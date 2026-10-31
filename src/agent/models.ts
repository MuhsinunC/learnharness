import { readFileSync } from "node:fs";
import {
	clampThinkingLevel,
	createModels,
	getSupportedThinkingLevels,
	normalizeContext,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type Models,
	type OpenRouterRouting,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { OpenRouterRoutingSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import { type ModelRole } from "../../config.ts";
import { claudeCodeProvider, type ClaudeCodeProviderDeps } from "./claude-code/provider.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import { contextOverflowState, type HeldBack } from "../core/context-overflow.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import { e2eProviders } from "./e2e-providers.ts";
import type { ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { nativeSubscriptionId, nativeSubscriptionModel } from "./subscription-bridge.ts";
import { nativeSubscriptionStream } from "./subscription-stream.ts";
import { markUnadmittedUsage } from "./subscription-request-cycle.ts";

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level —
	 *  observability + tests; the streamFn pins it anyway. */
	level?: ThinkingLevel;
	/** The model's learned overcount (ResolvedModelSpec.overcount): the
	 *  threshold compaction and recovery size from the same margin as
	 *  the engine's requests (contextMarginTokens). */
	overcount?: number;
}

export type { ThinkingLevel };

let collection: ReturnType<typeof createModels> | undefined;

const registrationKey = Symbol.for("lh.claudeCodeRegistration.v2");
const registrations = globalThis as typeof globalThis & {
	[registrationKey]?: { generation: number; desired?: { executable: string; deps?: ClaudeCodeProviderDeps } };
};
const registration = registrations[registrationKey] ??= { generation: 0 };
let appliedGeneration = -1;

export function enableClaudeCodeProvider(executable: string, deps?: ClaudeCodeProviderDeps): void {
	const current = registration.desired;
	if (current?.executable === executable && current.deps?.dataDir === deps?.dataDir &&
		!!current.deps?.endpoint === !!deps?.endpoint && current.deps?.loadQuery === deps?.loadQuery &&
		current.deps?.logger === deps?.logger && current.deps?.claudeDirForTests === deps?.claudeDirForTests) return;
	registration.desired = { executable, deps };
	registration.generation++;
}

export function claudeCodeRegistrationExecutable(): string | undefined { return registration.desired?.executable; }

export function disableClaudeCodeProvider(): void {
	registration.desired = undefined;
	registration.generation++;
	collection?.deleteProvider("claude-code");
}

export function resetClaudeCodeProviderForTests(): void {
	disableClaudeCodeProvider();
}

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) collection.setProvider(provider);
		for (const provider of e2eProviders()) collection.setProvider(provider);
	}
	if (appliedGeneration !== registration.generation) {
		const desired = registration.desired;
		if (desired) collection.setProvider(claudeCodeProvider(desired.executable, collection.getModels("anthropic"), {
			...desired.deps, registrationError: () => !registration.desired ? "claude-code: provider is off"
				: registration.desired !== desired ? "claude-code: provider changed; retry" : null,
		}));
		else collection.deleteProvider("claude-code");
		appliedGeneration = registration.generation;
	}
	return collection;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
	/** The user's custom context window for this pair (LH-38), resolved by
	 *  the server with the spec; unset = the catalog window. pi-ai clamps
	 *  maxTokens to model.contextWindow, so the engine's model carries it. */
	contextWindow?: number;
	/** The limit a provider stated for this pair (LH-40's learned limit):
	 *  the engine's window never exceeds it, so pi-ai's max-tokens clamp
	 *  uses the real limit, not a larger custom window (LH-50). */
	contextLimit?: number;
	/** How much more than pi-ai's estimate the provider counted in its
	 *  own rejections (LH-54's learned overcount): the engine's requests
	 *  keep that much more free (contextMarginTokens). */
	overcount?: number;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function openRouterRouting(id: string): OpenRouterRouting | undefined {
	const path = process.env.LH_OPENROUTER_ROUTING_FILE;
	if (!path) return undefined;
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (cause) {
		throw new Error(`OpenRouter routing file ${path}: unable to read file`, { cause });
	}
	let routing: unknown;
	try {
		routing = JSON.parse(contents);
	} catch (cause) {
		throw new Error(`OpenRouter routing file ${path}: invalid JSON`, { cause });
	}
	if (!isPlainObject(routing)) {
		throw new Error(`OpenRouter routing file ${path}: top level must be a plain object`);
	}
	for (const [modelId, entry] of Object.entries(routing)) {
		if (!isPlainObject(entry)) {
			throw new Error(`OpenRouter routing file ${path}: entry ${modelId} must be a plain object`);
		}
		if (!Value.Check(OpenRouterRoutingSchema, entry)) {
			const error = Value.Errors(OpenRouterRoutingSchema, entry)[0]!;
			throw new Error(`OpenRouter routing file ${path}: entry ${modelId} ${error.instancePath}: ${error.message}`);
		}
	}
	return Object.hasOwn(routing, id) ? routing[id] as OpenRouterRouting : undefined;
}

