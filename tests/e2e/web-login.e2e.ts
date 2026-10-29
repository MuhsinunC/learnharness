import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { bootServer, REPO_ROOT, until, type LhServer } from "./harness/server.ts";
import { launchChrome } from "./harness/chrome.ts";
import { API_ROUTES, routePath } from "../../src/server/desktop-access.ts";
import { PATH_COMPUTER_ONLY } from "../../src/core/remote-access.ts";

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

/** A login posted to this computer's own address, for a browser that then
 * opens server.url (a session works only on the Host it was issued for). */
function loginLocal(ip: string): Promise<RawResponse> {
	return raw("/login", {
		method: "POST",
		headers: local({ "content-type": "application/x-www-form-urlencoded", origin: server.url, "x-forwarded-for": ip }),
		body: new URLSearchParams({ password: PASSWORD, next: "/" }).toString(),
	});
}

/** CSRF: posts to /api/chats and /api/graph/import from other origins
 * (another server on 127.0.0.1 is the same site, so a session cookie goes
 * along) are refused before any route runs; the app's own page still gets
 * through. */
async function crossOriginRefused(headers: Record<string, string>, ownOrigin: string): Promise<void> {
	const send = (extra: Record<string, string>) => Promise.all([
		raw("/api/chats", { method: "POST", headers: { ...headers, ...JSON_BODY, ...extra }, body: JSON.stringify({ title: "Cross-origin" }) }),
		raw("/api/graph/import", { method: "POST", headers: { ...headers, "content-type": "multipart/form-data; boundary=lh43", ...extra }, body: "--lh43--\r\n" }),
	]);
	for (const extra of [{ origin: `http://127.0.0.1:${port + 1}` }, { origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }] as Array<Record<string, string>>) {
		for (const res of await send(extra)) {
			assert.equal(res.status, 403, JSON.stringify(extra));
			assert.deepEqual(JSON.parse(res.body), { error: "Change LearnHarness only from its own pages." }, JSON.stringify(extra));
		}
	}
	const [chat, graph] = await send({ origin: ownOrigin, "sec-fetch-site": "same-origin" });
	assert.equal(chat.status, 200, "the app's own page creates a chat");
	assert.equal(graph.status, 400, "and reaches the import route itself (no files)");
}

const CSRF_REFUSAL = { error: "Change LearnHarness only from its own pages." };

/** LH-60: reads too. Another page's GET is refused before the route runs
 * (/api/stt/token would mint a Deepgram token with the learner's key,
 * /api/models asks the subscription bridges), on every GET route; the
 * app's own page and a non-browser client (`headers` alone: no Origin, no
 * Sec-Fetch-Site) still reach the route. The harness has no Deepgram key,
 * so reaching the token route is its 503. */
