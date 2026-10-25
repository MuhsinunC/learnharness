#!/bin/bash
# Hook strings expand only in the isolated child shell.
# shellcheck disable=SC2016

set -eu
# Locate optional shellcheck before restricting PATH to stock macOS tools.
shellcheck_bin=$(command -v shellcheck || true)
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH LC_ALL=C
repo=$(cd "$(dirname "$0")/../.." && pwd)
failures=0
run_logs=$(mktemp -d "${TMPDIR:-/tmp}/lh migrate logs.XXXXXX")
trap 'rm -rf "${run_logs:?}"' EXIT
fixture_app() {
    dest=$1; app_version=$2
    mkdir -p "$dest/Contents/MacOS"
    cat > "$dest/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.learnharness.LearnHarness</string>
<key>CFBundleShortVersionString</key><string>$app_version</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleExecutable</key><string>LearnHarness</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
    printf '#!/bin/bash\nexit 0\n' > "$dest/Contents/MacOS/LearnHarness"
    chmod 755 "$dest" "$dest/Contents" "$dest/Contents/MacOS" "$dest/Contents/MacOS/LearnHarness"
    chmod 644 "$dest/Contents/Info.plist"
    codesign -s - --force "$dest" >/dev/null 2>&1
}
setup() {
    case_root=$(mktemp -d "${TMPDIR:-/tmp}/lh migrate case $1.XXXXXX")
    trap 'result=$?; if [ "$result" -ne 0 ] && [ -f "$case_root/output" ]; then cat "$case_root/output"; fi; rm -rf "${case_root:?}"' EXIT
    fake_home=$case_root/home
    case_tmp=$case_root/tmp
    apps=$case_root/Applications
    data="$case_root/user data/LearnHarness"
    backups="$case_root/private backups"
    mkdir -p "$fake_home" "$case_tmp" "$apps" "$data/data/chats" "$data/data/graph" "$data/nested dir" "$case_root/source"
    printf '{"fixture":"sign-in"}\n' > "$data/auth.json"
    printf '{"fixture":"credential"}\n' > "$data/nested dir/foo-credentials.json"
    chmod 600 "$data/auth.json" "$data/nested dir/foo-credentials.json"
    printf '{}\n' > "$data/data/chats/one.json"
    printf '{"chat":2}\n' > "$data/data/chats/two.json"
    printf '{}\n' > "$data/data/graph/sources.json"
    printf '{}\n' > "$data/data/graph/positions.json"
    printf '{}\n' > "$data/data/settings.json"
    printf 'fixture bytes\n' > "$data/nested dir/file with space"
    ln -s missing-host-lock "$data/SingletonLock"
    fixture_app "$apps/LearnHarness.app" 0.3.3
    fixture_app "$case_root/source/LearnHarness.app" 0.3.4-fork.2
    xattr -w com.apple.quarantine '0081;fixture;fixture;' "$case_root/source/LearnHarness.app"
    hdiutil create -srcfolder "$case_root/source" -volname LearnHarness -format UDZO -ov "$case_root/fork.dmg" >/dev/null
    xattr -w com.apple.quarantine '0081;fixture;fixture;' "$case_root/fork.dmg"
    digest=$(shasum -a 256 "$case_root/fork.dmg" | awk '{print $1}')
    # file:// URL encodes spaces so curl exercises exactly the release path.
    url=$(printf '%s' "$case_root/fork.dmg" | sed 's/ /%20/g')
    cat > "$case_root/releases.json" <<JSON
[
 {"tag_name":"v99.0-fork.1","draft":true,"assets":[]},
 {"tag_name":"v99.0","draft":false,"assets":[]},
 {"tag_name":"v0.3.4-fork.1","draft":false,"assets":[{"name":"LearnHarness-old-arm64.dmg","digest":null}]},
 {"tag_name":"v0.3.4-fork.2","draft":false,"prerelease":true,"assets":[{"name":"other.zip"},{"name":"LearnHarness-0.3.4-fork.2-arm64.dmg","browser_download_url":"file://$url","digest":"sha256:$digest"}]},
 {"tag_name":"v0.3.3-fork.99","draft":false,"assets":[]}
]
JSON
    for hook in quit launch ps launchctl; do
        cat > "$case_root/$hook stub" <<'STUB'
#!/bin/bash
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
printf '%s\n' "$0 $*" >> "$LH_TEST_ROOT/calls"
name=${0##*/}
case "$name" in
    'quit stub')
        printf quit >> "$LH_TEST_ROOT/quit-called"
        if [ -f "$LH_TEST_ROOT/launched" ]; then mv "$LH_TEST_ROOT/launched" "$LH_TEST_ROOT/previous-launch"; fi;;
    'launch stub') printf launched >> "$LH_TEST_ROOT/launched";;
    'ps stub')
        if [ -f "$LH_TEST_ROOT/stubborn" ] || [ -f "$LH_TEST_ROOT/launched" ]; then printf '123 %s/Contents/MacOS/LearnHarness\n' "$LH_MIGRATE_APPS_DIR/LearnHarness.app";
        elif [ -f "$LH_TEST_ROOT/running" ] && [ ! -f "$LH_TEST_ROOT/quit-called" ]; then printf '123 %s/Contents/MacOS/LearnHarness\n' "$LH_MIGRATE_APPS_DIR/LearnHarness.app"; fi;;
    'launchctl stub') if [ -f "$LH_TEST_ROOT/shipit" ]; then printf '"PID" = 123;\n'; fi;;
