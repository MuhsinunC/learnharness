import type { ClaudeCodeEndpoint } from "../../core/claude-code-endpoint.ts";
import type { query, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Message, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { redactSecrets } from "./redact.ts";
import { convertPiMessages } from "./convert.ts";
import { EventMapper, overageLatched, OVERAGE_REFUSAL, type EventMapperLogger } from "./events.ts";
import { foldTranscript, splitPrompt } from "./history.ts";
import { claudeCodeModelId, CLAUDE_CODE_SETTINGS } from "./models.ts";
import { createToolServer } from "./mcp-server.ts";
import { buildQueryOptions, CONTINUE_TEXT, MCP_SERVER_NAME, MCP_TOOL_PREFIX, resolveEffort } from "./query-options.ts";
import { claudeCodeWorkdir, deleteSessionFile, markSessionActive, markSessionDone, sweepStaleSessions, writeSessionFile } from "./session-file.ts";
import { acquireClaudeCodeSlot } from "./slots.ts";
import { evictIdleLiveChild, liveChildBusy, liveReuseKey, streamLive } from "./live.ts";

const sweepKey = Symbol.for("lh.claudeCode.swept");
const state = globalThis as typeof globalThis & { [sweepKey]?: Set<string> };
export function resetClaudeCodeStreamForTests(): void { delete state[sweepKey]; }
export const defaultLoadQuery = () => import("@anthropic-ai/claude-agent-sdk").then(m => m.query);
export type Deps = { registrationError?: () => string | null; endpoint?: () => ClaudeCodeEndpoint | null; executable: string; dataDir: string; claudeDir: string; loadQuery: () => Promise<typeof query>; logger: EventMapperLogger; parkQuietMs?: number; cleanupWaitMs?: number };

/** options.maxTokens and LH_MAX_OUTPUT_TOKENS do not apply to this provider (no verified SDK surface). */
export function streamClaudeCode(model: Model<any>, transcript: TranscriptContext, options: SimpleStreamOptions | undefined, deps: Deps): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	// LH-62: a conversation's calls share one long-lived child; a second call while it is busy runs one-shot.
	const key = liveReuseKey(options);
	if (key && !liveChildBusy(key)) {
		void streamLive(key, model, transcript, options, deps, stream);
		return stream;
	}
	const toolNameMap = new Map<string, string>();
	void run();
	return stream;

	async function run(): Promise<void> {
		const { mapper, logger, warn, readEndpoint } = callMapper(stream, model, toolNameMap, deps);
		let cwd = "", sessionId: string | undefined, release: (() => void) | undefined;
		let child: Query | undefined, server: ReturnType<typeof createToolServer> | undefined;
		let pending: Promise<unknown> | undefined, settled = true, closed = false;
		const park = parkCheck(mapper, () => server?.calls, deps.parkQuietMs);
		let wake!: () => void;
		const ended = new Promise<undefined>(resolve => { wake = () => resolve(undefined); });
		const abort = () => { stopChild("aborted"); mapper.fail("aborted", "aborted"); wake(); };
		function stopChild(reason: string): void {
			park.cancel();
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

		mapper.onToolTurnEnded = () => { wake(); stopChild("turn ended"); };
		try {
			if (overageLatched()) throw new Error(OVERAGE_REFUSAL);
			if (options?.signal?.aborted) { abort(); return; }
			options?.signal?.addEventListener("abort", abort, { once: true });
			const { systemPrompt, tools, history } = foldTranscript(transcript);
			const split = splitPrompt(history);
			if (split.kind === "invalid") throw new Error("claude-code: nothing to send");
			release = await acquireClaudeCodeSlot(options?.signal, evictIdleLiveChild);
			if (mapper.ended || options?.signal?.aborted) { abort(); return; }
			if (overageLatched()) throw new Error(OVERAGE_REFUSAL);
			for (const tool of tools) toolNameMap.set(MCP_TOOL_PREFIX + tool.name, tool.name);
			const cliModel = claudeCodeModelId(model, CLAUDE_CODE_SETTINGS);
			({ cwd, sessionId } = importHistory(split.prior, toolNameMap, cliModel, deps, warn));
			if (tools.length) server = createToolServer(tools, { timeoutMs: 3_600_000, onCall: park.check });
			const endpoint = readEndpoint();
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
				park.check();
			}
		} catch (error) {
			if (mapper.ended) warn(error);
			else mapper.fail(options?.signal?.aborted ? "aborted" : "error", options?.signal?.aborted ? "aborted" : error instanceof Error ? error.message : String(error));
		} finally {
			options?.signal?.removeEventListener("abort", abort);
			stopChild(options?.signal?.aborted ? "aborted" : "turn ended");
			server?.closeAll("turn ended");
			await reapChild({ child, pending: pending && !settled ? pending : undefined, release, sessionId, cwd, claudeDir: deps.claudeDir, logger, cleanupWaitMs: deps.cleanupWaitMs });
		}
	}
}

