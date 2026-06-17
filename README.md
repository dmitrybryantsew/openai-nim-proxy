# openai-nim-proxy

OpenAI-compatible proxy for NVIDIA NIM, Chutes, Ollama, and OpenRouter models.

The proxy keeps OpenAI-style endpoints, but it does not fake OpenAI model aliases. It exposes real provider models with explicit IDs:

- `nim:<nvidia-model-id>`
- `chutes:<chutes-model-id>`
- `ollama:<ollama-model-name>`
- `openrouter:<openrouter-model-id>`

Example: `openrouter:nvidia/nemotron-3-ultra-550b-a55b:free`.

## Model registry

`GET /v1/models` returns cached provider models in OpenAI-compatible format.

Sources:

- NVIDIA NIM: `GET {NIM_API_BASE}/models`, when `NIM_API_KEY` is configured.
- Chutes: `GET {CHUTES_API_BASE}/models`, when `CHUTES_API_KEY` is configured.
- Ollama: `GET {OLLAMA_API_BASE}/models`, when `OLLAMA_ENABLED=true`.
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

# Chutes models only
curl "http://localhost:3000/v1/models?provider=chutes" \
  -H "Authorization: Bearer replace-with-a-long-random-secret"

# Ollama models only
curl "http://localhost:3000/v1/models?provider=ollama" \
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

Open the built-in chat UI:

```text
http://localhost:3000/
```

The UI asks for `PROXY_API_KEY` and stores it in browser local storage. Chats are saved in SQLite at `data/chats.sqlite` by default. New messages also store provider metadata, so the UI can show which provider and provider model produced a response.

Set at least:

```bash
PROXY_API_KEY=replace-with-a-long-random-secret
NIM_API_KEY=nvapi-your-nvidia-key
CHUTES_API_KEY=cpk-your-chutes-key
OPENROUTER_API_KEY=sk-or-your-openrouter-key
```

OpenRouter model listing works without an API key, but chat completions and tests require `OPENROUTER_API_KEY`.

Ollama does not require a login or API key when it runs locally. Install Ollama separately, pull at least one model, and keep `OLLAMA_API_BASE=http://127.0.0.1:11434/v1`:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.2
```

Then use model IDs like `ollama:llama3.2`.

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

## Tool calling

The proxy passes OpenAI-style tool-calling fields through to upstream providers:

- `tools`
- `tool_choice`
- `parallel_tool_calls`
- legacy `functions` / `function_call`

It also preserves returned `tool_calls` in non-streaming and streaming responses. Tool execution is still the client application's job; the proxy only routes the model request and response.

Local deterministic probe:

```bash
npm run probe:tools
```

This starts a mock upstream provider and verifies tool-call pass-through without using provider credits.

Hermes end-to-end probe, when Hermes is installed locally:

```powershell
$env:HERMES_EXE='E:\agent coding\hermes-agent\.venv-local\Scripts\hermes.exe'
npm run probe:hermes
```

This uses a temporary Hermes home under `data/hermes-probe-home`, sends tools through the proxy, receives a streaming tool call, executes Hermes' `read_file` tool, and sends the tool result back.

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
  -e CHUTES_API_KEY=cpk-your-chutes-key \
  -e OLLAMA_API_BASE=http://host.docker.internal:11434/v1 \
  -e OPENROUTER_API_KEY=sk-or-your-openrouter-key \
  openai-nim-proxy
```

## VPS install

The included install script targets Debian/Ubuntu servers with systemd:

```bash
sudo PROXY_API_KEY="replace-with-a-long-random-secret" \
  NIM_API_KEY="nvapi-your-nvidia-key" \
  CHUTES_API_KEY="cpk-your-chutes-key" \
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

Then open:

```text
http://your-server:3000/
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
| `CHUTES_API_BASE` | `https://llm.chutes.ai/v1` | Chutes OpenAI-compatible endpoint. |
| `CHUTES_API_KEY` | none | Required for Chutes model listing, chat completions, and tests. |
| `OLLAMA_ENABLED` | `true` | If true, tries to list and route local/self-hosted Ollama models. |
| `OLLAMA_API_BASE` | `http://127.0.0.1:11434/v1` | Ollama OpenAI-compatible endpoint. |
| `OLLAMA_API_KEY` | none | Optional bearer token if Ollama is behind an authenticating proxy. |
| `OPENROUTER_API_BASE` | `https://openrouter.ai/api/v1` | OpenRouter OpenAI-compatible endpoint. |
| `OPENROUTER_API_KEY` | none | Required for OpenRouter chat completions and tests. |
| `OPENROUTER_INCLUDE_PAID` | `false` | If true, exposes paid OpenRouter models too. |
| `OPENROUTER_INCLUDE_MULTIMODAL_OUTPUT` | `true` | If true, also exposes models that return text plus another modality. |
| `OPENROUTER_APP_TITLE` | `openai-nim-proxy` | Sent as `X-Title` to OpenRouter. |
| `OPENROUTER_APP_URL` | none | Sent as `HTTP-Referer` to OpenRouter. |
| `DEFAULT_MAX_TOKENS` | `4096` | Used when the client omits `max_tokens`. |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout. |
| `MODEL_TEST_TIMEOUT_MS` | `30000` | Timeout for `/admin/models/test`. |
| `MODEL_CACHE_TTL_MS` | `300000` | Cache duration for provider model lists. |
| `MODEL_CACHE_FILE` | `data/models-cache.json` | Persistent model registry cache. |
| `CHAT_DB_FILE` | `data/chats.sqlite` | SQLite database used by the built-in browser chat UI. |
| `SHOW_REASONING` | `false` | If true, exposes upstream reasoning in `<think>` tags. |
| `ENABLE_THINKING_MODE` | `false` | Forces `chat_template_kwargs.enable_thinking=true`. |
| `THINKING_MODELS` | none | Comma-separated public or provider model IDs that should get thinking enabled. |
