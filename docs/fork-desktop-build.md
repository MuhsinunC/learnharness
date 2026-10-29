# Fork desktop build

## Build

Use macOS 26 on Apple Silicon, Xcode 26 or newer (for `actool`), and Node 26. Install dependencies with `npm ci`, then run:

```bash
scripts/build-fork-mac.sh       # fork number 1
scripts/build-fork-mac.sh 2     # next build of the same base version
```

The script works from any working directory. It runs the production Next build, provider-runtime smoke, server packaging and server smoke before packaging the app. It prints the absolute DMG path and SHA-256; for base version 0.3.7 the default output is `dist/LearnHarness-0.3.7-fork.1-arm64.dmg`.

## Differences from upstream releases

`electron-builder.fork.yml` extends the upstream configuration without changing it. The fork uses an ad-hoc signature (`mac.identity: "-"`), no Developer ID and no notarization. Signing and Apple credential environment variables are cleared before packaging. Only an arm64 DMG is built; there is no ZIP/Squirrel update target. The package version is `<package.json version>-fork.<N>` via `extraMetadata`.

Publish configuration is null and publishing is disabled; the bundle contains no `app-update.yml`. The pure updater gate recognizes versions matching `/-fork(\.|$)/`. For these builds, the main process returns before loading `electron-updater`, so no update check, download or install on quit can occur. The manual Check for Updates menu shows “Updates are disabled in this build.” Upstream versions retain their existing updater behavior.

Hardened runtime is disabled for the fork. With it enabled, the ad-hoc-signed main executable exited with SIGABRT in the headless Node-mode probe: `Library not loaded: @rpath/Electron Framework.framework/Electron Framework`, with `mapping process and mapped file (non-platform) have different Team IDs`. All four helper executables passed that probe, but the main executable could not load its framework. No entitlements were added. With hardened runtime disabled, the main executable and all four helpers print the Electron version and exit successfully; deep strict signature verification passes with `Signature=adhoc` and no `runtime` flag. These checks load the framework under each executable's own signature without opening the GUI.

The app keeps the same bundle identifier (`com.learnharness.LearnHarness`) and product name (`LearnHarness`), reusing `~/Library/Application Support/LearnHarness`.

## Install or return to upstream

1. Quit the official app first. The official app installs a downloaded update when it quits, so quitting it after the fork is in place could put the official build back.
2. Choose a fork whose base version is at or above the installed official version. Older code reading data migrated by a newer version is a downgrade risk.
3. Mount the DMG, drag LearnHarness to Applications, and replace the existing app.
4. A downloaded, non-notarized app is blocked by Gatekeeper on first launch. Use System Settings > Privacy & Security > **Open Anyway**; recent macOS does not offer the right-click bypass.
5. Because the signature changed, macOS may ask once for access to the keychain item **LearnHarness Safe Storage**. Choose **Always Allow**. The app itself does not use Electron `safeStorage`; this item stores Chromium's cookie key.

To return to the official build, quit the fork and install the official DMG over it the same way, observing the same base-version downgrade precaution. Keep the Application Support directory to preserve data.

## Release convention

Releases are cut by dispatching the `Fork release` workflow (`.github/workflows/fork-release.yml`) on `ai-reviewed`; never build or publish a release DMG on your own Mac:

```bash
gh workflow run fork-release.yml --repo MuhsinunC/learnharness --ref ai-reviewed -f fork_build=1 -f notes="One-line summary"
```

It runs on a GitHub-hosted Apple Silicon runner at the current tip of `ai-reviewed`. It refuses any other ref, a tag that already exists, and a commit without a successful `Fork macOS E2E` run, so wait for that run after a stack move. It builds with `scripts/build-fork-mac.sh <N>`, checks the app's version and ad-hoc signature, and fails if `ai-reviewed` moved during the build. Then it pushes the annotated tag `lh-<version>-fork.<N>` (for example `lh-0.3.8-fork.1`) on the built commit and publishes a GitHub **pre-release**, never marked latest, on [MuhsinunC/learnharness](https://github.com/MuhsinunC/learnharness). The release starts as a draft with the DMG and `SHA256SUMS`, and is published only after the uploaded assets are downloaded back and their hashes match. Its notes give the DMG SHA-256 and the commits since the previous `lh-*` tag; replace them with fuller notes afterwards with `gh release edit <tag> --notes-file <file>`. If a run fails after pushing the tag, never delete it: finish the existing draft (or run `gh release create <tag> --verify-tag` for that tag), or dispatch N+1. Bump N for every new fork build of the same base version. Never use a `v*` tag: upstream's `.github/workflows/release.yml` runs on those tags. The build script itself never publishes, tags, or contacts GitHub.

The script keeps your proxy environment. If a proxy in your shell blocks npm or Electron downloads, run it as `LH_BUILD_NO_PROXY=1 scripts/build-fork-mac.sh`. After packaging, it checks the app's signature and runs the provider runtime probe under the packaged executable, and under Electron's Node before packaging.

## macOS end-to-end CI

`Fork macOS E2E` runs on pull requests, pushes to `ai-reviewed`, and manual dispatch, exclusively on GitHub-hosted Apple Silicon macOS runners. It builds the DMG, verifies migration from upstream 0.3.6 with fixture data, exercises the real window and local API, records Gatekeeper evidence and screenshots, and verifies rollback. It depends on `scripts/migrate-to-fork.sh`, `scripts/rollback-fork.sh`, and their shared migration helper being present in the stacked branch.

CI sets `LH_FORK_ICON=icns` to use `build/icon.icns`: Xcode 26's `actool` for the Icon Composer document cannot run on macOS 15. Unset keeps the local Icon Composer default; other values are rejected. Logs and screenshots are retained for 14 days; backup archives and credential files are never uploaded.
