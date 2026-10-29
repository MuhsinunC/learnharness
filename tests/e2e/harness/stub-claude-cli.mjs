// A stand-in for the `claude` binary (LH-62), started by the real Agent SDK
// through the real server. argv[2] is the test's stub-claude URL; the rest is
// what the SDK passes. It speaks the SDK's stream-json control protocol the
// way Claude Code does, as far as LearnHarness depends on it:
// - answers `initialize`, then connects the SDK MCP server (`initialize`,
//   `notifications/initialized`, `tools/list`) over `mcp_message`;
// - loads `--resume` history from $HOME/.claude/projects/*/<id>.jsonl;
// - per API request: stream events (signed thinking first when `--effort`
//   is passed), then `message_stop`, then one trailing `assistant` frame per
//   content block, as Claude Code does;
// - runs tool calls one at a time as `tools/call` with
//   `_meta["claudecode/toolUseId"]`, then emits the `user` tool_result echo
//   before the next request; `claude/endTurn` or `--max-turns` end the turn;
// - queues user messages that arrive mid-turn.
// Each request (the full message list it would send) goes to the test's
// responder, which picks the reply. This proves LearnHarness's side of the
// protocol only; Claude Code's side is proven by the live re-measure.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [url, ...argv] = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(name);
	if (i >= 0) return argv[i + 1];
	return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
};
if (argv.includes("--version")) {
	console.log("2.1.300 (Claude Code)");
	process.exit(0);
}
if (argv[0] === "auth") {
	console.log(JSON.stringify({ loggedIn: true, subscriptionType: "max" }));
	process.exit(0);
}

const post = async (route, body) => (await fetch(url + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const resume = flag("--resume");
const sessionId = resume ?? randomUUID();
const maxTurns = flag("--max-turns") === undefined ? undefined : Number(flag("--max-turns"));

/** The API's view: consecutive same-role messages merge, string content becomes a text block. */
const messages = [];
function append(role, content) {
	const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
	const last = messages.at(-1);
	if (last?.role === role) last.content.push(...blocks);
	else messages.push({ role, content: [...blocks] });
}
if (resume) {
	const root = path.join(process.env.HOME, ".claude", "projects");
	const dir = fs.readdirSync(root).find((d) => fs.existsSync(path.join(root, d, `${resume}.jsonl`)));
	if (!dir) throw new Error(`stub claude: no session ${resume}`);
	for (const line of fs.readFileSync(path.join(root, dir, `${resume}.jsonl`), "utf8").split("\n")) {
		if (!line.trim()) continue;
		const record = JSON.parse(line);
		if ((record.type === "user" || record.type === "assistant") && record.message) append(record.message.role, record.message.content);
	}
}

let system = "";
let server;
let tools = [];
let seq = 0;
const waiting = new Map();
function control(request) {
	const request_id = `stub-${++seq}`;
	out({ type: "control_request", request_id, request });
	return new Promise((resolve) => waiting.set(request_id, resolve));
}
const mcp = async (method, params) => (await control({ subtype: "mcp_message", server_name: server, message: { jsonrpc: "2.0", id: ++seq, method, params } })).mcp_response;
let connected = Promise.resolve();
async function connect() {
	if (!server) return;
	await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stub-claude", version: "0" } });
	await control({ subtype: "mcp_message", server_name: server, message: { jsonrpc: "2.0", method: "notifications/initialized" } });
	tools = (await mcp("tools/list", {})).result.tools.map((tool) => `mcp__${server}__${tool.name}`);
}

let previous = "";
let ids = 0;
const frame = (fields) => ({ ...fields, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
const event = (e) => out(frame({ type: "stream_event", event: e }));
async function turn() {
	await connected;
	for (let requests = 1; ; requests++) {
		const body = { pid: process.pid, sessionId, resume, model: flag("--model"), effort: flag("--effort"), maxTurns, system, tools, messages: structuredClone(messages) };
		const reply = await post("/request", body);
		if (reply.hang) await new Promise(() => {});
		const sent = JSON.stringify(messages);
		let shared = 0;
		while (shared < sent.length && sent[shared] === previous[shared]) shared++;
		const usage = { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: Math.floor(shared / 4), cache_creation_input_tokens: Math.ceil((sent.length - shared) / 4) };
		if (reply.error) {
			out(frame({ type: "result", subtype: "success", is_error: true, result: reply.error, usage, stop_reason: null, num_turns: requests, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0 }));
			return;
		}
		const id = `msg_stub_${process.pid}_${++ids}`;
		const content = [];
		// The real route always passes --effort, so every reply carries signed thinking.
		if (flag("--effort")) content.push({ type: "thinking", thinking: `Thinking about request ${requests}.`, signature: `sig_${process.pid}_${ids}` });
		if (reply.text) content.push({ type: "text", text: reply.text });
		for (const call of reply.tools ?? []) content.push({ type: "tool_use", id: `toolu_stub_${process.pid}_${++ids}`, name: `mcp__${server}__${call.name}`, input: call.arguments });
		const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
		event({ type: "message_start", message: { id, role: "assistant", content: [], usage: { ...usage, output_tokens: 1 } } });
		content.forEach((block, index) => {
			if (block.type === "thinking") {
				event({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
				event({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
				event({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
			} else if (block.type === "text") {
				event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
				event({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
			} else {
				event({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
				event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
			}
			event({ type: "content_block_stop", index });
		});
		event({ type: "message_delta", delta: { stop_reason: stop }, usage });
		event({ type: "message_stop" });
		for (const block of content) out(frame({ type: "assistant", message: { id, role: "assistant", content: [block], stop_reason: stop, usage } }));
		append("assistant", content);
		previous = JSON.stringify(messages);
		if (stop === "end_turn") {
			out(frame({ type: "result", subtype: "success", is_error: false, result: reply.text ?? "", usage, stop_reason: "end_turn", num_turns: requests, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0 }));
			return;
		}
		const results = [];
		let endTurn = false;
		for (const block of content.filter((b) => b.type === "tool_use")) {
			const response = await mcp("tools/call", { name: block.name.slice(`mcp__${server}__`.length), arguments: block.input, _meta: { "claudecode/toolUseId": block.id } });
			const result = response.result ?? { content: [{ type: "text", text: String(response.error?.message) }], isError: true };
			if (result._meta?.["claude/endTurn"]) endTurn = true;
			results.push({ type: "tool_result", tool_use_id: block.id, content: result.content, is_error: result.isError === true });
		}
		out(frame({ type: "user", message: { role: "user", content: results } }));
		append("user", results);
		if (endTurn || (maxTurns !== undefined && requests >= maxTurns)) {
			out(frame({ type: "result", subtype: endTurn ? "success" : "error_max_turns", is_error: false, result: "", usage, stop_reason: null, num_turns: requests, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0 }));
			return;
		}
	}
}

const inbox = [];
let running = false;
async function drain() {
	if (running) return;
	running = true;
	while (inbox.length) {
		append("user", inbox.shift());
		await turn();
	}
	running = false;
}

await post("/spawn", { pid: process.pid, argv, sessionId });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.type === "control_response") {
		const response = message.response;
		waiting.get(response.request_id)?.(response.response ?? {});
		waiting.delete(response.request_id);
	} else if (message.type === "control_request") {
		if (message.request.subtype === "initialize") {
			system = message.request.appendSystemPrompt ?? "";
			server = message.request.sdkMcpServers?.[0];
			connected = connect();
		}
		out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
	} else if (message.type === "user") {
		inbox.push(message.message.content);
		void drain();
	}
}).on("close", () => process.exit(0));
