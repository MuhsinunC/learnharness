import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import type { Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getProjectDir } from "cc-session-io";
import type { ChatInput } from "../src/core/input-events.ts";

// config.ts resolves its data directory at import time, before any store loads.
const root = mkdtempSync(join(tmpdir(), "lh-chat-flow-"));
const savedEnv = { HOME: process.env.HOME, LH_DATA_DIR: process.env.LH_DATA_DIR, LH_AUTH_FILE: process.env.LH_AUTH_FILE };
const home = join(root, "home"), dataDir = join(root, "data"), claudeDir = join(home, ".claude");
mkdirSync(home);
process.env.HOME = home;
process.env.LH_DATA_DIR = dataDir;
process.env.LH_AUTH_FILE = join(root, "auth.json");

const { enableClaudeCodeProvider, resetClaudeCodeProviderForTests, piEngineForSpec } = await import("../src/agent/models.ts");
const { resetClaudeCodeStreamForTests } = await import("../src/agent/claude-code/stream.ts");
const { CONTINUE_TEXT } = await import("../src/agent/claude-code/query-options.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { danglingQuestionOf } = await import("../src/core/native-messages.ts");
const { projectView } = await import("../src/core/view.ts");
const { buildAnswer, normalizeOptions, resolveCorrect } = await import("../src/core/question-core.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { deliverJobResult } = await import("../src/server/jobs.ts");
const { resolveRoleSpec } = await import("../src/core/settings-resolution.ts");
const { turnCost, jobCost } = await import("../src/core/prices.ts");

const strong = { provider: "claude-code", id: "claude-opus-5-5" };
const cheap = { provider: "claude-code", id: "claude-haiku-5-5" };
const quiz = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury", explanation: "Mercury is the innermost planet.", type: "check", nodeId: "planet-order",
};
const usage = { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 13, cache_creation_input_tokens: 5 };
const sdk = (message: unknown) => message as SDKMessage;
const event = (type: string, fields = {}) => sdk({ type: "stream_event", event: { type, ...fields } });
type Call = { prompt: SDKUserMessage[]; options: Options; file?: string; parked: string[] };
type Step = { text: string; model?: string; beforeReply?: () => Promise<void>; tool?: { name: string; input: Record<string, unknown> } };
const networkAttempts: string[] = [];

beforeEach(() => {
	// Fail before any transport can leave the process, including accidental provider fallbacks.
	networkAttempts.length = 0;
	mock.method(globalThis, "fetch", (input: RequestInfo | URL) => {
		networkAttempts.push(`fetch ${input instanceof Request ? input.url : String(input)}`);
		assert.fail("network fetch forbidden");
	});
	mock.method(Socket.prototype, "connect", (...args: unknown[]) => {
		networkAttempts.push(`socket ${args.map(String).join(" ")}`);
		assert.fail("network socket forbidden");
	});
	resetClaudeCodeProviderForTests();
	resetClaudeCodeStreamForTests();
	settingsStore.writeSettings({ version: 1, models: { strong: { model: strong }, cheap: { model: cheap } }, graph: { enabled: false } });
});
afterEach(async () => {
	await tick();
	try {
		assert.deepEqual(networkAttempts, []);
	} finally {
		mock.restoreAll();
		resetClaudeCodeProviderForTests();
		resetClaudeCodeStreamForTests();
	}
	assert.equal(providerKeyPresent("claude-code"), false);
});
after(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

function register(steps: Step[]) {
	const calls: Call[] = [];
	const stub = join(root, "claude-stub");
	writeFileSync(stub, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
	const fakeLoader = async () => (({ prompt, options }: Parameters<typeof query>[0]) => {
		assert.ok(options);
		assert.equal(options.maxTurns, 1);
		assert.equal(options.persistSession, false);
		assert.equal(options.extraArgs?.model, steps[calls.length]?.model ?? "claude-opus-5-5[1m]");
		assert.equal(options.env?.HOME, home);
		assert.equal(options.pathToClaudeCodeExecutable, stub);
		const call: Call = { prompt: [], options, parked: [] };
		if (options.resume) call.file = readFileSync(join(getProjectDir(options.cwd!, claudeDir), options.resume + ".jsonl"), "utf8");
		const step = steps[calls.length];
		assert.ok(step, "unexpected query call");
		calls.push(call);
		let close!: () => void;
		const closed = new Promise<IteratorResult<SDKMessage>>(resolve => { close = () => resolve({ done: true, value: undefined }); });
		const iterator = (async function* () {
			for await (const message of prompt as AsyncIterable<SDKUserMessage>) call.prompt.push(message);
			await step.beforeReply?.();
			yield event("message_start", { message: { id: `msg-${calls.length}`, usage: { ...usage, output_tokens: 1 } } });
			yield event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			yield event("content_block_delta", { index: 0, delta: { type: "text_delta", text: step.text } });
			yield event("content_block_stop", { index: 0 });
			let parked: Promise<unknown> | undefined;
			if (step.tool) {
				yield event("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call-1", name: `mcp__custom-tools__${step.tool.name}`, input: step.tool.input } });
				yield event("content_block_stop", { index: 1 });
				// Same in-process SDK endpoint as claude-code-stream.test.ts.
				const config = options.mcpServers!["custom-tools"] as any;
				parked = config.instance.server._requestHandlers.get("tools/call")({ method: "tools/call", params: {
					name: step.tool.name, arguments: step.tool.input, _meta: { "claudecode/toolUseId": "call-1" },
				} }, { signal: new AbortController().signal });
				call.parked.push(step.tool.name);
			}
			yield event("message_delta", { delta: { stop_reason: step.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: usage.output_tokens } });
			yield event("message_stop");
			if (parked) await parked;
			yield sdk({ type: "result", subtype: "success", is_error: false });
		})();
		return {
			[Symbol.asyncIterator]() { return this; }, next: () => Promise.race([iterator.next(), closed]),
			return: async () => ({ done: true, value: undefined }), interrupt: async () => {}, close,
		};
	}) as unknown as typeof query;
	enableClaudeCodeProvider(stub, { loadQuery: fakeLoader, claudeDirForTests: claudeDir, dataDir });
	assert.equal(providerKeyPresent("claude-code"), true);
	return calls;
}

function teacherChat() {
	const chat = chatStore.createChat("Fake SDK lesson");
	// A concluded probe selects the real teacher branch, with its plan tools.
	chatStore.saveMessages(chat.id, [
		{ ...fauxAssistantMessage([fauxToolCall("probe_done", {}, { id: "probe" })], { stopReason: "toolUse" }), id: "probe-message" },
		{ id: "probe-result", role: "toolResult", toolCallId: "probe", toolName: "probe_done", content: [{ type: "text", text: "Probe concluded." }], isError: false, timestamp: 0 },
	]);
	chatStore.saveTree(chat.id, { nodes: [{ id: "planet-order", title: "Planet order" }], edges: [], version: 1 });
	return chat;
}

async function post(chatId: string, input: ChatInput) {
	const ack = await handleChatInput(chatId, input);
	assert.equal(ack.status, 200, await ack.text());
	const turn = runningTurn(chatId);
	assert.ok(turn, "subscribe immediately after POST acknowledgement");
	const body = await new Response(turn.subscribe()).text();
	assertSettledBody(body);
	assert.equal(runningTurn(chatId), undefined);
	await tick();
	return chatStore.getChat(chatId)!;
}

function assertSettledBody(body: string) {
	const events = body.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));
	assert.ok(events.some(e => e.type === "agent_end"), body);
	assert.ok(!events.some(e => e.type === "error"), body);
	assert.ok(body.endsWith("data: [DONE]\n\n"));
}

