#!/bin/bash
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/migrate-common.sh
. "$script_dir/migrate-common.sh"
[ "$#" -eq 1 ] || fail 'Usage: rollback-fork.sh BACKUP_DIR'
backup=$1
printf 'Checking the backup...\n'
manifest=$backup/manifest.txt
[ -f "$manifest" ] || fail 'Backup manifest is missing.'
# Validate the record structure without executing any manifest text.
awk -F '\t' '
$1=="entry" {
 if(NF!=5 || $2 !~ /^[fdl]$/ || $3 !~ /^[0-7]+$/ || ($2=="f" && ($4 !~ /^[a-f0-9]+$/ || length($4)!=64)) || ($2=="d" && $4!="-") || ($5!="." && $5!~/^\.\//) || $5 ~ /(^|\/)\.\.(\/|$)/ || seen[$5]++)bad=1;
 counts[$2]++; if($5==".")root=$2;
 if($2=="f" && $5 ~ /^\.\/data\/chats\/[^\/]+\.json$/)chats++;
 if($2=="f" && index($5,"./data/graph/")==1)graph++;
 if(($2=="f" || $2=="l") && $5=="./data/settings.json")settings=1;
 next
}
$1=="sign_in" {if(NF!=2)bad=1;next}
{if(NF!=2 || headers[$1]++)bad=1; values[$1]=$2; if($1 !~ /^(format|created_utc|old_app_path|old_app_version|data_path|data_present|files|dirs|symlinks|chats|graph_files|settings|tarball_sha256)$/)bad=1}
END{
 split("format created_utc old_app_path old_app_version data_path data_present files dirs symlinks chats graph_files settings tarball_sha256",required," ");
 for(i in required)if(headers[required[i]]!=1)bad=1;
 split("files dirs symlinks chats graph_files",numeric," ");for(i in numeric)if(values[numeric[i]] !~ /^[0-9]+$/)bad=1;
 if(values["files"]!=counts["f"]+0 || values["dirs"]!=counts["d"]+0 || values["symlinks"]!=counts["l"]+0 || values["chats"]!=chats+0 || values["graph_files"]!=graph+0)bad=1;
 if(values["settings"]!=(settings?"yes":"no"))bad=1;
 if(values["data_present"]=="yes" && root!="d")bad=1;
 if(values["data_present"]=="no" && (counts["f"]+counts["d"]+counts["l"])!=0)bad=1;
 exit bad
}' "$manifest" || fail 'Malformed backup manifest.'
[ "$(field format)" = 1 ] || fail 'Unsupported manifest format.'
present=$(field data_present)
case "$present" in yes|no) ;; *) fail 'Invalid data presence field.';; esac
manifest_data=$(field data_path)
case "$manifest_data" in /*) ;; *) fail 'Invalid data path.';; esac
export LH_MIGRATE_DATA_DIR=${LH_MIGRATE_DATA_DIR:-"$manifest_data"}
old_path=$(field old_app_path); old_version=$(field old_app_version)
if [ "$old_path" != none ]; then
    case "$old_path" in /*/LearnHarness.app) ;; *) fail 'Invalid old app path.';; esac
    export LH_MIGRATE_APPS_DIR=${LH_MIGRATE_APPS_DIR:-"$(dirname "$old_path")"}
    [ -d "$backup/LearnHarness.app" ] || fail 'Backup app is missing.'
    codesign --verify "$backup/LearnHarness.app"
    [ "$(version "$backup/LearnHarness.app")" = "$old_version" ] || fail 'Backup app version mismatch.'
else [ "$old_version" = none ] || fail 'Invalid fresh-install manifest.'; fi
if [ "$present" = yes ]; then
    [ -f "$backup/data.tar.gz" ] || fail 'Backup tarball is missing.'
    [ "$(hash_file "$backup/data.tar.gz")" = "$(field tarball_sha256)" ] || fail 'Backup tarball digest mismatch.'
else [ "$(field tarball_sha256)" = none ] || fail 'Invalid absent-data manifest.'; fi
init
quit_app
# Pre-stage and verify before moving the current data, keeping it safe on errors.
stage=
printf 'Restoring data...\n'
if [ "$present" = yes ]; then
    mkdir -p "$(dirname "$data")"
    stage=$(mktemp -d "$(dirname "$data")/.lh-restore.XXXXXX")
    archive_name=$(basename "$manifest_data")
    tar -tzf "$backup/data.tar.gz" > "$tmp/archive-list"
    awk -v prefix="$archive_name" 'index($0,"/")==1 || $0 ~ /(^|\/)\.\.(\/|$)/ || ($0!=prefix && index($0,prefix "/")!=1){bad=1}END{exit bad}' "$tmp/archive-list" || fail 'Unsafe archive paths.'
    tar -xpf "$backup/data.tar.gz" -C "$stage"
    verify_data "$stage/$archive_name"
fi
if [ "$old_path" != none ]; then
    printf 'Restoring the app...\n'
    prepare_app "$backup/LearnHarness.app"
fi
aside_data=none
if exists "$data"; then
    aside_data=$(unique_path "$data.fork-$stamp")
    mv "$data" "$aside_data"
fi
if [ "$present" = yes ]; then
    mv "$stage/$archive_name" "$data"
    rmdir "$stage"
    stage=
fi
if [ "$old_path" != none ]; then
    swap_app
    [ "$(version "$app")" = "$old_version" ] || fail 'Restored app version mismatch.'
else printf '%s\n' 'Backup contains no old app; leaving the installed app in place.'; fi
printf 'Verifying the restored data and app...\n'
verify_data "$data"
printf 'Rollback complete. Preserved current data: %s\n' "$aside_data"
