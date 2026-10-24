import { createHash } from "node:crypto";
import type { Message as PiMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage, ToolResultBlock } from "cc-session-io";

export const PROVIDER_ID = "claude-code";
// query-options.ts (lh-2c) exports the same values; deduplicate at integration.
export const MCP_TOOL_PREFIX = "mcp__custom-tools__";
export const CONTINUE_TEXT = "[Continue from the tool result above.]";

type RedactedThinkingBlock = { type: "redacted_thinking"; data: string };
export type AnthropicMessage = Omit<SessionMessage, "content"> & {
	content: string | (ContentBlock | RedactedThinkingBlock)[];
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	if (cache.has(id)) return cache.get(id)!;
	const used = new Set(cache.values());
	let clean = id;
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || used.has(id)) {
		const base = id.replace(/[^a-zA-Z0-9_-]/g, "_");
		const hash = createHash("sha256").update(id).digest("hex");
		let length = 8;
		do {
			if (length > 63) throw new Error("sanitizeToolId: exhausted SHA-256 collision suffixes");
			clean = `${base.slice(0, 64 - length - 1)}_${hash.slice(0, length++)}`;
		} while (used.has(clean));
	}
	cache.set(id, clean);
	return clean;
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	// Pi history holds pi tool names. Our own SDK prefix can only reach here by
	// feeding already-converted names back through the conversion, and prefixing
	// twice invents a tool nobody serves.
	if (normalized.startsWith(MCP_TOOL_PREFIX)) {
		throw new Error(`mapPiToolNameToSdk: "${name}" is already an SDK tool name — pi history holds pi tool names`);
	}
	return customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized) ?? `${MCP_TOOL_PREFIX}${name}`;
}

export function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

// Tool results are flattened to text, which is how Claude Code stores most of
// them. Images are the exception: they have no text form, so a result carrying
// one keeps the block array shape instead (also what CC writes for screenshots).
export function toolResultContent(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string | ContentBlock[] {
	if (typeof content === "string" || !Array.isArray(content)) return messageContentToText(content) || "";
	const images = content.filter((b) => b.type === "image" && b.data && b.mimeType);
	if (!images.length) return messageContentToText(content) || "";
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
		else if (block.type === "image" && block.data && block.mimeType) {
			blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
		} else if (block.type !== "text" && block.type !== "image") {
			// Same marker messageContentToText leaves for unrecognized blocks, so the
			// text and image paths describe an extension's output the same way.
			blocks.push({ type: "text", text: `[${block.type}]` });
		}
	}
	return blocks;
}

/** Content discarded during conversion. */
export type DroppedContent = {
	thinking: number;
	abortedTurns: number;
	providers: Set<string>;
	other: Map<string, number>;
};

// Match pi-ai: partial aborted/error replies are not safe to replay, even with text.
export function isDroppedAssistant(msg: PiMessage): boolean {
	return msg.role === "assistant" && (!Array.isArray(msg.content) || !msg.content.length
		|| msg.stopReason === "aborted" || msg.stopReason === "error");
}

