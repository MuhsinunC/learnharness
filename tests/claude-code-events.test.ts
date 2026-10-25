import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { EventMapper, OVERAGE_REFUSAL, overageLatched, resetOverageLatchForTests,
 resultErrorText, describeRateLimitFailure, mapStopReason } from "../src/agent/claude-code/events";
import { MCP_TOOL_PREFIX } from "../src/agent/claude-code/query-options.ts";

const model = { id: "test-model", api: "claude-agent-sdk", provider: "claude-code" } as Model<any>;
const names = new Map(["bash", "edit", "read", "write"].map(name => [`${MCP_TOOL_PREFIX}${name}`, name]));
const sdk = (message: unknown) => message as SDKMessage;
const success = sdk({ type: "result", subtype: "success", is_error: false });
const event = (type: string, fields: object = {}) => sdk({ type: "stream_event", event: { type, ...fields } });
const start = (id = "one", usage = {}) => event("message_start", { message: { id, usage } });
const block = (index: number, content_block: object) => event("content_block_start", { index, content_block });
const delta = (index: number, delta: object) => event("content_block_delta", { index, delta });
const stop = (index: number) => event("content_block_stop", { index });
const assistant = (id: string, content: object[], usage = {}) => sdk({ type: "assistant", message: { id, content, usage } });
const rate = (rate_limit_info: object) => sdk({ type: "rate_limit_event", rate_limit_info });
const fixture = (name: string): SDKMessage[] => fs.readFileSync(new URL(`./fixtures/claude-code-sdk-streams/${name}.jsonl`, import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));

function assertValidSequence(events: AssistantMessageEvent[]) {
 assert.equal(events[0]?.type, "start");
 assert.equal(events.filter(e => e.type === "start").length, 1);
 const terminals = events.filter(e => e.type === "done" || e.type === "error");
 assert.equal(terminals.length, 1);
 assert.equal(events.at(-1), terminals[0]);
 const started = new Map<number, string>();
 for (const e of events) {
  if (!("contentIndex" in e)) continue;
  const [kind, phase] = e.type.split("_");
  if (phase === "start") started.set(e.contentIndex, kind!);
  else assert.equal(started.get(e.contentIndex), kind, `${e.type} requires matching start`);
 }
}

const calls: ReturnType<typeof harness>[] = [];
function harness(): { mapper: EventMapper; events: AssistantMessageEvent[]; warns: string[]; debugs: string[]; actions: string[]; stream: ReturnType<typeof createAssistantMessageEventStream>; send(...messages: SDKMessage[]): void } {
 const stream = createAssistantMessageEventStream();
 const events: AssistantMessageEvent[] = [];
 const warns: string[] = [], debugs: string[] = [];
 const actions: string[] = [];
 const push = stream.push.bind(stream), end = stream.end.bind(stream);
 stream.push = e => { events.push(e); actions.push(e.type); push(e); };
 stream.end = () => { actions.push("end"); end(); };
 const mapper = new EventMapper(stream, model, names, { warn: m => warns.push(m), debug: m => debugs.push(m) });
 const h = { mapper, events, warns, debugs, actions, stream, send: (...messages: SDKMessage[]) => messages.forEach(m => mapper.handle(m)) };
 calls.push(h);
 return h;
}
beforeEach(() => { resetOverageLatchForTests(); calls.length = 0; });
afterEach(() => {
 try {
  for (const h of calls) {
   assert.equal(h.mapper.ended, true);
   assertValidSequence(h.events);
   const terminal = h.actions.findIndex(a => a === "done" || a === "error");
   assert.equal(h.actions[terminal + 1], "end");
   assert.equal(h.actions.filter(a => a === "end").length, 1);
  }
 } finally { resetOverageLatchForTests(); }
});

