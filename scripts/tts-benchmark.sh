#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
PROXY_API_KEY="${PROXY_API_KEY:-}"
PROVIDERS="${PROVIDERS:-kokoro,kittentts,piper}"
KITTENTTS_MODEL="${KITTENTTS_MODEL:-KittenML/kitten-tts-nano-0.8}"
REPEAT="${REPEAT:-3}"
WARMUP="${WARMUP:-1}"
RESPONSE_FORMAT="${RESPONSE_FORMAT:-wav}"
TEXT="${TEXT:-This is a text to speech benchmark for Kokoro, KittenTTS, and Piper running behind the OpenAI-compatible proxy.}"

if [[ -z "$PROXY_API_KEY" ]]; then
  echo "Set PROXY_API_KEY before running this script." >&2
  exit 1
fi

json_providers="$(printf '%s' "$PROVIDERS" | awk -F, '{ printf "["; for (i=1; i<=NF; i++) { gsub(/^ +| +$/, "", $i); printf "%s\"%s\"", i>1?",":"", $i } printf "]" }')"

curl -fsS "${BASE_URL}/api/tts/benchmark" \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"providers\":${json_providers},\"models\":{\"kittentts\":$(KITTENTTS_MODEL="$KITTENTTS_MODEL" node -e "process.stdout.write(JSON.stringify(process.env.KITTENTTS_MODEL || ''))")},\"input\":$(TEXT="$TEXT" node -e "process.stdout.write(JSON.stringify(process.env.TEXT || ''))"),\"response_format\":$(RESPONSE_FORMAT="$RESPONSE_FORMAT" node -e "process.stdout.write(JSON.stringify(process.env.RESPONSE_FORMAT || 'wav'))"),\"speed\":1,\"warmup\":${WARMUP},\"repeat\":${REPEAT}}"
