# openai-nim-proxy

OpenAI-compatible proxy for NVIDIA NIM and OpenRouter models.

The proxy keeps OpenAI-style endpoints, but it does not fake OpenAI model aliases. It exposes real provider models with explicit IDs:

- `nim:<nvidia-model-id>`
- `openrouter:<openrouter-model-id>`

Example: `openrouter:nvidia/nemotron-3-ultra-550b-a55b:free`.

## Model registry

`GET /v1/models` returns cached provider models in OpenAI-compatible format.

Sources:

- NVIDIA NIM: `GET {NIM_API_BASE}/models`, when `NIM_API_KEY` is configured.
- OpenRouter: `GET {OPENROUTER_API_BASE}/models`. By default only free text-only-output models are exposed.

OpenRouter free filtering uses `:free` model IDs and zero prompt/completion pricing. NVIDIA's model list does not expose comparable free-pricing metadata, so NIM models are treated as models available to the configured NVIDIA key.

Useful filters:

```bash
# All text-only models
curl "http://localhost:3000/v1/models?modality=text" \
  -H "Authorization: Bearer replace-with-a-long-random-secret"

# Multimodal models only
curl "http://localhost:3000/v1/models?modality=multimodal" \
  -H "Authorization: Bearer replace-with-a-long-random-secret"

# OpenRouter free models only
curl "http://localhost:3000/v1/models?provider=openrouter&free=true" \
  -H "Authorization: Bearer replace-with-a-long-random-secret"
```

Refresh manually:

```bash
curl -X POST http://localhost:3000/admin/models/refresh \
  -H "Authorization: Bearer replace-with-a-long-random-secret"
```

Inspect stored metadata:

```bash
curl http://localhost:3000/admin/models \
  -H "Authorization: Bearer replace-with-a-long-random-secret"
```

## Local run

```bash
npm install
cp .env.example .env
npm start
```

Set at least:

```bash
PROXY_API_KEY=replace-with-a-long-random-secret
NIM_API_KEY=nvapi-your-nvidia-key
OPENROUTER_API_KEY=sk-or-your-openrouter-key
```

OpenRouter model listing works without an API key, but chat completions and tests require `OPENROUTER_API_KEY`.

Health check:

```bash
curl http://localhost:3000/health
```

List models:

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer replace-with-a-long-random-secret"
```

Chat request:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer replace-with-a-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"model":"nim:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning","messages":[{"role":"user","content":"Say hello"}]}'
```

Test one model:

```bash
curl -X POST http://localhost:3000/admin/models/test \
  -H "Authorization: Bearer replace-with-a-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"model":"openrouter:nvidia/nemotron-3-ultra-550b-a55b:free"}'
```

Test the first 5 OpenRouter models currently in the registry:

```bash
curl -X POST http://localhost:3000/admin/models/test \
  -H "Authorization: Bearer replace-with-a-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"provider":"openrouter","limit":5}'
```

## Docker

```bash
docker build -t openai-nim-proxy .
docker run --rm -p 3000:3000 \
  -e PROXY_API_KEY=replace-with-a-long-random-secret \
  -e NIM_API_KEY=nvapi-your-nvidia-key \
  -e OPENROUTER_API_KEY=sk-or-your-openrouter-key \
  openai-nim-proxy
```

## VPS install

The included install script targets Debian/Ubuntu servers with systemd:

```bash
sudo PROXY_API_KEY="replace-with-a-long-random-secret" \
  NIM_API_KEY="nvapi-your-nvidia-key" \
  OPENROUTER_API_KEY="sk-or-your-openrouter-key" \
  bash scripts/install-vps.sh
```

Useful install variables:

```bash
APP_DIR=/opt/openai-nim-proxy
APP_USER=openai-nim-proxy
REPO_URL=https://github.com/dmitrybryantsew/openai-nim-proxy.git
BRANCH=main
PORT=3000
```

After install:

```bash
systemctl status openai-nim-proxy
journalctl -u openai-nim-proxy -f
```

Remote smoke check:

```bash
BASE_URL=http://your-server:3000 \
  PROXY_API_KEY=replace-with-a-long-random-secret \
  bash scripts/smoke-remote.sh
```

## Environment

| Name | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `PROXY_API_KEY` | none | Required for every endpoint except `/health`. |
| `CORS_ORIGIN` | `*` | Restrict this on a public VPS when browser clients are known. |
| `NIM_API_BASE` | `https://integrate.api.nvidia.com/v1` | NVIDIA OpenAI-compatible endpoint. |
| `NIM_API_KEY` | none | Required for NIM model listing, chat completions, and tests. |
| `OPENROUTER_API_BASE` | `https://openrouter.ai/api/v1` | OpenRouter OpenAI-compatible endpoint. |
| `OPENROUTER_API_KEY` | none | Required for OpenRouter chat completions and tests. |
| `OPENROUTER_INCLUDE_PAID` | `false` | If true, exposes paid OpenRouter models too. |
| `OPENROUTER_INCLUDE_MULTIMODAL_OUTPUT` | `false` | If true, also exposes models that return text plus another modality. |
| `OPENROUTER_APP_TITLE` | `openai-nim-proxy` | Sent as `X-Title` to OpenRouter. |
| `OPENROUTER_APP_URL` | none | Sent as `HTTP-Referer` to OpenRouter. |
| `DEFAULT_MAX_TOKENS` | `4096` | Used when the client omits `max_tokens`. |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout. |
| `MODEL_TEST_TIMEOUT_MS` | `30000` | Timeout for `/admin/models/test`. |
| `MODEL_CACHE_TTL_MS` | `300000` | Cache duration for provider model lists. |
| `MODEL_CACHE_FILE` | `data/models-cache.json` | Persistent model registry cache. |
| `SHOW_REASONING` | `false` | If true, exposes upstream reasoning in `<think>` tags. |
| `ENABLE_THINKING_MODE` | `false` | Forces `chat_template_kwargs.thinking=true`. |
| `THINKING_MODELS` | none | Comma-separated public or provider model IDs that should get thinking enabled. |
