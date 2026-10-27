import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { calledTool, lastToolName, reply, startStubProvider, type StubProvider, type StubRequest } from "./harness/stub-provider.ts";

// LH-37: a demo job whose Cheap model rejects its key (Baseten's exact 403)
// falls back once to the Strong model; when that is impossible it fails
// within bounds with learner-readable text, even behind an open question.
// A 403 that is not about credentials (OpenRouter moderation) is a plain
// failure. A job that stops making progress, in a model call or in a step
// that ignores the abort signal, fails at the idle limit; a slow job that
// keeps making progress does not. The Background agents feed
// (/api/activity) empties every time.

const IDLE_LIMIT_MS = 30_000;
/** The final headless verification stalls this long (LH_E2E_DEMO_VERIFY_STALL_MS). */
const VERIFY_STALL_MS = 60_000;
const stubModel = (id: string) => ({ model: { provider: "e2e-stub", id } });
// stub-a works; stub-b answers like Baseten with a bad key; stub-c rejects too;
// stub-mod refuses like OpenRouter moderation; stub-hang never answers.
const MODELS = { strong: stubModel("stub-a"), cheap: stubModel("stub-b"), vision: stubModel("stub-a") };
const ASSESSMENT = { assessment: { strands: [{ strand: "limits", assessment: "Knows the idea, not the epsilon-delta form." }] } };
const DEMO_HTML = "<!doctype html><html><body><input type=range id=s><output id=o>0</output><script>s.oninput=()=>o.textContent=s.value</script></body></html>";
const ASK_MARKER = "[ask-a-question-too]";
// Learner-text markers that pick the demo's title, and through it the builder's script.
const STALL_MARKER = "[skip-run-demo]";
const SLOW_MARKER = "[slow-builder]";
const SLOW_STEP_MS = 14_000;
const MODERATION_403 = {
	error: {
		code: 403,
		message: "Your chosen model requires moderation and your input was flagged",
		metadata: { reasons: ["harassment"], flagged_input: "Teach me limits.", provider_name: "e2e-stub", model_slug: "stub-mod" },
	},
};

interface Job {
	id: string;
	status: string;
	error?: string;
	activity: string;
	delivery?: { status: string };
	result?: { html?: string; notes?: string; needsSettingsFix?: boolean };
	usage?: { model: string };
}
interface ChatRecord {
	messages: Array<{ id?: string; role: string; content: unknown; customType?: string }>;
	turnInFlight: boolean;
}

async function respond(req: StubRequest) {
	if (req.model === "stub-b" || req.model === "stub-c") return reply.baseten403();
	if (req.model === "stub-mod") return reply.http(403, MODERATION_403);
	if (req.model === "stub-hang") return reply.hang();
	const transcript = JSON.stringify(req.messages);
	if (req.system.includes("You are a demo builder")) {
		if (transcript.includes("Slow slider")) await new Promise((r) => setTimeout(r, SLOW_STEP_MS));
		const last = lastToolName(req);
		if (!last) return reply.tools([{ name: "write_demo", arguments: { html: DEMO_HTML } }]);
		// The stall script finishes without run_demo, so the builder's final verification runs.
		if (last === "write_demo" && !transcript.includes("Stalled slider")) return reply.tools([{ name: "run_demo", arguments: {} }]);
		return reply.text("A slider whose value is echoed beside it.");
	}
	if (req.tools.includes("probe_done") && !calledTool(req, "probe_done")) return reply.tools([{ name: "probe_done", arguments: ASSESSMENT }]);
	if (req.tools.includes("demo") && !calledTool(req, "demo")) {
		const title = transcript.includes(STALL_MARKER) ? "Stalled slider" : transcript.includes(SLOW_MARKER) ? "Slow slider" : "Limit slider";
		const calls: Array<{ name: string; arguments: unknown }> = [{ name: "demo", arguments: { title, brief: "One slider, value shown." } }];
		if (JSON.stringify(req.messages).includes(ASK_MARKER))
			calls.push({ name: "ask_user_question", arguments: { question: "Ready for the formal definition?" } });
		return reply.tools(calls, "Let me build a demo.");
	}
	return reply.text("Continuing the lesson.");
}

let stub: StubProvider;
let server: LhServer;

before(async () => {
	stub = await startStubProvider(respond);
	server = await bootServer({
		ticket: "lh-37",
		providers: [{
			id: "e2e-stub",
			baseUrl: stub.baseUrl,
			models: ["stub-a", "stub-b", "stub-c", "stub-mod", "stub-hang"].map((id) => ({ id, input: ["text", "image"] as Array<"text" | "image"> })),
		}],
		settings: { version: 1, models: MODELS, graph: { enabled: false } },
		env: { LH_E2E_JOB_IDLE_LIMIT_MS: String(IDLE_LIMIT_MS), LH_E2E_DEMO_VERIFY_STALL_MS: String(VERIFY_STALL_MS) },
	});
});

