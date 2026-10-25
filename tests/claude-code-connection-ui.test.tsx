import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
// Enable React's input-event detection before loading the DOM renderer.
document.oninput = null;
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ClaudeCodeConnection, CLAUDE_LOGIN_POLL_MS, CLAUDE_LOGIN_POLL_LIMIT_MS } = await import("../components/settings/claude-code-connection.tsx");
const { SubscriptionConnections, NativeSubscriptionUIProvider } = await import("../components/settings/subscription-connections.tsx");
const { ChatGPTUIProvider } = await import("../components/settings/chatgpt-connection.tsx");
const { onSettingsSaved } = await import("../components/settings-signal.ts");
const storage = new Map<string, string>();
Object.assign(globalThis, { sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } } });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const initial = { mode: "off", envOverride: false, active: false, executable: "/Users/example/.local/bin/claude", found: true, loggedIn: false, account: null, login: { state: "idle", url: null as string | null, error: null as string | null }, endpoint: { baseUrl: null as string | null, tokenSet: false }, error: null };
type Call = { method: string; path: string; body?: Record<string, unknown> };
function fixture(overrides = {}) {
	let status = { ...initial, ...overrides }, failure: { code: number; error: string } | null = null;
	const calls: Call[] = [];
	let get: (() => void) | undefined;
	globalThis.fetch = (async (path, options) => {
		const call = { path: String(path), method: options?.method ?? "GET", ...(options?.body ? { body: JSON.parse(String(options.body)) } : {}) };
		calls.push(call);
		assert(["/api/claude-code", "/api/claude-code/login"].includes(call.path));
		if (call.method === "GET") get?.();
		if (call.method === "PUT" && failure) return { ok: false, status: failure.code, json: async () => ({ error: failure!.error }) } as Response;
		if (call.method === "POST") status = { ...status, login: { state: "pending", url: "https://claude.com/login", error: null } };
		if (call.method === "PUT") status = { ...status, mode: call.body.mode, endpoint: call.body.baseUrl ? { baseUrl: call.body.baseUrl, tokenSet: true } : status.endpoint };
		return { ok: true, json: async () => structuredClone(status) } as Response;
	}) as typeof fetch;
	return { calls, set: (next: object) => { status = { ...status, ...next }; }, fail: (error: string, code = 500) => { failure = { code, error }; }, onGet: (handler: () => void) => { get = handler; } };
}
async function mount() { host = document.createElement("div"); document.body.appendChild(host); await act(async () => { root = createRoot(host!); root.render(<ClaudeCodeConnection />); }); }
const text = () => host!.textContent!;
const input = (label: string) => host!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (label: string) => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
async function click(element: HTMLElement) { assert(element); await act(async () => element.click()); }
async function type(label: string, value: string) {
	await act(async () => {
		const element = input(label);
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
		element.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}
const puts = (f: ReturnType<typeof fixture>) => f.calls.filter((c) => c.method === "PUT");
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; storage.clear(); });

