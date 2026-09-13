const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Tests get their own database file. Sharing one with the running app made the
// suite non-idempotent -- a second run inherited a full arcade board from the
// first and behaved differently, which is exactly the kind of flake that
// teaches people to ignore red builds.
const DB_FILE = process.env.RAMBLER_DB
  || (process.env.NODE_ENV === 'test' ? 'test.db' : 'wordless.db');
const db = new DatabaseSync(path.join(DATA_DIR, DB_FILE));

db.exec(`
  CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    subject TEXT NOT NULL,
    emoji TEXT NOT NULL,
    accent TEXT NOT NULL,
    bg TEXT NOT NULL,
    font TEXT NOT NULL,
    words TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    initials TEXT NOT NULL,
    score INTEGER NOT NULL,
    theme_id TEXT NOT NULL,
    theme_label TEXT NOT NULL,
    theme_emoji TEXT NOT NULL,
    won INTEGER NOT NULL,
    guesses INTEGER NOT NULL,
    hints_used INTEGER NOT NULL,
    word TEXT NOT NULL,
    elapsed_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Player profiles. Deliberately not accounts: no password, no email, just a
  -- name and an avatar the family picks from a grid. Streaks and coins live
  -- here because they are the things a kid checks between rounds.
  CREATE TABLE IF NOT EXISTS rambler_players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '🙂',
    coins INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    longest_streak INTEGER NOT NULL DEFAULT 0,
    last_played TEXT,
    games INTEGER NOT NULL DEFAULT 0,
    total_score INTEGER NOT NULL DEFAULT 0,
    best_score INTEGER NOT NULL DEFAULT 0,
    best_word TEXT NOT NULL DEFAULT '',
    best_marathon INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One board a day, the same for everyone in the house. The primary key is
  -- what stops a second attempt counting: you get one go at the daily.
  CREATE TABLE IF NOT EXISTS rambler_daily (
    day TEXT NOT NULL,
    player_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    words INTEGER NOT NULL,
    best_word TEXT NOT NULL DEFAULT '',
    profile TEXT NOT NULL DEFAULT 'kids',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (day, player_id)
  );

  CREATE TABLE IF NOT EXISTS rambler_milestones (
    player_id TEXT NOT NULL,
    code TEXT NOT NULL,
    earned_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (player_id, code)
  );

  CREATE INDEX IF NOT EXISTS idx_rambler_daily_day ON rambler_daily (day, score DESC);

  -- A theme pack for Rambler. Unlike a Wordless theme (a list one answer is
  -- drawn from), these words are added to the dictionary so they *score*, and
  -- are flagged so finding one is an event rather than a quiet five points.
  CREATE TABLE IF NOT EXISTS rambler_themes (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    blurb TEXT NOT NULL DEFAULT '',
    emoji TEXT NOT NULL DEFAULT '\u2728',
    audience TEXT NOT NULL DEFAULT 'all',
    accent TEXT NOT NULL DEFAULT '',
    bg TEXT NOT NULL DEFAULT '',
    words TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Words the admin added or removed from the browser. Kept in the database
  -- rather than written back to words/*.txt, because the files live in the
  -- image and an edit there would vanish on the next docker compose pull.
  CREATE TABLE IF NOT EXISTS dictionary_edits (
    word TEXT NOT NULL,
    list TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (word, list)
  );

  -- A season is a run of the arcade board. When one ends the walls clear, but
  -- everything personal -- streaks, coins, milestones, lifetime bests --
  -- carries straight over. Only the walls reset.
  CREATE TABLE IF NOT EXISTS seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    number INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    theme_id TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ends_at TEXT,
    ended_at TEXT
  );

  -- What somebody took home from a season. Written once, when the season
  -- closes, from whatever was standing on the boards at that moment.
  CREATE TABLE IF NOT EXISTS season_badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id INTEGER NOT NULL,
    player_id TEXT,
    initials TEXT NOT NULL,
    board_key TEXT NOT NULL,
    rank INTEGER NOT NULL,
    score INTEGER NOT NULL,
    word_count INTEGER NOT NULL DEFAULT 0,
    best_word TEXT NOT NULL DEFAULT '',
    earned_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_badges_player ON season_badges (player_id, season_id);

  -- Small key/value store for things the admin can change without a redeploy.
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rambler_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    initials TEXT NOT NULL,
    score INTEGER NOT NULL,
    mode TEXT NOT NULL,
    board_size INTEGER NOT NULL,
    profile TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    best_word TEXT NOT NULL DEFAULT '',
    longest_word TEXT NOT NULL DEFAULT '',
    duration_sec INTEGER NOT NULL,
    players INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_rambler_board
    ON rambler_scores (profile, board_size, score DESC);

  CREATE TABLE IF NOT EXISTS theme_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    requested_by TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    fulfilled_theme_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    fulfilled_at TEXT
  );
`);

