'use strict';

const crypto = require('node:crypto');

// The rolled boards, held server-side so scoring never trusts the client: the
// browser is told the letters, but every word it claims is re-walked here
// against the board the server actually rolled.
//
// This lives in its own module because both the single-device routes and the
// room state machine need to put boards in it. Rooms have to stash a board
// *before* they broadcast the round start, or clients receive a null board id
// and every word check 404s.
const boards = new Map();
const TTL_MS = 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;

function stash(built) {
  const id = crypto.randomBytes(12).toString('hex');
  boards.set(id, { ...built, id, createdAt: Date.now(), result: null });
  return boards.get(id);
}

function get(id) {
  return boards.get(String(id || '')) || null;
}

function require_(id) {
  const entry = get(id);
  if (!entry) {
    throw Object.assign(new Error('That board has expired. Start a new round.'), { status: 404 });
  }
  return entry;
}

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, entry] of boards) {
    if (entry.createdAt < cutoff) boards.delete(id);
  }
}

const sweeper = setInterval(sweep, SWEEP_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();

module.exports = {
  stash,
  get,
  require: require_,
  sweep,
  get count() { return boards.size; }
};
