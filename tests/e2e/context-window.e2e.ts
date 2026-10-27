import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { bootServer, until, type E2EProvider, type LhServer } from "./harness/server.ts";
import { launchChrome, type HeadlessChrome } from "./harness/chrome.ts";
import { reply, startStubProvider, type StubProvider } from "./harness/stub-provider.ts";

// LH-38: the per-(provider, model) context window. Settings > Agent >
// Context shows one row per slot model; saves above the known Maximum go
// through the confirm modal, saves below the Minimum are refused; the
// value persists on disk, survives a restart, sticks per pair, and
// reaches the footer and the engine. Stub models carry no known-max
// entry, so Maximum = Default here; Minimum is 48,384 (min(floor, Default)).
//
// /api/models federates keyed providers only, so the stub registers under
// a key-gated id (openrouter) and a dummy key is saved after each boot.

const STUB = "openrouter";
const A = `${STUB}:stub-a`; // Default 100k
const B = `${STUB}:stub-b`; // Default 128k, maxTokens 64k
const D = `${STUB}:stub-d`; // Default 64k, never in a slot

let stub: StubProvider;
let server: LhServer;
let chrome: HeadlessChrome;
let page: Page;
const keptRoots: string[] = [];
/** The data dir the running server reads; (e) restarts onto the first one. */
let dataDir: string;

const providers = (baseUrl: string): E2EProvider[] => [
	{
		id: STUB,
		baseUrl,
		models: [
			{ id: "stub-a", contextWindow: 100_000 },
			{ id: "stub-b", contextWindow: 128_000, maxTokens: 64_000 },
			{ id: "stub-c", contextWindow: 200_000, input: ["text", "image"] },
			{ id: "stub-d", contextWindow: 64_000 }, // in no slot: composer-only
		],
	},
];

before(async () => {
	stub = await startStubProvider(() => reply.text("ok"));
	server = await bootServer({
		ticket: "lh-38",
		providers: providers(stub.baseUrl),
		settings: {
			version: 1,
			graph: { enabled: false },
			models: {
				strong: { model: { provider: STUB, id: "stub-a" } },
				cheap: { model: { provider: STUB, id: "stub-c" } },
				vision: { model: { provider: STUB, id: "stub-c" } },
			},
		},
	});
	dataDir = server.dataDir;
	await saveStubKey();
	chrome = await launchChrome("lh-38");
	page = await chrome.browser.newPage();
	await page.setViewport({ width: 1400, height: 900 });
});

after(async () => {
	await chrome?.close();
	await server?.stop();
	await stub?.close();
	for (const root of keptRoots) fs.rmSync(root, { recursive: true, force: true });
});

async function saveStubKey(): Promise<void> {
	await server.json("/api/keys/OPENROUTER_API_KEY", { method: "PUT", body: { value: "e2e-dummy-key-not-real" } });
}

const rowSel = (pair: string) => `[data-testid="context-window-row-${pair}"]`;
const inputSel = (pair: string) => `${rowSel(pair)} [data-testid="input-context-window"]`;
const dialogSel = '[data-testid="context-window-dialog"]';

function diskSettings(): { contextWindows?: Record<string, number>; models?: Record<string, { model?: { id: string } }> } {
	return JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8"));
}

function diskWindows(): Record<string, number> | undefined {
	return diskSettings().contextWindows;
}

/** Write a window straight into settings.json (a record from before a fix,
 *  or a pair whose model has since left the catalog). */
function writeDiskWindow(pair: string, tokens: number): void {
	const file = path.join(dataDir, "settings.json");
	const record = JSON.parse(fs.readFileSync(file, "utf-8"));
	record.contextWindows = { ...record.contextWindows, [pair]: tokens };
	fs.writeFileSync(file, JSON.stringify(record, null, "\t"));
}

/** Click `selector`, re-querying it when React swapped the node out
 *  between the query and the click (hydration after a slow first
 *  compile, or a field remounting after a save). Only that error retries:
 *  it is thrown before any click is dispatched. */
async function click(selector: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await page.waitForSelector(selector, { timeout: 60_000 });
			await page.click(selector);
			return;
		} catch (err) {
			if (attempt >= 20 || !/detached/i.test(String(err))) throw err;
			await new Promise((r) => setTimeout(r, 250));
		}
	}
}

