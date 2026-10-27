/**
 * PUT /api/settings/context-windows — one (provider, model) pair's custom
 * context window (LH-38). Body: {provider, id, tokens, confirmAboveMax?}
 * (server/settings-body.ts parseContextWindowBody). The pair must be in its
 * provider's catalog. A value above the pair's known Maximum is refused
 * with 409 `above_maximum` unless confirmAboveMax is true — the settings
 * modal's confirmation is the only way past it. `tokens: null` clears the
 * pair back to its catalog default.
 *
 * A static sibling of [section], so it wins the route match; the generic
 * section route has no contextWindows parser and cannot write the map.
 */

import { contextWindowKey } from "@/src/core";
import { contextWindowBounds, parseContextWindowBody, readSettingsRecord, writeSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
	const parsed = parseContextWindowBody(await request.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const { provider, id, tokens, confirmAboveMax } = parsed.settings;
	const bounds = contextWindowBounds(provider, id);
	if (!bounds) return Response.json({ error: `No model "${id}" in the ${provider} catalog` }, { status: 400 });
	if (tokens !== null && tokens > bounds.maxWindow && !confirmAboveMax) {
		return Response.json(
			{ error: `${tokens} is above the known maximum (${bounds.maxWindow}) for ${provider}:${id}`, code: "above_maximum", maximum: bounds.maxWindow },
			{ status: 409 },
		);
	}
	const record = readSettingsRecord() ?? { version: 1 };
	const windows = { ...record.contextWindows };
	const key = contextWindowKey(provider, id);
	if (tokens === null) delete windows[key];
	else windows[key] = tokens;
	const next = { ...record, contextWindows: windows };
	writeSettingsRecord(next);
	return Response.json({ settings: next });
}
