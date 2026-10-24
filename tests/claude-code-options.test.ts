import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { CHILD_ENV_ALLOWLIST, CC_CHILD_ENV, buildChildEnv, childClaudeDir } from "../src/agent/claude-code/child-env.ts";
import {
	CONTINUE_TEXT, MCP_SERVER_NAME, MCP_TOOL_PREFIX, REASONING_TO_EFFORT, VALID_EFFORTS,
	buildQueryOptions, resolveEffort, type QueryInputs,
} from "../src/agent/claude-code/query-options.ts";

function withEnv(source: Record<string, string | undefined>, run: (home: string) => void) {
	const original = { ...process.env };
	const home = mkdtempSync(join(tmpdir(), "lh-claude-options-"));
	try {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, { ...source, HOME: home });
		run(home);
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, original);
		rmSync(home, { recursive: true, force: true });
	}
}

const required: QueryInputs = {
	executable: "/abs/bin/claude", cwd: "/workspace", cliModel: "claude-test",
	appendPrompt: "Tutor prompt", resumeId: "session-id",
};

const flags = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

function assertSnapshot(actual: unknown, expected: object) {
	assert.deepStrictEqual(actual, expected);
	assert.deepStrictEqual(Object.keys(actual as object), Object.keys(expected));
}

describe("Claude Code query contract", () => {
	it("matches the complete options snapshot and key order", () => {
		withEnv({ PATH: "/test/bin", TMPDIR: "/test/tmp" }, home => {
			const result = buildQueryOptions({
				...required, effort: "high", mcpServers: { "custom-tools": { type: "stdio", command: "x" } },
				maxTurns: 1, persistSession: false,
			});
			assertSnapshot(result, {
				cwd: "/workspace", includePartialMessages: true, resume: "session-id",
				pathToClaudeCodeExecutable: "/abs/bin/claude",
				systemPrompt: { type: "preset", preset: "claude_code", append: "Tutor prompt" },
				settings: { autoMemoryEnabled: false, includeGitInstructions: false, claudeMdExcludes: ["**/CLAUDE.md", "**/.claude/rules/**"] },
				extraArgs: { model: "claude-test", "strict-mcp-config": null, "thinking-display": "summarized" },
				effort: "high", mcpServers: { "custom-tools": { type: "stdio", command: "x" } },
				maxTurns: 1, persistSession: false,
				env: { HOME: home, PATH: "/test/bin", TMPDIR: "/test/tmp", ...flags },
				permissionMode: "dontAsk", settingSources: [], tools: [],
				allowedTools: ["mcp__custom-tools__*"], strictMcpConfig: true,
			});
		});
	});

	it("matches required-only options with optional keys absent", () => {
		withEnv({}, home => {
			assertSnapshot(buildQueryOptions(required), {
				cwd: "/workspace", includePartialMessages: true, resume: "session-id",
				pathToClaudeCodeExecutable: "/abs/bin/claude",
				systemPrompt: { type: "preset", preset: "claude_code", append: "Tutor prompt" },
				settings: { autoMemoryEnabled: false, includeGitInstructions: false, claudeMdExcludes: ["**/CLAUDE.md", "**/.claude/rules/**"] },
				extraArgs: { model: "claude-test", "strict-mcp-config": null },
				env: { HOME: home, ...flags }, permissionMode: "dontAsk", settingSources: [], tools: [],
				allowedTools: ["mcp__custom-tools__*"], strictMcpConfig: true,
			});
			assert.equal(buildQueryOptions({ ...required, maxTurns: 0 }).maxTurns, 0);
		});
	});

	it("passes exactly allowlisted values and child-only flags from a poisoned environment", () => {
		const poison = {
			ANTHROPIC_API_KEY: "poison", ANTHROPIC_BASE_URL: "poison", CLAUDE_CONFIG_DIR: "poison",
			HTTPS_PROXY: "poison", HTTP_PROXY: "poison", ALL_PROXY: "poison", NO_PROXY: "poison",
			OPENROUTER_API_KEY: "poison", CLAUDE_CODE_OAUTH_TOKEN: "poison", LH_CLAUDE_CODE_EXECUTABLE: "poison",
		};
		const allowed = Object.fromEntries(CHILD_ENV_ALLOWLIST.map(key => [key, `/test/${key}`]));
		const poisoned = { NODE_ENV: "test" as const, ...poison, ...allowed, ENABLE_CLAUDEAI_MCP_SERVERS: "1", DISABLE_AUTO_COMPACT: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" };
		assert.deepStrictEqual(buildChildEnv(poisoned), { ...allowed, ...flags });
		withEnv(poisoned, home => {
			const env = buildQueryOptions(required).env;
			assert.deepStrictEqual(env, { ...allowed, HOME: home, ...flags });
			assert.deepStrictEqual(env, buildChildEnv(process.env));
			for (const key of Object.keys(poison)) assert.equal(Object.hasOwn(env!, key), false, key);
		});
	});

	it("omits absent allowlisted variables and resolves the child directory without accessing it", () => {
		assert.deepStrictEqual(CC_CHILD_ENV, flags);
		assert.deepStrictEqual(CHILD_ENV_ALLOWLIST, ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]);
		withEnv({}, home => {
			const env = buildChildEnv();
			assert.deepStrictEqual(env, { HOME: home, ...flags });
			for (const key of CHILD_ENV_ALLOWLIST.filter(key => key !== "HOME")) assert.equal(Object.hasOwn(env, key), false);
			assert.equal(childClaudeDir(), join(home, ".claude"));
			assert.equal(childClaudeDir({ NODE_ENV: "test" }), join(homedir(), ".claude"));
		});
	});

	it("requires an absolute executable path", () => {
		for (const executable of ["", "bin/claude", undefined]) {
			assert.throws(() => buildQueryOptions({ ...required, executable } as QueryInputs), {
				message: "claude-code: executable path required",
			});
		}
	});

	it("refuses Windows before validating the executable", () => {
		for (const executable of [required.executable, "", undefined]) {
			assert.throws(() => buildQueryOptions({ ...required, executable } as QueryInputs, "win32"), {
				message: "claude-code: not supported on Windows",
			});
		}
	});

	it("builds the same options on macOS and Linux as the default platform", () => {
		withEnv({}, () => {
			for (const platform of ["darwin", "linux"] as const) {
				assert.deepStrictEqual(buildQueryOptions(required, platform), buildQueryOptions(required));
			}
		});
	});

	it("discards all unknown input keys and forces the safety contract", () => {
		withEnv({}, () => {
			const hostile = {
				...required, permissionMode: "default", settingSources: ["user"], tools: ["Bash"],
				allowedTools: ["Bash"], env: { ANTHROPIC_API_KEY: "x" }, strictMcpConfig: false,
				extraArgs: { foo: "bar" }, pathToClaudeCodeExecutable: "/evil", executableArgs: ["evil"],
				settings: { autoMemoryEnabled: true }, systemPrompt: "evil", includePartialMessages: false,
				resume: "evil", thinking: { type: "disabled" },
			} as QueryInputs;
			assert.deepStrictEqual(buildQueryOptions(hostile), buildQueryOptions(required));
		});
	});

	it("exports the exact continuation and MCP constants", () => {
		assert.equal(CONTINUE_TEXT, "[Continue from the tool result above.]");
		assert.equal(MCP_SERVER_NAME, "custom-tools");
		assert.equal(MCP_TOOL_PREFIX, "mcp__custom-tools__");
	});

	it("resolves every thinking level with full, partial, invalid and off maps", () => {
		const levels: (ModelThinkingLevel | undefined)[] = [undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"];
		const cases: { map?: ThinkingLevelMap; expected: (string | undefined)[] }[] = [
			{ expected: [undefined, undefined, "low", "low", "medium", "high", "max", "max"] },
			{ map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, expected: [undefined, undefined, undefined, "low", "medium", "high", "xhigh", "max"] },
			{ map: { xhigh: "xhigh", max: "max" }, expected: [undefined, undefined, "low", "low", "medium", "high", "xhigh", "max"] },
			{ map: { high: "turbo" } as ThinkingLevelMap, expected: [undefined, undefined, "low", "low", "medium", undefined, "max", "max"] },
			{ map: { off: "low" }, expected: [undefined, undefined, "low", "low", "medium", "high", "max", "max"] },
		];
		for (const { map, expected } of cases) {
			for (const [i, level] of levels.entries()) assert.equal(resolveEffort(map ? { thinkingLevelMap: map } : {}, level), expected[i], `${JSON.stringify(map)} / ${level}`);
		}
		assert.deepStrictEqual(REASONING_TO_EFFORT, { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" });
		assert.deepStrictEqual([...VALID_EFFORTS], ["low", "medium", "high", "xhigh", "max"]);
	});

	it("keeps forbidden transport overrides out of every provider source file", () => {
		const root = new URL("../src/agent/claude-code/", import.meta.url);
		for (const file of readdirSync(root, { recursive: true, withFileTypes: true })) {
			if (!file.isFile()) continue;
			const source = readFileSync(join(file.parentPath, file.name), "utf8");
			assert.doesNotMatch(source, /fetch\s*\(|transformHeaders|spawnClaudeCodeProcess|baseUrl\s*:\s*(?!["']{2})[^\s,}]+/, file.name);
		}
	});
});
