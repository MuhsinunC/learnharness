import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseStreamingJson, parseToolCallArguments, type AssistantMessage, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";

export interface EventMapperLogger { debug(msg: string): void; warn(msg: string): void }
export const OVERAGE_REFUSAL = "claude-code: would spend Extra Usage; refused";
const overageKey = Symbol.for("lh.claudeCode.overage");
const globalState = globalThis as typeof globalThis & { [overageKey]?: boolean };
export function overageLatched(): boolean { return globalState[overageKey] === true; }
export function resetOverageLatchForTests(): void { delete globalState[overageKey]; }

export function resultErrorText(message: SDKMessage): string | undefined {
	const result = message as SDKMessage & { subtype?: string; is_error?: boolean; result?: string; errors?: unknown; error?: unknown };
	if (result.subtype === "success") return result.is_error ? result.result || "Claude Code reported an error" : undefined;
	if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

export function describeRateLimitFailure(rejection: { rateLimitType?: string; resetsAt?: number }, failure: string): string {
	const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : "";
	const resets = rejection.resetsAt ? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}` : ""; // resetsAt: Unix seconds (unit undocumented in the SDK; observed)
	return `Claude rate limit${kind}${resets}: ${failure}`;
}
export function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function piToolNameFor(name: string, toolNameMap: ReadonlyMap<string, string>): string {
	return toolNameMap.get(name) ?? toolNameMap.get(name.toLowerCase()) ?? name;
}

type SDKUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number; reasoning_tokens?: number; thinking_tokens?: number;
	output_tokens_details?: { thinking_tokens?: number | null } | null;
	cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null };
type RateLimitInfo = { status?: string; rateLimitType?: string; resetsAt?: number; utilization?: number;
	surpassedThreshold?: number; isUsingOverage?: boolean; overageInUse?: boolean };

type RequestState = {
	id: string | undefined; blocks: any[]; streamed: Map<number, any>; ordinal: number;
	usage: AssistantMessage["usage"]; fallbackTools: boolean; finalUsage: boolean; open: boolean; fromStream: boolean; stopReason?: string;
};
function emptyUsage(): AssistantMessage["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export class EventMapper {
	private readonly message: AssistantMessage;
	private terminal = false;
	private turnStarted = false;
	private requests: RequestState[] = [];
	private currentRequest: RequestState | undefined;
	private frameBlocks = new Map<string, { request: RequestState; blocks: any[] }>();
	private turnSawToolCall = false;
	private activeBlockIndices = new Map<any, number>();
	private rateLimitRejection: RateLimitInfo | null = null;
	private lastRateLimitWarnStep: number | null = null;
	private lastRateLimitWarnThreshold: number | undefined;
	onToolTurnEnded: (() => void) | undefined;
	constructor(private stream: AssistantMessageEventStream, model: Model<any>,
		private toolNameMap: ReadonlyMap<string, string>, private logger: EventMapperLogger) {
		this.message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
	}
	get output(): AssistantMessage { return this.message; }
	get ended(): boolean { return this.terminal; }
	get hasOpenBlocks(): boolean { return this.activeBlockIndices.size > 0; }
	/** True when the current request was opened by a stream message_start (not the non-streaming fallback). */
	get currentRequestStreamed(): boolean { return this.currentRequest?.fromStream === true; }
	private get blocks(): Array<any> { return this.output.content; }
	handle(message: SDKMessage): void {
		if ("parent_tool_use_id" in message && message.parent_tool_use_id != null) {
			this.logger.debug(`Ignoring nested subagent ${message.type}`);
			return;
		}
		if (message.type === "rate_limit_event") {
			this.processRateLimitEvent(message.rate_limit_info as RateLimitInfo);
			return;
		}
		if (this.terminal) {
			if (message.type === "stream_event" && message.event.type === "message_start" && (this.output.stopReason === "toolUse" || this.output.stopReason === "length") && this.turnSawToolCall)
				this.logger.warn("guard violation: message_start after tool turn ended");
			return;
		}
		if (message.type === "stream_event") this.processStreamEvent(message);
		else if (message.type === "assistant") this.processAssistantMessage(message);
		else if (message.type === "result") this.finish(message);
		else if (message.type === "user") this.endToolTurn("user frame");
	}
	/** lh-2h calls this once every pending tool call id seen by the mapper has a
	 * matching parked MCP tools/call. Ends the turn so the orchestrator can close it. */
	endToolTurn(reason: string): void {
		if (this.terminal || !this.turnSawToolCall) return;
		this.logger.debug(`endToolTurn: ${reason}`);
		this.endTurn(this.output.stopReason === "length" ? "length" : "toolUse");
	}
	finish(result: SDKMessage): void {
		if (this.terminal) return;
		if (result.type === "result") {
			if (result.usage) {
				const aggregate = { usage: emptyUsage() };
				this.updateUsage(aggregate, result.usage);
				if (!this.requests.some(r => r.finalUsage) || aggregate.usage.totalTokens > this.output.usage.totalTokens)
					this.output.usage = aggregate.usage;
			}
			if (result.stop_reason != null && (!this.currentRequest?.stopReason || result.stop_reason === "max_tokens"))
				this.output.stopReason = mapStopReason(result.stop_reason);
		}
		let text = resultErrorText(result);
		if (text !== undefined) {
			if (this.rateLimitRejection) text = describeRateLimitFailure(this.rateLimitRejection, text);
			this.rateLimitRejection = null;
			this.fail("error", text);
		} else this.endTurn(this.output.stopReason === "length" ? "length" : this.turnSawToolCall ? "toolUse" : "stop");
	}
	fail(reason: "aborted" | "error", errorMessage: string): void {
		if (this.terminal) return;
		this.output.stopReason = reason;
		this.output.errorMessage = errorMessage;
		this.ensureTurnStarted();
		this.terminal = true;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}
	private ensureTurnStarted(): void {
		if (!this.turnStarted) {
			this.turnStarted = true;
			this.stream.push({ type: "start", partial: this.output });
		}
	}
	private endTurn(reason: "stop" | "length" | "toolUse"): void {
		this.ensureTurnStarted();
		this.output.stopReason = reason;
		this.terminal = true;
		this.stream.push({ type: "done", reason, message: this.output });
		this.stream.end();
		if (this.turnSawToolCall) this.onToolTurnEnded?.();
	}
	private updateUsage(output: Pick<AssistantMessage, "usage">, usage: SDKUsage): void {
		if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
		if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
		if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
		if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
		if (usage.cache_creation?.ephemeral_1h_input_tokens != null) output.usage.cacheWrite1h = usage.cache_creation.ephemeral_1h_input_tokens;
		const reasoning = usage.output_tokens_details?.thinking_tokens ?? usage.reasoning_tokens ?? usage.thinking_tokens;
		if (reasoning != null) output.usage.reasoning = reasoning;
		output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
		const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
		const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
		this.logger.debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoning != null ? ` reasoning=${reasoning}` : ""} cachePct=${cachePct}%`);
	}
	private processRateLimitEvent(info: RateLimitInfo): void {
		this.logger.debug(`rate_limit_event ${JSON.stringify(info)}`);
		if (info.isUsingOverage === true || info.overageInUse === true) {
			globalState[overageKey] = true;
			this.logger.warn(OVERAGE_REFUSAL);
			this.fail("error", OVERAGE_REFUSAL);
		}
		if (info.status === "rejected") {
			this.rateLimitRejection = info;
			this.lastRateLimitWarnStep = null;
			this.lastRateLimitWarnThreshold = undefined;
			const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "unknown";
			this.logger.warn(`Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`);
		} else if (info.status === "allowed") {
			this.rateLimitRejection = null;
			this.lastRateLimitWarnStep = null;
			this.lastRateLimitWarnThreshold = undefined;
		} else if (info.status === "allowed_warning") {
			this.rateLimitRejection = null;
			const percent = Math.round((info.utilization ?? 0) * 100);
			const step = Math.floor(percent / 5);
			const rose = this.lastRateLimitWarnStep === null || step > this.lastRateLimitWarnStep;
			if (rose || info.surpassedThreshold !== this.lastRateLimitWarnThreshold) {
				this.lastRateLimitWarnStep = step;
				this.lastRateLimitWarnThreshold = info.surpassedThreshold;
				this.logger.warn(`Claude rate limit warning: ${percent}% used (${info.rateLimitType ?? ""})`);
			}
		}
	}
	private refreshUsage(): void {
		const usage = emptyUsage();
		for (const request of this.requests) {
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "cacheWrite1h"] as const)
				if (request.usage[key] != null) usage[key] = (usage[key] ?? 0) + request.usage[key];
		}
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		this.output.usage = usage;
	}
	private beginRequest(id: string | undefined): RequestState {
		const request: RequestState = { id, blocks: [], streamed: new Map(), ordinal: 0,
			usage: emptyUsage(), fallbackTools: false, finalUsage: false, open: false, fromStream: false };
		this.requests.push(request);
		this.currentRequest = request;
		this.output.stopReason = "stop";
		return request;
	}
	// A stream that never finished, or finished without a stop reason, was abandoned. Fallback-only
	// frames rarely carry a stop reason, so they count as complete; refusals are evicted via supersedes.
	private abandoned(request: RequestState): boolean { return request.open || (request.fromStream && !request.stopReason); }
	private dropAbandonedStreamBlocks(why: string): void {
		const request = this.currentRequest;
		if (!request) return;
		this.output.content = this.blocks.filter(b => !request.blocks.includes(b));
		this.requests = this.requests.filter(r => r !== request);
		for (const block of request.blocks) this.activeBlockIndices.delete(block);
		this.logger.debug(`dropAbandonedStreamBlocks: ${why}; dropped ${request.blocks.length} blocks from ${request.id}`);
		this.currentRequest = undefined;
		this.turnSawToolCall = this.blocks.some(b => b.type === "toolCall");
		this.output.stopReason = "stop";
		this.refreshUsage();
	}
	private supersedeFrames(uuids: readonly string[]): void {
		for (const uuid of uuids) {
			const frame = this.frameBlocks.get(uuid);
			if (!frame) continue;
			this.output.content = this.blocks.filter(b => !frame.blocks.includes(b));
			frame.request.blocks = frame.request.blocks.filter(b => !frame.blocks.includes(b));
			for (const [index, block] of frame.request.streamed)
				if (frame.blocks.includes(block)) frame.request.streamed.delete(index);
			if (!frame.request.blocks.length) {
				this.requests = this.requests.filter(r => r !== frame.request);
				if (this.currentRequest === frame.request) this.currentRequest = undefined;
			}
			this.frameBlocks.delete(uuid);
			this.logger.debug(`supersedes: evicted ${uuid}`);
		}
		// Superseding earlier content can shift a block whose stream has not stopped yet.
		for (const [block, previous] of this.activeBlockIndices) {
			const contentIndex = this.blocks.indexOf(block);
			if (contentIndex < 0) { this.activeBlockIndices.delete(block); continue; }
			if (contentIndex === previous) continue;
			this.activeBlockIndices.set(block, contentIndex);
			if (block.type === "text") this.stream.push({ type: "text_start", contentIndex, partial: this.output });
			else if (block.type === "thinking") this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
			else this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			if (block.type === "text" && block.text) this.stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: this.output });
			else if (block.type === "thinking" && block.thinking) this.stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: this.output });
			else if (block.partialJson) this.stream.push({ type: "toolcall_delta", contentIndex, delta: block.partialJson, partial: this.output });
		}
		this.turnSawToolCall = this.blocks.some(b => b.type === "toolCall");
		this.refreshUsage();
	}
	private processStreamEvent(message: SDKMessage): void {
		const event = (message as SDKMessage & { event: any }).event;

		if (event?.type === "message_start") {
			if (this.currentRequest && (this.abandoned(this.currentRequest) || this.currentRequest.id === event.message?.id))
				this.dropAbandonedStreamBlocks(`restreamed as ${event.message?.id}`);
			const request = this.beginRequest(event.message?.id);
			request.open = request.fromStream = true;
			if (event.message?.usage) this.updateUsage(request, event.message.usage);
			this.refreshUsage();
			return;
		}
		const request = this.currentRequest ?? this.beginRequest(undefined);

		if (event?.type === "content_block_start") {
			this.ensureTurnStarted();
			if (event.content_block?.type === "text") {
				this.blocks.push({ type: "text", text: event.content_block.text ?? "" });
				this.stream.push({ type: "text_start", contentIndex: this.blocks.length - 1, partial: this.output });
				if (event.content_block.text) this.stream.push({ type: "text_delta", contentIndex: this.blocks.length - 1, delta: event.content_block.text, partial: this.output });
			} else if (event.content_block?.type === "thinking") {
				this.blocks.push({ type: "thinking", thinking: event.content_block.thinking ?? "", thinkingSignature: event.content_block.signature ?? "" });
				this.stream.push({ type: "thinking_start", contentIndex: this.blocks.length - 1, partial: this.output });
				if (event.content_block.thinking) this.stream.push({ type: "thinking_delta", contentIndex: this.blocks.length - 1, delta: event.content_block.thinking, partial: this.output });
			} else if (event.content_block?.type === "redacted_thinking") {
				this.blocks.push({ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: event.content_block.data, redacted: true });
				this.stream.push({ type: "thinking_start", contentIndex: this.blocks.length - 1, partial: this.output });
			} else if (event.content_block?.type === "tool_use") {
				const piName = piToolNameFor(event.content_block.name, this.toolNameMap);
				this.turnSawToolCall = true;
				this.blocks.push({
					type: "toolCall", id: event.content_block.id,
					name: piName,
					arguments: (event.content_block.input as Record<string, unknown>) ?? {},
					partialJson: "",
				});
				this.stream.push({ type: "toolcall_start", contentIndex: this.blocks.length - 1, partial: this.output });
			} else {
				this.logger.debug(`processStreamEvent: unhandled content_block_start type ${event.content_block?.type}`);
				return;
			}
			request.streamed.set(event.index, this.blocks.at(-1));
			this.activeBlockIndices.set(this.blocks.at(-1), this.blocks.length - 1);
			request.blocks.push(this.blocks.at(-1));
			return;
		}

		if (event?.type === "content_block_delta") {
			const block = request.streamed.get(event.index);
			const index = this.blocks.indexOf(block);
			if (!block) return;
			if (event.delta?.type === "text_delta" && block.type === "text") {
				block.text += event.delta.text;
				this.stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: this.output });
			} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
				block.thinking += event.delta.thinking;
				this.stream.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: this.output });
			} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
				block.partialJson += event.delta.partial_json;
				if (block.partialJson) block.arguments = parseStreamingJson(block.partialJson);
				this.stream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: this.output });
			} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
				block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
			} else {
				this.logger.debug(`processStreamEvent: unhandled content_block_delta type ${event.delta?.type}`);
			}
			return;
		}

		if (event?.type === "content_block_stop") {
			const block = request.streamed.get(event.index);
			const index = this.blocks.indexOf(block);
			if (!block) return;
			this.activeBlockIndices.delete(block);
			if (block.type === "text") {
				this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.output });
			} else if (block.type === "thinking") {
				this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.output });
			} else if (block.type === "toolCall") {
				this.turnSawToolCall = true;
				if (block.partialJson) {
					Object.assign(block, parseToolCallArguments(block.partialJson));
				} else if (!block.arguments || (Object.getPrototypeOf(block.arguments) !== Object.prototype && Object.getPrototypeOf(block.arguments) !== null)) {
					block.arguments = {};
				}
				delete block.partialJson;
				this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.output });
			}
			return;
		}

		if (event?.type === "message_delta") {
			if (event.delta?.stop_reason != null) {
				request.stopReason = event.delta.stop_reason;
				this.output.stopReason = mapStopReason(request.stopReason);
			}
			if (event.usage) {
				this.updateUsage(request, event.usage);
				request.finalUsage = true;
				this.refreshUsage();
			}
			return;
		}

		if (event?.type === "message_stop") request.open = false;

		if (event?.type === "message_stop" && this.turnSawToolCall) {
			this.endToolTurn("message_stop");
			return;
		}

		if (event?.type !== "message_stop" && event?.type !== "ping") {
			this.logger.debug(`processStreamEvent: unhandled event type ${event?.type}`);
		}
	}
	private processAssistantMessage(message: SDKMessage): void {
		const assistantMsg = (message as any).message;
		if (!assistantMsg?.content) return;
		const id = assistantMsg.id;
		const supersedes = (message as { supersedes?: string[] }).supersedes;
		if (supersedes?.length) this.supersedeFrames(supersedes);
		if (this.currentRequest?.id !== id && this.currentRequest?.fallbackTools && this.turnSawToolCall) {
			this.endToolTurn("different assistant id");
			return;
		}
		if (this.currentRequest?.id !== id) {
			if (this.currentRequest && this.abandoned(this.currentRequest))
				this.dropAbandonedStreamBlocks(`non-streaming fallback ${id}`);
			this.beginRequest(id);
		}
		const request = this.currentRequest!;
		const contributed: any[] = [];
		this.logger.debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
		for (const block of assistantMsg.content) {
			const ordinal = request.ordinal++;
			const streamed = block.type === "tool_use"
				? [...request.streamed.values()].find(b => b.type === "toolCall" && b.id === block.id)
				: request.streamed.get(ordinal);
			if (streamed) { contributed.push(streamed); continue; }
			if (block.type === "text" && block.text) {
				this.ensureTurnStarted();
				this.blocks.push({ type: "text", text: block.text });
				const idx = this.blocks.length - 1;
				this.stream.push({ type: "text_start", contentIndex: idx, partial: this.output });
				this.stream.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: this.output });
				this.stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: this.output });
			} else if (block.type === "thinking" || block.type === "redacted_thinking") {
				this.ensureTurnStarted();
				this.blocks.push(block.type === "redacted_thinking"
					? { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: block.data, redacted: true }
					: { type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
				const idx = this.blocks.length - 1;
				this.stream.push({ type: "thinking_start", contentIndex: idx, partial: this.output });
				if (block.thinking) this.stream.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: this.output });
				this.stream.push({ type: "thinking_end", contentIndex: idx, content: this.blocks[idx].thinking, partial: this.output });
			} else if (block.type === "tool_use") {
				const piName = piToolNameFor(block.name, this.toolNameMap);
				this.ensureTurnStarted();
				this.turnSawToolCall = true;
				request.fallbackTools = true;
				this.blocks.push({
					type: "toolCall", id: block.id,
					name: piName,
					arguments: block.input ?? {},
				});
				const idx = this.blocks.length - 1;
				const toolBlock = this.blocks[idx];
				this.stream.push({ type: "toolcall_start", contentIndex: idx, partial: this.output });
				this.stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock, partial: this.output });
			} else {
				this.logger.debug(`processAssistantMessage: unhandled block type ${block.type}`);
				continue;
			}
			contributed.push(this.blocks.at(-1));
			request.blocks.push(this.blocks.at(-1));
		}
		if ("uuid" in message && message.uuid) this.frameBlocks.set(message.uuid, { request, blocks: contributed });
		if (assistantMsg.usage && !request.finalUsage) this.updateUsage(request, assistantMsg.usage);
		this.refreshUsage();
		if (assistantMsg.stop_reason != null) {
			request.stopReason = assistantMsg.stop_reason;
			this.output.stopReason = mapStopReason(assistantMsg.stop_reason);
			this.endToolTurn("assistant stop_reason");
		}
	}
}
