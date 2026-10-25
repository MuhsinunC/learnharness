import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
import { bootClaudeCodeProvider, resetClaudeCodeBootForTests } from "../src/server/claude-code-boot.ts";
import { piModels, resetClaudeCodeProviderForTests } from "../src/agent/models.ts";
import { providerKeyPresent } from "../src/server/keys.ts";

const root = path.resolve(import.meta.dirname, "..");
const loader = path.join(root, "node_modules/tsx/dist/loader.mjs");
const variable = "LH_CLAUDE_CODE_EXECUTABLE";
// The subprocess scenarios use a /bin/sh stub and POSIX exec bits.
const posixOnly = { skip: process.platform === "win32" && "POSIX executable checks" };

function scenario(kind: string, entry: "catalog" | "chat" = "catalog") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cc-catalog-"));
	try {
		const stub = path.join(dir, "claude");
		fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(stub, ["non-executable", "reject-repeat"].includes(kind) ? 0o644 : 0o755);
		const env = { ...process.env };
		for (const key of [variable, "LH_IGNORE_ENV_KEYS", "LH_AUTH_FILE"]) delete env[key];
		env.HOME = dir;
		env.LH_DATA_DIR = path.join(dir, "data");
		if (kind === "fill-gap") {
			fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ [variable]: stub }));
			env.LH_AUTH_FILE = path.join(dir, "auth.json");
		} else {
			// Isolate from the checkout's auth.json even when no file exists.
			env.LH_AUTH_FILE = path.join(dir, "absent-auth.json");
			if (!["unset", "late"].includes(kind)) env[variable] = stub;
		}
		if (kind === "ignore") env.LH_IGNORE_ENV_KEYS = "1";
		if (kind === "relative") env[variable] = "./claude";
		if (kind === "directory") env[variable] = dir;
		if (kind === "missing") env[variable] = path.join(dir, "missing");
		if (kind === "empty") env[variable] = "";
		const out = execFileSync(process.execPath, ["--import", loader, "--input-type=module", "--eval", `
			const { registerHooks } = await import("node:module");
			registerHooks({ resolve(specifier, context, nextResolve) {
				if (specifier.includes("@anthropic-ai/claude-agent-sdk")) throw new Error("SDK must stay unloaded");
				return nextResolve(specifier, context);
			} });
			const warnings = [];
			console.warn = (...args) => warnings.push(args.join(" "));
			if (${JSON.stringify(entry)} === "chat") {
				await import(${JSON.stringify(path.join(root, "src/server/chat-handler.ts"))});
				const { piModels, piEngineForSpec } = await import(${JSON.stringify(path.join(root, "src/agent/models.ts"))});
				const providerPresent = piModels().getProvider("claude-code") !== undefined;
				const engine = providerPresent ? piEngineForSpec({ provider: "claude-code", id: "claude-opus-5-5" }) : undefined;
				console.log(JSON.stringify({ providerPresent, engineModel: engine?.model.id ?? null, warnings }));
			} else {
				const m = await import(${JSON.stringify(path.join(root, "src/server/model-catalog.ts"))});
				const model = { provider: "claude-code", id: "claude-opus-5-5" };
				const snapshot = () => ({
					catalog: m.modelCatalog(), providers: m.catalogProviders(),
					ids: m.modelCatalog().models.filter(x => x.provider === "claude-code").map(x => x.provider + ":" + x.id),
					limit: m.catalogContextLimits().get("claude-code:claude-opus-5-5") ?? null,
					chat: m.validateChatSettings({ model }),
					strong: m.validateModelsSettings({ strong: { model } }),
				});
				const first = snapshot();
				const keys = await import(${JSON.stringify(path.join(root, "src/server/keys.ts"))});
				if (!["accepted", "restore"].includes(${JSON.stringify(kind)})) {
					const { default: assert } = await import("node:assert/strict");
					const { piModels } = await import(${JSON.stringify(path.join(root, "src/agent/models.ts"))});
					const { builtinProviders } = await import(${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/all"))});
					const { AUTH_PROVIDER_KEYS } = await import(${JSON.stringify(path.join(root, "src/core/auth-keys.ts"))});
					assert.deepEqual(piModels().getProviders().map(p => p.id), builtinProviders().map(p => p.id));
					const { isSubscriptionProvider } = await import(${JSON.stringify(path.join(root, "src/agent/subscription-connections.ts"))});
					assert.deepEqual(m.catalogProviders().filter(p => !isSubscriptionProvider(p.id)), AUTH_PROVIDER_KEYS.map(p => ({
						id: p.id, envVar: p.envVar, keyPresent: keys.keyValue(p.envVar) !== undefined,
					})).sort((a, b) => a.id.localeCompare(b.id)));
					assert.ok(m.catalogProviders().every(p => !("keyless" in p)));
					assert.ok(m.modelCatalog().models.every(m => m.provider !== "claude-code"));
					assert.ok([...m.catalogContextLimits().keys()].every(key => !key.startsWith("claude-code:")));
				}
				if (${JSON.stringify(kind)} === "restore" || ${JSON.stringify(kind)} === "late" || ${JSON.stringify(kind)} === "reject-repeat") {
					const a = await import(${JSON.stringify(path.join(root, "src/agent/models.ts"))});
					const b = await import(${JSON.stringify(path.join(root, "src/server/claude-code-boot.ts"))});
					a.resetClaudeCodeProviderForTests();
					process.env.LH_CLAUDE_CODE_EXECUTABLE = ${JSON.stringify(stub)};
					b.bootClaudeCodeProvider();
					b.bootClaudeCodeProvider();
				}
				console.log(JSON.stringify({ first, final: snapshot(), warnings,
					keyPresent: keys.providerKeyPresent("claude-code"), fillGapped: keys.isFillGapped("LH_CLAUDE_CODE_EXECUTABLE") }));
			}
		`], { cwd: dir, env, encoding: "utf8", timeout: 30_000 });
		return { ...JSON.parse(out), stub };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

