import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { launchChrome, type HeadlessChrome } from "./harness/chrome.ts";
import { inputTokens, maxOutputTokens, reply, requestTokens, startStubProvider, type StubProvider, type StubRequest, type StubResponder } from "./harness/stub-provider.ts";

// LH-50, the live OB-0645 run: OpenRouter qwen/qwen3-14b (real window
// 40,960, max output 16,384) under a custom 1M window. The stub enforces
// the real window the way that provider does: the serialized input
// (messages and tool declarations) PLUS the request's max_tokens. Its
// usage reports the input it counted, so the threshold compaction's usage
// anchor behaves as with a real provider. The learner pastes ~2k tokens a
// turn. Before LH-50 the first rejection recovered, then the next turns
// were rejected again (max_tokens kept asking 16,384 against the 1M
// window), and the chat ended unrecoverable with Repair refused. The
// second case is the live single huge paste: its recovery's retry was
// rejected too (27,684 text + 3,796 tool + 16,384 out).

const LIMIT = 40_960;
const MAX_OUTPUT = 16_384;
/** stub-t: LH-40's old tiny regime, a real 11,548 window with 2,048 max
 *  output, under the same custom 1M window. */
const TINY = 11_548;
const REPLY_FLOOR = 1_024;
/** stub-s: a window large for its 1,024 max output, run at the catalog
 *  window. It reports no usage, so the threshold measures with no anchor,
 *  where the old trigger's estimate (chars/4, no tool declarations) and
 *  the held-back floor's (pi-ai's chars/3.5 with them) parted most. */
const SMALL_OUT = 32_000;
const STUB = "openrouter";
const SUMMARIZER = "You are the session-compaction summarizer";
const SUMMARY = [
	"## The learner's understanding",
	"The learner pasted worked derivatives and checked each one.",
	"## The current moment",
	"The learner is pasting the next attempt.",
].join("\n");
const PASTE = "The derivative of x squared is two x, by the limit of the difference quotient. ".repeat(100);
const REPLY = "Checked: each step follows from the definition of the derivative. ".repeat(30);
const paste = (n: number) => `Part ${n}: my next worked attempt. ${PASTE}`;

type Msg = {
	id: string;
	role: string;
	stopReason?: string;
	errorMessage?: string;
	contextOverflow?: { providerText?: string; unrecoverable?: boolean };
	customType?: string;
	details?: { notice?: string };
};
type Chat = { messages: Msg[]; turnInFlight: boolean; compacting?: boolean };

const isTurnRequest = (req: StubRequest) => !req.system.startsWith(SUMMARIZER);
const lastPart = (req: StubRequest) => {
	const content = req.messages.filter((m) => m.role === "user").at(-1)?.content;
	return /Part (\d+):/.exec(typeof content === "string" ? content : JSON.stringify(content ?? ""))?.[1] ?? "?";
};

let rejections = 0;
/** Turn requests to reject regardless of size (the Repair case). */
let forcedRejections = 0;
const responder: StubResponder = (req) => {
	const limit = req.model === "stub-t" ? TINY : req.model === "stub-s" ? SMALL_OUT : LIMIT;
	if (requestTokens(req) > limit || (isTurnRequest(req) && forcedRejections > 0 && forcedRejections--)) {
		rejections++;
		return reply.contextLength(limit);
	}
	if (!isTurnRequest(req)) return reply.text(SUMMARY);
	const text = `Answering part ${lastPart(req)}. ${REPLY}`;
	if (req.model === "stub-s") return reply.text(text, { prompt_tokens: 0, completion_tokens: 0 });
	return reply.text(text, { prompt_tokens: inputTokens(req), completion_tokens: Math.ceil(text.length / 4) });
};

let stub: StubProvider;
let server: LhServer;
let chrome: HeadlessChrome;

