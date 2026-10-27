# Per-model context windows

The window is set per (provider, model) pair in two places. The composer's
model menu shows the active model's window, so a model that isn't in any slot
can be edited too. Settings → Agent → Context has one **Context window** row
for each distinct slot model. Both use the same field and the same modal. The
thinking level doesn't affect the window.

- **Default** is the catalog window, which is pi-ai's `contextWindow` for the model.
- **Maximum** is the known working limit from
  `src/core/context-windows.ts` (`KNOWN_MAX_CONTEXT_WINDOWS`). When the table
  has no entry for the pair, Maximum equals Default.
- Enter or **Save** commits the value. An empty field resets the pair to Default.
- A value above Maximum opens a confirm modal. **Confirm** stays disabled until
  the "I know what I'm doing" box is checked. **Cancel** or Esc keeps the
  stored value.
- `PUT /api/settings/context-windows` refuses an above-maximum value with
  409 `above_maximum` unless `confirmAboveMax: true` is set. The generic
  `PUT /api/settings/[section]` route can't write the map at all.
- The value is stored in `settings.json` under `contextWindows`, keyed `provider:id`.

## Where the window is used

| Consumer | Path |
|---|---|
| Composer footer "used / window" | `/api/models` `contextWindow` (custom over default) → `catalogLimits` → stats bar |
| Compaction trigger, `min(threshold, window − 16k)` | `catalogContextLimits()` in `src/server/model-catalog.ts` |
| Activity dock job limits | `catalogContextLimits()` |
| Engine model, and pi-ai's max-tokens clamp (`window − context − 4096`) | `setContextWindowLookup` → `piEngineForSpec` in `src/agent/models.ts`; native subscription transports carry it across (`src/agent/subscription-stream.ts`). The claude-code stream has no max-tokens surface |

With the default 150k threshold, a window **above** the default doesn't move
the compaction trigger. Only a window below about 166k lowers it. To compact
later on a bigger window, raise Settings → Agent → Context → Compaction
threshold as well.

## Where "272k" came from

ChatGPT models in LearnHarness are copies of pi-ai's **`openai`** catalog
entries (`refreshChatGPTModels` in `src/agent/chatgpt-bridge.ts`, fed
`piModels().getModels("openai")`). pi-ai 1.4.0's `openai.json` gives
`gpt-6.1-sol` `contextWindow: 272000`.

pi-ai's separate `openai-codex` catalog lists `gpt-6.1-sol` at 500000, but this
app doesn't read that catalog. pi-ai 1.4.0's `openai` data also has no
`gpt-6.1-terra`, so the ChatGPT bridge drops that model today. The table row
for ChatGPT + gpt-6.1-terra only takes effect once pi-ai adds the model.

## Known maxima (sources)

| Pair | Default | Maximum | Source |
|---|---|---|---|
| chatgpt:gpt-6.1-sol | 272k | 872k | Codex CLI 0.160.0 bundled model catalog, `max_context_window` (upstream value) |
| chatgpt:gpt-6.1-terra | (not in pi-ai 1.4.0) | 872k | Local Codex catalog entry cloned from gpt-6.1-sol. Not measured separately |
| chatgpt:gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol | 272k | 920k | Upstream catalog says 872k. Raised to 920k after a context-limit bisection through the Codex backend on a subscription login: about 920.9k input tokens accepted, about 922k rejected (2026-09-26) |
| chatgpt:gpt-5.6-terra, gpt-5.6-luna | 272k | 872k | Codex CLI bundled catalog, `max_context_window` |
| openai:gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna | 272k | 1.05M | OpenAI API model pages: "1,050,000 context window". Prompts above 272K input tokens are billed at 2x input and 1.5x output ([gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [gpt-6-sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [gpt-6-astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [gpt-5.6-sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [gpt-5.6-terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [gpt-5.6-luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), checked 2026-10-27) |
| anthropic:claude-fable-5-1, fable-5, opus-5-5, opus-5, opus-4-8, opus-4-7, opus-4-6, sonnet-5-5, sonnet-5, sonnet-4-6, haiku-5-5 | 1M | 1M | pi-ai `contextWindow`, matching [Anthropic's context-window docs](https://platform.claude.com/docs/en/build-with-claude/context-windows): "have a 1M-token context window … 1M is the default: you don't need a beta header" (checked 2026-10-27) |
| anthropic:claude-opus-4-5, sonnet-4-5, haiku-4-5 | 200k | 200k | Same docs: "Other Claude models, including Claude Sonnet 4.5 (deprecated), have a 200k-token context window" |
| claude-code:claude-fable-5-1, fable-5, opus-5-5, opus-5, opus-4-8, opus-4-7, sonnet-5 | 1M | 1M | `claudeCodeCatalog` in `src/agent/claude-code/models.ts`: `MEASURED_ONE_M` ids run as `<id>[1m]` |
| claude-code:claude-opus-4-6, sonnet-4-6 | 200k | 200k | Same file: these run at 1M only on the Max plan (opus-4-6) or with long-context extra usage (`PLAN_GATED_ONE_M`). The fork's settings are `plan: "pro"` with no extra usage, so the CLI runs the plain id at 200k |
| claude-code:claude-sonnet-5-5, haiku-5-5, opus-4-5, sonnet-4-5, haiku-4-5 | 200k | 200k | Same file: not in either 1M table, so the CLI runs the plain id at 200k, even though the API model supports 1M (sonnet-5-5, haiku-5-5) |
| every other pair (OpenRouter, ...) | pi-ai `contextWindow` | = Default | No documented higher limit found |

The Codex catalogs also give `effective_context_window_percent: 95`. LearnHarness
doesn't apply that factor, and its own 16k compaction reserve plays a similar role.

### Caveats

- **Claude Code (`claude-code`).** The window the CLI actually runs comes from
  the model id it's given (`claudeCodeModelId`: `<id>` for 200k, `<id>[1m]`
  for 1M), and this setting doesn't change that id. The claude-code stream
  also ignores max tokens (`src/agent/claude-code/stream.ts`). So a custom
  claude-code window moves only LearnHarness's own budget: the footer and the
  compaction trigger. That's why Maximum = Default there, and a value above it
  goes through the warning modal. To let a 200k claude-code model run at 1M,
  the `[1m]` tables have to change; this setting can't do it.

- LearnHarness sends ChatGPT requests to `https://api.openai.com/v1` with the
  subscription token (`src/agent/chatgpt-stream.ts`). The Codex maxima above
  were measured or published for Codex's own backend. Nobody has measured them
  on this transport.
- OpenAI's help center says ChatGPT Work and Codex use a 500k default window
  for GPT-6.1 Sol. That matches pi-ai's `openai-codex` entry, but the page
  couldn't be fetched to quote it.

## Extending

Add a `"provider:id": tokens` row to `KNOWN_MAX_CONTEXT_WINDOWS`. A pair with
no row gets Maximum = Default.
