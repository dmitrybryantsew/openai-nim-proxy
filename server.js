const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { buildOpenRouterHeaders, buildOptionalBearerHeaders, createModelRegistry } = require('./src/model-registry');
const { ChatStore } = require('./src/chat-store');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 1200000);
const MODEL_CACHE_TTL_MS = Number(process.env.MODEL_CACHE_TTL_MS || 300000);
const MODEL_CACHE_FILE = process.env.MODEL_CACHE_FILE || path.join(__dirname, 'data', 'models-cache.json');
const CHAT_DB_FILE = process.env.CHAT_DB_FILE || path.join(__dirname, 'data', 'chats.sqlite');
const TTS_OUTPUT_DIR = process.env.TTS_OUTPUT_DIR || path.join(__dirname, 'data', 'tts');
const KOKORO_API_BASE = trimTrailingSlash(process.env.KOKORO_API_BASE || 'http://127.0.0.1:8880/v1');
const KOKORO_API_KEY = process.env.KOKORO_API_KEY;
const KOKORO_MODEL = process.env.KOKORO_MODEL || 'kokoro';
const KOKORO_DEFAULT_VOICE = process.env.KOKORO_DEFAULT_VOICE || 'af_heart';
const KITTENTTS_API_BASE = trimTrailingSlash(process.env.KITTENTTS_API_BASE || '');
const KITTENTTS_API_KEY = process.env.KITTENTTS_API_KEY;
const KITTENTTS_MODEL = process.env.KITTENTTS_MODEL || 'KittenML/kitten-tts-nano-0.8';
const KITTENTTS_MODELS = parseCsv(process.env.KITTENTTS_MODELS || 'KittenML/kitten-tts-mini-0.8,KittenML/kitten-tts-micro-0.8,KittenML/kitten-tts-nano-0.8,KittenML/kitten-tts-nano-0.8-int8');
const KITTENTTS_DEFAULT_VOICE = process.env.KITTENTTS_DEFAULT_VOICE || 'Jasper';
const KITTENTTS_COMMAND = process.env.KITTENTTS_COMMAND || '';
const KITTENTTS_OUTPUT_FORMAT = process.env.KITTENTTS_OUTPUT_FORMAT || 'wav';
const PIPER_BINARY = process.env.PIPER_BINARY || '/opt/piper/piper';
const PIPER_MODEL = process.env.PIPER_MODEL || '/opt/piper/voices/en_US-lessac-medium.onnx';
const PIPER_DEFAULT_VOICE = process.env.PIPER_DEFAULT_VOICE || 'en_US-lessac-medium';
const TTS_PROVIDERS = parseCsv(process.env.TTS_PROVIDERS || 'kokoro,kittentts,piper').map(normalizeTtsProvider);
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 120000);
const PROXY_API_KEY = process.env.PROXY_API_KEY;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const SHOW_REASONING = parseBoolean(process.env.SHOW_REASONING, false);
const ENABLE_THINKING_MODE = parseBoolean(process.env.ENABLE_THINKING_MODE, false);
const THINKING_MODELS = parseCsv(process.env.THINKING_MODELS || 'nim:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');
const NIM_FEATURED_MODELS = parseCsv(process.env.NIM_FEATURED_MODELS || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');
const G4F_MODELS = parseCsv(process.env.G4F_MODELS || 'gpt-4o-mini,gpt-4o,gpt-3.5-turbo');

const providers = {
  nim: {
    apiBase: trimTrailingSlash(process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1'),
    apiKey: process.env.NIM_API_KEY,
  },
  chutes: {
    apiBase: trimTrailingSlash(process.env.CHUTES_API_BASE || 'https://llm.chutes.ai/v1'),
    apiKey: process.env.CHUTES_API_KEY,
  },
  ollama: {
    apiBase: trimTrailingSlash(process.env.OLLAMA_API_BASE || 'http://127.0.0.1:11434/v1'),
    apiKey: process.env.OLLAMA_API_KEY,
    enabled: parseBoolean(process.env.OLLAMA_ENABLED, true),
  },
  g4f: {
    apiBase: trimTrailingSlash(process.env.G4F_API_BASE || 'http://127.0.0.1:1337/v1'),
    apiKey: process.env.G4F_API_KEY,
    enabled: parseBoolean(process.env.G4F_ENABLED, false),
    webUrl: trimTrailingSlash(process.env.G4F_WEB_URL || 'http://127.0.0.1:8080'),
    webPublicUrl: trimTrailingSlash(process.env.G4F_WEB_PUBLIC_URL || ''),
  },
  openrouter: {
    apiBase: trimTrailingSlash(process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1'),
    apiKey: process.env.OPENROUTER_API_KEY,
    appUrl: process.env.OPENROUTER_APP_URL,
    appTitle: process.env.OPENROUTER_APP_TITLE || 'openai-nim-proxy',
    includePaid: parseBoolean(process.env.OPENROUTER_INCLUDE_PAID, false),
    includeMultimodalOutput: parseBoolean(process.env.OPENROUTER_INCLUDE_MULTIMODAL_OUTPUT, true),
  },
};

const registry = createModelRegistry({
  cacheFile: MODEL_CACHE_FILE,
  ttlMs: MODEL_CACHE_TTL_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  nimApiBase: providers.nim.apiBase,
  nimApiKey: providers.nim.apiKey,
  nimFeaturedModels: NIM_FEATURED_MODELS,
  chutesApiBase: providers.chutes.apiBase,
  chutesApiKey: providers.chutes.apiKey,
  ollamaApiBase: providers.ollama.apiBase,
  ollamaApiKey: providers.ollama.apiKey,
  ollamaEnabled: providers.ollama.enabled,
  g4fApiBase: providers.g4f.apiBase,
  g4fApiKey: providers.g4f.apiKey,
  g4fEnabled: providers.g4f.enabled,
  g4fModels: G4F_MODELS,
  openRouterApiBase: providers.openrouter.apiBase,
  openRouterApiKey: providers.openrouter.apiKey,
  openRouterIncludePaid: providers.openrouter.includePaid,
  openRouterIncludeMultimodalOutput: providers.openrouter.includeMultimodalOutput,
  openRouterAppUrl: providers.openrouter.appUrl,
  openRouterAppTitle: providers.openrouter.appTitle,
});
const chatStore = new ChatStore(CHAT_DB_FILE);

app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: process.env.BODY_LIMIT || '50mb' }));
app.use(express.urlencoded({ limit: process.env.BODY_LIMIT || '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  index: 'index.html',
}));

