import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { bootServer, freePort, until, type LhServer } from "./harness/server.ts";
import { reply, startStubProvider, type StubProvider } from "./harness/stub-provider.ts";
import { startStubClaude, type StubClaude, type StubClaudeReply, type StubClaudeRequest } from "./harness/stub-claude.ts";

// LH-62: with LH_CLAUDE_CODE_REUSE=1 a conversation keeps one Claude Code
// child (stub-claude-cli.mjs, spawned by the real Agent SDK through the
// real server). Each learner message reaches the same child through its
// streaming input, and each tool result answers the parked MCP call in that
// child, so request N+1 extends request N, as the prompt cache needs. A
// model or effort switch, an abort, an idle timeout, a restart, a
// compaction or an over-context recovery (LH-40) falls back to a new child
// that imports the record's history. The stub stands in for Claude Code's
// side of the protocol only; the live re-measure proves the real binary.

const TICKET = "lh-62";
const PREFIX = "mcp__custom-tools__";
const CONTINUE_TEXT = "[Continue from the tool result above.]";
const ASSESSMENT = { assessment: { strands: [{ strand: "limits", assessment: "Knows the idea, not the epsilon-delta form." }] } };
const QUESTION = "Ready for the formal definition?";
const SUMMARIZER = "You are the session-compaction summarizer";
const SUMMARY = [
	"## The learner's understanding",
	"The learner asked for a walk through limits and followed each step.",
	"## The teaching arc",
	"Several long explanations of limits.",
	"## The plan dependency tree",
	"(none yet)",
	"## The current moment",
	"The learner asked to keep going.",
].join("\n");
/** About 15k tokens: a few such replies outgrow a lowered threshold or a stated limit. */
const FILLER = "Limits describe what a function approaches. ".repeat(1400);
const TOO_LONG = "Prompt is too long: 130000 tokens > 100000 maximum";
const HAIKU = { provider: "claude-code", id: "claude-haiku-5-5" };

type Msg = { id?: string; role: string; content: unknown; customType?: string; stopReason?: string; details?: { notice?: string } };
type Chat = { messages: Msg[]; turnInFlight: boolean; compacting?: boolean };
type Block = { type: string; text?: string; id?: string; name?: string; toolCallId?: string };

const offers = (r: StubClaudeRequest, name: string) => r.tools.includes(PREFIX + name);
const toolUses = (r: StubClaudeRequest) => r.messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((b) => b.type === "tool_use") : []));
const called = (r: StubClaudeRequest, name: string) => toolUses(r).some((b) => b.name === PREFIX + name);
const learnerTexts = (r: StubClaudeRequest) =>
	r.messages.flatMap((m) => (m.role === "user" ? m.content.filter((b) => b.type === "text" && b.text !== CONTINUE_TEXT).map((b) => b.text!) : []));
const lastText = (r: StubClaudeRequest) => learnerTexts(r).at(-1) ?? "";
const isProber = (r: StubClaudeRequest) => offers(r, "probe_done");
const failedOnce = new Set<string>();

function respond(r: StubClaudeRequest): StubClaudeReply {
	if (r.system.startsWith(SUMMARIZER)) return { text: SUMMARY };
	const last = lastText(r);
	if (isProber(r) && !called(r, "probe_done")) return { tools: [{ name: "probe_done", arguments: ASSESSMENT }] };
	if (last.includes("[hang]")) return { hang: true };
	if (last.includes("[ask]") && !called(r, "ask_user_question")) return { text: "One question first.", tools: [{ name: "ask_user_question", arguments: { question: QUESTION } }] };
	if (last.includes("[too-long]") && !failedOnce.has(last)) {
		failedOnce.add(last);
		return { error: TOO_LONG };
	}
	return { text: `Reply to: ${last}${last.includes("[long]") ? ` ${FILLER}` : ""}` };
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0); // signal 0 sends nothing: it only asks whether the stub child still runs
		return true;
	} catch {
		return false;
	}
};

