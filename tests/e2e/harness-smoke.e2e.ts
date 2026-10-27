import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { launchChrome } from "./harness/chrome.ts";
import { reply, startStubProvider, type StubProvider } from "./harness/stub-provider.ts";

// The harness's own proof: the real server boots on the stub provider, a
// learner turn round-trips through the stub, and headless Chrome renders
// the app. Also the template other e2e files copy.

let stub: StubProvider;
let server: LhServer;

before(async () => {
	stub = await startStubProvider(() => reply.text("Hello from the stub teacher."));
	const slot = { model: { provider: "e2e-stub", id: "stub-a" } };
	server = await bootServer({
		ticket: "lh-37",
		providers: [{ id: "e2e-stub", baseUrl: stub.baseUrl, models: [{ id: "stub-a", input: ["text", "image"] }] }],
		settings: { version: 1, models: { strong: slot, cheap: slot, vision: slot }, graph: { enabled: false } },
	});
});

after(async () => {
	await server?.stop();
	await stub?.close();
});

test("a learner turn round-trips through the stub provider", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Smoke" } });
	const res = await server.api("/api/chat", { body: { chatId: id, input: { type: "text", text: "Teach me limits." } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	const chat = await until(async () => {
		const c = await server.json<{ messages: Array<{ role: string; content: unknown }>; turnInFlight: boolean }>(`/api/chats/${id}`);
		return !c.turnInFlight && c.messages.some((m) => m.role === "assistant") ? c : null;
	}, "the assistant reply to persist");
	assert.match(JSON.stringify(chat.messages), /Hello from the stub teacher/);
	assert.equal(stub.requests[0]?.model, "stub-a");
});

test("headless Chrome renders the app", async () => {
	const chrome = await launchChrome("lh-37");
	try {
		const page = await chrome.browser.newPage();
		await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 180_000 });
		await until(async () => (await page.title()).length > 0, "a page title", 120_000);
	} finally {
		await chrome.close();
	}
});