async function crossSiteReadsRefused(headers: Record<string, string>, ownOrigin: string): Promise<void> {
	for (const route of ["/api/stt/token", "/api/models"]) {
		for (const extra of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "null" }, { origin: "https://evil.example" }] as Array<Record<string, string>>) {
			const res = await raw(route, { headers: { ...headers, ...extra } });
			assert.equal(res.status, 403, `${route} ${JSON.stringify(extra)}`);
			assert.deepEqual(JSON.parse(res.body), CSRF_REFUSAL, `${route} ${JSON.stringify(extra)}`);
		}
		for (const extra of [{ origin: ownOrigin, "sec-fetch-site": "same-origin" }, {}] as Array<Record<string, string>>) {
			const res = await raw(route, { headers: { ...headers, ...extra } });
			if (route === "/api/stt/token") {
				assert.equal(res.status, 503, `${route} ${JSON.stringify(extra)}: ${res.body}`);
				assert.match(JSON.parse(res.body).message, /No DEEPGRAM_API_KEY/);
			} else {
				assert.equal(res.status, 200, `${route} ${JSON.stringify(extra)}: ${res.body}`);
				assert(Array.isArray(JSON.parse(res.body).models), route);
			}
		}
	}
	const app = path.join(REPO_ROOT, "app");
	for (const route of Object.keys(API_ROUTES)) {
		if (!/export (?:const|async function|function) GET\b/.test(fs.readFileSync(path.join(app, route, "route.ts"), "utf8"))) continue;
		const res = await raw(route.replace(/\[[^\]]+\]/g, "x"), { headers: { ...headers, "sec-fetch-site": "cross-site" }, headOnly: true });
		assert.equal(res.status, 403, `GET ${route}`);
	}
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
	const pathRead = await raw("/api/attachments/file", { method: "POST", headers: { ...local(), ...JSON_BODY }, body: JSON.stringify({ path: "/nonexistent/lh-43.png" }) });
	assert(![401, 403].includes(pathRead.status), `without a password, host routes answer this computer as before (${pathRead.status})`);
	await crossOriginRefused(local(), server.url);
	await crossSiteReadsRefused(local(), server.url);

	// GET /api/claude-code runs the executable: no other page may make it, not even with a GET.
	// A stand-in on the server's own (harness) HOME records each run; the real claude is never found.
	const bin = path.join(path.dirname(server.dataDir), "home", ".local", "bin");
	const runs = path.join(path.dirname(server.dataDir), "claude-runs");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$*" >> '${runs}'\necho "2.0.0 (Claude Code)"\n`, { mode: 0o755 });
	try {
		// same-site first: another server on 127.0.0.1 (an <img> there sends no Origin).
		for (const extra of [{ "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }, { origin: `http://127.0.0.1:${port + 1}` }, { origin: "https://evil.example" }] as Array<Record<string, string>>) {
			const res = await raw("/api/claude-code", { headers: local(extra) });
			assert(!fs.existsSync(runs), `${JSON.stringify(extra)} made it run the executable`);
			assert.equal(res.status, 403, JSON.stringify(extra));
			assert.deepEqual(JSON.parse(res.body), { error: "Change LearnHarness only from its own pages." }, JSON.stringify(extra));
		}
		const own = await raw("/api/claude-code", { headers: local({ "sec-fetch-site": "same-origin" }) });
		assert.equal(own.status, 200, own.body);
		assert(fs.existsSync(runs), "the app's own page does run it (so the refusals above were real)");
	} finally {
		fs.rmSync(path.join(bin, "claude"), { force: true });
	}

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

test("(c) a login with the old password that races a password change gets no session", async () => {
	// Logins hash one at a time on the server; the CLI replaces the password
	// meanwhile, so the later ones finish against a record that moved on.
	// First of the (c) cases: two dozen logins in flight fit under the global
	// cap only before other tests have charged it.
	const done: number[] = [];
	const pending = Array.from({ length: 24 }, (_, i) => login(`100.70.4.${i}`, PASSWORD).then((res) => { done.push(Date.now()); return res; }));
	const changed = await new Promise<number>((resolve, reject) => {
		const child = spawn(TSX, [path.join(REPO_ROOT, "scripts", "remote-access.ts"), "set-password", "--stdin"], { cwd: REPO_ROOT, env: { ...process.env, LH_DATA_DIR: server.dataDir }, stdio: ["pipe", "ignore", "pipe"] });
		child.stdin.end(`${NEW_PASSWORD}\n`);
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve(Date.now()) : reject(new Error(`set-password exited ${code}`))));
	});
	const results = await Promise.all(pending);
	assert(done.some((t) => t > changed), "some logins finished after the password changed (the race ran)");
	for (const res of results) {
		assert([303, 401].includes(res.status), `${res.status}: ${res.body.slice(0, 300)}`);
		if (res.status === 401) assert.match(res.body, /Wrong password/);
		else assert.equal((await raw("/api/settings", { headers: viaServe("100.70.4.99", { cookie: cookieOf(res) }) })).status, 401, "a session from the old password does not survive the change");
	}
	assert.equal((await login("100.70.4.100", NEW_PASSWORD)).status, 303);
	assert.equal(cli(["set-password", "--stdin"], `${PASSWORD}\n`).status, 0);
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

test("(c) the limit goes by the address serve adds (rightmost X-Forwarded-For), so a rotating forged one gains nothing", async () => {
	for (let i = 0; i < 5; i++) assert.equal((await login(`203.0.113.${i}, 100.70.0.21`, "wrong password")).status, 401);
	const blocked = await login("198.51.100.7, 100.70.0.21", PASSWORD);
	assert.equal(blocked.status, 429, "five failures from one tailnet address, whatever was forged in front of it");
	assert.equal((await login("100.70.0.21, 100.70.0.22", PASSWORD)).status, 303, "the forged entry is not charged either");
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
		assert.equal((await raw("/api/settings", { headers: viaServe("100.70.0.4", { host: `${TS_HOST}:${port}`, cookie: `lh_session=${cookie.value}` }) })).status, 401, "the server revoked it, not only the browser");
	} finally {
		await chrome.close();
	}
});

const WEB_COMPUTER_ONLY = "Change this on the computer: run npm run remote-access:off, change it here, then set the password again.";
/** proxy.ts's refusal of a computer-only route to a session: a typed image path gets its own (LH-45). */
const computerOnly = (pathname: string) => ({ error: routePath(pathname) === "/api/attachments/file" ? PATH_COMPUTER_ONLY : WEB_COMPUTER_ONLY, computerOnly: true });

test("(h) with a password, a session cannot run binaries, read paths, move endpoints or sign in on the computer", async () => {
	const cookie = cookieOf(await login("100.70.0.12", PASSWORD));
	const session = { ...viaServe("100.70.0.12", { cookie, origin: `https://${TS_HOST}` }), ...JSON_BODY };
	const send = (pathname: string, method: string, body?: unknown) => raw(pathname, { method, headers: session, body: body === undefined ? undefined : JSON.stringify(body) });
	// Every one is refused by proxy.ts before its route runs, so no real `claude` is ever started.
	for (const [pathname, method, body] of [
		["/api/claude-code", "GET", undefined],
		["/api/claude-code", "PUT", { mode: "local", executable: "/bin/sh" }],
		["/api/claude-code", "PUT", { mode: "endpoint", baseUrl: "https://evil.example", token: "stolen" }],
		["/api/claude-code/endpoint", "DELETE", undefined],
		["/api/claude-code/login", "POST", {}],
		["/api/subscriptions", "GET", undefined],
		["/api/subscriptions", "POST", { providerId: "chatgpt", op: "login" }],
		["/api/subscriptions/browser?id=00000000-0000-0000-0000-000000000000", "GET", undefined],
		["/api/attachments/file", "POST", { path: "/etc/hosts" }],
		["/api/claude-cod%65", "GET", undefined],
		["/api/attachments/fil%65", "POST", { path: "/etc/hosts" }],
	] as const) {
		const res = await send(pathname, method, body);
		assert.equal(res.status, 403, `${method} ${pathname}`);
		assert.deepEqual(JSON.parse(res.body), computerOnly(pathname), `${method} ${pathname}`);
	}
	assert.equal((await send("/api/keys", "GET")).status, 200, "key status stays readable");
	assert.equal((await send("/api/chats", "POST", { title: "From a session" })).status, 200);
	assert.equal((await send("/api/settings/general", "PUT", { autoUpdate: true })).status, 200);

	const chrome = await launchChrome(TICKET, ["--no-proxy-server"]);
	try {
		const page = await chrome.browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });
		await page.setCookie({ name: "lh_session", value: cookieOf(await loginLocal("100.70.0.12")).split("=")[1]!, url: server.url });
		await page.goto(`${server.url}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
		await until(async () => {
			await page.click('[data-testid="settings-entry"]');
			return page.waitForSelector('[data-testid="settings-nav-keys"]', { timeout: 2000 });
		}, "the settings dialog to open", 120_000, 500);
		await page.click('[data-testid="settings-nav-keys"]');
		await page.waitForSelector('[data-testid="connections-computer-only"]', { timeout: 60_000 });
		assert.equal(await page.$eval('[data-testid="connections-computer-only"]', (el) => el.textContent), WEB_COMPUTER_ONLY);
		assert.equal(await page.$('[data-testid="keys-computer-only"]'), null, "keys stay editable in web mode, with the password");
		assert.equal(await page.$('[data-testid="claude-code-connection"]'), null);
	} finally {
		await chrome.close();
	}
});

test("(h) in web mode a session changes a key only with the current password, charged to that device", async () => {
	const keyWrite = (ip: string, method: "PUT" | "DELETE", password?: string) => {
		const cookieFor = sessions.get(ip)!;
		return raw("/api/keys/OPENROUTER_API_KEY", {
			method,
			headers: { ...viaServe(ip, { cookie: cookieFor, origin: `https://${TS_HOST}` }), ...JSON_BODY, ...(password === undefined ? {} : { "x-lh-current-password": encodeURIComponent(password) }) },
			body: method === "PUT" ? JSON.stringify({ value: "e2e-dummy-key-not-real" }) : undefined,
		});
	};
	const sessions = new Map<string, string>();
	for (const ip of ["100.70.0.13", "100.70.0.14"]) sessions.set(ip, cookieOf(await login(ip, PASSWORD)));

	for (const method of ["PUT", "DELETE"] as const) {
		const res = await keyWrite("100.70.0.13", method);
		assert.equal(res.status, 403, `${method} with no password`);
		assert.equal(JSON.parse(res.body).passwordRequired, true);
	}
	for (let i = 0; i < 5; i++) {
		const res = await keyWrite("100.70.0.13", "PUT", "not the password");
		assert.equal(res.status, 403);
		assert.equal(JSON.parse(res.body).passwordRequired, true);
	}
	assert.equal((await keyWrite("100.70.0.13", "PUT", PASSWORD)).status, 429, "the five wrong passwords were charged to this client");
	assert.equal((await keyWrite("100.70.0.14", "PUT", PASSWORD)).status, 200);
	assert.equal((await keyWrite("100.70.0.14", "DELETE", PASSWORD)).status, 200);
	assert.equal((await keyWrite("100.70.0.14", "PUT", PASSWORD)).status, 200);

	// The Providers row asks for the password beside the key, then saves.
	const chrome = await launchChrome(TICKET, ["--no-proxy-server"]);
	try {
		const page = await chrome.browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });
		await page.setCookie({ name: "lh_session", value: cookieOf(await loginLocal("100.70.0.15")).split("=")[1]!, url: server.url });
		await page.goto(`${server.url}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
		await until(async () => {
			await page.click('[data-testid="settings-entry"]');
			return page.waitForSelector('[data-testid="settings-nav-keys"]', { timeout: 2000 });
		}, "the settings dialog to open", 120_000, 500);
		await page.click('[data-testid="settings-nav-keys"]');
		const row = "key-openrouter_api_key";
		await page.waitForSelector(`[data-testid="${row}-row"]`, { timeout: 60_000 });
		await page.click(`[data-testid="${row}-row"]`);
		await page.waitForSelector(`[data-testid="${row}-password"]`, { timeout: 60_000 });
		await page.type(`[data-testid="${row}-input"]`, "e2e-dummy-key-from-the-ui-WXYZ");
		assert.equal(await page.$eval(`[data-testid="${row}-save"]`, (el) => (el as HTMLButtonElement).disabled), true, "Save waits for the password");
		await page.type(`[data-testid="${row}-password"]`, PASSWORD);
		await page.click(`[data-testid="${row}-save"]`);
		await until(async () => {
			const keys = JSON.parse((await raw("/api/keys", { headers: viaServe("100.70.0.15", { cookie: sessions.get("100.70.0.14")! }) })).body) as { keys: Array<{ id: string; masked: string | null }> };
			return keys.keys.find((k) => k.id === "OPENROUTER_API_KEY")?.masked?.includes("WXYZ");
		}, "the key saved from the UI", 30_000);
	} finally {
		await chrome.close();
	}
	assert.equal((await keyWrite("100.70.0.14", "DELETE", PASSWORD)).status, 200);
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
	assert.equal((await raw("/api/settings/models", { headers: local() })).status, 401);
	assert.equal((await raw("/api/chat", { method: "POST", headers: { ...local(), ...JSON_BODY }, body: JSON.stringify({ chatId, input: { type: "text", text: "hi" } }) })).status, 401, "spending routes too");
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

test("(h) a session gets five wrong passwords beside keys whatever address it claims; other devices and logins are unaffected", async () => {
	for (let device = 0; device < 6; device++) {
		const cookie = cookieOf(await login(`100.70.0.${40 + device}`, PASSWORD));
		// Each try claims a new address: a forged X-Forwarded-For buys nothing.
		const keyWrite = (i: number) => raw("/api/keys/OPENROUTER_API_KEY", {
			method: "PUT",
			headers: { ...viaServe(`198.51.${device}.${i}`, { cookie, origin: `https://${TS_HOST}` }), ...JSON_BODY, "x-lh-current-password": "not the password" },
			body: JSON.stringify({ value: "e2e-dummy-key-not-real" }),
		});
		for (let i = 0; i < 5; i++) assert.equal((await keyWrite(i)).status, 403, `device ${device}, try ${i}`);
		assert.equal((await keyWrite(5)).status, 429, `device ${device}'s session is locked out`);
	}
	assert.equal((await login("100.70.0.31", PASSWORD)).status, 303, "thirty failures beside keys did not lock new logins out");
});

