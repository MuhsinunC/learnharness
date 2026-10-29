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
	| { kind: "text"; text: string; usage?: StubUsage }
	| { kind: "tools"; calls: Array<{ name: string; arguments: unknown }>; text?: string }
	| { kind: "http"; status: number; body: unknown }
	| { kind: "hang" };

/** Reported token counts (default: a fixed 100 prompt / 20 completion). */
export interface StubUsage {
	prompt_tokens: number;
	completion_tokens: number;
}

export type StubResponder = (req: StubRequest) => StubReply | Promise<StubReply>;

/** The exact body Baseten returns for a bad key (reproduced with curl). */
export const BASETEN_403_BODY = { error: "please check the api-key you provided" };

export const reply = {
	text: (text: string, usage?: StubUsage): StubReply => ({ kind: "text", text, usage }),
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

/** The input a real provider counts against the window: the serialized
 *  messages and tool declarations, at chars/4. */
export function inputTokens(req: StubRequest): number {
	return Math.ceil((JSON.stringify(req.messages).length + JSON.stringify(req.body.tools ?? []).length) / 4);
}

/** The output the request reserves (max_completion_tokens or max_tokens; 0 when absent). */
export function maxOutputTokens(req: StubRequest): number {
	const body = req.body as { max_tokens?: number; max_completion_tokens?: number };
	return body.max_completion_tokens ?? body.max_tokens ?? 0;
}

/** What providers that count input + max_tokens against the window see. */
export const requestTokens = (req: StubRequest) => inputTokens(req) + maxOutputTokens(req);

/** Did any assistant message in the transcript call this tool? */
export function calledTool(req: StubRequest, name: string): boolean {
	return req.messages.some((m) => m.tool_calls?.some((c) => c.function.name === name));
}

export interface StubOptions {
	/** The ChatGPT account catalog GET /v1/models answers (LH-55): set it to
	 *  stand in for api.openai.com behind LH_E2E_CHATGPT_BASE_URL. */
	chatgptModels?: Array<{ slug: string; display_name: string; visibility: "list" }>;
}

export async function startStubProvider(responder: StubResponder, options: StubOptions = {}): Promise<StubProvider> {
	let respond = responder;
	const requests: StubRequest[] = [];
	const open = new Set<http.ServerResponse>();
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			void (async () => {
				const responses = req.url?.endsWith("/responses") ?? false;
				if (req.method === "GET" && req.url?.endsWith("/models") && options.chatgptModels) {
					res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: options.chatgptModels }));
					return;
				}
				if (!req.url?.endsWith("/chat/completions") && !responses) {
					res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
					return;
				}
				const body = JSON.parse(raw || "{}") as Record<string, unknown>;
				const parsed = responses ? parseResponsesRequest(body) : parseRequest(body);
				requests.push(parsed);
				let out: StubReply;
				try {
					out = await respond(parsed);
				} catch (err) {
					out = reply.http(500, { error: { message: `stub responder threw: ${String(err)}` } });
				}
				if (responses) sendResponses(res, out, open);
				else send(res, parsed.model, out, body.stream !== false, open);
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

/** A Responses API request (ChatGPT) in the chat-completions shape the
 *  responders read: instructions and developer items are the system
 *  prompt, input items the messages, function tools (also inside a
 *  namespace) the tools offered. */
function parseResponsesRequest(body: Record<string, unknown>): StubRequest {
	type Item = { type?: string; role?: string; content?: unknown; name?: string; tools?: Item[] };
	const text = (content: unknown) => typeof content === "string" ? content : (Array.isArray(content) ? content : []).map((c) => (c as { text?: string }).text ?? "").join("");
	const input = (Array.isArray(body.input) ? body.input : []) as Item[];
	const system = [typeof body.instructions === "string" ? body.instructions : "", ...input.filter((i) => i.role === "system" || i.role === "developer").map((i) => text(i.content))].filter(Boolean).join("\n");
	const messages = input.filter((i) => i.role === "user" || i.role === "assistant").map((i) => ({ role: i.role!, content: text(i.content) }));
	const tools = ((Array.isArray(body.tools) ? body.tools : []) as Item[]).flatMap((t) => t.type === "namespace" ? t.tools ?? [] : [t]).map((t) => t.name ?? "");
	return { model: String(body.model ?? ""), system, tools, messages, body };
}

/** A text or HTTP reply as a Responses API event stream. */
function sendResponses(res: http.ServerResponse, out: StubReply, open: Set<http.ServerResponse>): void {
	if (out.kind === "tools") out = reply.http(500, { error: { message: "the Responses stub answers text only, not tool calls" } });
	if (out.kind !== "text") {
		send(res, "", out, true, open);
		return;
	}
	const counts = out.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
	const usage = { input_tokens: counts.prompt_tokens, output_tokens: counts.completion_tokens, total_tokens: counts.prompt_tokens + counts.completion_tokens };
	const item = { id: `msg_stub_${Date.now()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: out.text, annotations: [] }] };
	const events = [
		{ type: "response.created", response: { id: `resp_stub_${Date.now()}` } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: out.text },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { status: "completed", output: [item], usage } },
	];
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
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
	const counts = (out.kind === "text" && out.usage) || { prompt_tokens: 100, completion_tokens: 20 };
	const usage = { ...counts, total_tokens: counts.prompt_tokens + counts.completion_tokens };
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
