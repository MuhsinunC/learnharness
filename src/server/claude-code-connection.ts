import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { buildChildEnv } from "../agent/claude-code/child-env.ts";
import { claudeCodeRegistrationExecutable, piModels } from "../agent/models.ts";
import { applyClaudeCodeSettings, claudeCodeEnvOverride } from "./claude-code-boot.ts";
import {
	claudeExecutableProblem, claudeSettingsError, claudeSettingsGeneration, readClaudeCodeSettings, writeClaudeCodeSettings,
} from "./claude-code-settings.ts";
import { clearEndpointConfig, endpointFile, endpointStatus, isAllowedEndpointUrl, validToken, writeEndpointConfig } from "./claude-code-endpoint.ts";

const UNREADABLE_ENDPOINT = "claude-code endpoint: existing endpoint credentials could not be read; re-enter the token";

export type DiscoveryRoots = { pathEnv: string | undefined; home: string; fixedDirs: string[] };
function defaultRoots(): DiscoveryRoots {
	return {
		pathEnv: process.env.PATH, home: process.env.HOME ?? homedir(),
		fixedDirs: process.env.NODE_ENV === "test" && process.env.LH_CLAUDE_CODE_TEST_NO_FIXED_DIRS === "1"
			? [] : ["/opt/homebrew/bin", "/usr/local/bin"],
	};
}
export function discoverClaudeExecutables(roots = defaultRoots()): string[] {
	const { home } = roots;
	let versions: string[] = [];
	try { versions = readdirSync(join(home, ".nvm/versions/node")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch { /* no nvm */ }
	const paths = [
		readClaudeCodeSettings().executable,
		...(roots.pathEnv ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, "claude")),
		join(home, ".local/bin/claude"), join(home, ".claude/local/claude"),
		...roots.fixedDirs.map(dir => join(dir, "claude")),
		join(home, ".npm-global/bin/claude"), join(home, ".bun/bin/claude"),
		...versions.map(version => join(home, ".nvm/versions/node", version, "bin/claude")),
	];
	const seen = new Set<string>();
	return paths.filter((p): p is string => {
		if (!p || claudeExecutableProblem(p)) return false;
		try { const real = realpathSync(p); if (seen.has(real)) return false; seen.add(real); return true; } catch { return false; }
	});
}
let probeDeadlineMs = 10_000, probeKillGraceMs = 2_000;
export function setClaudeProbeTimeoutsForTests(deadlineMs: number, killGraceMs: number): void {
	if (process.env.NODE_ENV !== "test") throw new Error("test-only injection");
	probeDeadlineMs = deadlineMs;
	probeKillGraceMs = killGraceMs;
}
function run(executable: string, args: string[]): Promise<{ stdout: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			env: buildChildEnv(process.env, null, executable) as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "", bytes = 0, settled = false;
		let escalation: NodeJS.Timeout | undefined;
		const fail = () => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			child.kill("SIGTERM");
			escalation = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, probeKillGraceMs);
			escalation.unref();
			reject(new Error("probe failed"));
		};
		const deadline = setTimeout(fail, probeDeadlineMs);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 64 * 1024) fail();
			else stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) fail(); });
		child.on("error", fail);
		child.on("close", code => {
			clearTimeout(deadline);
			clearTimeout(escalation);
			if (settled) return;
			settled = true;
			resolve({ stdout, code });
		});
	});
}
export async function validateClaudeExecutable(executable: string): Promise<{ version: string | null; error: string | null }> {
	const problem = claudeExecutableProblem(executable);
	if (problem) return { version: null, error: problem };
	try {
		const { stdout, code } = await run(executable, ["--version"]);
		if (code === 0 && stdout.includes("Claude Code")) return { version: stdout.trim(), error: null };
	} catch { /* private failure */ }
	return { version: null, error: "executable failed validation" };
}
export async function readClaudeAuthStatus(executable: string) {
	try {
		const { stdout } = await run(executable, ["auth", "status", "--json"]);
		const value = JSON.parse(stdout);
		if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.loggedIn !== "boolean") throw new Error();
		const account = value.loggedIn === true && (typeof value.email === "string" || typeof value.subscriptionType === "string")
			? {
				...(typeof value.email === "string" ? { email: value.email } : {}),
				...(typeof value.subscriptionType === "string" ? { subscriptionType: value.subscriptionType } : {}),
			} : null;
		return { loggedIn: value.loggedIn === true, account, error: null };
	} catch { return { loggedIn: false, account: null, error: "unable to read login status" }; }
}
const mutationKey = Symbol.for("lh.claudeCodeMutations.v2");
const mutations = globalThis as typeof globalThis & { [mutationKey]?: { tail: Promise<unknown> } };
const mutation = mutations[mutationKey] ??= { tail: Promise.resolve() };
function serialize<T>(run: () => Promise<T>): Promise<T> {
	const result = mutation.tail.then(run, run);
	mutation.tail = result.catch(() => {});
	return result;
}
function platformRefusal(): Response | null {
	return process.platform === "win32"
		? json({ error: "Claude Code provider is not supported on Windows" }, 400) : null;
}
type Login = { state: "idle" | "pending" | "failed"; url: string | null; error: string | null };
type LoginSession = { child?: ChildProcess; login: Login; timer?: NodeJS.Timeout; finish?: () => void };
const loginKey = Symbol.for("lh.claudeCodeLogin");
const loginGlobal = globalThis as typeof globalThis & { [loginKey]?: { current: LoginSession; exitRegistered?: boolean } };
const loginState = loginGlobal[loginKey] ??= {
	current: { login: { state: "idle", url: null, error: null } } as LoginSession,
	exitRegistered: false,
};
if (!loginState.exitRegistered) {
	// Install once across HMR copies without capturing a particular child.
	loginState.exitRegistered = true;
	process.once("exit", () => loginState.current.child?.kill("SIGTERM"));
}
export function cancelClaudeLogin(): void {
	const old = loginState.current;
	loginState.current = { login: { state: "failed", url: null, error: "login cancelled" } };
	clearTimeout(old.timer); old.child?.kill("SIGTERM");
	old.login = { state: "failed", url: null, error: "login cancelled" };
	old.finish?.();
}
export function resetClaudeLoginForTests(): void {
	cancelClaudeLogin();
	loginState.current = { login: { state: "idle", url: null, error: null } };
}
async function startLogin(executable: string): Promise<Login> {
	cancelClaudeLogin();
	const session: LoginSession = { login: { state: "pending", url: null, error: null } };
	loginState.current = session;
	return new Promise(resolve => {
		let urlTimer: NodeJS.Timeout;
		const finish = () => {
			clearTimeout(urlTimer);
			resolve({ ...session.login });
		};
		session.finish = finish;
		const current = () => loginState.current === session;
		const fail = (error: string) => {
			if (!current()) return;
			invalidateStatusCache();
			session.login = { state: "failed", url: null, error };
			clearTimeout(session.timer); session.child?.kill("SIGTERM"); finish();
		};
		const child = session.child = spawn(executable, ["auth", "login", "--claudeai"], {
			detached: true, stdio: ["ignore", "pipe", "pipe"],
			env: {
				...buildChildEnv(process.env, null, executable),
				...Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]
					.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
			} as NodeJS.ProcessEnv,
		});
		let buffer = "";
		child.stdout!.on("data", chunk => {
			if (!current() || session.login.url) return;
			buffer = (buffer + chunk.toString()).slice(-65536);
			const match = buffer.match(/If the browser didn't open, visit: (https:\/\/[^\s]+)(?:\r?\n)/);
			if (match) { session.login.url = match[1]!; finish(); }
		});
		child.stderr!.on("data", () => {});
		child.on("error", () => fail("unable to start login"));
		child.on("exit", code => {
			if (!current() || session.login.state === "failed") return;
			clearTimeout(session.timer);
			invalidateStatusCache();
			session.child = undefined;
			session.login = code === 0 ? { state: "idle", url: null, error: null } : { state: "failed", url: null, error: "login exited before completion" };
			finish();
		});
		session.timer = setTimeout(() => fail("login timed out"), 10 * 60_000); session.timer.unref();
		urlTimer = setTimeout(() => fail("login did not provide a URL"), 15_000); urlTimer.unref();
	});
}
type Validation = { executable: string; version: string };
async function resolveExecutable(validation?: Validation) {
	const override = claudeCodeEnvOverride();
	const settings = readClaudeCodeSettings();
	if (override.rejected || process.platform === "win32") {
		return { executable: override.path ?? settings.executable, candidates: [], version: null,
			error: "Claude Code executable was rejected" };
	}
	const candidates = discoverClaudeExecutables();
	const preferred = override.path ?? settings.executable;
	for (const executable of [...new Set([preferred, ...candidates])]) {
		if (!executable) continue;
		const checked = validation?.executable === executable ? { version: validation.version, error: null }
			: await validateClaudeExecutable(executable);
		if (checked.version) return { executable, candidates, ...checked };
		if (override.enabled) return { executable, candidates, ...checked };
	}
	return { executable: null, candidates, version: null, error: "Claude Code not found" };
}
async function readSpawnStatus(validation?: Validation) {
	const resolved = await resolveExecutable(validation);
	const auth = resolved.version && resolved.executable ? await readClaudeAuthStatus(resolved.executable)
		: { loggedIn: false, account: null, error: null };
	const configured = claudeCodeRegistrationExecutable() ?? claudeCodeEnvOverride().path ?? readClaudeCodeSettings().executable;
	const discovered = resolved.executable !== configured ? resolved.executable : null;
	return {
		...resolved, executable: configured, discovered,
		hint: configured && discovered ? "Saved Claude Code path is missing; choose the discovered one" : null,
		found: !!configured && !claudeExecutableProblem(configured),
		loggedIn: auth.loggedIn, account: auth.account, error: resolved.error ?? auth.error,
	};
}
type SpawnStatus = Awaited<ReturnType<typeof readSpawnStatus>>;
const cacheKey = Symbol.for("lh.claudeCodeStatusCache.v3");
type StatusCache = {
	entry?: { expires: number; value: SpawnStatus };
	pending?: Promise<SpawnStatus>;
};
const cacheGlobal = globalThis as typeof globalThis & { [cacheKey]?: StatusCache };
const statusCache = cacheGlobal[cacheKey] ??= {};
function invalidateStatusCache(): void { statusCache.entry = undefined; statusCache.pending = undefined; }
export function invalidateClaudeStatusCacheForTests(): void { invalidateStatusCache(); }
async function getClaudeCodeStatus(validation?: Validation, retry = true): Promise<ReturnType<typeof statusResponse>> {
	const generation = claudeSettingsGeneration();
	let backed: SpawnStatus;
	if (statusCache.entry && statusCache.entry.expires > Date.now()) backed = statusCache.entry.value;
	else {
		const pending = statusCache.pending ??= readSpawnStatus(validation);
		try {
			backed = await pending;
			if (statusCache.pending === pending && !backed.error) {
				statusCache.entry = { expires: Date.now() + 5_000, value: backed };
			}
		} finally { if (statusCache.pending === pending) statusCache.pending = undefined; }
	}
	if (retry && generation !== claudeSettingsGeneration()) {
		invalidateStatusCache();
		return getClaudeCodeStatus(undefined, false);
	}
	return statusResponse(backed);
}
function statusResponse(backed: SpawnStatus) {
	const override = claudeCodeEnvOverride();
	const settings = readClaudeCodeSettings();
	return {
		mode: override.enabled ? "local" : settings.mode, envOverride: override.enabled,
		active: piModels().getProvider("claude-code") !== undefined,
		...backed, error: claudeSettingsError() ?? backed.error, login: { ...loginState.current.login }, endpoint: endpointStatus(),
	};
}
function refuseCrossOrigin(request: Request): Response | null {
	const origin = request.headers.get("origin");
	let mismatch = false;
	if (origin !== null) {
		try { mismatch = new URL(origin).host !== request.headers.get("host"); }
		catch { mismatch = true; }
	}
	return mismatch || request.headers.get("sec-fetch-site") === "cross-site"
		? json({ error: "cross-origin request refused" }, 403) : null;
}
/** Status keeps the configured/registered executable separate from discovered fallback and hint.
 * Version and auth fields describe discovered when present, otherwise executable. */
