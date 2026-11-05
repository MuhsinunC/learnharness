import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { Message, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import type { ImageBlock, TextBlock } from "cc-session-io";
import { isDroppedAssistant, userPromptBlocks } from "./convert.ts";

export type PromptBlock = TextBlock | ImageBlock;
export type SplitPromptResult =
	| { kind: "user"; prior: Message[]; blocks: PromptBlock[] }
	| { kind: "continue"; prior: Message[] }
	| { kind: "invalid"; reason: string };

export function foldTranscript(t: TranscriptContext): { systemPrompt: string; tools: Tool[]; history: Message[] } {
	return {
		systemPrompt: getCurrentSystemPrompt(t.messages),
		tools: getCurrentTools(t.messages),
		history: t.messages.filter((m) => m.role !== "system"),
	};
}

export function turnStart(messages: Message[]): number {
	let i = messages.length;
	while (i > 0 && messages[i - 1]!.role === "user") i--;
	return i;
}

export function splitPrompt(history: Message[]): SplitPromptResult {
	// Prior is sliced from the trimmed history; conversion drops these tails too.
	let end = history.length;
	while (end > 0 && isDroppedAssistant(history[end - 1]!)) end--;
	if (end !== history.length) history = history.slice(0, end);
	const start = turnStart(history);
	const blocks: PromptBlock[] = [];
	for (const message of history.slice(start)) {
		if (message.role !== "user") continue;
		const userBlocks = userPromptBlocks(message.content);
		if (!userBlocks) {
			throw new Error(
				`splitPrompt: user message content must be a string or block array, got ${typeof message.content} — likely a malformed message from another extension`,
			);
		}
		blocks.push(...userBlocks);
	}
	if (blocks.length) return { kind: "user", prior: history.slice(0, start), blocks };
	// The caller sends CONTINUE_TEXT as its prompt; prior retains every result.
	if (history.at(-1)?.role === "toolResult") return { kind: "continue", prior: history };
	return { kind: "invalid", reason: "claude-code: nothing to send" };
}
