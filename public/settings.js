document.addEventListener('DOMContentLoaded', async () => {
  const settingsForm = document.getElementById('settingsForm');
  const statusDiv = document.getElementById('status');
  const saveBtn = document.getElementById('saveBtn');

  function showStatus(msg, error = false) {
    statusDiv.style.display = 'block';
    statusDiv.textContent = msg;
    statusDiv.style.color = error ? 'var(--danger)' : 'var(--accent-strong)';
    statusDiv.style.borderColor = error ? 'var(--danger)' : 'var(--accent)';
    statusDiv.style.backgroundColor = error ? '#fef2f2' : '#dff5f1';
  }

  try {
    const res = await fetch('/admin/settings');
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const { data } = await res.json();

    // Sort keys alphabetically
    const keys = Object.keys(data).sort();

    for (const key of keys) {
      const label = document.createElement('label');
      label.className = 'field';

      const span = document.createElement('span');
      span.textContent = key;

      const input = document.createElement('input');
      input.type = 'text';
      input.name = key;
      input.value = data[key] || '';

      label.appendChild(span);
      label.appendChild(input);
      settingsForm.appendChild(label);
    }
  } catch (err) {
    showStatus(`Error loading settings: ${err.message}`, true);
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    showStatus('Saving...');

    const formData = new FormData(settingsForm);
    const updates = {};
    for (const [key, value] of formData.entries()) {
      updates[key] = value;
    }

    try {
      const res = await fetch('/admin/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates)
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }
      showStatus('Settings saved successfully!');
    } catch (err) {
      showStatus(`Error saving settings: ${err.message}`, true);
    } finally {
      saveBtn.disabled = false;
    }
  });
});