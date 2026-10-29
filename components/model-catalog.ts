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

export function useModelCatalog(): { catalog: ModelCatalogResponse | undefined; failed: boolean; refresh: () => void } {
	const [snapshot, setSnapshot] = useState(() => ({ catalog: catalogCache, failed: catalogError }));
	const hub = useNotifyHub();
	useEffect(() => {
		const first = catalogReaders.size === 0;
		const read = () => setSnapshot({ catalog: catalogCache, failed: catalogError });
		catalogReaders.add(read);
		if (first) {
			const stopSaved = onSettingsSaved((section) => {
				if (section === "keys") {
					catalogGeneration++; catalogInflight = undefined; catalogCache = undefined;
					fetchCatalog();
				} else if (section === "models" || section === "contextWindows" || section === "imageSupport") fetchCatalog(true);
			});
			// A limit a provider stated mid-turn is a server-side change (LH-54).
			const stopEvent = hub?.subscribe("models-changed", () => fetchCatalog(true));
			stopCatalogSignals = () => { stopSaved(); stopEvent?.(); };
			fetchCatalog(true);
		} else fetchCatalog();
		read();
		return () => { catalogReaders.delete(read); if (!catalogReaders.size) { stopCatalogSignals?.(); stopCatalogSignals = undefined; } };
	}, [hub]);
	const refresh = useCallback(() => fetchCatalog(true), []);
	return { ...snapshot, refresh };
}