test("not found has only installation instructions and refresh", async () => {
	fixture({ found: false }); await mount(); assert(text().includes("Claude Code isn't installed on this computer.")); assert(text().includes("Install Claude Code from claude.com/claude-code, then come back here.")); assert(button("Refresh")); assert(!button("Log in with Claude")); assert(!host!.querySelector("input, details"));
});
test("logged out offers login and closed advanced section, tolerating missing fields", async () => {
	fixture({ endpoint: null, login: null, account: null, candidates: null, version: null }); await mount(); assert(button("Log in with Claude")); assert(!host!.querySelector("details")!.hasAttribute("open"));
});
for (const url of ["https://claude.com/login", "http://claude.com/login", "javascript:alert(1)", "invalid"]) test(`pending login only links https: ${url}`, async () => {
	fixture({ login: { state: "pending", url } }); await mount(); assert(text().includes("Finish signing in in your browser…")); assert.equal(host!.querySelector("a")?.getAttribute("href") ?? null, url.startsWith("https:") ? url : null);
});
test("logged in shows account, switch and binary", async () => {
	fixture({ loggedIn: true, mode: "local", account: { email: "user@example.com", subscriptionType: "pro" } }); await mount(); assert(text().includes("Signed in as user@example.com (pro)")); assert(text().includes(initial.executable)); assert.equal(host!.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "true");
});
test("environment override is read only", async () => {
	fixture({ envOverride: true, loggedIn: true }); await mount(); assert(text().includes("Configured by the LH_CLAUDE_CODE_EXECUTABLE environment variable.")); assert(text().includes("Signed in")); assert.equal(host!.querySelectorAll('button, input, [role="switch"], details').length, 0);
});
test("endpoint starts expanded with saved URL and empty secret", async () => {
	fixture({ mode: "endpoint", endpoint: { baseUrl: "https://relay.example", tokenSet: true } }); await mount(); assert(host!.querySelector("details")!.hasAttribute("open")); assert.equal(input("Base URL").value, "https://relay.example"); assert.equal(input("Token").value, ""); assert.equal(input("Token").placeholder, "Token saved — leave empty to keep it");
});
test("login posts, polls and enables local once, then stops polling", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture(); await mount(); await click(button("Log in with Claude")); assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
	let polls = 0; f.onGet(() => { if (++polls === 2) f.set({ loggedIn: true }); });
	for (let i = 0; i < 5; i++) await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS));
	assert.equal(polls, 2); assert.deepEqual(puts(f).map((c) => c.body), [{ mode: "local" }]);
});
test("pending GET resumes polling and timeout permits retry", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture({ login: { state: "pending", url: null } }); await mount();
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert.equal(f.calls.length, 2);
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_LIMIT_MS)); assert(text().includes("Sign-in timed out. Try again.")); assert(button("Log in with Claude"));
	const count = f.calls.length; await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS * 3)); assert.equal(f.calls.length, count);
});
test("failed login stops polling and displays login error", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture({ login: { state: "pending", url: null } }); await mount(); f.set({ login: { state: "failed", url: null, error: "Sign-in refused" } });
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert(text().includes("Sign-in refused")); assert(button("Log in with Claude"));
	const count = f.calls.length; await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS * 3)); assert.equal(f.calls.length, count);
});
for (const failure of [false, true]) test(`endpoint clears secret and redacts errors: failure=${failure}`, async () => {
	const f = fixture(); await mount(); await type("Base URL", "https://relay.example"); await type("Token", "SENTINEL-TOKEN-7f3a"); if (failure) f.fail("bad relay SENTINEL-TOKEN-7f3a", 400);
	await click(button("Save")); assert.deepEqual(puts(f)[0]!.body, { mode: "endpoint", baseUrl: "https://relay.example", token: "SENTINEL-TOKEN-7f3a" }); assert.equal(input("Token").value, ""); assert(!document.body.innerHTML.includes("SENTINEL-TOKEN-7f3a"));
	if (failure) assert(text().includes("The Claude connection could not be changed. Try again."));
	else { await click(button("Save")); assert.deepEqual(puts(f)[1]!.body, { mode: "endpoint", baseUrl: "https://relay.example" }); }
});
for (const url of ["http://relay.example", "ftp://x", "not a url", "http://localhost.evil.example", "http://127.0.0.1:9000", "http://localhost:9000"]) test(`endpoint validates exact protocol and hostname: ${url}`, async () => {
	const f = fixture({ endpoint: { baseUrl: null, tokenSet: true } }); await mount(); await type("Base URL", url); await click(button("Save"));
	const valid = url.endsWith(":9000"); assert.equal(puts(f).length, valid ? 1 : 0); if (!valid) assert(text().includes("Enter an https:// URL, or http://localhost or http://127.0.0.1 for a relay on this computer."));
});
test("unsaved endpoint requires token", async () => {
	const f = fixture(); await mount(); await type("Base URL", "https://relay.example"); await click(button("Save")); assert(text().includes("Enter a token.")); assert.equal(puts(f).length, 0);
});
for (const failure of [false, true]) test(`mode signal is emitted only for successful PUT: failure=${failure}`, async () => {
	const f = fixture({ loggedIn: true, mode: "local" }); await mount(); const events: string[] = []; const off = onSettingsSaved((section) => events.push(section));
	try { if (failure) f.fail("Unavailable"); await click(host!.querySelector('[role="switch"]')!); assert.deepEqual(puts(f)[0]!.body, { mode: "off" }); assert.deepEqual(events, failure ? [] : ["keys"]); } finally { off(); }
});
for (const loggedIn of [false, true]) test(`stop endpoint chooses local only when logged in: ${loggedIn}`, async () => {
	const f = fixture({ loggedIn, mode: "endpoint" }); await mount(); await click(button("Stop using endpoint")); assert.deepEqual(puts(f)[0]!.body, { mode: loggedIn ? "local" : "off" });
});
test("SSR preserves upstream Connect rows and places Claude last", () => {
	const html = renderToStaticMarkup(<ChatGPTUIProvider><NativeSubscriptionUIProvider><SubscriptionConnections /></NativeSubscriptionUIProvider></ChatGPTUIProvider>);
	assert.equal((html.match(/>Connect<\/button>/g) ?? []).length, 3); assert(!html.includes("@")); assert(html.indexOf('data-testid="claude-code-connection"') > html.indexOf('data-testid="xai-connection"'));
});
test("network errors stay inline and refresh retries", async () => {
	globalThis.fetch = async () => { throw new Error("network"); }; await mount(); assert(text().includes("Could not read the Claude Code status. Try again."));
	fixture(); await click(button("Refresh")); assert(button("Log in with Claude"));
});
test("initial GET renders no controls and unmounted completion is ignored", async () => {
	let resolve!: (value: Response) => void;
	globalThis.fetch = () => new Promise<Response>((done) => { resolve = done; });
	await mount(); assert.equal(host!.querySelectorAll("button, input").length, 0);
	await act(async () => root!.unmount()); root = undefined;
	await act(async () => resolve({ ok: true, json: async () => initial } as Response)); assert.equal(host!.innerHTML, "");
});
test("mode refresh waits for successful reply and controls lock during writes", async () => {
	fixture({ loggedIn: true, mode: "local" }); await mount();
	let resolve!: (value: Response) => void;
	globalThis.fetch = () => new Promise<Response>((done) => { resolve = done; });
	const events: string[] = [], off = onSettingsSaved((section) => events.push(section));
	try {
		await click(host!.querySelector('[role="switch"]')!); assert.deepEqual(events, []);
		assert([...host!.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")].every((item) => item.disabled));
		await act(async () => resolve({ ok: true, json: async () => ({ ...initial, loggedIn: true }) } as Response)); assert.deepEqual(events, ["keys"]);
	} finally { off(); }
});
for (const kind of ["network", "parse", "api"]) test(`failed PUT clears token and leaves endpoint status unchanged: ${kind}`, async () => {
	fixture(); await mount(); await type("Base URL", "https://relay.example"); await type("Token", "SENTINEL-TOKEN-7f3a");
	globalThis.fetch = async () => {
		if (kind === "network") throw new Error("SENTINEL-TOKEN-7f3a");
		return { ok: true, json: async () => { if (kind === "parse") throw new Error("SENTINEL-TOKEN-7f3a"); return { error: "SENTINEL-TOKEN-7f3a" }; } } as Response;
	};
	const events: string[] = [], off = onSettingsSaved((section) => events.push(section));
	try { await click(button("Save")); assert.equal(input("Token").value, ""); assert(!document.body.innerHTML.includes("SENTINEL-TOKEN-7f3a")); assert(host!.querySelector('[role="alert"]')); assert(!button("Stop using endpoint")); assert.deepEqual(events, []); } finally { off(); }
});
test("login deadline does not discard an endpoint write already in flight", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	fixture({ login: { state: "pending", url: null } }); await mount();
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_LIMIT_MS - CLAUDE_LOGIN_POLL_MS));
	await type("Base URL", "https://relay.example"); await type("Token", "SENTINEL-TOKEN-7f3a");
	let resolve!: (value: Response) => void;
	globalThis.fetch = () => new Promise<Response>((done) => { resolve = done; });
	const events: string[] = [], off = onSettingsSaved((section) => events.push(section));
	try {
		await click(button("Save")); await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS));
		assert(button("Save").disabled);
		await act(async () => resolve({ ok: true, json: async () => ({ ...initial, mode: "endpoint", endpoint: { baseUrl: "https://relay.example", tokenSet: true }, login: { state: "pending", url: null } }) } as Response));
		assert.deepEqual(events, ["keys"]); assert(button("Stop using endpoint")); assert(button("Log in with Claude")); assert.equal(input("Token").value, "");
	} finally { off(); }
});

