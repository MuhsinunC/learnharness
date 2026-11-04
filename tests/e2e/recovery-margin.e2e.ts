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
// (e) A rejected chat smaller than a quarter of the budget: its last
// message alone is the last-resort tail, and the retry is answered.
// (f) LH-54: the rejection that teaches the limit states what OpenRouter
// counted, so it teaches the overcount too: from then on every request
// keeps a margin that grows with its input, and none is rejected again,
// on the way to the threshold compaction or past it. pi-ai's flat 4,096
// covers the 1.18x count only below ~22.8k tokens: the live re-check's
// part 15 (23.9k) was rejected 257 over and condensed.
// (h) LH-54: a large window (163,840, max output 16k) on that count. The
// margin brings the held-back floor down to ~134.5k, so the threshold
// compaction comes down with it (to ~119k) and still lands first: no
// turn is held back or rejected. Sized from the flat 4,096, it fired at
// 143.4k (the window less the reserve, under the default 150k) while
// requests were held back from ~135.7k.
// (l) LH-54 review: a stored ratio above any real overcount (a hand-
// edited 50) is read as the most the app believes, 2x: the turn is sent,
// not held back.
// (m) A later rejection's count replaces the learned ratio, down as well
// as up: a 1.5 learned before is replaced by the 1.18 the provider counts.
// (n) Saving the pair's window in Settings forgets its learned ratio, as
// it forgets the learned limit.
// (o) OpenAI's breakdown ("N in the messages, M in the functions, and K
// in the completion"): the input is messages plus functions, the very
// parts pi-ai's estimate covers, so the ratio comes out at 1.18 too.

const LIMIT = 40_960;
const MAX_OUTPUT = 16_384;
/** stub-w's window: the catalog's, no custom window over it. */
const WIDE = 163_840;
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
/** The tool declarations alone, at chars/3.5. */
const toolWire = (req: StubRequest) => Math.ceil(JSON.stringify(((req.body.tools ?? []) as Array<{ function: unknown }>).map((t) => t.function)).length / 3.5);
/** OpenRouter's pre-flight, in the parts its rejection states: 1.18x the
 *  estimate of the text and of the tool declarations, and the reply's
 *  max_tokens. */
const countedParts = (req: StubRequest) => ({ text: Math.ceil(1.18 * (wireTokens(req) - toolWire(req))), tool: Math.ceil(1.18 * toolWire(req)), output: maxOutputTokens(req) });
const counted = (req: StubRequest) => { const { text, tool, output } = countedParts(req); return text + tool + output; };
const limitOf = (req: StubRequest) => req.model === "stub-w" ? WIDE : LIMIT;
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
	if (counted(req) > limitOf(req)) {
		rejections++;
		return reply.contextLength(limitOf(req), countedParts(req), req.model === "stub-p" ? "openai" : "openrouter");
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
		providers: [{ id: STUB, baseUrl: stub.baseUrl, models: [...["stub-q", "stub-x", "stub-y", "stub-p"].map((id) => ({ id, contextWindow: LIMIT, maxTokens: MAX_OUTPUT })), { id: "stub-w", contextWindow: WIDE, maxTokens: MAX_OUTPUT }] }],
		settings: {
			version: 1,
			models: { strong: slot, cheap: slot, vision: slot },
			contextWindows: { [`${STUB}:stub-q`]: 1_000_000, [`${STUB}:stub-x`]: 1_000_000, [`${STUB}:stub-y`]: 1_000_000, [`${STUB}:stub-p`]: 1_000_000 },
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
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), "utf-8")) as Record<string, unknown> & { learnedContextLimits?: Record<string, number>; learnedOvercounts?: Record<string, number> };
const writeSettings = (patch: Record<string, unknown>) => fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, "\t"));
type ModelRow = { id: string; contextWindow: number; customContextWindow?: number; learnedContextLimit?: number };
const modelRow = async (id: string) => (await server.json<{ models: ModelRow[] }>("/api/models")).models.find((m) => m.id === id);

