'use strict';

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const db = require('../db');
const boards = require('./boards');
const dictionary = require('./dictionary');
const round = require('./round');
const { solve } = require('./solver');
const rooms = require('./rooms');
const marathon = require('./marathon');
const progress = require('./progress');
const seasons = require('./seasons');
const packs = require('./packs');
const adminRouter = require('./admin');

const router = express.Router();
router.use('/admin', adminRouter);

// Optional extra lock on the unfiltered dictionary. Unset -- the default --
// means a confirmation tap is all that stands in front of it, which is what
// was asked for. Set ADULT_PIN in .env and it becomes a real gate, matching
// how ADMIN_TOKEN already works.
const ADULT_PIN = process.env.ADULT_PIN || '';

const INITIALS_RE = /^[A-Z0-9]{1,3}$/;

function fail(message, status) {
  return Object.assign(new Error(message), { status });
}

function profileOf(raw) {
  return raw === 'adult' ? 'adult' : 'kids';
}

// Enforced on every path that could reach unfiltered words: creating a board,
// creating a room, and changing a room's settings mid-session.
function assertProfileAllowed(profile, req) {
  if (profile !== 'adult' || !ADULT_PIN) return;
  const supplied = req.get('X-Adult-Pin') || (req.body && req.body.adultPin) || '';
  if (String(supplied) !== ADULT_PIN) {
    throw fail('That PIN is not right.', 403);
  }
}

// The two dictionaries share a board, so an adult round could put a rude word
// on a wall the kids read. The score still counts -- only the word is withheld.
function publicEntry(row) {
  const clean = row.bestWord && dictionary.isWord(row.bestWord, 'kids');
  return { ...row, bestWord: clean ? row.bestWord : '', profile: undefined };
}

function boardLabel(key) {
  return key === 'marathon' ? 'Marathon' : key === '5' ? '5x5 Big' : '4x4 Classic';
}

function solverSolve(board, spec, profile, min) {
  return solve(board, spec, profile, { min });
}

const limit = (windowMinutes, max, message) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  limit: max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: message }
});

const boardLimiter = limit(10, 120, 'Too many boards. Give it a minute.');
const checkLimiter = limit(10, 2000, 'Slow down a moment.');
const scoreLimiter = limit(10, 120, 'Too many rounds scored. Try again shortly.');
const leaderboardLimiter = limit(10, 30, 'Too many score submissions. Try again in a few minutes.');
const roomLimiter = limit(60, 40, 'Too many rooms created. Try again later.');

// ---- config ----------------------------------------------------------------

router.get('/config', (req, res) => {
  res.json({
    sizes: round.SIZES.map(size => ({
      size,
      minLength: size >= 5 ? 4 : 3,
      label: size === 4 ? '4x4 Classic' : '5x5 Big'
    })),
    durations: round.DURATIONS,
    defaultDuration: round.DEFAULT_DURATION,
    difficulties: Object.values(round.DIFFICULTIES).map(d => ({
      id: d.id, label: d.label, blurb: d.blurb,
      minLength: d.minLength, hintCost: d.hintCost, scoreMultiplier: d.scoreMultiplier
    })),
    defaultDifficulty: round.DEFAULT_DIFFICULTY,
    marathon: { start: marathon.START, timeBonus: marathon.TIME_BONUS },
    milestones: progress.catalogue(),
    today: progress.today(),
    season: seasons.status(),
    theme: packs.active(),
    profiles: dictionary.listProfiles(),
    adultRequiresPin: !!ADULT_PIN,
    maxPlayers: rooms.MAX_PLAYERS,
    dictionary: dictionary.stats
  });
});

// ---- single-device rounds (solo, hotseat turns, tabletop) -------------------

router.post('/board', boardLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const profile = profileOf(body.profile);
    assertProfileAllowed(profile, req);

    const entry = boards.stash(round.createBoard({
      size: body.size,
      profile,
      difficulty: body.difficulty
    }));
    res.status(201).json({
      boardId: entry.id,
      board: entry.board,
      size: entry.size,
      cols: entry.cols,
      rows: entry.rows,
      profile: entry.profile,
      difficulty: entry.difficulty,
      minLength: entry.minLength
    });
  } catch (e) {
    next(e);
  }
});

