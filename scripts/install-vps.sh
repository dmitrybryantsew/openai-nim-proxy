#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-openai-nim-proxy}"
APP_DIR="${APP_DIR:-/opt/openai-nim-proxy}"
APP_USER="${APP_USER:-openai-nim-proxy}"
REPO_URL="${REPO_URL:-https://github.com/dmitrybryantsew/openai-nim-proxy.git}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-3000}"

PROXY_API_KEY="${PROXY_API_KEY:-}"
NIM_API_KEY="${NIM_API_KEY:-}"
CHUTES_API_KEY="${CHUTES_API_KEY:-}"
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root or with sudo." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg git
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
else
  apt-get update
  apt-get install -y git
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
fi

cd "$APP_DIR"
npm ci --omit=dev

if [[ ! -f "$APP_DIR/.env" ]]; then
  if [[ -z "$PROXY_API_KEY" || -z "$NIM_API_KEY" ]]; then
    echo "Set PROXY_API_KEY and NIM_API_KEY for first install, or create $APP_DIR/.env manually." >&2
    exit 1
  fi

  install -m 0600 /dev/null "$APP_DIR/.env"
  {
    echo "PORT=${PORT}"
    echo "PROXY_API_KEY=${PROXY_API_KEY}"
    echo "NIM_API_BASE=https://integrate.api.nvidia.com/v1"
    echo "NIM_API_KEY=${NIM_API_KEY}"
    echo "NIM_FEATURED_MODELS=nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
    echo "CHUTES_API_BASE=https://llm.chutes.ai/v1"
    echo "CHUTES_API_KEY=${CHUTES_API_KEY}"
    echo "OPENROUTER_API_BASE=https://openrouter.ai/api/v1"
    echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
    echo "OPENROUTER_INCLUDE_PAID=false"
    echo "OPENROUTER_INCLUDE_MULTIMODAL_OUTPUT=true"
    echo "MODEL_CACHE_FILE=${APP_DIR}/data/models-cache.json"
    echo "SHOW_REASONING=false"
    echo "ENABLE_THINKING_MODE=false"
    echo "THINKING_MODELS=nim:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
    echo "DEFAULT_REASONING_BUDGET=16384"
  } > "$APP_DIR/.env"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

cat > "/etc/systemd/system/${APP_NAME}.service" <<UNIT
[Unit]
Description=OpenAI-compatible NVIDIA NIM/OpenRouter proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}/data

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$APP_NAME"
systemctl restart "$APP_NAME"
systemctl --no-pager --full status "$APP_NAME"
