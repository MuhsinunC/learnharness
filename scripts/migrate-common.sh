#!/bin/bash
# shellcheck disable=SC2034,SC2154

# Shared by the migration scripts and copied beside the backup's rollback script.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH LC_ALL=C

fail() { printf '%s\n' "$*" >&2; exit 1; }
hash_file() { shasum -a 256 < "$1" | awk '{print $1}'; }
version() { /usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$1/Contents/Info.plist"; }
base_version() { printf '%s\n' "${1#v}" | sed -E 's/-.*$//'; }
valid_base() { printf '%s\n' "$1" | /usr/bin/grep -Eq '^[0-9]+(\.[0-9]+)*$'; }
newer() {
    awk -v a="$1" -v b="$2" 'BEGIN {na=split(a,x,"."); nb=split(b,y,"."); n=na>nb?na:nb; for(i=1;i<=n;i++){if(x[i]+0>y[i]+0)exit 0;if(x[i]+0<y[i]+0)exit 1}exit 1}'
}
plain() {
    case "$1" in *"$(printf '\t')"*|*'
'*) fail 'Tabs and newlines in paths or link targets are unsupported.';; esac
}
exists() { [ -e "$1" ] || [ -L "$1" ]; }
init() {
    [ "$(uname -s)" = Darwin ] && [ "$(sysctl -n hw.optional.arm64)" = 1 ] || fail 'An Apple Silicon Mac is required.'
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/lh-migrate.XXXXXX")
    mounted=no; new_app=; aside_app=; swap_pending=no
    trap cleanup EXIT
    trap 'exit 1' HUP INT TERM
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    data=${LH_MIGRATE_DATA_DIR:-"$HOME/Library/Application Support/LearnHarness"}
    apps=${LH_MIGRATE_APPS_DIR:-/Applications}
    if [ -z "${LH_MIGRATE_APPS_DIR:-}" ] && [ ! -d "$apps/LearnHarness.app" ] && [ -d "$HOME/Applications/LearnHarness.app" ]; then apps=$HOME/Applications; fi
    app=$apps/LearnHarness.app
    plain "$data"; plain "$app"
    case "$data" in /*) ;; *) fail 'Data path must be absolute.';; esac
    [ ! -L "$data" ] || fail 'The data folder itself must not be a symlink.'
    [ -d "$apps" ] && [ -w "$apps" ] || fail 'The Applications directory must exist and be writable.'
    quit_timeout=${LH_MIGRATE_QUIT_TIMEOUT:-30}
    ship_timeout=${LH_MIGRATE_SHIPIT_TIMEOUT:-60}
    settle=${LH_MIGRATE_SHIPIT_SETTLE:-5}
    launch_timeout=${LH_MIGRATE_LAUNCH_TIMEOUT:-30}
    for seconds in "$quit_timeout" "$ship_timeout" "$settle" "$launch_timeout"; do
        case "$seconds" in ''|*[!0-9]*) fail 'Timeouts must be non-negative integer seconds.';; esac
    done
}
cleanup() {
    status=$?
    trap - EXIT
    if [ "$mounted" = yes ]; then hdiutil detach "$tmp/mnt" >/dev/null 2>&1 || true; fi
    if [ "$swap_pending" = yes ] && [ -n "$aside_app" ] && exists "$aside_app" && ! exists "$app"; then
        mv "$aside_app" "$app" || printf 'Restore the preserved app from %s\n' "$aside_app" >&2
    fi
    if [ -n "$new_app" ] && exists "$new_app"; then rm -rf "${new_app:?}"; fi
    rm -rf "${tmp:?}"
    exit "$status"
}
# Test-only hooks: bash -c COMMAND hook ARG. Quit/launch get the app path as $1;
# ps gets no arguments and prints "pid command"; launchctl gets the ShipIt label.
# Test-only timeout overrides: QUIT_TIMEOUT=30, SHIPIT_TIMEOUT=60,
# SHIPIT_SETTLE=5, LAUNCH_TIMEOUT=30 (all prefixed LH_MIGRATE_).
processes() {
    if [ -n "${LH_MIGRATE_PS_CMD:-}" ]; then /bin/bash -c "$LH_MIGRATE_PS_CMD" hook; else ps -axo pid=,command=; fi
}
app_running() {
    processes > "$tmp/ps" || fail 'Could not read the process listing. Nothing was changed.'
    LH_PROCESS_PREFIX="$app/Contents/${1:-}" awk '{sub(/^[[:space:]]*[0-9]+[[:space:]]+/,"");if(index($0,ENVIRON["LH_PROCESS_PREFIX"])==1)found=1}END{exit !found}' "$tmp/ps"
}
ship_running() {
    label=com.learnharness.LearnHarness.ShipIt
    if [ -n "${LH_MIGRATE_LAUNCHCTL_CMD:-}" ]; then
        /bin/bash -c "$LH_MIGRATE_LAUNCHCTL_CMD" hook "$label" > "$tmp/launchctl" || true
    else launchctl list "$label" > "$tmp/launchctl" 2>/dev/null || true; fi
    if /usr/bin/grep -Eq '"PID"[[:space:]]*=' "$tmp/launchctl"; then return 0; fi
    processes > "$tmp/ps" || fail 'Could not read the process listing. Nothing was changed.'
    awk -v label="$label" '{sub(/^[[:space:]]*[0-9]+[[:space:]]+/,"");if(index($0,label)>0)found=1}END{exit !found}' "$tmp/ps"
}
quit_app() {
    was_running=no
    if app_running; then
        was_running=yes
        if [ -n "${LH_MIGRATE_QUIT_CMD:-}" ]; then
            /bin/bash -c "$LH_MIGRATE_QUIT_CMD" hook "$app" || printf '%s\n' 'Could not ask LearnHarness to quit; please quit it yourself (Cmd-Q).'
        else
            osascript -e 'quit app "LearnHarness"' >/dev/null 2>&1 || printf '%s\n' 'Could not ask LearnHarness to quit; please quit it yourself (Cmd-Q).'
        fi
    fi
    start=$SECONDS
    while app_running; do
        [ "$((SECONDS-start))" -lt "$quit_timeout" ] || fail 'LearnHarness is still running. Nothing was changed.'
        sleep 1
    done
    start=$SECONDS; absent=-1
    while :; do
        if ship_running; then
            absent=-1
        else
            if [ "$absent" -eq -1 ]; then absent=$SECONDS; fi
            if [ "$((SECONDS-absent))" -ge "$settle" ]; then break; fi
        fi
        [ "$((SECONDS-start))" -lt "$ship_timeout" ] || fail 'A LearnHarness update is still installing; try again in a minute. Nothing was changed.'
        sleep 1
    done
}
launch_app() {
    if [ -n "${LH_MIGRATE_LAUNCH_CMD:-}" ]; then /bin/bash -c "$LH_MIGRATE_LAUNCH_CMD" hook "$app" || true
    else open -a "$app" || true; fi
    start=$SECONDS
    until app_running MacOS/; do
        if [ "$((SECONDS-start))" -ge "$launch_timeout" ]; then printf '%s\n' 'Warning: no window process was seen; the install is complete.'; break; fi
        sleep 1
    done
}
mount_dmg() {
    mkdir -p "$tmp/mnt"
    hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$tmp/mnt" "$dmg" >/dev/null
    mounted=yes
    [ -d "$tmp/mnt/LearnHarness.app" ] || fail 'DMG does not contain LearnHarness.app.'
}
detach_dmg() { hdiutil detach "$tmp/mnt" >/dev/null; mounted=no; }
# Tab-separated records; spaces are literal. Include the root mode as entry '.'.
snapshot() {
    root=$1
    if ! exists "$root"; then return; fi
    [ -d "$root" ] && [ ! -L "$root" ] || fail 'Expected a real data/app directory.'
    (cd "$root"; find . -print) > "$tmp/paths"
    LC_ALL=C sort "$tmp/paths" > "$tmp/sorted"
    while IFS= read -r path; do
        plain "$path"
        full=$root/$path
        mode=$(stat -f '%Lp' "$full")
        if [ -L "$full" ]; then kind=l; value=$(readlink "$full"); plain "$value"
        elif [ -f "$full" ]; then kind=f; value=$(hash_file "$full")
        elif [ -d "$full" ]; then kind=d; value=-
        else fail 'Unsupported special file in backup.'; fi
        printf 'entry\t%s\t%s\t%s\t%s\n' "$kind" "$mode" "$value" "$path"
    done < "$tmp/sorted"
}
verify_data() {
    snapshot "$1" > "$tmp/live"
    /usr/bin/grep '^entry' "$manifest" > "$tmp/expected" || true
    cmp -s "$tmp/live" "$tmp/expected" || fail 'Data manifest verification failed.'
    if [ "$present" = yes ]; then [ -d "$1" ] || fail 'Data folder is missing.'
    else ! exists "$1" || fail 'Unexpected data folder.'; fi
}
field() { awk -F '\t' -v key="$1" '$1==key {print $2}' "$manifest"; }
summary() {
    printf 'Chats: %s; graph files: %s; settings: %s\n' "$(field chats)" "$(field graph_files)" "$(field settings)"
    printf 'Sign-in files (names only):\n'
    awk -F '\t' '$1=="sign_in"{print "  " $2}' "$manifest"
}
unique_path() {
    candidate=$1; suffix=2
    while exists "$candidate"; do candidate=$1-$suffix; suffix=$((suffix+1)); done
    printf '%s\n' "$candidate"
}
prepare_app() {
    new_app=$(unique_path "$apps/.LearnHarness.app.lh-new-$stamp")
    ditto "$1" "$new_app"
    xattr -dr com.apple.quarantine "$new_app"
    codesign --verify --deep --strict "$new_app"
}
swap_app() {
    aside_app=$(unique_path "$apps/.LearnHarness.app.lh-old-$stamp")
    swap_pending=yes
    if exists "$app"; then mv "$app" "$aside_app"; fi
    mv "$new_app" "$app"
    new_app=; swap_pending=no
    if exists "$aside_app"; then rm -rf "${aside_app:?}"; fi
    aside_app=
}
