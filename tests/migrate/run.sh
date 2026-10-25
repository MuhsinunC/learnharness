#!/bin/bash
# Hook strings expand only in the isolated child shell.
# shellcheck disable=SC2016

set -eu
# Locate optional shellcheck before restricting PATH to stock macOS tools.
shellcheck_bin=$(command -v shellcheck || true)
if [ -z "$shellcheck_bin" ] && [ -x /opt/homebrew/bin/shellcheck ]; then shellcheck_bin=/opt/homebrew/bin/shellcheck; fi
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH LC_ALL=C
export LH_NO_GUI=1
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
    printf 'backslash bytes\n' > "$data/nested dir/back\\slash"
    printf 'edge spaces\n' > "$data/nested dir/ leading and trailing "
    printf 'prefix ordering\n' > "$data/nested dir/file with space"$'\001'
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
 {"tag_name":"lh-99.0.0-fork.1","draft":true,"assets":[]},
 {"tag_name":"v99.0","draft":false,"assets":[]},
 {"tag_name":"v99.0.0-fork.1","draft":false,"assets":[{"name":"LearnHarness-99.0.0-fork.1-arm64.dmg","browser_download_url":"file://$url","digest":"sha256:$digest"}]},
 {"tag_name":"0.3.4-fork.1","draft":false,"assets":[{"name":"LearnHarness-old-arm64.dmg","digest":null}]},
 {"tag_name":"lh-0.3.4-fork.2","draft":false,"prerelease":true,"assets":[{"name":"other.zip"},{"name":"LearnHarness-0.3.4-fork.2-arm64.dmg","browser_download_url":"file://$url","digest":"sha256:$digest"}]},
 {"tag_name":"lh-0.3.3-fork.99","draft":false,"assets":[]}
]
JSON
    # Stubs only print text: no process is started, signalled, or looked up for real.
    for hook in quit launch ps launchctl lsappinfo; do
        cat > "$case_root/$hook stub" <<'STUB'