test("(h) the same holds for wrong current passwords when changing remote access", async () => {
	for (let device = 0; device < 6; device++) {
		const cookie = cookieOf(await login(`100.70.0.${50 + device}`, PASSWORD));
		const change = (i: number) => remoteAccess(viaServe(`198.51.${10 + device}.${i}`, { cookie, origin: `https://${TS_HOST}` }), i % 2 ? "DELETE" : "PUT", i % 2 ? { current: "not the password" } : { password: "attacker-chosen", current: "not the password" });
		for (let i = 0; i < 5; i++) assert.equal((await change(i)).status, 403, `device ${device}, try ${i}`);
		assert.equal((await change(6)).status, 429, `device ${device}'s session is locked out`);
	}
	const cookie = cookieOf(await login("100.70.0.33", PASSWORD));
	assert.equal((await raw("/api/settings", { headers: viaServe("100.70.0.33", { cookie }) })).status, 200, "logins still work, and the password never changed");
});

test("(i) a session works only through the Host it was issued for", async () => {
	const phone = cookieOf(await login("100.70.0.16", PASSWORD));
	const laptop = cookieOf(await loginLocal("100.70.0.16"));
	assert.equal((await raw("/api/settings", { headers: viaServe("100.70.0.16", { cookie: phone }) })).status, 200);
	assert.equal((await raw("/api/settings", { headers: local({ cookie: laptop }) })).status, 200);
	for (const [label, headers] of [
		["the phone's cookie on 127.0.0.1", local({ cookie: phone })],
		["the laptop's cookie through ts.net", viaServe("100.70.0.16", { cookie: laptop })],
		["the laptop's cookie through ts.net with a port", viaServe("100.70.0.16", { host: `${TS_HOST}:${port}`, cookie: laptop })],
		["the laptop's cookie as localhost", { host: `localhost:${port}`, cookie: laptop }],
		["the laptop's cookie from another loopback port", { host: `127.0.0.1:${port + 1}`, cookie: laptop }],
	] as Array<[string, Record<string, string>]>) {
		assert.equal((await raw("/api/settings", { headers })).status, 401, label);
	}
});

