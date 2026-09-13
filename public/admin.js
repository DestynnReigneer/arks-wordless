(function() {
  const TOKEN_KEY = 'wordless_admin_token';

  const lockScreen = document.getElementById('lockScreen');
  const adminContent = document.getElementById('adminContent');
  const tokenInput = document.getElementById('tokenInput');
  const unlockBtn = document.getElementById('unlockBtn');
  const lockError = document.getElementById('lockError');
  const lockBtn = document.getElementById('lockBtn');

  const requestsList = document.getElementById('requestsList');
  const themesList = document.getElementById('themesList');
  const jsonInput = document.getElementById('jsonInput');
  const createFromJsonBtn = document.getElementById('createFromJsonBtn');
  const jsonStatus = document.getElementById('jsonStatus');

  let token = '';

  function buildPrompt(topic) {
    return `Create a word-guessing game "theme pack" for the topic: ${topic}.

Return ONLY a single valid JSON object (no markdown, no code fences, no commentary) with exactly these fields:

{
  "label": "Short display name for the theme",
  "subject": "Short description of what the words are, e.g. '${topic} character or thing'",
  "emoji": "one emoji that fits the theme",
  "accent": "#hexcolor - a bright accent color fitting the theme",
  "bg": "#hexcolor - a dark background color fitting the theme",
  "fontKey": "one of: sans, serif, comic, mono, fantasy",
  "words": ["at least 15 lowercase words or names related to ${topic}, each using only letters a-z, 3 to 10 letters long, no spaces, no punctuation, no numbers"]
}`;
  }

  async function apiGet(url) {
    const res = await fetch(url, { headers: { 'X-Admin-Token': token } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
      body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  async function apiDelete(url) {
    const res = await fetch(url, { method: 'DELETE', headers: { 'X-Admin-Token': token } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function loadRequests() {
    const requests = await apiGet('/api/theme-requests?status=pending');
    requestsList.innerHTML = '';
    if (requests.length === 0) {
      requestsList.innerHTML = '<div class="empty-note">No pending requests.</div>';
      return;
    }
    requests.forEach(r => {
      const card = document.createElement('div');
      card.className = 'req-card';
      card.innerHTML = `
        <div class="req-top">
          <div class="req-topic">${escapeHtml(r.topic)}</div>
          <div class="req-meta">${escapeHtml(r.createdAt)}${r.requestedBy ? ' · from ' + escapeHtml(r.requestedBy) : ''}</div>
        </div>
        ${r.note ? `<div class="req-note">"${escapeHtml(r.note)}"</div>` : ''}
        <div class="req-actions">
          <button data-action="copy">📋 Copy Prompt</button>
          <button data-action="fulfill">✅ Fulfill</button>
          <button data-action="dismiss">✕ Dismiss</button>
        </div>
        <div class="req-fulfill-box">
          <textarea rows="5" placeholder="Paste theme JSON here"></textarea>
          <button data-action="create-and-fulfill" class="primary-btn" style="border:none;border-radius:6px;padding:8px 14px;font-weight:700;cursor:pointer;">Create Theme &amp; Fulfill</button>
          <div class="status-msg"></div>
        </div>
      `;

      card.querySelector('[data-action="copy"]').addEventListener('click', async (e) => {
        await navigator.clipboard.writeText(buildPrompt(r.topic));
        const btn = e.target;
        const original = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = original; }, 1500);
      });

      card.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
        try {
          await apiPost(`/api/theme-requests/${r.id}/dismiss`);
          await loadRequests();
        } catch (e) {
          alert(e.message);
        }
      });

      card.querySelector('[data-action="fulfill"]').addEventListener('click', () => {
        card.querySelector('.req-fulfill-box').classList.toggle('open');
      });

      card.querySelector('[data-action="create-and-fulfill"]').addEventListener('click', async () => {
        const box = card.querySelector('.req-fulfill-box');
        const statusEl = box.querySelector('.status-msg');
        statusEl.textContent = '';
        statusEl.className = 'status-msg';
        let parsed;
        try {
          parsed = JSON.parse(box.querySelector('textarea').value);
        } catch (err) {
          statusEl.textContent = 'Invalid JSON — check for missing commas/quotes.';
          statusEl.className = 'status-msg error';
          return;
        }
        try {
          const newTheme = await apiPost('/api/themes', parsed);
          await apiPost(`/api/theme-requests/${r.id}/fulfill`, { themeId: newTheme.id });
          await loadRequests();
          await loadThemes();
        } catch (err) {
          statusEl.textContent = err.message;
          statusEl.className = 'status-msg error';
        }
      });

      requestsList.appendChild(card);
    });
  }

  async function loadThemes() {
    const themes = await apiGet('/api/themes');
    themesList.innerHTML = '';
    themes.forEach(t => {
      const row = document.createElement('div');
      row.className = 'theme-row';
      row.innerHTML = `
        <span>${t.emoji} ${escapeHtml(t.label)} ${t.builtin ? '<span style="opacity:0.4">(built-in)</span>' : ''}</span>
        ${t.builtin ? '' : '<button data-action="delete" style="background:transparent;border:1px solid #7f3a3a;color:#f5a3a3;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;">🗑 Delete</button>'}
      `;
      if (!t.builtin) {
        row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
          if (!confirm(`Delete theme "${t.label}"? This can't be undone.`)) return;
          try {
            await apiDelete(`/api/themes/${encodeURIComponent(t.id)}`);
            await loadThemes();
          } catch (e) {
            alert(e.message);
          }
        });
      }
      themesList.appendChild(row);
    });
  }

  createFromJsonBtn.addEventListener('click', async () => {
    jsonStatus.textContent = '';
    jsonStatus.className = 'status-msg';
    let parsed;
    try {
      parsed = JSON.parse(jsonInput.value);
    } catch (e) {
      jsonStatus.textContent = 'Invalid JSON — check for missing commas/quotes.';
      jsonStatus.className = 'status-msg error';
      return;
    }
    try {
      await apiPost('/api/themes', parsed);
      jsonInput.value = '';
      jsonStatus.textContent = 'Theme created!';
      jsonStatus.className = 'status-msg ok';
      await loadThemes();
    } catch (e) {
      jsonStatus.textContent = e.message;
      jsonStatus.className = 'status-msg error';
    }
  });

  function safeStorageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeStorageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* unavailable */ }
  }
  function safeStorageRemove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* unavailable */ }
  }

  async function tryUnlock(candidateToken) {
    token = candidateToken;
    try {
      await apiGet('/api/theme-requests?status=pending');
      safeStorageSet(TOKEN_KEY, candidateToken);
      lockScreen.classList.add('hidden');
      adminContent.classList.remove('hidden');
      await Promise.all([loadRequests(), loadThemes()]);
    } catch (e) {
      token = '';
      lockError.textContent = 'Invalid token.';
    }
  }

  unlockBtn.addEventListener('click', () => tryUnlock(tokenInput.value.trim()));
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryUnlock(tokenInput.value.trim());
  });

  lockBtn.addEventListener('click', () => {
    safeStorageRemove(TOKEN_KEY);
    token = '';
    adminContent.classList.add('hidden');
    lockScreen.classList.remove('hidden');
    tokenInput.value = '';
  });

  (function init() {
    const saved = safeStorageGet(TOKEN_KEY);
    if (saved) tryUnlock(saved);
  })();
})();
