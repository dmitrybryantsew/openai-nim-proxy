#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
PROXY_API_KEY="${PROXY_API_KEY:-}"
PROVIDERS="${PROVIDERS:-kokoro,kittentts,piper}"
TEXT="${TEXT:-Warm up text to speech models.}"

if [[ -z "$PROXY_API_KEY" ]]; then
  echo "Set PROXY_API_KEY before running this script." >&2
  exit 1
fi

json_providers="$(printf '%s' "$PROVIDERS" | awk -F, '{ printf "["; for (i=1; i<=NF; i++) { gsub(/^ +| +$/, "", $i); printf "%s\"%s\"", i>1?",":"", $i } printf "]" }')"

curl -fsS "${BASE_URL}/api/tts/benchmark" \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"providers\":${json_providers},\"input\":$(TEXT="$TEXT" node -e "process.stdout.write(JSON.stringify(process.env.TEXT || ''))"),\"response_format\":\"wav\",\"warmup\":0,\"repeat\":1}" \
  >/dev/null

echo "TTS warmup complete."
