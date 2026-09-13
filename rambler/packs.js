'use strict';

const db = require('../db');
const dictionary = require('./dictionary');

// Connects the database to the dictionary. The dictionary itself knows nothing
// about themes or admin edits -- it takes an overlay and rebuilds. This module
// decides what that overlay should be and when to re-apply it.
//
// A theme pack does four things:
//   1. its words become valid, so ENDERMAN actually scores;
//   2. they are flagged, so finding one is an event rather than a quiet +5;
//   3. boards are re-rolled until they genuinely contain some of them;
//   4. the season wears its colours.
// This file owns 1 and 2; round.js does 3; the client does 4.

// The theme the current season is wearing, if any.
function seasonTheme() {
  const season = db.currentSeason();
  if (!season || !season.themeId) return null;
  return db.getRamblerTheme(season.themeId);
}

function buildOverlay() {
  const edits = db.listDictionaryEdits();
  const theme = seasonTheme();
  return {
    block: edits.filter(e => e.list === 'block').map(e => e.word),
    allow: edits.filter(e => e.list === 'allow').map(e => e.word),
    adult: edits.filter(e => e.list === 'adult').map(e => e.word),
    theme: theme ? { id: theme.id, words: theme.words, audience: theme.audience } : null
  };
}

let lastSignature = null;

// Re-applies the overlay. Rebuilding the trie costs about 200ms, so it only
// happens when the inputs have actually changed -- this is safe to call on
// every admin write and on a schedule without thinking about it.
function refresh({ force = false } = {}) {
  const overlay = buildOverlay();
  const signature = JSON.stringify([
    overlay.block, overlay.allow, overlay.adult,
    overlay.theme ? [overlay.theme.id, overlay.theme.words.length, overlay.theme.audience] : null
  ]);

  if (!force && signature === lastSignature) return { changed: false, theme: overlay.theme };
  lastSignature = signature;
  dictionary.applyOverlay(overlay);
  return { changed: true, theme: overlay.theme };
}

function active() {
  const theme = seasonTheme();
  if (!theme) return null;
  return {
    id: theme.id,
    label: theme.label,
    blurb: theme.blurb,
    emoji: theme.emoji,
    accent: theme.accent,
    bg: theme.bg,
    audience: theme.audience,
    wordCount: theme.wordCount
    // Deliberately not the word list: handing the client every theme word
    // would turn the hunt into a lookup.
  };
}

// The prompt an admin copies into any chatbot to generate a pack. Same flow as
// the Wordless themes: no API key, no cost, no abuse surface, and the admin
// reads what comes back before it goes anywhere near the game.
function promptFor({ topic, audience = 'all', count = 60 }) {
  const tone = audience === 'kids'
    ? 'Keep it suitable for children: nothing sexual, violent, or profane.'
    : audience === 'adult'
      ? 'This pack is for an adults-only mode, so crude and rude words are fine. No slurs targeting race, sexuality, or disability.'
      : 'Keep it broadly family-friendly.';

  return [
    `Generate a word pack for a Boggle-style word game about: ${topic}.`,
    '',
    'MOST IMPORTANT RULE -- keep the words SHORT.',
    'The words have to be findable on a 4x4 grid of random letter dice.',
    'Measured on real boards: a 3-4 letter word turns up on about 1 board in 4,',
    'a 5-6 letter word on about 1 in 300, and a 7+ letter word essentially',
    'never. A pack of long names looks great in a list and never appears in',
    'the game. So:',
    '- At least two thirds of the words must be 3 to 5 letters.',
    '- Include 6-8 letter words only where they are iconic enough to be worth',
    '  the rarity.',
    '- Nothing longer than 9 letters.',
    '',
    'Other rules:',
    `- Between 40 and ${count} words.`,
    '- Letters A-Z only. One word per entry: no spaces, hyphens, apostrophes,',
    '  numbers or accents. Split or drop anything that needs them.',
    '- Proper nouns and invented words from the subject ARE wanted (character',
    '  names, places, items, creatures) -- that is the point of the pack.',
    '- Prefer common letters. A word full of Q, X, Z or J will almost never',
    '  appear on a dice board.',
    '- No duplicates. Uppercase.',
    `- ${tone}`,
    '',
    'Reply with nothing but JSON in exactly this shape:',
    '{',
    `  "label": "${topic}",`,
    '  "blurb": "one short sentence describing the pack",',
    '  "emoji": "a single emoji",',
    `  "audience": "${audience}",`,
    '  "accent": "#RRGGBB hex that suits the subject",',
    '  "words": ["WORD", "ANOTHER", "..."]',
    '}'
  ].join('\n');
}

