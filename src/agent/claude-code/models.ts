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

function buildModels<T extends Model<Api>>(piAiModels: readonly T[]) {
	return piAiModels
		.filter((m) => !isDatedAlias(m.id))
		.sort((a, b) => {
			const va = versionRank(a.id);
			const vb = versionRank(b.id);
			const fa = FAMILY_ORDER.indexOf(va.family);
			const fb = FAMILY_ORDER.indexOf(vb.family);
			const ta = fa === -1 ? FAMILY_ORDER.length : fa;
			const tb = fb === -1 ? FAMILY_ORDER.length : fb;
			if (ta !== tb) return ta - tb;
			const ra = va.tuple;
			const rb = vb.tuple;
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

type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

// Only measured subscription-safe ids request the SDK's explicit 1M window.
// claude-opus-4-6 and claude-sonnet-4-6 reach 1M only on the Max plan or with
// long-context extra usage; this provider assumes neither, so they run at 200K.
export const MEASURED_ONE_M = new Set([
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-sonnet-5",
]);

function resolveClaudeCodeRuntimeModel(model: { id: string }): ClaudeCodeRuntimeModel {
	const modelId = model.id;
	if (MEASURED_ONE_M.has(modelId)) {
		return { cliModelId: `${modelId}[1m]`, contextWindow: ONE_M_CONTEXT };
	}
	return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
}

export function claudeCodeModelId(model: { id: string }): string {
	return resolveClaudeCodeRuntimeModel(model).cliModelId;
}

function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(models: T[]): T[] {
	return models.map((m) => {
		const { contextWindow } = resolveClaudeCodeRuntimeModel(m);
		const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
	});
}

export function claudeCodeCatalog(anthropicModels: readonly Model<Api>[]): Model<"claude-agent-sdk">[] {
	return applyLongContext(buildModels(anthropicModels)).map(model => ({
		...model, provider: "claude-code", api: "claude-agent-sdk", baseUrl: "",
	}));
}
