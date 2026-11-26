#!/bin/bash
# Install a Storefront Code runtime archive on this Linux host and switch the T3 background
# service to it, keeping all data (see fork/GOAL.md, "No data loss, no fresh start").
#
#   fork/scripts/install-runtime.sh build/linux-cli/t3-<version>-linux-x64.tar.gz
#
# T3 only trusts runtimes it downloads and checks itself (SHA256SUMS), and it removes anything else
# it finds in <T3 home>/runtime/versions. So this script hands the archive to T3's own installer:
# 1. Serves the archive and its SHA256SUMS as a release on 127.0.0.1 (T3CODE_RELEASE_BASE_URL).
# 2. Waits until no thread has an active run (a restart would cut it off).
# 3. Backs up the databases (SQLite online backup, consistent while the server runs) and the
#    small config files to <T3 home>/backups/<timestamp>-before-<version>.
# 4. Runs the new `t3 service install`: it downloads and verifies the runtime from that local
#    release, then the running launcher snapshots SQLite, starts the new runtime as a trial and
#    rolls back if it does not come up.
# 5. Links `t3` on PATH to the new runtime and checks the result.
# The previous runtime stays installed for rollback. This session may run inside the service:
# start it detached (systemd-run) when an agent runs it. Log: <T3 home>/backups/install-runtime.log
set -euo pipefail

ARCHIVE=$(realpath "$1")
T3_HOME="${T3CODE_HOME:-$HOME/.t3}"
LOG="$T3_HOME/backups/install-runtime.log"
mkdir -p "$T3_HOME/backups"
log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

file=$(basename "$ARCHIVE")
name=${file%.tar.gz}                         # t3-<version>-linux-x64
VERSION=${name#t3-}
VERSION=${VERSION%-linux-x64}
TARGET="$T3_HOME/runtime/versions/$VERSION"
log "== install $VERSION from $ARCHIVE"

work=$(mktemp -d)
server_pid=""
cleanup() { [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

# The new CLI, unpacked outside T3 home, runs the install.
tar -xzf "$ARCHIVE" -C "$work"
CLI="$work/$name/t3"
reported=$("$CLI" --version 2>&1 | tail -1)
log "new runtime reports: $reported"
case "$reported" in *"$VERSION"*) ;; *) log "version mismatch, stopping"; exit 1 ;; esac

# A local release laid out like GitHub's: <base>/v<version>/<file> and SHA256SUMS.
mkdir -p "$work/release/v$VERSION"
ln "$ARCHIVE" "$work/release/v$VERSION/$file" 2>/dev/null || cp "$ARCHIVE" "$work/release/v$VERSION/$file"
(cd "$work/release/v$VERSION" && sha256sum "$file" >SHA256SUMS)
port=$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
python3 -I -m http.server "$port" --bind 127.0.0.1 --directory "$work/release" >/dev/null 2>&1 &
server_pid=$!
sleep 1
curl -fsS -o /dev/null "http://127.0.0.1:$port/v$VERSION/SHA256SUMS" || { log "local release not reachable"; exit 1; }

DB="$T3_HOME/userdata/statev2.sqlite"
ACTIVE="'queued','preparing','starting','running','waiting'"
active_runs() { sqlite3 "file:$DB?mode=ro" "select count(*) from orchestration_v2_projection_runs where status in ($ACTIVE)" 2>/dev/null || echo err; }
idle=0
while [ "$idle" -lt 2 ]; do
	n=$(active_runs)
	if [ "$n" = 0 ]; then idle=$((idle + 1)); else idle=0; fi
	[ "$idle" -lt 2 ] && { log "active runs: $n, waiting"; sleep 15; }
done
log "no active runs"

BACKUP="$T3_HOME/backups/$(date +%Y-%m-%d-%H%M)-before-$VERSION"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
for db in "$T3_HOME"/userdata/*.sqlite; do
	# server-owner.sqlite only marks which process owns the data; the server holds it exclusively.
	[ "$(basename "$db")" = server-owner.sqlite ] && continue
	sqlite3 -cmd ".timeout 30000" "$db" ".backup '$BACKUP/$(basename "$db")'"
done
sqlite3 "$BACKUP/statev2.sqlite" "pragma quick_check" | grep -qx ok || { log "backup check failed"; exit 1; }
for f in settings.json keybindings.json environment-id anonymous-id server-runtime.json; do
	[ -e "$T3_HOME/userdata/$f" ] && cp -p "$T3_HOME/userdata/$f" "$BACKUP/"
done
cp -p "$T3_HOME/service.env" "$BACKUP/"
threads_before=$(sqlite3 "file:$DB?mode=ro" "select count(*) from orchestration_v2_projection_threads")
log "backup in $BACKUP ($(du -sh "$BACKUP" | cut -f1)), threads: $threads_before"

log "switching the service"
T3CODE_RELEASE_BASE_URL="http://127.0.0.1:$port" "$CLI" service install 2>&1 | tee -a "$LOG"
[ -x "$TARGET/t3" ] || { log "runtime not installed in $TARGET"; exit 1; }
"$TARGET/t3" install 2>&1 | tee -a "$LOG" || true

ok=no
status=""
for i in $(seq 1 40); do
	sleep 5
	status=$("$TARGET/t3" service status 2>&1 || true)
	if echo "$status" | grep -q "t3@$VERSION" && curl -fsS -o /dev/null http://127.0.0.1:3773/; then ok=yes; break; fi
done
echo "$status" | tee -a "$LOG"
threads_after=$(sqlite3 "file:$DB?mode=ro" "select count(*) from orchestration_v2_projection_threads" 2>/dev/null || echo "?")
telemetry=no
for pid in $(pgrep -u "$(id -u)" -f 't3 serve'); do
	tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -qx 'T3CODE_TELEMETRY_ENABLED=false' && telemetry=yes
done
log "result: running new version=$ok, threads $threads_before -> $threads_after, telemetry opt-out in env=$telemetry"
notify-send "Storefront Code" "Server $VERSION: $( [ "$ok" = yes ] && echo actief || echo 'NIET actief, zie log'), threads $threads_before → $threads_after" 2>/dev/null || true
[ "$ok" = yes ]
