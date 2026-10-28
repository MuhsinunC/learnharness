import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { bootServer, REPO_ROOT, until, type LhServer } from "./harness/server.ts";
import { launchChrome } from "./harness/chrome.ts";

// LH-43: the web login, in web mode (`npm start`: the harness serves the
// production build on 127.0.0.1, as scripts/web-server.mjs would). A phone
// behind `tailscale serve` is simulated with the headers serve really
// sends (tailscale ipn/ipnlocal/serve.go: Host kept as the ts.net name,
// X-Forwarded-Host/-Proto/-For, Tailscale-User-*), and headless Chrome
// reaches the loopback server under a ts.net name through
// --host-resolver-rules, so it sends a real non-loopback Host. A
// header-less loopback request stands in for any TCP forwarder
// (tailscale serve --tcp, editor port forwarding, ssh -R).

const TICKET = "lh-43";
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new password";
const TS_HOST = "lh-test.example.ts.net";
/** Keeps the real `tailscale status` (this machine's tailnet name) out of the run. */
const NO_TAILSCALE = "/nonexistent/tailscale";
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

let server: LhServer;
let port: number;
let chatId: string;

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

/** One HTTP request with exact headers (fetch cannot set Host). `headOnly`
 * resolves on the status line and drops the socket, for SSE streams. */
function raw(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string; headOnly?: boolean } = {}): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		// A fresh connection each time: a kept-alive socket the server already
		// closed resets the next request. Bodies carry a length, as browsers send.
		const headers = opts.body === undefined ? opts.headers : { ...opts.headers, "content-length": String(Buffer.byteLength(opts.body)) };
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

const local = (extra: Record<string, string> = {}) => ({ host: `127.0.0.1:${port}`, ...extra });
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

function remoteAccess(headers: Record<string, string>, method: "PUT" | "DELETE", body: unknown): Promise<RawResponse> {
	return raw("/api/remote-access", { method, headers: { ...headers, ...JSON_BODY }, body: JSON.stringify(body) });
}

/** scripts/remote-access.ts against this server's data dir. */
function cli(args: string[], input?: string) {
	return spawnSync(TSX, [path.join(REPO_ROOT, "scripts", "remote-access.ts"), ...args], {
		cwd: REPO_ROOT,
		input,
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, LH_DATA_DIR: server.dataDir },
	});
}

/** Opens Settings → General in a page that is already in the app. */
async function openGeneralSettings(page: Page): Promise<void> {
	// Clicks before hydration land on inert markup: retry until it opens.
	await until(async () => {
		await page.click('[data-testid="settings-entry"]');
		return page.waitForSelector('[data-testid="settings-nav-general"]', { timeout: 2000 });
	}, "the settings dialog to open", 120_000, 500);
	await page.click('[data-testid="settings-nav-general"]');
	await page.waitForSelector('[data-testid="remote-access-status"]', { timeout: 60_000 });
}

before(async () => {
	server = await bootServer({ ticket: TICKET, providers: [], settings: { version: 1, graph: { enabled: false } }, env: { LH_TAILSCALE_BIN: NO_TAILSCALE } });
	port = Number(new URL(server.url).port);
	chatId = (await server.json<{ id: string }>("/api/chats", { body: { title: "Remote" } })).id;
});

after(async () => {
	await server?.stop();
});

test("(a) no password: loopback needs no login, remote requests get nothing, and HTTP cannot set the first password", async () => {
	assert.equal((await raw("/api/settings", { headers: local() })).status, 200);
	assert.equal((await raw("/chat/new", { headers: local() })).status, 200);
	assert.equal((await raw("/api/settings", { headers: { host: `localhost:${port}` } })).status, 200);
	assert.deepEqual(JSON.parse((await raw("/api/remote-access", { headers: local() })).body), {
		available: true, desktop: false, enabled: false, access: "local", remotePort: port, restartNeeded: false, url: null,
	});
	const remote = await raw("/api/settings", { headers: viaServe() });
	assert.equal(remote.status, 401);
	assert.match(remote.headers["content-type"] ?? "", /json/);
	const page = await raw("/login", { headers: viaServe() });
	assert.match(page.body, /Remote access is off/);
	assert.match(page.body, /remote-access:set-password/);
	assert.equal((await login("100.64.0.9", "anything")).status, 403);

	const first = await remoteAccess(local(), "PUT", { password: PASSWORD });
	assert.equal(first.status, 403, "a loopback browser cannot set the first password");
	assert.match(JSON.parse(first.body).error, /npm run remote-access:set-password/);
	assert.equal((await remoteAccess(viaServe(), "PUT", { password: PASSWORD })).status, 401);
	assert(!fs.existsSync(path.join(server.dataDir, "web-login.json")));

	const chrome = await launchChrome(TICKET, ["--no-proxy-server"]);
	try {
		const tab = await chrome.browser.newPage();
		await tab.setViewport({ width: 1280, height: 800 });
		await tab.goto(server.url, { waitUntil: "domcontentloaded", timeout: 120_000 });
		await openGeneralSettings(tab);
		assert.equal(await tab.$eval('[data-testid="remote-access-cli"]', (el) => el.textContent), "npm run remote-access:set-password");
		assert.equal(await tab.$('[data-testid="remote-access-password"]'), null, "no password field before the CLI ran");
	} finally {
		await chrome.close();
	}
});

