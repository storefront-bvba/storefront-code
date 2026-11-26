#!/bin/bash
# Restart the T3 background service on this host once no thread runs, for changes that need only a
# restart (the managed policy, ~/.t3/service.env). A new runtime goes through install-runtime.sh.
# Start it detached, it outlives the agent that starts it:
#   systemd-run --user --collect --unit=storefront-code-restart fork/scripts/restart-when-idle.sh
set -euo pipefail

T3_HOME="${T3CODE_HOME:-$HOME/.t3}"
LOG="$T3_HOME/backups/restart-when-idle.log"
T3=$(readlink -f "$HOME/.local/bin/t3")
DB="$T3_HOME/userdata/statev2.sqlite"
ACTIVE="'queued','preparing','starting','running','waiting'"
mkdir -p "$T3_HOME/backups"
log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }
active_runs() { sqlite3 "file:$DB?mode=ro" "select count(*) from orchestration_v2_projection_runs where status in ($ACTIVE)" 2>/dev/null || echo err; }
threads() { sqlite3 "file:$DB?mode=ro" "select count(*) from orchestration_v2_projection_threads" 2>/dev/null || echo "?"; }

log "== restart when idle ($("$T3" --version 2>&1 | tail -1))"
idle=0
while [ "$idle" -lt 2 ]; do
	n=$(active_runs)
	if [ "$n" = 0 ]; then idle=$((idle + 1)); else idle=0; fi
	[ "$idle" -lt 2 ] && { log "active runs: $n, waiting"; sleep 15; }
done

# Secrets first: a policy that turns T3 Connect off unlinks the host at startup and removes its link.
BACKUP="$T3_HOME/backups/$(date +%Y-%m-%d-%H%M)-before-restart"
mkdir -m 700 -p "$BACKUP/secrets"
find "$T3_HOME/userdata/secrets" -mindepth 1 -maxdepth 1 ! -name 'dpop-proof-*' ! -name 'cloud-mint-*' \
	! -name 'cloud-health-*' -exec cp -a --reflink=auto -t "$BACKUP/secrets" {} +
cp -p "$T3_HOME/service.env" "$BACKUP/"
before=$(threads)
log "no active runs; secrets backed up in $BACKUP; restarting"
"$T3" service restart 2>&1 | tee -a "$LOG" || true

ok=no
for _ in $(seq 1 40); do
	sleep 5
	curl -fsS -o /dev/null http://127.0.0.1:3773/ && { ok=yes; break; }
done
sleep 10
policy=$("$T3" policy show 2>&1 | grep -c 'loaded no policy' || true)
tunnel=$(pgrep -u "$(id -u)" -f 'cloudflared tunnel' >/dev/null && echo yes || echo no)
telemetry=no
for pid in $(pgrep -u "$(id -u)" -f 't3 serve'); do
	tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -qx 'T3CODE_TELEMETRY_ENABLED=false' && telemetry=yes
done
log "result: up=$ok, policy loaded=$([ "$policy" = 0 ] && echo yes || echo no), Connect tunnel=$tunnel," \
	"telemetry opt-out=$telemetry, threads $before -> $(threads)"
notify-send "Storefront Code" "Herstart: $([ "$ok" = yes ] && echo actief || echo 'NIET actief'), Connect-tunnel: $tunnel" 2>/dev/null || true
[ "$ok" = yes ]
