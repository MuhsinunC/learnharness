import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";

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

export function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}

function piToolNameFor(name: string, toolNameMap: ReadonlyMap<string, string>): string {
	return toolNameMap.get(name) ?? toolNameMap.get(name.toLowerCase()) ?? name;
}

type SDKUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number; reasoning_tokens?: number; thinking_tokens?: number;
	cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null };
type RateLimitInfo = { status?: string; rateLimitType?: string; resetsAt?: number; utilization?: number;
	surpassedThreshold?: number; isUsingOverage?: boolean; overageInUse?: boolean };

export class EventMapper {
	private readonly message: AssistantMessage;
	private terminal = false;
	private turnStarted = false;
	private turnSawStreamEvent = false;
	private turnSawToolCall = false;
	private turnStreamMessageId: string | undefined;
	private turnStreamOpen = false;
	private turnStreamBlockStart = 0;
	private rateLimitRejection: RateLimitInfo | null = null;
	private lastRateLimitWarnStep: number | null = null;
	private lastRateLimitWarnThreshold: number | undefined;
	onToolTurnEnded: (() => void) | undefined;
	constructor(private stream: AssistantMessageEventStream, model: Model<any>,
		private toolNameMap: ReadonlyMap<string, string>, private logger: EventMapperLogger) {
		this.message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
	}
	get output(): AssistantMessage { return this.message; }
	get ended(): boolean { return this.terminal; }
	private get blocks(): Array<any> { return this.output.content; }
	handle(message: SDKMessage): void {
		if (message.type === "rate_limit_event") {
			this.processRateLimitEvent(message.rate_limit_info as RateLimitInfo);
			return;
		}
		if (this.terminal) {
			if (message.type === "stream_event" && message.event.type === "message_start" && this.output.stopReason === "toolUse")
				this.logger.warn("guard violation: message_start after tool turn ended");
			return;
		}
		if (message.type === "stream_event") this.processStreamEvent(message);
		else if (message.type === "assistant") this.processAssistantMessage(message);
		else if (message.type === "result") this.finish(message);
	}
	finish(result: SDKMessage): void {
		if (this.terminal) return;
		let text = resultErrorText(result);
		if (text !== undefined) {
			if (this.rateLimitRejection) text = describeRateLimitFailure(this.rateLimitRejection, text);
			this.rateLimitRejection = null;
			this.fail("error", text);
		} else this.endTurn(this.output.stopReason === "length" ? "length" : "stop");
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
		if (reason === "toolUse") this.onToolTurnEnded?.();
	}
	private updateUsage(output: AssistantMessage, usage: SDKUsage): void {
		if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
		if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
		if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
		if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
		if (usage.cache_creation?.ephemeral_1h_input_tokens != null) output.usage.cacheWrite1h = usage.cache_creation.ephemeral_1h_input_tokens;
		const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
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
			this.lastRateLimitWarnStep = null;
			this.lastRateLimitWarnThreshold = undefined;
		} else if (info.status === "allowed_warning") {
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
	private dropAbandonedStreamBlocks(why: string): void {
		const dropped = this.blocks.splice(this.turnStreamBlockStart);
		this.logger.debug(`dropAbandonedStreamBlocks: ${why}; dropped ${dropped.length} blocks from ${this.turnStreamMessageId}`);
		this.turnSawToolCall = this.blocks.some(b => b.type === "toolCall");
		this.turnStreamOpen = false;
	}
	private processStreamEvent(message: SDKMessage): void {
		this.turnSawStreamEvent = true;
		const event = (message as SDKMessage & { event: any }).event;

		if (event?.type === "message_start") {
			if (this.turnStreamOpen) this.dropAbandonedStreamBlocks(`restreamed as ${event.message?.id}`);
			this.turnStreamMessageId = event.message?.id;
			this.turnStreamOpen = true;
			this.turnStreamBlockStart = this.blocks.length;
			if (event.message?.usage) this.updateUsage(this.output, event.message.usage);
			return;
		}

		if (event?.type === "content_block_start") {
			this.ensureTurnStarted();
			if (event.content_block?.type === "text") {
				this.blocks.push({ type: "text", text: "", index: event.index });
				this.stream.push({ type: "text_start", contentIndex: this.blocks.length - 1, partial: this.output });
			} else if (event.content_block?.type === "thinking") {
				this.blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
				this.stream.push({ type: "thinking_start", contentIndex: this.blocks.length - 1, partial: this.output });
			} else if (event.content_block?.type === "tool_use") {
				const piName = piToolNameFor(event.content_block.name, this.toolNameMap);
				this.turnSawToolCall = true;
				this.blocks.push({
					type: "toolCall", id: event.content_block.id,
					name: piName,
					arguments: (event.content_block.input as Record<string, unknown>) ?? {},
					partialJson: "", index: event.index,
				});
				this.stream.push({ type: "toolcall_start", contentIndex: this.blocks.length - 1, partial: this.output });
			} else {
				this.logger.debug(`processStreamEvent: unhandled content_block_start type ${event.content_block?.type}`);
			}
			return;
		}

		if (event?.type === "content_block_delta") {
			const index = this.blocks.findIndex((b: any) => b.index === event.index);
			const block = this.blocks[index];
			if (!block) return;
			if (event.delta?.type === "text_delta" && block.type === "text") {
				block.text += event.delta.text;
				this.stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: this.output });
			} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
				block.thinking += event.delta.thinking;
				this.stream.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: this.output });
			} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
				block.partialJson += event.delta.partial_json;
				block.arguments = parsePartialJson(block.partialJson, block.arguments);
				this.stream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: this.output });
			} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
				block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
			} else {
				this.logger.debug(`processStreamEvent: unhandled content_block_delta type ${event.delta?.type}`);
			}
			return;
		}

		if (event?.type === "content_block_stop") {
			const index = this.blocks.findIndex((b: any) => b.index === event.index);
			const block = this.blocks[index];
			if (!block) return;
			delete block.index;
			if (block.type === "text") {
				this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.output });
			} else if (block.type === "thinking") {
				this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.output });
			} else if (block.type === "toolCall") {
				this.turnSawToolCall = true;
				block.arguments = parsePartialJson(block.partialJson, block.arguments);
				delete block.partialJson;
				this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.output });
			}
			return;
		}

		if (event?.type === "message_delta") {
			this.output.stopReason = mapStopReason(event.delta?.stop_reason);
			if (event.usage) this.updateUsage(this.output, event.usage);
			return;
		}

		if (event?.type === "message_stop") this.turnStreamOpen = false;

		if (event?.type === "message_stop" && this.turnSawToolCall) {
			this.endTurn("toolUse");
			return;
		}

		if (event?.type !== "message_stop" && event?.type !== "ping") {
			this.logger.debug(`processStreamEvent: unhandled event type ${event?.type}`);
		}
	}
	private processAssistantMessage(message: SDKMessage): void {
		const assistantMsg = (message as any).message;
		if (!assistantMsg?.content) return;
		if (this.turnSawStreamEvent) {
			const id = assistantMsg.id;
			if (!id || !this.turnStreamMessageId || id === this.turnStreamMessageId) return;
			if (this.turnStreamOpen) this.dropAbandonedStreamBlocks(`non-streaming fallback ${id}`);
		}
		this.logger.debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
		for (const block of assistantMsg.content) {
			if (block.type === "text" && block.text) {
				this.ensureTurnStarted();
				this.blocks.push({ type: "text", text: block.text });
				const idx = this.blocks.length - 1;
				this.stream.push({ type: "text_start", contentIndex: idx, partial: this.output });
				this.stream.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: this.output });
				this.stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: this.output });
			} else if (block.type === "thinking") {
				this.ensureTurnStarted();
				this.blocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
				const idx = this.blocks.length - 1;
				this.stream.push({ type: "thinking_start", contentIndex: idx, partial: this.output });
				if (block.thinking) this.stream.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: this.output });
				this.stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: this.output });
			} else if (block.type === "tool_use") {
				const piName = piToolNameFor(block.name, this.toolNameMap);
				this.ensureTurnStarted();
				this.turnSawToolCall = true;
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
			}
		}
		if (assistantMsg.usage) this.updateUsage(this.output, assistantMsg.usage);

		if (this.turnSawToolCall) this.endTurn("toolUse");
	}
}
