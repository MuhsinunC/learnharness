"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { minContextWindow, type ModelCatalogEntry } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { formatTokens } from "@/components/usage-format";
import { CommitInput } from "./controls.tsx";

/** The field's caption, shared by Settings and the composer menu. */
export function contextWindowCaption(entry: ModelCatalogEntry): string {
	return `Default: ${formatTokens(entry.defaultContextWindow)} · Maximum: ${formatTokens(entry.maxContextWindow)}`;
}

/**
 * One (provider, model) pair's context window (LH-38, owner 2026-10-27).
 * Commits on Enter, Save or blur (CommitInput: the field always shows what
 * is stored); an empty field, or the Default itself, resets to the catalog
 * Default. A value below the pair's Minimum is refused in place. A value
 * above the known Maximum opens a confirm modal first — Confirm stays
 * disabled until "I know what I'm doing" is checked; Cancel keeps the
 * stored value. The server refuses above-maximum writes without that
 * confirmation, so the modal is the only way past it; a server refusal
 * (a stale client catalog) opens the same modal at the server's maximum.
 *
 * Callers key this per pair + stored value, so switching models shows
 * that pair's own value and a landed save resets the field.
 */
export function ContextWindowField({ entry }: { entry: ModelCatalogEntry }) {
	const stored = entry.customContextWindow === undefined ? "" : String(entry.customContextWindow);
	const [pending, setPending] = useState<{ tokens: number; maximum: number } | null>(null);
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
				const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; maximum?: number };
				if (body.code === "above_maximum" && tokens !== null && typeof body.maximum === "number") setPending({ tokens, maximum: body.maximum });
				else setError(body.error ?? `settings rejected (${res.status})`);
				return;
			}
			notifySettingsSaved("contextWindows");
		} catch {
			setError("Could not reach the server — try again.");
		}
	}

	function commit(text: string) {
		if (pending) return;
		if (text === "") {
			void write(null, false);
			return;
		}
		const tokens = Math.floor(Number(text));
		if (!Number.isFinite(tokens)) {
			setError("Enter a number of tokens.");
			return;
		}
		const minimum = minContextWindow(entry.defaultContextWindow);
		if (tokens < minimum) setError(`Minimum: ${formatTokens(minimum)} — a smaller window makes compaction churn.`);
		else if (tokens === entry.defaultContextWindow) void write(null, false);
		else if (tokens > entry.maxContextWindow) setPending({ tokens, maximum: entry.maxContextWindow });
		else void write(tokens, false);
	}

	return (
		<span className="flex flex-col items-end gap-1">
			<span className="flex items-center gap-2">
				<CommitInput
					type="number"
					value={stored}
					placeholder={String(entry.defaultContextWindow)}
					ariaLabel={`${entry.id} context window`}
					testid="input-context-window"
					onCommit={commit}
				/>
				{/* The visible commit: pressing it moves focus off the input,
				    and CommitInput commits on that blur — one path for Enter,
				    Save and clicking away. */}
				<button
					type="button"
					data-testid="save-context-window"
					className="rounded-sm border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Save
				</button>
			</span>
			{error && <span className="text-xs text-destructive" data-testid="context-window-error">{error}</span>}
			{pending !== null && (
				<AboveMaximumDialog
					tokens={pending.tokens}
					maximum={pending.maximum}
					onCancel={() => setPending(null)}
					onConfirm={() => {
						setPending(null);
						void write(pending.tokens, true);
					}}
				/>
			)}
		</span>
	);
}

/** The above-maximum confirm (the abort-turn dialog's frame). No backdrop
 *  dismiss: leaving takes Cancel or Esc. Focus lands on the checkbox and
 *  Tab / Shift+Tab cycle inside the dialog. Keys are claimed in the
 *  window's capture phase, so Esc leaves the settings dialog behind it
 *  open, and data-lh-menu marks it a layer of the open menu, so the menus'
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
	const ref = useRef<HTMLDivElement>(null), cancelRef = useRef(onCancel);
	cancelRef.current = onCancel;
	useEffect(() => {
		const focusable = () => [...(ref.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])") ?? [])];
		focusable()[0]?.focus();
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				cancelRef.current();
			} else if (e.key === "Tab") {
				// Claimed outright: the app's own Tab (keyboard-shortcuts.tsx)
				// would move focus to the fields behind the dialog.
				e.preventDefault();
				e.stopPropagation();
				const items = focusable(), at = items.indexOf(document.activeElement as HTMLElement);
				const step = e.shiftKey ? -1 : 1;
				items[at === -1 ? 0 : (at + step + items.length) % items.length]?.focus();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, []);
	return createPortal(
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Context window above maximum"
			data-testid="context-window-dialog"
			data-lh-menu=""
			className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 backdrop-blur-sm"
		>
			<div ref={ref} className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg">
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
