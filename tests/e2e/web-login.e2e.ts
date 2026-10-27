import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { bootServer, REPO_ROOT, until, type LhServer } from "./harness/server.ts";
import { launchChrome } from "./harness/chrome.ts";

// LH-43: the web login and the bind gate. The server listens on 127.0.0.1
// as scripts/web-server.mjs would start it (LH_LISTEN_HOST=127.0.0.1).
// A phone behind `tailscale serve` is simulated with the headers serve
// really sends (tailscale ipn/ipnlocal/serve.go: Host kept as the ts.net
// name, X-Forwarded-Host/-Proto/-For, Tailscale-User-*), and headless
// Chrome reaches the loopback server under a ts.net name through
// --host-resolver-rules, so it sends a real non-loopback Host.

const TICKET = "lh-43";
const PASSWORD = "correct horse battery";
const TS_HOST = "lh-test.example.ts.net";

let server: LhServer;
let port: number;
let chatId: string;

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

/** One HTTP request with exact headers (fetch cannot set Host). `headOnly`
 * resolves on the status line and drops the socket, for SSE streams. */
function raw(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string; headOnly?: boolean } = {}): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: pathname, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
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

/** What `tailscale serve` forwards for a phone on the tailnet. */
const viaServe = (ip = "100.101.102.103", extra: Record<string, string> = {}) => ({
	host: TS_HOST,
	"x-forwarded-host": TS_HOST,
	"x-forwarded-proto": "https",
	"x-forwarded-for": ip,
	"tailscale-user-login": "learner@example.com",
	"tailscale-user-name": "Learner",
	"tailscale-headers-info": "https://tailscale.com/s/serve-headers",
	...extra,
});

const local = () => ({ host: `127.0.0.1:${port}` });
const JSON_BODY = { "content-type": "application/json" };

function login(ip: string, password: string, next = "/", extra: Record<string, string> = {}): Promise<RawResponse> {
	return raw("/login", {
		method: "POST",
		headers: viaServe(ip, { "content-type": "application/x-www-form-urlencoded", origin: `https://${TS_HOST}`, ...extra }),
		body: new URLSearchParams({ password, next }).toString(),
	});
}

/** The `lh_session=…` pair from a login response. */
function cookieOf(res: RawResponse): string {
	const set = [res.headers["set-cookie"] ?? []].flat().find((c) => c.startsWith("lh_session="));
	assert(set, `no session cookie in ${JSON.stringify(res.headers)}`);
	return set.split(";")[0]!;
}

async function setPassword(password: string): Promise<RawResponse> {
	return raw("/api/remote-access", { method: "PUT", headers: { ...local(), ...JSON_BODY }, body: JSON.stringify({ password }) });
}

before(async () => {
	server = await bootServer({ ticket: TICKET, providers: [], settings: { version: 1, graph: { enabled: false } }, env: { LH_LISTEN_HOST: "127.0.0.1" } });
	port = Number(new URL(server.url).port);
	chatId = (await server.json<{ id: string }>("/api/chats", { body: { title: "Remote" } })).id;
});

after(async () => {
	await server?.stop();
});

test("(a) with no password, loopback needs no login and remote requests are refused", async () => {
	assert.equal((await raw("/api/settings", { headers: local() })).status, 200);
	assert.equal((await raw("/chat/new", { headers: local() })).status, 200);
	assert.equal((await raw("/api/settings", { headers: { host: `localhost:${port}` } })).status, 200);
	assert.deepEqual(JSON.parse((await raw("/api/remote-access", { headers: local() })).body), { available: true, enabled: false, access: "local" });
	const remote = await raw("/api/settings", { headers: viaServe() });
	assert.equal(remote.status, 401);
	assert.match(remote.headers["content-type"] ?? "", /json/);
	const page = await raw("/login", { headers: viaServe() });
	assert.equal(page.status, 200);
	assert.match(page.body, /Remote access is off/);
	assert.equal((await login("100.64.0.9", "anything")).status, 403);
});

test("(b) the computer sets the password in Settings → General → Remote access", async () => {
	assert.equal((await raw("/api/remote-access", { method: "PUT", headers: { ...viaServe(), ...JSON_BODY }, body: JSON.stringify({ password: PASSWORD }) })).status, 401);
	assert.equal((await setPassword("short")).status, 400);
	const chrome = await launchChrome(TICKET, ["--no-proxy-server"]);
	try {
		const page = await chrome.browser.newPage();
		await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 180_000 });
		// Clicks before hydration land on inert markup: retry until it opens.
		await until(async () => {
			await page.click('[data-testid="settings-entry"]');
			return page.waitForSelector('[data-testid="settings-nav-general"]', { timeout: 2000 });
		}, "the settings dialog to open", 180_000, 500);
		await page.click('[data-testid="settings-nav-general"]');
		await page.waitForSelector('[data-testid="remote-access-password"]', { timeout: 60_000 });
		assert.match(await page.$eval('[data-testid="remote-access-status"]', (el) => el.textContent ?? ""), /^Off/);
		await page.type('[data-testid="remote-access-password"]', PASSWORD);
		await page.click('[data-testid="remote-access-save"]');
		await page.waitForFunction(() => /^On/.test(document.querySelector('[data-testid="remote-access-status"]')?.textContent ?? ""), { timeout: 60_000 });
	} finally {
		await chrome.close();
	}
	assert.equal(JSON.parse((await raw("/api/remote-access", { headers: local() })).body).enabled, true);
});

