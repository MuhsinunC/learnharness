"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { computerOnlyMessage, REMOTE_PASSWORD_MIN } from "@/src/core";
import { SettingsRow } from "./controls.tsx";

/** GET /api/remote-access (LH-43). */
type RemoteAccess = {
	available: boolean;
	desktop: boolean;
	enabled: boolean;
	access: "desktop" | "local" | "session" | null;
	remotePort: number | null;
	restartNeeded: boolean;
	url: string | null;
};

/** One GET per 30 s for every row that asks (KeysSection, the sign-in
 * rows and RemoteAccessSettings open together); a change refreshes it.
 * Only an answer is kept: a failed read is asked again next time. */
let shared: { at: number; state: Promise<RemoteAccess | null> } | null = null;
function remoteAccessState(fresh = false): Promise<RemoteAccess | null> {
	if (fresh || !shared || Date.now() - shared.at >= 30_000) {
		const state = fetch("/api/remote-access").then((r) => (r.ok ? r.json() as Promise<RemoteAccess> : null)).catch(() => null);
		shared = { at: Date.now(), state };
		void state.then((s) => { if (!s && shared?.state === state) shared = null; });
	}
	return shared.state;
}

const DOCS = `${process.env.LH_HOMEPAGE ?? ""}/blob/main/docs/remote-access.md`;
const code = "select-all font-mono text-foreground";
const field = "h-7 w-32 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";

/** For a logged-in browser session (from the access stamp GET
 * /api/remote-access already returns): the message proxy.ts sends for
 * host-affecting changes; whether key writes are among them (desktop app),
 * or need the current password re-entered instead (web mode). null on the
 * desktop window, or when no password exists. */
export function useComputerOnly(): { message: string; keys: boolean; confirmKeys: boolean } | null {
	const [state, setState] = useState<{ message: string; keys: boolean; confirmKeys: boolean } | null>(null);
	useEffect(() => {
		let live = true;
		void remoteAccessState().then((s) => { if (live && s?.access === "session") setState({ message: computerOnlyMessage(s.desktop), keys: s.desktop, confirmKeys: !s.desktop }); });
		return () => { live = false; };
	}, []);
	return state;
}

export function ComputerOnlyNote({ testid, message }: { testid: string; message: string }) {
	return <p className="text-xs text-muted-foreground" data-testid={testid}>{message}</p>;
}

/** Settings → General: the login password for phones on the learner's
 * tailnet, the one `tailscale serve` command and the phone's address. The
 * desktop window changes it freely; a logged-in browser re-enters the
 * current password; web mode sets the first one with the CLI. */
export function RemoteAccessSettings() {
	const [state, setState] = useState<RemoteAccess | null>(null);
	const [password, setPassword] = useState("");
	const [current, setCurrent] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = (fresh = false) => remoteAccessState(fresh).then(setState);
	useEffect(() => { void load(); }, []);

	const change = async (method: "PUT" | "DELETE") => {
		setBusy(true);
		setError(null);
		const res = await fetch("/api/remote-access", {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(method === "PUT" ? { password, current } : { current }),
		}).catch(() => null);
		setBusy(false);
		if (!res?.ok) {
			setError(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn’t save. Try again.");
			return;
		}
		setPassword("");
		setCurrent("");
		// A browser session was revoked with every other one: log in again.
		if (state?.access === "session") window.location.assign("/login");
		else await load(true);
	};

	if (!state) return null;
	// A stale tailscale serve keeps forwarding to whoever holds the port next.
	const serveOff = <code className={code} data-testid="remote-access-serve-off">tailscale serve --https=443 off</code>;
	let status: React.ReactNode;
	if (!state.available) {
		status = "Not available here. Remote access works only in the desktop app or with npm start, never with a development server.";
	} else if (!state.enabled) {
		status = state.desktop
			? <>Off. Set a password to open LearnHarness from your phone over Tailscale. If you used tailscale serve before, stop it: {serveOff}</>
			: <>Off. To turn it on, run <code className={code} data-testid="remote-access-cli">npm run remote-access:set-password</code> in the LearnHarness folder on this computer.</>;
	} else if (state.restartNeeded) {
		status = <span data-testid="remote-access-restart">On, but quit LearnHarness and open it again to finish. If this stays, port {state.remotePort} is used by another program: don’t run tailscale serve for it, and if you already did, run {serveOff}</span>;
	} else {
		status = (
			<>
				<span className="block">On. Devices on your tailnet log in with the password; saving a new one logs every device out.</span>
				<span className="block">Once, in Terminal on this computer: <code className={code} data-testid="remote-access-command">tailscale serve --bg {state.remotePort}</code></span>
				<span className="block">Then open <span className={code} data-testid="remote-access-url">{state.url ?? "https://<this-computer>.<your-tailnet>.ts.net"}</span> on your phone.</span>
			</>
		);
	}
	const canEdit = state.available && (state.access === "desktop" || (state.access === "session" && state.enabled));
	const needsCurrent = state.access === "session";
	return (
		<SettingsRow
			label="Remote access"
			testid="row-remote-access"
			hint={
				<>
					<span className="block" data-testid="remote-access-status">{status}</span>
					{error && <span className="block text-red-500" role="alert">{error}</span>}
					<a href={DOCS} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline">How to set it up</a>
				</>
			}
		>
			<span className="flex shrink-0 items-center gap-2">
				{canEdit && needsCurrent && (
					<input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" aria-label="Current remote access password" autoComplete="current-password" data-testid="remote-access-current" disabled={busy} className={field} />
				)}
				{canEdit && (
					<>
						<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={state.enabled ? "New password" : "Password"} aria-label="Remote access password" autoComplete="new-password" data-testid="remote-access-password" disabled={busy} className={field} />
						<Button type="button" size="xs" className="cursor-pointer" data-testid="remote-access-save" disabled={busy || password.length < REMOTE_PASSWORD_MIN || (needsCurrent && !current)} onClick={() => void change("PUT")}>
							Save
						</Button>
						{state.enabled && (
							<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="remote-access-off" disabled={busy || (needsCurrent && !current)} onClick={() => void change("DELETE")}>
								Turn off
							</Button>
						)}
					</>
				)}
				{state.access === "session" && (
					<form method="post" action="/logout">
						<Button type="submit" size="xs" variant="outline" className="cursor-pointer" data-testid="remote-access-logout">Log out</Button>
					</form>
				)}
			</span>
		</SettingsRow>
	);
}
