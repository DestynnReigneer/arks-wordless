'use strict';

// Test runner. Boots the real server on a spare port, runs every suite
// against it, shuts it down, and exits non-zero if anything failed — which is
// what makes it usable as a CI gate.
//
//   npm test

const path = require('node:path');
const { spawn } = require('node:child_process');

const fs = require('node:fs');

const PORT = process.env.TEST_PORT || 3222;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

const SUITES = [
  ['unit', require('./unit.test.js')],
  ['api', require('./api.test.js')]
];

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    const onData = chunk => {
      out += chunk.toString();
      if (out.includes('running at')) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => reject(new Error(`server exited early (${code})\n${out}`)));
    setTimeout(() => reject(new Error(`server did not start in time\n${out}`)), 30000);
  });
}

// Poll rather than assume: the log line appears just before listen() resolves.
async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server never became healthy');
}

// Wipe the test database before every run so results never depend on what a
// previous run left behind.
function resetTestDb() {
  const dir = path.join(ROOT, 'data');
  for (const f of ['test.db', 'test.db-journal', 'test.db-wal', 'test.db-shm']) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* not there */ }
  }
}

(async () => {
  let server = null;
  resetTestDb();
  let total = 0;
  let failed = 0;

  try {
    server = await startServer();
    await waitForHealth();

    for (const [name, suite] of SUITES) {
      console.log(`\n${'='.repeat(60)}\n  ${name}\n${'='.repeat(60)}`);
      const result = await suite.run({ base: BASE, root: ROOT });
      total += result.pass + result.fail;
      failed += result.fail;
    }
  } catch (e) {
    console.error('\nRUNNER FAILED:', e.message);
    failed++;
  } finally {
    if (server) server.kill();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${total - failed}/${total} checks passed`);
  console.log(`${'='.repeat(60)}\n`);
  process.exit(failed ? 1 : 0);
})();
