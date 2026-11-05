"use client";

import { useCallback, useEffect, useState } from "react";
import type { ModelCatalogResponse } from "@/src/core";
import { onSettingsSaved } from "@/components/settings-signal";
import { useNotifyHub } from "@/components/server-events";

// Shared stale-while-revalidate catalog. Metadata refreshes retain the last
// good snapshot; connection changes clear selectable models immediately.
let catalogCache: ModelCatalogResponse | undefined;
/** The last catalog that loaded, kept through a connection change's
 *  clear: readers that only show a model's settings stay mounted on it
 *  until the refetch lands or fails, so an open modal survives (LH-63). */
let catalogLoaded: ModelCatalogResponse | undefined;
let catalogError = false;
let catalogInflight: Promise<void> | undefined;
let catalogGeneration = 0;
let stopCatalogSignals: (() => void) | undefined;
const catalogReaders = new Set<() => void>();
const publishCatalog = () => { for (const reader of catalogReaders) reader(); };
type Hub = NonNullable<ReturnType<typeof useNotifyHub>>;
/** One models-changed subscription and one resync per window's event
 *  hub, however many readers it has (LH-54). */
const hubSignals = new Map<Hub, { readers: number; stop: () => void }>();

function fetchCatalog(revalidate = false): Promise<void> {
	if (revalidate) { catalogGeneration++; catalogInflight = undefined; }
	if (catalogInflight) return catalogInflight;
	const generation = catalogGeneration;
	catalogError = false;
	publishCatalog();
	catalogInflight = fetch("/api/models")
		.then((r) => { if (!r.ok) throw new Error(`catalog request failed: ${r.status}`); return r.json() as Promise<ModelCatalogResponse>; })
		.then((c) => {
			if (generation === catalogGeneration) { catalogCache = catalogLoaded = c; catalogError = false; publishCatalog(); }
		})
		.catch(() => {
			// A failed reload ends the hold: what shows follows what may be
			// selected, as in the slot pickers (LH-63).
			if (generation === catalogGeneration) { catalogLoaded = catalogCache; catalogError = true; publishCatalog(); }
		})
		.finally(() => { if (generation === catalogGeneration) catalogInflight = undefined; });
	return catalogInflight;
}

/** Revalidate now and resolve with the fresh catalog, for a decision that
 *  must not read the snapshot it is about to replace: undefined when the
 *  read fails or takes longer than `waitMs`, never the stale snapshot. The
 *  read itself goes on and publishes as usual. */
export function refreshCatalogNow(waitMs: number): Promise<ModelCatalogResponse | undefined> {
	const read = (async () => {
		await fetchCatalog(true);
		while (catalogInflight) await catalogInflight;
		return catalogError ? undefined : catalogCache;
	})();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, waitMs, undefined); });
	return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/** Refetch on the server's word that the catalog changed (a provider
 *  stated a limit, a window was saved, here or elsewhere), and on every
 *  reconnect, which may have missed that word, while any reader of this
 *  hub is mounted. Not on the window's first open: it follows the mount
 *  fetch by a moment, so a page load reads the catalog once (LH-54). */
function holdHub(hub: Hub): () => void {
	let held = hubSignals.get(hub);
	if (!held) {
		const offEvent = hub.subscribe("models-changed", () => { void fetchCatalog(true); });
		const offResync = hub.onResync((reconnect) => { if (reconnect) fetchCatalog(true); });
		held = { readers: 0, stop: () => { offEvent(); offResync(); } };
		hubSignals.set(hub, held);
	}
	const mine = held;
	mine.readers++;
	return () => { if (--mine.readers === 0) { mine.stop(); hubSignals.delete(hub); } };
}

/** `catalog` is what may be selected; `loaded` is the last catalog that
 *  loaded, for display that must not blink out while a key change
 *  reloads it. */
export function useModelCatalog(): { catalog: ModelCatalogResponse | undefined; loaded: ModelCatalogResponse | undefined; failed: boolean; refresh: () => void } {
	const [snapshot, setSnapshot] = useState(() => ({ catalog: catalogCache, loaded: catalogLoaded, failed: catalogError }));
	const hub = useNotifyHub();
	useEffect(() => {
		const first = catalogReaders.size === 0;
		const read = () => setSnapshot({ catalog: catalogCache, loaded: catalogLoaded, failed: catalogError });
		catalogReaders.add(read);
		if (first) {
			// A window save's models-changed reaches every window with a
			// channel, the saving one included: one refetch there, not two
			// (LH-54).
			stopCatalogSignals = onSettingsSaved((section) => {
				if (section === "keys") {
					catalogGeneration++; catalogInflight = undefined; catalogCache = undefined;
					fetchCatalog();
				} else if (section === "models" || section === "imageSupport" || (section === "contextWindows" && !hubSignals.size)) fetchCatalog(true);
			});
			fetchCatalog(true);
		} else fetchCatalog();
		read();
		return () => { catalogReaders.delete(read); if (!catalogReaders.size) { stopCatalogSignals?.(); stopCatalogSignals = undefined; } };
	}, []);
	useEffect(() => hub ? holdHub(hub) : undefined, [hub]);
	const refresh = useCallback(() => { void fetchCatalog(true); }, []);
	return { ...snapshot, refresh };
}
