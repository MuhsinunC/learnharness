import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { launchChrome, type HeadlessChrome } from "./harness/chrome.ts";
import { reply, startStubProvider, type StubProvider, type StubRequest, type StubResponder } from "./harness/stub-provider.ts";

// LH-40: a chat that outgrows the model's REAL window recovers. The stub
// model is registered with a 1.5M window (the misconfiguration), so the
// threshold compaction never fires; the stub enforces the real limit on
// the serialized messages and answers past it with pi-ai's real
// context-length 400, stating LIMIT_CHARS / 4 tokens.

const LIMIT_CHARS = 38_000;
const FILLER = "Limits describe what a function approaches. ".repeat(115);
const SUMMARY = [
	"## The learner's understanding",
	"The learner asked for a walk through limits and followed each step.",
	"## The teaching arc",
	"Several long explanations of limits.",
	"## The plan dependency tree",
	"- [upcoming] Limit intuition (limits-intuition)",
	"## The current moment",
	"The learner asked to keep going.",
].join("\n");
const SUMMARIZER = "You are the session-compaction summarizer";
const HEADER = "[SESSION HISTORY COMPACTED]";
const TREE = {
	nodes: [
		{ id: "limits-intuition", title: "Limit intuition" },
		{ id: "epsilon-delta", title: "Epsilon-delta definition" },
	],
	edges: [{ from: "limits-intuition", to: "epsilon-delta" }],
	version: 1,
};
const GRAPH_NODE = {
	id: "n_lh40seed",
	name: "Limit",
	statement: "A limit is the value a function approaches as its input approaches a point.",
	aliases: [],
	createdAt: "2026-10-27T00:00:00.000Z",
	provenance: [],
};

type Msg = { id: string; role: string; content?: unknown; stopReason?: string; errorMessage?: string; customType?: string; details?: { notice?: string; firstKeptMessageId?: string } };
type Chat = { messages: Msg[]; tree?: unknown; turnInFlight: boolean; compacting?: boolean };

const size = (req: StubRequest) => JSON.stringify(req.messages).length;
const lastLearnerText = (req: StubRequest) => {
	const content = req.messages.filter((m) => m.role === "user").at(-1)?.content;
	return typeof content === "string" ? content : JSON.stringify(content ?? "");
};
/** The reply names the learner message it answers, so a test can tell replies apart. */
const answer = (text: string) => `Answering "${text}". ${FILLER}`;
const limited = (limitChars: number): StubResponder => (req) => {
	if (size(req) > limitChars) return reply.contextLength(Math.floor(limitChars / 4));
	return reply.text(req.system.startsWith(SUMMARIZER) ? SUMMARY : answer(lastLearnerText(req)));
};
const isTurnRequest = (req: StubRequest) => !req.system.startsWith(SUMMARIZER);
const recoveryMarkers = (c: Chat) => c.messages.filter((m) => m.customType === "compaction" && m.details?.notice);
const isReply = (m: Msg | undefined) => m?.role === "assistant" && m.stopReason !== "error";

let stub: StubProvider;
let server: LhServer;
let chrome: HeadlessChrome;

before(async () => {
	stub = await startStubProvider(limited(LIMIT_CHARS));
	const slot = { model: { provider: "e2e-stub", id: "stub-a" } };
	server = await bootServer({
		ticket: "lh-40",
		providers: [{ id: "e2e-stub", baseUrl: stub.baseUrl, models: [{ id: "stub-a", contextWindow: 1_500_000 }] }],
		settings: { version: 1, models: { strong: slot, cheap: slot, vision: slot }, graph: { enabled: false } },
	});
	chrome = await launchChrome("lh-40");
});

after(async () => {
	await chrome?.close();
	await server?.stop();
	await stub?.close();
});

const chat = (id: string) => server.json<Chat>(`/api/chats/${id}`);
const settled = (id: string, label: string, done: (c: Chat) => boolean) =>
	until(async () => {
		const c = await chat(id);
		return !c.turnInFlight && !c.compacting && done(c) ? c : null;
	}, label, 120_000);

async function send(id: string, text: string): Promise<void> {
	const res = await server.api("/api/chat", { body: { chatId: id, input: { type: "text", text } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
}

/** Learner turns that all succeed (the chat grows ~5k chars per turn). */
async function grow(id: string, turns: number): Promise<void> {
	for (let i = 0; i < turns; i++) {
		const before = (await chat(id)).messages.filter(isReply).length;
		await send(id, `Keep going, part ${i + 1}.`);
		await settled(id, `growth turn ${i + 1}`, (c) => c.messages.filter(isReply).length > before && isReply(c.messages.at(-1)));
	}
}

function hashDir(dir: string): string {
	const h = crypto.createHash("sha256");
	for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) h.update(name).update(fs.readFileSync(path.join(dir, name)));
	return h.digest("hex");
}

async function newChat(title: string): Promise<string> {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title } });
	return id;
}