/** Optional global output cap, read anew for every engine and validated fail-closed. */
function maxOutputTokens(): number | undefined {
	const raw = process.env.LH_MAX_OUTPUT_TOKENS;
	if (raw === undefined || raw === "") return undefined;
	const value = Number(raw);
	if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value) || value < 1024) {
		throw new Error(`LH_MAX_OUTPUT_TOKENS must be a positive integer >= 1024, got ${JSON.stringify(raw)}`);
	}
	return value;
}

/** pi-ai's margin under the window: its max-tokens clamp leaves this
 *  much free (api/simple-options.js CONTEXT_SAFETY_TOKENS). */
export const CONTEXT_SAFETY_TOKENS = 4096;

/** The APIs whose thinking budget pi-ai adds to the reply's max tokens
 *  before clamping the sum to the window (api/anthropic-messages and
 *  api/bedrock-converse-stream streamSimple): options.maxTokens does not
 *  bound such a request. */
const BUDGET_THINKING_APIS = new Set<string>(["anthropic-messages", "bedrock-converse-stream"]);

/** The least reply room a request goes out with (LH-50): 1024 tokens,
 *  or the model's whole max output when that is smaller. */
export const replyFloorTokens = (maxTokens: number) => Math.min(1024, maxTokens);

/** The margin a request keeps under the window, for pi-ai's estimate
 *  of its input (LH-54): pi-ai's flat 4,096, plus what the provider
 *  counts over that estimate when its rejections showed it counts more
 *  (`overcount`, the learned ratio). The request clamp, the held-back
 *  floor, the threshold compaction and recovery all size from it. */
export function contextMarginTokens(estimate: number, overcount = 1): number {
	return CONTEXT_SAFETY_TOKENS + Math.max(0, Math.ceil(estimate * (overcount - 1)));
}

/** Its inverse: the largest estimate a request may carry and still leave
 *  its reply `room` tokens (estimate + margin + room ≤ window). */
export function inputBudgetTokens(windowTokens: number, room: number, overcount = 1): number {
	return Math.floor((windowTokens - CONTEXT_SAFETY_TOKENS - room) / Math.max(overcount, 1));
}

/** The reply room this request goes out with: window − pi-ai's estimate
 *  of the context (system prompt, tool declarations, messages) − the
 *  margin (contextMarginTokens). */
function replyRoom(model: Model<Api>, context: Context, overcount: number | undefined): { room: number; estimate: number; margin: number } {
	const estimate = estimateContextTokens(normalizeContext(context)).tokens;
	const margin = contextMarginTokens(estimate, overcount);
	return { room: model.contextWindow > 0 ? model.contextWindow - estimate - margin : Infinity, estimate, margin };
}

/** The request's stream, with pi-ai's estimate stamped on a length
 *  rejection (core SentEstimate): the provider's own count in it then
 *  teaches the model's overcount (LH-54, context-recovery). Forwarded
 *  as pi-ai's own lazy streams forward theirs: the source's result is
 *  passed on, and a source that throws ends in an error event, never a
 *  stream that never settles. */
function withSentEstimate(model: Model<Api>, source: AssistantMessageEventStream, estimate: number): AssistantMessageEventStream {
	const output = new AssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				if (event.type === "error" && contextOverflowState(event.error) !== null) Object.assign(event.error, { sentEstimate: estimate });
				output.push(event);
			}
			output.end(await source.result());
		} catch (error) {
			output.push({ type: "error", reason: "error", error: errorMessage(model, error instanceof Error ? error.message : String(error)) });
			output.end();
		}
	})();
	return output;
}

/** An error reply of `model` that no provider answered. */
function errorMessage(model: Model<Api>, text: string): AssistantMessage {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage, stopReason: "error", errorMessage: text, timestamp: Date.now() };
}

/** A request whose reply would be cut off silently is held back as a
 *  length rejection marked `heldBack` (LH-50, core/context-overflow):
 *  overflow recovery then condenses the chat, or explains that nothing
 *  can (context-recovery). No provider saw it, so it states no limit. */
