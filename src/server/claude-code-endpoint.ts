/**
 * Kept out of auth.json: initAuthEnv copies it into process.env, where pi-ai's
 * anthropic provider would send ANTHROPIC_AUTH_TOKEN to api.anthropic.com.
 */
import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import type { ClaudeCodeEndpoint } from "../core/claude-code-endpoint.ts";

export function endpointFile(): string {
	return path.join(path.dirname(AUTH_FILE), "claude-endpoint.json");
}

function normalizeEndpointUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || /[?#]/.test(trimmed)) return null;
	try {
		const url = new URL(trimmed);
		if (url.username || url.password || !(url.protocol === "https:" ||
			(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")))) return null;
		return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
	} catch { return null; }
}

export function isAllowedEndpointUrl(value: string): boolean {
	return normalizeEndpointUrl(value) !== null;
}

function validToken(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !/[^\x21-\x7e]/.test(value);
}

type Stored = { kind: "absent" | "unreadable" } | { kind: "ok"; url: string | null; token?: string };
function readStored(): Stored {
	let raw: string;
	try { raw = fs.readFileSync(endpointFile(), "utf8"); }
	catch (error) { return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" }; }
	try {
		const value = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value) ||
			("token" in value && !validToken(value.token))) return { kind: "unreadable" };
		return { kind: "ok", url: normalizeEndpointUrl(value.baseUrl), token: value.token };
	} catch { return { kind: "unreadable" }; }
}

export function readEndpointConfig(): ClaudeCodeEndpoint | null {
	const cfg = readStored();
	return cfg.kind === "ok" && cfg.url && cfg.token ? { baseUrl: cfg.url, token: cfg.token } : null;
}

export function endpointStatus(): { baseUrl: string | null; tokenSet: boolean } {
	const cfg = readStored();
	return { baseUrl: cfg.kind === "ok" ? cfg.url : null, tokenSet: cfg.kind === "ok" && cfg.token !== undefined };
}

function saveError(error: unknown): Error {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return new Error(`claude-code endpoint: could not save (${typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown"})`);
}

export function writeEndpointConfig(cfg: { baseUrl: string; token?: string }): void {
	const url = normalizeEndpointUrl(cfg.baseUrl);
	if (url === null) throw new Error("claude-code endpoint: invalid base URL");
	if (cfg.token !== undefined && !validToken(cfg.token)) throw new Error("claude-code endpoint: invalid token");
	const stored = readStored();
	if (cfg.token === undefined && stored.kind === "unreadable") throw new Error("claude-code endpoint: existing endpoint credentials could not be read; re-enter the token");
	const token = cfg.token ?? (stored.kind === "ok" ? stored.token : undefined);
	const file = endpointFile(), dir = path.dirname(file);
	const tmp = path.join(dir, `.claude-endpoint.json.tmp-${process.pid}`);
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.rmSync(tmp, { force: true });
		fs.writeFileSync(tmp, JSON.stringify({ baseUrl: url, ...(token !== undefined ? { token } : {}) }), { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, file);
	} catch (error) {
		try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
		throw saveError(error);
	}
}

export function clearEndpointConfig(): void {
	try { fs.rmSync(endpointFile(), { force: true }); }
	catch (error) { throw saveError(error); }
}
