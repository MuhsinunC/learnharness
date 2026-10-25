/**
 * Query options for the personal macOS/Linux provider.
 * The child env allowlist is the safety contract; Windows needs USERPROFILE/SystemRoot/APPDATA, which is out of scope.
 */
import { isAbsolute } from "node:path";
import type { Options, EffortLevel, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ClaudeCodeEndpoint } from "../../core/claude-code-endpoint.ts";
import { buildChildEnv } from "./child-env.ts";

export const CONTINUE_TEXT = "[Continue from the tool result above.]";
export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export type QueryInputs = {
	endpoint?: ClaudeCodeEndpoint | null;
	executable: string;
	cwd: string;
	cliModel: string;
	effort?: EffortLevel;
	appendPrompt: string;
	mcpServers?: Record<string, McpServerConfig>;
	resumeId?: string;
};

export function buildQueryOptions(inputs: QueryInputs, platform: NodeJS.Platform = process.platform): Options {
	if (platform === "win32") throw new Error("claude-code: not supported on Windows");
	if (!inputs.executable || !isAbsolute(inputs.executable)) {
		throw new Error("claude-code: executable path required");
	}
	return {
		cwd: inputs.cwd,
		includePartialMessages: true,
		...(inputs.resumeId ? { resume: inputs.resumeId } : {}),
		pathToClaudeCodeExecutable: inputs.executable,
		systemPrompt: { type: "preset", preset: "claude_code", append: inputs.appendPrompt },
		settings: {
			autoMemoryEnabled: false,
			includeGitInstructions: false,
			claudeMdExcludes: ["**/CLAUDE.md", "**/.claude/rules/**"],
		},
		extraArgs: {
			model: inputs.cliModel,
			"strict-mcp-config": null,
			// Request thinking_delta events rather than omitted thinking text.
			...(inputs.effort ? { "thinking-display": "summarized" } : {}),
		},
		...(inputs.effort !== undefined ? { effort: inputs.effort } : {}),
		...(inputs.mcpServers !== undefined ? { mcpServers: inputs.mcpServers } : {}),
		maxTurns: 1,
		persistSession: false,
		env: buildChildEnv(process.env, inputs.endpoint, inputs.executable),
		permissionMode: "dontAsk",
		settingSources: [],
		tools: [],
		allowedTools: [`${MCP_TOOL_PREFIX}*`],
		strictMcpConfig: true,
	};
}

export const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

export const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

export function resolveEffort(
	model: { thinkingLevelMap?: ThinkingLevelMap },
	reasoning: ModelThinkingLevel | undefined,
): EffortLevel | undefined {
	if (reasoning === undefined || reasoning === "off") return undefined;
	const mapped = model.thinkingLevelMap?.[reasoning];
	return mapped === undefined
		? REASONING_TO_EFFORT[reasoning]
		: VALID_EFFORTS.has(mapped as EffortLevel) ? mapped as EffortLevel : undefined;
}
