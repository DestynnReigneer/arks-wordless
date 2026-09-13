'use strict';

// Everything over HTTP against a real running server: classic rounds, the
// anti-cheat guarantees, multi-device rooms and their event stream, marathon,
// the daily challenge, profiles, coins and hints.

const path = require('node:path');

async function run({ base, root }) {
  const solver = require(path.join(root, 'rambler/solver.js'));
  const API = base + '/api/rambler';

  let pass = 0;
  let fail = 0;
  const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  ' + extra : '')); }
  };

  async function api(p, method = 'GET', body) {
    const res = await fetch(API + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }

  const square = n => ({ cols: n, rows: n });

  console.log('\n-- config --');
  const cfg = await api('/config');
  ok('config responds', cfg.status === 200);
  ok('three difficulties', cfg.data.difficulties.length === 3);
  ok('timers stretch to 10 minutes for younger players', cfg.data.durations.includes(600));
  ok('milestone catalogue is published', cfg.data.milestones.length >= 15);

  console.log('\n-- a classic round --');
  const board = await api('/board', 'POST', { size: 4, profile: 'kids' });
  ok('board created', board.status === 201);
  ok('16 tiles', board.data.board.length === 16);
  const { boardId, board: tiles } = board.data;
  const real = solver.solveWords(tiles, square(4), 'kids').filter(w => w.length >= 4)
    .sort((a, b) => b.length - a.length).slice(0, 5);

  const good = await api('/check', 'POST', { boardId, word: real[0] });
  ok(`a real word is accepted (${real[0]})`, good.data.valid === true, JSON.stringify(good.data));
  ok('and comes back with its path', Array.isArray(good.data.path));

  const junk = await api('/check', 'POST', { boardId, word: 'ZZZZQ' });
  ok('a non-word is refused', junk.data.valid === false && junk.data.reason === 'not a word');

  const absent = ['SYZYGY', 'JUKEBOX', 'QUIZZED'].find(w => !solver.solveWords(tiles, square(4), 'kids').includes(w));
  const off = await api('/check', 'POST', { boardId, word: absent });
  ok(`a real word not on the board is refused (${absent})`, off.data.reason === 'not on the board');

  const rude = await api('/check', 'POST', { boardId, word: 'FUCK' });
  ok('profanity is refused on the kids dictionary', rude.data.valid === false);

  const scored = await api('/score', 'POST', {
    boardId, players: [{ id: 'p0', name: 'Solo', words: [...real, 'ZZZZQ'] }]
  });
  const me = scored.data.results[0];
  const expect = real.reduce((a, w) =>
    a + (w.length <= 4 ? 1 : w.length === 5 ? 2 : w.length === 6 ? 3 : w.length === 7 ? 5 : 11), 0);
  ok(`score matches the table (${me.score} == ${expect})`, me.score === expect);
  ok('the junk word counts as submitted but not valid', me.wordCount === real.length);

  console.log('\n-- the score cannot be forged --');
  const saved = await api('/leaderboard', 'POST', { boardId, playerId: 'p0', mode: 'solo', initials: 'AAA' });
  ok('a score saves', saved.status === 201);
  const forged = await api('/leaderboard', 'POST', { boardId, playerId: 'p0', mode: 'solo', initials: 'HAX', score: 99999 });
  ok('a score in the request body is ignored', forged.data.score === me.score,
    `${forged.data.score} vs ${me.score}`);
  const badInitials = await api('/leaderboard', 'POST', { boardId, playerId: 'p0', initials: 'TOOLONG' });
  ok('bad initials are refused', badInitials.status === 400);
  ok('an unknown board is a 404', (await api('/check', 'POST', { boardId: 'deadbeef', word: 'CAT' })).status === 404);

  console.log('\n-- the arcade board --');
  const arcadeBoard = await api('/arcade?board=4');
  ok('the board reports its shape', arcadeBoard.data.slots === 10 && arcadeBoard.data.boardKey === '4',
    JSON.stringify({ slots: arcadeBoard.data.slots, key: arcadeBoard.data.boardKey }));
  ok('and lists the three boards', arcadeBoard.data.boards.length === 3,
    JSON.stringify(arcadeBoard.data.boards.map(b => b.key)));

  // Fill every slot, then try to get on with a score that does not deserve it.
  for (let i = 0; i < 12; i++) {
    const b = await api('/board', 'POST', { size: 4, profile: 'kids' });
    const words = solver.solveWords(b.data.board, square(4), 'kids')
      .filter(w => w.length >= 5).slice(0, 3 + (i % 4));
    await api('/score', 'POST', { boardId: b.data.boardId, players: [{ id: 'p0', name: 'F', words }] });
    await api('/leaderboard', 'POST', {
      boardId: b.data.boardId, playerId: 'p0', mode: 'solo', initials: 'F' + i
    });
  }
  const full = await api('/arcade?board=4');
  ok('the board never exceeds ten slots', full.data.entries.length <= 10, String(full.data.entries.length));
  ok('it is sorted best first', full.data.entries.every((e, i, a) => i === 0 || a[i - 1].score >= e.score));

  const boardIsFull = full.data.entries.length === 10 && full.data.entries[9].score > 1;

  // A round worth almost nothing cannot buy a slot on a full board.
  const cheapBoard = await api('/board', 'POST', { size: 4, profile: 'kids' });
  const oneWord = solver.solveWords(cheapBoard.data.board, square(4), 'kids').find(w => w.length === 3);
  await api('/score', 'POST', {
    boardId: cheapBoard.data.boardId, players: [{ id: 'p0', name: 'Low', words: [oneWord] }]
  });
  const rejected = await api('/leaderboard', 'POST', {
    boardId: cheapBoard.data.boardId, playerId: 'p0', mode: 'solo', initials: 'LOW'
  });
  ok('a score that misses the cut is refused entry',
    !boardIsFull || rejected.data.made === false, JSON.stringify(rejected.data).slice(0, 120));
  ok('and is told how far short it fell',
    !boardIsFull || (typeof rejected.data.shortBy === 'number' && rejected.data.shortBy > 0),
    String(rejected.data.shortBy));
  ok('missing the board is not an error', rejected.status === 200 || rejected.status === 201,
    String(rejected.status));

  // A big score gets on and knocks the bottom entry off for good.
  //
  // Boards are random, and a weak one can yield fewer points than the current
  // cutoff -- which made this assertion pass or fail on the luck of the roll.
  // Roll until the round is genuinely good enough, so the test is about the
  // board's eviction rule rather than the dice.
  const beforeTop = (await api('/arcade?board=4')).data.entries;
  const needed = beforeTop.length === 10 ? beforeTop[9].score : 0;
  const pointsOf = w => (w.length <= 4 ? 1 : w.length === 5 ? 2 : w.length === 6 ? 3 : w.length === 7 ? 5 : 11);

  let bigBoard = null;
  let many = [];
  for (let attempt = 0; attempt < 25; attempt++) {
    bigBoard = await api('/board', 'POST', { size: 4, profile: 'kids' });
    many = solver.solveWords(bigBoard.data.board, square(4), 'kids').slice(0, 60);
    if (many.reduce((a, w) => a + pointsOf(w), 0) > needed) break;
  }
  ok('found a round good enough to challenge the board',
    many.reduce((a, w) => a + pointsOf(w), 0) > needed,
    `needed more than ${needed}`);

  await api('/score', 'POST', {
    boardId: bigBoard.data.boardId, players: [{ id: 'p0', name: 'Big', words: many }]
  });
  const big = await api('/leaderboard', 'POST', {
    boardId: bigBoard.data.boardId, playerId: 'p0', mode: 'solo', initials: 'BIG'
  });
  ok('a big score makes the board', big.data.made === true, JSON.stringify(big.data).slice(0, 140));
  ok('and is told which slot it took', big.data.rank >= 1, String(big.data.rank));
  const afterTop = (await api('/arcade?board=4')).data.entries;
  ok('the board is still capped after the insert', afterTop.length <= 10, String(afterTop.length));
  ok('somebody was knocked off to make room',
    beforeTop.length < 10 || (Array.isArray(big.data.evicted) && big.data.evicted.length >= 1),
    JSON.stringify(big.data.evicted));

  // Marathon keeps its own wall.
  const maraWall = await api('/arcade?board=marathon');
  ok('marathon has a board of its own', maraWall.data.boardKey === 'marathon');
  ok('and the 4x4 scores did not leak into it',
    maraWall.data.entries.every(e => e.mode === 'marathon'),
    JSON.stringify(maraWall.data.entries.map(e => e.mode)));

  console.log('\n-- difficulty --');
  const easy = await api('/board', 'POST', { size: 4, difficulty: 'easy' });
  const hard = await api('/board', 'POST', { size: 4, difficulty: 'hard' });
  ok('easy allows three letters', easy.data.minLength === 3);
  ok('hard demands four', hard.data.minLength === 4);

  console.log('\n-- profiles, coins and hints --');
  const player = await api('/players', 'POST', { name: 'Tester' });
  ok('a profile is created', player.status === 201);
  const pid = player.data.id;
  ok('it starts with nothing banked', player.data.coins === 0 && player.data.streak === 0);
  ok('a blank name is refused', (await api('/players', 'POST', { name: '  ' })).status === 400);

  const daily = await api('/daily?playerId=' + pid);
  ok('the daily board loads', daily.status === 200 && daily.data.board.length === 16);
  ok('and reports it is unplayed', daily.data.alreadyPlayed === false);
  const dailySame = await api('/daily?playerId=' + pid);
  ok('the daily is stable within the day', daily.data.board.join('') === dailySame.data.board.join(''));

  const dWords = solver.solveWords(daily.data.board, square(4), 'kids', { min: daily.data.minLength })
    .filter(w => w.length >= 5).slice(0, 6);
  const dScore = await api('/score', 'POST', {
    boardId: daily.data.boardId, playerId: pid,
    players: [{ id: 'p0', name: 'Tester', words: dWords }]
  });
  ok('the daily round records progress', !!dScore.data.progress);
  ok('a streak begins', dScore.data.progress.streak === 1);
  ok('coins are paid', dScore.data.progress.coinsEarned > 0, String(dScore.data.progress.coinsEarned));
  ok('milestones fire', dScore.data.progress.milestones.length > 0);
  ok('the daily now reads as played', (await api('/daily?playerId=' + pid)).data.alreadyPlayed === true);

  const coinsBefore = (await api('/players/' + pid)).data.coins;
  const hintBoard = await api('/board', 'POST', { size: 4 });
  const hint = await api('/hint', 'POST', { boardId: hintBoard.data.boardId, playerId: pid, found: [] });
  ok('a hint is given', hint.status === 200 && typeof hint.data.word === 'string');
  ok('coins are deducted for it', hint.data.coins === coinsBefore - hint.data.cost);
  ok('the hinted word is really on the board',
    (await api('/check', 'POST', { boardId: hintBoard.data.boardId, word: hint.data.word })).data.valid === true);
  const skint = await api('/players', 'POST', { name: 'Skint' });
  ok('no coins means no hint',
    (await api('/hint', 'POST', { boardId: hintBoard.data.boardId, playerId: skint.data.id, found: [] })).status === 402);
  ok('a guest cannot buy one',
    (await api('/hint', 'POST', { boardId: hintBoard.data.boardId, found: [] })).status === 400);

  console.log('\n-- marathon --');
  const m = await api('/marathon', 'POST', { profile: 'kids', difficulty: 'normal' });
  ok('a run starts', m.status === 201 && m.data.cols === 4 && m.data.level === 1);
  const mid = m.data.id;
  const clockAtStart = m.data.endsAt;
  let cur = m.data;
  let grew = null;
  for (let i = 0; i < 12; i++) {
    const words = solver.solveWords(cur.board, { cols: cur.cols, rows: cur.rows }, 'kids', { min: cur.minLength });
    const have = new Set(cur.found.map(f => f.word));
    const next = words.find(w => !have.has(w));
    if (!next) break;
    const res = await api(`/marathon/${mid}/word`, 'POST', { word: next });
    cur = res.data;
    if (res.data.grew) grew = res.data.grew;
  }
  ok('words buy time', cur.endsAt > clockAtStart, `${cur.endsAt - clockAtStart}ms`);
  ok('the grid grows', !!grew, JSON.stringify(grew));
  ok('the level rises with it', cur.level > 1);
  ok('tiles match the new shape', cur.board.length === cur.cols * cur.rows);
  ok('a repeat word is refused',
    (await api(`/marathon/${mid}/word`, 'POST', { word: cur.found[0].word })).data.reason === 'already found');
  const done = await api(`/marathon/${mid}/finish`, 'POST', { playerId: pid });
  ok('the run finishes with a score', typeof done.data.finalScore === 'number');
  ok('and banks progress', !!done.data.progress);
  ok('nothing counts afterwards', (await api(`/marathon/${mid}/word`, 'POST', { word: 'CAT' })).status === 409);

  console.log('\n-- rooms --');
  const room = await api('/rooms', 'POST', { name: 'Ada', size: 4, durationSec: 60 });
  ok('a room opens', room.status === 201 && room.data.code.length === 4);
  const host = { code: room.data.code, playerId: room.data.playerId, token: room.data.token };
  ok('the board is hidden in the lobby', room.data.state.board === null);
  const guest = await api(`/rooms/${host.code}/join`, 'POST', { name: 'Bo' });
  const g = { code: host.code, playerId: guest.data.playerId, token: guest.data.token };
  ok('a guest joins', guest.status === 201 && guest.data.state.players.length === 2);
  ok('a wrong token is refused',
    (await api(`/rooms/${host.code}/start`, 'POST', { playerId: g.playerId, token: 'nope' })).status === 403);
  ok('a guest cannot start the round', (await api(`/rooms/${host.code}/start`, 'POST', g)).status === 403);

  const events = [];
  const ac = new AbortController();
  const stream = (async () => {
    const res = await fetch(`${API}/rooms/${host.code}/events?playerId=${g.playerId}&token=${g.token}`, { signal: ac.signal });
    ok('the event stream opens', res.status === 200);
    ok('with the right content type', (res.headers.get('content-type') || '').includes('text/event-stream'));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const mm = chunk.match(/^event: (\w+)\ndata: (.*)$/s);
          if (mm) events.push(JSON.parse(mm[2]));
        }
      }
    } catch { /* aborted */ }
  })();

  await new Promise(r => setTimeout(r, 400));
  ok('the guest gets an opening state', events.length > 0);

  const started = await api(`/rooms/${host.code}/start`, 'POST', host);
  ok('the host starts it', started.status === 200 && started.data.board.length === 16);
  await new Promise(r => setTimeout(r, 400));
  const playing = events[events.length - 1];
  ok('the start reaches the guest', playing.state === 'playing');
  ok('with the same board', JSON.stringify(playing.board) === JSON.stringify(started.data.board));
  // Regression: the board used to be stashed after this event was sent, so
  // clients got a null id on the very message that started their round.
  ok('and a usable board id', !!playing.boardId);
  const guestWord = solver.solveWords(playing.board, square(4), 'kids').find(w => w.length >= 4);
  ok('which the guest can check words against',
    (await api('/check', 'POST', { boardId: playing.boardId, word: guestWord })).data.valid === true);

  const pool = solver.solveWords(started.data.board, square(4), 'kids').filter(w => w.length >= 4);
  const aWords = pool.slice(0, 4);
  const bWords = pool.slice(2, 6);
  await api(`/rooms/${host.code}/words`, 'POST', { ...host, words: aWords });
  await api(`/rooms/${host.code}/words`, 'POST', { ...g, words: bWords });
  await new Promise(r => setTimeout(r, 300));
  ok('word counts are broadcast', events[events.length - 1].players.every(p => p.wordCount > 0));

  await api(`/rooms/${host.code}/ready`, 'POST', host);
  const ready = await api(`/rooms/${host.code}/ready`, 'POST', g);
  ok('both ready ends the round early', ready.data.state === 'results');
  await new Promise(r => setTimeout(r, 300));
  const overlap = aWords.filter(w => bWords.includes(w));
  ok(`shared words cancel (${overlap.join(',')})`,
    overlap.every(w => events[events.length - 1].results.cancelled.includes(w)));
  ok('late words are refused',
    (await api(`/rooms/${host.code}/words`, 'POST', { ...host, words: ['CAT'] })).status === 409);
  ok('the host can reset to the lobby',
    (await api(`/rooms/${host.code}/next`, 'POST', host)).data.state === 'lobby');

  ac.abort();
  await stream.catch(() => {});
  await api(`/rooms/${host.code}/leave`, 'POST', g);
  await api(`/rooms/${host.code}/leave`, 'POST', host);
  ok('an empty room is cleaned up', (await api(`/rooms/${host.code}/start`, 'POST', host)).status === 404);

  await api('/players/' + pid, 'DELETE');
  await api('/players/' + skint.data.id, 'DELETE');
  ok('profiles can be deleted', (await api('/players/' + pid)).status === 404);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  return { pass, fail };
}

module.exports = { run };
