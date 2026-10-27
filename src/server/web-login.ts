/**
 * WEB LOGIN (LH-43): one local user, so the learner can open the copy on
 * their own computer from a phone over their tailnet. The desktop window
 * and a browser on the same machine over loopback never log in.
 *
 * THE TRUST RULE (decideAccess): a request is "local" only when
 *   - the server listens on loopback (LH_LISTEN_HOST, set by
 *     scripts/web-server.mjs), and
 *   - Host is loopback, and every forwarding header is absent or loopback.
 * Next fills x-forwarded-for/-host from the socket when the client sent
 * none, so those are checked by value, not presence. `tailscale serve`
 * proxies from 127.0.0.1 but keeps the ts.net Host and sets the tailnet
 * peer in X-Forwarded-For plus Tailscale-* identity headers, so it never
 * counts as local. On a network listener every header is client-chosen,
 * so nobody is local there. A raw `next dev` (LH_LISTEN_HOST unset) keeps
 * today's loopback trust until a password exists, then requires login.
 * Everyone else needs a session cookie.
 *
 * The record (web-login.json under the data dir, mode 0600) holds the
 * scrypt hash and the SHA-256 of each live session token, never a token.
 * Reads are synchronous so the proxy can decide without awaiting.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";

const SESSION_COOKIE = "lh_session";
/** Stamped by proxy.ts on every request it lets through; client copies are stripped. */
export const ACCESS_HEADER = "x-lh-access";
export const MIN_PASSWORD_LENGTH = 8;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
// OWASP's scrypt alternative to N=2^17,p=1: the same work for 32 MiB.
const KDF = { N: 2 ** 15, r: 8, p: 3, keylen: 32 } as const;

type Access = "local" | "session";

interface Session { id: string; expires: number }
interface LoginRecord {
	version: 1;
	password: { salt: string; hash: string; N: number; r: number; p: number };
	sessions: Session[];
}

function loginFile(): string {
	return path.join(PATHS.data, "web-login.json");
}

function readRecord(): LoginRecord | null {
	try {
		const value = JSON.parse(fs.readFileSync(loginFile(), "utf8")) as LoginRecord;
		return typeof value?.password?.hash === "string" && Array.isArray(value.sessions) ? value : null;
	} catch {
		return null;
	}
}

function writeRecord(record: LoginRecord): void {
	const file = loginFile(), tmp = `${file}.tmp-${process.pid}`;
	const now = Date.now();
	record.sessions = record.sessions.filter((s) => s.expires > now);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
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

/** Sets or replaces the password and revokes every session. */
export async function setPassword(password: string): Promise<void> {
	const salt = randomBytes(16);
	const hash = await serial(() => derive(password, salt, KDF));
	writeRecord({ version: 1, password: { salt: salt.toString("base64"), hash: hash.toString("base64"), N: KDF.N, r: KDF.r, p: KDF.p }, sessions: [] });
}

/** Turns remote access off: the password and every session go. */
export function clearPassword(): void {
	fs.rmSync(loginFile(), { force: true });
}

export async function verifyPassword(password: string): Promise<boolean> {
	const record = readRecord();
	if (!record) return false;
	const want = Buffer.from(record.password.hash, "base64");
	const got = await serial(() => derive(password, Buffer.from(record.password.salt, "base64"), record.password));
	return got.length === want.length && timingSafeEqual(got, want);
}

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new session token; only its digest is stored. */
export function createSession(): string {
	const record = readRecord();
	if (!record) throw new Error("web login: no password is set");
	const token = randomBytes(32).toString("base64url");
	record.sessions.push({ id: digest(token), expires: Date.now() + SESSION_MS });
	writeRecord(record);
	return token;
}

export function revokeSession(token: string | null): void {
	const record = readRecord();
	if (!record || !token) return;
	const id = digest(token);
	record.sessions = record.sessions.filter((s) => s.id !== id);
	writeRecord(record);
}

function validSession(record: LoginRecord, token: string | null): boolean {
	if (!token) return false;
	// Digests of 256-bit random tokens: equality timing reveals nothing usable.
	const id = digest(token), now = Date.now();
	return record.sessions.some((s) => s.id === id && s.expires > now);
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

/** "local", "session", or null (log in first). See the trust rule above. */
export function decideAccess(headers: Headers, env: Record<string, string | undefined> = process.env): Access | null {
	const record = readRecord();
	const listen = env.LH_LISTEN_HOST;
	const loopbackListener = listen === undefined ? record === null : isLoopbackHost(listen);
	if (loopbackListener && fromThisMachine(headers)) return "local";
	return record && validSession(record, sessionToken(headers)) ? "session" : null;
}

/** The client a failed login is charged to: the proxy's peer (tailscale serve's
 * X-Forwarded-For) or Next's socket address. A client on a directly bound
 * address can forge it, which is why the global cap exists too. */
export function clientKey(headers: Headers): string {
	return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
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

/** Seconds until this client may try again, or 0. Checked before any hashing. */
export function loginRetryAfter(key: string, now = Date.now()): number {
	const mine = recent(key, now), all = recent(ALL, now);
	const blockedBy = mine.length >= PER_CLIENT ? mine[mine.length - PER_CLIENT] : all.length >= GLOBAL ? all[all.length - GLOBAL] : undefined;
	return blockedBy === undefined ? 0 : Math.ceil((blockedBy + WINDOW_MS - now) / 1000);
}

/** Charges one attempt BEFORE the password is checked, so parallel posts
 * cannot outrun the limit. Call the returned release for a right password. */
export function chargeLoginAttempt(key: string, now = Date.now()): () => void {
	for (const bucket of [key, ALL]) failures.set(bucket, [...recent(bucket, now), now]);
	return () => {
		failures.delete(key);
		const all = failures.get(ALL) ?? [], i = all.indexOf(now);
		if (i >= 0) all.splice(i, 1);
	};
}

/** A same-origin path to return to after login; anything else becomes "/". */
export function safeNext(value: unknown): string {
	return typeof value === "string" && /^\/(?![/\\])[^\s]*$/.test(value) && !value.startsWith("/login") ? value : "/";
}

// A GUI app's PATH rarely has the CLI: try the usual installs too.
const TAILSCALE_BINS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];

/** This computer's `https://<machine>.<tailnet>.ts.net` from `tailscale status
 * --json`, or null when Tailscale is missing, stopped or has no DNS name.
 * Read-only: it never runs `tailscale serve`. LH_TAILSCALE_BIN overrides. */
export async function tailnetURL(env: Record<string, string | undefined> = process.env): Promise<string | null> {
	for (const bin of env.LH_TAILSCALE_BIN ? [env.LH_TAILSCALE_BIN] : TAILSCALE_BINS) {
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