test("text fixture maps thinking signature, text and incremental zero-cost usage", async () => {
 const h = harness();
 const messages = fixture("text");
 h.send(...messages.filter(m => m.type !== "result"));
 assert.equal(h.mapper.ended, false);
 assert.equal(h.mapper.output.usage.input, 10);
 assert.equal(h.mapper.output.usage.output, 47);
 assert.equal(h.mapper.output.usage.cacheRead, 0);
 assert.equal(h.mapper.output.usage.cacheWrite, 10088);
 assert.equal(h.mapper.output.usage.cacheWrite1h, 10088);
 assert.equal(h.mapper.output.usage.totalTokens, 10145);
 assert.deepEqual(h.mapper.output.usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
 const thinking = h.mapper.output.content[0]!;
 assert.equal(thinking.type, "thinking");
 if (thinking.type === "thinking") {
  assert.match(thinking.thinking, /exactly the word/);
  const signature = messages.find(m => m.type === "stream_event" && m.event.type === "content_block_delta" && m.event.delta.type === "signature_delta");
  assert.ok(signature && signature.type === "stream_event" && signature.event.type === "content_block_delta" && signature.event.delta.type === "signature_delta");
  assert.equal(thinking.thinkingSignature, signature.event.delta.signature);
 }
 assert.deepEqual(h.mapper.output.content[1], { type: "text", text: "ALPHA" });
 h.mapper.finish(messages.find(m => m.type === "result")!);
 assert.equal(h.events.at(-1)?.type, "done");
 assert.equal(h.mapper.output.stopReason, "stop");
 assert.ok(h.debugs.some(m => m.startsWith("usage:")));
 const collected = [];
 for await (const e of h.stream) collected.push(e);
 assert.deepEqual(collected, h.events);
 assert.equal(await h.stream.result(), h.mapper.output);
});

for (const name of ["single-tool", "parallel-tools"]) test(`${name} fixture emits all mapped tools and terminates once`, () => {
 const h = harness();
 let callbacks = 0;
 h.mapper.onToolTurnEnded = () => { callbacks++; assert.equal(h.mapper.ended, true); assert.equal(h.actions.at(-1), "end"); };
 h.send(...fixture(name));
 const tools = h.mapper.output.content.filter(b => b.type === "toolCall");
 assert.equal(tools.length, name === "single-tool" ? 1 : 3);
 assert.ok(tools.every(b => ["bash", "read", "edit", "write"].includes(b.name)));
 const expected = fixture(name).filter(m => m.type === "assistant").flatMap(m => m.type === "assistant" ? m.message.content : []).filter(b => b.type === "tool_use");
 for (const tool of tools) {
  const original = expected.find(b => b.type === "tool_use" && b.id === tool.id);
  assert.ok(original && original.type === "tool_use");
  assert.deepEqual(tool.arguments, original.input);
 }
 assert.ok(h.events.some(e => e.type === "toolcall_delta"));
 assert.equal(h.events.filter(e => e.type === "toolcall_end").length, tools.length);
 assert.equal(h.mapper.output.stopReason, "toolUse");
 assert.equal(callbacks, 1);
 const count = h.events.length;
 h.send(assistant("trailing", [{ type: "text", text: "ignored" }]), success);
 assert.equal(h.events.length, count);
});

for (const [reason, expected] of [["end_turn", "stop"], ["max_tokens", "length"], ["tool_use", "toolUse"]] as const) test(`stop reason ${reason}`, () => {
 const h = harness();
 h.send(start());
 if (reason === "tool_use") h.send(block(0, { type: "tool_use", id: "tool", name: `${MCP_TOOL_PREFIX}bash`, input: {} }), stop(0));
 h.send(event("message_delta", { delta: { stop_reason: reason } }), event("message_stop"));
 if (reason !== "tool_use") { assert.equal(h.mapper.ended, false); h.mapper.finish(success); }
 assert.equal(h.mapper.output.stopReason, expected);
 const terminal = h.events.at(-1);
 assert.ok(terminal?.type === "done" && terminal.reason === expected);
});

test("restream drops abandoned tools and text without ending as toolUse", () => {
 const h = harness();
 h.send(start(), block(0, { type: "tool_use", id: "abandoned", name: "Bash" }), block(1, { type: "text" }), delta(1, { type: "text_delta", text: "old" }),
  start("two"), block(0, { type: "text" }), delta(0, { type: "text_delta", text: "new" }), stop(0), event("message_stop"), success);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "new" }]);
 assert.equal(h.mapper.output.stopReason, "stop");
});

test("non-streaming fallback emits text thinking and mapped tools with original arguments", () => {
 const h = harness(); let callbacks = 0;
 h.mapper.onToolTurnEnded = () => { callbacks++; assert.equal(h.actions.at(-1), "end"); };
 h.send(assistant("fallback", [{ type: "text", text: "answer" }, { type: "thinking", thinking: "reason", signature: "sig" },
  { type: "tool_use", id: "t", name: `${MCP_TOOL_PREFIX}bash`.toUpperCase(), input: { command: "pwd", file_path: "keep" } }], { input_tokens: 7 }));
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "answer" }, { type: "thinking", thinking: "reason", thinkingSignature: "sig" },
  { type: "toolCall", id: "t", name: "bash", arguments: { command: "pwd", file_path: "keep" } }]);
 assert.equal(h.mapper.output.usage.input, 7);
 assert.equal(callbacks, 0);
 h.send(success);
 assert.equal(callbacks, 1);
});

