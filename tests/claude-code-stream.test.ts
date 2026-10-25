import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, beforeEach, test } from "node:test";
import type { query, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Message, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { getProjectDir } from "cc-session-io";
import { Type } from "typebox";
import { streamClaudeCode, resetClaudeCodeStreamForTests } from "../src/agent/claude-code/stream.ts";
import { resetClaudeCodeSlotsForTests, acquireClaudeCodeSlot } from "../src/agent/claude-code/slots.ts";
import { OVERAGE_REFUSAL, resetOverageLatchForTests } from "../src/agent/claude-code/events.ts";
import { buildQueryOptions, CONTINUE_TEXT } from "../src/agent/claude-code/query-options.ts";
import { claudeCodeWorkdir, writeSessionFile } from "../src/agent/claude-code/session-file.ts";

const model = { id: "test-model", api: "claude-agent-sdk", provider: "claude-code" } as Model<any>;
const user = (content: string): Message => ({ role: "user", content, timestamp: 0 });
const sdk = (m: unknown) => m as SDKMessage;
const event = (type: string, fields = {}) => sdk({ type: "stream_event", event: { type, ...fields } });
const success = sdk({ type: "result", subtype: "success", is_error: false });
const toolBlock = { type: "tool_use", id: "call-1", name: "mcp__custom-tools__work", input: {} };
function turn(tool = false, name = "work"): SDKMessage[] {
	return [event("message_start", { message: { id: "msg", usage: {} } }),
		event("content_block_start", { index: 0, content_block: tool ? { ...toolBlock, name: "mcp__custom-tools__" + name } : { type: "text", text: "" } }),
		...(!tool ? [event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "OK" } })] : []),
		event("content_block_stop", { index: 0 }), event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: {} }), event("message_stop"), success];
}
const tool: AgentTool = { name: "work", label: "work", description: "work", parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "worked" }], details: null }) };
const transcript = (messages: Message[] = [user("hello")], tools: AgentTool[] = []): TranscriptContext => normalizeContext({ systemPrompt: "system", tools, messages });
const history = () => [user("old"), { role: "assistant", content: [{ type: "text", text: "prior" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 } as Message, user("new")];
let root: string, oldHome: string | undefined, oldCap: string | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "lh-stream-"));
	oldHome = process.env.HOME; oldCap = process.env.LH_CLAUDE_CODE_MAX_CHILDREN;
	process.env.HOME = join(root, "home"); mkdirSync(process.env.HOME);
	delete process.env.LH_CLAUDE_CODE_MAX_CHILDREN;
	resetClaudeCodeStreamForTests(); resetClaudeCodeSlotsForTests(); resetOverageLatchForTests();
});
afterEach(async () => {
	await tick();
	rmSync(root, { recursive: true, force: true });
	if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
	if (oldCap === undefined) delete process.env.LH_CLAUDE_CODE_MAX_CHILDREN; else process.env.LH_CLAUDE_CODE_MAX_CHILDREN = oldCap;
});
type RecordCall = { prompt: SDKUserMessage[]; options: Options; file?: string; pulls: number; interrupts: number; closes: number; returns: number };
function fake(script: (call: RecordCall) => AsyncGenerator<SDKMessage> = async function* () { yield* turn(); }) {
	const calls: RecordCall[] = [], warnings: string[] = [], debugs: string[] = [];
	const deps = { parkQuietMs: 3, cleanupWaitMs: 5, executable: "/fake/claude", dataDir: join(root, "data"), claudeDir: join(root, "home", ".claude"), logger: { debug(m: string) { debugs.push(m); }, warn(m: string) { warnings.push(m); } },
		loadQuery: async () => (({ prompt, options }: Parameters<typeof query>[0]) => {
			const call: RecordCall = { prompt: [], options: options!, pulls: 0, interrupts: 0, closes: 0, returns: 0 };
			if (options?.resume) call.file = readFileSync(join(getProjectDir(options.cwd!, deps.claudeDir), options.resume + ".jsonl"), "utf8");
			calls.push(call);
			let unblock!: () => void;
			const closed = new Promise<IteratorResult<SDKMessage>>(resolve => { unblock = () => resolve({ done: true, value: undefined }); });
			const iterator = (async function* () {
				for await (const p of prompt as AsyncIterable<SDKUserMessage>) call.prompt.push(p);
				yield* script(call);
			})();
			return { [Symbol.asyncIterator]() { return this; }, next() { call.pulls++; return Promise.race([iterator.next(), closed]); },
				return: async () => { call.returns++; return { done: true, value: undefined }; },
				interrupt: async () => { call.interrupts++; }, close() { call.closes++; unblock(); } };
		}) as unknown as typeof query };
	return { deps, calls, warnings, debugs, run: (t = transcript(), signal?: AbortSignal) => streamClaudeCode(model, t, { signal }, deps) };
}
async function collect(stream: ReturnType<typeof streamClaudeCode>) {
	const events = [];
	for await (const e of stream) events.push(e);
	await tick();
	return events;
}
function noFiles(h: ReturnType<typeof fake>) {
	const dir = getProjectDir(claudeCodeWorkdir(h.deps.dataDir), h.deps.claudeDir);
	let files: string[] = [];
	try { files = readdirSync(dir, { recursive: true }) as string[]; } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	assert.deepEqual(files.filter(f => f.endsWith(".jsonl")), []);
}
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.fail("condition did not become true"); }