function noSessionFiles() {
	const files = readdirSync(claudeDir, { recursive: true }) as string[];
	assert.deepEqual(files.filter(file => file.endsWith(".jsonl")), []);
}

const quizStep: Step = { text: "Let’s check planet order.", tool: { name: "quiz", input: quiz } };

test("POST 1 persists text and an unanswered quiz, then settles", { timeout: 8000 }, async () => {
	const calls = register([quizStep]);
	const chat = teacherChat();
	const saved = await post(chat.id, { type: "text", text: "Teach me planet order" });
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]!.parked, ["quiz"]);
	assert.deepEqual(danglingQuestionOf(saved.messages), { toolCallId: "call-1", tool: "quiz", input: quiz });
	const last = saved.messages.at(-1)!;
	assert.equal(last.role, "assistant");
	assert.deepEqual(last.content.map(b => b.type), ["text", "toolCall"]);
	assert.deepEqual(last.content[0], { type: "text", text: quizStep.text });
	const pending = projectView(saved.messages).flatMap(m => m.parts).find(p => p.type === "tool-quiz");
	assert.ok(pending && pending.type === "tool-quiz");
	assert.equal(pending.state, "input-available");
	noSessionFiles();
});

test("POST 2 resumes quiz plus answer in one query with CONTINUE_TEXT and persists the reply", { timeout: 8000 }, async () => {
	const calls = register([quizStep, { text: "Right — Mercury it is." }]);
	const chat = teacherChat();
	await post(chat.id, { type: "text", text: "Teach me planet order" });
	const options = normalizeOptions(quiz.options);
	const answer = buildAnswer({ id: "call-1", kind: "quiz", question: quiz.question, mode: "single-select", options,
		correctIndices: resolveCorrect(quiz.correctAnswer, options).indices, explanation: quiz.explanation, createdAt: new Date().toISOString(),
	}, { values: ["Mercury"] });
	const before = calls.length;
	const saved = await post(chat.id, { type: "answer", toolCallId: "call-1", answer });
	assert.equal(calls.length - before, 1);
	const call = calls[before]!;
	assert.deepEqual(call.prompt.map(p => p.message.content), [[{ type: "text", text: CONTINUE_TEXT }]]);
	assert.ok(call.file);
	const records = call.file.trim().split("\n").map(line => JSON.parse(line));
	const [assistant, result] = records.filter(r => r.type === "assistant" || r.type === "user").slice(-2);
	assert.deepEqual(assistant.message.content.at(-1), { type: "tool_use", id: "call-1", name: "mcp__custom-tools__quiz", input: quiz });
	assert.equal(result.message.content[0].type, "tool_result");
	assert.equal(result.message.content[0].tool_use_id, "call-1");
	assert.deepEqual(JSON.parse(result.message.content[0].content), { kind: "quiz", answers: [{ index: 2, label: "Mercury" }], correct: true });
	const persistedAnswer = saved.messages.at(-2)!;
	assert.ok(persistedAnswer.role === "toolResult");
	assert.deepEqual(persistedAnswer.details, JSON.parse(JSON.stringify(answer)));
	assert.deepEqual(saved.messages.at(-1)!.content, [{ type: "text", text: "Right — Mercury it is." }]);
	assert.equal(danglingQuestionOf(saved.messages), null);
	noSessionFiles();
});

