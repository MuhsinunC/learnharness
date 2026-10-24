import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { EventMapper, OVERAGE_REFUSAL, overageLatched, resetOverageLatchForTests,
 resultErrorText, describeRateLimitFailure, mapStopReason, parsePartialJson } from "../src/agent/claude-code/events";

const model = { id: "test-model", api: "claude-agent-sdk", provider: "claude-code" } as Model<any>;
const names = new Map(["bash", "edit", "read", "write"].map(name => [`mcp__custom-tools__${name}`, name]));
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
 if (reason === "tool_use") h.send(block(0, { type: "tool_use", id: "tool", name: "mcp__custom-tools__bash", input: {} }), stop(0));
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
  { type: "tool_use", id: "t", name: "MCP__CUSTOM-TOOLS__BASH", input: { command: "pwd", file_path: "keep" } }], { input_tokens: 7 }));
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "answer" }, { type: "thinking", thinking: "reason", thinkingSignature: "sig" },
  { type: "toolCall", id: "t", name: "bash", arguments: { command: "pwd", file_path: "keep" } }]);
 assert.equal(h.mapper.output.usage.input, 7);
 assert.equal(callbacks, 1);
 h.send(success);
});

test("different-id fallback replaces a stalled stream", () => {
 const h = harness();
 h.send(start(), block(0, { type: "tool_use", id: "abandoned", name: "Bash" }), assistant("two", [{ type: "text", text: "fallback" }]), success);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "fallback" }]);
 assert.equal(h.mapper.output.stopReason, "stop");
});

test("same-id assistant messages add nothing during and after stream delivery", () => {
 const h = harness();
 h.send(start(), block(0, { type: "text" }), delta(0, { type: "text_delta", text: "stream" }));
 const count = h.events.length;
 h.send(assistant("one", [{ type: "text", text: "duplicate" }]));
 assert.equal(h.events.length, count);
 h.send(stop(0), event("message_stop"));
 const stoppedCount = h.events.length;
 h.send(assistant("one", [{ type: "text", text: "duplicate" }]));
 assert.equal(h.events.length, stoppedCount);
 h.send(success);
 assert.deepEqual(h.mapper.output.content, [{ type: "text", text: "stream" }]);
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
 const fallback = { keep: true };
 assert.equal(parsePartialJson("", fallback), fallback);
 assert.equal(parsePartialJson('{"a":', fallback), fallback);
 assert.deepEqual(parsePartialJson('{"a":1}', fallback), { a: 1 });
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
 if (fallback) h.send(assistant("fallback", [{ type: "tool_use", id: "t", name: "Bash", input }]));
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
 const h = harness(); h.send(assistant("one", [{ type: "tool_use", id: "t", name: "Bash" }]));
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