test("(i) encoded and odd spellings of /api get the API's refusal, never the route", async () => {
	for (const spelling of ["/%61pi/chat", "/%61pi/claude-code", "/%61pi/remote-access", "/%2561pi/settings", "/API/settings", "/api%2Fsettings"]) {
		for (const headers of [local(), viaServe("100.70.0.17")]) {
			const res = await raw(spelling, { headers });
			assert.equal(res.status, 401, `${spelling} ${headers.host}`);
			assert.deepEqual(JSON.parse(res.body), { error: "Log in to LearnHarness first." }, spelling);
		}
	}
	const cookie = cookieOf(await login("100.70.0.17", PASSWORD));
	for (const spelling of ["/%61pi/claude-code", "/%41PI/Claude-Code", "/api/claude%2Dcode", "/%61pi/subscriptions/browser", "/api/attachments/%66ile"]) {
		const res = await raw(spelling, { method: "POST", headers: { ...viaServe("100.70.0.17", { cookie, origin: `https://${TS_HOST}` }), ...JSON_BODY }, body: "{}" });
		assert.equal(res.status, 403, spelling);
		assert.deepEqual(JSON.parse(res.body), computerOnly(spelling), spelling);
	}
	// A spelling no route in API_ROUTES fits is refused to a session, never passed on.
	for (const spelling of ["/api/claude-code-x", "/api/keys/a/b", "/api/nope", "/apix/settings", "/api"]) {
		const res = await raw(spelling, { headers: viaServe("100.70.0.17", { cookie }) });
		assert.equal(res.status, 404, spelling);
		assert.deepEqual(JSON.parse(res.body), { error: "No such API route." }, spelling);
	}
	// Next redirects these to the plain path before the gate, which then applies.
	for (const spelling of ["/api/claude-code/", "//api/claude-code", "/api\\claude-code"]) {
		const res = await raw(spelling, { headers: viaServe("100.70.0.17", { cookie }) });
		assert.equal(res.status, 308, spelling);
		assert.equal(res.headers.location, "/api/claude-code", spelling);
	}
});