test("pending login polls preserve the custom endpoint URL draft", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture(); await mount(); await click(button("Log in with Claude"));
	await type("Base URL", "https://relay.example"); await type("Token", "SENTINEL-TOKEN-7f3a");
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS));
	assert.equal(input("Base URL").value, "https://relay.example");
	f.set({ loggedIn: true }); await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS));
	assert.equal(input("Base URL").value, "https://relay.example");
	assert.deepEqual(puts(f)[0]!.body, { mode: "local" });
	await type("Token", "SENTINEL-TOKEN-7f3a");
	await click(button("Save")); assert.deepEqual(puts(f)[1]!.body, { mode: "endpoint", baseUrl: "https://relay.example", token: "SENTINEL-TOKEN-7f3a" });
});

test("GET status with an API error still shows signed-in content", async () => {
	fixture({ loggedIn: true, mode: "local", error: "auth status timed out" }); await mount();
	assert(text().includes("Signed in")); assert(text().includes("auth status timed out"));
	assert(host!.querySelector('[role="switch"]'));
});
test("PUT status with an API error notifies when its mode committed", async () => {
	fixture({ loggedIn: true, mode: "local" }); await mount();
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...initial, loggedIn: true, mode: "off", error: "auth status timed out" }) }) as Response;
	const events: string[] = [], off = onSettingsSaved((section) => events.push(section));
	try {
		await click(host!.querySelector('[role="switch"]')!);
		assert.equal(host!.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "false");
		assert(text().includes("auth status timed out")); assert.deepEqual(events, ["keys"]);
	} finally { off(); }
});
test("endpoint saves preempt background polling and ignore its late reply", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	fixture({ login: { state: "pending", url: null } }); await mount();
	let resolve!: (value: Response) => void;
	const calls: Call[] = [];
	globalThis.fetch = (async (path, options) => {
		const method = options?.method ?? "GET";
		calls.push({ path: String(path), method, ...(options?.body ? { body: JSON.parse(String(options.body)) } : {}) });
		if (method === "GET") return new Promise<Response>((done) => { resolve = done; });
		return { ok: true, json: async () => ({ ...initial, mode: "endpoint", endpoint: { baseUrl: "https://relay.example", tokenSet: true } }) } as Response;
	}) as typeof fetch;
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS));
	assert(!input("Base URL").disabled); assert(!input("Token").disabled); assert(!button("Save").disabled);
	await type("Base URL", "https://relay.example"); await type("Token", "SENTINEL-TOKEN-7f3a");
	await click(button("Save")); assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
	assert(button("Stop using endpoint"));
	await act(async () => resolve({ ok: true, json: async () => ({ ...initial, loggedIn: true, mode: "off" }) } as Response));
	assert(button("Stop using endpoint")); assert.equal(host!.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "true");
	assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
});
test("status-bearing PUT errors redact the submitted token", async () => {
	fixture(); await mount(); await type("Base URL", "https://relay.example"); await type("Token", "SENTINEL-TOKEN-7f3a");
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...initial, mode: "endpoint", endpoint: { baseUrl: "https://relay.example", tokenSet: true }, error: "bad relay SENTINEL-TOKEN-7f3a" }) }) as Response;
	const events: string[] = [], off = onSettingsSaved((section) => events.push(section));
	try {
		await click(button("Save")); assert(button("Stop using endpoint")); assert.equal(input("Token").value, "");
		assert(!document.body.innerHTML.includes("SENTINEL-TOKEN-7f3a")); assert(text().includes("The Claude connection could not be changed. Try again.")); assert.deepEqual(events, ["keys"]);
	} finally { off(); }
});
test("Base URL changes through React onChange without controlled-input warnings", async (t) => {
	const errors: unknown[][] = []; t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
	fixture(); await mount(); await type("Base URL", "https://relay.example");
	assert.equal(input("Base URL").value, "https://relay.example"); assert.deepEqual(errors, []);
});
test("a held background poll expires at the login deadline", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	fixture({ login: { state: "pending", url: null } }); await mount();
	let resolve!: (value: Response) => void;
	globalThis.fetch = () => new Promise<Response>((done) => { resolve = done; });
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS));
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_LIMIT_MS));
	assert(text().includes("Sign-in timed out. Try again.")); assert(!button("Log in with Claude").disabled);
	await act(async () => resolve({ ok: true, json: async () => ({ ...initial, loggedIn: true }) } as Response));
	assert(button("Log in with Claude")); assert(!host!.querySelector('[role="switch"]'));
});

