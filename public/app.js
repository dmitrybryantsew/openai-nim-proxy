const state = {
  apiKey: localStorage.getItem('openai-nim-proxy-key') || '',
  chats: [],
  models: [],
  activeChatId: null,
  activeFilter: 'all',
  hiddenProviders: loadHiddenProviders(),
  busy: false,
  requestSettings: loadRequestSettings(),
};

const PROVIDER_LABELS = {
  nim: 'NIM',
  chutes: 'Chutes',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  g4f: 'G4F',
};

function loadHiddenProviders() {
  try {
    const raw = localStorage.getItem('openai-nim-proxy-hidden-providers');
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function saveHiddenProviders() {
  localStorage.setItem(
    'openai-nim-proxy-hidden-providers',
    JSON.stringify([...state.hiddenProviders]),
  );
}

const elements = {
  apiKeyInput: document.getElementById('apiKeyInput'),
  saveKeyButton: document.getElementById('saveKeyButton'),
  refreshModelsButton: document.getElementById('refreshModelsButton'),
  newChatButton: document.getElementById('newChatButton'),
  deleteChatButton: document.getElementById('deleteChatButton'),
  modelSelect: document.getElementById('modelSelect'),
  temperatureInput: document.getElementById('temperatureInput'),
  maxTokensInput: document.getElementById('maxTokensInput'),
  topPInput: document.getElementById('topPInput'),
  presencePenaltyInput: document.getElementById('presencePenaltyInput'),
  frequencyPenaltyInput: document.getElementById('frequencyPenaltyInput'),
  chatList: document.getElementById('chatList'),
  status: document.getElementById('status'),
  chatTitle: document.getElementById('chatTitle'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  messageInput: document.getElementById('messageInput'),
  sendButton: document.getElementById('sendButton'),
  filters: Array.from(document.querySelectorAll('.filter')),
  providerChips: document.getElementById('providerChips'),
};

elements.apiKeyInput.value = state.apiKey;
elements.temperatureInput.value = state.requestSettings.temperature;
elements.maxTokensInput.value = state.requestSettings.max_tokens;
elements.topPInput.value = state.requestSettings.top_p;
elements.presencePenaltyInput.value = state.requestSettings.presence_penalty;
elements.frequencyPenaltyInput.value = state.requestSettings.frequency_penalty;

elements.saveKeyButton.addEventListener('click', async () => {
  state.apiKey = elements.apiKeyInput.value.trim();
  localStorage.setItem('openai-nim-proxy-key', state.apiKey);
  await bootstrap();
});

elements.refreshModelsButton.addEventListener('click', () => loadModels(true));
elements.newChatButton.addEventListener('click', createChat);
elements.deleteChatButton.addEventListener('click', deleteActiveChat);
elements.modelSelect.addEventListener('change', saveActiveChatModel);
elements.chatTitle.addEventListener('change', saveActiveChatTitle);
elements.composer.addEventListener('submit', sendMessage);
elements.messageInput.addEventListener('input', resizeComposer);
for (const input of [
  elements.temperatureInput,
  elements.maxTokensInput,
  elements.topPInput,
  elements.presencePenaltyInput,
  elements.frequencyPenaltyInput,
]) {
  input.addEventListener('change', saveRequestSettings);
}
elements.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

for (const button of elements.filters) {
  button.addEventListener('click', () => {
    state.activeFilter = button.dataset.filter;
    for (const item of elements.filters) {
      item.classList.toggle('active', item === button);
    }
    renderModels();
  });
}

bootstrap();

async function bootstrap() {
  if (!state.apiKey) {
    renderEmpty('Enter your proxy key, then load chats.');
    return;
  }

  await Promise.all([
    loadModels(false),
    loadChats(),
  ]);

  if (state.chats.length > 0) {
    await openChat(state.chats[0].id);
  } else {
    renderEmpty('Create a chat to start.');
  }
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
      // Keep the HTTP status message.
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function loadModels(forceRefresh) {
  setStatus(forceRefresh ? 'Refreshing models...' : 'Loading models...');
  try {
    const data = await api(`/v1/models${forceRefresh ? '?refresh=true' : ''}`);
    state.models = data.data || [];
    renderModels();
    setStatus(`Loaded ${state.models.length} models.`);
  } catch (error) {
    setStatus(`Models failed: ${error.message}`);
  }
}

async function loadChats() {
  try {
    const data = await api('/api/chats');
    state.chats = data.data || [];
    renderChatList();
  } catch (error) {
    setStatus(`Chats failed: ${error.message}`);
  }
}

async function createChat() {
  if (!state.apiKey) {
    setStatus('Save proxy key first.');
    return;
  }

  const model = elements.modelSelect.value || state.models[0]?.id || null;
  const data = await api('/api/chats', {
    method: 'POST',
    body: JSON.stringify({ title: 'New chat', model }),
  });

  await loadChats();
  await openChat(data.data.id);
}

async function openChat(chatId) {
  const data = await api(`/api/chats/${chatId}`);
  state.activeChatId = data.data.id;
  elements.chatTitle.value = data.data.title || 'New chat';
  if (data.data.model) {
    elements.modelSelect.value = data.data.model;
  }
  renderChatList();
  renderMessages(data.data.messages || []);
}

async function deleteActiveChat() {
  if (!state.activeChatId) {
    return;
  }

  await api(`/api/chats/${state.activeChatId}`, { method: 'DELETE' });
  state.activeChatId = null;
  await loadChats();

  if (state.chats.length > 0) {
    await openChat(state.chats[0].id);
  } else {
    elements.chatTitle.value = 'New chat';
    renderEmpty('Create a chat to start.');
  }
}

async function saveActiveChatTitle() {
  if (!state.activeChatId) {
    return;
  }

  await api(`/api/chats/${state.activeChatId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: elements.chatTitle.value.trim() || 'New chat' }),
  });
  await loadChats();
}

async function saveActiveChatModel() {
  if (!state.activeChatId) {
    return;
  }

  await api(`/api/chats/${state.activeChatId}`, {
    method: 'PATCH',
    body: JSON.stringify({ model: elements.modelSelect.value }),
  });
  await loadChats();
}

async function sendMessage(event) {
  event.preventDefault();
  const content = elements.messageInput.value.trim();
  const model = elements.modelSelect.value;

  if (!content || state.busy) {
    return;
  }

  if (!state.activeChatId) {
    await createChat();
  }

  if (!model) {
    setStatus('Pick a model first.');
    return;
  }

  state.busy = true;
  elements.sendButton.disabled = true;
  elements.messageInput.value = '';
  resizeComposer();
  appendLocalMessage('user', content);
  appendLocalMessage('assistant', 'Thinking...');

  try {
    const data = await api(`/api/chats/${state.activeChatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        model,
        ...state.requestSettings,
      }),
    });
    renderMessages(data.data.chat.messages || []);
    elements.chatTitle.value = data.data.chat.title || 'New chat';
    await loadChats();
    setStatus('Message saved.');
  } catch (error) {
    removeThinkingMessage();
    appendLocalMessage('assistant', `Request failed: ${error.message}`);
    setStatus(`Send failed: ${error.message}`);
  } finally {
    state.busy = false;
    elements.sendButton.disabled = false;
    elements.messageInput.focus();
  }
}

function renderModels() {
  const models = state.models.filter((model) => {
    if (state.hiddenProviders.has(model.provider)) {
      return false;
    }

    if (state.activeFilter === 'text') {
      return isTextOnly(model);
    }

    if (state.activeFilter === 'multimodal') {
      return !isTextOnly(model);
    }

    return true;
  });

  renderProviderChips();

  const current = elements.modelSelect.value;
  elements.modelSelect.innerHTML = '';

  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    const tags = [];
    if (model.experimental) tags.push('experimental');
    if (model.healthy === false) tags.push('unhealthy');
    const tagSuffix = tags.length ? ` [${tags.join(', ')}]` : '';
    option.textContent = `${model.id}${model.free ? ' free' : ''}${tagSuffix}`;
    elements.modelSelect.appendChild(option);
  }

  if (models.some((model) => model.id === current)) {
    elements.modelSelect.value = current;
  }
}

