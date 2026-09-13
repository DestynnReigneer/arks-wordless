'use strict';

// Word Shaker client.
//
// Four modes share one board and one scoring path. The server owns the board
// and every verdict; this file owns the clock, the dragging, and the fuss.

const API = '/api/shaker';
const $ = id => document.getElementById(id);

const S = {
  config: null,
  mode: 'solo',
  size: 4,
  duration: 180,
  profile: 'kids',
  adultPin: '',

  // single-device round
  boardId: null,
  board: null,
  minLength: 3,
  players: [],          // [{ id, name }] for turns/tabletop
  submissions: [],      // [{ id, name, words: [] }]
  turnIndex: 0,

  // the turn in progress
  found: [],            // [{ word, points }]
  endsAt: 0,
  ticker: null,

  // rooms
  creds: null,          // { code, playerId, token }
  room: null,           // latest snapshot
  stream: null,
  clockSkew: 0,         // serverNow - Date.now()

  results: null
};

// ---------------------------------------------------------------- utilities

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

// Mirrors the server's table so the running total updates without a round
// trip. The server's number is still the one that counts.
function pointsFor(word, size) {
  const n = word.length;
  if (n < (size >= 5 ? 4 : 3)) return 0;
  if (n <= 4) return 1;
  if (n === 5) return 2;
  if (n === 6) return 3;
  if (n === 7) return 5;
  return 11;
}

function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function mmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function screen(name) {
  for (const id of ['setupScreen', 'lobbyScreen', 'gateScreen', 'playScreen', 'entryScreen', 'resultsScreen']) {
    $(id).classList.toggle('hidden', id !== `${name}Screen`);
  }
  window.scrollTo(0, 0);
}

function segment(host, items, current, onPick) {
  host.innerHTML = '';
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = item.label;
    b.setAttribute('aria-pressed', String(item.value === current));
    b.onclick = () => onPick(item.value);
    host.appendChild(b);
  }
}

function chips(host, items) {
  host.innerHTML = '';
  for (const it of items) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = it.word;
    if (it.points) {
      const sup = document.createElement('sup');
      sup.textContent = it.points;
      c.appendChild(sup);
    }
    host.appendChild(c);
  }
}

