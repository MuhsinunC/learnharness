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
		for (let i = 0; i < 100 && stores.jobStore.getJob(job.id)?.status === "running"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
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
