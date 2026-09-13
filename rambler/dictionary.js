'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WORDS_DIR = path.join(__dirname, '..', 'words');

// Profile bits. A single trie holds every word; each node records which
// profiles it belongs to, so kids and adults share one structure instead
// of paying for two ~170k-word copies.
const KIDS = 1;
const ADULT = 2;

const PROFILES = {
  kids: { id: 'kids', bit: KIDS, label: 'Kids', blurb: 'Rude words removed' },
  adult: { id: 'adult', bit: ADULT, label: 'Unfiltered', blurb: 'Everything, plus slang' }
};

// Trie node keys: letters are A-Z, so these two can never collide.
const TERM = '_';   // bitmask of profiles for which this node ends a word
const PRE = '$';    // bitmask of profiles reachable anywhere below this node

function readList(file, { optional = false } = {}) {
  const full = path.join(WORDS_DIR, file);
  if (!fs.existsSync(full)) {
    if (optional) return [];
    throw new Error(
      `Missing word list: ${full}\n` +
      `Word lists ship with the repo — see words/README.md if this is a fresh checkout.`
    );
  }
  return fs.readFileSync(full, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

// Words layered on top of the files at runtime: admin edits, and the active
// theme pack. Kept as plain data here rather than read from the database, so
// this module stays a pure dictionary and the caller decides what is active.
let overlay = {
  block: [],          // removed from the kids list
  allow: [],          // rescued from the blocklist
  adult: [],          // added to the unfiltered list
  theme: null         // { id, words, audience }
};

function applyOverlay(next = {}) {
  overlay = {
    block: next.block || [],
    allow: next.allow || [],
    adult: next.adult || [],
    theme: next.theme || null
  };
  cache = null;       // rebuilt lazily on the next read
  return overlay;
}

function activeTheme() {
  return overlay.theme;
}

const CLEAN = /^[A-Z]+$/;
function normalise(list, minLength) {
  const out = [];
  for (const raw of list) {
    const w = raw.toUpperCase();
    if (w.length >= minLength && CLEAN.test(w)) out.push(w);
  }
  return out;
}

// The blocklist is stored as base words so it stays human-editable. Listing
// "wank" has to block wanks/wanked/wanking/wanker too, so expand here rather
// than making someone maintain every inflection by hand.
function inflect(word) {
  const forms = new Set([word]);
  const last = word[word.length - 1];
  const stem = word.slice(0, -1);

  forms.add(word + 'S');
  forms.add(word + 'ES');
  forms.add(word + 'ED');
  forms.add(word + 'ING');
  forms.add(word + 'ER');
  forms.add(word + 'ERS');
  forms.add(word + 'Y');

  if (last === 'E') {
    forms.add(stem + 'ED');
    forms.add(stem + 'ING');
    forms.add(stem + 'ER');
    forms.add(stem + 'ERS');
    forms.add(word + 'D');
  }
  if (last === 'Y') {
    forms.add(stem + 'IES');
    forms.add(stem + 'IED');
    forms.add(stem + 'IER');
  }
  // Doubled final consonant: shit -> shitted, shitting, shitter.
  if (!'AEIOU'.includes(last) && word.length >= 3 && 'AEIOU'.includes(word[word.length - 2])) {
    const dbl = word + last;
    forms.add(dbl + 'ED');
    forms.add(dbl + 'ING');
    forms.add(dbl + 'ER');
    forms.add(dbl + 'ERS');
    forms.add(dbl + 'Y');
  }
  return forms;
}

function buildTrie() {
  const root = { [PRE]: 0 };

  function insert(word, mask) {
    let node = root;
    node[PRE] |= mask;
    for (const ch of word) {
      let next = node[ch];
      if (!next) next = node[ch] = { [PRE]: 0 };
      next[PRE] |= mask;
      node = next;
    }
    node[TERM] = (node[TERM] || 0) | mask;
  }

  const base = normalise(readList('enable1.txt'), 3);

  // Expand the blocklist, then keep only forms that are really in ENABLE1 —
  // no point carrying entries that could never have matched anyway.
  const baseSet = new Set(base);
  const blocked = new Set();
  const blockSources = [...normalise(readList('blocklist-kids.txt'), 3), ...normalise(overlay.block, 3)];
  for (const word of blockSources) {
    for (const form of inflect(word)) {
      if (baseSet.has(form)) blocked.add(form);
    }
  }

  // The allowlist wins. Inflecting blocklist stems always catches innocent
  // bystanders -- "heroin" produces HEROINES, "bonk" produces BONKERS -- and
  // wrongly rejecting a real word is the exact frustration this dictionary
  // split exists to prevent.
  for (const word of [...normalise(readList('allowlist-kids.txt', { optional: true }), 3),
                     ...normalise(overlay.allow, 3)]) {
    blocked.delete(word);
  }

  for (const word of base) {
    insert(word, blocked.has(word) ? ADULT : KIDS | ADULT);
  }

  const supplement = [
    ...normalise(readList('supplement-adult.txt'), 3),
    ...normalise(overlay.adult, 3)
  ];
  for (const word of supplement) insert(word, ADULT);

  // The active theme pack. Its words are inserted so they genuinely score,
  // and remembered separately so finding one can be made an event.
  const themeWords = new Set();
  if (overlay.theme) {
    const audience = overlay.theme.audience || 'all';
    const bits = audience === 'kids' ? KIDS | ADULT
      : audience === 'adult' ? ADULT
        : KIDS | ADULT;
    for (const word of normalise(overlay.theme.words || [], 3)) {
      insert(word, bits);
      themeWords.add(word);
    }
  }

  // Common words drive the kids' end-of-round reveal. Showing a child every
  // word the solver found means a wall of ZAX and AALII; showing only the
  // common ones means they learn something.
  const common = new Set();
  for (const word of normalise(readList('common-10k.txt', { optional: true }), 3)) {
    if (baseSet.has(word) && !blocked.has(word)) common.add(word);
  }

  return {
    root,
    common,
    themeWords,
    stats: {
      base: base.length,
      blocked: blocked.size,
      supplement: supplement.length,
      common: common.size,
      themeWords: themeWords.size,
      themeId: overlay.theme ? overlay.theme.id : null,
      kids: base.length - blocked.size,
      adult: base.length + supplement.length
    }
  };
}

let cache = null;
function load() {
  if (!cache) {
    const t0 = Date.now();
    cache = buildTrie();
    cache.stats.buildMs = Date.now() - t0;
  }
  return cache;
}

function profileBit(profileId) {
  const p = PROFILES[profileId];
  if (!p) throw new Error(`Unknown dictionary profile: ${profileId}`);
  return p.bit;
}

// Walks the trie instead of keeping a parallel Set — same answer, no second
// copy of 170k strings in memory.
function isWord(word, profileId) {
  const bit = profileBit(profileId);
  let node = load().root;
  for (const ch of word.toUpperCase()) {
    node = node[ch];
    if (!node) return false;
  }
  return ((node[TERM] || 0) & bit) !== 0;
}

function isCommon(word) {
  return load().common.has(word.toUpperCase());
}

// Is this one of the active theme pack's words? Drives the bonus and the
// celebration -- a themed word should never land as a quiet five points.
function isThemeWord(word) {
  return load().themeWords.has(String(word || '').toUpperCase());
}

function listProfiles() {
  const { stats } = load();
  return Object.values(PROFILES).map(p => ({
    id: p.id,
    label: p.label,
    blurb: p.blurb,
    words: p.id === 'kids' ? stats.kids : stats.adult
  }));
}

module.exports = {
  KIDS, ADULT, TERM, PRE, PROFILES,
  load, isWord, isCommon, isThemeWord, listProfiles, profileBit,
  applyOverlay, activeTheme,
  get stats() { return load().stats; }
};
