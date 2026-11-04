/**
 * CONTEXT OVERFLOW (LH-40): THE one classification of a provider's
 * "too long" rejection, shared by the server (recovery, the repair route),
 * the session list and the client's error banner. pi-ai's own detector
 * (its pure utils/overflow module, browser-safe) plus the two phrasings
 * the brief names that pi only matches with extra qualifiers. A message
 * the server already explained carries a ContextOverflowMark, which then
 * rules; a request the app held back (LH-50) carries HeldBack. See
 * docs/context-recovery.md.
 */

import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const EXTRA_OVERFLOW_TEXT = [/maximum context length/i, /input is too long/i];

/** Set by the server when it rewrites a rejection into a plain
 *  explanation: the provider's own text (absent for a held-back request),
 *  and whether Repair can still help. */
export interface ContextOverflowMark {
	providerText?: string;
	unrecoverable?: boolean;
}

/** Set by the engine on a request it never sent because the reply would
 *  have had no room (LH-50, agent/models.ts heldBackStream): a length
 *  rejection for recovery, but no provider's words: it has no provider
 *  text and states no limit to learn. */
export interface HeldBack {
	heldBack: true;
}

type MaybeMarked = { role?: string; stopReason?: string; errorMessage?: string; contextOverflow?: ContextOverflowMark; heldBack?: boolean };

/** repairable: a length rejection Repair can act on. unrecoverable: the
 *  server already condensed what it could. null: not a length rejection. */
export function contextOverflowState(message: unknown): "repairable" | "unrecoverable" | null {
	const m = message as MaybeMarked | undefined;
	if (m?.role !== "assistant" || m.stopReason !== "error") return null;
	if (m.contextOverflow) return m.contextOverflow.unrecoverable ? "unrecoverable" : "repairable";
	if (m.heldBack) return "repairable";
	const text = m.errorMessage ?? "";
	return isContextOverflow(m as AssistantMessage) || EXTRA_OVERFLOW_TEXT.some((p) => p.test(text)) ? "repairable" : null;
}

/** Is this error text a length rejection? The subscription transports
 *  keep such text instead of their generic failure line (LH-50), so
 *  recovery can act on it. */
export function isContextOverflowText(text: string): boolean {
	return contextOverflowState({ role: "assistant", stopReason: "error", errorMessage: text }) === "repairable";
}

/** The provider's own rejection text (never a server explanation, and
 *  none for a held-back request). */
export function overflowProviderText(message: unknown): string | undefined {
	const m = message as MaybeMarked | undefined;
	return m?.contextOverflow?.providerText ?? (m?.heldBack ? undefined : m?.errorMessage);
}

/** Was this request held back by the app rather than rejected by a provider? */
export function heldBackRequest(message: unknown): boolean {
	return (message as MaybeMarked | undefined)?.heldBack === true;
}

// The LIMIT, never the request size: Anthropic puts it second
// ("213462 tokens > 200000 maximum"), OpenAI first ("maximum context
// length is 8192 tokens. However, your messages resulted in 9192").
const LIMIT_TEXT = [
	/maximum context length (?:is|of) ([\d,]+)/i,
	/maximum context length \(([\d,]+)\)/i,
	/tokens? > ([\d,]+) maximum/i,
	/maximum number of tokens allowed \(([\d,]+)\)/i,
	/maximum prompt length is ([\d,]+)/i,
	/context length \(([\d,]+) tokens\)/i,
	/configured context size is ([\d,]+)/i,
];

/** The context window a rejection states, in tokens, or null. */
export function reportedContextLimit(text: string | undefined): number | null {
	if (!text) return null;
	for (const p of LIMIT_TEXT) {
		const n = Number(p.exec(text)?.[1]?.replace(/,/g, ""));
		if (Number.isFinite(n) && n > 0) return n;
	}
	return null;
}

const tokenCount = (raw: string | undefined) => Number(raw?.replace(/,/g, ""));

/** The INPUT a rejection says the provider counted, in tokens, or null
 *  (LH-54): OpenRouter sums its parts ("(24953 of text input, 3331 of
 *  tool input, 12933 in the output)"), OpenAI names them ("(8000 in the
 *  messages, 500 in the functions, and 1500 in the completion)", or
 *  "your messages resulted in 9192 tokens"), Anthropic the prompt
 *  ("prompt is too long: 213462 tokens"). The messages and the tool
 *  declarations, as pi-ai's estimate counts them; never the reply's max
 *  tokens (OpenAI's completion, OpenRouter's output), which the provider
 *  adds on top. */
export function reportedInputTokens(text: string | undefined): number | null {
	if (!text) return null;
	const parts = [...text.matchAll(/([\d,]+) (?:of [a-z ]*?input|in the (?:messages|functions|tools))\b/gi)].map((m) => tokenCount(m[1]));
	if (parts.length) return parts.every(Number.isFinite) ? parts.reduce((a, b) => a + b, 0) : null;
	const n = tokenCount((/messages resulted in ([\d,]+) tokens/i.exec(text) ?? /prompt is too long: ([\d,]+) tokens/i.exec(text))?.[1]);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/** Set by the engine on a provider's length rejection (LH-54,
 *  agent/models.ts): pi-ai's estimate of the request's input, the one
 *  the request's margin was sized from. With the provider's own count
 *  (reportedInputTokens) it measures how much more the provider counts. */
export interface SentEstimate {
	sentEstimate: number;
}

/** The estimate the engine stamped on this rejection, if any. */
export function sentEstimate(message: unknown): number | undefined {
	const n = (message as Partial<SentEstimate> | undefined)?.sentEstimate;
	return typeof n === "number" && n > 0 ? n : undefined;
}
