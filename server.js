const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { buildOpenRouterHeaders, createModelRegistry } = require('./src/model-registry');
const { ChatStore } = require('./src/chat-store');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
const MODEL_CACHE_TTL_MS = Number(process.env.MODEL_CACHE_TTL_MS || 300000);
const MODEL_CACHE_FILE = process.env.MODEL_CACHE_FILE || path.join(__dirname, 'data', 'models-cache.json');
const CHAT_DB_FILE = process.env.CHAT_DB_FILE || path.join(__dirname, 'data', 'chats.sqlite');
const PROXY_API_KEY = process.env.PROXY_API_KEY;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const SHOW_REASONING = parseBoolean(process.env.SHOW_REASONING, false);
const ENABLE_THINKING_MODE = parseBoolean(process.env.ENABLE_THINKING_MODE, false);
const THINKING_MODELS = parseCsv(process.env.THINKING_MODELS || 'nim:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');
const NIM_FEATURED_MODELS = parseCsv(process.env.NIM_FEATURED_MODELS || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');

const providers = {
  nim: {
    apiBase: trimTrailingSlash(process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1'),
    apiKey: process.env.NIM_API_KEY,
  },
  chutes: {
    apiBase: trimTrailingSlash(process.env.CHUTES_API_BASE || 'https://llm.chutes.ai/v1'),
    apiKey: process.env.CHUTES_API_KEY,
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

  const userMessage = chatStore.addMessage({
    chatId,
    role: 'user',
    content,
    model: modelId,
  });

  const messages = [
    ...chat.messages.map((message) => ({ role: message.role, content: message.content })),
    { role: 'user', content },
  ];
  const completion = await createChatCompletion({
    ...req.body,
    model: modelId,
    messages,
    stream: false,
  });
  const assistantContent = completion.choices?.[0]?.message?.content || '';
  const assistantMessage = chatStore.addMessage({
    chatId,
    role: 'assistant',
    content: assistantContent,
    model: modelId,
    raw: completion,
  });

  if (chat.title === 'New chat') {
    chatStore.updateChat(chatId, {
      title: makeChatTitle(content),
      model: modelId,
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
      return pipeStreamingResponse(response, res);
    }

    res.json(toOpenAiCompletion(response.data, model.id));
  } catch (error) {
    const status = error.response?.status || error.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Internal server error';
    res.status(status).json(openAiError(message, status >= 500 ? 'server_error' : 'invalid_request_error', status));
  }
});

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
  console.log(`OpenRouter API base: ${providers.openrouter.apiBase}`);
  console.log(`Model cache: ${MODEL_CACHE_FILE}`);
  console.log(`Chat database: ${CHAT_DB_FILE}`);
});

async function createChatCompletion(body) {
  const { response, model } = await requestChatCompletion(body, false);

  if (response.status < 200 || response.status >= 300) {
    const upstreamError = response.data?.error;
    const message = upstreamError?.message || response.statusText || 'Provider request failed';
    throw Object.assign(new Error(message), { status: response.status });
  }

  return toOpenAiCompletion(response.data, model.id);
}

async function requestChatCompletion(body, stream) {
  const model = await registry.resolveModel(body.model);
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
    'response_format',
    'seed',
    'user',
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
      const content = withReasoning(message.content || '', message.reasoning_content);

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

function pipeStreamingResponse(response, res) {
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

  if (!config.apiKey) {
    throw Object.assign(new Error(`${provider.toUpperCase()}_API_KEY is required for chat completions and tests`), { status: 500 });
  }

  return config;
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