test("resume id, split prompt and exact safe options; success deletes file", async () => {
	const h = fake(); const events = await collect(h.run(transcript(history()))); const c = h.calls[0]!;
	assert.equal(events.at(-1)?.type, "done");
	assert.equal((events.at(-1) as any).reason, "stop");
	assert.match(c.file!, new RegExp(c.options.resume!));
	assert.deepEqual(c.prompt, [{ type: "user", message: { role: "user", content: [{ type: "text", text: "new" }] }, parent_tool_use_id: null, session_id: "" }]);
	assert.deepEqual(c.options, buildQueryOptions({ executable: h.deps.executable, cwd: claudeCodeWorkdir(h.deps.dataDir), cliModel: model.id, appendPrompt: "system", resumeId: c.options.resume }));
	assert.equal(Object.hasOwn(c.options, "mcpServers"), false); noFiles(h);
});
test("fresh prompt omits resume; tool stop closes once without pulling second turn", async () => {
	const h = fake(async function* () { yield* turn(true).slice(0, -1); yield event("message_start"); throw new Error("must not pull"); });
	const events = await collect(h.run(transcript(undefined, [tool])));
	assert.equal(events.filter(e => e.type === "done").length, 1);
	assert.equal((events.at(-1) as any).reason, "toolUse");
	assert.equal(h.calls[0]!.pulls, turn(true).length - 1);
	assert.equal(h.calls[0]!.closes, 1); assert.equal(h.calls[0]!.interrupts, 1);
	assert.equal(Object.hasOwn(h.calls[0]!.options, "resume"), false);
	assert.equal(h.calls[0]!.options.mcpServers?.["custom-tools"]?.type, "sdk");
});
test("fallback tools/call ends a blocked iterator", { timeout: 2000 }, async () => {
	const h = fake(async function* (c) {
		yield sdk({ type: "assistant", message: { id: "fallback", content: [toolBlock], usage: {} } });
		const config = c.options.mcpServers!["custom-tools"] as any;
		const handler = config.instance.server._requestHandlers.get("tools/call");
		await handler({ method: "tools/call", params: { name: "work", _meta: { "claudecode/toolUseId": "call-1" } } }, { signal: new AbortController().signal });
		await new Promise(() => {});
	});
	const events = await collect(h.run(transcript(history(), [tool])));
	assert.equal((events.at(-1) as any).reason, "toolUse"); assert.equal(h.calls[0]!.closes, 1);
	assert.equal(events.filter(e => e.type === "done").length, 1); assert.equal(h.calls[0]!.returns, 1); assert.deepEqual(h.warnings, []); noFiles(h);
});
test("abort before spawning and during a pending pull preserves partial output and cleans up", async () => {
	const h = fake(async function* () { yield* turn().slice(0, 4); await new Promise(() => {}); });
	const before = new AbortController(); before.abort();
	assert.equal((await collect(h.run(transcript(history()), before.signal))).at(-1)?.type, "error"); assert.equal(h.calls.length, 0);
	const controller = new AbortController(); const stream = h.run(transcript(history()), controller.signal);
	let closedAtError = 0, interruptedAtError = 0;
	const push = stream.push.bind(stream);
	stream.push = e => {
		if (e.type === "error") { closedAtError = h.calls[0]!.closes; interruptedAtError = h.calls[0]!.interrupts; }
		push(e);
	};
	await until(() => (h.calls[0]?.pulls ?? 0) === 5); controller.abort();
	const events = await collect(stream); const last = events.at(-1) as any;
	assert.equal(last.reason, "aborted"); assert.equal(last.error.errorMessage, "aborted"); assert.equal(last.error.content[0].text, "OK");
	assert.equal(closedAtError, 1); assert.equal(interruptedAtError, 1);
	assert.equal(h.calls[0]!.closes, 1); noFiles(h);
});
for (const mode of ["throw", "end", "result"] as const) test(`failure ${mode} deletes session`, async () => {
	const h = fake(async function* () { if (mode === "throw") throw new Error("broken"); if (mode === "result") yield sdk({ type: "result", subtype: "error_during_execution", errors: ["broken"] }); });
	const events = await collect(h.run(transcript(history()))); assert.equal(events.at(-1)?.type, "error"); noFiles(h);
});
test("cap=1 queues FIFO, queued abort never queries, distinct sessions survive until release", async () => {
	process.env.LH_CLAUDE_CODE_MAX_CHILDREN = "1";
	let finish!: () => void; const wait = new Promise<void>(r => { finish = r; });
	const h = fake(async function* () { await wait; yield* turn(); });
	const first = h.run(transcript(history())); await until(() => h.calls.length === 1);
	const controller = new AbortController(); const aborted = h.run(transcript(history()), controller.signal);
	const second = h.run(transcript(history())); await tick(); assert.equal(h.calls.length, 1);
	const dir = getProjectDir(claudeCodeWorkdir(h.deps.dataDir), h.deps.claudeDir);
	assert.equal(readdirSync(dir).filter(f => f.endsWith(".jsonl")).length, 1);
	controller.abort(); assert.equal((await collect(aborted)).at(-1)?.type, "error"); assert.equal(h.calls.length, 1);
	finish(); await collect(first); await collect(second);
	assert.equal(h.calls.length, 2); assert.notEqual(h.calls[0]!.options.resume, h.calls[1]!.options.resume); noFiles(h);
});
test("slot handoff skips aborts and release is idempotent; minimum cap is one", async () => {
	process.env.LH_CLAUDE_CODE_MAX_CHILDREN = "0";
	const release = await acquireClaudeCodeSlot(); const order: number[] = [];
	const a = acquireClaudeCodeSlot().then(r => { order.push(1); r(); r(); });
	const b = acquireClaudeCodeSlot().then(r => { order.push(2); r(); });
	await tick(); assert.deepEqual(order, []); release(); await Promise.all([a, b]); assert.deepEqual(order, [1, 2]);
});
test("overage persists and later calls neither write nor load query", async () => {
	const h = fake(async function* () { yield sdk({ type: "rate_limit_event", rate_limit_info: { isUsingOverage: true } }); });
	assert.equal((await collect(h.run(transcript(history())))).at(-1)?.type, "error"); noFiles(h);
	h.deps.loadQuery = async () => { assert.fail("must not load"); };
	const events = await collect(h.run(transcript(history()))); assert.equal((events.at(-1) as any).error.errorMessage, OVERAGE_REFUSAL); assert.equal(h.calls.length, 1); noFiles(h);
});
test("invalid split, workdir, executable, sweep and loader errors are stream errors", async () => {
	for (const kind of ["split", "cwd", "options", "sweep", "load"] as const) {
		resetClaudeCodeStreamForTests(); const h = fake();
		if (kind === "cwd") h.deps.dataDir = join(root, "x".repeat(180));
		if (kind === "options") h.deps.executable = "relative";
		if (kind === "load") h.deps.loadQuery = async () => { throw new Error("loader failure"); };
		if (kind === "sweep") { rmSync(h.deps.claudeDir, { recursive: true, force: true }); mkdirSync(h.deps.claudeDir, { recursive: true }); writeFileSync(join(h.deps.claudeDir, "projects"), "bad"); }
		const events = await collect(h.run(kind === "split" ? transcript([]) : transcript(history())));
		assert.equal(events.at(-1)?.type, "error", kind); assert.equal(h.calls.length, 0);
		if (kind === "sweep") rmSync(join(h.deps.claudeDir, "projects"));
	}
});