// Live feedback while a word is being entered. Deliberately does not reveal
// anything beyond a yes/no about the word actually submitted -- handing the
// client the solved board would make cheating trivial.
router.post('/check', checkLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const entry = boards.require(body.boardId);
    const verdict = round.validateWord(
      entry.board,
      { cols: entry.cols, rows: entry.rows },
      entry.profile,
      body.word,
      entry.minLength
    );
    const word = String(body.word || '').toUpperCase().replace(/[^A-Z]/g, '');
    res.json({
      word,
      valid: verdict.valid,
      reason: verdict.reason,
      path: verdict.path || null,
      themed: verdict.valid && dictionary.isThemeWord(word)
    });
  } catch (e) {
    next(e);
  }
});

router.post('/score', scoreLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const entry = boards.require(body.boardId);

    const rawPlayers = Array.isArray(body.players) ? body.players.slice(0, rooms.MAX_PLAYERS) : [];
    if (rawPlayers.length === 0) throw fail('No players submitted.', 400);

    const players = rawPlayers.map((p, i) => ({
      id: String(p.id || `p${i}`),
      name: String(p.name || `Player ${i + 1}`).trim().slice(0, 16) || `Player ${i + 1}`,
      words: Array.isArray(p.words) ? p.words.slice(0, 400) : []
    }));

    const result = round.scoreSubmissions({
      board: entry.board,
      cols: entry.cols,
      rows: entry.rows,
      profile: entry.profile,
      difficulty: entry.difficulty,
      minLength: entry.minLength,
      players
    });
    result.board = entry.board;
    result.size = entry.size;
    result.cols = entry.cols;
    result.rows = entry.rows;
    result.profile = entry.profile;
    result.difficulty = entry.difficulty;
    entry.result = result;

    // If a profile was playing, this is where the streak, coins and
    // milestones move. Guests can still play; they just bank nothing.
    //
    // `profileId` is the field; `playerId` is accepted as a fallback only
    // because an earlier version used it, and it means something different
    // everywhere else (which player of the round, or which room member).
    const profileId = body.profileId || body.playerId;
    if (profileId && db.getPlayer(profileId)) {
      const mine = result.results.find(r => r.playerId === (body.forPlayer || players[0].id))
        || result.results[0];
      result.progress = progress.recordRound(profileId, {
        score: mine.score,
        wordCount: mine.wordCount,
        longestWord: mine.longest || '',
        bestWord: mine.best ? mine.best.word : '',
        daily: !!entry.daily,
        day: entry.daily || progress.today()
      });
    }

    // What the arcade board makes of it, so the client knows whether to offer
    // the initials prompt or show the player how far off they were.
    const top = result.results[0];
    if (top) {
      result.arcade = db.arcadeStanding(db.boardKeyFor('solo', entry.size), top.score);
      result.arcade.entries = db.listArcadeBoard(result.arcade.boardKey).map(publicEntry);
    }

    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ---- seasons ---------------------------------------------------------------

// The countdown, and whatever the asking profile has won before.
router.get('/season', (req, res) => {
  seasons.checkDue();
  packs.refresh();
  const status = seasons.status();
  const playerId = String(req.query.playerId || '');
  res.json({
    ...status,
    badges: playerId ? db.badgesForPlayer(playerId) : [],
    past: db.listSeasons(8).filter(s => s.endedAt).map(s => ({
      ...s,
      winners: db.badgesForSeason(s.id).filter(b => b.rank === 1)
    }))
  });
});

// ---- the arcade board ------------------------------------------------------

// Ten slots per board, and you only get on by beating the tenth score.
router.get('/arcade', (req, res) => {
  seasons.checkDue();
  const key = db.ARCADE_BOARDS.includes(String(req.query.board)) ? String(req.query.board) : '4';
  const entries = db.listArcadeBoard(key).map(publicEntry);
  res.json({
    boardKey: key,
    label: boardLabel(key),
    slots: db.ARCADE_SLOTS,
    filled: entries.length,
    entries,
    boards: db.ARCADE_BOARDS.map(k => ({ key: k, label: boardLabel(k) }))
  });
});

// ---- leaderboard -----------------------------------------------------------

router.get('/leaderboard', (req, res) => {
  const key = req.query.mode === 'marathon'
    ? 'marathon'
    : db.boardKeyFor('solo', req.query.size);
  res.json(db.listArcadeBoard(key, req.query.limit).map(publicEntry));
});

// The score is never taken from the request body. It is looked up from the
// round the server already scored, so a crafted POST cannot invent one.
router.post('/leaderboard', leaderboardLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const initials = String(body.initials || '').toUpperCase().trim();
    if (!INITIALS_RE.test(initials)) {
      throw fail('Initials must be 1-3 letters or numbers.', 400);
    }
    // Roll the season over first, so a score submitted a minute after
    // midnight lands on the new board rather than the one being frozen.
    seasons.checkDue();

    let result;
    let playerId;
    let mode;
    let durationSec;

    // A finished Marathon run. The score comes off the session the server
    // scored, exactly like every other mode -- never off the request.
    if (body.marathonId) {
      const done = marathon.finish(body.marathonId);
      const saved = db.insertArcadeScore({
        initials,
        playerId: body.profileId && db.getPlayer(body.profileId) ? body.profileId : null,
        score: done.finalScore,
        mode: 'marathon',
        boardSize: 4,
        profile: done.profile,
        wordCount: done.wordCount,
        bestWord: done.best ? done.best.word : '',
        longestWord: done.longest || '',
        durationSec: Math.round(done.survivedMs / 1000),
        players: 1
      });
      return res.status(saved.made ? 201 : 200).json(saved);
    }

    if (body.code) {
      const room = rooms.requireRoom(body.code);
      rooms.authenticate(room, body.playerId, body.token);
      if (!room.results) throw fail('That round has no results yet.', 409);
      result = room.results;
      playerId = String(body.playerId);
      mode = 'room';
      durationSec = room.settings.durationSec;
    } else {
      const entry = boards.require(body.boardId);
      if (!entry.result) throw fail('That round has not been scored yet.', 409);
      result = entry.result;
      playerId = String(body.playerId || 'p0');
      mode = ['solo', 'turns', 'tabletop'].includes(body.mode) ? body.mode : 'solo';
      durationSec = Math.max(0, Math.min(3600, parseInt(body.durationSec, 10) || 0));
    }

    const player = result.results.find(r => r.playerId === playerId);
    if (!player) throw fail('Unknown player for that round.', 400);

    const saved = db.insertArcadeScore({
      initials,
      // `playerId` above identifies the player *within the round*; the profile
      // that banks the badge is a separate thing and has its own field.
      playerId: body.profileId && db.getPlayer(body.profileId) ? body.profileId : null,
      score: player.score,
      mode,
      boardSize: result.size,
      profile: result.profile,
      wordCount: player.wordCount,
      bestWord: player.best ? player.best.word : '',
      longestWord: player.longest || '',
      durationSec,
      players: result.results.length
    });
    // Missing the board is not an error -- it is the answer to the question.
    res.status(saved.made ? 201 : 200).json(saved);
  } catch (e) {
    next(e);
  }
});

