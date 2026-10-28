/**
 * CONTEXT OVERFLOW (LH-40): THE one classification of a provider's
 * "too long" rejection, shared by the server (recovery, the repair route),
 * the session list and the client's error banner. pi-ai's own detector
 * (its pure utils/overflow module, browser-safe) plus the two phrasings
 * the brief names that pi only matches with extra qualifiers. A message
 * the server already explained carries a ContextOverflowMark, which then
 * rules. See docs/context-recovery.md.
 */

import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const EXTRA_OVERFLOW_TEXT = [/maximum context length/i, /input is too long/i];

/** Set by the server when it rewrites a rejection into a plain
 *  explanation: the provider's own text, and whether Repair can still help. */
export interface ContextOverflowMark {
	providerText: string;
	unrecoverable?: boolean;
}

type MaybeMarked = { role?: string; stopReason?: string; errorMessage?: string; contextOverflow?: ContextOverflowMark };

/** repairable: a length rejection Repair can act on. unrecoverable: the
 *  server already condensed what it could. null: not a length rejection. */
export function contextOverflowState(message: unknown): "repairable" | "unrecoverable" | null {
	const m = message as MaybeMarked | undefined;
	if (m?.role !== "assistant" || m.stopReason !== "error") return null;
	if (m.contextOverflow) return m.contextOverflow.unrecoverable ? "unrecoverable" : "repairable";
	const text = m.errorMessage ?? "";
	return isContextOverflow(m as AssistantMessage) || EXTRA_OVERFLOW_TEXT.some((p) => p.test(text)) ? "repairable" : null;
}

/** Is this error text a length rejection? The subscription transports
 *  keep such text instead of their generic failure line (LH-50), so
 *  recovery can act on it. */
export function isContextOverflowText(text: string): boolean {
	return contextOverflowState({ role: "assistant", stopReason: "error", errorMessage: text }) === "repairable";
}

/** The provider's own rejection text (never a server explanation). */
export function overflowProviderText(message: unknown): string | undefined {
	const m = message as MaybeMarked;
	return m.contextOverflow?.providerText ?? m.errorMessage;
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