test("real Agent executes server tool then resumes with result and CONTINUE_TEXT", async () => {
	const h = fake(async function* (c) { yield* turn(c === h.calls[0]); });
	const agent = new Agent({ initialState: { model, systemPrompt: "system", tools: [tool] }, streamFn: ((m, t, o) => streamClaudeCode(m, t, o, h.deps)) as StreamFn });
	await agent.prompt("do work"); assert.equal(h.calls.length, 2);
	assert.deepEqual(h.calls[1]!.prompt[0]!.message.content, [{ type: "text", text: CONTINUE_TEXT }]);
	assert.match(h.calls[1]!.file!, /tool_result/); assert.match(h.calls[1]!.file!, /worked/); noFiles(h);
});
test("real quiz Agent terminates, then a new Agent continues from recorded answer", async () => {
	const quiz: AgentTool = { ...tool, name: "quiz", execute: async () => ({ content: [{ type: "text", text: "waiting" }], details: null, terminate: true }) };
	const h = fake(async function* (c) { yield* turn(c === h.calls[0], "quiz"); });
	const streamFn: StreamFn = (m, t, o) => streamClaudeCode(m, t, o, h.deps);
	const agent = new Agent({ initialState: { model, tools: [quiz] }, streamFn });
	await agent.prompt("quiz"); assert.equal(h.calls.length, 1);
	const record = agent.state.messages.filter(m => m.role !== "toolResult");
	const answer: Message = { role: "toolResult", toolCallId: "call-1", toolName: "quiz", content: [{ type: "text", text: "answer: 42" }], isError: false, timestamp: 0 };
	const resumed = new Agent({ initialState: { model, tools: [quiz], messages: [...record, answer] }, streamFn });
	await resumed.continue(); assert.equal(h.calls.length, 2);
	assert.deepEqual(h.calls[1]!.prompt[0]!.message.content, [{ type: "text", text: CONTINUE_TEXT }]);
	assert.match(h.calls[1]!.file!, /answer: 42/); noFiles(h);
});

