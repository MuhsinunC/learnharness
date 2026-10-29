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

Publish manually as a GitHub **pre-release** on [MuhsinunC/learnharness](https://github.com/MuhsinunC/learnharness), with tag `lh-<version>` (for example `lh-0.3.7-fork.1`). Attach the DMG and include its SHA-256 in the release notes. Bump N for every new fork build of the same base version. Never use a `v*` tag: upstream's `.github/workflows/release.yml` runs on those tags. The build script never publishes, tags, or contacts GitHub.

The script keeps your proxy environment. If a proxy in your shell blocks npm or Electron downloads, run it as `LH_BUILD_NO_PROXY=1 scripts/build-fork-mac.sh`. After packaging, it checks the app's signature and runs the provider runtime probe under the packaged executable, and under Electron's Node before packaging.