function renderProviderChips() {
  if (!elements.providerChips) return;

  const counts = new Map();
  for (const model of state.models) {
    counts.set(model.provider, (counts.get(model.provider) || 0) + 1);
  }

  const providers = [...counts.keys()].sort();
  elements.providerChips.innerHTML = '';

  if (providers.length === 0) {
    elements.providerChips.style.display = 'none';
    return;
  }

  elements.providerChips.style.display = '';

  for (const provider of providers) {
    const label = PROVIDER_LABELS[provider] || provider;
    const count = counts.get(provider);
    const hidden = state.hiddenProviders.has(provider);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `provider-chip${hidden ? ' off' : ''}`;
    chip.dataset.provider = provider;
    chip.title = hidden ? `Show ${label} models` : `Hide ${label} models`;
    chip.textContent = hidden ? `${label} (${count})` : `${label} (${count})`;
    if (hidden) {
      chip.style.opacity = '0.45';
      chip.style.textDecoration = 'line-through';
    }
    chip.addEventListener('click', () => {
      if (state.hiddenProviders.has(provider)) {
        state.hiddenProviders.delete(provider);
      } else {
        state.hiddenProviders.add(provider);
      }
      saveHiddenProviders();
      renderModels();
    });
    elements.providerChips.appendChild(chip);
  }
}

