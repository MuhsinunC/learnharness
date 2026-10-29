// LH-62: one long-lived Claude Code child per conversation, opt-in with LH_CLAUDE_CODE_REUSE=1.
//
// A fresh child per model call never hits the prompt cache: Claude Code ends
// every request with its own context (a synthetic assistant turn, a
// system-reminder and the environment block holding the only message cache
// breakpoint), which the imported history of the next call never holds. A
// child kept alive with streaming input keeps that context in its own
// history, and its stable session id keeps a relay on one account.
//
// The key is pi's sessionId (the chat id for prober, teacher and practice; a
// per-run id for sub-agents). A call continues the child only when the child
// is idle, the model, effort, system prompt and tools are unchanged, and the
// transcript extends exactly what the child has seen: by pi's results for the
// tool calls the child is parked on (answered in-process), or by a new user
// run (pushed into the input stream). Anything else closes the child and
// imports the history into a new one, as the one-shot path does.
//
// No SDK contract covers the in-process tool-result path: toolUseId pairing,
// ack ordering and the post-tool drain are Claude Code behaviour, proven by
// tests/e2e/claude-code-session-reuse.e2e.ts against a stub and by the live
// re-measure, not by a spec.

import { createHash } from "node:crypto";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessageEventStream, Message, Model, SimpleStreamOptions, Tool, ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { onRunSessionEnd } from "../run-session.ts";
import { buildChildEnv } from "./child-env.ts";
import { overageLatched, OVERAGE_REFUSAL, type EventMapperLogger } from "./events.ts";
import { foldTranscript, splitPrompt, type PromptBlock } from "./history.ts";
import { claudeCodeModelId, CLAUDE_CODE_SETTINGS } from "./models.ts";
import { createToolServer } from "./mcp-server.ts";
import { buildQueryOptions, CONTINUE_TEXT, MCP_SERVER_NAME, MCP_TOOL_PREFIX, resolveEffort } from "./query-options.ts";
import { acquireClaudeCodeSlot, claudeCodeSlotWaiters } from "./slots.ts";
import { callMapper, importHistory, parkCheck, reapChild, type Deps } from "./stream.ts";

const DEFAULT_IDLE_MS = 600_000;
/** setTimeout overflows past 2^31 ms, so a day is the longest idle hold. */
const MAX_IDLE_MS = 86_400_000;
/** With callers waiting for a slot, an idle child gets this long (a tool step's gap) before it yields its slot. */
const SLOT_HANDOFF_MS = 2_000;
/** Claude Code caps MCP output (MAX_MCP_OUTPUT_TOKENS, 25k tokens by default); bigger results go through the import. */
const MAX_LIVE_RESULT_CHARS = 80_000;

export function liveReuseKey(options: SimpleStreamOptions | undefined): string | undefined {
	return process.env.LH_CLAUDE_CODE_REUSE === "1" && options?.sessionId ? options.sessionId : undefined;
}

function idleMs(): number {
	const value = Number(process.env.LH_CLAUDE_CODE_IDLE_MS ?? DEFAULT_IDLE_MS);
	return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_IDLE_MS) : DEFAULT_IDLE_MS;
}

/** A tool call stays parked while the child is idle, so Claude Code's timeout for it outlasts the idle close. */
function liveToolTimeoutMs(): number { return Math.max(3_600_000, idleMs() + 60_000); }

/** Frames that mean the model ran: an idle child that sends one has moved past the transcript. */
const MODEL_ACTIVITY = new Set(["assistant", "user", "result", "stream_event"]);

const registryKey = Symbol.for("lh.claudeCode.live");
const releasingKey = Symbol.for("lh.claudeCode.liveReleasing");
const globalState = globalThis as typeof globalThis & { [registryKey]?: Map<string, LiveChild>; [releasingKey]?: number };

/** Callers waiting for a slot beyond those that a closing child's slot will reach. */
function unservedWaiters(): number { return claudeCodeSlotWaiters() - (globalState[releasingKey] ?? 0); }
function liveChildren(): Map<string, LiveChild> {
	let registry = globalState[registryKey];
	if (!registry) {
		registry = globalState[registryKey] = new Map();
		// The children are this server's subprocesses: never leave one behind.
		process.once("exit", () => { for (const child of registry!.values()) child.close("server exit"); });
	}
	return registry;
}

