#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-ssh.sh user@host

Bootstrap a fresh Linux host for Cortex City. The script connects over SSH and:
  - installs base packages
  - installs Node.js from NodeSource
  - installs gh, codex, claude, and wrangler
  - creates the app user/group
  - creates /opt/cortex-city/app and /etc/cortex-city
  - creates starter web.env and worker.env files
  - verifies systemd is available

Environment overrides:
  APP_USER=cortex
  APP_GROUP=cortex
  APP_DIR=/opt/cortex-city/app
  CONFIG_DIR=/etc/cortex-city
  WEB_ENV_FILE=/etc/cortex-city/web.env
  WORKER_ENV_FILE=/etc/cortex-city/worker.env
  NODE_MAJOR=22
  INSTALL_GH=1
  INSTALL_CODEX=1
  INSTALL_CLAUDE=1
  INSTALL_WRANGLER=1
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

APP_USER="${APP_USER:-cortex}"
APP_GROUP="${APP_GROUP:-$APP_USER}"
APP_DIR="${APP_DIR:-/opt/cortex-city/app}"
CONFIG_DIR="${CONFIG_DIR:-/etc/cortex-city}"
WEB_ENV_FILE="${WEB_ENV_FILE:-$CONFIG_DIR/web.env}"
WORKER_ENV_FILE="${WORKER_ENV_FILE:-$CONFIG_DIR/worker.env}"
NODE_MAJOR="${NODE_MAJOR:-22}"
INSTALL_GH="${INSTALL_GH:-1}"
INSTALL_CODEX="${INSTALL_CODEX:-1}"
INSTALL_CLAUDE="${INSTALL_CLAUDE:-1}"
INSTALL_WRANGLER="${INSTALL_WRANGLER:-1}"
SSH_PORT="${SSH_PORT:-22}"
SSH_KEY_PATH="${SSH_KEY_PATH:-}"
SSH_STRICT_HOST_KEY_CHECKING="${SSH_STRICT_HOST_KEY_CHECKING:-accept-new}"
SUDO="${SUDO:-sudo}"

require_local_command ssh

ssh_cmd=(ssh -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking="$SSH_STRICT_HOST_KEY_CHECKING")
if [[ -n "$SSH_KEY_PATH" ]]; then
  ssh_cmd+=(-i "$SSH_KEY_PATH")
fi

log "Bootstrapping $REMOTE"
run_remote "
set -euo pipefail

SUDO=$(quote "$SUDO")
APP_USER=$(quote "$APP_USER")
APP_GROUP=$(quote "$APP_GROUP")
APP_DIR=$(quote "$APP_DIR")
CONFIG_DIR=$(quote "$CONFIG_DIR")
WEB_ENV_FILE=$(quote "$WEB_ENV_FILE")
WORKER_ENV_FILE=$(quote "$WORKER_ENV_FILE")
NODE_MAJOR=$(quote "$NODE_MAJOR")
INSTALL_GH=$(quote "$INSTALL_GH")
INSTALL_CODEX=$(quote "$INSTALL_CODEX")
INSTALL_CLAUDE=$(quote "$INSTALL_CLAUDE")
INSTALL_WRANGLER=$(quote "$INSTALL_WRANGLER")

if ! command -v systemctl >/dev/null 2>&1; then
  echo 'systemd is required on the remote host.' >&2
  exit 1
fi

if [[ -r /etc/os-release ]]; then
  . /etc/os-release
else
  echo 'Unable to detect remote OS.' >&2
  exit 1
fi

install_packages_apt() {
  \$SUDO apt-get update
  \$SUDO apt-get install -y ca-certificates curl git rsync build-essential
  curl -fsSL https://deb.nodesource.com/setup_\${NODE_MAJOR}.x | \$SUDO bash -
  \$SUDO apt-get install -y nodejs
  if [[ \$INSTALL_GH == 1 ]]; then
    \$SUDO apt-get install -y gh
  fi
}

install_packages_dnf() {
  \$SUDO dnf install -y ca-certificates curl git rsync gcc-c++ make
  curl -fsSL https://rpm.nodesource.com/setup_\${NODE_MAJOR}.x | \$SUDO bash -
  \$SUDO dnf install -y nodejs
  if [[ \$INSTALL_GH == 1 ]]; then
    \$SUDO dnf install -y gh || true
  fi
}

