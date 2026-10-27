import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { freePort, REPO_ROOT, until } from "./harness/server.ts";
import { launchChrome } from "./harness/chrome.ts";

// LH-43, desktop app: remote access from a phone through the packaged
// server. Electron cannot run here, so this builds the standalone (next
// build + scripts/build-server.mjs, as desktop:dist does) and spawns
// .next/standalone/server.js with the env electron/main.cjs gives it: the
// per-launch secret, 127.0.0.1, and the fixed remote port. The window is
// simulated by sending the secret header; a phone behind `tailscale serve`
// by the headers serve sends (see web-login.e2e.ts). LH_E2E_STANDALONE=reuse
// skips the build when a standalone already exists.

const TICKET = "lh-43";
const PASSWORD = "desktop phone password";
const TS_HOST = "lh-test.example.ts.net";
const SECRET = randomBytes(32).toString("hex");
const WINDOW = { "x-learnharness-desktop": SECRET };
const SERVER = path.join(REPO_ROOT, ".next", "standalone", "server.js");

let root: string;
let port: number;
let child: ChildProcess | null = null;
let output = "";

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

function raw(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string; headOnly?: boolean } = {}): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: pathname, method: opts.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
			if (opts.headOnly) {
				resolve({ status: res.statusCode!, headers: res.headers, body: "" });
				res.destroy();
				return;
			}
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.end(opts.body);
	});
}

const viaServe = (extra: Record<string, string> = {}) => ({
	host: TS_HOST,
	"x-forwarded-host": TS_HOST,
	"x-forwarded-proto": "https",
	"x-forwarded-for": "100.101.102.103",
	"tailscale-user-login": "learner@example.com",
	"tailscale-headers-info": "https://tailscale.com/s/serve-headers",
	...extra,
});

async function remoteAccess(headers: Record<string, string> = WINDOW) {
	return JSON.parse((await raw("/api/remote-access", { headers })).body) as { enabled: boolean; access: string | null; remotePort: number; restartNeeded: boolean; url: string | null };
}

