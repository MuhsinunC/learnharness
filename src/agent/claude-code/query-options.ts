import { isAbsolute } from "node:path";
import type { Options, EffortLevel, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { buildChildEnv } from "./child-env.ts";

export const CONTINUE_TEXT = "[Continue from the tool result above.]";
export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export type QueryInputs = {
	executable: string;
	cwd: string;
	cliModel: string;
	effort?: EffortLevel;
	appendPrompt: string;
	mcpServers?: Record<string, McpServerConfig>;
	resumeId: string;
	maxTurns?: number;
	persistSession?: boolean;
};

export function buildQueryOptions(inputs: QueryInputs): Options {
	if (!inputs.executable || !isAbsolute(inputs.executable)) {
		throw new Error("claude-code: executable path required");
	}
	return {
		cwd: inputs.cwd,
		includePartialMessages: true,
		resume: inputs.resumeId,
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
		...(inputs.maxTurns !== undefined ? { maxTurns: inputs.maxTurns } : {}),
		...(inputs.persistSession !== undefined ? { persistSession: inputs.persistSession } : {}),
		env: buildChildEnv(),
		permissionMode: "dontAsk",
		settingSources: [],
		tools: [],
		allowedTools: [`${MCP_TOOL_PREFIX}*`],
		strictMcpConfig: true,
	};
}

export const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
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
