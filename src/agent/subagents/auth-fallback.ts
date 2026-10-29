import type { PiEngine } from "../models.ts";
import type { ModelRole } from "../../../config.ts";
import { AUTH_PROVIDER_KEYS } from "../../core/auth-keys.ts";
import { NATIVE_SUBSCRIPTIONS } from "../../core/contracts/subscriptions.ts";
import type { ModelSlotName } from "../../core/settings.ts";

/**
 * Provider auth failures in background work (LH-37): classify a model
 * call the provider refused on credentials, pick the one fallback (the
 * Strong slot's engine), and word the learner-readable failure. Shared by
 * the job runner and the extraction pipeline.
 */

/** A model call the provider refused on credentials. `message` stays the
 *  provider's raw text; the parsed status and detail ride alongside. Branded
 *  by name (isProviderAuthError): Next dev may load this module twice. */
export class ProviderAuthError extends Error {
	constructor(
		message: string,
		readonly status: number | undefined,
		/** The provider's own message, unwrapped from its JSON body. */
		readonly detail: string,
	) {
		super(message);
		this.name = "ProviderAuthError";
	}
}

export function isProviderAuthError(err: unknown): err is ProviderAuthError {
	return err instanceof Error && err.name === "ProviderAuthError";
}

/** Credential wording: OpenAI's invalid_api_key, Anthropic's
 *  authentication_error, Baseten's "check the api-key", and similar. */
const AUTH_TEXT = /api[ _-]?key|authenticat|unauthori[sz]ed|invalid[ _-]?token|credential|permission to use this key/i;

/**
 * Classify a failed call's errorMessage. pi-ai formats HTTP failures as
 * `<status> <sdk message>` or `<status>: <body>` (utils/error-body.js), e.g.
 * Baseten's bad key: `403 "please check the api-key you provided"`. The
 * status survives only inside that string. A 401 is always credentials; a
 * 403 (or 400, or no status) only when the provider's own message uses
 * credential wording, because providers also send 403 for moderation,
 * region and model access. The rest of a body (a moderation body echoes
 * the flagged input) is never read for it.
 */
export function providerAuthError(message: string | undefined): ProviderAuthError | undefined {
	if (!message) return undefined;
	const match = /^(\d{3})(?::\s*|\s+)/.exec(message);
	const status = match ? Number(match[1]) : undefined;
	if (status !== undefined && status !== 400 && status !== 401 && status !== 403) return undefined;
	const rest = match ? message.slice(match[0].length) : message;
	let detail = rest;
	try {
		const body = JSON.parse(rest) as unknown;
		const inner = typeof body === "object" && body !== null ? (body as { message?: unknown; error?: unknown }) : undefined;
		const text = typeof body === "string" ? body : inner?.message ?? (inner?.error as { message?: unknown } | undefined)?.message ?? inner?.error;
		if (typeof text === "string") detail = text;
	} catch {
		// Not JSON: keep the text as the provider sent it.
	}
	if (status !== 401 && !AUTH_TEXT.test(detail)) return undefined;
	return new ProviderAuthError(message, status, detail.slice(0, 300));
}

/** What a failed model call throws: the typed auth error, else a plain Error. */
export function modelCallError(message: string): Error {
	return providerAuthError(message) ?? new Error(message);
}

function describeAuthError(error: ProviderAuthError): string {
	return `${error.status ? `HTTP ${error.status}, ` : ""}"${error.detail}"`;
}

const SLOT_LABEL: Record<ModelSlotName, string> = { strong: "Strong", cheap: "Cheap", vision: "Vision" };

function providerLabel(provider: string): string {
	if (provider === "chatgpt") return "ChatGPT";
	if (provider === "claude-code") return "Claude";
	return (
		NATIVE_SUBSCRIPTIONS.find((p) => p.logicalId === provider)?.label ??
		AUTH_PROVIDER_KEYS.find((p) => p.id === provider)?.label ??
		provider
	);
}