test("different-id fallback replaces a stalled stream", () => {
 const h = harness();
 h.send(start(), block(0, { type: "tool_use", id: "abandoned", name: "Bash" }), assistant("two", [{ type: "text", text: "fallback" }]), success);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "fallback" }]);
 assert.equal(h.mapper.output.stopReason, "stop");
});

test("same-id assistant frames dedupe their streamed block ordinals", () => {
 const h = harness();
 h.send(start(), block(0, { type: "text" }), delta(0, { type: "text_delta", text: "stream" }));
 const count = h.events.length;
 h.send(assistant("one", [{ type: "text", text: "stream" }]));
 assert.equal(h.events.length, count);
 h.send(stop(0), block(1, { type: "thinking", thinking: "thought", signature: "sig" }), stop(1), event("message_stop"));
 const stoppedCount = h.events.length;
 h.send(assistant("one", [{ type: "thinking", thinking: "thought", signature: "sig" }]));
 assert.equal(h.events.length, stoppedCount);
 h.send(success);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "stream" }, { type: "thinking", thinking: "thought", thinkingSignature: "sig" }]);
});

test("rejected rate limit prefixes an error result without prior content", () => {
 const h = harness();
 h.send(rate({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1789770600 }), sdk({ type: "result", subtype: "error_during_execution", errors: ["limit"] }));
 assert.ok(h.mapper.output.errorMessage?.startsWith("Claude rate limit"));
 assert.deepEqual(h.events.map(e => e.type), ["start", "error"]);
});

test("error result alone emits exactly start and error", () => {
 const h = harness(); h.send(sdk({ type: "result", subtype: "success", is_error: true, result: "bad" }));
 assert.equal(h.mapper.output.errorMessage, "bad");
 assert.deepEqual(h.events.map(e => e.type), ["start", "error"]);
});

test("pure helper cases preserve ported behavior", () => {
 assert.equal(resultErrorText(success), undefined);
 for (const [fields, expected] of [
  [{ subtype: "success", is_error: true, result: "failed" }, "failed"],
  [{ subtype: "success", is_error: true }, "Claude Code reported an error"],
  [{ errors: ["one", 2] }, "one\n2"], [{ error: "bad" }, "bad"],
  [{ subtype: "other" }, "Claude Code failed: other"], [{}, "Claude Code failed: unknown result"],
 ] as const) assert.equal(resultErrorText(sdk({ type: "result", ...fields })), expected);
 assert.equal(describeRateLimitFailure({}, "bad"), "Claude rate limit: bad");
 assert.equal(mapStopReason(undefined), "stop");
});

for (const flag of ["isUsingOverage", "overageInUse"]) test(`${flag} latches across mappers and refuses before tool completion`, () => {
 const h = harness(); let callbacks = 0;
 h.mapper.onToolTurnEnded = () => { callbacks++; };
 h.send(start(), block(0, { type: "tool_use", id: "t", name: "Bash", input: {} }), rate({ status: "allowed", [flag]: true }));
 assert.equal(h.mapper.output.errorMessage, OVERAGE_REFUSAL);
 assert.equal(h.mapper.output.stopReason, "error");
 const count = h.events.length;
 h.send(stop(0), event("message_stop"), success);
 assert.equal(h.events.length, count);
 assert.equal(h.events.some(e => e.type === "toolcall_end" || e.type === "done"), false);
 assert.equal(callbacks, 0);
 assert.equal(overageLatched(), true);
 const next = harness();
 assert.equal(overageLatched(), true);
 next.send(rate({ status: "allowed", isUsingOverage: false }), success);
 assert.equal(overageLatched(), true);
 resetOverageLatchForTests();
 assert.equal(overageLatched(), false);
});