after(async () => {
	await server?.stop();
	await stub?.close();
});

/** Put the slot models in place (the PUT is the Settings → Agent → Models write). */
async function setModels(models: Record<string, unknown>): Promise<void> {
	await server.json("/api/settings/models", { method: "PUT", body: models });
}

/** Create a session (stamped with the current Strong model), send the learner's message, return the demo job. */
async function startLesson(text: string, beforeTurn?: () => Promise<void>): Promise<{ chatId: string; job: () => Promise<Job> }> {
	const { id: chatId } = await server.json<{ id: string }>("/api/chats", { body: { title: "Limits" } });
	await beforeTurn?.();
	const res = await server.api("/api/chat", { body: { chatId, input: { type: "text", text } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	const job = async () => {
		const { jobs } = await server.json<{ jobs: Job[] }>(`/api/jobs?chatId=${chatId}`);
		assert(jobs.length <= 1, "the teacher dispatched one demo");
		return jobs[0]!;
	};
	await until(job, "the teacher to dispatch the demo job", 120_000);
	return { chatId, job };
}

async function settledJob(job: () => Promise<Job>, timeoutMs: number): Promise<Job> {
	return until(async () => {
		const j = await job();
		return j.status !== "running" ? j : null;
	}, "the demo job to leave running", timeoutMs);
}

async function backgroundAgents(): Promise<unknown[]> {
	return (await server.json<{ jobs: unknown[] }>("/api/activity")).jobs;
}

async function chat(chatId: string): Promise<ChatRecord> {
	return server.json<ChatRecord>(`/api/chats/${chatId}`);
}

test("(a) a Cheap-model 403 falls back to the Strong model and the demo is delivered", async () => {
	await setModels(MODELS);
	const before = stub.requests.length;
	const { chatId, job } = await startLesson("Teach me limits.");
	const done = await settledJob(job, 120_000);

	assert.equal(done.status, "done", done.error);
	assert.equal(done.result?.html, DEMO_HTML);
	assert.equal(done.usage?.model, "e2e-stub:stub-a", "usage is billed to the model that ran");
	const builderModels = stub.requests.slice(before).filter((r) => r.system.includes("You are a demo builder")).map((r) => r.model);
	assert.equal(builderModels[0], "stub-b", "the Cheap model was tried first");
	assert(builderModels.slice(1).length > 0 && builderModels.slice(1).every((m) => m === "stub-a"), `one fallback onto stub-a, no loop: ${builderModels.join(",")}`);

	const record = await until(async () => {
		const c = await chat(chatId);
		return c.messages.some((m) => m.id === `steer_${done.id}`) && !c.turnInFlight ? c : null;
	}, "the demo steer to reach the lesson", 120_000);
	const steer = record.messages.find((m) => m.id === `steer_${done.id}`)!;
	assert.match(String(steer.content), /is built, headlessly tested/);
	assert.deepEqual(await backgroundAgents(), []);
});

test("(b) with no usable fallback the job fails in bounds, learner-readable, behind an open question", async () => {
	await setModels(MODELS);
	// The session keeps stub-a (stamped at creation); the Strong slot then
	// moves to stub-c, which rejects its key too.
	const started = Date.now();
	const { chatId, job } = await startLesson(`Teach me limits. ${ASK_MARKER}`, () => setModels({ ...MODELS, strong: stubModel("stub-c") }));
	const failed = await settledJob(job, 60_000);

	assert.equal(failed.status, "error");
	assert(Date.now() - started < 60_000);
	for (const text of [failed.error!, failed.result!.notes!]) {
		assert.match(text, /The Cheap model \(e2e-stub · stub-b\) was rejected by e2e-stub: HTTP 403, "please check the api-key you provided"\./);
		assert.match(text, /Retrying on your Strong model \(e2e-stub · stub-c\) was rejected too: HTTP 403/);
		assert.match(text, /Settings → Providers to fix the key, or Settings → Agent → Models to switch the Cheap model to your ChatGPT\/Claude sign-in/);
	}
	assert.equal(failed.result?.needsSettingsFix, true);
	assert.deepEqual(await backgroundAgents(), [], "no Background agents row stays behind");

	// The question card is still open, so delivery waits — but the job is terminal.
	const record = await chat(chatId);
	assert.equal(failed.delivery?.status, "pending");
	assert(!record.messages.some((m) => m.id === `steer_${failed.id}`));
	const ask = record.messages
		.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; name?: string; id?: string }>) : []))
		.find((b) => b.type === "toolCall" && b.name === "ask_user_question")!;
	assert(ask, "the question card is open");

	// Answering lets the steer land; it tells the teacher not to retry.
	const res = await server.api("/api/chat", {
		body: { chatId, input: { type: "answer", toolCallId: ask.id, answer: { kind: "ask", questionText: "Ready for the formal definition?", dontKnow: false, answers: [], text: "Yes", answeredAt: new Date().toISOString() } } },
	});
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	const delivered = await until(async () => (await chat(chatId)).messages.find((m) => m.id === `steer_${failed.id}`), "the failure steer to land", 120_000);
	assert.match(String(delivered.content), /Retrying won't help until the learner changes this setting, so don't call demo again\./);
	assert.match(String(delivered.content), /continue teaching without it/);
	await setModels(MODELS);
});

