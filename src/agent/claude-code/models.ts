import type { Api, Model } from "@earendil-works/pi-ai";

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

function isDatedAlias(id: string): boolean {
	return /-20\d{6}$/.test(id);
}

const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

function versionRank(id: string): { family: string; tuple: [number, number] } {
	const [, family, major, minor] = id.split("-");
	return { family: family ?? "", tuple: [Number(major) || 0, Number(minor) || 0] };
}

export function buildModels<T extends Model<Api>>(piAiModels: readonly T[]) {
	return piAiModels
		.filter((m) => typeof m.id === "string" && !isDatedAlias(m.id))
		.sort((a, b) => {
			const fa = FAMILY_ORDER.indexOf(versionRank(a.id).family);
			const fb = FAMILY_ORDER.indexOf(versionRank(b.id).family);
			const ta = fa === -1 ? FAMILY_ORDER.length : fa;
			const tb = fb === -1 ? FAMILY_ORDER.length : fb;
			if (ta !== tb) return ta - tb;
			const ra = versionRank(a.id).tuple;
			const rb = versionRank(b.id).tuple;
			if (ra[0] !== rb[0]) return rb[0] - ra[0];
			if (ra[1] !== rb[1]) return rb[1] - ra[1];
			return a.id.localeCompare(b.id);
		})
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens,
			thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
	forceTwoHundredK?: string[];
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

// Only measured subscription-safe ids request the SDK's explicit 1M window.
export const MEASURED_ONE_M = new Set([
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-sonnet-5",
]);

const PLAN_GATED_ONE_M: Record<string, (settings: LongContextSettings) => boolean> = {
	"claude-opus-4-6": (settings) => settings.plan === "max" || settings.longContextExtraUsage,
	"claude-sonnet-4-6": (settings) => settings.longContextExtraUsage,
};

export function resolveClaudeCodeRuntimeModel(
	model: { id: string },
	settings: LongContextSettings,
): ClaudeCodeRuntimeModel {
	const modelId = model.id;
	if (settings.forceTwoHundredK?.includes(modelId)) {
		return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
	if (MEASURED_ONE_M.has(modelId)) {
		return { cliModelId: `${modelId}[1m]`, contextWindow: ONE_M_CONTEXT };
	}
	const planGate = PLAN_GATED_ONE_M[modelId];
	if (planGate) {
		const useOneM = planGate(settings);
		return {
			cliModelId: useOneM ? `${modelId}[1m]` : modelId,
			contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
		};
	}
	return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
	return resolveClaudeCodeRuntimeModel(model, settings).cliModelId;
}

export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	return models.map((m) => {
		const { contextWindow } = resolveClaudeCodeRuntimeModel(m, settings);
		const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
	});
}

export const CLAUDE_CODE_SETTINGS: LongContextSettings = Object.freeze({ plan: "pro", longContextExtraUsage: false });

export function claudeCodeCatalog(anthropicModels: readonly Model<Api>[]): Model<"claude-agent-sdk">[] {
	return applyLongContext(buildModels(anthropicModels), CLAUDE_CODE_SETTINGS).map(model => ({
		...model, provider: "claude-code", api: "claude-agent-sdk", "baseUrl": "",
	}));
}