for (const fallback of [false, true]) test(`unmapped Bash keeps name and arguments (${fallback ? "fallback" : "stream"})`, () => {
 const h = harness(); const input = { command: "pwd", file_path: "unchanged" };
 if (fallback) h.send(assistant("fallback", [{ type: "tool_use", id: "t", name: "Bash", input }]), success);
 else h.send(start(), block(0, { type: "tool_use", id: "t", name: "Bash", input: {} }),
  delta(0, { type: "input_json_delta", partial_json: '{"command":' }), delta(0, { type: "input_json_delta", partial_json: '"pwd","file_path":"unchanged"}' }), stop(0), event("message_stop"));
 assert.deepEqual(h.mapper.output.content, [{ type: "toolCall", id: "t", name: "Bash", arguments: input }]);
});

test("fail aborted preserves partial content and all later terminals are no-ops", () => {
 const h = harness(); h.send(start(), block(0, { type: "text" }), delta(0, { type: "text_delta", text: "partial" }));
 h.mapper.fail("aborted", "cancelled");
 const snapshot = structuredClone(h.mapper.output); const count = h.events.length;
 h.mapper.fail("error", "late"); h.mapper.finish(success); h.send(stop(0), start("late"));
 assert.equal(h.events.length, count);
 assert.deepEqual(h.mapper.output, snapshot);
 const partial = h.mapper.output.content[0]!;
 assert.equal(partial.type === "text" && partial.text, "partial");
 const terminal = h.events.at(-1);
 assert.ok(terminal?.type === "error" && terminal.reason === "aborted");
});

test("empty fail error emits start first", () => {
 const h = harness(); h.mapper.fail("error", "iterator ended");
 assert.deepEqual(h.events.map(e => e.type), ["start", "error"]);
});

test("tool-turn guard warns without pushes; overage still latches after done", () => {
 const h = harness(); h.send(assistant("one", [{ type: "tool_use", id: "t", name: "Bash" }]), success);
 const snapshot = structuredClone(h.mapper.output); const count = h.events.length;
 h.send(start("late"), rate({ status: "rejected", overageInUse: true }));
 h.mapper.fail("error", "late"); h.mapper.finish(success);
 assert.equal(h.events.length, count);
 assert.deepEqual(h.mapper.output, snapshot);
 assert.ok(h.warns.some(m => m.includes("guard violation")));
 assert.equal(overageLatched(), true);
});

test("usage merges reasoning and preserves cacheWrite1h unless overwritten non-null", () => {
 const h = harness(); h.send(start("one", { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, cache_creation: { ephemeral_1h_input_tokens: 6 }, thinking_tokens: 4 }));
 assert.equal(h.mapper.output.usage.reasoning, 4);
 h.send(event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 11, reasoning_tokens: 8, thinking_tokens: 99, cache_creation: { ephemeral_1h_input_tokens: null } } }));
 assert.equal(h.mapper.output.usage.cacheWrite1h, 6);
 assert.equal(h.mapper.output.usage.reasoning, 8);
 assert.equal(h.mapper.output.usage.totalTokens, 26);
 h.send(event("message_delta", { usage: { cache_creation: { ephemeral_1h_input_tokens: 0 } } }), success);
 assert.equal(h.mapper.output.usage.cacheWrite1h, 0);
 assert.ok(Object.values(h.mapper.output.usage.cost).every(value => value === 0));
});

test("rate warnings dedupe by five-percent step and threshold and rearm on reset or rejection", () => {
 const h = harness();
 const warning = (utilization: number, surpassedThreshold = 0.8) => rate({ status: "allowed_warning", utilization, surpassedThreshold });
 h.send(warning(0.81), warning(0.82), warning(0.8)); assert.equal(h.warns.length, 1);
 h.send(warning(0.86), warning(0.86, 0.85)); assert.equal(h.warns.length, 3);
 h.send(rate({ status: "allowed" }), warning(0.81)); assert.equal(h.warns.length, 4);
 h.send(rate({ status: "rejected" }), warning(0.81)); assert.equal(h.warns.length, 6);
 h.send(success);
});

const toolFrame = (id: string, toolId: string, stop_reason: string | null = null) => sdk({
 type: "assistant", parent_tool_use_id: null,
 message: { id, stop_reason, content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: toolId } }] },
});
const result = (fields: object = {}) => sdk({ type: "result", subtype: "success", is_error: false, ...fields });
function assertDone(h: ReturnType<typeof harness>, reason: "stop" | "length" | "toolUse") {
 const last = h.events.at(-1);
 assert.ok(last?.type === "done");
 assert.equal(last.reason, reason);
 assert.equal(h.mapper.output.stopReason, reason);
}

