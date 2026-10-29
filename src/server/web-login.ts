/**
 * WEB LOGIN (LH-43): one local user, so the learner can open the copy on
 * their own computer from a phone over their tailnet (tailscale serve).
 *
 * THE TRUST RULE. Remote access exists only in a production server (the
 * desktop app or `npm start`); a dev server ignores the record, because
 * Next's dev-only endpoints never pass through proxy.ts.
 *   - No password: as before LH-43. A request is "local" when Host is
 *     loopback and every forwarding header is absent or loopback (Next
 *     fills x-forwarded-for/-host from the socket, so values are checked,
 *     not presence). Anything else, tailscale serve included, gets nothing.
 *   - Password set: no header heuristic is trusted, since any header-less
 *     TCP forwarder (tailscale serve --tcp, editor port forwarding,
 *     ssh -R) would pass it. Every browser request needs a session, on
 *     this computer too. The one exception is the desktop window's
 *     per-launch secret (desktop-access.ts), checked in proxy.ts.
 *   - The first password is set only by the desktop window or the CLI
 *     (scripts/remote-access.ts): writing the data dir proves locality.
 *
 * The record (web-login.json under the data dir, mode 0600) holds the
 * scrypt hash and the SHA-256 of each live session token, never a token.
 * Reads are synchronous so the proxy can decide without awaiting, and
 * cached until the file's identity, size or mtime changes.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { TAILSCALE_BINS } from "./tailscale-bins.mjs";

const SESSION_COOKIE = "lh_session";
/** Stamped by proxy.ts on every request it lets through; client copies are always stripped. */
export const ACCESS_HEADER = "x-lh-access";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** Oldest sessions go first beyond this many devices. */
const MAX_SESSIONS = 20;
// OWASP's scrypt alternative to N=2^17,p=1: the same work for 32 MiB.
const KDF = { N: 2 ** 15, r: 8, p: 3, keylen: 32 } as const;

/** desktop: the window's secret; local: this computer, no password set; session: logged in. */
export type Access = "desktop" | "local" | "session";

/** host: the Host header the session was issued for (lower case). */
interface Session { id: string; expires: number; host: string }
interface LoginRecord {
	version: 1;
	password: { salt: string; hash: string; N: number; r: number; p: number };
	sessions: Session[];
}

/** Remote access is production-only: the desktop app or `npm start`. */
export function remoteAccessAvailable(env: Record<string, string | undefined> = process.env): boolean {
	return env.NODE_ENV === "production";
}

function loginFile(): string {
	return path.join(PATHS.data, "web-login.json");
}

let cached: { key: string; record: LoginRecord | null } | null = null;

function readRecord(): LoginRecord | null {
	let key: string;
	try {
		const st = fs.statSync(loginFile());
		key = `${st.ino}:${st.size}:${st.mtimeMs}`;
	} catch {
		cached = null;
		return null;
	}
	if (cached?.key === key) return cached.record;
	let record: LoginRecord | null = null;
	try {
		const value = JSON.parse(fs.readFileSync(loginFile(), "utf8")) as LoginRecord;
		if (typeof value?.password?.hash === "string" && Array.isArray(value.sessions)) record = value;
	} catch { /* unreadable counts as no password */ }
	cached = { key, record };
	return record;
}

function writeRecord(record: LoginRecord): void {
	const file = loginFile(), tmp = `${file}.tmp-${process.pid}`;
	const now = Date.now();
	record.sessions = record.sessions.filter((s) => s.expires > now).slice(-MAX_SESSIONS);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
	cached = null;
}

/** A copy the caller may change and write back. */
function editableRecord(): LoginRecord | null {
	const record = readRecord();
	return record && structuredClone(record);
}

export function passwordConfigured(): boolean {
	return readRecord() !== null;
}

function derive(password: string, salt: Buffer, p: { N: number; r: number; p: number }): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		scrypt(password, salt, KDF.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r }, (err, key) => (err ? reject(err) : resolve(key))));
}

// One derivation at a time: each costs 32 MiB and real CPU on a shared laptop.
let kdfQueue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
	const run = kdfQueue.then(work, work);
	kdfQueue = run.catch(() => {});
	return run;
}

/** Which password a check matched (its stored hash): a write or session
 * that follows the check goes ahead only while that password is current,
 * so one racing a password change cannot outlive it. */
export type PasswordProof = string;

/** The current password is still the one `proof` matched (none: no check needed). */
function stillCurrent(proof: PasswordProof | undefined): boolean {
	return proof === undefined || readRecord()?.password.hash === proof;
}

/** Sets or replaces the password and revokes every session. With `proof`,
 * only while the password it matched is still current (false otherwise). */
export async function setPassword(password: string, proof?: PasswordProof): Promise<boolean> {
	const salt = randomBytes(16);
	const hash = await serial(() => derive(password, salt, KDF));
	if (!stillCurrent(proof)) return false;
	writeRecord({ version: 1, password: { salt: salt.toString("base64"), hash: hash.toString("base64"), N: KDF.N, r: KDF.r, p: KDF.p }, sessions: [] });
	return true;
}

