import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, beforeEach, test } from "node:test";
import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { normalizeContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getProjectDir } from "cc-session-io";
import { enableClaudeCodeProvider, piEngineForSpec, piModels, resetClaudeCodeProviderForTests } from "../src/agent/models.ts";
import { claudeCodeCatalog, claudeCodeModelId, CLAUDE_CODE_SETTINGS, MEASURED_ONE_M } from "../src/agent/claude-code/models.ts";
import { resetClaudeCodeStreamForTests } from "../src/agent/claude-code/stream.ts";

let root: string, oldHome: string | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "lh-provider-"));
	oldHome = process.env.HOME;
	process.env.HOME = join(root, "home"); mkdirSync(process.env.HOME);
	resetClaudeCodeProviderForTests(); resetClaudeCodeStreamForTests();
});
afterEach(async () => {
	await tick(); resetClaudeCodeProviderForTests();
	if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
	rmSync(root, { recursive: true, force: true });
});
function fake() {
	let loads = 0;
	const calls: { model: string | null | undefined; file?: string; options: Parameters<typeof query>[0]["options"] }[] = [];
	const deps = {
		dataDir: join(root, "data"), claudeDir: join(root, "claude"),
		logger: { debug() {}, warn(message: string) { assert.fail(message); } },
		loadQuery: async () => {
			loads++;
			return (({ options }: Parameters<typeof query>[0]) => {
				calls.push({ model: options?.extraArgs?.model, options,
					file: options?.resume ? readFileSync(join(getProjectDir(options.cwd!, deps.claudeDir), options.resume + ".jsonl"), "utf8") : undefined });
				const iterator = (async function* () {
					yield { type: "assistant", message: { id: "answer", content: [{ type: "text", text: "OK" }], usage: {} } } as SDKMessage;
					yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
				})();
				return Object.assign(iterator, { interrupt: async () => {}, close() {} });
			}) as typeof query;
		},
	};
	return { deps, calls, loads: () => loads };
}
const providerIds = () => piModels().getProviders().map(p => p.id);
const builtinIds = () => builtinProviders().map(p => p.id);

test("registration before collection creation is applied lazily", () => {
	const h = fake(); enableClaudeCodeProvider("/abs/stub", h.deps);
	assert.ok(piModels().getModel("claude-code", "claude-opus-5-5"));
	assert.equal(h.loads(), 0);
});

test("disabled provider preserves builtins and never loads the SDK; reset restores baseline", () => {
	const h = fake();
	assert.deepEqual(providerIds(), builtinIds());
	assert.throws(() => piEngineForSpec({ provider: "claude-code", id: "claude-opus-5-5" }), /no model/);
	assert.equal(h.loads(), 0);
	enableClaudeCodeProvider("/abs/stub", h.deps);
	assert.ok(providerIds().includes("claude-code")); assert.equal(h.loads(), 0);
	resetClaudeCodeProviderForTests();
	assert.deepEqual(providerIds(), builtinIds()); assert.equal(h.loads(), 0);
});

test("catalog projects only model fields, orders families newest first, and matches served windows", () => {
	const source = piModels().getModels("anthropic");
	const original = structuredClone(source);
	const catalog = claudeCodeCatalog(source);
	assert.deepEqual(source, original);
	assert.ok(source.some(m => m.id === "claude-opus-4-5-20251101"));
	assert.ok(catalog.every(m => !/-20\d{6}$/.test(m.id)));
	assert.deepEqual(catalog.slice(0, 4).map(m => m.id), ["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5"]);
	const families = ["fable", "opus", "sonnet", "haiku"];
	for (const [index, model] of catalog.entries()) {
		const src = source.find(m => m.id === model.id)!;
		assert.deepEqual(Object.keys(model).sort(), ["id", "name", "api", "provider", "baseUrl", "reasoning", "input", "contextWindow", "maxTokens", "thinkingLevelMap", "cost"].sort());
		assert.equal(model.provider, "claude-code"); assert.equal(model.api, "claude-agent-sdk"); assert.equal(model.baseUrl, "");
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(model.thinkingLevelMap, src.thinkingLevelMap);
		assert.equal(model.maxTokens, src.maxTokens); assert.equal(model.reasoning, src.reasoning); assert.deepEqual(model.input, src.input);
		const measured = MEASURED_ONE_M.has(model.id);
		assert.equal(model.contextWindow, measured ? 1_000_000 : 200_000);
		assert.equal(model.name, measured && !/\b1M\b/i.test(src.name) ? `${src.name} 1M` : src.name);
		assert.equal(claudeCodeModelId(model, CLAUDE_CODE_SETTINGS), model.id + (measured ? "[1m]" : ""));
		if (index === 0) continue;
		const prev = catalog[index - 1]!;
		const family = (id: string) => families.indexOf(id.split("-")[1]!);
		assert.ok(family(prev.id) <= family(model.id));
		if (family(prev.id) === family(model.id)) {
			const rank = (id: string) => id.split("-").slice(2).reduce((n, part) => n * 100 + Number(part), 0) * (id.split("-").length === 3 ? 100 : 1);
			assert.ok(rank(prev.id) >= rank(model.id), `${prev.id} before ${model.id}`);
		}
	}
	for (const id of MEASURED_ONE_M) assert.ok(catalog.some(m => m.id === id));
});

for (const id of ["claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"]) test(`Models.streamSimple resolves auth and sends served model for ${id}`, async () => {
	const h = fake(); enableClaudeCodeProvider("/abs/stub", h.deps);
	const engine = piEngineForSpec({ provider: "claude-code", id, thinkingLevel: "max" });
	assert.equal(engine.model.id, id);
	const auth = await piModels().getAuth(engine.model);
	assert.ok(auth); assert.deepEqual(auth.auth, {}); assert.equal(auth.source, "LH_CLAUDE_CODE_EXECUTABLE");
	assert.equal(h.loads(), 0);
	const stream = engine.streamFn(engine.model, normalizeContext({ messages: [
		{ role: "user", content: "prior", timestamp: 0 },
		{ role: "assistant", content: [{ type: "text", text: "previous answer" }],
			api: engine.model.api, provider: "claude-code", model: id, stopReason: "stop", timestamp: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
		{ role: "user", content: "next", timestamp: 1 },
	] }), { apiKey: "ignored", headers: { "x-test": "ignored" } });
	const events = []; for await (const event of stream) events.push(event);
	await tick();
	assert.equal(events.at(-1)?.type, "done"); assert.equal(h.loads(), 1);
	const cliId = id + (id === "claude-opus-5-5" ? "[1m]" : "");
	assert.equal(h.calls[0]!.model, cliId);
	const records = h.calls[0]!.file!.trim().split("\n").map(line => JSON.parse(line));
	assert.ok(records.some(record => record.message?.model === cliId), "session uses the same CLI model");
	assert.equal(h.calls[0]!.options?.pathToClaudeCodeExecutable, "/abs/stub");
	assert.equal(Object.hasOwn(h.calls[0]!.options!, "apiKey"), false);
	assert.equal(Object.hasOwn(h.calls[0]!.options!, "headers"), false);
});
