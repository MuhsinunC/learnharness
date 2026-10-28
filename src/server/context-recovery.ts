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
 * judged as the wire request will be (LH-50): the system prompt and tool
 * declarations, the marker and kept tail, and the reply's room, all at
 * pi-ai's own chars/3.5 — never the usage anchor, which describes the
 * last request that SUCCEEDED. A request the app held back (LH-50) is an
 * overflow too, but no provider's statement: nothing is learned from it.
 */

import {
	activeCompactionOf,
	attachmentReferenceText,
	buildCompactionPrompt,
	COMPACTED_HISTORY_HEADER,
	compactionCutIndex,
	contextOverflowState,
	derivePlanStatusesLh,
	derivedNodeStatus,
	estimateMessageTokens,
	estimateTokens,
	heldBackRequest,
	keptIndexFor,
	newCompactionMarker,
	overflowProviderText,
	planTreeToText,
	reportedContextLimit,
	type ChatRecord,
	type CompactionDetails,
	type LhMarkerMessage,
	type LhMessage,
	type LhUserMessage,
} from "../core/index.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import {
	heuristicContextTokens,
	outputReserveTokens,
	requestPrefixTokens,
	saveCompactionMarker,
	sessionKind,
	subagentSummarizer,
	systemPromptTokensFor,
	summarySpan,
	type CompactionDeps,
} from "./compaction.ts";
import { CONTEXT_SAFETY_TOKENS, replyFloorTokens, type PiEngine } from "../agent/models.ts";
import { stores } from "./stores.ts";
import { updateSettings } from "../store/settings.ts";

const modelIdOf = (engine: PiEngine) => `${engine.model.provider}:${engine.model.id}`;

/** The limit providers stated for this model (`provider:id`), if any. */
function learnedContextLimit(modelId: string): number | undefined {
	return stores.settingsStore.readSettings()?.learnedContextLimits?.[modelId];
}

/** Remember the limit the chat's newest rejection states for its model —
 *  its own settings key, never the user's window. A held-back request
 *  has no provider text, so it never teaches a limit. */
export function learnStatedLimit(model: { provider: string; id: string }, messages: readonly LhMessage[]): void {
	const stated = reportedContextLimit(overflowProviderText(lastOverflow(messages)));
	const modelId = `${model.provider}:${model.id}`;
	if (!stated || learnedContextLimit(modelId) === stated) return;
	updateSettings((record) => ({ ...record, learnedContextLimits: { ...record.learnedContextLimits, [modelId]: stated } }));
}

/** THE WINDOW SEAM: the window this app may trust for the engine's
 *  model — LH-38's per-(provider, model) custom window when set (the spec
 *  carries it: chat-handler's withContextWindow), else the catalog
 *  default; never above a limit the provider has stated (the engine's
 *  own window already honours one learned before it was built; this
 *  read also covers one learned since). The threshold compaction and
 *  recovery both read it here. */
export function contextWindowFor(engine: PiEngine): number | undefined {
	const learned = learnedContextLimit(modelIdOf(engine));
	if (learned === undefined) return engine.model.contextWindow;
	return Math.min(engine.model.contextWindow ?? Infinity, learned);
}

/** pi-ai's estimate, the one its max-tokens clamp applies: chars/3.5,
 *  where this module's estimates count chars/4. */
const WIRE_CHARS_PER_TOKEN = 3.5;

/** The share of its room a recovery retry fills, the system prompt and
 *  tool declarations included (LH-55). The OB-0645 live check counted
 *  OpenRouter's pre-flight at about 1.18x the billed tokens, and pi-ai's
 *  flat 4,096-token margin absorbs that only below ~22.7k tokens once it
 *  clamps max_tokens to the window: 1/1.18 ≈ 0.85, less some headroom. */
const RETRY_FIT_SHARE = 0.8;

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

/** The newest length rejection (its provider text may state the real limit). */
function lastOverflow(messages: readonly LhMessage[]): LhMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (contextOverflowState(messages[i]) !== null) return messages[i];
	}
	return undefined;
}

/** The window to fit: the limit the rejection states; for a held-back
 *  request, the known window it was measured against (no provider
 *  contradicted it); otherwise the known window, but never more than
 *  half the request that just failed (the known window is exactly what
 *  may be wrong). */
export function recoveryWindowTokens(overflow: LhMessage | undefined, knownWindowTokens: number | undefined, failedRequestTokens: number): number {
	const stated = reportedContextLimit(overflowProviderText(overflow));
	if (stated) return stated;
	if (knownWindowTokens !== undefined && heldBackRequest(overflow)) return knownWindowTokens;
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
			// Attached images keep their ids, so the model can still
			// view_image them (LH-39).
			const images = ((m as LhUserMessage).attachments ?? []).map((ref) => ` ${attachmentReferenceText(ref)}`).join("");
			return `- ${text.length > FALLBACK_LINE_CHARS ? `${text.slice(0, FALLBACK_LINE_CHARS)}…` : text}${images}`;
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
	/** What the marker and the kept tail may fill, in wire tokens:
	 *  RETRY_FIT_SHARE of the window less the reply's room
	 *  (outputReserveTokens), less the system prompt and tool
	 *  declarations. At most 0 when those leave no room. */
	fitTokens: number;
	/** What they may fill before the request is held back: the same
	 *  share of the window less pi-ai's margin and the least reply room
	 *  (replyFloorTokens), less the prompt and declarations. At most 0
	 *  when nothing can be sent: the chat is explained, never condensed. */
	floorFitTokens: number;
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
	const windowTokens = recoveryWindowTokens(lastOverflow(record.messages), contextWindowFor(engine), failedRequestTokens);
	const prefixTokens = requestPrefixTokens(record.id, systemPromptTokens);
	return {
		chatStore,
		engine,
		modelId: modelIdOf(engine),
		kind,
		systemPromptTokens,
		failedRequestTokens,
		windowTokens,
		fitTokens: Math.floor(RETRY_FIT_SHARE * (windowTokens - outputReserveTokens(windowTokens, engine.model.maxTokens))) - prefixTokens,
		floorFitTokens: Math.floor(RETRY_FIT_SHARE * (windowTokens - CONTEXT_SAFETY_TOKENS - replyFloorTokens(engine.model.maxTokens))) - prefixTokens,
		notice,
	};
}

