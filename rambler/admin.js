'use strict';

const express = require('express');
const db = require('../db');
const seasons = require('./seasons');
const packs = require('./packs');

// Admin routes for Rambler. Mounted under /api/rambler/admin and gated by the
// same ADMIN_TOKEN the Wordless admin already uses -- deny by default: if the
// token is not configured, none of this exists.

const router = express.Router();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function fail(message, status) {
  return Object.assign(new Error(message), { status });
}

router.use((req, res, next) => {
  const supplied = req.get('X-Admin-Token') || '';
  if (!ADMIN_TOKEN || supplied !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Admin token missing or incorrect.' });
  }
  next();
});

// ---- overview ---------------------------------------------------------------

router.get('/overview', (req, res) => {
  const status = seasons.status();
  res.json({
    season: status,
    boards: db.ARCADE_BOARDS.map(key => ({
      key,
      entries: db.listArcadeBoard(key)
    })),
    players: db.listPlayers(),
    theme: packs.active(),
    past: db.listSeasons(12).filter(s => s.endedAt)
  });
});

// ---- seasons ----------------------------------------------------------------

router.get('/seasons', (req, res) => {
  const list = db.listSeasons(24).map(s => ({
    ...s,
    badges: s.endedAt ? db.badgesForSeason(s.id) : []
  }));
  res.json({ current: seasons.status(), seasons: list });
});

// Ending a season is destructive -- the boards are wiped -- so it takes an
// explicit confirm rather than being a bare button press away.
router.post('/seasons/end', (req, res, next) => {
  try {
    if (!(req.body || {}).confirm) {
      throw fail('Ending a season clears all three boards. Send confirm: true.', 400);
    }
    const result = seasons.close('manual');
    if (!result) throw fail('There is no open season.', 409);
    res.json({
      ended: result.season,
      minted: result.minted.length,
      badges: result.minted,
      next: result.next
    });
  } catch (e) {
    next(e);
  }
});

router.post('/seasons/settings', (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.interval) seasons.setInterval(body.interval);
    if (body.warnDays !== undefined) seasons.setWarnDays(body.warnDays);
    if (body.name !== undefined || body.endsAt !== undefined) {
      const cur = db.currentSeason();
      if (cur) {
        db.updateSeason(cur.id, {
          name: body.name === undefined ? undefined : String(body.name).slice(0, 40),
          endsAt: body.endsAt === undefined ? undefined : body.endsAt
        });
      }
    }
    res.json(seasons.status());
  } catch (e) {
    next(e);
  }
});

// ---- theme packs ------------------------------------------------------------

router.get('/themes', (req, res) => {
  const season = db.currentSeason();
  res.json({
    themes: db.listRamblerThemes().map(t => ({ ...t, words: undefined, wordCount: t.wordCount })),
    activeId: season ? season.themeId : null,
    season
  });
});

// One theme's words, for when the admin wants to read what they ingested.
router.get('/themes/:id', (req, res, next) => {
  try {
    const theme = db.getRamblerTheme(req.params.id);
    if (!theme) throw fail('No such pack.', 404);
    res.json(theme);
  } catch (e) {
    next(e);
  }
});

// The prompt to paste into any chatbot. Generated rather than stored so it
// always matches what the parser below will accept.
router.post('/themes/prompt', (req, res, next) => {
  try {
    const body = req.body || {};
    const topic = String(body.topic || '').trim().slice(0, 60);
    if (!topic) throw fail('What should the pack be about?', 400);
    res.json({
      topic,
      prompt: packs.promptFor({
        topic,
        audience: body.audience,
        count: Math.max(20, Math.min(200, parseInt(body.count, 10) || 60))
      })
    });
  } catch (e) {
    next(e);
  }
});

