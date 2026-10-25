#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ $# -gt 1 || ! ${1:-1} =~ ^[1-9][0-9]*$ ]]; then
  echo "Usage: scripts/build-fork-mac.sh [N] (positive integer, default 1)" >&2
  exit 1
fi
# A scalar plus conditional expansion is safe with Bash 3.2 and set -u.
case ${LH_FORK_ICON-} in
  '') fork_icon= ;;
  icns) fork_icon=-c.mac.icon=build/icon.icns ;;
  *) echo 'LH_FORK_ICON must be unset or icns' >&2; exit 1 ;;
esac
fork_number=${1:-1}
version="$(node -p 'require("./package.json").version')-fork.${fork_number}"
# Keep the caller's proxy settings unless asked to build on a direct connection.
if [[ ${LH_BUILD_NO_PROXY:-} == 1 ]]; then
  unset HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy
fi
export NEXT_TELEMETRY_DISABLED=1

# Next rewrites this generated declaration during production builds.
# Preserve even a caller's uncommitted version, including on build failure.
next_env_backup=$(mktemp "${TMPDIR:-/tmp}/lh-fork-next-env.XXXXXX")
cp -p next-env.d.ts "$next_env_backup"
restore_next_env() {
  cp -p "$next_env_backup" next-env.d.ts
  rm -f "$next_env_backup"
}
trap restore_next_env EXIT

rm -rf dist .next/standalone
node_modules/.bin/next build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
node scripts/smoke-server.mjs
# The desktop app runs the server under Electron's bundled Node, not the host Node.
node scripts/smoke-server.mjs --electron

unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID APPLE_KEYCHAIN_PROFILE
unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER CSC_LINK CSC_NAME CSC_KEY_PASSWORD
export CSC_IDENTITY_AUTO_DISCOVERY=false
# electron-builder skips signing on pull-request CI builds. The fork signs ad-hoc
# (identity "-", no certificate or secret involved), so signing is always safe here.
export CSC_FOR_PULL_REQUEST=true
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
node_modules/.bin/electron-builder --config electron-builder.fork.yml --mac --arm64 \
  --publish never "-c.extraMetadata.version=$version" ${fork_icon:+"$fork_icon"}

dmg="$PWD/dist/LearnHarness-${version}-arm64.dmg"
test -f "$dmg"

# Check the packaged app itself: a valid ad-hoc signature without the hardened
# runtime first (a failed library-validation launch shows a crash dialog), then
# the provider runtime probe under the packaged executable.
app="$PWD/dist/mac-arm64/LearnHarness.app"
codesign --verify --deep --strict "$app"
if codesign -dv "$app" 2>&1 | grep -q 'flags=.*runtime'; then
  echo "hardened runtime is on; an ad-hoc build cannot load its frameworks" >&2
  exit 1
fi
node scripts/smoke-provider-runtime.mjs \
  --standalone "$app/Contents/Resources/server/standalone" --runtime "$app/Contents/MacOS/LearnHarness"
echo "$dmg"
shasum -a 256 "$dmg"
