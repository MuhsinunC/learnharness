import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { getProjectDir, openSession } from "cc-session-io";
import { convertPiMessages, type AnthropicMessage } from "../src/agent/claude-code/convert.ts";
import { claudeCodeWorkdir, deleteSessionFile, markSessionActive, markSessionDone, sweepStaleSessions, writeSessionFile } from "../src/agent/claude-code/session-file.ts";

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

test("writes use distinct ids and paths for non-empty histories", (t) => {
	const options = fixture(t);
	const first = writeSessionFile({ ...options, messages: history });
	const second = writeSessionFile({ ...options, messages: history });
	assert.notEqual(first.sessionId, second.sessionId);
	assert.notEqual(first.jsonlPath, second.jsonlPath);
	for (const written of [first, second]) {
		assert.ok(existsSync(written.jsonlPath));
		assert.equal(openSession({ ...options, projectPath: options.cwd, sessionId: written.sessionId }).messages.length, history.length);
	}
});

test("empty history throws before creating a project directory", (t) => {
	const options = fixture(t);
	assert.throws(() => writeSessionFile({ ...options, messages: [] }), /claude-code: empty history/);
	assert.ok(!existsSync(getProjectDir(options.cwd, options.claudeDir)));
	assert.ok(!existsSync(options.claudeDir));
});

test("non-empty input that imports no records is rejected", (t) => {
	const options = fixture(t);
	assert.throws(() => writeSessionFile({ ...options, messages: [{ role: "user", content: [] }] }), /claude-code: empty history/);
	assert.ok(!existsSync(getProjectDir(options.cwd, options.claudeDir)));
});

test("invalid session names survive sweeping and invalid delete ids throw", (t) => {
	const options = fixture(t);
	const fresh = writeSessionFile({ ...options, messages: history });
	const projectDir = getProjectDir(options.cwd, options.claudeDir);
	const now = 1_800_000_000_000;
	const keep = [".jsonl", "foo.jsonl", "keep.txt"].map(name => join(projectDir, name));
	for (const path of keep) {
		writeFileSync(path, "keep");
		utimesSync(path, new Date(0), new Date(0));
	}
	utimesSync(fresh.jsonlPath, new Date(now), new Date(now));
	sweepStaleSessions(options.cwd, options.claudeDir, undefined, now);
	for (const id of ["", "foo"]) {
		assert.throws(() => deleteSessionFile(id, options.cwd, options.claudeDir), {
			message: `claude-code: invalid session id "${id}"`,
		});
	}
	for (const path of [projectDir, fresh.jsonlPath, ...keep]) assert.ok(existsSync(path), path);
});

test("sweep skips per-entry ENOENT races but propagates other errors", (t) => {
	const options = fixture(t);
	const removed = writeSessionFile({ ...options, messages: history });
	const other = writeSessionFile({ ...options, messages: history });
	for (const path of [removed.jsonlPath, other.jsonlPath]) utimesSync(path, new Date(0), new Date(0));
	const original = fs.lstatSync;
	let code = "ENOENT";
	const mocked = t.mock.method(fs, "lstatSync", ((...args: Parameters<typeof fs.lstatSync>) => {
		if (args[0] === removed.jsonlPath) {
			if (code === "ENOENT") fs.unlinkSync(removed.jsonlPath);
			throw Object.assign(new Error(code), { code });
		}
		return original(...args);
	}) as typeof fs.lstatSync);
	t.after(() => {
		mocked.mock.restore();
		syncBuiltinESMExports();
	});
	syncBuiltinESMExports();
	assert.doesNotThrow(() => sweepStaleSessions(options.cwd, options.claudeDir, undefined, 1_800_000_000_000));
	assert.ok(!existsSync(removed.jsonlPath));
	assert.ok(!existsSync(other.jsonlPath));
	writeFileSync(removed.jsonlPath, "");
	code = "EACCES";
	assert.throws(() => sweepStaleSessions(options.cwd, options.claudeDir), { code: "EACCES" });
});

test("active old sessions survive until marked done", (t) => {
	const options = fixture(t);
	const written = writeSessionFile({ ...options, messages: history });
	utimesSync(written.jsonlPath, new Date(0), new Date(0));
	markSessionActive(written.sessionId);
	t.after(() => markSessionDone(written.sessionId));
	sweepStaleSessions(options.cwd, options.claudeDir, undefined, 1_800_000_000_000);
	assert.ok(existsSync(written.jsonlPath));
	markSessionDone(written.sessionId);
	sweepStaleSessions(options.cwd, options.claudeDir, undefined, 1_800_000_000_000);
	assert.ok(!existsSync(written.jsonlPath));
});

