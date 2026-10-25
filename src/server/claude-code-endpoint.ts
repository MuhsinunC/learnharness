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

export function isAllowedEndpointUrl(value: string): boolean {
	if (typeof value !== "string" || !value.trim()) return false;
	try {
		const url = new URL(value);
		return !url.username && !url.password && (url.protocol === "https:" ||
			(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")));
	} catch { return false; }
}

function validToken(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

function readStored(): { baseUrl?: unknown; token?: unknown } {
	try {
		const value = JSON.parse(fs.readFileSync(endpointFile(), "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch { return {}; }
}

export function readEndpointConfig(): ClaudeCodeEndpoint | null {
	const cfg = readStored();
	return typeof cfg.baseUrl === "string" && isAllowedEndpointUrl(cfg.baseUrl) && validToken(cfg.token)
		? { baseUrl: cfg.baseUrl, token: cfg.token } : null;
}

export function endpointStatus(): { baseUrl: string | null; tokenSet: boolean } {
	const cfg = readStored();
	return { baseUrl: typeof cfg.baseUrl === "string" && isAllowedEndpointUrl(cfg.baseUrl) ? cfg.baseUrl : null, tokenSet: validToken(cfg.token) };
}

function saveError(error: unknown): Error {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return new Error(`claude-code endpoint: could not save (${typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown"})`);
}

export function writeEndpointConfig(cfg: { baseUrl: string; token?: string }): void {
	if (!isAllowedEndpointUrl(cfg.baseUrl)) throw new Error("claude-code endpoint: invalid base URL");
	if (cfg.token !== undefined && !validToken(cfg.token)) throw new Error("claude-code endpoint: invalid token");
	const stored = readStored();
	const token = cfg.token ?? (validToken(stored.token) ? stored.token : undefined);
	const file = endpointFile(), dir = path.dirname(file);
	const tmp = path.join(dir, `.claude-endpoint.json.tmp-${process.pid}`);
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.rmSync(tmp, { force: true });
		fs.writeFileSync(tmp, JSON.stringify({ baseUrl: cfg.baseUrl, ...(token !== undefined ? { token } : {}) }), { mode: 0o600 });
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
