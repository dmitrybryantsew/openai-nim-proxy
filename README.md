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

The UI also includes request settings for temperature, max tokens, top-p, presence penalty, and frequency penalty. They are saved in browser local storage and sent to the same OpenAI-compatible chat completion path used by API clients.

Open the TTS benchmark UI:

```text
http://localhost:3000/tts.html
```

It uses the same `PROXY_API_KEY`, checks Kokoro/KittenTTS/Piper readiness, generates test audio, and reports latency, bytes, and characters per second.

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

## Text To Speech Probe

The proxy includes an OpenAI-style speech endpoint for testing local TTS engines:

```bash
curl http://localhost:3000/v1/audio/speech \
  -H "Authorization: Bearer replace-with-a-long-random-secret" \
  -H "Content-Type: application/json" \
  -o speech.mp3 \
  -d '{"model":"tts:kokoro","voice":"af_heart","input":"Hello from Kokoro through the proxy.","response_format":"mp3"}'
```

Supported local providers:

- `tts:kokoro` routes to Kokoro-FastAPI, default `KOKORO_API_BASE=http://127.0.0.1:8880/v1`.
- `tts:kittentts` runs the KittenTTS Python wrapper installed by `scripts/install-tts-vps.sh`. You can test the documented KittenTTS sizes from the TTS page: mini 80M, micro 40M, nano 15M, and nano int8. You can also point it at an HTTP endpoint with `KITTENTTS_API_BASE`.
- `tts:piper` runs the local Piper CLI and returns WAV.

Install all test engines on an Ubuntu/Debian VPS:

```bash
cd /opt/openai-nim-proxy
sudo bash scripts/install-tts-vps.sh
```

The installer runs Kokoro-FastAPI as a local Docker-backed systemd service, installs KittenTTS from the GitHub release wheel, downloads Piper plus the `en_US-lessac-medium` voice, updates `/opt/openai-nim-proxy/.env`, and restarts the proxy.

On a 1-core / 2 GB RAM VPS, Piper is usually the only practical local TTS provider. To remove Kokoro and KittenTTS after testing, keep Piper, and make the proxy expose only `tts:piper`:

```bash
cd /opt/openai-nim-proxy
sudo bash scripts/cleanup-tts-vps.sh
systemctl status openai-nim-proxy --no-pager
```

If the server does not use Docker for anything else, you can also remove the Docker package:

```bash
sudo REMOVE_DOCKER_PACKAGE=true bash scripts/cleanup-tts-vps.sh
```

Run a command-line benchmark:

```bash
BASE_URL=http://127.0.0.1:3000 \
  PROXY_API_KEY=replace-with-a-long-random-secret \
  bash scripts/tts-benchmark.sh
```

By default the benchmark runs one warmup request and three measured repeats, using WAV to avoid measuring MP3 encoding overhead. Override it with `WARMUP`, `REPEAT`, and `RESPONSE_FORMAT`.

Warm the local TTS engines after restart:

```bash
BASE_URL=http://127.0.0.1:3000 \
  PROXY_API_KEY=replace-with-a-long-random-secret \
  bash scripts/warmup-tts.sh
```

Benchmark a specific KittenTTS size:

```bash
BASE_URL=http://127.0.0.1:3000 \
  PROXY_API_KEY=replace-with-a-long-random-secret \
  KITTENTTS_MODEL=KittenML/kitten-tts-mini-0.8 \
  PROVIDERS=kittentts \
  bash scripts/tts-benchmark.sh
```

Or open:

```text
http://your-server:3000/tts.html
```

Kokoro speed notes:

- Use `response_format=wav` or `pcm` while benchmarking. MP3/AAC can add encoding time.
- Compare cold and warm runs. First request after container start can include model load.
- If the VPS has an NVIDIA GPU, install Docker NVIDIA runtime and run `scripts/install-tts-vps.sh` with a GPU Kokoro image by setting `KOKORO_IMAGE`.
- If the VPS is CPU-only, keep Kokoro local on `127.0.0.1` and benchmark shorter chunks; very long text should be split client-side or by a future queue/chunker.

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

OpenAI-compatible clients can use either the server root or `/v1`, depending on the client. For example, the Obsidian plugin proxy provider accepts `http://obsidianvault.duckdns.org:3000` and normalizes it to `/v1` before loading models or sending chat requests.

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
| `REQUEST_TIMEOUT_MS` | `1200000` | Upstream request timeout. Raise this for long summaries or slow multimodal models. |
| `MODEL_TEST_TIMEOUT_MS` | `30000` | Timeout for `/admin/models/test`. |
| `MODEL_CACHE_TTL_MS` | `300000` | Cache duration for provider model lists. |
| `MODEL_CACHE_FILE` | `data/models-cache.json` | Persistent model registry cache. |
| `CHAT_DB_FILE` | `data/chats.sqlite` | SQLite database used by the built-in browser chat UI. |
| `KOKORO_API_BASE` | `http://127.0.0.1:8880/v1` | Kokoro-FastAPI OpenAI-compatible endpoint. |
| `KOKORO_MODEL` | `kokoro` | Model name sent to Kokoro-FastAPI. |
| `KOKORO_DEFAULT_VOICE` | `af_heart` | Default Kokoro voice for `/v1/audio/speech`. |
| `KOKORO_API_KEY` | none | Optional bearer token if Kokoro is behind an authenticating proxy. |
| `KITTENTTS_API_BASE` | none | Optional OpenAI-compatible KittenTTS HTTP endpoint. If set, the proxy uses HTTP instead of local command mode. |
| `KITTENTTS_API_KEY` | none | Optional bearer token for the KittenTTS HTTP endpoint. |
| `KITTENTTS_MODEL` | `KittenML/kitten-tts-nano-0.8` | KittenTTS model name or path. |
| `KITTENTTS_MODELS` | mini/micro/nano/nano-int8 presets | Comma-separated KittenTTS model presets shown on the TTS benchmark page. |
| `KITTENTTS_DEFAULT_VOICE` | `Jasper` | Default KittenTTS voice. The upstream examples include voices such as Bella, Liam, and Jasper. |
| `KITTENTTS_COMMAND` | none | Local command template. The VPS installer sets this to the Python wrapper. Supports `{model}`, `{voice}`, `{speed}`, `{format}`, and `{output}` tokens. Text is passed on stdin. |
| `KITTENTTS_OUTPUT_FORMAT` | `wav` | Expected output format for local KittenTTS command mode. |
| `PIPER_BINARY` | `/opt/piper/piper` | Piper CLI path. |
| `PIPER_MODEL` | `/opt/piper/voices/en_US-lessac-medium.onnx` | Piper voice model path. |
| `PIPER_DEFAULT_VOICE` | `en_US-lessac-medium` | Display/default label for Piper. |
| `TTS_PROVIDERS` | `kokoro,kittentts,piper` | Comma-separated enabled TTS providers. Use `piper` on small VPS hosts. |
| `TTS_TIMEOUT_MS` | `120000` | TTS generation timeout. |
| `SHOW_REASONING` | `false` | If true, exposes upstream reasoning in `<think>` tags. |
| `ENABLE_THINKING_MODE` | `false` | Forces `chat_template_kwargs.enable_thinking=true`. |
| `THINKING_MODELS` | none | Comma-separated public or provider model IDs that should get thinking enabled. |
