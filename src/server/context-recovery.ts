/**
 * CONTEXT-OVERFLOW RECOVERY (LH-40, docs/context-recovery.md): a chat
 * whose request the provider rejects for length — typically because the
 * configured window is larger than the model's real one, so the threshold
 * compaction never fired — is compacted toward the window the provider
 * actually enforces, then the turn is retried ONCE (chat-handler). The
 * learner's "Repair this chat" action runs the same compaction. The limit
 * a rejection states is remembered per model (learnedContextLimits), so
 * the threshold compaction fires before the next rejection.
 *
 * Nothing is ever deleted: the rejected reply stays in the record (pi
 * drops errored assistants on the wire), and full history stays behind a
 * compaction marker exactly as the threshold run leaves it. The plan tree,
 * graph and job stores are never touched. The marker's details.notice is
 * the learner-facing line, and marks the marker as a recovery.
 *
 * Shape of a recovery: one model summary sized for the target window; if
 * that fails, comes back empty, or still does not fit, a deterministic
 * marker (lesson topic, the prior summary verbatim, plan tree, the
 * learner's dropped lines) with a progressively shorter kept tail. Fit is
 * judged by chars/4 — never the usage anchor, which describes the last
 * request that SUCCEEDED.
 */

import {
	activeCompactionOf,
	buildCompactionPrompt,
	COMPACTED_HISTORY_HEADER,
	compactionCutIndex,
	contextOverflowState,
	derivePlanStatusesLh,
	derivedNodeStatus,
	estimateMessageTokens,
	estimateTokens,
	keptIndexFor,
	newCompactionMarker,
	overflowProviderText,
	planTreeToText,
	reportedContextLimit,
	type ChatRecord,
	type CompactionDetails,
	type LhMarkerMessage,
	type LhMessage,
} from "../core/index.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import {
	heuristicContextTokens,
	saveCompactionMarker,
	sessionKind,
	subagentSummarizer,
	systemPromptTokensFor,
	summarySpan,
	type CompactionDeps,
} from "./compaction.ts";
import type { PiEngine } from "../agent/models.ts";
import { stores } from "./stores.ts";
import { updateSettings } from "../store/settings.ts";

const modelIdOf = (engine: PiEngine) => `${engine.model.provider}:${engine.model.id}`;

/** The limit providers stated for this model (`provider:id`), if any. */
function learnedContextLimit(modelId: string): number | undefined {
	return stores.settingsStore.readSettings()?.learnedContextLimits?.[modelId];
}

/** Remember the limit the chat's newest rejection states for its model —
 *  its own settings key, never the user's window. */
export function learnStatedLimit(engine: PiEngine, messages: readonly LhMessage[]): void {
	const stated = reportedContextLimit(lastOverflowText(messages));
	const modelId = modelIdOf(engine);
	if (!stated || learnedContextLimit(modelId) === stated) return;
	updateSettings((record) => ({ ...record, learnedContextLimits: { ...record.learnedContextLimits, [modelId]: stated } }));
}

/** THE WINDOW SEAM: the window this app may trust for the engine's
 *  model — LH-38's per-(provider, model) custom window when set (the spec
 *  carries it: chat-handler's withContextWindow), else the catalog
 *  default; never above a limit the provider has stated. The threshold
 *  compaction and recovery both read it here. */
export function contextWindowFor(engine: PiEngine): number | undefined {
	const learned = learnedContextLimit(modelIdOf(engine));
	if (learned === undefined) return engine.model.contextWindow;
	return Math.min(engine.model.contextWindow ?? Infinity, learned);
}

/** Share of the target window a recovered request may fill: the rest is
 *  the tool declarations, the reply's max_tokens, and chars/4's error. */
const RECOVERY_FILL = 0.6;

/** Per-line cap for the learner's dropped lines in the fallback marker. */
const FALLBACK_LINE_CHARS = 300;

const isSuccessfulReply = (m: LhMessage) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted";

/** One overflow episode gets one compact-and-retry: true when a recovery
 *  marker landed after the last successful reply. Read from the record,
 *  so it holds across restarts, entry points and threshold markers. */
export function recoveryAttempted(messages: readonly LhMessage[]): boolean {
	let i = messages.length - 1;
	while (i >= 0 && !isSuccessfulReply(messages[i]!)) i--;
	return messages
		.slice(i + 1)
		.some((m) => m.role === "custom" && m.customType === "compaction" && !!(m.details as Partial<CompactionDetails>).notice);
}

