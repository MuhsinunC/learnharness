import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { reply, startStubProvider, type StubProvider, type StubRequest } from "./harness/stub-provider.ts";

// LH-55: a request held back for want of reply room (LH-50) on a ChatGPT
// subscription. The real web-mode ChatGPT owner runs with a fake saved
// account; its catalog read and its turns go to the loopback stub
// (LH_E2E_CHATGPT_BASE_URL), never to OpenAI. Before LH-55 the
// subscription request cycle took the held-back request for an admission
// denial: it dropped the rejection, the turn ended on the learner's
// message, and neither recovery nor Repair ever ran.

const MODEL = "gpt-5";
/** The pair's custom window: small enough for one paste to be held back. */
const WINDOW = 40_000;
const SUMMARIZER = "You are the session-compaction summarizer";
const SUMMARY = "## The learner's understanding\nThe learner pasted calculus notes.\n## The current moment\nThe learner pasted more notes.";
const NOTES = "The derivative of x squared is two x, by the limit of the difference quotient. ";
/** About 3.4k wire tokens each, so four of them stay under the threshold. */
const seed = (n: number) => `Notes ${n}: ${NOTES.repeat(150)}`;
/** About 16k wire tokens: with the seeds and the prompt, past the window's reply floor. */
const PASTE = `All my notes at once: ${"A limit describes what a function approaches near a point. ".repeat(950)}`;

type Msg = { id: string; role: string; content?: unknown; stopReason?: string; errorMessage?: string; heldBack?: boolean; contextOverflow?: { unrecoverable?: boolean }; customType?: string; details?: { notice?: string } };
type Chat = { messages: Msg[]; turnInFlight: boolean; compacting?: boolean };

const isTurn = (req: StubRequest) => !req.system.startsWith(SUMMARIZER);
/** What a provider bills for the request (its usage anchors the held-back
 *  floor): the instructions, messages and tool declarations at chars/3.5. */
const billed = (req: StubRequest) =>
	Math.ceil((req.system.length + req.messages.reduce((n, m) => n + String(m.content ?? "").length, 0) + JSON.stringify(req.body.tools ?? []).length) / 3.5);
const pasted = (req: StubRequest) => req.messages.some((m) => JSON.stringify(m.content ?? "").includes("All my notes at once"));

let stub: StubProvider;
let server: LhServer;
let authDir: string;