it("unset and empty preserve the baseline catalog and validators", () => {
	const baseline = scenario("unset");
	for (const kind of ["unset", "empty"]) {
		const result = scenario(kind);
		assert.deepEqual(result.first, baseline.first);
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(result.first.ids, []);
	}
});

for (const [kind, reason] of [
	["fill-gap", "set only via auth.json"], ["ignore", "LH_IGNORE_ENV_KEYS=1"],
	["relative", "not an absolute path"], ["non-executable", "not executable"],
	["directory", "not a file"], ["missing", "not a file"],
] as const) {
	it(`rejects ${kind} with one private reason line`, kind === "ignore" ? {} : posixOnly, () => {
		const result = scenario(kind);
		assert.deepEqual(result.first, scenario("unset").first);
		assert.deepEqual(result.warnings, [`claude-code: LH_CLAUDE_CODE_EXECUTABLE ignored (${reason})`]);
		assert.ok(!result.warnings[0].includes(result.stub));
		assert.equal(result.fillGapped, kind === "fill-gap");
		assert.equal(result.keyPresent, false);
	});
}

it("production import enables the catalog and accepted decisions re-register", posixOnly, () => {
	for (const kind of ["accepted", "restore"]) {
		const result = scenario(kind);
		const row = { id: "claude-code", envVar: variable, keyPresent: true, keyless: true };
		assert.deepEqual(result.first.providers.find((p: { id: string }) => p.id === "claude-code"), row);
		const ids = result.first.providers.map((p: { id: string }) => p.id);
		assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
		assert.ok(result.first.ids.includes("claude-code:claude-opus-5-5"));
		assert.equal(result.first.limit, 1_000_000);
		assert.deepEqual(result.first.strong, { ok: true });
		assert.deepEqual(result.first.chat, { ok: true });
		assert.equal(result.keyPresent, true);
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(result.final, result.first);
	}
});

it("an unset boot decision stays disabled after an env change", () => {
	const result = scenario("late");
	assert.deepEqual(result.final, result.first);
	assert.deepEqual(result.first.ids, []);
	assert.deepEqual(result.warnings, []);
});

it("a rejected decision logs once across repeated boots", posixOnly, () => {
	const result = scenario("reject-repeat");
	assert.deepEqual(result.first.ids, []);
	assert.deepEqual(result.final, result.first);
	assert.deepEqual(result.warnings, ["claude-code: LH_CLAUDE_CODE_EXECUTABLE ignored (not executable)"]);
});

it("chat-handler import boots the provider and engine only with the executable env", posixOnly, () => {
	const accepted = scenario("accepted", "chat");
	assert.equal(accepted.providerPresent, true);
	assert.equal(accepted.engineModel, "claude-opus-5-5");
	assert.deepEqual(accepted.warnings, []);
	const unset = scenario("unset", "chat");
	assert.equal(unset.providerPresent, false);
	assert.equal(unset.engineModel, null);
	assert.deepEqual(unset.warnings, []);
});

function bootWith(env: Record<string, string>, platform: NodeJS.Platform) {
	const warnings: string[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
	resetClaudeCodeBootForTests();
	resetClaudeCodeProviderForTests();
	try {
		bootClaudeCodeProvider(env as NodeJS.ProcessEnv, platform);
		return { warnings, registered: piModels().getProvider("claude-code") !== undefined, keyPresent: providerKeyPresent("claude-code") };
	} finally {
		console.warn = warn;
		resetClaudeCodeBootForTests();
		resetClaudeCodeProviderForTests();
	}
}

it("only darwin and linux are allowed; other platforms refuse before any path check", () => {
	const secret = "/nonexistent/secret-claude-path";
	for (const [platform, reason] of [
		["win32", "Windows is not supported"], ["freebsd", "unsupported platform freebsd"], ["aix", "unsupported platform aix"],
	] as const) {
		const result = bootWith({ [variable]: secret }, platform);
		assert.deepEqual(result.warnings, [`claude-code: LH_CLAUDE_CODE_EXECUTABLE ignored (${reason})`]);
		assert.ok(!result.warnings[0]!.includes(secret));
		assert.equal(result.registered, false);
		assert.equal(result.keyPresent, false);
	}
});

it("darwin and linux accept an executable", posixOnly, () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cc-platform-"));
	try {
		const stub = path.join(dir, "claude");
		fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(stub, 0o755);
		for (const platform of ["darwin", "linux"] as const) {
			assert.deepEqual(bootWith({ [variable]: stub }, platform), { warnings: [], registered: true, keyPresent: true });
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

it("LH_IGNORE_ENV_KEYS is read from the env passed to the boot gate", () => {
	assert.equal(process.env.LH_IGNORE_ENV_KEYS, undefined);
	const result = bootWith({ [variable]: "/nonexistent/claude", LH_IGNORE_ENV_KEYS: "1" }, "linux");
	assert.deepEqual(result.warnings, ["claude-code: LH_CLAUDE_CODE_EXECUTABLE ignored (LH_IGNORE_ENV_KEYS=1)"]);
	assert.equal(result.registered, false);
});
