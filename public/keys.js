document.addEventListener('DOMContentLoaded', async () => {
  const grid = document.getElementById('keysGrid');
  const statusDiv = document.getElementById('status');

  function showStatus(msg, isError = false) {
    statusDiv.style.display = 'block';
    statusDiv.textContent = msg;
    statusDiv.style.borderColor = isError ? '#ef4444' : '#22c55e';
    statusDiv.style.color = isError ? '#f87171' : '#22c55e';
    if (!isError) setTimeout(() => { statusDiv.style.display = 'none'; }, 4000);
  }

  async function fetchKeys() {
    const res = await fetch('/admin/keys');
    if (res.status === 403) {
      grid.innerHTML = `
        <div class="no-access">
          <h2>Admin access required</h2>
          <p>Sign in with Google as an admin user to manage provider keys.</p>
          <a href="/auth/google" class="button">Sign in with Google</a>
        </div>`;
      return null;
    }
    if (!res.ok) throw new Error(await res.text());
    const { data } = await res.json();
    return data;
  }

  function formatMs(ms) {
    if (!ms || ms <= 0) return '';
    if (ms < 60000) return Math.ceil(ms / 1000) + 's';
    return Math.ceil(ms / 60000) + 'm';
  }

  function render(data) {
    grid.innerHTML = Object.entries(data).map(([name, p]) => {
      const poolKeys = (p.keys || []).map((k) => {
        const status = k.available
          ? '<span style="color:#4ade80">available</span>'
          : `<span style="color:#fbbf24">cooling ${formatMs(k.cooldown_remaining_ms)}</span>`;
        const stats = [
          k.total_requests > 0 ? `${k.total_requests} req` : '',
          k.total_failures > 0 ? `${k.total_failures} fail` : '',
          k.consecutive_failures > 0 ? `${k.consecutive_failures}x streak` : '',
        ].filter(Boolean).join(' · ');
        return `<div class="key-item">
          <span class="masked" title="${escapeHtml(k.label)}">${escapeHtml(k.masked)}</span>
          <span class="meta">${status}${stats ? ' · ' + escapeHtml(stats) : ''}</span>
          <button class="remove-btn" data-provider="${name}" data-index="${k.index}" title="Remove key">✕</button>
        </div>`;
      }).join('');

      const hasKeys = (p.keys || []).length > 0;
      const statsHtml = hasKeys
        ? `<span style="color:#4ade80">${p.pool.available} available</span><span style="color:#fbbf24">${p.pool.cooling} cooling</span><span>${p.pool.total_keys} total</span>`
        : '<span>no keys configured</span>';

      return `<div class="key-card" data-provider="${name}">
        <div class="key-card-head">
          <h2>${escapeHtml(p.label)}</h2>
          <span class="api-base">${escapeHtml(p.api_base || '')}</span>
        </div>
        <div class="pool-stats">${statsHtml}</div>
        <div class="key-list">${hasKeys ? poolKeys : '<div class="empty">No keys. Add one below.</div>'}</div>
        <div class="key-add-row">
          <input type="text" placeholder="Paste new key…" data-provider="${name}" class="new-key-input" autocomplete="off">
          <button data-provider="${name}" class="add-btn">Add</button>
        </div>
        <div class="hint">Multiple keys rotate round-robin with cooldown on 429/403. Removing all keys disables the provider.</div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.add-btn').forEach((btn) => {
      btn.addEventListener('click', () => addKey(btn.dataset.provider));
    });
    grid.querySelectorAll('.new-key-input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addKey(input.dataset.provider);
      });
    });
    grid.querySelectorAll('.remove-btn').forEach((btn) => {
      btn.addEventListener('click', () => removeKey(btn.dataset.provider, Number(btn.dataset.index)));
    });
  }

  async function post(body) {
    const res = await fetch('/admin/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `${res.status} ${res.statusText}`);
    return data;
  }

  async function addKey(provider) {
    const card = grid.querySelector(`.key-card[data-provider="${provider}"]`);
    const input = card.querySelector('.new-key-input');
    const raw = input.value.trim();
    if (!raw) return showStatus('Paste a key first.', true);

    try {
      const result = await post({ provider, action: 'add', keys: [raw] });
      input.value = '';
      showStatus(result.message || 'Key added.');
      await load();
    } catch (err) {
      showStatus(`Add failed: ${err.message}`, true);
    }
  }

  async function removeKey(provider, index) {
    if (!confirm('Remove this key from the rotation pool?')) return;
    try {
      const result = await post({ provider, action: 'remove', index });
      showStatus(result.message || 'Key removed.');
      await load();
    } catch (err) {
      showStatus(`Remove failed: ${err.message}`, true);
    }
  }

  async function load() {
    try {
      const data = await fetchKeys();
      if (data) render(data);
    } catch (err) {
      grid.innerHTML = `<div class="empty" style="color:#fbbf24">${escapeHtml(err.message)}</div>`;
    }
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  await load();
});
