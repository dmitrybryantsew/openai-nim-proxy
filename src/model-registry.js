const fs = require('fs');
const path = require('path');
const axios = require('axios');

function createModelRegistry(options) {
  const config = {
    cacheFile: options.cacheFile,
    ttlMs: options.ttlMs,
    requestTimeoutMs: options.requestTimeoutMs,
    nimApiBase: trimTrailingSlash(options.nimApiBase),
    nimApiKey: options.nimApiKey,
    nimFeaturedModels: options.nimFeaturedModels || [],
    chutesApiBase: trimTrailingSlash(options.chutesApiBase),
    chutesApiKey: options.chutesApiKey,
    ollamaApiBase: trimTrailingSlash(options.ollamaApiBase),
    ollamaApiKey: options.ollamaApiKey,
    ollamaEnabled: options.ollamaEnabled,
    g4fApiBase: trimTrailingSlash(options.g4fApiBase),
    g4fApiKey: options.g4fApiKey,
    g4fEnabled: options.g4fEnabled,
    g4fModels: options.g4fModels || [],
    g4fModelAllowlist: options.g4fModelAllowlist || [],
    g4fProbeEnabled: Boolean(options.g4fProbeEnabled),
    g4fProbeTimeoutMs: Number(options.g4fProbeTimeoutMs) || 8000,
    openRouterApiBase: trimTrailingSlash(options.openRouterApiBase),
    openRouterApiKey: options.openRouterApiKey,
    openRouterIncludePaid: options.openRouterIncludePaid,
    tokenrouterApiBase: trimTrailingSlash(options.tokenrouterApiBase),
    tokenrouterApiKey: options.tokenrouterApiKey,
    inferxApiBase: trimTrailingSlash(options.inferxApiBase),
    inferxApiKey: options.inferxApiKey,
    openRouterIncludeMultimodalOutput: options.openRouterIncludeMultimodalOutput,
    openRouterAppUrl: options.openRouterAppUrl,
    openRouterAppTitle: options.openRouterAppTitle,
  };

  let memoryCache = readCache(config.cacheFile);

  async function listModels({ force = false } = {}) {
    if (!force && isFresh(memoryCache, config.ttlMs)) {
      return memoryCache.models;
    }

    const models = await refreshModels();
    return models;
  }

  async function refreshModels() {
    const [nimModels, chutesModels, ollamaModels, g4fModels, openRouterModels, tokenrouterModels, inferxModels] = await Promise.all([
      fetchNimModels(config).catch(() => []),
      fetchChutesModels(config).catch(() => []),
      fetchOllamaModels(config).catch(() => []),
      fetchG4fModels(config).catch(() => buildConfiguredG4fModels(config)),
      fetchOpenRouterModels(config).catch(() => []),
      fetchTokenRouterModels(config).catch(() => []),
      fetchInferxModels(config).catch(() => []),
    ]);

    const models = uniqueById([
      ...buildFeaturedNimModels(config.nimFeaturedModels),
      ...nimModels,
      ...chutesModels,
      ...ollamaModels,
      ...g4fModels,
      ...openRouterModels,
      ...tokenrouterModels,
      ...inferxModels,
    ]).sort((a, b) => {
      if (a.provider !== b.provider) {
        return a.provider.localeCompare(b.provider);
      }

      return a.id.localeCompare(b.id);
    });

    memoryCache = {
      updated_at: new Date().toISOString(),
      models,
    };

    writeCache(config.cacheFile, memoryCache);
    return models;
  }

  async function resolveModel(publicModelId) {
    if (!publicModelId || typeof publicModelId !== 'string') {
      throw Object.assign(new Error('model is required'), { status: 400 });
    }

    const models = await listModels();
    const match = models.find((model) => model.id === publicModelId);
    if (match) {
      return match;
    }

    const direct = parseDirectModel(publicModelId);
    if (direct) {
      return direct;
    }

    throw Object.assign(
      new Error(`Unknown model "${publicModelId}". Refresh /v1/models or use provider-prefixed IDs like "nim:<model>", "ollama:<model>", "g4f:<model>", or "openrouter:<model>".`),
      { status: 400 },
    );
  }

  function getCacheInfo() {
    return {
      cache_file: config.cacheFile,
      updated_at: memoryCache.updated_at || null,
      ttl_ms: config.ttlMs,
      count: memoryCache.models?.length || 0,
    };
  }

  return {
    listModels,
    refreshModels,
    resolveModel,
    getCacheInfo,
  };
}

