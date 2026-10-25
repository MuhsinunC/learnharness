#!/bin/bash
# shellcheck disable=SC2034,SC2154

# Shared by the migration scripts and copied beside the backup's rollback script.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH LC_ALL=C

bundle_id=com.learnharness.LearnHarness
state_msg='Nothing was changed.'
fail() { printf '%s\n' "$*" >&2; exit 1; }
hash_file() {
    digest=$(shasum -a 256 < "$1") || fail "Could not compute the SHA-256 digest of $1. $state_msg"
    digest=${digest%% *}
    case "$digest" in *[!0-9a-f]*|'') fail "Invalid SHA-256 digest for $1. $state_msg";; esac
    [ "${#digest}" -eq 64 ] || fail "Invalid SHA-256 digest for $1. $state_msg"
    printf '%s\n' "$digest"
}
version() { /usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$1/Contents/Info.plist"; }
base_version() { printf '%s\n' "$1" | sed -E 's/-.*$//'; }
valid_base() { printf '%s\n' "$1" | /usr/bin/grep -Eq '^[0-9]+(\.[0-9]+)*$'; }
fork_version_ok() { printf '%s\n' "$1" | /usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+-fork\.[0-9]+$'; }
# Fork revision N of X-fork.N; official builds count as revision 0 of their base.
fork_revision() { case "$1" in *-fork.*) printf '%s\n' "${1##*-fork.}";; *) printf '0\n';; esac; }
newer() {
    awk -v a="$1" -v b="$2" 'BEGIN {na=split(a,x,"."); nb=split(b,y,"."); n=na>nb?na:nb; for(i=1;i<=n;i++){if(x[i]+0>y[i]+0)exit 0;if(x[i]+0<y[i]+0)exit 1}exit 1}'
}
# True when installed version $1 is newer than target fork version $2, fork revision included.
newer_version() {
    if newer "$(base_version "$1")" "$(base_version "$2")"; then return 0; fi
    if newer "$(base_version "$2")" "$(base_version "$1")"; then return 1; fi
    [ "$(fork_revision "$1")" -gt "$(fork_revision "$2")" ]
}
plain() {
    case "$1" in *$'\t'*|*'
'*) fail 'Tabs and newlines in paths or link targets are unsupported.';; esac
}
exists() { [ -e "$1" ] || [ -L "$1" ]; }
# Physical path of $1, resolving the longest existing ancestor (APFS is case-insensitive).
canonical() {
    head=$1; rest=
    while [ ! -d "$head" ]; do rest=/$(basename "$head")$rest; head=$(dirname "$head"); done
    head=$(cd "$head" && pwd -P)
    printf '%s%s\n' "${head%/}" "$rest" | tr '[:upper:]' '[:lower:]'
}
# One lock for migrate and rollback, held until exit. mkdir is atomic.
acquire_lock() {
    lock_root=$HOME/LearnHarness-backups
    lock=$lock_root/.lock
    [ ! -L "$lock_root" ] || fail "$lock_root must not be a symlink. Nothing was changed."
    (umask 077; mkdir -p "$lock_root")
    if mkdir "$lock" 2>/dev/null; then
        lock_held=yes
        printf '%s\n' "$$" > "$lock/pid"
        return
    fi
    raw_holder=$(cat "$lock/pid" 2>/dev/null || true)
    holder=$raw_holder
    case "$holder" in ''|*[!0-9]*) holder=;; esac
    # ps -p only reads the process table; nothing is signalled.
    if [ -n "$holder" ] && ps -p "$holder" >/dev/null 2>&1; then
        fail "Another migration or rollback is running (pid $holder). Nothing was changed."
    fi
    if [ "${force_unlock:-no}" != yes ]; then
        fail "A stale lock from an interrupted run exists at $lock (pid ${holder:-unknown} is not running). If no migration or rollback is running, rerun with --force-unlock. Nothing was changed."
    fi
    # Rename first, then recheck, so a fresh lock taken meanwhile is never deleted.
    stale=$lock.stale-$$
    mv "$lock" "$stale" || fail 'Could not remove the stale lock. Nothing was changed.'
    if [ "$(cat "$stale/pid" 2>/dev/null || true)" != "$raw_holder" ]; then
        mv "$stale" "$lock" 2>/dev/null || true
        fail 'The lock changed while it was being removed. Nothing was changed.'
    fi
    rm -rf "${stale:?}"
    printf 'Removed a stale lock (pid %s).\n' "${holder:-unknown}"
    mkdir "$lock" 2>/dev/null || fail 'Another migration or rollback is running. Nothing was changed.'
    lock_held=yes
    printf '%s\n' "$$" > "$lock/pid"
}
init() {
    [ "$(uname -s)" = Darwin ] && [ "$(sysctl -n hw.optional.arm64)" = 1 ] || fail 'An Apple Silicon Mac is required.'
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/lh-migrate.XXXXXX")
    mounted=no; new_app=; aside_app=; swap_pending=no; stage=; lock_held=no
    aside_data=none; data_swap_pending=no
    trap cleanup EXIT
    trap 'exit 1' HUP INT TERM
    acquire_lock
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
    if [ "$data_swap_pending" = yes ] && [ "$aside_data" != none ] && exists "$aside_data"; then
        if ! exists "$data"; then
            mv "$aside_data" "$data" || printf 'Restore your data from %s\n' "$aside_data" >&2
        else
            printf 'Your previous data is preserved at %s\n' "$aside_data" >&2
        fi
    fi
    if [ -n "$new_app" ] && exists "$new_app"; then rm -rf "${new_app:?}"; fi
    # Only the private staging wrapper, never live or aside data.
    if [ -n "$stage" ] && exists "$stage"; then rm -rf "${stage:?}"; fi
    rm -rf "${tmp:?}"
    if [ "$lock_held" = yes ]; then rm -rf "${lock:?}"; fi
    exit "$status"
}
# Test-only hooks: bash -c COMMAND hook ARG. Quit/launch get the app path as $1;
# LH_NO_GUI=1 skips the launch hook, open, and window-process wait.
# ps gets no arguments and prints "pid command"; launchctl gets the ShipIt label;
# lsappinfo gets the bundle id and prints a line for each running app instance.
# Test-only timeout overrides: QUIT_TIMEOUT=30, SHIPIT_TIMEOUT=60,
# SHIPIT_SETTLE=5, LAUNCH_TIMEOUT=30 (all prefixed LH_MIGRATE_).
processes() {
    if [ -n "${LH_MIGRATE_PS_CMD:-}" ]; then /bin/bash -c "$LH_MIGRATE_PS_CMD" hook; else ps -axo pid=,command=; fi
}
# Any LearnHarness (GUI or Node-mode backend) from any location: they all share the data folder.
app_running() {
    processes > "$tmp/ps" || fail "Could not read the process listing. $state_msg"
    LH_PROCESS_PREFIX="$app/Contents/" awk '
        {sub(/^[[:space:]]*[0-9]+[[:space:]]+/,"")}
        index($0,ENVIRON["LH_PROCESS_PREFIX"])==1 {found=1}
        {
            s=$0; key="/LearnHarness.app/Contents/MacOS/LearnHarness"
            while((i=index(s,key))>0) {rest=substr(s,i+length(key)); if(rest=="" || substr(rest,1,1)==" ")found=1; s=rest}
        }
        END{exit !found}' "$tmp/ps" && return 0
    if [ -n "${LH_MIGRATE_LSAPPINFO_CMD:-}" ]; then
        /bin/bash -c "$LH_MIGRATE_LSAPPINFO_CMD" hook "$bundle_id" > "$tmp/lsappinfo" || true
    else lsappinfo find "bundleid=$bundle_id" > "$tmp/lsappinfo" 2>/dev/null || true; fi
    [ -s "$tmp/lsappinfo" ]
}
# The installed app's window process; its Node-mode backend runs server.js with the same executable.
gui_running() {
    LH_PROCESS_EXE="$app/Contents/MacOS/LearnHarness" awk '
        {sub(/^[[:space:]]*[0-9]+[[:space:]]+/,""); exe=ENVIRON["LH_PROCESS_EXE"]; rest=substr($0,length(exe)+1)}
        index($0,exe)==1 && (rest=="" || substr(rest,1,1)==" ") && index($0,"/server/standalone/server.js")==0 {found=1}
        END{exit !found}' "$tmp/ps"
}
ship_running() {
    label=$bundle_id.ShipIt
    if [ -n "${LH_MIGRATE_LAUNCHCTL_CMD:-}" ]; then
        /bin/bash -c "$LH_MIGRATE_LAUNCHCTL_CMD" hook "$label" > "$tmp/launchctl" || true
    else launchctl list "$label" > "$tmp/launchctl" 2>/dev/null || true; fi
    if /usr/bin/grep -Eq '"PID"[[:space:]]*=' "$tmp/launchctl"; then return 0; fi
    processes > "$tmp/ps" || fail "Could not read the process listing. $state_msg"
    awk -v label="$label" '{sub(/^[[:space:]]*[0-9]+[[:space:]]+/,"");if(index($0,label)>0)found=1}END{exit !found}' "$tmp/ps"
}
request_quit() {
    if [ -n "${LH_MIGRATE_QUIT_CMD:-}" ]; then
        /bin/bash -c "$LH_MIGRATE_QUIT_CMD" hook "$app" || printf '%s\n' 'Could not ask LearnHarness to quit; please quit it yourself (Cmd-Q).'
    else
        # "is running" never launches the app; quit by bundle id reaches a copy at any path.
        osascript -e "if application id \"$bundle_id\" is running then tell application id \"$bundle_id\" to quit" >/dev/null 2>&1 ||
            printf '%s\n' 'Could not ask LearnHarness to quit; please quit it yourself (Cmd-Q).'
    fi
}
quit_app() {
    printf 'Waiting for LearnHarness to quit...\n'
    was_running=no; rounds=0
    while :; do
        if app_running; then
            was_running=yes
            request_quit
        fi
        start=$SECONDS
        while app_running; do
            [ "$((SECONDS-start))" -lt "$quit_timeout" ] || fail "LearnHarness is still running. Quit every copy of it and try again. $state_msg"
            sleep 1
        done
        printf 'Waiting for updates to finish...\n'
        start=$SECONDS; absent=-1
        while :; do
            if ship_running; then
                absent=-1
            else
                if [ "$absent" -eq -1 ]; then absent=$SECONDS; fi
                if [ "$((SECONDS-absent))" -ge "$settle" ]; then break; fi
            fi
            [ "$((SECONDS-start))" -lt "$ship_timeout" ] || fail "A LearnHarness update is still installing; try again in a minute. $state_msg"
            sleep 1
        done
        # An update restart can relaunch the app while ShipIt runs.
        app_running || return 0
        rounds=$((rounds+1))
        [ "$rounds" -lt 3 ] || fail "LearnHarness keeps relaunching. Quit it and try again. $state_msg"
        printf '%s\n' 'LearnHarness relaunched after an update; asking it to quit again.'
    done
}
launch_app() {
    if [ "${LH_NO_GUI:-}" = 1 ]; then
        printf '%s\n' 'LH_NO_GUI=1: not launching the app'
        return
    fi
    printf 'Launching LearnHarness...\n'
    if [ -n "${LH_MIGRATE_LAUNCH_CMD:-}" ]; then /bin/bash -c "$LH_MIGRATE_LAUNCH_CMD" hook "$app" || true
    else open -a "$app" || true; fi
    wait_for_window
}
# Warn only: by now the app may already be replaced, so never fail here.
wait_for_window() {
    start=$SECONDS
    while :; do
        if ! processes > "$tmp/ps"; then
            printf '%s\n' 'Warning: could not read the process listing to confirm the app started.'
            return 0
        fi
        if gui_running; then return 0; fi
        if [ "$((SECONDS-start))" -ge "$launch_timeout" ]; then
            if [ "${dry:-no}" = yes ]; then
                printf '%s\n' 'Warning: no window process was seen.'
            else
                printf '%s\n' 'Warning: no window process was seen; the install is complete.'
            fi
            return 0
        fi
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
    # Validate NUL-delimited names before using the format-1 line records.
    (cd "$root"; find . -print0) > "$tmp/paths"
    : > "$tmp/escaped-paths"
    : > "$tmp/links"
    while IFS= read -r -d '' path; do
        plain "$path"
        if [ -L "$root/$path" ]; then printf '%s\0' "$path" >> "$tmp/links"
        else
            case "$path" in *\\*)
                if [ -f "$root/$path" ]; then printf '%s\0' "$path" >> "$tmp/escaped-paths"; fi;;
            esac
        fi
    done < "$tmp/paths"
    (
        cd "$root"
        find . -exec stat -f $'%HT\t%Lp\t%N' {} + > "$tmp/metadata"
        # shasum escapes backslashes in names; hash those few paths via stdin.
        find . -type f ! -path '*\\*' -exec shasum -a 256 {} + > "$tmp/hashes"
        while IFS= read -r -d '' path; do
            printf '%s  %s\n' "$(hash_file "$path")" "$path" >> "$tmp/hashes"
        done < "$tmp/escaped-paths"
        while IFS= read -r -d '' path; do
            # -n adds no delimiter; the sentinel preserves target newlines for validation.
            value=$(readlink -n "$path" && printf '.')
            value=${value%.}
            plain "$value"
            printf '%s\t%s\n' "$path" "$value"
        done < "$tmp/links" > "$tmp/targets"
    )
    awk -F '\t' '
        FILENAME==ARGV[1] {hashes[substr($0,67)]=substr($0,1,64);next}
        FILENAME==ARGV[2] {targets[$1]=$2;next}
        {
            if($1=="Regular File") {kind="f";value=hashes[$3];if(length(value)!=64)exit 1}
            else if($1=="Directory") {kind="d";value="-"}
            else if($1=="Symbolic Link") {kind="l";value=targets[$3];if(!($3 in targets))exit 1}
            else exit 1
            print $3 "\tentry\t" kind "\t" $2 "\t" value "\t" $3
        }
    ' "$tmp/hashes" "$tmp/targets" "$tmp/metadata" > "$tmp/records" || fail 'Unsupported or unreadable entry in backup.'
    LC_ALL=C sort -t $'\t' -k1,1 "$tmp/records" > "$tmp/sorted"
    cut -f 2- "$tmp/sorted"
}
verify_data() {
    snapshot "$1" > "$tmp/live"
    /usr/bin/grep '^entry' "$manifest" > "$tmp/expected" || true
    cmp -s "$tmp/live" "$tmp/expected" || fail 'Data manifest verification failed.'
    if [ "$present" = yes ]; then [ -d "$1" ] || fail 'Data folder is missing.'
    else ! exists "$1" || fail 'Unexpected data folder.'; fi
}
# Extract archive $1 into empty dir $2 and check its only entry $3 against the manifest.
extract_verified() {
    tar -xpf "$1" -C "$2" || fail 'Could not extract the backup archive.'
    # BSD tar protects extraction paths; inspect actual names, not its escaped listing.
    (dir=$2; name=$3; shopt -s dotglob nullglob; set -- "$dir"/*
        [ "$#" -eq 1 ] && [ "$1" = "$dir/$name" ]
    ) || fail 'Unexpected archive contents.'
    verify_data "$2/$3"
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
# Move current data aside, then make staged dir $1 live (empty $1: leave the data path absent).
# Until both moves finish, cleanup moves the aside copy back if the data path is absent.
swap_data() {
    aside_data=none
    if exists "$data"; then
        aside_data=$(unique_path "$data.fork-$stamp")
        data_swap_pending=yes
        mv "$data" "$aside_data"
    fi
    if [ -n "$1" ]; then mv "$1" "$data"; fi
    data_swap_pending=no
}