test("abort retains slot and session until the pending next settles", async () => {
	process.env.LH_CLAUDE_CODE_MAX_CHILDREN = "1";
	let settle!: (value: IteratorResult<SDKMessage>) => void;
	const pending = new Promise<IteratorResult<SDKMessage>>(resolve => { settle = resolve; });
	const h = fake(); let closed = 0, pulled = 0;
	h.deps.loadQuery = async () => (() => ({
		[Symbol.asyncIterator]() { return this; }, next() { pulled++; return pending; },
		return: async () => ({ done: true, value: undefined }),
		interrupt: async () => {}, close() { closed++; },
	})) as unknown as typeof query;
	const controller = new AbortController();
	const stream = h.run(transcript(history()), controller.signal);
	await until(() => pulled === 1); controller.abort(); await collect(stream);
	assert.equal(closed, 1);
	let acquired = false; const waiting = acquireClaudeCodeSlot().then(release => { acquired = true; release(); });
	await tick(); assert.equal(acquired, false);
	const dir = getProjectDir(claudeCodeWorkdir(h.deps.dataDir), h.deps.claudeDir);
	assert.equal(readdirSync(dir).filter(f => f.endsWith(".jsonl")).length, 1);
	settle({ done: true, value: undefined }); await waiting; await tick(); noFiles(h);
});