test("F1: streamed truncated tool turn ends length and fires its hook once", () => {
 const h = harness(); let hooks = 0;
 h.mapper.onToolTurnEnded = () => { hooks++; assert.equal(h.actions.at(-1), "end"); };
 h.send(start(), block(0, { type: "tool_use", id: "truncated", name: "Bash" }),
  delta(0, { type: "input_json_delta", partial_json: '{"command":' }), stop(0),
  event("message_delta", { delta: { stop_reason: "max_tokens" } }), event("message_stop"), success);
 assertDone(h, "length");
 assert.equal(hooks, 1);
 assert.equal(h.mapper.output.content[0]?.type, "toolCall");
});

for (const boundary of ["result", "user", "different-id", "stop-reason"] as const) test(`F2: fallback collects all same-id tool frames until ${boundary}`, () => {
 const h = harness(); let hooks = 0;
 h.mapper.onToolTurnEnded = () => {
  hooks++; assert.equal(h.actions.at(-1), "end");
  assert.deepEqual(h.mapper.output.content.filter(b => b.type === "toolCall").map(b => b.id), ["first", "second"]);
 };
 h.send(toolFrame("one", "first"));
 assert.equal(h.mapper.ended, false); assert.equal(hooks, 0);
 h.send(sdk({ ...toolFrame("nested", "ignored"), parent_tool_use_id: "subagent" }),
  sdk({ type: "user", parent_tool_use_id: "subagent" }));
 assert.equal(h.mapper.ended, false);
 if (boundary === "stop-reason") h.send(toolFrame("one", "second", "tool_use"));
 else {
  h.send(toolFrame("one", "second"));
  assert.equal(h.mapper.ended, false); assert.equal(hooks, 0);
  if (boundary === "result") h.send(success);
  else if (boundary === "user") h.send(sdk({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "first" }] } }));
  else h.send(assistant("two", [{ type: "text", text: "ignored" }]));
 }
 assertDone(h, "toolUse"); assert.equal(hooks, 1);
 const count = h.events.length;
 h.send(toolFrame("one", "late"), success);
 assert.equal(h.events.length, count); assert.equal(hooks, 1);
});

test("F3: nested stream assistant and user frames cannot alter the main text turn", () => {
 const main = [start(), block(0, { type: "text" }), delta(0, { type: "text_delta", text: "main" }), stop(0), event("message_stop"), success];
 const control = harness(); control.send(...main);
 const h = harness();
 const nested = (...messages: SDKMessage[]) => messages.map(m => sdk({ ...m, parent_tool_use_id: "parent" }));
 h.send(...nested(start("nested"), block(0, { type: "tool_use", id: "t", name: "Bash" }), event("message_stop")), main[0]!, main[1]!,
  ...nested(assistant("nested", [{ type: "text", text: "bad" }]), toolFrame("nested", "tool"), sdk({ type: "user" })),
  main[2]!, ...nested(delta(0, { type: "text_delta", text: "bad" }), stop(0), event("message_stop")), ...main.slice(3));
 assert.deepEqual(h.mapper.output.content, control.mapper.output.content);
 assert.deepEqual(h.events.map(e => e.type), control.events.map(e => e.type));
 assert.ok(h.debugs.some(m => /nested|subagent/.test(m)));
});

for (const [label, input, json, expected, malformed] of [
 ["no args", {}, undefined, {}, false],
 ["start input", { a: 2 }, undefined, { a: 2 }, false],
 ["valid", {}, '{"a":1}', { a: 1 }, false],
 ["trailing garbage", {}, '{"a":1}x', {}, true],
 ["truncated", {}, '{"a":', {}, true],
] as const) test(`F4: validates complete tool arguments (${label})`, () => {
 const h = harness(); h.send(start(), block(0, { type: "tool_use", id: "t", name: "Bash", input }));
 if (json !== undefined) h.send(delta(0, { type: "input_json_delta", partial_json: json }));
 h.send(stop(0), event("message_stop"));
 const tool = h.mapper.output.content[0]; assert.ok(tool?.type === "toolCall");
 assert.deepEqual(tool.arguments, expected);
 if (malformed) assert.ok(tool.argumentsError);
 else assert.equal(tool.argumentsError, undefined);
});