export function liveChildBusy(key: string): boolean { return liveChildren().get(key)?.busy === true; }

// A sub-agent run's session id is never used again: free its child as soon as the run ends.
onRunSessionEnd(sessionId => globalState[registryKey]?.get(sessionId)?.closeWhenIdle("run ended"));

/** Closes the least recently used idle child so a caller waiting for a slot gets its slot. */
export function evictIdleLiveChild(): void {
	let oldest: LiveChild | undefined;
	for (const child of liveChildren().values()) if (!child.busy && (!oldest || child.lastUsed < oldest.lastUsed)) oldest = child;
	oldest?.close("evicted for another conversation");
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Hashes cached by object: pi hands a message's content array and its image blocks to every later call unchanged, so each is hashed once. */
const hashes = new WeakMap<object, string>();
function cachedHash(object: object, text: () => string): string {
	let hash = hashes.get(object);
	if (hash === undefined) hashes.set(object, hash = sha256(text()));
	return hash;
}

/** Pi messages compared by what the model sees; ids, timestamps and usage are left out. */
function messageKey(message: Message): string {
	const project = (block: any): unknown => {
		switch (block.type) {
			case "text": return ["text", block.text];
			case "image": return ["image", block.mimeType, cachedHash(block, () => block.data)];
			case "thinking": return ["thinking", block.thinking, block.thinkingSignature ?? "", block.redacted === true];
			case "toolCall": return ["toolCall", block.id, block.name, block.arguments];
			default: return [block.type];
		}
	};
	const content = typeof message.content === "string" ? sha256(JSON.stringify([project({ type: "text", text: message.content })]))
		: cachedHash(message.content, () => JSON.stringify((message.content as unknown[]).map(project)));
	const extra = message.role === "toolResult" ? [message.toolCallId, message.isError] : [];
	return sha256(JSON.stringify([message.role, ...extra, content]));
}

/** env is the child's whole environment, so a new endpoint token or address starts a new child. */
function configKey(parts: { executable: string; cliModel: string; effort: string | undefined; systemPrompt: string; tools: Tool[]; env: Record<string, string> }): string {
	const tools = parts.tools.map(tool => [tool.name, tool.description, tool.parameters]);
	return sha256(JSON.stringify({ ...parts, tools }));
}

function callToolResult(message: ToolResultMessage): CallToolResult {
	return {
		content: message.content.map(block => block.type === "text" ? { type: "text" as const, text: block.text }
			: block.type === "image" ? { type: "image" as const, data: block.data, mimeType: block.mimeType }
			: { type: "text" as const, text: `[${(block as { type: string }).type}]` }),
		isError: message.isError,
	};
}

/** convert.ts moves an error result's images out of the tool_result; MCP cannot, so those go through the import. */
function fitsInProcess(message: ToolResultMessage): boolean {
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "image" && message.isError) return false;
	}
	return chars <= MAX_LIVE_RESULT_CHARS;
}

type Continuation = { kind: "results"; results: ToolResultMessage[] } | { kind: "user"; blocks: PromptBlock[] };

class InputQueue {
	private items: SDKUserMessage[] = [];
	private wake: (() => void) | undefined;
	private ended = false;
	readonly messages: AsyncGenerator<SDKUserMessage>;
	constructor() {
		const self = this;
		this.messages = (async function* () {
			for (;;) {
				while (self.items.length) yield self.items.shift()!;
				if (self.ended) return;
				await new Promise<void>(resolve => { self.wake = resolve; });
			}
		})();
	}
	push(blocks: PromptBlock[]): void {
		this.items.push({ type: "user", message: { role: "user", content: blocks as SDKUserMessage["message"]["content"] }, parent_tool_use_id: null, session_id: "" });
		this.wake?.();
	}
	end(): void { this.ended = true; this.wake?.(); }
}

class LiveChild {
	busy = true;
	closed = false;
	lastUsed = Date.now();
	/** messageKey of every message the child has seen, its own replies included. */
	seen: string[] = [];
	/** Tool call ids of the last reply, which the child is parked on. */
	pending: string[] = [];
	query: Query | undefined;
	server: ReturnType<typeof createToolServer> | undefined;
	release: (() => void) | undefined;
	cwd = "";
	sessionFile: string | undefined;
	/** The running call's park check. */
	onCall: (() => void) | undefined;
	/** Why the child closes when its running call ends instead of going idle. */
	closeReason: string | undefined;
	readonly input = new InputQueue();
	private iterator: AsyncIterator<SDKMessage> | undefined;
	private buffered: Promise<IteratorResult<SDKMessage>> | undefined;
	/** Message ids of earlier calls: their trailing frames arrive after those calls ended. */
	private priorIds = new Set<string>();
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(readonly key: string, readonly config: string, private deps: Deps, private logger: EventMapperLogger) {}