test("watchdog closes again and releases a child whose pending next never settles", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	process.env.LH_CLAUDE_CODE_MAX_CHILDREN = "1";
	const h = fake(); let closed = 0, pulled = 0;
	h.deps.loadQuery = async () => (() => ({
		[Symbol.asyncIterator]() { return this; }, next() { pulled++; return new Promise(() => {}); },
		return: async () => ({ done: true, value: undefined }),
		interrupt: async () => {}, close() { closed++; },
	})) as unknown as typeof query;
	const controller = new AbortController(); const stream = h.run(transcript(history()), controller.signal);
	await until(() => pulled === 1); controller.abort(); await collect(stream);
	let acquired = false; const waiting = acquireClaudeCodeSlot().then(release => { acquired = true; release(); });
	t.mock.timers.tick(29_999); await tick(); assert.equal(acquired, false);
	t.mock.timers.tick(1); await waiting; await tick();
	assert.equal(closed, 2); assert.ok(h.warnings.some(w => w.includes("30s"))); noFiles(h);
});

function park(c: RecordCall, id: string) {
	const config = c.options.mcpServers!["custom-tools"] as any;
	return config.instance.server._requestHandlers.get("tools/call")({ method: "tools/call", params: { name: "work", _meta: { "claudecode/toolUseId": id } } }, { signal: new AbortController().signal });
}

test("fallback quiet window collects both frames of the same assistant message", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let second!: () => void;
	const wait = new Promise<void>(resolve => { second = resolve; });
	const h = fake(async function* (c) {
		yield sdk({ type: "assistant", message: { id: "same", content: [toolBlock], usage: {} } });
		void park(c, "call-1"); await wait;
		yield sdk({ type: "assistant", message: { id: "same", content: [{ ...toolBlock, id: "call-2" }], usage: {} } });
		await park(c, "call-2"); await new Promise(() => {});
	});
	h.deps.parkQuietMs = 20;
	const stream = h.run(transcript(history(), [tool]));
	await until(() => h.calls[0]?.pulls === 2);
	t.mock.timers.tick(15); second(); await until(() => h.calls[0]?.pulls === 3);
	t.mock.timers.tick(19); await tick(); assert.equal(h.calls[0]!.closes, 0);
	t.mock.timers.tick(1); const events = await collect(stream);
	const done = events.filter(e => e.type === "done"); assert.equal(done.length, 1);
	assert.equal(done[0]!.reason, "toolUse");
	assert.deepEqual(done[0]!.message.content.filter(b => b.type === "toolCall").map(b => b.id), ["call-1", "call-2"]);
});

test("parked tool with unfinished argument deltas cannot end during quiet window", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = fake(async function* (c) {
		yield event("message_start", { message: { id: "open", usage: {} } });
		yield event("content_block_start", { index: 0, content_block: toolBlock });
		yield event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{" } });
		await park(c, "call-1");
	});
	const controller = new AbortController(); const stream = h.run(transcript(history(), [tool]), controller.signal);
	await until(() => h.calls[0]?.pulls === 4); t.mock.timers.tick(20); await tick();
	assert.equal(h.calls[0]!.closes, 0); controller.abort();
	assert.equal((await collect(stream)).filter(e => e.type === "done").length, 0);
});

