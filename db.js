const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'wordless.db'));

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
  CREATE TABLE IF NOT EXISTS shaker_players (
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
  CREATE TABLE IF NOT EXISTS shaker_daily (
    day TEXT NOT NULL,
    player_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    words INTEGER NOT NULL,
    best_word TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (day, player_id)
  );

  CREATE TABLE IF NOT EXISTS shaker_milestones (
    player_id TEXT NOT NULL,
    code TEXT NOT NULL,
    earned_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (player_id, code)
  );

  CREATE INDEX IF NOT EXISTS idx_shaker_daily_day ON shaker_daily (day, score DESC);

  CREATE TABLE IF NOT EXISTS shaker_scores (
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

  CREATE INDEX IF NOT EXISTS idx_shaker_board
    ON shaker_scores (profile, board_size, score DESC);

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

// ---- Word Shaker ----
// Kept on its own table and indexed by (profile, board_size) so the kids'
// 4x4 board and an unfiltered 5x5 board never share a leaderboard -- the
// scores simply aren't comparable.

function insertShakerScore({ initials, score, mode, boardSize, profile, wordCount, bestWord, longestWord, durationSec, players }) {
  const info = db.prepare(`
    INSERT INTO shaker_scores
      (initials, score, mode, board_size, profile, word_count, best_word, longest_word, duration_sec, players)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    initials, score, mode, boardSize, profile, wordCount,
    bestWord || '', longestWord || '', durationSec, players || 1
  );
  const rank = db.prepare(`
    SELECT COUNT(*) AS c FROM shaker_scores
    WHERE profile = ? AND board_size = ? AND score > ?
  `).get(profile, boardSize, score).c + 1;
  return { id: info.lastInsertRowid, score, rank };
}

function listShakerLeaderboard({ profile, boardSize, limit }) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const rows = db.prepare(`
    SELECT * FROM shaker_scores
    WHERE profile = ? AND board_size = ?
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

// ---- Word Shaker: players, streaks, dailies, milestones ----

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
  return db.prepare('SELECT * FROM shaker_players ORDER BY created_at ASC').all().map(rowToPlayer);
}

function getPlayer(id) {
  return rowToPlayer(db.prepare('SELECT * FROM shaker_players WHERE id = ?').get(String(id || '')));
}

function createPlayer({ id, name, avatar }) {
  db.prepare('INSERT INTO shaker_players (id, name, avatar) VALUES (?, ?, ?)').run(id, name, avatar);
  return getPlayer(id);
}

function updatePlayer(id, { name, avatar }) {
  const p = getPlayer(id);
  if (!p) return null;
  db.prepare('UPDATE shaker_players SET name = ?, avatar = ? WHERE id = ?')
    .run(name || p.name, avatar || p.avatar, id);
  return getPlayer(id);
}

function deletePlayer(id) {
  const info = db.prepare('DELETE FROM shaker_players WHERE id = ?').run(id);
  db.prepare('DELETE FROM shaker_milestones WHERE player_id = ?').run(id);
  db.prepare('DELETE FROM shaker_daily WHERE player_id = ?').run(id);
  return info.changes > 0;
}

// One statement so a round either lands completely or not at all. MAX() keeps
// personal bests monotonic without a read-modify-write race between two kids
// finishing on different devices at the same moment.
function applyPlayerRound(id, { score, bestWord, marathonScore, coins, streak, longestStreak, day }) {
  const p = getPlayer(id);
  if (!p) return null;
  db.prepare(`
    UPDATE shaker_players SET
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
  const info = db.prepare('UPDATE shaker_players SET coins = coins - ? WHERE id = ? AND coins >= ?')
    .run(amount, id, amount);
  return info.changes > 0 ? getPlayer(id) : null;
}

function grantCoins(id, amount) {
  db.prepare('UPDATE shaker_players SET coins = coins + ? WHERE id = ?').run(amount, id);
  return getPlayer(id);
}

function listMilestones(playerId) {
  return db.prepare('SELECT code, earned_at FROM shaker_milestones WHERE player_id = ?')
    .all(playerId).map(r => ({ code: r.code, earnedAt: r.earned_at }));
}

function awardMilestone(playerId, code) {
  const info = db.prepare('INSERT OR IGNORE INTO shaker_milestones (player_id, code) VALUES (?, ?)')
    .run(playerId, code);
  return info.changes > 0;
}

function getDailyResult(day, playerId) {
  const r = db.prepare('SELECT * FROM shaker_daily WHERE day = ? AND player_id = ?').get(day, playerId);
  return r ? { day: r.day, playerId: r.player_id, score: r.score, words: r.words, bestWord: r.best_word } : null;
}

function recordDaily({ day, playerId, score, words, bestWord }) {
  const info = db.prepare(`
    INSERT OR IGNORE INTO shaker_daily (day, player_id, score, words, best_word)
    VALUES (?, ?, ?, ?, ?)
  `).run(day, playerId, score, words, bestWord || '');
  return info.changes > 0;
}

function listDaily(day) {
  return db.prepare(`
    SELECT d.*, p.name, p.avatar FROM shaker_daily d
    LEFT JOIN shaker_players p ON p.id = d.player_id
    WHERE d.day = ? ORDER BY d.score DESC, d.created_at ASC
  `).all(day).map(r => ({
    playerId: r.player_id, name: r.name || 'Unknown', avatar: r.avatar || '🙂',
    score: r.score, words: r.words, bestWord: r.best_word
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
  insertShakerScore,
  listShakerLeaderboard,
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
