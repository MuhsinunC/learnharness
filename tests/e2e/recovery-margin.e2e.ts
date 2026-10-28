import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { maxOutputTokens, reply, startStubProvider, type StubProvider, type StubRequest, type StubResponder } from "./harness/stub-provider.ts";

// LH-55, the LH-50 review follow-ups on an OpenRouter-like stub.
// (a) The OB-0645 live check measured OpenRouter's pre-flight count at
// about 1.18x what it bills; this stub counts 1.18x pi-ai's chars/3.5
// (the instructions, messages and tool declarations) plus max_tokens
// against the real 40,960 window of qwen3-14b. Before LH-55 the recovery
// retry was sized to the room with only pi-ai's flat 4,096-token margin,
// and was rejected again.
// (b) A stated limit smaller than the prompt and tool declarations:
// nothing can be sent, so nothing is condensed.
// (c) A learned limit is cleared by saving a custom window, and the
// rejection that taught it does not teach it again.
// (d) A stated limit that leaves the prompt and tool declarations a
// little room: the recovery condenses into that room (never to nothing),
// its retry is still held back, and the learner gets the explanation.

const LIMIT = 40_960;
const MAX_OUTPUT = 16_384;
/** A limit that leaves the prober's prompt and tool declarations (~7.5k
 *  wire tokens) no room for a reply. Its replies report the default usage,
 *  so the settle kick's threshold compaction stays out of the way. */
const TINY_LIMIT = 11_000;
const STUB = "openrouter";
const SUMMARIZER = "You are the session-compaction summarizer";
const NOTES = "The derivative of x squared is two x, by the limit of the difference quotient. ";
const paste = (n: number) => `Part ${n}: my next worked attempt. ${NOTES.repeat(42)}`;
const REPLY = "Checked: each step follows from the definition of the derivative. ".repeat(8);

type Msg = { id: string; role: string; content?: unknown; stopReason?: string; errorMessage?: string; heldBack?: boolean; contextOverflow?: { providerText?: string; unrecoverable?: boolean }; customType?: string; details?: { notice?: string; firstKeptMessageId?: string } };
type Chat = { messages: Msg[]; turnInFlight: boolean; compacting?: boolean };

const text = (content: unknown) => typeof content === "string" ? content : JSON.stringify(content ?? "");
/** pi-ai's estimate of the request as sent: chars/3.5 over the message
 *  text, the tool calls and the tool declarations. */
const wireTokens = (req: StubRequest) => Math.ceil((
	req.messages.reduce((n, m) => n + text(m.content).length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) +
	JSON.stringify(((req.body.tools ?? []) as Array<{ function: unknown }>).map((t) => t.function)).length
) / 3.5);
/** OpenRouter's pre-flight: 1.18x the estimate, plus the reply's max_tokens. */
const counted = (req: StubRequest) => Math.ceil(1.18 * wireTokens(req)) + maxOutputTokens(req);
const isTurn = (req: StubRequest) => !req.system.startsWith(SUMMARIZER);
/** The summarizer writes up to its word cap ("under N words"), as models do. */
const summaryOf = (req: StubRequest) => {
	const cap = Number(/under (\d+) words/.exec(text(req.messages.at(-1)?.content))?.[1] ?? 200);
	return `## The learner's understanding\n${Array(cap - 8).fill("rate").join(" ")}\n## The current moment\nThe learner pastes.`;
};

/** The system prompt and tool declarations at pi-ai's chars/3.5: what the
 *  server measures as the chat's request prefix. */
const prefixWire = (req: StubRequest) =>
	Math.ceil(req.system.length / 3.5) + Math.ceil(JSON.stringify(((req.body.tools ?? []) as Array<{ function: unknown }>).map((t) => t.function)).length / 3.5);
/** Room the stub-y limit leaves the marker and kept tail above the
 *  held-back floor (4,096 + 1,024): below a quarter of the prefix, so the
 *  0.8 margin alone would leave none. */
const ROOM = 1_400;
const LONG_REPLY = "Checked: each step follows from the definition of the derivative. ".repeat(96);
const short = (n: number) => `Part ${n}: is this limit right?`;

