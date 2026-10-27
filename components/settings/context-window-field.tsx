"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelCatalogEntry } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { formatTokens } from "@/components/usage-format";

/**
 * One (provider, model) pair's context window (LH-38, owner 2026-10-27).
 * Enter or Save commits; an empty field resets to the catalog Default. A
 * value above the known Maximum opens a confirm modal first — Confirm
 * stays disabled until "I know what I'm doing" is checked; Cancel keeps
 * the stored value. The server refuses above-maximum writes without that
 * confirmation, so the modal is the only way past it.
 *
 * Callers key this per pair + stored value, so switching models shows
 * that pair's own value and a landed save resets the draft.
 */
export function ContextWindowField({ entry }: { entry: ModelCatalogEntry }) {
	const stored = entry.contextWindow === entry.defaultContextWindow ? "" : String(entry.contextWindow);
	const [draft, setDraft] = useState(stored);
	const [pending, setPending] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function write(tokens: number | null, confirmAboveMax: boolean) {
		setError(null);
		try {
			const res = await fetch("/api/settings/context-windows", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider: entry.provider, id: entry.id, tokens, confirmAboveMax }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? `settings rejected (${res.status})`);
				return;
			}
			notifySettingsSaved("contextWindows");
		} catch {
			setError("Could not reach the server — try again.");
		}
	}

	function save() {
		const text = draft.trim();
		if (text === "") {
			if (stored !== "") void write(null, false);
			return;
		}
		const tokens = Math.floor(Number(text));
		if (!Number.isFinite(tokens) || tokens < 1) {
			setError("Enter a positive number of tokens.");
			return;
		}
		if (tokens > entry.maxContextWindow) setPending(tokens);
		else void write(tokens, false);
	}

	return (
		<span className="flex flex-col items-end gap-1">
			<span className="flex items-center gap-2">
				<input
					type="number"
					value={draft}
					placeholder={String(entry.defaultContextWindow)}
					aria-label={`${entry.id} context window`}
					data-testid="input-context-window"
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") save();
					}}
					className="h-7 w-32 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
				/>
				<button
					type="button"
					data-testid="save-context-window"
					onClick={save}
					className="rounded-sm border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Save
				</button>
			</span>
			{error && <span className="text-xs text-destructive" data-testid="context-window-error">{error}</span>}
			{pending !== null && (
				<AboveMaximumDialog
					tokens={pending}
					maximum={entry.maxContextWindow}
					onCancel={() => {
						setPending(null);
						setDraft(stored);
					}}
					onConfirm={() => {
						setPending(null);
						void write(pending, true);
					}}
				/>
			)}
		</span>
	);
}

/** The above-maximum confirm (the abort-turn dialog's frame). No backdrop
 *  dismiss: leaving takes Cancel or Esc. Esc is claimed in the window's
 *  capture phase so the settings dialog behind it stays open, and
 *  data-lh-menu marks it a layer of the open menu, so the menus'
 *  outside-click handlers don't close the field under it. */
function AboveMaximumDialog({
	tokens,
	maximum,
	onCancel,
	onConfirm,
}: {
	tokens: number;
	maximum: number;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const [understood, setUnderstood] = useState(false);
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			onCancel();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [onCancel]);
	return createPortal(
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Context window above maximum"
			data-testid="context-window-dialog"
			data-lh-menu=""
			className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 backdrop-blur-sm"
		>
			<div className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg">
				<h2 className="text-sm font-semibold text-card-foreground">
					{formatTokens(tokens)} is above the known maximum ({formatTokens(maximum)})
				</h2>
				<p className="mt-1.5 text-xs text-muted-foreground">
					This context window is larger than we know this model supports. It may not work, and the chat could get
					ruined: it may stop compacting, so you can&apos;t continue it.
				</p>
				<label className="mt-3 flex items-center gap-2 text-xs text-card-foreground">
					<input
						type="checkbox"
						checked={understood}
						onChange={(e) => setUnderstood(e.target.checked)}
						data-testid="context-window-understood"
					/>
					I know what I&apos;m doing
				</label>
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						data-testid="context-window-cancel"
						onClick={onCancel}
						className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="context-window-confirm"
						disabled={!understood}
						onClick={onConfirm}
						className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
					>
						Confirm
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
