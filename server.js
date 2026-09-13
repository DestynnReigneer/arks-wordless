const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const dictionary = require('./shaker/dictionary');
const shakerRoutes = require('./shaker/routes');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Word Shaker lives behind its own router; everything it needs is under
// shaker/ so this file stays about the arcade as a whole.
app.use('/api/shaker', shakerRoutes);

const WORD_RE = /^[a-zA-Z]{3,10}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const INITIALS_RE = /^[A-Z0-9]{1,3}$/;

// ---- Admin auth ----
// Lightweight shared-token gate for a solo/family admin, not a full account system.
// If ADMIN_TOKEN isn't configured, admin routes are disabled entirely (deny by default).
function requireAdmin(req, res, next) {
  const supplied = req.get('X-Admin-Token') || '';
  if (!ADMIN_TOKEN || supplied !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Admin token missing or incorrect.' });
  }
  next();
}

// ---- Rate limiting for public write endpoints ----
const leaderboardLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many score submissions. Try again in a few minutes.' }
});

const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many theme requests. Try again later.' }
});

async function notifyDiscord(request) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🎮 **New Wordless theme request**\n**Topic:** ${request.topic}${request.requestedBy ? `\n**From:** ${request.requestedBy}` : ''}${request.note ? `\n**Note:** ${request.note}` : ''}`
      })
    });
  } catch (e) {
    console.error('Discord webhook failed:', e.message);
  }
}

// ---- Health ----
// Used by the container healthcheck. It touches the dictionary and the
// database deliberately: a process that is listening but whose word lists
// failed to load is not healthy, and reporting it as such would hide the
// single most likely deployment failure.
app.get('/healthz', (req, res) => {
  try {
    const stats = dictionary.stats;
    const themes = db.listThemes().length;
    if (!stats.kids || !themes) throw new Error('not ready');
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      words: { kids: stats.kids, adult: stats.adult },
      themes
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ---- Themes (read: public, write: admin-only) ----
app.get('/api/themes', (req, res) => {
  res.json(db.listThemes());
});

app.post('/api/themes', requireAdmin, (req, res) => {
  const body = req.body || {};
  const label = String(body.label || '').trim().slice(0, 40);
  const subject = String(body.subject || '').trim().slice(0, 60) || 'word';
  const emoji = String(body.emoji || '⭐').trim().slice(0, 8) || '⭐';
  const accent = HEX_COLOR_RE.test(body.accent) ? body.accent : '#7dd3fc';
  const bg = HEX_COLOR_RE.test(body.bg) ? body.bg : '#0f1115';
  const fontKey = Object.keys(db.FONT_STACKS).includes(body.fontKey) ? body.fontKey : 'sans';

  if (!label) {
    return res.status(400).json({ error: 'Theme name is required.' });
  }

  const rawWords = Array.isArray(body.words) ? body.words : [];
  const words = [...new Set(
    rawWords.map(w => String(w).trim().toLowerCase()).filter(w => WORD_RE.test(w))
  )];

  if (words.length < 5) {
    return res.status(400).json({ error: 'Need at least 5 valid words (letters only, 3-10 letters each).' });
  }

  const theme = db.createTheme({ label, subject, emoji, accent, bg, fontKey, words });
  res.status(201).json(theme);
});

app.delete('/api/themes/:id', requireAdmin, (req, res) => {
  const ok = db.deleteTheme(req.params.id);
  if (!ok) return res.status(400).json({ error: 'Cannot delete this theme.' });
  res.json({ deleted: true });
});

// ---- Theme requests (kids suggest, admin fulfills) ----
app.post('/api/theme-requests', requestLimiter, async (req, res) => {
  const body = req.body || {};
  const topic = String(body.topic || '').trim().slice(0, 60);
  const note = String(body.note || '').trim().slice(0, 200);
  const requestedBy = String(body.requestedBy || '').trim().slice(0, 30);

  if (!topic) {
    return res.status(400).json({ error: 'Please enter a theme idea.' });
  }

  const request = db.createThemeRequest({ topic, note, requestedBy });
  notifyDiscord(request);
  res.status(201).json(request);
});

app.get('/api/theme-requests', requireAdmin, (req, res) => {
  res.json(db.listThemeRequests(req.query.status || 'pending'));
});

app.post('/api/theme-requests/:id/dismiss', requireAdmin, (req, res) => {
  const ok = db.dismissThemeRequest(Number(req.params.id));
  if (!ok) return res.status(400).json({ error: 'Request not found or already handled.' });
  res.json({ dismissed: true });
});

app.post('/api/theme-requests/:id/fulfill', requireAdmin, (req, res) => {
  const themeId = String((req.body || {}).themeId || '');
  if (!db.getTheme(themeId)) {
    return res.status(400).json({ error: 'Unknown theme id.' });
  }
  const ok = db.fulfillThemeRequest(Number(req.params.id), themeId);
  if (!ok) return res.status(400).json({ error: 'Request not found or already handled.' });
  res.json({ fulfilled: true });
});

// ---- Leaderboard ----
app.get('/api/leaderboard', (req, res) => {
  res.json(db.listLeaderboard({ themeId: req.query.theme, limit: req.query.limit }));
});

app.post('/api/leaderboard', leaderboardLimiter, (req, res) => {
  const body = req.body || {};
  const initials = String(body.initials || '').toUpperCase().trim();
  const themeId = String(body.themeId || '');
  const won = !!body.won;
  const guesses = Math.max(0, Math.min(20, parseInt(body.guesses, 10) || 0));
  const hintsUsed = Math.max(0, Math.min(3, parseInt(body.hintsUsed, 10) || 0));
  const word = String(body.word || '').toLowerCase().slice(0, 20);
  const elapsedMs = Math.max(0, Math.min(3600000, parseInt(body.elapsedMs, 10) || 0));

  if (!INITIALS_RE.test(initials)) {
    return res.status(400).json({ error: 'Initials must be 1-3 letters or numbers.' });
  }
  if (!db.getTheme(themeId)) {
    return res.status(400).json({ error: 'Unknown theme.' });
  }

  const result = db.insertScore({ initials, themeId, won, guesses, hintsUsed, word, elapsedMs });
  res.status(201).json(result);
});

app.listen(PORT, () => {
  // Build the trie now rather than on the first player's request -- it takes
  // about 200ms, which is a visible stutter if it lands mid-round.
  const stats = dictionary.stats;
  console.log(`Wordless Arcade running at http://localhost:${PORT}`);
  console.log(
    `Word Shaker dictionary: ${stats.kids.toLocaleString()} kids / ` +
    `${stats.adult.toLocaleString()} unfiltered words (${stats.buildMs}ms)`
  );
  if (!ADMIN_TOKEN) {
    console.warn('ADMIN_TOKEN is not set — admin routes (create/delete theme, view requests) are disabled.');
  }
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('DISCORD_WEBHOOK_URL is not set — theme request notifications will not be sent.');
  }
  if (process.env.ADULT_PIN) {
    console.log('ADULT_PIN is set — the unfiltered dictionary requires a PIN.');
  }
});