for (const source of ["frame", "result"] as const) for (const tool of [false, true]) test(`F5: fallback ${tool ? "tool" : "text"} honors max_tokens from ${source}`, () => {
 const h = harness(); let hooks = 0; h.mapper.onToolTurnEnded = () => { hooks++; };
 const message = tool ? toolFrame("fallback", "t", source === "frame" ? "max_tokens" : null) : sdk({
  type: "assistant", message: { id: "fallback", content: [{ type: "text", text: "partial" }], stop_reason: source === "frame" ? "max_tokens" : null },
 });
 h.send(message, result({ stop_reason: source === "result" ? "max_tokens" : null }));
 assertDone(h, "length"); assert.equal(hooks, tool ? 1 : 0);
});

test("F6: result usage replaces provisional fallback usage", () => {
 const h = harness(); h.send(assistant("fallback", [{ type: "text", text: "answer" }], { input_tokens: 1, output_tokens: 2 }),
  result({ usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, cache_creation: { ephemeral_1h_input_tokens: 4 } } }));
 assert.deepEqual(h.mapper.output.usage, { input: 11, output: 22, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 4, totalTokens: 40,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
});

test("F6 / R2-F4: larger result aggregate replaces final streamed usage", () => {
 const h = harness(); h.send(start("one", { input_tokens: 7 }), block(0, { type: "text" }), stop(0),
  event("message_delta", { usage: { input_tokens: 13, output_tokens: 17 } }), event("message_stop"),
  result({ usage: { input_tokens: 999, output_tokens: 999 } }));
 assert.equal(h.mapper.output.usage.input, 999); assert.equal(h.mapper.output.usage.output, 999);
});

test("F7: text fixture reports nested thinking tokens as reasoning", () => {
 const h = harness(); h.send(...fixture("text")); assert.equal(h.mapper.output.usage.reasoning, 39);
});

for (const prelude of ["ping", "empty-start", "nested-content"] as const) test(`F8: ${prelude} does not suppress a non-streamed answer`, () => {
 const h = harness();
 if (prelude === "ping") h.send(event("ping"));
 else if (prelude === "empty-start") h.send(start("fallback"));
 else h.send(sdk({ ...start("fallback"), parent_tool_use_id: "nested" }), sdk({ ...block(0, { type: "text" }), parent_tool_use_id: "nested" }));
 h.send(assistant("fallback", [{ type: "text", text: "answer" }]), success);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "answer" }]); assertDone(h, "stop");
});

for (const status of ["allowed", "allowed_warning"]) test(`F9: ${status} clears a stale rejection`, () => {
 const h = harness(); h.send(rate({ status: "rejected" }), rate({ status }), sdk({ type: "result", subtype: "error_during_execution", errors: ["unrelated"] }));
 assert.equal(h.mapper.output.errorMessage, "unrelated");
 assert.equal(h.mapper.output.errorMessage.startsWith("Claude rate limit"), false);
});

test("F10: partial tool fields are available during input_json_delta", () => {
 const h = harness(); h.send(start(), block(0, { type: "tool_use", id: "t", name: "Bash", input: {} }),
  delta(0, { type: "input_json_delta", partial_json: '{"command":"ls' }));
 const e = h.events.at(-1); assert.ok(e?.type === "toolcall_delta");
 const partial = e.partial.content[e.contentIndex]; assert.ok(partial?.type === "toolCall");
 assert.equal(partial.arguments.command, "ls");
 h.send(delta(0, { type: "input_json_delta", partial_json: '"}' }), stop(0), event("message_stop"));
});

const frame = (id: string, uuid: string, content: object[], supersedes?: string[]) => sdk({
 type: "assistant", uuid, supersedes, message: { id, content, stop_reason: null },
});
const endRequest = (input: number, output: number, stop_reason = "end_turn") => [
 event("message_delta", { delta: { stop_reason }, usage: { input_tokens: input, output_tokens: output } }), event("message_stop"),
];

test("R2-F1: parked parallel fallback tools can end explicitly and idempotently", () => {
 const h = harness(); let hooks = 0; h.mapper.onToolTurnEnded = () => { hooks++; assert.equal(h.actions.at(-1), "end"); };
 h.send(toolFrame("one", "first"), toolFrame("one", "second"));
 assert.equal(h.mapper.ended, false);
 h.mapper.endToolTurn("all calls parked");
 assertDone(h, "toolUse");
 assert.deepEqual(h.mapper.output.content.filter(b => b.type === "toolCall").map(b => b.id), ["first", "second"]);
 const count = h.events.length;
 h.mapper.endToolTurn("again"); assert.equal(h.events.length, count); assert.equal(hooks, 1);
 assert.ok(h.debugs.some(m => m.includes("all calls parked")));
 const empty = harness(); empty.mapper.endToolTurn("nothing pending"); assert.equal(empty.events.length, 0); empty.send(success);
});