/** One booted server with its stub Claude Code; the chats are tagged so requests can be told apart. */
function harness(env: Record<string, string>, settings: Record<string, unknown> = {}) {
	const h = {} as { claude: StubClaude; stub: StubProvider; server: LhServer; port: number };
	const boot = async (seedDataDir?: string) => {
		h.port = await freePort();
		h.server = await bootServer({
			ticket: TICKET,
			port: h.port,
			headers: { origin: `http://127.0.0.1:${h.port}` },
			providers: [{ id: "e2e-stub", baseUrl: h.stub.baseUrl, models: [{ id: "stub-a" }] }],
			settings: { version: 1, models: { strong: { model: HAIKU }, cheap: { model: { provider: "e2e-stub", id: "stub-a" } }, vision: { model: { provider: "e2e-stub", id: "stub-a" } } }, graph: { enabled: false }, ...settings },
			env: { LH_CLAUDE_CODE_REUSE: "1", ...env },
			...(seedDataDir ? { seedDataDir } : {}),
		});
		if (!seedDataDir) await h.server.json("/api/claude-code", { method: "PUT", body: { mode: "local", executable: h.claude.executable } });
	};
	before(async () => {
		h.stub = await startStubProvider(() => reply.text(SUMMARY));
		h.claude = await startStubClaude(respond, TICKET);
		await boot();
	});
	after(async () => {
		await h.server?.stop();
		await h.claude?.close();
		await h.stub?.close();
	});

	const chats = new Map<string, string>();
	const chat = (tag: string) => h.server.json<Chat>(`/api/chats/${chats.get(tag)}`);
	const settle = (tag: string, label: string, done: (c: Chat) => boolean) =>
		until(async () => {
			const c = await chat(tag);
			return !c.turnInFlight && !c.compacting && done(c) ? c : null;
		}, label, 240_000);
	const post = (tag: string, input: unknown) => h.server.api("/api/chat", { body: { chatId: chats.get(tag), input } });
	async function say(tag: string, text: string): Promise<Chat> {
		const message = `[${tag}] ${text}`;
		const res = await post(tag, { type: "text", text: message });
		assert.equal(res.status, 200, await res.clone().text());
		await res.arrayBuffer();
		return settle(tag, `the reply to ${message}`, (c) => answered(c, message));
	}
	/** A new chat through the prober and the handoff, ending with the teacher's child live. */
	async function open(tag: string): Promise<void> {
		chats.set(tag, (await h.server.json<{ id: string }>("/api/chats", { body: { title: tag } })).id);
		await say(tag, "Teach me limits.");
		await say(tag, "Go on.");
		await settle(tag, "the teacher's reply to the handoff", (c) => {
			const handoff = c.messages.findIndex((m) => m.role === "custom");
			return handoff >= 0 && c.messages.slice(handoff + 1).some((m) => m.role === "assistant");
		});
	}
	const requestsOf = (tag: string) => h.claude.requests.filter((r) => learnerTexts(r).some((t) => t.startsWith(`[${tag}]`)));
	const teacher = (tag: string) => requestsOf(tag).filter((r) => !isProber(r) && !r.system.startsWith(SUMMARIZER));
	const spawned = (pid: number) => h.claude.spawns.find((s) => s.pid === pid)!;
	return { h, boot, chats, chat, settle, post, say, open, requestsOf, teacher, spawned };
}

/** The record holds a reply to the learner's newest copy of `message`; a later turn (the handoff) may follow it. */
function answered(c: Chat, message: string): boolean {
	const asked = c.messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(JSON.stringify(message).slice(1, -1)));
	return asked >= 0 && c.messages.slice(asked + 1).some((m) => m.role === "assistant" && JSON.stringify(m.content).includes(`Reply to: ${message}`));
}

