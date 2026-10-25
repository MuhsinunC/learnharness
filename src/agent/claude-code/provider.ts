import { createProvider, type Api, type Model, type ProviderStreams, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { PATHS } from "../../../config.ts";
import { childClaudeDir } from "./child-env.ts";
import type { EventMapperLogger } from "./events.ts";
import { claudeCodeCatalog } from "./models.ts";
import { defaultLoadQuery, streamClaudeCode } from "./stream.ts";

export type ClaudeCodeProviderDeps = {
	loadQuery?: typeof defaultLoadQuery;
	dataDir?: string;
	claudeDir?: string;
	logger?: EventMapperLogger;
};

export function claudeCodeProvider(executable: string, anthropicModels: readonly Model<Api>[], deps: ClaudeCodeProviderDeps = {}) {
	const streamDeps = {
		executable,
		loadQuery: deps.loadQuery ?? defaultLoadQuery,
		dataDir: deps.dataDir ?? PATHS.data,
		claudeDir: deps.claudeDir ?? childClaudeDir(),
		logger: deps.logger ?? { debug: () => {}, warn: (message: string) => console.warn(message) },
	};
	const s = (model: Model<Api>, transcript: TranscriptContext, options?: SimpleStreamOptions) => streamClaudeCode(model, transcript, options, streamDeps);
	return createProvider<"claude-agent-sdk">({
		id: "claude-code", name: "Claude (subscription, Claude Code)",
		auth: { apiKey: { name: "Claude subscription via Claude Code", resolve: async () => ({ auth: {}, source: "LH_CLAUDE_CODE_EXECUTABLE" }) } },
		models: claudeCodeCatalog(anthropicModels),
		api: { stream: s as ProviderStreams["stream"], streamSimple: s },
	});
}