export async function getClaudeCodeConnection(request: Request): Promise<Response> {
	const refusal = refuseCrossOrigin(request);
	if (refusal) return refusal;
	return json(await getClaudeCodeStatus());
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const isJson = (request: Request) => request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
async function putClaudeCodeConnectionLocked(body: { mode: "off" | "local" | "endpoint"; executable?: string; baseUrl?: unknown; token?: unknown }): Promise<Response> {
	const saved = readClaudeCodeSettings();
	let executable = saved.executable;
	let validation: { executable: string; version: string } | undefined;
	if (body.mode !== "off") {
		const resolved = body.executable === undefined ? await resolveExecutable() : null;
		executable = body.executable ?? resolved?.executable ?? null;
		if (!executable) return json({ error: "Claude Code not found" }, 400);
		const result = resolved ?? await validateClaudeExecutable(executable);
		if (result.error) return json({ error: result.error }, 400);
		validation = { executable, version: result.version! };
	}
	let endpointWrite: { baseUrl: string; token?: string } | undefined;
	if (body.mode === "endpoint") {
		const stored = endpointStatus();
		const baseUrl = body.baseUrl === undefined ? stored.baseUrl : body.baseUrl;
		if (typeof baseUrl !== "string" || !isAllowedEndpointUrl(baseUrl)) {
			return json({ error: "invalid endpoint URL" }, 400);
		}
		const token = body.token;
		if (token !== undefined && !validToken(token)) {
			return json({ error: "invalid endpoint token" }, 400);
		}
		if (token === undefined && !stored.tokenSet) {
			return json({ error: existsSync(endpointFile()) ? UNREADABLE_ENDPOINT : "endpoint token required" }, 400);
		}
		endpointWrite = { baseUrl, ...(token !== undefined ? { token } : {}) };
	}
	try { writeClaudeCodeSettings({ mode: body.mode, executable }); }
	catch { return json({ error: "unable to save connection settings" }, 500); }
	if (endpointWrite) {
		try { writeEndpointConfig(endpointWrite); }
		catch (error) {
			writeClaudeCodeSettings(saved);
			invalidateStatusCache();
			// The endpoint module's validation errors are fixed texts without secrets.
			const message = error instanceof Error ? error.message : "";
			if (message === UNREADABLE_ENDPOINT || message.startsWith("claude-code endpoint: invalid ")) return json({ error: message }, 400);
			return json({ error: "unable to save endpoint configuration" }, 500);
		}
	}
	applyClaudeCodeSettings();
	invalidateStatusCache();
	return mutationSuccess(await getClaudeCodeStatus(validation));
}
async function postClaudeCodeLoginLocked(request: Request): Promise<Response> {
	const refusal = refuseCrossOrigin(request);
	if (refusal) return refusal;
	const platformError = platformRefusal();
	if (platformError) return platformError;
	if (!isJson(request)) return json({ error: "application/json required" }, 415);
	const { executable, version } = await resolveExecutable();
	if (!executable || !version) return json({ error: "Claude Code not found" }, 400);
	const login = await startLogin(executable);
	return login.state === "idle" ? json({ login: { state: "idle" } }) : json({ login }, login.state === "pending" ? 200 : 502);
}

async function deleteClaudeCodeEndpointLocked(request: Request): Promise<Response> {
	const refusal = refuseCrossOrigin(request);
	if (refusal) return refusal;
	try { clearEndpointConfig(); }
	catch { return json({ error: "unable to clear endpoint configuration" }, 500); }
	invalidateStatusCache();
	const settings = readClaudeCodeSettings();
	if (settings.mode === "endpoint" && !claudeCodeEnvOverride().enabled) {
		const status = await getClaudeCodeStatus();
		try { writeClaudeCodeSettings({ mode: status.loggedIn ? "local" : "off", executable: status.discovered ?? status.executable }); }
		catch { return json({ error: "unable to save connection settings" }, 500); }
		applyClaudeCodeSettings();
		invalidateStatusCache();
	}
	return mutationSuccess(await getClaudeCodeStatus());
}

function mutationSuccess(status: ReturnType<typeof statusResponse>): Response {
	const { error, ...rest } = status;
	return json({ ok: true, ...rest, error: null, ...(error ? { probeError: error } : {}) });
}
/** Commit settings with ok:true/error:null, optional probeError, and the GET executable/discovered/hint fields. */
export async function putClaudeCodeConnection(request: Request): Promise<Response> {
	const refusal = refuseCrossOrigin(request);
	if (refusal) return refusal;
	const platformError = platformRefusal();
	if (platformError) return platformError;
	if (claudeCodeEnvOverride().enabled) return json({ error: "connection controlled by launch environment" }, 409);
	if (!isJson(request)) return json({ error: "application/json required" }, 415);
	let body;
	try {
		const reader = request.body?.getReader();
		let bytes = 0;
		const chunks: Uint8Array[] = [];
		if (reader) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					bytes += value.length;
					if (bytes > 64 * 1024) {
						void reader.cancel().catch(() => {});
						return json({ error: "request body too large" }, 413);
					}
					chunks.push(value);
				}
			} finally { reader.releaseLock(); }
		}
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch { return json({ error: "invalid JSON object" }, 400); }
	if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid JSON object" }, 400);
	if (!["off", "local", "endpoint"].includes(body.mode)) return json({ error: "invalid mode" }, 400);
	if (Object.hasOwn(body, "executable") &&
		(typeof body.executable !== "string" || !body.executable || !isAbsolute(body.executable))) {
		return json({ error: "executable must be an absolute path" }, 400);
	}
	return serialize(() => putClaudeCodeConnectionLocked(body));
}

export function postClaudeCodeLogin(request: Request): Promise<Response> {
	return serialize(() => postClaudeCodeLoginLocked(request));
}

/** Clear credentials with ok:true/error:null, optional probeError, and the GET executable/discovered/hint fields. */
export function deleteClaudeCodeEndpoint(request: Request): Promise<Response> {
	return serialize(() => deleteClaudeCodeEndpointLocked(request));
}