const endpoint = { baseUrl: "https://relay.example", tokenSet: true };
async function unmount() { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; }
for (const mode of ["local", "endpoint"]) test(`login completion preserves the already chosen ${mode} backend`, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture({ mode, endpoint }); await mount(); await click(button("Log in with Claude"));
	f.set({ loggedIn: true, login: { state: "idle", url: null } });
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS));
	assert.deepEqual(puts(f), []);
});
test("a user mode change during login prevents automatic activation", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture(); await mount(); await click(button("Log in with Claude"));
	await type("Base URL", endpoint.baseUrl); await type("Token", "SENTINEL-TOKEN-7f3a"); await click(button("Save"));
	await click(host!.querySelector('[role="switch"]')!);
	f.set({ loggedIn: true, login: { state: "idle", url: null } });
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS));
	assert.deepEqual(puts(f).map(c => c.body?.mode), ["endpoint", "off"]);
});
test("backend choice is remembered while off and restored by the toggle", async () => {
	const f = fixture({ mode: "endpoint", loggedIn: true, endpoint }); await mount();
	assert(input("custom endpoint").checked);
	await click(host!.querySelector('[role="switch"]')!); await click(host!.querySelector('[role="switch"]')!);
	assert.deepEqual(puts(f).map(c => c.body), [{ mode: "off" }, { mode: "endpoint" }]);
	await click(input("my Claude login")); assert.deepEqual(puts(f).at(-1)?.body, { mode: "local" });
});
test("changing backend while off sends no request and on needs a usable backend", async () => {
	const f = fixture({ endpoint }); await mount();
	assert((host!.querySelector('[role="switch"]') as HTMLButtonElement).disabled);
	await click(input("custom endpoint")); assert.deepEqual(puts(f), []);
	assert(!(host!.querySelector('[role="switch"]') as HTMLButtonElement).disabled);
	await click(host!.querySelector('[role="switch"]')!); assert.deepEqual(puts(f)[0]!.body, { mode: "endpoint" });
});
test("without an endpoint there is no choice and the toggle uses local", async () => {
	const f = fixture({ loggedIn: true }); await mount(); assert(!host!.querySelector('[type="radio"]'));
	await click(host!.querySelector('[role="switch"]')!); assert.deepEqual(puts(f)[0]!.body, { mode: "local" });
});
for (const mode of ["local", "endpoint"]) test(`signed-out ${mode} can always be turned off`, async () => {
	const f = fixture({ mode, error: "auth status timed out" }); await mount();
	assert(button("Log in with Claude")); const toggle = host!.querySelector<HTMLButtonElement>('[role="switch"]')!;
	assert(!toggle.disabled); await click(toggle); assert.deepEqual(puts(f)[0]!.body, { mode: "off" });
});
test("mode-only writes preserve the unsubmitted token draft", async () => {
	fixture({ loggedIn: true, mode: "local", endpoint }); await mount(); await type("Token", "SENTINEL-TOKEN-7f3a");
	await click(host!.querySelector('[role="switch"]')!); assert.equal(input("Token").value, "SENTINEL-TOKEN-7f3a");
	await click(input("custom endpoint")); await click(host!.querySelector('[role="switch"]')!);
	assert.equal(input("Token").value, "SENTINEL-TOKEN-7f3a");
});
test("login activation survives remount and is consumed exactly once", async () => {
	const f = fixture(); await mount(); await click(button("Log in with Claude")); assert.equal(storage.size, 1);
	await unmount(); f.set({ loggedIn: true, login: { state: "idle", url: null } }); await mount();
	assert.deepEqual(puts(f).map(c => c.body), [{ mode: "local" }]); assert.equal(storage.size, 0);
	await unmount(); await mount(); assert.equal(puts(f).length, 1);
});
test("expired login markers do not activate a remounted card", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture(); await mount(); await click(button("Log in with Claude")); await unmount();
	t.mock.timers.tick(CLAUDE_LOGIN_POLL_LIMIT_MS);
	f.set({ loggedIn: true, login: { state: "idle", url: null } }); await mount(); assert.deepEqual(puts(f), []); assert.equal(storage.size, 0);
});
test("user writes clear activation for later remounts", async () => {
	const f = fixture({ endpoint }); await mount(); await click(button("Log in with Claude"));
	await click(input("custom endpoint")); await click(host!.querySelector('[role="switch"]')!);
	await click(host!.querySelector('[role="switch"]')!); await unmount();
	f.set({ loggedIn: true, login: { state: "idle", url: null } }); await mount();
	assert.deepEqual(puts(f).map(c => c.body?.mode), ["endpoint", "off"]); assert.equal(storage.size, 0);
});
test("background recovery clears only background errors", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	fixture({ login: { state: "pending", url: null } }); await mount(); const fetchStatus = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("offline"); };
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert(host!.querySelector('[role="alert"]'));
	globalThis.fetch = fetchStatus;
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert(!host!.querySelector('[role="alert"]'));
	await type("Base URL", "not a url"); await click(button("Save"));
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert(text().includes("Enter an https:// URL"));
});
for (const changed of [false, true]) test(`error-bearing write signals only a committed status change: ${changed}`, async () => {
	fixture({ loggedIn: true, mode: "local" }); await mount();
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...initial, loggedIn: true, mode: changed ? "off" : "local", error: "auth status timed out" }) }) as Response;
	const events: string[] = [], off = onSettingsSaved(s => events.push(s));
	try { await click(host!.querySelector('[role="switch"]')!); assert.deepEqual(events, changed ? ["keys"] : []); } finally { off(); }
});
test("a completed write notifies even after unmount", async () => {
	fixture({ loggedIn: true, mode: "local" }); await mount(); let resolve!: (r: Response) => void;
	globalThis.fetch = () => new Promise<Response>(done => { resolve = done; });
	const events: string[] = [], off = onSettingsSaved(s => events.push(s));
	try {
		await click(host!.querySelector('[role="switch"]')!); await unmount();
		await act(async () => resolve({ ok: true, json: async () => ({ ...initial, loggedIn: true }) } as Response));
		assert.deepEqual(events, ["keys"]);
	} finally { off(); }
});
for (const account of [{ subscriptionType: "pro" }, { email: null, subscriptionType: null }]) test(`account without email renders a clean identity: ${account.subscriptionType}`, async () => {
	fixture({ loggedIn: true, account }); await mount();
	assert(text().includes(account.subscriptionType ? "Signed in (pro)" : "Signed in"));
	assert(!text().includes("undefined")); assert(!text().includes("null")); assert(!text().includes("Signed in as"));
});
for (const url of ["https://user:pass@relay.example", "https://relay.example/?", "https://relay.example/#"]) test(`shared endpoint predicate rejects ${url} without clearing token`, async () => {
	const f = fixture(); await mount(); await type("Base URL", url); await type("Token", "SENTINEL-TOKEN-7f3a"); await click(button("Save"));
	assert.deepEqual(puts(f), []); assert.equal(input("Token").value, "SENTINEL-TOKEN-7f3a");
});

