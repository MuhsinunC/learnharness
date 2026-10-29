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
  A request the app held back (see "The reply's room") carries
  `heldBack: true` instead of provider-shaped text: it is an overflow for
  recovery, but it has no provider text, and no limit is learned from it.
- **Target.** Use the limit the error states ("maximum context length is N",
  Anthropic's "… > N maximum", and others). After a held-back request, use
  the window from `contextWindowFor`, which it was measured against.
  Otherwise use that window, but never more than half the request that
  failed, because that window is exactly what may be wrong. Fit is judged
  as the wire request will be (LH-50): the system prompt and tool declarations, the
  new marker and the kept tail, plus the reply's room (see "The reply's
  room"), all at pi-ai's chars/3.5, must stay within the target. The
  prompt, declarations, marker and tail fill only 0.8 of what the reply's
  room leaves (LH-55): a provider may count 15-20% more than chars/3.5
  (the OB-0645 live check measured OpenRouter's pre-flight count at about
  1.18x; see "The reply's room" for the request margin). When the margin
  leaves no room but the held-back floor itself still does, the retry gets
  that whole room rather than none, so recovery never drops the whole
  history. A rejection's stated limit counts only while the rejection is
  in force: given by the model the recovery runs on (pi-ai stamps provider
  and model on every reply) and newer than the user's last window save for
  that pair (one of unknown age counts as older). Otherwise the target is
  the known window, and when nothing needs dropping there Repair just
  answers ok (the chat already fits). The target never exceeds the known
  window either, so a custom window below the stated limit is what
  recovery aims at. The fallback cuts down to the last message alone only
  as a last resort, for a rejection in force when no larger tail can be
  cut. The prompt and
  declarations are the chat's last turn's, measured as pi-ai sends them
  (the declarations, not the tool objects) when its agent is built. They
  are kept in memory and dropped with the chat; with no turn since boot,
  the kind's composed prompt and every tool its registry can hold stand in
  (an over-count of the gated tools). The failed request is measured once.
  The usage anchor is not used, because it describes the last request that
  succeeded.
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
  when nothing older is left to condense or the system prompt and tool
  declarations alone would be held back (`condensable`, the held-back
  floor; a recovery whose full reply room is gone fits under that floor
  instead); otherwise it says "…after condensing its older
  part once. Press Repair this chat…" and Repair stays offered (LH-50: the
  failure may have come from an output budget, which a Repair can fix).
- **Never silent.** When recovery cannot run, the rejection becomes a plain
  explanation that keeps Repair offered: background use off for the
  connection ("turn background use on, or press Repair this chat"), no
  engine, or a compaction still holding the gate after a 30-second wait.
  When the system prompt and tool declarations alone would be held back
  under the target (`floorFitTokens <= 0`: no room under the held-back
  floor even without the margin), recovery and Repair explain at once
  that the chat is still too long, mark it unrecoverable and leave its
  history as it is (LH-55): no marker, no retry. Recovery resolves its spec afresh,
  as Repair does, so a window or model changed during the turn applies.
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

The limit a provider's rejection states is saved per `provider:id` in
settings, under `learnedContextLimits`, its own key (a held-back request
states none, so it never sets or overwrites one): the user's
`contextWindows` value and the context-window modal are untouched. Every engine built after that runs
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
field's caption adds "Provider limit: N (saving a new value clears it)" when
that limit is below the configured window; the field itself keeps the
user's value. Saving the field for a pair, a value or a reset to the
Default, forgets that pair's learned limit (LH-55): the user's word on the
window replaces it. The save time is kept per pair
(`learnedLimitsClearedAt`), and only a rejection newer than it, from the
pair's own model, teaches a limit again or sets recovery's target, so
Repair on the chat whose old rejection taught the limit neither writes it
back nor condenses toward it. Re-saving the value already stored sends
nothing, hence "a new value".
Before LH-55 a learned limit capped the engine window for good, and raising
the custom window did nothing.

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
`outputReserveTokens(window, maxTokens)` is the model's max output plus
pi-ai's 4096, at least pi's 16,384 and at most a quarter of the window
plus 4096. The threshold compaction fires at
`min(settings threshold, window − that reserve)`, so a request at the
threshold still gets that much output, and a recovery's whole request fits
`window − reserve` (see Target).

The threshold measures the next request the way pi-ai's clamp and the
held-back floor below measure it (`projectedContextTokens`): the usage
anchor plus the messages after it at chars/3.5, or, with no anchor, every
message at chars/3.5 plus the noted system prompt and tool declarations.
Measured at chars/4 without the declarations, a chat could be held back
before the threshold fired (a 128k window with an 8,192 max output). The
16,384 floor keeps a gap between the threshold and the held-back floor
for the next learner message and the turn's tool round trips: with a max
output of 1,024 or less, the reply's room alone leaves none. Thresholds
(the default 150k setting):

