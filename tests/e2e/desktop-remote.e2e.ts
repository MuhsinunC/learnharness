import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { bootServer, freePort, until, type LhServer } from "./harness/server.ts";
import { launchChrome } from "./harness/chrome.ts";

// LH-43, desktop app: remote access from a phone through the packaged
// server. Electron cannot run here, so the harness's production build
// (the standalone server.js the desktop ships) starts with the env
// electron/main.cjs gives it: LH_DESKTOP_SERVER, the per-launch secret,
// and the fixed remote port. The window is simulated by what main.cjs
// gives it: the secret header on API calls and the lh_desktop cookie (an
// HMAC of the secret) on page loads. A phone behind `tailscale serve` is
// simulated by the headers serve sends (see web-login.e2e.ts).

const TICKET = "lh-43";
const PASSWORD = "desktop phone password";
const TS_HOST = "lh-test.example.ts.net";
const SECRET = randomBytes(32).toString("hex");
const PAGE_KEY = createHmac("sha256", SECRET).update("lh-desktop-page").digest("hex");
const WINDOW_API = { "x-learnharness-desktop": SECRET };
const WINDOW_PAGE = { cookie: `lh_desktop=${PAGE_KEY}` };

let server: LhServer;
let port: number;
let fakeTailscale: string;

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