before(async () => {
	stub = await startStubProvider(
		(req) => isTurn(req) ? reply.text("Checked: each step follows from the definition.", { prompt_tokens: billed(req), completion_tokens: 12 }) : reply.text(SUMMARY),
		{ chatgptModels: [{ slug: MODEL, display_name: "GPT-5", visibility: "list" }] },
	);
	// A saved ChatGPT account whose token never needs a refresh: nothing
	// reaches auth.openai.com. The credential file sits next to LH_AUTH_FILE.
	authDir = fs.mkdtempSync(path.join(os.homedir(), ".cache", "lh-e2e", "lh-55-auth-"));
	fs.writeFileSync(path.join(authDir, "auth.json"), "{}", { mode: 0o600 });
	fs.writeFileSync(path.join(authDir, "chatgpt-credentials.json"), JSON.stringify({
		version: 1,
		hostId: `urn:uuid:${randomUUID()}`,
		activeId: "e2e-account",
		allowBackgroundUse: true,
		registrations: [{
			id: "e2e-account", clientId: "e2e-client", issuer: "https://auth.openai.com", subject: "e2e-subject", email: "learner@example.invalid",
			tokens: { accessToken: "e2e-dummy-access-not-real", refreshToken: "e2e-dummy-refresh-not-real", idToken: "e2e.dummy.id", expiresAt: Date.now() + 30 * 86_400_000,
				scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"] },
		}],
	}), { mode: 0o600 });
	const slot = { model: { provider: "chatgpt", id: MODEL } };
	server = await bootServer({
		ticket: "lh-55",
		providers: [],
		settings: { version: 1, models: { strong: slot, cheap: slot, vision: slot }, contextWindows: { [`chatgpt:${MODEL}`]: WINDOW }, graph: { enabled: false } },
		env: { LH_AUTH_FILE: path.join(authDir, "auth.json"), LH_E2E_CHATGPT_BASE_URL: stub.baseUrl },
	});
});

after(async () => {
	await server?.stop();
	await stub?.close();
	if (authDir) fs.rmSync(authDir, { recursive: true, force: true });
});

const chat = (id: string) => server.json<Chat>(`/api/chats/${id}`);
const isReply = (m: Msg | undefined) => m?.role === "assistant" && m.stopReason !== "error";
const recoveryMarkers = (c: Chat) => c.messages.filter((m) => m.customType === "compaction" && m.details?.notice);

/** The background-use consent, through the same-origin control the Providers page uses. */
async function consent(enabled: boolean): Promise<void> {
	const res = await fetch(`${server.url}/api/subscriptions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-learnharness-subscriptions": "1", origin: server.url },
		body: JSON.stringify({ providerId: "chatgpt", op: "consent", enabled }),
	});
	assert.equal(res.status, 200, await res.text());
}

/** One learner turn, then wait until nothing runs for the chat (recovery included). */
async function turn(id: string, text: string): Promise<Chat> {
	const res = await server.api("/api/chat", { body: { chatId: id, input: { type: "text", text } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	const idle = (c: Chat) => !c.turnInFlight && !c.compacting && c.messages.at(-1)?.customType !== "compaction";
	await until(async () => idle(await chat(id)), `the turn "${text.slice(0, 12)}" to settle`, 120_000);
	// Recovery takes the compaction gate before the turn ends, so a chat
	// idle twice in a row has settled.
	await new Promise((r) => setTimeout(r, 1_500));
	return until(async () => {
		const c = await chat(id);
		return idle(c) ? c : null;
	}, "the chat to stay settled", 120_000);
}

async function seeded(title: string): Promise<string> {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title } });
	for (let n = 1; n <= 4; n++) assert.ok(isReply((await turn(id, seed(n))).messages.at(-1)), `seed ${n} is answered`);
	return id;
}

test("background use on: the held-back paste is condensed and retried, never dropped", async () => {
	const id = await seeded("Calculus notes");
	const start = stub.requests.length;
	const c = await turn(id, PASTE);
	const last = c.messages.at(-1);
	assert.notEqual(last?.role, "user", "the chat does not end silently on the learner's message");
	const heldBack = c.messages.find((m) => m.heldBack);
	assert.ok(heldBack, "the held-back rejection is in the record");
	assert.match(heldBack.errorMessage ?? "", /^Not sent: the reply would have only/);
	assert.equal(recoveryMarkers(c).length, 1, "recovery condensed the older part once");
	assert.ok(c.messages.indexOf(heldBack) < c.messages.indexOf(recoveryMarkers(c)[0]!), "the marker follows the rejection");
	assert.ok(isReply(last), "the retry is answered");
	const sent = stub.requests.slice(start);
	assert.ok(sent.some((r) => !isTurn(r)), "the summary went to the stub");
	assert.equal(sent.filter((r) => isTurn(r) && pasted(r)).length, 1, "one turn request carried the paste: the retry; the held-back one never left");
});

test("background use off: the held-back paste is explained, Repair is offered and works", async () => {
	await consent(false);
	try {
		const id = await seeded("More calculus notes");
		const start = stub.requests.length;
		const c = await turn(id, PASTE);
		const last = c.messages.at(-1)!;
		assert.equal(last.role, "assistant", "the chat does not end silently on the learner's message");
		assert.ok(last.heldBack, "the held-back rejection ends the turn");
		assert.match(last.errorMessage ?? "", /Condensing it automatically needs background use for this connection/);
		assert.notEqual(last.contextOverflow?.unrecoverable, true, "Repair stays offered");
		assert.equal(stub.requests.length, start, "nothing was dispatched: no turn, no summary");
		const listed = await server.json<{ chats: Array<{ id: string; repairable?: boolean }> }>("/api/chats");
		assert.equal(listed.chats.find((row) => row.id === id)?.repairable, true, "the session menu offers Repair");

		const repaired = await server.api(`/api/chats/${id}/repair`, { method: "POST" });
		assert.equal(repaired.status, 200, await repaired.text());
		assert.equal(recoveryMarkers(await chat(id)).length, 1, "Repair condensed the chat");
		const next = await turn(id, "Did those notes make sense?");
		assert.ok(isReply(next.messages.at(-1)), "the first send after Repair is answered");
	} finally {
		await consent(true);
	}
});
