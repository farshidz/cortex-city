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
  - reads deploy credentials from .env.prod by default

Environment overrides:
  BOOTSTRAP_ENV_FILE=/path/to/.env.prod
  APP_USER=cortex
  APP_GROUP=cortex
  APP_DIR=/opt/cortex-city/app
  GIT_USER_NAME="Cortex City"
  GIT_USER_EMAIL="farshid@marqo.ai"
  CONFIG_DIR=/etc/cortex-city
  WEB_ENV_FILE=/etc/cortex-city/web.env
  WORKER_ENV_FILE=/etc/cortex-city/worker.env
  NODE_MAJOR=22
  INSTALL_GH=1
  INSTALL_CODEX=1
  INSTALL_CLAUDE=1
  INSTALL_WRANGLER=1
  GH_TOKEN=github_pat_...
  CLOUDFLARE_API_TOKEN=...
  CLOUDFLARE_ACCOUNT_ID=...
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
  printf '%s' "$script" | "${ssh_cmd[@]}" "$REMOTE" "bash -s"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

REMOTE="${1:-}"
if [[ -z "$REMOTE" ]]; then
  usage >&2
  exit 1
fi

BOOTSTRAP_ENV_FILE="${BOOTSTRAP_ENV_FILE:-$REPO_ROOT/.env.prod}"

original_gh_token="${GH_TOKEN+x}:${GH_TOKEN-}"
original_github_token="${GITHUB_TOKEN+x}:${GITHUB_TOKEN-}"
original_cloudflare_api_token="${CLOUDFLARE_API_TOKEN+x}:${CLOUDFLARE_API_TOKEN-}"
original_cloudflare_account_id="${CLOUDFLARE_ACCOUNT_ID+x}:${CLOUDFLARE_ACCOUNT_ID-}"