app.use((req, res, next) => {
  if (req.path === '/health') {
    return next();
  }

  if (!PROXY_API_KEY) {
    return res.status(500).json(openAiError('PROXY_API_KEY is required', 'server_error', 500));
  }

  const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (key !== PROXY_API_KEY) {
    return res.status(401).json(openAiError('Invalid API key', 'invalid_request_error', 401));
  }

  next();
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'openai-nim-proxy',
    providers: {
      nim: {
        api_base: providers.nim.apiBase,
        api_key_configured: Boolean(providers.nim.apiKey),
      },
      chutes: {
        api_base: providers.chutes.apiBase,
        api_key_configured: Boolean(providers.chutes.apiKey),
      },
      ollama: {
        api_base: providers.ollama.apiBase,
        enabled: providers.ollama.enabled,
        api_key_configured: Boolean(providers.ollama.apiKey),
      },
      g4f: {
        api_base: providers.g4f.apiBase,
        enabled: providers.g4f.enabled,
        api_key_configured: Boolean(providers.g4f.apiKey),
        web_url: providers.g4f.webUrl,
        web_public_url: providers.g4f.webPublicUrl || null,
      },
      openrouter: {
        api_base: providers.openrouter.apiBase,
        api_key_configured: Boolean(providers.openrouter.apiKey),
        include_paid: providers.openrouter.includePaid,
        include_multimodal_output: providers.openrouter.includeMultimodalOutput,
      },
    },
    proxy_api_key_configured: Boolean(PROXY_API_KEY),
    model_cache: registry.getCacheInfo(),
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE,
    tts: {
      kokoro_api_base: KOKORO_API_BASE,
      kokoro_configured: Boolean(KOKORO_API_BASE),
      kittentts_api_base: KITTENTTS_API_BASE || null,
      kittentts_command_configured: Boolean(KITTENTTS_COMMAND),
      piper_binary: PIPER_BINARY,
      piper_model: PIPER_MODEL,
    },
  });
});

app.get('/v1/models', asyncHandler(async (req, res) => {
  const models = await registry.listModels({ force: req.query.refresh === 'true' });
  const filteredModels = filterModels(models, req.query);

  res.json({
    object: 'list',
    data: filteredModels.map(toOpenAiModel),
  });
}));

app.post('/admin/models/refresh', asyncHandler(async (_req, res) => {
  const models = await registry.refreshModels();
  res.json({
    object: 'model.refresh',
    count: models.length,
    cache: registry.getCacheInfo(),
    data: models.map(toOpenAiModel),
  });
}));

app.get('/admin/models', asyncHandler(async (req, res) => {
  const models = await registry.listModels({ force: req.query.refresh === 'true' });
  const filteredModels = filterModels(models, req.query);
  res.json({
    object: 'model.registry',
    cache: registry.getCacheInfo(),
    data: filteredModels,
  });
}));

app.get('/api/chats', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  res.json({
    object: 'chat.list',
    data: chatStore.listChats({ limit }),
  });
});

app.post('/api/chats', (req, res) => {
  const chat = chatStore.createChat({
    title: req.body.title || 'New chat',
    model: req.body.model || null,
  });

  res.status(201).json({
    object: 'chat',
    data: chat,
  });
});

app.get('/api/chats/:id', (req, res) => {
  const chat = chatStore.getChat(Number(req.params.id));
  if (!chat) {
    return res.status(404).json(openAiError('Chat not found', 'invalid_request_error', 404));
  }

  res.json({
    object: 'chat',
    data: chat,
  });
});

app.patch('/api/chats/:id', (req, res) => {
  const chat = chatStore.updateChat(Number(req.params.id), {
    title: req.body.title,
    model: req.body.model,
  });

  if (!chat) {
    return res.status(404).json(openAiError('Chat not found', 'invalid_request_error', 404));
  }

  res.json({
    object: 'chat',
    data: chat,
  });
});

