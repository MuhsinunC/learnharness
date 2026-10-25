import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { buildChildEnv, CHILD_ENV_ALLOWLIST, CC_CHILD_ENV } from "../src/agent/claude-code/child-env.ts";
import { buildQueryOptions } from "../src/agent/claude-code/query-options.ts";

const root = fs.mkdtempSync(join(tmpdir(), "lh-endpoint-"));
const dir = join(root, "credentials");
process.env.LH_AUTH_FILE = join(dir, "auth.json");
const { endpointFile, isAllowedEndpointUrl, readEndpointConfig, writeEndpointConfig, clearEndpointConfig, endpointStatus } = await import("../src/server/claude-code-endpoint.ts");
const SENTINEL = "lh27-SENTINEL-token-do-not-leak";
const B1 = "https://relay.example/v1", B2 = "http://localhost:9000/x";
const required = { executable: "/example/bin/claude", cwd: "/workspace", cliModel: "test-model", appendPrompt: "system" };
after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir); });

function noSentinel(value: unknown): void { assert.ok(!JSON.stringify(value).includes(SENTINEL)); }

test("R1: credentials reach only the explicit child env, never keys, errors or logs", async t => {
	const logs: unknown[][] = [];
	for (const method of ["log", "info", "warn", "error", "debug"] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
	writeEndpointConfig({ baseUrl: B1, token: SENTINEL });
	fs.writeFileSync(process.env.LH_AUTH_FILE!, JSON.stringify({ LH_ENDPOINT_TEST_UNRELATED: "unrelated" }));
	const { initAuthEnv, keyStatuses } = await import("../src/server/keys.ts");
	try {
		initAuthEnv();
		for (const value of [process.env, fs.readFileSync(process.env.LH_AUTH_FILE!, "utf8"), keyStatuses(), endpointStatus()]) noSentinel(value);
		for (const cfg of [{ baseUrl: "ftp://relay.example", token: SENTINEL }, { baseUrl: B1, token: SENTINEL + "\x00" }]) {
			assert.throws(() => writeEndpointConfig(cfg), error => { noSentinel((error as Error).message); return true; });
		}
		const endpoint = readEndpointConfig()!;
		const env = buildChildEnv(process.env, endpoint);
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, SENTINEL);
		const { ANTHROPIC_AUTH_TOKEN: token, ...rest } = env;
		assert.equal(token, SENTINEL); noSentinel(rest);
		const { env: optionsEnv, ...options } = buildQueryOptions({ ...required, endpoint });
		assert.deepEqual(optionsEnv, env); noSentinel(options);
		// Replace the fixed credential directory with a regular file: reliable even as root.
		fs.rmSync(dir, { recursive: true }); fs.writeFileSync(dir, "blocked");
		assert.throws(() => writeEndpointConfig({ baseUrl: B1, token: SENTINEL }), { message: "claude-code endpoint: could not save (EEXIST)" });
		assert.throws(() => clearEndpointConfig(), { message: "claude-code endpoint: could not save (ENOTDIR)" });
		assert.equal(readEndpointConfig(), null);
		assert.deepEqual(endpointStatus(), { baseUrl: null, tokenSet: false });
		noSentinel(logs);
	} finally { delete process.env.LH_ENDPOINT_TEST_UNRELATED; }
});