// ---- migrations ----
// CREATE TABLE IF NOT EXISTS will not add a column to a table that already
// exists, so anything added after the first release needs doing by hand.
function ensureColumn(table, column, declaration) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  return true;
}

// The arcade board is partitioned by shape of game, not by dictionary: 4x4,
// 5x5 and Marathon. The two dictionaries differ by about 300 words in 172,000,
// which is a fraction of a word per board -- not enough to justify splitting
// the wall in half and leaving both halves empty.
if (ensureColumn('rambler_scores', 'board_key', "TEXT NOT NULL DEFAULT ''")) {
  db.prepare(`
    UPDATE rambler_scores
    SET board_key = CASE WHEN mode = 'marathon' THEN 'marathon' ELSE CAST(board_size AS TEXT) END
  `).run();
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_arcade_board ON rambler_scores (board_key, score DESC);`);

// Which profile was playing when a score went up. Without it a season badge
// has nowhere to land -- the board only ever knew the three letters someone
// typed, not whose account they were on.
ensureColumn('rambler_scores', 'player_id', 'TEXT');

// Which season a score belongs to, so a board can be rebuilt after the fact.
ensureColumn('rambler_scores', 'season_id', 'INTEGER');

// Which dictionary somebody played the daily on. Everyone gets the same
// letters, but the unfiltered list is wider, so an adult's 55 and a kid's 40
// are not the same achievement. The standings say which was which instead of
// quietly ranking them against each other.
ensureColumn('rambler_daily', 'profile', "TEXT NOT NULL DEFAULT 'kids'");

const FONT_STACKS = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  comic: '"Comic Sans MS", "Chalkboard SE", cursive',
  mono: '"Courier New", monospace',
  fantasy: 'Papyrus, fantasy'
};

const BUILTIN_THEMES = [
  {
    id: 'classic', label: 'Classic', subject: 'word', emoji: '🔤',
    accent: '#7dd3fc', bg: '#0f1115', font: FONT_STACKS.sans,
    words: [
      "apple","brave","chair","dance","eagle","flame","grape","house","input","jolly",
      "knife","lemon","mango","noble","ocean","piano","quiet","river","sugar","table",
      "unity","vivid","wheat","yield","zebra","actor","bloom","crisp","dream",
      "elbow","fable","glide","habit","ideal","joker","kneel","lucky","mirth","nudge",
      "orbit","pluck","quilt","reign","stark","tiger","urban","vault","waltz","yacht",
      "zesty","amber","brisk","cider","dusty","frost","grain","honey","irony",
      "jumbo","koala","latch","mossy","nifty","olive","pearl","quirk","rusty","solid",
      "trove","vigor","witty","adobe","blend","charm","dwell","early","fancy","gusty"
    ]
  },
  {
    id: 'simpsons', label: 'The Simpsons', subject: 'Simpsons character or thing', emoji: '🍩',
    accent: '#facc15', bg: '#171203', font: FONT_STACKS.comic,
    words: [
      "homer","marge","bart","lisa","maggie","krusty","milhouse","nelson","skinner",
      "wiggum","burns","smithers","flanders","barney","patty","selma","comic","ralph",
      "edna","willie","duffman","bobo","maude","lenny","carl","cletus","frink",
      "hibbert","apu","moe","otto","troy","itchy","kang","kodos","duff","springfield"
    ]
  },
  {
    id: 'dune', label: 'Dune', subject: 'Dune name or term', emoji: '🏜️',
    accent: '#e0813f', bg: '#140f0a', font: FONT_STACKS.serif,
    words: [
      "paul","leto","chani","duncan","stilgar","gurney","baron","feyd","fremen",
      "arrakis","kynes","irulan","alia","thufir","hawat","yueh","piter","spice",
      "sietch","worm","sandworm","mentat","shield","desert","house","shaddam",
      "corrino","caladan","giedi","atreides","bene","gesserit","navigator","guild"
    ]
  }
];

function seedBuiltinThemes() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO themes (id, label, subject, emoji, accent, bg, font, words, builtin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  for (const t of BUILTIN_THEMES) {
    insert.run(t.id, t.label, t.subject, t.emoji, t.accent, t.bg, t.font, JSON.stringify(t.words));
  }
}
seedBuiltinThemes();

function rowToTheme(row) {
  return {
    id: row.id,
    label: row.label,
    subject: row.subject,
    emoji: row.emoji,
    accent: row.accent,
    bg: row.bg,
    font: row.font,
    words: JSON.parse(row.words),
    builtin: !!row.builtin
  };
}

function listThemes() {
  const rows = db.prepare('SELECT * FROM themes ORDER BY builtin DESC, created_at ASC').all();
  return rows.map(rowToTheme);
}

function getTheme(id) {
  const row = db.prepare('SELECT * FROM themes WHERE id = ?').get(id);
  return row ? rowToTheme(row) : null;
}

function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 24) || 'theme';
}

function createTheme({ label, subject, emoji, accent, bg, fontKey, words }) {
  const base = slugify(label);
  let id = base;
  let n = 1;
  while (getTheme(id)) {
    id = `${base}-${++n}`;
  }
  const font = FONT_STACKS[fontKey] || FONT_STACKS.sans;
  db.prepare(`
    INSERT INTO themes (id, label, subject, emoji, accent, bg, font, words, builtin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, label, subject, emoji, accent, bg, font, JSON.stringify(words));
  return getTheme(id);
}

