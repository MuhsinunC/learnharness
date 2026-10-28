import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { inputTokens, maxOutputTokens, reply, requestTokens, startStubProvider, type StubProvider, type StubRequest, type StubResponder } from "./harness/stub-provider.ts";

// LH-50, the live OB-0645 run: OpenRouter qwen/qwen3-14b (real window
// 40,960, max output 16,384) under a custom 1M window. The stub enforces
// the real window the way that provider does: the serialized input
// (messages and tool declarations) PLUS the request's max_tokens. Its
// usage reports the input it counted, so the threshold compaction's usage
// anchor behaves as with a real provider. The learner pastes ~2k tokens a
// turn. Before LH-50 the first rejection recovered, then the next turns
// were rejected again (max_tokens kept asking 16,384 against the 1M
// window), and the chat ended unrecoverable with Repair refused.

const LIMIT = 40_960;
const MAX_OUTPUT = 16_384;
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
	contextOverflow?: { providerText: string; unrecoverable?: boolean };
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
	if (requestTokens(req) > LIMIT || (isTurnRequest(req) && forcedRejections > 0 && forcedRejections--)) {
		rejections++;
		return reply.contextLength(LIMIT);
	}
	if (!isTurnRequest(req)) return reply.text(SUMMARY);
	const text = `Answering part ${lastPart(req)}. ${REPLY}`;
	return reply.text(text, { prompt_tokens: inputTokens(req), completion_tokens: Math.ceil(text.length / 4) });
};

let stub: StubProvider;
let server: LhServer;

before(async () => {
	stub = await startStubProvider(responder);
	const slot = { model: { provider: STUB, id: "stub-q" } };
	server = await bootServer({
		ticket: "lh-50",
		providers: [{ id: STUB, baseUrl: stub.baseUrl, models: [{ id: "stub-q", contextWindow: LIMIT, maxTokens: MAX_OUTPUT }] }],
		settings: {
			version: 1,
			models: { strong: slot, cheap: slot, vision: slot },
			contextWindows: { [`${STUB}:stub-q`]: 1_000_000 },
			graph: { enabled: false },
		},
	});
	// A keyed provider, so the catalog and the threshold see its window (as in context-recovery.e2e.ts).
	await server.json(`/api/keys/OPENROUTER_API_KEY`, { method: "PUT", body: { value: "e2e-dummy-key-not-real" } });
});

after(async () => {
	await server?.stop();
	await stub?.close();
});

const chat = (id: string) => server.json<Chat>(`/api/chats/${id}`);
const isReply = (m: Msg | undefined) => m?.role === "assistant" && m.stopReason !== "error";
const replies = (c: Chat) => c.messages.filter(isReply).length;
const recoveryMarkers = (c: Chat) => c.messages.filter((m) => m.customType === "compaction" && m.details?.notice);
const learned = () =>
	(JSON.parse(fs.readFileSync(path.join(server.dataDir, "settings.json"), "utf-8")) as { learnedContextLimits?: Record<string, number> })
		.learnedContextLimits?.[`${STUB}:stub-q`];

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
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Derivatives by hand" } });

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