async function openAgentSettings(): Promise<void> {
	await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 180_000 });
	// Clicks before hydration land on inert markup: retry until it opens.
	await until(async () => {
		await page.click('[data-testid="settings-entry"]');
		return page.waitForSelector('[data-testid="settings-nav-agent"]', { timeout: 2000 });
	}, "the settings dialog to open", 180_000, 500);
	await click('[data-testid="settings-nav-agent"]');
	await page.waitForSelector('[data-testid="group-context"]', { timeout: 60_000 });
}

async function rowText(pair: string): Promise<string> {
	await page.waitForSelector(rowSel(pair), { timeout: 60_000 });
	return page.$eval(rowSel(pair), (el) => el.textContent ?? "");
}

async function inputValue(pair: string): Promise<string> {
	await page.waitForSelector(inputSel(pair), { timeout: 60_000 });
	return page.$eval(inputSel(pair), (el) => (el as HTMLInputElement).value);
}

async function waitInput(pair: string, value: string): Promise<void> {
	await until(async () => (await inputValue(pair)) === value, `${pair} input to read "${value}"`);
}

async function typeWindow(pair: string, value: string, commit: "enter" | "save" | "blur"): Promise<void> {
	await typeIn(rowSel(pair), value, commit);
}

/** Replace the field's text inside `container`, then commit: Enter, the
 *  Save button, or a click on the Context group's corner (the field
 *  commits on blur). */
async function typeIn(container: string, value: string, commit: "enter" | "save" | "blur"): Promise<void> {
	const input = `${container} [data-testid="input-context-window"]`;
	await click(input);
	await page.keyboard.press("End");
	for (let i = 0; i < 12; i++) await page.keyboard.press("Backspace");
	await page.type(input, value);
	if (commit === "enter") await page.keyboard.press("Enter");
	else if (commit === "save") await click(`${container} [data-testid="save-context-window"]`);
	else {
		const box = await (await page.$('[data-testid="group-context"]'))!.boundingBox();
		await page.mouse.click(box!.x + 4, box!.y + 4);
	}
}

/** The data-testid of the focused element, or of the dialog it sits in. */
function focusedTestid(): Promise<string> {
	return page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		const own = el?.dataset.testid;
		return own ?? (el?.closest("[data-testid]") as HTMLElement | null)?.dataset.testid ?? "";
	});
}

function focusInDialog(): Promise<boolean> {
	return page.evaluate(() => !!document.activeElement?.closest('[data-testid="context-window-dialog"]'));
}

async function footerReads(denominator: string): Promise<void> {
	await until(async () => (await page.$eval('[data-testid="stats-context"]', (el) => el.textContent ?? "").catch(() => "")).trim().endsWith(`/ ${denominator}`), `footer to read / ${denominator}`, 120_000);
}

async function pickStrong(id: string): Promise<void> {
	await click('[data-testid="slot-model-strong"]');
	await click(`[data-testid="model-option-${id}"]`);
	await until(() => diskSettings().models?.strong?.model?.id === id, `strong slot = ${id}`);
}

