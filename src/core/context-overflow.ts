/**
 * CONTEXT OVERFLOW TEXT (LH-40): browser-safe reading of a provider's
 * "too long" rejection. The server's detector is pi-ai's isContextOverflow
 * plus these patterns (two of the brief's phrasings are narrower in pi);
 * the client's error banner uses this alone, so the client bundle never
 * pulls in pi-ai's runtime. See docs/context-recovery.md.
 */

const OVERFLOW_TEXT = [
	/context[_ ]length[_ ]exceeded/i,
	/maximum context length/i,
	/prompt (?:is )?too long/i,
	/input is too long/i,
	/request_too_large/i,
	/exceeds the context window/i,
	/^(?:[\w -]+ API error \()?413\b/i,
];

/** Does this error text read as a context-length rejection? */
export function isContextOverflowText(text: string | undefined): boolean {
	return !!text && OVERFLOW_TEXT.some((p) => p.test(text));
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
