# Move to the fork

Requirements: an Apple Silicon Mac. Nothing else needs to be installed. The fork build from `MuhsinunC/learnharness` is ad-hoc signed and **not notarized**.

Download `migrate-to-fork.sh`, `rollback-fork.sh`, and `migrate-common.sh` from this repository's `scripts/` directory into the same folder. In Terminal, change to that folder and run:

```sh
/bin/bash migrate-to-fork.sh --dry-run
/bin/bash migrate-to-fork.sh
```

The script selects the newest fork release, checks its SHA-256 digest, quits LearnHarness, waits for any pending official update, and backs up your app and all its data. A dry run also quits the app for a consistent backup, but does not install anything; it reopens the app if it was running. macOS may show an Automation prompt to allow Terminal to quit LearnHarness. If permission is denied, quit LearnHarness yourself with Cmd-Q.

The installation replaces the app, removes its quarantine attribute, verifies its signature, and opens it once. It never modifies or deletes your data, sign-in files, updater cache, or launchd jobs. The summary shows counts and sign-in filenames, never file contents.

Private backups live in `~/LearnHarness-backups/<UTC timestamp>/`. Each includes the complete data archive (including sign-in files), the old app when present, a checksum manifest, and rollback scripts. Keep this folder private and delete it yourself when satisfied.

To undo, use the exact command printed at the end, for example:

```sh
/bin/bash "$HOME/LearnHarness-backups/<UTC timestamp>/rollback-fork.sh" "$HOME/LearnHarness-backups/<UTC timestamp>"
```

Rollback preserves the current data beside its original folder with a `.fork-<UTC timestamp>` suffix, verifies and restores the backup data, and restores the old app. A fresh-install backup has no old app, so rollback leaves the installed app in place.

If you see “Your installed LearnHarness … is newer than the fork build …”, nothing was changed: ask for a fork update. “A LearnHarness update is still installing; try again in a minute. Nothing was changed.” means wait and rerun. If the window process is not seen after installation, the script warns; you can open the installed app yourself.