#!/bin/bash
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
printf '%s\n' "$0 $*" >> "$LH_TEST_ROOT/calls"
name=${0##*/}
quits=0
if [ -f "$LH_TEST_ROOT/quit-called" ]; then quits=$(( $(wc -c < "$LH_TEST_ROOT/quit-called") / 4 )); fi
exe=$LH_MIGRATE_APPS_DIR/LearnHarness.app/Contents/MacOS/LearnHarness
case "$name" in
    'quit stub')
        printf quit >> "$LH_TEST_ROOT/quit-called"
        if [ -f "$LH_TEST_ROOT/launched" ]; then mv "$LH_TEST_ROOT/launched" "$LH_TEST_ROOT/previous-launch"; fi;;
    'launch stub') printf launched >> "$LH_TEST_ROOT/launched";;
    'ps stub')
        if [ -f "$LH_TEST_ROOT/ps-fail" ]; then exit 1; fi
        # Like ps -o comm (executable only) or -o command (with arguments): emit PID EXE [ARGS].
        emit() { if [ "$1" = comm ]; then printf '%s %s\n' "$2" "$3"; else printf '%s %s%s\n' "$2" "$3" "${4:+ $4}"; fi; }
        mode=$1
        if [ -f "$LH_TEST_ROOT/stubborn" ] || [ -f "$LH_TEST_ROOT/launched" ]; then emit "$mode" 123 "$exe";
        elif [ -f "$LH_TEST_ROOT/running" ] && [ "$quits" -eq 0 ]; then emit "$mode" 123 "$exe"; fi
        # Reopened mid-run: once the new app is staged, or once rollback moved the data aside.
        if { [ -f "$LH_TEST_ROOT/reopen-on-new" ] && ls -d "$LH_MIGRATE_APPS_DIR"/.LearnHarness.app.lh-new-* >/dev/null 2>&1; } ||
            { [ -f "$LH_TEST_ROOT/reopen-on-aside" ] && ls -d "$LH_MIGRATE_DATA_DIR".fork-* >/dev/null 2>&1; }; then emit "$mode" 127 "$exe"; fi
        # A copy outside the selected install path, e.g. a mounted DMG.
        if [ -f "$LH_TEST_ROOT/elsewhere" ] && [ "$quits" -eq 0 ]; then emit "$mode" 124 /Volumes/LearnHarness/LearnHarness.app/Contents/MacOS/LearnHarness; fi
        # The Node-mode backend: same executable, plus server.js.
        if { [ -f "$LH_TEST_ROOT/backend" ] && [ "$quits" -eq 0 ]; } || [ -f "$LH_TEST_ROOT/backend-only" ]; then
            emit "$mode" 125 "$exe" "$LH_MIGRATE_APPS_DIR/LearnHarness.app/Contents/Resources/server/standalone/server.js"
        fi
        if [ -f "$LH_TEST_ROOT/relaunched" ] && [ "$quits" -lt 2 ]; then emit "$mode" 126 "$exe"; fi
        # Found only through LaunchServices: its executable does not end in MacOS/LearnHarness.
        if [ -f "$LH_TEST_ROOT/bundle-running" ] && [ "$quits" -eq 0 ]; then emit "$mode" 128 /Volumes/Other/LearnHarness.app/Contents/MacOS/LearnHarness-launcher; fi
        # Shells whose arguments name app paths; this script's own --dmg arguments.
        if [ -f "$LH_TEST_ROOT/phantom" ]; then
            emit "$mode" 130 /bin/bash "-c exec $exe --dmg /Volumes/LearnHarness/LearnHarness.app/Contents/MacOS/LearnHarness"
            emit "$mode" 131 /bin/bash "migrate-to-fork.sh --dmg $LH_TEST_ROOT/tmp/mnt/LearnHarness.app/Contents/MacOS/LearnHarness"
        fi;;
    'launchctl stub')
        if [ -f "$LH_TEST_ROOT/shipit" ]; then printf '"PID" = 123;\n'; exit 0; fi
        # An update restart relaunches the app while ShipIt finishes.
        if [ -f "$LH_TEST_ROOT/shipit-once" ]; then rm "$LH_TEST_ROOT/shipit-once"; touch "$LH_TEST_ROOT/relaunched"; printf '"PID" = 123;\n'; exit 0; fi
        if [ -f "$LH_TEST_ROOT/shipit-loaded" ]; then printf '{\n"LastExitStatus" = 256;\n}\n'; exit 0; fi
        if [ -f "$LH_TEST_ROOT/shipit-done" ]; then
            printf '{\n\t"Label" = "%s";\n\t"LastExitStatus" = 0;\n};\n' "$1"
            exit 0
        fi
        if [ -f "$LH_TEST_ROOT/shipit-garbled" ]; then
            printf '{\n"PreviousPID" = 123;\n"PreviousLastExitStatus" = 0;\n}\n'
            exit 0
        fi
        if { [ -f "$LH_TEST_ROOT/shipit-on-new" ] && ls -d "$LH_MIGRATE_APPS_DIR"/.LearnHarness.app.lh-new-* >/dev/null 2>&1; } ||
            { [ -f "$LH_TEST_ROOT/shipit-on-aside" ] && ls -d "$LH_MIGRATE_DATA_DIR".fork-* >/dev/null 2>&1; }; then
            printf '{\n"PID" = 123;\n"LastExitStatus" = 0;\n}\n'
            exit 0
        fi
        exit 113;;
    'lsappinfo stub')
        if [ -f "$LH_TEST_ROOT/bundle-running" ] && [ "$quits" -eq 0 ]; then printf 'ASN:0x0-0x1-"LearnHarness":\n    pid = 128 !cgsConnection\n'; fi
        # Entries with no pid, pid 0, a dead pid, and a live pid that is not a LearnHarness executable.
        if [ -f "$LH_TEST_ROOT/phantom" ]; then
            printf 'ASN:0x0-0x2-"LearnHarness":\nASN:0x0-0x3-"LearnHarness":\n    pid = 0\nASN:0x0-0x4-"LearnHarness":\n    pid = 99999\nASN:0x0-0x5-"LearnHarness":\n    "pid"=130\n'
        fi;;
