import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { maxOutputTokens, reply, startStubProvider, type StubProvider, type StubRequest } from "./harness/stub-provider.ts";

// The engine's request options as they reach the provider (LH-54 moved
// these pins here from tests/max-output-tokens.test.ts and
// tests/openrouter-routing.test.ts). With LH_MAX_OUTPUT_TOKENS set, a
// model whose max output is above it asks for the cap, and one below it
// for its own; an OpenRouter model pinned in LH_OPENROUTER_ROUTING_FILE
// carries its provider routing, on the same request as the cap, and no
// other model carries any. With neither set, every model asks for its
// own max output and nothing is pinned.

const STUB = "openrouter";
const CAP = 32_000;
const ROUTING = { only: ["sail-research/us"], allow_fallbacks: false };
const models = [
	{ id: "stub-big", contextWindow: 400_000, maxTokens: 64_000 },
	{ id: "stub-small", contextWindow: 400_000, maxTokens: 16_384 },
];

let stub: StubProvider;
const servers: LhServer[] = [];
let routingDir: string;

before(async () => {
	stub = await startStubProvider(() => reply.text("ok"));
	fs.mkdirSync(path.join(os.homedir(), ".cache", "lh-e2e"), { recursive: true });
	routingDir = fs.mkdtempSync(path.join(os.homedir(), ".cache", "lh-e2e", "lh-54-routing-"));
	fs.writeFileSync(path.join(routingDir, "routing.json"), JSON.stringify({ "stub-big": ROUTING }));
});

after(async () => {
	for (const server of servers) await server.stop();
	await stub?.close();
	fs.rmSync(routingDir, { recursive: true, force: true });
});

async function boot(env: Record<string, string>): Promise<LhServer> {
	const slot = { model: { provider: STUB, id: "stub-big" } };
	const server = await bootServer({
		ticket: "lh-54",
		providers: [{ id: STUB, baseUrl: stub.baseUrl, models }],
		settings: { version: 1, models: { strong: slot, cheap: slot, vision: slot }, graph: { enabled: false } },
		env,
	});
	servers.push(server);
	await server.json("/api/keys/OPENROUTER_API_KEY", { method: "PUT", body: { value: "e2e-dummy-key-not-real" } });
	return server;
}

/** One learner turn on `model`; the request the stub received for it. */
async function turnRequest(server: LhServer, model: string): Promise<StubRequest> {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: `On ${model}` } });
	if (model !== "stub-big") await server.json(`/api/chats/${id}/settings`, { method: "PUT", body: { model: { provider: STUB, id: model } } });
	const start = stub.requests.length;
	const res = await server.api("/api/chat", { body: { chatId: id, input: { type: "text", text: "Teach me limits." } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	const sent = await until(() => stub.requests.slice(start).find((r) => r.model === model && r.tools.length > 0), `a ${model} turn request`);
	await until(async () => !(await server.json<{ turnInFlight: boolean }>(`/api/chats/${id}`)).turnInFlight, "the turn to settle");
	return sent;
}

test("with the cap and a routing pin: the big model asks for the cap and carries its pin; the small one asks for its own and carries none", async () => {
	const server = await boot({ LH_MAX_OUTPUT_TOKENS: String(CAP), LH_OPENROUTER_ROUTING_FILE: path.join(routingDir, "routing.json") });
	const big = await turnRequest(server, "stub-big");
	assert.equal(maxOutputTokens(big), CAP, "64,000 is capped at 32,000");
	assert.deepEqual(big.body.provider, ROUTING, "the pinned model's routing, on the capped request");
	const small = await turnRequest(server, "stub-small");
	assert.equal(maxOutputTokens(small), 16_384, "a max output under the cap is left alone");
	assert.equal(small.body.provider, undefined, "an unpinned model carries no routing");
});

test("with neither set: every model asks for its own max output, and nothing is pinned", async () => {
	const server = await boot({});
	const big = await turnRequest(server, "stub-big");
	assert.equal(maxOutputTokens(big), 64_000);
	assert.equal(big.body.provider, undefined);
	assert.equal(maxOutputTokens(await turnRequest(server, "stub-small")), 16_384);
});
