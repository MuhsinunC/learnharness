import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { launchChrome, type HeadlessChrome } from "./harness/chrome.ts";
import type { Page } from "puppeteer-core";
import { maxOutputTokens, reply, startStubProvider, type StubProvider, type StubRequest, type StubResponder } from "./harness/stub-provider.ts";

// LH-40: a chat that outgrows the model's REAL window recovers. The stub
// model's catalog window is small, but the learner set a custom 1.5M
// window for it (LH-38's setting, the owner's "1.5M by mistake"), so the
// threshold compaction never fires; the stub enforces the real limit on
// the serialized messages plus the request's max_tokens, as providers do
// (LH-50; output-budget.e2e.ts also counts the tool declarations), and
// answers past it with pi-ai's real context-length 400, stating LIMIT.
// Its usage reports the input it counted (chars/4), so the threshold
// compaction's usage anchor behaves as with a real provider.

/** The real window, in tokens: the 38,000 chars of messages five turns
 *  grow into, plus the 2,048 max_tokens the requests ask for. */
const LIMIT = 38_000 / 4 + 2_048;
const FILLER = "Limits describe what a function approaches. ".repeat(115);
const SUMMARY = [
	"## The learner's understanding",
	"The learner asked for a walk through limits and followed each step.",
	"## The teaching arc",
	"Several long explanations of limits.",
	"## The plan dependency tree",
	"- [upcoming] Limit intuition (limits-intuition)",
	"## The current moment",
	"The learner asked to keep going.",
].join("\n");
const SUMMARIZER = "You are the session-compaction summarizer";
/** Registered as openrouter: /api/models and the threshold see keyed providers only (LH-38's e2e does the same). */
const STUB = "openrouter";
const HEADER = "[SESSION HISTORY COMPACTED]";
const TREE = {
	nodes: [
		{ id: "limits-intuition", title: "Limit intuition" },
		{ id: "epsilon-delta", title: "Epsilon-delta definition" },
	],
	edges: [{ from: "limits-intuition", to: "epsilon-delta" }],
	version: 1,
};
const GRAPH_NODE = {
	id: "n_lh40seed",
	name: "Limit",
	statement: "A limit is the value a function approaches as its input approaches a point.",
	aliases: [],
	createdAt: "2026-10-27T00:00:00.000Z",
	provenance: [],
};

type Msg = {
	id: string;
	role: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	contextOverflow?: { providerText: string; unrecoverable?: boolean };
	customType?: string;
	details?: { notice?: string; firstKeptMessageId?: string };
};
type Chat = { messages: Msg[]; tree?: unknown; turnInFlight: boolean; compacting?: boolean };

const inputTokens = (req: StubRequest) => Math.ceil(JSON.stringify(req.messages).length / 4);
const requestTokens = (req: StubRequest) => inputTokens(req) + maxOutputTokens(req);

const lastLearnerText = (req: StubRequest) => {
	const content = req.messages.filter((m) => m.role === "user").at(-1)?.content;
	return typeof content === "string" ? content : JSON.stringify(content ?? "");
};
/** The reply names the learner message it answers, so a test can tell replies apart. */
const answer = (text: string) => `Answering "${text}". ${FILLER}`;
/** Bedrock's wording: a length rejection that states no limit. */
const BEDROCK_400 = reply.http(400, { message: "Input is too long for requested model." });
let rejections = 0;
const limited = (limitTokens: number, rejection = reply.contextLength(limitTokens), summary = reply.text(SUMMARY)): StubResponder => (req) => {
	if (requestTokens(req) > limitTokens) {
		rejections++;
		return rejection;
	}
	if (req.system.startsWith(SUMMARIZER)) return summary;
	const text = answer(lastLearnerText(req));
	return reply.text(text, { prompt_tokens: inputTokens(req), completion_tokens: Math.ceil(text.length / 4) });
};
const isTurnRequest = (req: StubRequest) => !req.system.startsWith(SUMMARIZER);
const recoveryMarkers = (c: Chat) => c.messages.filter((m) => m.customType === "compaction" && m.details?.notice);
const isReply = (m: Msg | undefined) => m?.role === "assistant" && m.stopReason !== "error";
const lastReply = (c: Chat) => c.messages.filter(isReply).at(-1);
/** A reply landed after the newest recovery marker (a threshold marker may follow it). */
const replyAfterRecovery = (c: Chat) => {
	const marker = recoveryMarkers(c).at(-1);
	return !!marker && c.messages.slice(c.messages.indexOf(marker) + 1).some(isReply);
};