test("(b) the CLI sets the first password; from then on every request needs a login, loopback too", async () => {
	const noTty = cli(["set-password"]);
	assert.equal(noTty.status, 1);
	assert.match(noTty.stderr, /Run this in a terminal/);
	const short = cli(["set-password", "--stdin"], "short\n");
	assert.equal(short.status, 1);
	assert.match(short.stderr, /at least 8 characters/);
	const file = path.join(server.dataDir, "web-login.json");
	assert(!fs.existsSync(file));
	const set = cli(["set-password", "--stdin"], `${PASSWORD}\n`);
	assert.equal(set.status, 0, set.stderr);
	assert.match(set.stdout, /Remote access is on/);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert(!fs.readFileSync(file, "utf8").includes(PASSWORD), "the password is stored only as a hash");

	for (const headers of [
		local(), // any header-less TCP forwarder looks exactly like this
		local({ "x-lh-access": "local" }),
		local({ "x-lh-access": "desktop" }),
		{ host: `localhost:${port}` },
		viaServe(),
		viaServe("100.64.0.5", { "x-lh-access": "local" }),
		{ host: TS_HOST },
		{ host: `127.0.0.1:${port}`, "x-forwarded-for": "100.64.0.5" },
		{ host: `localhost:${port}`, "tailscale-user-login": "learner@example.com" },
	] as Array<Record<string, string>>) {
		assert.equal((await raw("/api/settings", { headers })).status, 401, JSON.stringify(headers));
	}
	assert.equal((await raw("/chat/new", { headers: local() })).status, 303, "pages too: they render chats on the server");
	for (const sneaky of ["/_next/../api/settings", "/_next/%2e%2e/api/settings", "/_next/static/../../api/settings", "/_next/static/%2e%2e/%2e%2e/api/settings"]) {
		assert.notEqual((await raw(sneaky, { headers: local() })).status, 200, `${sneaky} must not slip past the proxy`);
	}
	const page = await raw("/chat/new?x=1", { headers: viaServe() });
	assert.equal(page.status, 303);
	assert.equal(page.headers.location, "/login?next=%2Fchat%2Fnew%3Fx%3D1", "relative, so the phone stays on its ts.net name");
	assert.match((await raw("/login", { headers: viaServe() })).body, /type="password"/);
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
});

test("(c) cross-site posts are refused before they cost an attempt: Origin null, other origins, Sec-Fetch-Site", async () => {
	const ip = "100.70.0.2";
	for (const extra of [{ origin: "null" }, { origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }] as Array<Record<string, string>>) {
		for (let i = 0; i < 3; i++) assert.equal((await login(ip, "wrong password", "/", extra)).status, 403, JSON.stringify(extra));
	}
	assert.equal((await login(ip, PASSWORD)).status, 303, "twelve refused posts charged nothing");
});

test("(c) parallel wrong logins cannot outrun the limit", async () => {
	const statuses = (await Promise.all(Array.from({ length: 8 }, () => login("100.70.0.9", "wrong password")))).map((r) => r.status).sort();
	assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429]);
});

test("(c) a next that is not a plain same-origin ASCII path falls back to /", async () => {
	for (const next of ["/€uro", "//evil.example/x", "/\\evil.example", "https://evil.example/", "/a b", "/login?next=/x"]) {
		const res = await login("100.70.0.10", PASSWORD, next);
		assert.equal(res.status, 303, next);
		assert.equal(res.headers.location, "/", next);
		cookieOf(res);
	}
});

