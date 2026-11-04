import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { Page } from "puppeteer-core";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { hydrated as reactHydrated, launchChrome, type HeadlessChrome } from "./harness/chrome.ts";
import { calledTool, reply, startStubProvider, type StubProvider } from "./harness/stub-provider.ts";

// LH-61: a Claude Code (subscription) selection that is off keeps v0.3.9's
// own flows: the pre-send picker, Retry and the refusal handling. The fork
// adds only what a subscription needs: the "Claude isn't turned on" notice
// where key setup would open, since a subscription has no key to add.
// "Off" means the claude-code provider is absent from the catalog. Claude
// Code is turned on here with a stand-in executable that only answers
// --version; no turn ever runs it.

const TICKET = "lh-61";
const stub = (id: string) => ({ model: { provider: "e2e-stub", id } });
const RETIRED = { model: { provider: "claude-code", id: "claude-retired-model" } };
const QUIZ = "[quiz-me]";
const PROBE = {
	question: "What is the limit of 1/x as x grows?",
	options: [{ label: "0", value: "a" }, { label: "1", value: "b" }],
	explanation: "1/x shrinks toward 0.",
	correctAnswer: "a",
};

let chrome: HeadlessChrome;
let provider: StubProvider;

before(async () => {
	// stub-fail answers like a provider outage, so a turn on it fails. A
	// transcript carrying QUIZ gets one probe question, which stays open.
	provider = await startStubProvider((req) => {
		if (req.model === "stub-fail") return reply.http(500, { error: { message: "upstream down" } });
		if (JSON.stringify(req.messages).includes(QUIZ) && !calledTool(req, "probe")) return reply.tools([{ name: "probe", arguments: PROBE }]);
		return reply.text("Hello.");
	});
	chrome = await launchChrome(TICKET);
});

after(async () => {
	await chrome?.close();
	await provider?.close();
});

/** The composer's text field: the shared Composer, or Home's own textarea. */
const FIELD = '[data-testid=composer] textarea, textarea[placeholder="What do you want to learn?"]';