test("login failure clears the remount activation marker", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture(); await mount(); await click(button("Log in with Claude"));
	f.set({ login: { state: "failed", url: null, error: "Login failed" } });
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert.equal(storage.size, 0);
	await unmount(); f.set({ loggedIn: true, login: { state: "idle", url: null } }); await mount(); assert.deepEqual(puts(f), []);
});
test("login works when session storage is unavailable", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	for (const method of ["getItem", "setItem", "removeItem"] as const) t.mock.method(sessionStorage, method, () => { throw new Error("storage disabled"); });
	const f = fixture(); await mount(); await click(button("Log in with Claude")); f.set({ loggedIn: true });
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert.deepEqual(puts(f).map(c => c.body), [{ mode: "local" }]);
});

test("failed backend changes keep the current selection", async () => {
	const f = fixture({ loggedIn: true, mode: "local", endpoint }); await mount(); f.fail("cannot save");
	await click(input("custom endpoint")); assert(input("my Claude login").checked); assert(!input("custom endpoint").checked);
});
test("a missing executable does not prevent disabling an active mode", async () => {
	const f = fixture({ found: false, mode: "local" }); await mount();
	await click(host!.querySelector('[role="switch"]')!); assert.deepEqual(puts(f)[0]!.body, { mode: "off" });
});

