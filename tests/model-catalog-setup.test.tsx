import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { SetupDialog } from "../components/setup-dialog.tsx";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { providerKeyLabel, classifyKeys } from "../components/settings/keys-section.tsx";
import { useModelCatalog } from "../components/model-catalog.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import type { ModelCatalogEntry, ModelCatalogResponse, ModelsSettings } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let requests: ReturnType<typeof deferred<Response>>[] = [];
let writes: ModelsSettings[] = [];
let snapshot: ReturnType<typeof useModelCatalog>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
const provider = { id: "fixture", envVar: "FIXTURE_KEY", label: "Fixture" };
const a: ModelCatalogEntry = { id: "vendor/model:free", name: "Model free", provider: provider.id, input: ["text", "image"], reasoning: true, supportedLevels: ["off", "low", "high"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
const b: ModelCatalogEntry = { ...a, id: "claude-opus-5-5", name: "Claude Opus 5.5", supportedLevels: ["off", "medium"] };
function catalog(connected = true): ModelCatalogResponse {
	return {
		models: connected ? [a, b] : [], defaults: null,
		rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null },
		slots: { strong: { model: { provider: a.provider, id: a.id }, thinkingLevel: "low" }, cheap: { model: { provider: a.provider, id: a.id }, thinkingLevel: "high" }, vision: { model: { provider: a.provider, id: a.id }, thinkingLevel: "low" } },
		providers: [{ ...provider, keyPresent: connected }],
	};
}
function Reader() { snapshot = useModelCatalog(); return null; }
function setup() { return <SetupDialog open onClose={() => {}} onDone={() => {}} />; }
function installFetch() {
	requests = []; writes = [];
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		if (path === "/api/models") { const request = deferred<Response>(); requests.push(request); return request.promise; }
		if (path === "/api/settings/models") { writes.push(JSON.parse(String(init?.body))); return Response.json({ settings: { models: writes.at(-1) } }); }
		if (path === "/api/keys") return Response.json({ providers: [provider], keys: [] });
		if (path === "/api/settings/prompts") return Response.json({ prober: [], teacher: [] });
		if (path === "/api/search") return Response.json({ available: false, engine: null, reason: "fixture" });
		throw new Error(`Unexpected request ${path}`);
	};
}
async function render(children: React.ReactNode) {
	if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
	await act(async () => root!.render(children));
}
async function answer(index: number, body: ModelCatalogResponse | null) { await act(async () => requests[index]!.resolve(body ? Response.json(body) : new Response("unavailable", { status: 503 }))); }
function element(testid: string) { const e = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`); assert.ok(e, testid); return e; }
async function click(testid: string) { await act(async () => element(testid).click()); }
function levels() { return [...document.querySelectorAll('[data-testid^="thinking-option-"]')].map((e) => e.textContent); }
async function warm(body = catalog()) { await render(<Reader />); await answer(0, body); }

afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

test("cold setup is loading, not keyless; failure/Retry does not invent a key stage", async () => {
	installFetch(); await render(setup());
	assert.ok(element("setup-stage-loading"));
	assert.equal(document.querySelector('[data-testid="setup-stage-keys"]'), null);
	await answer(0, null);
	assert.ok(element("setup-catalog-error"));
	assert.equal(document.querySelector('[data-testid="setup-stage-keys"]'), null);
	await click("setup-retry"); assert.ok(element("setup-stage-loading"));
	const empty = catalog(false); empty.slots = { strong: null, cheap: null, vision: null };
	await answer(1, empty); assert.ok(element("setup-stage-keys"));
});

test("cached setup is immediately usable; fresh metadata/untouched slots update without wiping model or thinking edits; failed refresh still allows exact-ID Save", async () => {
	installFetch(); await warm();
	await render(<><Reader />{setup()}</>);
	assert.equal(requests.length, 2);
	assert.ok(element("setup-stage-pickers"));
	assert.equal(document.querySelector('[data-testid="setup-stage-keys"]'), null);
	assert.equal(element("setup-trigger-strong").textContent, "model:free▾");
	await click("setup-trigger-strong"); await click("model-option-claude-opus-5-5");
	await click("setup-thinking-strong"); await click("thinking-option-medium");
	const fresh = catalog(); fresh.slots.cheap = { model: { provider: b.provider, id: b.id }, thinkingLevel: "off" };
	fresh.models[1] = { ...b, supportedLevels: ["off", "medium", "high"] };
	await answer(1, fresh);
	assert.equal(element("setup-trigger-strong").textContent, "claude-opus-5-5▾");
	assert.equal(element("setup-thinking-strong").textContent?.trim(), "medium▾");
	assert.equal(element("setup-trigger-cheap").textContent, "claude-opus-5-5▾");
	await click("setup-thinking-strong"); assert.deepEqual(levels(), ["off", "medium✓", "high"]);
	await click("setup-thinking-strong");
	await act(async () => snapshot.refresh()); await answer(2, null);
	assert.ok(element("setup-catalog-error")); assert.equal(element("setup-save").hasAttribute("disabled"), false);
	await click("setup-save");
	assert.deepEqual(writes[0], {
		strong: { model: { provider: b.provider, id: b.id }, thinkingLevel: "medium" },
		cheap: { model: { provider: b.provider, id: b.id }, thinkingLevel: "off" },
		vision: { model: { provider: a.provider, id: a.id }, thinkingLevel: "low" },
	});
});

test("disconnect invalidates choices, not saved selections or thinking; all-disconnected setup offers Add provider", async () => {
	installFetch(); await warm(); await render(<><Reader />{setup()}</>); await answer(1, catalog());
	await click("setup-trigger-strong");
	assert.ok(document.querySelector('[data-testid="model-option-claude-opus-5-5"]'));
	await act(async () => notifySettingsSaved("keys"));
	assert.equal(document.querySelector('[data-testid="model-option-claude-opus-5-5"]'), null, "stale choices disappear before the fresh request resolves");
	await answer(2, catalog(false));
	assert.equal(element("setup-trigger-strong").textContent, "model:free▾");
	assert.equal(element("setup-thinking-strong").textContent?.trim(), "low▾");
	assert.ok(element("setup-add-provider")); await click("setup-add-provider"); assert.ok(element("setup-stage-keys"));
	await click("setup-thinking-strong"); await click("thinking-option-xhigh");
	assert.equal(element("setup-thinking-strong").textContent?.trim(), "xhigh▾");
	await click("setup-save"); assert.equal(writes[0]?.strong?.thinkingLevel, "xhigh"); assert.equal(writes[0]?.strong?.model?.id, a.id);
});

test("cold reconnect checks saved pins before choosing the key stage, and reopening gets a new draft", async () => {
	installFetch(); await warm();
	await act(async () => notifySettingsSaved("keys"));
	const stages: Array<string | undefined> = [];
	function Probe() {
		const { catalog } = useModelCatalog();
		React.useLayoutEffect(() => { stages.push(document.querySelector<HTMLElement>('[data-testid^="setup-stage-"]')?.dataset.testid); }, [catalog]);
		return null;
	}
	await render(<><Reader />{setup()}<Probe /></>);
	assert.ok(element("setup-stage-loading"));
	await answer(1, catalog(false));
	assert.deepEqual(stages, ["setup-stage-loading", "setup-stage-pickers"]);
	await click("setup-thinking-strong"); await click("thinking-option-xhigh");
	await render(<Reader />);
	await render(<><Reader />{setup()}</>);
	assert.equal(element("setup-thinking-strong").textContent?.trim(), "low▾", "a reopened draft uses saved state, not the abandoned edit");
	await answer(2, catalog(false));
});

test("Agent opens with cached thinking metadata; refresh and disconnect never clear saved levels", async () => {
	installFetch(); await warm();
	const models: ModelsSettings = { strong: { model: { provider: a.provider, id: a.id }, thinkingLevel: "low" } };
	let changed: ModelsSettings | undefined;
	await render(<><Reader /><AgentSection agent={undefined} models={models} graph={undefined} compaction={undefined} onSectionChange={() => {}} onModelsChange={(next) => { changed = next; }} onCompactionChange={() => {}} /></>);
	await click("slot-thinking-strong"); assert.deepEqual(levels(), ["off", "low✓", "high"]);
	assert.equal(element("slot-model-strong").textContent, "model:free▾");
	await answer(1, catalog());
	await act(async () => notifySettingsSaved("keys")); await answer(2, catalog(false));
	assert.equal(element("slot-thinking-strong").textContent, "low▾");
	await click("thinking-option-xhigh"); assert.equal(changed?.strong?.thinkingLevel, "xhigh"); assert.equal(changed?.strong?.model?.id, a.id);
});

test("shared refresh fences late failure as well as late success, and Retry clears a current error", async () => {
	installFetch(); await warm();
	await act(async () => snapshot.refresh()); await act(async () => snapshot.refresh());
	const fresh = catalog(); fresh.models = [b];
	await answer(2, fresh); await answer(1, null);
	assert.equal(snapshot.failed, false); assert.equal(snapshot.catalog?.models[0]?.id, b.id);
	await act(async () => snapshot.refresh()); await answer(3, null);
	assert.equal(snapshot.failed, true); assert.equal(snapshot.catalog?.models[0]?.id, b.id);
	await act(async () => snapshot.refresh()); assert.equal(snapshot.failed, false);
	await answer(4, fresh);
});

test("OpenCode's saved shared credential names both Pi providers without changing addable-provider semantics", () => {
	const providers = [{ id: "opencode", envVar: "OPENCODE_API_KEY", label: "OpenCode Zen" }, { id: "opencode-go", envVar: "OPENCODE_API_KEY", label: "OpenCode Go" }];
	assert.equal(providerKeyLabel("OPENCODE_API_KEY", providers), "OpenCode (Zen / Go)");
	assert.equal(providerKeyLabel("OPENCODE_API_KEY", [...providers].reverse()), "OpenCode (Zen / Go)");
	assert.equal(providerKeyLabel("FIXTURE_KEY", [provider]), "Fixture");
	assert.equal(classifyKeys([{ id: "OPENCODE_API_KEY", info: null, present: true, masked: "…fake", source: "file", shadowedByEnv: false }], providers).addable.length, 0);
});