if [[ -f "$BOOTSTRAP_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$BOOTSTRAP_ENV_FILE"
  set +a
fi

if [[ "${original_gh_token%%:*}" == "x" ]]; then
  GH_TOKEN="${original_gh_token#*:}"
fi

if [[ "${original_github_token%%:*}" == "x" ]]; then
  GITHUB_TOKEN="${original_github_token#*:}"
fi

if [[ "${original_cloudflare_api_token%%:*}" == "x" ]]; then
  CLOUDFLARE_API_TOKEN="${original_cloudflare_api_token#*:}"
fi

if [[ "${original_cloudflare_account_id%%:*}" == "x" ]]; then
  CLOUDFLARE_ACCOUNT_ID="${original_cloudflare_account_id#*:}"
fi

APP_USER="${APP_USER:-cortex}"
APP_GROUP="${APP_GROUP:-$APP_USER}"
APP_DIR="${APP_DIR:-/opt/cortex-city/app}"
GIT_USER_NAME="${GIT_USER_NAME:-Cortex City}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-farshid@marqo.ai}"
CONFIG_DIR="${CONFIG_DIR:-/etc/cortex-city}"
WEB_ENV_FILE="${WEB_ENV_FILE:-$CONFIG_DIR/web.env}"
WORKER_ENV_FILE="${WORKER_ENV_FILE:-$CONFIG_DIR/worker.env}"
NODE_MAJOR="${NODE_MAJOR:-22}"
INSTALL_GH="${INSTALL_GH:-1}"
INSTALL_CODEX="${INSTALL_CODEX:-1}"
INSTALL_CLAUDE="${INSTALL_CLAUDE:-1}"
INSTALL_WRANGLER="${INSTALL_WRANGLER:-1}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
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
GIT_USER_NAME=$(quote "$GIT_USER_NAME")
GIT_USER_EMAIL=$(quote "$GIT_USER_EMAIL")
CONFIG_DIR=$(quote "$CONFIG_DIR")
WEB_ENV_FILE=$(quote "$WEB_ENV_FILE")
WORKER_ENV_FILE=$(quote "$WORKER_ENV_FILE")
NODE_MAJOR=$(quote "$NODE_MAJOR")
INSTALL_GH=$(quote "$INSTALL_GH")
INSTALL_CODEX=$(quote "$INSTALL_CODEX")
INSTALL_CLAUDE=$(quote "$INSTALL_CLAUDE")
INSTALL_WRANGLER=$(quote "$INSTALL_WRANGLER")
GH_TOKEN=$(quote "$GH_TOKEN")
CLOUDFLARE_API_TOKEN=$(quote "$CLOUDFLARE_API_TOKEN")
CLOUDFLARE_ACCOUNT_ID=$(quote "$CLOUDFLARE_ACCOUNT_ID")

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

upsert_env_file_var() {
  local file="\$1"
  local key="\$2"
  local value="\$3"
  local tmp

  tmp=\$(mktemp)
  if \$SUDO test -f "\$file"; then
    \$SUDO cat "\$file" | grep -vE \"^\${key}=\" >\"\$tmp\" || true
  fi
  printf '%s=%s\n' \"\$key\" \"\$value\" >>\"\$tmp\"
  \$SUDO install -m 640 -o root -g \"\$APP_GROUP\" \"\$tmp\" \"\$file\"
  rm -f \"\$tmp\"
}

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

if command -v git >/dev/null 2>&1; then
  \$SUDO -u \"\$APP_USER\" -H git config --global user.name \"\$GIT_USER_NAME\"
  \$SUDO -u \"\$APP_USER\" -H git config --global user.email \"\$GIT_USER_EMAIL\"
fi

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

if [[ -n \"\$GH_TOKEN\" ]]; then
  upsert_env_file_var \"\$WORKER_ENV_FILE\" GH_TOKEN \"\$GH_TOKEN\"
fi

if [[ -n \"\$CLOUDFLARE_API_TOKEN\" ]]; then
  upsert_env_file_var \"\$WORKER_ENV_FILE\" CLOUDFLARE_API_TOKEN \"\$CLOUDFLARE_API_TOKEN\"
fi

if [[ -n \"\$CLOUDFLARE_ACCOUNT_ID\" ]]; then
  upsert_env_file_var \"\$WORKER_ENV_FILE\" CLOUDFLARE_ACCOUNT_ID \"\$CLOUDFLARE_ACCOUNT_ID\"
fi

\$SUDO chmod 640 \"\$WEB_ENV_FILE\" \"\$WORKER_ENV_FILE\"
\$SUDO chown root:\"\$APP_GROUP\" \"\$WEB_ENV_FILE\" \"\$WORKER_ENV_FILE\"

if [[ -n \"\$GH_TOKEN\" ]] && command -v gh >/dev/null 2>&1; then
  if ! printf '%s' \"\$GH_TOKEN\" | \$SUDO -u \"\$APP_USER\" -H env -u GH_TOKEN -u GITHUB_TOKEN gh auth login --with-token; then
    echo 'Warning: gh auth login failed. GH_TOKEN is still present in worker.env for headless use.' >&2
  fi
fi

echo
echo 'Bootstrap complete.'
echo \"App user:      \$APP_USER:\$APP_GROUP\"
echo \"App dir:       \$APP_DIR\"
echo \"Git identity:  \$GIT_USER_NAME <\$GIT_USER_EMAIL>\"
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
echo '  1. worker.env has been updated with any GH / Cloudflare values passed to bootstrap.'
echo '  2. Authenticate subscription-backed CLIs as the service user:'
if [[ -z \"\$GH_TOKEN\" ]]; then
  echo \"     sudo -u \$APP_USER -H gh auth login\"
fi
echo \"     sudo -u \$APP_USER -H codex --login\"
echo \"     sudo -u \$APP_USER -H claude\"
if [[ -z \"\$CLOUDFLARE_API_TOKEN\" ]]; then
  echo \"     sudo -u \$APP_USER -H wrangler login\"
fi
echo '  3. Run scripts/deploy-ssh.sh to sync the app and install systemd units.'
"

log "Bootstrap complete"
