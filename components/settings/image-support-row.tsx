"use client";

import { useEffect, useState } from "react";
import type { ImageSupportSettings, ModelCatalogEntry } from "@/src/core";
import { SettingsRow, ThinSelect } from "@/components/settings/controls";
import { notifySettingsSaved } from "@/components/settings-signal";

/**
 * The per-model "accepts images" override (LH-39): pick any catalog model,
 * then keep the catalog's answer or force it on or off. Persisted as the
 * `imageSupport` settings section (PUT /api/settings/imageSupport,
 * replace-whole); the composer and the server gate both read the result
 * through the catalog's `supportsImages`.
 */
export function ImageSupportRow({ catalog }: { catalog: ModelCatalogEntry[] | null }) {
	const [overrides, setOverrides] = useState<ImageSupportSettings>({});
	const [picked, setPicked] = useState("");

	useEffect(() => {
		fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings?: { imageSupport?: ImageSupportSettings } | null }>)
			.then((body) => setOverrides(body.settings?.imageSupport ?? {}))
			.catch(() => {});
	}, []);

	const model = catalog?.find((m) => `${m.provider}:${m.id}` === picked) ?? catalog?.[0];
	const override = model ? overrides[model.provider]?.[model.id] : undefined;
	const catalogSays = model?.input.includes("image") ? "yes" : "no";

	const write = (value: string) => {
		if (!model) return;
		const forProvider = { ...overrides[model.provider] };
		if (value === "default") delete forProvider[model.id];
		else forProvider[model.id] = value === "on";
		const next = { ...overrides, [model.provider]: forProvider };
		if (Object.keys(forProvider).length === 0) delete next[model.provider];
		fetch("/api/settings/imageSupport", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(next),
		})
			.then((r) => {
				if (!r.ok) return;
				setOverrides(next);
				notifySettingsSaved("imageSupport");
			})
			.catch(() => {});
	};

	return (
		<SettingsRow
			label="Image input"
			hint="Whether a model reads images you attach. Defaults come from the model catalog."
			testid="image-support-row"
			dimmed={!catalog?.length}
		>
			<span className="flex items-center gap-2">
				<ThinSelect
					value={model ? `${model.provider}:${model.id}` : ""}
					onChange={setPicked}
					ariaLabel="Model for image input"
					testid="image-support-model"
					disabled={!catalog?.length}
				>
					{catalog?.map((m) => (
						<option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
							{m.provider}/{m.id}
						</option>
					))}
				</ThinSelect>
				<ThinSelect
					value={override === undefined ? "default" : override ? "on" : "off"}
					onChange={write}
					ariaLabel="Image input"
					testid="image-support-value"
					disabled={!model}
				>
					<option value="default">Catalog ({catalogSays})</option>
					<option value="on">Yes</option>
					<option value="off">No</option>
				</ThinSelect>
			</span>
		</SettingsRow>
	);
}