// Validates what the admin pastes back. Deliberately strict: this text came
// from a chatbot via a clipboard, so it is treated as untrusted input.
function parsePack(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw Object.assign(new Error('That is not valid JSON.'), { status: 400 });
    }
  }
  if (!data || typeof data !== 'object') {
    throw Object.assign(new Error('Expected a JSON object.'), { status: 400 });
  }

  const label = String(data.label || '').trim().slice(0, 40);
  if (!label) throw Object.assign(new Error('The pack needs a label.'), { status: 400 });

  const seen = new Set();
  const words = [];
  for (const raw of Array.isArray(data.words) ? data.words : []) {
    // Trimming and uppercasing is fine; stripping punctuation out of the
    // middle is not -- "bad word!" would become BADWORD, which nobody asked
    // for. Anything that is not a single run of letters is dropped.
    const w = String(raw || '').trim().toUpperCase();
    if (!/^[A-Z]{3,14}$/.test(w) || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
  }
  if (words.length < 5) {
    throw Object.assign(new Error('Need at least 5 usable words (A-Z only, 3-14 letters).'), { status: 400 });
  }

  const audience = ['kids', 'adult', 'all'].includes(data.audience) ? data.audience : 'all';
  const accent = /^#[0-9a-fA-F]{6}$/.test(data.accent || '') ? data.accent : '';

  return {
    label,
    blurb: String(data.blurb || '').trim().slice(0, 120),
    emoji: String(data.emoji || '✨').trim().slice(0, 8) || '✨',
    audience,
    accent,
    bg: /^#[0-9a-fA-F]{6}$/.test(data.bg || '') ? data.bg : '',
    words,
    skipped: (Array.isArray(data.words) ? data.words.length : 0) - words.length
  };
}

// Estimates how often a board will contain at least one of a pack's words, by
// rolling sample boards and solving them. Reported at ingest so an admin can
// see that their beautiful pack of nine-letter names will never actually
// appear, and go back for shorter words.
function reachability(words, samples = 160) {
  const dice = require('./dice');
  const spec = { cols: 4, rows: 4 };
  let hits = 0;
  const byLength = {};

  for (const w of words) {
    const bucket = w.length <= 4 ? 'short' : w.length <= 6 ? 'medium' : 'long';
    byLength[bucket] = (byLength[bucket] || 0) + 1;
  }

  // Walks each word on the board directly rather than solving it. The pack
  // being measured is usually not in the dictionary yet -- that is the whole
  // point of ingesting it -- so asking the solver would report every invented
  // word as unreachable. What matters here is geometry: can these letters be
  // traced on this grid at all.
  for (let i = 0; i < samples; i++) {
    const board = dice.rollBoard(4);
    for (const w of words) {
      if (dice.findPath(board, spec, w)) { hits++; break; }
    }
  }

  const percent = Math.round((hits / samples) * 100);
  return {
    percent,
    samples,
    byLength: {
      short: byLength.short || 0,
      medium: byLength.medium || 0,
      long: byLength.long || 0
    },
    verdict: percent >= 15 ? 'good'
      : percent >= 5 ? 'thin'
        : 'poor'
  };
}

module.exports = { refresh, active, seasonTheme, buildOverlay, promptFor, parsePack, reachability };
