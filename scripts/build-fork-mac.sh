#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ $# -gt 1 || ! ${1:-1} =~ ^[1-9][0-9]*$ ]]; then
  echo "Usage: scripts/build-fork-mac.sh [N] (positive integer, default 1)" >&2
  exit 1
fi
fork_number=${1:-1}
version="$(node -p 'require("./package.json").version')-fork.${fork_number}"
unset HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy
export NEXT_TELEMETRY_DISABLED=1

# Next rewrites this generated declaration during production builds.
# Preserve even a caller's uncommitted version, including on build failure.
next_env_backup=$(mktemp "${TMPDIR:?}/lh-fork-next-env.XXXXXX")
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

unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID APPLE_KEYCHAIN_PROFILE
unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER CSC_LINK CSC_NAME CSC_KEY_PASSWORD
export CSC_IDENTITY_AUTO_DISCOVERY=false
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
node_modules/.bin/electron-builder --config electron-builder.fork.yml --mac --arm64 \
  --publish never "-c.extraMetadata.version=$version"

dmg="$PWD/dist/LearnHarness-${version}-arm64.dmg"
test -f "$dmg"
echo "$dmg"
shasum -a 256 "$dmg"
