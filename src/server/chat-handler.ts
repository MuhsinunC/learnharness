import type { Usage } from "@earendil-works/pi-ai";
import {
	createPracticeAgent,
	createProberAgent,
	createTeacherAgent,
	type AgentBuildOptions,
	type TeachingAgent,
} from "../agent/teacher-agent.ts";
import { piEngineForSpec, type PiEngine, type ResolvedModelSpec } from "../agent/models.ts";
import { connectionBackgroundAllowed, connectionScopeCurrent, isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { nativeSubscriptionError } from "../agent/subscription-stream.ts";
import { chatGPTStreamError } from "../agent/chatgpt-stream.ts";
import { SubscriptionRequestCycle, type SubscriptionDispatchLifecycle } from "../agent/subscription-request-cycle.ts";
import { reconstructRequestCause } from "../core/native-messages.ts";
import { createJobRunner } from "../agent/subagents/runner.ts";
import { createExtractionPipeline } from "../agent/subagents/extraction.ts";
import type { ModelRole } from "../../config.ts";
import {
	deliverJobResult,
	noteSteersDurable,
	reconcileUserSteers,
	registerLiveAgent,
	restoreUncommittedAutomatic,
	setJobRespawn,
	setTurnRunner,
	settleSteers,
	steerLiveChat,
	unregisterLiveAgent,
} from "./jobs.ts";
import { runPiTurn } from "./pi/ui-stream.ts";
import { collectToolCallIds } from "./pi/call-ids.ts";
import { providerEventNote } from "../agent/provider-events.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { imageInputRefusal, withImageSupport } from "./attachments.ts";
import { searchAvailable, searchProvider } from "./search.ts";
import { providerKeyPresent } from "./keys.ts";
import { bootClaudeCodeProvider } from "./claude-code-boot.ts";
import {
	extractionEnabled,
	graphToolsEnabled,
	resolveConversationSpec,
	resolveRoleSpec,
} from "../core/settings-resolution.ts";
import { contextWindowKey } from "../core/context-windows.ts";
import { ProviderKeyMissingError, ROLE_SLOT, modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope, type ProviderKeyMissing } from "../core/settings.ts";
import { beginTurn, endTurn, isTurnRunning } from "./turn-liveness.ts";
import { applyParkedDismissal } from "./dismissal-park.ts";
import { registerTurn, rememberTurnFailure, unregisterTurn } from "./turn-runs.ts";
import { persistTurn, triggerExtraction, TurnPersistenceError } from "./turn-service.ts";
import { hasProbeDone, danglingQuestionOf } from "../core/native-messages.ts";
import { awaitCompaction, ensureCompacted, kickCompaction, effectiveThresholdTokens, holdCompactionGate, keepRecentTokensFor, noteRequestPrefix, sessionKind } from "./compaction.ts";
import { condensable, contextWindowFor, explainOverflow, learnStatedLimit, overflowExplanation, recoverContext, recoveryAttempted, recoveryDeps } from "./context-recovery.ts";
import { contextOverflowState } from "../core/context-overflow.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { emit } from "../core/events.ts";
import { settledTurnResponse } from "./turn-runs.ts";
import { asAgentMessages } from "../core/native-messages.ts";
import {
	ChatInputError,
	inputAppends,
	parseChatInput,
	type TurnInput,
} from "../core/input-events.ts";
import { steerDelivered } from "../core/contracts.ts";
import type {CallUsage} from "../core/contracts.ts";

/**
 * One chat turn over the server-owned native record. Framework-free (plain
 * Request/Response) so tests can drive it directly with a scripted faux
 * engine — the Next route handler in app/api/chat is a one-line wrapper.
 *
 * THE INPUT-EVENTS CONTRACT (Wave B, owner ruling 2026-09-26): POST /api/chat
 * carries {chatId, input} — one explicit event (text / answer / verdict /
 * continue), never a client transcript. The server owns the record; this
 * module is the TURN COMPOSITION ROOT: it turns the event into native
 * record appends (core/input-events.ts), builds the agent from the record
 * (the record IS the agent state — state.messages = record.messages,
 * continue()), and runs the turn as a background object (pi/ui-stream.ts).
 * Wake-pipeline steers ride the same composition (TurnInput's steer kind).
 *
 * THE SAME COMPOSITION serves both entry points: client requests and the
 * wake pipeline's server-side steers (src/server/jobs.ts) — one code path
 * for write-ahead persistence, turn liveness, and the turn services.
 */

bootClaudeCodeProvider();

function settlementErrorText(error: unknown): string {
	return error instanceof TurnPersistenceError ? error.message : "An error occurred.";
}

const jobRunner = createJobRunner({
	chatStore: stores.chatStore,
	jobStore: stores.jobStore,
	deliver: deliverJobResult,
	// BYOK (owner, 2026-09-22): job engines resolve the chain — role
	// override → slot → NOTHING — read FRESH per job (a settings PUT
	// between dispatch and spawn lands); an empty chain flows through as
	// undefined and the runner refuses the spawn honestly.
	engineFor: (role) =>
		resolveEngine(role),
	// Key-presence gate (provider-key interlude, 2026-09-25): the runner
	// reads the resolved engine's provider and asks THIS check (the agent
	// layer may not read the key store); a missing key refuses the spawn
	// with the 503-envelope family instead of dying mid-run.
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
	// The auth fallback (LH-37) honors a subscription's background consent.
	backgroundAllowed: connectionBackgroundAllowed,
	// Search port wave (2026-09-20): the researcher's web_search runs on the
	// injected port — resolved FRESH per job (key rotations land immediately).
	// null = honestly unavailable; the dispatch-level drop (below) uses the
	// same signal so keyless servers never see the research tool at all.
	searchProvider,
});
/** The app's ONE extraction pipeline instance — both front doors share it:
 *  quiz-triggered session runs (turn-service) and notes imports
 *  (/api/graph/import) hit the same single-flight registry. */
export const extraction = createExtractionPipeline({
	...stores,
	// BYOK (owner, 2026-09-22): the extraction stages resolve the chain —
	// role override → slot → NOTHING — read FRESH per stage call; an empty
	// chain flows through as undefined and the pipeline refuses the run
	// with the typed ModelsNotConfiguredError. Direct test values still win.
	engineFor: (role) =>
		resolveEngine(role),
	// Key-presence gate (provider-key interlude, 2026-09-25): same check
	// the job runner gets — a stage engine whose provider key is gone
	// refuses BEFORE any batch runs (the typed throw), never mid-run.
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
	// The auth fallback (LH-37), same consent gate as the job runner.
	backgroundAllowed: connectionBackgroundAllowed,
});


// Wake-pipeline wiring (contracts.ts "THE ASYNC PROTOCOL" §4): the pipeline
// delivers its steers through THIS composition root (one event: the steer
// marker, appended natively under the turn claim), and crash recovery
// re-spawns orphaned sub-agent loops through THIS runner.
setTurnRunner(async (chatId, input) => {
	const res = await handleChatInput(chatId, input);
	// Drive the stream to completion server-side — nobody else will read it,
	// and onFinish (persist, extraction, endTurn) only runs when it drains.
	await res.arrayBuffer().catch(() => undefined);
	return res.status;
});
/** The settings-resolved engine for one role — BYOK (owner, 2026-09-22):
 *  the chain (role override → slot → NOTHING) may end empty, and undefined
 *  flows through to the per-need refusal gates (runner/extraction), read
 *  FRESH so a settings PUT between dispatch and spawn lands. */
function resolveEngine(role: ModelRole): PiEngine | undefined {
	const record = stores.settingsStore.readSettings();
	const spec = resolveRoleSpec(role, record);
	if (spec && !providerKeyPresent(spec.provider)) {
		throw new ProviderKeyMissingError(spec.provider, [ROLE_SLOT[role]]);
	}
	return spec ? piEngineForSpec(withContextWindow(spec, record)) : undefined;
}

/** The spec with its pair's custom context window (LH-38) and the limit
 *  its provider stated (LH-40), from the same settings read that resolved
 *  it — every engine built here carries the window, capped at that limit
 *  (LH-50), so the engine model, pi-ai's max-tokens clamp and the
 *  compaction trigger agree. */
function withContextWindow(
	spec: ResolvedModelSpec,
	settings: { contextWindows?: Record<string, number>; learnedContextLimits?: Record<string, number> } | null | undefined,
): ResolvedModelSpec {
	const key = contextWindowKey(spec.provider, spec.id);
	const contextWindow = settings?.contextWindows?.[key];
	const contextLimit = settings?.learnedContextLimits?.[key];
	return {
		...spec,
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(contextLimit !== undefined ? { contextLimit } : {}),
	};
}

setJobRespawn((jobId) => void jobRunner.runJob(jobId));

/**
 * CONTEXT-OVERFLOW RECOVERY (LH-40, docs/context-recovery.md): the turn
 * just persisted ended in a length rejection. Compact toward the window
 * the provider enforces, under the compaction gate, then retry the turn
 * ONCE as a continue. A retry that overflows again (the guard reads the
 * record) or a record with nothing to drop gets a plain explanation.
 */
function recoverFromOverflow(
	chatId: string,
	conversation: NonNullable<ReturnType<typeof resolveConversationSpec>>,
	buildAgent?: (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent,
): void {
	const record = stores.chatStore.getChat(chatId);
	if (!record || contextOverflowState(record.messages.at(-1)) !== "repairable") return;
	// Every path ends in a learner-visible outcome: a recovered reply or a
	// plain explanation (Repair stays offered unless nothing can help).
	const explain = (text: (model: string) => string, model: string, unrecoverable = false) =>
		explainOverflow(stores.chatStore, chatId, text(model), unrecoverable);
	// Learn first, for the model that was rejected: the summarizer's
	// engine then runs at the stated limit.
	learnStatedLimit(conversation, record.messages);
	// The spec is resolved afresh, as Repair does (LH-55): a window or
	// model changed during the turn applies to the recovery.
	const fresh = effectiveSettings();
	const spec = resolveConversationSpec(record.settings, fresh.models.strong);
	if (!spec) return explain(overflowExplanation.notCondensed, conversation.id);
	let engine: PiEngine;
	try { engine = piEngineForSpec(withContextWindow(spec, fresh), true); }
	catch { return explain(overflowExplanation.notCondensed, spec.id); }
	const modelName = engine.model.name || engine.model.id;
	const deps = recoveryDeps(stores.chatStore, record, engine, `This chat had grown too long for ${modelName}; I condensed the older part and continued.`);
	// The prompt and tool declarations alone leave no room (LH-55): no
	// condensing can help, so the history stays as it is.
	if (!deps.prefixFits) return explain(overflowExplanation.stillTooLong, modelName, true);
	// The retry failed too: unrecoverable only when nothing is left to
	// condense; otherwise Repair stays offered (LH-50).
	if (recoveryAttempted(record.messages)) {
		return condensable(deps, record.messages)
			? explain(overflowExplanation.retryFailed, modelName)
			: explain(overflowExplanation.stillTooLong, modelName, true);
	}
	if (!connectionBackgroundAllowed(spec.provider)) return explain(overflowExplanation.backgroundOff, modelName);
	const recover = () => holdCompactionGate(chatId, () => recoverContext(deps, chatId));
	void (async () => {
		// A compaction already holding the gate: wait for it (bounded), once.
		let run = recover();
		if (!run) {
			await Promise.race([awaitCompaction(chatId), new Promise((resolve) => setTimeout(resolve, GATE_WAIT_MS))]);
			run = recover();
		}
		if (!run) return explain(overflowExplanation.notCondensed, modelName);
		if ((await run) === "unchanged") return explain(overflowExplanation.stillTooLong, modelName, true);
		const res = await handleChatInput(chatId, { type: "continue" }, buildAgent);
		await res.arrayBuffer().catch(() => undefined);
	})().catch((err) => {
		console.error(`[chat ${chatId}] overflow recovery failed:`, err);
		explain(overflowExplanation.notCondensed, modelName);
	});
}

/** How long overflow recovery waits for a compaction already holding the gate. */
const GATE_WAIT_MS = 30_000;

/** POST /api/chats/[id]/repair — "Repair this chat": the same recovery,
 *  on the learner's request, for a chat whose last reply failed for
 *  length; saved, and the learner sends again. */
export async function handleRepairRequest(chatId: string): Promise<Response> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (isTurnRunning(chatId)) return Response.json({ error: "A turn is running for this session. Try again when it ends." }, { status: 409 });
	// Only a chat whose last reply was rejected for length: a healthy chat
	// has no stated limit to aim at, and a repaired one ends in its marker.
	const state = contextOverflowState(record.messages.at(-1));
	if (state !== "repairable") {
		const error = state === "unrecoverable"
			? "This chat cannot be condensed any further. Start a new session, or pick a model with a larger context window."
			: "This chat is not broken: its last reply did not fail for length.";
		return Response.json({ error }, { status: 409 });
	}
	const spec = resolveConversationSpec(record.settings, effectiveSettings().models.strong);
	if (!spec) return Response.json(modelsNotConfigured(["strong"]), { status: 503 });
	learnStatedLimit(spec, record.messages);
	// Read after learning: the engine runs at the stated limit.
	let engine: PiEngine;
	try { engine = piEngineForSpec(withContextWindow(spec, effectiveSettings()), false); }
	catch { return Response.json({ error: "The selected model is unavailable." }, { status: 503 }); }
	const modelName = engine.model.name || engine.model.id;
	const deps = recoveryDeps(stores.chatStore, record, engine, `This chat had grown too long for ${modelName}; I condensed the older part.`);
	if (!deps.prefixFits) {
		explainOverflow(stores.chatStore, chatId, overflowExplanation.stillTooLong(modelName), true);
		return Response.json({ error: "Condensing cannot help: the instructions and tools alone fill this model's context window." }, { status: 422 });
	}
	const run = holdCompactionGate(chatId, () => recoverContext(deps, chatId));
	if (!run) return Response.json({ error: "This session is already being condensed. Try again in a moment." }, { status: 409 });
	if ((await run) === "unchanged") {
		explainOverflow(stores.chatStore, chatId, overflowExplanation.stillTooLong(modelName), true);
		return Response.json({ error: "Nothing older in this chat can be condensed." }, { status: 422 });
	}
	return Response.json({ ok: true });
}

/** The route-facing entry: parse {chatId, input} and run one turn. */
export async function handleChatRequest(
	req: Request,
	buildAgent?: (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent,
): Promise<Response> {
	let body: { chatId?: unknown; input?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const chatId = typeof body.chatId === "string" ? body.chatId : "";
	if (!chatId) return Response.json({ error: "Unknown chat" }, { status: 404 });
	let input: TurnInput;
	try {
		input = parseChatInput(body.input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
	return handleChatInput(chatId, input, buildAgent);
}

/**
 * The turn composition: one input event → native record appends → one
 * agent turn as a background object. Also the wake pipeline's entry
 * (TurnInput's steer kind appends the marker under the same claim).
 */
export async function handleChatInput(
	chatId: string,
	input: TurnInput,
	buildAgent?: (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent,
): Promise<Response> {
	let record = stores.chatStore.getChat(chatId);
	if (!record) {
		return Response.json({ error: "Unknown chat" }, { status: 404 });
	}

	// THE UNIVERSAL TURN GATE (BYOK, owner, 2026-09-22): a turn needs the
	// CONVERSATION chain — the chat's own model override over the strong
	// slot — and there is no factory floor; when both are empty the turn
	// refuses honestly with the machine-readable 503 envelope (new sessions
	// and continuing ones alike — wake-pipeline turns ride this same path).
	// Placement is deliberate: BEFORE beginTurn (no liveness effects), the
	// write-ahead persist (nothing durable changes), and every downstream
	// resolution (jobs/extraction gate per-need on their own tiers).
	const effective = effectiveSettings();
	const resolved = resolveConversationSpec(record.settings, effective.models.strong);
	if (!resolved) {
		const envelope = modelsNotConfigured(["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}
	const conversation = withContextWindow(resolved, effective);

	// THE KEY-PRESENCE GATE (provider-key interlude, owner, 2026-09-25): a
	// pinned model is not enough — its PROVIDER's key must be present, or
	// the turn dies mid-stream masked to a generic error. Truth is env-first
	// (providerKeyPresent reads what pi-ai would read at request time), so
	// an env-shadowed key passes. Same placement discipline as the models
	// gate: BEFORE beginTurn (no liveness effects) and the write-ahead
	// persist (nothing durable changes); wake-pipeline turns ride the same
	// path. The affected tier is strong — the conversation chain's own tier
	// (a chat.model override still resolves through it).
	if (isSubscriptionProvider(conversation.provider)) {
		await refreshConnectionCatalog(conversation.provider);
		if (input.type === "steers" && !connectionBackgroundAllowed(conversation.provider)) {
			return Response.json({ error: "Background use is off for this connection. Automatic follow-up remains deferred in its queue." }, { status: 403 });
		}
	}
	if (!providerKeyPresent(conversation.provider)) {
		const envelope = providerKeyMissingEnvelope(conversation.provider, ["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	// THE COMPACTION GATE (owner round 14, 2026-10-05 — the structural
	// ruling: NOTHING model-facing for this chat interleaves with a
	// running compaction): await any in-flight compaction (the settle
	// kick usually finished inside the learner's answer pause), and if
	// the record is STILL over threshold, compact synchronously — this
	// request waits. Skipped under tests (the extraction precedent);
	// placement mirrors the BYOK/key gates — BEFORE appends and
	// beginTurn, no liveness effects — and the record re-reads after
	// because compaction appends the marker.
	const callPurpose = { background: input.type === "steers" || (input.type === "continue" && reconstructRequestCause(record.messages) !== "foreground") };
	let requestCycle: SubscriptionRequestCycle | undefined;
	const lifecycle: SubscriptionDispatchLifecycle = {
		captured: (scope) => requestCycle?.captured(scope),
		beforeDispatch: (scope) => requestCycle?.beforeDispatch(scope),
		noDispatch: (kind) => requestCycle?.noDispatch(kind),
	};
	let conversationEngine: PiEngine;
	try { conversationEngine = piEngineForSpec(conversation, () => callPurpose.background, lifecycle); }
	catch { return Response.json({ error: conversation.provider === "chatgpt" ? chatGPTStreamError("model catalog") : isSubscriptionProvider(conversation.provider) ? nativeSubscriptionError(conversation.provider, "model catalog") : "The selected model is unavailable." }, { status: 503 }); }
	// THE IMAGE GATE (LH-39): the learner's override reaches the Model
	// (pi-ai keys image handling on model.input), and a send with images
	// for a model that can't take them refuses before anything persists.
	conversationEngine = withImageSupport(conversationEngine);
	const imageRefusal = input.type === "text" ? imageInputRefusal(conversationEngine.model, input.attachments) : null;
	if (imageRefusal) return imageRefusal;
	const modelIdForCompaction = `${conversationEngine.model.provider}:${conversationEngine.model.id}`;
	// The window seam (LH-40): never above a limit the provider stated.
	const compactionWindow = contextWindowFor(conversationEngine);
	await ensureCompacted(
		{
			chatStore: stores.chatStore,
			engine: piEngineForSpec(conversation, true),
			canStart: () => connectionBackgroundAllowed(conversation.provider),
			modelId: modelIdForCompaction,
			kind: sessionKind(record),
			thresholdTokens: effectiveThresholdTokens(effective.compaction?.thresholdTokens, compactionWindow, conversationEngine.model.maxTokens),
			keepRecentTokens: keepRecentTokensFor(compactionWindow),
		},
		chatId,
	);
	const compactedRecord = stores.chatStore.getChat(chatId);
	if (!compactedRecord) return Response.json({ error: "Unknown chat" }, { status: 404 });
	record = compactedRecord;

	// The input's native appends (pure; the honest 400 for an answer with no
	// pending question call). Computed BEFORE beginTurn so a refused input
	// leaves no liveness effects; read against the CURRENT record. Wave C:
	// the idle wake carries EVERY queued marker (steerDelivered filters a
	// re-fire of an already-landed one) - with claimSteers gone, this wake
	// input is the only steer appender; in-run delivery rides pi's own
	// follow-up queue and never builds an input event at all.
	let appends;
	try {
		appends =
			input.type === "steers"
				? input.steers.filter((s) => !steerDelivered(record.messages, s.id))
				: inputAppends(record, input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}

	// THE PARALLEL-QUESTION GATE (owner, 2026-10-03 — the deepseek parallel
	// batch incident): an answer that leaves a SIBLING question dangling
	// defers its wake. The dock advances to the next question (the client's
	// optimistic result + record-changed carry the view); the LAST answer
	// fires the one reaction turn with every result ADJACENT to its calling
	// assistant message — the provider shape law (a tool result appended
	// after an intervening assistant message is rejected, which stranded
	// the sibling question permanently pre-fix). Nothing else can generate
	// while a question dangles (job wakes wait, continuation folds refuse,
	// the composer gates), so adjacency holds by construction.
	if (input.type === "answer" && danglingQuestionOf([...record.messages, ...appends]) !== null) {
		const merged = [...record.messages, ...appends];
		try { stores.chatStore.saveMessages(chatId, merged); }
		catch (err) {
			console.error(`[chat ${chatId}] write-ahead persist failed:`, err);
			return new Response("Your input could not be saved. Please try again.", { status: 500 });
		}
		emit("record-changed", { chatId });
		return settledTurnResponse(); // the cheap terminal — no beginTurn, no turn
	}

	// One turn per chat, ever. A second request while a turn runs means a
	// stale/remounted client raced a live one — letting it through would
	// double-run the teacher and clobber the first turn's persist.
	if (!beginTurn(chatId)) {
		console.info(`[chat ${chatId}] turn already in flight — request rejected`);
		return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
	}

	// Write-ahead persistence: the input's native appends go on disk BEFORE
	// the turn starts - the learner's answer is durable the instant the
	// request arrives, and any remount, second tab, or server crash reads
	// truth instead of the pre-answer record. (Wave C: the wake's markers
	// ride this same write-ahead - the pump de-queued them at fire, so this
	// is the ONLY copy ever appended.)
	const merged = [...record.messages, ...appends];
	const stagedAutomatic = isSubscriptionProvider(conversation.provider) && input.type === "steers";
	let persistBaseCount = stagedAutomatic ? record.messages.length : merged.length;
	try {
		if (!stagedAutomatic) stores.chatStore.saveMessages(chatId, merged);
	} catch (err) {
		console.error(`[chat ${chatId}] write-ahead persist failed:`, err);
		endTurn(chatId);
		return new Response("Your input could not be saved. Please try again.", { status: 500 });
	}
	// Visibility bookkeeping is not the canonical save. Its failure must
	// neither misreport a saved input as lost nor prevent the turn running.
	try {
		if (!stagedAutomatic) noteSteersDurable(chatId, merged);
	} catch (err) {
		console.error(`[chat ${chatId}] input visibility bookkeeping failed:`, err);
	}

	// MONEY CHANNEL (wave 4): one collector per request, fed by the agent's
	// message_end events. Every model call's usage lands in the chat record's
	// append-only turns log at onFinish — idempotent per turn id.
	const turnUsageId = crypto.randomUUID();
	const steps: CallUsage[] = [];
	const collectUsage = (usage: Usage) => {
		steps.push({
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
			// Optional in pi's Usage — persisted as 0, never dropped.
			reasoningTokens: usage.reasoning ?? 0,
		});
	};

	// AGENT CONSTRUCTION BRANCH (docs/probe-teach-split.md §2): the transcript
	// is the seam — a probe_done call in the record means the probe is
	// concluded: build the TEACHER (planning + the full toolset). Otherwise
	// the session is still probing: build the PROBER (quiz/ask + probe_done).
	// Both share this whole composition (write-ahead persist, liveness,
	// steers, usage, extraction) — only the agent differs.
	const teaching = hasProbeDone(merged);
	// BYOK (owner, 2026-09-22): the conversation chain was resolved by the
	// turn gate above (chat.model override → strong slot → refused) — the
	// engine build is pure from here; thinking levels clamp natively.
	// (Built once above the compaction gate; reused verbatim.)
	const engine = conversationEngine;
	// Provider-qualified stamp (model slots wave): matches the price table's
	// provider:id keys.
	const modelId = `${engine.model.provider}:${engine.model.id}`;
	// Tests inject a factory: the agent is stateless per turn, so each
	// request builds a fresh one off the record — the factory mirrors that
	// seam exactly. Wave B: the record IS the agent state (native messages;
	// the record's id field strips at the wire in toLlmMessages).
	// CROSS-STREAM SEAM (P2 reconciliation, 2026-09-19): `toolToggles`
	// rides the build opts as the user-level DELTA map (absent key =
	// enabled). The definitive toggleable set is TOGGLEABLE_TOOLS — the
	// sub-agent JOB tools (research/demo/visual/pdf; adjudicated with the
	// user: quiz/ask/fs/plan/probe_done are always-on).
	if (isSubscriptionProvider(conversation.provider)) requestCycle = new SubscriptionRequestCycle({
		initialMessages: asAgentMessages(merged),
		staged: stagedAutomatic ? asAgentMessages(appends) : undefined,
		foregroundOwed: !callPurpose.background,
		purpose: callPurpose,
		scopeCurrent: (scope) => connectionScopeCurrent(conversation.provider, scope),
		commitStaged: () => {
			stores.chatStore.saveMessages(chatId, merged);
			persistBaseCount = merged.length;
			noteSteersDurable(chatId, merged);
		},
		restoreAutomatic: (automaticIds, retainedIds) => restoreUncommittedAutomatic(chatId, constructed, automaticIds, retainedIds),
	});
	const agentOpts: AgentBuildOptions = {
		engine,
		callPurpose,
		requestCycle,
		messages: asAgentMessages(merged),
		onUsage: collectUsage,
		toolToggles: effective.agent.tools,
		// Debug (owner, 2026-10-04): teacher/prober raw provider events under
		// LH_PROVIDER_EVENTS=1 (provider-events.ts); no-op otherwise.
		chatId,
		// The prompt-override switches (P2, 2026-09-19): same resolution
		// point as the tool delta — the agent layer composes the system
		// prompt fresh per turn, swapping in any enabled override segments.
		promptSwitches: effective.agent.prompts,
		attachments: stores.attachmentStore,
	};
	// PRACTICE BRANCH (owner design, 2026-10-04): a kind:"practice"
	// session builds the practitioner from turn 1 — no prober→teacher
	// split, no plan/question/job tools; the whole registry is
	// problem + conclude. buildAgent stays honored (the test seam is
	// uniform across kinds).
	const constructed: TeachingAgent = buildAgent
		? buildAgent({ ...agentOpts, teaching })
		: record.kind === "practice"
			? createPracticeAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						// TARGET VALIDATION (owner round 9): the practice tools read the
						// WHOLE graph fresh per pose — targets validate against every
						// proposition, not just the session's picks (pickless sessions
						// and future graph-tools poses stay valid).
						graphNodes: () => stores.graphStore.readNodes(),
						// THE RARELY-NEEDED SET (owner round 10): research + pdf jobs
						// (same runner/gating as the teacher's — research honestly
						// absent when no engine is live) and the map readers behind
						// the SAME settings gate as the prober's.
						jobs: {
							chatId,
							jobStore: stores.jobStore,
							spawn: (job, input) => void jobRunner.runJob(job.id, input),
							searchAvailable,
						},
						...(graphToolsEnabled(effective) ? { graph: { chatStore: stores.chatStore, graphStore: stores.graphStore } } : {}),
					},
					agentOpts,
				)
			: teaching
			? createTeacherAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						jobStore: stores.jobStore,
						spawn: (job, input) => void jobRunner.runJob(job.id, input),
						// The registry drop's signal (2026-09-20): no live engine
						// = no research tool in the teacher's registry.
						searchAvailable,
					},
					agentOpts,
				)
			: createProberAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						deliver: (steer) => void deliverJobResult(steer),
						// Fix wave (2026-09-20): the prober carries research + pdf
						// dispatch (owner ruling — phase-omnipresent), so its ctx
						// needs the same job wiring as the teacher's.
						jobStore: stores.jobStore,
						spawn: (job, input) => void jobRunner.runJob(job.id, input),
						searchAvailable,
						// The map reader (wave 7): the prober reads the learner's
						// knowledge graph through tools when the gate opens —
						// graph master switch AND the agent.graphTools toggle.
						...(graphToolsEnabled(effective) ? { graphStore: stores.graphStore } : {}),
					},
					agentOpts,
				);

	// What every request of this chat carries before its messages: the
	// threshold counts it and an overflow recovery fits with it (LH-50).
	noteRequestPrefix(chatId, constructed.state.systemPrompt, constructed.state.tools);

	// A test-injected agent gets no usage collector (tests assert the
	// transcript, not the money channel); when it's ours, usage flows through
	// the factory's subscription (wired above via onUsage).
	try {
		// THE TURN AS A BACKGROUND OBJECT (owner ruling, 2026-09-25):
		// runPiTurn executes decoupled from this response — the POST stream
		// is just the FIRST subscriber (a view). A client disconnect can no
		// longer abort the turn; the remote kill is the abort channel, and
		// late views reattach via GET /api/chats/[id]/stream.
		// Wave C (owner correction, 2026-09-26 — steering): register the live
		// agent BEFORE runPiTurn — the loop's start steering-poll drains the
		// queue SYNCHRONOUSLY inside that call, so a later registration would
		// miss it. Registration also steers any pending registry markers into
		// this run: a marker parked behind a just-answered quiz rides THIS
		// run's first LLM call (the native replacement for continuation
		// coalescing). Settlement still cannot beat the flow below: it needs
		// a streamed response, which never happens inside the constructor.
		registerLiveAgent(chatId, constructed, input.type !== "steers" && input.type !== "continue",
			input.type === "steers" ? new Set(appends.map((message) => message.id)) : undefined);
		// Debug recorder run marker (owner, 2026-10-04): correlates the
		// JSONL event stream with the record's turns; no-op unless
		// LH_PROVIDER_EVENTS=1.
		providerEventNote(chatId, "turn", `run start (base: ${merged.length} messages)`);
		const handle = runPiTurn({
			agent: constructed,
			requestCycle,
			// The coalescing window seam (COMPACTION LAW, 2026-10-09): tests
			// tighten it via LH_UPDATE_FLUSH_MS; production rides the 100ms
			// default in ui-stream.
			...(process.env.LH_UPDATE_FLUSH_MS ? { updateFlushMs: Number(process.env.LH_UPDATE_FLUSH_MS) } : {}),
			// THE LACAN FIX (2026-10-04): seed the uniquifier with every
			// tool-call id the record already holds — a provider that resets
			// ids per response (DeepSeek) then gets fresh unique ids for this
			// turn's calls at the wire boundary, on the wire, in the record,
			// and in the next turn's context alike.
			usedToolCallIds: new Set(collectToolCallIds(merged)),
			// Stream-level failures are provider/transport internals — masked,
			// like the SDK defaults. Tool-input validation messages never
			// route through here: they ride the error-result path and reach the
			// transcript directly (the retry context the model saw).
			onError: (error) => {
				if (conversation.provider === "chatgpt") return chatGPTStreamError(String(error));
				if (isSubscriptionProvider(conversation.provider)) return nativeSubscriptionError(conversation.provider, String(error));
				console.error(`[chat ${chatId}] turn error:`, error);
				return "An error occurred.";
			},
			onSettleError: settlementErrorText,
			onSettleFailure: (error, reportedErrorText) => {
				// POST only acknowledges acceptance; the submitter may attach
				// after this turn has already failed and left the registry.
				rememberTurnFailure(chatId, reportedErrorText ?? settlementErrorText(error));
				endTurn(chatId);
				unregisterTurn(chatId);
				unregisterLiveAgent(chatId);
				// The canonical save may have succeeded before later bookkeeping
				// threw. Reconcile against actual durability, never replay input
				// merely because usage/extraction/other settlement work failed.
				const persisted = stores.chatStore.getChat(chatId)?.messages ?? [];
				reconcileUserSteers(chatId, persisted);
				settleSteers(chatId, persisted, true, constructed);
			},
			onFinish: (turnMessages, isAborted) => {
				// Wave B: the record write is the agent's own final state —
				// the new messages are the slice past the merged base.
				const stamped = persistTurn(stores.chatStore, chatId, persistBaseCount, turnMessages, isAborted);
				noteSteersDurable(chatId, stores.chatStore.getChat(chatId)?.messages ?? stamped);
				// usage log append (idempotent per turn id) — the stats bar
				// refolds this on the client after the turn settles. The
				// provenance message is the turn's FIRST new assistant message.
				const response = stamped.find((m) => (m as { role?: string }).role === "assistant");
				if (response && steps.length > 0) {
					stores.chatStore.appendTurnUsage(chatId, {
						id: turnUsageId,
						messageId: response.id,
						at: new Date().toISOString(),
						model: modelId,
						steps,
					});
				}
				// GRAPH GATE (settings-storage wave, 2026-09-19): the write channel —
				// extraction, its auditor — dies with the master switch.
				// PRACTICE (owner, 2026-10-04): practice sessions write nothing —
				// no extraction, no graph, no coverage (v1: the session itself
				// is the deliverable).
				if ((!requestCycle || requestCycle.dispatched) && record.kind !== "practice" && extractionEnabled(effective.graph)) {
					// Fresh per-turn read of the graph section's chunk budget
					// (extraction-UX redesign, 2026-09-24): the trigger compares
					// against it and the pipeline's batches share it.
					triggerExtraction(stores, extraction, chatId, effective.graph.extractionChunkTokens);
				}
				// PARKED DISMISSAL (owner, 2026-10-04): a dismissal that arrived
				// mid-turn was parked by the dismiss route (202); now that
				// persistTurn has landed the turn's messages, apply it against
				// real truth — BEFORE endTurn, so "turn-settled" guarantees a
				// subsequent fetch reads the dismissal already in the record
				// (the same ordering law as persistTurn itself).
				applyParkedDismissal(stores.chatStore, chatId);
				// OVERFLOW RECOVERY (LH-40): takes the compaction gate before
				// endTurn, so nothing model-facing slips in ahead of the repair.
				if (process.env.NODE_ENV !== "test" && !isAborted) recoverFromOverflow(chatId, conversation, buildAgent);
				// LAST: a poller that sees not-in-flight must read an already-persisted
				// record — endTurn only after persistTurn has done its job.
				endTurn(chatId);
				// And only then does the turn stop being a running object
				// (background-turn wave, 2026-09-25): a reattach that finds
				// nothing must find the persisted record current — the same
				// ordering rule as endTurn.
				unregisterTurn(chatId);
				// Wave C steer settlement: the live agent is dead (no more
				// followUp handoffs) - reconcile the steer registry against
				// what this run actually persisted (in-run injections
				// resolve; stranded markers return to pending), then let
				// the pump take any stragglers down the idle wake.
				unregisterLiveAgent(chatId);
				settleSteers(chatId, stamped, false, constructed);
				// Composer steers (2026-10-03): delivered ids dropped, stranded
				// ones stay parked for the chat's next run (the registry is the
				// stranding safety net — the agent's undrained copy died above).
				reconcileUserSteers(chatId, stamped);
				// THE SETTLE KICK (owner round 14): the turn settled — if the
				// projection is now over threshold, the summary starts in the
				// background, INSIDE the learner's reading/answering pause
				// (question/problem poses end runs, so this moment is always a
				// between-runs window). The next turn's ensureCompacted gate
				// awaits whatever this leaves running; a lost engine or a
				// beneath-threshold record is a silent no-op. Skipped under
				// tests (the extraction precedent — scripted chats are
				// fixtures; the service itself is pinned directly).
				if (process.env.NODE_ENV !== "test" && (!requestCycle || requestCycle.dispatched))
					kickCompaction(() => {
						const fresh = effectiveSettings();
						const spec = resolveConversationSpec(stores.chatStore.getChat(chatId)?.settings, fresh.models.strong);
						if (!spec || !connectionBackgroundAllowed(spec.provider)) return null;
						let kickEngine: PiEngine;
						try { kickEngine = piEngineForSpec(withContextWindow(spec, fresh), true); } catch { return null; }
						const kickModelId = `${kickEngine.model.provider}:${kickEngine.model.id}`;
						const freshRecord = stores.chatStore.getChat(chatId);
						if (!freshRecord) return null;
						return {
							chatStore: stores.chatStore,
							engine: kickEngine,
							canStart: () => connectionBackgroundAllowed(spec.provider),
							modelId: kickModelId,
							kind: sessionKind(freshRecord),
							thresholdTokens: effectiveThresholdTokens(fresh.compaction?.thresholdTokens, contextWindowFor(kickEngine), kickEngine.model.maxTokens),
							keepRecentTokens: keepRecentTokensFor(contextWindowFor(kickEngine)),
						};
					}, chatId);
			},
		});
		// The turn is now a live background object: register it so any view
		// can reattach (GET /api/chats/[id]/stream) or remotely abort it
		// (POST /api/activity/abort, kind "turn"). Registration after the
		// runPiTurn call is race-free: the agent loop only ticks in later
		// microtasks, so settle (and thus unregister) cannot beat us here.
		registerTurn(chatId, handle);
		// CONNECTION DIET B (owner, 2026-10-10 — the parallel-session freeze
		// postmortem): the POST no longer holds the turn's SSE stream open for
		// its whole duration. It acknowledges acceptance and CLOSES; the
		// submitter attaches through GET /api/chats/[id]/stream — the same
		// universal reattach wire a returning visitor uses. The browser's
		// 6-connections-per-origin pool is the scarce resource: a submission
		// must cost zero permanently-held slots beyond the one live view. The
		// turn itself is a server-side process (ruling 2026-09-25) — it never
		// needed this connection, only a view did.
		if (stagedAutomatic && requestCycle && !(await requestCycle.admission)) return Response.json({ error: "Automatic follow-up remains deferred in its queue." }, { status: 403 });
		return Response.json({ ok: true });
	} catch (err) {
		// The stream never started, so no onFinish will fire — clear the registry
		// or a malformed request would lock the chat until the TTL eviction.
		endTurn(chatId);
		// Wave C: the live-agent registration (if it happened) dies with the
		// turn here too - nothing was handed (the loop never ticked).
		unregisterLiveAgent(chatId);
		console.error(`[chat ${chatId}] turn failed to start:`, err);
		return Response.json({ error: "Failed to start the turn" }, { status: 500 });
	}
}
