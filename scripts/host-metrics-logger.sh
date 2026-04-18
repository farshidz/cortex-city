#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/host-metrics-logger.sh [log-file] [interval-seconds]

Continuously write lightweight host and service diagnostics to disk.

Defaults:
  log-file         /opt/cortex-city/app/logs/host-metrics-<timestamp>.log
  interval-seconds 5
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

DEFAULT_LOG_DIR="/opt/cortex-city/app/logs"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG_FILE="${1:-$DEFAULT_LOG_DIR/host-metrics-$TIMESTAMP.log}"
INTERVAL="${2:-5}"
LOG_DIR="$(dirname "$LOG_FILE")"
LOCK_FILE="$LOG_DIR/host-metrics.lock"
PID_FILE="$LOG_DIR/host-metrics.pid"
CURRENT_LINK="$LOG_DIR/host-metrics-current.log"

mkdir -p "$LOG_DIR"

if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || [[ "$INTERVAL" -lt 1 ]]; then
  printf 'Interval must be a positive integer. Got: %s\n' "$INTERVAL" >&2
  exit 1
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf 'Another host-metrics-logger instance is already running.\n' >&2
  exit 1
fi

ln -sfn "$(basename "$LOG_FILE")" "$CURRENT_LINK"
printf '%s\n' "$$" >"$PID_FILE"

cleanup() {
  rm -f "$PID_FILE"
}
trap cleanup EXIT

exec >>"$LOG_FILE" 2>&1

section() {
  printf '\n=== %s ===\n' "$1"
}

safe_run() {
  local label="$1"
  shift

  printf -- '-- %s --\n' "$label"
  if ! "$@"; then
    printf 'command failed: %s\n' "$label"
  fi
}

service_snapshot() {
  local service="$1"
  printf -- '-- service:%s --\n' "$service"
  systemctl show "$service" \
    -p ActiveState \
    -p SubState \
    -p MainPID \
    -p ExecMainStatus \
    -p NRestarts \
    -p MemoryCurrent \
    -p CPUUsageNSec || true
}

process_count() {
  local label="$1"
  shift
  local count
  count="$({ "$@" 2>/dev/null || true; } | wc -l | tr -d ' ')"
  printf '%s=%s\n' "$label" "$count"
}

sample() {
  section "sample $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  safe_run "uptime" uptime
  safe_run "free -h" free -h
  safe_run "meminfo" grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree|Dirty|Writeback' /proc/meminfo

  printf -- '-- vmstat --\n'
  vmstat 1 2 | tail -1 || true

  if [[ -r /proc/pressure/cpu ]]; then
    safe_run "psi cpu" cat /proc/pressure/cpu
  fi
  if [[ -r /proc/pressure/memory ]]; then
    safe_run "psi memory" cat /proc/pressure/memory
  fi
  if [[ -r /proc/pressure/io ]]; then
    safe_run "psi io" cat /proc/pressure/io
  fi

  service_snapshot "cortex-city-web.service"
  service_snapshot "cortex-city-worker.service"

  printf -- '-- process counts --\n'
  process_count "codex" pgrep -a -u cortex -f codex
  process_count "claude" pgrep -a -u cortex -f claude
  process_count "gh" pgrep -a -u cortex -x gh
  process_count "git" pgrep -a -u cortex -x git
  process_count "git_remote_https" pgrep -a -u cortex -f git-remote-https
  process_count "next_server" pgrep -a -u cortex -f next-server

  safe_run "cortex ps by rss" bash -lc \
    "ps -u cortex -o pid,ppid,%cpu,%mem,rss,stat,etime,comm,args --sort=-rss | head -20"
  safe_run "top cpu all" bash -lc \
    "ps -eo pid,ppid,user,%cpu,%mem,rss,stat,comm,args --sort=-%cpu | head -20"
  safe_run "df -h" df -h /
  safe_run "ss -s" ss -s
}

section "host-metrics-logger start"
printf 'pid=%s\n' "$$"
printf 'hostname=%s\n' "$(hostname)"
printf 'interval_seconds=%s\n' "$INTERVAL"
printf 'log_file=%s\n' "$LOG_FILE"
printf 'current_link=%s\n' "$CURRENT_LINK"

sample

while true; do
  sleep "$INTERVAL"
  sample
done
