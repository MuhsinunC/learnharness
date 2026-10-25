# Fork workflow

This fork keeps its own changes as a stack of small pull requests on top of the upstream project
([amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness)), so upstream releases can be pulled in
and our changes replayed on top without merge commits.

## Branches

The names are declared in `.github/stack-branches.json`.

- **`main`** is the reviewed trunk. It moves only when a layer lands.
- **`ai-reviewed`** is the top of the open stack: it has every change, landed or not. Build and run from it.
  Nobody commits to it; it is moved to the top layer after every stack change (see below).
- **Layers** are branches named `feat/`, `fix/`, `docs/` or `sync/` plus `lh-<n>-<slug>`. Each one has one issue
  and one pull request titled `LH-<n>: <title> (#<issue>)`.
- History is linear: layers land by rebase, never squash or merge commit.

## One-time setup in a clone

```bash
git remote add upstream-src https://github.com/amosblomqvist/learnharness.git
git remote set-url --push upstream-src DISABLED      # never push to upstream
gh repo set-default MuhsinunC/learnharness           # gh must target the fork, not the parent
git config remote.pushDefault origin                # gh stack needs it when two remotes exist
gh extension install github/gh-stack
git branch main origin/main 2>/dev/null
```

Name the upstream remote `upstream-src`, never `upstream`: `gh stack` treats a remote named `upstream` as the place to
open pull requests.

## Add a layer

```bash
gh stack sync && gh stack top           # or, in a fresh clone: gh stack checkout <any open layer PR>
gh stack add feat/lh-<n>-<slug>
# commit; run npm run typecheck, npm run lint, npm test
gh stack submit --auto --open
gh pr edit feat/lh-<n>-<slug> --title "LH-<n>: <title> (#<issue>)" --body-file <file outside the repo>
```

The first layer of a new stack (nothing open) starts with `git switch main && gh stack init --base main <branch>`.

## Sync upstream

`.github/upstream-sync.json` records the last upstream commit we replayed (`last_synced`). A sync is its own `sync/`
layer at the bottom of the open stack; it replays only the new upstream commits onto `main` (or onto the previous sync layer while that one is still open):

```bash
git fetch upstream-src --tags
SYNC_BASE=main                                       # or the previous sync/ layer, if it has not landed yet
LAST=$(git show "$SYNC_BASE":.github/upstream-sync.json | jq -r .last_synced)
NEW=$(git rev-parse upstream-src/main)
git log --oneline "$LAST..$NEW"                      # what is new upstream

git switch -c sync-work "$NEW"
git rebase --onto "$SYNC_BASE" "$LAST" sync-work            # resolve conflicts keeping both sides' behaviour
jq --arg s "$NEW" --arg v "<version>" '.last_synced=$s | .version=$v' .github/upstream-sync.json > "$TMPDIR/s.json" \
  && mv "$TMPDIR/s.json" .github/upstream-sync.json
git commit -am "sync: record upstream <version>"
git branch -m sync-work sync/lh-<n>-upstream-<version>
```

Then gates (`npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, and the build) on the sync branch.

**Restack our open layers on top of it.** With no stack open, start one: `gh stack init --base main sync/lh-<n>-...`,
then `gh stack submit --auto --open`. With layers open, move the layers above `$SYNC_BASE` onto the sync branch and adopt the
new order (`<next layer>` is the layer that sat directly on `$SYNC_BASE`):

```bash
git rebase --onto sync/lh-<n>-upstream-<version> "$SYNC_BASE" <next layer>
gh stack rebase --upstack                            # from <next layer>: replays every higher layer
gh stack unstack --local
gh stack init --base main <every layer, bottom to top, with the sync layer in its place>
gh stack submit --auto --open                        # links the existing PRs in the new order
```

Check that each pull request's base is the layer below (`gh pr view <n> --json baseRefName`); fix one with
`gh pr edit <n> --base <layer below>`.

## Move ai-reviewed

After any stack change, point `ai-reviewed` at the top layer:

```bash
OLD=$(git rev-parse origin/ai-reviewed)
git push --force-with-lease=ai-reviewed:"$OLD" origin <top layer>:ai-reviewed
```

## Land layers

Bottom first, one at a time, after review: `gh stack merge <bottom PR> --rebase --yes` (never `gh pr merge`, which
refuses stacked pull requests). When the stack is fully landed, `ai-reviewed` equals `main`.
