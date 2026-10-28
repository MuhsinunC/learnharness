/**
 * PUT /api/settings/context-windows — one (provider, model) pair's custom
 * context window (LH-38). Body: {provider, id, tokens, confirmAboveMax?}
 * (server/settings-body.ts parseContextWindowBody). A value must name a
 * pair in its provider's catalog and be at least the pair's Minimum
 * (400 `below_minimum`). A value above the pair's known Maximum is refused
 * with 409 `above_maximum` unless confirmAboveMax is true — the settings
 * modal's confirmation is the only way past it. `tokens: null`, or a value
 * equal to the Default, clears the pair back to its catalog default; a
 * clear needs no catalog entry, so a pair whose model left the catalog
 * can still be cleared. Either save also forgets the limit a provider
 * stated for the pair (learnedContextLimits, LH-55): the user's word on
 * the window replaces it, and a real limit is learned again only from a
 * rejection newer than the save (learnedLimitsClearedAt).
 *
 * A static sibling of [section], so it wins the route match; the generic
 * section route has no contextWindows parser and cannot write the map.
 */

import { contextWindowKey } from "@/src/core";
import { contextWindowBounds, parseContextWindowBody, updateSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
	const parsed = parseContextWindowBody(await request.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const { provider, id, tokens, confirmAboveMax } = parsed.settings;
	let pin: number | null = null;
	if (tokens !== null) {
		const bounds = contextWindowBounds(provider, id);
		if (!bounds) return Response.json({ error: `No model "${id}" in the ${provider} catalog` }, { status: 400 });
		if (tokens < bounds.minWindow) {
			return Response.json(
				{ error: `${tokens} is below the minimum (${bounds.minWindow}) for ${provider}:${id}`, code: "below_minimum", minimum: bounds.minWindow },
				{ status: 400 },
			);
		}
		if (tokens > bounds.maxWindow && !confirmAboveMax) {
			return Response.json(
				{ error: `${tokens} is above the known maximum (${bounds.maxWindow}) for ${provider}:${id}`, code: "above_maximum", maximum: bounds.maxWindow },
				{ status: 409 },
			);
		}
		if (tokens !== bounds.defaultWindow) pin = tokens;
	}
	const key = contextWindowKey(provider, id);
	const next = updateSettingsRecord((record) => {
		const windows = { ...record.contextWindows };
		if (pin === null) delete windows[key];
		else windows[key] = pin;
		const { [key]: _learned, ...learnedContextLimits } = record.learnedContextLimits ?? {};
		return { ...record, contextWindows: windows, learnedContextLimits, learnedLimitsClearedAt: { ...record.learnedLimitsClearedAt, [key]: Date.now() } };
	});
	return Response.json({ settings: next });
}