test("queued abort creates no session file", async () => {
	process.env.LH_CLAUDE_CODE_MAX_CHILDREN = "1";
	const release = await acquireClaudeCodeSlot(); const h = fake();
	const controller = new AbortController(); const stream = h.run(transcript(history()), controller.signal);
	await tick(); noFiles(h); controller.abort();
	assert.equal((await collect(stream)).at(-1)?.type, "error"); assert.equal(h.calls.length, 0); noFiles(h); release();
});

test("child return holds slot and session until cleanup completes", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	process.env.LH_CLAUDE_CODE_MAX_CHILDREN = "1";
	const h = fake(); h.deps.cleanupWaitMs = 20;
	const load = h.deps.loadQuery; let finish!: () => void; let returning = false;
	const cleanup = new Promise<void>(resolve => { finish = resolve; });
	h.deps.loadQuery = async () => {
		const queryFn = await load();
		return ((params: Parameters<typeof query>[0]) => {
			const child = queryFn(params);
			if (h.calls.length === 1) child.return = async () => { returning = true; await cleanup; return { done: true, value: undefined }; };
			return child;
		}) as typeof query;
	};
	const first = h.run(transcript(history())); await collect(first); await until(() => returning);
	const second = h.run(transcript(history())); await tick(); assert.equal(h.calls.length, 1);
	const dir = getProjectDir(claudeCodeWorkdir(h.deps.dataDir), h.deps.claudeDir);
	assert.equal(readdirSync(dir).filter(f => f.endsWith(".jsonl")).length, 1);
	finish(); await collect(second); assert.equal(h.calls.length, 2); noFiles(h);
});

test("cleanup timeout releases permit and catches a late return rejection", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	process.env.LH_CLAUDE_CODE_MAX_CHILDREN = "1";
	const h = fake(); const load = h.deps.loadQuery; let reject!: (e: Error) => void; let returning = false;
	h.deps.loadQuery = async () => {
		const queryFn = await load();
		return ((params: Parameters<typeof query>[0]) => {
			const child = queryFn(params);
			child.return = () => { returning = true; return new Promise((_, r) => { reject = r; }); };
			return child;
		}) as typeof query;
	};
	await collect(h.run(transcript(history()))); await until(() => returning);
	let acquired = false; const waiting = acquireClaudeCodeSlot().then(release => { acquired = true; release(); });
	await tick(); assert.equal(acquired, false); t.mock.timers.tick(5); await waiting; await tick();
	assert.ok(h.warnings.some(w => w.includes("cleanup timed out"))); noFiles(h);
	reject(new Error("late cleanup rejection")); await tick(); assert.ok(h.warnings.some(w => w.includes("late cleanup rejection")));
});

test("sequential MCP calls end after only the first parks, preserving both fallback tools", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = fake(async function* (c) {
		yield sdk({ type: "assistant", message: { id: "sequential", content: [toolBlock], usage: {} } });
		yield sdk({ type: "assistant", message: { id: "sequential", content: [{ ...toolBlock, id: "call-2" }], usage: {} } });
		await park(c, "call-1"); await new Promise(() => {});
	});
	const stream = h.run(transcript(history(), [tool]));
	await until(() => h.calls[0]?.pulls === 3); t.mock.timers.tick(3);
	const events = await collect(stream); const done = events.filter(e => e.type === "done");
	assert.equal(done.length, 1); assert.equal(done[0]!.reason, "toolUse");
	assert.deepEqual(done[0]!.message.content.filter(b => b.type === "toolCall").map(b => b.id), ["call-1", "call-2"]);
});