// ---- rooms (each player on their own phone) --------------------------------

router.post('/rooms', roomLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const profile = profileOf(body.profile);
    assertProfileAllowed(profile, req);

    const { room, player } = rooms.createRoom({
      hostName: body.name,
      size: body.size,
      profile,
      durationSec: body.durationSec
    });
    res.status(201).json({
      code: room.code,
      playerId: player.id,
      token: player.token,
      state: rooms.snapshot(room, player.id)
    });
  } catch (e) {
    next(e);
  }
});

router.post('/rooms/:code/join', (req, res, next) => {
  try {
    const { room, player } = rooms.joinRoom(req.params.code, (req.body || {}).name);
    res.status(201).json({
      code: room.code,
      playerId: player.id,
      token: player.token,
      state: rooms.snapshot(room, player.id)
    });
  } catch (e) {
    next(e);
  }
});

router.get('/rooms/:code/events', (req, res, next) => {
  try {
    rooms.subscribe(req.params.code, req.query.playerId, req.query.token, res);
  } catch (e) {
    next(e);
  }
});

router.post('/rooms/:code/settings', (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.profile) assertProfileAllowed(profileOf(body.profile), req);
    const room = rooms.updateSettings(req.params.code, body.playerId, body.token, {
      size: body.size,
      profile: body.profile,
      durationSec: body.durationSec
    });
    res.json(rooms.snapshot(room, body.playerId));
  } catch (e) {
    next(e);
  }
});