/** Open the chat and wait until React has hydrated `selector`. */
async function openChat(id: string, selector: string) {
	const page = await chrome.browser.newPage();
	await page.setViewport({ width: 1400, height: 900 });
	await page.goto(`${server.url}/chat/${id}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	await page.waitForFunction(
		(sel) => {
			const el = document.querySelector(sel);
			return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
		},
		{ timeout: 120_000 },
		selector,
	);
	return page;
}

/** Leave the chat as one broken before this release: the learner's
 *  message, then the provider's length rejection (pi-ai's persisted text
 *  for reply.contextLength, seen in a live run). */
function breakChat(id: string): void {
	const file = path.join(server.dataDir, "chats", `${id}.json`);
	const record = JSON.parse(fs.readFileSync(file, "utf-8")) as { messages: unknown[] };
	const limit = Math.floor(LIMIT_CHARS / 4);
	record.messages.push(
		{ id: `msg_lh40_user_${id}`, role: "user", content: `Explain it all again in detail. ${"Please. ".repeat(700)}`, timestamp: Date.now() },
		{
			id: `msg_lh40_error_${id}`,
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "e2e-stub",
			model: "stub-a",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			errorMessage: `400: {"message":"This model's maximum context length is ${limit} tokens. However, your messages resulted in ${limit + 1000} tokens.","type":"invalid_request_error","code":"context_length_exceeded"}`,
			timestamp: Date.now(),
		},
	);
	fs.writeFileSync(file, JSON.stringify(record));
	const lastGrowth = stub.requests.at(-1)!;
	assert.ok(size(lastGrowth) + JSON.stringify(record.messages.slice(-3)).length > LIMIT_CHARS, "the next request would be past the real window");
}

test("(a, c) an over-window chat recovers on the next learner turn, and the learning state is untouched", async () => {
	const id = await newChat("Limits of functions");
	// The learning state: a plan tree in the record, a node in the graph.
	const file = path.join(server.dataDir, "chats", `${id}.json`);
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf-8")), tree: TREE }));
	fs.mkdirSync(path.join(server.dataDir, "graph"), { recursive: true });
	fs.writeFileSync(path.join(server.dataDir, "graph", "nodes.jsonl"), `${JSON.stringify(GRAPH_NODE)}\n`);
	const graphBefore = hashDir(path.join(server.dataDir, "graph"));
	const graphApiBefore = await (await server.api("/api/graph")).text();

	await grow(id, 5);
	const grown = await chat(id);
	const start = stub.requests.length;

	// The learner is in the tab when the chat breaks: part 6 goes through
	// the composer, and the same page (no reload) must end on the
	// recovered reply and the notice, with no error banner or bubble.
	const page = await openChat(id, '[data-testid="composer"] textarea');
	try {
		await page.type('[data-testid="composer"] textarea', "Keep going, part 6.");
		await page.keyboard.press("Enter");
		await page.waitForFunction(
			() => document.body.innerText.includes('Answering "Keep going, part 6."') &&
				[...document.querySelectorAll('[data-testid="compaction-divider"]')].some((el) => el.textContent?.includes("condensed the older part and continued")),
			{ timeout: 120_000 },
		);
		assert.equal(await page.$('[data-testid="chat-error"]'), null, "no stale error banner");
		assert.ok(!(await page.evaluate(() => document.body.innerText)).includes("context_length_exceeded"), "the kept rejection renders nothing");
	} finally {
		await page.close();
	}
	const done = await settled(id, "the recovered reply", (c) => recoveryMarkers(c).length > 0 && isReply(c.messages.at(-1)));

	const turnRequests = stub.requests.slice(start).filter(isTurnRequest);
	assert.equal(turnRequests.length, 2, "the rejected turn and exactly one retry");
	assert.ok(size(turnRequests[0]!) > LIMIT_CHARS, "the first request really overflowed");
	const retried = turnRequests[1]!;
	assert.ok(size(retried) <= LIMIT_CHARS, `the retried request fits (${size(retried)} chars)`);
	assert.match(JSON.stringify(retried.messages), new RegExp(HEADER.replace(/[[\]]/g, "\\$&")));
	assert.match(JSON.stringify(retried.messages), /Current lesson topic: Limits of functions/);
	assert.match(JSON.stringify(retried.messages), /The learner asked for a walk through limits/, "the model summary fit, no fallback");
	assert.match(JSON.stringify(retried.messages.at(-1)), /Keep going, part 6/, "the learner's turn is what gets answered");

	const markers = recoveryMarkers(done);
	assert.equal(markers.length, 1);
	assert.equal(markers[0]!.details!.notice, "This chat had grown too long for stub-a; I condensed the older part and continued.");
	assert.match(JSON.stringify(done.messages.at(-1)!.content), /Answering \\"Keep going, part 6\.\\"/);

	// (c) Nothing was deleted: every earlier message survives, in order;
	// the plan tree and the graph are byte-identical.
	const ids = done.messages.map((m) => m.id);
	const kept = grown.messages.map((m) => ids.indexOf(m.id));
	assert.ok(kept.every((i, n) => i >= 0 && (n === 0 || i > kept[n - 1]!)), "full history kept in order");
	assert.deepEqual(done.tree, TREE);
	assert.equal(hashDir(path.join(server.dataDir, "graph")), graphBefore);
	assert.equal(await (await server.api("/api/graph")).text(), graphApiBefore);
});

test("(b) Repair this chat fixes a chat already in the broken state", async () => {
	const id = await newChat("Derivatives");
	await grow(id, 5);
	breakChat(id);

	const page = await openChat(id, '[data-testid="repair-chat"]');
	try {
		await page.click('[data-testid="repair-chat"]');
		await settled(id, "the repair marker", (c) => recoveryMarkers(c).length === 1);
		await page.waitForFunction(
			() => !document.querySelector('[data-testid="chat-error"]') &&
				[...document.querySelectorAll('[data-testid="compaction-divider"]')].some((el) => el.textContent?.includes("I condensed the older part.")),
			{ timeout: 60_000 },
		);
	} finally {
		await page.close();
	}

	const start = stub.requests.length;
	await send(id, "Thanks, carry on.");
	const done = await settled(id, "the reply after repair", (c) => isReply(c.messages.at(-1)));
	const turnRequests = stub.requests.slice(start).filter(isTurnRequest);
	assert.equal(turnRequests.length, 1, "the first send after repair succeeds");
	assert.ok(size(turnRequests[0]!) <= LIMIT_CHARS);
	assert.match(JSON.stringify(turnRequests[0]!.messages), /SESSION HISTORY COMPACTED/);
	assert.equal(recoveryMarkers(done).length, 1);
	assert.ok(done.messages.some((m) => m.id === `msg_lh40_error_${id}`), "the rejected reply is kept, never deleted");
});

test("(b) the session menu repairs a broken chat and refuses a healthy one", async () => {
	const id = await newChat("Sequences");
	await grow(id, 5);
	breakChat(id);
	const page = await openChat(id, '[data-testid="session-row"]');
	try {
		const rows = await page.$$('[data-testid="session-row"], [data-testid="session-row-kbd"]');
		let row = null;
		for (const r of rows) if ((await r.evaluate((el) => el.textContent ?? "")).includes("Sequences")) row = r;
		assert.ok(row, "the chat's sidebar row");
		await row.click({ button: "right" });
		await page.click('[data-testid="ctx-repair"]');
		const repaired = await settled(id, "the menu repair marker", (c) => recoveryMarkers(c).length === 1);
		assert.equal(repaired.messages.at(-1)!.customType, "compaction");
	} finally {
		await page.close();
	}
	// Once repaired (or never broken), repair refuses rather than compact a working chat.
	for (const target of [id, await newChat("Healthy")]) {
		const before = (await chat(target)).messages.length;
		const res = await server.api(`/api/chats/${target}/repair`, { method: "POST" });
		assert.equal(res.status, 409, await res.text());
		assert.equal((await chat(target)).messages.length, before);
	}
});

test("(d) recovery never loops: when even the smallest request is too big, the learner gets a clear failure", async () => {
	const id = await newChat("Integrals");
	await grow(id, 2);
	// The provider now refuses anything: even the system prompt alone is over.
	const tiny = 10_000;
	stub.setResponder(limited(tiny));
	try {
		const start = stub.requests.length;
		await send(id, "Next part, please.");
		const done = await settled(id, "the clear failure", (c) => /still too long/.test(c.messages.at(-1)?.errorMessage ?? ""));
		// Quiet window: nothing else may fire.
		await new Promise((r) => setTimeout(r, 8_000));
		const turnRequests = stub.requests.slice(start).filter(isTurnRequest);
		assert.equal(turnRequests.length, 2, "the rejected turn and one retry, never more");
		assert.ok(turnRequests.every((r) => size(r) > tiny));
		const final = await chat(id);
		assert.equal(final.messages.length, done.messages.length, "nothing ran after the failure");
		assert.equal(recoveryMarkers(final).length, 1);
		assert.match(JSON.stringify(recoveryMarkers(final)[0]!.content), /no model summary could be written/, "the deterministic fallback landed");
		assert.match(
			final.messages.at(-1)!.errorMessage!,
			/^This chat is still too long for stub-a, even after condensing its older part\. Start a new session, or pick a model with a larger context window\./,
		);
	} finally {
		stub.setResponder(limited(LIMIT_CHARS));
	}
});