/** The provider's text of the newest length rejection (it may state the real limit). */
function lastOverflowText(messages: readonly LhMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (contextOverflowState(messages[i]) !== null) return overflowProviderText(messages[i]);
	}
	return undefined;
}

/** The window to fit: the limit the rejection states; otherwise the
 *  known window, but never more than half the request that just failed
 *  (the known window is exactly what may be wrong). */
export function recoveryWindowTokens(errorText: string | undefined, knownWindowTokens: number | undefined, failedRequestTokens: number): number {
	const stated = reportedContextLimit(errorText);
	if (stated) return stated;
	return Math.max(1, Math.min(knownWindowTokens ?? Infinity, Math.floor(failedRequestTokens / 2)));
}

/** The lesson the summary must name so teaching resumes coherently. */
function lessonTopic(record: ChatRecord): string {
	const tree = record.tree;
	const statuses = tree ? derivePlanStatusesLh(tree, record.messages) : null;
	const current = tree && statuses ? tree.nodes.find((n) => derivedNodeStatus(statuses, n.id) === "current") : undefined;
	return `Current lesson topic: ${record.title}${current ? ` (plan step "${current.title}", ${current.id})` : ""}.`;
}

const middleTruncate = (text: string, max: number) =>
	text.length <= max ? text : `${text.slice(0, Math.ceil(max / 2))}\n…[middle omitted]…\n${text.slice(text.length - Math.floor(max / 2))}`;

/** The deterministic marker body: what the record states for certain —
 *  the prior summary verbatim (middle-truncated only if it alone exceeds
 *  the share), then the plan tree, then the learner's dropped lines. */
function droppedSpanSummary(record: ChatRecord, previous: LhMarkerMessage | null, dropped: readonly LhMessage[], maxChars: number): string {
	const prior = previous?.content.replace(`${COMPACTED_HISTORY_HEADER}\n\n`, "");
	const head = [
		"The older part of this session was dropped to fit the model's context window; no model summary could be written. What the record states for certain:",
		...(prior ? ["## The earlier summary (still authoritative)", middleTruncate(prior, maxChars)] : []),
	].join("\n\n");
	const learner = dropped
		.filter((m) => m.role === "user")
		.map((m) => {
			const text = typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join(" ");
			return `- ${text.length > FALLBACK_LINE_CHARS ? `${text.slice(0, FALLBACK_LINE_CHARS)}…` : text}`;
		});
	const rest = [
		"## The plan dependency tree",
		planTreeToText(record.tree, record.messages) ?? "No plan tree exists in this session.",
		"## What the learner said in the dropped part (newest last)",
		learner.length ? learner.join("\n") : "Nothing.",
	].join("\n\n");
	const room = maxChars - head.length;
	if (room <= 0) return head;
	return `${head}\n\n${rest.length > room ? `${rest.slice(0, room)}…[truncated]` : rest}`;
}

export interface RecoveryDeps extends Omit<CompactionDeps, "thresholdTokens" | "canStart" | "keepRecentTokens"> {
	/** The window to fit (recoveryWindowTokens). */
	windowTokens: number;
	/** The rejected request's estimate (chars/4), measured once. */
	failedRequestTokens: number;
	/** The learner-facing line the moment divider shows. */
	notice: string;
}

/** summarized: a model summary fit. truncated: the deterministic marker
 *  landed (it may still be too big — the retry then fails clearly).
 *  unchanged: nothing could be dropped. */
export type RecoveryOutcome = "summarized" | "truncated" | "unchanged";

/** Everything a recovery needs, resolved from the record and the chat's
 *  engine (the turn handler and the repair route share it). */
export function recoveryDeps(chatStore: ChatStore, record: ChatRecord, engine: PiEngine, notice: string): RecoveryDeps {
	const kind = sessionKind(record);
	const systemPromptTokens = systemPromptTokensFor(kind);
	const failedRequestTokens = heuristicContextTokens(record.messages, systemPromptTokens);
	return {
		chatStore,
		engine,
		modelId: modelIdOf(engine),
		kind,
		systemPromptTokens,
		failedRequestTokens,
		windowTokens: recoveryWindowTokens(lastOverflowText(record.messages), contextWindowFor(engine), failedRequestTokens),
		notice,
	};
}

/** The plain explanations that replace a rejection recovery could not fix. */
export const overflowExplanation = {
	stillTooLong: (model: string) => `This chat is still too long for ${model}, even after condensing its older part. Start a new session, or pick a model with a larger context window.`,
	backgroundOff: (model: string) => `This chat grew too long for ${model}. Condensing it automatically needs background use for this connection: turn background use on, or press Repair this chat.`,
	notCondensed: (model: string) => `This chat grew too long for ${model} and could not be condensed automatically. Press Repair this chat to condense it.`,
};

