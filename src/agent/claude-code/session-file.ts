import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSession, deleteSession, getProjectDir, type Message } from "cc-session-io";

import type { AnthropicMessage } from "./convert.ts";

export function writeSessionFile({ messages, cwd, claudeDir, model }: {
	messages: AnthropicMessage[];
	cwd: string;
	claudeDir: string;
	model: string;
}): { sessionId: string; jsonlPath: string } {
	const session = createSession({ projectPath: cwd, claudeDir, sessionId: randomUUID(), model });
	// cc-session-io preserves redacted thinking at runtime but omits it from its types.
	session.importMessages(messages as Message[]);
	session.save();
	if (session.records.length === 0) {
		// save() skips sessions with no pending records.
		mkdirSync(dirname(session.jsonlPath), { recursive: true });
		writeFileSync(session.jsonlPath, "", { flag: "wx" });
	}
	return { sessionId: session.sessionId, jsonlPath: session.jsonlPath };
}

export function deleteSessionFile(id: string, cwd: string, claudeDir: string): void {
	deleteSession(id, cwd, claudeDir);
}

export function sweepStaleSessions(
	cwd: string,
	claudeDir: string,
	olderThanMs = 3_600_000,
	now = Date.now(),
): void {
	const projectDir = getProjectDir(cwd, claudeDir);
	let entries;
	try {
		entries = readdirSync(projectDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		if (lstatSync(join(projectDir, entry.name)).mtimeMs < now - olderThanMs) {
			deleteSessionFile(entry.name.slice(0, -".jsonl".length), cwd, claudeDir);
		}
	}
}

export function claudeCodeWorkdir(dataDir: string): string {
	const cwd = join(dataDir, "claude-code", "cwd");
	mkdirSync(cwd, { recursive: true });
	return realpathSync(cwd);
}
