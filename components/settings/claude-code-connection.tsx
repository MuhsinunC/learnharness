"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { Toggle } from "./controls";
import { endpointOrigin, normalizeEndpointUrl, isAllowedEndpointUrl } from "@/src/core";

export const CLAUDE_LOGIN_POLL_MS = 2000;
export const CLAUDE_LOGIN_POLL_LIMIT_MS = 600000;
const READ_ERROR = "Could not read the Claude Code status. Try again.";
const CHANGE_ERROR = "The Claude connection could not be changed. Try again.";
const LOGIN_ERROR = "Sign-in did not complete. Try again.";
type Login = { state: "idle" | "pending" | "failed"; url: string | null; error?: string | null };
type Status = {
	mode: "off" | "local" | "endpoint"; envOverride: boolean; active: boolean;
	executable: string | null; found: boolean; candidates?: string[] | null; version?: string | null;
	loggedIn: boolean; account?: { email?: string | null; subscriptionType: string | null } | null;
	login?: Login | null; endpoint?: { baseUrl: string | null; tokenSet: boolean } | null; error?: string | null;
	// PUT and DELETE success carry `ok: true`, `error: null`, and an optional `probeError` diagnostic; failures are non-2xx with `error`.
	ok?: boolean; probeError?: string | null; discovered?: string | null; hint?: string | null;
};
type Change = { mode: Status["mode"]; baseUrl?: string; token?: string; executable?: string };
function safeError(value: unknown, fallback: string, token?: string) {
	return typeof value === "string" && (!token || !value.includes(token)) ? value : fallback;
}
function loginUrl(value?: string | null) {
	try { return value && new URL(value).protocol === "https:" ? value : null; } catch { return null; }
}

const LOGIN_MARKER = "lh:claude-login";
function readLoginMarker(): number | "expired" | null {
	try {
		const value = sessionStorage.getItem(LOGIN_MARKER);
		if (value === null) return null;
		const started = Number(value);
		if (Number.isFinite(started) && Date.now() >= started && Date.now() - started < CLAUDE_LOGIN_POLL_LIMIT_MS) return started;
		sessionStorage.removeItem(LOGIN_MARKER);
		return "expired";
	} catch { /* Storage is optional in browser privacy modes. */ }
	return null;
}
function storeLoginMarker(started: number | null) {
	try {
		if (started === null) sessionStorage.removeItem(LOGIN_MARKER);
		else sessionStorage.setItem(LOGIN_MARKER, String(started));
	} catch { /* In-memory activation still works without storage. */ }
}