async function hydrated(page: Page, pathname: string, server: LhServer): Promise<void> {
	await page.setViewport({ width: 1280, height: 800 });
	await page.goto(`${server.url}${pathname}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	await reactHydrated(page, FIELD);
	// The model control has read the session (or the Strong slot): the send guards key on it.
	await until(async () => {
		const label = await page.$eval("[data-testid=stats-model]", (el) => el.textContent ?? "").catch(() => "");
		return label.trim().length > 1 && label.trim() !== "—";
	}, "the model control to load", 120_000);
}

async function type(page: Page, text: string): Promise<void> {
	await page.type(FIELD, text);
	await page.keyboard.press("Enter");
}

const draft = (page: Page) => page.$eval(FIELD, (el) => (el as HTMLTextAreaElement).value);
const present = async (page: Page, selector: string) => (await page.$(selector)) !== null;
const sessions = async (server: LhServer) => (await server.json<{ chats: unknown[] }>("/api/chats")).chats.length;

async function userMessages(server: LhServer, id: string): Promise<number> {
	const chat = await server.json<{ messages: Array<{ role: string }> }>(`/api/chats/${id}`);
	return chat.messages.filter((m) => m.role === "user").length;
}

/** A stand-in Claude Code executable: it answers --version and nothing else. */
function standInClaude(server: LhServer): string {
	const claude = path.join(path.dirname(server.dataDir), "claude");
	fs.writeFileSync(claude, `#!/bin/sh\n[ "$1" = --version ] && echo "2.0.0 (Claude Code)" && exit 0\nexit 1\n`, { mode: 0o755 });
	return claude;
}

/** Claude Code on (the stand-in) or off, as the Settings card turns it: a
 *  same-origin PUT from the page, which the route requires for writes. */
async function setClaudeCode(page: Page, server: LhServer, claude: string, mode: "local" | "off"): Promise<void> {
	const body = JSON.stringify(mode === "off" ? { mode } : { mode, executable: claude });
	const res = await page.evaluate(async (body) => {
		const r = await fetch("/api/claude-code", { method: "PUT", headers: { "content-type": "application/json" }, body });
		return { status: r.status, text: await r.text() };
	}, body);
	assert.equal(res.status, 200, res.text);
	const catalog = await server.json<{ providers: Array<{ id: string }> }>("/api/models");
	assert.equal(catalog.providers.some((p) => p.id === "claude-code"), mode === "local", `Claude Code ${mode}`);
}

/** A session stamped with `model`, switched there through its settings route. */
async function sessionOn(server: LhServer, model: { provider: string; id: string }): Promise<string> {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Claude Code off" } });
	await server.json(`/api/chats/${id}/settings`, { method: "PUT", body: { model } });
	return id;
}

/** The first model Claude Code lists (it must be on). */
async function firstClaudeModel(server: LhServer): Promise<{ provider: string; id: string }> {
	const catalog = await server.json<{ models: Array<{ provider: string; id: string }> }>("/api/models");
	const model = catalog.models.find((m) => m.provider === "claude-code");
	assert(model, "Claude Code lists models");
	return { provider: model.provider, id: model.id };
}

describe("another provider is connected", () => {
	let server: LhServer;
	let page: Page;
	let claude: string;
	let claudeModel: { provider: string; id: string };
	const claudeCode = (mode: "local" | "off") => setClaudeCode(page, server, claude, mode);
	const chatOn = (model: { provider: string; id: string }) => sessionOn(server, model);

	before(async () => {
		server = await bootServer({
			ticket: TICKET,
			providers: [{ id: "e2e-stub", baseUrl: provider.baseUrl, models: [{ id: "stub-a" }, { id: "stub-fail" }] }],
			// Strong names a Claude Code model the catalog doesn't list (retired or renamed).
			settings: { version: 1, graph: { enabled: false }, models: { strong: RETIRED, cheap: stub("stub-a"), vision: stub("stub-a") } },
		});
		claude = standInClaude(server);
		page = await chrome.browser.newPage();
		await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 180_000 });
		await claudeCode("local");
		claudeModel = await firstClaudeModel(server);
	});

	after(async () => {
		await page?.close();
		await server?.stop();
	});

	test("with Claude Code on, a session on a model it no longer lists opens the picker and keeps the draft", async () => {
		// POST /api/chats stamps the Strong slot as it is: the retired id.
		const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Retired model" } });
		await hydrated(page, `/chat/${id}`, server);
		await type(page, "What is a limit?");
		await page.waitForSelector("[data-testid=model-search]", { timeout: 30_000 });
		assert.equal(await draft(page), "What is a limit?");
		assert.equal(await userMessages(server, id), 0, "nothing was sent");
		assert(!(await present(page, "[data-testid=claude-code-off-notice]")), "Claude Code is on: no off notice");
		assert(!(await present(page, "[data-testid=chat-error]")));
	});

	test("with Claude Code off, Home and the new-session page open v0.3.9's picker for an off Strong pin", async () => {
		const pinClaude = async () => {
			await claudeCode("local");
			await server.json("/api/settings/models", { method: "PUT", body: { strong: { model: claudeModel }, cheap: stub("stub-a"), vision: stub("stub-a") } });
			await claudeCode("off");
		};
		for (const pathname of ["/", "/chat/new"]) {
			await pinClaude();
			const before = await sessions(server);
			await hydrated(page, pathname, server);
			await type(page, "Limits");
			await page.waitForSelector("[data-testid=model-search]", { timeout: 30_000 });
			assert.equal(await draft(page), "Limits", pathname);
			assert.equal(await sessions(server), before, `${pathname}: no session was created`);
			// Picking another model clears the way: nothing is left to say.
			await page.type("[data-testid=model-search]", "stub-a");
			await page.click("[data-testid=model-option-stub-a]");
			await until(async () => (await page.$eval("[data-testid=stats-model]", (el) => el.textContent ?? "")).includes("stub-a"), "the stub-a pick");
			assert(!(await present(page, "[data-testid=claude-code-off-notice]")), pathname);
		}
	});

	test("with Claude Code off, a session on it opens the picker before sending", async () => {
		await claudeCode("local");
		const id = await chatOn(claudeModel);
		await claudeCode("off");
		await hydrated(page, `/chat/${id}`, server);
		await type(page, "Hello again");
		await page.waitForSelector("[data-testid=model-search]", { timeout: 30_000 });
		assert.equal(await draft(page), "Hello again");
		assert.equal(await userMessages(server, id), 0, "nothing was sent");
		assert(!(await present(page, "[data-testid=chat-error]")), "no refusal banner");
	});

	test("Retry after Claude Code went off opens the picker, and Retry on the picked model recovers the turn", async () => {
		const id = await chatOn(stub("stub-fail").model);
		const res = await server.api("/api/chat", { body: { chatId: id, input: { type: "text", text: "Teach me limits" } } });
		await res.arrayBuffer();
		await until(async () => !(await server.json<{ turnInFlight: boolean }>(`/api/chats/${id}`)).turnInFlight, "the failed turn to settle");
		await claudeCode("local");
		await server.json(`/api/chats/${id}/settings`, { method: "PUT", body: { model: claudeModel } });
		await claudeCode("off");
		await hydrated(page, `/chat/${id}`, server);
		await page.waitForSelector("[data-testid=retry-failed-turn]", { timeout: 30_000 });
		await page.click("[data-testid=retry-failed-turn]");
		await page.waitForSelector("[data-testid=model-search]", { timeout: 30_000 });
		// v0.3.9's refusal flow: the refusal itself never becomes the banner
		// (the record's own failure may come back, with its Retry).
		const banner = await page.$eval("[data-testid=chat-error]", (el) => el.textContent ?? "").catch(() => "");
		assert(!banner.includes("Claude") && !banner.includes("provider_key_missing"), banner);
		await page.type("[data-testid=model-search]", "stub-a");
		await page.click("[data-testid=model-option-stub-a]");
		await until(async () => (await page.$eval("[data-testid=stats-model]", (el) => el.textContent ?? "")).includes("stub-a"), "the stub-a pick");
		assert(!(await present(page, "[data-testid=claude-code-off-notice]")));
		await page.waitForSelector("[data-testid=retry-failed-turn]", { timeout: 30_000 });
		await page.click("[data-testid=retry-failed-turn]");
		await until(async () => {
			const chat = await server.json<{ turnInFlight: boolean; messages: Array<{ role: string; content?: unknown }> }>(`/api/chats/${id}`);
			return !chat.turnInFlight && JSON.stringify(chat.messages.at(-1)?.content ?? "").includes("Hello.");
		}, "the retried turn to answer on stub-a");
		await until(async () => !(await present(page, "[data-testid=chat-error]")), "the banner to go");
	});
});

