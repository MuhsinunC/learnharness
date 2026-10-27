# Context-overflow recovery

## The problem

The threshold compaction fires at `min(settings threshold, contextWindow − 16k)`
(`src/server/compaction.ts`). If the window the app believes in is larger than
the one the provider enforces, for example 1.5M left on for a 128k model, the
chat grows past the real limit before the threshold is reached. Every turn after
that is rejected for length, and the chat is broken.

## Options considered

1. **Summarize and replace.** Summarize the older span and keep a recent tail.
   This is what the app already does at the threshold. It keeps the most
   meaning. It needs a model call, and that call runs on the same model whose
   window was just exceeded.
2. **Tail truncation with a running summary.** Drop the older span
   deterministically and keep a written record of it. No model call, so it
   always terminates. It loses nuance.
3. **Rebuild from the transcript.** Re-derive the context from durable state
   (plan tree, graph, the learner's own lines) instead of the chat. It is the
   most robust, but it would need a second, parallel summary format.

## What other agents do

- **Pi coding agent 1.4.0** (`dist/core/agent-session.js`, `_checkCompaction`,
  the source the app's compaction port comes from). On a context-overflow
  error (`isContextOverflow` from pi-ai) it omits the failed reply, compacts,
  and retries the turn once (`_overflowRecoveryAttempted`). A second overflow
  ends with "Context overflow recovery failed after one compact-and-retry
  attempt. Try reducing context or switching to a larger-context model."
- **Codex** (`codex-rs/core/src/compact.rs`). If the compaction request itself
  overflows, Codex drops the oldest history items and tries again, trimming
  from the start "to preserve cache (prefix-based) and keep recent messages
  intact". It keeps about 20k tokens of recent user messages
  (`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`). The trigger is
  `model_auto_compact_token_limit`, and `model_context_window` overrides the
  window ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
- **Claude Code** ([how it works](https://code.claude.com/docs/en/how-claude-code-works),
  [troubleshooting](https://code.claude.com/docs/en/troubleshooting),
  [errors](https://code.claude.com/docs/en/errors)). It compacts automatically
  near the limit. When a request is rejected for input plus `max_tokens`, it
  first retries with a smaller `max_tokens`, then "stops retrying and compacts
  instead". "Prompt is too long" (and Bedrock's "Input is too long for
  requested model") triggers auto-compact; a failed one surfaces as "Prompt
  is too long · automatic compaction failed: …". When compaction cannot keep
  up, it stops with a thrashing error rather than looping. `/compact` (with
  an optional focus) is the manual repair.

## The choice

Pi's shape, with Codex's clipping and option 2 as the fallback
(`src/server/context-recovery.ts`):

- **Detect.** A turn's last message is an assistant error that
  `isContextOverflow` matches (pi-ai), or one that
  `src/core/context-overflow.ts` matches. The second covers "maximum context
  length" and "input is too long" without pi's extra qualifiers, plus a 413.
- **Target.** Use the limit the error states ("maximum context length is N",
  Anthropic's "… > N maximum", and others). Otherwise use the known window
  from `contextWindowFor`, but never more than half the request that failed,
  because the known window is exactly what may be wrong. A recovered request
  may fill 60% of the target. The rest is left for tool declarations, the
  reply's `max_tokens`, and the error in the chars/4 estimate. Fit is measured
  by chars/4 over the projection. The usage anchor is not used, because it
  describes the last request that succeeded.
- **Compact.** First, one model summary: half the budget for the kept tail,
  half for the summary, which carries a word cap. The summarizer's own input
  is clipped to the target, oldest text first, as in Codex. If the summary
  fails, comes back empty, or still doesn't fit, a deterministic marker
  follows. It holds the lesson topic, the plan tree verbatim, and the
  learner's dropped lines, and shorter tails are tried until it fits. Every
  marker starts with "Current lesson topic: …".
- **Retry once.** The retry is a `continue` turn. The guard is read from the
  record: the active marker is a recovery marker (`details.notice`) and no
  reply has succeeded since it. A second overflow, or a chat with nothing to
  drop, turns the provider error into a plain explanation. Nothing runs
  after that.
- **Notice.** `details.notice` is shown in the transcript in place of
  "Context compacted": "This chat had grown too long for \<model\>; I condensed
  the older part and continued."
- **Manual repair.** "Repair this chat" sits in the error banner for a
  length error and in the session menu. It calls
  `POST /api/chats/[id]/repair`, which runs the same compaction toward the
  limit stated in the chat's length error. It refuses (409) unless the
  chat's last message is that error, so it never compacts a working chat
  and a second click is a no-op.
- **Learning state.** Nothing is deleted. The rejected reply stays in the
  record; pi drops errored replies on the wire. Full history stays behind
  the marker, which keeps the transcript-derived plan progress and
  extraction coverage intact. The plan tree, graph and job stores are not
  touched. The recovery holds the compaction gate, so no turn interleaves.

## The window seam (LH-38)

Recovery reads the window only through `contextWindowFor(engine)` in
`src/server/context-recovery.ts`, which returns `engine.model.contextWindow`.
`piEngineForSpec` applies LH-38's per-(provider, model) custom window there,
so it is the user's value when set and the catalog default otherwise. It
also covers providers with no key, which `catalogContextLimits()` skips.
Recovery still trusts the provider's stated limit over it. The threshold
compaction keeps reading the same custom window, so until the user corrects
it, an over-window chat hits the limit and recovers again every few turns.
Persisting the limit a rejection states, per model, would stop that; it is
not done here.