function renderChatList() {
  elements.chatList.innerHTML = '';

  for (const chat of state.chats) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = chat.id === state.activeChatId ? 'active' : '';
    button.addEventListener('click', () => openChat(chat.id));

    const title = document.createElement('strong');
    title.textContent = chat.title || 'New chat';

    const summary = document.createElement('span');
    summary.textContent = chat.last_message || chat.model || 'No messages';

    button.append(title, summary);
    elements.chatList.appendChild(button);
  }
}

function renderMessages(messages) {
  elements.messages.innerHTML = '';

  if (messages.length === 0) {
    renderEmpty('No messages yet.');
    return;
  }

  for (const message of messages) {
    appendLocalMessage(message.role, message.content, message);
  }

  scrollMessages();
}

function renderEmpty(text) {
  elements.messages.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = text;
  elements.messages.appendChild(empty);
}

function appendLocalMessage(role, content, metadata = {}) {
  const wrapper = document.createElement('article');
  wrapper.className = `message ${role}`;

  const label = document.createElement('div');
  label.className = 'message-role';
  label.textContent = role;

  let displayContent = content;
  let thinkingContent = null;

  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    thinkingContent = thinkMatch[1].trim();
    displayContent = content.replace(/<think>[\s\S]*?<\/think>\n*/, '').trim();
  }

  const body = document.createElement('div');
  body.className = 'message-content';

  if (thinkingContent) {
    const details = document.createElement('details');
    details.className = 'thinking-block';
    const summary = document.createElement('summary');
    summary.textContent = 'Thinking...';
    const thinkBody = document.createElement('div');
    thinkBody.textContent = thinkingContent;
    details.append(summary, thinkBody);
    body.appendChild(details);
  }

  const mainContent = document.createElement('div');
  mainContent.className = 'main-content';
  mainContent.textContent = displayContent;
  body.appendChild(mainContent);

  wrapper.append(label, body);

  const footerText = formatMessageFooter(metadata);
  const actions = document.createElement('div');
  actions.className = 'message-actions';

  const copyButton = document.createElement('button');
  copyButton.textContent = 'Copy';
  copyButton.className = 'action-btn secondary';
  copyButton.addEventListener('click', () => {
    navigator.clipboard.writeText(content).catch(() => {});
  });
  actions.appendChild(copyButton);

  if (metadata.id) {
    const deleteButton = document.createElement('button');
    deleteButton.textContent = 'Delete';
    deleteButton.className = 'action-btn secondary danger';
    deleteButton.addEventListener('click', async () => {
      try {
        await api(`/api/chats/${state.activeChatId}/messages/${metadata.id}`, { method: 'DELETE' });
        await openChat(state.activeChatId);
      } catch (e) {
        setStatus(`Delete failed: ${e.message}`);
      }
    });
    actions.appendChild(deleteButton);

    if (role === 'assistant') {
      const regenButton = document.createElement('button');
      regenButton.textContent = 'Regenerate';
      regenButton.className = 'action-btn secondary';
      regenButton.addEventListener('click', async () => {
        try {
          await api(`/api/chats/${state.activeChatId}/messages/${metadata.id}`, { method: 'DELETE' });
          await generateMessage();
        } catch (e) {
          setStatus(`Regenerate failed: ${e.message}`);
        }
      });
      actions.appendChild(regenButton);
    }
  }

  if (footerText || actions.hasChildNodes()) {
    const footer = document.createElement('div');
    footer.className = 'message-footer';
    if (footerText) {
      const footerTextEl = document.createElement('span');
      footerTextEl.textContent = footerText;
      footer.appendChild(footerTextEl);
    }
    footer.appendChild(actions);
    wrapper.appendChild(footer);
  }

  elements.messages.appendChild(wrapper);
  scrollMessages();
}