app.delete('/api/chats/:id', (req, res) => {
  if (!chatStore.deleteChat(Number(req.params.id))) {
    return res.status(404).json(openAiError('Chat not found', 'invalid_request_error', 404));
  }

  res.status(204).end();
});

app.post('/api/chats/:id/messages', asyncHandler(async (req, res) => {
  const chatId = Number(req.params.id);
  const chat = chatStore.getChat(chatId);
  if (!chat) {
    return res.status(404).json(openAiError('Chat not found', 'invalid_request_error', 404));
  }

  const content = normalizeUserContent(req.body.content);
  const modelId = req.body.model || chat.model;
  if (!modelId) {
    return res.status(400).json(openAiError('model is required', 'invalid_request_error', 400));
  }

  const resolvedModel = await registry.resolveModel(modelId);
  const userMessage = chatStore.addMessage({
    chatId,
    role: 'user',
    content,
    model: resolvedModel.id,
    provider: resolvedModel.provider,
    providerModelId: resolvedModel.provider_model_id,
  });

  const messages = [
    ...chat.messages.map((message) => ({ role: message.role, content: message.content })),
    { role: 'user', content },
  ];
  const { completion, model } = await createChatCompletion({
    ...req.body,
    model: resolvedModel.id,
    messages,
    stream: false,
  }, resolvedModel);
  const assistantContent = completion.choices?.[0]?.message?.content || '';
  const assistantMessage = chatStore.addMessage({
    chatId,
    role: 'assistant',
    content: assistantContent,
    model: model.id,
    provider: model.provider,
    providerModelId: model.provider_model_id,
    raw: completion,
  });

  if (chat.title === 'New chat') {
    chatStore.updateChat(chatId, {
      title: makeChatTitle(content),
      model: model.id,
    });
  }

  res.json({
    object: 'chat.message_pair',
    data: {
      chat: chatStore.getChat(chatId),
      user_message: normalizeMessageRow(userMessage),
      assistant_message: normalizeMessageRow(assistantMessage),
      completion,
    },
  });
}));

app.post('/admin/models/test', async (req, res) => {
  try {
    const models = await pickModelsForTest(req.body);
    const results = [];

    for (const model of models) {
      results.push(await testModel(model));
    }

    res.json({
      object: 'model.test_results',
      count: results.length,
      data: results,
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json(openAiError(error.message || 'Model test failed', status >= 500 ? 'server_error' : 'invalid_request_error', status));
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const stream = Boolean(req.body.stream);
    const { response, model } = await requestChatCompletion(req.body, stream);

    if (response.status < 200 || response.status >= 300) {
      return sendUpstreamError(res, response);
    }

    if (stream) {
      return pipeStreamingResponse(response, res, model.id);
    }

    res.json(toOpenAiCompletion(response.data, model.id));
  } catch (error) {
    const status = error.response?.status || error.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Internal server error';
    res.status(status).json(openAiError(message, status >= 500 ? 'server_error' : 'invalid_request_error', status));
  }
});

app.get('/api/g4f/status', asyncHandler(async (_req, res) => {
  const status = await getG4fStatus();
  res.json({
    object: 'g4f.status',
    data: status,
  });
}));

app.get('/api/g4f/models', asyncHandler(async (_req, res) => {
  const status = await getG4fStatus();
  res.json({
    object: 'list',
    data: status.models,
  });
}));

app.post('/api/g4f/chat', asyncHandler(async (req, res) => {
  const model = req.body.model || G4F_MODELS[0];
  const response = await axios.post(`${getProviderConfig('g4f').apiBase}/chat/completions`, {
    model: stripG4fPrefix(model),
    messages: req.body.messages || [{ role: 'user', content: req.body.prompt || 'Reply with exactly: ok' }],
    temperature: req.body.temperature ?? 0.7,
    max_tokens: req.body.max_tokens ?? 512,
    stream: false,
  }, {
    headers: buildProviderHeaders('g4f', false),
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });

  res.status(response.status).json(response.data);
}));

app.post('/api/g4f/images', asyncHandler(async (req, res) => {
  const response = await requestG4fImageGeneration(req.body || {});
  res.status(response.status).json(response.data);
}));

app.post('/v1/images/generations', asyncHandler(async (req, res) => {
  const response = await requestG4fImageGeneration(req.body || {});
  res.status(response.status).json(response.data);
}));

app.get('/api/tts/providers', asyncHandler(async (_req, res) => {
  res.json({
    object: 'tts.provider_list',
    data: await getTtsProviders(),
  });
}));

app.post('/v1/audio/speech', asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await synthesizeSpeech(req.body || {});

  res.setHeader('Content-Type', result.contentType);
  res.setHeader('X-TTS-Provider', result.provider);
  res.setHeader('X-TTS-Elapsed-Ms', String(Date.now() - startedAt));
  res.send(result.audio);
}));

