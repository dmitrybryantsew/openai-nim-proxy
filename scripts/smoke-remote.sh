#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
PROXY_API_KEY="${PROXY_API_KEY:?Set PROXY_API_KEY to the proxy bearer token}"
MODEL_ID="${MODEL_ID:-nim:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning}"

curl -fsS "${BASE_URL}/health" >/dev/null

curl -fsS "${BASE_URL}/v1/models" \
  -H "Authorization: Bearer ${PROXY_API_KEY}" >/dev/null

curl -fsS "${BASE_URL}/v1/models?modality=multimodal" \
  -H "Authorization: Bearer ${PROXY_API_KEY}" >/dev/null

curl -fsS "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: ok\"}],\"max_tokens\":8}" >/dev/null

echo "remote smoke ok"