before(async () => {
	stub = await startStubProvider(responder);
	const slot = { model: { provider: STUB, id: "stub-q" } };
	server = await bootServer({
		ticket: "lh-50",
		providers: [{
			id: STUB,
			baseUrl: stub.baseUrl,
			models: [{ id: "stub-q", contextWindow: LIMIT, maxTokens: MAX_OUTPUT }, { id: "stub-t", contextWindow: TINY, maxTokens: 2_048 }, { id: "stub-s", contextWindow: SMALL_OUT, maxTokens: 1_024 }],
		}],
		settings: {
			version: 1,
			models: { strong: slot, cheap: slot, vision: slot },
			contextWindows: { [`${STUB}:stub-q`]: 1_000_000, [`${STUB}:stub-t`]: 1_000_000 },
			graph: { enabled: false },
		},
	});
	// A keyed provider, so the catalog and the threshold see its window (as in context-recovery.e2e.ts).
	await server.json(`/api/keys/OPENROUTER_API_KEY`, { method: "PUT", body: { value: "e2e-dummy-key-not-real" } });
	chrome = await launchChrome("lh-50");
});

after(async () => {
	await chrome?.close();
	await server?.stop();
	await stub?.close();
});

const chat = (id: string) => server.json<Chat>(`/api/chats/${id}`);
const isReply = (m: Msg | undefined) => m?.role === "assistant" && m.stopReason !== "error";
const replies = (c: Chat) => c.messages.filter(isReply).length;
const recoveryMarkers = (c: Chat) => c.messages.filter((m) => m.customType === "compaction" && m.details?.notice);
const settingsFile = () => path.join(server.dataDir, "settings.json");
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), "utf-8")) as { contextWindows?: Record<string, number>; learnedContextLimits?: Record<string, number> };
const learned = () => readSettings().learnedContextLimits?.[`${STUB}:stub-q`];
const writeSettings = (patch: Record<string, unknown>) => fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, "\t"));
type ModelRow = { id: string; contextWindow: number; customContextWindow?: number; learnedContextLimit?: number };
const modelRow = async (id: string) => (await server.json<{ models: ModelRow[] }>("/api/models")).models.find((m) => m.id === id);
const errored = (c: Chat) => c.messages.filter((m) => m.role === "assistant" && m.stopReason === "error");

/** A new chat, with no limit learned from an earlier case. */
async function newChat(title: string): Promise<string> {
	const { learnedContextLimits: _learned, ...rest } = JSON.parse(fs.readFileSync(settingsFile(), "utf-8")) as Record<string, unknown>;
	fs.writeFileSync(settingsFile(), JSON.stringify(rest, null, "\t"));
	rejections = 0;
	return (await server.json<{ id: string }>("/api/chats", { body: { title } })).id;
}

