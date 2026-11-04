import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { bootServer, REPO_ROOT, until, type LhServer } from "./harness/server.ts";
import { hydrated, launchChrome, type HeadlessChrome } from "./harness/chrome.ts";
import { reply, startStubProvider, type StubProvider } from "./harness/stub-provider.ts";
import { png } from "./harness/png.ts";
import { PATH_COMPUTER_ONLY } from "../../src/core/remote-access.ts";
import { desktopPageKey } from "../../src/server/desktop-access.ts";

// LH-45: the paths that went through Electron's bridge, used from a plain
// browser (headless Chrome: no window.lh). Each one either works through
// the server or says why it can't; none fails silently.
//   - ChatGPT: a sign-in change made through the server's own owner
//     reaches the open page's model catalog without a reload. In a browser
//     the root that refreshes it is NativeSubscriptionUIProvider (the web
//     bridge hears the server's subscriptions-changed for every provider,
//     ChatGPT included); the sidebar's own refresh is the Electron one.
//   - The desktop app's server, opened in a browser before any password:
//     the login page says to use the desktop window, instead of an app
//     whose every API call is refused.
//   - Images in a logged-in browser: a picker uploads them, a photo with
//     no type too; a typed path (read on the computer, so LH-43 keeps it
//     from a session) says so, and asks the server only once.

const TICKET = "lh-45";
const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

async function chrome(): Promise<HeadlessChrome> {
	const c = await launchChrome(TICKET, ["--no-proxy-server"]);
	cleanups.push(() => c.close());
	return c;
}

async function boot(options: Parameters<typeof bootServer>[0]): Promise<LhServer> {
	const server = await bootServer(options);
	cleanups.push(() => server.stop());
	return server;
}

const COMPOSER = "[data-testid=composer] textarea";

