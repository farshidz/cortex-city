#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-ssh.sh user@host [app-dir]

Deploy the current checkout to a remote Linux host over SSH, run `npm ci`,
build the app on the remote machine, install the systemd unit files, and
restart the Cortex City web and worker services.

Environment overrides:
  APP_DIR=/opt/cortex-city/app
  CONFIG_DIR=/etc/cortex-city
  WEB_ENV_FILE=/etc/cortex-city/web.env
  WORKER_ENV_FILE=/etc/cortex-city/worker.env
  SYSTEMD_USER=cortex
  SYSTEMD_GROUP=cortex
  REMOTE_OWNER=cortex
  REMOTE_GROUP=cortex
  WEB_SERVICE_NAME=cortex-city-web.service
  WORKER_SERVICE_NAME=cortex-city-worker.service
  REMOTE_SYSTEMD_DIR=/etc/systemd/system
  SSH_PORT=22
  SSH_KEY_PATH=~/.ssh/your-key.pem
  SSH_STRICT_HOST_KEY_CHECKING=accept-new
  SUDO=sudo
EOF
}

log() {
  printf '==> %s\n' "$*"
}

quote() {
  printf '%q' "$1"
}

require_local_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'Missing local command: %s\n' "$cmd" >&2
    exit 1
  fi
}

render_service() {
  local src="$1"
  local dest="$2"
  local env_file="$3"

  sed \
    -e "s|^User=.*$|User=$SYSTEMD_USER|" \
    -e "s|^Group=.*$|Group=$SYSTEMD_GROUP|" \
    -e "s|^WorkingDirectory=.*$|WorkingDirectory=$APP_DIR|" \
    -e "s|^EnvironmentFile=.*$|EnvironmentFile=-$env_file|" \
    "$src" > "$dest"
}

run_remote() {
  local script="$1"
  "${ssh_cmd[@]}" "$REMOTE" "bash -lc $(printf '%q' "$script")"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

REMOTE="${1:-}"
if [[ -z "$REMOTE" ]]; then
  usage >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

APP_DIR="${2:-${APP_DIR:-/opt/cortex-city/app}}"
CONFIG_DIR="${CONFIG_DIR:-/etc/cortex-city}"
WEB_ENV_FILE="${WEB_ENV_FILE:-$CONFIG_DIR/web.env}"
WORKER_ENV_FILE="${WORKER_ENV_FILE:-$CONFIG_DIR/worker.env}"
WEB_SERVICE_NAME="${WEB_SERVICE_NAME:-cortex-city-web.service}"
WORKER_SERVICE_NAME="${WORKER_SERVICE_NAME:-cortex-city-worker.service}"
REMOTE_SYSTEMD_DIR="${REMOTE_SYSTEMD_DIR:-/etc/systemd/system}"
REMOTE_RENDER_DIR="$APP_DIR/.deploy/systemd"
SSH_PORT="${SSH_PORT:-22}"
SSH_KEY_PATH="${SSH_KEY_PATH:-}"
SSH_STRICT_HOST_KEY_CHECKING="${SSH_STRICT_HOST_KEY_CHECKING:-accept-new}"
SUDO="${SUDO:-sudo}"

REMOTE_LOGIN_USER=""
if [[ "$REMOTE" == *"@"* ]]; then
  REMOTE_LOGIN_USER="${REMOTE%@*}"
fi

SYSTEMD_USER="${SYSTEMD_USER:-cortex}"
SYSTEMD_GROUP="${SYSTEMD_GROUP:-$SYSTEMD_USER}"
REMOTE_OWNER="${REMOTE_OWNER:-$SYSTEMD_USER}"
REMOTE_GROUP="${REMOTE_GROUP:-$REMOTE_OWNER}"

if [[ -z "$SYSTEMD_USER" || -z "$SYSTEMD_GROUP" ]]; then
  printf 'Set SYSTEMD_USER and SYSTEMD_GROUP.\n' >&2
  exit 1
fi

if [[ -z "$REMOTE_OWNER" || -z "$REMOTE_GROUP" ]]; then
  printf 'Set REMOTE_OWNER and REMOTE_GROUP.\n' >&2
  exit 1
fi

require_local_command git
require_local_command rsync
require_local_command ssh
require_local_command sed
require_local_command mktemp

ssh_cmd=(ssh -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking="$SSH_STRICT_HOST_KEY_CHECKING")
if [[ -n "$SSH_KEY_PATH" ]]; then
  ssh_cmd+=(-i "$SSH_KEY_PATH")
fi
rsync_rsh="$(printf '%q ' "${ssh_cmd[@]}")"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

mkdir -p "$tmpdir/systemd"
render_service \
  "$REPO_ROOT/deploy/systemd/cortex-city-web.service" \
  "$tmpdir/systemd/$WEB_SERVICE_NAME" \
  "$WEB_ENV_FILE"
render_service \
  "$REPO_ROOT/deploy/systemd/cortex-city-worker.service" \
  "$tmpdir/systemd/$WORKER_SERVICE_NAME" \
  "$WORKER_ENV_FILE"

log "Checking remote prerequisites on $REMOTE"
run_remote "
set -euo pipefail
for cmd in bash rsync npm systemctl install; do
  command -v \"\$cmd\" >/dev/null 2>&1 || {
    echo \"Missing remote command: \$cmd\" >&2
    exit 1
  }
