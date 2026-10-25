#!/bin/bash
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/migrate-common.sh
. "$script_dir/migrate-common.sh"
dry=no; dmg=; expected_hash=; release_json=${LH_MIGRATE_RELEASE_JSON:-}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run) dry=yes; shift;;
        --dmg|--sha256|--release-json)
            [ "$#" -ge 2 ] || fail "Missing argument for $1"
            case "$1" in --dmg) dmg=$2;; --sha256) expected_hash=$2;; --release-json) release_json=$2;; esac
            shift 2;;
        -h|--help) printf '%s\n' 'Usage: migrate-to-fork.sh [--dry-run] [--dmg PATH [--sha256 HEX]] [--release-json PATH]'; exit 0;;
        *) fail "Unknown option: $1";;
    esac
done
[ -n "$dmg" ] || [ -z "$expected_hash" ] || fail '--sha256 requires --dmg.'
init
if [ -z "$dmg" ]; then
    printf 'Downloading the release...\n'
    if [ -z "$release_json" ]; then
        release_json=$tmp/releases.json
        curl -fL 'https://api.github.com/repos/MuhsinunC/learnharness/releases?per_page=100' -o "$release_json"
    fi
    osascript -l JavaScript - "$release_json" > "$tmp/release" <<'JXA'
ObjC.import('Foundation');
function run(argv) {
    var text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
    if (!text) throw Error('Cannot read release JSON');
    var releases = JSON.parse(ObjC.unwrap(text));
    if (!Array.isArray(releases)) throw Error('Expected releases array');
    function parts(tag) { return tag.replace(/^v/, '').split(/-fork\.|\./).map(Number); }
    function compare(a,b) {
        var x=parts(a.tag_name), y=parts(b.tag_name), xn=x.pop(), yn=y.pop();
        for(var i=0;i<Math.max(x.length,y.length);i++) {var d=(x[i]||0)-(y[i]||0);if(d)return d;}
        return xn-yn;
    }
    releases=releases.filter(function(r){return !r.draft && /^v?[0-9]+(\.[0-9]+)*-fork\.[0-9]+$/.test(r.tag_name);}).sort(compare);
    if (!releases.length) throw Error('No fork release found');
    var r=releases[releases.length-1];
    var assets=r.assets.filter(function(a){return /^LearnHarness-.*-arm64\.dmg$/.test(a.name);});
    if(assets.length!==1) throw Error('Expected one arm64 DMG asset');
    var a=assets[0];
    if(typeof a.digest!=='string' || !/^sha256:[a-fA-F0-9]{64}$/.test(a.digest)) throw Error('Missing or invalid SHA-256 digest');
    if(typeof a.browser_download_url!=='string' || /[\r\n]/.test(a.browser_download_url)) throw Error('Invalid download URL');
    return [r.tag_name,a.browser_download_url,a.digest.slice(7).toLowerCase()].join('\n');
}
JXA
    fork_tag=$(sed -n '1p' "$tmp/release")
    url=$(sed -n '2p' "$tmp/release")
    expected_hash=$(sed -n '3p' "$tmp/release")
    dmg=$tmp/download.dmg
    curl -fL "$url" -o "$dmg"
else
    [ -f "$dmg" ] || fail 'Local DMG not found.'
    if [ -z "$expected_hash" ]; then printf '%s\n' 'Warning: local DMG has no supplied SHA-256 digest.'; fi
fi
if [ -n "$expected_hash" ]; then
    printf '%s\n' "$expected_hash" | /usr/bin/grep -Eq '^[a-fA-F0-9]{64}$' || fail 'Invalid SHA-256 digest.'
    expected_hash=$(printf '%s' "$expected_hash" | tr 'ABCDEF' 'abcdef')
    [ "$(hash_file "$dmg")" = "$expected_hash" ] || fail 'DMG SHA-256 digest mismatch. Nothing was changed.'
fi
if [ -z "${fork_tag:-}" ]; then
    mount_dmg
    fork_tag=$(version "$tmp/mnt/LearnHarness.app")
    detach_dmg
fi
fork_base=$(base_version "$fork_tag")
valid_base "$fork_base" || fail 'Invalid fork version.'
backup_root=${LH_MIGRATE_BACKUP_ROOT:-"$HOME/LearnHarness-backups"}
plain "$backup_root"
[ ! -L "$backup_root" ] || fail 'Backup root must not be a symlink. Nothing was changed.'
ancestor=$backup_root
while [ ! -d "$ancestor" ]; do ancestor=$(dirname "$ancestor"); done
ancestor=$(cd "$ancestor" && pwd -P)
existing=$ancestor
while :; do
    [ ! -e "$ancestor/.git" ] && [ ! -L "$ancestor/.git" ] || fail 'Backup root is inside a git checkout. Nothing was changed.'
    [ "$ancestor" != / ] || break
    ancestor=$(dirname "$ancestor")
