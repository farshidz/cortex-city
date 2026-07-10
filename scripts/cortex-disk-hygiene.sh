#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/cortex-disk-hygiene.sh [--apply] [options]

Prune Cortex City production disk usage from old app/metrics logs and common
package/browser caches for the service user. The script is dry-run by default;
pass --apply from cron/systemd once the dry run looks right.

This script intentionally does not remove managed repos or task worktrees under
.cortex/repos/*/.worktrees. Use the app's worktree cleanup path for that.

Options:
  --apply                         Delete/prune instead of printing a dry run.
  --dry-run                       Print what would be pruned. Default.
  --app-dir DIR                   Cortex app directory. Default: CORTEX_APP_DIR or cwd.
  --log-dir DIR                   Log directory. Default: CORTEX_LOG_DIR or APP_DIR/logs.
  --home DIR                      Service-user home. Default: CORTEX_HOME_DIR or HOME.
  --host-metrics-retention-days N Retain host-metrics-*.log for N days. Default: 3.
  --app-log-retention-days N      Retain server-*.log for N days. Default: 14.
  --task-log-retention-days N     Retain task-*.log/jsonl for N days. Default: 14.
  --cache-retention-days N        Retain stale cache children for N days. Default: 14.
  --tmp-dir DIR                   Cortex-owned temp dir. Default: CORTEX_TMP_DIR or APP_DIR/tmp.
  --tmp-retention-days N          Retain temp candidates for N days. Default: 2.
  -h, --help                      Show this help.

Environment:
  CORTEX_NPM_CACHE_ACTION         clean, verify, or skip. Default: clean.
  CORTEX_PNPM_STORE_ACTION        prune or skip. Default: prune.
  CORTEX_BROWSER_CACHE_RETENTION_DAYS
                                  Retain stale Playwright/Puppeteer cache dirs for N days.
                                  Default: CORTEX_CACHE_RETENTION_DAYS.
  CORTEX_TMP_SCAN_DIRS            Colon-separated temp roots to scan for known-safe stale prefixes.
                                  Default: /tmp plus CORTEX_TMP_DIR.
  CORTEX_PRUNE_OWNED_TMP_ALL      Also prune any stale top-level child in CORTEX_TMP_DIR. Default: 1.
  CORTEX_TMP_USE_LSOF             Skip candidates with open files when lsof exists. Default: 1.
  NPM_CONFIG_CACHE                npm cache directory. Default: HOME/.npm.
  PNPM_STORE_PATH                 pnpm store path for fallback age pruning.
EOF
}

log() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

quote_cmd() {
  local arg
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
}

APPLY=0
APP_DIR="${CORTEX_APP_DIR:-$(pwd)}"
LOG_DIR="${CORTEX_LOG_DIR:-}"
HOME_DIR="${CORTEX_HOME_DIR:-${HOME:-/home/cortex}}"
TMP_DIR="${CORTEX_TMP_DIR:-}"
HOST_METRICS_RETENTION_DAYS="${HOST_METRICS_RETENTION_DAYS:-3}"
APP_LOG_RETENTION_DAYS="${CORTEX_APP_LOG_RETENTION_DAYS:-14}"
TASK_LOG_RETENTION_DAYS="${CORTEX_TASK_LOG_RETENTION_DAYS:-14}"
CACHE_RETENTION_DAYS="${CORTEX_CACHE_RETENTION_DAYS:-14}"
BROWSER_CACHE_RETENTION_DAYS="${CORTEX_BROWSER_CACHE_RETENTION_DAYS:-$CACHE_RETENTION_DAYS}"
TMP_RETENTION_DAYS="${CORTEX_TMP_RETENTION_DAYS:-2}"
CORTEX_TMP_SCAN_DIRS="${CORTEX_TMP_SCAN_DIRS:-}"
CORTEX_PRUNE_OWNED_TMP_ALL="${CORTEX_PRUNE_OWNED_TMP_ALL:-1}"
CORTEX_TMP_USE_LSOF="${CORTEX_TMP_USE_LSOF:-1}"
NPM_CACHE_ACTION="${CORTEX_NPM_CACHE_ACTION:-clean}"
PNPM_STORE_ACTION="${CORTEX_PNPM_STORE_ACTION:-prune}"
CURRENT_UID="$(id -u)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      ;;
    --dry-run)
      APPLY=0
      ;;
    --app-dir)
      APP_DIR="${2:-}"
      shift
      ;;
    --log-dir)
      LOG_DIR="${2:-}"
      shift
      ;;
    --home)
      HOME_DIR="${2:-}"
      shift
      ;;
    --host-metrics-retention-days)
      HOST_METRICS_RETENTION_DAYS="${2:-}"
      shift
      ;;
    --app-log-retention-days)
      APP_LOG_RETENTION_DAYS="${2:-}"
      shift
      ;;
    --task-log-retention-days)
      TASK_LOG_RETENTION_DAYS="${2:-}"
      shift
      ;;
    --cache-retention-days)
      CACHE_RETENTION_DAYS="${2:-}"
      BROWSER_CACHE_RETENTION_DAYS="${CORTEX_BROWSER_CACHE_RETENTION_DAYS:-$CACHE_RETENTION_DAYS}"
      shift
      ;;
    --tmp-dir)
      TMP_DIR="${2:-}"
      shift
      ;;
    --tmp-retention-days)
      TMP_RETENTION_DAYS="${2:-}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ -z "$LOG_DIR" ]]; then
  LOG_DIR="$APP_DIR/logs"
fi

if [[ -z "$TMP_DIR" ]]; then
  TMP_DIR="$APP_DIR/tmp"
fi

validate_positive_int() {
  local label="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [[ "$value" -lt 1 ]]; then
    printf '%s must be a positive integer. Got: %s\n' "$label" "$value" >&2
    exit 1
  fi
}

validate_positive_int HOST_METRICS_RETENTION_DAYS "$HOST_METRICS_RETENTION_DAYS"
validate_positive_int CORTEX_APP_LOG_RETENTION_DAYS "$APP_LOG_RETENTION_DAYS"
validate_positive_int CORTEX_TASK_LOG_RETENTION_DAYS "$TASK_LOG_RETENTION_DAYS"
validate_positive_int CORTEX_CACHE_RETENTION_DAYS "$CACHE_RETENTION_DAYS"
validate_positive_int CORTEX_BROWSER_CACHE_RETENTION_DAYS "$BROWSER_CACHE_RETENTION_DAYS"
validate_positive_int CORTEX_TMP_RETENTION_DAYS "$TMP_RETENTION_DAYS"

case "$NPM_CACHE_ACTION" in
  clean|verify|skip) ;;
  *)
    printf 'CORTEX_NPM_CACHE_ACTION must be clean, verify, or skip. Got: %s\n' "$NPM_CACHE_ACTION" >&2
    exit 1
    ;;
esac

case "$PNPM_STORE_ACTION" in
  prune|skip) ;;
  *)
    printf 'CORTEX_PNPM_STORE_ACTION must be prune or skip. Got: %s\n' "$PNPM_STORE_ACTION" >&2
    exit 1
    ;;
esac

refuse_dangerous_dir() {
  local label="$1"
  local dir="$2"
  case "$dir" in
    ""|"/"|"/."|"//")
      printf 'Refusing unsafe %s directory: %s\n' "$label" "$dir" >&2
      exit 1
      ;;
  esac
}

refuse_dangerous_dir app "$APP_DIR"
refuse_dangerous_dir log "$LOG_DIR"
refuse_dangerous_dir home "$HOME_DIR"
refuse_dangerous_dir tmp "$TMP_DIR"

LOCK_FILE="${CORTEX_DISK_HYGIENE_LOCK_FILE:-/tmp/cortex-city-disk-hygiene.lock}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    printf 'Another cortex-disk-hygiene instance is already running.\n' >&2
    exit 1
  fi
else
  warn "flock is unavailable; continuing without an inter-process lock"
fi

remove_path() {
  local kind="$1"
  local target="$2"

  if [[ "$APPLY" == "1" ]]; then
    if [[ "$kind" == "dir" ]]; then
      rm -rf -- "$target"
    else
      rm -f -- "$target"
    fi
    printf 'deleted %s\n' "$target"
  else
    printf 'would delete %s\n' "$target"
  fi
}

run_or_report() {
  local label="$1"
  shift

  if [[ "$APPLY" == "1" ]]; then
    log "$label"
    if ! "$@"; then
      warn "$label failed"
    fi
    return
  fi

  printf 'would run:'
  quote_cmd "$@"
  printf '\n'
}

summarize_path() {
  local target="$1"
  if [[ -e "$target" ]]; then
    du -sh "$target" 2>/dev/null || true
  fi
}

prune_old_log_files() {
  local pattern="$1"
  local days="$2"
  local label="$3"
  local keep_mtime_days=$((days - 1))
  local found=0

  if [[ ! -d "$LOG_DIR" ]]; then
    log "Skipping $label; log directory does not exist: $LOG_DIR"
    return
  fi

  log "Pruning $label in $LOG_DIR older than ${days} day(s)"
  while IFS= read -r -d '' target; do
    found=1
    remove_path file "$target"
  done < <(
    find "$LOG_DIR" \
      -maxdepth 1 \
      -type f \
      -name "$pattern" \
      -mtime +"$keep_mtime_days" \
      -print0
  )

  if [[ "$found" == "0" ]]; then
    printf 'nothing matched\n'
  fi
}

prune_old_cache_children() {
  local dir="$1"
  local days="$2"
  local label="$3"
  local keep_mtime_days=$((days - 1))
  local found=0

  if [[ ! -d "$dir" ]]; then
    log "Skipping $label; directory does not exist: $dir"
    return
  fi

  log "Pruning stale $label children in $dir older than ${days} day(s)"
  while IFS= read -r -d '' target; do
    found=1
    if [[ -d "$target" ]]; then
      remove_path dir "$target"
    else
      remove_path file "$target"
    fi
  done < <(
    find "$dir" \
      -mindepth 1 \
      -maxdepth 1 \
      \( -type d -o -type f \) \
      -mtime +"$keep_mtime_days" \
      -print0
  )

  if [[ "$found" == "0" ]]; then
    printf 'nothing matched\n'
  fi
}

prune_empty_dirs() {
  local dir="$1"
  local label="$2"
  local days="$3"
  local keep_mtime_days=$((days - 1))
  local found=0

  if [[ ! -d "$dir" ]]; then
    return
  fi

  log "Pruning empty $label directories in $dir older than ${days} day(s)"
  while IFS= read -r -d '' target; do
    found=1
    remove_path dir "$target"
  done < <(
    find "$dir" \
      -mindepth 1 \
      -depth \
      -type d \
      -empty \
      -mtime +"$keep_mtime_days" \
      -print0
  )

  if [[ "$found" == "0" ]]; then
    printf 'nothing matched\n'
  fi
}

matches_known_tmp_prefix() {
  local name="$1"

  case "$name" in
    cloud_control_plane*|ccp-*|agentic-chat-*|aws-cdk-lib-review*|immutable_inputs*|codex-schema-*|node-compile-cache*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

has_recent_changes() {
  local target="$1"
  local days="$2"
  local recent

  recent="$(
    find "$target" \
      -mindepth 0 \
      -mtime "-$days" \
      -print \
      -quit 2>/dev/null || true
  )"
  [[ -n "$recent" ]]
}

has_open_files() {
  local target="$1"

  if [[ "$CORTEX_TMP_USE_LSOF" != "1" ]] || ! command -v lsof >/dev/null 2>&1; then
    return 1
  fi

  if [[ -d "$target" ]]; then
    lsof +D "$target" >/dev/null 2>&1
    return
  fi

  lsof "$target" >/dev/null 2>&1
}

tmp_scan_dirs() {
  if [[ -n "$CORTEX_TMP_SCAN_DIRS" ]]; then
    local IFS=:
    local dir
    for dir in $CORTEX_TMP_SCAN_DIRS; do
      [[ -n "$dir" ]] && printf '%s\n' "$dir"
    done
    return
  fi

  printf '/tmp\n'
  if [[ "$TMP_DIR" != "/tmp" ]]; then
    printf '%s\n' "$TMP_DIR"
  fi
}

prune_tmp_candidates_in_dir() {
  local scan_dir="$1"
  local known_prefix_only="$2"
  local label="$3"
  local keep_mtime_days=$((TMP_RETENTION_DAYS - 1))
  local found=0

  if [[ ! -d "$scan_dir" ]]; then
    log "Skipping $label; directory does not exist: $scan_dir"
    return
  fi

  log "Pruning stale $label in $scan_dir older than ${TMP_RETENTION_DAYS} day(s)"
  while IFS= read -r -d '' target; do
    local name
    name="$(basename "$target")"

    if [[ "$known_prefix_only" == "1" ]] && ! matches_known_tmp_prefix "$name"; then
      continue
    fi

    found=1

    if has_recent_changes "$target" "$TMP_RETENTION_DAYS"; then
      printf 'skipping recent temp candidate %s\n' "$target"
      continue
    fi

    if has_open_files "$target"; then
      printf 'skipping open temp candidate %s\n' "$target"
      continue
    fi

    if [[ -d "$target" ]]; then
      remove_path dir "$target"
    else
      remove_path file "$target"
    fi
  done < <(
    find "$scan_dir" \
      -mindepth 1 \
      -maxdepth 1 \
      \( -type d -o -type f \) \
      -user "$CURRENT_UID" \
      -mtime +"$keep_mtime_days" \
      -print0
  )

  if [[ "$found" == "0" ]]; then
    printf 'nothing matched\n'
  fi
}

prune_temp_roots() {
  local scan_dir
  local seen_owned_tmp=0

  while IFS= read -r scan_dir; do
    [[ -n "$scan_dir" ]] || continue

    if [[ "$scan_dir" == "$TMP_DIR" ]]; then
      seen_owned_tmp=1
      if [[ "$CORTEX_PRUNE_OWNED_TMP_ALL" == "1" && "$TMP_DIR" != "/tmp" ]]; then
        continue
      fi
    fi

    prune_tmp_candidates_in_dir "$scan_dir" 1 "known-safe temp prefixes"
  done < <(tmp_scan_dirs)

  if [[ "$CORTEX_PRUNE_OWNED_TMP_ALL" == "1" && "$TMP_DIR" != "/tmp" ]]; then
    if [[ "$seen_owned_tmp" == "0" ]]; then
      prune_tmp_candidates_in_dir "$TMP_DIR" 1 "known-safe temp prefixes"
    fi
    prune_tmp_candidates_in_dir "$TMP_DIR" 0 "Cortex-owned temp children"
  fi
}

prune_npm_cache() {
  local npm_cache_dir="${NPM_CONFIG_CACHE:-$HOME_DIR/.npm}"

  case "$NPM_CACHE_ACTION" in
    skip)
      log "Skipping npm cache by CORTEX_NPM_CACHE_ACTION=skip"
      ;;
    verify)
      if command -v npm >/dev/null 2>&1; then
        run_or_report "Verifying npm cache" npm cache verify --cache "$npm_cache_dir"
      else
        warn "npm is unavailable; cannot verify npm cache"
      fi
      ;;
    clean)
      if command -v npm >/dev/null 2>&1; then
        run_or_report "Cleaning npm cache" npm cache clean --force --cache "$npm_cache_dir"
      elif [[ -d "$npm_cache_dir/_cacache" ]]; then
        log "npm is unavailable; falling back to removing $npm_cache_dir/_cacache"
        remove_path dir "$npm_cache_dir/_cacache"
      else
        log "Skipping npm cache; npm is unavailable and no _cacache exists"
      fi
      ;;
  esac

  prune_old_cache_children "$npm_cache_dir/_logs" "$CACHE_RETENTION_DAYS" "npm logs"
}

pnpm_store_path() {
  if [[ -n "${PNPM_STORE_PATH:-}" ]]; then
    printf '%s' "$PNPM_STORE_PATH"
    return
  fi

  if command -v pnpm >/dev/null 2>&1; then
    pnpm store path --silent 2>/dev/null || true
  fi
}

prune_pnpm_store() {
  local store_path
  store_path="$(pnpm_store_path)"

  if [[ "$PNPM_STORE_ACTION" == "skip" ]]; then
    log "Skipping pnpm store by CORTEX_PNPM_STORE_ACTION=skip"
    return
  fi

  if command -v pnpm >/dev/null 2>&1; then
    run_or_report "Pruning pnpm store" pnpm store prune
    return
  fi

  warn "pnpm is unavailable; falling back to age-based pruning of known pnpm store paths"
  if [[ -n "$store_path" ]]; then
    prune_old_cache_children "$store_path" "$CACHE_RETENTION_DAYS" "pnpm store"
  fi
  prune_old_cache_children "$HOME_DIR/.pnpm-store" "$CACHE_RETENTION_DAYS" "pnpm store"
  prune_old_cache_children "$HOME_DIR/.local/share/pnpm/store" "$CACHE_RETENTION_DAYS" "pnpm store"
}

mode="dry-run"
if [[ "$APPLY" == "1" ]]; then
  mode="apply"
fi

log "Cortex disk hygiene mode=$mode"
printf 'app_dir=%s\n' "$APP_DIR"
printf 'log_dir=%s\n' "$LOG_DIR"
printf 'home_dir=%s\n' "$HOME_DIR"
printf 'tmp_dir=%s\n' "$TMP_DIR"
printf 'worktrees_scope=skipped:%s\n' "$APP_DIR/.cortex/repos/*/.worktrees"

