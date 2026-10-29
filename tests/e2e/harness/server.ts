import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Boot the real LearnHarness server on a free 127.0.0.1 port, with a fresh
 * data dir and a pre-written settings.json. By default it serves ONE
 * production build per source state: `next build` runs once (cached under
 * ~/.cache/lh-e2e/build-<hash of the sources + lockfile>), and every test
 * starts that build's standalone server.js, the server the desktop app
 * ships. No route compiles on first hit. LH_E2E_DEV=1 serves `next dev`
 * instead, for debugging. The child runs under `nice -n 10`, without
 * proxy or credential env vars, with its own HOME and PATH (hostless()),
 * with LH_IGNORE_ENV_KEYS=1 (no real key leaks in) and LH_E2E=1 (the
 * stub provider seam in src/agent/e2e-providers.ts and the Chrome-only
 * demo browser in headless.ts). Every seam is read from process.env at request time, so
 * one build serves every test's env.
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
	/** Listen here instead of a free port (the desktop app's fixed remote port). */
	port?: number;
	/** Sent with every api()/json() call and the boot probe, e.g. the desktop secret header. */
	headers?: Record<string, string>;
	/** The boot probe waits for a 2xx here. Default /api/settings. */
	readyPath?: string;
	/** Default 6 minutes (a `next dev` first compile is slow on a busy machine). */
	bootTimeoutMs?: number;
	/** Start from a copy of this data dir, as a restart does; `settings` still replaces settings.json. */
	seedDataDir?: string;
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

const CACHE = path.join(os.homedir(), ".cache", "lh-e2e");

/** The env every child starts from: ours minus proxies, credentials and LH_*. */
function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED_ENV.test(k)) env[k] = v;
	return env;
}

/** A fresh HOME and a PATH of the system dirs plus a bin dir holding only
 *  `node`, all under `root`, so a child never finds the host's Claude Code
 *  or reads the real home. Node's own dir is left out: it may hold an
 *  npm-global `claude`. The link serves `#!/usr/bin/env node` (next). */
function hostless(root: string): { HOME: string; PATH: string } {
	const home = path.join(root, "home");
	const bin = path.join(root, "bin");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(bin, { recursive: true });
	fs.symlinkSync(process.execPath, path.join(bin, "node"));
	return { HOME: home, PATH: [bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter) };
}

/** sha256 of every tracked or unignored file outside tests/ and docs/
 *  (the lockfile and next.config.ts included), so any source edit rebuilds.
 *  next-env.d.ts is left out: Next rewrites it on every build and dev boot. */