test("an expired marker cannot restart activation from a pending GET", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture(); await mount(); await click(button("Log in with Claude")); await unmount();
	t.mock.timers.tick(CLAUDE_LOGIN_POLL_LIMIT_MS); await mount();
	assert(button("Log in with Claude")); f.set({ loggedIn: true });
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert.deepEqual(puts(f), []);
});

test("logging in while an endpoint is selected off does not override the choice", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture({ endpoint }); await mount(); await click(input("custom endpoint")); await click(button("Log in with Claude"));
	f.set({ loggedIn: true, login: { state: "idle", url: null } });
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert.deepEqual(puts(f), []); assert(input("custom endpoint").checked);
});

test("a pending GET without click-created eligibility never activates local", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture({ login: { state: "pending", url: null } }); await mount();
	f.set({ loggedIn: true, login: { state: "idle", url: null } });
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert.deepEqual(puts(f), []);
});
test("even a failed user endpoint write cancels login activation", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const f = fixture(); await mount(); await click(button("Log in with Claude"));
	f.fail("cannot save endpoint"); await type("Base URL", endpoint.baseUrl); await type("Token", "SENTINEL-TOKEN-7f3a"); await click(button("Save"));
	f.set({ loggedIn: true, login: { state: "idle", url: null } });
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS));
	assert.deepEqual(puts(f).map(c => c.body?.mode), ["endpoint"]); assert.equal(storage.size, 0);
});
test("poll failure and recovery preserve a validation error", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	fixture({ login: { state: "pending", url: null } }); await mount();
	await type("Base URL", "invalid"); await click(button("Save")); const fetchStatus = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("offline"); };
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert(text().includes("Enter an https:// URL"));
	globalThis.fetch = fetchStatus;
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS)); assert(text().includes("Enter an https:// URL"));
});
test("a login failure after unmount clears the activation marker", async () => {
	fixture(); await mount(); let resolve!: (r: Response) => void;
	globalThis.fetch = () => new Promise<Response>(done => { resolve = done; });
	await click(button("Log in with Claude")); assert.equal(storage.size, 1); await unmount();
	await act(async () => resolve({ ok: false, json: async () => ({ error: "login failed" }) } as Response));
	assert.equal(storage.size, 0);
});