function deleteTheme(id) {
  const theme = getTheme(id);
  if (!theme || theme.builtin) return false;
  db.prepare('DELETE FROM themes WHERE id = ?').run(id);
  return true;
}

const SCORING = {
  BASE: 1000,
  GUESS_PENALTY: 120,
  HINT_PENALTY: 150,
  SPEED_BONUS_MAX: 300,
  SPEED_BONUS_PER_SEC: 3
};

function computeScore({ won, guesses, hintsUsed, elapsedMs }) {
  if (!won) return 0;
  const guessPenalty = Math.max(0, guesses - 1) * SCORING.GUESS_PENALTY;
  const hintPenalty = Math.max(0, hintsUsed) * SCORING.HINT_PENALTY;
  const elapsedSec = Math.max(0, elapsedMs) / 1000;
  const speedBonus = Math.max(0, Math.round(SCORING.SPEED_BONUS_MAX - elapsedSec * SCORING.SPEED_BONUS_PER_SEC));
  const raw = SCORING.BASE - guessPenalty - hintPenalty + speedBonus;
  return Math.max(0, Math.round(raw / 10) * 10);
}

function insertScore({ initials, themeId, won, guesses, hintsUsed, word, elapsedMs }) {
  const theme = getTheme(themeId);
  const score = computeScore({ won, guesses, hintsUsed, elapsedMs });
  const info = db.prepare(`
    INSERT INTO scores (initials, score, theme_id, theme_label, theme_emoji, won, guesses, hints_used, word, elapsed_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    initials,
    score,
    themeId,
    theme ? theme.label : 'Unknown',
    theme ? theme.emoji : '❓',
    won ? 1 : 0,
    guesses,
    hintsUsed,
    word,
    elapsedMs
  );
  const rank = db.prepare('SELECT COUNT(*) AS c FROM scores WHERE score > ?').get(score).c + 1;
  return { id: info.lastInsertRowid, score, rank };
}

function listLeaderboard({ themeId, limit }) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  let rows;
  if (themeId && themeId !== 'all') {
    rows = db.prepare(`
      SELECT * FROM scores WHERE theme_id = ? ORDER BY score DESC, created_at ASC LIMIT ?
    `).all(themeId, cap);
  } else {
    rows = db.prepare(`
      SELECT * FROM scores ORDER BY score DESC, created_at ASC LIMIT ?
    `).all(cap);
  }
  return rows.map(r => ({
    id: r.id,
    initials: r.initials,
    score: r.score,
    themeId: r.theme_id,
    themeLabel: r.theme_label,
    themeEmoji: r.theme_emoji,
    won: !!r.won,
    guesses: r.guesses,
    hintsUsed: r.hints_used,
    word: r.word,
    elapsedMs: r.elapsed_ms,
    createdAt: r.created_at
  }));
}

function createThemeRequest({ topic, note, requestedBy }) {
  const info = db.prepare(`
    INSERT INTO theme_requests (topic, note, requested_by)
    VALUES (?, ?, ?)
  `).run(topic, note, requestedBy);
  return getThemeRequest(info.lastInsertRowid);
}

function getThemeRequest(id) {
  const row = db.prepare('SELECT * FROM theme_requests WHERE id = ?').get(id);
  return row ? rowToRequest(row) : null;
}

function rowToRequest(row) {
  return {
    id: row.id,
    topic: row.topic,
    note: row.note,
    requestedBy: row.requested_by,
    status: row.status,
    fulfilledThemeId: row.fulfilled_theme_id,
    createdAt: row.created_at,
    fulfilledAt: row.fulfilled_at
  };
}

function listThemeRequests(status) {
  let rows;
  if (status && status !== 'all') {
    rows = db.prepare('SELECT * FROM theme_requests WHERE status = ? ORDER BY created_at DESC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM theme_requests ORDER BY created_at DESC').all();
  }
  return rows.map(rowToRequest);
}

function dismissThemeRequest(id) {
  const info = db.prepare(`UPDATE theme_requests SET status = 'dismissed' WHERE id = ? AND status = 'pending'`).run(id);
  return info.changes > 0;
}

function fulfillThemeRequest(id, themeId) {
  const info = db.prepare(`
    UPDATE theme_requests
    SET status = 'fulfilled', fulfilled_theme_id = ?, fulfilled_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(themeId, id);
  return info.changes > 0;
}

// ---- Rambler ----
// Kept on its own table and indexed by (profile, board_size) so the kids'
// 4x4 board and an unfiltered 5x5 board never share a leaderboard -- the
// scores simply aren't comparable.

function insertRamblerScore({ initials, score, mode, boardSize, profile, wordCount, bestWord, longestWord, durationSec, players }) {
  const info = db.prepare(`
    INSERT INTO rambler_scores
      (initials, score, mode, board_size, profile, word_count, best_word, longest_word, duration_sec, players)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    initials, score, mode, boardSize, profile, wordCount,
    bestWord || '', longestWord || '', durationSec, players || 1
  );
  const rank = mode === 'marathon'
    ? db.prepare(`
        SELECT COUNT(*) AS c FROM rambler_scores
        WHERE profile = ? AND mode = 'marathon' AND score > ?
      `).get(profile, score).c + 1
    : db.prepare(`
        SELECT COUNT(*) AS c FROM rambler_scores
        WHERE profile = ? AND board_size = ? AND mode != 'marathon' AND score > ?
      `).get(profile, boardSize, score).c + 1;
  return { id: info.lastInsertRowid, score, rank };
}

// Marathon boards grow, so board_size means nothing for that mode -- it is
// filtered by mode instead, and the two never share a table view.
function listRamblerLeaderboard({ profile, boardSize, mode, limit }) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const rows = mode === 'marathon'
    ? db.prepare(`
        SELECT * FROM rambler_scores
        WHERE profile = ? AND mode = 'marathon'
        ORDER BY score DESC, word_count DESC, created_at ASC
        LIMIT ?
      `).all(profile, cap)
    : db.prepare(`
        SELECT * FROM rambler_scores
        WHERE profile = ? AND board_size = ? AND mode != 'marathon'
        ORDER BY score DESC, word_count DESC, created_at ASC
        LIMIT ?
      `).all(profile, boardSize, cap);
  return rows.map(r => ({
    id: r.id,
    initials: r.initials,
    score: r.score,
    mode: r.mode,
    boardSize: r.board_size,
    profile: r.profile,
    wordCount: r.word_count,
    bestWord: r.best_word,
    longestWord: r.longest_word,
    durationSec: r.duration_sec,
    players: r.players,
    createdAt: r.created_at
  }));
}

// ---- Rambler theme packs ----

function rowToTheme(r) {
  if (!r) return null;
  let words = [];
  try { words = JSON.parse(r.words); } catch { words = []; }
  return {
    id: r.id,
    label: r.label,
    blurb: r.blurb,
    emoji: r.emoji,
    audience: r.audience,
    accent: r.accent || '',
    bg: r.bg || '',
    words,
    wordCount: words.length,
    builtin: !!r.builtin,
    createdAt: r.created_at
  };
}

function listRamblerThemes() {
  return db.prepare('SELECT * FROM rambler_themes ORDER BY created_at ASC').all().map(rowToTheme);
}

function getRamblerTheme(id) {
  return rowToTheme(db.prepare('SELECT * FROM rambler_themes WHERE id = ?').get(String(id || '')));
}

function themeSlug(label) {
  return String(label).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 28) || 'theme';
}

function createRamblerTheme({ label, blurb, emoji, audience, accent, bg, words }) {
  const base = themeSlug(label);
  let id = base;
  let n = 1;
  while (getRamblerTheme(id)) id = `${base}-${++n}`;

  db.prepare(`
    INSERT INTO rambler_themes (id, label, blurb, emoji, audience, accent, bg, words)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, label, blurb || '', emoji || '\u2728', audience || 'all',
    accent || '', bg || '', JSON.stringify(words));
  return getRamblerTheme(id);
}

function updateRamblerTheme(id, patch) {
  const t = getRamblerTheme(id);
  if (!t) return null;
  db.prepare(`
    UPDATE rambler_themes SET label = ?, blurb = ?, emoji = ?, audience = ?,
      accent = ?, bg = ?, words = ? WHERE id = ?
  `).run(
    patch.label === undefined ? t.label : patch.label,
    patch.blurb === undefined ? t.blurb : patch.blurb,
    patch.emoji === undefined ? t.emoji : patch.emoji,
    patch.audience === undefined ? t.audience : patch.audience,
    patch.accent === undefined ? t.accent : patch.accent,
    patch.bg === undefined ? t.bg : patch.bg,
    JSON.stringify(patch.words === undefined ? t.words : patch.words),
    id
  );
  return getRamblerTheme(id);
}

function deleteRamblerTheme(id) {
  // Any season pointing at it loses the reference rather than dangling.
  db.prepare('UPDATE seasons SET theme_id = NULL WHERE theme_id = ?').run(id);
  return db.prepare('DELETE FROM rambler_themes WHERE id = ?').run(id).changes > 0;
}

// ---- runtime dictionary edits ----

function listDictionaryEdits(list = null) {
  const rows = list
    ? db.prepare('SELECT * FROM dictionary_edits WHERE list = ? ORDER BY word ASC').all(list)
    : db.prepare('SELECT * FROM dictionary_edits ORDER BY list ASC, word ASC').all();
  return rows.map(r => ({ word: r.word, list: r.list, createdAt: r.created_at }));
}

function addDictionaryEdit(word, list) {
  const w = String(word || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (w.length < 3) return null;
  db.prepare('INSERT OR IGNORE INTO dictionary_edits (word, list) VALUES (?, ?)').run(w, list);
  return { word: w, list };
}

function removeDictionaryEdit(word, list) {
  const w = String(word || '').toUpperCase().replace(/[^A-Z]/g, '');
  return db.prepare('DELETE FROM dictionary_edits WHERE word = ? AND list = ?').run(w, list).changes > 0;
}

// ---- settings ----
// Deliberately a key/value table rather than columns: the admin page adds
// knobs faster than a schema should change, and none of these are queried.

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(value));
  return value;
}

function allSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

// ---- seasons ----

function rowToSeason(r) {
  if (!r) return null;
  return {
    id: r.id,
    year: r.year,
    number: r.number,
    name: r.name,
    themeId: r.theme_id,
    startedAt: r.started_at,
    endsAt: r.ends_at,
    endedAt: r.ended_at,
    label: r.name || `${r.year} Season ${r.number}`
  };
}

function currentSeason() {
  return rowToSeason(
    db.prepare('SELECT * FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get()
  );
}

function listSeasons(limit = 24) {
  return db.prepare('SELECT * FROM seasons ORDER BY id DESC LIMIT ?').all(limit).map(rowToSeason);
}

function getSeason(id) {
  return rowToSeason(db.prepare('SELECT * FROM seasons WHERE id = ?').get(id));
}

function startSeason({ endsAt = null, name = '', themeId = null } = {}) {
  const year = new Date().getFullYear();
  const last = db.prepare('SELECT MAX(number) AS n FROM seasons WHERE year = ?').get(year);
  const number = (last && last.n ? last.n : 0) + 1;
  const info = db.prepare(`
    INSERT INTO seasons (year, number, name, theme_id, ends_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(year, number, name || '', themeId, endsAt);
  return getSeason(info.lastInsertRowid);
}

function updateSeason(id, { endsAt, name, themeId }) {
  const season = getSeason(id);
  if (!season) return null;
  db.prepare('UPDATE seasons SET ends_at = ?, name = ?, theme_id = ? WHERE id = ?').run(
    endsAt === undefined ? season.endsAt : endsAt,
    name === undefined ? season.name : name,
    themeId === undefined ? season.themeId : themeId,
    id
  );
  return getSeason(id);
}

// Freezes the boards into badges, then wipes them. Everything personal is
// untouched on purpose: a streak that survived a month should survive the
// month ending.
function closeSeason(seasonId, boards) {
  const season = getSeason(seasonId);
  if (!season || season.endedAt) return null;

  const minted = [];
  for (const key of boards) {
    const rows = db.prepare(`
      SELECT * FROM rambler_scores WHERE board_key = ?
      ORDER BY score DESC, created_at ASC LIMIT ?
    `).all(key, ARCADE_SLOTS);

    rows.forEach((r, i) => {
      db.prepare(`
        INSERT INTO season_badges
          (season_id, player_id, initials, board_key, rank, score, word_count, best_word)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(seasonId, r.player_id || null, r.initials, key, i + 1, r.score, r.word_count, r.best_word || '');
      minted.push({ initials: r.initials, boardKey: key, rank: i + 1, score: r.score });
    });
  }

  db.prepare('DELETE FROM rambler_scores').run();
  db.prepare("UPDATE seasons SET ended_at = datetime('now') WHERE id = ?").run(seasonId);
  return { season: getSeason(seasonId), minted };
}

