import { PATHS } from "../../config.ts";
import { disableClaudeCodeProvider, enableClaudeCodeProvider } from "../agent/models.ts";
import { readEndpointConfig } from "./claude-code-endpoint.ts";
import type { ClaudeCodeProviderDeps } from "../agent/claude-code/provider.ts";
import { isFillGapped } from "./keys.ts";
import { claudeExecutableProblem, readClaudeCodeSettings } from "./claude-code-settings.ts";

type BootDecision =
	| { kind: "unset" }
	| { kind: "rejected"; reason: string }
	| { kind: "accepted"; path: string; mode: "local" | "endpoint" };
const BOOT_KEY = Symbol.for("lh.claudeCodeBoot.v2");
type BootState = { decision: BootDecision; override: boolean; path?: string };
const bootState = globalThis as Record<symbol, BootState | undefined>;

function decide(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, saved = false): BootDecision {
	const p = env.LH_CLAUDE_CODE_EXECUTABLE;
	const reject = (reason: string): BootDecision => ({ kind: "rejected", reason });
	if (env.LH_IGNORE_ENV_KEYS === "1") return p ? reject("LH_IGNORE_ENV_KEYS=1") : { kind: "unset" };
	if (!p) return { kind: "unset" };
	if (platform === "win32") return reject("Windows is not supported");
	if (platform !== "darwin" && platform !== "linux") return reject(`unsupported platform ${platform}`);
	if (!saved && isFillGapped("LH_CLAUDE_CODE_EXECUTABLE")) return reject("set only via auth.json");
	const problem = claudeExecutableProblem(p);
	if (problem) return reject(problem);
	return { kind: "accepted", path: p, mode: "local" };
}

function savedDecision(platform: NodeJS.Platform): BootDecision {
	const saved = readClaudeCodeSettings();
	if (saved.mode === "off" || !saved.executable) return { kind: "unset" };
	// Reuse the stat-only gate, without treating saved settings as an env key.
	const decision = decide({ NODE_ENV: process.env.NODE_ENV, LH_CLAUDE_CODE_EXECUTABLE: saved.executable }, platform, true);
	if (decision.kind === "rejected") console.warn(`claude-code: saved executable ignored (${decision.reason})`);
	return decision.kind === "accepted" ? { ...decision, mode: saved.mode } : decision;
}
export function bootClaudeCodeProvider(env = process.env, platform: NodeJS.Platform = process.platform): void {
	let state = bootState[BOOT_KEY];
	if (!state) {
		const envDecision = decide(env, platform);
		if (envDecision.kind === "rejected") console.warn(`claude-code: LH_CLAUDE_CODE_EXECUTABLE ignored (${envDecision.reason})`);
		const override = !!env.LH_CLAUDE_CODE_EXECUTABLE && !isFillGapped("LH_CLAUDE_CODE_EXECUTABLE");
		state = bootState[BOOT_KEY] = {
			override, path: override ? env.LH_CLAUDE_CODE_EXECUTABLE : undefined,
			decision: override ? envDecision : savedDecision(platform),
		};
	}
	if (state.decision.kind === "accepted") {
		enableClaudeCodeProvider(state.decision.path, {
			dataDir: PATHS.data,
			...(state.decision.mode === "endpoint" ? { endpoint: readEndpointConfig } : {}),
			...(loadQueryForTests ? { loadQuery: loadQueryForTests } : {}),
		});
	}
	else disableClaudeCodeProvider();
}
export function claudeCodeEnvOverride(): { enabled: boolean; path?: string; rejected: boolean } {
	if (!bootState[BOOT_KEY]) bootClaudeCodeProvider();
	const state = bootState[BOOT_KEY]!;
	return { enabled: state.override, path: state.path, rejected: state.override && state.decision.kind !== "accepted" };
}
export function applyClaudeCodeSettings(): void {
	if (claudeCodeEnvOverride().enabled) return;
	bootState[BOOT_KEY]!.decision = savedDecision(process.platform);
	bootClaudeCodeProvider();
}
let loadQueryForTests: ClaudeCodeProviderDeps["loadQuery"];
export function setClaudeCodeLoadQueryForTests(loadQuery: ClaudeCodeProviderDeps["loadQuery"]): void {
	if (process.env.NODE_ENV !== "test") throw new Error("test-only injection");
	loadQueryForTests = loadQuery;
	applyClaudeCodeSettings();
}
export function resetClaudeCodeBootForTests(): void {
	loadQueryForTests = undefined;
	delete bootState[BOOT_KEY];
}
