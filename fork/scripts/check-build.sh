#!/bin/bash
# Typecheck and test gate for fork builds; fork/scripts/build-linux-cli.sh runs it in its container
# before it builds. A clean rebase can still break types or behaviour, and GitHub Actions are off in
# the fork, so this stands in for upstream's release quality and test jobs (.github/workflows/release.yml).
#
#   fork/scripts/check-build.sh       from an installed checkout (pnpm install done)
#
# It runs, in about four minutes on 24 cores:
# - the typecheck of every package;
# - the unit tests of every package and app except the server, web browser tests and the desktop
#   app (those need Chromium or Electron; the full server suite runs one file at a time and takes
#   far longer than a build);
# - the web app's unit tests;
# - the server tests beside each server file this branch changed since its base tag.
# Made for the Ubuntu build container: elsewhere the host can trip tests that pass there (on Arch,
# `sh` is bash and sets SHELL for install.test.ts; bootError.test.ts counts "outer" in /home/wouter).
set -euo pipefail

cd "$(dirname "$0")/../.."
export PATH="$PWD/node_modules/.bin:$PATH"
base=$(git describe --tags --abbrev=0 --exclude '*-*' HEAD)

# Tests that fail by design in the fork, by name (vitest matches "<describe> <test>"):
# our own bundle IDs (apps/mobile/app.config.test.ts) and our own release repository
# (apps/mobile/src/features/settings/environment-maintenance.test.ts, packages/ssh/src/tunnel.test.ts).
EXPECTED_FAILURES=(
	"keeps the iOS and Android identifiers"
	"keeps nightly and preview hosts on their channel without using the anonymous API quota"
	"finds a published preview beyond the ten-entry feed and first API page"
	"only downloads a release archive the host can run: Darwin arm64"
)
skip=$(printf '%s|' "${EXPECTED_FAILURES[@]}")
not_expected="^(?!.*(${skip%|})).*\$"

echo "== typecheck"
vp run typecheck

echo "== package tests"
vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!@t3tools/monorepo' \
	--filter '!@t3tools/web' --filter '!@t3tools/desktop' --filter '!@t3tools/marketing' \
	test -t "$not_expected"

echo "== web unit tests"
(cd apps/web && vp test run --project unit)

echo "== server tests beside changed files (since $base)"
mapfile -t tests < <(git diff --name-only "$base" HEAD -- apps/server/src | while read -r file; do
	case "$file" in
	*.test.ts | *.test.tsx) test=$file ;;
	*.ts | *.tsx) test=${file%.*}.test.${file##*.} ;;
	*) continue ;;
	esac
	if [ -f "$test" ]; then echo "${test#apps/server/}"; fi
done | sort -u)
if [ "${#tests[@]}" -gt 0 ]; then
	printf '  %s\n' "${tests[@]}"
	# `t3 triage` is off in the fork; its tests exercise the upstream flow behind the opt-in.
	(cd apps/server && STOREFRONT_TRIAGE=1 vp test run "${tests[@]}")
else
	echo "  none"
fi
echo "== gate passed"