let stub: StubProvider;
let server: LhServer;
let chrome: HeadlessChrome;

before(async () => {
	stub = await startStubProvider(limited(LIMIT));
	const slot = { model: { provider: STUB, id: "stub-a" } };
	server = await bootServer({
		ticket: "lh-40",
		// Catalog default 4,000 (the threshold would compact every turn);
		// the custom 1.5M is what the engine runs (LH-38).
		providers: [{ id: STUB, baseUrl: stub.baseUrl, models: [{ id: "stub-a", contextWindow: 4_000, maxTokens: 2_048 }] }],
		settings: {
			version: 1,
			models: { strong: slot, cheap: slot, vision: slot },
			contextWindows: { [`${STUB}:stub-a`]: 1_500_000 },
			graph: { enabled: false },
		},
	});
	// A dummy key makes the stub a keyed provider, so the catalog (and the
	// threshold compaction) sees its window, as for a real provider.
	await server.json(`/api/keys/OPENROUTER_API_KEY`, { method: "PUT", body: { value: "e2e-dummy-key-not-real" } });
	chrome = await launchChrome("lh-40");
});

after(async () => {
	await chrome?.close();
	await server?.stop();
	await stub?.close();
});

const chat = (id: string) => server.json<Chat>(`/api/chats/${id}`);
const settled = (id: string, label: string, done: (c: Chat) => boolean) =>
	until(async () => {
		const c = await chat(id);
		return !c.turnInFlight && !c.compacting && done(c) ? c : null;
	}, label, 120_000);

async function send(id: string, text: string): Promise<void> {
	const res = await server.api("/api/chat", { body: { chatId: id, input: { type: "text", text } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
}

/** Learner turns that all succeed (the chat grows ~5k chars per turn). */
async function grow(id: string, turns: number): Promise<void> {
	for (let i = 0; i < turns; i++) {
		const before = (await chat(id)).messages.filter(isReply).length;
		await send(id, `Keep going, part ${i + 1}.`);
		await settled(id, `growth turn ${i + 1}`, (c) => c.messages.filter(isReply).length > before);
	}
}

function hashDir(dir: string): string {
	const h = crypto.createHash("sha256");
	for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) h.update(name).update(fs.readFileSync(path.join(dir, name)));
	return h.digest("hex");
}

/** Each case starts with no limit learned from an earlier case. */
function forgetLearnedLimits(): void {
	const file = path.join(server.dataDir, "settings.json");
	const { learnedContextLimits: _learned, ...rest } = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
	fs.writeFileSync(file, JSON.stringify(rest, null, "\t"));
}

const settingsOnDisk = () => JSON.parse(fs.readFileSync(path.join(server.dataDir, "settings.json"), "utf-8")) as {
	contextWindows?: Record<string, number>;
	learnedContextLimits?: Record<string, number>;
};

async function newChat(title: string): Promise<string> {
	forgetLearnedLimits();
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title } });
	return id;
}

