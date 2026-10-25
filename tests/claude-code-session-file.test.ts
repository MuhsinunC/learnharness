import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { getProjectDir, openSession } from "cc-session-io";
import { convertPiMessages, type AnthropicMessage } from "../src/agent/claude-code/convert.ts";
import { claudeCodeWorkdir, deleteSessionFile, sweepStaleSessions, writeSessionFile } from "../src/agent/claude-code/session-file.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(os.tmpdir(), "lh-2f-"));
	const previousHome = process.env.HOME;
	const home = join(root, "home");
	mkdirSync(home);
	process.env.HOME = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	});
	const dataDir = join(root, "data");
	const cwd = claudeCodeWorkdir(dataDir);
	return { root, dataDir, cwd, claudeDir: join(home, ".claude"), model: "test-model" };
}

const history: AnthropicMessage[] = [
	{ role: "user", content: [{ type: "text", text: "Run quiz" }] },
	{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "quiz", input: { topic: "math" } }] },
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "done" }] },
];

test("session JSONL round-trips roles and contents, ending in a real tool result", (t) => {
	const options = fixture(t);
	const written = writeSessionFile({ ...options, messages: history });
	const session = openSession({ ...options, projectPath: options.cwd, sessionId: written.sessionId });
	assert.deepEqual(session.messages.map(record => ({ role: record.message.role, content: record.message.content })), history);
	assert.deepEqual(session.messages.at(-1)!.message.content, history.at(-1)!.content);
	assert.ok(!readFileSync(written.jsonlPath, "utf8").includes("[no tool result recorded]"));
	assert.equal(session.messages[1]!.message.role, "assistant");
	assert.equal(session.messages[1]!.type, "assistant");
	if (session.messages[1]!.type === "assistant") assert.equal(session.messages[1]!.message.model, options.model);
});

test("writes use distinct ids and paths, including valid empty sessions", (t) => {
	const options = fixture(t);
	const first = writeSessionFile({ ...options, messages: [] });
	const second = writeSessionFile({ ...options, messages: [] });
	assert.notEqual(first.sessionId, second.sessionId);
	assert.notEqual(first.jsonlPath, second.jsonlPath);
	for (const written of [first, second]) {
		assert.ok(existsSync(written.jsonlPath));
		assert.equal(openSession({ ...options, projectPath: options.cwd, sessionId: written.sessionId }).messages.length, 0);
	}
});

test("delete removes JSONL and populated companion directory and tolerates missing artifacts", (t) => {
	const options = fixture(t);
	const written = writeSessionFile({ ...options, messages: history });
	const companion = join(getProjectDir(options.cwd, options.claudeDir), written.sessionId);
	mkdirSync(companion);
	writeFileSync(join(companion, "artifact"), "data");
	deleteSessionFile(written.sessionId, options.cwd, options.claudeDir);
	assert.ok(!existsSync(written.jsonlPath));
	assert.ok(!existsSync(companion));
	assert.doesNotThrow(() => deleteSessionFile(written.sessionId, options.cwd, options.claudeDir));
	mkdirSync(companion);
	writeFileSync(join(companion, "orphan"), "data");
	deleteSessionFile(written.sessionId, options.cwd, options.claudeDir);
	assert.ok(!existsSync(companion));
});

test("sweep deletes only old JSONL files and companions inside this project", (t) => {
	const options = fixture(t);
	const now = 1_800_000_000_000;
	assert.doesNotThrow(() => sweepStaleSessions(options.cwd, options.claudeDir, 3_600_000, now));
	const old = writeSessionFile({ ...options, messages: history });
	const fresh = writeSessionFile({ ...options, messages: [] });
	const boundary = writeSessionFile({ ...options, messages: [] });
	const siblingCwd = claudeCodeWorkdir(join(options.root, "sibling-data"));
	const sibling = writeSessionFile({ ...options, cwd: siblingCwd, messages: history });
	const projectDir = getProjectDir(options.cwd, options.claudeDir);
	const companion = join(projectDir, old.sessionId);
	mkdirSync(companion);
	writeFileSync(join(companion, "artifact"), "data");
	const freshCompanion = join(projectDir, fresh.sessionId);
	mkdirSync(freshCompanion);
	const unrelated = join(projectDir, "keep.txt");
	writeFileSync(unrelated, "keep");
	for (const path of [old.jsonlPath, sibling.jsonlPath, unrelated]) utimesSync(path, new Date(now - 3_600_001), new Date(now - 3_600_001));
	utimesSync(fresh.jsonlPath, new Date(now), new Date(now));
	utimesSync(boundary.jsonlPath, new Date(now - 3_600_000), new Date(now - 3_600_000));
	const link = join(projectDir, "external.jsonl");
	symlinkSync(sibling.jsonlPath, link);
	sweepStaleSessions(options.cwd, options.claudeDir, undefined, now);
	assert.ok(!existsSync(old.jsonlPath));
	assert.ok(!existsSync(companion));
	for (const path of [fresh.jsonlPath, freshCompanion, boundary.jsonlPath, sibling.jsonlPath, unrelated, link]) assert.ok(existsSync(path), path);
});

test("workdir resolves a symlinked data directory to its realpath", (t) => {
	const options = fixture(t);
	const link = join(options.root, "data-link");
	symlinkSync(options.dataDir, link, "dir");
	const cwd = claudeCodeWorkdir(link);
	assert.equal(cwd, realpathSync(join(options.dataDir, "claude-code", "cwd")));
	assert.ok(cwd.startsWith(realpathSync(options.dataDir) + "/"));
	assert.ok(!cwd.includes(link));
});

test("converted redacted thinking survives import tool-pair repair and JSONL round-trip", (t) => {
	const options = fixture(t);
	const assistant: AssistantMessage = {
		role: "assistant", provider: "claude-code", api: "anthropic-messages", model: "test", stopReason: "toolUse", timestamp: 1,
		content: [
			{ type: "thinking", thinking: "", thinkingSignature: "<sig>", redacted: true },
			{ type: "toolCall", id: "call-1", name: "quiz", arguments: {} },
		],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const piHistory: Message[] = [
		{ role: "user", content: "Run quiz", timestamp: 1 },
		assistant,
		{ role: "toolResult", toolCallId: "call-1", toolName: "quiz", content: [{ type: "text", text: "done" }], isError: false, timestamp: 1 },
	];
	const { anthropicMessages } = convertPiMessages(piHistory, new Map());
	const written = writeSessionFile({ ...options, messages: anthropicMessages });
	const session = openSession({ ...options, projectPath: options.cwd, sessionId: written.sessionId });
	const content = session.messages.find(record => record.type === "assistant")!.message.content;
	assert.ok(Array.isArray(content));
	assert.deepEqual(content[0], { type: "redacted_thinking", data: "<sig>" });
	assert.deepEqual(content, anthropicMessages[1]!.content);
	assert.deepEqual(session.messages.at(-1)!.message.content, [{
		type: "tool_result", tool_use_id: "call-1", content: "done",
	}]);
});