function heldBackStream(model: Model<Api>, { room, estimate, margin }: ReturnType<typeof replyRoom>, lifecycle?: ChatGPTDispatchLifecycle) {
	const output = new AssistantMessageEventStream();
	const error: AssistantMessage & HeldBack = {
		...errorMessage(model, `Not sent: the reply would have only ${Math.max(room, 0)} tokens of room in this chat's ${model.contextWindow}-token context window (about ${estimate} tokens of request and a ${margin}-token margin).`),
		heldBack: true,
	};
	markUnadmittedUsage(error.usage);
	lifecycle?.noDispatch("heldBack");
	output.push({ type: "error", reason: "error", error });
	output.end();
	return output;
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle): PiEngine {
	const models: Models = piModels();
	const nativeId = nativeSubscriptionId(spec.provider);
	const catalogModel = spec.provider === "chatgpt" ? chatGPTModel(spec.id) : nativeId ? nativeSubscriptionModel(spec.provider, spec.id) : models.getModel(spec.provider, spec.id);
	if (!catalogModel) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	const routing = spec.provider === "openrouter" ? openRouterRouting(spec.id) : undefined;
	const cap = maxOutputTokens();
	const clamp = cap !== undefined && catalogModel.maxTokens > cap;
	const contextWindow = spec.contextLimit !== undefined && spec.contextLimit < (spec.contextWindow ?? catalogModel.contextWindow)
		? spec.contextLimit
		: spec.contextWindow;
	const model = routing || clamp || contextWindow
		? {
			...catalogModel,
			...(routing ? { compat: { ...catalogModel.compat, openRouterRouting: routing } } : {}),
			...(clamp ? { maxTokens: cap } : {}),
			...(contextWindow ? { contextWindow } : {}),
		}
		: catalogModel;
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const level = spec.thinkingLevel
		? clampThinkingLevel(model, spec.thinkingLevel)
		: defaultThinkingLevel(model);
	return {
		model,
		level,
		...(spec.overcount !== undefined ? { overcount: spec.overcount } : {}),
		// bound streamSimple: the agent loop forwards state.thinkingLevel as
		// `reasoning` (undefined = off on pi-ai's scale); the clamp above keeps
		// the pin honest even when config or settings drift off the map.
		streamFn: (requestModel, context, options) => {
			const purpose = typeof background === "function" ? background : () => background;
			const stream = spec.provider === "chatgpt" ? chatGPTStream(purpose, lifecycle) : nativeId ? nativeSubscriptionStream(models.getProvider(nativeId)!, purpose, lifecycle) : models.streamSimple.bind(models);
			const matches = requestModel.provider === model.provider && requestModel.id === model.id;
			const streamModel = model !== catalogModel && matches ? model
				: cap !== undefined && !matches && requestModel.maxTokens > cap
					? { ...requestModel, maxTokens: cap } : requestModel;
			// The overcount is this model's: another model's request keeps
			// pi-ai's flat margin.
			const fit = replyRoom(streamModel, context, matches ? spec.overcount : undefined);
			if (fit.room < replyFloorTokens(streamModel.maxTokens)) return heldBackStream(streamModel, fit, lifecycle);
			const outputCeiling = cap === undefined ? undefined : Math.min(streamModel.maxTokens, cap);
			const asked = outputCeiling !== undefined && options?.maxTokens !== undefined && options.maxTokens > outputCeiling ? outputCeiling : options?.maxTokens;
			// The margin past pi-ai's flat one reaches the request as the
			// reply's max tokens: every API takes the smaller of those and its
			// own clamp to the window, and the model keeps its real window.
			// Anthropic's and Bedrock's budget thinking add the thinking
			// budget to max tokens and clamp the sum to the window with the
			// flat margin alone, so there the margin goes through a window
			// that much smaller.
			const extraMargin = fit.margin - CONTEXT_SAFETY_TOKENS;
			const budgetThinking = level !== "off" && BUDGET_THINKING_APIS.has(streamModel.api);
			const sentModel = extraMargin > 0 && budgetThinking && streamModel.contextWindow > 0 ? { ...streamModel, contextWindow: streamModel.contextWindow - extraMargin } : streamModel;
			const maxTokens = extraMargin > 0 && !budgetThinking ? Math.min(asked ?? streamModel.maxTokens, fit.room) : asked;
			return withSentEstimate(streamModel, stream(sentModel, context, {
				...options,
				...(maxTokens !== options?.maxTokens ? { maxTokens } : {}),
				reasoning: level === "off" ? undefined : level,
			}), fit.estimate);
		},
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
