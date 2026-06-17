#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3130}"
PROXY_API_KEY="${PROXY_API_KEY:-local-check-key}"
MODEL_CACHE_FILE="${MODEL_CACHE_FILE:-data/check-models-cache.json}"
RUN_LIVE_MODEL_REFRESH="${RUN_LIVE_MODEL_REFRESH:-0}"

npm ci
npm run check

export PORT PROXY_API_KEY MODEL_CACHE_FILE

log_file="$(mktemp)"
err_file="$(mktemp)"

node server.js >"$log_file" 2>"$err_file" &
pid="$!"

cleanup() {
  kill "$pid" >/dev/null 2>&1 || true
  rm -f "$log_file" "$err_file"
}
trap cleanup EXIT

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null; then
    break
  fi
  sleep 0.25
done

curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null

if [[ "$RUN_LIVE_MODEL_REFRESH" == "1" ]]; then
  curl -fsS "http://127.0.0.1:${PORT}/v1/models?refresh=true" \
    -H "Authorization: Bearer ${PROXY_API_KEY}" >/dev/null
else
  curl -fsS "http://127.0.0.1:${PORT}/v1/models" \
    -H "Authorization: Bearer ${PROXY_API_KEY}" >/dev/null
fi

echo "check ok"
