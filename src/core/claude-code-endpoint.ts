/** Explicit credentials for an Anthropic-compatible Claude Code endpoint. */
export type ClaudeCodeEndpoint = { baseUrl: string; token: string };

export function normalizeEndpointUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || /[?#]/.test(trimmed)) return null;
	try {
		const url = new URL(trimmed);
		if (url.username || url.password || !(url.protocol === "https:" ||
			(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")))) return null;
		return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
	} catch { return null; }
}

export function isAllowedEndpointUrl(value: string): boolean {
	return normalizeEndpointUrl(value) !== null;
}
