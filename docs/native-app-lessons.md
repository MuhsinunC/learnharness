# Native app later: lessons from the web and phone work

LearnHarness reaches a phone today as a website: the learner's own computer runs the server, and the phone opens it in its browser over Tailscale ([remote access](remote-access.md)). A native wrapper, such as Capacitor around the same web UI, was deferred. This note records what the web and phone work taught us and what a wrapper would still need. Every lesson below points at the change that backs it.

## What exists today

- **Loopback server, Tailscale in front, a login.** The server listens only on `127.0.0.1`; the phone reaches it through `tailscale serve`, which gives it a `https://…ts.net` address and a real certificate. Once a password is set, every page, API call, live update and attachment needs a session. ([#101](https://github.com/MuhsinunC/learnharness/pull/101))
- **One responsive UI.** The same pages serve the desktop window, a laptop browser and a phone. ([#86](https://github.com/MuhsinunC/learnharness/pull/86), [#96](https://github.com/MuhsinunC/learnharness/pull/96))
- **Home-screen install.** A web app manifest, icons and the iOS meta tags; no service worker (`app/manifest.ts`). ([#95](https://github.com/MuhsinunC/learnharness/pull/95))
- **No cross-site API calls.** `proxy.ts` refuses every `/api` request, reads included, that is not same-origin. ([#106](https://github.com/MuhsinunC/learnharness/pull/106))

## Lessons that carry over to any web view

A wrapper renders these same pages, so all of this is already done for it.

- **The compact layout keys on width and pointer.** `COMPACT_QUERY` (`components/compact-query.ts`) switches the sessions sidebar to a drawer under 640px, or under 1024px on a touch screen. A mouse window of 900px keeps the inline sidebar. ([#96](https://github.com/MuhsinunC/learnharness/pull/96))
- **Use `max-width` queries, not range syntax.** The rule then doesn't depend on range-query support, which older iOS Safari lacks. The build itself targets Safari 16.4 and up, so that is the floor a wrapper's web view must meet. ([#96](https://github.com/MuhsinunC/learnharness/pull/96))
- **The drawer is a modal dialog.** While it is open the page behind is inert, and the page's own key listeners stand down. Escape closes the drawer without aborting a turn, and focus goes into it and back out. The first attempt, a window-level key fence, let Tab and other keys through to the hidden page; a guard in each page listener replaced it. ([#96](https://github.com/MuhsinunC/learnharness/pull/96))
- **iOS details.** Fields on touch screens use a 16px font so iOS doesn't zoom in. Rows that have a right-click menu on desktop get a "…" button, because iOS has no long-press right-click. `viewport-fit=cover` with safe-area padding keeps the docks clear of the home bar (`app/layout.tsx`). ([#86](https://github.com/MuhsinunC/learnharness/pull/86), [#96](https://github.com/MuhsinunC/learnharness/pull/96))
- **Installable files load without a login.** Browsers fetch the manifest without cookies, so `/manifest.webmanifest`, `/apple-icon.png` and the three `/pwa/` icons pass the login wall, and nothing near them does. Login redirects stay relative and same-origin, so a standalone home-screen app stays inside itself. Both are covered by `tests/e2e/web-login.e2e.ts` (j). ([#101](https://github.com/MuhsinunC/learnharness/pull/101))
- **No service worker is needed to install.** Chrome's menu install and iOS's Add to Home Screen both work without one. Offline use was not a goal. ([#95](https://github.com/MuhsinunC/learnharness/pull/95))

## Auth: the main design choice for a wrapper

A wrapper can load the server's own pages from the `ts.net` address, or bundle the UI inside the app and call the server as an API. With today's server, only the first works without server changes:

- **Sessions are bound to the Host they were issued for** (`hostKey` in `src/server/web-login.ts`), and the cookie is `HttpOnly; SameSite=Lax`. ([#101](https://github.com/MuhsinunC/learnharness/pull/101))
- **API calls must be same-origin.** `sameOriginRequest` refuses any request whose `Sec-Fetch-Site` is not `same-origin`, or whose `Origin` host differs from `Host`. UI bundled in a wrapper runs on its own origin, so the web view's own `fetch` calls to the server would be refused, and its session cookie would not be sent. A request with neither header (curl, the desktop main process, or a wrapper's native code) does pass that check; the trust rule assumes browsers, so that path would need its own review. ([#106](https://github.com/MuhsinunC/learnharness/pull/106))
- **A wrapper that loads the server's pages is just another logged-in browser.** It logs in once with the remote-access password and gets a 30-day session, like the phone browser does now.
- **It never gets desktop trust.** The desktop window proves itself with a secret made fresh at each launch: a header on its API calls and an HMAC cookie on its page loads (`src/server/desktop-access.ts`). A wrapper on another device never has it. So everything that acts on the computer itself (Claude Code settings, subscription sign-ins, API key changes in the desktop app, attaching an image by file path) stays refused with a "change this on the computer" message (`computerOnlyMessage` in `src/core/remote-access.ts`), and the first password can't be set from it. That is intended. ([#101](https://github.com/MuhsinunC/learnharness/pull/101))
- **Bundling the UI would mean a token-based API**, a CORS policy for the wrapper's origin, and a new review of the trust rule in `src/server/web-login.ts`. It is not a small change.

## Host discovery

- The computer finds its own address: `tailnetURL()` in `src/server/web-login.ts` reads `tailscale status --json` and shows `https://<machine>.<tailnet>.ts.net` in Settings → General → Remote access. ([#101](https://github.com/MuhsinunC/learnharness/pull/101))
- The phone has no way to ask. Today the learner reads the address off Settings and types it in. A wrapper would need the same: a typed address, or a QR code that Settings could show.
- The wrapper can only reach the computer while the computer is awake, LearnHarness is running, and Tailscale is connected on both devices. It should say which of these is missing rather than show a blank page.

## Electron-only features

The desktop window talks to Electron through `window.lh` (`electron/preload.cjs`): ChatGPT and subscription sign-ins, zoom, updates and window controls. A browser has no bridge, and a wrapper wouldn't either, so it takes the browser path. Giving those features web equivalents, or a clear desktop-only message, is [#73](https://github.com/MuhsinunC/learnharness/issues/73), in progress.

## What a wrapper would still need

None of this has been tried in this repo.

- **An Apple developer account and TestFlight.** Building for iPhone and handing out test builds through TestFlight need an Apple Developer Program membership. The fork's builds use an ad-hoc signature with no Developer ID today ([fork desktop build](fork-desktop-build.md)).
- **Push notifications.** There is no service worker and no push of any kind today, so a wrapper would start from nothing: a native push setup, a way for the computer to send to it, and something worth notifying about (a finished turn or extraction, for example).
- **The auth choice above.** Loading the server's pages needs no server change. Bundling the UI needs a new API auth design.
- **Host discovery**, as above.

## Not verified yet

- Remote access has not been tested against a real `tailscale serve` or on a real phone; the e2e tests send the headers serve sends (`tests/e2e/web-login.e2e.ts`). ([#101](https://github.com/MuhsinunC/learnharness/pull/101))
- Whether an iOS home-screen app keeps its own cookies, so the learner logs in once more inside it, is unconfirmed.
- An iPad with a trackpad between 768 and 1023px gets the inline sidebar by design; this has not been tried on a device. ([#96](https://github.com/MuhsinunC/learnharness/pull/96))
