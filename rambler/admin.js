'use strict';

const express = require('express');
const db = require('../db');
const seasons = require('./seasons');

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