case \${ID:-} in
  ubuntu|debian)
    install_packages_apt
    ;;
  amzn|fedora|rhel|centos|rocky|almalinux)
    install_packages_dnf
    ;;
  *)
    echo \"Unsupported distro: \${ID:-unknown}\" >&2
    exit 1
    ;;
esac

if [[ \$INSTALL_CODEX == 1 ]]; then
  \$SUDO npm install -g @openai/codex@latest
fi

if [[ \$INSTALL_CLAUDE == 1 ]]; then
  \$SUDO npm install -g @anthropic-ai/claude-code@latest
fi

if [[ \$INSTALL_WRANGLER == 1 ]]; then
  \$SUDO npm install -g wrangler@latest
fi

if ! getent group \"\$APP_GROUP\" >/dev/null 2>&1; then
  \$SUDO groupadd --system \"\$APP_GROUP\"
fi

if ! id -u \"\$APP_USER\" >/dev/null 2>&1; then
  \$SUDO useradd \
    --system \
    --gid \"\$APP_GROUP\" \
    --create-home \
    --home-dir \"/home/\$APP_USER\" \
    --shell /bin/bash \
    \"\$APP_USER\"
fi

\$SUDO install -d -m 755 -o \"\$APP_USER\" -g \"\$APP_GROUP\" \"\$APP_DIR\"
\$SUDO install -d -m 755 -o \"\$APP_USER\" -g \"\$APP_GROUP\" \"\$APP_DIR/.deploy\"
\$SUDO install -d -m 755 -o \"\$APP_USER\" -g \"\$APP_GROUP\" \"\$APP_DIR/logs\"
\$SUDO install -d -m 755 -o \"\$APP_USER\" -g \"\$APP_GROUP\" \"\$APP_DIR/.cortex\"
\$SUDO install -d -m 755 \"\$CONFIG_DIR\"

if [[ ! -f \"\$WEB_ENV_FILE\" ]]; then
  cat <<EOF_WEB | \$SUDO tee \"\$WEB_ENV_FILE\" >/dev/null
# Cortex City web service environment
# Add server-specific overrides here if needed.
PATH=/usr/local/bin:/usr/bin:/bin
HOME=/home/\$APP_USER
EOF_WEB
fi

if [[ ! -f \"\$WORKER_ENV_FILE\" ]]; then
  cat <<EOF_WORKER | \$SUDO tee \"\$WORKER_ENV_FILE\" >/dev/null
# Cortex City worker service environment
PATH=/usr/local/bin:/usr/bin:/bin
HOME=/home/\$APP_USER
#
# Add runtime credentials if your host needs them, for example:
# GH_TOKEN=
# GITHUB_TOKEN=
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
EOF_WORKER
fi

\$SUDO chmod 640 \"\$WEB_ENV_FILE\" \"\$WORKER_ENV_FILE\"
\$SUDO chown root:\"\$APP_GROUP\" \"\$WEB_ENV_FILE\" \"\$WORKER_ENV_FILE\"

echo
echo 'Bootstrap complete.'
echo \"App user:      \$APP_USER:\$APP_GROUP\"
echo \"App dir:       \$APP_DIR\"
echo \"Config dir:    \$CONFIG_DIR\"
echo \"Web env file:  \$WEB_ENV_FILE\"
echo \"Worker env:    \$WORKER_ENV_FILE\"
echo
echo 'Installed versions:'
node --version
npm --version
if command -v gh >/dev/null 2>&1; then
  gh --version | head -n 1
else
  echo 'gh not installed'
fi
if command -v codex >/dev/null 2>&1; then
  codex --version | head -n 1
else
  echo 'codex not installed'
fi
if command -v claude >/dev/null 2>&1; then
  claude --version | head -n 1
else
  echo 'claude not installed'
fi
if command -v wrangler >/dev/null 2>&1; then
  wrangler --version | head -n 1
else
  echo 'wrangler not installed'
fi
echo
echo 'Next steps:'
echo '  1. Put required credentials into the env files if needed.'
echo '  2. Authenticate each CLI as the service user:'
echo \"     sudo -u \$APP_USER -H gh auth login\"
echo \"     sudo -u \$APP_USER -H codex --login\"
echo \"     sudo -u \$APP_USER -H claude\"
echo \"     sudo -u \$APP_USER -H wrangler login\"
echo '  3. Run scripts/deploy-ssh.sh to sync the app and install systemd units.'
"

log "Bootstrap complete"