/** The record as the model reads it (role, text, tool ids), to compare with what the child received. */
function recordTokens(messages: Msg[]): string[] {
	return messages.flatMap((m) => {
		const blocks: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content as Block[] : [];
		if (m.role === "toolResult") return [`result:${(m as unknown as { toolCallId: string }).toolCallId}`];
		const side = m.role === "assistant" ? "a" : "u";
		return blocks.flatMap((b) => (b.type === "text" && b.text ? [`${side}:${b.text}`] : b.type === "toolCall" ? [`call:${b.id}`] : []));
	});
}
function requestTokens(r: StubClaudeRequest): string[] {
	return r.messages.flatMap((m) => m.content.flatMap((b) => {
		if (b.type === "text") return b.text && b.text !== CONTINUE_TEXT ? [`${m.role === "assistant" ? "a" : "u"}:${b.text}`] : [];
		if (b.type === "tool_use") return [`call:${b.id}`];
		if (b.type === "tool_result") return [`result:${b.tool_use_id}`];
		return [];
	}));
}
/** Request `next` repeats `prev` byte for byte, then adds the child's reply and the new input. */
function assertExtends(next: StubClaudeRequest, prev: StubClaudeRequest, label: string): void {
	assert.equal(next.pid, prev.pid, `${label}: same child`);
	assert.equal(next.sessionId, prev.sessionId, `${label}: same session id`);
	assert.deepEqual(next.messages.slice(0, prev.messages.length), prev.messages, `${label}: the earlier request is a prefix`);
	assert.equal(next.messages[prev.messages.length]?.role, "assistant", `${label}: then the child's own reply`);
}

describe("one live child per conversation", () => {
	const t = harness({ LH_CLAUDE_CODE_MAX_CHILDREN: "3" });

	test("learner messages and tool results continue the same child, request after request", async () => {
		await t.open("a");
		await t.say("a", "And then?");
		await t.say("a", "Keep going.");

		const probe = t.requestsOf("a").filter(isProber);
		const done = toolUses(probe[1]!)[0];
		assert.equal(done?.name, `${PREFIX}probe_done`);
		assertExtends(probe[1]!, probe[0]!, "probe_done's result");
		const result = probe[1]!.messages.at(-1)!.content.find((b) => b.type === "tool_result");
		assert.equal(result?.tool_use_id, done!.id, "the parked call got its own result");
		assert.match(JSON.stringify(result?.content), /Assessment recorded/);
		assert.equal(probe[0]!.maxTurns, undefined, "a live child has no turn cap");

		// The teacher's prompt and tools differ from the prober's: one fresh import, then continuation.
		const turns = t.teacher("a");
		assert(turns.length >= 4, `the teacher answered every message (${turns.length})`);
		assert.match(t.spawned(turns[0]!.pid).argv.join(" "), /--resume/, "the teacher's child imported the prober's history");
		for (let i = 1; i < turns.length; i++) assertExtends(turns[i]!, turns[i - 1]!, `teacher request ${i + 1}`);
		await until(() => !alive(probe[0]!.pid), "the prober's child to exit", 30_000);
		assert(alive(turns[0]!.pid), "the teacher's child stays alive between turns");

		const record = await t.chat("a");
		assert.deepEqual(requestTokens(turns.at(-1)!), recordTokens(record.messages.slice(0, -1)), "the child received exactly the chat record");
		assert.match(t.h.server.log(), /claude-code: live session closed \(model, effort, prompt or tools changed\)/);
	});

	test("a question answered after a pause resolves the parked call in the same child", async () => {
		await t.open("b");
		const res = await t.post("b", { type: "text", text: "[b] [ask] Check me." });
		assert.equal(res.status, 200);
		await res.arrayBuffer();
		const posed = await t.settle("b", "the question card", (c) => JSON.stringify(c.messages.at(-1)?.content ?? "").includes("ask_user_question"));
		const ask = (posed.messages.at(-1)!.content as Block[]).find((b) => b.type === "toolCall")!;
		const asked = t.teacher("b").at(-1)!;
		await new Promise((r) => setTimeout(r, 8_000)); // the learner thinks
		assert(alive(asked.pid), "the parked child survives the pause");

		const answer = await t.post("b", { type: "answer", toolCallId: ask.id, answer: { kind: "ask", questionText: QUESTION, dontKnow: false, answers: [], text: "Yes", answeredAt: new Date().toISOString() } });
		assert.equal(answer.status, 200, await answer.clone().text());
		await answer.arrayBuffer();
		await t.settle("b", "the reply after the answer", (c) => answered(c, "[b] [ask] Check me."));
		const next = t.teacher("b").at(-1)!;
		assertExtends(next, asked, "the answer");
		const result = next.messages.at(-1)!.content.find((b) => b.type === "tool_result");
		assert.equal(result?.tool_use_id, ask.id);
		assert.match(JSON.stringify(result?.content), /Yes/);
	});

	test("an effort or model switch starts a new child from the record", async () => {
		const before = t.teacher("b").at(-1)!;
		await t.h.server.json(`/api/chats/${t.chats.get("b")}/settings`, { method: "PUT", body: { model: HAIKU, thinkingLevel: "high" } });
		await t.say("b", "Harder now.");
		const harder = t.teacher("b").at(-1)!;
		assert.notEqual(harder.pid, before.pid);
		assert.equal(harder.effort, "high");
		assert.match(t.spawned(harder.pid).argv.join(" "), /--resume/);
		assert.deepEqual(requestTokens(harder), recordTokens((await t.chat("b")).messages.slice(0, -1)));

		await t.h.server.json(`/api/chats/${t.chats.get("b")}/settings`, { method: "PUT", body: { model: { provider: "claude-code", id: "claude-sonnet-5-5" }, thinkingLevel: "high" } });
		await t.say("b", "Another model.");
		const other = t.teacher("b").at(-1)!;
		assert.notEqual(other.pid, harder.pid);
		assert.match(other.model ?? "", /sonnet-5-5/);
		await until(() => !alive(before.pid) && !alive(harder.pid), "the replaced children to exit", 30_000);
	});

	test("an abort mid-request closes the child; the next turn imports the history", async () => {
		const pending = t.post("b", { type: "text", text: "[b] [hang] Wait." });
		const hung = await until(() => t.teacher("b").find((r) => lastText(r) === "[b] [hang] Wait."), "the hung request", 60_000);
		const abort = await t.h.server.api("/api/activity/abort", { body: { kind: "turn", id: t.chats.get("b") } });
		assert.equal(abort.status, 200, await abort.clone().text());
		await (await pending).arrayBuffer();
		await until(() => !alive(hung.pid), "the aborted child to exit", 30_000);
		await t.settle("b", "the aborted turn to settle", () => true);

		await t.say("b", "After the stop.");
		const after = t.teacher("b").at(-1)!;
		assert.notEqual(after.pid, hung.pid);
		assert.match(t.spawned(after.pid).argv.join(" "), /--resume/);
		assert(learnerTexts(after).includes("[b] [hang] Wait."), "the interrupted message stays in the history");
		assert.deepEqual(requestTokens(after), recordTokens((await t.chat("b")).messages.slice(0, -1)));
	});

	test("two conversations at once keep their own children", async () => {
		await Promise.all([t.open("c"), t.open("d")]);
		await Promise.all([t.say("c", "Next for c."), t.say("d", "Next for d.")]);
		const c = t.teacher("c"), d = t.teacher("d");
		assert(!t.h.claude.requests.some((r) => learnerTexts(r).some((x) => x.startsWith("[c]")) && learnerTexts(r).some((x) => x.startsWith("[d]"))), "no request mixes the chats");
		assert.equal(new Set(c.map((r) => r.pid)).size, 1, "c's teacher stays on one child");
		assert.equal(new Set(d.map((r) => r.pid)).size, 1, "d's teacher stays on one child");
		assert.notEqual(c[0]!.pid, d[0]!.pid);
		for (let i = 1; i < c.length; i++) assertExtends(c[i]!, c[i - 1]!, `c request ${i + 1}`);
		for (let i = 1; i < d.length; i++) assertExtends(d[i]!, d[i - 1]!, `d request ${i + 1}`);
	});
});

