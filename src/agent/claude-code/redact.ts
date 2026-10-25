import type { ClaudeCodeEndpoint } from "../../core/claude-code-endpoint.ts";

export function redactSecrets(text: string, endpoint: ClaudeCodeEndpoint | null | undefined): string {
	if (!endpoint) return text;
	const secrets = new Set<string>();
	const add = (value: string) => {
		if (!value) return;
		secrets.add(value);
		secrets.add(encodeURIComponent(value));
		secrets.add(JSON.stringify(value).slice(1, -1));
	};
	add(endpoint.token);
	const userinfo = endpoint.baseUrl.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)@/i)?.[1];
	if (userinfo) {
		add(userinfo);
		try { add(decodeURIComponent(userinfo)); } catch { /* Keep the encoded userinfo redacted. */ }
	}
	for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[redacted]");
	return text;
}
