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
	/** @type {Map<string, import("node:fs").Dirent[]>} */
	const visited = new Map();
	const contexts = new Set();
	/** @param {string[]} parts */
	function walk(parts) {
		const dir = path.join(rootDir, ...parts);
		const real = fs.realpathSync(dir);
		// Aliases can reach the same directory at different package-matching depths.
		const scoped = parts.at(-2) === "node_modules" && parts.at(-1) === "@anthropic-ai";
		const context = JSON.stringify([real, scoped ? "scope" : parts.at(-1) === "node_modules" ? "modules" : "other"]);
		if (contexts.has(context)) return;
		contexts.add(context);
		const cached = visited.get(real);
		const entries = cached ?? fs.readdirSync(dir, { withFileTypes: true });
		visited.set(real, entries);
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const relative = [...parts, entry.name];
			if (scoped && entry.name.startsWith("claude-agent-sdk-")) {
				forbidden.push(relative.join("/"));
			} else if (entry.isDirectory() || (fs.existsSync(path.join(dir, entry.name))
				&& fs.statSync(path.join(dir, entry.name)).isDirectory())) {
				walk(relative);
			}
		}
	}
	if (fs.existsSync(rootDir)) walk([]);
	return forbidden.sort();
}