test("(i) every API route is classified, and a session reaches none of the computer-only ones", async () => {
	const app = path.join(REPO_ROOT, "app");
	const routes: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) walk(path.join(dir, entry.name));
			else if (/^route\.(ts|tsx|js|mjs)$/.test(entry.name)) routes.push(`/${path.relative(app, dir).split(path.sep).join("/")}`);
		}
	};
	walk(path.join(app, "api"));
	assert(routes.length > 30);
	assert.deepEqual(routes.sort(), Object.keys(API_ROUTES).sort(), "classify every app/api route in API_ROUTES (src/server/desktop-access.ts)");

	const cookie = cookieOf(await login("100.70.0.18", PASSWORD));
	for (const [route, kind] of Object.entries(API_ROUTES)) {
		if (kind !== "computer") continue;
		const source = fs.readFileSync(path.join(app, route, "route.ts"), "utf8");
		const methods = [...source.matchAll(/export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!);
		assert(methods.length > 0, route);
		for (const method of methods) {
			const res = await raw(route.replace(/\[[^\]]+\]/g, "x"), { method, headers: { ...viaServe("100.70.0.18", { cookie, origin: `https://${TS_HOST}` }), ...JSON_BODY }, body: method === "GET" ? undefined : "{}" });
			assert.equal(res.status, 403, `${method} ${route}`);
			assert.deepEqual(JSON.parse(res.body), computerOnly(route), `${method} ${route}`);
		}
	}
});

