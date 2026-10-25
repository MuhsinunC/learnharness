import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { CONTINUE_TEXT, MCP_TOOL_PREFIX, PROVIDER_ID, convertPiMessages, isDroppedAssistant, mapPiToolNameToSdk, messageContentToText, sanitizeToolId, toolResultContent } from "../src/agent/claude-code/convert.ts";
import { CONTINUE_TEXT as OPTIONS_CONTINUE_TEXT, MCP_TOOL_PREFIX as OPTIONS_MCP_TOOL_PREFIX } from "../src/agent/claude-code/query-options.ts";
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
	assert.equal(sanitizeToolId("a:b.c", cache), `a_b_c_${createHash("sha256").update("a:b.c").digest("hex").slice(0, 8)}`);
	assert.equal(sanitizeToolId("a:b.c", cache), `a_b_c_${createHash("sha256").update("a:b.c").digest("hex").slice(0, 8)}`);
	assert.equal(cache.size, 1);
	const converted = convert([assistant([call("a:b"), call("c", "foo")]), result("a:b")]);
	assert.deepEqual(converted.anthropicMessages[0]!.content, [
		{ type: "tool_use", id: sanitizeToolId("a:b", new Map()), name: "mcp__custom-tools__quiz", input: {} },
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
	assert.equal(converted.anthropicMessages.length, 2);
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
	const history: Message[] = [user("start")];
	const additions: Message[][] = [
		[assistant([call("server")]), result("server"), assistant([])],
		[assistant([call("X"), call("Y")]), result("X"), user([text("steer")]), result("Y")],
		[assistant([text("done")]), user("next"), user([text("with image"), image]), { ...assistant([text("partial")]), stopReason: "aborted" }],
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
		const replay = convert(next.prior).anthropicMessages.slice(0, prefix.length);
		assert.deepEqual(replay, prefix);
		assert.equal(JSON.stringify(replay), JSON.stringify(prefix));
	}
});


test("sanitized ids avoid collisions and preserve call/result pairing deterministically", () => {
	const ids = ["a:b", "a_b", "valid-short_ID"];
	const history = [assistant(ids.map(id => call(id))), ...ids.map(id => result(id))];
	const first = convert(history);
	const second = convert(history);
	assert.deepEqual(first.sanitizedIds, second.sanitizedIds);
	assert.equal(new Set(first.sanitizedIds.values()).size, ids.length);
	assert.equal(first.sanitizedIds.get("valid-short_ID"), "valid-short_ID");
	const uses = first.anthropicMessages[0]!.content;
	const results = first.anthropicMessages[1]!.content;
	assert.ok(Array.isArray(uses) && Array.isArray(results));
	assert.deepEqual(uses.map(b => b.type === "tool_use" && b.id), results.map(b => b.type === "tool_result" && b.tool_use_id));
	assert.equal(JSON.stringify(first.anthropicMessages), JSON.stringify(second.anthropicMessages));
	const cachedEmpty = new Map([["cached", ""]]);
	assert.equal(sanitizeToolId("cached", cachedEmpty), "");
});

test("sanitized ids obey the 64-character bound and extend occupied hash suffixes", () => {
	const ids = ["a|".repeat(225), "x".repeat(100) + "first", "x".repeat(100) + "second"];
	const converted = convert([assistant(ids.map(id => call(id))), ...ids.map(id => result(id))]);
	assert.equal(new Set(converted.sanitizedIds.values()).size, 3);
	for (const clean of converted.sanitizedIds.values()) {
		assert.ok(clean.length <= 64);
		assert.match(clean, /^[a-zA-Z0-9_-]+$/);
	}
	const original = "a:b";
	const digest = createHash("sha256").update(original).digest("hex");
	const occupied = `a_b_${digest.slice(0, 8)}`;
	assert.equal(sanitizeToolId(original, new Map([["other", occupied]])), `a_b_${digest.slice(0, 9)}`);
	const cache = new Map<string, string>();
	assert.equal(sanitizeToolId(original, cache), occupied);
	assert.notEqual(sanitizeToolId(occupied, cache), occupied);
	assert.equal(new Set(cache.values()).size, 2);
});

test("error result images follow all parallel results with original-id captions", () => {
	const error = { ...result("X:original", [text("failed"), image, image, text("again"), image]), isError: true };
	const a = assistant([call("X:original"), call("Y")]);
	const converted = convert([a, error, user("steer"), result("Y")]);
	const expectedError = {
		type: "tool_result", tool_use_id: converted.sanitizedIds.get("X:original"),
		content: "failed\n(image attached after the tool results)\nagain\n(image attached after the tool results)", is_error: true,
	};
	const attachments = [text("Images from the error result of tool call X:original (quiz):"), wireImage, wireImage, wireImage];
	assert.deepEqual(convert([a, error]).anthropicMessages[1]!.content, [expectedError, ...attachments]);
	assert.deepEqual(converted.anthropicMessages[1]!.content, [
		expectedError, { type: "tool_result", tool_use_id: "Y", content: "Y", is_error: false }, ...attachments,
	]);
	assert.deepEqual(converted.anthropicMessages[2], { role: "user", content: [text("steer")] });
});