app.post('/api/tts/benchmark', asyncHandler(async (req, res) => {
  const providers = normalizeTtsProviders(req.body.providers);
  const input = String(req.body.input || 'This is a short text to speech benchmark for the proxy.').slice(0, 4000);
  const voice = req.body.voice;
  const responseFormat = req.body.response_format || 'mp3';
  const speed = req.body.speed;
  const modelsByProvider = req.body.models && typeof req.body.models === 'object' ? req.body.models : {};
  const requestedModel = req.body.model;
  const repeat = Math.min(Math.max(Number(req.body.repeat || 1), 1), 20);
  const warmup = Math.min(Math.max(Number(req.body.warmup || 0), 0), 5);
  const results = [];

  for (const provider of providers) {
    try {
      const request = {
        provider,
        input,
        voice,
        model: modelsByProvider[provider] || requestedModel,
        response_format: provider === 'piper' ? 'wav' : responseFormat,
        speed,
      };

      for (let i = 0; i < warmup; i += 1) {
        await synthesizeSpeech(request);
      }

      const samples = [];
      let bestResult = null;
      for (let i = 0; i < repeat; i += 1) {
        const startedAt = Date.now();
        const result = await synthesizeSpeech(request);
        const elapsedMs = Date.now() - startedAt;
        const sample = {
          elapsed_ms: elapsedMs,
          chars_per_second: Number((input.length / Math.max(elapsedMs / 1000, 0.001)).toFixed(2)),
          bytes: result.audio.length,
        };
        samples.push(sample);

        if (!bestResult || elapsedMs < bestResult.elapsedMs) {
          bestResult = {
            elapsedMs,
            result,
          };
        }
      }

      const elapsedValues = samples.map((sample) => sample.elapsed_ms);
      const avgElapsedMs = Math.round(elapsedValues.reduce((sum, value) => sum + value, 0) / elapsedValues.length);
      const minElapsedMs = Math.min(...elapsedValues);
      const maxElapsedMs = Math.max(...elapsedValues);

      results.push({
        provider,
        ok: true,
        elapsed_ms: avgElapsedMs,
        avg_elapsed_ms: avgElapsedMs,
        min_elapsed_ms: minElapsedMs,
        max_elapsed_ms: maxElapsedMs,
        input_chars: input.length,
        chars_per_second: Number((input.length / Math.max(avgElapsedMs / 1000, 0.001)).toFixed(2)),
        repeat,
        warmup,
        samples,
        bytes: bestResult.result.audio.length,
        content_type: bestResult.result.contentType,
        audio_base64: bestResult.result.audio.toString('base64'),
      });
    } catch (error) {
      results.push({
        provider,
        ok: false,
        elapsed_ms: 0,
        input_chars: input.length,
        repeat,
        warmup,
        error: error.message,
      });
    }
  }

  res.json({
    object: 'tts.benchmark',
    data: results,
  });
}));

app.all('*', (req, res) => {
  res.status(404).json(openAiError(`Endpoint ${req.path} not found`, 'invalid_request_error', 404));
});

app.use((error, _req, res, _next) => {
  const status = error.status || error.response?.status || 500;
  const message = error.response?.data?.error?.message || error.message || 'Internal server error';
  res.status(status).json(openAiError(message, status >= 500 ? 'server_error' : 'invalid_request_error', status));
});

app.listen(PORT, () => {
  console.log(`openai-nim-proxy listening on http://localhost:${PORT}`);
  console.log(`NVIDIA API base: ${providers.nim.apiBase}`);
  console.log(`Chutes API base: ${providers.chutes.apiBase}`);
  console.log(`Ollama API base: ${providers.ollama.apiBase}`);
  console.log(`GPT4Free API base: ${providers.g4f.apiBase} (${providers.g4f.enabled ? 'enabled' : 'disabled'})`);
  console.log(`OpenRouter API base: ${providers.openrouter.apiBase}`);
  console.log(`Model cache: ${MODEL_CACHE_FILE}`);
  console.log(`Chat database: ${CHAT_DB_FILE}`);
});

async function createChatCompletion(body, resolvedModel) {
  const { response, model } = await requestChatCompletion(body, false, resolvedModel);

  if (response.status < 200 || response.status >= 300) {
    const upstreamError = response.data?.error;
    const message = upstreamError?.message || response.statusText || 'Provider request failed';
    throw Object.assign(new Error(message), { status: response.status });
  }

  return {
    completion: toOpenAiCompletion(response.data, model.id),
    model,
  };
}

async function requestChatCompletion(body, stream, resolvedModel) {
  const model = resolvedModel || await registry.resolveModel(body.model);
  const upstreamRequest = buildUpstreamRequest(body, model, stream);
  const upstream = getProviderConfig(model.provider);

  const response = await axios.post(`${upstream.apiBase}/chat/completions`, upstreamRequest, {
    headers: buildProviderHeaders(model.provider, stream),
    responseType: stream ? 'stream' : 'json',
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });

  return { response, model };
}

async function pickModelsForTest(body = {}) {
  if (body.model) {
    return [await registry.resolveModel(body.model)];
  }

  const allModels = await registry.listModels({ force: Boolean(body.refresh) });
  const provider = body.provider;
  const limit = Number(body.limit || 10);

  return allModels
    .filter((model) => !provider || model.provider === provider)
    .slice(0, limit);
}