/** The plain explanations that replace a rejection recovery could not fix. */
export const overflowExplanation = {
	stillTooLong: (model: string) => `This chat is still too long for ${model}, even after condensing its older part. Start a new session, or pick a model with a larger context window.`,
	retryFailed: (model: string) => `This chat is still too long for ${model} after condensing its older part once. Press Repair this chat to condense it further, or start a new session.`,
	backgroundOff: (model: string) => `This chat grew too long for ${model}. Condensing it automatically needs background use for this connection: turn background use on, or press Repair this chat.`,
	notCondensed: (model: string) => `This chat grew too long for ${model} and could not be condensed automatically. Press Repair this chat to condense it.`,
};

/** Rewrite the chat's trailing rejection into a plain explanation, built
 *  from the provider's own text every time (never nested; a held-back
 *  request has none). Unrecoverable marks it so Repair is no longer
 *  offered. */
export function explainOverflow(chatStore: ChatStore, chatId: string, explanation: string, unrecoverable: boolean): void {
	const record = chatStore.getChat(chatId);
	const failed = record?.messages.at(-1);
	if (!record || failed?.role !== "assistant" || contextOverflowState(failed) === null) return;
	const providerText = overflowProviderText(failed);
	Object.assign(failed, {
		errorMessage: providerText === undefined ? explanation : `${explanation} (${providerText})`,
		contextOverflow: { ...(providerText !== undefined ? { providerText } : {}), ...(unrecoverable ? { unrecoverable: true } : {}) },
	});
	chatStore.saveMessages(chatId, record.messages);
	emit("record-changed", { chatId });
}

/** Where a recovery may cut: in what precedes the trailing rejections
 *  (cutting AT one would push the learner's last message into the
 *  summary), after the active marker's kept boundary. cutFor(keep) is
 *  null when no cut keeping `keep` tokens lies in between. */
function cutWithin(messages: readonly LhMessage[]) {
	let end = messages.length;
	while (end > 0 && contextOverflowState(messages[end - 1]) !== null) end--;
	const base = messages.slice(0, end);
	const previous = activeCompactionOf(messages);
	const floor = previous ? Math.max(keptIndexFor(messages, previous), 0) : 0;
	const cutFor = (keep: number) => {
		const cut = compactionCutIndex(base, Math.max(Math.floor(keep), 1));
		return cut > floor && cut < base.length ? cut : null;
	};
	return { base, previous, floor, cutFor };
}

/** Can a recovery still shrink this chat's request (LH-50)? Something
 *  older is left to condense, and the system prompt and tool declarations
 *  leave a request that is not held back. A failed retry alone is not
 *  hopeless — it may have overrun an output budget — so only a chat
 *  where this is false is marked unrecoverable. */
export function condensable(deps: RecoveryDeps, messages: readonly LhMessage[]): boolean {
	return deps.floorFitTokens > 0 && cutWithin(messages).cutFor(1) !== null;
}

/** One recovery compaction. The caller holds the compaction gate
 *  (holdCompactionGate). */
export async function recoverContext(deps: RecoveryDeps, chatId: string): Promise<RecoveryOutcome> {
	const record = deps.chatStore.getChat(chatId);
	if (!record) return "unchanged";
	const messages = record.messages;
	const { base, previous, floor, cutFor } = cutWithin(messages);

	// The marker and kept tail's share, in this module's chars/4 tokens:
	// the full reply's room when it exists, else what is not held back.
	const fit = deps.fitTokens > 0 ? deps.fitTokens : deps.floorFitTokens;
	const budget = Math.max(Math.floor((fit * WIRE_CHARS_PER_TOKEN) / 4), 0);
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
	// The next request's messages: the marker (the summary head) + the kept tail.
	const fits = (marker: LhMarkerMessage, cut: number) =>
		estimateMessageTokens(marker) + estimateTokens(messages.slice(cut)) <= budget;

	emit("compaction-changed", { chatId, running: true });
	try {
		// The model summary: half the budget for the kept tail, half for the
		// summary; the summarizer's own request is clipped to the same share
		// (it runs on the same over-window model), oldest transcript first.
		const cut = cutFor(budget / 2);
		if (cut !== null) {
			const planTreeText = planTreeToText(record.tree, messages);
			const kind = deps.kind;
			const maxWords = Math.max(Math.floor((budget / 2) * 0.6), 50);
			const room = budget * 4 - buildCompactionPrompt({ spanText: "", planTreeText, kind, maxWords }).length;
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
