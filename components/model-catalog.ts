"use client";

import { useCallback, useEffect, useState } from "react";
import type { ModelCatalogResponse } from "@/src/core";
import { onSettingsSaved } from "@/components/settings-signal";
import { useNotifyHub } from "@/components/server-events";

// Shared stale-while-revalidate catalog. Metadata refreshes retain the last
// good snapshot; connection changes clear selectable models immediately.
let catalogCache: ModelCatalogResponse | undefined;
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

function fetchCatalog(revalidate = false): void {
	if (revalidate) { catalogGeneration++; catalogInflight = undefined; }
	if (catalogInflight) return;
	const generation = catalogGeneration;
	catalogError = false;
	publishCatalog();
	catalogInflight = fetch("/api/models")
		.then((r) => { if (!r.ok) throw new Error(`catalog request failed: ${r.status}`); return r.json() as Promise<ModelCatalogResponse>; })
		.then((c) => {
			if (generation === catalogGeneration) { catalogCache = c; catalogError = false; publishCatalog(); }
		})
		.catch(() => {
			if (generation === catalogGeneration) { catalogError = true; publishCatalog(); }
		})
		.finally(() => { if (generation === catalogGeneration) catalogInflight = undefined; });
}

/** Refetch on the server's word that the catalog changed (a provider
 *  stated a limit, a window was saved elsewhere), and on every reconnect,
 *  which may have missed that word, while any reader of this hub is
 *  mounted. */
function holdHub(hub: Hub): () => void {
	let held = hubSignals.get(hub);
	if (!held) {
		const offEvent = hub.subscribe("models-changed", () => fetchCatalog(true));
		const offResync = hub.onResync(() => fetchCatalog(true));
		held = { readers: 0, stop: () => { offEvent(); offResync(); } };
		hubSignals.set(hub, held);
	}
	const mine = held;
	mine.readers++;
	return () => { if (--mine.readers === 0) { mine.stop(); hubSignals.delete(hub); } };
}

export function useModelCatalog(): { catalog: ModelCatalogResponse | undefined; failed: boolean; refresh: () => void } {
	const [snapshot, setSnapshot] = useState(() => ({ catalog: catalogCache, failed: catalogError }));
	const hub = useNotifyHub();
	useEffect(() => {
		const first = catalogReaders.size === 0;
		const read = () => setSnapshot({ catalog: catalogCache, failed: catalogError });
		catalogReaders.add(read);
		if (first) {
			stopCatalogSignals = onSettingsSaved((section) => {
				if (section === "keys") {
					catalogGeneration++; catalogInflight = undefined; catalogCache = undefined;
					fetchCatalog();
				} else if (section === "models" || section === "contextWindows" || section === "imageSupport") fetchCatalog(true);
			});
			fetchCatalog(true);
		} else fetchCatalog();
		read();
		return () => { catalogReaders.delete(read); if (!catalogReaders.size) { stopCatalogSignals?.(); stopCatalogSignals = undefined; } };
	}, []);
	useEffect(() => hub ? holdHub(hub) : undefined, [hub]);
	const refresh = useCallback(() => fetchCatalog(true), []);
	return { ...snapshot, refresh };
}
