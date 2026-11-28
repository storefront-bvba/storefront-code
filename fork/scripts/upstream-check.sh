#!/bin/bash
# Gather what a rebase of `storefront` onto a newer upstream stable tag would bring and cost, for
# the storefront-upstream-check skill. Reads refs only; the guards run in a scratch worktree beside
# this checkout, removed on exit. Never rebases, builds or restarts anything.
#   fork/scripts/upstream-check.sh [vX.Y.Z]   (default: the newest stable upstream tag)
set -euo pipefail

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$REPO"
git fetch upstream --tags --quiet
git fetch origin storefront --quiet || true

BASE=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' storefront)
NEW=${1:-$(git tag -l 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)}
OUT="${TMPDIR:-/tmp}/storefront-upstream-check/$NEW"
mkdir -p "$OUT"
section() { printf '\n== %s\n' "$*"; }

section "Versions"
echo "fork base:      $BASE ($(git log -1 --format=%cs "$BASE"))"
echo "newest stable:  $NEW ($(git log -1 --format=%cs "$NEW"))"
echo "upstream main:  $(git rev-list --count "$NEW..upstream/main") commits past $NEW"
[ "$(git rev-parse storefront)" = "$(git rev-parse origin/storefront 2>/dev/null || true)" ] ||
	echo "note: local storefront differs from origin/storefront"
if [ "$BASE" = "$NEW" ] || git merge-base --is-ancestor "$NEW" "$BASE"; then
	echo "Nothing newer than the fork base."
	exit 0
fi
TAGS=$(git tag -l 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V |
	awk -v b="$BASE" -v n="$NEW" '$0==b{on=1;next} on{print} $0==n{exit}')
echo "stable tags:    $(echo $TAGS) ($(git rev-list --count "$BASE..$NEW") commits)"

section "Release notes (saved in $OUT)"
: >"$OUT/prs.txt"
for t in $TAGS; do
	gh release view "$t" -R pingdotgg/t3code --json body -q .body >"$OUT/notes-$t.md"
	sed -n '1,/<details>/p' "$OUT/notes-$t.md" | grep -v '<details>' | sed "s/^/[$t] /"
	grep -E '^\* [a-z]+(\([^)]*\))?!?:' "$OUT/notes-$t.md" |
		sed -E 's/ by @[^ ]+ in https:\/\/github.com\/pingdotgg\/t3code\/pull\/([0-9]+).*/ #\1/' >>"$OUT/prs.txt"
done
echo "PRs by type: $(sed -E 's/^\* ([a-z]+).*/\1/' "$OUT/prs.txt" | sort | uniq -c | sort -rn | awk '{printf "%s %s, ", $1, $2}')"
echo "PRs by scope (top 12): $(grep -oE '^\* [a-z]+\([^)]+\)' "$OUT/prs.txt" | sed -E 's/.*\(//;s/\)//' |
	sort | uniq -c | sort -rn | head -12 | awk '{printf "%s %s, ", $1, $2}')"

section "Features and performance"
grep -E '^\* (feat|perf)' "$OUT/prs.txt" || true

section "Watched paths (sync checklist step 1)"
git diff --stat "$BASE" "$NEW" -- apps/server/src/telemetry packages/shared/src/cliRelease.ts \
	apps/mobile/app.config.ts infra/relay apps/server/src/relay apps/server/src/cloud | tail -25

section "Dependencies (package.json, pnpm-workspace.yaml)"
git diff "$BASE" "$NEW" -- '**/package.json' package.json pnpm-workspace.yaml |
	grep -E '^[+-] ' | grep -vE '"version"|^[+-] *#' || echo "(none)"

section "New database migrations"
git diff --name-status --diff-filter=AD "$BASE" "$NEW" -- apps/server/src/persistence/Migrations/ || true

section "Hosts in added shipped lines (the guard below judges them)"
git diff "$BASE" "$NEW" -- . ':!**/*.test.*' ':!**/*.md' ':!docs/**' ':!.repos/**' ':!**/test/**' \
	':!**/__tests__/**' ':!patches/**' | grep '^+' | grep -oE 'https?://[a-zA-Z0-9.-]+' |
	sort | uniq -c | sort -rn || true

section "Files our patches change that upstream changed too"
git diff --name-only "$BASE" storefront -- . ':!fork/**' | sort >"$OUT/ours.txt"
git diff --name-only "$BASE" "$NEW" | sort >"$OUT/theirs.txt"
comm -12 "$OUT/ours.txt" "$OUT/theirs.txt" | while read -r f; do
	echo "$f"
	git log --format='    %h %s' "$BASE..$NEW" -- "$f" | head -5
done

section "Dry-run merge of $NEW into storefront: conflicts"
CONFLICTS=$(git merge-tree --write-tree --name-only --no-messages storefront "$NEW" | tail -n +2 || true)
if [ -z "$CONFLICTS" ]; then echo "(none)"; else
	for f in $CONFLICTS; do
		echo "$f"
		git log --format='    %h %s' "$BASE..$NEW" -- "$f" | head -5
	done
fi

section "Guards on storefront + $NEW (scratch worktree)"
SCRATCH="$(dirname "$REPO")/$(basename "$REPO")-upstream-check"
[ -e "$SCRATCH" ] && { echo "$SCRATCH exists; remove it first"; exit 1; }
cleanup() { git -C "$REPO" worktree remove --force "$SCRATCH" >/dev/null 2>&1 || true; }
trap cleanup EXIT
git worktree add --quiet --detach "$SCRATCH" storefront
git -C "$SCRATCH" -c user.name=check -c user.email=check@localhost merge --quiet --no-commit --no-ff "$NEW" \
	>/dev/null 2>&1 || true
MARKED=$(git -C "$SCRATCH" diff --name-only --diff-filter=U)
[ -n "$MARKED" ] && echo "conflict markers left in (findings in these files may be false): $(echo $MARKED)"
for guard in check-telemetry.mjs check-push-port.mjs; do
	echo "-- $guard"
	if (cd "$SCRATCH" && node "fork/scripts/$guard"); then echo "-> passed"; else echo "-> FAILED (exit $?)"; fi
done