	start(query: Query): void {
		this.query = query;
		this.iterator = query[Symbol.asyncIterator]();
	}

	/** One read at a time; a read the last call left unconsumed is the next call's first. */
	next(): Promise<IteratorResult<SDKMessage>> {
		if (!this.buffered) {
			const read = Promise.resolve().then(() => this.iterator!.next());
			read.catch(() => {});
			this.buffered = read;
		}
		return this.buffered;
	}
	consume(read: Promise<IteratorResult<SDKMessage>>): void { if (this.buffered === read) this.buffered = undefined; }

	stale(message: SDKMessage): boolean {
		const id = message.type === "assistant" ? (message as { message?: { id?: string } }).message?.id
			: message.type === "stream_event" && (message as { event?: { type?: string } }).event?.type === "message_start"
				? (message as { event: { message?: { id?: string } } }).event.message?.id : undefined;
		return id !== undefined && this.priorIds.has(id);
	}

	busyAgain(): void {
		clearTimeout(this.idleTimer);
		this.busy = true;
		this.lastUsed = Date.now();
	}

	/** Closes the child now, or when its running call ends. */
	closeWhenIdle(reason: string): void {
		if (this.busy) this.closeReason ??= reason;
		else this.close(reason);
	}

	idle(seen: string[], pending: string[], callIds: Iterable<string>): void {
		this.seen = seen;
		this.pending = pending;
		for (const id of callIds) this.priorIds.add(id);
		this.busy = false;
		this.lastUsed = Date.now();
		this.armIdle(Date.now() + idleMs());
		void this.watch();
	}

	/** While callers wait for a slot the child yields its own after a tool step's gap, if any still wait by then. */
	private armIdle(deadline: number): void {
		const handoff = unservedWaiters() > 0 && deadline - Date.now() > SLOT_HANDOFF_MS;
		this.idleTimer = setTimeout(() => {
			if (!handoff) this.close("idle");
			else if (unservedWaiters() > 0) this.close("slot needed");
			else this.armIdle(deadline);
		}, handoff ? SLOT_HANDOFF_MS : Math.max(0, deadline - Date.now()));
		this.idleTimer.unref();
	}

	/** Drains late frames while idle; a child that runs the model on its own or exits between calls is closed. */
	private async watch(): Promise<void> {
		while (!this.busy && !this.closed) {
			const read = this.next();
			const item = await read.catch(() => undefined);
			if (this.busy || this.closed) return;
			this.consume(read);
			if (!item || item.done) { this.close("child exited"); return; }
			if (this.stale(item.value)) continue;
			if (MODEL_ACTIVITY.has(item.value.type)) { this.close(`idle child sent ${item.value.type}`); return; }
			this.logger.debug(`claude-code: idle child sent ${item.value.type}`);
		}
	}

	close(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.idleTimer);
		const registry = liveChildren();
		if (registry.get(this.key) === this) registry.delete(this.key);
		if (this.query) console.info(`claude-code: live session closed (${reason})`);
		this.input.end();
		const warn = (error: unknown) => this.logger.warn(`claude-code: ${String(error)}`);
		if (this.query) {
			try { void this.query.interrupt().catch(error => this.logger.debug(`claude-code: ${String(error)}`)); } catch (error) { warn(error); }
			try { this.query.close(); } catch (error) { warn(error); }
		}
		this.server?.closeAll(reason);
		const release = this.release;
		if (release) globalState[releasingKey] = (globalState[releasingKey] ?? 0) + 1;
		void reapChild({ child: this.query, pending: this.buffered?.catch(() => {}), release: release && (() => { globalState[releasingKey]!--; release(); }), sessionId: this.sessionFile, cwd: this.cwd,
			claudeDir: this.deps.claudeDir, logger: this.logger, cleanupWaitMs: this.deps.cleanupWaitMs });
	}

	/** What the new transcript asks of this child, or undefined when it does not extend what the child has seen. */
	continuation(keys: string[], history: Message[], split: ReturnType<typeof splitPrompt>): Continuation | undefined {
		const n = this.seen.length;
		if (keys.length <= n || this.seen.some((key, i) => key !== keys[i])) return undefined;
		const tail = history.slice(n);
		if (this.pending.length) {
			if (!tail.every((m): m is ToolResultMessage => m.role === "toolResult" && fitsInProcess(m))) return undefined;
			const ids = new Set(tail.map(m => m.toolCallId));
			if (ids.size !== tail.length || ids.size !== this.pending.length || !this.pending.every(id => ids.has(id))) return undefined;
			return { kind: "results", results: tail };
		}
		return split.kind === "user" && split.prior.length === n ? { kind: "user", blocks: split.blocks } : undefined;
	}
}

