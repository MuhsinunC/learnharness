import type { query, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { convertPiMessages } from "./convert.ts";
import { EventMapper, overageLatched, OVERAGE_REFUSAL, type EventMapperLogger } from "./events.ts";
import { foldTranscript, splitPrompt } from "./history.ts";
import { createToolServer } from "./mcp-server.ts";
import { buildQueryOptions, CONTINUE_TEXT, MCP_SERVER_NAME, MCP_TOOL_PREFIX, resolveEffort } from "./query-options.ts";
import { claudeCodeWorkdir, deleteSessionFile, markSessionActive, markSessionDone, sweepStaleSessions, writeSessionFile } from "./session-file.ts";
import { acquireClaudeCodeSlot } from "./slots.ts";

const sweepKey = Symbol.for("lh.claudeCode.swept");
const state = globalThis as typeof globalThis & { [sweepKey]?: boolean };
export function resetClaudeCodeStreamForTests(): void { delete state[sweepKey]; }
export const defaultLoadQuery = () => import("@anthropic-ai/claude-agent-sdk").then(m => m.query);
type Deps = { executable: string; dataDir: string; claudeDir: string; loadQuery: () => Promise<typeof query>; logger: EventMapperLogger };

export function streamClaudeCode(model: Model<any>, transcript: TranscriptContext, options: SimpleStreamOptions | undefined, deps: Deps): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const toolNameMap = new Map<string, string>();
	const mapper = new EventMapper(stream, model, toolNameMap, deps.logger);
	void run();
	return stream;

	async function run(): Promise<void> {
		let cwd = "", sessionId: string | undefined, release: (() => void) | undefined;
		let child: Query | undefined, server: ReturnType<typeof createToolServer> | undefined;
		let pending: Promise<unknown> | undefined, settled = true, closed = false;
		let wake!: () => void;
		const ended = new Promise<undefined>(resolve => { wake = () => resolve(undefined); });
		const warn = (error: unknown) => deps.logger.warn(`claude-code: ${String(error)}`);
		const abort = () => { mapper.fail("aborted", "aborted"); wake(); stopChild("aborted"); };
		function stopChild(reason: string): void {
			if (closed || !child) return;
			closed = true;
			try { void child.interrupt().catch(warn); } catch (error) { warn(error); }
			try { child.close(); } catch (error) { warn(error); }
			server?.closeAll(reason);
		}
		function checkParked(): void {
			const ids = mapper.output.content.filter(b => b.type === "toolCall").map(b => b.id);
			if (!mapper.ended && ids.length && ids.every(id => server?.calls.includes(id))) mapper.endToolTurn("all tool calls parked");
		}
		mapper.onToolTurnEnded = () => { wake(); stopChild("turn ended"); };
		try {
			if (overageLatched()) throw new Error(OVERAGE_REFUSAL);
			if (options?.signal?.aborted) { abort(); return; }
			options?.signal?.addEventListener("abort", abort, { once: true });
			const { systemPrompt, tools, history } = foldTranscript(transcript);
			const split = splitPrompt(history);
			if (split.kind === "invalid") throw new Error("claude-code: nothing to send");
			for (const tool of tools) toolNameMap.set(MCP_TOOL_PREFIX + tool.name, tool.name);
			const { anthropicMessages } = convertPiMessages(split.prior, new Map([...toolNameMap].map(([sdk, pi]) => [pi, sdk])));
			cwd = claudeCodeWorkdir(deps.dataDir);
			if (!state[sweepKey]) { sweepStaleSessions(cwd, deps.claudeDir); state[sweepKey] = true; }
			try {
				({ sessionId } = writeSessionFile({ messages: anthropicMessages, cwd, claudeDir: deps.claudeDir, model: model.id }));
				markSessionActive(sessionId);
			} catch (error) { if (!(error instanceof Error && error.message === "claude-code: empty history")) throw error; }
			release = await acquireClaudeCodeSlot(options?.signal);
			if (mapper.ended || options?.signal?.aborted) { abort(); return; }
			if (overageLatched()) throw new Error(OVERAGE_REFUSAL);
			if (tools.length) server = createToolServer(tools, { timeoutMs: 3_600_000, onCall: checkParked });
			const queryOptions = buildQueryOptions({ executable: deps.executable, cwd, cliModel: model.id,
				effort: resolveEffort(model, options?.reasoning), appendPrompt: systemPrompt, resumeId: sessionId,
				...(server ? { mcpServers: { [MCP_SERVER_NAME]: server.config } } : {}) });
			const queryFn = await deps.loadQuery();
			if (mapper.ended || options?.signal?.aborted) { abort(); return; }
			if (overageLatched()) throw new Error(OVERAGE_REFUSAL);
			const content = split.kind === "user" ? split.blocks : [{ type: "text" as const, text: CONTINUE_TEXT }];
			async function* prompt(): AsyncGenerator<SDKUserMessage> {
				yield { type: "user", message: { role: "user", content: content as SDKUserMessage["message"]["content"] }, parent_tool_use_id: null, session_id: "" };
			}
			child = queryFn({ prompt: prompt(), options: queryOptions });
			const iterator = child[Symbol.asyncIterator]();
			while (!mapper.ended) {
				settled = false;
				const next = Promise.resolve().then(() => iterator.next());
				pending = next.then(() => { settled = true; }, error => { settled = true; if (mapper.ended) warn(error); });
				const item = await Promise.race([next, ended]);
				if (!item) break;
				if (item.done) { mapper.fail("error", "claude-code: iterator ended without result"); break; }
				mapper.handle(item.value);
				checkParked();
			}
		} catch (error) {
			if (mapper.ended) warn(error);
			else mapper.fail(options?.signal?.aborted ? "aborted" : "error", options?.signal?.aborted ? "aborted" : error instanceof Error ? error.message : String(error));
		} finally {
			options?.signal?.removeEventListener("abort", abort);
			stopChild(options?.signal?.aborted ? "aborted" : "turn ended");
			server?.closeAll("turn ended");
			if (pending && !settled) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([pending, new Promise<void>(resolve => {
					timer = setTimeout(() => {
						deps.logger.warn("claude-code: iterator still pending 30s after close");
						try { child?.close(); } catch (error) { warn(error); }
						resolve();
					}, 30_000);
					timer.unref();
				})]);
				clearTimeout(timer);
			}
			release?.();
			if (sessionId) {
				markSessionDone(sessionId);
				try { deleteSessionFile(sessionId, cwd, deps.claudeDir); } catch (error) { warn(error); }
			}
		}
	}
}