test("a ChatGPT sign-out made through the server reaches the open page's models without a reload", async () => {
	const MODEL = "gpt-5";
	const stub: StubProvider = await startStubProvider(() => reply.text("ok"), { chatgptModels: [{ slug: MODEL, display_name: "GPT-5", visibility: "list" }] });
	cleanups.push(() => stub.close());
	// A saved ChatGPT account with no refresh token: nothing ever reaches
	// auth.openai.com, not even the sign-out's revocation.
	fs.mkdirSync(path.join(os.homedir(), ".cache", "lh-e2e"), { recursive: true });
	const authDir = fs.mkdtempSync(path.join(os.homedir(), ".cache", "lh-e2e", `${TICKET}-auth-`));
	cleanups.push(() => fs.rmSync(authDir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(authDir, "auth.json"), "{}", { mode: 0o600 });
	fs.writeFileSync(path.join(authDir, "chatgpt-credentials.json"), JSON.stringify({
		version: 1,
		hostId: `urn:uuid:${randomUUID()}`,
		activeId: "e2e-account",
		allowBackgroundUse: true,
		registrations: [{
			id: "e2e-account", clientId: "e2e-client", issuer: "https://auth.openai.com", subject: "e2e-subject", email: "learner@example.invalid",
			tokens: { accessToken: "e2e-dummy-access-not-real", idToken: "e2e.dummy.id", expiresAt: Date.now() + 30 * 86_400_000,
				scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"] },
		}],
	}), { mode: 0o600 });
	const slot = { model: { provider: "chatgpt", id: MODEL } };
	const server = await boot({
		ticket: TICKET,
		providers: [],
		settings: { version: 1, models: { strong: slot, cheap: slot, vision: slot }, graph: { enabled: false } },
		env: { LH_AUTH_FILE: path.join(authDir, "auth.json"), LH_E2E_CHATGPT_BASE_URL: stub.baseUrl },
	});

	const page = await (await chrome()).browser.newPage();
	await page.setViewport({ width: 1280, height: 800 });
	const catalogRead = page.waitForResponse(async (r) => new URL(r.url()).pathname === "/api/models" && r.ok() && (await r.text()).includes(`"${MODEL}"`), { timeout: 180_000 });
	await page.goto(`${server.url}/chat/new`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	await hydrated(page, COMPOSER);
	assert.equal(await page.evaluate(() => "lh" in window), false, "a plain browser: no Electron bridge");
	// Signed in: the catalog has ChatGPT, so no "add a key" pill.
	await catalogRead;
	await new Promise((resolve) => setTimeout(resolve, 1000));
	assert.equal(await page.$("[data-testid=setup-cta-keys]"), null);
	await page.evaluate(() => { (window as unknown as { lhNoReload: boolean }).lhNoReload = true; });

	// Another tab (or device) signs out, through the server's controls.
	const res = await fetch(`${server.url}/api/subscriptions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-learnharness-subscriptions": "1", origin: server.url },
		body: JSON.stringify({ providerId: "chatgpt", op: "logout", id: "e2e-account" }),
	});
	assert.equal(res.status, 200, await res.clone().text());

	await page.waitForSelector("[data-testid=setup-cta-keys]", { timeout: 60_000 });
	assert.equal(await page.evaluate(() => (window as unknown as { lhNoReload?: boolean }).lhNoReload), true, "the same page, never reloaded");
});

test("the desktop app's server in a plain browser gets the login page, which says to use the window; the window still opens the app", async () => {
	const secret = randomBytes(32).toString("hex");
	const server = await boot({
		ticket: TICKET,
		providers: [],
		settings: { version: 1, graph: { enabled: false } },
		headers: { "x-learnharness-desktop": secret },
		env: { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret, LH_TAILSCALE_BIN: "/nonexistent/tailscale" },
	});
	const browser = (await chrome()).browser;

	// No password yet: before LH-45 this page loaded and then broke on the
	// first refused API call ("This page couldn't load").
	const plain = await browser.newPage();
	await plain.setViewport({ width: 390, height: 844 });
	await plain.goto(`${server.url}/chat/new`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	assert.equal(new URL(plain.url()).pathname, "/login");
	assert.match(await plain.evaluate(() => document.body.innerText), /This is the LearnHarness desktop app: use it in its own window\. To use it from a browser too, set a password in the desktop app/);

	// The window: main.cjs gives its pages the lh_desktop cookie and its API
	// calls the secret header.
	const window = await browser.newPage();
	await window.setViewport({ width: 1280, height: 800 });
	await window.setCookie({ name: "lh_desktop", value: desktopPageKey(secret), url: server.url, httpOnly: true, sameSite: "Strict" });
	await window.setExtraHTTPHeaders({ "x-learnharness-desktop": secret });
	await window.goto(`${server.url}/chat/new`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	assert.equal(new URL(window.url()).pathname, "/chat/new");
	await hydrated(window, COMPOSER);
});

test("a logged-in browser attaches images with the picker; a typed path says it can't be read from there", async () => {
	const stub: StubProvider = await startStubProvider(() => reply.text("I see it."));
	cleanups.push(() => stub.close());
	const slot = { model: { provider: "e2e-stub", id: "vision-a" } };
	const server = await boot({
		ticket: TICKET,
		providers: [{ id: "e2e-stub", baseUrl: stub.baseUrl, models: [{ id: "vision-a", input: ["text", "image"] }] }],
		settings: { version: 1, models: { strong: slot, cheap: slot, vision: slot }, graph: { enabled: false } },
		env: { LH_TAILSCALE_BIN: "/nonexistent/tailscale" },
	});
	const { id: chatId } = await server.json<{ id: string }>("/api/chats", { body: { title: "Images from a phone" } });
	const PASSWORD = "phone picker password";
	const set = spawnSync(path.join(REPO_ROOT, "node_modules", ".bin", "tsx"), [path.join(REPO_ROOT, "scripts", "remote-access.ts"), "set-password", "--stdin"], {
		cwd: REPO_ROOT, input: `${PASSWORD}\n`, encoding: "utf8", timeout: 120_000, env: { ...process.env, LH_DATA_DIR: server.dataDir },
	});
	assert.equal(set.status, 0, set.stderr);
	const login = await fetch(`${server.url}/login`, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "application/x-www-form-urlencoded", origin: server.url },
		body: new URLSearchParams({ password: PASSWORD, next: "/" }).toString(),
	});
	const session = login.headers.getSetCookie().find((c) => c.startsWith("lh_session="))?.split(";")[0]?.split("=")[1];
	assert(session, `no session cookie (${login.status})`);

	const page = await (await chrome()).browser.newPage();
	await page.setViewport({ width: 390, height: 844 });
	await page.setCookie({ name: "lh_session", value: session, url: server.url });
	const intake: string[] = [];
	page.on("request", (r) => {
		const url = new URL(r.url());
		if (url.pathname.startsWith("/api/attachments")) intake.push(`${r.method()} ${url.pathname}`);
	});
	await page.goto(`${server.url}/chat/${chatId}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	await hydrated(page, COMPOSER);
	await until(async () => {
		const label = await page.$eval("[data-testid=stats-model]", (el) => el.textContent ?? "").catch(() => "");
		return label.trim().length > 1 && label.trim() !== "—";
	}, "the model control to load", 120_000);

	/** The chat once its `n`th user message has its reply and no turn runs. */
	const settled = (n: number) => until(async () => {
		const c = await fetch(`${server.url}/api/chats/${chatId}`, { headers: { cookie: `lh_session=${session}` } }).then((r) => r.json() as Promise<{ messages: Array<{ role: string; content?: unknown; attachments?: Array<{ id: string }> }>; turnInFlight: boolean }>);
		const user = c.messages.filter((m) => m.role === "user");
		return !c.turnInFlight && user.length === n && c.messages.at(-1)?.role === "assistant" ? user : null;
	}, `turn ${n} to settle`, 180_000);

	// The picker: real files chosen in the file dialog. A photo some
	// providers hand over with no type (here: no extension) is not dropped.
	const image = png(40, 120, 220), untyped = png(220, 120, 40);
	const file = path.join(path.dirname(server.dataDir), "from-the-phone.png");
	const bare = path.join(path.dirname(server.dataDir), "from-the-gallery");
	fs.writeFileSync(file, image);
	fs.writeFileSync(bare, untyped);
	await page.waitForSelector("[data-testid=attach-image]", { timeout: 30_000 });
	const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 30_000 }), page.click("[data-testid=attach-image]")]);
	await chooser.accept([file, bare]);
	await until(async () => (await page.$$("[data-testid=attachment-chip]")).length === 2 || null, "both picked images' chips", 30_000);
	await page.type(COMPOSER, "What is in these pictures?");
	await page.keyboard.press("Enter");
	const [sent] = await settled(1);
	assert.equal(sent!.attachments?.length, 2, "both picked images rode with the message");
	const stored = sent!.attachments!.map((a) => fs.readFileSync(path.join(server.dataDir, "attachments", a.id)).toString("hex")).sort();
	assert.deepEqual(stored, [image, untyped].map((b) => b.toString("hex")).sort(), "and the store holds their bytes");

	// A typed path: the server refuses it to a session, and the composer
	// says why, in the server's words; the next one is not asked again.
	for (const [n, text] of [[2, `And this one ${file}`], [3, `Or this one ${file}`]] as const) {
		await page.type(COMPOSER, text);
		await page.keyboard.press("Enter");
		const user = await settled(n);
		assert(JSON.stringify(user.at(-1)!.content).includes(text), "the path was sent as text");
		const notice = await until(() => page.$eval("[data-testid=attachment-notice]", (el) => el.textContent).catch(() => null), "the path notice", 30_000);
		assert.equal(notice, `${PATH_COMPUTER_ONLY} The path was sent as text.`);
	}
	assert.equal(intake.filter((r) => r === "POST /api/attachments/file").length, 1, "only the first path asked the server, which refused it");
});