describe("the child cap and compaction", () => {
	const t = harness({ LH_CLAUDE_CODE_MAX_CHILDREN: "2", LH_MAX_OUTPUT_TOKENS: "16000" }, { compaction: { thresholdTokens: 60_000 } });

	test("a full cap evicts the least recently used idle child", async () => {
		await t.open("e");
		await t.open("f");
		await t.say("e", "Still here.");
		const e = t.teacher("e").at(-1)!.pid, f = t.teacher("f").at(-1)!.pid;
		assert(alive(e) && alive(f), "two live children fill the cap");
		await t.open("g");
		await until(() => !alive(f), "f's idle child to be evicted", 30_000);
		assert(alive(e), "e was used more recently and stays");
		assert.match(t.h.server.log(), /live session closed \(evicted for another conversation\)/);

		await t.say("f", "Back.");
		const back = t.teacher("f").at(-1)!;
		assert.notEqual(back.pid, f);
		assert.deepEqual(requestTokens(back), recordTokens((await t.chat("f")).messages.slice(0, -1)), "f's new child imported its whole record");
	});

	test("a compaction rewrites the history: the next call starts a new child from it", async () => {
		await t.open("h");
		const compacted = async () => (await t.settle("h", "compaction to finish", () => true)).messages.some((m) => m.customType === "compaction");
		for (let part = 1; part <= 8 && !(await compacted()); part++) await t.say("h", `[long] Part ${part}.`);
		assert(await compacted(), "the threshold compaction ran");
		await t.say("h", "After the summary.");
		const turns = t.teacher("h");
		const first = turns.findIndex((r) => JSON.stringify(r.messages).includes("The learner asked for a walk through limits"));
		assert(first > 0, "a call after the compaction carried the summary");
		assert.notEqual(turns[first]!.pid, turns[first - 1]!.pid, "the compacted history no longer extends the child's");
		assert.match(t.spawned(turns[first]!.pid).argv.join(" "), /--resume/);
		for (let i = first + 1; i < turns.length; i++) assertExtends(turns[i]!, turns[i - 1]!, `request ${i + 1} after the compaction`);
		assert.match(t.h.server.log(), /live session closed \(history changed\)/);
		await until(() => !alive(turns[first - 1]!.pid), "the old child to exit", 30_000);
	});
});

