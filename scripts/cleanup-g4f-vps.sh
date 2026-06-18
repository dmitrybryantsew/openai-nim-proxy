#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-openai-nim-proxy}"
APP_DIR="${APP_DIR:-/opt/openai-nim-proxy}"
G4F_IMAGE="${G4F_IMAGE:-hlohaus789/g4f:latest}"
G4F_DATA_DIR="${G4F_DATA_DIR:-/opt/g4f}"
REMOVE_DOCKER_IMAGE="${REMOVE_DOCKER_IMAGE:-true}"
REMOVE_G4F_DATA="${REMOVE_G4F_DATA:-false}"
REMOVE_DOCKER_PACKAGE="${REMOVE_DOCKER_PACKAGE:-false}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root or with sudo." >&2
  exit 1
fi

remove_env_key() {
  local key="$1"
  local env_file="${APP_DIR}/.env"
  if [[ -f "$env_file" ]]; then
    sed -i "/^${key}=.*/d" "$env_file"
  fi
}

ensure_env() {
  local key="$1"
  local value="$2"
  local env_file="${APP_DIR}/.env"
  if [[ ! -f "$env_file" ]]; then
    return
  fi

  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    echo "${key}=${value}" >> "$env_file"
  fi
}

systemctl disable --now g4f-sidecar 2>/dev/null || true
rm -f /etc/systemd/system/g4f-sidecar.service
systemctl daemon-reload

if command -v docker >/dev/null 2>&1; then
  docker rm -f g4f-sidecar 2>/dev/null || true
  if [[ "$REMOVE_DOCKER_IMAGE" == "true" ]]; then
    docker image rm "$G4F_IMAGE" 2>/dev/null || true
    docker image prune -f >/dev/null 2>&1 || true
  fi
fi

ensure_env "G4F_ENABLED" "false"
remove_env_key "G4F_API_BASE"
remove_env_key "G4F_API_KEY"
remove_env_key "G4F_WEB_URL"
remove_env_key "G4F_WEB_PUBLIC_URL"
remove_env_key "G4F_MODELS"
remove_env_key "G4F_IMAGE_MODEL"

if [[ "$REMOVE_G4F_DATA" == "true" ]]; then
  rm -rf "$G4F_DATA_DIR"
fi

if [[ "$REMOVE_DOCKER_PACKAGE" == "true" ]]; then
  if command -v docker >/dev/null 2>&1; then
    if [[ -z "$(docker ps -aq 2>/dev/null)" ]]; then
      apt-get purge -y docker.io containerd runc || true
      apt-get autoremove -y || true
    else
      echo "Docker still has containers; leaving docker.io installed." >&2
    fi
  fi
fi

if systemctl list-unit-files "${APP_NAME}.service" >/dev/null 2>&1; then
  systemctl restart "$APP_NAME"
fi

echo "GPT4Free sidecar cleanup complete."
echo "G4F_ENABLED=false"
