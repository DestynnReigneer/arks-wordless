'use strict';

const crypto = require('node:crypto');
const round = require('./round');
const boards = require('./boards');

// Rooms are deliberately in-memory only. A room is worth less than the three
// minutes it lasts, so there is nothing here worth surviving a restart --
// only finished results go to SQLite.
const rooms = new Map();

const MAX_PLAYERS = 8;
const MAX_ROOMS = 200;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;
const GRACE_MS = 2500;          // allow for latency on words sent as the timer dies
const HEARTBEAT_MS = 25000;

// No O/0 or I/1 -- these get read aloud across a room.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const makeToken = () => crypto.randomBytes(24).toString('hex');
const makePlayerId = () => crypto.randomBytes(8).toString('hex');

function cleanName(raw, fallback) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 16);
  return name || fallback;
}

function touch(room) {
  room.lastActivity = Date.now();
}

function fail(message, status) {
  return Object.assign(new Error(message), { status });
}

// ---- snapshots -------------------------------------------------------------

// What a given player is allowed to see. The board stays hidden until the
// round starts, and nobody sees another player's actual words until the
// results are in -- only how many they have found.
function snapshot(room, forPlayerId) {
  const me = room.players.get(forPlayerId);
  return {
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    youAreHost: room.hostId === forPlayerId,
    you: me ? { id: me.id, name: me.name } : null,
    settings: room.settings,
    board: room.state === 'lobby' ? null : room.board,
    boardId: room.state === 'lobby' ? null : room.boardId,
    minLength: room.minLength,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    serverNow: Date.now(),
    maxPlayers: MAX_PLAYERS,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
      connected: p.clients > 0,
      wordCount: p.words.length,
      ready: p.ready
    })),
    results: room.results
  };
}

function send(client, event, payload) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // Broken pipe -- the close handler and the sweep will clear it up.
  }
}

function broadcast(room) {
  for (const client of room.clients) {
    send(client, 'state', snapshot(room, client.playerId));
  }
}

// ---- lifecycle -------------------------------------------------------------

function normaliseSettings({ size, profile, durationSec }) {
  const s = round.SIZES.includes(Number(size)) ? Number(size) : 4;
  const p = profile === 'adult' ? 'adult' : 'kids';
  const d = round.DURATIONS.includes(Number(durationSec)) ? Number(durationSec) : round.DEFAULT_DURATION;
  return { size: s, profile: p, durationSec: d };
}

function addPlayer(room, rawName) {
  const taken = new Set([...room.players.values()].map(p => p.name.toLowerCase()));
  let name = cleanName(rawName, `Player ${room.players.size + 1}`);
  if (taken.has(name.toLowerCase())) {
    let n = 2;
    while (taken.has(`${name} ${n}`.toLowerCase())) n++;
    name = `${name} ${n}`;
  }
  const player = {
    id: makePlayerId(),
    token: makeToken(),
    name,
    words: [],
    ready: false,
    clients: 0,
    joinedAt: Date.now()
  };
  room.players.set(player.id, player);
  touch(room);
  return player;
}

function createRoom({ hostName, size, profile, durationSec }) {
  if (rooms.size >= MAX_ROOMS) {
    sweep();
    if (rooms.size >= MAX_ROOMS) throw fail('Too many rooms open right now.', 503);
  }

  const room = {
    code: makeCode(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    state: 'lobby',
    settings: normaliseSettings({ size, profile, durationSec }),
    board: null,
    boardId: null,
    minLength: null,
    totalWords: 0,
    startedAt: null,
    endsAt: null,
    players: new Map(),
    clients: new Set(),
    results: null,
    timer: null,
    hostId: null,
    onFinish: null
  };
  rooms.set(room.code, room);

  const host = addPlayer(room, hostName || 'Host');
  room.hostId = host.id;
  return { room, player: host };
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase()) || null;
}

function requireRoom(code) {
  const room = getRoom(code);
  if (!room) throw fail('No room with that code.', 404);
  return room;
}

function authenticate(room, id, suppliedToken) {
  const player = room.players.get(String(id || ''));
  if (!player || !suppliedToken || player.token !== String(suppliedToken)) {
    throw fail('Not a member of this room.', 403);
  }
  return player;
}

function requireHost(room, player) {
  if (room.hostId !== player.id) throw fail('Only the host can do that.', 403);
}

function joinRoom(code, name) {
  const room = requireRoom(code);
  if (room.players.size >= MAX_PLAYERS) {
    throw fail(`Room is full (${MAX_PLAYERS} players).`, 409);
  }
  const player = addPlayer(room, name);
  broadcast(room);
  return { room, player };
}

function leaveRoom(code, id, suppliedToken) {
  const room = requireRoom(code);
  const player = authenticate(room, id, suppliedToken);
  room.players.delete(player.id);

  if (room.players.size === 0) {
    closeRoom(room);
    return;
  }
  // Host walked out mid-game; hand the room to whoever has been here longest.
  if (room.hostId === player.id) {
    room.hostId = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0].id;
  }
  touch(room);
  broadcast(room);
}

function updateSettings(code, id, suppliedToken, settings) {
  const room = requireRoom(code);
  const player = authenticate(room, id, suppliedToken);
  requireHost(room, player);
  if (room.state === 'playing') throw fail('Round in progress.', 409);

  room.settings = normaliseSettings({ ...room.settings, ...settings });
  touch(room);
  broadcast(room);
  return room;
}

