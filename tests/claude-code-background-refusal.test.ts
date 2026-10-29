import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "lh-background-refusal-"));
const previousDataDir = process.env.LH_DATA_DIR;
process.env.LH_DATA_DIR = dir;
const { extraction } = await import("../src/server/chat-handler.ts");
const { stores } = await import("../src/server/stores.ts");
const { recoverStaleJobs, setTurnRunner } = await import("../src/server/jobs.ts");
const { enableClaudeCodeProvider, resetClaudeCodeProviderForTests } = await import("../src/agent/models.ts");
const { modelCatalog } = await import("../src/server/model-catalog.ts");
const { ProviderKeyMissingError, isProviderKeyRefusal, providerKeyMissing } = await import("../src/core/settings.ts");

after(() => {
	if (previousDataDir === undefined) delete process.env.LH_DATA_DIR;
	else process.env.LH_DATA_DIR = previousDataDir;
	rmSync(dir, { recursive: true, force: true });
});

async function withDisabledPin(run: () => Promise<void>) {
	const saved = stores.settingsStore.readSettings();
	try {
		enableClaudeCodeProvider("/nonexistent/claude");
		const model = modelCatalog().models.find((m) => m.provider === "claude-code");
		assert.ok(model);
		stores.settingsStore.writeSettings({ version: 1, models: { cheap: { model: { provider: model.provider, id: model.id } } } });
		resetClaudeCodeProviderForTests();
		await run();
	} finally {
		stores.settingsStore.writeSettings(saved ?? { version: 1 });
		resetClaudeCodeProviderForTests();
	}
}

it("production job respawn finalizes a disabled Claude Code pin as a provider-key refusal", async () => {
	await withDisabledPin(async () => {
		const chat = stores.chatStore.createChat("Disabled provider job");
		const job = stores.jobStore.createJob({ chatId: chat.id, kind: "research", toolCallId: "disabled-provider" });
		// Only replace the teacher wake, leaving chat-handler's real job respawn wired.
		setTurnRunner(async () => 200);
		recoverStaleJobs();
		await waitFor(() => stores.jobStore.getJob(job.id)?.status !== "running");
		const done = stores.jobStore.getJob(job.id)!;
		assert.equal(done.error, providerKeyMissing("claude-code", ["cheap"]).error);
		assert.equal(isProviderKeyRefusal(done.error), true);
		assert.equal(done.status, "error");
		assert.equal(done.activity, "failed");
		assert.ok(done.result, "normal refusal result is delivered and finalized");
	});
});

it("production extraction refuses a disabled Claude Code pin with ProviderKeyMissingError", async () => {
	await withDisabledPin(async () => {
		const chat = stores.chatStore.createChat("Disabled provider extraction");
		await assert.rejects(extraction.runExtraction(chat.id), (error: unknown) => {
			assert.ok(error instanceof ProviderKeyMissingError);
			assert.equal(error.envelope.code, "provider_key_missing");
			assert.equal(error.envelope.provider, "claude-code");
			assert.deepEqual(error.envelope.slots, ["cheap"]);
			assert.equal(isProviderKeyRefusal(error.message), true);
			return true;
		});
	});
});

function sweep() {
	const state = (globalThis as { __lhWakePipeline?: { lastSweepAt: number } }).__lhWakePipeline;
	if (state) state.lastSweepAt = 0;
	recoverStaleJobs();
}

async function waitFor(check: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("background job did not reach the expected state");
}

it("a refusing job preserves its original error when the teacher wake returns 503", async () => {
	await withDisabledPin(async () => {
		setTurnRunner(async () => 503);
		const chat = stores.chatStore.createChat("Refusal with failed wake");
		const job = stores.jobStore.createJob({ chatId: chat.id, kind: "research", toolCallId: "failed-wake" });
		sweep();
		await waitFor(() => stores.jobStore.getJob(job.id)?.status === "error");
		assert.equal(stores.jobStore.getJob(job.id)?.error, providerKeyMissing("claude-code", ["cheap"]).error);
		assert.equal(stores.jobStore.getJob(job.id)?.activity, "failed");
		assert.equal(stores.jobStore.getJob(job.id)?.delivery?.status, "pending");
	});
});

it("production respawn delivers a failure result for an available provider's missing catalog model", async () => {
	const saved = stores.settingsStore.readSettings();
	try {
		enableClaudeCodeProvider("/nonexistent/claude");
		stores.settingsStore.writeSettings({ version: 1, models: { cheap: { model: { provider: "claude-code", id: "no-such-model" } } } });
		let wakes = 0;
		const chat = stores.chatStore.createChat("Missing catalog model");
		// Count only this chat's wakes: the sweep may also retry earlier tests' pending deliveries.
		setTurnRunner(async (chatId) => { if (chatId === chat.id) wakes++; return 200; });
		const job = stores.jobStore.createJob({ chatId: chat.id, kind: "research", toolCallId: "missing-model" });
		sweep();
		await waitFor(() => stores.jobStore.getJob(job.id)?.status === "error" && wakes > 0);
		const done = stores.jobStore.getJob(job.id)!;
		assert.equal(done.error, "claude-code catalog has no model no-such-model");
		assert.equal(done.activity, "failed");
		assert.match(JSON.stringify(done.result), /claude-code catalog has no model no-such-model/);
		assert.equal(wakes, 1);
	} finally {
		stores.settingsStore.writeSettings(saved ?? { version: 1 });
		resetClaudeCodeProviderForTests();
	}
});

it("a parked refusal stays pending and stale recovery does not queue duplicate steers", async () => {
	await withDisabledPin(async () => {
		const { isJobLive } = await import("../src/agent/subagents/aborts.ts");
		setTurnRunner(async () => 200);
		const chat = stores.chatStore.createChat("Parked refusal");
		stores.chatStore.saveMessages(chat.id, [{
			id: "pending-quiz", role: "assistant",
			content: [{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "q", choices: ["a", "b"] } }],
			api: "openai-completions", provider: "openrouter", model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 1,
		} as never]);
		const job = stores.jobStore.createJob({ chatId: chat.id, kind: "research", toolCallId: "parked-refusal" });
		try {
			sweep();
			await waitFor(() => !!stores.jobStore.getJob(job.id)?.result);
			sweep();
			const state = (globalThis as { __lhWakePipeline?: { queues: Map<string, unknown[]> } }).__lhWakePipeline!;
			assert.equal(state.queues.get(chat.id)?.length, 1);
			assert.notEqual(stores.jobStore.getJob(job.id)?.activity, "recovering: re-delivering");
			assert.equal(isJobLive(job.id), false);
			assert.equal(stores.jobStore.getJob(job.id)?.delivery?.status, "pending");
		} finally {
			stores.chatStore.saveMessages(chat.id, []);
			await waitFor(() => stores.jobStore.getJob(job.id)?.status === "error" && !isJobLive(job.id));
		}
	});
});