describe("the catalog changed after the page loaded", () => {
	let server: LhServer;
	let page: Page;
	let claude: string;
	const openrouter = (id: string) => ({ model: { provider: "openrouter", id } });

	before(async () => {
		server = await bootServer({
			ticket: TICKET,
			// openrouter keeps its key gate; no key is saved yet.
			providers: [{ id: "openrouter", baseUrl: provider.baseUrl, models: [{ id: "or-a" }] }],
			settings: { version: 1, graph: { enabled: false }, models: { strong: openrouter("or-a"), cheap: openrouter("or-a"), vision: openrouter("or-a") } },
		});
		claude = standInClaude(server);
		page = await chrome.browser.newPage();
	});

	after(async () => {
		await page?.close();
		await server?.stop();
	});

	test("a Claude Code refusal decides from the refreshed catalog: the picker for a provider keyed since the load", async () => {
		await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 180_000 });
		await setClaudeCode(page, server, claude, "local");
		const id = await sessionOn(server, await firstClaudeModel(server));
		await hydrated(page, `/chat/${id}`, server);
		// The page's catalog: Claude Code on, openrouter without a key.
		let catalogReads = 0;
		page.on("request", (req) => { if (new URL(req.url()).pathname === "/api/models") catalogReads++; });
		// Behind the page's back: Claude Code goes off and openrouter gets a key.
		await setClaudeCode(page, server, claude, "off");
		await server.json("/api/keys/OPENROUTER_API_KEY", { method: "PUT", body: { value: "e2e-dummy-key-not-real" } });
		assert.equal(catalogReads, 0, "the page still holds the catalog it loaded");
		await type(page, "Hello there");
		await page.waitForSelector("[data-testid=model-search]", { timeout: 30_000 });
		assert.equal(await draft(page), "Hello there");
		assert.equal(await userMessages(server, id), 0, "nothing was sent");
	});
});