/** A tool_result echo for a call whose answer from pi is still waiting: Claude Code gave that call a result of its own. */
function answeredItself(child: LiveChild, message: SDKMessage): boolean {
	if (message.type !== "user" || message.parent_tool_use_id != null) return false;
	const content = (message as { message?: { content?: unknown } }).message?.content;
	return Array.isArray(content) && content.some(block => block?.type === "tool_result" && child.server?.awaitsCall(block.tool_use_id) === true);
}

/** One model call on the conversation's live child, continuing it or starting it. */
export async function streamLive(key: string, model: Model<any>, transcript: TranscriptContext, options: SimpleStreamOptions | undefined, deps: Deps, stream: AssistantMessageEventStream): Promise<void> {
	const toolNameMap = new Map<string, string>();
	const { mapper, logger, warn, readEndpoint } = callMapper(stream, model, toolNameMap, deps);
	mapper.resultUsageSpansCalls = true;
	let child: LiveChild | undefined, delivered = false, settled = false;
	let wake!: () => void;
	const ended = new Promise<undefined>(resolve => { wake = () => resolve(undefined); });
	const park = parkCheck(mapper, () => child?.server?.calls, deps.parkQuietMs);
	// Once the child has the input its history runs ahead of the transcript, so an abort ends it.
	const abort = () => { park.cancel(); if (delivered) child?.close("aborted"); mapper.fail("aborted", "aborted"); wake(); };
	const callIds = new Set<string>();
	let keys: string[] = [];
	/** Hands the child back when the call ends. A tool turn ends inside the mapper, which pushes `done` first,
	 * but pi reads it only on a later tick: pi's next call finds the child idle, not busy. */
	function settle(): void {
		if (settled) return;
		settled = true;
		options?.signal?.removeEventListener("abort", abort);
		park.cancel();
		if (!child) return;
		child.onCall = undefined;
		const output = mapper.output;
		if (child.closed) return;
		if (mapper.ranOn) child.close("Claude Code ran past the tool calls");
		else if (child.closeReason) child.close(child.closeReason);
		else if (output.stopReason === "stop" || output.stopReason === "toolUse") {
			const pending = output.stopReason === "toolUse" ? output.content.flatMap(b => b.type === "toolCall" ? [b.id] : []) : [];
			child.idle([...keys, messageKey(output)], pending, callIds);
		} else child.close(output.stopReason === "aborted" ? "aborted" : "call failed");
	}
	mapper.onToolTurnEnded = () => { settle(); wake(); };
	try {
		if (overageLatched()) throw new Error(OVERAGE_REFUSAL);
		if (options?.signal?.aborted) { abort(); return; }
		options?.signal?.addEventListener("abort", abort, { once: true });
		const { systemPrompt, tools, history } = foldTranscript(transcript);
		const split = splitPrompt(history);
		if (split.kind === "invalid") throw new Error("claude-code: nothing to send");
		for (const tool of tools) toolNameMap.set(MCP_TOOL_PREFIX + tool.name, tool.name);
		const endpoint = readEndpoint();
		if (deps.endpoint && !endpoint) throw new Error("claude-code: endpoint not configured");
		const cliModel = claudeCodeModelId(model, CLAUDE_CODE_SETTINGS);
		const effort = resolveEffort(model, options?.reasoning);
		const config = configKey({ executable: deps.executable, cliModel, effort, systemPrompt, tools, env: buildChildEnv(process.env, endpoint, deps.executable) });
		keys = history.map(messageKey);
		const registry = liveChildren();
		const live = registry.get(key);
		let step = live && live.config === config ? live.continuation(keys, history, split) : undefined;
		if (live && !step) live.close(live.config === config ? "history changed" : "model, effort, prompt, tools or credentials changed");
		/** Starts a child from an import of the record; false when the call ended first. */
		const startFresh = async (replacing: boolean): Promise<boolean> => {
			// Registered before the first await, so a concurrent call on this key runs one-shot.
			const fresh = child = new LiveChild(key, config, deps, logger);
			registry.set(key, fresh);
			// A replaced child frees its own slot; evicting another one too would cost that conversation its cache.
			fresh.release = await acquireClaudeCodeSlot(options?.signal, replacing ? undefined : evictIdleLiveChild);
			if (mapper.ended || options?.signal?.aborted) { abort(); return false; }
			if (overageLatched()) throw new Error(OVERAGE_REFUSAL);
			({ cwd: fresh.cwd, sessionId: fresh.sessionFile } = importHistory(split.prior, toolNameMap, cliModel, deps, warn));
			// A cancelled or refused call gets an error result inside Claude Code, which then runs on without pi.
			if (tools.length) fresh.server = createToolServer(tools, { timeoutMs: liveToolTimeoutMs(), onCall: () => fresh.onCall?.(),
				onCancel: () => fresh.closeWhenIdle("tool call cancelled"), onRefuse: () => fresh.closeWhenIdle("tool call refused") });
			const queryOptions = buildQueryOptions({ executable: deps.executable, cwd: fresh.cwd, cliModel, live: true,
				...(endpoint ? { endpoint } : {}),
				effort, appendPrompt: systemPrompt, resumeId: fresh.sessionFile,
				...(fresh.server ? { mcpServers: { [MCP_SERVER_NAME]: fresh.server.config } } : {}) });
			const loading = deps.loadQuery();
			void loading.catch(error => { if (mapper.ended) warn(error); });
			const queryFn = await Promise.race([loading, ended]);
			if (!queryFn) { abort(); return false; }
			if (mapper.ended || options?.signal?.aborted) { abort(); return false; }
			if (overageLatched()) throw new Error(OVERAGE_REFUSAL);
			const registrationError = deps.registrationError?.();
			if (registrationError) throw new Error(registrationError);
			fresh.input.push(split.kind === "user" ? split.blocks : [{ type: "text", text: CONTINUE_TEXT }]);
			fresh.start(queryFn({ prompt: fresh.input.messages, options: queryOptions }));
			delivered = true;
			console.info(`claude-code: live session started (${replacing ? "replaced" : "new"})`);
			return true;
		};
		if (live && step) {
			child = live;
			child.busyAgain();
			const registrationError = deps.registrationError?.();
			if (registrationError) throw new Error(registrationError);
			if (step.kind === "results") for (const result of step.results) child.server?.answer(result.toolCallId, callToolResult(result));
			else child.input.push(step.blocks);
			delivered = true;
			logger.debug(`claude-code: live session continued with ${step.kind}`);
		} else if (!await startFresh(live !== undefined)) return;
		let active = child!;
		active.onCall = park.check;
		while (!mapper.ended) {
			const read = active.next();
			const item = await Promise.race([read, ended]);
			if (!item) break;
			active.consume(read);
			if (item.done) { mapper.fail("error", "claude-code: iterator ended without result"); break; }
			const message = item.value;
			if (active.stale(message)) continue;
			if (step?.kind === "results" && !mapper.output.content.length && answeredItself(active, message)) {
				// The idle child ran on before its watch saw it: pi's results never reached it, so start over from the record.
				active.close("Claude Code answered a tool call itself");
				step = undefined;
				callIds.clear();
				if (!await startFresh(true)) return;
				active = child!;
				active.onCall = park.check;
				continue;
			}
			if (message.type === "assistant") { const id = (message as { message?: { id?: string } }).message?.id; if (id) callIds.add(id); }
			else if (message.type === "stream_event" && message.event.type === "message_start") callIds.add(message.event.message.id);
			mapper.handle(message);
			park.check();
		}
	} catch (error) {
		if (mapper.ended) warn(error);
		else mapper.fail(options?.signal?.aborted ? "aborted" : "error", options?.signal?.aborted ? "aborted" : error instanceof Error ? error.message : String(error));
	} finally {
		settle();
	}
}
