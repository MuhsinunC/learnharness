import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local OpenAI-compatible chat-completions server for e2e tests. Every
 * request goes to the test's responder, which picks the reply from the
 * request content (model, system prompt, tools offered, transcript).
 */

export interface StubRequest {
	model: string;
	/** The system prompt text ("" when absent). */
	system: string;
	/** The tool names offered in this request. */
	tools: string[];
	messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ function: { name: string } }>; tool_call_id?: string }>;
	body: Record<string, unknown>;
}

export type StubReply =
	| { kind: "text"; text: string }
	| { kind: "tools"; calls: Array<{ name: string; arguments: unknown }>; text?: string }
	| { kind: "http"; status: number; body: unknown }
	| { kind: "hang" };

export type StubResponder = (req: StubRequest) => StubReply | Promise<StubReply>;

/** The exact body Baseten returns for a bad key (reproduced with curl). */
export const BASETEN_403_BODY = { error: "please check the api-key you provided" };

export const reply = {
	text: (text: string): StubReply => ({ kind: "text", text }),
	tools: (calls: Array<{ name: string; arguments: unknown }>, text?: string): StubReply => ({ kind: "tools", calls, text }),
	http: (status: number, body: unknown): StubReply => ({ kind: "http", status, body }),
	baseten403: (): StubReply => ({ kind: "http", status: 403, body: BASETEN_403_BODY }),
	contextLength: (limit = 8192): StubReply => ({
		kind: "http",
		status: 400,
		body: {
			error: {
				message: `This model's maximum context length is ${limit} tokens. However, your messages resulted in ${limit + 1000} tokens.`,
				type: "invalid_request_error",
				code: "context_length_exceeded",
			},
		},
	}),
	/** Accept the request and never answer (the connection stays open). */
	hang: (): StubReply => ({ kind: "hang" }),
};

export interface StubProvider {
	/** OpenAI-style base URL, ending in /v1. */
	baseUrl: string;
	/** Every request received, in order. */
	requests: StubRequest[];
	setResponder(responder: StubResponder): void;
	close(): Promise<void>;
}

/** The last tool result's tool name in a transcript (undefined when the last message is not a tool result). */
export function lastToolName(req: StubRequest): string | undefined {
	const last = req.messages[req.messages.length - 1];
	if (last?.role !== "tool") return undefined;
	for (const m of [...req.messages].reverse()) {
		const call = m.tool_calls?.find((c) => (c as { id?: string }).id === last.tool_call_id);
		if (call) return call.function.name;
	}
	return undefined;
}

/** Did any assistant message in the transcript call this tool? */
export function calledTool(req: StubRequest, name: string): boolean {
	return req.messages.some((m) => m.tool_calls?.some((c) => c.function.name === name));
}

export async function startStubProvider(responder: StubResponder): Promise<StubProvider> {
	let respond = responder;
	const requests: StubRequest[] = [];
	const open = new Set<http.ServerResponse>();
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			void (async () => {
				if (!req.url?.endsWith("/chat/completions")) {
					res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
					return;
				}
				const body = JSON.parse(raw || "{}") as Record<string, unknown>;
				const parsed = parseRequest(body);
				requests.push(parsed);
				let out: StubReply;
				try {
					out = await respond(parsed);
				} catch (err) {
					out = reply.http(500, { error: { message: `stub responder threw: ${String(err)}` } });
				}
				send(res, parsed.model, out, body.stream !== false, open);
			})();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		setResponder: (next) => {
			respond = next;
		},
		close: async () => {
			for (const res of open) res.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function parseRequest(body: Record<string, unknown>): StubRequest {
	const messages = (Array.isArray(body.messages) ? body.messages : []) as StubRequest["messages"];
	const system = messages
		.filter((m) => m.role === "system" || m.role === "developer")
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n");
	const tools = (Array.isArray(body.tools) ? body.tools : []).map(
		(t) => (t as { function?: { name?: string } }).function?.name ?? "",
	);
	return { model: String(body.model ?? ""), system, tools, messages, body };
}

function send(res: http.ServerResponse, model: string, out: StubReply, stream: boolean, open: Set<http.ServerResponse>): void {
	if (out.kind === "hang") {
		open.add(res);
		res.on("close", () => open.delete(res));
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.flushHeaders();
		return;
	}
	if (out.kind === "http") {
		res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
		return;
	}
	const id = `chatcmpl-stub-${Date.now()}`;
	const toolCalls = out.kind === "tools"
		? out.calls.map((c, index) => ({
				index,
				id: `call_${index}_${Math.random().toString(36).slice(2, 10)}`,
				type: "function",
				function: { name: c.name, arguments: JSON.stringify(c.arguments) },
			}))
		: [];
	const text = out.text ?? "";
	const finish = toolCalls.length > 0 ? "tool_calls" : "stop";
	const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
	if (!stream) {
		res.writeHead(200, { "content-type": "application/json" }).end(
			JSON.stringify({
				id,
				object: "chat.completion",
				model,
				choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index: _i, ...c }) => c) } : {}) } }],
				usage,
			}),
		);
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices, ...extra })}\n\n`);
	chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);
	if (text) chunk([{ index: 0, delta: { content: text }, finish_reason: null }]);
	if (toolCalls.length) chunk([{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }]);
	chunk([{ index: 0, delta: {}, finish_reason: finish }]);
	chunk([], { usage });
	res.end("data: [DONE]\n\n");
}
