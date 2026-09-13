'use strict';

const db = require('../db');
const round = require('./round');
const { solve } = require('./solver');

// Streaks, dailies, milestones and coins — the bits that make a kid come back
// tomorrow. Kept apart from the game rules so the scoring stays honest: none
// of this can change what a word is worth, only what you earn around it.

// ---- days -------------------------------------------------------------------

// Local date, not UTC. A 9pm round in Britain should count as today, and
// toISOString() would file it under tomorrow half the year.
function today(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function yesterday(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return today(d);
}

// ---- deterministic daily board ---------------------------------------------

// mulberry32 — small, fast, and stable across Node versions, which matters:
// everyone in the house has to get the same board from the same date.
function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const { rollBoard } = require('./dice');

// The daily is always a 4x4 on the normal ruleset: one fixed shape everyone
// can compare fairly. Re-rolled deterministically until it is worth playing,
// so the seed alone reproduces it anywhere.
function dailyBoard(day = today(), profile = 'kids') {
  const spec = { cols: 4, rows: 4 };
  const min = round.resolveMinLength(spec, 'normal');
  let attempt = 0;
  let board;
  let words;

  do {
    const rng = seededRng(seedFrom(`${day}|${profile}|${attempt}`));
    board = rollBoard(spec, rng);
    words = solve(board, spec, profile, { min });
    attempt++;
  } while (words.size < 35 && attempt < 25);

  return {
    day,
    board,
    cols: spec.cols,
    rows: spec.rows,
    size: 4,
    profile,
    difficulty: 'normal',
    minLength: min,
    totalWords: words.size
  };
}

// ---- milestones -------------------------------------------------------------

// Deliberately a mix: some you get in the first five minutes, some take weeks.
// `check` runs against a snapshot of the player plus the round just played.
const MILESTONES = [
  { code: 'first_game',   label: 'First Shake',      emoji: '🎲', coins: 2,  blurb: 'Play your first round',            check: c => c.games >= 1 },
  { code: 'first_word',   label: 'Word One',         emoji: '✏️', coins: 1,  blurb: 'Find your first word',             check: c => c.wordCount >= 1 },
  { code: 'ten_words',    label: 'Ten in a Round',   emoji: '🔟', coins: 3,  blurb: 'Find ten words in one round',      check: c => c.wordCount >= 10 },
  { code: 'score_50',     label: 'Half Century',     emoji: '🏏', coins: 3,  blurb: 'Score 50 in one round',            check: c => c.score >= 50 },
  { code: 'score_100',    label: 'Ton Up',           emoji: '💯', coins: 6,  blurb: 'Score 100 in one round',           check: c => c.score >= 100 },
  { code: 'word_6',       label: 'Six Shooter',      emoji: '🔫', coins: 2,  blurb: 'Find a six-letter word',           check: c => c.longestWord >= 6 },
  { code: 'word_7',       label: 'Lucky Seven',      emoji: '🍀', coins: 4,  blurb: 'Find a seven-letter word',         check: c => c.longestWord >= 7 },
  { code: 'word_8',       label: 'Big Word Energy',  emoji: '🐘', coins: 10, blurb: 'Find an eight-letter word',        check: c => c.longestWord >= 8 },
  { code: 'streak_3',     label: 'Three Days',       emoji: '🔥', coins: 3,  blurb: 'Play three days running',          check: c => c.streak >= 3 },
  { code: 'streak_7',     label: 'A Full Week',      emoji: '🔥', coins: 8,  blurb: 'Play seven days running',          check: c => c.streak >= 7 },
  { code: 'streak_30',    label: 'A Whole Month',    emoji: '🏆', coins: 30, blurb: 'Play thirty days running',         check: c => c.streak >= 30 },
  { code: 'marathon_3',   label: 'Still Going',      emoji: '🏃', coins: 3,  blurb: 'Reach level 3 in Marathon',        check: c => c.marathonLevel >= 3 },
  { code: 'marathon_6',   label: 'Long Hauler',      emoji: '🚚', coins: 8,  blurb: 'Reach level 6 in Marathon',        check: c => c.marathonLevel >= 6 },
  { code: 'daily_done',   label: 'Daily Dose',       emoji: '📅', coins: 2,  blurb: 'Play a daily challenge',           check: c => c.daily },
  { code: 'games_25',     label: 'Regular',          emoji: '🎯', coins: 5,  blurb: 'Play 25 rounds',                   check: c => c.games >= 25 },
  { code: 'games_100',    label: 'Devoted',          emoji: '🎖️', coins: 20, blurb: 'Play 100 rounds',                  check: c => c.games >= 100 }
];

const MILESTONE_BY_CODE = new Map(MILESTONES.map(m => [m.code, m]));

function catalogue() {
  return MILESTONES.map(({ check, ...rest }) => rest);
}

// ---- coins ------------------------------------------------------------------

// Earned slowly on purpose. A hint costs 2 on Normal, and a decent round pays
// about 4 — so a hint is a real decision, not a default.
function coinsFor({ score, wordCount, streak, daily }) {
  let coins = Math.floor(score / 12);
  if (wordCount >= 10) coins += 1;
  if (daily) coins += 2;
  if (streak >= 3) coins += 1;
  if (streak >= 7) coins += 2;
  return Math.max(0, coins);
}

// ---- the one call a finished round makes ------------------------------------

function nextStreak(player, day) {
  if (!player.lastPlayed) return 1;
  if (player.lastPlayed === day) return Math.max(1, player.streak);     // already played today
  if (player.lastPlayed === yesterday(new Date(`${day}T12:00:00`))) return player.streak + 1;
  return 1;                                                             // streak broken
}

// Records a finished round against a profile: updates the streak, pays out
// coins, awards any newly-earned milestones, and files the daily result.
// Returns everything the results screen needs to celebrate with.
function recordRound(playerId, {
  score = 0,
  wordCount = 0,
  longestWord = '',
  bestWord = '',
  marathonScore = 0,
  marathonLevel = 0,
  daily = false,
  day = today()
} = {}) {
  const player = db.getPlayer(playerId);
  if (!player) return null;

  const streak = nextStreak(player, day);
  const longestStreak = Math.max(player.longestStreak, streak);

  let dailyCounted = false;
  if (daily) {
    dailyCounted = db.recordDaily({
      day, playerId, score, words: wordCount, bestWord: bestWord || longestWord
    });
  }

  const coins = coinsFor({ score, wordCount, streak, daily: dailyCounted });

  const updated = db.applyPlayerRound(playerId, {
    score,
    bestWord: bestWord || longestWord,
    marathonScore,
    coins,
    streak,
    longestStreak,
    day
  });

  // Milestones are checked against the player as they are *after* the round,
  // so "play 25 rounds" fires on the 25th, not the 26th.
  const context = {
    games: updated.games,
    score,
    wordCount,
    longestWord: (longestWord || bestWord || '').length,
    streak,
    marathonLevel,
    daily: dailyCounted
  };

  const earned = [];
  let bonus = 0;
  for (const m of MILESTONES) {
    if (!m.check(context)) continue;
    if (!db.awardMilestone(playerId, m.code)) continue;   // already had it
    earned.push({ code: m.code, label: m.label, emoji: m.emoji, blurb: m.blurb, coins: m.coins });
    bonus += m.coins;
  }
  if (bonus) db.grantCoins(playerId, bonus);

  return {
    player: db.getPlayer(playerId),
    streak,
    streakContinued: streak > 1,
    coinsEarned: coins + bonus,
    coinsFromPlay: coins,
    coinsFromMilestones: bonus,
    milestones: earned,
    dailyCounted
  };
}

function profile(playerId) {
  const player = db.getPlayer(playerId);
  if (!player) return null;
  const earned = new Map(db.listMilestones(playerId).map(m => [m.code, m.earnedAt]));
  return {
    ...player,
    milestones: MILESTONES.map(m => ({
      code: m.code,
      label: m.label,
      emoji: m.emoji,
      blurb: m.blurb,
      coins: m.coins,
      earned: earned.has(m.code),
      earnedAt: earned.get(m.code) || null
    })),
    earnedCount: earned.size,
    milestoneTotal: MILESTONES.length
  };
}

module.exports = {
  today, yesterday, seededRng, seedFrom, dailyBoard,
  MILESTONES, MILESTONE_BY_CODE, catalogue,
  coinsFor, nextStreak, recordRound, profile
};