let rejections = 0;
/** Turn requests to reject at LIMIT regardless of size. */
let forced = 0;
/** stub-x states its tiny limit once a chat has been answered twice. */
const tinyAfter = 2;
let stubYRejected = false;
const responder: StubResponder = (req) => {
	if (req.model === "stub-y" && isTurn(req)) {
		if (stubYRejected || !text(req.messages.at(-1)?.content).includes("Part 4:")) return reply.text(LONG_REPLY);
		stubYRejected = true;
		rejections++;
		return reply.contextLength(prefixWire(req) + 5_120 + ROOM);
	}
	if (isTurn(req) && forced > 0) {
		forced--;
		rejections++;
		return reply.contextLength(LIMIT);
	}
	if (req.model === "stub-x" && isTurn(req) && req.messages.filter((m) => m.role === "assistant").length >= tinyAfter) {
		rejections++;
		return reply.contextLength(TINY_LIMIT);
	}
	if (counted(req) > LIMIT) {
		rejections++;
		return reply.contextLength(LIMIT);
	}
	if (!isTurn(req)) return reply.text(summaryOf(req));
	if (req.model === "stub-x") return reply.text(REPLY);
	return reply.text(REPLY, { prompt_tokens: wireTokens(req), completion_tokens: Math.ceil(REPLY.length / 3.5) });
};

let stub: StubProvider;
let server: LhServer;

before(async () => {
	stub = await startStubProvider(responder);
	const slot = { model: { provider: STUB, id: "stub-q" } };
	server = await bootServer({
		ticket: "lh-55",
		providers: [{ id: STUB, baseUrl: stub.baseUrl, models: ["stub-q", "stub-x", "stub-y"].map((id) => ({ id, contextWindow: LIMIT, maxTokens: MAX_OUTPUT })) }],
		settings: {
			version: 1,
			models: { strong: slot, cheap: slot, vision: slot },
			contextWindows: { [`${STUB}:stub-q`]: 1_000_000, [`${STUB}:stub-x`]: 1_000_000, [`${STUB}:stub-y`]: 1_000_000 },
			graph: { enabled: false },
		},
	});
	await server.json(`/api/keys/OPENROUTER_API_KEY`, { method: "PUT", body: { value: "e2e-dummy-key-not-real" } });
});

after(async () => {
	await server?.stop();
	await stub?.close();
});

const chat = (id: string) => server.json<Chat>(`/api/chats/${id}`);
const isReply = (m: Msg | undefined) => m?.role === "assistant" && m.stopReason !== "error";
const replies = (c: Chat) => c.messages.filter(isReply).length;
const markers = (c: Chat) => c.messages.filter((m) => m.customType === "compaction");
const settingsFile = () => path.join(server.dataDir, "settings.json");
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), "utf-8")) as Record<string, unknown> & { learnedContextLimits?: Record<string, number> };
const writeSettings = (patch: Record<string, unknown>) => fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, "\t"));
type ModelRow = { id: string; contextWindow: number; customContextWindow?: number; learnedContextLimit?: number };
const modelRow = async (id: string) => (await server.json<{ models: ModelRow[] }>("/api/models")).models.find((m) => m.id === id);

async function newChat(title: string, model = "stub-q"): Promise<string> {
	writeSettings({ learnedContextLimits: {} });
	rejections = 0;
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title } });
	if (model !== "stub-q") await server.json(`/api/chats/${id}/settings`, { method: "PUT", body: { model: { provider: STUB, id: model } } });
	return id;
}

