#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-openai-nim-proxy}"
APP_DIR="${APP_DIR:-/opt/openai-nim-proxy}"
G4F_IMAGE="${G4F_IMAGE:-hlohaus789/g4f:latest}"
G4F_API_PORT="${G4F_API_PORT:-1337}"
G4F_WEB_PORT="${G4F_WEB_PORT:-8080}"
G4F_BIND="${G4F_BIND:-127.0.0.1}"
G4F_PUBLIC_HOST="${G4F_PUBLIC_HOST:-}"
G4F_MODELS="${G4F_MODELS:-gpt-4o-mini,gpt-4o,gpt-3.5-turbo}"
G4F_DOCKER_ARGS="${G4F_DOCKER_ARGS:---shm-size=512m}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root or with sudo." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl

if ! command -v docker >/dev/null 2>&1; then
  apt-get install -y docker.io
  systemctl enable --now docker
fi

docker pull "$G4F_IMAGE"

mkdir -p /opt/g4f/har_and_cookies
# The upstream image may run as a non-root user and needs to create keys/cookies here.
chmod 0777 /opt/g4f /opt/g4f/har_and_cookies

cat > /etc/systemd/system/g4f-sidecar.service <<UNIT
[Unit]
Description=GPT4Free sidecar
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=10
ExecStartPre=-/usr/bin/docker rm -f g4f-sidecar
ExecStart=/usr/bin/docker run --rm --name g4f-sidecar ${G4F_DOCKER_ARGS} -p ${G4F_BIND}:${G4F_API_PORT}:1337 -p ${G4F_BIND}:${G4F_WEB_PORT}:8080 -v /opt/g4f/har_and_cookies:/app/har_and_cookies ${G4F_IMAGE}
ExecStop=/usr/bin/docker stop g4f-sidecar

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now g4f-sidecar

ensure_env() {
  local key="$1"
  local value="$2"
  local env_file="${APP_DIR}/.env"
  if [[ ! -f "$env_file" ]]; then
    touch "$env_file"
  fi

  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    echo "${key}=${value}" >> "$env_file"
  fi
}

ensure_env "G4F_ENABLED" "true"
ensure_env "G4F_API_BASE" "http://127.0.0.1:${G4F_API_PORT}/v1"
ensure_env "G4F_WEB_URL" "http://127.0.0.1:${G4F_WEB_PORT}"
ensure_env "G4F_MODELS" "${G4F_MODELS}"

if [[ -n "$G4F_PUBLIC_HOST" ]]; then
  ensure_env "G4F_WEB_PUBLIC_URL" "http://${G4F_PUBLIC_HOST}:${G4F_WEB_PORT}"
fi

systemctl restart "$APP_NAME"

echo "GPT4Free sidecar installed."
echo "API: http://127.0.0.1:${G4F_API_PORT}/v1"
echo "Web: http://127.0.0.1:${G4F_WEB_PORT}"
echo "Proxy page: http://your-server:3000/g4f.html"
