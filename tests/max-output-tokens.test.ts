import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { normalizeContext, type StreamFunction } from "@earendil-works/pi-ai";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";

const spec = { provider: "openrouter", id: "z-ai/glm-5.3" };
const smallSpec = { provider: "openai", id: "gpt-4o-mini" };
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });

describe("global max output tokens", { concurrency: false }, () => {
	let previousCap: string | undefined;
	let previousRouting: string | undefined;
	let directory: string;
	beforeEach(() => {
		previousCap = process.env.LH_MAX_OUTPUT_TOKENS;
		previousRouting = process.env.LH_OPENROUTER_ROUTING_FILE;
		delete process.env.LH_MAX_OUTPUT_TOKENS;
		delete process.env.LH_OPENROUTER_ROUTING_FILE;
		directory = mkdtempSync(join(tmpdir(), "lh-output-cap-"));
	});
	afterEach(() => {
		if (previousCap === undefined) delete process.env.LH_MAX_OUTPUT_TOKENS;
		else process.env.LH_MAX_OUTPUT_TOKENS = previousCap;
		if (previousRouting === undefined) delete process.env.LH_OPENROUTER_ROUTING_FILE;
		else process.env.LH_OPENROUTER_ROUTING_FILE = previousRouting;
		rmSync(directory, { recursive: true, force: true });
	});

	function captureStream(run: (calls: Parameters<StreamFunction>[]) => void) {
		const models = piModels();
		const original = models.streamSimple;
		const calls: Parameters<StreamFunction>[] = [];
		models.streamSimple = ((...args: Parameters<StreamFunction>) => {
			calls.push(args);
			return undefined;
		}) as unknown as StreamFunction;
		try { run(calls); } finally { models.streamSimple = original; }
	}

	for (const value of [undefined, ""]) {
		it(`preserves references and explicit token options when ${value === undefined ? "unset" : "empty"}`, () => {
			if (value !== undefined) process.env.LH_MAX_OUTPUT_TOKENS = value;
			const catalog = piModels().getModel(spec.provider, spec.id)!;
			const engine = piEngineForSpec(spec);
			assert.equal(catalog.maxTokens, 943718);
			assert.equal(engine.model, catalog);
			captureStream((calls) => {
				for (const requestModel of [{ ...catalog }, piModels().getModel(smallSpec.provider, smallSpec.id)!]) {
					engine.streamFn(requestModel, context, { maxTokens: 100000 });
					assert.equal(calls.at(-1)![0], requestModel);
					assert.deepEqual(calls.at(-1)![2], { maxTokens: 100000, reasoning: engine.level === "off" ? undefined : engine.level });
				}
			});
		});
	}

	it("copies only above the cap, leaves catalogs intact, and reads each call", () => {
		const catalog = piModels().getModel(spec.provider, spec.id)!;
		process.env.LH_MAX_OUTPUT_TOKENS = "32000";
		const engine = piEngineForSpec(spec);
		assert.notEqual(engine.model, catalog);
		assert.equal(engine.model.maxTokens, 32000);
		assert.equal(catalog.maxTokens, 943718);
		const small = piModels().getModel(smallSpec.provider, smallSpec.id)!;
		assert.equal(small.maxTokens, 16384);
		assert.equal(piEngineForSpec(smallSpec).model, small);
		process.env.LH_MAX_OUTPUT_TOKENS = "943718";
		assert.equal(piEngineForSpec(spec).model, catalog);
		process.env.LH_MAX_OUTPUT_TOKENS = "1000000";
		assert.equal(piEngineForSpec(spec).model, catalog);
	});

	it("substitutes matching models and clamps explicit options and nonmatching models", () => {
		process.env.LH_MAX_OUTPUT_TOKENS = "32000";
		const engine = piEngineForSpec(spec);
		captureStream((calls) => {
			for (const maxTokens of [100000, 12000, undefined]) {
				engine.streamFn(piModels().getModel(spec.provider, spec.id)!, context, { maxTokens });
				assert.equal(calls.at(-1)![0], engine.model);
				assert.equal(calls.at(-1)![2]?.maxTokens, maxTokens === 100000 ? 32000 : maxTokens);
			}
			for (const requestModel of [
				{ ...engine.model, provider: "different-provider", maxTokens: 64000 },
				{ ...engine.model, id: "different-id", maxTokens: 64000 },
			]) {
				engine.streamFn(requestModel, context, {});
				assert.notEqual(calls.at(-1)![0], requestModel);
				assert.deepEqual(calls.at(-1)![0], { ...requestModel, maxTokens: 32000 });
				assert.equal(requestModel.maxTokens, 64000);
			}
			const small = piModels().getModel(smallSpec.provider, smallSpec.id)!;
			engine.streamFn(small, context, {});
			assert.equal(calls.at(-1)![0], small);
		});
	});

	it("composes routing and the cap on the same engine copy", () => {
		const routing = { only: ["sail-research/us"], allow_fallbacks: false };
		const path = join(directory, "routing.json");
		writeFileSync(path, JSON.stringify({ [spec.id]: routing }));
		process.env.LH_OPENROUTER_ROUTING_FILE = path;
		process.env.LH_MAX_OUTPUT_TOKENS = "32000";
		const catalog = piModels().getModel(spec.provider, spec.id)!;
		const engine = piEngineForSpec(spec);
		assert.notEqual(engine.model, catalog);
		assert.deepEqual(engine.model, { ...catalog, maxTokens: 32000, compat: { ...catalog.compat, openRouterRouting: routing } });
		captureStream((calls) => {
			engine.streamFn(catalog, context, {});
			assert.equal(calls[0]![0], engine.model);
		});
	});

	for (const value of ["abc", "0", "-5", "1.5", " 32000", "32000 ", "1e3", "9007199254740992"]) {
		it(`rejects invalid cap ${JSON.stringify(value)}`, () => {
			process.env.LH_MAX_OUTPUT_TOKENS = value;
			assert.throws(() => piEngineForSpec(spec), (error: unknown) => {
				assert.ok(error instanceof Error);
				assert.ok(error.message.includes("LH_MAX_OUTPUT_TOKENS"));
				assert.ok(error.message.includes(value));
				return true;
			});
		});
	}

	async function outgoingTokens(modelSpec: typeof spec, thinkingLevel: "off" | "high") {
		const engine = piEngineForSpec({ ...modelSpec, thinkingLevel });
		let payload: Record<string, unknown> | undefined;
		let fetchCalls = 0;
		const stream = engine.streamFn(engine.model, context, {
			apiKey: "test",
			onPayload: (params) => {
				payload = params as Record<string, unknown>;
				throw new Error("payload captured; stop before network");
			},
			fetch: async () => { fetchCalls++; throw new Error("no network"); },
		});
		const result = await stream.result();
		assert.equal(result.stopReason, "error");
		assert.equal(fetchCalls, 0);
		assert.ok(payload, "real payload builder must run");
		const tokens = payload.max_tokens ?? payload.max_completion_tokens;
		assert.equal(typeof tokens, "number");
		return tokens as number;
	}

	for (const modelSpec of [spec,
		{ provider: "anthropic", id: "claude-sonnet-4-5" },
		{ provider: "anthropic", id: "claude-sonnet-4-6" },
	]) {
		for (const thinkingLevel of ["off", "high"] as const) {
			it(`caps real ${modelSpec.id} payload with reasoning ${thinkingLevel}`, async () => {
				const catalog = piModels().getModel(modelSpec.provider, modelSpec.id)!;
				assert.ok(catalog.maxTokens > 32000);
				assert.equal(catalog.api, modelSpec.provider === "anthropic" ? "anthropic-messages" : "openai-completions");
				process.env.LH_MAX_OUTPUT_TOKENS = "32000";
				assert.ok(await outgoingTokens(modelSpec, thinkingLevel) <= 32000);
			});
		}
	}
	it("observes an uncapped real GLM payload above 32000", async () => {
		assert.ok(await outgoingTokens(spec, "off") > 32000);
	});
});