function normalizeModelCreated(value) {
  const created = Number(value || 0);
  if (!Number.isFinite(created) || created <= 0) {
    return 0;
  }

  const earliestSaneModelTimestamp = Date.UTC(2018, 0, 1) / 1000;
  const oneYearInSeconds = 365 * 24 * 60 * 60;
  const latestSaneModelTimestamp = Math.floor(Date.now() / 1000) + oneYearInSeconds;
  if (created < earliestSaneModelTimestamp || created > latestSaneModelTimestamp) {
    return 0;
  }

  return created;
}
function buildFeaturedNimModels(modelIds) {
  return modelIds
    .filter(Boolean)
    .map((modelId) => ({
      id: `nim:${modelId}`,
      object: 'model',
      created: 0,
      owned_by: 'nvidia',
      provider: 'nim',
      provider_model_id: modelId,
      name: modelId,
      free: null,
      pricing: null,
      context_length: null,
      source: 'configured-nim-featured',
    }));
}

async function fetchNimModels(config) {
  if (!config.nimApiKey) {
    return [];
  }

  const response = await axios.get(`${config.nimApiBase}/models`, {
    headers: {
      Authorization: `Bearer ${config.nimApiKey}`,
      Accept: 'application/json',
    },
    timeout: config.requestTimeoutMs,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    return [];
  }

  return (response.data?.data || [])
    .filter((model) => model?.id)
    .map((model) => ({
      id: `nim:${model.id}`,
      object: 'model',
      created: normalizeModelCreated(model.created),
      owned_by: 'nvidia',
      provider: 'nim',
      provider_model_id: model.id,
      name: model.name || model.id,
      free: null,
      pricing: model.pricing || null,
      context_length: model.context_length || model.top_provider?.context_length || null,
      source: 'nvidia-nim',
    }));
}

async function fetchChutesModels(config) {
  if (!config.chutesApiKey) {
    return [];
  }

  const response = await axios.get(`${config.chutesApiBase}/models`, {
    headers: {
      Authorization: `Bearer ${config.chutesApiKey}`,
      Accept: 'application/json',
    },
    timeout: config.requestTimeoutMs,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    return [];
  }

  return (response.data?.data || [])
    .filter((model) => model?.id)
    .map((model) => ({
      id: `chutes:${model.id}`,
      object: 'model',
      created: Number(model.created || 0),
      owned_by: model.owned_by || model.id.split('/')[0] || 'chutes',
      provider: 'chutes',
      provider_model_id: model.id,
      name: model.name || model.id,
      free: null,
      pricing: model.pricing || null,
      context_length: model.context_length || model.top_provider?.context_length || null,
      architecture: {
        input_modalities: model.input_modalities || null,
        output_modalities: model.output_modalities || null,
      },
      source: 'chutes',
      supported_features: model.supported_features || [],
      supported_parameters: model.supported_sampling_parameters || [],
    }));
}

async function fetchOllamaModels(config) {
  if (!config.ollamaEnabled) {
    return [];
  }

  const response = await axios.get(`${config.ollamaApiBase}/models`, {
    headers: buildOptionalBearerHeaders(config.ollamaApiKey, false),
    timeout: config.requestTimeoutMs,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    return [];
  }

  return (response.data?.data || [])
    .filter((model) => model?.id)
    .map((model) => ({
      id: `ollama:${model.id}`,
      object: 'model',
      created: Number(model.created || 0),
      owned_by: model.owned_by || 'ollama',
      provider: 'ollama',
      provider_model_id: model.id,
      name: model.name || model.id,
      free: true,
      pricing: {
        prompt: '0',
        completion: '0',
      },
      context_length: model.context_length || null,
      source: 'ollama',
    }));
}

async function fetchG4fModels(config) {
  if (!config.g4fEnabled) {
    return [];
  }

  const response = await axios.get(`${config.g4fApiBase}/models`, {
    headers: buildOptionalBearerHeaders(config.g4fApiKey, false),
    timeout: config.requestTimeoutMs,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    return buildConfiguredG4fModels(config);
  }

  const fetched = (response.data?.data || [])
    .filter((model) => model?.id)
    .map((model) => buildG4fModel(model.id, {
      created: Number(model.created || 0),
      ownedBy: model.owned_by || 'gpt4free',
      name: model.name || model.id,
      source: 'g4f',
    }));

  const filtered = applyG4fAllowlist(fetched, config);

  if (filtered.length > 0) {
    return filtered;
  }

  return buildConfiguredG4fModels(config);
}

function applyG4fAllowlist(models, config) {
  // If an explicit allowlist is configured, intersect with it. Otherwise
  // return the models unchanged (the caller falls back to the configured
  // g4fModels list when the live fetch returns nothing usable).
  if (!Array.isArray(config.g4fModelAllowlist) || config.g4fModelAllowlist.length === 0) {
    return models;
  }

  const allowed = new Set(config.g4fModelAllowlist.map((id) => String(id).trim()).filter(Boolean));
  if (allowed.size === 0) {
    return models;
  }

  return models.filter((model) => allowed.has(model.provider_model_id));
}

function buildConfiguredG4fModels(config) {
  if (!config.g4fEnabled) {
    return [];
  }

  return config.g4fModels.map((modelId) => buildG4fModel(modelId, {
    ownedBy: 'gpt4free',
    name: modelId,
    source: 'configured-g4f',
  }));
}

function buildG4fModel(modelId, options = {}) {
  return {
    id: `g4f:${modelId}`,
    object: 'model',
    created: options.created || 0,
    owned_by: options.ownedBy || 'gpt4free',
    provider: 'g4f',
    provider_model_id: modelId,
    name: options.name || modelId,
    free: true,
    pricing: {
      prompt: '0',
      completion: '0',
    },
    context_length: null,
    source: options.source || 'g4f',
    experimental: true,
  };
}

async function fetchOpenRouterModels(config) {
  const response = await axios.get(`${config.openRouterApiBase}/models`, {
    headers: buildOpenRouterHeaders(config, false),
    timeout: config.requestTimeoutMs,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    return [];
  }

  return (response.data?.data || [])
    .filter((model) => model?.id)
    .filter((model) => config.openRouterIncludePaid || isOpenRouterFree(model))
    .filter((model) => supportsChatOutput(model, config.openRouterIncludeMultimodalOutput))
    .map((model) => ({
      id: `openrouter:${model.id}`,
      object: 'model',
      created: Number(model.created || 0),
      owned_by: model.id.split('/')[0] || 'openrouter',
      provider: 'openrouter',
      provider_model_id: model.id,
      name: model.name || model.id,
      free: isOpenRouterFree(model),
      pricing: model.pricing || null,
      context_length: model.context_length || model.top_provider?.context_length || null,
      architecture: model.architecture || null,
      source: 'openrouter',
      supported_parameters: model.supported_parameters || [],
    }));
}

async function fetchTokenRouterModels(config) {
  if (!config.tokenrouterApiKey) {
    return [];
  }

  const response = await axios.get(`${config.tokenrouterApiBase}/models`, {
    headers: buildOptionalBearerHeaders(config.tokenrouterApiKey, false),
    timeout: config.requestTimeoutMs,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    return [];
  }

  return (response.data?.data || [])
    .filter((model) => model?.id)
    .map((model) => ({
      id: `tokenrouter:${model.id}`,
      object: 'model',
      created: normalizeModelCreated(model.created),
      owned_by: model.owned_by || 'tokenrouter',
      provider: 'tokenrouter',
      provider_model_id: model.id,
      name: model.name || model.id,
      free: null,
      pricing: model.pricing || null,
      context_length: model.context_length || null,
      architecture: model.architecture || null,
      source: 'tokenrouter',
    }));
}

async function fetchInferxModels(config) {
  if (!config.inferxApiKey) {
    return [];
  }

  const response = await axios.get(`${config.inferxApiBase}/models`, {
    headers: buildOptionalBearerHeaders(config.inferxApiKey, false),
    timeout: config.requestTimeoutMs,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    return [];
  }

  return (response.data?.data || [])
    .filter((model) => model?.id)
    .map((model) => ({
      id: `inferx:${model.id}`,
      object: 'model',
      created: normalizeModelCreated(model.created),
      owned_by: model.owned_by || 'inferx',
      provider: 'inferx',
      provider_model_id: model.id,
      name: model.name || model.id,
      free: null,
      pricing: model.pricing || null,
      context_length: model.context_length || null,
      architecture: model.architecture || null,
      source: 'inferx',
    }));
}

function isOpenRouterFree(model) {
  const pricing = model.pricing || {};
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);

  return model.id.endsWith(':free') || (prompt === 0 && completion === 0);
}

function supportsChatOutput(model, includeMultimodalOutput) {
  const outputs = model.architecture?.output_modalities;
  if (!Array.isArray(outputs)) {
    return true;
  }

  if (includeMultimodalOutput) {
    return outputs.includes('text');
  }

  return outputs.length === 1 && outputs[0] === 'text';
}

function parseDirectModel(publicModelId) {
  if (publicModelId.startsWith('nim:')) {
    const providerModelId = publicModelId.slice('nim:'.length);
    if (providerModelId) {
      return directModel('nim', providerModelId, publicModelId);
    }
  }

  if (publicModelId.startsWith('openrouter:')) {
    const providerModelId = publicModelId.slice('openrouter:'.length);
    if (providerModelId) {
      return directModel('openrouter', providerModelId, publicModelId);
    }
  }

  if (publicModelId.startsWith('chutes:')) {
    const providerModelId = publicModelId.slice('chutes:'.length);
    if (providerModelId) {
      return directModel('chutes', providerModelId, publicModelId);
    }
  }

  if (publicModelId.startsWith('ollama:')) {
    const providerModelId = publicModelId.slice('ollama:'.length);
    if (providerModelId) {
      return directModel('ollama', providerModelId, publicModelId);
    }
  }

  if (publicModelId.startsWith('g4f:')) {
    const providerModelId = publicModelId.slice('g4f:'.length);
    if (providerModelId) {
      return directModel('g4f', providerModelId, publicModelId);
    }
  }

  if (publicModelId.startsWith('tokenrouter:')) {
    const providerModelId = publicModelId.slice('tokenrouter:'.length);
    if (providerModelId) {
      return directModel('tokenrouter', providerModelId, publicModelId);
    }
  }

  if (publicModelId.startsWith('inferx:')) {
    const providerModelId = publicModelId.slice('inferx:'.length);
    if (providerModelId) {
      return directModel('inferx', providerModelId, publicModelId);
    }
  }

  return null;
}

function directModel(provider, providerModelId, publicModelId) {
  return {
    id: publicModelId,
    object: 'model',
    created: 0,
    owned_by: provider,
    provider,
    provider_model_id: providerModelId,
    name: providerModelId,
    free: provider === 'openrouter' ? providerModelId.endsWith(':free') : ['ollama', 'g4f'].includes(provider) ? true : null,
    source: 'direct',
  };
}

function buildOptionalBearerHeaders(apiKey, stream) {
  const headers = {
    Accept: stream ? 'text/event-stream' : 'application/json',
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function buildOpenRouterHeaders(config, stream) {
  const headers = {
    Accept: stream ? 'text/event-stream' : 'application/json',
  };

  if (config.openRouterApiKey) {
    headers.Authorization = `Bearer ${config.openRouterApiKey}`;
  }

  if (config.openRouterAppUrl) {
    headers['HTTP-Referer'] = config.openRouterAppUrl;
  }

  if (config.openRouterAppTitle) {
    headers['X-Title'] = config.openRouterAppTitle;
  }

  return headers;
}

function readCache(cacheFile) {
  try {
    if (!cacheFile || !fs.existsSync(cacheFile)) {
      return { updated_at: null, models: [] };
    }

    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return {
      updated_at: parsed.updated_at || null,
      models: Array.isArray(parsed.models) ? parsed.models : [],
    };
  } catch {
    return { updated_at: null, models: [] };
  }
}

function writeCache(cacheFile, cache) {
  if (!cacheFile) {
    return;
  }

  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
}

function isFresh(cache, ttlMs) {
  if (!cache.updated_at || !Array.isArray(cache.models) || cache.models.length === 0) {
    return false;
  }

  const updatedAt = Date.parse(cache.updated_at);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < ttlMs;
}

function uniqueById(models) {
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

module.exports = {
  buildOptionalBearerHeaders,
  buildOpenRouterHeaders,
  createModelRegistry,
};