log "Size summary before cleanup"
summarize_path "$LOG_DIR"
summarize_path "${NPM_CONFIG_CACHE:-$HOME_DIR/.npm}"
summarize_path "$HOME_DIR/.pnpm-store"
summarize_path "$HOME_DIR/.local/share/pnpm"
summarize_path "$HOME_DIR/.cache/ms-playwright"
summarize_path "$HOME_DIR/.cache/puppeteer"
summarize_path /tmp
summarize_path "$TMP_DIR"

prune_old_log_files 'host-metrics-*.log' "$HOST_METRICS_RETENTION_DAYS" "host metrics logs"
prune_old_log_files 'server-*.log' "$APP_LOG_RETENTION_DAYS" "server logs"
prune_old_log_files 'task-*.log' "$TASK_LOG_RETENTION_DAYS" "task transcript logs"
prune_old_log_files 'task-*.jsonl' "$TASK_LOG_RETENTION_DAYS" "task machine logs"

prune_npm_cache
prune_pnpm_store
prune_old_cache_children "$HOME_DIR/.cache/ms-playwright" "$BROWSER_CACHE_RETENTION_DAYS" "Playwright browser cache"
prune_old_cache_children "$HOME_DIR/.cache/puppeteer" "$BROWSER_CACHE_RETENTION_DAYS" "Puppeteer browser cache"
prune_empty_dirs "$HOME_DIR/.cache/ms-playwright" "Playwright browser cache" "$BROWSER_CACHE_RETENTION_DAYS"
prune_empty_dirs "$HOME_DIR/.cache/puppeteer" "Puppeteer browser cache" "$BROWSER_CACHE_RETENTION_DAYS"
prune_temp_roots

log "Size summary after cleanup"
summarize_path "$LOG_DIR"
summarize_path "${NPM_CONFIG_CACHE:-$HOME_DIR/.npm}"
summarize_path "$HOME_DIR/.pnpm-store"
summarize_path "$HOME_DIR/.local/share/pnpm"
summarize_path "$HOME_DIR/.cache/ms-playwright"
summarize_path "$HOME_DIR/.cache/puppeteer"
summarize_path /tmp
summarize_path "$TMP_DIR"

log "Cortex disk hygiene complete"
