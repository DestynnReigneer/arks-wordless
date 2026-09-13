'use strict';

const { minLength } = require('./solver');

// Standard Boggle scoring. Big Boggle uses the same table but starts at
// four letters, so a 4-letter word is worth 1 point on both boards.
// A word from the active theme pack is worth double. The multiplier is here
// rather than in the dictionary so scoring stays a pure function of the word --
// the caller decides whether it is themed.
const THEME_MULTIPLIER = 2;

function wordPoints(word, spec, min = minLength(spec), { themed = false } = {}) {
  const n = word.length;
  if (n < min) return 0;
  const base = n <= 4 ? 1 : n === 5 ? 2 : n === 6 ? 3 : n === 7 ? 5 : 11;
  return themed ? base * THEME_MULTIPLIER : base;
}

// The rule that makes Boggle Boggle: a word more than one player found is
// worth nothing to anyone. It's why hunting obscure words pays, and it only
// applies when more than one player is in the round.
//
// players: [{ id, name, words: string[] }]
// Returns per-player breakdowns plus the set of cancelled words.
function scoreRound({ players, size, min, validator, isThemed = () => false }) {
  const multi = players.length > 1;
  const counts = new Map();

  const accepted = players.map(p => {
    const seen = new Set();
    const rows = [];
    for (const raw of p.words) {
      const word = String(raw || '').toUpperCase();
      if (seen.has(word)) continue;
      seen.add(word);
      const verdict = validator(word);
      rows.push({ word, ...verdict });
      if (verdict.valid) counts.set(word, (counts.get(word) || 0) + 1);
    }
    return { player: p, rows };
  });

  const cancelled = new Set();
  if (multi) {
    for (const [word, n] of counts) {
      if (n > 1) cancelled.add(word);
    }
  }

  const results = accepted.map(({ player, rows }) => {
    let score = 0;
    let valid = 0;
    let best = null;
    const words = rows.map(row => {
      if (!row.valid) return { ...row, points: 0, cancelled: false };
      const isCancelled = cancelled.has(row.word);
      const themed = isThemed(row.word);
      const points = isCancelled ? 0 : wordPoints(row.word, size, min, { themed });
      score += points;
      valid++;
      if (points > 0 && (!best || points > best.points ||
          (points === best.points && row.word.length > best.word.length))) {
        best = { word: row.word, points };
      }
      return { ...row, points, cancelled: isCancelled, themed };
    });

    words.sort((a, b) => b.points - a.points || a.word.localeCompare(b.word));

    return {
      playerId: player.id,
      name: player.name,
      score,
      wordCount: valid,
      submitted: rows.length,
      best,
      longest: words.filter(w => w.valid).reduce(
        (a, w) => (!a || w.word.length > a.length ? w.word : a), null
      ),
      words
    };
  });

  results.sort((a, b) => b.score - a.score || b.wordCount - a.wordCount);

  let rank = 0;
  let prev = null;
  results.forEach((r, i) => {
    if (prev === null || r.score !== prev) rank = i + 1;
    prev = r.score;
    r.rank = rank;
  });

  return { results, cancelled: [...cancelled].sort() };
}

module.exports = { wordPoints, scoreRound, THEME_MULTIPLIER };