function badgesForPlayer(playerId) {
  return db.prepare(`
    SELECT b.*, s.year, s.number, s.name
    FROM season_badges b JOIN seasons s ON s.id = b.season_id
    WHERE b.player_id = ?
    ORDER BY b.season_id DESC, b.rank ASC
  `).all(playerId).map(r => ({
    seasonId: r.season_id,
    seasonLabel: r.name || `${r.year} Season ${r.number}`,
    year: r.year,
    number: r.number,
    initials: r.initials,
    boardKey: r.board_key,
    rank: r.rank,
    score: r.score,
    wordCount: r.word_count,
    bestWord: r.best_word
  }));
}

function badgesForSeason(seasonId) {
  return db.prepare(`
    SELECT * FROM season_badges WHERE season_id = ?
    ORDER BY board_key ASC, rank ASC
  `).all(seasonId).map(r => ({
    playerId: r.player_id,
    initials: r.initials,
    boardKey: r.board_key,
    rank: r.rank,
    score: r.score,
    wordCount: r.word_count,
    bestWord: r.best_word
  }));
}

function deleteArcadeEntry(id) {
  return db.prepare('DELETE FROM rambler_scores WHERE id = ?').run(id).changes > 0;
}

function clearArcadeBoard(boardKey) {
  return db.prepare('DELETE FROM rambler_scores WHERE board_key = ?').run(String(boardKey)).changes;
}