test("(d) a correct login sets the session cookie and opens the app; a session changes the password only with the current one", async () => {
	const res = await login("100.70.0.3", PASSWORD, "/chat/new");
	assert.equal(res.status, 303);
	assert.equal(res.headers.location, "/chat/new");
	const set = [res.headers["set-cookie"]].flat().join("\n");
	assert.match(set, /HttpOnly/);
	assert.match(set, /SameSite=Lax/);
	assert.match(set, /Secure/, "serve terminates TLS, so the cookie is Secure");
	const cookie = cookieOf(res);
	const phone = (extra: Record<string, string> = {}) => viaServe("100.70.0.3", { cookie, origin: `https://${TS_HOST}`, ...extra });
	assert.equal((await raw("/api/settings", { headers: phone() })).status, 200);
	assert.equal((await raw("/chat/new", { headers: phone() })).status, 200);
	assert.equal(JSON.parse((await raw("/api/remote-access", { headers: phone() })).body).access, "session");
	assert.equal((await remoteAccess(phone({ "x-lh-access": "desktop" }), "PUT", { password: "attacker-chosen" })).status, 403, "no current password, even claiming the desktop");
	assert.equal((await remoteAccess(phone(), "PUT", { password: "attacker-chosen", current: "a guess" })).status, 403);
	assert.equal((await remoteAccess(phone({ origin: "null" }), "PUT", { password: "attacker-chosen", current: PASSWORD })).status, 403, "cross-site");
	assert.equal((await raw("/api/settings", { headers: phone() })).status, 200, "the password did not change");
});

