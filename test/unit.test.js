'use strict';

// Pure logic: dice, board shapes, the solver, scoring, and the progress rules.
// No server and no network — these are the things that must never quietly
// change, because every other test trusts them.

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const dice = require(path.join(ROOT, 'shaker/dice.js'));
const solver = require(path.join(ROOT, 'shaker/solver.js'));
const scoring = require(path.join(ROOT, 'shaker/scoring.js'));
const dictionary = require(path.join(ROOT, 'shaker/dictionary.js'));
const progress = require(path.join(ROOT, 'shaker/progress.js'));
const marathon = require(path.join(ROOT, 'shaker/marathon.js'));

async function run() {
  let pass = 0;
  let fail = 0;
  const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  ' + extra : '')); }
  };

  console.log('\n-- dice and board shape --');
  ok('4x4 rolls 16 tiles', dice.rollBoard(4).length === 16);
  ok('5x5 rolls 25 tiles', dice.rollBoard(5).length === 25);
  ok('rectangles roll the right count', dice.rollBoard({ cols: 4, rows: 6 }).length === 24);
  ok('a corner has 3 neighbours', dice.neighbours(4)[0].length === 3);
  ok('an interior cell has 8', dice.neighbours(4)[5].length === 8);
  ok('rectangular adjacency is right', dice.neighbours({ cols: 4, rows: 2 })[0].length === 3);
  ok('bad dimensions are rejected', (() => {
    try { dice.dims({ cols: 1, rows: 1 }); return false; } catch { return true; }
  })());

  console.log('\n-- the Qu tile --');
  const qb = ['QU', 'I', 'T', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X'];
  ok('QUIT walks the Qu tile as two letters', !!dice.findPath(qb, 4, 'QUIT'));
  ok('QIT does not', dice.findPath(qb, 4, 'QIT') === null);

  console.log('\n-- growing a board --');
  const base = ['C', 'A', 'T', 'S'];
  const dim = { cols: 2, rows: 2 };
  for (const side of dice.SIDES) {
    const g = dice.growBoard(base, dim, side, () => 0.5);
    ok(`grow ${side} keeps the cell count consistent`, g.board.length === g.cols * g.rows,
      `${g.board.length} vs ${g.cols}x${g.rows}`);
  }
  const topGrown = dice.growBoard(base, dim, 'top', () => 0.5);
  ok('growing upward leaves the original rows intact', topGrown.board.slice(2).join('') === 'CATS');

  console.log('\n-- dictionary profiles --');
  const checks = [
    ['CAT', 'kids', true], ['CAT', 'adult', true],
    ['FUCK', 'kids', false], ['FUCK', 'adult', true],
    ['SHITTING', 'kids', false], ['SHITTING', 'adult', true],
    ['WANKER', 'kids', false], ['WANKER', 'adult', true],
    ['RIZZ', 'kids', false], ['RIZZ', 'adult', true],
    // innocent words the blocklist's inflections used to catch by accident
    ['HEROINES', 'kids', true], ['BONKERS', 'kids', true],
    ['SPUNKY', 'kids', true], ['COCKY', 'kids', true],
    // mild words deliberately left playable for children
    ['NUT', 'kids', true], ['CRACK', 'kids', true], ['WEED', 'kids', true], ['FART', 'kids', true]
  ];
  let bad = 0;
  for (const [w, p, want] of checks) {
    if (dictionary.isWord(w, p) !== want) { bad++; console.log(`        ${w} (${p}) expected ${want}`); }
  }
  ok(`all ${checks.length} dictionary rules hold`, bad === 0, bad ? `${bad} wrong` : '');
  ok('the kids list is not empty', dictionary.stats.kids > 150000);
  ok('the adult list is larger than the kids list', dictionary.stats.adult > dictionary.stats.kids);

  console.log('\n-- scoring --');
  ok('3 and 4 letters score 1', scoring.wordPoints('CAT', 4) === 1 && scoring.wordPoints('CATS', 4) === 1);
  ok('5 scores 2', scoring.wordPoints('CATER', 4) === 2);
  ok('6 scores 3', scoring.wordPoints('CATERS', 4) === 3);
  ok('7 scores 5', scoring.wordPoints('CATERER', 4) === 5);
  ok('8+ scores 11', scoring.wordPoints('CATERERS', 4) === 11);
  ok('a 3-letter word scores nothing on 5x5', scoring.wordPoints('CAT', 5) === 0);

  console.log('\n-- duplicate cancellation --');
  const valid = w => ({ valid: ['AAA', 'BBB', 'CCC'].includes(w), reason: null });
  const r = scoring.scoreRound({
    size: 4, min: 3, validator: valid,
    players: [
      { id: 'a', name: 'Ada', words: ['AAA', 'BBB'] },
      { id: 'b', name: 'Bo', words: ['CCC', 'BBB'] },
      { id: 'c', name: 'Cy', words: [] }
    ]
  });
  ok('a word two players found is cancelled', r.cancelled.includes('BBB'), JSON.stringify(r.cancelled));
  ok('both are left on 1 point', r.results[0].score === 1 && r.results[1].score === 1);
  ok('a tie shares rank 1', r.results.filter(p => p.rank === 1).length === 2);
  ok('the player with nothing ranks last', r.results[2].rank === 3);

  console.log('\n-- solver --');
  const known = ['C', 'A', 'T', 'S', 'O', 'R', 'E', 'D', 'N', 'I', 'L', 'P', 'E', 'S', 'T', 'A'];
  const found = solver.solveWords(known, 4, 'kids');
  ok('finds a decent haul on a known board', found.length > 100, String(found.length));
  ok('includes an obvious word', found.includes('CAT'));
  ok('excludes a word not on the board', !found.includes('ZEBRA'));

  console.log('\n-- streaks --');
  const mk = (last, streak) => ({ lastPlayed: last, streak, longestStreak: streak });
  ok('a first game starts at 1', progress.nextStreak(mk(null, 0), '2026-09-12') === 1);
  ok('a second game the same day does not double-count', progress.nextStreak(mk('2026-09-12', 4), '2026-09-12') === 4);
  ok('the next day extends it', progress.nextStreak(mk('2026-09-11', 4), '2026-09-12') === 5);
  ok('a missed day resets it', progress.nextStreak(mk('2026-09-09', 9), '2026-09-12') === 1);
  ok('it survives a month boundary', progress.nextStreak(mk('2026-08-31', 3), '2026-09-01') === 4);

  console.log('\n-- the daily board is reproducible --');
  const d1 = progress.dailyBoard('2026-09-12', 'kids');
  const d2 = progress.dailyBoard('2026-09-12', 'kids');
  const d3 = progress.dailyBoard('2026-09-13', 'kids');
  ok('the same date gives the same board', d1.board.join('') === d2.board.join(''));
  ok('a different date gives a different board', d1.board.join('') !== d3.board.join(''));
  ok('the daily board is worth playing', d1.totalWords >= 35, String(d1.totalWords));

  console.log('\n-- marathon --');
  const session = marathon.create({ profile: 'kids', difficulty: 'normal' });
  const startEnds = session.endsAt;
  let cur = marathon.view(marathon.get(session.id));
  let grew = null;
  for (let i = 0; i < 12; i++) {
    const live = marathon.get(session.id);
    const words = solver.solveWords(live.board, { cols: live.cols, rows: live.rows }, 'kids', { min: live.minLength });
    const have = new Set(live.found.map(f => f.word));
    const next = words.find(w => !have.has(w));
    if (!next) break;
    const res = marathon.submit(session.id, next);
    cur = res;
    if (res.grew) grew = res.grew;
  }
  ok('finding words buys time', cur.endsAt > startEnds, `${cur.endsAt - startEnds}ms`);
  ok('the board grows', !!grew, JSON.stringify(grew));
  ok('growth raises the level', cur.level > 1, String(cur.level));
  ok('tiles still match the shape after growing', cur.board.length === cur.cols * cur.rows);
  const done = marathon.finish(session.id);
  ok('finishing yields a final score', typeof done.finalScore === 'number');
  ok('nothing is accepted after the end', (() => {
    try { marathon.submit(session.id, 'CAT'); return false; } catch (e) { return e.status === 409; }
  })());

  console.log(`\n  ${pass} passed, ${fail} failed`);
  return { pass, fail };
}

module.exports = { run };
