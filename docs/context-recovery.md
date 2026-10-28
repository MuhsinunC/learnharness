# Context-overflow recovery

## The problem

The threshold compaction fires at `min(settings threshold, contextWindow − the reply's room)`
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

- **Detect.** One classification, `contextOverflowState` in
  `src/core/context-overflow.ts`, serves the server, the session list and the
  error banner. It is pi-ai's `isContextOverflow` (its pure `utils/overflow`
  module, so the client can use it too), plus "maximum context length" and
  "input is too long" without pi's extra qualifiers. A rejection the server
  has rewritten carries a `contextOverflow` mark (the provider's own text,
  and `unrecoverable` once Repair can no longer help), and the mark rules.
- **Target.** Use the limit the error states ("maximum context length is N",
  Anthropic's "… > N maximum", and others). Otherwise use the window from
  `contextWindowFor`, but never more than half the request that failed,
  because that window is exactly what may be wrong. Fit is judged as the
  wire request will be (LH-50): the system prompt and tool declarations, the
  new marker and the kept tail, plus the reply's room (see "The reply's
  room"), all at pi-ai's chars/3.5, must stay within the target. The prompt
  and declarations are the chat's last turn's, noted when its agent is built
  (in memory; with no turn since boot, the composed prompt alone). The
  failed request is measured once. The usage anchor is not used, because it
  describes the last request that succeeded.
- **Compact.** First, one model summary: half the budget for the kept tail,
  half for the summary, which carries a word cap. The summarizer's input is
  clipped to the target: the prior summary always rides whole, and only the
  raw transcript is trimmed, oldest text first, as in Codex. If the summary
  fails, comes back empty, or still doesn't fit, a deterministic marker
  follows. It holds the lesson topic, the prior summary verbatim (trimmed
  from its middle only if it alone exceeds the share), the plan tree, and the
  learner's dropped lines, each with its attached images' references (so
  `view_image` can still load them), and shorter tails are tried until it
  fits. Every
  marker starts with "Current lesson topic: …".
- **Retry once per episode.** The retry is a `continue` turn. The guard is
  read from the record: a recovery marker (`details.notice`) after the last
  successful reply means this episode already had its compact-and-retry,
  whatever threshold markers landed since. A chat with nothing to drop
  becomes "This chat is still too long for \<model\>…", built from the
  provider's text every time (never nested), and marked unrecoverable, so
  Repair is no longer offered. A second overflow is marked unrecoverable only
  when nothing older is left to condense or the system prompt alone exceeds
  the fit (`condensable`); otherwise it says "…after condensing its older
  part once. Press Repair this chat…" and Repair stays offered (LH-50: the
  failure may have come from an output budget, which a Repair can fix).
- **Never silent.** When recovery cannot run, the rejection becomes a plain
  explanation that keeps Repair offered: background use off for the
  connection ("turn background use on, or press Repair this chat"), no
  engine, or a compaction still holding the gate after a 30-second wait.
- **Notice.** `details.notice` is shown in the transcript in place of
  "Context compacted": "This chat had grown too long for \<model\>; I condensed
  the older part and continued."
- **Manual repair.** "Repair this chat" sits in the error banner and in the
  session menu, only for a repairable rejection. It calls
  `POST /api/chats/[id]/repair`, which runs the same compaction toward the
  limit stated in the chat's length error. It refuses (409) unless the
  chat's last message is a repairable rejection, so it never compacts a
  working chat and a second click is a no-op. Both surfaces show the
  route's reason when it refuses (409, 422, 503) or cannot be reached. A
  422 (nothing older to condense) also marks the chat unrecoverable.
- **Learning state.** Nothing is deleted. The rejected reply stays in the
  record; pi drops errored replies on the wire. Full history stays behind
  the marker, which keeps the transcript-derived plan progress and
  extraction coverage intact. The plan tree, graph and job stores are not
  touched. The recovery holds the compaction gate, so no turn interleaves.

## The learned limit

The limit a rejection states is saved per `provider:id` in settings, under
`learnedContextLimits`, its own key: the user's `contextWindows` value and
the context-window modal are untouched. Every engine built after that runs
at min(window, learned limit) (LH-50: the resolved spec's `contextLimit`), so
pi-ai's max-tokens clamp uses the real limit, and `contextWindowFor` returns
the same min, which the threshold compaction reads, so after one recovery
the threshold fires before the provider rejects again. Recovery and Repair
learn the limit before they build their engine, so the summarizer runs at it
too. For small windows the 20k kept tail scales down to a quarter of the
window, since it can exceed a learned 8k limit. The
threshold also estimates each kind's own system prompt (the prober's is about 40%
of the teacher's). The footer's "/ N" and the model menus show the window
that runs (`/api/models` `contextWindow` is capped at the learned limit,
which it also returns as `learnedContextLimit`), and the context-window
field's caption adds "Provider limit: N" when that limit is below the
configured window; the field itself keeps the user's value.

## The window seam (LH-38)

Recovery and the threshold compaction read the window only through
`contextWindowFor(engine)` in `src/server/context-recovery.ts`. It starts
from `engine.model.contextWindow`, which carries LH-38's per-(provider,
model) custom window (the resolved spec's `contextWindow`, set by
chat-handler's `withContextWindow`; the user's value when set, else the
catalog default), already capped at a learned limit (the spec's
`contextLimit`), and caps it at one learned since. The repair route
builds its engine the same way.

## The reply's room (LH-50)

Providers count the input plus the request's `max_tokens` against the
window. pi-ai asks for the model's max output, clamped to
`window − estimated context − 4096`, where the estimate covers the system
prompt and tool declarations (its usage anchor, or chars/3.5). Once the
engine's window is the real limit, that clamp keeps every request inside it,
so the budgets' job is to keep room for the reply:
`outputReserveTokens(window, maxTokens)` is the model's max output, at most a
quarter of the window, plus pi-ai's 4096. The threshold compaction fires at
`min(settings threshold, window − that reserve)`, so a request at the
threshold still gets that much output, and a recovery's whole request fits
`window − reserve` (see Target). Before LH-50 a custom 1M window over a real
40,960 one (OpenRouter qwen/qwen3-14b, 16,384 max output) made every request
ask for 16,384: with gradual growth the first recovery fit, the next turns
were rejected again, and the chat ended unrecoverable; one huge paste's
recovery retry was rejected outright (`tests/e2e/output-budget.e2e.ts`
reproduces both).