test("(i) cross-origin posts and reads are refused with a session cookie too", async () => {
	const cookie = cookieOf(await login("100.70.0.19", PASSWORD));
	await crossOriginRefused(viaServe("100.70.0.19", { cookie }), `https://${TS_HOST}`);
	await crossSiteReadsRefused(viaServe("100.70.0.19", { cookie }), `https://${TS_HOST}`);
	const laptop = cookieOf(await loginLocal("100.70.0.19"));
	await crossOriginRefused(local({ cookie: laptop }), server.url);
	await crossSiteReadsRefused(local({ cookie: laptop }), server.url);
	// Without the cookie a non-browser read is a 401, as every request is once a password exists.
	assert.equal((await raw("/api/models", { headers: local() })).status, 401);
});

test("(c) a login that races turning remote access off gets the off page, never a 500", async () => {
	// Logins hash one at a time: the later ones finish after the record is gone.
	const pending = Array.from({ length: 6 }, (_, i) => login(`100.70.2.${i}`, PASSWORD));
	await Promise.race(pending);
	fs.rmSync(path.join(server.dataDir, "web-login.json"));
	const results = await Promise.all(pending);
	for (const res of results) {
		assert([303, 403].includes(res.status), `${res.status}: ${res.body.slice(0, 300)}`);
		if (res.status === 403) assert.match(res.body, /Remote access is off/);
	}
	assert(results.some((res) => res.status === 403), "a login finished after the password was gone");
	assert.equal(cli(["set-password", "--stdin"], `${PASSWORD}\n`).status, 0);
});

