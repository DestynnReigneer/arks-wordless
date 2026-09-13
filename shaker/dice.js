'use strict';

// The real printed dice. Rolling actual Boggle dice — rather than picking
// letters from a weighted random pool — is what makes boards feel "right":
// the die faces guarantee a workable vowel spread and keep Q/Z/X rare
// without any extra balancing logic.

// 4x4 — standard Boggle, post-1983 US distribution.
const DICE_4 = [
  'AAEEGN', 'ABBJOO', 'ACHOPS', 'AFFKPS',
  'AOOTTW', 'CIMOTU', 'DEILRX', 'DELRVY',
  'DISTTY', 'EEGHNW', 'EEINSU', 'EHRTVW',
  'EIOSST', 'ELRTTY', 'HIMNQU', 'HLNNRZ'
];

// 5x5 — Big Boggle / Boggle Deluxe.
const DICE_5 = [
  'AAAFRS', 'AAEEEE', 'AAFIRS', 'ADENNN', 'AEEEEM',
  'AEEGMU', 'AEGMNN', 'AFIRSY', 'BJKQXZ', 'CCNSTW',
  'CEIILT', 'CEILPT', 'CEIPST', 'DDHNOT', 'DHHLOR',
  'DHHNOT', 'DHLNOR', 'EIIITT', 'EMOTTT', 'ENSSSU',
  'FIPRSY', 'GORRVW', 'HIPRRY', 'NOOTUW', 'OOOTTU'
];

// Boards are rectangular, not just square: Marathon grows the grid one row or
// column at a time, so a 4x4 becomes a 4x5, then a 5x5, and so on. Every
// function here takes either a plain number (a square board, which is what the
// classic modes use) or a { cols, rows } pair.
function dims(spec) {
  if (typeof spec === 'number') return { cols: spec, rows: spec };
  const cols = Number(spec && spec.cols);
  const rows = Number(spec && spec.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) {
    throw new Error(`Bad board dimensions: ${JSON.stringify(spec)}`);
  }
  return { cols, rows };
}

const cellCount = spec => {
  const { cols, rows } = dims(spec);
  return cols * rows;
};

// On a physical die the Q face is printed "Qu" and plays as two letters.
function faceToTile(letter) {
  return letter === 'Q' ? 'QU' : letter;
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Enough dice to fill the board. The printed sets stop at 25, so a grown
// Marathon board reuses the larger set, reshuffled each time it runs out —
// still real die faces, just more of them.
function dicePool(cells, rng) {
  const base = cells <= DICE_4.length ? DICE_4 : DICE_5;
  const pool = [];
  while (pool.length < cells) pool.push(...shuffle(base, rng));
  return pool.slice(0, cells);
}

// Returns a flat array of tiles, row-major. A tile is a string: usually one
// letter, but "QU" for the Q die.
function rollBoard(spec, rng = Math.random) {
  const cells = cellCount(spec);
  return dicePool(cells, rng).map(die => faceToTile(die[Math.floor(rng() * die.length)]));
}

// Roll a single strip of tiles — one new row or column for a growing board.
function rollStrip(length, rng = Math.random) {
  return dicePool(length, rng).map(die => faceToTile(die[Math.floor(rng() * die.length)]));
}

// Grow a board by one row or column on the given side, returning the new
// board and its new dimensions. Existing tiles keep their letters; only the
// indices shift, which is why the client re-renders rather than patching.
const SIDES = ['top', 'bottom', 'left', 'right'];

function growBoard(board, spec, side, rng = Math.random) {
  const { cols, rows } = dims(spec);
  if (!SIDES.includes(side)) throw new Error(`Unknown side: ${side}`);

  if (side === 'top' || side === 'bottom') {
    const strip = rollStrip(cols, rng);
    const next = side === 'top' ? [...strip, ...board] : [...board, ...strip];
    return { board: next, cols, rows: rows + 1, added: strip.length };
  }

  const strip = rollStrip(rows, rng);
  const next = [];
  for (let r = 0; r < rows; r++) {
    const rowTiles = board.slice(r * cols, (r + 1) * cols);
    next.push(...(side === 'left' ? [strip[r], ...rowTiles] : [...rowTiles, strip[r]]));
  }
  return { board: next, cols: cols + 1, rows, added: strip.length };
}

// Neighbour indices for every cell, precomputed once per shape. Boggle
// adjacency is all 8 directions.
const neighbourCache = new Map();
function neighbours(spec) {
  const { cols, rows } = dims(spec);
  const key = `${cols}x${rows}`;
  if (neighbourCache.has(key)) return neighbourCache.get(key);

  const table = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const list = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          list.push(nr * cols + nc);
        }
      }
      table.push(list);
    }
  }
  neighbourCache.set(key, table);
  return table;
}

// Walks the board looking for `word`, returning the winning path as cell
// indices, or null. This is the server's proof that a claimed word is
// actually on the board — never trust the path the client drew.
function findPath(board, spec, word) {
  const target = word.toUpperCase();
  const adj = neighbours(spec);
  const used = new Array(board.length).fill(false);
  const path = [];

  function walk(cell, pos) {
    const tile = board[cell];
    if (!target.startsWith(tile, pos)) return false;
    const next = pos + tile.length;
    used[cell] = true;
    path.push(cell);
    if (next === target.length) return true;
    for (const n of adj[cell]) {
      if (!used[n] && walk(n, next)) return true;
    }
    used[cell] = false;
    path.pop();
    return false;
  }

  for (let i = 0; i < board.length; i++) {
    if (walk(i, 0)) return path.slice();
    used.fill(false);
    path.length = 0;
  }
  return null;
}

module.exports = {
  DICE_4, DICE_5, SIDES,
  dims, cellCount, rollBoard, rollStrip, growBoard, neighbours, findPath
};
