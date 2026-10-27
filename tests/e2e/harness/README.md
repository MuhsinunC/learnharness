# e2e harness

End-to-end tests boot the real server in web mode, talk to it over HTTP, and
drive the UI in headless Chrome. A local stub stands in for every model.
Run them with `npm run test:e2e`. It runs `tests/e2e/*.e2e.ts`, one file at a
time, because each file boots its own `next dev` in this checkout.

## Pieces

- `stub-provider.ts`: `startStubProvider(responder)` starts an OpenAI-compatible
  `/v1/chat/completions` server on 127.0.0.1. The responder receives each
  request as `{ model, system, tools, messages, body }` and returns one of:
  - `reply.text(s)`
  - `reply.tools([{ name, arguments }], text?)`
  - `reply.baseten403()`: HTTP 403 `{"error":"please check the api-key you provided"}`
  - `reply.contextLength(limit?)`: HTTP 400 `context_length_exceeded`
  - `reply.http(status, body)`
  - `reply.hang()`: the request is accepted and never answered

  Pick the reply from the request content, never from a global counter.
  The helpers `lastToolName(req)` and `calledTool(req, name)` help with that.
  `stub.requests` records every request and `stub.setResponder()` swaps the
  script mid-file.
- `server.ts`: `bootServer({ ticket, providers, settings, env? })` returns
  `{ url, dataDir, api, json, log, stop }`. It writes `settings` to a fresh
  `LH_DATA_DIR` under `~/.cache/lh-e2e/<ticket>/`, strips proxy and credential
  variables, and sets `LH_IGNORE_ENV_KEYS=1` and `LH_E2E=1`. The server runs
  under `nice -n 10`. `stop()` collects that child's process tree
  (`pgrep -P`, recursively), sends SIGTERM to exactly those pids, sends
  SIGKILL to any still alive after 10 s, then deletes the run directory;
  set `LH_E2E_KEEP=1` to keep it. `until(probe, label, ms)` polls.
- `chrome.ts`: `launchChrome(ticket)` starts headless system Chrome with a
  throwaway `--user-data-dir`. Set `CHROME_PATH` to override the binary.

## Registering stub models

The app has no custom-provider setting, so there is a test-only seam:
`src/agent/e2e-providers.ts`. It is read only when `LH_E2E=1`.
`bootServer` passes `providers` to it as `LH_E2E_PROVIDERS`. Each entry
registers one OpenAI-compatible provider on pi-ai's `openai-completions` API:

```ts
providers: [{ id: "e2e-stub", baseUrl: stub.baseUrl, models: [
	{ id: "stub-a", input: ["text", "image"] },
	{ id: "stub-small", contextWindow: 8192 },
] }]
```

A model entry is a partial pi `Model` (`contextWindow`, `maxTokens`, `input`,
`reasoning`, `cost`, ...) merged over text-only defaults. Point the slots at
it in `settings`:

```ts
settings: { version: 1, graph: { enabled: false }, models: {
	strong: { model: { provider: "e2e-stub", id: "stub-a" } },
	cheap: { model: { provider: "e2e-stub", id: "stub-a" } },
	vision: { model: { provider: "e2e-stub", id: "stub-a" } },
} }
```

`graph.enabled: false` keeps extraction (cheap slot) out of the stub traffic.
The ids are not in `AUTH_PROVIDER_KEYS`, so the key gates pass and every
request reaches the stub. `PUT /api/settings/models` also accepts them.

Under `LH_E2E=1`, the demo and visual headless runs also skip the Electron
browser-service helper and launch headless system Chrome, using
puppeteer's own temp profile.

## Driving a session

A new session starts with the prober. Its tools include `probe_done`, but not
the job tools. Script `probe_done` with `{ assessment: { strands: [{ strand,
assessment }] } }`. The handoff steer then wakes the teacher by itself, and
the teacher's requests offer `demo`, `visual`, `research` and `pdf`. Teacher
and sub-agent requests are told apart by their system prompts; for example,
the demo builder's starts "You are a demo builder".

Useful endpoints:
- `POST /api/chats {title}` returns `{id}`
- `POST /api/chat {chatId, input: {type: "text", text}}` (drain the body)
- `GET /api/chats/:id` returns the record, with `turnInFlight`
- `GET /api/jobs?chatId=` returns the job records
- `GET /api/activity`: `.jobs` holds the Background agents rows (running jobs only)

`harness-smoke.e2e.ts` is the smallest working example.
