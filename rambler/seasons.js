'use strict';

const db = require('../db');

// Seasons run the arcade board. A permanent top-ten eventually calcifies --
// whoever is strongest takes every slot and nobody else bothers -- so the
// walls clear on a schedule and everyone starts level.
//
// What clears: the three arcade boards, and only those. Streaks, coins,
// milestones and lifetime bests all carry over. Ending a month should never
// cost a child a forty-day streak.

const INTERVAL_KEY = 'season.interval';
const WARN_DAYS_KEY = 'season.warnDays';

const DEFAULT_INTERVAL = { unit: 'months', every: 1 };
const DEFAULT_WARN_DAYS = 7;

const UNITS = ['days', 'weeks', 'months', 'manual'];

function readInterval() {
  const raw = db.getSetting(INTERVAL_KEY, DEFAULT_INTERVAL);
  const unit = UNITS.includes(raw && raw.unit) ? raw.unit : DEFAULT_INTERVAL.unit;
  const every = Math.max(1, Math.min(52, parseInt(raw && raw.every, 10) || 1));
  return { unit, every };
}

function warnDays() {
  const n = parseInt(db.getSetting(WARN_DAYS_KEY, DEFAULT_WARN_DAYS), 10);
  return Math.max(0, Math.min(60, Number.isFinite(n) ? n : DEFAULT_WARN_DAYS));
}

// Seasons end at local midnight, like the daily challenge and streaks do --
// a board that clears at 1am UTC would surprise somebody mid-game.
function localMidnight(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function nextEnd(from = new Date(), interval = readInterval()) {
  if (interval.unit === 'manual') return null;
  const d = localMidnight(from);
  if (interval.unit === 'days') d.setDate(d.getDate() + interval.every);
  else if (interval.unit === 'weeks') d.setDate(d.getDate() + interval.every * 7);
  else {
    // Monthly means the 1st of the month, not "30 days from now" -- the
    // difference matters when somebody reads "Season ends 1 November".
    d.setDate(1);
    d.setMonth(d.getMonth() + interval.every);
  }
  return d.toISOString();
}

function describeInterval(interval = readInterval()) {
  if (interval.unit === 'manual') return 'when you end it';
  if (interval.unit === 'months') return interval.every === 1 ? 'monthly' : `every ${interval.every} months`;
  if (interval.unit === 'weeks') return interval.every === 1 ? 'weekly' : `every ${interval.every} weeks`;
  return interval.every === 1 ? 'daily' : `every ${interval.every} days`;
}

// Makes sure a season exists. Called on boot and before anything that needs
// one, so a fresh install is never without a current season.
function ensure() {
  let season = db.currentSeason();
  if (!season) {
    season = db.startSeason({ endsAt: nextEnd() });
  }
  return season;
}

// Ends a season and immediately opens the next. Returns what was minted so a
// caller can tell people what they won.
function close(reason = 'scheduled') {
  const season = db.currentSeason();
  if (!season) return null;

  const closed = db.closeSeason(season.id, db.ARCADE_BOARDS);
  const next = db.startSeason({ endsAt: nextEnd() });
  return { ...closed, reason, next };
}

// Rolls the season over if its end has passed. Safe to call often -- it is a
// single indexed read when nothing is due.
function checkDue() {
  const season = ensure();
  if (!season.endsAt) return null;
  if (new Date(season.endsAt).getTime() > Date.now()) return null;
  return close('scheduled');
}

function status() {
  const season = ensure();
  const interval = readInterval();
  const warn = warnDays();

  let endsInMs = null;
  let daysLeft = null;
  if (season.endsAt) {
    endsInMs = new Date(season.endsAt).getTime() - Date.now();
    daysLeft = Math.max(0, Math.ceil(endsInMs / 86400000));
  }

  return {
    season,
    interval,
    intervalLabel: describeInterval(interval),
    warnDays: warn,
    endsAt: season.endsAt,
    endsInMs,
    daysLeft,
    // The countdown only shows near the end. A number that sits there all
    // month is wallpaper; one that appears in the last week is a prompt.
    closingSoon: daysLeft !== null && daysLeft <= warn,
    slots: db.ARCADE_SLOTS,
    boards: db.ARCADE_BOARDS
  };
}

function setInterval_(interval) {
  const unit = UNITS.includes(interval && interval.unit) ? interval.unit : 'months';
  const every = Math.max(1, Math.min(52, parseInt(interval && interval.every, 10) || 1));
  db.setSetting(INTERVAL_KEY, { unit, every });

  // Re-base the current season's end on the new interval, measured from when
  // it started rather than from now, so changing the setting cannot
  // accidentally extend a season that was about to close.
  const season = db.currentSeason();
  if (season) {
    db.updateSeason(season.id, { endsAt: nextEnd(new Date(season.startedAt)) });
  }
  return status();
}

function setWarnDays(days) {
  db.setSetting(WARN_DAYS_KEY, Math.max(0, Math.min(60, parseInt(days, 10) || 0)));
  return status();
}

// A cheap heartbeat so a season rolls over even if nobody loads a page at
// midnight. unref so it never holds the process open.
const timer = setInterval(() => {
  try {
    checkDue();
  } catch (e) {
    console.error('season rollover failed:', e.message);
  }
}, 10 * 60 * 1000);
if (typeof timer.unref === 'function') timer.unref();

module.exports = {
  DEFAULT_INTERVAL,
  UNITS,
  ensure,
  close,
  checkDue,
  status,
  nextEnd,
  readInterval,
  describeInterval,
  setInterval: setInterval_,
  setWarnDays
};
