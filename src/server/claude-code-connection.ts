import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { buildChildEnv } from "../agent/claude-code/child-env.ts";
import { piModels } from "../agent/models.ts";
import { applyClaudeCodeSettings, claudeCodeEnvOverride } from "./claude-code-boot.ts";

type Settings = { mode: "off" | "local"; executable: string | null };
const settingsFile = join(PATHS.data, "claude-code.json");
const warningKey = Symbol.for("lh.claudeCodeSettingsWarning");
const warnings = globalThis as Record<symbol, boolean | undefined>;
export function readClaudeCodeSettings(): Settings {
	try {
		const value = JSON.parse(readFileSync(settingsFile, "utf8"));
		if (!value || !["off", "local"].includes(value.mode) || !(value.executable === null || typeof value.executable === "string")) throw new Error();
		return { mode: value.mode, executable: value.executable };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !warnings[warningKey]) {
			warnings[warningKey] = true;
			console.warn("claude-code: invalid connection settings ignored");
		}
		return { mode: "off", executable: null };
	}
}
function writeSettings(settings: Settings): void {
	mkdirSync(PATHS.data, { recursive: true });
	const temporary = `${settingsFile}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(settings));
		renameSync(temporary, settingsFile);
	} finally { rmSync(temporary, { force: true }); }
}
export function claudeExecutableProblem(executable: string): string | null {
	if (!isAbsolute(executable)) return "not an absolute path";
	try { if (!statSync(executable).isFile()) return "not a file"; } catch { return "not a file"; }
	try { accessSync(executable, constants.X_OK); } catch { return "not executable"; }
	return null;
}
export type DiscoveryRoots = { pathEnv: string | undefined; home: string; fixedDirs: string[] };
function defaultRoots(): DiscoveryRoots {
	return { pathEnv: process.env.PATH, home: process.env.HOME ?? homedir(), fixedDirs: process.env.NODE_ENV === "test" && process.env.LH_CLAUDE_CODE_TEST_NO_FIXED_DIRS === "1" ? [] : ["/opt/homebrew/bin", "/usr/local/bin"] };
}
export function discoverClaudeExecutables(roots = defaultRoots()): string[] {
	const { home } = roots;
	let versions: string[] = [];
	try { versions = readdirSync(join(home, ".nvm/versions/node")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch { /* no nvm */ }
	const paths = [readClaudeCodeSettings().executable, ...(roots.pathEnv ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, "claude")), join(home, ".local/bin/claude"), join(home, ".claude/local/claude"), ...roots.fixedDirs.map(dir => join(dir, "claude")), join(home, ".npm-global/bin/claude"), join(home, ".bun/bin/claude"), ...versions.map(version => join(home, ".nvm/versions/node", version, "bin/claude"))];
	const seen = new Set<string>();
	return paths.filter((p): p is string => {
		if (!p || claudeExecutableProblem(p)) return false;
		try { const real = realpathSync(p); if (seen.has(real)) return false; seen.add(real); return true; } catch { return false; }
	});
}
function run(executable: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(executable, args, { env: buildChildEnv(process.env, null, executable) as NodeJS.ProcessEnv, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => error ? reject(new Error("command failed")) : resolve(stdout));
		child.stdin?.end();
	});
}
export async function validateClaudeExecutable(executable: string): Promise<{ version: string | null; error: string | null }> {
	const problem = claudeExecutableProblem(executable);
	if (problem) return { version: null, error: problem };
	try {
		const stdout = await run(executable, ["--version"]);
		if (stdout.includes("Claude Code")) return { version: stdout.trim(), error: null };
	} catch { /* private failure */ }
	return { version: null, error: "executable failed validation" };
}
export async function readClaudeAuthStatus(executable: string) {
	try {
		const value = JSON.parse(await run(executable, ["auth", "status"]));
		const account = value.loggedIn === true ? { ...(typeof value.email === "string" ? { email: value.email } : {}), ...(typeof value.subscriptionType === "string" ? { subscriptionType: value.subscriptionType } : {}) } : null;
		return { loggedIn: value.loggedIn === true, account, error: null };
	} catch { return { loggedIn: false, account: null, error: "unable to read login status" }; }
}
type Login = { state: "idle" | "pending" | "failed"; url: string | null; error: string | null };
type LoginSession = { child?: ChildProcess; login: Login; timer?: NodeJS.Timeout; finish?: () => void };
const loginKey = Symbol.for("lh.claudeCodeLogin");
const loginGlobal = globalThis as typeof globalThis & { [loginKey]?: { current: LoginSession; exitRegistered?: boolean } };
const loginState: { current: LoginSession; exitRegistered?: boolean } = loginGlobal[loginKey] ??= { current: { login: { state: "idle", url: null, error: null } } };
if (!loginState.exitRegistered) {
	// Install once across HMR copies without capturing a particular child.
	loginState.exitRegistered = true;
	process.once("exit", () => loginState.current.child?.kill("SIGTERM"));
}
export function cancelClaudeLoginForTests(): void {
	const old = loginState.current;
	loginState.current = { login: { state: "idle", url: null, error: null } };
	clearTimeout(old.timer); old.child?.kill("SIGTERM");
	old.login = { state: "failed", url: null, error: "login cancelled" };
	old.finish?.();
}
async function startLogin(executable: string): Promise<Login> {
	cancelClaudeLoginForTests();
	const session: LoginSession = { login: { state: "pending", url: null, error: null } };
	loginState.current = session;
	return new Promise(resolve => {
		let urlTimer: NodeJS.Timeout;
		const finish = () => {
			clearTimeout(urlTimer);
			resolve(session.login.state === "idle" ? { state: "failed", url: null, error: "login exited before providing a URL" } : { ...session.login });
		};
		session.finish = finish;
		const current = () => loginState.current === session;
		const fail = (error: string) => {
			if (!current()) return;
			session.login = { state: "failed", url: null, error };
			clearTimeout(session.timer); session.child?.kill("SIGTERM"); finish();
		};
		const child = session.child = spawn(executable, ["auth", "login", "--claudeai"], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: buildChildEnv(process.env, null, executable) as NodeJS.ProcessEnv });
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
			session.login = code === 0 ? { state: "idle", url: null, error: null } : { state: "failed", url: null, error: "login exited before completion" };
			finish();
		});
		session.timer = setTimeout(() => fail("login timed out"), 10 * 60_000); session.timer.unref();
		urlTimer = setTimeout(() => fail("login did not provide a URL"), 15_000); urlTimer.unref();
	});
}
function resolveExecutable() {
	const override = claudeCodeEnvOverride();
	const settings = readClaudeCodeSettings();
	const candidates = discoverClaudeExecutables();
	return { override, settings, candidates, executable: override.path ?? settings.executable ?? candidates[0] ?? null };
}
export async function getClaudeCodeStatus() {
	const { override, settings, candidates, executable } = resolveExecutable();
	const validated = executable ? await validateClaudeExecutable(executable) : { version: null, error: "Claude Code not found" };
	const auth = validated.version && executable ? await readClaudeAuthStatus(executable) : { loggedIn: false, account: null, error: null };
	return { mode: override.enabled ? "local" : settings.mode, envOverride: override.enabled, active: piModels().getProvider("claude-code") !== undefined, executable, found: !!executable && !claudeExecutableProblem(executable), candidates, version: validated.version, loggedIn: auth.loggedIn, account: auth.account, login: { ...loginState.current.login }, endpoint: { baseUrl: null, tokenSet: false }, error: validated.error ?? auth.error };
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const isJson = (request: Request) => request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
export async function putClaudeCodeConnection(request: Request): Promise<Response> {
	if (claudeCodeEnvOverride().enabled) return json({ error: "connection controlled by launch environment" }, 409);
	if (!isJson(request)) return json({ error: "application/json required" }, 415);
	let body;
	try { body = await request.json(); } catch { return json({ error: "invalid JSON object" }, 400); }
	if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid JSON object" }, 400);
	if (!["off", "local", "endpoint"].includes(body.mode)) return json({ error: "invalid mode" }, 400);
	if (body.mode === "endpoint") return json({ error: "endpoint mode not available yet" }, 400);
	if (Object.hasOwn(body, "executable") && (typeof body.executable !== "string" || !body.executable || !isAbsolute(body.executable))) return json({ error: "executable must be an absolute path" }, 400);
	const saved = readClaudeCodeSettings();
	let executable = saved.executable;
	if (body.mode === "local") {
		executable = body.executable ?? saved.executable ?? discoverClaudeExecutables()[0];
		if (!executable) return json({ error: "Claude Code not found" }, 400);
		const result = await validateClaudeExecutable(executable);
		if (result.error) return json({ error: result.error }, 400);
	}
	try { writeSettings({ mode: body.mode, executable }); }
	catch { return json({ error: "unable to save connection settings" }, 500); }
	applyClaudeCodeSettings();
	return json(await getClaudeCodeStatus());
}
export async function postClaudeCodeLogin(request: Request): Promise<Response> {
	if (!isJson(request)) return json({ error: "application/json required" }, 415);
	const { executable } = resolveExecutable();
	if (!executable) return json({ error: "Claude Code not found" }, 400);
	const validated = await validateClaudeExecutable(executable);
	if (validated.error) return json({ error: validated.error }, 400);
	const login = await startLogin(executable);
	return json({ login }, login.state === "pending" ? 200 : 502);
}
