import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { OpenAICompletionsCompat, StreamFunction } from "@earendil-works/pi-ai";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";

const spec = { provider: "openrouter", id: "z-ai/glm-5.3" };
const otherSpec = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017" };
function compat(model: Parameters<StreamFunction>[0]) {
	return model.compat as OpenAICompletionsCompat | undefined;
}

const entry = {
	order: ["sail-research/us"], only: ["sail-research/us"], allow_fallbacks: false,
	quantizations: ["fp8"], data_collection: "deny",
};

describe("OpenRouter provider-routing file", { concurrency: false }, () => {
	let previousEnv: string | undefined;
	let directory: string;
	let path: string;

	beforeEach(() => {
		previousEnv = process.env.LH_OPENROUTER_ROUTING_FILE;
		delete process.env.LH_OPENROUTER_ROUTING_FILE;
		directory = mkdtempSync(join(tmpdir(), "lh-routing-"));
		path = join(directory, "routing.json");
	});
	afterEach(() => {
		if (previousEnv === undefined) delete process.env.LH_OPENROUTER_ROUTING_FILE;
		else process.env.LH_OPENROUTER_ROUTING_FILE = previousEnv;
		rmSync(directory, { recursive: true, force: true });
	});

	function configure(value: unknown) {
		writeFileSync(path, JSON.stringify(value));
		process.env.LH_OPENROUTER_ROUTING_FILE = path;
	}

	it("copies only matching models, preserves compat, and reads anew for every engine", () => {
		configure({ [spec.id]: entry });
		const catalog = piModels().getModel(spec.provider, spec.id)!;
		const originalCompat = structuredClone(catalog.compat);
		const engine = piEngineForSpec(spec);
		assert.notEqual(engine.model, catalog);
		assert.deepEqual(engine.model.compat, { ...originalCompat, openRouterRouting: entry });
		assert.equal(compat(engine.model)?.thinkingFormat, "openrouter");
		assert.deepEqual(catalog.compat, originalCompat);
		assert.equal(compat(catalog)?.openRouterRouting, undefined);
		assert.equal(piEngineForSpec(otherSpec).model, piModels().getModel(otherSpec.provider, otherSpec.id));
		assert.equal(compat(piEngineForSpec(otherSpec).model)?.openRouterRouting, undefined);
		configure({ [spec.id]: {} });
		assert.deepEqual(compat(piEngineForSpec(spec).model)?.openRouterRouting, {});
		assert.deepEqual(compat(engine.model)?.openRouterRouting, entry);
	});

	it("leaves other providers unchanged even when the file is missing", () => {
		process.env.LH_OPENROUTER_ROUTING_FILE = path;
		const other = { provider: "openai", id: "gpt-4o-mini" };
		assert.equal(piEngineForSpec(other).model, piModels().getModel(other.provider, other.id));
	});

	it("accepts valid GLM and DeepSeek routing entries", () => {
		const deepseekEntry = { quantizations: ["fp8"], sort: "throughput", data_collection: "deny" };
		configure({ [spec.id]: entry, [otherSpec.id]: deepseekEntry });
		assert.deepEqual(compat(piEngineForSpec(spec).model)?.openRouterRouting, entry);
		assert.deepEqual(compat(piEngineForSpec(otherSpec).model)?.openRouterRouting, deepseekEntry);
	});

	for (const [field, value] of [["only", "sail-research/us"], ["allow_fallbacks", "false"]] as const) {
		for (const modelId of [spec.id, otherSpec.id]) {
			it(`rejects invalid /${field} on ${modelId}`, () => {
				configure({ [modelId]: { [field]: value } });
				assert.throws(() => piEngineForSpec(spec), (error: unknown) => {
					assert.ok(error instanceof Error);
					assert.ok(error.message.includes(path));
					assert.ok(error.message.includes(modelId));
					assert.ok(error.message.includes(`/${field}`));
					return true;
				});
			});
		}
	}

	for (const [label, contents, problem] of [
		["invalid JSON", "{", "invalid JSON"],
		["missing file", undefined, "unable to read file"],
		["top-level array", "[]", "top level must be a plain object"],
		["top-level null", "null", "top level must be a plain object"],
		["string entry", JSON.stringify({ [spec.id]: "pin" }), "entry"],
		["array entry", JSON.stringify({ [spec.id]: [] }), "entry"],
		["null entry", JSON.stringify({ [spec.id]: null }), "entry"],
		["invalid unrelated entry", JSON.stringify({ [spec.id]: entry, other: false }), "entry"],
	] as const) {
		it(`fails closed for ${label}`, () => {
			if (contents !== undefined) writeFileSync(path, contents);
			process.env.LH_OPENROUTER_ROUTING_FILE = path;
			assert.throws(() => piEngineForSpec(spec), (error: unknown) => {
				assert.ok(error instanceof Error);
				assert.ok(error.message.includes(path));
				assert.ok(error.message.includes(problem));
				return true;
			});
		});
	}
});