/** One learner turn; settles on a new reply or on an explained failure. */
async function turn(id: string, input: string): Promise<Chat> {
	const before = replies(await chat(id));
	const res = await server.api("/api/chat", { body: { chatId: id, input: { type: "text", text: input } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	return until(async () => {
		const c = await chat(id);
		return !c.turnInFlight && !c.compacting && (replies(c) > before || !!c.messages.at(-1)?.contextOverflow) ? c : null;
	}, `the turn "${input.slice(0, 7)}"`, 120_000);
}

test("(a) a provider that counts 1.18x pi-ai's estimate: the recovery retry fits first time", async () => {
	const id = await newChat("Derivatives, counted high");
	let c = await chat(id);
	for (let part = 1; markers(c).length === 0; part++) {
		assert.ok(part <= 30, "the chat outgrows the real window within 30 turns");
		c = await turn(id, paste(part));
	}
	const retry = stub.requests.filter((r) => r.model === "stub-q" && isTurn(r)).at(-1)!;
	assert.equal(rejections, 1, `only the first request was rejected (the retry counted ${counted(retry)} against ${LIMIT})`);
	assert.ok(counted(retry) <= LIMIT);
	assert.ok(isReply(c.messages.at(-1)), "the recovered reply landed");
	assert.equal(markers(c)[0]!.details?.notice?.startsWith("This chat had grown too long"), true, "the recovery marker landed");
});

test("(b) a stated limit below the prompt and tool declarations: explained at once, nothing condensed or retried, and Repair refuses", async () => {
	const id = await newChat("Too small for its own prompt", "stub-x");
	await turn(id, paste(1));
	await turn(id, paste(2));
	const before = await chat(id);
	const start = stub.requests.length;
	const c = await turn(id, paste(3));
	assert.equal(stub.requests.length, start + 1, "one request, rejected; no summary, no retry");
	assert.equal(rejections, 1);
	assert.equal(markers(c).length, 0, "no fallback marker");
	assert.deepEqual(c.messages.slice(0, before.messages.length).map((m) => m.id), before.messages.map((m) => m.id), "the history is untouched");
	const failed = c.messages.at(-1)!;
	assert.equal(c.messages.length, before.messages.length + 2, "the learner's message and the explained rejection");
	assert.match(failed.errorMessage ?? "", /^This chat is still too long for stub-x/);
	assert.equal(failed.contextOverflow?.unrecoverable, true, "Repair is no longer offered");

	// The same chat as a pre-LH-55 build left it: the raw rejection,
	// still repairable. Repair explains at once and condenses nothing.
	const file = path.join(server.dataDir, "chats", `${id}.json`);
	const record = JSON.parse(fs.readFileSync(file, "utf-8")) as { messages: Msg[] };
	const raw = record.messages.at(-1)!;
	raw.errorMessage = raw.contextOverflow!.providerText;
	delete raw.contextOverflow;
	fs.writeFileSync(file, JSON.stringify(record));
	const repaired = await server.api(`/api/chats/${id}/repair`, { method: "POST" });
	assert.equal(repaired.status, 422, await repaired.text());
	const after = await chat(id);
	assert.equal(stub.requests.length, start + 1, "Repair sent nothing");
	assert.equal(markers(after).length, 0, "Repair landed no marker");
	assert.equal(after.messages.at(-1)!.contextOverflow?.unrecoverable, true, "and marked the chat unrecoverable");
});

test("(c) saving a custom window clears the pair's learned limit, and Repair does not learn it back", async () => {
	const id = await newChat("A limit the learner overrides");
	// Enough history for the recovery to condense.
	for (let part = 1; part <= 8; part++) await turn(id, paste(part));
	// The turn and its recovery retry are both rejected: Repair stays offered.
	forced = 2;
	const c = await turn(id, paste(9));
	assert.ok(c.messages.at(-1)!.contextOverflow && !c.messages.at(-1)!.contextOverflow!.unrecoverable, "Repair is offered");
	assert.deepEqual([(await modelRow("stub-q"))?.contextWindow, (await modelRow("stub-q"))?.learnedContextLimit], [LIMIT, LIMIT]);
	await server.json("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "stub-q", tokens: 200_000, confirmAboveMax: true } });
	const row = await modelRow("stub-q");
	assert.deepEqual([row?.contextWindow, row?.customContextWindow, row?.learnedContextLimit], [200_000, 200_000, undefined], "the saved window runs");
	assert.equal(readSettings().learnedContextLimits?.[`${STUB}:stub-q`], undefined);
	// The chat's old rejection still states 40,960: Repair must not learn it again.
	const repaired = await server.api(`/api/chats/${id}/repair`, { method: "POST" });
	assert.equal(repaired.status, 200, await repaired.text());
	const after = await modelRow("stub-q");
	assert.deepEqual([after?.contextWindow, after?.learnedContextLimit], [200_000, undefined], "Repair learned nothing from the old rejection");
	assert.equal(readSettings().learnedContextLimits?.[`${STUB}:stub-q`], undefined);
});

test("(d) the prefix fits but the retry is still held back: the history keeps its tail, and the learner gets the explanation", async () => {
	const id = await newChat("A little room", "stub-y");
	for (let n = 1; n <= 3; n++) await turn(id, short(n));
	const start = stub.requests.length;
	const c = await turn(id, short(4));
	const marker = c.messages.find((m) => m.customType === "compaction" && m.details?.notice);
	assert.ok(marker, "the recovery condensed the chat");
	const kept = c.messages.findIndex((m) => m.id === marker.details!.firstKeptMessageId);
	const learner = c.messages.findIndex((m) => m.role === "user" && text(m.content).includes("Part 4:"));
	assert.ok(kept >= 0 && kept < learner, `the kept tail holds more than the learner's last message (kept from ${kept}, learner at ${learner}): the history is not truncated to nothing`);
	const sent = stub.requests.slice(start).filter((r) => r.model === "stub-y" && isTurn(r));
	assert.equal(sent.length, 1, "the rejected turn only: the recovery retry was held back, never sent");
	const failed = c.messages.at(-1)!;
	assert.equal(failed.heldBack, true, "the last request was held back");
	assert.match(failed.errorMessage ?? "", /^This chat is still too long for stub-y/, "the learner gets the explanation");
	assert.equal(failed.contextOverflow?.providerText, undefined, "no provider text: the held-back retry reached no provider");
});