test("(b) a password makes remote-style requests log in, while loopback stays login-free", async () => {

	const file = path.join(server.dataDir, "web-login.json");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert(!fs.readFileSync(file, "utf8").includes(PASSWORD), "the password is stored only as a hash");

	assert.equal((await raw("/api/settings", { headers: local() })).status, 200, "local access never logs in");
	assert.equal((await raw("/chat/new", { headers: local() })).status, 200);

	for (const headers of [
		viaServe(),
		viaServe("100.64.0.5", { "x-lh-access": "local" }),
		{ host: TS_HOST }, // DNS rebinding, or serve without its extra headers
		{ host: `127.0.0.1:${port}`, "x-forwarded-for": "100.64.0.5" },
		{ host: `127.0.0.1:${port}`, "x-forwarded-host": TS_HOST },
		{ host: `127.0.0.1:${port}`, forwarded: "for=100.64.0.5" },
		{ host: `127.0.0.1:${port}`, "x-real-ip": "100.64.0.5" },
		{ host: `localhost:${port}`, "tailscale-user-login": "learner@example.com" },
	] as Array<Record<string, string>>) {
		assert.equal((await raw("/api/settings", { headers })).status, 401, JSON.stringify(headers));
	}
	const page = await raw("/chat/new?x=1", { headers: viaServe() });
	assert.equal(page.status, 303);
	assert.equal(page.headers.location, "/login?next=%2Fchat%2Fnew%3Fx%3D1", "relative, so the phone stays on its ts.net name");
	const form = await raw("/login", { headers: viaServe() });
	assert.equal(form.status, 200);
	assert.match(form.body, /type="password"/);
});

test("(c) a wrong password is refused and failed attempts are rate-limited", async () => {
	const ip = "100.70.0.1";
	for (let i = 0; i < 5; i++) {
		const res = await login(ip, "wrong password");
		assert.equal(res.status, 401);
		assert.match(res.body, /Wrong password/);
		assert.equal(res.headers["set-cookie"], undefined);
	}
	const blocked = await login(ip, PASSWORD);
	assert.equal(blocked.status, 429, "even the right password waits once the client is locked out");
	assert(Number(blocked.headers["retry-after"]) > 0);
	assert.equal((await login("100.70.0.2", PASSWORD, "/", { origin: "https://evil.example" })).status, 403, "cross-site login posts are refused");
});

test("(d) a correct login sets the session cookie and opens the app and /api", async () => {
	const res = await login("100.70.0.3", PASSWORD, "/chat/new");
	assert.equal(res.status, 303);
	assert.equal(res.headers.location, "/chat/new");
	const set = [res.headers["set-cookie"]].flat().join("\n");
	assert.match(set, /HttpOnly/);
	assert.match(set, /SameSite=Lax/);
	assert.match(set, /Secure/, "serve terminates TLS, so the cookie is Secure");
	const cookie = cookieOf(res);
	assert.equal((await raw("/api/settings", { headers: viaServe("100.70.0.3", { cookie }) })).status, 200);
	assert.equal((await raw("/chat/new", { headers: viaServe("100.70.0.3", { cookie }) })).status, 200);
	assert.equal(JSON.parse((await raw("/api/remote-access", { headers: viaServe("100.70.0.3", { cookie }) })).body).access, "session");
	const takeover = await raw("/api/remote-access", { method: "PUT", headers: { ...viaServe("100.70.0.3", { cookie, "x-lh-access": "local" }), ...JSON_BODY }, body: JSON.stringify({ password: "attacker-chosen" }) });
	assert.equal(takeover.status, 403, "a logged-in phone cannot change the password, even claiming to be local");
	assert.equal((await raw("/api/settings", { headers: viaServe("100.70.0.3", { cookie }) })).status, 200, "the password did not change");
});

test("(d) headless Chrome logs in through the login page, uses the app, and logs out", async () => {
	const chrome = await launchChrome(TICKET, [`--host-resolver-rules=MAP ${TS_HOST} 127.0.0.1`, "--no-proxy-server"]);
	try {
		const page = await chrome.browser.newPage();
		const origin = `http://${TS_HOST}:${port}`;
		await page.goto(`${origin}/chat/new`, { waitUntil: "domcontentloaded", timeout: 180_000 });
		assert.equal(new URL(page.url()).pathname, "/login");
		await page.type("#password", "not it");
		await Promise.all([page.waitForNavigation({ timeout: 120_000 }), page.click("button[type=submit]")]);
		assert.match(await page.content(), /Wrong password/);
		await page.type("#password", PASSWORD);
		await Promise.all([page.waitForNavigation({ timeout: 180_000 }), page.click("button[type=submit]")]);
		assert.equal(page.url(), `${origin}/chat/new`);

		const cookie = (await chrome.browser.cookies()).find((c) => c.name === "lh_session");
		assert(cookie, "the browser holds the session cookie");
		assert.equal(cookie.httpOnly, true);
		assert.equal(cookie.sameSite, "Lax");
		assert.equal(cookie.secure, false, "plain http here; Secure only behind https");
		assert.equal(await page.evaluate(() => document.cookie.includes("lh_session")), false, "scripts cannot read it");
		assert.equal(await page.evaluate(async () => (await fetch("/api/settings")).status), 200);

		await page.evaluate(async () => { await fetch("/logout", { method: "POST" }); });
		assert.equal(await page.evaluate(async () => (await fetch("/api/settings")).status), 401);
		assert.equal((await raw("/api/settings", { headers: viaServe("100.70.0.4", { cookie: `lh_session=${cookie.value}` }) })).status, 401, "the server revoked it, not only the browser");
	} finally {
		await chrome.close();
	}
});

