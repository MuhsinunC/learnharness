import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSession, deleteSession, getProjectDir, normalizeProjectPath, type Message } from "cc-session-io";

import type { AnthropicMessage } from "./convert.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activeSessionsKey = Symbol.for("learnharness.claude-code.active-sessions");

function activeSessions(): Set<string> {
	const registry = globalThis as typeof globalThis & { [activeSessionsKey]?: Set<string> };
	return registry[activeSessionsKey] ??= new Set<string>();
}

export function markSessionActive(id: string): void {
	activeSessions().add(id);
}

export function markSessionDone(id: string): void {
	activeSessions().delete(id);
}

export function writeSessionFile({ messages, cwd, claudeDir, model }: {
	messages: AnthropicMessage[];
	cwd: string;
	claudeDir: string;
	model: string;
}): { sessionId: string; jsonlPath: string } {
	// With no prior history the orchestrator sends a fresh query without resume.
	if (messages.length === 0) throw new Error("claude-code: empty history");
	const session = createSession({ projectPath: cwd, claudeDir, sessionId: randomUUID(), model });
	// cc-session-io preserves redacted thinking at runtime but omits it from its types.
	session.importMessages(messages as Message[]);
	session.save();
	if (session.records.length === 0) throw new Error("claude-code: empty history");
	return { sessionId: session.sessionId, jsonlPath: session.jsonlPath };
}

export function deleteSessionFile(id: string, cwd: string, claudeDir: string): void {
	if (!SESSION_ID.test(id)) throw new Error(`claude-code: invalid session id "${id}"`);
	deleteSession(id, cwd, claudeDir);
}

function recordedCwd(path: string): string | undefined {
	for (const line of readFileSync(path, "utf8").split("\n")) {
		try {
			const record = JSON.parse(line);
			if (record !== null && typeof record === "object" && typeof record.cwd === "string") return record.cwd;
		} catch {
			continue;
		}
	}
}

/** Deletes only sessions whose recorded cwd is this workdir, plus orphaned companion dirs. */
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
		if (entry.isDirectory() && SESSION_ID.test(entry.name) && !activeSessions().has(entry.name)) {
			try {
				lstatSync(join(projectDir, `${entry.name}.jsonl`));
				continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			try {
				const path = join(projectDir, entry.name);
				if (lstatSync(path).mtimeMs < now - olderThanMs) rmSync(path, { recursive: true, force: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const id = entry.name.slice(0, -".jsonl".length);
		if (!SESSION_ID.test(id) || activeSessions().has(id)) continue;
		try {
			const path = join(projectDir, entry.name);
			if (lstatSync(path).mtimeMs < now - olderThanMs && recordedCwd(path) === normalizeProjectPath(cwd)) {
				deleteSessionFile(id, cwd, claudeDir);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export function claudeCodeWorkdir(dataDir: string): string {
	const cwd = join(dataDir, "claude-code", "cwd");
	mkdirSync(cwd, { recursive: true });
	const realCwd = realpathSync(cwd);
	const normalized = normalizeProjectPath(realCwd);
	if (normalized.length > 200) {
		throw new Error(`claude-code: workdir path is ${normalized.length} characters; cc-session-io/Claude Code resume requires at most 200 (${normalized}); use a shorter data directory`);
	}
	return realCwd;
}