async function generateMessage() {
  if (state.busy) return;
  state.busy = true;
  elements.sendButton.disabled = true;

  const model = elements.modelSelect.value;
  appendLocalMessage('assistant', 'Thinking...');

  try {
    const data = await api(`/api/chats/${state.activeChatId}/generate`, {
      method: 'POST',
      body: JSON.stringify({
        model,
        ...state.requestSettings,
      }),
    });
    renderMessages(data.data.messages || []);
    await loadChats();
    setStatus('Message regenerated.');
  } catch (error) {
    removeThinkingMessage();
    appendLocalMessage('assistant', `Request failed: ${error.message}`);
    setStatus(`Generate failed: ${error.message}`);
  } finally {
    state.busy = false;
    elements.sendButton.disabled = false;
  }
}

function formatMessageFooter(message) {
  if (!message.provider && !message.model) {
    return '';
  }

  const parts = [];
  if (message.provider) {
    parts.push(`provider: ${message.provider}`);
  }

  if (message.provider_model_id) {
    parts.push(`provider model: ${message.provider_model_id}`);
  } else if (message.model) {
    parts.push(`model: ${message.model}`);
  }

  if (message.created_at) {
    parts.push(new Date(message.created_at).toLocaleString());
  }

  return parts.join(' | ');
}

function removeThinkingMessage() {
  const messages = Array.from(elements.messages.querySelectorAll('.message.assistant'));
  const last = messages[messages.length - 1];
  if (last?.textContent.includes('Thinking...')) {
    last.remove();
  }
}

function resizeComposer() {
  elements.messageInput.style.height = 'auto';
  elements.messageInput.style.height = `${elements.messageInput.scrollHeight}px`;
}

function scrollMessages() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function setStatus(text) {
  elements.status.textContent = text;
}

function loadRequestSettings() {
  const defaults = {
    temperature: 0.7,
    max_tokens: 4096,
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
  };

  try {
    return {
      ...defaults,
      ...JSON.parse(localStorage.getItem('openai-nim-proxy-request-settings') || '{}'),
    };
  } catch {
    return defaults;
  }
}

function saveRequestSettings() {
  state.requestSettings = {
    temperature: clampNumber(elements.temperatureInput.value, 0, 2, 0.7),
    max_tokens: Math.max(1, Math.round(clampNumber(elements.maxTokensInput.value, 1, Number.MAX_SAFE_INTEGER, 4096))),
    top_p: clampNumber(elements.topPInput.value, 0, 1, 1),
    presence_penalty: clampNumber(elements.presencePenaltyInput.value, -2, 2, 0),
    frequency_penalty: clampNumber(elements.frequencyPenaltyInput.value, -2, 2, 0),
  };

  elements.temperatureInput.value = state.requestSettings.temperature;
  elements.maxTokensInput.value = state.requestSettings.max_tokens;
  elements.topPInput.value = state.requestSettings.top_p;
  elements.presencePenaltyInput.value = state.requestSettings.presence_penalty;
  elements.frequencyPenaltyInput.value = state.requestSettings.frequency_penalty;
  localStorage.setItem('openai-nim-proxy-request-settings', JSON.stringify(state.requestSettings));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function isTextOnly(model) {
  const input = model.modalities?.input;
  const output = model.modalities?.output;

  if (Array.isArray(input) && !(input.length === 1 && input[0] === 'text')) {
    return false;
  }

  if (Array.isArray(output) && !(output.length === 1 && output[0] === 'text')) {
    return false;
  }

  return !model.id.includes('omni');
}