/** Spawns the standalone the way electron/main.cjs startServer does. */
async function startDesktopServer(listenPort: number, remotePort: number): Promise<void> {
	port = listenPort;
	output = "";
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/PROXY|proxy|^LH_|^NODE_ENV$|KEY|TOKEN|SECRET/.test(k)) env[k] = v;
	child = spawn("nice", ["-n", "10", process.execPath, SERVER], {
		cwd: path.dirname(SERVER),
		env: {
			...env,
			NODE_ENV: "production",
			PORT: String(listenPort),
			HOSTNAME: "127.0.0.1",
			LH_DATA_DIR: path.join(root, "data"),
			LH_AUTH_FILE: path.join(root, "auth.json"),
			LH_DESKTOP_SERVER: "1",
			LH_DESKTOP_API_SECRET: SECRET,
			LH_LISTEN_HOST: "127.0.0.1",
			LH_REMOTE_PORT: String(remotePort),
			LH_IGNORE_ENV_KEYS: "1",
			LH_TAILSCALE_BIN: path.join(root, "tailscale"),
			TMPDIR: path.join(root, "tmp"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout!.on("data", (c) => (output += c));
	child.stderr!.on("data", (c) => (output += c));
	await until(async () => {
		if (child?.exitCode !== null) throw new Error(`standalone exited:\n${output.slice(-3000)}`);
		return (await raw("/")).status === 200;
	}, "the standalone to answer GET /", 120_000, 500);
}

async function stopDesktopServer(): Promise<void> {
	const running = child;
	child = null;
	if (!running || running.exitCode !== null) return;
	const exited = new Promise((resolve) => running.once("exit", resolve));
	// nice execs node, so this pid is the server itself.
	running.kill("SIGTERM");
	const timer = setTimeout(() => running.kill("SIGKILL"), 10_000);
	await exited;
	clearTimeout(timer);
}

before(async () => {
	if (process.env.LH_E2E_STANDALONE !== "reuse" || !fs.existsSync(SERVER)) {
		for (const [cmd, args] of [["node_modules/.bin/next", ["build"]], [process.execPath, ["scripts/build-server.mjs"]]] as const) {
			const run = spawnSync("nice", ["-n", "10", cmd, ...args], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" } });
			assert.equal(run.status, 0, `${cmd} ${args.join(" ")} failed:\n${(run.stdout + run.stderr).slice(-4000)}`);
		}
	}
	const base = path.join(os.homedir(), ".cache", "lh-e2e", TICKET);
	fs.mkdirSync(base, { recursive: true });
	root = fs.mkdtempSync(path.join(base, "desktop-"));
	for (const dir of ["data", "tmp"]) fs.mkdirSync(path.join(root, dir));
	fs.writeFileSync(path.join(root, "auth.json"), "{}", { mode: 0o600 });
	// Stands in for `tailscale status --json` on a signed-in Mac.
	fs.writeFileSync(path.join(root, "tailscale"), `#!/bin/sh\necho '{"BackendState":"Running","Self":{"DNSName":"${TS_HOST}."}}'\n`, { mode: 0o755 });
	const fixed = await freePort();
	await startDesktopServer(fixed, fixed);
});

after(async () => {
	await stopDesktopServer();
	if (root && process.env.LH_E2E_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
});

test("(desktop) the window keeps its secret path, and nothing else gets in before a password", async () => {
	assert.equal((await raw("/")).status, 200, "the window's page loads need no header");
	assert.equal((await raw("/api/settings", { headers: WINDOW })).status, 200);
	assert.equal((await raw("/api/settings")).status, 403, "loopback without the secret stays shut, as before");
	assert.deepEqual(await remoteAccess(), { enabled: false, access: "local", remotePort: port, restartNeeded: false, url: null });
	assert.equal((await raw("/api/settings", { headers: viaServe() })).status, 403);
	const page = await raw("/chat/new", { headers: viaServe() });
	assert.equal(page.status, 303);
	assert.equal(page.headers.location, "/login?next=%2Fchat%2Fnew");
	assert.match((await raw("/login", { headers: viaServe() })).body, /Remote access is off/);
});

test("(desktop) only the window sets the password; then Settings shows the serve command and the phone's address", async () => {
	const put = (headers: Record<string, string>) =>
		raw("/api/remote-access", { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ password: PASSWORD }) });
	assert.equal((await put({})).status, 403, "another local program cannot set it");
	assert.equal((await put(viaServe())).status, 403);
	assert.equal((await put(WINDOW)).status, 200);
	assert.deepEqual(await remoteAccess(), { enabled: true, access: "local", remotePort: port, restartNeeded: false, url: `https://${TS_HOST}` });

	const chrome = await launchChrome(TICKET, ["--no-proxy-server"]);
	try {
		const page = await chrome.browser.newPage();
		// The window's webRequest hook adds the secret to its own /api calls.
		await page.setExtraHTTPHeaders(WINDOW);
		await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
		await until(async () => {
			await page.click('[data-testid="settings-entry"]');
			return page.waitForSelector('[data-testid="settings-nav-general"]', { timeout: 2000 });
		}, "the settings dialog to open", 120_000, 500);
		await page.click('[data-testid="settings-nav-general"]');
		await page.waitForSelector('[data-testid="remote-access-command"]', { timeout: 60_000 });
		assert.equal(await page.$eval('[data-testid="remote-access-command"]', (el) => el.textContent), `tailscale serve --bg ${port}`);
		assert.equal(await page.$eval('[data-testid="remote-access-url"]', (el) => el.textContent), `https://${TS_HOST}`);
	} finally {
		await chrome.close();
	}
});

test("(desktop) a phone behind tailscale serve logs in and uses the app; the window never does", async () => {
	assert.equal((await raw("/")).status, 200);
	assert.equal((await raw("/api/settings", { headers: WINDOW })).status, 200);
	assert.equal((await raw("/api/settings", { headers: viaServe() })).status, 403);
	assert.equal((await raw("/api/settings", { headers: viaServe({ "x-learnharness-desktop": "0".repeat(64) }) })).status, 403);
	assert.equal((await raw("/chat/new", { headers: viaServe() })).status, 303);

	const login = await raw("/login", {
		method: "POST",
		headers: viaServe({ "content-type": "application/x-www-form-urlencoded", origin: `https://${TS_HOST}` }),
		body: new URLSearchParams({ password: PASSWORD, next: "/chat/new" }).toString(),
	});
	assert.equal(login.status, 303);
	assert.equal(login.headers.location, "/chat/new");
	const set = [login.headers["set-cookie"]].flat().join("\n");
	assert.match(set, /HttpOnly/);
	assert.match(set, /Secure/);
	const cookie = set.split(";")[0]!;

	assert.equal((await raw("/api/settings", { headers: viaServe({ cookie }) })).status, 200);
	assert.equal((await raw("/chat/new", { headers: viaServe({ cookie }) })).status, 200);
	const events = await raw("/api/events", { headers: viaServe({ cookie }), headOnly: true });
	assert.equal(events.status, 200);
	assert.match(events.headers["content-type"] ?? "", /text\/event-stream/);
	const phone = await remoteAccess(viaServe({ cookie }));
	assert.equal(phone.access, "session");
	assert.equal(phone.url, null, "only the computer itself is told the tailnet name");
	assert.equal((await raw("/api/remote-access", { method: "DELETE", headers: viaServe({ cookie }) })).status, 403, "a phone cannot turn remote access off");

	assert.equal((await raw("/logout", { method: "POST", headers: viaServe({ cookie }) })).status, 303);
	assert.equal((await raw("/api/settings", { headers: viaServe({ cookie }) })).status, 403);
});

test("(desktop) a server that did not get the fixed port asks for a restart and still gates the phone", async () => {
	await stopDesktopServer();
	await startDesktopServer(await freePort(), 3757);
	const status = await remoteAccess();
	assert.equal(status.enabled, true);
	assert.equal(status.remotePort, 3757);
	assert.equal(status.restartNeeded, true);
	assert.equal((await raw("/chat/new", { headers: viaServe() })).status, 303);
	assert(!output.includes(PASSWORD));
});