test("(d) headless Chrome on the tailnet logs in through the login page, uses the app, and logs out", async () => {
	const chrome = await launchChrome(TICKET, [`--host-resolver-rules=MAP ${TS_HOST} 127.0.0.1`, "--no-proxy-server"]);
	try {
		const page = await chrome.browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });
		const origin = `http://${TS_HOST}:${port}`;
		await page.goto(`${origin}/chat/new`, { waitUntil: "domcontentloaded", timeout: 120_000 });
		assert.equal(new URL(page.url()).pathname, "/login");
		await page.type("#password", "not it");
		await Promise.all([page.waitForNavigation({ timeout: 120_000 }), page.click("button[type=submit]")]);
		assert.match(await page.content(), /Wrong password/);
		await page.type("#password", PASSWORD);
		await Promise.all([page.waitForNavigation({ timeout: 120_000 }), page.click("button[type=submit]")]);
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

test("(e) logout is same-origin only and revokes the session; a password change or turning access off revokes them all", async () => {
	const first = cookieOf(await login("100.70.0.5", PASSWORD));
	const as = (cookie: string, extra: Record<string, string> = {}) => viaServe("100.70.0.5", { cookie, ...extra });
	assert.equal((await raw("/logout", { method: "POST", headers: as(first, { origin: "null" }) })).status, 403);
	assert.equal((await raw("/logout", { method: "POST", headers: as(first, { "sec-fetch-site": "cross-site" }) })).status, 403);
	assert.equal((await raw("/api/settings", { headers: as(first) })).status, 200, "another site could not log it out");
	const out = await raw("/logout", { method: "POST", headers: as(first, { origin: `https://${TS_HOST}` }) });
	assert.equal(out.status, 303);
	assert.equal(out.headers.location, "/login");
	assert.match([out.headers["set-cookie"]].flat().join("\n"), /lh_session=;.*Max-Age=0/);
	assert.equal((await raw("/api/settings", { headers: as(first) })).status, 401);

	const second = cookieOf(await login("100.70.0.6", PASSWORD));
	const third = cookieOf(await login("100.70.0.6", PASSWORD));
	assert.equal((await remoteAccess(as(second), "PUT", { password: NEW_PASSWORD, current: PASSWORD })).status, 200);
	assert.equal((await raw("/api/settings", { headers: as(second) })).status, 401, "the changer logs in again too");
	assert.equal((await raw("/api/settings", { headers: as(third) })).status, 401, "a password change logs every device out");

	const fourth = cookieOf(await login("100.70.0.7", NEW_PASSWORD));
	assert.equal((await remoteAccess(as(fourth), "DELETE", {})).status, 403, "turning it off needs the current password");
	assert.equal((await remoteAccess(as(fourth), "DELETE", { current: NEW_PASSWORD })).status, 200);
	assert.equal((await raw("/api/settings", { headers: as(fourth) })).status, 401, "turning remote access off ends every session");
	assert.equal((await raw("/api/settings", { headers: local() })).status, 200, "and this computer is back to no login");
	assert.equal(cli(["set-password", "--stdin"], `${PASSWORD}\n`).status, 0);
});

test("(e) this computer's own browser logs in too, and changes the password in Settings with the current one", async () => {
	const chrome = await launchChrome(TICKET, ["--no-proxy-server"]);
	try {
		const page = await chrome.browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });
		await page.goto(`${server.url}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
		assert.equal(new URL(page.url()).pathname, "/login", "loopback is no exception once a password exists");
		await page.type("#password", PASSWORD);
		await Promise.all([page.waitForNavigation({ timeout: 120_000 }), page.click("button[type=submit]")]);
		await openGeneralSettings(page);
		await page.waitForSelector('[data-testid="remote-access-command"]', { timeout: 60_000 });
		assert.equal(await page.$eval('[data-testid="remote-access-command"]', (el) => el.textContent), `tailscale serve --bg ${port}`);
		assert.match(await page.$eval('[data-testid="remote-access-url"]', (el) => el.textContent ?? ""), /<this-computer>/, "no tailscale here: the placeholder");
		await page.type('[data-testid="remote-access-current"]', PASSWORD);
		await page.type('[data-testid="remote-access-password"]', NEW_PASSWORD);
		await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click('[data-testid="remote-access-save"]')]);
		assert.equal(new URL(page.url()).pathname, "/login", "saving logged this browser out with every other");
	} finally {
		await chrome.close();
	}
	assert.equal((await login("100.70.0.11", PASSWORD)).status, 401);
	assert.equal((await login("100.70.0.11", NEW_PASSWORD)).status, 303);
	assert.equal(cli(["set-password", "--stdin"], `${PASSWORD}\n`).status, 0);
});

test("(g) SSE, the turn stream, the chat export and attachments need the session too", async () => {
	const routes = ["/api/events", `/api/chats/${chatId}/stream`, `/api/chats/${chatId}/markdown`, "/api/attachments/0000", `/api/attachments?check=1&chatId=${chatId}`];
	for (const route of routes) {
		assert.equal((await raw(route, { headers: viaServe(), headOnly: true })).status, 401, route);
		assert.equal((await raw(route, { headers: local(), headOnly: true })).status, 401, `${route} from loopback`);
	}
	assert.equal((await raw("/api/attachments", { method: "POST", headers: local() })).status, 401);
	const cookie = cookieOf(await login("100.70.0.8", PASSWORD));
	const events = await raw("/api/events", { headers: viaServe("100.70.0.8", { cookie }), headOnly: true });
	assert.equal(events.status, 200);
	assert.match(events.headers["content-type"] ?? "", /text\/event-stream/);
	const md = await raw(`/api/chats/${chatId}/markdown`, { headers: viaServe("100.70.0.8", { cookie }) });
	assert.equal(md.status, 200);
	assert.match(String(md.headers["content-disposition"]), /attachment/);
	assert.equal((await raw(`/api/chats/${chatId}/stream`, { headers: viaServe("100.70.0.8", { cookie }), headOnly: true })).status, 200);
	assert.notEqual((await raw("/api/attachments/0000", { headers: viaServe("100.70.0.8", { cookie }) })).status, 401);
});

test("(f) the launcher listens only on 127.0.0.1: no other address, no -H/-p, and no dev server behind tailscale serve", () => {
	// Every case is refused before `next` is spawned, so nothing ever listens.
	const launch = (args: string[], env: Record<string, string> = {}) =>
		spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "web-server.mjs"), "start", ...args], {
			env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", LH_LISTEN_PORT: "1", ...env },
			encoding: "utf8",
			timeout: 30_000,
		});
	for (const args of [["-H", "0.0.0.0"], ["-H0.0.0.0"], ["--hostname", "0.0.0.0"], ["--hostname=::"], ["-p", "80"], ["-p80"], ["--port", "80"], ["--port=80"]]) {
		const run = launch(args);
		assert.equal(run.status, 78, `${args.join(" ")}: ${run.stderr}`);
		assert.match(run.stderr, /set by LearnHarness/);
	}
	for (const host of ["0.0.0.0", "::", "100.100.100.100", "fd7a:115c:a1e0::1", "192.168.1.20", "my-laptop.local"]) {
		const run = launch([], { LH_LISTEN_HOST: host });
		assert.equal(run.status, 78, `${host}: ${run.stderr}`);
		assert.match(run.stderr, /only listens on 127\.0\.0\.1/);
	}
	// `dev` never starts on a port tailscale serve forwards (its /__nextjs_* tools skip the login).
	const dir = fs.mkdtempSync(path.join(path.dirname(server.dataDir), "ts-"));
	const fake = path.join(dir, "tailscale");
	fs.writeFileSync(fake, `#!/bin/sh\necho '{"Web":{"${TS_HOST}:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3911"}}}}}'\n`, { mode: 0o755 });
	const dev = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "web-server.mjs"), "dev"], {
		env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", LH_LISTEN_PORT: "3911", LH_TAILSCALE_BIN: fake },
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(dev.status, 78, dev.stderr);
	assert.match(dev.stderr, /development server must never be on your tailnet/);
});

test("the server log holds no password and no session token", async () => {
	await until(() => server.log().length > 0, "server output");
	assert(!server.log().includes(PASSWORD));
	assert(!server.log().includes(NEW_PASSWORD));
	assert(!/lh_session=[A-Za-z0-9_-]{20,}/.test(server.log()));
});