function startRound(code, id, suppliedToken) {
  const room = requireRoom(code);
  const player = authenticate(room, id, suppliedToken);
  requireHost(room, player);
  if (room.state === 'playing') throw fail('Round already running.', 409);

  const built = round.createBoard({ size: room.settings.size, profile: room.settings.profile });

  // Stash before the broadcast below, not after. Clients move to the playing
  // screen on that SSE event and immediately start checking words against
  // this id -- publishing the state first would hand them a null one.
  room.board = built.board;
  room.boardId = boards.stash(built).id;
  room.minLength = built.minLength;
  room.totalWords = built.totalWords;
  room.state = 'playing';
  room.results = null;
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + room.settings.durationSec * 1000;

  for (const p of room.players.values()) {
    p.words = [];
    p.ready = false;
  }

  clearTimeout(room.timer);
  room.timer = setTimeout(() => finishRound(room), room.settings.durationSec * 1000 + GRACE_MS);
  touch(room);
  broadcast(room);
  return room;
}

// Clients post their whole found-list each time they find something, so a
// dropped request is simply corrected by the next one, and nothing is lost
// if a phone dies before the timer runs out.
function submitWords(code, id, suppliedToken, words) {
  const room = requireRoom(code);
  const player = authenticate(room, id, suppliedToken);
  if (room.state !== 'playing') throw fail('No round in progress.', 409);
  if (Date.now() > room.endsAt + GRACE_MS) throw fail('Time is up.', 409);

  const list = Array.isArray(words) ? words : [];
  const seen = new Set();
  const clean = [];
  for (const raw of list.slice(0, 400)) {
    const w = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 25);
    if (w && !seen.has(w)) {
      seen.add(w);
      clean.push(w);
    }
  }
  player.words = clean;
  touch(room);
  broadcast(room);
  return { accepted: clean.length };
}

function markReady(code, id, suppliedToken) {
  const room = requireRoom(code);
  const player = authenticate(room, id, suppliedToken);
  player.ready = true;
  touch(room);

  // Everyone has stopped early -- no reason to make them watch the clock.
  if (room.state === 'playing' && [...room.players.values()].every(p => p.ready)) {
    finishRound(room);
  } else {
    broadcast(room);
  }
  return room;
}

function finishRound(room) {
  if (room.state !== 'playing') return;
  clearTimeout(room.timer);
  room.timer = null;
  room.state = 'results';

  const players = [...room.players.values()].map(p => ({ id: p.id, name: p.name, words: p.words }));
  room.results = round.scoreSubmissions({
    board: room.board,
    size: room.settings.size,
    profile: room.settings.profile,
    players
  });
  room.results.board = room.board;
  room.results.size = room.settings.size;
  room.results.profile = room.settings.profile;
  room.results.durationSec = room.settings.durationSec;

  touch(room);
  broadcast(room);

  if (typeof room.onFinish === 'function') {
    try {
      room.onFinish(room);
    } catch (e) {
      console.error('shaker room onFinish failed:', e.message);
    }
  }
}

function resetToLobby(code, id, suppliedToken) {
  const room = requireRoom(code);
  const player = authenticate(room, id, suppliedToken);
  requireHost(room, player);

  room.state = 'lobby';
  room.board = null;
  room.boardId = null;
  room.results = null;
  room.startedAt = null;
  room.endsAt = null;
  for (const p of room.players.values()) {
    p.words = [];
    p.ready = false;
  }
  touch(room);
  broadcast(room);
  return room;
}

// ---- SSE -------------------------------------------------------------------

function subscribe(code, id, suppliedToken, res) {
  const room = requireRoom(code);
  const player = authenticate(room, id, suppliedToken);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx buffers event streams by default, which makes the whole feature
    // look broken behind a reverse proxy. This turns that off.
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');

  const client = { playerId: player.id, res };
  room.clients.add(client);
  player.clients++;

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // closed
    }
  }, HEARTBEAT_MS);

  send(client, 'state', snapshot(room, player.id));
  broadcast(room);

  const close = () => {
    clearInterval(heartbeat);
    if (room.clients.delete(client)) {
      player.clients = Math.max(0, player.clients - 1);
      touch(room);
      broadcast(room);
    }
  };
  res.on('close', close);
  res.on('error', close);
}

// ---- housekeeping ----------------------------------------------------------

function closeRoom(room) {
  clearTimeout(room.timer);
  for (const client of room.clients) {
    try {
      client.res.end();
    } catch {
      // already gone
    }
  }
  room.clients.clear();
  rooms.delete(room.code);
}

function sweep() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const room of [...rooms.values()]) {
    if (room.lastActivity < cutoff || (room.players.size === 0 && room.clients.size === 0)) {
      closeRoom(room);
    }
  }
}

const sweeper = setInterval(sweep, SWEEP_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();

module.exports = {
  MAX_PLAYERS,
  createRoom, joinRoom, leaveRoom, getRoom, requireRoom, authenticate,
  updateSettings, startRound, submitWords, markReady, finishRound,
  resetToLobby, subscribe, snapshot, sweep,
  get count() { return rooms.size; },
  _rooms: rooms
};