test("R2-F2: dedupe streamed blocks while preserving same-id fallback-only tools", () => {
 const h = harness(); h.send(start("X"), block(0, { type: "text" }), delta(0, { type: "text_delta", text: "hello" }), stop(0),
  frame("X", "text-frame", [{ type: "text", text: "hello" }]),
  frame("X", "tool-frame", [{ type: "tool_use", id: "fallback-tool", name: "Bash", input: { a: 1 } }]), success);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "hello" }, { type: "toolCall", id: "fallback-tool", name: "Bash", arguments: { a: 1 } }]);
 assert.equal(h.events.filter(e => e.type === "text_start").length, 1);
 assert.equal(h.events.filter(e => e.type === "toolcall_end").length, 1); assertDone(h, "toolUse");
});

test("R2-F3: supersedes evicts fallback frame contributions and ignores unknown uuids", () => {
 const h = harness(); h.send(frame("A", "u1", [{ type: "text", text: "refused" }]),
  frame("B", "u2", [{ type: "text", text: "answer" }], ["u1", "unknown-tool-result"]), success);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "answer" }]);
 assert.ok(h.debugs.some(m => m.includes("supersed")));
});

for (const explicitStop of [false, true]) test(`R2-F3: completed streamed refusal is replaced (explicit stop ${explicitStop})`, () => {
 const h = harness(); h.send(start("A", { input_tokens: 10, output_tokens: 5 }), block(0, { type: "text" }), delta(0, { type: "text_delta", text: "refused" }), stop(0),
  frame("A", "u1", [{ type: "text", text: "refused" }]));
 if (explicitStop) h.send(event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } }));
 h.send(event("message_stop"), start("B", { input_tokens: 20, output_tokens: 7 }), block(0, { type: "text" }),
  delta(0, { type: "text_delta", text: "answer" }), stop(0), frame("B", "u2", [{ type: "text", text: "answer" }], ["u1"]), ...endRequest(20, 7), success);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "answer" }]);
 assert.equal(h.mapper.output.usage.input, 20); assert.equal(h.mapper.output.usage.output, 7);
});

for (const aggregate of [false, true]) test(`R2-F4: sequential requests aggregate usage (larger result ${aggregate})`, () => {
 const h = harness(); h.send(start("A"), block(0, { type: "text" }), delta(0, { type: "text_delta", text: "first" }), stop(0), ...endRequest(10, 5),
  start("B"), block(0, { type: "text" }), delta(0, { type: "text_delta", text: "second" }), stop(0), ...endRequest(20, 7),
  result(aggregate ? { usage: { input_tokens: 40, output_tokens: 16 } } : {}));
 assert.equal(h.mapper.output.usage.input, aggregate ? 40 : 30); assert.equal(h.mapper.output.usage.output, aggregate ? 16 : 12);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "first" }, { type: "text", text: "second" }]);
});

test("R2-F5: initial text thinking and signature are preserved with deltas", () => {
 const h = harness(); h.send(start(), block(0, { type: "text", text: "Hi" }), delta(0, { type: "text_delta", text: " there" }), stop(0),
  block(1, { type: "thinking", thinking: "initial thought", signature: "sig" }), stop(1), event("message_stop"), success);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "Hi there" }, { type: "thinking", thinking: "initial thought", thinkingSignature: "sig" }]);
 assert.ok(h.events.some(e => e.type === "text_delta" && e.delta === "Hi"));
 assert.ok(h.events.some(e => e.type === "thinking_delta" && e.delta === "initial thought"));
});

for (const streaming of [true, false]) test(`R2-F6: redacted thinking maps on ${streaming ? "stream" : "fallback"} path`, () => {
 const h = harness(); const redacted = { type: "redacted_thinking", data: "opaque" };
 if (streaming) h.send(start(), block(0, redacted), stop(0), event("message_stop"));
 else h.send(assistant("one", [redacted]));
 h.send(success);
 assert.deepEqual(h.mapper.output.content, [{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true }]);
 assert.equal(h.events.filter(e => e.type === "thinking_start").length, 1);
 assert.equal(h.events.filter(e => e.type === "thinking_end").length, 1);
});

