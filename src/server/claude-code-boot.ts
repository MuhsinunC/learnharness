import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PATHS } from "../../config.ts";
import { enableClaudeCodeProvider } from "../agent/models.ts";
import { isFillGapped } from "./keys.ts";

type BootDecision =
	| { kind: "unset" }
	| { kind: "rejected"; reason: string }
	| { kind: "accepted"; path: string };
const BOOT_KEY = Symbol.for("lh.claudeCodeBoot");
const bootState = globalThis as Record<symbol, BootDecision | undefined>;

function decide(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): BootDecision {
	const p = env.LH_CLAUDE_CODE_EXECUTABLE;
	const reject = (reason: string): BootDecision => ({ kind: "rejected", reason });
	if (env.LH_IGNORE_ENV_KEYS === "1") return p ? reject("LH_IGNORE_ENV_KEYS=1") : { kind: "unset" };
	if (!p) return { kind: "unset" };
	if (platform === "win32") return reject("Windows is not supported");
	if (platform !== "darwin" && platform !== "linux") return reject(`unsupported platform ${platform}`);
	if (isFillGapped("LH_CLAUDE_CODE_EXECUTABLE")) return reject("set only via auth.json");
	if (!isAbsolute(p)) return reject("not an absolute path");
	try {
		if (!statSync(p).isFile()) return reject("not a file");
	} catch {
		return reject("not a file");
	}
	try {
		accessSync(p, constants.X_OK);
	} catch {
		return reject("not executable");
	}
	return { kind: "accepted", path: p };
}

export function bootClaudeCodeProvider(env = process.env, platform: NodeJS.Platform = process.platform): void {
	let decision = bootState[BOOT_KEY];
	if (!decision) {
		decision = bootState[BOOT_KEY] = decide(env, platform);
		if (decision.kind === "rejected") {
			console.warn(`claude-code: LH_CLAUDE_CODE_EXECUTABLE ignored (${decision.reason})`);
		}
	}
	// Re-register module-local state after HMR or a duplicated bundle import.
	if (decision.kind === "accepted") enableClaudeCodeProvider(decision.path, { dataDir: PATHS.data });
}

export function resetClaudeCodeBootForTests(): void {
	delete bootState[BOOT_KEY];
}
