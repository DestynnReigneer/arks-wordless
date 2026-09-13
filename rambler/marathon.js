'use strict';

const crypto = require('node:crypto');
const { growBoard, rollBoard, dims, SIDES } = require('./dice');
const { solve } = require('./solver');
const { wordPoints } = require('./scoring');
const round = require('./round');

// Marathon: you start on a small board with a short clock, and every word you
// find buys you more time. Find enough and the grid grows a row, opening
// letters that weren't reachable a moment ago. You never "win" — you last.
//
// The clock lives here, not in the browser. The client renders a countdown
// from `endsAt`, but the server is what decides when you are out of time, so
// editing the page can't buy you a second.

const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const GRACE_MS = 1500;          // forgive the latency on a word sent as time expires

// How much a word is worth in seconds. Deliberately steeper than the points
// table: a seven-letter word should feel like a reprieve, not a rounding error.
const TIME_BONUS = { 3: 3, 4: 5, 5: 8, 6: 12, 7: 18, 8: 25 };

const START = {
  easy:   { cols: 4, rows: 4, seconds: 150, growEvery: 4, maxCells: 49 },
  normal: { cols: 4, rows: 4, seconds: 100, growEvery: 5, maxCells: 49 },
  hard:   { cols: 4, rows: 4, seconds: 70,  growEvery: 6, maxCells: 42 }
};

function secondsFor(word) {
  return TIME_BONUS[Math.min(8, word.length)] || TIME_BONUS[8];
}

function startFor(difficultyId) {
  return START[difficultyId] || START.normal;
}

function create({ profile = 'kids', difficulty = 'normal' } = {}) {
  sweep();
  const diff = round.difficultyOf(difficulty);
  const start = startFor(diff.id);
  const spec = dims({ cols: start.cols, rows: start.rows });

  const built = round.createBoard({
    cols: spec.cols,
    rows: spec.rows,
    profile,
    difficulty: diff.id
  });

  const now = Date.now();
  const session = {
    id: crypto.randomBytes(12).toString('hex'),
    profile,
    difficulty: diff.id,
    board: built.board,
    cols: spec.cols,
    rows: spec.rows,
    minLength: built.minLength,
    found: [],                 // [{ word, points, seconds }]
    score: 0,
    level: 1,
    grows: 0,
    hintsUsed: 0,
    revealed: [],              // words handed over by a hint, so they can't be re-claimed for points
    startedAt: now,
    endsAt: now + start.seconds * 1000,
    createdAt: now,
    over: false,
    growEvery: start.growEvery,
    maxCells: start.maxCells
  };
  sessions.set(session.id, session);
  return session;
}

function fail(message, status) {
  return Object.assign(new Error(message), { status });
}

function get(id) {
  const s = sessions.get(String(id || ''));
  if (!s) throw fail('That run has expired. Start a new one.', 404);
  return s;
}

function timeLeft(session) {
  return session.endsAt - Date.now();
}

// A run ends the moment the clock runs out, whether or not anyone asks. This
// is checked on every interaction rather than on a timer, because nothing has
// to happen at the exact instant a solo run finishes.
function settle(session) {
  if (!session.over && timeLeft(session) <= -GRACE_MS) {
    session.over = true;
    session.endedAt = session.endsAt;
  }
  return session;
}

function spec(session) {
  return { cols: session.cols, rows: session.rows };
}

function submit(sessionId, raw) {
  const session = settle(get(sessionId));
  if (session.over) throw fail('Time is up.', 409);

  const word = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (session.found.some(f => f.word === word)) {
    return { ...view(session), valid: false, word, reason: 'already found' };
  }

  const verdict = round.validateWord(
    session.board, spec(session), session.profile, word, session.minLength
  );
  if (!verdict.valid) {
    return { ...view(session), valid: false, word, reason: verdict.reason };
  }

  // A word the player was handed by a hint still counts for time, but not for
  // points — otherwise coins convert straight into score.
  const wasHinted = session.revealed.includes(word);
  const points = wasHinted ? 0 : wordPoints(word, spec(session), session.minLength);
  const seconds = secondsFor(word);

  session.found.push({ word, points, seconds, path: verdict.path });
  session.score += points;
  session.endsAt += seconds * 1000;

  const grew = maybeGrow(session);

  return {
    ...view(session),
    valid: true,
    word,
    reason: null,
    points,
    seconds,
    hinted: wasHinted,
    path: verdict.path,
    grew
  };
}