esac
STUB
    done
    quit_hook='exec /bin/bash "$LH_TEST_ROOT/quit stub" "$@"'
    launch_hook='exec /bin/bash "$LH_TEST_ROOT/launch stub" "$@"'
    ps_hook='exec /bin/bash "$LH_TEST_ROOT/ps stub" "$@"'
    launchctl_hook='exec /bin/bash "$LH_TEST_ROOT/launchctl stub" "$@"'
    lsappinfo_hook='exec /bin/bash "$LH_TEST_ROOT/lsappinfo stub" "$@"'
    snapshot "$data" > "$case_root/original-data"
    snapshot "$apps/LearnHarness.app" > "$case_root/original-app"
}
# Independent fixture snapshot: sorted path, type, mode and bytes/link target.
snapshot() {
    (cd "$1"; find . -print | sort | while IFS= read -r item; do
        printf '%s\t%s\t' "$item" "$(stat -f '%Lp' "$item")"
        if [ -L "$item" ]; then printf 'l\t%s\n' "$(readlink "$item")"
        elif [ -d "$item" ]; then printf 'd\n'
        else printf 'f\t%s\n' "$(shasum -a 256 < "$item" | awk '{print $1}')"; fi
    done)
}
invoke() {
    # Fail closed: only case 2 may omit no-GUI, once, with every fixture hook.
    local gui_env=(LH_NO_GUI=1)
    [ "${LH_NO_GUI:-}" = 1 ] || return 99
    if [ "${1:-}" = --launch-stub-test ]; then
        [ "$number" = 2 ] && [ ! -e "$case_root/launch-exception-used" ] || return 99
        touch "$case_root/launch-exception-used"
        gui_env=(-u LH_NO_GUI)
        shift
    fi
    # Never invoke a production script without all five fixture hooks.
    [ "${quit_hook:-}" = 'exec /bin/bash "$LH_TEST_ROOT/quit stub" "$@"' ] &&
    [ "${launch_hook:-}" = 'exec /bin/bash "$LH_TEST_ROOT/launch stub" "$@"' ] &&
    [ "${ps_hook:-}" = 'exec /bin/bash "$LH_TEST_ROOT/ps stub" "$@"' ] &&
    [ "${launchctl_hook:-}" = 'exec /bin/bash "$LH_TEST_ROOT/launchctl stub" "$@"' ] &&
    [ "${lsappinfo_hook:-}" = 'exec /bin/bash "$LH_TEST_ROOT/lsappinfo stub" "$@"' ] || return 99
    for hook in quit launch ps launchctl lsappinfo; do [ -f "$case_root/$hook stub" ] || return 99; done
    env -i "${gui_env[@]}" HOME="$fake_home" TMPDIR="$case_tmp" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
        LH_TEST_ROOT="$case_root" LH_MIGRATE_APPS_DIR="$apps" LH_MIGRATE_DATA_DIR="$data" LH_MIGRATE_BACKUP_ROOT="$backups" \
        LH_MIGRATE_RELEASE_JSON="$case_root/releases.json" \
        LH_MIGRATE_QUIT_CMD="$quit_hook" LH_MIGRATE_LAUNCH_CMD="$launch_hook" \
        LH_MIGRATE_PS_CMD="$ps_hook" LH_MIGRATE_LAUNCHCTL_CMD="$launchctl_hook" LH_MIGRATE_LSAPPINFO_CMD="$lsappinfo_hook" \
        LH_MIGRATE_QUIT_TIMEOUT=1 LH_MIGRATE_SHIPIT_TIMEOUT=1 LH_MIGRATE_SHIPIT_SETTLE=0 LH_MIGRATE_LAUNCH_TIMEOUT=1 \
        /bin/bash "$@" > "$case_root/output" 2>&1
}
migrate() { invoke "$repo/scripts/migrate-to-fork.sh" "$@"; }
# Run a snippet with migrate-common.sh sourced as $1, under the same hooks and environment.
unit() { snippet=$1; shift; invoke -c "set -eu; . \"\$1\"; $snippet" unit "$repo/scripts/migrate-common.sh" "$@"; }
backup_path() { find "$backups" -mindepth 1 -maxdepth 1 -type d | sort | tail -1; }
unchanged_data() { snapshot "$data" > "$case_root/now-data"; cmp "$case_root/original-data" "$case_root/now-data"; }
unchanged_app() { snapshot "$apps/LearnHarness.app" > "$case_root/now-app"; cmp "$case_root/original-app" "$case_root/now-app"; }
no_backup() { [ ! -e "$backups" ]; }
expect_failure() { if migrate "$@"; then printf 'Expected migration failure\n' >&2; return 1; fi; }
case_1() {
    setup 1
    for bad_name in $'tab\tname' $'line\nname'; do
        printf 'unsupported filename\n' > "$data/$bad_name"
        expect_failure --dry-run
        no_backup
        grep -Fq 'Tabs and newlines in paths or link targets are unsupported.' "$case_root/output"
        mv "$data/$bad_name" "$case_root/rejected filename"
    done
    ln -s $'missing\n' "$data/newline-target"
    expect_failure --dry-run
    no_backup
    grep -Fq 'Tabs and newlines in paths or link targets are unsupported.' "$case_root/output"
    mv "$data/newline-target" "$case_root/rejected symlink"
    touch "$case_root/running"
    migrate --dry-run
    unchanged_data; unchanged_app
    backup=$(backup_path)
    [ "$(stat -f '%Lp' "$backups")" = 700 ]
    [ "$(stat -f '%Lp' "$backup")" = 700 ]
    for file in data.tar.gz manifest.txt rollback-fork.sh migrate-common.sh; do [ "$(stat -f '%Lp' "$backup/$file")" = 600 ]; done
    grep -qx $'chats\t2' "$backup/manifest.txt"
    grep -qx $'graph_files\t2' "$backup/manifest.txt"
    grep -qx $'files\t11' "$backup/manifest.txt"
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
    [ -f "$case_root/quit-called" ]
    [ "$(grep -Fxc 'LH_NO_GUI=1: not launching the app' "$case_root/output")" = 1 ]
    [ ! -e "$case_root/launched" ]
}
case_2() {
    setup 2
    invoke --launch-stub-test "$repo/scripts/migrate-to-fork.sh"
    [ -f "$case_root/launched" ]
    # The undo command is printed before the launch step.
    [ "$(grep -n '^To undo: ' "$case_root/output" | head -1 | cut -d: -f1)" -lt "$(grep -n '^Launching LearnHarness' "$case_root/output" | cut -d: -f1)" ]
    [ "$(grep -c '^Backup: ' "$case_root/output")" = 2 ]
    backup=$(sed -n 's/^Backup: //p' "$case_root/output" | sort -u)
    [ -n "$backup" ] && [ "$(printf '%s\n' "$backup" | wc -l)" -eq 1 ]
    [ -d "$backup" ]
    [ "$(grep -c '^To undo: ' "$case_root/output")" = 2 ]
    [ "$(grep '^To undo: ' "$case_root/output" | sort -u | wc -l)" -eq 1 ]
    [ "$(grep -n '^To undo: ' "$case_root/output" | head -1 | cut -d: -f1)" -lt "$(grep -n '^Verifying data\.\.\.$' "$case_root/output" | tail -1 | cut -d: -f1)" ]
    [ "$(tail -1 "$case_root/output")" = Done. ]
    unchanged_data
    [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$apps/LearnHarness.app/Contents/Info.plist")" = 0.3.4-fork.2 ]
    if xattr -lrs "$apps/LearnHarness.app" | grep -q com.apple.quarantine; then return 1; fi
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
    grep -Fq 'Your installed LearnHarness (0.3.10) is newer than the fork build (0.3.4-fork.2). Nothing was changed. Ask for a fork update.' "$case_root/output"
    [ "$(grep -Fxc 'LH_NO_GUI=1: not launching the app' "$case_root/output")" = 1 ]
    [ ! -e "$case_root/launched" ]
}
case_4() {
    setup 4
    expect_failure --dmg "$case_root/fork.dmg" --sha256 0000000000000000000000000000000000000000000000000000000000000000
    no_backup; unchanged_data; unchanged_app
    [ ! -e "$case_root/calls" ]
}
case_5() {
    setup 5
    renamed_data="$data literal\\t"
    mv "$data" "$renamed_data"
    data=$renamed_data
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
    grep -Fxq "Running LearnHarness copy: pid 123: $apps/LearnHarness.app/Contents/MacOS/LearnHarness" "$case_root/output"
    snapshot "$data" > "$case_root/timeout-data"
    cmp "$case_root/fork-data" "$case_root/timeout-data"
    snapshot "$apps/LearnHarness.app" > "$case_root/timeout-app"
    cmp "$case_root/fork-app" "$case_root/timeout-app"
    [ "$(find "$apps" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ]
    [ -z "$(find "$(dirname "$data")" -maxdepth 1 -name '.lh-restore.*')" ]
    mv "$case_root/stubborn" "$case_root/was-stubborn"
    invoke "$backup/rollback-fork.sh" "$backup"
    unchanged_data; unchanged_app
    aside=
    for candidate in "$data".fork-*; do
        if [ -d "$candidate" ]; then aside=$candidate; fi
    done
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
    touch "$case_root/running"
    mkdir -p "$case_root/checkout/.git"
    backups=$case_root/checkout/deep/backups
    expect_failure --dry-run
    no_backup; unchanged_data; unchanged_app
    grep -q 'inside a git checkout.*Nothing was changed.' "$case_root/output"
    [ ! -e "$case_root/quit-called" ]
    backups=$case_root/backup-link
    ln -s "$case_root/private backups" "$backups"
    expect_failure --dry-run
    grep -q 'must not be a symlink.*Nothing was changed.' "$case_root/output"
    [ ! -e "$case_root/quit-called" ]
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
case_11() {
    # One lock shared by migrate and rollback; stale locks need --force-unlock.
    setup 11
    lock_dir=$fake_home/LearnHarness-backups/.lock
    mkdir -p "$lock_dir"
    printf '%s\n' "$$" > "$lock_dir/pid"
    touch "$case_root/running"
    expect_failure --dry-run
    grep -Fq "Another migration or rollback is running (pid $$). Nothing was changed." "$case_root/output"
    no_backup; unchanged_data; unchanged_app
    [ ! -e "$case_root/quit-called" ]
    [ "$(cat "$lock_dir/pid")" = "$$" ]
    sleep 0 & dead=$!
    wait "$dead"
    printf '%s\n' "$dead" > "$lock_dir/pid"
    expect_failure --dry-run
    grep -Fq 'A stale lock from an interrupted run exists' "$case_root/output"
    grep -Fq 'rerun with --force-unlock' "$case_root/output"
    no_backup; [ -d "$lock_dir" ]; [ ! -e "$case_root/quit-called" ]
    migrate --dry-run --force-unlock
    grep -Fq "Removed a stale lock (pid $dead)." "$case_root/output"
    [ ! -e "$lock_dir" ]
    backup=$(backup_path)
    mkdir "$lock_dir"
    printf '%s\n' "$$" > "$lock_dir/pid"
    if invoke "$backup/rollback-fork.sh" "$backup"; then return 1; fi
    grep -Fq 'Another migration or rollback is running' "$case_root/output"
    unchanged_data; unchanged_app
    rm -rf "$lock_dir"
    invoke "$backup/rollback-fork.sh" "$backup"
    [ ! -e "$lock_dir" ]
}
case_12() {
    # Copies outside the install path, the backend, and update relaunches all block the backup.
    setup 12
    touch "$case_root/elsewhere"
    migrate --dry-run
    [ "$(cat "$case_root/quit-called")" = quit ]
    rm "$case_root/quit-called" "$case_root/elsewhere"
    # Found only by bundle id, with a live pid running a LearnHarness executable.
    touch "$case_root/bundle-running"
    migrate --dry-run
    [ "$(cat "$case_root/quit-called")" = quit ]
    rm "$case_root/quit-called" "$case_root/bundle-running"
    touch "$case_root/backend"
    migrate --dry-run
    [ "$(cat "$case_root/quit-called")" = quit ]
    rm "$case_root/quit-called" "$case_root/backend"
    touch "$case_root/running" "$case_root/shipit-once"
    migrate --dry-run
    [ "$(cat "$case_root/quit-called")" = quitquit ]
    grep -Fq 'LearnHarness relaunched after an update; asking it to quit again.' "$case_root/output"
    unchanged_data; unchanged_app
}
case_13() {
    # Full fork versions: revision-aware downgrade check and exact DMG version.
    setup 13
    fixture_app "$apps/LearnHarness.app" 0.3.4-fork.5
    snapshot "$apps/LearnHarness.app" > "$case_root/original-app"
    expect_failure
    grep -Fq 'Your installed LearnHarness (0.3.4-fork.5) is newer than the fork build (0.3.4-fork.2).' "$case_root/output"
    no_backup; unchanged_data; unchanged_app
    for allowed in 0.3.4-fork.2 0.3.4; do
        fixture_app "$apps/LearnHarness.app" "$allowed"
        migrate --dry-run
        rm -rf "$backups"
    done
    sed 's/"lh-0.3.4-fork.2"/"lh-0.3.4-fork.3"/' "$case_root/releases.json" > "$case_root/mismatch.json"
    touch "$case_root/running"
    expect_failure --release-json "$case_root/mismatch.json"
    grep -Fq 'The DMG app version (0.3.4-fork.2) differs from the release version (0.3.4-fork.3). Nothing was changed.' "$case_root/output"
    no_backup; unchanged_data; [ ! -e "$case_root/quit-called" ]
    mkdir "$case_root/official"
    fixture_app "$case_root/official/LearnHarness.app" 0.3.4
    hdiutil create -srcfolder "$case_root/official" -volname LearnHarness -format UDZO -ov "$case_root/official.dmg" >/dev/null
    expect_failure --dmg "$case_root/official.dmg"
    grep -Fq 'The DMG is not a fork build (version 0.3.4). Nothing was changed.' "$case_root/output"
    no_backup; unchanged_data; [ ! -e "$case_root/quit-called" ]
}
case_14() {
    # Backup root validation, private ACL-free backups, and a shell-escaped undo command.
    setup 14
    touch "$case_root/running"
    bad_roots=("$data/backups" "$data" relative/backups "$case_root/x/../backups" "$case_root/./backups")
    if [ -d "$case_root/user data/learnharness" ]; then bad_roots+=("$case_root/user data/learnharness/backups"); fi
    for bad in "${bad_roots[@]}"; do
        backups=$bad
        expect_failure --dry-run
        grep -Eq 'outside the data folder|absolute path|components\. Nothing was changed\.' "$case_root/output"
        [ ! -e "$case_root/quit-called" ]
        unchanged_data
    done
    acl_parent="$case_root/acl parent"
    mkdir "$acl_parent"
    chmod +a 'everyone allow list,search,read,readattr,readextattr,readsecurity,file_inherit,directory_inherit' "$acl_parent"
    ls -led "$acl_parent" > "$case_root/parent-acl"
    grep -Eq '^ [0-9]+: ' "$case_root/parent-acl"
    backups="$acl_parent/backups"
    migrate --dry-run
    backup=$(backup_path)
    if { ls -led "$backups" "$backup"; ls -leRA "$backups"; } | grep -Eq '^ [0-9]+: '; then return 1; fi
    rm "$case_root/quit-called"
    # An existing root keeps its mode and ACL; the run folder is still private and ACL-free.
    backups="$case_root/existing root"
    mkdir "$backups"
    chmod 755 "$backups"
    chmod +a 'everyone allow list,search,readattr,file_inherit,directory_inherit' "$backups"
    ls -led "$backups" > "$case_root/root-ls"; grep -E '^ [0-9]+: ' "$case_root/root-ls" > "$case_root/root-acl-before"
    [ -s "$case_root/root-acl-before" ]
    migrate --dry-run
    backup=$(backup_path)
    [ "$(stat -f '%Lp' "$backups")" = 755 ]
    ls -led "$backups" > "$case_root/root-ls"; grep -E '^ [0-9]+: ' "$case_root/root-ls" > "$case_root/root-acl-after"
    cmp "$case_root/root-acl-before" "$case_root/root-acl-after"
    [ "$(stat -f '%Lp' "$backup")" = 700 ]
    if { ls -led "$backup"; ls -leRA "$backup"; } | grep -Eq '^ [0-9]+: '; then return 1; fi
    # The default root is also the lock root: when this run creates it, it is private.
    backups="$fake_home/LearnHarness-backups"
    rm -rf "$backups"
    chmod +a 'everyone allow list,search,readattr,file_inherit,directory_inherit' "$fake_home"
    migrate --dry-run
    chmod -N "$fake_home"
    backup=$(backup_path)
    [ "$(stat -f '%Lp' "$backups")" = 700 ]
    if { ls -led "$backups" "$backup"; ls -leRA "$backup"; } | grep -Eq '^ [0-9]+: '; then return 1; fi
    rm "$case_root/quit-called"
    backups="$case_root/odd \$HOME \`touch pwned\` \"double\" 'single'"
    migrate --dry-run
    backup=$(backup_path)
    line=$(grep '^To undo: ' "$case_root/output" | head -1)
    # Parse only: never run the printed command (it carries none of the test hooks).
    (cd "$case_root" && eval "set -- ${line#To undo: }" &&
        [ "$#" -eq 3 ] && [ "$1" = /bin/bash ] && [ "$2" = "$backup/rollback-fork.sh" ] && [ "$3" = "$backup" ])
    [ ! -e "$case_root/pwned" ]
}
case_15() {
    # Function-level checks for paths no fixture can reach without launching or faulting.
    setup 15
    # Interrupted rollback data swap: the moved-aside data returns to the data path.
    if unit 'init; swap_data "$2"' "$case_root/missing staged dir"; then return 1; fi
    unchanged_data
    [ -z "$(find "$(dirname "$data")" -maxdepth 1 -name 'LearnHarness.fork-*')" ]
    # The archive check compares extracted contents with the manifest.
    migrate --dry-run
    backup=$(backup_path)
    mkdir "$case_root/tampered"
    tar -xpf "$backup/data.tar.gz" -C "$case_root/tampered"
    printf 'torn\n' >> "$case_root/tampered/LearnHarness/data/chats/one.json"
    tar -czpf "$case_root/tampered.tar.gz" -C "$case_root/tampered" LearnHarness
    check='init; manifest=$2/manifest.txt; present=yes; mkdir "$tmp/x"; extract_verified "$3" "$tmp/x" LearnHarness'
    unit "$check" "$backup" "$backup/data.tar.gz"
    if unit "$check" "$backup" "$case_root/tampered.tar.gz"; then return 1; fi
    grep -Fq 'Data manifest verification failed.' "$case_root/output"
    # Checksum failures propagate.
    printf 'secret\n' > "$case_root/unreadable"
    chmod 000 "$case_root/unreadable"
    if unit 'hash_file "$2"' "$case_root/unreadable"; then return 1; fi
    grep -Fq 'Could not compute the SHA-256 digest' "$case_root/output"
    chmod 600 "$case_root/unreadable"
    # The backend alone is not a window process.
    touch "$case_root/backend-only"
    unit 'init; wait_for_window'
    grep -Fxq 'Warning: no window process was seen; the install is complete.' "$case_root/output"
    rm "$case_root/backend-only"
    touch "$case_root/launched"
    unit 'init; wait_for_window'
    if grep -q Warning "$case_root/output"; then return 1; fi
    rm "$case_root/launched"
    # A listing failure after install only warns; before any change it reports nothing changed.
    touch "$case_root/ps-fail"
    unit 'init; wait_for_window'
    grep -Fxq 'Warning: could not read the process listing to confirm the app started.' "$case_root/output"
    if unit 'init; quit_app'; then return 1; fi
    grep -Fq 'Could not read the process listing. Nothing was changed.' "$case_root/output"
    rm "$case_root/ps-fail"
    # Cleanup detaches our DMG and releases the lock, even when a temp file cannot be removed.
    lock_dir=$fake_home/LearnHarness-backups/.lock
    if unit 'init; dmg=$2; mount_dmg; exit 3' "$case_root/fork.dmg"; then return 1; fi
    [ ! -e "$lock_dir" ]
    if hdiutil info | grep -Fq "$case_tmp"; then return 1; fi
    [ -z "$(find "$case_tmp" -mindepth 1 -maxdepth 1)" ]
    if unit 'init; mounted=yes; mkdir "$tmp/stuck"; touch "$tmp/stuck/file"; chmod 500 "$tmp/stuck"; exit 3'; then return 1; fi
    [ ! -e "$lock_dir" ]
    chmod -R u+w "$case_tmp"
}
case_16() {
    # Bundle-id entries without a live LearnHarness pid, and app paths in arguments, are not running copies.
    setup 16
    touch "$case_root/phantom"
    migrate
    [ "$(tail -1 "$case_root/output")" = Done. ]
    [ ! -e "$case_root/quit-called" ]
    if grep -Fq 'Running LearnHarness copy' "$case_root/output"; then return 1; fi
    [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$apps/LearnHarness.app/Contents/Info.plist")" = 0.3.4-fork.2 ]
}
case_17() {
    # A copy reopened mid-run stops each destructive swap; the backup stays.
    setup 17
    reopened='LearnHarness was reopened during the migration. Nothing more was changed. Quit it and run again.'
    touch "$case_root/reopen-on-new"
    expect_failure
    grep -Fxq "$reopened" "$case_root/output"
    grep -Fxq "Running LearnHarness copy: pid 127: $apps/LearnHarness.app/Contents/MacOS/LearnHarness" "$case_root/output"
    unchanged_data; unchanged_app
    backup=$(backup_path)
    [ -f "$backup/manifest.txt" ] && [ -f "$backup/data.tar.gz" ] && [ -d "$backup/LearnHarness.app" ]
    [ "$(find "$apps" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ]
    rm "$case_root/reopen-on-new"
    migrate
    backup=$(backup_path)
    snapshot "$data" > "$case_root/fork-data"
    snapshot "$apps/LearnHarness.app" > "$case_root/fork-app"
    # Rollback, before the data swap.
    touch "$case_root/reopen-on-new"
    if invoke "$backup/rollback-fork.sh" "$backup"; then return 1; fi
    grep -Fxq "$reopened" "$case_root/output"
    snapshot "$data" > "$case_root/now-data"; cmp "$case_root/fork-data" "$case_root/now-data"
    snapshot "$apps/LearnHarness.app" > "$case_root/now-app"; cmp "$case_root/fork-app" "$case_root/now-app"
    [ -z "$(find "$(dirname "$data")" -maxdepth 1 \( -name '.lh-restore.*' -o -name 'LearnHarness.fork-*' \))" ]
    [ "$(find "$apps" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ]
    rm "$case_root/reopen-on-new"
    # Rollback, before the app swap (the data is already restored).
    touch "$case_root/reopen-on-aside"
    if invoke "$backup/rollback-fork.sh" "$backup"; then return 1; fi
    grep -Fxq "$reopened" "$case_root/output"
    unchanged_data
    snapshot "$apps/LearnHarness.app" > "$case_root/now-app"; cmp "$case_root/fork-app" "$case_root/now-app"
    [ "$(find "$apps" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ]
    [ -n "$(find "$(dirname "$data")" -maxdepth 1 -name 'LearnHarness.fork-*')" ]
    [ -f "$backup/manifest.txt" ]
}
case_18() {
    # Trailing slashes in the data and apps paths; a failed dry run reopens the app it quit.
    setup 18
    data="$data/"; apps="$apps/"
    migrate
    data=${data%/}; apps=${apps%/}
    backup=$(backup_path)
    grep -Fxq "$(printf 'data_path\t%s' "$data")" "$backup/manifest.txt"
    grep -Fxq "$(printf 'old_app_path\t%s' "$apps/LearnHarness.app")" "$backup/manifest.txt"
    data="$data/"; apps="$apps/"
    invoke "$backup/rollback-fork.sh" "$backup"
    data=${data%/}; apps=${apps%/}
    unchanged_data; unchanged_app
    [ -z "$(find "$data" -maxdepth 1 -name '.fork-*')" ]
    [ -n "$(find "$(dirname "$data")" -maxdepth 1 -name 'LearnHarness.fork-*')" ]
    # A recorded data path with trailing slashes is normalized the same way.
    unit '[ "$(trim_slashes "/a b/c//")" = "/a b/c" ] && [ "$(trim_slashes /)" = / ] && [ "$(trim_slashes //)" = / ]'
    touch "$case_root/running"
    mkfifo "$data/fifo"
    expect_failure --dry-run
    grep -Fq 'Unsupported or unreadable entry in backup.' "$case_root/output"
    [ -f "$case_root/quit-called" ]
    grep -Fxq 'LH_NO_GUI=1: not launching the app' "$case_root/output"
    rm "$data/fifo"
}
case_19() {
    setup 19
    touch "$case_root/shipit-loaded"
    expect_failure
    grep -Fxq 'A LearnHarness update is still installing; try again in a minute. Nothing was changed.' "$case_root/output"
    no_backup; unchanged_data; unchanged_app
}
case_20() {
    setup 20
    cache=$fake_home/Library/Caches/com.learnharness.LearnHarness.ShipIt
    mkdir -p "$cache"
    printf 'old record\n' > "$cache/ShipItState.plist"
    migrate
    [ "$(tail -1 "$case_root/output")" = Done. ]
    [ "$(grep -Fxc 'Note: an old update record was found; continuing.' "$case_root/output")" = 1 ]
    [ "$(cat "$cache/ShipItState.plist")" = 'old record' ]
    unchanged_data
    # A dangling state-file symlink is also left in place.
    rm "$cache/ShipItState.plist"
    ln -s missing-state "$cache/ShipItState.plist"
    migrate
    [ "$(tail -1 "$case_root/output")" = Done. ]
    [ "$(grep -Fxc 'Note: an old update record was found; continuing.' "$case_root/output")" = 1 ]
    [ -L "$cache/ShipItState.plist" ]
    [ "$(readlink "$cache/ShipItState.plist")" = missing-state ]
    unchanged_data
}
case_21() {
    # A staged official update stops each destructive swap; the backup stays.
    setup 21
    installing='A LearnHarness update is still installing; try again in a minute.'
    touch "$case_root/shipit-on-new"
    expect_failure
    grep -Fxq "$installing Nothing was changed." "$case_root/output"
    unchanged_data; unchanged_app
    backup=$(backup_path)
    [ -f "$backup/manifest.txt" ] && [ -f "$backup/data.tar.gz" ] && [ -d "$backup/LearnHarness.app" ]
    [ "$(find "$apps" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ]
    rm "$case_root/shipit-on-new"
    migrate
    backup=$(backup_path)
    snapshot "$data" > "$case_root/fork-data"
    snapshot "$apps/LearnHarness.app" > "$case_root/fork-app"
    # Rollback, before the data swap.
    touch "$case_root/shipit-on-new"
    if invoke "$backup/rollback-fork.sh" "$backup"; then return 1; fi
    grep -Fxq "$installing Nothing was changed." "$case_root/output"
    snapshot "$data" > "$case_root/now-data"; cmp "$case_root/fork-data" "$case_root/now-data"
    snapshot "$apps/LearnHarness.app" > "$case_root/now-app"; cmp "$case_root/fork-app" "$case_root/now-app"
    [ -z "$(find "$(dirname "$data")" -maxdepth 1 \( -name '.lh-restore.*' -o -name 'LearnHarness.fork-*' \))" ]
    [ "$(find "$apps" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ]
    rm "$case_root/shipit-on-new"
    # Rollback, before the app swap (the data is already restored).
    touch "$case_root/shipit-on-aside"
    if invoke "$backup/rollback-fork.sh" "$backup"; then return 1; fi
    aside=$(find "$(dirname "$data")" -maxdepth 1 -name 'LearnHarness.fork-*')
    [ -d "$aside" ]
    grep -Fxq "$installing The backup data is restored, but the app is not. Rerun the rollback to finish. Your previous data is preserved at $aside." "$case_root/output"
    unchanged_data
    snapshot "$apps/LearnHarness.app" > "$case_root/now-app"; cmp "$case_root/fork-app" "$case_root/now-app"
    [ "$(find "$apps" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ]
    [ -f "$backup/manifest.txt" ]
    rm "$case_root/shipit-on-aside"
    invoke "$backup/rollback-fork.sh" "$backup"
    unchanged_data; unchanged_app
}
case_22() {
    setup 22
    touch "$case_root/shipit-done"
    migrate
    [ "$(tail -1 "$case_root/output")" = Done. ]
    if grep -Fq 'Note: an old update record was found; continuing.' "$case_root/output"; then return 1; fi
    unchanged_data
    cache=$fake_home/Library/Caches/com.learnharness.LearnHarness.ShipIt
    mkdir -p "$cache"
    printf 'old record\n' > "$cache/ShipItState.plist"
    migrate
    [ "$(tail -1 "$case_root/output")" = Done. ]
    [ "$(grep -Fxc 'Note: an old update record was found; continuing.' "$case_root/output")" = 1 ]
    [ "$(cat "$cache/ShipItState.plist")" = 'old record' ]
    unchanged_data
}
case_23() {
    setup 23
    touch "$case_root/shipit-garbled"
    expect_failure
    grep -Fxq 'A LearnHarness update is still installing; try again in a minute. Nothing was changed.' "$case_root/output"
    grep -Fxq 'Could not read the launchd status of com.learnharness.LearnHarness.ShipIt; treating it as an update still installing.' "$case_root/output"
    [ "$(grep -Fc 'com.learnharness.LearnHarness.ShipIt' "$case_root/output")" = 1 ]
    no_backup; unchanged_data; unchanged_app
}
for number in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23; do
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
