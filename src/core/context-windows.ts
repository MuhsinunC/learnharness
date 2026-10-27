/**
 * Per-model context windows (LH-38, owner 2026-10-27): the user may set a
 * custom context window per (provider, model) pair — thinking level never
 * changes it. Default is the catalog's contextWindow (pi-ai metadata);
 * Maximum is the known working limit from the table below, or the
 * Default when no higher limit is known. Values above the Maximum are
 * allowed only behind an explicit confirmation (the settings modal; the
 * write route enforces it). Minimum is a hard floor: below it compaction
 * would churn. Sources: docs/context-windows.md.
 *
 * Pure: GET /api/models projects Default and Maximum from it for the
 * settings UI, and the write route guards with the same numbers. Extend
 * it by adding `provider:id` rows.
 */

import { COMPACTION_RESERVE_TOKENS } from "./compaction.ts";
import { COMPACTION_THRESHOLD_FLOOR } from "./settings.ts";

/** Known working maximum context windows, keyed `provider:id`. OpenAI API:
 *  the model pages' documented window. ChatGPT subscription models: the
 *  Codex model catalog's max_context_window. Claude has no rows: the
 *  anthropic catalog already carries Anthropic's documented windows, and
 *  claude-code's catalog window is the one its CLI model id runs at
 *  (agent/claude-code/models.ts), which this setting does not change. */
export const KNOWN_MAX_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
	"openai:gpt-6.1-sol": 1_050_000,
	"openai:gpt-6-astra": 1_050_000,
	"openai:gpt-6-sol": 1_050_000,
	"openai:gpt-6-luna": 1_050_000,
	"openai:gpt-5.6-sol": 1_050_000,
	"openai:gpt-5.6-terra": 1_050_000,
	"openai:gpt-5.6-luna": 1_050_000,
	"chatgpt:gpt-6.1-sol": 872_000,
	"chatgpt:gpt-6.1-terra": 872_000,
	"chatgpt:gpt-6-astra": 920_000,
	"chatgpt:gpt-6-sol": 920_000,
	"chatgpt:gpt-6-luna": 920_000,
	"chatgpt:gpt-5.6-sol": 920_000,
	"chatgpt:gpt-5.6-terra": 872_000,
	"chatgpt:gpt-5.6-luna": 872_000,
};

/** The settings record's key for one pair. */
export function contextWindowKey(provider: string, id: string): string {
	return `${provider}:${id}`;
}

/** The known working maximum for a pair — never below its Default. */
export function maxContextWindow(provider: string, id: string, defaultWindow: number): number {
	return Math.max(defaultWindow, KNOWN_MAX_CONTEXT_WINDOWS[contextWindowKey(provider, id)] ?? 0);
}

/** The smallest window that keeps the compaction trigger (window − reserve)
 *  at or above the threshold floor: 32k + 16,384 = 48,384 tokens. */
export const CONTEXT_WINDOW_FLOOR = COMPACTION_THRESHOLD_FLOOR + COMPACTION_RESERVE_TOKENS;

/** The lowest window a pair accepts — the floor, or the pair's own
 *  Default when the model is smaller than that. */
export function minContextWindow(defaultWindow: number): number {
	return Math.min(CONTEXT_WINDOW_FLOOR, defaultWindow);
}