/** Turns remote access off: the password and every session go. With
 * `proof`, only while the password it matched is still current. */
export function clearPassword(proof?: PasswordProof): boolean {
	if (!stillCurrent(proof)) return false;
	fs.rmSync(loginFile(), { force: true });
	cached = null;
	return true;
}

/** The proof for a right password, else null. */
export async function verifyPassword(password: string): Promise<PasswordProof | null> {
	const record = readRecord();
	if (!record) return null;
	const want = Buffer.from(record.password.hash, "base64");
	const got = await serial(() => derive(password, Buffer.from(record.password.salt, "base64"), record.password));
	return got.length === want.length && timingSafeEqual(got, want) ? record.password.hash : null;
}

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/** The Host a session is bound to. Cookies ignore ports, so the laptop's
 * own browser sends its cookie to every server on 127.0.0.1; bound to its
 * Host, a token read there cannot be replayed through the ts.net name. */
const hostKey = (headers: Headers) => (headers.get("host") ?? "").trim().toLowerCase();

/** A new session token for this request's Host (only its digest is
 * stored), or null when the password `proof` matched was changed or
 * removed meanwhile. */
export function createSession(headers: Headers, proof: PasswordProof): string | null {
	const record = editableRecord();
	if (!record || record.password.hash !== proof) return null;
	const token = randomBytes(32).toString("base64url");
	record.sessions.push({ id: digest(token), expires: Date.now() + SESSION_MS, host: hostKey(headers) });
	writeRecord(record);
	return token;
}

export function revokeSession(token: string | null): void {
	const record = editableRecord();
	if (!record || !token) return;
	const id = digest(token);
	record.sessions = record.sessions.filter((s) => s.id !== id);
	writeRecord(record);
}

function validSession(record: LoginRecord, headers: Headers): boolean {
	const token = sessionToken(headers);
	if (!token) return false;
	// Digests of 256-bit random tokens: equality timing reveals nothing usable.
	const id = digest(token), now = Date.now(), host = hostKey(headers);
	return record.sessions.some((s) => s.id === id && s.expires > now && s.host === host);
}

export function sessionToken(headers: Headers): string | null {
	for (const part of (headers.get("cookie") ?? "").split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === SESSION_COOKIE) return rest.join("=") || null;
	}
	return null;
}

export function sessionCookie(token: string, headers: Headers): string {
	const secure = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" ? "; Secure" : "";
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`;
}

export const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** 127.0.0.0/8, ::1 (any spelling Next or a client might use) and localhost. */
function isLoopbackHost(value: string): boolean {
	let host = value.trim().toLowerCase().replace(/\.$/, "");
	if (host.startsWith("::ffff:")) host = host.slice(7);
	return host === "localhost" || host === "::1" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** The hostname of a Host header value; null for anything malformed. */
function hostOf(value: string): string | null {
	if (!value || /[@/\\?#\s]/.test(value)) return null;
	try {
		return new URL(`http://${value}`).hostname;
	} catch {
		return null;
	}
}

function fromThisMachine(headers: Headers): boolean {
	const host = hostOf(headers.get("host") ?? "");
	if (!host || !isLoopbackHost(host)) return false;
	const forwardedHost = headers.get("x-forwarded-host");
	if (forwardedHost !== null && !forwardedHost.split(",").every((h) => isLoopbackHost(hostOf(h.trim()) ?? ""))) return false;
	const forwardedFor = headers.get("x-forwarded-for");
	if (forwardedFor !== null && !forwardedFor.split(",").every((ip) => isLoopbackHost(ip))) return false;
	let proxied = headers.has("forwarded") || headers.has("x-real-ip");
	headers.forEach((_value, name) => { if (name.startsWith("tailscale-")) proxied = true; });
	return !proxied;
}

/** "local", "session", or null (log in first). The desktop secret is
 * proxy.ts's to check. See the trust rule above. */
export function decideAccess(headers: Headers, env: Record<string, string | undefined> = process.env): Access | null {
	const record = remoteAccessAvailable(env) ? readRecord() : null;
	if (!record) return fromThisMachine(headers) ? "local" : null;
	return validSession(record, headers) ? "session" : null;
}

/** A state-changing request sent from this app's own pages, or by a
 * non-browser client (no Origin, no Sec-Fetch-Site). `Origin: null`
 * (sandboxed frames, data: URLs) counts as cross-site. */
export function sameOriginRequest(headers: Headers): boolean {
	const site = headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin") return false;
	const origin = headers.get("origin");
	if (origin === null) return true;
	try {
		return new URL(origin).host === headers.get("host");
	} catch {
		return false;
	}
}

/** The client a failed login is charged to: the rightmost X-Forwarded-For
 * entry, the one the last hop added. tailscale serve sets it to the tailnet
 * peer's address, replacing any the client sent (ipn/ipnlocal/serve.go,
 * addProxyForwardedHeaders); with no header, Next fills in the socket
 * address. A client on the loopback socket itself can still forge it,
 * which is why /login has the global cap too. */
