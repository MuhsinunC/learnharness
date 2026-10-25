# Move to the fork

Requirements: an Apple Silicon Mac. The migration itself needs nothing else installed. “Log in with Claude” needs the Claude Code command-line tool (`claude`) in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.claude/local`, npm-global (`~/.npm-global/bin`), bun (`~/.bun/bin`), or nvm (`~/.nvm/versions/node/<version>/bin`). The Claude desktop app’s built-in copy does not count. The setting is under Settings → Providers → Subscriptions → Claude. The fork build from `MuhsinunC/learnharness` is ad-hoc signed and **not notarized**.

Download `migrate-to-fork.sh`, `rollback-fork.sh`, and `migrate-common.sh` from this repository's `scripts/` directory into the same folder. In Terminal, change to that folder and run:

```sh
/bin/bash migrate-to-fork.sh --dry-run
/bin/bash migrate-to-fork.sh
```

The script selects the newest fork release (tag `lh-<version>`, for example `lh-0.3.7-fork.1`), checks its SHA-256 digest, checks that the app inside the DMG has exactly that fork version, quits every running copy of LearnHarness (wherever it was opened from; only live processes of the app's own executable count, and a refusal lists the pid and path it saw), waits for any pending official update, and backs up your app and all its data. A local `--dmg` must contain a fork build (`X.Y.Z-fork.N`). A dry run also quits the app for a consistent backup, but does not install anything; it reopens the app if it was running, even when the dry run fails. macOS may show an Automation prompt to allow Terminal to quit LearnHarness. If permission is denied, quit LearnHarness yourself with Cmd-Q.

The installation copies the app, verifies its signature, then removes its quarantine attribute, replaces the installed app, and opens it once. Right before replacing the app (and, in a rollback, before moving data), the script checks again that LearnHarness is still closed; if it was reopened, it stops with “LearnHarness was reopened during the migration. Nothing more was changed. Quit it and run again.” and keeps the backup. This recheck also stops if an official update is still installing, with the same message below. It never modifies or deletes your data, sign-in files, updater cache, or launchd jobs. The summary shows counts and sign-in filenames, never file contents.

Private backups live in `~/LearnHarness-backups/<UTC timestamp>/`. Each includes the complete data archive (including sign-in files), the old app when present, a checksum manifest, and rollback scripts. The script makes each timestamp folder private (mode 700, no access-control entries) and checks the archive by extracting it before installing. A backup root the script creates is made private too; an existing one keeps its own permissions. A custom `LH_MIGRATE_BACKUP_ROOT` must be an absolute path outside the data folder. Keep this folder private and delete it yourself when satisfied.

Only one migration or rollback runs at a time; they share the lock `~/LearnHarness-backups/.lock`. If a run was interrupted, the next one reports a stale lock: when no other migration or rollback is running, rerun with `--force-unlock`.

To undo, use the exact command printed right after the app is replaced and again at the end, for example:

```sh
/bin/bash ~/LearnHarness-backups/20261025T120000Z/rollback-fork.sh ~/LearnHarness-backups/20261025T120000Z
```

The printed command uses the full path and is shell-escaped, so it is safe to paste even when the path has spaces or quotes.

Rollback preserves the current data beside its original folder with a `.fork-<UTC timestamp>` suffix, verifies and restores the backup data, and restores the old app. If rollback is interrupted before the restored data is in place, it moves the preserved data back. A fresh-install backup has no old app, so rollback leaves the installed app in place.

If you see “Your installed LearnHarness … is newer than the fork build …”, nothing was changed: ask for a fork update. This includes a newer fork revision of the same version (for example `0.3.7-fork.5` installed and `0.3.7-fork.2` selected). “A LearnHarness update is still installing; try again in a minute. Nothing was changed.” means the updater job is loaded, its state file exists, or its process runs; wait and rerun. If the window process is not seen after installation, the script warns; you can open the installed app yourself.
