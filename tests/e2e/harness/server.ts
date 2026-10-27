import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Boot the real LearnHarness server in web mode (`next dev`) on a free
 * 127.0.0.1 port, with a fresh data dir and a pre-written settings.json.
 * The child runs under `nice -n 10`, without proxy or credential env vars,
 * with LH_IGNORE_ENV_KEYS=1 (no real key leaks in) and LH_E2E=1 (the stub
 * provider seam in src/agent/e2e-providers.ts and the Chrome-only demo
 * browser in headless.ts).
 */

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** One OpenAI-compatible provider registered through LH_E2E_PROVIDERS. */
export interface E2EProvider {
	id: string;
	baseUrl: string;
	models: Array<{ id: string; input?: Array<"text" | "image">; contextWindow?: number; maxTokens?: number; [key: string]: unknown }>;
}

export interface BootOptions {
	/** Groups temp dirs under ~/.cache/lh-e2e/<ticket>/. */
	ticket: string;
	/** Written verbatim to <data>/settings.json before boot. */
	settings: Record<string, unknown>;
	providers: E2EProvider[];
	/** Extra env for the server process. */
	env?: Record<string, string>;
	/** Default 6 minutes: the first `next dev` compile is slow on a busy machine. */
	bootTimeoutMs?: number;
}

export interface LhServer {
	url: string;
	dataDir: string;
	/** fetch against the server; JSON bodies are encoded for you. */
	api(pathname: string, init?: { method?: string; body?: unknown }): Promise<Response>;
	/** Shorthand: api() then .json(), throwing on a non-2xx status. */
	json<T = unknown>(pathname: string, init?: { method?: string; body?: unknown }): Promise<T>;
	/** Everything the server printed so far (stdout + stderr). */
	log(): string;
	stop(): Promise<void>;
}

const STRIPPED_ENV = /^(HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|NODE_ENV|ANTHROPIC_.*|CLAUDE_CODE_.*|LH_.*|OPENAI_.*|OPENROUTER_.*|BASETEN_.*|__NEXT_.*)$/;

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as net.AddressInfo;
			srv.close(() => resolve(port));
		});
	});
}

export async function until<T>(probe: () => T | Promise<T>, label: string, timeoutMs = 60_000, intervalMs = 250): Promise<NonNullable<T>> {
	const end = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < end) {
		try {
			const value = await probe();
			if (value) return value as NonNullable<T>;
		} catch (err) {
			last = err;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${last ? ` (last error: ${String(last)})` : ""}`);
}

/** Every descendant pid of `pid` (pgrep -P, recursively). */
function descendants(pid: number): number[] {
	const out = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout ?? "";
	return out.split("\n").filter(Boolean).map(Number).flatMap((kid) => [kid, ...descendants(kid)]);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function signal(pids: number[], sig: NodeJS.Signals): void {
	for (const pid of pids) {
		try {
			process.kill(pid, sig);
		} catch {
			// already gone
		}
	}
}

export async function bootServer(opts: BootOptions): Promise<LhServer> {
	const base = path.join(os.homedir(), ".cache", "lh-e2e", opts.ticket);
	fs.mkdirSync(base, { recursive: true });
	const root = fs.mkdtempSync(path.join(base, "run-"));
	const dataDir = path.join(root, "data");
	const tmpDir = path.join(root, "tmp");
	fs.mkdirSync(dataDir, { recursive: true });
	fs.mkdirSync(tmpDir, { recursive: true });
	fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(opts.settings, null, "\t"));
	const authFile = path.join(root, "auth.json");
	fs.writeFileSync(authFile, "{}", { mode: 0o600 });

	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED_ENV.test(k)) env[k] = v;
	Object.assign(env, {
		LH_E2E: "1",
		LH_E2E_PROVIDERS: JSON.stringify(opts.providers),
		LH_DATA_DIR: dataDir,
		LH_AUTH_FILE: authFile,
		LH_IGNORE_ENV_KEYS: "1",
		TMPDIR: tmpDir,
		NO_PROXY: "127.0.0.1,localhost",
		NEXT_TELEMETRY_DISABLED: "1",
		...opts.env,
	});

	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const next = path.join(REPO_ROOT, "node_modules", ".bin", "next");
	const child: ChildProcess = spawn("nice", ["-n", "10", next, "dev", "-H", "127.0.0.1", "-p", String(port)], {
		cwd: REPO_ROOT,
		env: env as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout!.on("data", (c) => (output += c));
	child.stderr!.on("data", (c) => (output += c));
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

	const api: LhServer["api"] = (pathname, init = {}) =>
		fetch(url + pathname, {
			method: init.method ?? (init.body === undefined ? "GET" : "POST"),
			headers: init.body === undefined ? undefined : { "content-type": "application/json" },
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		});
	const server: LhServer = {
		url,
		dataDir,
		api,
		json: async (pathname, init) => {
			const res = await api(pathname, init);
			const text = await res.text();
			if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${pathname} → ${res.status}: ${text.slice(0, 500)}`);
			return JSON.parse(text);
		},
		log: () => output,
		stop: async () => {
			if (child.exitCode === null && child.pid) {
				// `next dev` forks next-server workers. Collect the tree before
				// signalling (an orphan is reparented and pgrep -P loses it),
				// then signal exactly those pids.
				const pids = [child.pid, ...descendants(child.pid)];
				signal(pids, "SIGTERM");
				const deadline = Date.now() + 10_000;
				while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
				signal(pids.filter(alive), "SIGKILL");
				await exited;
			}
			if (process.env.LH_E2E_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
		},
	};

	try {
		await until(
			async () => {
				if (child.exitCode !== null) throw new Error(`next dev exited (${child.exitCode})`);
				return (await api("/api/settings")).ok;
			},
			"next dev to answer /api/settings",
			opts.bootTimeoutMs ?? 360_000,
			1000,
		);
	} catch (err) {
		await server.stop();
		throw new Error(`${(err as Error).message}\n--- server log ---\n${output.slice(-4000)}`);
	}
	return server;
}
