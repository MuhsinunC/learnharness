/**
 * CONTEXT-OVERFLOW RECOVERY (LH-40, docs/context-recovery.md): a chat
 * whose request the provider rejects for length — typically because the
 * configured window is larger than the model's real one, so the threshold
 * compaction never fired — is compacted toward the window the provider
 * actually enforces, then the turn is retried ONCE (chat-handler). The
 * learner's "Repair this chat" action runs the same compaction.
 *
 * Nothing is ever deleted: the rejected reply stays in the record (pi
 * drops errored assistants on the wire), and full history stays behind a
 * compaction marker exactly as the threshold run leaves it. The plan tree,
 * graph and job stores are never touched. The marker's details.notice is
 * the learner-facing line, and marks the marker as a recovery.
 *
 * Shape of a recovery: one model summary sized for the target window; if
 * that fails, comes back empty, or still does not fit, a deterministic
 * marker (lesson topic, plan tree verbatim, the learner's dropped lines)
 * with a progressively shorter kept tail. Fit is judged by chars/4 over
 * the projection — never the usage anchor, which describes the last
 * request that SUCCEEDED.
 */

import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	activeCompactionOf,
	buildCompactionPrompt,
	compactionCutIndex,
	derivePlanStatusesLh,
	derivedNodeStatus,
	estimateTokens,
	hasProbeDone,
	isContextOverflowText,
	keptIndexFor,
	newCompactionMarker,
	planTreeToText,
	reportedContextLimit,
	toLlmMessages,
	type ChatRecord,
	type CompactionDetails,
	type LhMarkerMessage,
	type LhMessage,
} from "../core/index.ts";
import { emit } from "../core/events.ts";
import { catalogContextLimits } from "./model-catalog.ts";
import { composeInstructions } from "../agent/teacher-agent.ts";
import type { ChatStore } from "../core/ports.ts";
import { holdCompactionGate, saveCompactionMarker, subagentSummarizer, summarySpan, type CompactionDeps } from "./compaction.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured } from "../core/settings.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/** THE WINDOW SEAM: the context window this app believes a model has
 *  (`provider:id`). LH-38's per-(provider, model) setting plugs in here;
 *  recovery reads the window through nothing else. */
export function contextWindowFor(modelId: string): number | undefined {
	return catalogContextLimits().get(modelId);
}

/** Share of the target window a recovered request may fill: the rest is
 *  the tool declarations, the reply's max_tokens, and chars/4's error. */
const RECOVERY_FILL = 0.6;

/** Per-line cap for the learner's dropped lines in the fallback marker. */
const FALLBACK_LINE_CHARS = 300;

export function isContextOverflowMessage(message: LhMessage | undefined): message is AssistantMessage & LhMessage {
	if (message?.role !== "assistant" || message.stopReason !== "error") return false;
	return isContextOverflow(message as AssistantMessage) || isContextOverflowText(message.errorMessage);
}

/** Recovery already ran for this overflow: the active marker is a
 *  recovery marker and no reply has succeeded since. The one-retry guard —
 *  read from the record, so it holds across restarts and entry points. */