test("workdir accepts 200 normalized characters and refuses 201", (t) => {
	const options = fixture(t);
	const root = realpathSync(options.root);
	for (const length of [200, 201]) {
		const padding = length - join(root, "claude-code", "cwd").length - 1;
		assert.ok(padding > 0 && padding < 255);
		const dataDir = join(root, "x".repeat(padding));
		if (length === 200) {
			const cwd = claudeCodeWorkdir(dataDir);
			assert.equal(cwd.length, 200);
			assert.equal(cwd, realpathSync(join(dataDir, "claude-code", "cwd")));
		} else {
			assert.throws(() => claudeCodeWorkdir(dataDir), error => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /201 characters.*at most 200/);
				assert.ok(error.message.includes(join(dataDir, "claude-code", "cwd")));
				return true;
			});
		}
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
	const fresh = writeSessionFile({ ...options, messages: history });
	const boundary = writeSessionFile({ ...options, messages: history });
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

test("sweep checks recorded cwd when workdirs share a project directory", (t) => {
	const options = fixture(t);
	const now = 1_800_000_000_000;
	const workdirs = ["a-b", "a_b"].map(name => {
		const path = join(options.root, name, "cwd");
		mkdirSync(path, { recursive: true });
		return realpathSync(path);
	});
	const cwdA = workdirs[0]!;
	const cwdB = workdirs[1]!;
	const projectDir = getProjectDir(cwdA, options.claudeDir);
	assert.equal(projectDir, getProjectDir(cwdB, options.claudeDir));
	const sessions = workdirs.map(cwd => writeSessionFile({ ...options, cwd, messages: history }));
	const companions = sessions.map(session => join(projectDir, session.sessionId));
	for (const path of companions) mkdirSync(path);
	// Summary and malformed records can precede the first record with a cwd.
	writeFileSync(sessions[0]!.jsonlPath, `{}\nnot JSON\nnull\n${readFileSync(sessions[0]!.jsonlPath, "utf8")}`);
	for (const path of [...sessions.map(session => session.jsonlPath), ...companions]) {
		utimesSync(path, new Date(0), new Date(0));
	}
	sweepStaleSessions(cwdA, options.claudeDir, undefined, now);
	assert.ok(!existsSync(sessions[0]!.jsonlPath));
	assert.ok(!existsSync(companions[0]!));
	assert.ok(existsSync(sessions[1]!.jsonlPath));
	assert.ok(existsSync(companions[1]!));
	sweepStaleSessions(cwdB, options.claudeDir, undefined, now);
	assert.ok(!existsSync(sessions[1]!.jsonlPath));
	assert.ok(!existsSync(companions[1]!));
});

test("sweep keeps old sessions without a readable cwd", (t) => {
	const options = fixture(t);
	const now = 1_800_000_000_000;
	const projectDir = getProjectDir(options.cwd, options.claudeDir);
	mkdirSync(projectDir, { recursive: true });
	const paths = ["not JSON\n", "{}\n{}\n"].map(content => {
		const path = join(projectDir, `${randomUUID()}.jsonl`);
		writeFileSync(path, content);
		utimesSync(path, new Date(0), new Date(0));
		return path;
	});
	sweepStaleSessions(options.cwd, options.claudeDir, undefined, now);
	for (const path of paths) assert.ok(existsSync(path), path);
});

test("sweep leaves old orphan UUID companion directories untouched", (t) => {
	const options = fixture(t);
	const companion = join(getProjectDir(options.cwd, options.claudeDir), randomUUID());
	mkdirSync(companion, { recursive: true });
	const artifact = join(companion, "artifact");
	writeFileSync(artifact, "data");
	utimesSync(companion, new Date(0), new Date(0));
	sweepStaleSessions(options.cwd, options.claudeDir, undefined, 1_800_000_000_000);
	assert.ok(existsSync(companion));
	assert.ok(existsSync(artifact));
});

test("sweep bounds transcript reads to 64 KiB", (t) => {
	const options = fixture(t);
	const written = writeSessionFile({ ...options, messages: history });
	const companion = join(getProjectDir(options.cwd, options.claudeDir), written.sessionId);
	mkdirSync(companion);
	writeFileSync(written.jsonlPath, `${JSON.stringify({ cwd: options.cwd })}\n${"x".repeat(1024 * 1024 + 1)}`);
	utimesSync(written.jsonlPath, new Date(0), new Date(0));
	const original = fs.readSync;
	let total = 0;
	const mocked = t.mock.method(fs, "readSync", ((...args: Parameters<typeof fs.readSync>) => {
		const bytes = original(...args);
		total += bytes;
		return bytes;
	}) as typeof fs.readSync);
	t.after(() => {
		mocked.mock.restore();
		syncBuiltinESMExports();
	});
	syncBuiltinESMExports();
	sweepStaleSessions(options.cwd, options.claudeDir, undefined, 1_800_000_000_000);
	assert.ok(!existsSync(written.jsonlPath));
	assert.ok(!existsSync(companion));
	assert.ok(total > 0 && total <= 64 * 1024, `read ${total} bytes`);
});

test("sweep keeps sessions whose first cwd record is beyond the scan cap", (t) => {
	const options = fixture(t);
	const written = writeSessionFile({ ...options, messages: history });
	writeFileSync(written.jsonlPath, `${"{}\n".repeat(24 * 1024)}${JSON.stringify({ cwd: options.cwd })}\n`);
	utimesSync(written.jsonlPath, new Date(0), new Date(0));
	sweepStaleSessions(options.cwd, options.claudeDir, undefined, 1_800_000_000_000);
	assert.ok(existsSync(written.jsonlPath));
});

test("sweep parses complete UTF-8 lines at EOF but keeps a line cut off by the cap", (t) => {
	const options = fixture(t);
	const record = JSON.stringify({ pad: "é", cwd: options.cwd });
	const splitUtf8 = " ".repeat(4095 - Buffer.byteLength('{"pad":"')) + record;
	const capped = " ".repeat(64 * 1024 - Buffer.byteLength(record)) + record + "\n";
	const complete = writeSessionFile({ ...options, messages: history });
	const partial = writeSessionFile({ ...options, messages: history });
	writeFileSync(complete.jsonlPath, splitUtf8);
	writeFileSync(partial.jsonlPath, capped);
	for (const path of [complete.jsonlPath, partial.jsonlPath]) utimesSync(path, new Date(0), new Date(0));
	sweepStaleSessions(options.cwd, options.claudeDir, undefined, 1_800_000_000_000);
	assert.ok(!existsSync(complete.jsonlPath));
	assert.ok(existsSync(partial.jsonlPath));
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
