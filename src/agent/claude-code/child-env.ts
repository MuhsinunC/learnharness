import { homedir } from "node:os";
import { join } from "node:path";

export const CHILD_ENV_ALLOWLIST = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;

// Applied to every child: LearnHarness owns its tools and compaction.
export const CC_CHILD_ENV = {
	// Suppress claude.ai cloud MCP servers: they add tools LearnHarness does not execute.
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	// LearnHarness owns compaction; CC auto-compact would double-flush the prompt cache (upstream #8).
	DISABLE_AUTO_COMPACT: "1",
	// Upstream set this globally so children inherited it; keep it child-only.
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
} as const;

export function buildChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of CHILD_ENV_ALLOWLIST) {
		if (source[key] !== undefined) env[key] = source[key];
	}
	return { ...env, ...CC_CHILD_ENV };
}

export function childClaudeDir(source: NodeJS.ProcessEnv = process.env): string {
	return join(source.HOME ?? homedir(), ".claude");
}
