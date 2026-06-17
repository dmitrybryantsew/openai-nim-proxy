const state = {
  apiKey: localStorage.getItem('openai-nim-proxy-key') || '',
  providers: [],
  busy: false,
};

const elements = {
  form: document.getElementById('ttsForm'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  saveKeyButton: document.getElementById('saveKeyButton'),
  providerSelect: document.getElementById('providerSelect'),
  modelInput: document.getElementById('modelInput'),
  modelPresets: document.getElementById('modelPresets'),
  voiceInput: document.getElementById('voiceInput'),
  formatSelect: document.getElementById('formatSelect'),
  speedInput: document.getElementById('speedInput'),
  warmupInput: document.getElementById('warmupInput'),
  repeatInput: document.getElementById('repeatInput'),
  textInput: document.getElementById('textInput'),
  runButton: document.getElementById('runButton'),
  status: document.getElementById('status'),
  providers: document.getElementById('providers'),
  results: document.getElementById('results'),
};

elements.apiKeyInput.value = state.apiKey;
elements.saveKeyButton.addEventListener('click', () => {
  state.apiKey = elements.apiKeyInput.value.trim();
  localStorage.setItem('openai-nim-proxy-key', state.apiKey);
  loadProviders();
});
elements.providerSelect.addEventListener('change', renderModelPresets);
elements.form.addEventListener('submit', runBenchmark);

if (state.apiKey) {
  loadProviders();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      message = data.error?.message || message;
    } catch {
      // Keep HTTP status text.
    }
    throw new Error(message);
  }

  return response.json();
}

async function loadProviders() {
  if (!state.apiKey) {
    setStatus('Save proxy key first.');
    return;
  }

  setStatus('Checking TTS providers...');
  try {
    const data = await api('/api/tts/providers');
    state.providers = data.data || [];
    renderProviders(data.data || []);
    renderProviderOptions();
    renderModelPresets();
    setStatus('Provider status loaded.');
  } catch (error) {
    setStatus(`Provider check failed: ${error.message}`);
  }
}

async function runBenchmark(event) {
  event.preventDefault();
  if (state.busy) {
    return;
  }
  if (!state.apiKey) {
    setStatus('Save proxy key first.');
    return;
  }

  state.busy = true;
  elements.runButton.disabled = true;
  elements.results.innerHTML = '';
  setStatus('Generating audio...');

  const selectedProvider = elements.providerSelect.value;
  const providers = selectedProvider === 'all'
    ? state.providers.map((provider) => provider.id)
    : [selectedProvider];
  const model = elements.modelInput.value.trim();
  const models = {};
  if (model && selectedProvider === 'all') {
    models.kittentts = model;
  }

  try {
    const data = await api('/api/tts/benchmark', {
      method: 'POST',
      body: JSON.stringify({
        providers,
        input: elements.textInput.value,
        voice: elements.voiceInput.value.trim() || undefined,
        model: selectedProvider === 'all' ? undefined : model || undefined,
        models,
        response_format: elements.formatSelect.value,
        speed: Number(elements.speedInput.value) || 1,
        warmup: Math.max(0, Math.round(Number(elements.warmupInput.value) || 0)),
        repeat: Math.max(1, Math.round(Number(elements.repeatInput.value) || 1)),
      }),
    });
    renderResults(data.data || []);
    setStatus('Benchmark complete.');
  } catch (error) {
    setStatus(`Benchmark failed: ${error.message}`);
  } finally {
    state.busy = false;
    elements.runButton.disabled = false;
  }
}

function renderModelPresets() {
  const selectedProvider = elements.providerSelect.value;
  const provider = (state.providers || []).find((item) => item.id === selectedProvider)
    || (state.providers || []).find((item) => item.id === 'kittentts');
  const models = provider?.models || [];

  elements.modelPresets.innerHTML = '';
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    elements.modelPresets.appendChild(option);
  }

  elements.modelInput.placeholder = provider?.default_model || 'Provider default';
}

function renderProviderOptions() {
  const currentValue = elements.providerSelect.value;
  elements.providerSelect.innerHTML = '';

  if (state.providers.length > 1) {
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'Compare all';
    elements.providerSelect.appendChild(allOption);
  }

  for (const provider of state.providers) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.name || provider.id;
    elements.providerSelect.appendChild(option);
  }

  const hasCurrent = Array.from(elements.providerSelect.options)
    .some((option) => option.value === currentValue);
  elements.providerSelect.value = hasCurrent
    ? currentValue
    : (elements.providerSelect.options[0]?.value || '');
}

function renderProviders(providers) {
  elements.providers.innerHTML = '';
  for (const provider of providers) {
    const item = document.createElement('article');
    item.className = `tts-card ${provider.ready ? 'ready' : 'not-ready'}`;

    const title = document.createElement('strong');
    title.textContent = `${provider.name} ${provider.ready ? 'ready' : 'not ready'}`;

    const detail = document.createElement('span');
    detail.textContent = provider.type === 'http'
      ? provider.api_base
      : `${provider.binary} | ${provider.model}`;

    item.append(title, detail);
    elements.providers.appendChild(item);
  }
}

function renderResults(results) {
  elements.results.innerHTML = '';
  for (const result of results) {
    const item = document.createElement('article');
    item.className = `tts-card ${result.ok ? 'ready' : 'not-ready'}`;

    const title = document.createElement('strong');
    title.textContent = result.provider;
    item.appendChild(title);

    const stats = document.createElement('span');
    stats.textContent = result.ok
      ? `avg ${result.avg_elapsed_ms || result.elapsed_ms}ms | min ${result.min_elapsed_ms || result.elapsed_ms}ms | max ${result.max_elapsed_ms || result.elapsed_ms}ms | ${result.chars_per_second} chars/s | ${result.bytes} bytes`
      : result.error;
    item.appendChild(stats);

    if (result.ok && result.audio_base64) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = `data:${result.content_type};base64,${result.audio_base64}`;
      item.appendChild(audio);
    }

    elements.results.appendChild(item);
  }
}

function setStatus(text) {
  elements.status.textContent = text;
}
