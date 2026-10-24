/**
 * Guard the desktop payload for the personal-use Claude Code provider: the
 * SDK's per-platform Claude Code binary must never ship inside the app.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** @param {string} rootDir @returns {string[]} */
export function findForbiddenPayload(rootDir) {
	/** @type {string[]} */
	const forbidden = [];
	/** @param {string[]} parts */
	function walk(parts) {
		for (const entry of fs.readdirSync(path.join(rootDir, ...parts), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const relative = [...parts, entry.name];
			if (parts.at(-2) === "node_modules" && parts.at(-1) === "@anthropic-ai"
				&& entry.name.startsWith("claude-agent-sdk-")) {
				forbidden.push(relative.join("/"));
			} else {
				walk(relative);
			}
		}
	}
	if (fs.existsSync(rootDir)) walk([]);
	return forbidden.sort();
}