// ---- Rambler: the arcade board ----
//
// A real cabinet keeps ten slots and nothing else. You get to type your
// initials only by knocking someone off, and when you do, they are gone.
// That scarcity is the entire point -- an unbounded table that merely
// displays its top 25 has nothing at stake.

const ARCADE_SLOTS = 10;
const ARCADE_BOARDS = ['4', '5', 'marathon'];

function boardKeyFor(mode, boardSize) {
  if (mode === 'marathon') return 'marathon';
  return String(boardSize) === '5' ? '5' : '4';
}

function rowToArcade(r) {
  return {
    id: r.id,
    initials: r.initials,
    score: r.score,
    mode: r.mode,
    boardKey: r.board_key,
    boardSize: r.board_size,
    profile: r.profile,
    playerId: r.player_id,
    wordCount: r.word_count,
    bestWord: r.best_word,
    longestWord: r.longest_word,
    durationSec: r.duration_sec,
    players: r.players,
    createdAt: r.created_at
  };
}

function listArcadeBoard(boardKey, limit = ARCADE_SLOTS) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || ARCADE_SLOTS, 1), ARCADE_SLOTS);
  return db.prepare(`
    SELECT * FROM rambler_scores
    WHERE board_key = ?
    ORDER BY score DESC, created_at ASC
    LIMIT ?
  `).all(String(boardKey), cap).map(rowToArcade);
}

