import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { z } from "zod";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { createToolServer, MCP_TOOL_PREFIX } from "../src/agent/claude-code/mcp-server.ts";
import { createProberTools, createTeacherTools, type ProberToolContext } from "../src/agent/tools.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import { bareQuestionTools } from "../src/agent/teacher-agent.ts";
import { createDemoBuilderTools } from "../src/agent/subagents/demo-builder.ts";
import { createPdfTools } from "../src/agent/subagents/pdf-reader.ts";
import { createVisualTools } from "../src/agent/subagents/visual-maker.ts";
import { createWebTools } from "../src/agent/tools/web.ts";
import { createPdfReadTools } from "../src/agent/tools/pdf-read.ts";
import { auditorGraphTools } from "../src/agent/tools/graph.ts";

const parameters = Type.Object({
	nested: Type.Object({ mode: Type.Union([Type.Literal("first"), Type.Literal("second")]) }),
});
const tool: Tool = { name: "nested", description: "Nested schema", parameters };

async function connect(t: TestContext, tools: Tool[] = [tool]) {
	const server = createToolServer(tools, { timeoutMs: 3_600_000 });
	const client = new Client({ name: "test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	t.after(async () => {
		server.closeAll("test cleanup");
		await client.close();
		await server.config.instance.close();
	});
	await server.config.instance.connect(serverTransport);
	await client.connect(clientTransport);
	return { ...server, client };
}

test("serves TypeBox schemas verbatim and configures the SDK timeout", async (t) => {
	const { config, client } = await connect(t);
	assert.equal(config.timeout, 3_600_000);
	assert.equal(config.type, "sdk");
	assert.equal(config.name, "custom-tools");
	assert.equal(MCP_TOOL_PREFIX, "mcp__custom-tools__");
	const { tools } = await client.listTools();
	assert.equal(tools.length, 1);
	assert.ok(tools[0]);
	assert.equal(tools[0].name, tool.name);
	assert.equal(tools[0].description, tool.description);
	assert.deepEqual(tools[0].inputSchema, parameters);
	// Client.listTools parses with Zod and reorders top-level schema keys.
	// Read the same wire response without transforming it for the byte check.
	const wire = await client.request({ method: "tools/list" }, z.custom<ListToolsResult>());
	assert.ok(wire.tools[0]);
	assert.equal(JSON.stringify(wire.tools[0].inputSchema), JSON.stringify(parameters));
});

test("parks parallel calls without executing, then closes once including late calls", async (t) => {
	const execute = t.mock.fn(async () => ({ content: [], details: null }));
	const spyTool: AgentTool<typeof parameters> = { ...tool, parameters, label: "nested", execute };
	const { client, calls, closeAll } = await connect(t, [spyTool]);
	const call = (id: string) => client.callTool({
		name: tool.name,
		// Deliberately schema-invalid: the endpoint must not validate arguments.
		arguments: { nested: false },
		_meta: { "claudecode/toolUseId": id },
	});
	const first = call("one");
	const second = call("two");
	assert.equal(await Promise.race([first, second, tick().then(() => "pending")]), "pending");
	assert.deepEqual(calls, ["one", "two"]);
	assert.equal(execute.mock.callCount(), 0);
	closeAll("reason text");
	closeAll("ignored");
	const expected = {
		content: [{ type: "text", text: "reason text" }],
		isError: true,
		_meta: { "claude/endTurn": true },
	};
	assert.deepEqual(await first, expected);
	assert.deepEqual(await second, expected);
	assert.deepEqual(await call("late"), expected);
	assert.deepEqual(calls, ["one", "two", "late"]);
	assert.equal(execute.mock.callCount(), 0);
});

test("rejects unknown names and missing or non-string toolUseId without recording them", async (t) => {
	const { client, calls } = await connect(t);
	await assert.rejects(client.callTool({ name: "unknown" }), /Unknown tool: unknown/);
	for (const _meta of [undefined, {}, { "claudecode/toolUseId": 42 }]) {
		await assert.rejects(client.callTool({ name: tool.name, _meta }),
			/nested: tools\/call is missing _meta\["claudecode\/toolUseId"\]/);
	}
	assert.deepEqual(calls, []);
});

test("rejects non-object schemas at construction with the tool name", () => {
	for (const parameters of [Type.String(), Type.Array(Type.String())]) {
		assert.throws(() => createToolServer([{ ...tool, parameters }], { timeoutMs: 1 }),
			/nested: MCP tool parameters must be an object schema/);
	}
});

// Construction-only contexts: no tool executes or touches storage/headless APIs.
export function assertLhToolSets(): number {
	const ctx: ProberToolContext = {
		chatId: "test",
		chatStore: { getChat: () => null } as unknown as ProberToolContext["chatStore"],
		jobStore: {} as ProberToolContext["jobStore"],
		graphStore: {} as NonNullable<ProberToolContext["graphStore"]>,
		deliver: () => {},
		spawn: () => {},
	};
	const graph = { chatStore: ctx.chatStore, graphStore: ctx.graphStore! };
	const registries = [
		createProberTools(ctx), createProberTools(ctx, { explain: true }),
		createTeacherTools(ctx), createTeacherTools(ctx, { explain: true }),
		practiceTools({ ...ctx, graph, jobs: ctx }), bareQuestionTools(),
		createDemoBuilderTools({ html: null, testedHtml: null, lastResult: null },
			{} as Parameters<typeof createDemoBuilderTools>[1]),
		createPdfTools("unused.pdf"), createVisualTools(), createWebTools(() => null),
		createPdfReadTools("unused-dir"), auditorGraphTools(graph),
	];
	// Extraction's submit schemas and runSubmitAgent's inline registry are
	// private; covering those requires an export outside this lane's scope.
	let count = 0;
	for (const registry of registries) {
		const tools = Object.values(registry);
		const server = createToolServer(tools, { timeoutMs: 1 });
		server.closeAll("schema sweep");
		for (const tool of tools) {
			assert.equal(tool.parameters.type, "object", tool.name);
			assert.ok(!tool.name.startsWith("mcp__"), tool.name);
			count++;
		}
	}
	return count;
}

test("LH registries use object schemas and unprefixed names", () => {
	assert.ok(assertLhToolSets() > 50, "the sweep must cover a non-trivial tool set");
});