esac
STUB
    done
    quit_hook='exec /bin/bash "$LH_TEST_ROOT/quit stub" "$@"'
    launch_hook='exec /bin/bash "$LH_TEST_ROOT/launch stub" "$@"'
    ps_hook='exec /bin/bash "$LH_TEST_ROOT/ps stub" "$@"'
    launchctl_hook='exec /bin/bash "$LH_TEST_ROOT/launchctl stub" "$@"'
    snapshot "$data" > "$case_root/original-data"
    snapshot "$apps/LearnHarness.app" > "$case_root/original-app"
}
# Independent fixture snapshot: sorted path, type, mode and bytes/link target.
snapshot() {
    (cd "$1"; find . -print | sort | while IFS= read -r item; do
        printf '%s\t%s\t' "$item" "$(stat -f '%Lp' "$item")"
        if [ -L "$item" ]; then printf 'l\t%s\n' "$(readlink "$item")"
        elif [ -d "$item" ]; then printf 'd\n'
        else printf 'f\t%s\n' "$(shasum -a 256 "$item" | awk '{print $1}')"; fi
    done)
}
invoke() {
    # Fail closed: never invoke a production script without all four fixture hooks.
    [ "${quit_hook:-}" = 'exec /bin/bash "$LH_TEST_ROOT/quit stub" "$@"' ] &&
    [ "${launch_hook:-}" = 'exec /bin/bash "$LH_TEST_ROOT/launch stub" "$@"' ] &&
    [ "${ps_hook:-}" = 'exec /bin/bash "$LH_TEST_ROOT/ps stub" "$@"' ] &&
    [ "${launchctl_hook:-}" = 'exec /bin/bash "$LH_TEST_ROOT/launchctl stub" "$@"' ] || return 99
    for hook in quit launch ps launchctl; do [ -f "$case_root/$hook stub" ] || return 99; done
    env -i HOME="$fake_home" TMPDIR="$case_tmp" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
        LH_TEST_ROOT="$case_root" LH_MIGRATE_APPS_DIR="$apps" LH_MIGRATE_DATA_DIR="$data" LH_MIGRATE_BACKUP_ROOT="$backups" \
        LH_MIGRATE_RELEASE_JSON="$case_root/releases.json" \
        LH_MIGRATE_QUIT_CMD="$quit_hook" LH_MIGRATE_LAUNCH_CMD="$launch_hook" \
        LH_MIGRATE_PS_CMD="$ps_hook" LH_MIGRATE_LAUNCHCTL_CMD="$launchctl_hook" \
        LH_MIGRATE_QUIT_TIMEOUT=1 LH_MIGRATE_SHIPIT_TIMEOUT=1 LH_MIGRATE_SHIPIT_SETTLE=0 LH_MIGRATE_LAUNCH_TIMEOUT=1 \
        /bin/bash "$@" > "$case_root/output" 2>&1
}
migrate() { invoke "$repo/scripts/migrate-to-fork.sh" "$@"; }
backup_path() { find "$backups" -mindepth 1 -maxdepth 1 -type d | sort | tail -1; }
unchanged_data() { snapshot "$data" > "$case_root/now-data"; cmp "$case_root/original-data" "$case_root/now-data"; }
unchanged_app() { snapshot "$apps/LearnHarness.app" > "$case_root/now-app"; cmp "$case_root/original-app" "$case_root/now-app"; }
no_backup() { [ ! -e "$backups" ]; }
expect_failure() { if migrate "$@"; then printf 'Expected migration failure\n' >&2; return 1; fi; }
case_1() {
    setup 1
    touch "$case_root/running"
    migrate --dry-run
    unchanged_data; unchanged_app
    backup=$(backup_path)
    [ "$(stat -f '%Lp' "$backups")" = 700 ]
    [ "$(stat -f '%Lp' "$backup")" = 700 ]
    for file in data.tar.gz manifest.txt rollback-fork.sh migrate-common.sh; do [ "$(stat -f '%Lp' "$backup/$file")" = 600 ]; done
    grep -qx $'chats\t2' "$backup/manifest.txt"
    grep -qx $'graph_files\t2' "$backup/manifest.txt"
    grep -qx $'files\t8' "$backup/manifest.txt"
    grep -qx $'dirs\t5' "$backup/manifest.txt"
    grep -qx $'symlinks\t1' "$backup/manifest.txt"
    grep -qx $'settings\tyes' "$backup/manifest.txt"
    grep -qx $'sign_in\tnested dir/foo-credentials.json' "$backup/manifest.txt"
    awk -F '\t' '{printf "entry\t%s\t%s\t%s\t%s\n",$3,$2,($3=="d"?"-":$4),$1}' "$case_root/original-data" > "$case_root/expected-entries"
    grep '^entry' "$backup/manifest.txt" > "$case_root/manifest-entries"
    cmp "$case_root/expected-entries" "$case_root/manifest-entries"
    mkdir "$case_root/extracted"
    tar -xpf "$backup/data.tar.gz" -C "$case_root/extracted"
    snapshot "$case_root/extracted/LearnHarness" > "$case_root/archive-data"
    cmp "$case_root/original-data" "$case_root/archive-data"
    [ -f "$case_root/quit-called" ] && [ -f "$case_root/launched" ]
}
case_2() {
    setup 2
    migrate
    unchanged_data
    [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$apps/LearnHarness.app/Contents/Info.plist")" = 0.3.4-fork.2 ]
    if xattr -lr "$apps/LearnHarness.app" | grep -q com.apple.quarantine; then return 1; fi
    snapshot "$apps/LearnHarness.app" > "$case_root/installed"
    snapshot "$case_root/source/LearnHarness.app" > "$case_root/source-app"
    cmp "$case_root/installed" "$case_root/source-app"
    [ "$(find "$apps" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ]
    codesign --verify --deep --strict "$apps/LearnHarness.app"
}
case_3() {
    setup 3
    fixture_app "$apps/LearnHarness.app" 0.3.10
    snapshot "$apps/LearnHarness.app" > "$case_root/original-app"
    touch "$case_root/running"
    expect_failure
    no_backup; unchanged_data; unchanged_app
    grep -Fq 'Your installed LearnHarness (0.3.10) is newer than the fork build (v0.3.4-fork.2). Nothing was changed. Ask for a fork update.' "$case_root/output"
    [ -f "$case_root/launched" ]
}
case_4() {
    setup 4
    expect_failure --dmg "$case_root/fork.dmg" --sha256 0000000000000000000000000000000000000000000000000000000000000000
    no_backup; unchanged_data; unchanged_app
    [ ! -e "$case_root/calls" ]
}
case_5() {
    setup 5
    mv "$data/data/settings.json" "$data/nested dir/settings target.json"
    ln -s '../nested dir/settings target.json' "$data/data/settings.json"
    snapshot "$data" > "$case_root/original-data"
    migrate
    backup=$(backup_path)
    printf 'new fork data\n' >> "$data/data/chats/one.json"
    snapshot "$data" > "$case_root/fork-data"
    snapshot "$apps/LearnHarness.app" > "$case_root/fork-app"
    # A well-formed but incorrect entry hash must fail in staging, before any move.
    cp "$backup/manifest.txt" "$case_root/good manifest"
    auth_hash=$(shasum -a 256 < "$data/auth.json" | awk '{print $1}')
    sed "s/$auth_hash/0000000000000000000000000000000000000000000000000000000000000000/" "$case_root/good manifest" > "$backup/manifest.txt"
    if invoke "$backup/rollback-fork.sh" "$backup"; then return 1; fi
    grep -Fq 'Data manifest verification failed' "$case_root/output"
    snapshot "$data" > "$case_root/failed-restore-data"
    cmp "$case_root/fork-data" "$case_root/failed-restore-data"
    [ -z "$(find "$(dirname "$data")" -maxdepth 1 -name '.lh-restore.*')" ]
    cp "$case_root/good manifest" "$backup/manifest.txt"
    touch "$case_root/stubborn"
    if invoke "$backup/rollback-fork.sh" "$backup"; then return 1; fi
    snapshot "$data" > "$case_root/timeout-data"
    cmp "$case_root/fork-data" "$case_root/timeout-data"
    snapshot "$apps/LearnHarness.app" > "$case_root/timeout-app"
    cmp "$case_root/fork-app" "$case_root/timeout-app"
    [ "$(find "$apps" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ]
    [ -z "$(find "$(dirname "$data")" -maxdepth 1 -name '.lh-restore.*')" ]
    mv "$case_root/stubborn" "$case_root/was-stubborn"
    invoke "$backup/rollback-fork.sh" "$backup"
    unchanged_data; unchanged_app
    aside=$(find "$(dirname "$data")" -maxdepth 1 -name 'LearnHarness.fork-*' -type d)
    [ -n "$aside" ]
    snapshot "$aside" > "$case_root/aside-data"
    cmp "$case_root/fork-data" "$case_root/aside-data"
    # Fresh-install rollback has no prior app/data, and preserves newly made data.
    mv "$data" "$case_root/saved data"
    mv "$apps/LearnHarness.app" "$case_root/saved app"
    migrate
    backup=$(backup_path)
    [ ! -e "$backup/data.tar.gz" ] && [ ! -e "$backup/LearnHarness.app" ]
    mkdir "$data"
    printf 'fresh fork data\n' > "$data/new file"
    invoke "$backup/rollback-fork.sh" "$backup"
    [ ! -e "$data" ]
    [ -d "$apps/LearnHarness.app" ]
    grep -Fq 'leaving the installed app in place' "$case_root/output"
}
case_6() {
    setup 6
    mkdir -p "$case_root/checkout/.git"
    backups=$case_root/checkout/deep/backups
    expect_failure --dry-run
    no_backup; unchanged_data; unchanged_app
    grep -q 'inside a git checkout' "$case_root/output"
}
case_7() {
    if [ -z "$shellcheck_bin" ]; then printf 'SKIP 7: shellcheck is not installed\n'; return; fi
    "$shellcheck_bin" "$repo/scripts/migrate-to-fork.sh" "$repo/scripts/rollback-fork.sh" "$repo/scripts/migrate-common.sh" "$repo/tests/migrate/run.sh"
}
case_8() {
    setup 8
    touch "$case_root/shipit"
    expect_failure
    no_backup; unchanged_data; unchanged_app
    grep -Fq 'A LearnHarness update is still installing; try again in a minute. Nothing was changed.' "$case_root/output"
}
case_9() {
    setup 9
    printf 'tampered\n' >> "$case_root/source/LearnHarness.app/Contents/MacOS/LearnHarness"
    hdiutil create -srcfolder "$case_root/source" -volname LearnHarness -format UDZO -ov "$case_root/bad.dmg" >/dev/null
    expect_failure --dmg "$case_root/bad.dmg"
    unchanged_data; unchanged_app
    [ "$(find "$apps" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ]
}
case_10() {
    setup 10
    migrate --dry-run
    grep -Fq 'Dry run:' "$case_root/output"
    sed -E 's/sha256:[a-f0-9]+/null/' "$case_root/releases.json" | sed 's/"digest":"null"/"digest":null/' > "$case_root/null.json"
    # The existing valid backup must be the only backup after the failed parse.
    before=$(find "$backups" -type d | wc -l)
    calls_before=$(wc -l < "$case_root/calls")
    expect_failure --release-json "$case_root/null.json"
    grep -Fq 'Missing or invalid SHA-256 digest' "$case_root/output"
    [ "$calls_before" = "$(wc -l < "$case_root/calls")" ]
    [ "$before" = "$(find "$backups" -type d | wc -l)" ]
    unchanged_data; unchanged_app
}
for number in 1 2 3 4 5 6 7 8 9 10; do
    # Do not use `if case_N`: it disables errexit inside the entire case.
    set +e
    (set -e; "case_$number") > "$run_logs/case-$number.log" 2>&1
    result=$?
    set -e
    if [ "$result" -eq 0 ]; then
        if [ "$number" = 7 ] && [ -z "$shellcheck_bin" ]; then cat "$run_logs/case-$number.log"; else printf 'PASS %s\n' "$number"; fi
    else
        printf 'FAIL %s\n' "$number"
        cat "$run_logs/case-$number.log"
        failures=$((failures+1))
    fi
done
[ "$failures" -eq 0 ]
