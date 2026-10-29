import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * The end-to-end test seam (tests/e2e/harness): extra OpenAI-compatible
 * providers that point at a local stub server. Read ONLY when LH_E2E=1, so
 * production never sees it. LH_E2E_PROVIDERS is a JSON array:
 *
 *   [{ "id": "e2e-stub", "baseUrl": "http://127.0.0.1:PORT/v1",
 *      "models": [{ "id": "stub-a", "input": ["text", "image"], "contextWindow": 128000 }] }]
 *
 * Each model entry is a partial pi Model merged over text-only defaults.
 * The ids are absent from AUTH_PROVIDER_KEYS, so the key-presence gates
 * pass and every request reaches the stub, which decides the outcome.
 */

interface E2EProviderSpec {
	id: string;
	baseUrl: string;
	models: Array<Partial<Model<"openai-completions">> & { id: string }>;
}

export function e2eProviders(): Provider[] {
	if (process.env.LH_E2E !== "1" || !process.env.LH_E2E_PROVIDERS) return [];
	const specs = JSON.parse(process.env.LH_E2E_PROVIDERS) as E2EProviderSpec[];
	return specs.map((spec) =>
		createProvider({
			id: spec.id,
			name: spec.id,
			baseUrl: spec.baseUrl,
			auth: { apiKey: { name: "e2e stub key", resolve: async () => ({ auth: { apiKey: "e2e-stub" }, source: "LH_E2E" }) } },
			api: openAICompletionsApi(),
			models: spec.models.map((m) => ({
				name: m.id,
				api: "openai-completions" as const,
				provider: spec.id,
				baseUrl: spec.baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
				...m,
			})),
		}),
	);
}