test("(c) a hung model call hits the idle limit and fails visibly", async () => {
	await setModels({ ...MODELS, cheap: stubModel("stub-hang") });
	const { job } = await startLesson("Teach me limits.");
	assert.deepEqual((await backgroundAgents()).length, 1, "the job shows as a running Background agent");
	const failed = await settledJob(job, IDLE_LIMIT_MS + 60_000);

	assert.equal(failed.status, "error");
	assert.equal(failed.error, `The demo job made no progress for ${IDLE_LIMIT_MS / 1000} seconds and was stopped.`);
	assert.equal(failed.activity, "failed");
	assert.deepEqual(await backgroundAgents(), []);
	await setModels(MODELS);
});

test("(d) a stalled step that ignores the abort fails at the idle limit, and its late result is dropped", async () => {
	await setModels({ ...MODELS, cheap: stubModel("stub-a") });
	const { chatId, job } = await startLesson(`Teach me limits. ${STALL_MARKER}`);
	const started = Date.now();
	const failed = await settledJob(job, VERIFY_STALL_MS - 5_000);

	assert(Date.now() - started < VERIFY_STALL_MS, "the job failed while the verification was still stalled");
	assert.equal(failed.status, "error");
	assert.equal(failed.error, `The demo job made no progress for ${IDLE_LIMIT_MS / 1000} seconds and was stopped.`);
	assert.equal(failed.activity, "failed");
	assert.equal(failed.result?.html, "");
	assert.deepEqual(await backgroundAgents(), [], "no Background agents row stays behind");

	// The stalled verification then finishes and the builder returns a passing demo: it must not land.
	await new Promise((r) => setTimeout(r, VERIFY_STALL_MS + 20_000 - (Date.now() - started)));
	const later = await job();
	assert.equal(later.status, "error");
	assert.equal(later.error, failed.error);
	assert.equal(later.activity, "failed");
	assert.equal(later.result?.html, "");
	const steers = (await chat(chatId)).messages.filter((m) => m.id === `steer_${failed.id}`);
	assert(steers.length <= 1, "one steer at most");
	if (steers[0]) assert.match(String(steers[0].content), /made no progress/);
	await setModels(MODELS);
});

test("(e) a slow job that keeps making progress outlives the idle limit", async () => {
	await setModels({ ...MODELS, cheap: stubModel("stub-a") });
	const { job } = await startLesson(`Teach me limits. ${SLOW_MARKER}`);
	const started = Date.now();
	const done = await settledJob(job, 180_000);

	assert(Date.now() - started > IDLE_LIMIT_MS, "the job ran longer than the idle limit");
	assert.equal(done.status, "done", done.error);
	assert.equal(done.result?.html, DEMO_HTML);
	assert.deepEqual(await backgroundAgents(), []);
	await setModels(MODELS);
});

test("(f) a 403 that is not about the key (OpenRouter moderation) is a plain failure", async () => {
	await setModels({ ...MODELS, cheap: stubModel("stub-mod") });
	const before = stub.requests.length;
	const { chatId, job } = await startLesson("Teach me limits.");
	const failed = await settledJob(job, 120_000);

	assert.equal(failed.status, "error");
	assert.match(failed.error!, /requires moderation and your input was flagged/);
	assert.equal(failed.result?.needsSettingsFix, undefined);
	for (const text of [failed.error!, failed.result!.notes!]) assert.doesNotMatch(text, /Settings →|fix the key|rejected by/);
	const builderModels = stub.requests.slice(before).filter((r) => r.system.includes("You are a demo builder")).map((r) => r.model);
	assert.deepEqual(builderModels, ["stub-mod"], "no fallback onto the Strong model");
	assert.deepEqual(await backgroundAgents(), []);

	const steer = await until(async () => (await chat(chatId)).messages.find((m) => m.id === `steer_${failed.id}`), "the failure steer to land", 120_000);
	assert.doesNotMatch(String(steer.content), /Retrying won't help/);
	await setModels(MODELS);
});
