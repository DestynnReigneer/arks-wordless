'use strict';

const { rollBoard, findPath, dims, cellCount } = require('./dice');
const dictionary = require('./dictionary');
const { solve, minLength } = require('./solver');
const { scoreRound, wordPoints } = require('./scoring');

const SIZES = [4, 5];

// Timers go up to ten minutes on purpose. Three minutes is the box rule, but
// it is genuinely miserable for a seven-year-old — and for plenty of adults
// four drinks in. Short options stay for anyone who wants the real thing.
const DURATIONS = [60, 90, 120, 180, 240, 300, 360, 480, 600];
const DEFAULT_DURATION = 180;

// Difficulty bundles the things that actually change how hard a board is:
// how long a word has to be, how long you get, and how densely packed the
// board is allowed to be before it gets re-rolled.
const DIFFICULTIES = {
  easy: {
    id: 'easy',
    label: 'Easy',
    blurb: 'Three-letter words count, roomy timer, richer boards',
    minLength: 3,
    minWords: { 16: 70, 25: 150 },
    durationBonus: 120,
    hintCost: 1,
    scoreMultiplier: 0.8
  },
  normal: {
    id: 'normal',
    label: 'Normal',
    blurb: 'The box rules',
    minLength: null,          // fall back to the board's own minimum
    minWords: { 16: 35, 25: 80 },
    durationBonus: 0,
    hintCost: 2,
    scoreMultiplier: 1
  },
  hard: {
    id: 'hard',
    label: 'Hard',
    blurb: 'Four letters minimum, leaner boards, less time',
    minLength: 4,
    minWords: { 16: 20, 25: 50 },
    durationBonus: -30,
    hintCost: 4,
    scoreMultiplier: 1.35
  }
};

const DEFAULT_DIFFICULTY = 'normal';

function difficultyOf(id) {
  return DIFFICULTIES[id] || DIFFICULTIES[DEFAULT_DIFFICULTY];
}

// Resolve the word-length floor once, at board creation, and carry it on the
// round from then on. Deriving it later would mean a Marathon board that grew
// past 16 cells suddenly rejecting the three-letter words it just accepted.
function resolveMinLength(spec, difficultyId) {
  const diff = difficultyOf(difficultyId);
  return diff.minLength || minLength(spec);
}

const MAX_ROLLS = 25;

// How many of the active theme's words a board should contain before it is
// considered worth playing. One, not two: measured on random boards, a short
// theme word is reachable about a quarter of the time, so insisting on two
// would mean nearly every board falls back to the best near-miss.
const THEME_WORD_FLOOR = 1;

// Themed boards get a bigger roll budget. Solving costs about a millisecond,
// so spending 120 of them to find a board that actually wears the theme is
// cheaper than the disappointment of one that does not.
const MAX_THEME_ROLLS = 120;

function qualityFloor(spec, difficultyId) {
  const cells = cellCount(spec);
  const table = difficultyOf(difficultyId).minWords;
  return cells <= 16 ? table[16] : table[25];
}

// A board with barely any words in it is a miserable three minutes. Solving
// costs about a millisecond, so we can simply roll again until we get one
// worth playing.
function createBoard({ size = 4, cols, rows, profile = 'kids', difficulty = DEFAULT_DIFFICULTY } = {}) {
  const spec = cols && rows
    ? dims({ cols, rows })
    : dims(SIZES.includes(Number(size)) ? Number(size) : 4);

  const min = resolveMinLength(spec, difficulty);
  const floor = qualityFloor(spec, difficulty);

  // With a theme pack on, a board is only worth playing if some of the theme
  // is actually reachable on it -- otherwise "Halloween season" is a label
  // with nothing behind it. Solving costs about a millisecond, so we can keep
  // rolling and simply take the best board we saw if none is ideal.
  const themed = !!dictionary.activeTheme();
  const themeFloor = themed ? THEME_WORD_FLOOR : 0;

  let board = null;
  let words = null;
  let themeHits = 0;
  let rolls = 0;
  let best = null;

  do {
    board = rollBoard(spec);
    words = solve(board, spec, profile, { min });
    themeHits = themed
      ? [...words.keys()].filter(w => dictionary.isThemeWord(w)).length
      : 0;
    rolls++;

    const good = words.size >= floor && themeHits >= themeFloor;
    if (good) { best = null; break; }
    // Keep whichever near-miss was closest, so a pack with rare letters
    // degrades to "the best board we could find" instead of a random one.
    const rank = Math.min(words.size, floor) + themeHits * 25;
    if (!best || rank > best.rank) best = { board, words, themeHits, rank };
  } while (rolls < (themed ? MAX_THEME_ROLLS : MAX_ROLLS));

  if (best) {
    board = best.board;
    words = best.words;
    themeHits = best.themeHits;
  }

  return {
    board,
    cols: spec.cols,
    rows: spec.rows,
    size: spec.cols === spec.rows ? spec.cols : null,
    profile,
    difficulty: difficultyOf(difficulty).id,
    minLength: min,
    totalWords: words.size,
    themeWords: themeHits,
    rolls
  };
}

