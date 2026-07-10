#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/host-metrics-logger.sh [log-file] [interval-seconds]

Continuously write lightweight host and service diagnostics to disk.
Default logs rotate daily, keep 3 days of host metrics files, and emit compact
one-line samples every 60 seconds. Set HOST_METRICS_MODE=verbose or
HOST_METRICS_DETAIL_EVERY=1 temporarily when debugging an active incident.

Defaults:
  log-file         /opt/cortex-city/app/logs/host-metrics-<YYYY-MM-DD>.log
  interval-seconds 60

Environment:
  HOST_METRICS_INTERVAL_SECONDS  Default interval when no positional interval is passed. Default: 60
  HOST_METRICS_RETENTION_DAYS    Retention for host-metrics-*.log files. Default: 3
  HOST_METRICS_MODE              compact or verbose. Default: compact
  HOST_METRICS_DETAIL_EVERY      Emit a verbose diagnostic snapshot every N compact samples. Default: 60
                                 Set to 0 to disable periodic verbose snapshots.
  HOST_METRICS_PROCESS_USER      User whose agent processes should be counted. Default: cortex
  HOST_METRICS_WEB_SERVICE       systemd web service name. Default: cortex-city-web.service
  HOST_METRICS_WORKER_SERVICE    systemd worker service name. Default: cortex-city-worker.service
  HOST_METRICS_ONCE              Set to 1 for a single sample, useful in tests/manual checks.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

DEFAULT_LOG_DIR="/opt/cortex-city/app/logs"
LOG_FILE_ARG="${1:-}"
INTERVAL="${2:-${HOST_METRICS_INTERVAL_SECONDS:-60}}"
LOG_DIR="$(dirname "${LOG_FILE_ARG:-$DEFAULT_LOG_DIR/host-metrics.log}")"
LOCK_FILE="$LOG_DIR/host-metrics.lock"
PID_FILE="$LOG_DIR/host-metrics.pid"
CURRENT_LINK="$LOG_DIR/host-metrics-current.log"
RETENTION_DAYS="${HOST_METRICS_RETENTION_DAYS:-3}"
METRICS_MODE="${HOST_METRICS_MODE:-compact}"
DETAIL_EVERY="${HOST_METRICS_DETAIL_EVERY:-60}"
PROCESS_USER="${HOST_METRICS_PROCESS_USER:-cortex}"
WEB_SERVICE="${HOST_METRICS_WEB_SERVICE:-cortex-city-web.service}"
WORKER_SERVICE="${HOST_METRICS_WORKER_SERVICE:-cortex-city-worker.service}"
RUN_ONCE="${HOST_METRICS_ONCE:-0}"
LOG_FILE=""
LOG_DATE=""
SAMPLE_COUNT=0

mkdir -p "$LOG_DIR"

if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || [[ "$INTERVAL" -lt 1 ]]; then
  printf 'Interval must be a positive integer. Got: %s\n' "$INTERVAL" >&2
  exit 1
fi

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || [[ "$RETENTION_DAYS" -lt 1 ]]; then
  printf 'HOST_METRICS_RETENTION_DAYS must be a positive integer. Got: %s\n' "$RETENTION_DAYS" >&2
  exit 1
fi

if [[ "$METRICS_MODE" != "compact" && "$METRICS_MODE" != "verbose" ]]; then
  printf 'HOST_METRICS_MODE must be compact or verbose. Got: %s\n' "$METRICS_MODE" >&2
  exit 1
fi

if ! [[ "$DETAIL_EVERY" =~ ^[0-9]+$ ]]; then
  printf 'HOST_METRICS_DETAIL_EVERY must be a non-negative integer. Got: %s\n' "$DETAIL_EVERY" >&2
  exit 1
fi

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    printf 'Another host-metrics-logger instance is already running.\n' >&2
    exit 1
  fi
else
  printf 'warning: flock is unavailable; continuing without an inter-process lock\n' >&2
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

