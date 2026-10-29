import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A stub Claude Code binary for e2e tests (LH-62). `executable` is an
 * absolute script that runs stub-claude-cli.mjs, which the real Agent SDK
 * spawns and drives over its stream-json protocol. Every API request the
 * stub would send reaches the responder, which picks the reply from the
 * request's content. `requests` and `spawns` record what each child (by
 * pid) received.
 */

export type StubClaudeBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
export interface StubClaudeRequest {
	pid: number;
	sessionId: string;
	resume?: string;
	model?: string;
	effort?: string;
	maxTurns?: number;
	/** The appended system prompt (LearnHarness's own). */
	system: string;
	tools: string[];
	messages: Array<{ role: "user" | "assistant"; content: StubClaudeBlock[] }>;
}
export type StubClaudeReply =
	| { text?: string; tools?: Array<{ name: string; arguments: Record<string, unknown> }> }
	| { error: string }
	| { hang: true };
export type StubClaudeResponder = (req: StubClaudeRequest) => StubClaudeReply | Promise<StubClaudeReply>;

export interface StubClaude {
	executable: string;
	requests: StubClaudeRequest[];
	spawns: Array<{ pid: number; argv: string[]; sessionId: string }>;
	setResponder(responder: StubClaudeResponder): void;
	close(): Promise<void>;
}

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "stub-claude-cli.mjs");

export async function startStubClaude(responder: StubClaudeResponder, ticket = "stub-claude"): Promise<StubClaude> {
	let respond = responder;
	const requests: StubClaudeRequest[] = [];
	const spawns: StubClaude["spawns"] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			const value = JSON.parse(body || "{}");
			let reply: unknown = {};
			if (req.url === "/spawn") spawns.push(value);
			else if (req.url === "/request") {
				requests.push(value);
				try {
					reply = await respond(value);
				} catch (error) {
					reply = { error: `stub responder threw: ${String(error)}` };
				}
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(reply));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	fs.mkdirSync(path.join(os.homedir(), ".cache", "lh-e2e"), { recursive: true });
	const dir = fs.mkdtempSync(path.join(os.homedir(), ".cache", "lh-e2e", `${ticket}-claude-`));
	const executable = path.join(dir, "claude");
	fs.writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${CLI}' 'http://127.0.0.1:${port}' "$@"\n`, { mode: 0o755 });
	return {
		executable,
		requests,
		spawns,
		setResponder: (next) => { respond = next; },
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}