describe("idle close, recovery and restart", () => {
	const IDLE_MS = 5_000;
	const t = harness({ LH_CLAUDE_CODE_IDLE_MS: String(IDLE_MS), LH_MAX_OUTPUT_TOKENS: "16000" });

	test("an idle child closes; the next turn imports the record", async () => {
		await t.open("i");
		const pid = t.teacher("i").at(-1)!.pid;
		await until(() => !alive(pid), "the idle child to exit", IDLE_MS + 30_000);
		assert.match(t.h.server.log(), /live session closed \(idle\)/);
		await t.say("i", "Back again.");
		const back = t.teacher("i").at(-1)!;
		assert.notEqual(back.pid, pid);
		assert.match(t.spawned(back.pid).argv.join(" "), /--resume/);
		assert.deepEqual(requestTokens(back), recordTokens((await t.chat("i")).messages.slice(0, -1)));
	});

	test("an over-context error closes the child; the recovered retry imports the condensed history", async () => {
		await t.open("j");
		for (let part = 1; part <= 6; part++) await t.say("j", `[long] Part ${part}.`);
		const res = await t.post("j", { type: "text", text: "[j] [too-long] One more." });
		assert.equal(res.status, 200);
		await res.arrayBuffer();
		const recovered = await t.settle("j", "the recovered reply", (c) => answered(c, "[j] [too-long] One more."));
		assert(recovered.messages.some((m) => m.customType === "compaction" && m.details?.notice), "LH-40 recovered from Claude Code's prompt-too-long error");
		const turns = t.teacher("j").filter((r) => lastText(r) === "[j] [too-long] One more.");
		const [failed, retried] = [turns[0]!, turns.at(-1)!];
		assert.notEqual(retried.pid, failed.pid, "the failed call closed its child");
		assert.match(JSON.stringify(retried.messages), /The learner asked for a walk through limits/, "the retry carries the summary");
		assert(!learnerTexts(retried).includes("[j] [long] Part 1."), "and not the condensed messages");
	});

	test("after a restart the conversation continues in a new child from the record", async () => {
		const copy = fs.mkdtempSync(path.join(path.dirname(t.h.server.dataDir), "..", "seed-"));
		fs.cpSync(t.h.server.dataDir, copy, { recursive: true });
		const before = t.teacher("i").at(-1)!;
		await t.h.server.stop();
		await until(() => !alive(before.pid), "the old server's children to exit", 30_000);
		try {
			await t.boot(copy);
		} finally {
			fs.rmSync(copy, { recursive: true, force: true });
		}
		await t.say("i", "After restart.");
		const after = t.teacher("i").at(-1)!;
		assert.notEqual(after.pid, before.pid);
		assert.match(t.spawned(after.pid).argv.join(" "), /--resume/);
		assert.deepEqual(requestTokens(after), recordTokens((await t.chat("i")).messages.slice(0, -1)));
	});
});