function raw(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string; headOnly?: boolean } = {}): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...opts.headers };
		if (opts.body !== undefined) headers["content-length"] = String(Buffer.byteLength(opts.body));
		const req = http.request({ host: "127.0.0.1", port, path: pathname, method: opts.method ?? "GET", headers, agent: false }, (res) => {
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

async function remoteAccess(headers: Record<string, string> = WINDOW_API) {
	return JSON.parse((await raw("/api/remote-access", { headers })).body) as { available: boolean; desktop: boolean; enabled: boolean; access: string | null; remotePort: number; restartNeeded: boolean; url: string | null };
}

function put(headers: Record<string, string>, body: unknown): Promise<RawResponse> {
	return raw("/api/remote-access", { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

/** Starts the desktop server; `fixed` false mimics a busy fixed port (main.cjs fell back to random). */
async function startDesktop(fixed: boolean, dataDir?: string): Promise<void> {
	const listen = await freePort();
	server = await bootServer({
		ticket: TICKET,
		providers: [],
		settings: { version: 1, graph: { enabled: false } },
		port: listen,
		headers: WINDOW_API,
		env: {
			LH_DESKTOP_SERVER: "1",
			LH_DESKTOP_API_SECRET: SECRET,
			LH_REMOTE_PORT: String(fixed ? listen : 3757),
			LH_TAILSCALE_BIN: fakeTailscale,
			...(dataDir ? { LH_DATA_DIR: dataDir } : {}),
		},
	});
	port = listen;
}

before(async () => {
	// Stands in for `tailscale status --json` on a signed-in Mac.
	const dir = fs.mkdtempSync(path.join(process.env.HOME!, ".cache", "lh-e2e", `${TICKET}-ts-`));
	fakeTailscale = path.join(dir, "tailscale");
	fs.writeFileSync(fakeTailscale, `#!/bin/sh\necho '{"BackendState":"Running","Self":{"DNSName":"${TS_HOST}."}}'\n`, { mode: 0o755 });
	await startDesktop(true);
});

after(async () => {
	await server?.stop();
	if (fakeTailscale) fs.rmSync(path.dirname(fakeTailscale), { recursive: true, force: true });
});

test("(desktop) before a password: the window works as before, and nothing remote gets in", async () => {
	assert.equal((await raw("/")).status, 200, "the window's page loads need nothing yet");
	assert.equal((await raw("/api/settings", { headers: WINDOW_API })).status, 200);
	assert.equal((await raw("/api/settings")).status, 403, "loopback without the secret stays shut, as before");
	assert.deepEqual(await remoteAccess(), { available: true, desktop: true, enabled: false, access: "desktop", remotePort: port, restartNeeded: false, url: null });
	assert.equal((await raw("/api/settings", { headers: viaServe() })).status, 403);
	const page = await raw("/chat/new", { headers: viaServe() });
	assert.equal(page.status, 303);
	assert.equal(page.headers.location, "/login?next=%2Fchat%2Fnew");
	assert.match((await raw("/login", { headers: viaServe() })).body, /Remote access is off/);
});

test("(desktop) only the window sets the password; then Settings shows the serve command and the phone's address", async () => {
	assert.equal((await put({}, { password: PASSWORD })).status, 403, "another local program cannot set it");
	assert.equal((await put(WINDOW_PAGE, { password: PASSWORD })).status, 403, "the page cookie is not an API key");
	assert.equal((await put(viaServe(), { password: PASSWORD })).status, 403);
	assert.equal((await put({ ...WINDOW_API, origin: "null" }, { password: PASSWORD })).status, 403, "cross-site even with the header");
	assert.equal((await put(WINDOW_API, { password: "short" })).status, 400);
	assert.equal((await put(WINDOW_API, { password: PASSWORD })).status, 200, "the window needs no current password");
	assert.deepEqual(await remoteAccess(), { available: true, desktop: true, enabled: true, access: "desktop", remotePort: port, restartNeeded: false, url: `https://${TS_HOST}` });

	assert.equal((await raw("/")).status, 303, "a header-less loopback page load is a forwarder until proven otherwise");
	assert.equal((await raw("/", { headers: WINDOW_PAGE })).status, 200, "the window's cookie opens its pages");
	assert.equal((await raw("/", { headers: { cookie: `lh_desktop=${SECRET}` } })).status, 303, "the raw secret is not the page key");

	const chrome = await launchChrome(TICKET, ["--no-proxy-server"]);
	try {
		const page = await chrome.browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });
		// What main.cjs gives the window: the cookie for its pages, the header for its API calls.
		await page.setCookie({ name: "lh_desktop", value: PAGE_KEY, url: `http://127.0.0.1:${port}`, httpOnly: true, sameSite: "Strict" });
		await page.setExtraHTTPHeaders(WINDOW_API);
		await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
		await until(async () => {
			await page.click('[data-testid="settings-entry"]');
			return page.waitForSelector('[data-testid="settings-nav-general"]', { timeout: 2000 });
		}, "the settings dialog to open", 120_000, 500);
		await page.click('[data-testid="settings-nav-general"]');
		await page.waitForSelector('[data-testid="remote-access-command"]', { timeout: 60_000 });
		assert.equal(await page.$eval('[data-testid="remote-access-command"]', (el) => el.textContent), `tailscale serve --bg ${port}`);
		assert.equal(await page.$eval('[data-testid="remote-access-url"]', (el) => el.textContent), `https://${TS_HOST}`);
		assert.equal(await page.$('[data-testid="remote-access-current"]'), null, "the window never asks for the current password");
	} finally {
		await chrome.close();
	}
});

test("(desktop) a phone behind tailscale serve logs in and uses the app; the window never does", async () => {
	assert.equal((await raw("/api/settings", { headers: WINDOW_API })).status, 200);
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
	const phone = (extra: Record<string, string> = {}) => viaServe({ cookie, origin: `https://${TS_HOST}`, ...extra });

	assert.equal((await raw("/api/settings", { headers: phone() })).status, 200);
	assert.equal((await raw("/chat/new", { headers: phone() })).status, 200);
	const events = await raw("/api/events", { headers: phone(), headOnly: true });
	assert.equal(events.status, 200);
	assert.match(events.headers["content-type"] ?? "", /text\/event-stream/);
	const status = await remoteAccess(phone());
	assert.equal(status.access, "session");
	assert.equal((await put(phone(), { password: "attacker-chosen" })).status, 403, "a phone needs the current password");
	assert.equal((await raw("/api/remote-access", { method: "DELETE", headers: phone() })).status, 403);

	assert.equal((await raw("/logout", { method: "POST", headers: phone() })).status, 303);
	assert.equal((await raw("/api/settings", { headers: phone() })).status, 403);
});

test("(desktop) keys and the Claude Code connection change only from the window; a phone reads status and keeps using the app", async () => {
	const local = { origin: `http://127.0.0.1:${port}` };
	const send = (pathname: string, method: string, headers: Record<string, string>, body?: unknown) =>
		raw(pathname, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
	// The window: keys and the Claude Code mode as before.
	assert.equal((await send("/api/keys/OPENROUTER_API_KEY", "PUT", { ...WINDOW_API, ...local }, { value: "e2e-dummy-key-not-real" })).status, 200);
	assert.equal((await send("/api/keys/OPENROUTER_API_KEY", "DELETE", { ...WINDOW_API, ...local })).status, 200);
	assert.equal((await send("/api/claude-code", "PUT", { ...WINDOW_API, ...local }, { mode: "off" })).status, 200);

	const login = await raw("/login", {
		method: "POST",
		headers: viaServe({ "content-type": "application/x-www-form-urlencoded", origin: `https://${TS_HOST}` }),
		body: new URLSearchParams({ password: PASSWORD, next: "/" }).toString(),
	});
	const cookie = [login.headers["set-cookie"]].flat().join("\n").split(";")[0]!;
	const phone = viaServe({ cookie, origin: `https://${TS_HOST}` });
	assert.equal((await raw("/api/keys", { headers: phone })).status, 200, "a phone may read key status");
	for (const [pathname, method, body] of [
		["/api/keys/OPENROUTER_API_KEY", "PUT", { value: "attacker-chosen-key-value" }],
		["/api/keys/OPENROUTER_API_KEY", "DELETE", undefined],
		["/api/claude-code", "PUT", { mode: "endpoint" }],
		["/api/claude-code/endpoint", "DELETE", undefined],
		["/api/claude-code/login", "POST", {}],
		["/api/subscriptions", "POST", { providerId: "chatgpt", op: "login" }],
	] as const) {
		const res = await send(pathname, method, phone, body);
		assert.equal(res.status, 403, `${method} ${pathname}`);
		assert.deepEqual(JSON.parse(res.body), { error: "Change this on the computer running LearnHarness.", computerOnly: true });
	}
	assert.equal((await send("/api/chats", "POST", phone, { title: "From the phone" })).status, 200, "chats still work");
	assert.equal((await send("/api/settings/general", "PUT", phone, { autoUpdate: true })).status, 200, "ordinary settings still save");

	const chrome = await launchChrome(TICKET, [`--host-resolver-rules=MAP ${TS_HOST} 127.0.0.1`, "--no-proxy-server"]);
	try {
		const page = await chrome.browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });
		await page.setCookie({ name: "lh_session", value: cookie.split("=")[1]!, url: `http://${TS_HOST}:${port}` });
		await page.goto(`http://${TS_HOST}:${port}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
		await until(async () => {
			await page.click('[data-testid="settings-entry"]');
			return page.waitForSelector('[data-testid="settings-nav-keys"]', { timeout: 2000 });
		}, "the settings dialog to open", 120_000, 500);
		await page.click('[data-testid="settings-nav-keys"]');
		for (const note of ["keys-computer-only", "claude-code-computer-only"]) {
			await page.waitForSelector(`[data-testid="${note}"]`, { timeout: 60_000 });
			assert.equal(await page.$eval(`[data-testid="${note}"]`, (el) => el.textContent), "Change this on the computer running LearnHarness.");
		}
	} finally {
		await chrome.close();
	}
});

test("(desktop) the window changes and removes the password without the current one, and that ends phone sessions", async () => {
	const loginAs = async (password: string) => {
		const res = await raw("/login", {
			method: "POST",
			headers: viaServe({ "content-type": "application/x-www-form-urlencoded", origin: `https://${TS_HOST}` }),
			body: new URLSearchParams({ password, next: "/" }).toString(),
		});
		return [res.headers["set-cookie"]].flat().join("\n").split(";")[0]!;
	};
	const before = await loginAs(PASSWORD);
	assert.equal((await raw("/api/settings", { headers: viaServe({ cookie: before }) })).status, 200);
	assert.equal((await put(WINDOW_API, { password: "the next password" })).status, 200);
	assert.equal((await raw("/api/settings", { headers: viaServe({ cookie: before }) })).status, 403, "the change logged the phone out");
	const after = await loginAs("the next password");
	assert.equal((await raw("/api/settings", { headers: viaServe({ cookie: after }) })).status, 200);
	assert.equal((await raw("/api/remote-access", { method: "DELETE", headers: { ...WINDOW_API, "content-type": "application/json" }, body: "{}" })).status, 200);
	assert.equal((await remoteAccess()).enabled, false);
	assert.equal((await raw("/api/settings", { headers: viaServe({ cookie: after }) })).status, 403, "off ends every session");
	assert.equal((await raw("/")).status, 200, "and the window is back to needing nothing");
	assert.equal((await put(WINDOW_API, { password: PASSWORD })).status, 200);
});

test("(desktop) a server that did not get the fixed port asks for a restart and still gates the phone", async () => {
	const dataDir = server.dataDir;
	process.env.LH_E2E_KEEP = "1";
	await server.stop();
	delete process.env.LH_E2E_KEEP;
	await startDesktop(false, dataDir);
	try {
		const status = await remoteAccess();
		assert.equal(status.enabled, true);
		assert.equal(status.remotePort, 3757);
		assert.equal(status.restartNeeded, true);
		assert.equal((await raw("/chat/new", { headers: viaServe() })).status, 303);
		assert(!server.log().includes(PASSWORD));
	} finally {
		await server.stop();
		fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
	}
});
