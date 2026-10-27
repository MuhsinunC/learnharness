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
// through the confirm modal; the value persists on disk, survives a
// restart, sticks per pair, and reaches the footer and the engine.
// Stub models carry no known-max entry, so Maximum = Default here.
//
// /api/models federates keyed providers only, so the stub registers under
// a key-gated id (openrouter) and a dummy key is saved after each boot.

const STUB = "openrouter";
const A = `${STUB}:stub-a`; // Default 100k
const B = `${STUB}:stub-b`; // Default 128k, maxTokens 64k

let stub: StubProvider;
let server: LhServer;
let chrome: HeadlessChrome;
let page: Page;
const keptRoots: string[] = [];

const providers = (baseUrl: string): E2EProvider[] => [
	{
		id: STUB,
		baseUrl,
		models: [
			{ id: "stub-a", contextWindow: 100_000 },
			{ id: "stub-b", contextWindow: 128_000, maxTokens: 64_000 },
			{ id: "stub-c", contextWindow: 200_000, input: ["text", "image"] },
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

function diskWindows(dataDir = server.dataDir): Record<string, number> | undefined {
	return JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8")).contextWindows;
}

async function openAgentSettings(): Promise<void> {
	await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 180_000 });
	// Clicks before hydration land on inert markup: retry until it opens.
	await until(async () => {
		await page.click('[data-testid="settings-entry"]');
		return page.waitForSelector('[data-testid="settings-nav-agent"]', { timeout: 2000 });
	}, "the settings dialog to open", 180_000, 500);
	await page.click('[data-testid="settings-nav-agent"]');
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

async function typeWindow(pair: string, value: string, commit: "enter" | "save"): Promise<void> {
	await page.click(inputSel(pair));
	await page.keyboard.press("End");
	for (let i = 0; i < 12; i++) await page.keyboard.press("Backspace");
	await page.type(inputSel(pair), value);
	if (commit === "enter") await page.keyboard.press("Enter");
	else await page.click(`${rowSel(pair)} [data-testid="save-context-window"]`);
}

async function pickStrong(id: string): Promise<void> {
	await page.click('[data-testid="slot-model-strong"]');
	await page.waitForSelector(`[data-testid="model-option-${id}"]`);
	await page.click(`[data-testid="model-option-${id}"]`);
	await until(async () => JSON.parse(fs.readFileSync(path.join(server.dataDir, "settings.json"), "utf-8")).models?.strong?.model?.id === id, `strong slot = ${id}`);
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
	await typeWindow(A, "80000", "enter");
	await until(() => diskWindows()?.[A] === 80_000, "80000 on disk");
	assert.equal(await page.$(dialogSel), null, "no modal at or below the maximum");
	await waitInput(A, "80000");
	await typeWindow(A, "100000", "save"); // exactly the maximum: still no modal
	await until(() => diskWindows()?.[A] === 100_000, "100000 on disk");
	assert.equal(await page.$(dialogSel), null);
	await openAgentSettings();
	await waitInput(A, ""); // equal to Default reads as the default placeholder
	await typeWindow(A, "80000", "enter");
	await until(() => diskWindows()?.[A] === 80_000, "80000 on disk again");
	await openAgentSettings();
	await waitInput(A, "80000");
});

test("(b) above the maximum: the modal gates the save behind the checkbox", async () => {
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

	await typeWindow(A, "250000", "save");
	await page.waitForSelector(dialogSel);
	await page.keyboard.press("Escape");
	await until(async () => (await page.$(dialogSel)) === null, "Esc to close the modal");
	assert.ok(await page.$('[data-testid="settings-dialog"]'), "Esc closed only the modal, not Settings");
	await waitInput(A, "150000");
	await openAgentSettings();
	await waitInput(A, "150000");
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
	const dataDir = server.dataDir;
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
	await until(async () => /\/ 60k$/.test((await page.$eval('[data-testid="stats-context"]', (el) => el.textContent ?? "").catch(() => "")).trim()), "footer to read / 60k", 120_000);

	// pi-ai clamps max tokens to contextWindow − context − 4096: with B's
	// 60k window the request asks for less than B's own 64k maxTokens;
	// cleared back to the 128k default, the full 64k returns.
	const custom = await turnBudget(id);
	assert.ok(custom <= 60_000 - 4096, `max tokens ${custom} fits the custom 60k window`);
	await server.json("/api/settings/context-windows", { method: "PUT", body: { provider: STUB, id: "stub-b", tokens: null } });
	assert.equal(diskWindows()?.[B], undefined);
	assert.equal(await turnBudget(id), 64_000);
	await page.reload({ waitUntil: "domcontentloaded" });
	await until(async () => /\/ 128k$/.test((await page.$eval('[data-testid="stats-context"]', (el) => el.textContent ?? "").catch(() => "")).trim()), "footer to read / 128k", 120_000);
});