export function clientKey(headers: Headers): string {
	return headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

const WINDOW_MS = 15 * 60 * 1000, PER_CLIENT = 5, GLOBAL = 30;
/** The global bucket: trimmed header values never start with a space. */
const ALL = " all";
const failures = new Map<string, number[]>();
function recent(key: string, now: number): number[] {
	const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
	// Only clients with live failures keep an entry: forged keys cannot grow the map.
	if (list.length) failures.set(key, list); else failures.delete(key);
	return list;
}

/** Seconds until this client may try again, or 0. Checked before any
 * hashing. `global` false skips the shared cap (see confirmCurrentPassword). */
export function loginRetryAfter(key: string, now = Date.now(), global = true): number {
	const mine = recent(key, now), all = global ? recent(ALL, now) : [];
	const blockedBy = mine.length >= PER_CLIENT ? mine[mine.length - PER_CLIENT] : all.length >= GLOBAL ? all[all.length - GLOBAL] : undefined;
	return blockedBy === undefined ? 0 : Math.ceil((blockedBy + WINDOW_MS - now) / 1000);
}

/** Charges one attempt BEFORE the password is checked, so parallel posts
 * cannot outrun the limit. Call the returned release for a right password. */
export function chargeLoginAttempt(key: string, now = Date.now(), global = true): () => void {
	for (const bucket of global ? [key, ALL] : [key]) failures.set(bucket, [...recent(bucket, now), now]);
	return () => {
		failures.delete(key);
		if (!global) return;
		const all = failures.get(ALL) ?? [], i = all.indexOf(now);
		if (i >= 0) all.splice(i, 1);
	};
}

/** The header a session sends the current password in (URI-encoded), for
 * writes that need it (web-mode key writes). proxy.ts checks it and never
 * forwards it. */
export const CURRENT_PASSWORD_HEADER = "x-lh-current-password";

/** The bucket a session's re-entered current passwords are charged to:
 * its own token, so one cookie gets five tries per window whatever
 * address it claims, and another device's session keeps its own. */
export function sessionAttemptKey(headers: Headers): string {
	return `session:${digest(sessionToken(headers) ?? "")}`;
}

/** Checks the current password a session re-entered, charged to that
 * session (sessionAttemptKey). Not to the global cap: the sender is
 * already logged in, and failures charged there would let one device
 * lock every other out of /login. */
export async function confirmCurrentPassword(headers: Headers): Promise<{ ok: true } | { ok: false; retryAfter?: number }> {
	const key = sessionAttemptKey(headers);
	const wait = loginRetryAfter(key, Date.now(), false);
	if (wait > 0) return { ok: false, retryAfter: wait };
	// URI-encoded by the client: header values must be ASCII, passwords need not be.
	let password: string | null = null;
	try { password = decodeURIComponent(headers.get(CURRENT_PASSWORD_HEADER) ?? ""); } catch { /* malformed: a wrong password */ }
	if (password === "") return { ok: false };
	const release = chargeLoginAttempt(key, Date.now(), false);
	const proof = password === null ? null : await verifyPassword(password);
	if (!proof) return { ok: false };
	release();
	return stillCurrent(proof) ? { ok: true } : { ok: false };
}

/** A same-origin path to return to after login, printable ASCII only (it
 * becomes a Location header); anything else becomes "/". */
export function safeNext(value: unknown): string {
	return typeof value === "string" && /^\/(?![/\\])[\x21-\x7e]*$/.test(value) && !value.startsWith("/login") ? value : "/";
}

const TAILNET_TTL_MS = 30_000;
let tailnet: { bin: string | undefined; at: number; url: Promise<string | null> } | null = null;

/** This computer's `https://<machine>.<tailnet>.ts.net` from `tailscale status
 * --json`, or null when Tailscale is missing, stopped or has no DNS name.
 * Read-only: it never runs `tailscale serve`. LH_TAILSCALE_BIN overrides.
 * Kept for 30 s, a miss included: Settings asks on every open. */
export function tailnetURL(env: Record<string, string | undefined> = process.env): Promise<string | null> {
	const now = Date.now();
	if (!tailnet || tailnet.bin !== env.LH_TAILSCALE_BIN || now - tailnet.at >= TAILNET_TTL_MS) tailnet = { bin: env.LH_TAILSCALE_BIN, at: now, url: lookUpTailnetURL(env.LH_TAILSCALE_BIN) };
	return tailnet.url;
}

async function lookUpTailnetURL(override: string | undefined): Promise<string | null> {
	for (const bin of override ? [override] : TAILSCALE_BINS) {
		const out = await new Promise<string | null>((resolve) =>
			execFile(bin, ["status", "--json"], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout)));
		if (out === null) continue;
		try {
			const status = JSON.parse(out) as { BackendState?: string; Self?: { DNSName?: string } };
			const name = status.Self?.DNSName?.replace(/\.$/, "");
			return status.BackendState === "Running" && name && /^[a-z0-9.-]+\.ts\.net$/i.test(name) ? `https://${name}` : null;
		} catch {
			return null;
		}
	}
	return null;
}
