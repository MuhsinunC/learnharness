import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { normalizeContext, type OpenAICompletionsCompat, type StreamFunction } from "@earendil-works/pi-ai";
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

	for (const value of [undefined, ""]) {
		it(`preserves the catalog reference with env ${value === undefined ? "unset" : "empty"}`, () => {
			if (value !== undefined) process.env.LH_OPENROUTER_ROUTING_FILE = value;
			const catalog = piModels().getModel(spec.provider, spec.id)!;
			assert.equal(piEngineForSpec(spec).model, catalog);
			assert.equal(compat(catalog)?.openRouterRouting, undefined);
			const models = piModels();
			const original = models.streamSimple;
			let captured: Parameters<StreamFunction>[0] | undefined;
			models.streamSimple = ((model: Parameters<StreamFunction>[0]) => { captured = model; return undefined; }) as unknown as StreamFunction;
			try {
				const requestModel = { ...catalog };
				piEngineForSpec(spec).streamFn(requestModel, normalizeContext({ messages: [] }), {});
				assert.equal(captured, requestModel);
			} finally { models.streamSimple = original; }
		});
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

	it("streams the pinned copy for matching provider and id only", () => {
		configure({ [spec.id]: entry });
		const engine = piEngineForSpec(spec);
		const models = piModels();
		const original = models.streamSimple;
		let captured: Parameters<StreamFunction>[0] | undefined;
		models.streamSimple = ((model: Parameters<StreamFunction>[0]) => { captured = model; return undefined; }) as unknown as StreamFunction;
		try {
			const context = normalizeContext({ messages: [] });
			engine.streamFn(models.getModel(spec.provider, spec.id)!, context, {});
			assert.equal(captured, engine.model);
			assert.deepEqual(captured && compat(captured)?.openRouterRouting, entry);
			for (const requestModel of [
				models.getModel(otherSpec.provider, otherSpec.id)!,
				{ ...engine.model, provider: "different-provider" },
			]) {
				engine.streamFn(requestModel, context, {});
				assert.equal(captured, requestModel);
			}
		} finally { models.streamSimple = original; }
	});
});
