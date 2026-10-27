import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { launchChrome } from "./harness/chrome.ts";
import { reply, startStubProvider, type StubProvider, type StubRequest } from "./harness/stub-provider.ts";

// LH-37 follow-up: the extraction pipeline's extractor and auditor (Cheap
// slot) get the same auth fallback as jobs. A notes import whose Cheap model
// answers with Baseten's 403 completes on the Strong model; with no usable
// fallback the import reports the learner-readable text, and a session's
// failed extraction shows it in the coverage ring instead of only a log line.

const stubModel = (id: string) => ({ model: { provider: "e2e-stub", id } });
// stub-a works; stub-b answers like Baseten with a bad key; stub-c rejects too.
const MODELS = { strong: stubModel("stub-a"), cheap: stubModel("stub-b"), vision: stubModel("stub-a") };
const FINDINGS = { propositions: [{ id: "p1", name: "Limit", statement: "A limit is the value a function approaches as its input approaches a point." }], chains: [] };
const READABLE = /The Cheap model \(e2e-stub · stub-b\) was rejected by e2e-stub: HTTP 403, "please check the api-key you provided"\. Retrying on your Strong model \(e2e-stub · stub-c\) was rejected too: HTTP 403, .* Go to Settings → Providers to fix the key, or Settings → Agent → Models to switch the Cheap model to your ChatGPT\/Claude sign-in\./;

function respond(req: StubRequest) {
	if (req.model === "stub-b" || req.model === "stub-c") return reply.baseten403();
	if (req.tools.includes("submit_findings")) return reply.tools([{ name: "submit_findings", arguments: FINDINGS }]);
	if (req.tools.includes("submit_review")) return reply.tools([{ name: "submit_review", arguments: { links: [] } }]);
	return reply.text("Limits describe where a function is heading.");
}

let stub: StubProvider;
let server: LhServer;

before(async () => {
	stub = await startStubProvider(respond);
	server = await bootServer({
		ticket: "lh-37",
		providers: [{ id: "e2e-stub", baseUrl: stub.baseUrl, models: ["stub-a", "stub-b", "stub-c"].map((id) => ({ id })) }],
		settings: { version: 1, models: MODELS },
	});
});

after(async () => {
	await server?.stop();
	await stub?.close();
});

async function setModels(models: Record<string, unknown>): Promise<void> {
	await server.json("/api/settings/models", { method: "PUT", body: models });
}

async function importNotes(name: string): Promise<{ ok: boolean; outcome: string; error?: string }> {
	const form = new FormData();
	form.append("files", new File(["# Limits\n\nA limit is where a function is heading."], name, { type: "text/markdown" }));
	const res = await fetch(`${server.url}/api/graph/import`, { method: "POST", body: form });
	assert.equal(res.status, 200, await res.clone().text());
	return ((await res.json()) as { results: Array<{ ok: boolean; outcome: string; error?: string }> }).results[0]!;
}

test("a notes import whose Cheap model gets the Baseten 403 completes on the Strong model", async () => {
	await setModels(MODELS);
	const before = stub.requests.length;
	const result = await importNotes("limits.md");
	assert.equal(result.outcome, "completed", result.error);
	assert(result.ok);

	const stages = stub.requests.slice(before).map((r) => `${r.tools.includes("submit_findings") ? "extractor" : "auditor"}:${r.model}`);
	assert.deepEqual(stages, ["extractor:stub-b", "extractor:stub-a", "auditor:stub-b", "auditor:stub-a"]);
	const graph = await server.json<{ nodes: Array<{ name: string }> }>("/api/graph");
	assert(graph.nodes.some((n) => n.name === "Limit"), "the findings merged into the graph");
});

test("with no usable fallback the notes import reports the learner-readable failure", async () => {
	await setModels({ ...MODELS, strong: stubModel("stub-c") });
	const result = await importNotes("limits-2.md");
	assert.equal(result.ok, false);
	assert.equal(result.outcome, "failed");
	assert.match(result.error!, READABLE);
	await setModels(MODELS);
});

test("a session's failed extraction shows the learner-readable text in the coverage ring", async () => {
	await setModels(MODELS);
	const { id: chatId } = await server.json<{ id: string }>("/api/chats", { body: { title: "Limits" } });
	const res = await server.api("/api/chat", { body: { chatId, input: { type: "text", text: "Teach me limits." } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	await until(async () => !(await server.json<{ turnInFlight: boolean }>(`/api/chats/${chatId}`)).turnInFlight, "the turn to settle");

	// The session keeps stub-a; the Strong slot moves to stub-c, which rejects too.
	await setModels({ ...MODELS, strong: stubModel("stub-c") });
	assert.equal((await server.api("/api/graph/coverage/extract", { body: { chatId } })).status, 202);
	const coverage = await until(async () => {
		const c = (await server.json<{ coverage: { running: boolean; lastError: string | null } }>(`/api/chats/${chatId}`)).coverage;
		return !c.running && c.lastError ? c : null;
	}, "the extraction failure to surface", 60_000);
	assert.match(coverage.lastError!, READABLE);

	const chrome = await launchChrome("lh-37");
	try {
		const page = await chrome.browser.newPage();
		await page.goto(`${server.url}/chat/${chatId}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
		const ring = await page.waitForSelector('[data-testid="coverage-ring"]', { timeout: 120_000 });
		await ring!.click();
		const error = await page.waitForSelector('[data-testid="coverage-ring-error"]', { timeout: 30_000 });
		assert.match(await error!.evaluate((el) => el.textContent ?? ""), /Last extraction failed: The Cheap model \(e2e-stub · stub-b\) was rejected/);
	} finally {
		await chrome.close();
	}
	await setModels(MODELS);
});
