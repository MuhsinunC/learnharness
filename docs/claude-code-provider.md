# Claude Code provider

This optional provider uses the owner's own Claude subscription through the official Claude Code binary. Personal use only. It is never on by default and has no setting, UI toggle, or default model slot. macOS and Linux only; Windows is refused.

## Enable

Set the CPA launcher path in the launch environment of `npm run dev` or `next start`:

```sh
LH_CLAUDE_CODE_EXECUTABLE=/Users/<you>/bin/claude npm run dev
```

A Finder-launched packaged app has no shell environment. Set the variable with launchctl, then fully relaunch the app:

```sh
launchctl setenv LH_CLAUDE_CODE_EXECUTABLE /Users/<you>/bin/claude
```

The value must be an absolute path to an executable regular file, supplied as a real environment variable. A value supplied only by `auth.json`, or set under `LH_IGNORE_ENV_KEYS=1`, is ignored with one log line that names the reason without exposing the path. The boot decision is cached until restart.

## Safety contracts

| Contract bullet | Code | Test |
|---|---|---|
| Requests go out as the official binary sends them, via `query()`; Claude Code's own preset | `src/agent/claude-code/stream.ts` is the only `query()` call site. Options come only from `query-options.ts` `buildQueryOptions`. `systemPrompt = {type: "preset", preset: "claude_code", append: lhPrompt}`. No fetch, headers, `executable` or `spawnClaudeCodeProcess` are set. | lh-2c: exact deep-equal snapshot. lh-2h: the fake `query()` gets exactly that object. A grep test checks that no file under `src/agent/claude-code/` contains `fetch(`, `transformHeaders`, `spawnClaudeCodeProcess` or `baseUrl:` with a non-empty value. |
| `settingSources: []`; strict MCP; claude.ai cloud MCP blocked | `buildQueryOptions` spreads caller inputs first, then forces `settingSources: []`, `strictMcpConfig: true`, `extraArgs["strict-mcp-config"] = null`, and `settings: {autoMemoryEnabled: false, includeGitInstructions: false, claudeMdExcludes: ["**/CLAUDE.md", "**/.claude/rules/**"]}`. The env has `ENABLE_CLAUDEAI_MCP_SERVERS=0`. | lh-2c: a caller that passes `settingSources: ["user"]`, `strictMcpConfig: false` or its own `extraArgs` is overridden. |
| `permissionMode "dontAsk"`; built-in tools off; only `mcp__custom-tools__*`; the app executes its own tools | Forced: `permissionMode: "dontAsk"`, `tools: []`, `allowedTools: ["mcp__custom-tools__*"]`. `mcpServers` is only `{"custom-tools": sdkServer}`. MCP handlers never call `AgentTool.execute`: they park until close. pi-agent-core executes LH tools. | lh-2d: a spy `execute` is never called and the handler settles only on close. lh-2h: a fake that would yield a second assistant turn after tool_use has `close()` called and nothing past `message_stop` forwarded. lh-2g: an unmapped `Bash` name is forwarded raw, and pi answers "not found". |
| Child env is the allowlist plus 3 flags; no `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR` or proxy vars | `child-env.ts` is ported verbatim. `buildQueryOptions` forces `env: buildChildEnv()` last. | lh-2c: a poisoned source env (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, `OPENROUTER_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `LH_CLAUDE_CODE_EXECUTABLE`) yields exactly the allowlisted keys present plus the 3 flags, and the options env is that object. |
| `pathToClaudeCodeExecutable` = the CPA launcher, from an env var; unset means the provider is absent | `src/server/claude-code-boot.ts` reads `LH_CLAUDE_CODE_EXECUTABLE`. It accepts the value only when: the name is not in the keys fill-gap set; `envKeysIgnored()` is false; the path is absolute; and it is an executable file. It then calls `enableClaudeCodeProvider(path)`. `buildQueryOptions` throws without a path; there is no fallback to the bundled binary. | lh-2j: the var unset, set only via `auth.json`, set under `LH_IGNORE_ENV_KEYS=1`, relative, or non-executable each give no provider and output deep-equal to the baseline. lh-2i: the dynamic-import spy is never called while the provider is disabled. |
| Personal use only; never on by default | Opt-in through the env var only. There is no setting, UI toggle or default slot for it. The SDK platform binary is kept out of the desktop payload, and the build fails if it is there. | lh-2b: the payload guard test. lh-2j: the baseline deep-equal tests. `tests/auth-provider-keys.test.ts` is unchanged and green. |
| No API key, Console credits, OAuth handling or request rewriting | `resolve()` returns `{auth: {}}`, the provider ignores `options.apiKey` and `headers`, and nothing reads `~/.claude` credentials. Overage latch. Plan-gated 1M models stay at 200K (`[1m]` only for `MEASURED_ONE_M` ids). | lh-2g: the latch sets, persists and refuses. lh-2i: the `[1m]` table. |

## Request lifecycle

1. Auth resolves to `{auth: {}}` with no API key; the provider returns a stream synchronously and continues detached.
2. Fold the current system prompt, tools, and non-system history from the transcript.
3. Split: a trailing user run supplies the prompt's text/image blocks; a trailing tool result uses `CONTINUE_TEXT`; anything else errors with “nothing to send” and spawns nothing.
4. Convert prior history with `mcp__custom-tools__<name>` names, merged parallel results, and separate continuation records; replay signed thinking only from `claude-code` messages.
5. Write a per-call session file using the fixed LH cwd (`PATHS.data/claude-code/cwd`, resolved to its realpath) and `~/.claude`, injectable for tests.
6. Acquire a FIFO, abort-aware child slot: `LH_CLAUDE_CODE_MAX_CHILDREN`, default 4.
7. Dynamically load the SDK on first use and call `query()` with the forced options in the safety table, `maxTurns: 1`, and `persistSession: false`.
8. Map start, text/thinking/tool-call deltas, ends, and usage; strip known served-name prefixes and handle restreamed messages and non-streaming fallbacks.
9. With tool calls, close at `message_stop`; without tool calls, wait for `result`, including rate-limit error text. Any Extra Usage signal latches a refusal for this and every later call until restart.
10. Abort interrupts and closes the child, then emits an aborted error with partial output.
11. Finally release the slot and delete the session file; on first use, sweep session files and companion directories older than 1 h within this cwd's Claude project directory.

Server tools execute in the harness and resume in a fresh child with tool results plus `CONTINUE_TEXT`; client tools such as quiz end the run with a placeholder, then the later answer resumes the same way.

The SDK platform binary is never shipped in the desktop payload; the build fails if it is present. The launcher is supplied by the owner.

`LH_MAX_OUTPUT_TOKENS` and `maxTokens` do not cap this provider: Claude Code sets its own output limit. An invalid `LH_MAX_OUTPUT_TOKENS` still fails every engine build, this one included, because it is validated for all providers: set it to an integer >= 1024 or leave it unset. Thinking `off` sends no effort, so Claude Code's default thinking applies. Usage cost shows as unpriced ("—").

Developers who export the variable in their shell will see an extra provider row in `tests/model-catalog.test.ts`-style outputs. Run the test suite with `LH_CLAUDE_CODE_EXECUTABLE` unset.