done
if xcode-select -p >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
    if [ "$(git -C "$existing" rev-parse --is-inside-work-tree 2>/dev/null || true)" = true ]; then fail 'Backup root is inside a git checkout. Nothing was changed.'; fi
fi
quit_app
old_version=none; old_path=none
if [ -d "$app" ]; then
    old_path=$app; old_version=$(version "$app")
    old_base=$(base_version "$old_version")
    valid_base "$old_base" || fail 'Invalid installed version.'
    if newer "$old_base" "$fork_base"; then
        printf 'Your installed LearnHarness (%s) is newer than the fork build (%s). Nothing was changed. Ask for a fork update.\n' "$old_version" "$fork_tag"
        if [ "$was_running" = yes ]; then launch_app; fi
        exit 1
    fi
fi
backup=$(unique_path "$backup_root/$stamp")
printf 'Backing up data...\n'
present=no; tar_hash=none
snapshot "$data" > "$tmp/data-entries"
if [ -d "$data" ]; then present=yes; fi
(
    umask 077
    mkdir -p "$backup_root"
    chmod 700 "$backup_root"
    mkdir "$backup"
    if [ "$present" = yes ]; then
        tar -czpf "$backup/data.tar.gz" -C "$(dirname "$data")" "$(basename "$data")"
        chmod 600 "$backup/data.tar.gz"
    fi
    cp "$script_dir/rollback-fork.sh" "$script_dir/migrate-common.sh" "$backup/"
    chmod 600 "$backup/rollback-fork.sh" "$backup/migrate-common.sh"
)
if [ "$present" = yes ]; then tar_hash=$(hash_file "$backup/data.tar.gz"); fi
if [ "$old_path" != none ]; then
    printf 'Copying the app into the backup...\n'
    ditto "$app" "$backup/LearnHarness.app"
fi
manifest=$backup/manifest.txt
(
    umask 077
    {
        printf 'format\t1\ncreated_utc\t%s\nold_app_path\t%s\nold_app_version\t%s\ndata_path\t%s\ndata_present\t%s\n' "$stamp" "$old_path" "$old_version" "$data" "$present"
        awk -F '\t' '$2=="f"{f++}$2=="d"{d++}$2=="l"{l++}END{printf "files\t%d\ndirs\t%d\nsymlinks\t%d\n",f,d,l}' "$tmp/data-entries"
        awk -F '\t' '$2=="f" && $5 ~ /^\.\/data\/chats\/[^\/]+\.json$/{n++}END{printf "chats\t%d\n",n}' "$tmp/data-entries"
        awk -F '\t' '$2=="f" && index($5,"./data/graph/")==1{n++}END{printf "graph_files\t%d\n",n}' "$tmp/data-entries"
        awk -F '\t' '($2=="f" || $2=="l") && $5=="./data/settings.json"{found=1}END{printf "settings\t%s\n",found?"yes":"no"}' "$tmp/data-entries"
        awk -F '\t' '$2=="f" && ($5=="./auth.json" || $5 ~ /\/[^\/]*-credentials\.json$/){print "sign_in\t" substr($5,3)}' "$tmp/data-entries"
        printf 'tarball_sha256\t%s\n' "$tar_hash"
        cat "$tmp/data-entries"
    } > "$manifest"
    chmod 600 "$manifest"
)
printf 'Verifying data...\n'
verify_data "$data"
if [ "$dry" = yes ]; then
    printf 'Dry run: would mount the DMG read-only, copy, remove quarantine, verify its signature, and swap %s.\n' "$app"
else
    printf 'Installing the fork...\n'
    mount_dmg
    prepare_app "$tmp/mnt/LearnHarness.app"
    [ "$(base_version "$(version "$new_app")")" = "$fork_base" ] || fail 'DMG app version differs from release version.'
    detach_dmg
    if [ "$old_path" != none ]; then
        printf 'Verifying the backup app copy...\n'
        snapshot "$app" > "$tmp/old-app"
        snapshot "$backup/LearnHarness.app" > "$tmp/backup-app"
        cmp -s "$tmp/old-app" "$tmp/backup-app" || fail 'Backup app verification failed.'
    fi
    swap_app
    [ "$(base_version "$(version "$app")")" = "$fork_base" ] || fail 'Installed version verification failed.'
    xattr -lr "$app" > "$tmp/xattrs"
    ! /usr/bin/grep -Fq 'com.apple.quarantine' "$tmp/xattrs" || fail 'Quarantine remains on installed app.'
    codesign --verify "$app"
fi
printf 'Verifying data...\n'
verify_data "$data"
summary
printf 'Backup: %s\n' "$backup"
if [ "$dry" = no ] || [ "$was_running" = yes ]; then launch_app; fi
printf 'Done.\nTo undo: /bin/bash "%s/rollback-fork.sh" "%s"\n' "$backup" "$backup"