// Ingest whatever came back. Treated as untrusted text: parsed, filtered to
// A-Z, deduped, and length-capped before it goes anywhere near the dictionary.
router.post('/themes', (req, res, next) => {
  try {
    const body = req.body || {};
    const parsed = packs.parsePack(body.json !== undefined ? body.json : body);
    const created = db.createRamblerTheme(parsed);
    packs.refresh({ force: true });
    res.status(201).json({
      theme: { ...created, words: undefined },
      skipped: parsed.skipped,
      // Tell the admin now whether this pack will ever show up in play.
      reach: packs.reachability(parsed.words)
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/themes/:id', (req, res, next) => {
  try {
    if (!db.deleteRamblerTheme(req.params.id)) throw fail('No such pack.', 404);
    packs.refresh({ force: true });
    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

// Dress the current season in a pack (or strip it with null).
router.post('/seasons/theme', (req, res, next) => {
  try {
    const body = req.body || {};
    const season = db.currentSeason();
    if (!season) throw fail('There is no open season.', 409);

    const themeId = body.themeId === null || body.themeId === '' ? null : String(body.themeId);
    if (themeId && !db.getRamblerTheme(themeId)) throw fail('No such pack.', 400);

    db.updateSeason(season.id, { themeId });
    packs.refresh({ force: true });
    res.json({ season: db.currentSeason(), theme: packs.active() });
  } catch (e) {
    next(e);
  }
});

// ---- dictionary edits -------------------------------------------------------

router.get('/dictionary', (req, res) => {
  res.json({
    edits: db.listDictionaryEdits(),
    stats: require('./dictionary').stats,
    lists: [
      { key: 'block', label: 'Blocked for kids' },
      { key: 'allow', label: 'Rescued (never blocked)' },
      { key: 'adult', label: 'Added to unfiltered' }
    ]
  });
});

router.post('/dictionary', (req, res, next) => {
  try {
    const body = req.body || {};
    const list = ['block', 'allow', 'adult'].includes(body.list) ? body.list : null;
    if (!list) throw fail('Pick a list: block, allow or adult.', 400);
    const added = db.addDictionaryEdit(body.word, list);
    if (!added) throw fail('Words need to be at least 3 letters, A-Z only.', 400);
    packs.refresh({ force: true });
    res.status(201).json(added);
  } catch (e) {
    next(e);
  }
});

router.delete('/dictionary', (req, res, next) => {
  try {
    const body = req.body || {};
    if (!db.removeDictionaryEdit(body.word, body.list)) throw fail('No such edit.', 404);
    packs.refresh({ force: true });
    res.json({ removed: true });
  } catch (e) {
    next(e);
  }
});

// ---- board moderation -------------------------------------------------------

// For when a child puts something unrepeatable in their three letters.
router.delete('/arcade/entry/:id', (req, res, next) => {
  try {
    if (!db.deleteArcadeEntry(Number(req.params.id))) throw fail('No such entry.', 404);
    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

router.post('/arcade/:board/clear', (req, res, next) => {
  try {
    const key = String(req.params.board);
    if (!db.ARCADE_BOARDS.includes(key)) throw fail('Unknown board.', 400);
    if (!(req.body || {}).confirm) throw fail('Send confirm: true to clear a board.', 400);
    const removed = db.clearArcadeBoard(key);
    res.json({ cleared: key, removed });
  } catch (e) {
    next(e);
  }
});

// ---- profiles ---------------------------------------------------------------

router.get('/players', (req, res) => {
  res.json({
    players: db.listPlayers().map(p => ({
      ...p,
      badges: db.badgesForPlayer(p.id).length,
      milestones: db.listMilestones(p.id).length
    }))
  });
});

router.patch('/players/:id', (req, res, next) => {
  try {
    const body = req.body || {};
    const existing = db.getPlayer(req.params.id);
    if (!existing) throw fail('No such profile.', 404);

    if (body.name !== undefined || body.avatar !== undefined) {
      db.updatePlayer(req.params.id, {
        name: body.name === undefined ? undefined : String(body.name).trim().slice(0, 16),
        avatar: body.avatar
      });
    }
    // Coins are granted, not set: a gift is an event, and "+10 for tidying
    // your room" is what this is actually for.
    if (body.grantCoins) {
      db.grantCoins(req.params.id, Math.max(-999, Math.min(999, parseInt(body.grantCoins, 10) || 0)));
    }
    res.json(db.getPlayer(req.params.id));
  } catch (e) {
    next(e);
  }
});

router.delete('/players/:id', (req, res, next) => {
  try {
    if (!(req.body || {}).confirm) throw fail('Send confirm: true to delete a profile.', 400);
    if (!db.deletePlayer(req.params.id)) throw fail('No such profile.', 404);
    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

// ---- errors -----------------------------------------------------------------

router.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('rambler admin:', err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
});

module.exports = router;