function say(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg ${kind}`;
}

// ------------------------------------------------------------------- board

// Same 8-way adjacency the server uses, so a drag can be rejected locally
// before it costs a request.
function adjacent(a, b, size) {
  const ar = Math.floor(a / size), ac = a % size;
  const br = Math.floor(b / size), bc = b % size;
  return a !== b && Math.abs(ar - br) <= 1 && Math.abs(ac - bc) <= 1;
}

function renderBoard(host, board, size) {
  host.className = `board s${size}`;
  host.innerHTML = '';
  board.forEach((tile, i) => {
    const d = document.createElement('div');
    d.className = 'die';
    d.dataset.i = String(i);
    d.textContent = tile === 'QU' ? 'Qu' : tile;
    host.appendChild(d);
  });
}

// ------------------------------------------------------------- word tracing

const trace = { active: false, path: [], busy: false };

function traceWord() {
  return trace.path.map(i => S.board[i]).join('');
}

function paintTrace(state = '') {
  const dice = $('board').children;
  for (const d of dice) d.className = 'die';
  for (const i of trace.path) {
    dice[i].className = `die on${state ? ' ' + state : ''}`;
  }
  const bar = $('traceBar');
  const word = traceWord();
  bar.className = `trace-bar${state ? ' ' + state : ''}`;
  if (!word) {
    bar.innerHTML = '<span class="placeholder">Drag across the dice to spell a word</span>';
  } else {
    bar.textContent = word;
  }
}

function dieIndexAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || !el.classList.contains('die')) return -1;
  return Number(el.dataset.i);
}

function extendTrace(i) {
  if (i < 0) return;
  const path = trace.path;
  // Sliding back over the previous die undoes the last step, which is how
  // every touch word game behaves and what fingers expect.
  if (path.length >= 2 && i === path[path.length - 2]) {
    path.pop();
    paintTrace();
    return;
  }
  if (path.includes(i)) return;
  if (path.length && !adjacent(path[path.length - 1], i, S.size)) return;
  path.push(i);
  paintTrace();
}

function bindTracing() {
  const wrap = document.querySelector('.board-wrap');

  wrap.addEventListener('pointerdown', e => {
    if (S.mode === 'tabletop') return;
    const i = dieIndexAt(e.clientX, e.clientY);
    if (i < 0) return;
    e.preventDefault();
    trace.active = true;
    trace.path = [i];
    paintTrace();
  });

  wrap.addEventListener('pointermove', e => {
    if (!trace.active) return;
    e.preventDefault();
    extendTrace(dieIndexAt(e.clientX, e.clientY));
  });

  const finish = () => {
    if (!trace.active) return;
    trace.active = false;
    const word = traceWord();
    if (word.length) submitWord(word);
    else paintTrace();
  };
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

// ------------------------------------------------------------ word submission

function flashTrace(state, word) {
  paintTrace(state);
  $('traceBar').textContent = word;
  setTimeout(() => {
    trace.path = [];
    paintTrace();
  }, state === 'ok' ? 350 : 550);
}

async function submitWord(raw) {
  const word = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!word || trace.busy) return;

  if (word.length < S.minLength) return flashTrace('no', `${word} — too short`);
  if (S.found.some(f => f.word === word)) return flashTrace('no', `${word} — already got it`);

  trace.busy = true;
  try {
    const verdict = await api('/check', { method: 'POST', body: { boardId: S.boardId, word } });
    if (!verdict.valid) {
      flashTrace('no', `${word} — ${verdict.reason}`);
      return;
    }
    S.found.push({ word, points: pointsFor(word, S.size) });
    flashTrace('ok', word);
    renderFound();
    if (S.mode === 'room') pushRoomWords();
  } catch (e) {
    flashTrace('no', e.message);
  } finally {
    trace.busy = false;
  }
}

function renderFound() {
  const total = S.found.reduce((a, f) => a + f.points, 0);
  $('foundCount').textContent = plural(S.found.length, 'word');
  $('foundPoints').textContent = plural(total, 'pt');
  chips($('foundChips'), [...S.found].reverse());
}

let pushTimer = null;
function pushRoomWords() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (!S.creds) return;
    api(`/rooms/${S.creds.code}/words`, {
      method: 'POST',
      body: { ...S.creds, words: S.found.map(f => f.word) }
    }).catch(() => { /* the next word resends the whole list */ });
  }, 250);
}

// ------------------------------------------------------------------- clock

function startClock(endsAt, onDone) {
  S.endsAt = endsAt;
  clearInterval(S.ticker);
  const total = Math.max(1, endsAt - (Date.now() + S.clockSkew));

  const tick = () => {
    const left = S.endsAt - (Date.now() + S.clockSkew);
    $('clock').textContent = mmss(left);
    const frac = Math.max(0, Math.min(1, left / total));
    $('timerFill').style.width = `${frac * 100}%`;

    const urgent = left <= 10000;
    const warn = left <= 30000;
    $('clock').className = `clock${urgent ? ' urgent' : warn ? ' warn' : ''}`;
    $('timerFill').className = `timer-fill${urgent ? ' urgent' : ''}`;

    if (left <= 0) {
      clearInterval(S.ticker);
      S.ticker = null;
      if (onDone) onDone();
    }
  };
  tick();
  S.ticker = setInterval(tick, 250);
}

function stopClock() {
  clearInterval(S.ticker);
  S.ticker = null;
}

// ------------------------------------------------------------ single device

async function newBoard() {
  const data = await api('/board', {
    method: 'POST',
    body: { size: S.size, profile: S.profile, adultPin: S.adultPin }
  });
  S.boardId = data.boardId;
  S.board = data.board;
  S.size = data.size;
  S.minLength = data.minLength;
}

function beginTurn() {
  const player = S.players[S.turnIndex];
  S.found = [];
  trace.path = [];

  renderBoard($('board'), S.board, S.size);
  paintTrace();
  renderFound();

  const solo = S.mode === 'solo';
  const tabletop = S.mode === 'tabletop';
  $('turnName').innerHTML = solo || tabletop ? '' : `<b>${player.name}</b>'s turn`;
  $('playRoster').classList.add('hidden');   // single-device modes have no roster
  $('typeRow').classList.toggle('hidden', tabletop);
  $('traceBar').classList.toggle('hidden', tabletop);
  $('foundChips').parentElement.classList.toggle('hidden', tabletop);
  $('tabletopHint').classList.toggle('hidden', !tabletop);
  $('doneBtn').textContent = tabletop ? 'Stop the clock' : "I'm done";

  screen('play');
  startClock(Date.now() + S.duration * 1000, endTurn);
}

