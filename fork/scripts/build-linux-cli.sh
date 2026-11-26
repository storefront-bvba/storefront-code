#!/bin/bash
# Build the Storefront Code server/CLI runtime for Linux x64, the way upstream's release does
# (.github/workflows/release.yml and release-desktop.yml), inside an Ubuntu container.
#
#   fork/scripts/build-linux-cli.sh [version]      e.g. 0.1.12-storefront.1
#
# Upstream's archive script expects Ubuntu (it ships libatomic with its dpkg licence info), so the
# build runs in ubuntu:24.04 whatever the host is. It builds the committed HEAD of this clone
# (uncommitted changes are not included), skips upstream's relay tracing configuration (that is
# Axiom telemetry), and writes build/linux-cli/t3-<version>-linux-x64.tar.gz, smoke-tested.
# The telemetry guard runs on the source first and on the unpacked archive last (fork/GOAL.md,
# sync checklist steps 3 and 4); an archive that fails is not copied out.
# Install it with fork/scripts/install-runtime.sh.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT=$PWD
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
	base=$(git describe --tags --abbrev=0 --exclude '*-*' HEAD | sed 's/^v//')
	VERSION="${base}-storefront.$(git rev-list --count "v${base}..HEAD")"
fi
NODE_VERSION=$(node -p "require('./package.json').engines.node")
PNPM_VERSION=$(node -p "require('./package.json').packageManager.split('@')[1]")
OUT="$ROOT/build/linux-cli"
mkdir -p "$OUT"

echo "== Storefront Code $VERSION for linux-x64 from $(git rev-parse --short HEAD) (node $NODE_VERSION, pnpm $PNPM_VERSION)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || echo "note: uncommitted changes are not part of this build"

docker run --rm \
	-e VERSION="$VERSION" -e NODE_VERSION="$NODE_VERSION" -e PNPM_VERSION="$PNPM_VERSION" \
	-e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
	-v "$ROOT:/repo:ro" -v "$OUT:/out" \
	-v storefront-code-pnpm-store:/root/.local/share/pnpm/store \
	-v storefront-code-cargo:/root/.cargo/registry \
	ubuntu:24.04 bash -euo pipefail -c '
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git xz-utils build-essential \
	python3 pkg-config libsecret-1-dev patchelf libatomic1 jq >/dev/null

cd /tmp
curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
grep " node-v$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
tar -xJf "node-v$NODE_VERSION-linux-x64.tar.xz" -C /usr/local --strip-components=1
npm install -g --silent "pnpm@$PNPM_VERSION"
curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain stable
. "$HOME/.cargo/env"

git config --global --add safe.directory "*"
git clone -q --no-hardlinks /repo /build
cd /build
echo "== telemetry guard"
node fork/scripts/check-telemetry.mjs
echo "== install"
pnpm install --frozen-lockfile >/tmp/install.log 2>&1 || { tail -40 /tmp/install.log; exit 1; }
echo "== versions"
node scripts/update-release-package-versions.ts "$VERSION"
pnpm install --lockfile-only --ignore-scripts >/dev/null
pnpm install --frozen-lockfile >>/tmp/install.log 2>&1 || { tail -40 /tmp/install.log; exit 1; }
# Build steps spawn `vp` (Vite+) by name; CI installs it globally, here it comes from the workspace.
export PATH="/build/node_modules/.bin:$PATH"
echo "== web client and server"
pnpm exec vp run --filter t3 build
# The server build puts T3's development icons into dist/client; upstream's release replaces them
# with its brand, we put back our own from apps/web/public.
for icon in favicon.ico favicon-16x16.png favicon-32x32.png apple-touch-icon.png icon-192x192.png icon-512x512.png; do
	cp "apps/web/public/$icon" "apps/server/dist/client/$icon"
done
echo "== single executable"
node apps/server/scripts/cli.ts build-exe
echo "== resource monitor"
cargo build -q --locked --release --manifest-path native/resource-monitor/Cargo.toml
mkdir -p /tmp/resource-monitor/linux-x64
cp native/resource-monitor/target/release/t3-resource-monitor /tmp/resource-monitor/linux-x64/
echo "== archive"
node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$VERSION" \
	--resource-monitor-dir /tmp/resource-monitor --output-dir /tmp/release-cli
node scripts/smoke-cli-archive.ts --archive /tmp/release-cli/* --expect-version "$VERSION"
echo "== artifact check"
mkdir /tmp/artifact
tar -xzf /tmp/release-cli/*.tar.gz -C /tmp/artifact
node fork/scripts/check-telemetry.mjs --artifact /tmp/artifact
cp /tmp/release-cli/* /out/
chown "$HOST_UID:$HOST_GID" /out/*
'
ls -l "$OUT"/t3-"$VERSION"-linux-x64.tar.gz