// Where a score would place, and whether that is good enough to get on.
// Ties go to whoever got there first, exactly like a cabinet: you have to
// beat the tenth score, not match it.
function arcadeStanding(boardKey, score) {
  const key = String(boardKey);
  const filled = db.prepare('SELECT COUNT(*) AS c FROM rambler_scores WHERE board_key = ?').get(key).c;
  const better = db.prepare(
    'SELECT COUNT(*) AS c FROM rambler_scores WHERE board_key = ? AND score >= ?'
  ).get(key, score).c;

  const rank = better + 1;
  const lowest = db.prepare(`
    SELECT score FROM rambler_scores WHERE board_key = ?
    ORDER BY score DESC, created_at ASC LIMIT 1 OFFSET ?
  `).get(key, ARCADE_SLOTS - 1);
  const cutoff = lowest ? lowest.score : 0;

  return {
    boardKey: key,
    rank,
    filled,
    slots: ARCADE_SLOTS,
    cutoff,
    makesBoard: score > 0 && (filled < ARCADE_SLOTS || score > cutoff),
    shortBy: filled < ARCADE_SLOTS ? 0 : Math.max(0, cutoff - score + 1)
  };
}

// Inserts, then trims the board back to its ten slots. Returns who fell off,
// because "you knocked ROB off the board" is the whole feeling.
function insertArcadeScore(entry) {
  const boardKey = boardKeyFor(entry.mode, entry.boardSize);
  const standing = arcadeStanding(boardKey, entry.score);
  // Report the score either way: the caller asked what happened to *this*
  // score, and omitting it on a miss makes the answer harder to use.
  if (!standing.makesBoard) return { made: false, score: entry.score, ...standing };

  const season = currentSeason();
  const info = db.prepare(`
    INSERT INTO rambler_scores
      (initials, score, mode, board_size, board_key, profile, word_count,
       best_word, longest_word, duration_sec, players, player_id, season_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.initials, entry.score, entry.mode, entry.boardSize, boardKey,
    entry.profile, entry.wordCount, entry.bestWord || '', entry.longestWord || '',
    entry.durationSec, entry.players || 1,
    entry.playerId || null, season ? season.id : null
  );

  const evicted = db.prepare(`
    SELECT * FROM rambler_scores WHERE board_key = ?
    ORDER BY score DESC, created_at ASC LIMIT -1 OFFSET ?
  `).all(boardKey, ARCADE_SLOTS).map(rowToArcade);

  for (const row of evicted) {
    db.prepare('DELETE FROM rambler_scores WHERE id = ?').run(row.id);
  }

  return {
    made: true,
    id: info.lastInsertRowid,
    score: entry.score,
    boardKey,
    // The standing taken *before* the insert is already the slot this entry
    // lands in -- it counted everything scoring at least as much, and ties go
    // to the incumbent. Re-querying afterwards counts this row itself and
    // reports one place too low.
    rank: standing.rank,
    evicted: evicted.map(e => ({ initials: e.initials, score: e.score }))
  };
}

// ---- Rambler: players, streaks, dailies, milestones ----

function rowToPlayer(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, avatar: r.avatar, coins: r.coins,
    streak: r.streak, longestStreak: r.longest_streak, lastPlayed: r.last_played,
    games: r.games, totalScore: r.total_score, bestScore: r.best_score,
    bestWord: r.best_word, bestMarathon: r.best_marathon, createdAt: r.created_at
  };
}

function listPlayers() {
  return db.prepare('SELECT * FROM rambler_players ORDER BY created_at ASC').all().map(rowToPlayer);
}

function getPlayer(id) {
  return rowToPlayer(db.prepare('SELECT * FROM rambler_players WHERE id = ?').get(String(id || '')));
}

function createPlayer({ id, name, avatar }) {
  db.prepare('INSERT INTO rambler_players (id, name, avatar) VALUES (?, ?, ?)').run(id, name, avatar);
  return getPlayer(id);
}

function updatePlayer(id, { name, avatar }) {
  const p = getPlayer(id);
  if (!p) return null;
  db.prepare('UPDATE rambler_players SET name = ?, avatar = ? WHERE id = ?')
    .run(name || p.name, avatar || p.avatar, id);
  return getPlayer(id);
}

function deletePlayer(id) {
  const info = db.prepare('DELETE FROM rambler_players WHERE id = ?').run(id);
  db.prepare('DELETE FROM rambler_milestones WHERE player_id = ?').run(id);
  db.prepare('DELETE FROM rambler_daily WHERE player_id = ?').run(id);
  return info.changes > 0;
}

// One statement so a round either lands completely or not at all. MAX() keeps
// personal bests monotonic without a read-modify-write race between two kids
// finishing on different devices at the same moment.
function applyPlayerRound(id, { score, bestWord, marathonScore, coins, streak, longestStreak, day }) {
  const p = getPlayer(id);
  if (!p) return null;
  db.prepare(`
    UPDATE rambler_players SET
      games = games + 1,
      total_score = total_score + ?,
      best_score = MAX(best_score, ?),
      best_marathon = MAX(best_marathon, ?),
      best_word = CASE WHEN LENGTH(?) > LENGTH(best_word) THEN ? ELSE best_word END,
      coins = MAX(0, coins + ?),
      streak = ?,
      longest_streak = ?,
      last_played = ?
    WHERE id = ?
  `).run(
    score, score, marathonScore || 0,
    bestWord || '', bestWord || '',
    coins, streak, longestStreak, day, id
  );
  return getPlayer(id);
}

// Guarded in SQL rather than in JS: the WHERE clause is what prevents a
// double-tap on the hint button spending coins that aren't there.
function spendCoins(id, amount) {
  const info = db.prepare('UPDATE rambler_players SET coins = coins - ? WHERE id = ? AND coins >= ?')
    .run(amount, id, amount);
  return info.changes > 0 ? getPlayer(id) : null;
}

function grantCoins(id, amount) {
  db.prepare('UPDATE rambler_players SET coins = coins + ? WHERE id = ?').run(amount, id);
  return getPlayer(id);
}

function listMilestones(playerId) {
  return db.prepare('SELECT code, earned_at FROM rambler_milestones WHERE player_id = ?')
    .all(playerId).map(r => ({ code: r.code, earnedAt: r.earned_at }));
}

function awardMilestone(playerId, code) {
  const info = db.prepare('INSERT OR IGNORE INTO rambler_milestones (player_id, code) VALUES (?, ?)')
    .run(playerId, code);
  return info.changes > 0;
}

function getDailyResult(day, playerId) {
  const r = db.prepare('SELECT * FROM rambler_daily WHERE day = ? AND player_id = ?').get(day, playerId);
  return r ? {
    day: r.day, playerId: r.player_id, score: r.score,
    words: r.words, bestWord: r.best_word, profile: r.profile || 'kids'
  } : null;
}

function recordDaily({ day, playerId, score, words, bestWord, profile = 'kids' }) {
  const info = db.prepare(`
    INSERT OR IGNORE INTO rambler_daily (day, player_id, score, words, best_word, profile)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(day, playerId, score, words, bestWord || '', profile);
  return info.changes > 0;
}

function listDaily(day) {
  return db.prepare(`
    SELECT d.*, p.name, p.avatar FROM rambler_daily d
    LEFT JOIN rambler_players p ON p.id = d.player_id
    WHERE d.day = ? ORDER BY d.score DESC, d.created_at ASC
  `).all(day).map((r, i) => ({
    rank: i + 1,
    playerId: r.player_id, name: r.name || 'Unknown', avatar: r.avatar || '🙂',
    score: r.score, words: r.words, bestWord: r.best_word, profile: r.profile || 'kids'
  }));
}

module.exports = {
  FONT_STACKS,
  listThemes,
  getTheme,
  createTheme,
  deleteTheme,
  computeScore,
  insertScore,
  listLeaderboard,
  createThemeRequest,
  listThemeRequests,
  dismissThemeRequest,
  fulfillThemeRequest,
  insertRamblerScore,
  listRamblerLeaderboard,
  ARCADE_SLOTS,
  ARCADE_BOARDS,
  listRamblerThemes,
  getRamblerTheme,
  createRamblerTheme,
  updateRamblerTheme,
  deleteRamblerTheme,
  listDictionaryEdits,
  addDictionaryEdit,
  removeDictionaryEdit,
  getSetting,
  setSetting,
  allSettings,
  currentSeason,
  listSeasons,
  getSeason,
  startSeason,
  updateSeason,
  closeSeason,
  badgesForPlayer,
  badgesForSeason,
  deleteArcadeEntry,
  clearArcadeBoard,
  boardKeyFor,
  listArcadeBoard,
  arcadeStanding,
  insertArcadeScore,
  listPlayers,
  getPlayer,
  createPlayer,
  updatePlayer,
  deletePlayer,
  applyPlayerRound,
  spendCoins,
  grantCoins,
  listMilestones,
  awardMilestone,
  getDailyResult,
  recordDaily,
  listDaily
};