test("abort during SDK load releases slot and session and catches late rejection", async () => {
	process.env.LH_CLAUDE_CODE_MAX_CHILDREN = "1";
	const h = fake(); let loading = false, reject!: (error: Error) => void;
	h.deps.loadQuery = () => { loading = true; return new Promise((_, r) => { reject = r; }); };
	const controller = new AbortController(); const stream = h.run(transcript(history()), controller.signal);
	await until(() => loading);
	const dir = getProjectDir(claudeCodeWorkdir(h.deps.dataDir), h.deps.claudeDir);
	assert.equal(readdirSync(dir).filter(f => f.endsWith(".jsonl")).length, 1);
	controller.abort(); const events = await collect(stream);
	assert.equal((events.at(-1) as any).reason, "aborted"); noFiles(h);
	let acquired = false; const waiting = acquireClaudeCodeSlot().then(release => { acquired = true; release(); });
	await tick(); assert.equal(acquired, true); await waiting;
	reject(new Error("late SDK load")); await tick(); assert.ok(h.warnings.some(m => m.includes("late SDK load")));
});

test("dropped history is warned once with counts and providers; clean history is silent", async () => {
	const h = fake(); const messages = history();
	const assistant = messages[1] as any;
	assistant.provider = "other-provider";
	assistant.content.unshift({ type: "thinking", thinking: "private" });
	await collect(h.run(transcript(messages)));
	const warnings = h.warnings.filter(m => m.includes("dropped history content:"));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /thinking=1 providers=\[other-provider\] abortedTurns=0/);
	const clean = fake(); await collect(clean.run(transcript(history())));
	assert.deepEqual(clean.warnings.filter(m => m.includes("dropped history content:")), []);
});

test("sweeps exactly once for each workdir and claudeDir pair", async () => {
	const x = fake(), y = fake();
	y.deps.dataDir = join(root, "other-data"); y.deps.claudeDir = join(root, "other-claude");
	const plant = (h: ReturnType<typeof fake>) => {
		const cwd = claudeCodeWorkdir(h.deps.dataDir);
		const file = writeSessionFile({ cwd, claudeDir: h.deps.claudeDir, model: model.id, messages: [{ role: "user", content: [{ type: "text", text: "stale" }] }] });
		utimesSync(file.jsonlPath, new Date(0), new Date(0));
		return file.jsonlPath;
	};
	const oldX = plant(x), oldY = plant(y);
	await collect(x.run()); assert.throws(() => readFileSync(oldX), { code: "ENOENT" });
	const retainedX = plant(x); await collect(x.run()); assert.ok(readFileSync(retainedX).length);
	await collect(y.run()); assert.throws(() => readFileSync(oldY), { code: "ENOENT" });
	const retainedY = plant(y); await collect(y.run()); assert.ok(readFileSync(retainedY).length);
});

test("queued cancellation removes its ticket immediately and preserves the next handoff", async () => {
	process.env.LH_CLAUDE_CODE_MAX_CHILDREN = "1";
	const release = await acquireClaudeCodeSlot(); const controller = new AbortController();
	const cancelled = acquireClaudeCodeSlot(controller.signal);
	const rejection = assert.rejects(cancelled, /aborted/);
	let granted = false; const remaining = acquireClaudeCodeSlot().then(r => { granted = true; r(); });
	const pool = (globalThis as any)[Symbol.for("lh.claudeCode.slots")];
	assert.equal(pool.queue.length, 2); controller.abort(); assert.equal(pool.queue.length, 1);
	await rejection; assert.equal(granted, false); release(); await remaining;
	assert.equal(granted, true); assert.equal(pool.active, 0);
});

for (const message of ["Query closed before response received", "Query closed before spawn", "unexpected interrupt failure"]) test(`interrupt logging: ${message}`, async () => {
	const h = fake(); const load = h.deps.loadQuery;
	h.deps.loadQuery = async () => {
		const queryFn = await load();
		return ((params: Parameters<typeof query>[0]) => {
			const child = queryFn(params); child.interrupt = async () => { throw new Error(message); }; return child;
		}) as typeof query;
	};
	await collect(h.run(transcript(history())));
	assert.equal(h.warnings.filter(m => m.includes(message)).length, message.startsWith("Query closed") ? 0 : 1);
	assert.equal(h.debugs.filter(m => m.includes(message)).length, message.startsWith("Query closed") ? 1 : 0);
});