/** One learner turn; settles on a new reply or on an explained failure. */
async function turn(id: string, text: string): Promise<Chat> {
	const before = replies(await chat(id));
	const res = await server.api("/api/chat", { body: { chatId: id, input: { type: "text", text } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	return until(async () => {
		const c = await chat(id);
		return !c.turnInFlight && !c.compacting && (replies(c) > before || !!c.messages.at(-1)?.contextOverflow) ? c : null;
	}, `the turn "${text.slice(0, 7)}"`, 120_000);
}

test("a custom window above the real limit: one recovery, then on-time compaction under input + max_tokens, and Repair stays usable", async () => {
	const id = await newChat("Derivatives by hand");

	// 1. Gradual growth until the provider first rejects; that one recovers.
	let part = 0;
	let c = await chat(id);
	while (recoveryMarkers(c).length === 0) {
		assert.ok(++part <= 20, "the chat outgrows the real window within 20 turns");
		c = await turn(id, paste(part));
	}
	assert.equal(rejections, 1, "one rejection, and the recovery's retry fit");
	assert.ok(isReply(c.messages.at(-1)), "the recovered reply landed");
	assert.equal(learned(), LIMIT, "the stated limit is learned");
	// The footer and the window caption show the window that runs, not the custom 1M.
	const row = (await server.json<{ models: Array<{ id: string; contextWindow: number; customContextWindow?: number; learnedContextLimit?: number }> }>("/api/models"))
		.models.find((m) => m.id === "stub-q");
	assert.deepEqual([row?.contextWindow, row?.customContextWindow, row?.learnedContextLimit], [LIMIT, 1_000_000, LIMIT]);
	const page = await chrome.browser.newPage();
	try {
		await page.goto(`${server.url}/chat/${id}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
		await page.waitForFunction(() => /\/ 41k$/.test(document.querySelector('[data-testid="stats-context"]')?.textContent ?? ""), { timeout: 60_000 });
		await until(async () => {
			await page.click('[data-testid="stats-model"]');
			return page.waitForSelector('[data-testid="model-menu"]', { timeout: 2000 });
		}, "the composer model menu to open", 180_000, 500);
		await page.waitForFunction(
			() => document.querySelector('[data-testid="composer-context-window"]')?.textContent?.includes("Provider limit: 41k"),
			{ timeout: 60_000 },
		);
	} finally {
		await page.close();
	}

	// 2. The same growth continues: the threshold compaction fires before
	// any request reaches the window, and max_tokens is clamped to the
	// learned limit, never the custom 1M.
	const start = stub.requests.length;
	for (let i = 0; i < 8; i++) c = await turn(id, paste(++part));
	assert.equal(rejections, 1, "no second rejection");
	const later = stub.requests.slice(start).filter(isTurnRequest);
	for (const r of later) {
		assert.ok(requestTokens(r) <= LIMIT, `input ${inputTokens(r)} + max_tokens ${maxOutputTokens(r)} fits ${LIMIT}`);
	}
	assert.ok(later.some((r) => maxOutputTokens(r) < MAX_OUTPUT), "max_tokens shrinks as the input grows");
	// The threshold keeps the reply its room (a quarter of the window, less
	// estimate error); a threshold that ignored it left ~4k near the limit.
	const room = Math.min(...later.map(maxOutputTokens));
	assert.ok(room >= LIMIT / 5, `the reply keeps its room (smallest max_tokens ${room})`);
	const recovery = recoveryMarkers(c).at(-1)!;
	assert.ok(
		c.messages.slice(c.messages.indexOf(c.messages.find((m) => m.id === recovery.id)!) + 1).some((m) => m.customType === "compaction" && !m.details?.notice),
		"a threshold compaction fired after the recovery",
	);

	// 3. A failed retry with older history still left to condense is not
	// the end: the chat explains, Repair stays offered and works.
	forcedRejections = 2;
	c = await turn(id, paste(++part));
	const failed = c.messages.at(-1)!;
	assert.ok(failed.contextOverflow, "the failure is explained");
	assert.notEqual(failed.contextOverflow!.unrecoverable, true, "Repair is still offered");
	const listed = await server.json<{ chats: Array<{ id: string; repairable?: boolean }> }>("/api/chats");
	assert.equal(listed.chats.find((row) => row.id === id)?.repairable, true, "the session menu offers Repair");
	const repaired = await server.api(`/api/chats/${id}/repair`, { method: "POST" });
	assert.equal(repaired.status, 200, await repaired.text());
	const before = rejections;
	c = await turn(id, paste(++part));
	assert.ok(isReply(c.messages.at(-1)), "the first send after Repair is answered");
	assert.equal(rejections, before, "and is not rejected");
});

test("one huge paste: the recovery's retry fits the window with the tool declarations and the reply's room", async () => {
	const id = await newChat("One huge paste");
	await turn(id, paste(1));
	// ~22k tokens of pasted notes in one message, like the live 69k-char paste.
	const start = stub.requests.length;
	const c = await turn(id, `Part 2: all my notes at once. ${"A derivative measures how fast a quantity changes at an instant. ".repeat(1_400)}`);
	const requests = stub.requests.slice(start).filter(isTurnRequest);
	assert.equal(rejections, 1, "only the first request is rejected");
	assert.equal(requests.length, 2, "the rejected turn and one retry");
	assert.ok(requestTokens(requests[1]!) <= LIMIT, `the retry fits: input ${inputTokens(requests[1]!)} + max_tokens ${maxOutputTokens(requests[1]!)}`);
	assert.equal(recoveryMarkers(c).length, 1);
	assert.ok(isReply(c.messages.at(-1)), "the retry is answered");
	// The next turn goes through too.
	const after = await turn(id, paste(3));
	assert.ok(isReply(after.messages.at(-1)));
	assert.equal(rejections, 1, "no later rejection");
});

test("a window too small for the prompt, the tool declarations and a reply: nothing is sent to be cut off, and the learner gets the explanation", async () => {
	const id = await newChat("Tiny window");
	await server.json(`/api/chats/${id}/settings`, { method: "PUT", body: { model: { provider: STUB, id: "stub-t" } } });
	const start = stub.requests.length;
	let c = await chat(id);
	for (let part = 1; part <= 6 && !c.messages.at(-1)?.contextOverflow; part++) c = await turn(id, paste(part));
	const sent = stub.requests.slice(start).filter((r) => r.model === "stub-t");
	assert.ok(sent.length > 0);
	for (const r of sent) assert.ok(maxOutputTokens(r) >= REPLY_FLOOR, `no request leaves its reply under ${REPLY_FLOOR} tokens (max_tokens ${maxOutputTokens(r)})`);
	const failed = c.messages.at(-1)!;
	assert.match(failed.errorMessage!, /^This chat is still too long for stub-t, even after condensing its older part\./, "the learner sees the explanation");
	// The stated limit leaves the prompt and tool declarations no room, so
	// the rejection is explained at once: nothing condensed, no retry (LH-55).
	assert.match(failed.contextOverflow!.providerText!, /maximum context length is 11548 tokens/, "the provider's rejection is the one explained");
	assert.equal(c.messages.filter((m) => m.customType === "compaction" && m.details?.notice).length, 0, "nothing was condensed");
});

test("a large window with a small max output: the growing chat compacts at the threshold, and no request is held back", async () => {
	const id = await newChat("Short replies");
	await server.json(`/api/chats/${id}/settings`, { method: "PUT", body: { model: { provider: STUB, id: "stub-s" } } });
	const start = stub.requests.length;
	const turns = 14;
	let c = await chat(id);
	for (let part = 1; part <= turns; part++) c = await turn(id, `Part ${part}: my next worked attempt. ${PASTE.slice(0, 4_000)}`);
	assert.equal(rejections, 0, "the provider never rejects");
	assert.deepEqual(errored(c).map((m) => m.errorMessage), [], "no request is held back or fails");
	assert.equal(recoveryMarkers(c).length, 0, "no overflow recovery ran");
	assert.ok(c.messages.some((m) => m.customType === "compaction" && !m.details?.notice), "the threshold compaction ran");
	const sent = stub.requests.slice(start).filter((r) => r.model === "stub-s" && isTurnRequest(r));
	assert.equal(sent.length, turns, "every turn went out once");
	for (const r of sent) assert.equal(maxOutputTokens(r), 1_024, "every reply keeps the model's whole max output");
});

test("a held-back request is never learned as the provider's limit: the custom 1M window, nothing learned yet", async () => {
	// One paste too big even for 1M is held back (the 150k threshold
	// compacts gradual growth long before).
	const id = await newChat("Everything at once");
	await turn(id, paste(1));
	const c = await turn(id, `Part 2: all my notes. ${"A derivative measures how fast a quantity changes at an instant. ".repeat(53_500)}`);
	assert.equal(rejections, 0, "no provider rejected anything");
	assert.ok(errored(c).length > 0 && c.messages.at(-1)?.contextOverflow, "the paste was held back and the chat explains");
	assert.equal(learned(), undefined, "nothing learned");
	const row = await modelRow("stub-q");
	assert.deepEqual([row?.contextWindow, row?.learnedContextLimit], [1_000_000, undefined], "no provider limit shown");
	assert.equal(c.messages.at(-1)!.contextOverflow!.providerText, undefined, "no provider text");
});

test("a held-back request is never learned as the provider's limit: a custom window below a real learned limit", async () => {
	const custom = readSettings().contextWindows;
	const id = await newChat("A smaller window");
	writeSettings({ contextWindows: { ...custom, [`${STUB}:stub-q`]: 20_000 }, learnedContextLimits: { [`${STUB}:stub-q`]: LIMIT } });
	try {
		await turn(id, paste(1));
		const c = await turn(id, `Part 2: all my notes. ${"A derivative measures how fast a quantity changes at an instant. ".repeat(800)}`);
		assert.equal(rejections, 0, "no provider rejected anything");
		assert.ok(errored(c).length > 0, "the paste was held back at the custom window");
		assert.equal(learned(), LIMIT, "the real limit survives");
		const row = await modelRow("stub-q");
		assert.deepEqual([row?.contextWindow, row?.customContextWindow, row?.learnedContextLimit], [20_000, 20_000, LIMIT]);
	} finally {
		writeSettings({ contextWindows: custom });
	}
});