test("R2-F7: usage-only delta preserves length for tool calls", () => {
 const h = harness(); h.send(start(), block(0, { type: "tool_use", id: "t", name: "Bash" }), stop(0),
  event("message_delta", { delta: { stop_reason: "max_tokens" } }), event("message_delta", { usage: { output_tokens: 20 } }), event("message_stop"));
 assertDone(h, "length");
});

test("R2-F8: empty JSON delta preserves nonempty start input", () => {
 const h = harness(); h.send(start(), block(0, { type: "tool_use", id: "t", name: "Bash", input: { a: 2 } }),
  delta(0, { type: "input_json_delta", partial_json: "" }));
 const partial = h.mapper.output.content[0]; assert.ok(partial?.type === "toolCall"); assert.deepEqual(partial.arguments, { a: 2 });
 h.send(stop(0), event("message_stop"));
 const tool = h.mapper.output.content[0]; assert.ok(tool?.type === "toolCall"); assert.deepEqual(tool.arguments, { a: 2 });
});

for (const fallback of [false, true]) test(`R2-F9: abandoned usage is discarded on ${fallback ? "fallback" : "restream"} replacement`, () => {
 const h = harness(); h.send(start("A", { input_tokens: 10, cache_creation_input_tokens: 30, cache_creation: { ephemeral_1h_input_tokens: 30 }, thinking_tokens: 8 }),
  block(0, { type: "text" }));
 if (fallback) h.send(assistant("B", [{ type: "text", text: "replacement" }], { input_tokens: 2, output_tokens: 3 }));
 else h.send(start("B", { input_tokens: 2, output_tokens: 3 }), block(0, { type: "text" }), stop(0), event("message_stop"));
 h.send(success);
 assert.equal(h.mapper.output.usage.input, 2); assert.equal(h.mapper.output.usage.cacheWrite, 0);
 assert.equal(h.mapper.output.usage.cacheWrite1h, undefined); assert.equal(h.mapper.output.usage.reasoning, undefined);
});

test("R2-F3: supersedes keeps active replacement block indices valid", () => {
 const h = harness(); h.send(start("A"), block(0, { type: "text", text: "refusal" }), stop(0),
  frame("A", "u1", [{ type: "text", text: "refusal" }]), ...endRequest(10, 5), start("B"),
  block(0, { type: "thinking", thinking: "replacement", signature: "sig" }),
  frame("B", "u2", [{ type: "thinking", thinking: "replacement", signature: "sig" }], ["u1"]),
  delta(0, { type: "thinking_delta", thinking: " thought" }), stop(0), ...endRequest(20, 7), success);
 assert.deepEqual(h.mapper.output.content, [{ type: "thinking", thinking: "replacement thought", thinkingSignature: "sig" }]);
 assert.ok(h.events.some(e => e.type === "thinking_delta" && e.contentIndex === 0 && e.delta === "replacement"));
});

test("R2-F2/F4 review: mixed-stream fallback tools honor result truncation", () => {
 const h = harness(); let hooks = 0; h.mapper.onToolTurnEnded = () => { hooks++; };
 h.send(start("X"), block(0, { type: "text", text: "intro" }), stop(0),
  frame("X", "text", [{ type: "text", text: "intro" }]), toolFrame("X", "fallback-tool"), result({ stop_reason: "max_tokens" }));
 assertDone(h, "length"); assert.equal(hooks, 1);
 assert.equal(h.mapper.output.content.filter(b => b.type === "toolCall").length, 1);
});

test("R2-F3 review: superseding the last fallback tool preserves a later continuation", () => {
 const h = harness(); let hooks = 0; h.mapper.onToolTurnEnded = () => { hooks++; };
 h.send(frame("A", "intro", [{ type: "text", text: "intro" }]), frame("A", "tool", [{ type: "tool_use", id: "removed", name: "Bash", input: {} }]),
  sdk({ type: "assistant", uuid: "replacement", supersedes: ["tool"], message: { id: "A", stop_reason: "end_turn", content: [{ type: "text", text: "replacement" }] } }),
  frame("B", "answer", [{ type: "text", text: "answer" }]), success);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "intro" }, { type: "text", text: "replacement" }, { type: "text", text: "answer" }]);
 assertDone(h, "stop"); assert.equal(hooks, 0);
});