router.post('/rooms/:code/start', (req, res, next) => {
  try {
    const body = req.body || {};
    const room = rooms.startRound(req.params.code, body.playerId, body.token);
    res.json(rooms.snapshot(room, body.playerId));
  } catch (e) {
    next(e);
  }
});

router.post('/rooms/:code/words', (req, res, next) => {
  try {
    const body = req.body || {};
    res.json(rooms.submitWords(req.params.code, body.playerId, body.token, body.words));
  } catch (e) {
    next(e);
  }
});

router.post('/rooms/:code/ready', (req, res, next) => {
  try {
    const body = req.body || {};
    const room = rooms.markReady(req.params.code, body.playerId, body.token);
    res.json(rooms.snapshot(room, body.playerId));
  } catch (e) {
    next(e);
  }
});

router.post('/rooms/:code/next', (req, res, next) => {
  try {
    const body = req.body || {};
    const room = rooms.resetToLobby(req.params.code, body.playerId, body.token);
    res.json(rooms.snapshot(room, body.playerId));
  } catch (e) {
    next(e);
  }
});

router.post('/rooms/:code/leave', (req, res, next) => {
  try {
    const body = req.body || {};
    rooms.leaveRoom(req.params.code, body.playerId, body.token);
    res.json({ left: true });
  } catch (e) {
    next(e);
  }
});

// ---- hints on a classic board ----------------------------------------------

// Costs coins, and the coins are deducted before the word is revealed. Order
// matters: reveal-then-charge would hand out a free hint whenever the charge
// failed.
router.post('/hint', checkLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const entry = boards.require(body.boardId);
    const player = db.getPlayer(body.playerId);
    if (!player) throw fail('Pick a profile before spending coins.', 400);

    const cost = round.difficultyOf(entry.difficulty).hintCost;
    if (!db.spendCoins(player.id, cost)) {
      throw fail(`Not enough coins — a hint costs ${cost}.`, 402);
    }

    const spec = { cols: entry.cols, rows: entry.rows };
    const all = solverSolve(entry.board, spec, entry.profile, entry.minLength);
    const had = new Set((Array.isArray(body.found) ? body.found : []).map(w => String(w).toUpperCase()));
    const candidates = [...all.keys()].filter(w => !had.has(w));

    if (!candidates.length) {
      db.grantCoins(player.id, cost);              // nothing to give, so give it back
      throw fail('You have found everything on this board.', 409);
    }

    candidates.sort((a, b) => b.length - a.length);
    const word = candidates[Math.min(candidates.length - 1, Math.floor(Math.random() * 5))];

    res.json({ word, path: all.get(word), cost, coins: db.getPlayer(player.id).coins });
  } catch (e) {
    next(e);
  }
});

// ---- marathon ---------------------------------------------------------------

router.post('/marathon', boardLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const profile = profileOf(body.profile);
    assertProfileAllowed(profile, req);
    res.status(201).json(marathon.view(marathon.create({ profile, difficulty: body.difficulty })));
  } catch (e) {
    next(e);
  }
});

router.post('/marathon/:id/word', checkLimiter, (req, res, next) => {
  try {
    res.json(marathon.submit(req.params.id, (req.body || {}).word));
  } catch (e) {
    next(e);
  }
});