sanitize_key() {
  printf '%s' "$1" | tr -c '[:alnum:]_' '_'
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

systemctl_value() {
  local service="$1"
  local property="$2"

  if ! command -v systemctl >/dev/null 2>&1; then
    printf 'unavailable'
    return
  fi

  systemctl show "$service" -p "$property" --value 2>/dev/null || printf 'unknown'
}

service_snapshot_compact() {
  local service="$1"
  local key
  key="$(sanitize_key "$service")"

  printf ' svc_%s_active=%s' "$key" "$(systemctl_value "$service" ActiveState)"
  printf ' svc_%s_sub=%s' "$key" "$(systemctl_value "$service" SubState)"
  printf ' svc_%s_pid=%s' "$key" "$(systemctl_value "$service" MainPID)"
  printf ' svc_%s_status=%s' "$key" "$(systemctl_value "$service" ExecMainStatus)"
  printf ' svc_%s_restarts=%s' "$key" "$(systemctl_value "$service" NRestarts)"
  printf ' svc_%s_mem_bytes=%s' "$key" "$(systemctl_value "$service" MemoryCurrent)"
  printf ' svc_%s_cpu_ns=%s' "$key" "$(systemctl_value "$service" CPUUsageNSec)"
}

process_count() {
  local label="$1"
  shift
  local count
  count="$({ "$@" 2>/dev/null || true; } | wc -l | tr -d ' ')"
  printf '%s=%s\n' "$label" "$count"
}

process_count_compact() {
  local label="$1"
  shift
  local key count
  key="$(sanitize_key "$label")"
  count="$({ "$@" 2>/dev/null || true; } | wc -l | tr -d ' ')"
  printf ' proc_%s=%s' "$key" "$count"
}

print_proc_load() {
  if [[ -r /proc/loadavg ]]; then
    awk '{printf " load1=%s load5=%s load15=%s runnable=%s last_pid=%s", $1, $2, $3, $4, $5}' /proc/loadavg
    return
  fi

  printf ' load1=unknown load5=unknown load15=unknown runnable=unknown last_pid=unknown'
}

print_proc_uptime() {
  if [[ -r /proc/uptime ]]; then
    awk '{printf " uptime_seconds=%d", $1}' /proc/uptime
    return
  fi

  printf ' uptime_seconds=unknown'
}

print_meminfo() {
  if [[ ! -r /proc/meminfo ]]; then
    printf ' meminfo=unavailable'
    return
  fi

  awk '
    /^(MemTotal|MemAvailable|SwapTotal|SwapFree|Dirty|Writeback):/ {
      key=tolower($1)
      gsub(":", "", key)
      printf " mem_%s_kb=%s", key, $2
    }
  ' /proc/meminfo
}

print_pressure() {
  local resource="$1"
  local file="/proc/pressure/$resource"

  if [[ ! -r "$file" ]]; then
    printf ' psi_%s=unavailable' "$resource"
    return
  fi

  awk -v resource="$resource" '
    /^some / {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^avg10=/) {
          split($i, parts, "=")
          some = parts[2]
        }
      }
    }
    /^full / {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^avg10=/) {
          split($i, parts, "=")
          full = parts[2]
        }
      }
    }
    END {
      if (some == "") some = "0.00"
      if (full == "") full = "0.00"
      printf " psi_%s_some_avg10=%s psi_%s_full_avg10=%s", resource, some, resource, full
    }
  ' "$file"
}

print_disk() {
  df -Pk / 2>/dev/null | awk 'NR == 2 {printf " root_size_kb=%s root_used_kb=%s root_avail_kb=%s root_use_pct=%s", $2, $3, $4, $5}'
  df -Pi / 2>/dev/null | awk 'NR == 2 {printf " root_inodes=%s root_iused=%s root_ifree=%s root_iuse_pct=%s", $2, $3, $4, $5}'
}

compact_sample() {
  printf 'ts=%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  print_proc_uptime
  print_proc_load
  print_meminfo
  print_pressure cpu
  print_pressure memory
  print_pressure io
  service_snapshot_compact "$WEB_SERVICE"
  service_snapshot_compact "$WORKER_SERVICE"
  process_count_compact "codex" pgrep -a -u "$PROCESS_USER" -f codex
  process_count_compact "claude" pgrep -a -u "$PROCESS_USER" -f claude
  process_count_compact "gh" pgrep -a -u "$PROCESS_USER" -x gh
  process_count_compact "git" pgrep -a -u "$PROCESS_USER" -x git
  process_count_compact "git_remote_https" pgrep -a -u "$PROCESS_USER" -f git-remote-https
  process_count_compact "next_server" pgrep -a -u "$PROCESS_USER" -f next-server
  print_disk
  printf '\n'
}

verbose_sample() {
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

  service_snapshot "$WEB_SERVICE"
  service_snapshot "$WORKER_SERVICE"

  printf -- '-- process counts --\n'
  process_count "codex" pgrep -a -u "$PROCESS_USER" -f codex
  process_count "claude" pgrep -a -u "$PROCESS_USER" -f claude
  process_count "gh" pgrep -a -u "$PROCESS_USER" -x gh
  process_count "git" pgrep -a -u "$PROCESS_USER" -x git
  process_count "git_remote_https" pgrep -a -u "$PROCESS_USER" -f git-remote-https
  process_count "next_server" pgrep -a -u "$PROCESS_USER" -f next-server

  safe_run "cortex ps by rss" bash -lc \
    "ps -u $(printf '%q' "$PROCESS_USER") -o pid,ppid,%cpu,%mem,rss,stat,etime,comm,args --sort=-rss | head -20"
  safe_run "top cpu all" bash -lc \
    "ps -eo pid,ppid,user,%cpu,%mem,rss,stat,comm,args --sort=-%cpu | head -20"
  safe_run "df -h" df -h /
  safe_run "df -ih" df -ih /
  safe_run "ss -s" ss -s
}

sample() {
  SAMPLE_COUNT=$((SAMPLE_COUNT + 1))

  if [[ "$METRICS_MODE" == "verbose" ]]; then
    verbose_sample
    return
  fi

  compact_sample

  if [[ "$DETAIL_EVERY" -gt 0 && $((SAMPLE_COUNT % DETAIL_EVERY)) -eq 0 ]]; then
    verbose_sample
  fi
}

rotate_log_file
section "host-metrics-logger start"
printf 'pid=%s\n' "$$"
printf 'hostname=%s\n' "$(hostname)"
printf 'interval_seconds=%s\n' "$INTERVAL"
printf 'retention_days=%s\n' "$RETENTION_DAYS"
printf 'mode=%s\n' "$METRICS_MODE"
printf 'detail_every=%s\n' "$DETAIL_EVERY"
printf 'process_user=%s\n' "$PROCESS_USER"
printf 'web_service=%s\n' "$WEB_SERVICE"
printf 'worker_service=%s\n' "$WORKER_SERVICE"
printf 'log_file=%s\n' "$LOG_FILE"
printf 'current_link=%s\n' "$CURRENT_LINK"

sample

if [[ "$RUN_ONCE" == "1" ]]; then
  exit 0
fi

while true; do
  sleep "$INTERVAL"
  rotate_log_file
  sample
done