async function testModel(model) {
  const startedAt = Date.now();

  try {
    const response = await axios.post(`${getProviderConfig(model.provider).apiBase}/chat/completions`, {
      model: model.provider_model_id,
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      temperature: 0,
      max_tokens: 8,
      stream: false,
    }, {
      headers: buildProviderHeaders(model.provider, false),
      timeout: Number(process.env.MODEL_TEST_TIMEOUT_MS || 30000),
      validateStatus: () => true,
    });

    return {
      id: model.id,
      provider: model.provider,
      provider_model_id: model.provider_model_id,
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      latency_ms: Date.now() - startedAt,
      sample: response.data?.choices?.[0]?.message?.content || null,
      error: response.status >= 400 ? response.data?.error?.message || response.statusText : null,
    };
  } catch (error) {
    return {
      id: model.id,
      provider: model.provider,
      provider_model_id: model.provider_model_id,
      ok: false,
      status: error.response?.status || 0,
      latency_ms: Date.now() - startedAt,
      sample: null,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

function normalizeUserContent(content) {
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return JSON.stringify(content);
  }

  throw Object.assign(new Error('content is required'), { status: 400 });
}

function normalizeMessageRow(message) {
  return {
    ...message,
    id: Number(message.id),
    chat_id: Number(message.chat_id),
  };
}

function makeChatTitle(content) {
  return String(content)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'New chat';
}

function buildUpstreamRequest(body, model, stream) {
  if (!Array.isArray(body.messages)) {
    throw Object.assign(new Error('messages must be an array'), { status: 400 });
  }

  const passthroughFields = [
    'messages',
    'temperature',
    'max_tokens',
    'top_p',
    'stop',
    'presence_penalty',
    'frequency_penalty',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'functions',
    'function_call',
    'response_format',
    'seed',
    'user',
    'stream_options',
    'logprobs',
    'top_logprobs',
  ];

  const request = {
    model: model.provider_model_id,
    stream,
  };

  for (const field of passthroughFields) {
    if (body[field] !== undefined) {
      request[field] = body[field];
    }
  }

  if (request.temperature === undefined) {
    request.temperature = 0.7;
  }

  if (request.max_tokens === undefined) {
    request.max_tokens = Number(process.env.DEFAULT_MAX_TOKENS || 4096);
  }

  if (ENABLE_THINKING_MODE || THINKING_MODELS.includes(model.id) || THINKING_MODELS.includes(model.provider_model_id)) {
    request.chat_template_kwargs = {
      ...(body.chat_template_kwargs || {}),
      enable_thinking: true,
    };

    if (body.reasoning_budget === undefined && process.env.DEFAULT_REASONING_BUDGET) {
      request.reasoning_budget = Number(process.env.DEFAULT_REASONING_BUDGET);
    }
  }

  if (body.extra_body && typeof body.extra_body === 'object') {
    Object.assign(request, body.extra_body);
  }

  return request;
}

function toOpenAiModel(model) {
  return {
    id: model.id,
    object: 'model',
    created: model.created || 0,
    owned_by: model.owned_by || model.provider,
    provider: model.provider,
    provider_model_id: model.provider_model_id,
    name: model.name,
    free: model.free,
    context_length: model.context_length || null,
    modalities: getModalities(model),
  };
}

function toOpenAiCompletion(data, publicModelId) {
  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: data.object || 'chat.completion',
    created: data.created || Math.floor(Date.now() / 1000),
    model: publicModelId,
    choices: (data.choices || []).map((choice, index) => {
      const message = choice.message || {};
      const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      const content = message.content == null && hasToolCalls
        ? null
        : withReasoning(message.content || '', message.reasoning_content);

      return {
        index: choice.index ?? index,
        message: {
          role: message.role || 'assistant',
          content,
          ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        },
        finish_reason: choice.finish_reason || null,
      };
    }),
    usage: data.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function pipeStreamingResponse(response, res, publicModelId) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  let buffer = '';
  let reasoningStarted = false;

  response.data.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        res.write(`${line}\n`);
        continue;
      }

      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') {
        res.write(`${line}\n\n`);
        continue;
      }

      try {
        const data = JSON.parse(payload);
        if (publicModelId) {
          data.model = publicModelId;
        }
        const delta = data.choices?.[0]?.delta;

        if (delta) {
          const transformed = transformDelta(delta, reasoningStarted);
          reasoningStarted = transformed.reasoningStarted;
          data.choices[0].delta = transformed.delta;
        }

        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        res.write(`${line}\n\n`);
      }
    }
  });

  response.data.on('end', () => res.end());
  response.data.on('error', (error) => {
    console.error('Upstream stream error:', error.message);
    res.end();
  });
}

function transformDelta(delta, reasoningStarted) {
  const reasoning = delta.reasoning_content;
  const content = delta.content;
  const nextDelta = { ...delta };

  delete nextDelta.reasoning_content;

  if (!SHOW_REASONING) {
    nextDelta.content = content || '';
    return { delta: nextDelta, reasoningStarted };
  }

  let combinedContent = '';
  if (reasoning && !reasoningStarted) {
    combinedContent += `<think>\n${reasoning}`;
    reasoningStarted = true;
  } else if (reasoning) {
    combinedContent += reasoning;
  }

  if (content && reasoningStarted) {
    combinedContent += `</think>\n\n${content}`;
    reasoningStarted = false;
  } else if (content) {
    combinedContent += content;
  }

  if (combinedContent) {
    nextDelta.content = combinedContent;
  }

  return { delta: nextDelta, reasoningStarted };
}

