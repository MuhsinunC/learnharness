"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { Toggle } from "./controls";

export const CLAUDE_LOGIN_POLL_MS = 2000;
export const CLAUDE_LOGIN_POLL_LIMIT_MS = 600000;
const READ_ERROR = "Could not read the Claude Code status. Try again.";
const CHANGE_ERROR = "The Claude connection could not be changed. Try again.";
const LOGIN_ERROR = "Sign-in did not complete. Try again.";
type Login = { state: "idle" | "pending" | "failed"; url: string | null; error?: string | null };
type Status = {
	mode: "off" | "local" | "endpoint"; envOverride: boolean; active: boolean;
	executable: string | null; found: boolean; candidates?: string[] | null; version?: string | null;
	loggedIn: boolean; account?: { email: string; subscriptionType: string | null } | null;
	login?: Login | null; endpoint?: { baseUrl: string | null; tokenSet: boolean } | null; error?: string | null;
};
type Change = { mode: Status["mode"]; baseUrl?: string; token?: string };
function safeError(value: unknown, fallback: string, token?: string) {
	return typeof value === "string" && (!token || !value.includes(token)) ? value : fallback;
}
function loginUrl(value?: string | null) {
	try { return value && new URL(value).protocol === "https:" ? value : null; } catch { return null; }
}