test("R2: missing, corrupt, invalid and unreadable files fail closed; writes are atomic and 0600", t => {
	const logs: unknown[][] = [];
	for (const method of ["log", "info", "warn", "error", "debug"] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
	assert.equal(endpointFile(), join(dir, "claude-endpoint.json"));
	assert.equal(readEndpointConfig(), null);
	assert.deepEqual(endpointStatus(), { baseUrl: null, tokenSet: false });
	for (const raw of [`{"baseUrl":"${B1}","token":"${SENTINEL}"`, `not json ${SENTINEL}`, "null", "[]", '"text"', JSON.stringify({ baseUrl: "ftp://relay.example", token: SENTINEL }), JSON.stringify({ baseUrl: B1, token: "inner space" })]) {
		fs.writeFileSync(endpointFile(), raw);
		assert.equal(readEndpointConfig(), null);
		assert.deepEqual(endpointStatus(), { baseUrl: null, tokenSet: raw.includes("ftp://") });
		if (!raw.includes("ftp://")) {
			assert.throws(() => writeEndpointConfig({ baseUrl: B2 }), { message: "claude-code endpoint: existing endpoint credentials could not be read; re-enter the token" });
			assert.equal(fs.readFileSync(endpointFile(), "utf8"), raw);
		}
		writeEndpointConfig({ baseUrl: B2, token: SENTINEL });
		assert.deepEqual(readEndpointConfig(), { baseUrl: B2, token: SENTINEL });
	}
	fs.rmSync(endpointFile()); fs.mkdirSync(endpointFile());
	assert.equal(readEndpointConfig(), null); assert.deepEqual(endpointStatus(), { baseUrl: null, tokenSet: false });
	assert.throws(() => writeEndpointConfig({ baseUrl: B2 }), { message: "claude-code endpoint: existing endpoint credentials could not be read; re-enter the token" });
	assert.equal(fs.statSync(endpointFile()).isDirectory(), true);
	assert.deepEqual(fs.readdirSync(endpointFile()), []);
	fs.rmSync(endpointFile(), { recursive: true });
	writeEndpointConfig({ baseUrl: B1, token: SENTINEL });
	fs.chmodSync(endpointFile(), 0o644);
	const tmp = join(dir, `.claude-endpoint.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, "stale", { mode: 0o644 });
	writeEndpointConfig({ baseUrl: B1 });
	assert.equal(fs.statSync(endpointFile()).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith(".claude-endpoint.json.tmp-")), []);
	noSentinel(logs);
});

test("R3: omitted token preserves valid credentials or saves URL only; invalid tokens leave bytes unchanged", () => {
	writeEndpointConfig({ baseUrl: B1, token: SENTINEL });
	writeEndpointConfig({ baseUrl: B2 });
	assert.deepEqual(readEndpointConfig(), { baseUrl: B2, token: SENTINEL });
	const bytes = fs.readFileSync(endpointFile());
	for (const token of ["", " leading", "trailing ", "control\x7f", "control\n", "emoji😀", "inner space", 42, null]) {
		assert.throws(() => writeEndpointConfig({ baseUrl: B1, token: token as string }), { message: "claude-code endpoint: invalid token" });
		assert.deepEqual(fs.readFileSync(endpointFile()), bytes);
	}
	clearEndpointConfig(); clearEndpointConfig(); assert.equal(fs.existsSync(endpointFile()), false);
	writeEndpointConfig({ baseUrl: B2 });
	assert.equal(readEndpointConfig(), null);
	assert.deepEqual(endpointStatus(), { baseUrl: B2, tokenSet: false });
	assert.deepEqual(JSON.parse(fs.readFileSync(endpointFile(), "utf8")), { baseUrl: B2 });
});

test("R4: URL validation rejects unsafe destinations without touching stored bytes", () => {
	writeEndpointConfig({ baseUrl: B1, token: SENTINEL });
	const bytes = fs.readFileSync(endpointFile());
	for (const baseUrl of ["ftp://relay.example", "http://example.com", "javascript:alert(1)", "", "   ", "http://localhost.evil.example", "http://127.0.0.1.nip.io", "https://user:pass@relay.example", "file:///etc/passwd", "not a url", "data:text/plain,test", "https://relay.example/#x", "https://relay.example/?a=1", "https://relay.example/?", "https://relay.example/#"]) {
		assert.equal(isAllowedEndpointUrl(baseUrl), false);
		assert.throws(() => writeEndpointConfig({ baseUrl, token: SENTINEL }), { message: "claude-code endpoint: invalid base URL" });
		assert.deepEqual(fs.readFileSync(endpointFile()), bytes);
	}
	for (const baseUrl of [B1, "http://127.0.0.1:9000", B2]) {
		assert.equal(isAllowedEndpointUrl(baseUrl), true);
		writeEndpointConfig({ baseUrl });
		assert.deepEqual(readEndpointConfig(), { baseUrl, token: SENTINEL });
	}
});

test("R5: endpoint overrides poisoned transport vars and adds exactly two child-only keys", () => {
	const allowed = Object.fromEntries(CHILD_ENV_ALLOWLIST.map(key => [key, `/example/${key}`]));
	const source = { NODE_ENV: "test" as const, ...allowed, ...Object.fromEntries(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "OPENROUTER_API_KEY", "LH_CLAUDE_CODE_EXECUTABLE"].map(key => [key, "poison"])) };
	const endpoint = { baseUrl: B1, token: SENTINEL };
	assert.deepEqual(buildChildEnv(source, endpoint), { ...allowed, ...CC_CHILD_ENV, ANTHROPIC_BASE_URL: B1, ANTHROPIC_AUTH_TOKEN: SENTINEL });
	for (const endpoint of [undefined, null]) {
		assert.deepEqual(buildChildEnv(process.env, endpoint), buildChildEnv());
		assert.equal(JSON.stringify(buildChildEnv(process.env, endpoint)), JSON.stringify(buildChildEnv()));
		assert.deepEqual(buildChildEnv(source, endpoint), { ...allowed, ...CC_CHILD_ENV });
		assert.deepEqual(buildQueryOptions({ ...required, endpoint }), buildQueryOptions(required));
	}
});


test("R4: URL normalization preserves input spelling apart from whitespace and one slash", () => {
	for (const input of ["https://relay.example ", "https://relay.example/", " https://Relay.example/Path/ "]) {
		writeEndpointConfig({ baseUrl: input, token: SENTINEL });
		const expected = input.trim().replace(/\/$/, "");
		assert.equal(JSON.parse(fs.readFileSync(endpointFile(), "utf8")).baseUrl, expected);
		assert.equal(readEndpointConfig()?.baseUrl, expected);
		fs.writeFileSync(endpointFile(), JSON.stringify({ baseUrl: input, token: SENTINEL }));
		assert.equal(readEndpointConfig()?.baseUrl, expected);
		assert.equal(endpointStatus().baseUrl, expected);
	}
	for (const input of ["https://relay.example/?", "https://relay.example/#"]) {
		fs.writeFileSync(endpointFile(), JSON.stringify({ baseUrl: input, token: SENTINEL }));
		assert.equal(readEndpointConfig(), null);
		assert.equal(endpointStatus().baseUrl, null);
	}
});
