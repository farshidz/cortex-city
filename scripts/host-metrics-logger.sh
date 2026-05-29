#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/host-metrics-logger.sh [log-file] [interval-seconds]

Continuously write lightweight host and service diagnostics to disk.
Default logs rotate daily and keep 7 days of host metrics files.

Defaults:
  log-file         /opt/cortex-city/app/logs/host-metrics-<YYYY-MM-DD>.log
  interval-seconds 5

Environment:
  HOST_METRICS_RETENTION_DAYS  Retention for host-metrics-*.log files. Default: 7
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

DEFAULT_LOG_DIR="/opt/cortex-city/app/logs"
LOG_FILE_ARG="${1:-}"
INTERVAL="${2:-5}"
LOG_DIR="$(dirname "${LOG_FILE_ARG:-$DEFAULT_LOG_DIR/host-metrics.log}")"
LOCK_FILE="$LOG_DIR/host-metrics.lock"
PID_FILE="$LOG_DIR/host-metrics.pid"
CURRENT_LINK="$LOG_DIR/host-metrics-current.log"
RETENTION_DAYS="${HOST_METRICS_RETENTION_DAYS:-7}"
LOG_FILE=""
LOG_DATE=""

mkdir -p "$LOG_DIR"

if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || [[ "$INTERVAL" -lt 1 ]]; then
  printf 'Interval must be a positive integer. Got: %s\n' "$INTERVAL" >&2
  exit 1
fi

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || [[ "$RETENTION_DAYS" -lt 1 ]]; then
  printf 'HOST_METRICS_RETENTION_DAYS must be a positive integer. Got: %s\n' "$RETENTION_DAYS" >&2
  exit 1
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf 'Another host-metrics-logger instance is already running.\n' >&2
  exit 1
fi

printf '%s\n' "$$" >"$PID_FILE"

cleanup() {
  rm -f "$PID_FILE"
}
trap cleanup EXIT

section() {
  printf '\n=== %s ===\n' "$1"
}

prune_old_logs() {
  local keep_mtime_days=$((RETENTION_DAYS - 1))
  find "$LOG_DIR" \
    -maxdepth 1 \
    -type f \
    -name 'host-metrics-*.log' \
    -mtime +"$keep_mtime_days" \
    ! -name "$(basename "$LOG_FILE")" \
    -delete
}

rotate_log_file() {
  if [[ -n "$LOG_FILE_ARG" ]]; then
    if [[ "$LOG_FILE" != "$LOG_FILE_ARG" ]]; then
      LOG_FILE="$LOG_FILE_ARG"
      ln -sfn "$(basename "$LOG_FILE")" "$CURRENT_LINK"
      exec >>"$LOG_FILE" 2>&1
    fi
    return
  fi

  local today
  today="$(date -u +%Y-%m-%d)"
  if [[ "$today" == "$LOG_DATE" ]]; then
    return
  fi

  LOG_DATE="$today"
  LOG_FILE="$DEFAULT_LOG_DIR/host-metrics-$today.log"
  ln -sfn "$(basename "$LOG_FILE")" "$CURRENT_LINK"
  exec >>"$LOG_FILE" 2>&1
  section "host-metrics-logger rotated"
  printf 'log_file=%s\n' "$LOG_FILE"
  prune_old_logs
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

rotate_log_file
section "host-metrics-logger start"
printf 'pid=%s\n' "$$"
printf 'hostname=%s\n' "$(hostname)"
printf 'interval_seconds=%s\n' "$INTERVAL"
printf 'retention_days=%s\n' "$RETENTION_DAYS"
printf 'log_file=%s\n' "$LOG_FILE"
printf 'current_link=%s\n' "$CURRENT_LINK"

sample

while true; do
  sleep "$INTERVAL"
  rotate_log_file
  sample
done