export function ClaudeCodeConnection() {
	const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false), [baseUrl, setBaseUrl] = useState("");
	const mounted = useRef(false), sequence = useRef(0), inFlight = useRef(false);
	const current = useRef<Status | null>(null), tokenInput = useRef<HTMLInputElement>(null);
	const polling = useRef<ReturnType<typeof setInterval> | null>(null), loginStarted = useRef<number | null>(null);
	const autoEnabled = useRef(false), loginTimedOut = useRef(false), pollInFlight = useRef(false);
	function stopPolling() {
		if (polling.current !== null) clearInterval(polling.current);
		polling.current = null; loginStarted.current = null;
	}
	function accept(next: Status, token?: string, syncEndpoint = false) {
		const normalized = { ...next, account: next.account ?? null, login: next.login ?? { state: "idle" as const, url: null, error: null }, endpoint: next.endpoint ?? { baseUrl: null, tokenSet: false } };
		if (loginTimedOut.current && normalized.login.state === "pending") normalized.login = { state: "idle", url: null, error: null };
		if (!current.current || syncEndpoint) setBaseUrl(normalized.endpoint.baseUrl ?? "");
		current.current = normalized; setStatus(normalized);
		if (normalized.login.state === "failed") {
			stopPolling(); setError(safeError(normalized.login.error, LOGIN_ERROR, token));
		} else if (next.loggedIn) {
			const completingLogin = loginStarted.current !== null;
			stopPolling();
			if (completingLogin && !next.envOverride && next.mode !== "local" && !autoEnabled.current) {
				autoEnabled.current = true;
				// Defer until the GET has released the request lock.
				queueMicrotask(() => { if (mounted.current) void request("PUT", { mode: "local" }); });
			}
		} else if (next.found && !next.envOverride && normalized.login.state === "pending" && loginStarted.current === null && !loginTimedOut.current) {
			autoEnabled.current = false; loginStarted.current = Date.now();
			polling.current = setInterval(() => {
				if (Date.now() - loginStarted.current! >= CLAUDE_LOGIN_POLL_LIMIT_MS) {
					stopPolling(); loginTimedOut.current = true;
					if (pollInFlight.current) { sequence.current++; pollInFlight.current = false; }
					if (current.current) { current.current = { ...current.current, login: { state: "idle", url: null } }; setStatus(current.current); }
					setError("Sign-in timed out. Try again.");
				} else void request("GET", undefined, true);
			}, CLAUDE_LOGIN_POLL_MS);
		} else if (!next.found || next.envOverride) stopPolling();
	}
	async function request(method: "GET" | "PUT" | "POST", body?: Change, background = false) {
		if (inFlight.current || (background && pollInFlight.current)) return;
		const owner = ++sequence.current, fallback = method === "GET" ? READ_ERROR : CHANGE_ERROR;
		pollInFlight.current = background;
		if (!background) { inFlight.current = true; setBusy(true); setError(null); }
		if (method === "POST") loginTimedOut.current = false;
		try {
			const response = await fetch(method === "POST" ? "/api/claude-code/login" : "/api/claude-code", method === "GET" ? { cache: "no-store" } : { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
			const reply = await response.json();
			if (!mounted.current || owner !== sequence.current) return;
			if (!response.ok) { setError(safeError(reply.error, fallback, body?.token)); return; }
			if (reply.error != null) {
				if (typeof reply.found === "boolean") accept({ ...reply, error: safeError(reply.error, fallback, body?.token) }, body?.token, method === "PUT" && body?.mode === "endpoint");
				setError(safeError(reply.error, fallback, body?.token)); return;
			}
			if (method === "POST") {
				if (current.current) accept({ ...current.current, login: reply.login });
			} else accept(reply, body?.token, method === "PUT" && body?.mode === "endpoint");
			if (method === "PUT") notifySettingsSaved("keys");
		} catch { if (mounted.current && owner === sequence.current) setError(fallback); }
		finally {
			if (method === "PUT" && tokenInput.current) tokenInput.current.value = "";
			if (body) delete body.token;
			if (mounted.current && owner === sequence.current) {
				pollInFlight.current = false;
				if (!background) { inFlight.current = false; setBusy(false); }
			}
		}
	}
	useEffect(() => {
		mounted.current = true; void request("GET");
		return () => { mounted.current = false; sequence.current++; inFlight.current = false; pollInFlight.current = false; stopPolling(); };
		// Requests and the polling timer read current status through refs.
	}, []);
	function saveEndpoint() {
		const url = baseUrl.trim();
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) throw new Error();
		} catch { setError("Enter an https:// URL, or http://localhost or http://127.0.0.1 for a relay on this computer."); return; }
		const token = tokenInput.current?.value ?? "";
		if (!token && !status?.endpoint?.tokenSet) { setError("Enter a token."); return; }
		void request("PUT", { mode: "endpoint", baseUrl: url, ...(token ? { token } : {}) });
	}
	const pending = status?.login?.state === "pending" && !status.loggedIn;
	const url = loginUrl(status?.login?.url);
	const signedIn = status?.account ? `Signed in as ${status.account.email}${status.account.subscriptionType ? ` (${status.account.subscriptionType})` : ""}` : "Signed in";
	const help = "text-xs leading-relaxed text-muted-foreground";
	return <div data-testid="claude-code-connection" className="flex flex-col gap-2">
		<span className="font-ui text-xs text-foreground">Claude</span>
		<p className={help}>Use your Claude subscription through Claude Code on this computer.</p>
		{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
		{!status ? error && <Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" variant="outline" disabled={busy} onClick={() => void request("GET")}>Refresh</Button> : status.envOverride ? <>
			<p className={help}>Configured by the LH_CLAUDE_CODE_EXECUTABLE environment variable.</p>
			{status.loggedIn && <p className={help}>{signedIn}</p>}
			{status.executable && <p className="text-[11px] text-muted-foreground">{status.executable}</p>}
		</> : !status.found ? <>
			<p className={help}>Claude Code isn&apos;t installed on this computer.</p>
			<p className={help}>Install Claude Code from claude.com/claude-code, then come back here.</p>
			<Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" variant="outline" disabled={busy} onClick={() => void request("GET")}>Refresh</Button>
		</> : <>
			{status.loggedIn ? <>
				<p className={help}>{signedIn}</p>
				<div className="flex items-center gap-3 text-xs text-foreground"><Toggle label="Use Claude in LearnHarness" checked={status.mode !== "off"} disabled={busy} onChange={(on) => void request("PUT", { mode: on ? "local" : "off" })} /><span>Use Claude in LearnHarness</span></div>
				{status.executable && <p className="text-[11px] text-muted-foreground">{status.executable}</p>}
			</> : pending ? <>
				<p className={help}>Finish signing in in your browser…</p>
				{url && <a className={help} href={url} target="_blank" rel="noreferrer">If no browser opened, open this link</a>}
			</> : <Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" variant="outline" disabled={busy} onClick={() => void request("POST")}>Log in with Claude</Button>}
			<details open={status.mode === "endpoint"} className="text-xs">
				<summary className="cursor-pointer text-muted-foreground">Advanced: use a custom Claude Code endpoint</summary>
				<div className="mt-2 space-y-2">
					<label className="block">Base URL<input type="text" aria-label="Base URL" autoComplete="off" value={baseUrl} disabled={busy} onChange={(event) => setBaseUrl(event.currentTarget.value)} className="w-full rounded-sm border border-border bg-background px-2 py-1.5" /></label>
					<label className="block">Token<input ref={tokenInput} aria-label="Token" type="password" autoComplete="off" disabled={busy} placeholder={status.endpoint?.tokenSet ? "Token saved — leave empty to keep it" : "Token"} className="w-full rounded-sm border border-border bg-background px-2 py-1.5" /></label>
					<Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" variant="outline" disabled={busy} onClick={saveEndpoint}>Save</Button>
					{status.mode === "endpoint" && <Button type="button" className="self-start cursor-pointer disabled:cursor-not-allowed" size="xs" variant="ghost" disabled={busy} onClick={() => void request("PUT", { mode: status.loggedIn ? "local" : "off" })}>Stop using endpoint</Button>}
				</div>
			</details>
		</>}
	</div>;
}
