#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-openai-nim-proxy}"
APP_DIR="${APP_DIR:-/opt/openai-nim-proxy}"
KOKORO_IMAGE="${KOKORO_IMAGE:-ghcr.io/remsky/kokoro-fastapi-cpu:latest}"
KITTENTTS_DIR="${KITTENTTS_DIR:-/opt/kittentts}"
REMOVE_KOKORO="${REMOVE_KOKORO:-true}"
REMOVE_KITTENTTS="${REMOVE_KITTENTTS:-true}"
REMOVE_DOCKER_IMAGE="${REMOVE_DOCKER_IMAGE:-true}"
REMOVE_DOCKER_PACKAGE="${REMOVE_DOCKER_PACKAGE:-false}"
KEEP_PROVIDER="${KEEP_PROVIDER:-piper}"

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

if [[ "$REMOVE_KOKORO" == "true" ]]; then
  systemctl disable --now kokoro-fastapi 2>/dev/null || true
  rm -f /etc/systemd/system/kokoro-fastapi.service
  systemctl daemon-reload

  if command -v docker >/dev/null 2>&1; then
    docker rm -f kokoro-fastapi 2>/dev/null || true
    if [[ "$REMOVE_DOCKER_IMAGE" == "true" ]]; then
      docker image rm "$KOKORO_IMAGE" 2>/dev/null || true
      docker image prune -f >/dev/null 2>&1 || true
    fi
  fi

  remove_env_key "KOKORO_API_BASE"
  remove_env_key "KOKORO_MODEL"
  remove_env_key "KOKORO_DEFAULT_VOICE"
  remove_env_key "KOKORO_API_KEY"
fi

if [[ "$REMOVE_KITTENTTS" == "true" ]]; then
  rm -rf "$KITTENTTS_DIR"
  remove_env_key "KITTENTTS_API_BASE"
  remove_env_key "KITTENTTS_API_KEY"
  remove_env_key "KITTENTTS_MODEL"
  remove_env_key "KITTENTTS_MODELS"
  remove_env_key "KITTENTTS_DEFAULT_VOICE"
  remove_env_key "KITTENTTS_COMMAND"
  remove_env_key "KITTENTTS_OUTPUT_FORMAT"
fi

ensure_env "TTS_PROVIDERS" "$KEEP_PROVIDER"

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

echo "TTS cleanup complete. Enabled TTS providers: ${KEEP_PROVIDER}"
echo "Piper files were left intact."