test("(j) the installable-app files load without a login; nothing near them does", async () => {
	// Browsers fetch the manifest and icons without cookies (LH-46's files).
	for (const asset of ["/manifest.webmanifest", "/apple-icon.png?a1b2c3", "/pwa/icon-192.png", "/pwa/icon-512.png", "/pwa/icon-maskable-512.png"]) {
		for (const method of ["GET", "HEAD"]) {
			for (const headers of [viaServe("100.70.0.23"), local()]) {
				const res = await raw(asset, { method, headers });
				assert(![303, 401].includes(res.status), `${method} ${asset} must not need a login (${res.status} ${res.headers.location ?? ""})`);
				assert(!res.body.includes(chatId) && !res.body.includes("Remote"), `${asset}: the pass-through renders no app data`);
			}
		}
	}
	for (const [method, near] of [
		["POST", "/manifest.webmanifest"],
		["GET", "/manifest.webmanifest.json"],
		["GET", "/apple-icon.png/x"],
		["GET", "/pwa"],
		["GET", "/pwa/anything"],
		["GET", "/pwa/icon-192.png/x"],
		["HEAD", "/pwa/icon-1024.png"],
		["GET", "/pwa/../chat/new"],
		["GET", "/pwa/%2e%2e/chat/new"],
		["GET", "/pwa/..%2Fchat/new"],
		["GET", "/%70wa/icon-192.png"],
		["GET", "/PWA/icon-192.png"],
		["GET", "/pwa-x/icon.png"],
	] as const) {
		const res = await raw(near, { method, headers: viaServe("100.70.0.23") });
		assert.equal(res.status, 303, `${method} ${near} still needs a login`);
		assert.match(res.headers.location ?? "", /^\/login\?next=/, near);
	}
	// iOS standalone: the wall, its form and its redirect stay same-origin, under /, in the same window.
	const wall = await raw("/chat/new", { headers: viaServe("100.70.0.23") });
	assert.equal(wall.headers.location, "/login?next=%2Fchat%2Fnew");
	const page = (await raw("/login?next=%2Fchat%2Fnew", { headers: viaServe("100.70.0.23") })).body;
	assert.match(page, /<form method="post" action="\/login">/);
	assert.doesNotMatch(page, /target=|https?:\/\//, "no new window and no absolute URL on the login page");
	const res = await login("100.70.0.23", PASSWORD, "/chat/new");
	assert.equal(res.status, 303);
	assert.equal(res.headers.location, "/chat/new", "a relative redirect back into the app");
});

test("the server log holds no password and no session token", async () => {
	await until(() => server.log().length > 0, "server output");
	assert(!server.log().includes(PASSWORD));
	assert(!server.log().includes(NEW_PASSWORD));
	assert(!/lh_session=[A-Za-z0-9_-]{20,}/.test(server.log()));
});
