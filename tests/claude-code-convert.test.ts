import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { CONTINUE_TEXT, MCP_TOOL_PREFIX, PROVIDER_ID, convertPiMessages, mapPiToolNameToSdk, messageContentToText, sanitizeToolId, toolResultContent } from "../src/agent/claude-code/convert.ts";
import { foldTranscript, splitPrompt, turnStart } from "../src/agent/claude-code/history.ts";

const text = (text: string) => ({ type: "text" as const, text });
const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
const wireImage = { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
const call = (id: string, name = "quiz"): ToolCall => ({ type: "toolCall", id, name, arguments: {} });
const assistant = (content: AssistantMessage["content"], provider = PROVIDER_ID): AssistantMessage => ({
	role: "assistant", content, provider, api: "anthropic-messages", model: "test", stopReason: "stop", timestamp: 1,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const result = (id: string, content: ToolResultMessage["content"] = [text(id)]): ToolResultMessage => ({
	role: "toolResult", toolCallId: id, toolName: "quiz", content, isError: false, timestamp: 1,
});
const names = new Map([["quiz", "mcp__custom-tools__quiz"]]);
const convert = (messages: Message[]) => convertPiMessages(messages, names);
const continueRecord = { role: "user", content: [text(CONTINUE_TEXT)] };

test("constants, tool names and sanitized ids follow the provider contract", () => {
	assert.equal(PROVIDER_ID, "claude-code");
	assert.equal(MCP_TOOL_PREFIX, "mcp__custom-tools__");
	assert.equal(CONTINUE_TEXT, "[Continue from the tool result above.]");
	assert.equal(mapPiToolNameToSdk("quiz", names), "mcp__custom-tools__quiz");
	assert.equal(mapPiToolNameToSdk("foo", names), "mcp__custom-tools__foo");
	assert.throws(() => mapPiToolNameToSdk("MCP__CUSTOM-TOOLS__quiz", names), /already an SDK tool name/);
	const cache = new Map<string, string>();
	assert.equal(sanitizeToolId("a:b.c", cache), "a_b_c");
	assert.equal(sanitizeToolId("a:b.c", cache), "a_b_c");
	assert.deepEqual(cache, new Map([["a:b.c", "a_b_c"]]));
	const converted = convert([assistant([call("a:b"), call("c", "foo")]), result("a:b")]);
	assert.deepEqual(converted.anthropicMessages[0]!.content, [
		{ type: "tool_use", id: "a_b", name: "mcp__custom-tools__quiz", input: {} },
		{ type: "tool_use", id: "c", name: "mcp__custom-tools__foo", input: {} },
	]);
});

test("thinking and redacted payloads require a local provider signature", () => {
	const thinking = { type: "thinking" as const, thinking: "reason", thinkingSignature: "sig" };
	const redacted = { ...thinking, thinking: "", redacted: true };
	const converted = convert([
		assistant([thinking, redacted, { ...thinking, thinkingSignature: "" }, { ...redacted, thinkingSignature: "" }]),
		assistant([thinking, redacted], "openrouter"),
	]);
	assert.deepEqual(converted.anthropicMessages.map(m => m.content), [
		[{ type: "thinking", thinking: "reason", signature: "sig" }, { type: "redacted_thinking", data: "sig" }],
		[text("[incompatible content omitted]")],
	]);
	assert.equal(converted.dropped.thinking, 4);
	assert.deepEqual(converted.dropped.providers, new Set(["claude-code", "openrouter"]));
});

test("parallel results hoist around steers and survive an empty aborted assistant", () => {
	const a = assistant([call("X"), call("Y")]);
	for (const history of [[a, result("X"), user([text("steer")]), result("Y")], [a, user([text("steer")]), result("X"), result("Y")]]) {
		const messages = convert(history).anthropicMessages;
		assert.equal(messages.length, 3);
		assert.equal(messages[0]!.role, "assistant");
		assert.deepEqual(messages[1]!.content, ["X", "Y"].map(id => ({ type: "tool_result", tool_use_id: id, content: id, is_error: false })));
		assert.deepEqual(messages[2], { role: "user", content: [text("steer")] });
	}
	const converted = convert([a, result("X"), assistant([]), result("Y")]);
	assert.equal(converted.dropped.abortedTurns, 1);
	assert.equal(converted.anthropicMessages.length, 3);
	assert.deepEqual(converted.anthropicMessages[2], continueRecord);
	assert.equal((converted.anthropicMessages[1]!.content as unknown[]).length, 2);
});

test("images survive user and tool result conversion; text-only results flatten", () => {
	assert.deepEqual(convert([user([text("look"), image])]).anthropicMessages, [{ role: "user", content: [text("look"), wireImage] }]);
	assert.deepEqual(toolResultContent([text("look"), image]), [text("look"), wireImage]);
	assert.equal(toolResultContent([text("one"), text("two")]), "one\ntwo");
	assert.equal(messageContentToText([{ type: "other" }, text("ok")]), "[other]\nok");
	const content = convert([assistant([call("X")]), result("X", [image])]).anthropicMessages[1]!.content;
	assert.deepEqual(content, [{ type: "tool_result", tool_use_id: "X", content: [wireImage], is_error: false }]);
});

test("CONTINUE re-insertion follows input position and provider, after intervening steers", () => {
	const a = assistant([call("X"), call("Y")]);
	const base = [a, result("X"), user([text("steer")]), result("Y")];
	assert.deepEqual(convert([...base, assistant([text("done")])]).anthropicMessages.slice(-3), [
		{ role: "user", content: [text("steer")] }, continueRecord, { role: "assistant", content: [text("done")] },
	]);
	for (const history of [[...base, assistant([text("done")], "openrouter")], [a, result("X"), result("Y"), user([text("steer")]), assistant([text("done")])]]) {
		assert.ok(!convert(history).anthropicMessages.some(m => JSON.stringify(m) === JSON.stringify(continueRecord)));
	}
});

test("conversion is byte deterministic for a rich history and ignores system messages", () => {
	const history: Message[] = [
		{ role: "system", content: "system", timestamp: 1 }, user([text("start"), image]),
		assistant([{ type: "thinking", thinking: "reason", thinkingSignature: "sig" }, { type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" }, call("X"), call("Y")]),
		result("X", [text("look"), image]), user([text("steer")]), result("Y"), assistant([text("done")]),
	];
	assert.equal(JSON.stringify(convert(history)), JSON.stringify(convert(history)));
	assert.deepEqual(convert(history).anthropicMessages, convert(history.slice(1)).anthropicMessages);
});

test("LearnHarness quiz answer and flattened handoff split into continue and user", () => {
	const record: LhMessage[] = [
		{ ...user([text("start")]), id: "u" }, { ...assistant([call("quiz")]), id: "a" }, { ...result("quiz", [text("answer")]), id: "r" },
		{ id: "h", role: "custom", customType: "probe-handoff", content: "handoff", display: true, details: {}, timestamp: 1 },
	];
	assert.equal(splitPrompt(toLlmMessages(record.slice(0, 3))).kind, "continue");
	const split = splitPrompt(toLlmMessages(record));
	assert.equal(split.kind, "user");
	if (split.kind === "user") assert.deepEqual(split.blocks, [text("handoff")]);
});

test("splitPrompt handles trailing runs, empty blocks, malformed content and invalid endings", () => {
	const history = [assistant([call("X")]), result("X")];
	assert.deepEqual(splitPrompt(history), { kind: "continue", prior: history });
	const continued = splitPrompt(history);
	if (continued.kind === "continue") assert.equal(continued.prior, history);
	const run = [...history, user("steer"), user([text("more"), image])];
	assert.equal(turnStart(run), 2);
	assert.deepEqual(splitPrompt(run), { kind: "user", prior: history, blocks: [text("steer"), text("more"), wireImage] });
	for (const invalid of [[], [assistant([text("done")])], [user([text(""), { ...image, data: "" }])], [user("")]]) {
		assert.deepEqual(splitPrompt(invalid), { kind: "invalid", reason: "claude-code: nothing to send" });
	}
	assert.throws(() => splitPrompt([user(null as unknown as string)]), /extractUserPromptBlocks: user message content must be a string or block array, got object/);
});

test("foldTranscript replays system state and removes system messages from history", () => {
	const tools = [{ name: "quiz", description: "Ask", parameters: { type: "object" as const, properties: {} } }];
	const transcript = normalizeContext({ systemPrompt: "system", tools, messages: [user("hello")] });
	const folded = foldTranscript(transcript);
	assert.equal(folded.systemPrompt, "system");
	assert.deepEqual(folded.tools.map(t => t.name), ["quiz"]);
	assert.deepEqual(folded.history, [user("hello")]);
});

test("each subsequent call preserves converted prior plus the previous prompt record", () => {
	const history: Message[] = [user([text("start")])];
	const additions: Message[][] = [
		[assistant([call("server")]), result("server")],
		[assistant([call("X"), call("Y")]), result("X"), user([text("steer")]), result("Y")],
		[assistant([text("done")]), user([text("next"), image])],
		[assistant([call("Z")]), result("Z")],
	];
	for (const addition of additions) {
		const split = splitPrompt(history);
		assert.notEqual(split.kind, "invalid");
		if (split.kind === "invalid") throw new Error(split.reason);
		const prefix = [...convert(split.prior).anthropicMessages, split.kind === "user" ? { role: "user", content: split.blocks } : continueRecord];
		history.push(...addition);
		const next = splitPrompt(history);
		assert.notEqual(next.kind, "invalid");
		if (next.kind === "invalid") throw new Error(next.reason);
		assert.deepEqual(convert(next.prior).anthropicMessages.slice(0, prefix.length), prefix);
	}
});