test("partial aborted/error assistants are dropped without splitting parallel results", () => {
	const a = assistant([call("X"), call("Y")]);
	for (const stopReason of ["aborted", "error"] as const) {
		const dropped = { ...assistant([text("partial"), { type: "thinking" as const, thinking: "partial", thinkingSignature: "sig" }, call("orphan")]), stopReason };
		assert.equal(isDroppedAssistant(dropped), true);
		const converted = convert([a, result("X"), dropped, result("orphan"), result("Y")]);
		assert.deepEqual(converted.anthropicMessages, convert([a, result("X"), result("Y")]).anthropicMessages);
		assert.equal(converted.dropped.abortedTurns, 1);
		assert.equal(converted.dropped.other.get("droppedAssistantToolResult"), 1);
	}
	const base = [assistant([call("X")]), result("X")];
	const converted = convert([...base, assistant([]), assistant([]), assistant([text("done")])]);
	assert.deepEqual(converted.anthropicMessages, [...convert(base).anthropicMessages, continueRecord, { role: "assistant", content: [text("done")] }]);
	assert.equal(converted.dropped.abortedTurns, 2);
	assert.equal(isDroppedAssistant(assistant(null as unknown as [])), true);
	// The latest owner shadows an earlier kept call with the same id.
	assert.equal(convert([assistant([call("X")]), { ...assistant([call("X")]), stopReason: "aborted" }, result("X")]).dropped.other.get("droppedAssistantToolResult"), 1);
});

test("splitPrompt trims dropped tails for result continuations and user retries", () => {
	const prior = [assistant([call("X")]), result("X")];
	const tails = [assistant([]), { ...assistant([text("partial")]), stopReason: "aborted" as const }, { ...assistant([text("failed")]), stopReason: "error" as const }];
	assert.deepEqual(splitPrompt([...prior, ...tails]), { kind: "continue", prior });
	assert.deepEqual(splitPrompt([user("retry"), ...tails]), { kind: "user", prior: [], blocks: [text("retry")] });
	assert.deepEqual(splitPrompt(tails), { kind: "invalid", reason: "claude-code: nothing to send" });
	// Retrying an aborted user prompt sends the exact record a later reply replays.
	const before = [user("retry"), ...tails];
	const split = splitPrompt(before);
	assert.equal(split.kind, "user");
	if (split.kind !== "user") throw new Error("expected user retry");
	const expected = [...convert(split.prior).anthropicMessages, { role: "user", content: split.blocks }];
	const replay = convert([...before, assistant([text("done")])]).anthropicMessages.slice(0, expected.length);
	assert.deepEqual(replay, expected);
	assert.equal(JSON.stringify(replay), JSON.stringify(expected));
});

test("user runs replay as block arrays without absorbing results or CONTINUE records", () => {
	assert.deepEqual(convert([user("hello")]).anthropicMessages, [{ role: "user", content: [text("hello")] }]);
	assert.deepEqual(convert([user(""), user([text(""), { ...image, data: "" }])]).anthropicMessages, [{ role: "user", content: [text("[empty]")] }]);
	assert.deepEqual(convert([user([])]).anthropicMessages, [{ role: "user", content: [text("[image]")] }]);
	const users = [user("one"), user([text(""), text("two"), image])];
	assert.deepEqual(convert(users).anthropicMessages, [{ role: "user", content: [text("one"), text("two"), wireImage] }]);
	const a = assistant([call("X"), call("Y")]);
	assert.deepEqual(convert([a, result("X"), ...users, result("Y"), assistant([text("done")])]).anthropicMessages.slice(2), [
		{ role: "user", content: [text("one"), text("two"), wireImage] }, continueRecord, { role: "assistant", content: [text("done")] },
	]);
});


test("interleaved results attach to their own assistant despite output index shifts", () => {
	const wireResult = (id: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: id, is_error: false }] });
	const x = assistant([call("X")]);
	const y = assistant([call("Y")]);
	const z = assistant([call("Z")]);
	assert.deepEqual(convert([x, y, result("X"), result("Y")]).anthropicMessages, [
		convert([x]).anthropicMessages[0], wireResult("X"), convert([y]).anthropicMessages[0], wireResult("Y"),
	]);
	const history = [x, y, z, result("Y"), result("X"), result("Z")];
	const expected = ["X", "Y", "Z"].flatMap(id => [convert([assistant([call(id)])]).anthropicMessages[0], wireResult(id)]);
	const before = convert(history).anthropicMessages;
	assert.deepEqual(before, expected);
	const replay = convert([...history, assistant([text("done")]), user("next")]).anthropicMessages.slice(0, before.length);
	assert.deepEqual(replay, before);
	assert.equal(JSON.stringify(replay), JSON.stringify(before));
});

