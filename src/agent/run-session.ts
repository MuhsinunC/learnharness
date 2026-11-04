import { randomUUID } from "node:crypto";

/**
 * A sub-agent run's model session (LH-62): a fresh session id for the run's
 * calls that no later call reuses. A provider that keeps state per session id
 * (the Claude Code live child) registers a closer here, so every runner frees
 * that state when its run ends without depending on the provider.
 */

const key = Symbol.for("lh.runSessionEnders");
const state = globalThis as typeof globalThis & { [key]?: Set<(sessionId: string) => void> };

export function onRunSessionEnd(end: (sessionId: string) => void): void {
	(state[key] ??= new Set()).add(end);
}

/** Call `end` once the run is over, whether it finished, failed or was aborted. */
export function runSession(): { id: string; end: () => void } {
	const id = randomUUID();
	return { id, end: () => { for (const end of state[key] ?? []) end(id); } };
}
