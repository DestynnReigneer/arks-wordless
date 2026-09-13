'use strict';

const { neighbours, cellCount } = require('./dice');
const dictionary = require('./dictionary');

const { TERM, PRE } = dictionary;

// Big Boggle raises the minimum to four letters — past 16 dice, three-letter
// words are too easy to be worth anything.
//
// Note this is derived from the board at creation time and then carried on the
// round: a Marathon board that grows past 16 cells must NOT silently start
// rejecting the three-letter words it was accepting a moment earlier.
function minLength(spec) {
  return cellCount(spec) > 16 ? 4 : 3;
}

// Walks every path on the board against the trie, pruning the moment a
// prefix can't lead to a word in this profile. Returns a Map of word -> path.
//
// This is the same routine that powers the end-of-round reveal and the
// board-quality check at roll time, so it has to stay fast: about 1ms for
// a 4x4 board and 2ms for 5x5.
function solve(board, spec, profileId, { min = minLength(spec) } = {}) {
  const { root } = dictionary.load();
  const bit = dictionary.profileBit(profileId);
  const adj = neighbours(spec);
  const used = new Array(board.length).fill(false);
  const found = new Map();
  const path = [];

  function walk(cell, node) {
    let next = node;
    for (const ch of board[cell]) {
      next = next[ch];
      if (!next || (next[PRE] & bit) === 0) return;
    }
    used[cell] = true;
    path.push(cell);

    if (((next[TERM] || 0) & bit) !== 0) {
      let word = '';
      for (const c of path) word += board[c];
      if (word.length >= min && !found.has(word)) found.set(word, path.slice());
    }
    for (const n of adj[cell]) {
      if (!used[n]) walk(n, next);
    }

    used[cell] = false;
    path.pop();
  }

  for (let i = 0; i < board.length; i++) walk(i, root);
  return found;
}

function solveWords(board, spec, profileId, opts) {
  return [...solve(board, spec, profileId, opts).keys()];
}

module.exports = { solve, solveWords, minLength };