// The server never trusts a path drawn by the client. Every claimed word is
// re-walked on the real board here, so a tampered front-end can't invent one.
function validateWord(board, spec, profile, raw, min = minLength(spec)) {
  const word = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '');

  if (word.length < min) return { valid: false, reason: `under ${min} letters` };
  if (!dictionary.isWord(word, profile)) return { valid: false, reason: 'not a word' };

  const path = findPath(board, spec, word);
  if (!path) return { valid: false, reason: 'not on the board' };

  return { valid: true, reason: null, path };
}

function makeValidator(board, spec, profile, min) {
  const cache = new Map();
  return word => {
    if (!cache.has(word)) cache.set(word, validateWord(board, spec, profile, word, min));
    return cache.get(word);
  };
}

// Everything a results screen needs: per-player scoring, plus what nobody
// found. For kids we show only common words — the full solver output is
// mostly things like AALII and ZAX, which teaches nothing and reads as noise.
function scoreSubmissions({ board, size, cols, rows, profile, difficulty, minLength: min, players }) {
  const spec = cols && rows ? dims({ cols, rows }) : dims(size);
  const floor = min || resolveMinLength(spec, difficulty);

  const scored = scoreRound({
    players,
    size: spec,
    min: floor,
    validator: makeValidator(board, spec, profile, floor),
    isThemed: w => dictionary.isThemeWord(w)
  });

  const all = solve(board, spec, profile, { min: floor });
  const claimed = new Set();
  for (const r of scored.results) {
    for (const w of r.words) if (w.valid) claimed.add(w.word);
  }

  const missed = [];
  for (const word of all.keys()) {
    if (claimed.has(word)) continue;
    if (profile === 'kids' && !dictionary.isCommon(word)) continue;
    const themed = dictionary.isThemeWord(word);
    missed.push({ word, points: wordPoints(word, spec, floor, { themed }), themed });
  }
  // Theme words first in the reveal: they are the point of the season.
  missed.sort((a, b) => (b.themed ? 1 : 0) - (a.themed ? 1 : 0)
    || b.points - a.points || a.word.localeCompare(b.word));

  // Naming DISEUSE as the best word on a kids board is no use to a child --
  // and it contradicts the reveal, which deliberately hides words like that.
  // So the headline word comes from the same pool they are actually shown.
  const pool = [...all.keys()].filter(w => profile !== 'kids' || dictionary.isCommon(w));
  const best = pool
    .map(w => ({ word: w, points: wordPoints(w, spec, floor, { themed: dictionary.isThemeWord(w) }) }))
    .sort((a, b) => b.points - a.points || b.word.length - a.word.length)[0] || null;

  return {
    ...scored,
    cols: spec.cols,
    rows: spec.rows,
    minLength: floor,
    totalWords: all.size,
    bestPossible: best,
    missed: missed.slice(0, 60),
    missedTotal: missed.length
  };
}

function pathFor(board, spec, word) {
  return findPath(board, spec, String(word || '').toUpperCase());
}

module.exports = {
  SIZES, DURATIONS, DEFAULT_DURATION, THEME_WORD_FLOOR,
  DIFFICULTIES, DEFAULT_DIFFICULTY, difficultyOf, resolveMinLength,
  createBoard, validateWord, scoreSubmissions, pathFor
};