// Grow after every Nth word, on a random side, until the grid hits its cap.
// The whole board is re-sent when this happens: growing on the top or left
// shifts every existing index, so patching in place would be a bug farm.
function maybeGrow(session) {
  const due = Math.floor(session.found.length / session.growEvery);
  if (due <= session.grows) return null;
  if (session.cols * session.rows >= session.maxCells) return null;

  const side = SIDES[crypto.randomInt(SIDES.length)];
  const grown = growBoard(session.board, spec(session), side);
  session.board = grown.board;
  session.cols = grown.cols;
  session.rows = grown.rows;
  session.grows++;
  session.level++;

  // Words already found stay found, but their old paths point at cells that
  // have moved, so drop the paths rather than render a lie.
  for (const f of session.found) f.path = null;

  return { side, cols: grown.cols, rows: grown.rows, level: session.level };
}

// Spend a hint: hand over the highest-scoring word still on the board that the
// player hasn't found. Costs coins, which the route layer deducts.
function hint(sessionId) {
  const session = settle(get(sessionId));
  if (session.over) throw fail('Time is up.', 409);

  const all = solve(session.board, spec(session), session.profile, { min: session.minLength });
  const taken = new Set([...session.found.map(f => f.word), ...session.revealed]);

  const candidates = [...all.keys()]
    .filter(w => !taken.has(w))
    .sort((a, b) =>
      wordPoints(b, spec(session), session.minLength) - wordPoints(a, spec(session), session.minLength) ||
      b.length - a.length);

  if (!candidates.length) throw fail('Nothing left to find on this board.', 409);

  // Not the single best word -- that hands over an 11-pointer for two coins.
  // Something from the top of the pile, so it still feels like a real leg-up.
  const word = candidates[crypto.randomInt(Math.min(5, candidates.length))];
  session.revealed.push(word);
  session.hintsUsed++;

  return { ...view(session), word, path: all.get(word) };
}

function finish(sessionId) {
  const session = settle(get(sessionId));
  session.over = true;

  const diff = round.difficultyOf(session.difficulty);
  const finalScore = Math.round(session.score * diff.scoreMultiplier);
  const longest = session.found.reduce((a, f) => (f.word.length > a.length ? f.word : a), '');
  const best = session.found.reduce((a, f) => (!a || f.points > a.points ? f : a), null);

  return {
    ...view(session),
    finalScore,
    rawScore: session.score,
    multiplier: diff.scoreMultiplier,
    longest,
    best: best ? { word: best.word, points: best.points } : null,
    survivedMs: (session.endedAt || Date.now()) - session.startedAt,
    words: [...session.found].sort((a, b) => b.points - a.points || a.word.localeCompare(b.word))
  };
}

// What the client is allowed to see. Never the solved board.
function view(session) {
  return {
    id: session.id,
    board: session.board,
    cols: session.cols,
    rows: session.rows,
    minLength: session.minLength,
    profile: session.profile,
    difficulty: session.difficulty,
    score: session.score,
    level: session.level,
    grows: session.grows,
    hintsUsed: session.hintsUsed,
    wordCount: session.found.length,
    nextGrowIn: Math.max(0, (session.grows + 1) * session.growEvery - session.found.length),
    endsAt: session.endsAt,
    serverNow: Date.now(),
    over: session.over,
    found: session.found.map(f => ({ word: f.word, points: f.points, seconds: f.seconds }))
  };
}

function sweep() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id);
  }
}

const sweeper = setInterval(sweep, 15 * 60 * 1000);
if (typeof sweeper.unref === 'function') sweeper.unref();

module.exports = {
  TIME_BONUS, START,
  create, get, submit, hint, finish, view, settle, sweep,
  get count() { return sessions.size; }
};