test("parallel results and error attachments remain with an earlier owning assistant", () => {
	const x = assistant([call("X"), call("X2")]);
	const y = assistant([call("Y")]);
	const error = { ...result("X", [image]), isError: true };
	const history = [x, y, error, user("steer"), result("Y"), result("X2")];
	const output = convert(history).anthropicMessages;
	assert.deepEqual(output.slice(0, 2), convert([x, error, result("X2")]).anthropicMessages);
	assert.deepEqual(output.slice(2, 4), convert([y, result("Y")]).anthropicMessages);
	assert.deepEqual(output[4], { role: "user", content: [text("steer")] });
	// Unknown ids retain the preceding kept turn's orphan pairing behavior.
	assert.deepEqual(convert([x, result("unknown")]).anthropicMessages[1]!.content,
		[{ type: "tool_result", tool_use_id: "unknown", content: "unknown", is_error: false }]);
});

test("a dropped owner shadows earlier calls of the same id only from its own position", () => {
	const kept = assistant([call("X")]);
	for (const stopReason of ["aborted", "error"] as const) {
		const history = [kept, result("X"), { ...assistant([call("X")]), stopReason }, result("X", [text("discarded")])];
		const converted = convert(history);
		assert.deepEqual(converted.anthropicMessages, convert([kept, result("X")]).anthropicMessages);
		assert.equal(converted.dropped.other.get("droppedAssistantToolResult"), 1);
		const restored = convert([...history, kept, result("X", [text("restored")])]);
		assert.equal(restored.dropped.other.get("droppedAssistantToolResult"), 1);
		assert.deepEqual(restored.anthropicMessages.at(-1)!.content, [{ type: "tool_result", tool_use_id: "X", content: "restored", is_error: false }]);
	}
});

test("unknown tool result blocks retain markers and report each lost block", () => {
	const audio = { type: "audio" };
	assert.equal(toolResultContent([audio]), "[audio]");
	assert.equal(toolResultContent([audio, { type: "video" }]), "[audio]\n[video]");
	assert.equal(toolResultContent([text("heard"), audio]), "heard\n[audio]");
	assert.equal(messageContentToText([audio]), "");
	for (const [blocks, expected] of [
		[[audio], "[audio]"], [[text("heard"), audio], "heard\n[audio]"],
	] as const) {
		const converted = convert([assistant([call("A")]), result("A", blocks as unknown as ToolResultMessage["content"])]);
		assert.deepEqual(converted.anthropicMessages[1]!.content, [{ type: "tool_result", tool_use_id: "A", content: expected, is_error: false }]);
		assert.equal(converted.dropped.other.get("toolResult:audio"), 1);
	}
	const converted = convert([assistant([call("A")]), result("A", [audio, image, audio] as unknown as ToolResultMessage["content"])]);
	assert.equal(converted.dropped.other.get("toolResult:audio"), 2);
	assert.deepEqual(converted.anthropicMessages[1]!.content, [{ type: "tool_result", tool_use_id: "A", content: [text("[audio]"), wireImage, text("[audio]")], is_error: false }]);
});

test("conversion re-exports shared query option constants", () => {
	assert.equal(CONTINUE_TEXT, OPTIONS_CONTINUE_TEXT);
	assert.equal(MCP_TOOL_PREFIX, OPTIONS_MCP_TOOL_PREFIX);
	assert.equal(mapPiToolNameToSdk("shared", new Map()), `${OPTIONS_MCP_TOOL_PREFIX}shared`);
	assert.deepEqual(convert([assistant([call("A")]), result("A"), assistant([text("done")])]).anthropicMessages[2],
		{ role: "user", content: [text(OPTIONS_CONTINUE_TEXT)] });
});

test("sanitization updates and reuses a supplied occupied-id set", () => {
	const cache = new Map<string, string>();
	const occupied = new Set<string>();
	const hashed = sanitizeToolId("a:b", cache, occupied);
	assert.deepEqual(occupied, new Set([hashed]));
	assert.equal(sanitizeToolId("a:b", cache, occupied), hashed);
	const collision = sanitizeToolId(hashed, cache, occupied);
	assert.notEqual(collision, hashed);
	assert.equal(sanitizeToolId("short", cache, occupied), "short");
	assert.deepEqual(occupied, new Set([hashed, collision, "short"]));
	assert.deepEqual(occupied, new Set(cache.values()));
});
