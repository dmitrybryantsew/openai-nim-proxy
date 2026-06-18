const state = {
  apiKey: localStorage.getItem('openai-nim-proxy-key') || '',
  models: [],
  busy: false,
};

const elements = {
  form: document.getElementById('g4fForm'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  saveKeyButton: document.getElementById('saveKeyButton'),
  refreshButton: document.getElementById('refreshButton'),
  modelInput: document.getElementById('modelInput'),
  modelList: document.getElementById('modelList'),
  chatPromptInput: document.getElementById('chatPromptInput'),
  chatButton: document.getElementById('chatButton'),
  imagePromptInput: document.getElementById('imagePromptInput'),
  imageModelInput: document.getElementById('imageModelInput'),
  imageSizeInput: document.getElementById('imageSizeInput'),
  imageButton: document.getElementById('imageButton'),
  status: document.getElementById('status'),
  sitePanel: document.getElementById('sitePanel'),
  models: document.getElementById('models'),
  results: document.getElementById('results'),
};

elements.apiKeyInput.value = state.apiKey;
elements.saveKeyButton.addEventListener('click', () => {
  state.apiKey = elements.apiKeyInput.value.trim();
  localStorage.setItem('openai-nim-proxy-key', state.apiKey);
  loadStatus();
});
elements.refreshButton.addEventListener('click', loadStatus);
elements.chatButton.addEventListener('click', testChat);
elements.imageButton.addEventListener('click', generateImage);
elements.form.addEventListener('submit', (event) => event.preventDefault());

if (state.apiKey) {
  loadStatus();
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

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Some upstream failures can return non-JSON bodies.
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || `${response.status} ${response.statusText}`);
  }

  return data;
}

async function loadStatus() {
  if (!state.apiKey) {
    setStatus('Save proxy key first.');
    return;
  }

  setBusy(true);
  setStatus('Checking G4F sidecar...');
  try {
    const data = await api('/api/g4f/status');
    const status = data.data || {};
    state.models = status.models || [];
    renderStatus(status);
    renderModels();
    setStatus(status.ready ? 'G4F sidecar is ready.' : `G4F sidecar not ready: ${status.error || 'unknown'}`);
  } catch (error) {
    setStatus(`G4F status failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function testChat() {
  if (!state.apiKey || state.busy) {
    return;
  }

  setBusy(true);
  setStatus('Testing chat...');
  elements.results.innerHTML = '';

  try {
    const model = elements.modelInput.value.trim() || state.models[0]?.id || 'g4f:gpt-4o-mini';
    const data = await api('/api/g4f/chat', {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: elements.chatPromptInput.value.trim() || 'Reply with exactly: ok' }],
      }),
    });

    const content = data?.choices?.[0]?.message?.content || JSON.stringify(data, null, 2);
    renderTextResult('Chat result', content);
    setStatus('Chat test complete.');
  } catch (error) {
    setStatus(`Chat test failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function generateImage() {
  if (!state.apiKey || state.busy) {
    return;
  }

  setBusy(true);
  setStatus('Generating image...');
  elements.results.innerHTML = '';

  try {
    const data = await api('/api/g4f/images', {
      method: 'POST',
      body: JSON.stringify({
        model: elements.imageModelInput.value.trim() || undefined,
        prompt: elements.imagePromptInput.value.trim(),
        size: elements.imageSizeInput.value.trim() || undefined,
        response_format: 'b64_json',
      }),
    });

    renderImageResult(data);
    setStatus('Image request complete.');
  } catch (error) {
    setStatus(`Image generation failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function renderStatus(status) {
  elements.sitePanel.innerHTML = '';
  const card = document.createElement('article');
  card.className = `tts-card ${status.ready ? 'ready' : 'not-ready'}`;

  const title = document.createElement('strong');
  title.textContent = status.enabled ? 'G4F enabled' : 'G4F disabled';

  const api = document.createElement('span');
  api.textContent = status.api_base || 'No API base configured';

  card.append(title, api);

  const serverUrl = document.createElement('span');
  serverUrl.textContent = `Web UI: ${status.web_public_url || status.web_url || 'not configured'}`;
  card.appendChild(serverUrl);

  if (state.apiKey) {
    const proxiedLink = document.createElement('a');
    proxiedLink.className = 'nav-link';
    proxiedLink.href = `/g4f-site/?key=${encodeURIComponent(state.apiKey)}`;
    proxiedLink.target = '_blank';
    proxiedLink.rel = 'noreferrer';
    proxiedLink.textContent = 'Open proxied G4F site';
    card.appendChild(proxiedLink);
  }

  if (status.web_public_url) {
    const link = document.createElement('a');
    link.className = 'nav-link';
    link.href = status.web_public_url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Open G4F site';
    card.appendChild(link);
  }

  elements.sitePanel.appendChild(card);
}

function renderModels() {
  elements.modelList.innerHTML = '';
  elements.models.innerHTML = '';

  for (const model of state.models) {
    const option = document.createElement('option');
    option.value = model.id;
    elements.modelList.appendChild(option);

    const item = document.createElement('article');
    item.className = 'tts-card ready';
    const title = document.createElement('strong');
    title.textContent = model.id;
    const detail = document.createElement('span');
    detail.textContent = model.provider_model_id || model.name || '';
    item.append(title, detail);
    elements.models.appendChild(item);
  }

  if (!elements.modelInput.value && state.models[0]) {
    elements.modelInput.value = state.models[0].id;
  }
}

function renderTextResult(titleText, content) {
  const item = document.createElement('article');
  item.className = 'tts-card ready';
  const title = document.createElement('strong');
  title.textContent = titleText;
  const body = document.createElement('pre');
  body.className = 'result-pre';
  body.textContent = content;
  item.append(title, body);
  elements.results.appendChild(item);
}

function renderImageResult(data) {
  const images = data?.data || [];
  if (images.length === 0) {
    renderTextResult('Image result', JSON.stringify(data, null, 2));
    return;
  }

  for (const image of images) {
    const item = document.createElement('article');
    item.className = 'tts-card ready';
    const title = document.createElement('strong');
    title.textContent = 'Image result';
    const img = document.createElement('img');
    img.className = 'generated-image';
    img.alt = image.revised_prompt || elements.imagePromptInput.value.trim() || 'Generated image';
    img.src = image.b64_json
      ? `data:image/png;base64,${image.b64_json}`
      : image.url;
    item.append(title, img);
    elements.results.appendChild(item);
  }
}

function setBusy(value) {
  state.busy = value;
  elements.refreshButton.disabled = value;
  elements.chatButton.disabled = value;
  elements.imageButton.disabled = value;
}

function setStatus(text) {
  elements.status.textContent = text;
}