router.post('/marathon/:id/hint', checkLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const session = marathon.get(req.params.id);
    const player = db.getPlayer(body.playerId);
    if (!player) throw fail('Pick a profile before spending coins.', 400);

    const cost = round.difficultyOf(session.difficulty).hintCost;
    if (!db.spendCoins(player.id, cost)) {
      throw fail(`Not enough coins — a hint costs ${cost}.`, 402);
    }

    try {
      const result = marathon.hint(req.params.id);
      res.json({ ...result, cost, coins: db.getPlayer(player.id).coins });
    } catch (inner) {
      db.grantCoins(player.id, cost);              // refund if there was nothing to reveal
      throw inner;
    }
  } catch (e) {
    next(e);
  }
});

router.post('/marathon/:id/finish', scoreLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const result = marathon.finish(req.params.id);

    const finishProfile = body.profileId || body.playerId;
    if (finishProfile && db.getPlayer(finishProfile)) {
      result.progress = progress.recordRound(finishProfile, {
        score: result.finalScore,
        wordCount: result.wordCount,
        longestWord: result.longest,
        bestWord: result.best ? result.best.word : '',
        marathonScore: result.finalScore,
        marathonLevel: result.level
      });
    }

    result.arcade = db.arcadeStanding('marathon', result.finalScore);
    result.arcade.entries = db.listArcadeBoard('marathon').map(publicEntry);

    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ---- daily challenge --------------------------------------------------------

// One board a day for the whole house, generated from the date rather than
// stored — so it is reproducible anywhere and survives losing the database.
router.get('/daily', (req, res, next) => {
  try {
    const profile = profileOf(req.query.profile);
    const day = progress.today();
    const built = progress.dailyBoard(day, profile);
    const entry = boards.stash({ ...built, daily: day });

    const already = req.query.playerId ? db.getDailyResult(day, String(req.query.playerId)) : null;

    res.json({
      boardId: entry.id,
      day,
      board: entry.board,
      size: entry.size,
      cols: entry.cols,
      rows: entry.rows,
      profile: entry.profile,
      difficulty: entry.difficulty,
      minLength: entry.minLength,
      alreadyPlayed: !!already,
      yourResult: already,
      standings: db.listDaily(day)
    });
  } catch (e) {
    next(e);
  }
});

router.get('/daily/standings', (req, res) => {
  const day = String(req.query.day || progress.today());
  res.json({ day, standings: db.listDaily(day) });
});

// ---- profiles ---------------------------------------------------------------

const AVATARS = ['\u{1F98A}', '\u{1F43B}', '\u{1F431}', '\u{1F436}', '\u{1F984}', '\u{1F996}',
  '\u{1F438}', '\u{1F419}', '\u{1F427}', '\u{1F981}', '\u{1F42F}', '\u{1F435}',
  '\u{1F47D}', '\u{1F916}', '\u{1F47B}', '\u{1F3AE}'];

router.get('/players', (req, res) => {
  res.json({ players: db.listPlayers(), avatars: AVATARS });
});

router.get('/players/:id', (req, res, next) => {
  try {
    const p = progress.profile(req.params.id);
    if (!p) throw fail('No such profile.', 404);
    res.json(p);
  } catch (e) {
    next(e);
  }
});

router.post('/players', boardLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 16);
    if (!name) throw fail('Give the profile a name.', 400);
    if (db.listPlayers().length >= 12) throw fail('That is enough profiles for one house.', 409);

    const avatar = AVATARS.includes(body.avatar) ? body.avatar : AVATARS[0];
    const id = crypto.randomBytes(8).toString('hex');
    res.status(201).json(db.createPlayer({ id, name, avatar }));
  } catch (e) {
    next(e);
  }
});

router.patch('/players/:id', (req, res, next) => {
  try {
    const body = req.body || {};
    const name = body.name === undefined ? undefined : String(body.name).trim().slice(0, 16);
    const avatar = AVATARS.includes(body.avatar) ? body.avatar : undefined;
    const updated = db.updatePlayer(req.params.id, { name, avatar });
    if (!updated) throw fail('No such profile.', 404);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.delete('/players/:id', (req, res, next) => {
  try {
    if (!db.deletePlayer(req.params.id)) throw fail('No such profile.', 404);
    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

// Router-local error handler so a thrown fail() becomes clean JSON rather
// than an HTML stack trace.
router.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('rambler:', err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
});

module.exports = router;