async function newChat(title: string, model = "stub-q"): Promise<string> {
	writeSettings({ learnedContextLimits: {}, learnedOvercounts: {} });
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
	// The chat's old rejection still states 40,960: Repair must neither
	// learn it again nor condense toward it. The chat fits the saved
	// window, so nothing is dropped.
	const condensed = markers(await chat(id)).length;
	const repaired = await server.api(`/api/chats/${id}/repair`, { method: "POST" });
	assert.equal(repaired.status, 200, await repaired.text());
	assert.equal(markers(await chat(id)).length, condensed, "Repair did not condense toward the old 40,960");
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
	// Older history is still left to condense, so Repair stays offered.
	assert.equal(
		failed.errorMessage,
		"This chat is still too long for stub-y after condensing its older part once. Press Repair this chat to condense it further, or start a new session.",
	);
	assert.notEqual(failed.contextOverflow?.unrecoverable, true, "Repair is still offered");
	assert.equal(failed.contextOverflow?.providerText, undefined, "no provider text: the held-back retry reached no provider");
});

test("(e) a rejected chat whose history is smaller than a quarter of the budget still condenses to its last message and is answered", async () => {
	const id = await newChat("A short chat, rejected anyway");
	await turn(id, paste(1));
	await turn(id, paste(2));
	forced = 1;
	const c = await turn(id, paste(3));
	assert.equal(rejections, 1);
	assert.equal(markers(c).filter((m) => m.details?.notice).length, 1, "the last-resort cut landed");
	assert.ok(isReply(c.messages.at(-1)), "the retry is answered, not marked unrecoverable");
});

/** Above this estimate pi-ai's flat 4,096-token margin no longer covers
 *  the stub's 1.18x count: 0.18 × estimate > 4,096. */
const FLAT_MARGIN_COVERS = Math.floor(4_096 / 0.18);

test("(f) the rejection that teaches the limit teaches the 1.18x count too: no request is rejected again, up to the threshold compaction or past the flat margin's reach", async () => {
	const id = await newChat("Derivatives, counted high, to the threshold");
	let c = await chat(id);
	for (let part = 1; markers(c).length === 0; part++) {
		assert.ok(part <= 30, "the chat outgrows the real window within 30 turns");
		c = await turn(id, paste(part));
	}
	assert.equal(rejections, 1, "the custom 1M window is rejected once");
	assert.equal(readSettings().learnedContextLimits?.[`${STUB}:stub-q`], LIMIT, "the limit is learned");
	const overcount = readSettings().learnedOvercounts?.[`${STUB}:stub-q`];
	assert.ok(overcount !== undefined && Math.abs(overcount - 1.18) < 0.02, `the 1.18x count is learned from the same rejection (${overcount})`);
	const start = stub.requests.length;
	for (let part = 31; markers(c).length === 1; part++) {
		assert.ok(part <= 60, "the threshold compaction lands within 30 more turns");
		c = await turn(id, paste(part));
		assert.ok(isReply(c.messages.filter((m) => m.role === "assistant").at(-1)), `part ${part} was answered`);
	}
	assert.equal(markers(c).at(-1)!.details?.notice, undefined, "the threshold compaction, never a second recovery");
	// One paste lands the next request between the flat margin's reach and
	// the held-back floor, (40,960 − 4,096 − 1,024) / 1.18 ≈ 30.4k.
	const sent = () => stub.requests.slice(start).filter((r) => r.model === "stub-q" && isTurn(r));
	const grow = 26_000 - wireTokens(sent().at(-1)!) - Math.ceil(REPLY.length / 3.5);
	c = await turn(id, `Part 99: all of it again. ${NOTES.repeat(Math.ceil((grow * 3.5) / NOTES.length))}`);
	assert.ok(isReply(c.messages.filter((m) => m.role === "assistant").at(-1)), "the big paste is answered");
	const band = sent().filter((r) => wireTokens(r) > FLAT_MARGIN_COVERS);
	assert.ok(band.length > 0, `a request went out above ${FLAT_MARGIN_COVERS} tokens (largest ${Math.max(...sent().map(wireTokens))})`);
	// The margin reaches the wire as the reply's max_tokens (LH-54 review):
	// every such request asks for less than the model's 16,384.
	assert.ok(band.every((r) => maxOutputTokens(r) < MAX_OUTPUT), `max_tokens ${band.map(maxOutputTokens).join(", ")} clamped under ${MAX_OUTPUT}`);
	assert.equal(rejections, 1, `no request was rejected after the first (counted ${band.map(counted).join(", ")} against ${LIMIT})`);
});

/** stub-w's paste: about 5.5k wire tokens, far under the ~15k the
 *  threshold leaves below the held-back floor. */
const widePaste = (n: number) => `Part ${n}: my next worked attempt. ${NOTES.repeat(235)}`;