export function modelLabel(engine: PiEngine): string {
	return `${providerLabel(engine.model.provider)} · ${engine.model.name || engine.model.id}`;
}

/** The learner-readable failure: which slot and model, what the provider
 *  said, and where to fix it. `extra` reports the fallback's outcome. */
export function authFailureText(tier: ModelSlotName, engine: PiEngine, error: ProviderAuthError, extra: string): string {
	const slot = SLOT_LABEL[tier];
	return [
		`The ${slot} model (${modelLabel(engine)}) was rejected by ${providerLabel(engine.model.provider)}: ${describeAuthError(error)}.`,
		extra,
		`Go to Settings → Providers to fix the key, or Settings → Agent → Models to switch the ${slot} model to your ChatGPT/Claude sign-in.`,
	]
		.filter(Boolean)
		.join(" ");
}

/** The `extra` sentence when the fallback was tried and refused too. */
export function retryRejectedText(fallback: PiEngine, error: ProviderAuthError): string {
	return `Retrying on your Strong model (${modelLabel(fallback)}) was rejected too: ${describeAuthError(error)}.`;
}

export interface FallbackDeps {
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	/** Background-use consent for a subscription provider (true for plain
	 *  API providers). Absent = allowed (engine-injecting tests). */
	backgroundAllowed?: (provider: string) => boolean;
}

/** The Strong slot's engine as the auth fallback for cheap or vision work:
 *  the teacher's model, usually a subscription that needs no API key. A
 *  string is why it can't take over (learner-readable; "" = say nothing). */
export function strongFallback(tier: ModelSlotName, failed: PiEngine, deps: FallbackDeps): PiEngine | string {
	let strong: PiEngine | undefined;
	try {
		strong = deps.engineFor?.("teacher");
	} catch {
		return ""; // the strong slot names a model the catalog lacks, or its key is gone
	}
	if (tier === "strong" || !strong) return "";
	if (strong.model.provider === failed.model.provider && strong.model.id === failed.model.id) return "";
	if (tier === "vision" && !strong.model.input.includes("image"))
		return `Your Strong model (${modelLabel(strong)}) can't read images, so it can't take over.`;
	if (deps.backgroundAllowed && !deps.backgroundAllowed(strong.model.provider))
		return `Your Strong model (${modelLabel(strong)}) could run this instead, but background use is off for that sign-in. Turn on background use for it in Settings → Providers, or pick another ${SLOT_LABEL[tier]} model.`;
	return strong;
}

/** The learner-readable end of an auth failure (authFailureText): only a
 *  settings change can fix it. Branded by name, like ProviderAuthError. */
export class KeyRejectedError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "KeyRejectedError";
	}
}

export function isKeyRejectedError(err: unknown): err is KeyRejectedError {
	return err instanceof Error && err.name === "KeyRejectedError";
}

/** The one auth-fallback policy (job runner and extraction): run `call` on
 *  `engine`; when it throws a ProviderAuthError, rerun it once on the Strong
 *  slot's engine. No usable fallback, or a second rejection, throws a
 *  KeyRejectedError; every other failure propagates untouched. */
export async function withStrongFallback<T>(
	tier: ModelSlotName,
	engine: PiEngine,
	deps: FallbackDeps,
	call: (engine: PiEngine) => Promise<T>,
	onFallback?: (fallback: PiEngine) => void,
): Promise<T> {
	try {
		return await call(engine);
	} catch (err) {
		if (!isProviderAuthError(err)) throw err;
		const fallback = strongFallback(tier, engine, deps);
		if (typeof fallback === "string") throw new KeyRejectedError(authFailureText(tier, engine, err, fallback), { cause: err });
		onFallback?.(fallback);
		try {
			return await call(fallback);
		} catch (retryErr) {
			if (!isProviderAuthError(retryErr)) throw retryErr;
			throw new KeyRejectedError(authFailureText(tier, engine, err, retryRejectedText(fallback, retryErr)), { cause: retryErr });
		}
	}
}
