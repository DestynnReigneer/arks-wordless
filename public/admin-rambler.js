'use strict';

// The Rambler half of the arcade admin: seasons, the boards, and profiles.
// Shares the token the Wordless admin already unlocked — admin.js puts it on
// window.ADMIN_TOKEN once the lock screen is passed.

(() => {
  const $ = id => document.getElementById(id);
  const API = '/api/rambler/admin';

  let state = { boardKey: '4', status: null };

  // admin.js owns the token. Fall back to the key it persists under so a
  // reload that auto-unlocks does not leave this panel unauthenticated.
  function token() {
    if (window.ADMIN_TOKEN) return window.ADMIN_TOKEN;
    try {
      return localStorage.getItem('wordless_admin_token') || '';
    } catch {
      return '';
    }
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'X-Admin-Token': token()
      },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new Error((data && data.error) || `Failed (${res.status})`);
    return data;
  }

  function say(el, text, good = true) {
    if (!el) return;
    el.textContent = text;
    el.style.color = good ? '#6ee7a8' : '#ff9a9a';
    if (text) setTimeout(() => { el.textContent = ''; }, 5000);
  }

  function boardLabel(key) {
    return key === 'marathon' ? 'Marathon' : key === '5' ? '5x5 Big' : '4x4 Classic';
  }

  // ---- season ---------------------------------------------------------------

  function renderSeason(status) {
    state.status = status;
    const s = status.season;
    const ends = status.endsAt
      ? new Date(status.endsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
      : 'when you end it';

    $('seasonBox').innerHTML =
      `<div class="season-head">
         <b></b>
         <span class="pill${status.closingSoon ? ' soon' : ''}"></span>
       </div>
       <div class="muted" style="font-size:12.5px;opacity:.7"></div>`;
    $('seasonBox').querySelector('b').textContent = s.label;
    $('seasonBox').querySelector('.pill').textContent =
      status.daysLeft === null ? 'no end set'
        : status.daysLeft === 0 ? 'ends today'
          : `${status.daysLeft} ${status.daysLeft === 1 ? 'day' : 'days'} left`;
    $('seasonBox').querySelector('.muted').textContent =
      `Resets ${status.intervalLabel} · ends ${ends} · players are warned ${status.warnDays} days out`;

    $('intervalUnit').value = status.interval.unit;
    $('intervalEvery').value = status.interval.every;
    $('intervalEvery').disabled = status.interval.unit === 'manual';
    $('warnDays').value = status.warnDays;
    $('seasonName').value = s.name || '';
  }

  async function loadSeason() {
    try {
      const data = await api('/seasons');
      renderSeason(data.current);
      renderHallOfFame(data.seasons.filter(x => x.endedAt));
    } catch (e) {
      $('seasonBox').textContent = e.message;
    }
  }

  function renderHallOfFame(past) {
    const host = $('hallOfFame');
    if (!past.length) {
      host.innerHTML = '<div class="muted" style="font-size:12.5px;opacity:.6">No seasons have finished yet. The first one to close lands here.</div>';
      return;
    }
    host.innerHTML = '';
    for (const season of past) {
      const winners = season.badges.filter(b => b.rank === 1);
      const row = document.createElement('div');
      row.className = 'row';
      row.style.flexWrap = 'wrap';
      const chips = winners.length
        ? winners.map(w =>
          `<span class="badge-chip gold">${boardLabel(w.boardKey)} · ${w.initials} · ${w.score}</span>`).join('')
        : '<span class="muted">nobody made a board</span>';
      row.innerHTML =
        `<div class="grow"><b></b><div class="muted"></div></div>
         <div style="flex-basis:100%;margin-top:6px">${chips}</div>`;
      row.querySelector('b').textContent = season.label;
      row.querySelector('.muted').textContent =
        `${season.badges.length} badge${season.badges.length === 1 ? '' : 's'} awarded`;
      host.appendChild(row);
    }
  }

  // ---- boards ---------------------------------------------------------------

  async function loadBoards() {
    try {
      const data = await api('/overview');
      const tabs = $('boardTabs');
      tabs.innerHTML = '';
      for (const b of data.boards) {
        const btn = document.createElement('button');
        btn.textContent = `${boardLabel(b.key)} (${b.entries.length})`;
        btn.setAttribute('aria-pressed', String(b.key === state.boardKey));
        btn.onclick = () => { state.boardKey = b.key; loadBoards(); };
        tabs.appendChild(btn);
      }

      const board = data.boards.find(b => b.key === state.boardKey) || data.boards[0];
      const host = $('boardList');
      host.innerHTML = '';
      if (!board.entries.length) {
        host.innerHTML = '<div class="muted" style="font-size:12.5px;opacity:.6">This board is empty.</div>';
        return;
      }
      board.entries.forEach((e, i) => {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML =
          `<span class="num"></span>
           <div class="grow"><b></b><div class="muted"></div></div>
           <span class="num"></span>
           <button class="danger">Remove</button>`;
        row.children[0].textContent = String(i + 1).padStart(2, '0');
        row.querySelector('b').textContent = e.initials;
        row.querySelector('.muted').textContent =
          `${e.wordCount} words${e.bestWord ? ' · ' + e.bestWord : ''}${e.playerId ? ' · profile linked' : ' · guest'}`;
        row.children[2].textContent = String(e.score);
        row.querySelector('button').onclick = async () => {
          try {
            await api(`/arcade/entry/${e.id}`, { method: 'DELETE' });
            say($('boardMsg'), `Removed ${e.initials}.`);
            loadBoards();
          } catch (err) {
            say($('boardMsg'), err.message, false);
          }
        };
        host.appendChild(row);
      });
    } catch (e) {
      $('boardList').textContent = e.message;
    }
  }

  // ---- theme packs ----------------------------------------------------------

  async function loadPacks() {
    try {
      const data = await api('/themes');
      const host = $('packList');
      host.innerHTML = '';

      const none = document.createElement('div');
      none.className = 'row';
      none.innerHTML =
        `<div class="grow"><b>No theme</b><div class="muted">Plain dictionary, no bonus words</div></div>
         <button></button>`;
      const noneBtn = none.querySelector('button');
      noneBtn.textContent = data.activeId ? 'Use this' : 'In use';
      noneBtn.disabled = !data.activeId;
      noneBtn.onclick = () => setSeasonTheme(null);
      host.appendChild(none);

      if (!data.themes.length) {
        const empty = document.createElement('div');
        empty.className = 'muted';
        empty.style.cssText = 'font-size:12.5px;opacity:.6;margin-top:8px';
        empty.textContent = 'No packs yet. Copy the prompt above into any chatbot and paste the answer back.';
        host.appendChild(empty);
        return;
      }

      for (const t of data.themes) {
        const active = t.id === data.activeId;
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML =
          `<span style="font-size:18px"></span>
           <div class="grow"><b></b><div class="muted"></div></div>
           <button data-act="use"></button>
           <button class="danger" data-act="del">Delete</button>`;
        row.children[0].textContent = t.emoji;
        row.querySelector('b').textContent = t.label + (active ? '  \u2190 in use' : '');
        row.querySelector('.muted').textContent =
          `${t.wordCount} words \u00B7 ${t.audience}${t.blurb ? ' \u00B7 ' + t.blurb : ''}`;

        const useBtn = row.querySelector('[data-act="use"]');
        useBtn.textContent = active ? 'In use' : 'Use this';
        useBtn.disabled = active;
        useBtn.onclick = () => setSeasonTheme(t.id);

        row.querySelector('[data-act="del"]').onclick = async () => {
          if (!confirm(`Delete the ${t.label} pack?`)) return;
          try {
            await api(`/themes/${t.id}`, { method: 'DELETE' });
            say($('packMsg'), 'Pack deleted.');
            loadPacks();
          } catch (e) { say($('packMsg'), e.message, false); }
        };
        host.appendChild(row);
      }
    } catch (e) {
      $('packList').textContent = e.message;
    }
  }

  async function setSeasonTheme(themeId) {
    try {
      const r = await api('/seasons/theme', { method: 'POST', body: { themeId } });
      say($('packMsg'), themeId ? `The season is wearing ${r.theme.label}.` : 'Theme removed.');
      loadPacks();
      loadSeason();
    } catch (e) { say($('packMsg'), e.message, false); }
  }

  async function copyPrompt() {
    const topic = $('packTopic').value.trim();
    if (!topic) return say($('packMsg'), 'What should the pack be about?', false);
    try {
      const r = await api('/themes/prompt', {
        method: 'POST', body: { topic, audience: $('packAudience').value }
      });
      try {
        await navigator.clipboard.writeText(r.prompt);
        say($('packMsg'), 'Prompt copied. Paste it into any chatbot, then paste the answer below.');
      } catch {
        // Clipboard is blocked in some contexts; give them the text anyway.
        $('packJson').value = r.prompt;
        say($('packMsg'), 'Copy blocked — the prompt is in the box below. Cut it, use it, then paste the answer back.', false);
      }
    } catch (e) { say($('packMsg'), e.message, false); }
  }

  async function ingestPack() {
    const json = $('packJson').value.trim();
    if (!json) return say($('packMsg'), 'Paste the JSON the chatbot gave you.', false);
    try {
      const r = await api('/themes', { method: 'POST', body: { json } });
      const reach = r.reach;
      const verdict = reach.verdict === 'good'
        ? `Its words turn up on about ${reach.percent}% of boards.`
        : reach.verdict === 'thin'
          ? `Careful: its words only turn up on about ${reach.percent}% of boards. More short words would help.`
          : `These words will almost never appear (about ${reach.percent}% of boards) \u2014 they are too long. Ask for 3-5 letter words.`;
      say($('packMsg'),
        `Added ${r.theme.label}: ${r.theme.wordCount} words${r.skipped ? `, ${r.skipped} skipped` : ''}. ${verdict}`,
        reach.verdict !== 'poor');
      $('packJson').value = '';
      $('packTopic').value = '';
      loadPacks();
    } catch (e) { say($('packMsg'), e.message, false); }
  }

  // ---- dictionary -----------------------------------------------------------

  async function loadDictionary() {
    try {
      const data = await api('/dictionary');
      const host = $('dictList2');
      host.innerHTML = '';
      if (!data.edits.length) {
        host.innerHTML = '<div class="muted" style="font-size:12.5px;opacity:.6">No edits. The word files are being used as they ship.</div>';
        return;
      }
      const labels = Object.fromEntries(data.lists.map(l => [l.key, l.label]));
      for (const e of data.edits) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML =
          `<div class="grow"><b></b><div class="muted"></div></div>
           <button class="danger">Undo</button>`;
        row.querySelector('b').textContent = e.word;
        row.querySelector('.muted').textContent = labels[e.list] || e.list;
        row.querySelector('button').onclick = async () => {
          try {
            await api('/dictionary', { method: 'DELETE', body: { word: e.word, list: e.list } });
            say($('dictMsg'), `${e.word} reverted.`);
            loadDictionary();
          } catch (err) { say($('dictMsg'), err.message, false); }
        };
        host.appendChild(row);
      }
    } catch (e) {
      $('dictList2').textContent = e.message;
    }
  }

  async function addWord() {
    const word = $('dictWord').value.trim();
    if (!word) return say($('dictMsg'), 'Type a word.', false);
    try {
      await api('/dictionary', { method: 'POST', body: { word, list: $('dictList').value } });
      say($('dictMsg'), `${word.toUpperCase()} added.`);
      $('dictWord').value = '';
      loadDictionary();
    } catch (e) { say($('dictMsg'), e.message, false); }
  }

  // ---- profiles -------------------------------------------------------------

  async function loadPlayers() {
    try {
      const { players } = await api('/players');
      const host = $('playerList');
      host.innerHTML = '';
      if (!players.length) {
        host.innerHTML = '<div class="muted" style="font-size:12.5px;opacity:.6">No profiles yet.</div>';
        return;
      }
      for (const p of players) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML =
          `<span style="font-size:20px"></span>
           <div class="grow"><b></b><div class="muted"></div></div>
           <button data-act="coins">+10 \u{1FA99}</button>
           <button data-act="rename">Rename</button>
           <button class="danger" data-act="delete">Delete</button>`;
        row.children[0].textContent = p.avatar;
        row.querySelector('b').textContent = p.name;
        row.querySelector('.muted').textContent =
          `${p.games} rounds · ${p.coins} coins · ${p.streak}d streak · ${p.badges} badges · ${p.milestones} milestones`;

        row.querySelector('[data-act="coins"]').onclick = async () => {
          try {
            const updated = await api(`/players/${p.id}`, { method: 'PATCH', body: { grantCoins: 10 } });
            say($('playerMsg'), `${updated.name} now has ${updated.coins} coins.`);
            loadPlayers();
          } catch (e) { say($('playerMsg'), e.message, false); }
        };
        row.querySelector('[data-act="rename"]').onclick = async () => {
          const name = prompt(`New name for ${p.name}?`, p.name);
          if (!name) return;
          try {
            await api(`/players/${p.id}`, { method: 'PATCH', body: { name } });
            say($('playerMsg'), 'Renamed.');
            loadPlayers();
          } catch (e) { say($('playerMsg'), e.message, false); }
        };
        row.querySelector('[data-act="delete"]').onclick = async () => {
          if (!confirm(`Delete ${p.name}? Their streak, coins, milestones and badges go with them.`)) return;
          try {
            await api(`/players/${p.id}`, { method: 'DELETE', body: { confirm: true } });
            say($('playerMsg'), 'Deleted.');
            loadPlayers();
          } catch (e) { say($('playerMsg'), e.message, false); }
        };
        host.appendChild(row);
      }
    } catch (e) {
      $('playerList').textContent = e.message;
    }
  }

  // ---- wiring ---------------------------------------------------------------

  function refreshAll() {
    loadSeason();
    loadPacks();
    loadDictionary();
    loadBoards();
    loadPlayers();
  }

  function bind() {
    $('tabRambler').onclick = () => {
      $('ramblerPanel').classList.remove('hidden');
      $('wordlessPanel').classList.add('hidden');
      $('tabRambler').setAttribute('aria-pressed', 'true');
      $('tabWordless').setAttribute('aria-pressed', 'false');
      refreshAll();
    };
    $('tabWordless').onclick = () => {
      $('ramblerPanel').classList.add('hidden');
      $('wordlessPanel').classList.remove('hidden');
      $('tabRambler').setAttribute('aria-pressed', 'false');
      $('tabWordless').setAttribute('aria-pressed', 'true');
    };

    $('intervalUnit').onchange = () => {
      $('intervalEvery').disabled = $('intervalUnit').value === 'manual';
    };

    $('saveSchedule').onclick = async () => {
      try {
        const status = await api('/seasons/settings', {
          method: 'POST',
          body: {
            interval: { unit: $('intervalUnit').value, every: Number($('intervalEvery').value) },
            warnDays: Number($('warnDays').value)
          }
        });
        renderSeason(status);
        say($('seasonMsg'), `Saved — resets ${status.intervalLabel}.`);
      } catch (e) { say($('seasonMsg'), e.message, false); }
    };

    $('saveSeasonName').onclick = async () => {
      try {
        const status = await api('/seasons/settings', {
          method: 'POST', body: { name: $('seasonName').value }
        });
        renderSeason(status);
        say($('seasonMsg'), 'Season renamed.');
      } catch (e) { say($('seasonMsg'), e.message, false); }
    };

    $('copyPromptBtn').onclick = copyPrompt;
    $('ingestPackBtn').onclick = ingestPack;
    $('addWordBtn').onclick = addWord;
    $('dictWord').addEventListener('keydown', e => { if (e.key === 'Enter') addWord(); });

    $('clearBoardBtn').onclick = async () => {
      if (!confirm(`Clear the ${boardLabel(state.boardKey)} board? Nobody gets a badge for it.`)) return;
      try {
        const r = await api(`/arcade/${state.boardKey}/clear`, { method: 'POST', body: { confirm: true } });
        say($('boardMsg'), `Cleared ${r.removed} entries.`);
        loadBoards();
      } catch (e) { say($('boardMsg'), e.message, false); }
    };

    $('endSeasonBtn').onclick = async () => {
      const label = state.status ? state.status.season.label : 'this season';
      if (!confirm(`End ${label}? Every board is frozen into badges and then cleared.`)) return;
      try {
        const r = await api('/seasons/end', { method: 'POST', body: { confirm: true } });
        say($('endMsg'), `${r.ended.label} closed — ${r.minted} badges awarded. ${r.next.label} has begun.`);
        refreshAll();
      } catch (e) { say($('endMsg'), e.message, false); }
    };
  }

  // admin.js reveals #adminContent once the token is accepted; wait for that
  // rather than firing requests that would only 401.
  function waitForUnlock() {
    const content = $('adminContent');
    if (!content) return;
    const check = () => {
      if (!content.classList.contains('hidden')) {
        refreshAll();
        return true;
      }
      return false;
    };
    if (check()) return;
    const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
    observer.observe(content, { attributes: true, attributeFilter: ['class'] });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    waitForUnlock();
  });
})();