export function recoveryAttempted(messages: readonly LhMessage[]): boolean {
	const active = activeCompactionOf(messages);
	if (!active?.details.notice) return false;
	return !messages
		.slice(messages.indexOf(active) + 1)
		.some((m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted");
}

/** The newest context-length rejection in the record (its text may state the real limit). */
export function lastOverflowError(messages: readonly LhMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (isContextOverflowMessage(m)) return m.errorMessage;
	}
	return undefined;
}

/** What the next request would carry, by chars/4 over the projection. */
function requestTokens(messages: readonly LhMessage[], systemPromptTokens: number): number {
	return estimateTokens(toLlmMessages(messages as readonly AgentMessage[]) as unknown as readonly LhMessage[]) + systemPromptTokens;
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

/** The deterministic marker body: what the record states for certain
 *  about the dropped span, clipped to the summary's share. */
function droppedSpanSummary(record: ChatRecord, dropped: readonly LhMessage[], maxChars: number): string {
	const learner = dropped
		.filter((m) => m.role === "user")
		.map((m) => {
			const text = typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join(" ");
			return `- ${text.length > FALLBACK_LINE_CHARS ? `${text.slice(0, FALLBACK_LINE_CHARS)}…` : text}`;
		});
	const text = [
		"The older part of this session was dropped to fit the model's context window; no model summary could be written. What the record states for certain:",
		"## The plan dependency tree",
		planTreeToText(record.tree, record.messages) ?? "No plan tree exists in this session.",
		"## What the learner said in the dropped part (newest last)",
		learner.length ? learner.join("\n") : "Nothing.",
	].join("\n\n");
	return text.length > maxChars ? `${text.slice(0, maxChars)}…[truncated]` : text;
}

export interface RecoveryDeps extends Omit<CompactionDeps, "thresholdTokens" | "canStart"> {
	/** The window to fit (recoveryWindowTokens). */
	windowTokens: number;
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
	const modelId = `${engine.model.provider}:${engine.model.id}`;
	const kind = record.kind === "practice" ? "practice" : hasProbeDone(record.messages) ? "teach" : "probe";
	// The prompt the retried turn will actually carry (the threshold run's
	// teacher-prompt approximation is 2.6x the prober's: too coarse here).
	const systemPromptTokens = Math.ceil(composeInstructions(kind === "teach" ? "teacher" : kind === "probe" ? "prober" : "practice").length / 4);
	return {
		chatStore,
		engine,
		modelId,
		kind,
		systemPromptTokens,
		windowTokens: recoveryWindowTokens(
			lastOverflowError(record.messages),
			contextWindowFor(modelId),
			requestTokens(record.messages, systemPromptTokens),
		),
		notice,
	};
}

/** Recovery could not help: rewrite the newest rejection into a plain
 *  explanation (the provider's text stays in parentheses). Never retries. */
export function explainUnrecoverable(chatStore: ChatStore, chatId: string, modelName: string): void {
	const record = chatStore.getChat(chatId);
	const failed = record?.messages.at(-1);
	if (!record || !isContextOverflowMessage(failed)) return;
	failed.errorMessage = `This chat is still too long for ${modelName}, even after condensing its older part. Start a new session, or pick a model with a larger context window. (${failed.errorMessage})`;
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
	while (end > 0 && isContextOverflowMessage(messages[end - 1])) end--;
	const base = messages.slice(0, end);
	const previous = activeCompactionOf(messages);
	const floor = previous ? Math.max(keptIndexFor(messages, previous), 0) : 0;

	const fit = Math.floor(deps.windowTokens * RECOVERY_FILL);
	const budget = Math.max(fit - deps.systemPromptTokens, 0);
	const tokensBefore = requestTokens(messages, deps.systemPromptTokens);
	const topic = lessonTopic(record);
	const markerAt = (cut: number, body: string) => {
		const details: CompactionDetails = {
			firstKeptMessageId: messages[cut]!.id,
			tokensBefore,
			model: deps.modelId,
			at: new Date().toISOString(),
			notice: deps.notice,
		};
		return newCompactionMarker(`${topic}\n\n${body}`, details);
	};
	const fits = (marker: LhMessage) => requestTokens([...messages, marker], deps.systemPromptTokens) <= fit;
	const cutFor = (keep: number) => {
		const cut = compactionCutIndex(base, Math.max(Math.floor(keep), 1));
		return cut > floor && cut < base.length ? cut : null;
	};

	emit("compaction-changed", { chatId, running: true });
	try {
		// The model summary: half the budget for the kept tail, half for the
		// summary; the summarizer's own request is clipped to the window too
		// (it runs on the same over-window model), oldest text first.
		const cut = cutFor(budget / 2);
		if (cut !== null) {
			const planTreeText = planTreeToText(record.tree, messages);
			const kind = deps.kind;
			const maxWords = Math.max(Math.floor((budget / 2) * 0.6), 50);
			const room = fit * 4 - buildCompactionPrompt({ spanText: "", planTreeText, kind, maxWords }).length;
			if (room > 0) {
				const span = summarySpan(messages, cut);
				const spanText = span.length > room ? `…[older part omitted]\n\n${span.slice(-room)}` : span;
				try {
					const summarize = deps.summarize ?? subagentSummarizer;
					const { summary, usage } = await summarize(buildCompactionPrompt({ spanText, planTreeText, kind, maxWords }), deps.engine);
					const marker = summary.trim() ? markerAt(cut, summary.trim()) : null;
					if (marker && fits(marker)) {
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
			fallback = markerAt(at, droppedSpanSummary(record, base.slice(floor, at), Math.max((budget / 2) * 4, 1_000)));
			if (fits(fallback)) break;
		}
		if (!fallback) return "unchanged";
		saveCompactionMarker(deps, chatId, messages, fallback, null);
		return "truncated";
	} finally {
		emit("compaction-changed", { chatId, running: false });
	}
}

/** POST /api/chats/[id]/repair — "Repair this chat": the same recovery,
 *  on the learner's request, saved; the learner sends again. */
export async function handleRepairRequest(chatId: string): Promise<Response> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (isTurnRunning(chatId)) return Response.json({ error: "A turn is running for this session" }, { status: 409 });
	const spec = resolveConversationSpec(record.settings, effectiveSettings().models.strong);
	if (!spec) return Response.json(modelsNotConfigured(["strong"]), { status: 503 });
	let engine: PiEngine;
	try { engine = piEngineForSpec(spec, false); }
	catch { return Response.json({ error: "The selected model is unavailable." }, { status: 503 }); }
	const notice = `This chat had grown too long for ${engine.model.name || engine.model.id}; I condensed the older part.`;
	const run = holdCompactionGate(chatId, () => recoverContext(recoveryDeps(stores.chatStore, record, engine, notice), chatId));
	if (!run) return Response.json({ error: "This session is already compacting" }, { status: 409 });
	const outcome = await run;
	if (outcome === "unchanged") return Response.json({ error: "Nothing older in this chat can be condensed." }, { status: 422 });
	return Response.json({ ok: true, outcome });
}