test("plan_init executes on the server and makes exactly two queries within one turn", { timeout: 8000 }, async () => {
	const calls = register([{ text: "Here is the plan.", tool: { name: "plan_init", input: { mermaid: "graph TD\n  planet-order[Planet order] --> orbits[Orbits]" } } }, { text: "Let’s begin." }]);
	const chat = teacherChat();
	const saved = await post(chat.id, { type: "text", text: "Plan the lesson" });
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0]!.parked, ["plan_init"]);
	assert.deepEqual(calls[1]!.prompt.map(p => p.message.content), [[{ type: "text", text: CONTINUE_TEXT }]]);
	assert.match(calls[1]!.file!, /tool_result/);
	assert.match(calls[1]!.file!, /nodeIds/);
	assert.deepEqual(saved.tree!.nodes.map(n => n.id), ["planet-order", "orbits"]);
	assert.deepEqual(saved.messages.filter(m => m.role === "assistant").at(-1)!.content, [{ type: "text", text: "Let’s begin." }]);
	noSessionFiles();
});

test("a background sub-agent resolves the cheap claude-code slot and leaves no session files", { timeout: 8000 }, async () => {
	let releaseWake!: () => void, wakeStarted!: () => void;
	const wakeGate = new Promise<void>(resolve => { releaseWake = resolve; });
	const started = new Promise<void>(resolve => { wakeStarted = resolve; });
	const calls = register([
		{ text: "Check search availability.", model: "claude-haiku-5-5", tool: { name: "web_search", input: { query: "planet order" } } },
		{ text: "The planets orbit the sun.", model: "claude-haiku-5-5" },
		{ text: "Research received.", beforeReply: () => { wakeStarted(); return wakeGate; } },
	]);
	const jobRunner = createJobRunner({ chatStore, jobStore, deliver: deliverJobResult, engineFor: (role) => {
		const spec = resolveRoleSpec(role, settingsStore.readSettings());
		return spec ? piEngineForSpec(spec) : undefined;
	} });
	const chat = teacherChat();
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "research-1" });
	const jobRun = jobRunner.runJob(job.id, { question: "Summarize planet order" });
	try {
		await started;
		const wake = runningTurn(chat.id);
		assert.ok(wake, "job delivery started the teacher wake turn");
		const body = new Response(wake.subscribe()).text();
		releaseWake();
		assertSettledBody(await body);
	} finally {
		releaseWake();
		await jobRun;
	}
	await tick();
	const saved = jobStore.getJob(job.id)!;
	assert.equal(calls.length, 3);
	assert.deepEqual(calls[0]!.parked, ["web_search"]);
	const resumed = calls[1]!;
	assert.equal(resumed.options.extraArgs?.model, "claude-haiku-5-5");
	assert.ok(resumed.options.resume);
	assert.ok(resumed.file);
	assert.match(resumed.file, /tool_result/);
	assert.match(resumed.file, /web_search is not available/);
	assert.equal(saved.status, "done", saved.error);
	assert.equal((saved.result as { brief: string }).brief, "The planets orbit the sun.");
	assert.equal(saved.usage!.model, "claude-code:claude-haiku-5-5");
	assert.equal(jobCost(saved), null);
	assert.deepEqual(chatStore.getChat(chat.id)!.messages.filter(m => m.role === "assistant").at(-1)!.content,
		[{ type: "text", text: "Research received." }]);
	noSessionFiles();
});