| Window, max output | Threshold | Held back above |
| --- | --- | --- |
| 128,000, 8,192 | 111,616 | 122,880 |
| 200,000, 64,000 | 145,904 | 194,880 |
| 32,000, 1,024 (e2e) | 19,904 | 26,880 |

Before LH-50 a custom 1M window over a real
40,960 one (OpenRouter qwen/qwen3-14b, 16,384 max output) made every request
ask for 16,384: with gradual growth the first recovery fit, the next turns
were rejected again, and the chat ended unrecoverable; one huge paste's
recovery retry was rejected outright (`tests/e2e/output-budget.e2e.ts`
reproduces both).

The 4096 is pi-ai's flat margin under the window. A provider whose
pre-flight count runs above pi-ai's estimate gets a margin that scales with
the input instead (LH-54, `PREFLIGHT_OVERCOUNT` in `src/agent/models.ts`):
OpenRouter counted about 1.18x the tokens it billed, which matched pi-ai's
estimate, so its requests keep `max(4096, 0.2 × estimate)` free. With the
flat margin, every request between ~22.8k tokens and the threshold of a
learned 40,960 window was rejected and condensed
(`tests/e2e/recovery-margin.e2e.ts` (f)). pi-ai's margin is a constant,
so the extra goes to pi-ai as a window that much smaller, which every
API's max-tokens clamp reads. The reserve and the threshold above still
count the flat 4096, so on such a route a request just under the
threshold gets up to 20% of its input less than the model's max output.
Providers with no measured overcount (Baseten among them) keep 4096.

A request whose reply room (window − pi-ai's estimate − that margin)
would fall below min(1024, the model's max output) is never sent:
`piEngineForSpec`'s stream function holds it back as a length rejection
marked `heldBack` ("Not sent: the reply would have only R tokens of room in
this chat's N-token context window."). It is a last-resort guard: normal
growth reaches the threshold first. Overflow recovery then condenses the
chat and retries once; if the system prompt and tool declarations alone
leave no room, the chat says plainly that it is too long for the model.
The held-back text is the app's, never the provider's: it is not learned
as a limit, the explanation that replaces it carries no provider text,
and background jobs only show it as their failure. A request with
max_tokens near 1 would otherwise end the reply silently (the old LH-40 e2e regime: an 11,548
window, a 3.6k-token prompt and 3k of tool declarations).

## Transports

- **API-key providers (pi-ai APIs, OpenRouter, the e2e stub):** pi-ai's
  clamp sets max_tokens against the engine model's window, which carries the
  learned limit; length rejections pass through unchanged.
- **Subscription request cycle** (`src/agent/subscription-request-cycle.ts`,
  ChatGPT and native subscriptions): a held-back request is its own
  no-dispatch kind, `heldBack` (LH-55). It stays undispatched for admission,
  usage and background consent (no lease is taken, no usage is accepted,
  admission resolves false, staged automatic input goes back to its queue),
  but the view and the record keep the rejection, so recovery runs. A
  request whose only new input is automatic (a steer turn, no foreground
  work owed) is deferred like any denial instead: its input goes back to
  its queue and no rejection is kept, so redeliveries add none; the
  learner's next turn meets the same window and is recovered or explained
  once, with the deferred input riding that run. Before
  LH-55 it was an admission denial: the cycle dropped the rejection and the
  turn ended on the learner's message, with no reply and no Repair
  (`tests/e2e/subscription-held-back.e2e.ts`).
- **Native subscriptions** (`src/agent/subscription-stream.ts`): the
  transport model takes the engine model's window, so pi-ai's clamp uses the
  learned limit. A length rejection used to be replaced by the generic
  "request failed" line, so recovery never ran; it now keeps the provider's
  text.
- **ChatGPT** (`src/agent/chatgpt-stream.ts`): the payload carries no
  max_output_tokens (`chatGPTPayload` keeps a fixed key list), so no output
  clamp reaches the wire; the threshold reserve and the held-back floor still
  apply. A length rejection (for example `context_length_exceeded`) used to
  be masked the same way; it now keeps its text and recovery runs. Such a
  rejection states no limit, so recovery aims at half the failed request.
- **Claude Code** (`src/agent/claude-code/`): options.maxTokens has no SDK
  surface; the CLI picks its own output budget and runs its model id at the
  catalog window. The engine window (catalog, custom, or learned) still
  drives the threshold and the held-back floor. A CLI error result passes
  through as its own text: "prompt is too long" is recognised as a length
  rejection (and "N tokens > M maximum", when present, is learned); any
  other wording is a plain failure.
