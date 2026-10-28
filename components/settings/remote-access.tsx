"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "./controls.tsx";

/** GET /api/remote-access (LH-43). */
type RemoteAccess = { enabled: boolean; access: "local" | "session" | null; remotePort: number | null; restartNeeded: boolean; url: string | null };

const DOCS = `${process.env.LH_HOMEPAGE ?? ""}/blob/main/docs/remote-access.md`;
const MIN_LENGTH = 8;

/** Settings → General: the login password for phones on the learner's
 * tailnet, plus the one `tailscale serve` command and the phone's address.
 * Only the computer itself can change it; a logged-in phone sees the
 * status and a Log out button. */
export function RemoteAccessSettings() {
	const [state, setState] = useState<RemoteAccess | null>(null);
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = () => fetch("/api/remote-access").then((r) => r.json() as Promise<RemoteAccess>).then(setState).catch(() => setState(null));
	useEffect(() => { void load(); }, []);

	const change = async (method: "PUT" | "DELETE") => {
		setBusy(true);
		setError(null);
		const res = await fetch("/api/remote-access", {
			method,
			headers: { "content-type": "application/json" },
			body: method === "PUT" ? JSON.stringify({ password }) : undefined,
		}).catch(() => null);
		setBusy(false);
		if (!res?.ok) {
			setError(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn’t save. Try again.");
			return;
		}
		setPassword("");
		await load();
	};

	if (!state) return null;
	const local = state.access === "local";
	const hint = state.enabled
		? "On. Devices on your tailnet log in with this password. Saving a new one logs every device out."
		: "Off. Set a password to open LearnHarness from your phone over Tailscale.";
	// A `tailscale serve` left running keeps forwarding to the port whoever holds it.
	const serveOff = <code className="select-all font-mono text-foreground" data-testid="remote-access-serve-off">tailscale serve --https=443 off</code>;
	const setup = !local ? null : !state.enabled ? (
		<span className="block">If you shared LearnHarness with tailscale serve before, stop that too: {serveOff}</span>
	) : state.restartNeeded ? (
		<span className="block" data-testid="remote-access-restart">
			Quit LearnHarness and open it again to finish. If this stays, port {state.remotePort} is used by another program: don’t run tailscale serve for it, and if you already did, run {serveOff}
		</span>
	) : (
		<>
			<span className="block">
				Once, in Terminal on this computer: <code className="select-all font-mono text-foreground" data-testid="remote-access-command">tailscale serve --bg {state.remotePort}</code>
			</span>
			<span className="block">
				Then open <span className="select-all font-mono text-foreground" data-testid="remote-access-url">{state.url ?? "https://<this-computer>.<your-tailnet>.ts.net"}</span> on your phone.
			</span>
		</>
	);
	return (
		<SettingsRow
			label="Remote access"
			testid="row-remote-access"
			hint={
				<>
					<span className="block" data-testid="remote-access-status">{hint}</span>
					{setup}
					{error && <span className="block text-red-500" role="alert">{error}</span>}
					<a href={DOCS} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline">How to set it up</a>
				</>
			}
		>
			{local ? (
				<span className="flex shrink-0 items-center gap-2">
					<input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder={state.enabled ? "New password" : "Password"}
						aria-label="Remote access password"
						autoComplete="new-password"
						data-testid="remote-access-password"
						disabled={busy}
						className="h-7 w-36 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
					/>
					<Button type="button" size="xs" className="cursor-pointer" data-testid="remote-access-save" disabled={busy || password.length < MIN_LENGTH} onClick={() => void change("PUT")}>
						Save
					</Button>
					{state.enabled && (
						<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="remote-access-off" disabled={busy} onClick={() => void change("DELETE")}>
							Turn off
						</Button>
					)}
				</span>
			) : (
				<form method="post" action="/logout">
					<Button type="submit" size="xs" variant="outline" className="cursor-pointer" data-testid="remote-access-logout">Log out</Button>
				</form>
			)}
		</SettingsRow>
	);
}