function withReasoning(content, reasoning) {
  if (!SHOW_REASONING || !reasoning) {
    return content;
  }

  return `<think>\n${reasoning}\n</think>\n\n${content}`;
}

function sendUpstreamError(res, response) {
  const upstreamError = response.data?.error;
  const message = upstreamError?.message || response.statusText || 'Provider request failed';
  res.status(response.status).json(openAiError(message, upstreamError?.type || 'upstream_error', response.status));
}

function getProviderConfig(provider) {
  const config = providers[provider];
  if (!config) {
    throw Object.assign(new Error(`Unsupported provider "${provider}"`), { status: 400 });
  }

  if (provider === 'ollama') {
    if (!config.enabled) {
      throw Object.assign(new Error('OLLAMA_ENABLED must be true to use Ollama models'), { status: 500 });
    }

    return config;
  }

  if (provider === 'g4f') {
    if (!config.enabled) {
      throw Object.assign(new Error('G4F_ENABLED must be true to use GPT4Free sidecar models'), { status: 500 });
    }

    return config;
  }

  if (!config.apiKey) {
    throw Object.assign(new Error(`${provider.toUpperCase()}_API_KEY is required for chat completions and tests`), { status: 500 });
  }

  return config;
}

async function getG4fStatus() {
  const status = {
    enabled: providers.g4f.enabled,
    api_base: providers.g4f.apiBase,
    web_url: providers.g4f.webUrl,
    web_public_url: providers.g4f.webPublicUrl || null,
    ready: false,
    models: [],
    error: null,
  };

  if (!providers.g4f.enabled) {
    status.error = 'G4F_ENABLED is false';
    return status;
  }

  try {
    const response = await axios.get(`${providers.g4f.apiBase}/models`, {
      headers: buildProviderHeaders('g4f', false),
      timeout: Number(process.env.G4F_STATUS_TIMEOUT_MS || 5000),
      validateStatus: () => true,
    });

    status.ready = response.status >= 200 && response.status < 300;
    status.models = (response.data?.data || [])
      .filter((model) => model?.id)
      .map((model) => ({
        id: `g4f:${model.id}`,
        provider_model_id: model.id,
        name: model.name || model.id,
        owned_by: model.owned_by || 'gpt4free',
      }));

    if (!status.ready) {
      status.error = response.data?.error?.message || response.statusText || `HTTP ${response.status}`;
    }
  } catch (error) {
    status.error = error.message;
  }

  if (status.models.length === 0) {
    status.models = G4F_MODELS.map((model) => ({
      id: `g4f:${model}`,
      provider_model_id: model,
      name: model,
      owned_by: 'gpt4free',
      fallback: true,
    }));
  }

  return status;
}

async function requestG4fImageGeneration(body) {
  const provider = getProviderConfig('g4f');
  const request = {
    ...body,
    model: stripG4fPrefix(body.model || process.env.G4F_IMAGE_MODEL || 'flux'),
  };

  const response = await axios.post(`${provider.apiBase}/images/generations`, request, {
    headers: buildProviderHeaders('g4f', false),
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });

  return response;
}

function stripG4fPrefix(model) {
  return String(model || '').startsWith('g4f:')
    ? String(model).slice('g4f:'.length)
    : String(model || '');
}

async function getTtsProviders() {
  const [piperBinaryOk, piperModelOk, kokoroOk, kittenOk] = await Promise.all([
    isTtsProviderEnabled('piper') ? pathExists(PIPER_BINARY) : false,
    isTtsProviderEnabled('piper') ? pathExists(PIPER_MODEL) : false,
    isTtsProviderEnabled('kokoro') ? checkKokoro() : false,
    isTtsProviderEnabled('kittentts') ? checkKittenTts() : false,
  ]);

  const providers = [
    {
      id: 'kokoro',
      name: 'Kokoro',
      type: 'http',
      ready: kokoroOk,
      api_base: KOKORO_API_BASE,
      default_voice: KOKORO_DEFAULT_VOICE,
      output_formats: ['mp3', 'wav', 'opus', 'flac', 'aac', 'pcm'],
    },
    {
      id: 'kittentts',
      name: 'KittenTTS',
      type: KITTENTTS_API_BASE ? 'http' : 'local-command',
      ready: kittenOk,
      api_base: KITTENTTS_API_BASE || null,
      command_configured: Boolean(KITTENTTS_COMMAND),
      default_voice: KITTENTTS_DEFAULT_VOICE,
      default_model: KITTENTTS_MODEL,
      models: KITTENTTS_MODELS,
      output_formats: KITTENTTS_API_BASE ? ['mp3', 'wav', 'opus', 'flac', 'aac', 'pcm'] : [KITTENTTS_OUTPUT_FORMAT],
    },
    {
      id: 'piper',
      name: 'Piper',
      type: 'local-cli',
      ready: piperBinaryOk && piperModelOk,
      binary: PIPER_BINARY,
      model: PIPER_MODEL,
      default_voice: PIPER_DEFAULT_VOICE,
      output_formats: ['wav'],
    },
  ];

  return providers.filter((provider) => isTtsProviderEnabled(provider.id));
}