function endTurn() {
  stopClock();
  if (S.mode !== 'tabletop') {
    S.submissions.push({
      id: S.players[S.turnIndex].id,
      name: S.players[S.turnIndex].name,
      words: S.found.map(f => f.word)
    });
  }

  if (S.mode === 'tabletop') {
    S.turnIndex = 0;
    return showEntry();
  }
  S.turnIndex++;
  if (S.turnIndex < S.players.length) return showGate();
  finishSingleDevice();
}

function showGate() {
  const player = S.players[S.turnIndex];
  $('gateName').textContent = player.name;
  $('gateNote').textContent = S.turnIndex === 0
    ? "Everyone gets the same board. Don't peek before your turn."
    : `Same board as before. ${S.duration / 60 >= 1 ? '' : ''}Hand the phone over.`;
  screen('gate');
}

function showEntry() {
  const player = S.players[S.turnIndex];
  $('entryName').textContent = player.name;
  $('entryText').value = '';
  say($('entryMsg'), '');
  renderBoard($('entryBoard'), S.board, S.size);
  $('entryNextBtn').textContent =
    S.turnIndex === S.players.length - 1 ? 'Score the round' : 'Next player';
  screen('entry');
  $('entryText').focus();
}

function takeEntry() {
  const words = $('entryText').value
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  S.submissions.push({
    id: S.players[S.turnIndex].id,
    name: S.players[S.turnIndex].name,
    words
  });
  S.turnIndex++;
  if (S.turnIndex < S.players.length) return showEntry();
  finishSingleDevice();
}

async function finishSingleDevice() {
  try {
    const results = await api('/score', {
      method: 'POST',
      body: { boardId: S.boardId, players: S.submissions }
    });
    showResults(results);
  } catch (e) {
    alert(e.message);
    screen('setup');
  }
}

// ------------------------------------------------------------------- rooms

function openStream() {
  if (S.stream) S.stream.close();
  const { code, playerId, token } = S.creds;
  const url = `${API}/rooms/${code}/events?playerId=${encodeURIComponent(playerId)}&token=${encodeURIComponent(token)}`;
  S.stream = new EventSource(url);
  S.stream.addEventListener('state', e => applyRoomState(JSON.parse(e.data)));
  S.stream.onerror = () => { /* EventSource reconnects on its own */ };
}

function closeStream() {
  if (S.stream) S.stream.close();
  S.stream = null;
}

function applyRoomState(snap) {
  const previous = S.room;
  S.room = snap;
  S.clockSkew = snap.serverNow - Date.now();
  S.size = snap.settings.size;
  S.duration = snap.settings.durationSec;
  S.profile = snap.settings.profile;

  if (snap.state === 'lobby') {
    renderLobby(snap);
    if (!previous || previous.state !== 'lobby') screen('lobby');
    return;
  }

  if (snap.state === 'playing') {
    const fresh = !previous || previous.state !== 'playing';
    S.board = snap.board;
    S.boardId = snap.boardId;
    S.minLength = snap.minLength;
    if (fresh) {
      S.found = [];
      trace.path = [];
      renderBoard($('board'), S.board, S.size);
      paintTrace();
      renderFound();
      $('turnName').innerHTML = `Room <b>${snap.code}</b>`;
      $('typeRow').classList.remove('hidden');
      $('traceBar').classList.remove('hidden');
      $('tabletopHint').classList.add('hidden');
      $('doneBtn').textContent = "I'm done";
      screen('play');
      startClock(snap.endsAt, () => { /* the server ends the round */ });
    }
    // Counts only, never the words themselves -- watching a rival's tally
    // climb is the fun part; seeing what they found would spoil the round.
    renderPlayRoster(snap);
    return;
  }

  if (snap.state === 'results' && snap.results) {
    stopClock();
    showResults(snap.results);
  }
}

