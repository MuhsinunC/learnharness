import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";

export type ClaudeCodeSettings = { mode: "off" | "local" | "endpoint"; executable: string | null };
const settingsFile = join(PATHS.data, "claude-code.json");
const warningKey = Symbol.for("lh.claudeCodeSettingsWarning");
const warnings = globalThis as Record<symbol, boolean | undefined>;
const stateKey = Symbol.for("lh.claudeCodeSettings.v2");
const globalState = globalThis as typeof globalThis & {
	[stateKey]?: { generation: number; last: ClaudeCodeSettings; error: string | null };
};
const state = globalState[stateKey] ??= { generation: 0, last: { mode: "off", executable: null }, error: null };
export function claudeSettingsGeneration(): number { return state.generation; }
export function claudeSettingsError(): string | null { return state.error; }
export function readClaudeCodeSettings(): ClaudeCodeSettings {
	try {
		const value = JSON.parse(readFileSync(settingsFile, "utf8"));
		if (!value || !["off", "local", "endpoint"].includes(value.mode) ||
			!(value.executable === null || typeof value.executable === "string") ||
			(value.mode !== "off" && !value.executable)) throw new Error();
		state.last = { mode: value.mode, executable: value.executable };
		state.error = null;
		return state.last;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !warnings[warningKey]) {
			warnings[warningKey] = true;
			console.warn("claude-code: invalid connection settings ignored");
		}
		state.error = (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "saved Claude settings could not be read";
		return state.error ? state.last : { mode: "off", executable: null };
	}
}
export function writeClaudeCodeSettings(settings: ClaudeCodeSettings): void {
	mkdirSync(PATHS.data, { recursive: true });
	const temporary = `${settingsFile}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(settings));
		renameSync(temporary, settingsFile);
		state.generation++;
	} finally { rmSync(temporary, { force: true }); }
}
export function claudeExecutableProblem(executable: string): string | null {
	if (!isAbsolute(executable)) return "not an absolute path";
	try { if (!statSync(executable).isFile()) return "not a file"; } catch { return "not a file"; }
	try { accessSync(executable, constants.X_OK); } catch { return "not executable"; }
	return null;
}