/** Rewrite the chat's trailing rejection into a plain explanation, built
 *  from the provider's own text every time (never nested). Unrecoverable
 *  marks it so Repair is no longer offered. */
export function explainOverflow(chatStore: ChatStore, chatId: string, explanation: string, unrecoverable: boolean): void {
	const record = chatStore.getChat(chatId);
	const failed = record?.messages.at(-1);
	if (!record || failed?.role !== "assistant" || contextOverflowState(failed) === null) return;
	const providerText = overflowProviderText(failed) ?? "";
	Object.assign(failed, {
		errorMessage: `${explanation} (${providerText})`,
		contextOverflow: unrecoverable ? { providerText, unrecoverable: true } : { providerText },
	});
	chatStore.saveMessages(chatId, record.messages);
	emit("record-changed", { chatId });
}

/** One recovery compaction. The caller holds the compaction gate
 *  (holdCompactionGate). */
export async function recoverContext(deps: RecoveryDeps, chatId: string): Promise<RecoveryOutcome> {
	const record = deps.chatStore.getChat(chatId);
	if (!record) return "unchanged";
	const messages = record.messages;
	// The cut walks what precedes the trailing rejections: cutting AT one
	// would push the learner's last message into the summary.
	let end = messages.length;
	while (end > 0 && contextOverflowState(messages[end - 1]) !== null) end--;
	const base = messages.slice(0, end);
	const previous = activeCompactionOf(messages);
	const floor = previous ? Math.max(keptIndexFor(messages, previous), 0) : 0;

	const fit = Math.floor(deps.windowTokens * RECOVERY_FILL);
	const budget = Math.max(fit - deps.systemPromptTokens, 0);
	const topic = lessonTopic(record);
	const markerAt = (cut: number, body: string) => {
		const details: CompactionDetails = {
			firstKeptMessageId: messages[cut]!.id,
			tokensBefore: deps.failedRequestTokens,
			model: deps.modelId,
			at: new Date().toISOString(),
			notice: deps.notice,
		};
		return newCompactionMarker(`${topic}\n\n${body}`, details);
	};
	// The next request: system prompt + the marker (the summary head) + the kept tail.
	const fits = (marker: LhMarkerMessage, cut: number) =>
		deps.systemPromptTokens + estimateMessageTokens(marker) + estimateTokens(messages.slice(cut)) <= fit;
	const cutFor = (keep: number) => {
		const cut = compactionCutIndex(base, Math.max(Math.floor(keep), 1));
		return cut > floor && cut < base.length ? cut : null;
	};

	emit("compaction-changed", { chatId, running: true });
	try {
		// The model summary: half the budget for the kept tail, half for the
		// summary; the summarizer's own request is clipped to the window too
		// (it runs on the same over-window model), oldest transcript first.
		const cut = cutFor(budget / 2);
		if (cut !== null) {
			const planTreeText = planTreeToText(record.tree, messages);
			const kind = deps.kind;
			const maxWords = Math.max(Math.floor((budget / 2) * 0.6), 50);
			const room = fit * 4 - buildCompactionPrompt({ spanText: "", planTreeText, kind, maxWords }).length;
			if (room > 0) {
				try {
					const summarize = deps.summarize ?? subagentSummarizer;
					const spanText = summarySpan(messages, cut, room);
					const { summary, usage } = await summarize(buildCompactionPrompt({ spanText, planTreeText, kind, maxWords }), deps.engine);
					const marker = summary.trim() ? markerAt(cut, summary.trim()) : null;
					if (marker && fits(marker, cut)) {
						saveCompactionMarker(deps, chatId, messages, marker, usage);
						return "summarized";
					}
				} catch (err) {
					console.error(`[chat ${chatId}] recovery summary failed:`, err);
				}
			}
		}
		// The deterministic fallback, never a model call: shorter kept
		// tails until the request fits; the smallest lands regardless.
		let fallback: LhMarkerMessage | null = null;
		for (const keep of [budget / 2, budget / 4, 1]) {
			const at = cutFor(keep);
			if (at === null) continue;
			fallback = markerAt(at, droppedSpanSummary(record, previous, base.slice(floor, at), Math.max((budget / 2) * 4, 1_000)));
			if (fits(fallback, at)) break;
		}
		if (!fallback) return "unchanged";
		saveCompactionMarker(deps, chatId, messages, fallback, null);
		return "truncated";
	} finally {
		emit("compaction-changed", { chatId, running: false });
	}
}