test("network guard records attempts even when the caller catches its error", async () => {
	try {
		await fetch("https://example.invalid/guard-check");
	} catch {
		// Simulate production swallowing a transport error.
	}
	assert.deepEqual(networkAttempts, ["fetch https://example.invalid/guard-check"]);
	networkAttempts.length = 0;
});

test("usage persists with token counts and reads as unpriced null", { timeout: 8000 }, async () => {
	register([{ text: "Mercury is closest." }]);
	const chat = teacherChat();
	const saved = await post(chat.id, { type: "text", text: "Tell me about Mercury" });
	assert.equal(saved.turns!.length, 1);
	const turn = saved.turns![0]!;
	assert.equal(turn.model, "claude-code:claude-opus-5-5");
	assert.deepEqual(turn.steps, [{ inputTokens: 11, outputTokens: 7, cacheReadTokens: 13, cacheWriteTokens: 5, reasoningTokens: 0 }]);
	assert.equal(turnCost(turn), null);
});

test("chat runs without network in a temp HOME and injected claude directory", { timeout: 8000 }, async () => {
	const calls = register([{ text: "Offline reply." }]);
	assert.equal(process.env.HOME, home);
	assert.ok(root.startsWith(join(tmpdir(), "lh-chat-flow-")));
	const chat = teacherChat();
	await post(chat.id, { type: "text", text: "Hello offline" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.options.env!.HOME, home);
	noSessionFiles();
});