function renderPlayRoster(snap) {
  const others = snap.players.filter(p => !snap.you || p.id !== snap.you.id);
  $('playRoster').classList.toggle('hidden', others.length === 0);
  if (!others.length) return;

  const host = $('playRosterList');
  host.innerHTML = '';
  for (const p of others) {
    const row = document.createElement('div');
    row.className = `who${p.connected ? '' : ' away'}`;
    row.innerHTML =
      '<span class="dot"></span><span class="nm"></span><span class="count"></span>';
    row.querySelector('.nm').textContent = p.name;
    row.querySelector('.count').textContent = p.ready ? 'done' : plural(p.wordCount, 'word');
    host.appendChild(row);
  }
}

function renderLobby(snap) {
  $('roomCode').textContent = snap.code;
  const roster = $('lobbyRoster');
  roster.innerHTML = '';
  for (const p of snap.players) {
    const row = document.createElement('div');
    row.className = `who${p.connected ? '' : ' away'}`;
    row.innerHTML =
      `<span class="dot"></span><span class="nm"></span>` +
      (p.isHost ? '<span class="tag">Host</span>' : '');
    row.querySelector('.nm').textContent = p.name + (p.id === snap.you?.id ? ' (you)' : '');
    roster.appendChild(row);
  }

  $('hostControls').classList.toggle('hidden', !snap.youAreHost);
  $('guestWaiting').classList.toggle('hidden', snap.youAreHost);

  if (snap.youAreHost) {
    segment($('lobbySizeSeg'), S.config.sizes.map(s => ({ label: s.label, value: s.size })),
      snap.settings.size, v => pushRoomSettings({ size: v }));
    segment($('lobbyDurationSeg'), S.config.durations.map(d => ({ label: mmss(d * 1000), value: d })),
      snap.settings.durationSec, v => pushRoomSettings({ durationSec: v }));
  }
}

function pushRoomSettings(patch) {
  api(`/rooms/${S.creds.code}/settings`, { method: 'POST', body: { ...S.creds, ...patch } })
    .catch(e => alert(e.message));
}

// ------------------------------------------------------------------ results

function showResults(results) {
  S.results = results;
  stopClock();

  const multi = results.results.length > 1;
  const mine = S.mode === 'room' && S.room?.you
    ? results.results.find(r => r.playerId === S.room.you.id)
    : results.results[0];
  const top = results.results[0];

  // Duplicate cancellation makes ties genuinely common, so don't crown the
  // first row just because it sorted first.
  const winners = results.results.filter(r => r.rank === 1);
  const tied = winners.length > 1;

  $('resultTitle').textContent = !multi ? 'Final score' : tied ? 'Tied' : 'Winner';
  $('resultScore').textContent = !multi
    ? String(mine ? mine.score : 0)
    : tied ? winners.map(w => w.name).join(' & ') : top.name;
  $('resultSub').textContent = multi
    ? `${plural(top.score, 'point')} each · ${plural(top.wordCount, 'word')}`
    : `${plural(mine ? mine.wordCount : 0, 'word')} · ${results.totalWords} were on the board`;
  if (multi && !tied) {
    $('resultSub').textContent = `${plural(top.score, 'point')} · ${plural(top.wordCount, 'word')}`;
  }

  const standings = $('standings');
  standings.innerHTML = '';
  results.results.forEach((r, i) => {
    const d = document.createElement('details');
    d.className = `stand${r.rank === 1 ? ' first' : ''}`;
    if (!multi) d.open = true;

    const sum = document.createElement('summary');
    sum.innerHTML =
      `<span class="rank">${r.rank}</span><span class="nm"></span>` +
      `<span class="sc">${r.score}<small>${r.score === 1 ? 'pt' : 'pts'}</small></span>`;
    sum.querySelector('.nm').textContent = r.name;
    d.appendChild(sum);

    const detail = document.createElement('div');
    detail.className = 'detail';
    if (!r.words.length) {
      detail.innerHTML = '<div class="note">No words submitted.</div>';
    }
    for (const w of r.words) {
      const line = document.createElement('div');
      line.className = `word-line${!w.valid ? ' bad' : w.cancelled ? ' dead' : ''}`;
      const label = !w.valid ? w.reason : w.cancelled ? 'everyone found it' : '';
      line.innerHTML = `<span class="w"></span><span class="p${w.points ? '' : ' zero'}"></span>`;
      line.querySelector('.w').textContent = w.word;
      line.querySelector('.p').textContent = w.points ? `+${w.points}` : label;
      detail.appendChild(line);
    }
    d.appendChild(detail);
    standings.appendChild(d);
  });

  const cancelled = results.cancelled || [];
  $('cancelledPanel').classList.toggle('hidden', cancelled.length === 0);
  if (cancelled.length) {
    chips($('cancelledChips'), cancelled.map(w => ({ word: w, points: 0 })));
  }

  $('missedPanel').classList.toggle('hidden', results.missed.length === 0);
  $('missedSub').textContent = results.profile === 'kids'
    ? `${results.missedTotal} everyday words were sitting there. The best was ${results.bestPossible ? results.bestPossible.word : '—'}.`
    : `${results.missedTotal} words went unfound, out of ${results.totalWords} on the board.`;
  chips($('missedChips'), results.missed.map(m => ({ word: m.word, points: m.points })));

  $('saveScoreBtn').classList.toggle('hidden', !canSaveScore());
  $('againBtn').textContent = S.mode === 'room'
    ? (S.room && S.room.youAreHost ? 'New round' : 'Back to lobby')
    : 'Play again';

  screen('results');
}