done
"

log "Preparing remote directories and stopping services"
run_remote "
set -euo pipefail
$SUDO install -d -m 755 -o $(quote "$REMOTE_OWNER") -g $(quote "$REMOTE_GROUP") $(quote "$APP_DIR")
$SUDO install -d -m 755 -o $(quote "$REMOTE_OWNER") -g $(quote "$REMOTE_GROUP") $(quote "$REMOTE_RENDER_DIR")
$SUDO install -d -m 755 $(quote "$CONFIG_DIR")
$SUDO systemctl stop $(quote "$WORKER_SERVICE_NAME") || true
$SUDO systemctl stop $(quote "$WEB_SERVICE_NAME") || true
"

log "Syncing application files"
rsync -az --delete \
  --exclude='.git/' \
  --exclude='.next/' \
  --exclude='node_modules/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.cortex/' \
  --exclude='logs/' \
  --exclude='.DS_Store' \
  --rsync-path="$SUDO rsync" \
  -e "$rsync_rsh" \
  "$REPO_ROOT/" "$REMOTE:$APP_DIR/"

log "Uploading rendered systemd units"
rsync -az --delete \
  --rsync-path="$SUDO rsync" \
  -e "$rsync_rsh" \
  "$tmpdir/systemd/" "$REMOTE:$REMOTE_RENDER_DIR/"

log "Installing dependencies and rebuilding on remote host"
run_remote "
set -euo pipefail
cd $(quote "$APP_DIR")
npm ci
npm run build
$SUDO chown -R $(quote "$SYSTEMD_USER:$SYSTEMD_GROUP") $(quote "$APP_DIR")
"

log "Installing systemd units and restarting services"
run_remote "
set -euo pipefail
$SUDO install -D -m 644 $(quote "$REMOTE_RENDER_DIR/$WEB_SERVICE_NAME") $(quote "$REMOTE_SYSTEMD_DIR/$WEB_SERVICE_NAME")
$SUDO install -D -m 644 $(quote "$REMOTE_RENDER_DIR/$WORKER_SERVICE_NAME") $(quote "$REMOTE_SYSTEMD_DIR/$WORKER_SERVICE_NAME")
$SUDO touch $(quote "$WEB_ENV_FILE") $(quote "$WORKER_ENV_FILE")
$SUDO systemctl daemon-reload
$SUDO systemctl enable $(quote "$WEB_SERVICE_NAME") $(quote "$WORKER_SERVICE_NAME")
$SUDO systemctl restart $(quote "$WEB_SERVICE_NAME") $(quote "$WORKER_SERVICE_NAME")
$SUDO systemctl --no-pager --full --lines=0 status $(quote "$WEB_SERVICE_NAME") $(quote "$WORKER_SERVICE_NAME")
"

log "Deploy complete"
