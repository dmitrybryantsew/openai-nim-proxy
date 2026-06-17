#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-openai-nim-proxy}"
APP_DIR="${APP_DIR:-/opt/openai-nim-proxy}"
PIPER_DIR="${PIPER_DIR:-/opt/piper}"
PIPER_VERSION="${PIPER_VERSION:-2023.11.14-2}"
PIPER_VOICE_DIR="${PIPER_VOICE_DIR:-${PIPER_DIR}/voices}"
PIPER_VOICE_NAME="${PIPER_VOICE_NAME:-en_US-lessac-medium}"
PIPER_VOICE_BASE_URL="${PIPER_VOICE_BASE_URL:-https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium}"
KOKORO_IMAGE="${KOKORO_IMAGE:-ghcr.io/remsky/kokoro-fastapi-cpu:latest}"
KOKORO_PORT="${KOKORO_PORT:-8880}"
KITTENTTS_DIR="${KITTENTTS_DIR:-/opt/kittentts}"
KITTENTTS_WHEEL_URL="${KITTENTTS_WHEEL_URL:-https://github.com/KittenML/KittenTTS/releases/download/0.8.1/kittentts-0.8.1-py3-none-any.whl}"
KITTENTTS_MODEL="${KITTENTTS_MODEL:-KittenML/kitten-tts-nano-0.8}"
KITTENTTS_MODELS="${KITTENTTS_MODELS:-KittenML/kitten-tts-mini-0.8,KittenML/kitten-tts-micro-0.8,KittenML/kitten-tts-nano-0.8,KittenML/kitten-tts-nano-0.8-int8}"
KITTENTTS_DEFAULT_VOICE="${KITTENTTS_DEFAULT_VOICE:-Jasper}"
INSTALL_KOKORO="${INSTALL_KOKORO:-true}"
INSTALL_KITTENTTS="${INSTALL_KITTENTTS:-true}"
INSTALL_PIPER="${INSTALL_PIPER:-true}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root or with sudo." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl tar gzip python3 python3-venv

if [[ "$INSTALL_PIPER" == "true" ]]; then
  mkdir -p "$PIPER_DIR" "$PIPER_VOICE_DIR"
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  curl -fL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
    -o "$tmp_dir/piper_linux_x86_64.tar.gz"
  tar -xzf "$tmp_dir/piper_linux_x86_64.tar.gz" -C "$tmp_dir"
  cp -a "$tmp_dir/piper/." "$PIPER_DIR/"
  chmod 0755 "$PIPER_DIR/piper"

  curl -fL "${PIPER_VOICE_BASE_URL}/${PIPER_VOICE_NAME}.onnx" \
    -o "${PIPER_VOICE_DIR}/${PIPER_VOICE_NAME}.onnx"
  curl -fL "${PIPER_VOICE_BASE_URL}/${PIPER_VOICE_NAME}.onnx.json" \
    -o "${PIPER_VOICE_DIR}/${PIPER_VOICE_NAME}.onnx.json"
fi

if [[ "$INSTALL_KITTENTTS" == "true" ]]; then
  mkdir -p "$KITTENTTS_DIR"
  python3 -m venv "$KITTENTTS_DIR/venv"
  "$KITTENTTS_DIR/venv/bin/python" -m pip install --upgrade pip
  "$KITTENTTS_DIR/venv/bin/python" -m pip install "$KITTENTTS_WHEEL_URL"
  install -m 0755 "${APP_DIR}/scripts/kittentts-synthesize.py" "$KITTENTTS_DIR/kittentts-synthesize.py"
fi

if [[ "$INSTALL_KOKORO" == "true" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    apt-get install -y docker.io
    systemctl enable --now docker
  fi

  docker pull "$KOKORO_IMAGE"

  cat > /etc/systemd/system/kokoro-fastapi.service <<UNIT
[Unit]
Description=Kokoro FastAPI TTS
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f kokoro-fastapi
ExecStart=/usr/bin/docker run --rm --name kokoro-fastapi -p 127.0.0.1:${KOKORO_PORT}:8880 ${KOKORO_IMAGE}
ExecStop=/usr/bin/docker stop kokoro-fastapi

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now kokoro-fastapi
fi

if [[ -f "${APP_DIR}/.env" ]]; then
  ensure_env() {
    local key="$1"
    local value="$2"
    if grep -q "^${key}=" "${APP_DIR}/.env"; then
      sed -i "s|^${key}=.*|${key}=${value}|" "${APP_DIR}/.env"
    else
      echo "${key}=${value}" >> "${APP_DIR}/.env"
    fi
  }

  ensure_env "KOKORO_API_BASE" "http://127.0.0.1:${KOKORO_PORT}/v1"
  ensure_env "KOKORO_MODEL" "kokoro"
  ensure_env "KOKORO_DEFAULT_VOICE" "af_heart"
  ensure_env "KITTENTTS_MODEL" "${KITTENTTS_MODEL}"
  ensure_env "KITTENTTS_MODELS" "${KITTENTTS_MODELS}"
  ensure_env "KITTENTTS_DEFAULT_VOICE" "${KITTENTTS_DEFAULT_VOICE}"
  ensure_env "KITTENTTS_COMMAND" "${KITTENTTS_DIR}/venv/bin/python ${KITTENTTS_DIR}/kittentts-synthesize.py --model {model} --voice {voice} --speed {speed} --output {output}"
  ensure_env "KITTENTTS_OUTPUT_FORMAT" "wav"
  ensure_env "PIPER_BINARY" "${PIPER_DIR}/piper"
  ensure_env "PIPER_MODEL" "${PIPER_VOICE_DIR}/${PIPER_VOICE_NAME}.onnx"
  ensure_env "PIPER_DEFAULT_VOICE" "${PIPER_VOICE_NAME}"
  ensure_env "TTS_TIMEOUT_MS" "120000"

  systemctl restart "$APP_NAME"
fi

echo "TTS setup complete."
echo "Kokoro: http://127.0.0.1:${KOKORO_PORT}/v1"
echo "KittenTTS: ${KITTENTTS_DIR}/venv/bin/python ${KITTENTTS_DIR}/kittentts-synthesize.py"
echo "Piper: ${PIPER_DIR}/piper"
echo "TTS page: http://your-server:3000/tts.html"