describe("a refused send leaves the session usable", () => {
	let server: LhServer;
	let page: Page;
	const openrouter = { model: { provider: "openrouter", id: "or-a" } };

	before(async () => {
		server = await bootServer({
			ticket: TICKET,
			// openrouter keeps its key gate; the stub stays connected.
			providers: [
				{ id: "e2e-stub", baseUrl: provider.baseUrl, models: [{ id: "stub-a" }] },
				{ id: "openrouter", baseUrl: provider.baseUrl, models: [{ id: "or-a" }] },
			],
			settings: { version: 1, graph: { enabled: false }, models: { strong: openrouter, cheap: stub("stub-a"), vision: stub("stub-a") } },
		});
		page = await chrome.browser.newPage();
	});

	after(async () => {
		await page?.close();
		await server?.stop();
	});

	test("after a missing-key refusal the open question can still be dismissed", async () => {
		await server.json("/api/keys/OPENROUTER_API_KEY", { method: "PUT", body: { value: "e2e-dummy-key-not-real" } });
		const id = await sessionOn(server, openrouter.model);
		const res = await server.api("/api/chat", { body: { chatId: id, input: { type: "text", text: `Quiz me on limits. ${QUIZ}` } } });
		assert.equal(res.status, 200, await res.clone().text());
		await res.arrayBuffer();
		await until(async () => !(await server.json<{ turnInFlight: boolean }>(`/api/chats/${id}`)).turnInFlight, "the probe turn to settle");
		await page.setViewport({ width: 1280, height: 800 });
		await page.goto(`${server.url}/chat/${id}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
		await reactHydrated(page, "[data-testid=question-dock] [role=radio]");
		// The key goes; answering is refused, which lands as the picker.
		await server.json("/api/keys/OPENROUTER_API_KEY", { method: "DELETE" });
		await page.click("[data-testid=question-dock] [role=radio]");
		await page.click("[data-testid=question-dock] button[type=submit]");
		await page.waitForSelector("[data-testid=model-search]", { timeout: 30_000 });
		await page.keyboard.press("Escape");
		await until(async () => !(await present(page, "[data-testid=model-search]")), "the picker to close", 10_000);
		// Esc with nothing open asks to dismiss the question.
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		if (!(await present(page, "[data-testid=abort-turn-dialog]"))) await page.keyboard.press("Escape");
		await page.waitForSelector("[data-testid=abort-turn-confirm]", { timeout: 10_000 });
		await page.click("[data-testid=abort-turn-confirm]");
		await until(async () => {
			const chat = await server.json<{ messages: Array<{ role: string }> }>(`/api/chats/${id}`);
			const last = chat.messages.at(-1);
			return last?.role === "toolResult" && JSON.stringify(last).includes('"dismissed":true');
		}, "the dismissal to reach the record", 30_000);
		assert.equal(await userMessages(server, id), 1, "the refused answer sent nothing");
	});
});

describe("Claude Code is the only provider", () => {
	let server: LhServer;
	let page: Page;

	before(async () => {
		const slot = { model: { provider: "claude-code", id: "claude-model" } };
		server = await bootServer({
			ticket: TICKET,
			providers: [],
			settings: { version: 1, graph: { enabled: false }, models: { strong: slot, cheap: slot, vision: slot } },
			// Set, and rejected: the harness sets LH_IGNORE_ENV_KEYS=1.
			env: { LH_CLAUDE_CODE_EXECUTABLE: "/bin/sh" },
		});
		page = await chrome.browser.newPage();
	});

	after(async () => {
		await page?.close();
		await server?.stop();
	});

	test("the Claude card says why the launch executable was rejected", async () => {
		const status = await server.json<{ envOverride: boolean; active: boolean; error: string | null }>("/api/claude-code");
		assert.equal(status.envOverride, true);
		assert.equal(status.active, false);
		assert.equal(status.error, "Claude Code executable was rejected (LH_IGNORE_ENV_KEYS=1)");
		// The Settings card shows that reason.
		await page.setViewport({ width: 1280, height: 800 });
		await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 180_000 });
		// Clicks before hydration land on inert markup: retry until it opens.
		await until(async () => {
			await page.click("[data-testid=settings-entry]");
			return page.waitForSelector("[data-testid=settings-nav-keys]", { timeout: 2000 });
		}, "the settings dialog to open", 180_000, 500);
		await page.click("[data-testid=settings-nav-keys]");
		const alert = "[data-testid=claude-code-connection] [role=alert]";
		await page.waitForSelector(alert, { timeout: 60_000 });
		assert.equal(await page.$eval(alert, (el) => el.textContent), "Claude Code executable was rejected (LH_IGNORE_ENV_KEYS=1)");
	});

	/** Enter, then one more key. React commits a key's update before the
	 *  next key's handler runs, so once the extra "!" shows, anything the
	 *  Enter opened is already on the page. */
	async function sendAndSettle(page: Page, pathname: string, text: string): Promise<void> {
		await type(page, text);
		await page.type(FIELD, "!");
		await until(async () => (await present(page, "[data-testid=setup-dialog]")) || (await draft(page)) === `${text}!`, `${pathname}: the Enter to be handled`, 10_000);
		assert(!(await present(page, "[data-testid=setup-dialog]")), `${pathname}: no key setup`);
	}

	test("every page shows the off notice where key setup would be, and a send opens no key setup", async () => {
		const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Only Claude" } });
		for (const pathname of [`/chat/${id}`, "/", "/chat/new"]) {
			await hydrated(page, pathname, server);
			await page.waitForSelector("[data-testid=claude-code-off-notice]", { timeout: 30_000 });
			assert(!(await present(page, "[data-testid=setup-cta-keys]")), `${pathname}: no "Add a provider key"`);
			await sendAndSettle(page, pathname, "Limits");
		}
		assert.equal(await userMessages(server, id), 0, "nothing was sent");
		assert.equal(await sessions(server), 1, "no session was created");
	});

	test("Enter before the model control has read the session opens no key setup", async () => {
		const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Only Claude, early Enter" } });
		const early = await chrome.browser.newPage();
		try {
			// Hold the model control's session read, so the stats bar has not
			// reported the model when Enter lands.
			const held: Array<{ continue(): Promise<void> }> = [];
			await early.setBypassServiceWorker(true);
			await early.setRequestInterception(true);
			early.on("request", (req) => {
				if (req.method() === "GET" && new URL(req.url()).pathname === `/api/chats/${id}`) held.push(req);
				else void req.continue();
			});
			await early.setViewport({ width: 1280, height: 800 });
			await early.goto(`${server.url}/chat/${id}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
			await reactHydrated(early, FIELD);
			// The catalog has loaded: one of the two zero-keys surfaces shows.
			await until(async () => (await present(early, "[data-testid=claude-code-off-notice]")) || (await present(early, "[data-testid=setup-cta-keys]")), "the catalog to load", 60_000);
			const label = (await early.$eval("[data-testid=stats-model]", (el) => el.textContent ?? "").catch(() => "")).trim();
			assert(held.length > 0 && (label === "" || label === "—"), `the session read is still held (label "${label}")`);
			await sendAndSettle(early, "early Enter", "Limits");
			assert(await present(early, "[data-testid=claude-code-off-notice]"), "the off notice shows");
			for (const req of held) await req.continue();
		} finally {
			await early.close();
		}
		assert.equal(await userMessages(server, id), 0, "nothing was sent");
	});
});