export function ClaudeCodeConnection({ labelClassName }: { labelClassName?: string } = {}) {
	const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false), [baseUrl, setBaseUrl] = useState("");
	const [tokenTyped, setTokenTyped] = useState(false);
	const [backend, setBackend] = useState<"local" | "endpoint">("local");
	const mounted = useRef(false), sequence = useRef(0), inFlight = useRef(false);
	const current = useRef<Status | null>(null), tokenInput = useRef<HTMLInputElement>(null);
	const polling = useRef<ReturnType<typeof setInterval> | null>(null), loginStarted = useRef<number | null>(null);
	const loginTimedOut = useRef(false), pollInFlight = useRef(false), errorSource = useRef<"background" | "user" | null>(null);
	const modeGeneration = useRef(0), activation = useRef<{ started: number; generation: number } | null>(null);
	function clearActivation() { activation.current = null; storeLoginMarker(null); }
	function showError(message: string, background = false) {
		if (background && errorSource.current === "user") return;
		errorSource.current = background ? "background" : "user"; setError(message);
	}
	function stopPolling() {
		if (polling.current !== null) clearInterval(polling.current);
		polling.current = null; loginStarted.current = null;
	}
	function accept(next: Status, token?: string, syncEndpoint = false) {
		const normalized = { ...next, probeError: safeError(next.probeError, "", token) || null, account: next.account ?? null, login: next.login ?? { state: "idle" as const, url: null, error: null }, endpoint: next.endpoint ?? { baseUrl: null, tokenSet: false } };
		if (loginTimedOut.current && normalized.login.state === "pending") normalized.login = { state: "idle", url: null, error: null };
		if (!current.current || syncEndpoint) setBaseUrl(normalized.endpoint.baseUrl ?? "");
		if (next.mode !== "off") setBackend(next.mode);
		current.current = normalized; setStatus(normalized);
		if (normalized.login.state === "failed") {
			stopPolling(); clearActivation(); showError(safeError(normalized.login.error, LOGIN_ERROR, token));
		} else if (next.loggedIn) {
			stopPolling();
			const eligible = activation.current;
			clearActivation();
			if (eligible && eligible.generation === modeGeneration.current && Date.now() - eligible.started < CLAUDE_LOGIN_POLL_LIMIT_MS && !next.envOverride && next.mode === "off") {
				// Consume activation before queuing so overlapping replies cannot enable twice.
				queueMicrotask(() => { if (mounted.current && eligible.generation === modeGeneration.current) void request("PUT", { mode: "local" }, false, true); });
			}
		} else if (next.found && !next.envOverride && normalized.login.state === "pending" && loginStarted.current === null && !loginTimedOut.current) {
			loginStarted.current = activation.current?.started ?? Date.now();
			polling.current = setInterval(() => {
				if (Date.now() - loginStarted.current! >= CLAUDE_LOGIN_POLL_LIMIT_MS) {
					stopPolling(); clearActivation(); loginTimedOut.current = true;
					if (pollInFlight.current) { sequence.current++; pollInFlight.current = false; }
					if (current.current) { current.current = { ...current.current, login: { state: "idle", url: null } }; setStatus(current.current); }
					showError("Sign-in timed out. Try again.");
				} else void request("GET", undefined, true);
			}, CLAUDE_LOGIN_POLL_MS);
		} else if (!next.found || next.envOverride) stopPolling();
	}
	async function request(method: "GET" | "PUT" | "POST" | "DELETE", body?: Change, background = false, automatic = false) {
		if (inFlight.current || (background && pollInFlight.current)) return;
		const owner = ++sequence.current, fallback = method === "GET" ? READ_ERROR : CHANGE_ERROR;
		const previous = current.current, sentToken = body?.token;
		pollInFlight.current = background;
		if (!background) { inFlight.current = true; setBusy(true); errorSource.current = null; setError(null); }
		if (method === "POST") {
			loginTimedOut.current = false; clearActivation();
			if (previous?.mode === "off" && !(backend === "endpoint" && previous.endpoint?.baseUrl && previous.endpoint.tokenSet)) {
				const started = Date.now(); activation.current = { started, generation: modeGeneration.current }; storeLoginMarker(started);
			}
		}
		if (method === "PUT" && !automatic) clearActivation();
		try {
			const response = await fetch(method === "DELETE" ? "/api/claude-code/endpoint" : method === "POST" ? "/api/claude-code/login" : "/api/claude-code", method === "GET" ? { cache: "no-store" } : { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
			const reply = await response.json();
			// A 2xx write commits unless the reply says `ok: false`.
			const committed = (method === "PUT" || method === "DELETE") && response.ok && (reply.ok === undefined || reply.ok === true);
			if (committed) {
				if (!automatic) { modeGeneration.current++; clearActivation(); }
				notifySettingsSaved("keys");
			}
			if (method === "POST" && (!response.ok || reply.error != null || reply.login?.state === "failed")) clearActivation();
			if (!mounted.current || owner !== sequence.current) return;
			if (!response.ok) {
				if (method === "POST" && reply.login?.state === "failed") showError(safeError(reply.login.error, LOGIN_ERROR, sentToken));
				else showError(safeError(reply.error, fallback, sentToken), background);
				return;
			}
			if (background && errorSource.current === "background") { errorSource.current = null; setError(null); }
			if (reply.error != null || ((method === "PUT" || method === "DELETE") && !committed)) {
				if (typeof reply.found === "boolean") accept({ ...reply, error: safeError(reply.error, fallback, sentToken) }, sentToken, method === "DELETE" || (method === "PUT" && body?.mode === "endpoint"));
				showError(safeError(reply.error, fallback, sentToken), background); return;
			}
			if (method === "POST") {
				if (current.current) accept({ ...current.current, login: reply.login });
				if (reply.login?.state === "idle") queueMicrotask(() => { if (mounted.current) void request("GET"); });
			} else {
				accept(reply, sentToken, method === "DELETE" || (method === "PUT" && body?.mode === "endpoint"));
				if (committed && body?.executable) queueMicrotask(() => { if (mounted.current) void request("GET"); });
			}
		} catch {
			if (method === "POST") clearActivation();
			if (mounted.current && owner === sequence.current) showError(fallback, background);
		} finally {
			if (sentToken && tokenInput.current) { tokenInput.current.value = ""; setTokenTyped(false); }
			if (body) delete body.token;
			if (mounted.current && owner === sequence.current) {
				pollInFlight.current = false;
				if (!background) { inFlight.current = false; setBusy(false); }
			}
		}
	}
	useEffect(() => {
		mounted.current = true;
		const started = readLoginMarker();
		if (started === "expired") loginTimedOut.current = true;
		else if (started !== null) activation.current = { started, generation: modeGeneration.current };
		void request("GET");
		return () => { mounted.current = false; sequence.current++; inFlight.current = false; pollInFlight.current = false; stopPolling(); };
		// Requests and the polling timer read current status through refs.
	}, []);
	function saveEndpoint() {
		const url = baseUrl.trim();
		if (!isAllowedEndpointUrl(url)) { showError("Enter an https:// URL, or http://localhost or http://127.0.0.1 for a relay on this computer."); return; }
		const token = tokenInput.current?.value ?? "";
		if (!token && !status?.endpoint?.tokenSet) { showError("Enter a token."); return; }
		void request("PUT", { mode: "endpoint", baseUrl: url, ...(token ? { token } : {}) });
	}
	function chooseBackend(choice: "local" | "endpoint") {
		if (status?.mode !== "off") void request("PUT", { mode: choice });
		else { setBackend(choice); if (choice === "endpoint") clearActivation(); }
	}
	const pending = status?.login?.state === "pending" && !status.loggedIn;
	const url = loginUrl(status?.login?.url);
	const signedIn = `${status?.account?.email ? `Signed in as ${status.account.email}` : "Signed in"}${status?.account?.subscriptionType ? ` (${status.account.subscriptionType})` : ""}`;
	const endpointConfigured = !!status?.endpoint?.baseUrl && !!status.endpoint.tokenSet;
	const selectedBackend = endpointConfigured ? backend : "local";
	const canEnable = selectedBackend === "endpoint" ? endpointConfigured : !!status?.loggedIn;
	const repair = status?.discovered != null && (status.hint != null || !status.found);
	const normalizedUrl = normalizeEndpointUrl(baseUrl);
	const originChanged = !!status?.endpoint?.baseUrl && status.endpoint.tokenSet && normalizedUrl !== null && endpointOrigin(baseUrl) !== endpointOrigin(status.endpoint.baseUrl);
	const help = "text-xs leading-relaxed text-muted-foreground";
	return <div data-testid="claude-code-connection" className="flex flex-col gap-2">
		<span className={labelClassName ?? "font-ui text-xs text-foreground"}>Claude</span>
		<p className={help}>Use your Claude subscription through Claude Code on this computer.</p>
		{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
		{status?.probeError && <p className={help}>{status.probeError}</p>}
		{!status ? error && <Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" variant="outline" disabled={busy} onClick={() => void request("GET")}>Refresh</Button> : status.envOverride ? <>
			<p className={help}>Configured by the LH_CLAUDE_CODE_EXECUTABLE environment variable.</p>
			{status.loggedIn && <p className={help}>{signedIn}</p>}
			{status.executable && <p className="text-[11px] text-muted-foreground">{status.executable}</p>}
		</> : repair || !status.found ? <>
			{repair ? <>
				<p className={help}>{status.hint ?? "The saved Claude Code path is missing."}</p>
				<Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" disabled={busy} onClick={() => void request("PUT", { mode: status.mode === "off" ? "local" : status.mode, executable: status.discovered! })}>{`Use ${status.discovered}`}</Button>
			</> : <>
				<p className={help}>{status.executable === null ? "Claude Code isn't installed on this computer." : `Claude Code wasn't found at ${status.executable}.`}</p>
				<p className={help}>Install Claude Code from claude.com/claude-code, then come back here.</p>
			</>}
			{status.mode !== "off" && <div className="flex items-center gap-3 text-xs text-foreground"><Toggle label="Use Claude in LearnHarness" checked disabled={busy} onChange={() => void request("PUT", { mode: "off" })} /><span>Use Claude in LearnHarness</span></div>}
			<Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" variant="outline" disabled={busy} onClick={() => void request("GET")}>Refresh</Button>
		</> : <>
			{status.loggedIn ? <>
				<p className={help}>{signedIn}</p>
				{status.executable && <p className="text-[11px] text-muted-foreground">{status.executable}</p>}
			</> : pending ? <>
				<p className={help}>Finish signing in in your browser…</p>
				{url && <a className={help} href={url} target="_blank" rel="noreferrer">If no browser opened, open this link</a>}
			</> : <Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" variant="outline" disabled={busy} onClick={() => void request("POST")}>Log in with Claude</Button>}
			{endpointConfigured && <fieldset disabled={busy} className="space-y-1 text-xs text-foreground">
				<legend>Send requests through:</legend>
				<label className="mr-3 inline-flex items-center gap-1"><input type="radio" name="claude-backend" aria-label="my Claude login" disabled={status.mode !== "off" && !status.loggedIn} checked={selectedBackend === "local"} onChange={() => chooseBackend("local")} />my Claude login</label>
				<label className="inline-flex items-center gap-1"><input type="radio" name="claude-backend" aria-label="custom endpoint" checked={selectedBackend === "endpoint"} onChange={() => chooseBackend("endpoint")} />custom endpoint</label>
			</fieldset>}
			{(status.loggedIn || endpointConfigured || status.mode !== "off") && <div className="flex items-center gap-3 text-xs text-foreground"><Toggle label="Use Claude in LearnHarness" checked={status.mode !== "off"} disabled={busy || (status.mode === "off" && !canEnable)} onChange={(on) => void request("PUT", { mode: on ? selectedBackend : "off" })} /><span>Use Claude in LearnHarness</span></div>}
			<details open={status.mode === "endpoint"} className="text-xs">
				<summary className="cursor-pointer text-muted-foreground">Advanced: use a custom Claude Code endpoint</summary>
				<div className="mt-2 space-y-2">
					<label className="block">Base URL<input type="text" aria-label="Base URL" autoComplete="off" value={baseUrl} disabled={busy} onChange={(event) => setBaseUrl(event.currentTarget.value)} className="w-full rounded-sm border border-border bg-background px-2 py-1.5" /></label>
					<label className="block">Token<input ref={tokenInput} aria-label="Token" type="password" autoComplete="off" disabled={busy} onInput={(event) => setTokenTyped(event.currentTarget.value !== "")} placeholder={originChanged ? "Enter the token for this address" : status.endpoint?.tokenSet ? "Token saved — leave empty to keep it" : "Token"} className="w-full rounded-sm border border-border bg-background px-2 py-1.5" /></label>
					<Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" variant="outline" disabled={busy || (originChanged && !tokenTyped)} onClick={saveEndpoint}>Save</Button>
					{normalizedUrl && new URL(normalizedUrl).protocol === "http:" && <p className={help}>This address isn't encrypted; anything else running on this computer could read the token.</p>}
					{(status.endpoint?.baseUrl != null || status.endpoint?.tokenSet) && <Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" variant="outline" disabled={busy} onClick={() => void request("DELETE")}>Remove saved endpoint</Button>}
					{status.mode === "endpoint" && <Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" variant="ghost" disabled={busy} onClick={() => void request("PUT", { mode: status.loggedIn ? "local" : "off" })}>Stop using endpoint</Button>}
				</div>
			</details>
		</>}
	</div>;
}