test("(e) logout revokes the session; a new password or turning access off revokes them all", async () => {
	const first = cookieOf(await login("100.70.0.5", PASSWORD));
	assert.equal((await raw("/api/settings", { headers: viaServe("100.70.0.5", { cookie: first }) })).status, 200);
	const out = await raw("/logout", { method: "POST", headers: viaServe("100.70.0.5", { cookie: first }) });
	assert.equal(out.status, 303);
	assert.equal(out.headers.location, "/login");
	assert.match([out.headers["set-cookie"]].flat().join("\n"), /lh_session=;.*Max-Age=0/);
	assert.equal((await raw("/api/settings", { headers: viaServe("100.70.0.5", { cookie: first }) })).status, 401);

	const second = cookieOf(await login("100.70.0.6", PASSWORD));
	assert.equal((await setPassword("another good password")).status, 200);
	assert.equal((await raw("/api/settings", { headers: viaServe("100.70.0.6", { cookie: second }) })).status, 401, "a password change logs every device out");

	const third = cookieOf(await login("100.70.0.7", "another good password"));
	assert.equal((await raw("/api/remote-access", { method: "DELETE", headers: local() })).status, 200);
	assert.equal((await raw("/api/settings", { headers: viaServe("100.70.0.7", { cookie: third }) })).status, 401, "turning remote access off ends every session");
	assert.equal((await setPassword(PASSWORD)).status, 200);
});

test("(g) SSE, the turn stream and the chat export need the session too", async () => {
	const routes = ["/api/events", `/api/chats/${chatId}/stream`, `/api/chats/${chatId}/markdown`];
	for (const route of routes) assert.equal((await raw(route, { headers: viaServe(), headOnly: true })).status, 401, route);
	const cookie = cookieOf(await login("100.70.0.8", PASSWORD));
	const events = await raw("/api/events", { headers: viaServe("100.70.0.8", { cookie }), headOnly: true });
	assert.equal(events.status, 200);
	assert.match(events.headers["content-type"] ?? "", /text\/event-stream/);
	const md = await raw(`/api/chats/${chatId}/markdown`, { headers: viaServe("100.70.0.8", { cookie }) });
	assert.equal(md.status, 200);
	assert.match(String(md.headers["content-disposition"]), /attachment/);
	assert.equal((await raw(`/api/chats/${chatId}/stream`, { headers: viaServe("100.70.0.8", { cookie }), headOnly: true })).status, 200);
});

test("(f) the launcher refuses a non-loopback bind without a password, and never a LAN or public one", () => {
	const dataDir = fs.mkdtempSync(path.join(os.homedir(), ".cache", "lh-e2e", TICKET, "gate-"));
	// Every case is refused before `next` is spawned, so nothing ever listens.
	const launch = (host: string) =>
		spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "web-server.mjs"), "dev"], {
			env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", LH_DATA_DIR: dataDir, LH_LISTEN_HOST: host, LH_LISTEN_PORT: "1" },
			encoding: "utf8",
			timeout: 30_000,
		});
	try {
		for (const [host, why] of [
			["100.100.100.100", /needs a login password first/],
			["fd7a:115c:a1e0::1", /needs a login password first/],
			["0.0.0.0", /LH_LISTEN_ALL=1/],
			["192.168.1.20", /never listens on a LAN or public interface/],
			["203.0.113.7", /never listens on a LAN or public interface/],
			["my-laptop.local", /not an IP address/],
		] as const) {
			const run = launch(host);
			assert.equal(run.status, 78, `${host}: ${run.stderr}`);
			assert.match(run.stderr, why);
		}
		fs.copyFileSync(path.join(server.dataDir, "web-login.json"), path.join(dataDir, "web-login.json"));
		const publicBind = launch("203.0.113.7");
		assert.equal(publicBind.status, 78, "a password never opens a public interface");
		assert.match(publicBind.stderr, /never listens on a LAN or public interface/);
	} finally {
		fs.rmSync(dataDir, { recursive: true, force: true });
	}
});

test("the proxy wrote no secret to the server log", async () => {
	await until(() => server.log().length > 0, "server output");
	assert(!server.log().includes(PASSWORD));
	assert(!/lh_session=[A-Za-z0-9_-]{20,}/.test(server.log()));
});