async function checkKokoro() {
  try {
    const response = await axios.get(`${KOKORO_API_BASE}/models`, {
      headers: buildOptionalBearerHeaders(KOKORO_API_KEY, false),
      timeout: 3000,
      validateStatus: () => true,
    });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

async function checkKittenTts() {
  if (KITTENTTS_API_BASE) {
    try {
      const response = await axios.get(`${KITTENTTS_API_BASE}/models`, {
        headers: buildOptionalBearerHeaders(KITTENTTS_API_KEY, false),
        timeout: 3000,
        validateStatus: () => true,
      });
      return response.status >= 200 && response.status < 500;
    } catch {
      return false;
    }
  }

  return Boolean(KITTENTTS_COMMAND);
}

async function synthesizeSpeech(body) {
  const input = String(body.input || '').trim();
  if (!input) {
    throw Object.assign(new Error('input is required'), { status: 400 });
  }

  const provider = normalizeTtsProvider(body.provider || body.model);
  if (!isTtsProviderEnabled(provider)) {
    throw Object.assign(new Error(`TTS provider "${provider}" is disabled`), { status: 400 });
  }

  if (provider === 'piper') {
    return synthesizeWithPiper(body, input);
  }

  if (provider === 'kokoro') {
    return synthesizeWithKokoro(body, input);
  }

  if (provider === 'kittentts') {
    return synthesizeWithKittenTts(body, input);
  }

  throw Object.assign(new Error(`Unsupported TTS provider "${provider}"`), { status: 400 });
}

async function synthesizeWithKittenTts(body, input) {
  if (KITTENTTS_API_BASE) {
    const responseFormat = String(body.response_format || 'mp3').toLowerCase();
    const modelName = getTtsModelName(body.model, KITTENTTS_MODEL);
    const response = await axios.post(`${KITTENTTS_API_BASE}/audio/speech`, {
      model: body.model && !String(body.model).startsWith('tts:')
        ? modelName
        : KITTENTTS_MODEL,
      input,
      voice: body.voice || KITTENTTS_DEFAULT_VOICE,
      response_format: responseFormat,
      speed: body.speed || 1,
    }, {
      headers: {
        ...buildOptionalBearerHeaders(KITTENTTS_API_KEY, false),
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: TTS_TIMEOUT_MS,
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      const message = Buffer.from(response.data || '').toString('utf8') || response.statusText || 'KittenTTS failed';
      throw Object.assign(new Error(message), { status: response.status });
    }

    return {
      provider: 'kittentts',
      audio: Buffer.from(response.data),
      contentType: response.headers['content-type'] || audioContentType(responseFormat),
    };
  }

  if (!KITTENTTS_COMMAND) {
    throw Object.assign(new Error('KITTENTTS_API_BASE or KITTENTTS_COMMAND is required'), { status: 500 });
  }

  await fs.mkdir(TTS_OUTPUT_DIR, { recursive: true });
  const responseFormat = String(body.response_format || KITTENTTS_OUTPUT_FORMAT).toLowerCase();
  const outputFile = path.join(TTS_OUTPUT_DIR, `kittentts-${Date.now()}-${Math.random().toString(16).slice(2)}.${responseFormat}`);
  const command = renderCommandTemplate(KITTENTTS_COMMAND, {
    model: getTtsModelName(body.model, KITTENTTS_MODEL),
    output: outputFile,
    voice: body.voice || KITTENTTS_DEFAULT_VOICE,
    format: responseFormat,
    speed: body.speed || 1,
  });

  await runShellCommand(command, input, 'KittenTTS');
  const audio = await fs.readFile(outputFile);
  fs.unlink(outputFile).catch(() => {});

  return {
    provider: 'kittentts',
    audio,
    contentType: audioContentType(responseFormat),
  };
}

async function synthesizeWithKokoro(body, input) {
  const responseFormat = String(body.response_format || 'mp3').toLowerCase();
  const response = await axios.post(`${KOKORO_API_BASE}/audio/speech`, {
    model: body.model && !String(body.model).startsWith('tts:')
      ? body.model
      : KOKORO_MODEL,
    input,
    voice: body.voice || KOKORO_DEFAULT_VOICE,
    response_format: responseFormat,
    speed: body.speed || 1,
  }, {
    headers: {
      ...buildOptionalBearerHeaders(KOKORO_API_KEY, false),
      'Content-Type': 'application/json',
    },
    responseType: 'arraybuffer',
    timeout: TTS_TIMEOUT_MS,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    const message = Buffer.from(response.data || '').toString('utf8') || response.statusText || 'Kokoro TTS failed';
    throw Object.assign(new Error(message), { status: response.status });
  }

  return {
    provider: 'kokoro',
    audio: Buffer.from(response.data),
    contentType: response.headers['content-type'] || audioContentType(responseFormat),
  };
}

async function synthesizeWithPiper(body, input) {
  if (!await pathExists(PIPER_BINARY)) {
    throw Object.assign(new Error(`Piper binary not found: ${PIPER_BINARY}`), { status: 500 });
  }

  if (!await pathExists(PIPER_MODEL)) {
    throw Object.assign(new Error(`Piper model not found: ${PIPER_MODEL}`), { status: 500 });
  }

  await fs.mkdir(TTS_OUTPUT_DIR, { recursive: true });
  const outputFile = path.join(TTS_OUTPUT_DIR, `piper-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
  const args = ['--model', PIPER_MODEL, '--output_file', outputFile];

  await runPiper(input, args);
  const audio = await fs.readFile(outputFile);
  fs.unlink(outputFile).catch(() => {});

  return {
    provider: 'piper',
    audio,
    contentType: 'audio/wav',
  };
}

function runPiper(input, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PIPER_BINARY, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`Piper timed out after ${TTS_TIMEOUT_MS}ms`), { status: 504 }));
    }, TTS_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(Object.assign(new Error(stderr.trim() || `Piper exited with code ${code}`), { status: 500 }));
      }
    });
    child.stdin.end(input);
  });
}

function runShellCommand(command, input, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`${label} timed out after ${TTS_TIMEOUT_MS}ms`), { status: 504 }));
    }, TTS_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(Object.assign(new Error(stderr.trim() || `${label} exited with code ${code}`), { status: 500 }));
      }
    });
    child.stdin.end(input);
  });
}

function renderCommandTemplate(template, values) {
  return String(template).replace(/\{(model|output|voice|format|speed)\}/g, (_match, key) => shellQuote(String(values[key])));
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeTtsProviders(value) {
  if (Array.isArray(value) && value.length > 0) {
    return value.map(normalizeTtsProvider).filter(isTtsProviderEnabled);
  }
  return TTS_PROVIDERS;
}

function normalizeTtsProvider(value) {
  const normalized = String(value || 'kokoro').toLowerCase().trim();
  if (normalized.startsWith('tts:')) {
    return normalized.slice(4);
  }
  if (normalized.includes('piper')) {
    return 'piper';
  }
  if (normalized.includes('kitten')) {
    return 'kittentts';
  }
  if (normalized.includes('kokoro')) {
    return 'kokoro';
  }
  return normalized;
}

function isTtsProviderEnabled(provider) {
  return TTS_PROVIDERS.includes(provider);
}

function getTtsModelName(value, fallback) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.startsWith('tts:')) {
    return fallback;
  }
  return normalized;
}

function audioContentType(format) {
  switch (format) {
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    case 'pcm':
      return 'audio/L16';
    case 'mp3':
    default:
      return 'audio/mpeg';
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildProviderHeaders(provider, stream) {
  if (provider === 'nim') {
    return {
      Authorization: `Bearer ${providers.nim.apiKey}`,
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
    };
  }

  if (provider === 'chutes') {
    return {
      Authorization: `Bearer ${providers.chutes.apiKey}`,
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
    };
  }

  if (provider === 'ollama') {
    return {
      ...buildOptionalBearerHeaders(providers.ollama.apiKey, stream),
      'Content-Type': 'application/json',
    };
  }

  if (provider === 'g4f') {
    return {
      ...buildOptionalBearerHeaders(providers.g4f.apiKey, stream),
      'Content-Type': 'application/json',
    };
  }

  if (provider === 'openrouter') {
    return {
      ...buildOpenRouterHeaders({
        openRouterApiKey: providers.openrouter.apiKey,
        openRouterAppUrl: providers.openrouter.appUrl,
        openRouterAppTitle: providers.openrouter.appTitle,
      }, stream),
      'Content-Type': 'application/json',
    };
  }

  throw Object.assign(new Error(`Unsupported provider "${provider}"`), { status: 400 });
}

function openAiError(message, type, code) {
  return {
    error: {
      message,
      type,
      code,
    },
  };
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseCsv(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function filterModels(models, query = {}) {
  return models.filter((model) => {
    if (query.provider && model.provider !== query.provider) {
      return false;
    }

    if (query.free === 'true' && model.free !== true) {
      return false;
    }

    if (query.free === 'false' && model.free !== false) {
      return false;
    }

    if (query.modality === 'text') {
      return isTextOnlyModel(model);
    }

    if (query.modality === 'multimodal') {
      return !isTextOnlyModel(model);
    }

    return true;
  });
}

function isTextOnlyModel(model) {
  const input = model.architecture?.input_modalities;
  const output = model.architecture?.output_modalities;

  if (Array.isArray(input) && !(input.length === 1 && input[0] === 'text')) {
    return false;
  }

  if (Array.isArray(output) && !(output.length === 1 && output[0] === 'text')) {
    return false;
  }

  return model.provider !== 'nim' || !model.provider_model_id.includes('omni');
}

function getModalities(model) {
  if (model.architecture) {
    return {
      input: model.architecture.input_modalities || null,
      output: model.architecture.output_modalities || null,
    };
  }

  if (model.provider_model_id?.includes('omni')) {
    return {
      input: ['text', 'image', 'video', 'audio'],
      output: ['text'],
    };
  }

  return {
    input: ['text'],
    output: ['text'],
  };
}