/** Convert pi message array to Anthropic API format. */
export function convertPiMessages(
	messages: PiMessage[],
	customToolNameToSdk: Map<string, string>,
): { anthropicMessages: AnthropicMessage[]; sanitizedIds: Map<string, string>; dropped: DroppedContent } {
	const anthropicMessages: AnthropicMessage[] = [];
	const sanitizedIds = new Map<string, string>();
	// What conversion discarded. Nothing downstream can tell: a stripped thinking
	// block and a message that never carried one convert to the same thing, so
	// without this the loss is invisible in the log and in a captured request.
	const dropped: DroppedContent = { thinking: 0, abortedTurns: 0, providers: new Set(), other: new Map() };
	// The user message collecting this assistant turn's tool results, if one has
	// been emitted yet, and the index of the assistant message it belongs to. Both
	// are cleared at every kept assistant message — see the toolResult branch.
	let turnResults: { role: "user"; content: ContentBlock[] } | null = null;
	let turnAssistantIdx: number | null = null;

	const droppedToolIds = new Set<string>();
	const keptToolIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const ids = isDroppedAssistant(msg) ? droppedToolIds : keptToolIds;
		for (const block of msg.content) if (block.type === "toolCall") ids.add(block.id);
	}

	for (let index = 0; index < messages.length; index++) {
		const msg = messages[index]!;
		if (msg.role === "user") {
			const parts: ContentBlock[] = [];
			const placeholder = typeof msg.content === "string" ? "[empty]" : "[image]";
			// Replay each input user run as the single prompt record splitPrompt sends.
			let next: PiMessage | undefined = msg;
			while (next?.role === "user") {
				const content = typeof next.content === "string" ? [{ type: "text" as const, text: next.content }] : next.content;
				if (Array.isArray(content)) for (const block of content) {
					if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
					else if (block.type === "image" && block.data && block.mimeType) {
						parts.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
					}
				}
				next = messages[index + 1];
				if (next?.role === "user") index++;
			}
			anthropicMessages.push({ role: "user", content: parts.length ? parts : [{ type: "text", text: placeholder }] });
		} else if (msg.role === "assistant") {
			// Do NOT clear turnResults/turnAssistantIdx: parallel results survive an abort.
			if (isDroppedAssistant(msg)) { dropped.abortedTurns++; continue; }
			let previous = index - 1;
			while (previous >= 0 && isDroppedAssistant(messages[previous]!)) previous--;
			// Reinsert the actual prompt after hoisted results AND any intervening steer.
			// A trailing steer was itself the prompt, so it needs no CONTINUE record.
			if (msg.provider === PROVIDER_ID && messages[previous]?.role === "toolResult") {
				anthropicMessages.push({ role: "user", content: [{ type: "text", text: CONTINUE_TEXT }] });
			}
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks: (ContentBlock | RedactedThinkingBlock)[] = [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					// Only replay thinking Claude Code itself produced. A signature minted
					// by any other provider — including pi's own Anthropic provider — is
					// not ours to hand back, and Anthropic rejects ones it can't verify.
					const sig = block.thinkingSignature;
					if (msg.provider === PROVIDER_ID && sig) {
						if (block.redacted === true) blocks.push({ type: "redacted_thinking", data: sig });
						else blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					} else {
						dropped.thinking++;
						dropped.providers.add(msg.provider ?? "unknown");
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: toolName, input: block.arguments ?? {} });
				} else {
					dropped.other.set(block.type, (dropped.other.get(block.type) ?? 0) + 1);
				}
			}
			// Blocks were present but every one was filtered — content really was
			// dropped here, so keep the slot and say so. Empty content is rejected by
			// the API, and dropping the message would break tool pairing.
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			turnResults = null;
			turnAssistantIdx = anthropicMessages.length;
			anthropicMessages.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			// Hoist parallel results into one user message directly after their assistant.
			// Pairing consumes pending ids at the first user message, so even a steer
			// before the first result must move after the merged results.
			if (droppedToolIds.has(msg.toolCallId) && !keptToolIds.has(msg.toolCallId)) {
				dropped.other.set("droppedAssistantToolResult", (dropped.other.get("droppedAssistantToolResult") ?? 0) + 1);
				continue;
			}
			const images: ContentBlock[] = [];
			const resultContent: ToolResultMessage["content"] = [];
			let previousWasImage = false;
			for (const part of msg.content) {
				if (msg.isError && part.type === "image" && part.data && part.mimeType) {
					if (!previousWasImage) resultContent.push({ type: "text", text: "(image attached after the tool results)" });
					previousWasImage = true;
					images.push({ type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } });
				} else {
					previousWasImage = false;
					resultContent.push(part);
				}
			}
			const block: ToolResultBlock = { type: "tool_result", tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds), content: toolResultContent(resultContent), is_error: msg.isError };
			if (!turnResults) {
				turnResults = { role: "user", content: [] };
				// Without a preceding assistant, preserve order for pairing repair.
				anthropicMessages.splice(turnAssistantIdx === null ? anthropicMessages.length : turnAssistantIdx + 1, 0, turnResults);
			}
			const firstAttachment = turnResults.content.findIndex((part) => part.type !== "tool_result");
			turnResults.content.splice(firstAttachment < 0 ? turnResults.content.length : firstAttachment, 0, block);
			if (images.length) {
				turnResults.content.push({ type: "text", text: `Images from the error result of tool call ${msg.toolCallId} (${msg.toolName}):` }, ...images);
			}
		}
	}

	return { anthropicMessages, sanitizedIds, dropped };
}