function scoreTarget() {
  if (!S.results) return null;
  if (S.mode === 'room') {
    return S.room?.you ? S.results.results.find(r => r.playerId === S.room.you.id) : null;
  }
  return S.results.results[0];   // already sorted, so this is the winner
}

function canSaveScore() {
  const target = scoreTarget();
  return !!target && target.score > 0;
}

// -------------------------------------------------------------- leaderboard

const lbState = { profile: 'kids', size: 4 };

async function openLeaderboard() {
  lbState.profile = S.profile;
  lbState.size = S.size;
  $('leaderboardOverlay').classList.remove('hidden');
  renderLeaderboardControls();
  await loadLeaderboard();
}

function renderLeaderboardControls() {
  segment($('lbProfileSeg'), S.config.profiles.map(p => ({ label: p.label, value: p.id })),
    lbState.profile, v => { lbState.profile = v; renderLeaderboardControls(); loadLeaderboard(); });
  segment($('lbSizeSeg'), S.config.sizes.map(s => ({ label: s.label, value: s.size })),
    lbState.size, v => { lbState.size = v; renderLeaderboardControls(); loadLeaderboard(); });
}

async function loadLeaderboard() {
  const host = $('leaderboardList');
  host.innerHTML = '<div class="note">Loading…</div>';
  try {
    const rows = await api(`/leaderboard?profile=${lbState.profile}&size=${lbState.size}&limit=25`);
    if (!rows.length) {
      host.innerHTML = '<div class="note">Nothing here yet. Go and win something.</div>';
      return;
    }
    host.innerHTML = '';
    rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'lb-row';
      row.innerHTML =
        `<span class="r">${i + 1}</span><span class="i"></span>` +
        `<span class="d"></span><span class="s">${r.score}</span>`;
      row.querySelector('.i').textContent = r.initials;
      row.querySelector('.d').textContent =
        `${r.wordCount} words${r.bestWord ? ' · ' + r.bestWord : ''} · ${r.mode}`;
      host.appendChild(row);
    });
  } catch (e) {
    host.innerHTML = '<div class="note"></div>';
    host.firstChild.textContent = e.message;
  }
}

// -------------------------------------------------------------------- setup

function defaultPlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i + 1}` }));
}

function renderPlayersEditor() {
  const host = $('playersEdit');
  host.innerHTML = '';
  S.players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'player-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 16;
    input.value = p.name;
    input.placeholder = `Player ${i + 1}`;
    input.oninput = () => { p.name = input.value; };
    row.appendChild(input);

    if (S.players.length > 2) {
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Remove';
      del.onclick = () => {
        S.players.splice(i, 1);
        renderPlayersEditor();
      };
      row.appendChild(del);
    }
    host.appendChild(row);
  });
  $('addPlayerBtn').classList.toggle('hidden', S.players.length >= (S.config?.maxPlayers || 8));
}

function renderSetup() {
  for (const b of $('modeList').children) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode));
  }

  const needsRoster = S.mode === 'turns' || S.mode === 'tabletop';
  $('playersField').classList.toggle('hidden', !needsRoster);
  $('nameField').classList.toggle('hidden', S.mode !== 'room');
  $('joinDivider').classList.toggle('hidden', S.mode !== 'room');
  $('joinField').classList.toggle('hidden', S.mode !== 'room');
  if (needsRoster) renderPlayersEditor();

  segment($('sizeSeg'), S.config.sizes.map(s => ({ label: s.label, value: s.size })),
    S.size, v => { S.size = v; renderSetup(); });
  segment($('durationSeg'), S.config.durations.map(d => ({ label: mmss(d * 1000), value: d })),
    S.duration, v => { S.duration = v; renderSetup(); });
  segment($('profileSeg'), S.config.profiles.map(p => ({ label: p.label, value: p.id })),
    S.profile, pickProfile);

  const profile = S.config.profiles.find(p => p.id === S.profile);
  $('profileNote').textContent = profile
    ? `${profile.words.toLocaleString()} words. ${profile.blurb}.`
    : '';

  $('startBtn').textContent = S.mode === 'room' ? 'Open a room' : 'Shake the dice';
}

function pickProfile(value) {
  if (value !== 'adult' || sessionStorage.getItem('shaker.adult') === 'yes') {
    S.profile = value;
    renderSetup();
    return;
  }
  $('adultPinField').classList.toggle('hidden', !S.config.adultRequiresPin);
  say($('adultMsg'), '');
  $('adultOverlay').classList.remove('hidden');
}

// ------------------------------------------------------------------- start

async function startPressed() {
  say($('setupMsg'), '');
  try {
    if (S.mode === 'room') {
      const data = await api('/rooms', {
        method: 'POST',
        body: {
          name: $('nameInput').value,
          size: S.size,
          profile: S.profile,
          durationSec: S.duration,
          adultPin: S.adultPin
        }
      });
      S.creds = { code: data.code, playerId: data.playerId, token: data.token };
      openStream();
      return;
    }

    S.players = S.mode === 'solo'
      ? [{ id: 'p0', name: 'You' }]
      : S.players.map((p, i) => ({ id: `p${i}`, name: (p.name || '').trim() || `Player ${i + 1}` }));
    S.submissions = [];
    S.turnIndex = 0;

    await newBoard();

    if (S.mode === 'turns') showGate();
    else beginTurn();
  } catch (e) {
    say($('setupMsg'), e.message, 'err');
  }
}

async function joinPressed() {
  const code = $('joinCodeInput').value.trim().toUpperCase();
  if (code.length !== 4) return say($('setupMsg'), 'Room codes are four characters.', 'err');
  try {
    const data = await api(`/rooms/${code}/join`, {
      method: 'POST',
      body: { name: $('nameInput').value }
    });
    S.creds = { code: data.code, playerId: data.playerId, token: data.token };
    S.mode = 'room';
    openStream();
  } catch (e) {
    say($('setupMsg'), e.message, 'err');
  }
}

function backToSetup() {
  stopClock();
  closeStream();
  S.creds = null;
  S.room = null;
  S.results = null;
  S.found = [];
  screen('setup');
  renderSetup();
}

// -------------------------------------------------------------- score entry

function openInitials() {
  const target = scoreTarget();
  if (!target) return;
  $('initialsWho').textContent = `Saving ${target.name}'s ${target.score} points.`;
  for (const box of document.querySelectorAll('.initial-box')) box.value = '';
  say($('initialsMsg'), '');
  $('initialsOverlay').classList.remove('hidden');
  document.querySelector('.initial-box').focus();
}

async function saveInitials() {
  const initials = [...document.querySelectorAll('.initial-box')]
    .map(b => b.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .join('');
  if (!initials) return say($('initialsMsg'), 'Enter at least one letter.', 'err');

  const target = scoreTarget();
  const body = S.mode === 'room'
    ? { ...S.creds, initials }
    : { boardId: S.boardId, playerId: target.playerId, mode: S.mode, durationSec: S.duration, initials };

  try {
    const saved = await api('/leaderboard', { method: 'POST', body });
    say($('initialsMsg'), `Saved — rank #${saved.rank}.`, 'ok');
    $('saveScoreBtn').classList.add('hidden');
    setTimeout(() => $('initialsOverlay').classList.add('hidden'), 900);
  } catch (e) {
    say($('initialsMsg'), e.message, 'err');
  }
}

function bindInitialsBoxes() {
  const boxes = [...document.querySelectorAll('.initial-box')];
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
      if (e.key === 'Enter') saveInitials();
    });
  });
}