/** The call's mapper and logger; both redact the endpoint's secrets once readEndpoint has read it. Shared by the one-shot and live (LH-62) paths. */
export function callMapper(stream: AssistantMessageEventStream, model: Model<any>, toolNameMap: ReadonlyMap<string, string>, deps: Deps) {
	let endpoint: ClaudeCodeEndpoint | null | undefined;
	const redact = (text: string) => redactSecrets(text, endpoint);
	const logger: EventMapperLogger = {
		debug: text => deps.logger.debug(redact(text)),
		warn: text => deps.logger.warn(redact(text)),
	};
	const mapper = new EventMapper(stream, model, toolNameMap, logger);
	mapper.redact = redact;
	return { mapper, logger, warn: (error: unknown) => logger.warn(`claude-code: ${String(error)}`), readEndpoint: () => endpoint = deps.endpoint?.() };
}

/** Fallback frames describe a complete API response and arrive back to back before tools/call.
 * Parking the first call means those frames arrived; MCP calls may run sequentially, so
 * later calls cannot arrive while the first is parked. A request that has seen stream
 * events ends only at message_stop, so parks never end it. */
export function parkCheck(mapper: EventMapper, calls: () => readonly string[] | undefined, quietMs: number | undefined): { check: () => void; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		check: () => {
			clearTimeout(timer);
			if (mapper.ended) return;
			timer = setTimeout(() => {
				const ids = mapper.output.content.filter(b => b.type === "toolCall").map(b => b.id);
				if (!mapper.ended && !mapper.currentRequestStreamed && !mapper.hasOpenBlocks && ids.some(id => calls()?.includes(id))) mapper.endToolTurn("tool call parked after quiet window");
			}, quietMs ?? 2000);
		},
		cancel: () => clearTimeout(timer),
	};
}

/** Writes the prior history as a fresh session file for the child to resume; empty history needs none. */
export function importHistory(prior: Message[], toolNameMap: ReadonlyMap<string, string>, cliModel: string, deps: Deps, warn: (error: unknown) => void): { cwd: string; sessionId?: string } {
	const { anthropicMessages, dropped } = convertPiMessages(prior, new Map([...toolNameMap].map(([sdk, pi]) => [pi, sdk])));
	if (dropped.thinking || dropped.abortedTurns || dropped.other.size) {
		warn(`dropped history content: thinking=${dropped.thinking} providers=[${[...dropped.providers].join(",")}] abortedTurns=${dropped.abortedTurns}${[...dropped.other].map(([key, count]) => ` ${key}=${count}`).join("")}`);
	}
	const cwd = claudeCodeWorkdir(deps.dataDir);
	const swept = state[sweepKey] ??= new Set<string>();
	const pair = `${cwd}\0${deps.claudeDir}`;
	if (!swept.has(pair)) { sweepStaleSessions(cwd, deps.claudeDir); swept.add(pair); }
	try {
		const { sessionId } = writeSessionFile({ messages: anthropicMessages, cwd, claudeDir: deps.claudeDir, model: cliModel });
		markSessionActive(sessionId);
		return { cwd, sessionId };
	} catch (error) {
		if (!(error instanceof Error && error.message === "claude-code: empty history")) throw error;
		return { cwd };
	}
}

/** Waits a bounded time for a closed child to exit, then releases its slot and session file. */
export async function reapChild({ child, pending, release, sessionId, cwd, claudeDir, logger, cleanupWaitMs }: {
	child: Query | undefined; pending: Promise<unknown> | undefined; release: (() => void) | undefined;
	sessionId: string | undefined; cwd: string; claudeDir: string; logger: EventMapperLogger; cleanupWaitMs: number | undefined;
}): Promise<void> {
	const warn = (error: unknown) => logger.warn(`claude-code: ${String(error)}`);
	if (pending) {
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
				timer = setTimeout(() => { warn("child cleanup timed out"); resolve(); }, cleanupWaitMs ?? 10_000);
				timer.unref();
			})]);
		} catch (error) { warn(error); } finally { clearTimeout(timer); }
	}
	release?.();
	if (sessionId) {
		markSessionDone(sessionId);
		try { deleteSessionFile(sessionId, cwd, claudeDir); } catch (error) { warn(error); }
	}
}
