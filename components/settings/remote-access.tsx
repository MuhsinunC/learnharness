"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "./controls.tsx";

/** GET /api/remote-access (LH-43). */
type RemoteAccess = { available: boolean; enabled: boolean; access: "local" | "session" | null };

const DOCS = `${process.env.LH_HOMEPAGE ?? ""}/blob/main/docs/remote-access.md`;
const MIN_LENGTH = 8;

/** Settings → General: the login password for phones on the learner's
 * tailnet. Only the computer itself can change it; a logged-in phone sees
 * the status and a Log out button. Hidden in the desktop app. */
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

	if (!state?.available) return null;
	const local = state.access === "local";
	const hint = state.enabled
		? "On. Devices on your tailnet log in with this password. Saving a new one logs every device out."
		: "Off. Set a password to open LearnHarness from your phone over Tailscale.";
	return (
		<SettingsRow
			label="Remote access"
			testid="row-remote-access"
			hint={
				<>
					<span className="block" data-testid="remote-access-status">{hint}</span>
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
