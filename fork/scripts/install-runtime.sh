#!/bin/bash
# Install a Storefront Code runtime archive on this Linux host and switch the T3 background
# service to it, keeping all data (see fork/GOAL.md, "No data loss, no fresh start").
#
#   fork/scripts/install-runtime.sh build/linux-cli/t3-<version>-linux-x64.tar.gz
#
# 1. Unpacks the runtime next to the current ones in <T3 home>/runtime/versions/<version>.
# 2. Waits until no thread has an active run (a restart would cut it off).
# 3. Backs up the databases (SQLite online backup, consistent while the server runs) and the
#    small config files to <T3 home>/backups/<timestamp>-before-<version>.
# 4. Runs `<new>/t3 service install`: the running launcher snapshots SQLite, starts the new
#    runtime as a trial and rolls back if it does not come up.
# 5. Links `t3` on PATH to the new runtime and checks the result.
# The previous runtime stays installed for rollback. This session may run inside the service:
# start it detached (systemd-run) when an agent runs it. Log: <T3 home>/backups/install-runtime.log
set -euo pipefail

ARCHIVE=$(realpath "$1")
T3_HOME="${T3CODE_HOME:-$HOME/.t3}"
VERSIONS="$T3_HOME/runtime/versions"
LOG="$T3_HOME/backups/install-runtime.log"
mkdir -p "$T3_HOME/backups"
log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

name=$(basename "$ARCHIVE" .tar.gz)          # t3-<version>-linux-x64
VERSION=${name#t3-}
VERSION=${VERSION%-linux-x64}
TARGET="$VERSIONS/$VERSION"
log "== install $VERSION from $ARCHIVE"

if [ ! -x "$TARGET/t3" ]; then
	staging=$(mktemp -d "$VERSIONS/.staging-XXXX")
	tar -xzf "$ARCHIVE" -C "$staging"
	src="$staging/$name"
	[ -x "$src/t3" ] || { log "archive has no $name/t3"; rm -rf "$staging"; exit 1; }
	mv "$src" "$TARGET"
	rm -rf "$staging"
	log "unpacked to $TARGET"
fi
reported=$("$TARGET/t3" --version 2>&1 | tail -1)
log "new runtime reports: $reported"
case "$reported" in *"$VERSION"*) ;; *) log "version mismatch, stopping"; exit 1 ;; esac

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
	sqlite3 "$db" ".backup '$BACKUP/$(basename "$db")'"
done
for f in settings.json keybindings.json environment-id anonymous-id server-runtime.json; do
	[ -e "$T3_HOME/userdata/$f" ] && cp -p "$T3_HOME/userdata/$f" "$BACKUP/"
done
cp -p "$T3_HOME/service.env" "$BACKUP/"
threads_before=$(sqlite3 "file:$DB?mode=ro" "select count(*) from orchestration_v2_projection_threads")
log "backup in $BACKUP ($(du -sh "$BACKUP" | cut -f1)), threads: $threads_before"

log "switching the service"
"$TARGET/t3" service install 2>&1 | tee -a "$LOG"
"$TARGET/t3" install 2>&1 | tee -a "$LOG" || true

ok=no
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