describe("extraction reports unset slots before missing keys", () => {
	let server: LhServer;

	before(async () => {
		server = await bootServer({
			ticket: TICKET,
			// openrouter keeps its key gate, and no key is saved.
			providers: [
				{ id: "e2e-stub", baseUrl: provider.baseUrl, models: [{ id: "stub-a" }] },
				{ id: "openrouter", baseUrl: provider.baseUrl, models: [{ id: "or-a" }] },
			],
			// The extractor is pinned to openrouter; the auditor follows the unset Cheap slot.
			settings: {
				version: 1,
				models: { strong: stub("stub-a"), vision: stub("stub-a") },
				agent: { models: { extractor: { model: { provider: "openrouter", id: "or-a" } } } },
			},
		});
	});

	after(async () => {
		await server?.stop();
	});

	async function importNotes(name: string): Promise<{ ok: boolean; code?: string; missing?: string[]; provider?: string }> {
		const form = new FormData();
		form.append("files", new File(["# Limits\n\nA limit is where a function is heading."], name, { type: "text/markdown" }));
		const res = await fetch(`${server.url}/api/graph/import`, { method: "POST", body: form });
		assert.equal(res.status, 200, await res.clone().text());
		return ((await res.json()) as { results: Array<{ ok: boolean; code?: string; missing?: string[]; provider?: string }> }).results[0]!;
	}

	test("an unset auditor is reported first, then the extractor's missing key", async () => {
		const unset = await importNotes("limits.md");
		assert.equal(unset.ok, false);
		assert.equal(unset.code, "models_not_configured");
		assert.deepEqual(unset.missing, ["cheap"]);

		await server.json("/api/settings/models", { method: "PUT", body: { strong: stub("stub-a"), cheap: stub("stub-a"), vision: stub("stub-a") } });
		const keyless = await importNotes("limits-2.md");
		assert.equal(keyless.ok, false);
		assert.equal(keyless.code, "provider_key_missing");
		assert.equal(keyless.provider, "openrouter");
	});
});
