import type { ClaudeCodeEndpoint } from "../../core/claude-code-endpoint.ts";
import type { query, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { redactSecrets } from "./redact.ts";
import { convertPiMessages } from "./convert.ts";
import { EventMapper, overageLatched, OVERAGE_REFUSAL, type EventMapperLogger } from "./events.ts";
import { foldTranscript, splitPrompt } from "./history.ts";
import { claudeCodeModelId, CLAUDE_CODE_SETTINGS } from "./models.ts";
import { createToolServer } from "./mcp-server.ts";
import { buildQueryOptions, CONTINUE_TEXT, MCP_SERVER_NAME, MCP_TOOL_PREFIX, resolveEffort } from "./query-options.ts";
import { claudeCodeWorkdir, deleteSessionFile, markSessionActive, markSessionDone, sweepStaleSessions, writeSessionFile } from "./session-file.ts";
import { acquireClaudeCodeSlot } from "./slots.ts";

const sweepKey = Symbol.for("lh.claudeCode.swept");
const state = globalThis as typeof globalThis & { [sweepKey]?: Set<string> };
export function resetClaudeCodeStreamForTests(): void { delete state[sweepKey]; }
export const defaultLoadQuery = () => import("@anthropic-ai/claude-agent-sdk").then(m => m.query);
type Deps = { registrationError?: () => string | null; endpoint?: () => ClaudeCodeEndpoint | null; executable: string; dataDir: string; claudeDir: string; loadQuery: () => Promise<typeof query>; logger: EventMapperLogger; parkQuietMs?: number; cleanupWaitMs?: number };

/** options.maxTokens and LH_MAX_OUTPUT_TOKENS do not apply to this provider (no verified SDK surface). */
export function streamClaudeCode(model: Model<any>, transcript: TranscriptContext, options: SimpleStreamOptions | undefined, deps: Deps): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const toolNameMap = new Map<string, string>();
	void run();
	return stream;

	async function run(): Promise<void> {
		let endpoint: ClaudeCodeEndpoint | null | undefined;
		const redact = (text: string) => redactSecrets(text, endpoint);
		const logger: EventMapperLogger = {
			debug: text => deps.logger.debug(redact(text)),
			warn: text => deps.logger.warn(redact(text)),
		};
		const mapper = new EventMapper(stream, model, toolNameMap, logger);
		mapper.redact = redact;
		let cwd = "", sessionId: string | undefined, release: (() => void) | undefined;
		let child: Query | undefined, server: ReturnType<typeof createToolServer> | undefined;
		let pending: Promise<unknown> | undefined, settled = true, closed = false;
		let parkTimer: ReturnType<typeof setTimeout> | undefined;
		let wake!: () => void;
		const ended = new Promise<undefined>(resolve => { wake = () => resolve(undefined); });
		const warn = (error: unknown) => logger.warn(`claude-code: ${String(error)}`);
		const abort = () => { stopChild("aborted"); mapper.fail("aborted", "aborted"); wake(); };
		function stopChild(reason: string): void {
			clearTimeout(parkTimer);
			if (closed || !child) return;
			closed = true;
			const interruptError = (error: unknown) => {
				if (error instanceof Error && error.message.startsWith("Query closed")) logger.debug(`claude-code: ${error.message}`);
				else warn(error);
			};
			try { void child.interrupt().catch(interruptError); } catch (error) { interruptError(error); }
			try { child.close(); } catch (error) { warn(error); }
			server?.closeAll(reason);
		}
		/** Fallback frames describe a complete API response and arrive back to back before tools/call.
		 * Parking the first call means those frames arrived; MCP calls may run sequentially, so
		 * later calls cannot arrive while the first is parked. A request that has seen stream
		 * events ends only at message_stop, so parks never end it. */
		function checkParked(): void {
			clearTimeout(parkTimer);
			if (mapper.ended) return;
			parkTimer = setTimeout(() => {
				const ids = mapper.output.content.filter(b => b.type === "toolCall").map(b => b.id);
				if (!mapper.ended && !mapper.currentRequestStreamed && !mapper.hasOpenBlocks && ids.some(id => server?.calls.includes(id))) mapper.endToolTurn("tool call parked after quiet window");
			}, deps.parkQuietMs ?? 2000);
		}

		mapper.onToolTurnEnded = () => { wake(); stopChild("turn ended"); };
		try {
			if (overageLatched()) throw new Error(OVERAGE_REFUSAL);
			if (options?.signal?.aborted) { abort(); return; }
			options?.signal?.addEventListener("abort", abort, { once: true });
			const { systemPrompt, tools, history } = foldTranscript(transcript);
			const split = splitPrompt(history);
			if (split.kind === "invalid") throw new Error("claude-code: nothing to send");
			release = await acquireClaudeCodeSlot(options?.signal);
			if (mapper.ended || options?.signal?.aborted) { abort(); return; }
			if (overageLatched()) throw new Error(OVERAGE_REFUSAL);
			for (const tool of tools) toolNameMap.set(MCP_TOOL_PREFIX + tool.name, tool.name);
			const { anthropicMessages, dropped } = convertPiMessages(split.prior, new Map([...toolNameMap].map(([sdk, pi]) => [pi, sdk])));
			if (dropped.thinking || dropped.abortedTurns || dropped.other.size) {
				warn(`dropped history content: thinking=${dropped.thinking} providers=[${[...dropped.providers].join(",")}] abortedTurns=${dropped.abortedTurns}${[...dropped.other].map(([key, count]) => ` ${key}=${count}`).join("")}`);
			}
			const cliModel = claudeCodeModelId(model, CLAUDE_CODE_SETTINGS);
			cwd = claudeCodeWorkdir(deps.dataDir);
			const swept = state[sweepKey] ??= new Set<string>();
			const pair = `${cwd}\0${deps.claudeDir}`;
			if (!swept.has(pair)) { sweepStaleSessions(cwd, deps.claudeDir); swept.add(pair); }
			try {
				({ sessionId } = writeSessionFile({ messages: anthropicMessages, cwd, claudeDir: deps.claudeDir, model: cliModel }));
				markSessionActive(sessionId);
			} catch (error) { if (!(error instanceof Error && error.message === "claude-code: empty history")) throw error; }
			if (tools.length) server = createToolServer(tools, { timeoutMs: 3_600_000, onCall: checkParked });
			endpoint = deps.endpoint?.();
			if (deps.endpoint && !endpoint) throw new Error("claude-code: endpoint not configured");
			const queryOptions = buildQueryOptions({ executable: deps.executable, cwd, cliModel,
				...(endpoint ? { endpoint } : {}),
				effort: resolveEffort(model, options?.reasoning), appendPrompt: systemPrompt, resumeId: sessionId,
				...(server ? { mcpServers: { [MCP_SERVER_NAME]: server.config } } : {}) });
			const loading = deps.loadQuery();
			void loading.catch(error => { if (mapper.ended) warn(error); });
			const queryFn = await Promise.race([loading, ended]);
			if (!queryFn) { abort(); return; }
			if (mapper.ended || options?.signal?.aborted) { abort(); return; }
			if (overageLatched()) throw new Error(OVERAGE_REFUSAL);
			const content = split.kind === "user" ? split.blocks : [{ type: "text" as const, text: CONTINUE_TEXT }];
			async function* prompt(): AsyncGenerator<SDKUserMessage> {
				yield { type: "user", message: { role: "user", content: content as SDKUserMessage["message"]["content"] }, parent_tool_use_id: null, session_id: "" };
			}
			const registrationError = deps.registrationError?.();
			if (registrationError) throw new Error(registrationError);
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
						logger.warn("claude-code: iterator still pending 30s after close");
						try { child?.close(); } catch (error) { warn(error); }
						resolve();
					}, 30_000);
					timer.unref();
				})]);
				clearTimeout(timer);
			}
			// SDK close/return caps waitForExit at 2s; release after bounded cleanup to avoid
			// a permanent stall rather than require proven termination. Keep the 30s watchdog.
			if (child) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const cleanup = child.return(undefined).catch(warn);
					await Promise.race([cleanup, new Promise<void>(resolve => {
						timer = setTimeout(() => { warn("child cleanup timed out"); resolve(); }, deps.cleanupWaitMs ?? 10_000);
						timer.unref();
					})]);
				} catch (error) { warn(error); } finally { clearTimeout(timer); }
			}
			release?.();
			if (sessionId) {
				markSessionDone(sessionId);
				try { deleteSessionFile(sessionId, cwd, deps.claudeDir); } catch (error) { warn(error); }
			}
		}
	}
}
