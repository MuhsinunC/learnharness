// In-process MCP server that exposes pi tools to Claude Code.
//
// Pi declares tool parameters as TypeBox objects, already JSON Schema at
// runtime. Serve them verbatim instead of createSdkMcpServer's lossy JSON
// Schema → Zod → JSON Schema round trip: nested objects, anyOf and const
// must survive unchanged.
//
// Handlers go on the underlying protocol server rather than through
// McpServer.registerTool, the Zod-only path. Pi validates and executes tools
// itself; this endpoint never validates arguments or executes a tool.
//
// The Agent SDK treats the instance as an opaque JSON-RPC endpoint, calling
// instance.connect(transport). Keep the McpServer wrapper for its SDK type.

import type { McpSdkServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "@earendil-works/pi-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { MCP_SERVER_NAME } from "./query-options.ts";

// Claude Code stamps tools/call with its tool_use block id. Call arrival
// order need not match block order, so only this extension reliably pairs
// calls. Fail explicitly if Claude Code stops sending it.
const TOOL_USE_ID_META = "claudecode/toolUseId";

// MCP requires an object schema. Pi permits any TypeBox schema, so report
// scalar/array parameters at startup, naming the tool rather than silently
// degrading its schema to "takes no arguments".
function assertObjectSchema(tool: Tool): void {
	const schema = tool.parameters as Record<string, unknown> | undefined;
	if (!schema || schema.type !== "object") {
		throw new Error(`${tool.name}: MCP tool parameters must be an object schema, got ${JSON.stringify(schema)}`);
	}
}

function endTurnResult(reason: string): CallToolResult {
	return {
		content: [{ type: "text", text: reason }],
		isError: true,
		_meta: { "claude/endTurn": true },
	};
}

export function createToolServer(tools: Tool[], opts: { timeoutMs: number }): {
	config: McpSdkServerConfig & { instance: McpServer };
	closeAll: (reason: string) => void;
	calls: string[];
} {
	const names = new Set<string>();
	// Deep-copy each schema so later mutation of the caller's registry cannot
	// change what tools/list serves; validate the copy that is served.
	const descriptors = tools.map(({ name, description, parameters }) => {
		const descriptor = { name, description, parameters: structuredClone(parameters) };
		assertObjectSchema(descriptor);
		if (names.has(name)) throw new Error(`duplicate MCP tool name: ${name}`);
		names.add(name);
		return descriptor;
	});
	const server = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
	const calls: string[] = [];
	const parked = new Set<(result: CallToolResult) => void>();
	let closedResult: CallToolResult | undefined;

	server.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: descriptors.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters as Record<string, unknown>,
		})),
	}));

	server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const name = request.params.name;
		if (!names.has(name)) throw new Error(`Unknown tool: ${name}`);
		const toolCallId = request.params._meta?.[TOOL_USE_ID_META];
		if (typeof toolCallId !== "string") {
			throw new Error(`${name}: tools/call is missing _meta["${TOOL_USE_ID_META}"] — cannot pair the result with its tool call`);
		}
		calls.push(toolCallId);
		// Park until the query closes, leaving Claude Code without a result
		// from which it could start another request. Late calls cannot hang.
		if (closedResult) return closedResult;
		return new Promise<CallToolResult>((resolve) => {
			const settle = (result: CallToolResult) => {
				parked.delete(settle);
				extra.signal.removeEventListener("abort", onAbort);
				resolve(result);
			};
			const onAbort = () => settle(endTurnResult("cancelled"));
			if (extra.signal.aborted) {
				onAbort();
				return;
			}
			parked.add(settle);
			extra.signal.addEventListener("abort", onAbort, { once: true });
		});
	});

	function closeAll(reason: string): void {
		if (closedResult) return;
		closedResult = endTurnResult(reason);
		for (const resolve of parked) resolve(closedResult);
		parked.clear();
	}

	return {
		config: { type: "sdk", name: MCP_SERVER_NAME, instance: server, timeout: opts.timeoutMs },
		closeAll,
		calls,
	};
}