/** Open the chat and wait until React has hydrated `selector`. */
async function openChat(id: string, selector: string) {
	const page = await chrome.browser.newPage();
	await page.setViewport({ width: 1400, height: 900 });
	await page.goto(`${server.url}/chat/${id}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	await page.waitForFunction(
		(sel) => {
			const el = document.querySelector(sel);
			return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
		},
		{ timeout: 120_000 },
		selector,
	);
	return page;
}

/** The sidebar row for a chat title, once the session list has loaded
 *  and React has hydrated it (a right-click before that opens nothing). */
const sidebarRow = (page: Page, title: string) =>
	until(async () => {
		for (const r of await page.$$('[data-testid="session-row"], [data-testid="session-row-kbd"]')) {
			const [text, hydrated] = await r.evaluate((el) => [el.textContent ?? "", Object.keys(el).some((k) => k.startsWith("__reactProps"))] as const);
			if (text.includes(title) && hydrated) return r;
		}
		return null;
	}, `the sidebar row for ${title}`);

/** Click `selector` and return the response to the POST it fires; one
 *  more click if the first fired nothing (it landed before React attached). */
async function clickForPost(page: Page, selector: string, urlPart: string) {
	for (let attempt = 0; ; attempt++) {
		const fired = page.waitForRequest((r) => r.method() === "POST" && r.url().includes(urlPart), { timeout: 10_000 });
		await page.click(selector);
		let request;
		try {
			request = await fired;
		} catch (err) {
			if (attempt === 1) throw err;
			continue;
		}
		return until(() => request.response(), `the response to ${urlPart}`, 120_000);
	}
}

/** Leave the chat as one broken before this release: the learner's
 *  message, then the provider's length rejection (pi-ai's persisted text
 *  for reply.contextLength, seen in a live run). */
function breakChat(id: string, grown = true): void {
	const file = path.join(server.dataDir, "chats", `${id}.json`);
	const record = JSON.parse(fs.readFileSync(file, "utf-8")) as { messages: unknown[] };
	record.messages.push(
		{ id: `msg_lh40_user_${id}`, role: "user", content: `Explain it all again in detail. ${"Please. ".repeat(700)}`, timestamp: Date.now() },
		{
			id: `msg_lh40_error_${id}`,
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: STUB,
			model: "stub-a",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			errorMessage: `400: {"message":"This model's maximum context length is ${LIMIT} tokens. However, your messages resulted in ${LIMIT + 1000} tokens.","type":"invalid_request_error","code":"context_length_exceeded"}`,
			timestamp: Date.now(),
		},
	);
	fs.writeFileSync(file, JSON.stringify(record));
	if (!grown) return;
	const lastGrowth = stub.requests.at(-1)!;
	assert.ok(requestTokens(lastGrowth) + Math.ceil(JSON.stringify(record.messages.slice(-3)).length / 4) > LIMIT, "the next request would be past the real window");
}

/** Append a compaction marker to the record file (a recovery one when `notice` is set). */
function seedMarker(id: string, firstKeptMessageId: string, content: string, notice?: string): void {
	const file = path.join(server.dataDir, "chats", `${id}.json`);
	const record = JSON.parse(fs.readFileSync(file, "utf-8")) as { messages: unknown[] };
	record.messages.push({
		id: `msg_lh40_marker_${record.messages.length}`,
		role: "custom",
		customType: "compaction",
		content: `${HEADER} The transcript before this point was summarized.\n\n${content}`,
		display: true,
		details: { firstKeptMessageId, tokensBefore: 1, at: new Date().toISOString(), ...(notice ? { notice } : {}) },
		timestamp: Date.now(),
	});
	fs.writeFileSync(file, JSON.stringify(record));
}

const PRIOR = `PRIOR-SUMMARY-SENTINEL ${"The learner mastered one-sided limits. ".repeat(80)}`;

test("(a, c) an over-window chat recovers on the next learner turn, and the learning state is untouched", async () => {
	const id = await newChat("Limits of functions");
	// The learning state: a plan tree in the record, a node in the graph.
	const file = path.join(server.dataDir, "chats", `${id}.json`);
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf-8")), tree: TREE }));
	fs.mkdirSync(path.join(server.dataDir, "graph"), { recursive: true });
	fs.writeFileSync(path.join(server.dataDir, "graph", "nodes.jsonl"), `${JSON.stringify(GRAPH_NODE)}\n`);
	const graphBefore = hashDir(path.join(server.dataDir, "graph"));
	const graphApiBefore = await (await server.api("/api/graph")).text();

	await grow(id, 5);
	const grown = await chat(id);
	const start = stub.requests.length;

	// The learner is in the tab when the chat breaks: part 6 goes through
	// the composer, and the same page (no reload) must end on the
	// recovered reply and the notice, with no error banner or bubble.
	const page = await openChat(id, '[data-testid="composer"] textarea');
	try {
		await page.type('[data-testid="composer"] textarea', "Keep going, part 6.");
		await page.keyboard.press("Enter");
		await page.waitForFunction(
			() => document.body.innerText.includes('Answering "Keep going, part 6."') &&
				[...document.querySelectorAll('[data-testid="compaction-divider"]')].some((el) => el.textContent?.includes("condensed the older part and continued")),
			{ timeout: 120_000 },
		);
		assert.equal(await page.$('[data-testid="chat-error"]'), null, "no stale error banner");
		assert.ok(!(await page.evaluate(() => document.body.innerText)).includes("context_length_exceeded"), "the kept rejection renders nothing");
	} finally {
		await page.close();
	}
	const done = await settled(id, "the recovered reply", replyAfterRecovery);

	const turnRequests = stub.requests.slice(start).filter(isTurnRequest);
	assert.equal(turnRequests.length, 2, "the rejected turn and exactly one retry");
	assert.ok(requestTokens(turnRequests[0]!) > LIMIT, "the first request really overflowed");
	const retried = turnRequests[1]!;
	assert.ok(requestTokens(retried) <= LIMIT, `the retried request fits (${requestTokens(retried)} tokens)`);
	assert.match(JSON.stringify(retried.messages), new RegExp(HEADER.replace(/[[\]]/g, "\\$&")));
	assert.match(JSON.stringify(retried.messages), /Current lesson topic: Limits of functions/);
	assert.match(JSON.stringify(retried.messages), /The learner asked for a walk through limits/, "the model summary fit, no fallback");
	assert.match(JSON.stringify(retried.messages.at(-1)), /Keep going, part 6/, "the learner's turn is what gets answered");

	const markers = recoveryMarkers(done);
	assert.equal(markers.length, 1);
	assert.equal(markers[0]!.details!.notice, "This chat had grown too long for stub-a; I condensed the older part and continued.");
	assert.match(JSON.stringify(lastReply(done)!.content), /Answering \\"Keep going, part 6\.\\"/);

	// (c) Nothing was deleted: every earlier message survives, in order;
	// the plan tree and the graph are byte-identical.
	const ids = done.messages.map((m) => m.id);
	const kept = grown.messages.map((m) => ids.indexOf(m.id));
	assert.ok(kept.every((i, n) => i >= 0 && (n === 0 || i > kept[n - 1]!)), "full history kept in order");
	assert.deepEqual(done.tree, TREE);
	assert.equal(hashDir(path.join(server.dataDir, "graph")), graphBefore);
	assert.equal(await (await server.api("/api/graph")).text(), graphApiBefore);
});

test("(b) Repair this chat fixes a chat already in the broken state", async () => {
	const id = await newChat("Derivatives");
	await grow(id, 5);
	breakChat(id);

	const page = await openChat(id, '[data-testid="repair-chat"]');
	try {
		const res = await clickForPost(page, '[data-testid="repair-chat"]', "/repair");
		assert.equal(res.status(), 200, await res.text());
		await settled(id, "the repair marker", (c) => recoveryMarkers(c).length === 1);
		await page.waitForFunction(
			() => !document.querySelector('[data-testid="chat-error"]') &&
				[...document.querySelectorAll('[data-testid="compaction-divider"]')].some((el) => el.textContent?.includes("I condensed the older part.")),
			{ timeout: 60_000 },
		);
	} finally {
		await page.close();
	}

	const start = stub.requests.length;
	await send(id, "Thanks, carry on.");
	const done = await settled(id, "the reply after repair", replyAfterRecovery);
	const turnRequests = stub.requests.slice(start).filter(isTurnRequest);
	assert.equal(turnRequests.length, 1, "the first send after repair succeeds");
	assert.ok(requestTokens(turnRequests[0]!) <= LIMIT);
	assert.match(JSON.stringify(turnRequests[0]!.messages), /SESSION HISTORY COMPACTED/);
	assert.equal(recoveryMarkers(done).length, 1);
	assert.ok(done.messages.some((m) => m.id === `msg_lh40_error_${id}`), "the rejected reply is kept, never deleted");
});

test("(b) the session menu repairs a broken chat and refuses a healthy one", async () => {
	const id = await newChat("Sequences");
	await grow(id, 5);
	breakChat(id);
	const page = await openChat(id, '[data-testid="session-row"]');
	try {
		await (await sidebarRow(page, "Sequences")).click({ button: "right" });
		const res = await clickForPost(page, '[data-testid="ctx-repair"]', "/repair");
		assert.equal(res.status(), 200, await res.text());
		const repaired = await settled(id, "the menu repair marker", (c) => recoveryMarkers(c).length === 1);
		assert.equal(repaired.messages.at(-1)!.customType, "compaction");
		// A working chat's menu offers no Repair (the list's repairable flag).
		await newChat("Healthy menu");
		await page.reload({ waitUntil: "domcontentloaded" });
		await (await sidebarRow(page, "Healthy menu")).click({ button: "right" });
		await page.waitForSelector('[data-testid="ctx-rename"]');
		assert.equal(await page.$('[data-testid="ctx-repair"]'), null, "no Repair for a working chat");
	} finally {
		await page.close();
	}
	// Once repaired (or never broken), repair refuses rather than compact a working chat.
	for (const target of [id, await newChat("Healthy")]) {
		const before = (await chat(target)).messages.length;
		const res = await server.api(`/api/chats/${target}/repair`, { method: "POST" });
		assert.equal(res.status, 409, await res.text());
		assert.equal((await chat(target)).messages.length, before);
	}
});

test("(d) recovery never loops: when even the smallest request is too big, the learner gets a clear failure", async () => {
	const id = await newChat("Integrals");
	await grow(id, 2);
	// The provider now refuses anything: even the system prompt alone is over.
	const tiny = 2_500;
	stub.setResponder(limited(tiny));
	try {
		const start = stub.requests.length;
		await send(id, "Next part, please.");
		const done = await settled(id, "the clear failure", (c) => !!c.messages.at(-1)?.contextOverflow?.unrecoverable);
		// Quiet window: nothing else may fire.
		await new Promise((r) => setTimeout(r, 8_000));
		const turnRequests = stub.requests.slice(start).filter(isTurnRequest);
		assert.equal(turnRequests.length, 2, "the rejected turn and one retry, never more");
		assert.ok(turnRequests.every((r) => requestTokens(r) > tiny));
		const final = await chat(id);
		assert.equal(final.messages.length, done.messages.length, "nothing ran after the failure");
		assert.equal(recoveryMarkers(final).length, 1);
		assert.match(JSON.stringify(recoveryMarkers(final)[0]!.content), /no model summary could be written/, "the deterministic fallback landed");
		const failed = final.messages.at(-1)!;
		assert.match(
			failed.errorMessage!,
			/^This chat is still too long for stub-a, even after condensing its older part\. Start a new session, or pick a model with a larger context window\. \(400: /,
		);
		// (7) Never nested, the provider text kept apart, and Repair no longer offered.
		assert.equal(failed.errorMessage!.split("This chat is still too long").length, 2);
		assert.match(failed.contextOverflow!.providerText, /^400: .*context_length_exceeded/);
		const refused = await server.api(`/api/chats/${id}/repair`, { method: "POST" });
		assert.equal(refused.status, 409);
		assert.match(await refused.text(), /cannot be condensed any further/);
	} finally {
		stub.setResponder(limited(LIMIT));
	}
});

test("(e) a custom window above the real limit: the chat overflows, then recovers, even when the rejection states no limit", async () => {
	// The misconfiguration is what runs: the custom 1.5M over the 4,000 default.
	const catalog = await server.json<{ models: Array<{ provider: string; id: string; contextWindow: number; defaultContextWindow: number }> }>("/api/models");
	const pair = catalog.models.find((m) => m.provider === STUB && m.id === "stub-a");
	assert.deepEqual([pair?.contextWindow, pair?.defaultContextWindow], [1_500_000, 4_000]);
	const id = await newChat("Series");
	await grow(id, 5);
	assert.equal((await chat(id)).messages.filter((m) => m.customType === "compaction").length, 0, "no threshold compaction under the 1.5M window");
	stub.setResponder(limited(LIMIT, BEDROCK_400));
	try {
		const start = stub.requests.length;
		await send(id, "Keep going, part 6.");
		const done = await settled(id, "the recovered reply", replyAfterRecovery);
		const turnRequests = stub.requests.slice(start).filter(isTurnRequest);
		assert.equal(turnRequests.length, 2, "the rejected turn and exactly one retry");
		assert.ok(requestTokens(turnRequests[0]!) > LIMIT);
		assert.ok(requestTokens(turnRequests[1]!) <= LIMIT, `the retried request fits (${requestTokens(turnRequests[1]!)} tokens)`);
		assert.match(JSON.stringify(lastReply(done)!.content), /Answering \\"Keep going, part 6\.\\"/);
		assert.equal(recoveryMarkers(done).length, 1);
	} finally {
		stub.setResponder(limited(LIMIT));
	}
});

for (const summarizerWorks of [true, false]) {
	test(`(f) a chained recovery keeps the prior summary (${summarizerWorks ? "model summary, transcript clipped" : "deterministic fallback"})`, async () => {
		const id = await newChat(summarizerWorks ? "Continuity" : "Continuity fallback");
		await grow(id, 5);
		// An earlier threshold compaction: its summary stands for message 0.
		seedMarker(id, (await chat(id)).messages[1]!.id, PRIOR);
		if (!summarizerWorks) stub.setResponder(limited(LIMIT, undefined, reply.http(500, { error: { message: "summarizer down" } })));
		try {
			const start = stub.requests.length;
			await send(id, "Keep going, part 6.");
			await settled(id, "the recovered reply", replyAfterRecovery);
			const requests = stub.requests.slice(start);
			const retried = requests.filter(isTurnRequest).at(-1)!;
			assert.ok(requestTokens(retried) <= LIMIT);
			assert.match(JSON.stringify(retried.messages), /PRIOR-SUMMARY-SENTINEL/, "the prior summary rides into the new marker");
			if (summarizerWorks) {
				// (2) The summarizer saw the whole prior block, with only the raw transcript clipped.
				const summarizer = JSON.stringify(requests.filter((r) => !isTurnRequest(r)).at(-1)!.messages);
				assert.match(summarizer, /prior compaction summary, still authoritative/);
				assert.match(summarizer, /PRIOR-SUMMARY-SENTINEL (?:The learner mastered one-sided limits\. ){80}/);
				assert.match(summarizer, /older part omitted/);
			} else {
				// (1) The fallback carries the prior summary verbatim, then the plan tree.
				assert.match(JSON.stringify(retried.messages), /no model summary could be written[^]*earlier summary \(still authoritative\)[^]*PRIOR-SUMMARY-SENTINEL[^]*plan dependency tree/);
			}
		} finally {
			stub.setResponder(limited(LIMIT));
		}
	});
}

test("(g) one compact-and-retry per overflow episode, even when a threshold marker landed after the recovery", async () => {
	const id = await newChat("Guard");
	await grow(id, 2);
	breakChat(id, false);
	const learner = `msg_lh40_user_${id}`;
	seedMarker(id, learner, "Recovered summary.", "This chat had grown too long for stub-a; I condensed the older part and continued.");
	seedMarker(id, learner, "A later threshold summary.");
	stub.setResponder(limited(2_500));
	try {
		const start = stub.requests.length;
		await send(id, "Another try.");
		const done = await settled(id, "the clear failure", (c) => !!c.messages.at(-1)?.contextOverflow?.unrecoverable);
		await new Promise((r) => setTimeout(r, 5_000));
		assert.equal(stub.requests.slice(start).length, 1, "no second recovery, no retry");
		assert.equal(recoveryMarkers(await chat(id)).length, 1);
		assert.match(done.messages.at(-1)!.errorMessage!, /^This chat is still too long for stub-a/);
	} finally {
		stub.setResponder(limited(LIMIT));
	}
});

test("(h) a refused repair shows the server's reason, then the chat says plainly it cannot be condensed", async () => {
	const id = await newChat("Nothing to drop");
	breakChat(id, false); // the learner's one message and its rejection: nothing older to condense
	const page = await openChat(id, '[data-testid="repair-chat"]');
	try {
		await (await sidebarRow(page, "Nothing to drop")).click({ button: "right" });
		await page.waitForSelector('[data-testid="ctx-repair"]');
		assert.equal((await clickForPost(page, '[data-testid="ctx-repair"]', "/repair")).status(), 422);
		await page.waitForFunction(
			() => document.querySelector('[data-testid="ctx-repair-error"]')?.textContent === "Nothing older in this chat can be condensed.",
			{ timeout: 60_000 },
		);
		// The server declared it hopeless: the banner explains, and Repair is no longer offered.
		await page.waitForFunction(
			() => document.querySelector('[data-testid="chat-error"]')?.textContent?.includes("This chat is still too long for stub-a") &&
				!document.querySelector('[data-testid="repair-chat"]'),
			{ timeout: 60_000 },
		);
	} finally {
		await page.close();
	}
	assert.equal(recoveryMarkers(await chat(id)).length, 0);
});

test("(i) the stated limit is learned: after one recovery, the threshold compaction keeps the chat under the real limit", async () => {
	const id = await newChat("Learned limit");
	await grow(id, 5);
	await send(id, "Keep going, part 6.");
	const recovered = await settled(id, "the recovered reply", replyAfterRecovery);
	const marker = recoveryMarkers(recovered).at(-1)!;
	// Its own key, never the user's value.
	assert.equal(settingsOnDisk().learnedContextLimits?.[`${STUB}:stub-a`], LIMIT);
	assert.equal(settingsOnDisk().contextWindows?.[`${STUB}:stub-a`], 1_500_000);

	const before = rejections;
	const start = stub.requests.length;
	for (let i = 7; i <= 12; i++) {
		const replies = (await chat(id)).messages.filter(isReply).length;
		await send(id, `Keep going, part ${i}.`);
		await settled(id, `turn ${i}`, (c) => c.messages.filter(isReply).length > replies);
	}
	assert.equal(rejections, before, "no second rejection");
	assert.ok(stub.requests.slice(start).filter(isTurnRequest).every((r) => requestTokens(r) <= LIMIT));
	const done = await chat(id);
	const later = done.messages.slice(done.messages.indexOf(done.messages.find((m) => m.id === marker.id)!) + 1);
	assert.ok(later.some((m) => m.customType === "compaction" && !m.details?.notice), "a threshold compaction fired");
	assert.equal(recoveryMarkers(done).length, 1);
});
