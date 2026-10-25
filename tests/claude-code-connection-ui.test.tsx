import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ClaudeCodeConnection, CLAUDE_LOGIN_POLL_MS, CLAUDE_LOGIN_POLL_LIMIT_MS } from "../components/settings/claude-code-connection.tsx";
import { SubscriptionConnections, NativeSubscriptionUIProvider } from "../components/settings/subscription-connections.tsx";
import { ChatGPTUIProvider } from "../components/settings/chatgpt-connection.tsx";
import { onSettingsSaved } from "../components/settings-signal.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
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
		const element = input(label); element.value = value;
		element.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}
const puts = (f: ReturnType<typeof fixture>) => f.calls.filter((c) => c.method === "PUT");
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; });

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
	const f = fixture({ login: { state: "pending", url: null } }); await mount();
	await type("Base URL", "https://relay.example"); await type("Token", "SENTINEL-TOKEN-7f3a");
	await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS));
	assert.equal(input("Base URL").value, "https://relay.example");
	f.set({ loggedIn: true }); await act(async () => t.mock.timers.tick(CLAUDE_LOGIN_POLL_MS));
	assert.equal(input("Base URL").value, "https://relay.example");
	assert.deepEqual(puts(f)[0]!.body, { mode: "local" });
	await type("Token", "SENTINEL-TOKEN-7f3a");
	await click(button("Save")); assert.deepEqual(puts(f)[1]!.body, { mode: "endpoint", baseUrl: "https://relay.example", token: "SENTINEL-TOKEN-7f3a" });
});