test("(h) a 163,840 window that counts 1.18x: the chat compacts on time, and no turn is held back or rejected", async () => {
	const id = await newChat("A wide window, counted high", "stub-w");
	writeSettings({ learnedOvercounts: { [`${STUB}:stub-w`]: 1.18 } });
	const start = stub.requests.length;
	let c = await chat(id);
	for (let part = 1; markers(c).length === 0; part++) {
		assert.ok(part <= 40, "the threshold compaction lands within 40 turns");
		c = await turn(id, widePaste(part));
		const last = c.messages.filter((m) => m.role === "assistant").at(-1);
		assert.ok(isReply(last), `part ${part} was answered (${last?.errorMessage ?? ""})`);
	}
	const sent = stub.requests.slice(start).filter((r) => r.model === "stub-w" && isTurn(r));
	assert.ok(Math.max(...sent.map(wireTokens)) > 110_000, `the chat grew near the threshold (largest ${Math.max(...sent.map(wireTokens))})`);
	assert.equal(rejections, 0, "no request was rejected");
	assert.deepEqual(c.messages.filter((m) => m.heldBack).map((m) => m.errorMessage), [], "no turn was held back");
	assert.deepEqual(markers(c).map((m) => m.details?.notice), [undefined], "the threshold compaction, never a recovery");
});

/** Turns until the chat's first marker: the rejection's recovery. */
async function untilRecovered(id: string): Promise<Chat> {
	let c = await chat(id);
	for (let part = 1; markers(c).length === 0; part++) {
		assert.ok(part <= 30, "the chat outgrows the real window within 30 turns");
		c = await turn(id, paste(part));
	}
	return c;
}

test("(l) a stored ratio above any real overcount (a hand-edited 50) is read as 2x: the turn is sent, not held back", async () => {
	const id = await newChat("A hand-edited ratio");
	writeSettings({ learnedContextLimits: { [`${STUB}:stub-q`]: LIMIT }, learnedOvercounts: { [`${STUB}:stub-q`]: 50 } });
	const start = stub.requests.length;
	const c = await turn(id, paste(1));
	const last = c.messages.filter((m) => m.role === "assistant").at(-1);
	assert.ok(isReply(last), `the turn is answered (${last?.errorMessage ?? ""})`);
	assert.ok(stub.requests.slice(start).some((r) => r.model === "stub-q" && isTurn(r)), "the request reached the provider");
	assert.equal(rejections, 0);
});

test("(m) a later rejection's count replaces the learned ratio, down as well as up", async () => {
	const id = await newChat("A ratio learned too high");
	writeSettings({ learnedOvercounts: { [`${STUB}:stub-q`]: 1.5 } });
	await untilRecovered(id);
	assert.equal(rejections, 1, "the custom 1M window is rejected once");
	const overcount = readSettings().learnedOvercounts?.[`${STUB}:stub-q`];
	assert.ok(overcount !== undefined && Math.abs(overcount - 1.18) < 0.02, `the 1.18x count replaced the 1.5 (${overcount})`);
});

test("(n) saving the pair's window in Settings forgets its learned ratio; another pair keeps its own", async () => {
	await newChat("A ratio the learner resets");
	writeSettings({ learnedOvercounts: { [`${STUB}:stub-q`]: 1.18, [`${STUB}:stub-w`]: 1.18 } });
	await server.json("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "stub-q", tokens: 1_000_000, confirmAboveMax: true } });
	assert.equal(readSettings().learnedOvercounts?.[`${STUB}:stub-q`], undefined, "the saved pair's ratio is forgotten");
	assert.equal(readSettings().learnedOvercounts?.[`${STUB}:stub-w`], 1.18, "the other pair's stays");
});

test("(o) OpenAI's breakdown of messages, functions and completion teaches the same 1.18x", async () => {
	const id = await newChat("Counted high, in OpenAI's words", "stub-p");
	await untilRecovered(id);
	assert.equal(rejections, 1, "the custom 1M window is rejected once");
	const rejected = stub.requests.filter((r) => r.model === "stub-p" && isTurn(r) && counted(r) > LIMIT).at(0)!;
	assert.ok(toolWire(rejected) > 1_000, `the functions are a real share of the request (${toolWire(rejected)} of ${wireTokens(rejected)})`);
	const overcount = readSettings().learnedOvercounts?.[`${STUB}:stub-p`];
	assert.ok(overcount !== undefined && Math.abs(overcount - 1.18) < 0.02, `messages plus functions over the estimate (${overcount})`);
});