function sourceHash(): string {
	const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8" });
	if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
	const hash = crypto.createHash("sha256");
	for (const file of listed.stdout.split("\n").filter((f) => f && !/^(tests|docs)\//.test(f) && f !== "next-env.d.ts").sort()) {
		const full = path.join(REPO_ROOT, file);
		if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
		hash.update(file).update("\0").update(fs.readFileSync(full)).update("\0");
	}
	return hash.digest("hex").slice(0, 16);
}

/** Hold an exclusive cross-process lock (a mkdir) around `work`. */
function withLock<T>(lock: string, work: () => T): T {
	for (;;) {
		try {
			fs.mkdirSync(lock);
			break;
		} catch {
			// A lock older than the build timeout belongs to a dead run.
			const held = fs.statSync(lock, { throwIfNoEntry: false });
			if (held && Date.now() - held.mtimeMs > BUILD_TIMEOUT_MS) fs.rmSync(lock, { recursive: true, force: true });
			else spawnSync("sleep", ["2"]);
		}
	}
	try {
		return work();
	} finally {
		fs.rmSync(lock, { recursive: true, force: true });
	}
}

const BUILD_TIMEOUT_MS = 30 * 60_000;

/** The standalone server directory for the current sources: reused when
 *  this source state was built before, else `next build` + the desktop's
 *  payload step (scripts/build-server.mjs copies static/ and public/ and
 *  guards against leaked data and keys), copied out of .next so a later
 *  build cannot change it under a running test. Older builds are pruned. */
export function productionBuild(): string {
	const dir = path.join(CACHE, `build-${sourceHash()}`);
	const server = path.join(dir, "server.js");
	if (fs.existsSync(server)) return dir;
	fs.mkdirSync(CACHE, { recursive: true });
	return withLock(path.join(CACHE, "build.lock"), () => {
		if (fs.existsSync(server)) return dir; // another run built it while we waited
		const envRoot = fs.mkdtempSync(path.join(CACHE, "env-build-"));
		const env = { ...cleanEnv(), ...hostless(envRoot), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" } as NodeJS.ProcessEnv;
		const run = (cmd: string, args: string[]) => {
			const res = spawnSync("nice", ["-n", "19", cmd, ...args], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: BUILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
			if (res.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(" ")} failed (${res.status ?? res.signal}):\n${(res.stdout + res.stderr).slice(-4000)}`);
		};
		// `next build` rewrites the tracked next-env.d.ts (dev and build
		// reference different type dirs); put it back so the tree stays clean.
		const nextEnv = path.join(REPO_ROOT, "next-env.d.ts");
		const nextEnvBefore = fs.readFileSync(nextEnv);
		try {
			try {
				run(path.join(REPO_ROOT, "node_modules", ".bin", "next"), ["build"]);
			} finally {
				fs.writeFileSync(nextEnv, nextEnvBefore);
			}
			run(process.execPath, [path.join(REPO_ROOT, "scripts", "build-server.mjs")]);
		} finally {
			fs.rmSync(envRoot, { recursive: true, force: true });
		}
		const staging = `${dir}.tmp-${process.pid}`;
		fs.cpSync(path.join(REPO_ROOT, ".next", "standalone"), staging, { recursive: true, verbatimSymlinks: true });
		fs.renameSync(staging, dir);
		for (const old of fs.readdirSync(CACHE)) {
			if (old.startsWith("build-") && path.join(CACHE, old) !== dir) fs.rmSync(path.join(CACHE, old), { recursive: true, force: true });
		}
		return dir;
	});
}

export async function bootServer(opts: BootOptions): Promise<LhServer> {
	const base = path.join(CACHE, opts.ticket);
	fs.mkdirSync(base, { recursive: true });
	const root = fs.mkdtempSync(path.join(base, "run-"));
	const dataDir = path.join(root, "data");
	const tmpDir = path.join(root, "tmp");
	fs.mkdirSync(dataDir, { recursive: true });
	if (opts.seedDataDir) fs.cpSync(opts.seedDataDir, dataDir, { recursive: true });
	fs.mkdirSync(tmpDir, { recursive: true });
	fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(opts.settings, null, "\t"));
	const authFile = path.join(root, "auth.json");
	fs.writeFileSync(authFile, "{}", { mode: 0o600 });

	const env = cleanEnv();
	Object.assign(env, {
		...hostless(root),
		LH_CLAUDE_CODE_TEST_NO_FIXED_DIRS: "1",
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

	const port = opts.port ?? (await freePort());
	const url = `http://127.0.0.1:${port}`;
	const dev = process.env.LH_E2E_DEV === "1";
	const [cmd, cwd] = dev
		? [[path.join(REPO_ROOT, "node_modules", ".bin", "next"), "dev", "-H", "127.0.0.1", "-p", String(port)], REPO_ROOT]
		: [[process.execPath, "server.js"], productionBuild()];
	if (!dev) Object.assign(env, { NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port) });
	const child: ChildProcess = spawn("nice", ["-n", "10", ...cmd], {
		cwd,
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
			headers: { ...opts.headers, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
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
				// The server may fork workers (`next dev` always does). Collect the tree before
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
				if (child.exitCode !== null) throw new Error(`the server exited (${child.exitCode})`);
				return (await api(opts.readyPath ?? "/api/settings")).ok;
			},
			`the server to answer ${opts.readyPath ?? "/api/settings"}`,
			opts.bootTimeoutMs ?? 360_000,
			1000,
		);
	} catch (err) {
		await server.stop();
		throw new Error(`${(err as Error).message}\n--- server log ---\n${output.slice(-4000)}`);
	}
	return server;
}
