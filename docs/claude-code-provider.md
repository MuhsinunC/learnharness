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
| `pathToClaudeCodeExecutable` = the CPA launcher, from an env var; unset means the provider is absent | `src/server/claude-code-boot.ts` reads `LH_CLAUDE_CODE_EXECUTABLE`. It accepts the value only when: the name is not in the keys fill-gap set; `envKeysIgnored()` is false; the path is absolute; and it is an executable file. It then calls `enableClaudeCodeProvider(path)`. `buildQueryOptions` throws without a path; there is no fallback to the bundled binary. | lh-2j: the var unset, set only via `auth.json`, set under `LH_IGNORE_ENV_KEYS=1`, relative, or non-executable each give no provider and output deep-equal to the baseline. lh-2i: the dynamic-import spy is never called while the provider is disabled. |
| Personal use only; never on by default | Opt-in through the env var only. There is no setting, UI toggle or default slot for it. The SDK platform binary is kept out of the desktop payload, and the build fails if it is there. | lh-2b: the payload guard test. lh-2j: the baseline deep-equal tests. `tests/auth-provider-keys.test.ts` is unchanged and green. |

## Request lifecycle

1. Prepare subscription auth and the child environment for the CPA launcher.
2. Fold the system prompt and history into the request.
3. Split the history from the final continuation text.
4. Convert messages to Claude Code session records and repair tool pairing.
5. Write the temporary session file.
6. Acquire a child slot.
7. Query Claude Code with the explicit launcher and resume file.
8. Map SDK events to the harness stream and park tool calls for the harness.
9. End the request at `message_stop`.
10. Abort and close the child, including on cancellation or failure.
11. Clean up the session file and release the child slot.

The SDK platform binary is never shipped in the desktop payload; the build fails if it is present. The launcher is supplied by the owner.

`LH_MAX_OUTPUT_TOKENS` and `maxTokens` do not apply to this provider: Claude Code sets its own output limit. Thinking `off` sends no effort, so Claude Code's default thinking applies. Usage cost shows as unpriced ("—").

Developers who export the variable in their shell will see an extra provider row in `tests/model-catalog.test.ts`-style outputs. Run the test suite with `LH_CLAUDE_CODE_EXECUTABLE` unset.