/** Run one learner turn and return the max-tokens budget stub-b received. */
async function turnBudget(chatId: string): Promise<number> {
	const before = stub.requests.length;
	const res = await server.api("/api/chat", { body: { chatId, input: { type: "text", text: "Teach me limits." } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	const sent = await until(() => stub.requests.slice(before).find((r) => r.model === "stub-b"), "a stub-b request");
	await until(async () => !(await server.json<{ turnInFlight: boolean }>(`/api/chats/${chatId}`)).turnInFlight, "the turn to settle");
	const body = sent.body as { max_tokens?: number; max_completion_tokens?: number };
	const budget = body.max_completion_tokens ?? body.max_tokens;
	assert.ok(budget !== undefined, "the request carries a max-tokens budget");
	return budget;
}

test("(a) a value at or below the maximum saves directly and shows", async () => {
	await openAgentSettings();
	const hint = await rowText(A);
	assert.match(hint, /Default: 100k · Maximum: 100k/);
	assert.equal(await inputValue(A), "");
	await typeWindow(A, "80000", "save");
	await until(() => diskWindows()?.[A] === 80_000, "80000 on disk");
	assert.equal(await page.$(dialogSel), null, "no modal at or below the maximum");
	await waitInput(A, "80000");
	// Exactly the Default (and here the maximum): no modal, and no pin — the
	// pair clears back to its default.
	await typeWindow(A, "100000", "blur");
	await until(() => diskWindows() !== undefined && !(A in diskWindows()!), "A cleared on disk");
	assert.equal(await page.$(dialogSel), null);
	await waitInput(A, "");
	const pinned = await server.json<{ settings: { contextWindows: Record<string, number> } }>("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "stub-a", tokens: 100_000 } });
	assert.equal(A in pinned.settings.contextWindows, false, "the route stores no pin equal to the Default either");

	// A pin equal to the Default from an older record shows as a value and
	// clears with an empty commit.
	writeDiskWindow(A, 100_000);
	await openAgentSettings();
	await waitInput(A, "100000");
	await typeWindow(A, "", "enter");
	await until(() => !(A in (diskWindows() ?? {})), "the old pin cleared");
	await waitInput(A, "");
	await typeWindow(A, "80000", "enter");
	await until(() => diskWindows()?.[A] === 80_000, "80000 on disk again");
	await openAgentSettings();
	await waitInput(A, "80000");
});

test("(a2) clicking away commits; the field never shows an unsaved value", async () => {
	await typeWindow(A, "90000", "blur");
	await until(() => diskWindows()?.[A] === 90_000, "90000 on disk after blur");
	await waitInput(A, "90000");
	// A refused value (below the minimum) snaps back to what is stored.
	await typeWindow(A, "1000", "blur");
	await waitInput(A, "90000");
	assert.equal(diskWindows()?.[A], 90_000);
	await typeWindow(A, "80000", "enter");
	await until(() => diskWindows()?.[A] === 80_000, "back to 80000");
	await waitInput(A, "80000");
});

test("(a3) below the minimum is refused in the field and by the server", async () => {
	await typeWindow(A, "40000", "enter");
	await until(async () => (await page.$eval(rowSel(A), (el) => el.textContent ?? "")).includes("Minimum: 48.4k"), "the minimum error");
	await waitInput(A, "80000");
	assert.equal(await page.$(dialogSel), null);
	assert.equal(diskWindows()?.[A], 80_000);
	const raw = await server.api("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "stub-a", tokens: 40_000 } });
	assert.equal(raw.status, 400);
	const body = (await raw.json()) as { code: string; minimum: number };
	assert.equal(body.code, "below_minimum");
	assert.equal(body.minimum, 48_384);
	assert.equal(diskWindows()?.[A], 80_000);
	const atFloor = await server.api("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "stub-a", tokens: 48_384 } });
	assert.equal(atFloor.status, 200, "the minimum itself saves");
	await server.json("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "stub-a", tokens: 80_000 } });
	assert.equal(diskWindows()?.[A], 80_000);
});

test("(b) above the maximum: the modal gates the save behind the checkbox", async () => {
	await openAgentSettings();
	await typeWindow(A, "150000", "save");
	await page.waitForSelector(dialogSel);
	assert.match(await page.$eval(dialogSel, (el) => el.textContent ?? ""), /it may stop compacting/);
	assert.equal(await page.$eval('[data-testid="context-window-confirm"]', (el) => (el as HTMLButtonElement).disabled), true);
	assert.equal(diskWindows()?.[A], 80_000, "nothing saved while the modal is open");
	await page.click('[data-testid="context-window-understood"]');
	assert.equal(await page.$eval('[data-testid="context-window-confirm"]', (el) => (el as HTMLButtonElement).disabled), false);
	await page.click('[data-testid="context-window-confirm"]');
	await until(() => diskWindows()?.[A] === 150_000, "150000 on disk");
	await until(async () => (await page.$(dialogSel)) === null, "the modal to close");
	await waitInput(A, "150000");

	// No other way past the maximum: the write route refuses without the
	// confirmation, and the generic section route has no parser for it.
	const raw = await server.api("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "stub-a", tokens: 300_000 } });
	assert.equal(raw.status, 409);
	assert.equal(((await raw.json()) as { code: string }).code, "above_maximum");
	const generic = await server.api("/api/settings/contextWindows", { method: "PUT", body: { [A]: 300_000 } });
	assert.equal(generic.status, 404);
	assert.equal(diskWindows()?.[A], 150_000);
});

test("(c) above the maximum: Cancel (and Esc) keep the old value", async () => {
	await typeWindow(A, "200000", "enter");
	await page.waitForSelector(dialogSel);
	await page.click('[data-testid="context-window-cancel"]');
	await until(async () => (await page.$(dialogSel)) === null, "the modal to close");
	await waitInput(A, "150000");
	assert.equal(diskWindows()?.[A], 150_000);

	await typeWindow(A, "250000", "blur");
	await page.waitForSelector(dialogSel);
	await page.keyboard.press("Escape");
	await until(async () => (await page.$(dialogSel)) === null, "Esc to close the modal");
	assert.ok(await page.$('[data-testid="settings-dialog"]'), "Esc closed only the modal, not Settings");
	await waitInput(A, "150000");
	await openAgentSettings();
	await waitInput(A, "150000");
	assert.equal(diskWindows()?.[A], 150_000);
});

test("(c2) the modal takes focus, keeps Tab inside, and works from the keyboard", async () => {
	await typeWindow(A, "200000", "enter");
	await page.waitForSelector(dialogSel);
	await until(async () => (await focusedTestid()) === "context-window-understood", "focus on the checkbox");
	// Enter in the dialog never re-runs the field's save.
	await page.keyboard.press("Enter");
	assert.equal((await page.$$(dialogSel)).length, 1);
	assert.equal(diskWindows()?.[A], 150_000);
	for (let i = 0; i < 5; i++) {
		await page.keyboard.press("Tab");
		assert.ok(await focusInDialog(), `Tab ${i + 1} stays inside the dialog`);
	}
	await page.keyboard.down("Shift");
	for (let i = 0; i < 3; i++) {
		await page.keyboard.press("Tab");
		assert.ok(await focusInDialog(), `Shift+Tab ${i + 1} stays inside the dialog`);
	}
	await page.keyboard.up("Shift");
	// Disabled Confirm is out of the cycle: checkbox → Cancel → checkbox.
	await page.focus('[data-testid="context-window-understood"]');
	await page.keyboard.press("Space");
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	assert.equal(await focusedTestid(), "context-window-confirm");
	await page.keyboard.press("Enter");
	await until(() => diskWindows()?.[A] === 200_000, "200000 on disk from the keyboard");
	await until(async () => (await page.$(dialogSel)) === null, "the modal to close");
	await server.json("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "stub-a", tokens: 150_000, confirmAboveMax: true } });
});

test("(c3) a server above_maximum refusal opens the modal at the server's maximum", async () => {
	// A stale client catalog: /api/models claims A's maximum is 1M, so the
	// field writes without confirmation and the server answers 409.
	const onRequest = async (request: import("puppeteer-core").HTTPRequest) => {
		if (new URL(request.url()).pathname !== "/api/models") return void request.continue();
		const catalog = await server.json<{ models: Array<{ provider: string; id: string; maxContextWindow: number }> }>("/api/models");
		for (const m of catalog.models) if (m.provider === STUB && m.id === "stub-a") m.maxContextWindow = 1_000_000;
		await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(catalog) });
	};
	await page.setRequestInterception(true);
	page.on("request", onRequest);
	try {
		await openAgentSettings();
		assert.match(await rowText(A), /Maximum: 1M/);
		await typeWindow(A, "300000", "enter");
		await page.waitForSelector(dialogSel);
		assert.match(await page.$eval(dialogSel, (el) => el.textContent ?? ""), /above the known maximum \(100k\)/);
		assert.equal(diskWindows()?.[A], 150_000);
		await page.click('[data-testid="context-window-cancel"]');
		await until(async () => (await page.$(dialogSel)) === null, "the modal to close");
	} finally {
		page.off("request", onRequest);
		await page.setRequestInterception(false);
	}
	await openAgentSettings();
	await waitInput(A, "150000");
});

test("(c4) a pair whose model left the catalog can still be cleared", async () => {
	const gone = `${STUB}:gone-model`;
	writeDiskWindow(gone, 90_000);
	const refused = await server.api("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "gone-model", tokens: 90_000 } });
	assert.equal(refused.status, 400, "a value still needs a catalog entry");
	await server.json("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "gone-model", tokens: null } });
	assert.equal(gone in (diskWindows() ?? {}), false);
	assert.equal(diskWindows()?.[A], 150_000);
});

test("(d) each pair keeps its own value across model switches", async () => {
	await pickStrong("stub-b");
	await waitInput(B, ""); // B's own (unset) value, not A's
	assert.match(await rowText(B), /Default: 128k · Maximum: 128k/);
	assert.equal(await page.$(rowSel(A)), null, "A is in no slot now");
	await typeWindow(B, "60000", "enter");
	await until(() => diskWindows()?.[B] === 60_000, "B = 60000 on disk");
	await pickStrong("stub-a");
	await waitInput(A, "150000");
	await pickStrong("stub-b");
	await waitInput(B, "60000");
	assert.deepEqual(diskWindows(), { [A]: 150_000, [B]: 60_000 });
});

test("(e) the values survive a server restart", async () => {
	// Same data dir and auth file: the new process reads what the old one wrote.
	const root = path.dirname(dataDir);
	keptRoots.push(root);
	process.env.LH_E2E_KEEP = "1";
	await server.stop();
	delete process.env.LH_E2E_KEEP;
	server = await bootServer({
		ticket: "lh-38",
		providers: providers(stub.baseUrl),
		settings: { version: 1 },
		env: { LH_DATA_DIR: dataDir, LH_AUTH_FILE: path.join(root, "auth.json") },
	});
	const catalog = await server.json<{ models: Array<{ provider: string; id: string; contextWindow: number; defaultContextWindow: number }> }>("/api/models");
	const window = (id: string) => catalog.models.find((m) => m.provider === STUB && m.id === id);
	assert.equal(window("stub-a")?.contextWindow, 150_000);
	assert.equal(window("stub-b")?.contextWindow, 60_000);
	assert.equal(window("stub-b")?.defaultContextWindow, 128_000);
	await openAgentSettings();
	await waitInput(B, "60000");
});

test("(f) the runtime uses the pair's value: footer denominator and engine budget", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Context window" } });
	await page.goto(`${server.url}/chat/${id}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	await footerReads("60k");

	// pi-ai clamps max tokens to contextWindow − context − 4096: with B's
	// 60k window the request asks for less than B's own 64k maxTokens;
	// cleared back to the 128k default, the full 64k returns.
	const custom = await turnBudget(id);
	assert.ok(custom <= 60_000 - 4096, `max tokens ${custom} fits the custom 60k window`);
	await server.json("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "stub-b", tokens: null } });
	assert.equal(diskWindows()?.[B], undefined);
	assert.equal(await turnBudget(id), 64_000);
	await page.reload({ waitUntil: "domcontentloaded" });
	await footerReads("128k");
});

test("(g) the composer's model picker edits a model that is in no slot", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Composer pick" } });
	await page.goto(`${server.url}/chat/${id}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	const openMenu = () =>
		until(async () => {
			await page.click('[data-testid="stats-model"]');
			return page.waitForSelector('[data-testid="model-menu"]', { timeout: 2000 });
		}, "the composer model menu to open", 180_000, 500);
	await openMenu();
	await page.waitForSelector('[data-testid="model-option-stub-d"]', { timeout: 60_000 });
	await click('[data-testid="model-option-stub-d"]');
	await until(async () => (await server.json<{ settings?: { model?: { id: string } } }>(`/api/chats/${id}`)).settings?.model?.id === "stub-d", "the session to run stub-d");
	await footerReads("64k");

	const field = '[data-testid="composer-context-window"]';
	await openMenu();
	await page.waitForSelector(field);
	assert.match(await page.$eval(field, (el) => el.textContent ?? ""), /Default: 64k · Maximum: 64k/);
	await typeIn(field, "50000", "enter");
	await until(() => diskWindows()?.[D] === 50_000, "D = 50000 on disk");
	await footerReads("50k");

	// The same modal and guard as Settings; clicking inside the modal must
	// not close the menu (and the field) underneath it.
	await typeIn(field, "250000", "save");
	await page.waitForSelector(dialogSel);
	assert.equal(await page.$eval('[data-testid="context-window-confirm"]', (el) => (el as HTMLButtonElement).disabled), true);
	await page.click('[data-testid="context-window-understood"]');
	assert.ok(await page.$('[data-testid="model-menu"]'), "the menu stays open under the modal");
	await page.click('[data-testid="context-window-confirm"]');
	await until(() => diskWindows()?.[D] === 250_000, "D = 250000 on disk");
	await footerReads("250k");
	assert.ok(!JSON.stringify(diskSettings().models).includes("stub-d"), "stub-d is in no slot");
});
