const elements = {
  apiKeyInput: document.getElementById('apiKeyInput'),
  baseUrlInput: document.getElementById('baseUrlInput'),
  loadModelsBtn: document.getElementById('loadModelsBtn'),
  providersContainer: document.getElementById('providersContainer'),
  configOutput: document.getElementById('configOutput'),
  copyBtn: document.getElementById('copyBtn'),
  statusMessage: document.getElementById('statusMessage'),
};

let allModels = [];
let modelsByProvider = {};

// Initialize
elements.apiKeyInput.value = localStorage.getItem('openai-nim-proxy-key') || '';
const defaultBaseUrl = window.location.origin + '/v1';
elements.baseUrlInput.value = localStorage.getItem('opencode-base-url') || defaultBaseUrl;

elements.loadModelsBtn.addEventListener('click', loadModels);
elements.baseUrlInput.addEventListener('input', () => {
  localStorage.setItem('opencode-base-url', elements.baseUrlInput.value);
  generateConfig();
});

elements.copyBtn.addEventListener('click', () => {
  elements.configOutput.select();
  document.execCommand('copy');
  const originalText = elements.copyBtn.textContent;
  elements.copyBtn.textContent = 'Copied!';
  setTimeout(() => {
    elements.copyBtn.textContent = originalText;
  }, 2000);
});

async function loadModels() {
  const apiKey = elements.apiKeyInput.value;
  localStorage.setItem('openai-nim-proxy-key', apiKey);

  elements.statusMessage.textContent = 'Loading models...';
  elements.providersContainer.innerHTML = '';
  elements.configOutput.value = '';

  try {
    const res = await fetch('/admin/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to load models: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    allModels = data.data || [];

    // Group models by provider
    modelsByProvider = {};
    for (const model of allModels) {
      const provider = model.provider || 'unknown';
      if (!modelsByProvider[provider]) {
        modelsByProvider[provider] = [];
      }
      modelsByProvider[provider].push(model);
    }

    renderProviders();
    elements.statusMessage.textContent = `Loaded ${allModels.length} models across ${Object.keys(modelsByProvider).length} providers.`;
    generateConfig();
  } catch (error) {
    elements.statusMessage.textContent = error.message;
  }
}

function renderProviders() {
  elements.providersContainer.innerHTML = '';

  for (const [provider, models] of Object.entries(modelsByProvider)) {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'provider-group';

    const header = document.createElement('div');
    header.className = 'provider-header';

    const providerCheckbox = document.createElement('input');
    providerCheckbox.type = 'checkbox';
    providerCheckbox.id = `prov_${provider}`;
    providerCheckbox.dataset.provider = provider;
    // Default to unselected so it doesn't dump huge config instantly, except if we want to

    const providerLabel = document.createElement('label');
    providerLabel.htmlFor = `prov_${provider}`;
    providerLabel.textContent = provider.toUpperCase() + ` (${models.length})`;

    header.appendChild(providerCheckbox);
    header.appendChild(providerLabel);
    groupDiv.appendChild(header);

    const listDiv = document.createElement('div');
    listDiv.className = 'model-list';

    // Sort models by name or id
    models.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

    models.forEach(model => {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'model-item';

      const modelCheckbox = document.createElement('input');
      modelCheckbox.type = 'checkbox';
      modelCheckbox.id = `mod_${model.id}`;
      modelCheckbox.className = `model-cb-${provider}`;
      modelCheckbox.dataset.provider = provider;
      modelCheckbox.dataset.modelId = model.id;

      const modelLabel = document.createElement('label');
      modelLabel.htmlFor = `mod_${model.id}`;
      modelLabel.textContent = model.name || model.id;
      modelLabel.title = model.id;

      itemDiv.appendChild(modelCheckbox);
      itemDiv.appendChild(modelLabel);
      listDiv.appendChild(itemDiv);

      modelCheckbox.addEventListener('change', () => {
        updateProviderCheckboxState(provider);
        generateConfig();
      });
    });

    providerCheckbox.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      const modelCheckboxes = listDiv.querySelectorAll(`input.model-cb-${provider}`);
      modelCheckboxes.forEach(cb => cb.checked = isChecked);
      generateConfig();
    });

    groupDiv.appendChild(listDiv);
    elements.providersContainer.appendChild(groupDiv);
  }
}

function updateProviderCheckboxState(provider) {
  const groupCb = document.getElementById(`prov_${provider}`);
  const modelCbs = document.querySelectorAll(`input.model-cb-${provider}`);
  if (!groupCb || modelCbs.length === 0) return;

  const checkedCount = Array.from(modelCbs).filter(cb => cb.checked).length;

  if (checkedCount === 0) {
    groupCb.checked = false;
    groupCb.indeterminate = false;
  } else if (checkedCount === modelCbs.length) {
    groupCb.checked = true;
    groupCb.indeterminate = false;
  } else {
    groupCb.checked = false;
    groupCb.indeterminate = true;
  }
}

function generateConfig() {
  const baseUrl = elements.baseUrlInput.value.trim();
  const config = {
    "$schema": "https://opencode.ai/config.json",
    "disabled_providers": [],
    "provider": {}
  };

  for (const [provider, models] of Object.entries(modelsByProvider)) {
    const selectedModelsForProvider = models.filter(m => {
      const cb = document.getElementById(`mod_${m.id}`);
      return cb && cb.checked;
    });

    if (selectedModelsForProvider.length > 0) {
      const providerConfig = {
        name: provider,
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: baseUrl
        },
        models: {}
      };

      selectedModelsForProvider.forEach(model => {
        const modelConfig = {
          name: model.name || model.id,
          id: model.id,
          family: provider, // Using provider as a fallback family
          status: "active",
          reasoning: true, // Assuming proxy handles this transparently
          tool_call: true, // Supported by proxy
          temperature: true,
          attachment: false,
          interleaved: true,
          limit: {
            context: model.context_length || 1048576,
            output: 131072 // Default max output if unknown
          },
          cost: {
            input: model.pricing?.prompt ? parseFloat(model.pricing.prompt) : 0,
            output: model.pricing?.completion ? parseFloat(model.pricing.completion) : 0,
            cache_read: 0
          },
          modalities: {
            input: ["text"],
            output: ["text"]
          }
        };

        // Determine input modalities
        if (model.architecture?.input_modalities) {
          modelConfig.modalities.input = model.architecture.input_modalities;
        } else if (model.name && model.name.toLowerCase().includes('vision')) {
           modelConfig.modalities.input = ["text", "image"];
        }

        // Output modalities
        if (model.architecture?.output_modalities) {
          modelConfig.modalities.output = model.architecture.output_modalities;
        }

        providerConfig.models[model.id] = modelConfig;
      });

      config.provider[provider] = providerConfig;
    }
  }

  elements.configOutput.value = JSON.stringify(config, null, 2);
}