// -------------------------------------------------------------------- wiring

function bind() {
  for (const b of $('modeList').children) {
    b.onclick = () => {
      S.mode = b.dataset.mode;
      if ((S.mode === 'turns' || S.mode === 'tabletop') && S.players.length < 2) {
        S.players = defaultPlayers(2);
      }
      renderSetup();
    };
  }

  $('addPlayerBtn').onclick = () => {
    if (S.players.length >= (S.config?.maxPlayers || 8)) return;
    S.players.push({ id: `p${S.players.length}`, name: '' });
    renderPlayersEditor();
  };

  $('startBtn').onclick = startPressed;
  $('joinBtn').onclick = joinPressed;
  $('joinCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinPressed(); });

  $('gateBtn').onclick = beginTurn;

  $('typeBtn').onclick = () => {
    const v = $('typeInput').value;
    $('typeInput').value = '';
    submitWord(v);
  };
  $('typeInput').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const v = $('typeInput').value;
    $('typeInput').value = '';
    submitWord(v);
  });

  $('doneBtn').onclick = () => {
    if (S.mode === 'room') {
      api(`/rooms/${S.creds.code}/ready`, { method: 'POST', body: S.creds }).catch(() => {});
      $('doneBtn').textContent = 'Waiting for the others…';
      $('doneBtn').disabled = true;
      return;
    }
    endTurn();
  };

  $('entryNextBtn').onclick = takeEntry;

  $('againBtn').onclick = () => {
    if (S.mode === 'room') {
      if (S.room && S.room.youAreHost) {
        api(`/rooms/${S.creds.code}/next`, { method: 'POST', body: S.creds }).catch(e => alert(e.message));
      }
      $('doneBtn').disabled = false;
      return;
    }
    backToSetup();
    startPressed();
  };

  $('saveScoreBtn').onclick = openInitials;
  $('confirmInitialsBtn').onclick = saveInitials;
  $('closeInitialsBtn').onclick = () => $('initialsOverlay').classList.add('hidden');

  $('leaderboardBtn').onclick = openLeaderboard;
  $('closeLeaderboardBtn').onclick = () => $('leaderboardOverlay').classList.add('hidden');

  $('lobbyStartBtn').onclick = () => {
    api(`/rooms/${S.creds.code}/start`, { method: 'POST', body: S.creds })
      .catch(e => alert(e.message));
  };

  $('leaveRoomBtn').onclick = () => {
    if (S.creds) api(`/rooms/${S.creds.code}/leave`, { method: 'POST', body: S.creds }).catch(() => {});
    backToSetup();
  };

  $('adultCancelBtn').onclick = () => $('adultOverlay').classList.add('hidden');
  $('closeAdultBtn').onclick = () => $('adultOverlay').classList.add('hidden');
  $('adultConfirmBtn').onclick = () => {
    if (S.config.adultRequiresPin) {
      const pin = $('adultPinInput').value.trim();
      if (!pin) return say($('adultMsg'), 'Enter the PIN.', 'err');
      S.adultPin = pin;
    }
    sessionStorage.setItem('shaker.adult', 'yes');
    S.profile = 'adult';
    $('adultOverlay').classList.add('hidden');
    renderSetup();
  };

  bindTracing();
  bindInitialsBoxes();

  window.addEventListener('beforeunload', () => {
    if (S.creds && navigator.sendBeacon) {
      navigator.sendBeacon(
        `${API}/rooms/${S.creds.code}/leave`,
        new Blob([JSON.stringify(S.creds)], { type: 'application/json' })
      );
    }
  });
}

async function boot() {
  try {
    S.config = await api('/config');
  } catch {
    document.body.innerHTML =
      '<p style="padding:30px;text-align:center">Could not reach the server.</p>';
    return;
  }
  S.duration = S.config.defaultDuration;
  S.players = defaultPlayers(2);
  bind();
  renderSetup();
}

boot();
