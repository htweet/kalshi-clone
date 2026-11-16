'use strict';
// WAL checkpoints and the ledger audit's read snapshot (one-hour soak finding 2026-11-16, CLONE_SPEC.md §39.20 item 9).
// Real server on a SQLite file. Each check fails on the code before the fix:
//   • the server's connection never checkpoints (wal_autocheckpoint 0; the operations worker does it): a reader holds the
//     WAL while ~200 MB is written, then lets go, and no request-sized write transaction afterwards takes long — the old
//     automatic checkpoint copied the whole backlog into the database file and synced it inside the next COMMIT on the
//     request thread; and the WAL still starts over (bounded file) while the server keeps writing;
//   • the scheduled ledger audit reads only the postings added since its previous recount (it re-read the whole journal,
//     a read snapshot that grew with the database), still finds a broken entry among the new ones, and recounts
//     everything when the earlier rows are no longer the ones it counted.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { start } = require('../server/index.js');
const LA = require('../server/ledger-audit');
const journal = require('../server/journal');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-ckpt-'));
const DB_FILE = path.join(TMP, 'ckpt.db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let srv;
before(async () => { srv = await start({ port: 0, dbFile: DB_FILE, quiet: true, sports: false, tickMs: 1000 }); });
after(async () => { await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

// A read transaction in another thread, held until told to end (the ledger audit / verifiers in the operations worker).
function holdReader(file) {
  const w = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(workerData, { readOnly: true });
    d.exec('BEGIN'); d.prepare('SELECT COUNT(*) c FROM ckpt_pad').get();
    parentPort.postMessage('holding');
    parentPort.once('message', () => { d.exec('COMMIT'); d.close(); parentPort.postMessage('done'); });`, { eval: true, workerData: file });
  const ready = new Promise((r) => w.once('message', r));
  return { ready, release: () => new Promise((r) => { w.once('message', r); w.postMessage('go'); }).then(() => w.terminate()) };
}

test('checkpoints run off the request thread: after a reader held 200 MB of WAL, no request-sized commit is slow', async () => {
  const db = srv.db;
  assert.equal(db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, 0, 'the server connection never checkpoints');
  db.exec('CREATE TABLE IF NOT EXISTS ckpt_pad (id INTEGER PRIMARY KEY, v BLOB NOT NULL)');
  const ins = db.prepare('INSERT INTO ckpt_pad(v) VALUES(randomblob(3900))');
  const reader = holdReader(DB_FILE);
  await reader.ready;
  for (let i = 0; i < 50; i++) { db.exec('BEGIN IMMEDIATE'); for (let j = 0; j < 1000; j++) ins.run(); db.exec('COMMIT'); await sleep(1); } // ~200 MB of new pages
  assert.ok(fs.statSync(`${DB_FILE}-wal`).size > 150 * 1048576, 'the held reader kept the WAL from being copied back');
  await reader.release();
  // Request-sized write transactions every 5 ms for 3 s: the old code copied the backlog in the first one.
  let worst = 0; const until = Date.now() + 3000;
  while (Date.now() < until) {
    const t = process.hrtime.bigint();
    db.exec('BEGIN IMMEDIATE'); for (let j = 0; j < 5; j++) ins.run(); db.exec('COMMIT');
    worst = Math.max(worst, Number(process.hrtime.bigint() - t) / 1e6);
    await sleep(5);
  }
  assert.ok(worst < 300, `the slowest write transaction took ${worst.toFixed(0)} ms (the backlog is copied in the operations worker)`);
  // The worker copies the backlog and the WAL starts over (and is trimmed) while the server keeps writing.
  const t0 = Date.now(); let st;
  for (;;) {
    db.exec('BEGIN IMMEDIATE'); ins.run(); db.exec('COMMIT');
    st = srv.app.locals.backups.checkpointStats();
    if (st.last && st.last.log < 5000 && fs.statSync(`${DB_FILE}-wal`).size <= 64 * 1048576) break; // started over, file trimmed
    assert.ok(Date.now() - t0 < 30000, `the WAL starts over within 30 s (${JSON.stringify(st)}, ${fs.statSync(`${DB_FILE}-wal`).size} bytes)`);
    await sleep(20);
  }
  assert.equal(st.in_worker, true);
  assert.equal(st.failures, 0);
  db.exec('DROP TABLE ckpt_pad');
});

test('the scheduled ledger audit reads only new postings, still finds a broken new entry, and recounts after a change', async () => {
  const db = srv.db;
  const full = await LA.runAudit(db, { payments: true, full: true });
  assert.equal(full.recount, 'full');
  assert.equal(full.ok, true, JSON.stringify(full.problems));
  journal.post(db, { kind: 'adjustment', memo: 'checkpoints e2e' }, [['house:ckpt_test_a', 700], ['house:ckpt_test_b', -700]]);
  const inc = await LA.runAudit(db, { payments: true });
  assert.equal(inc.recount, 'incremental', 'the scheduled audit counts only postings added since the last recount');
  assert.equal(inc.ok, true, JSON.stringify(inc.problems));
  assert.equal(inc.totals['house:ckpt_test_a'], 700, 'new postings are in the totals');
  assert.deepEqual(inc.totals, (await LA.runAudit(db, { payments: true, full: true })).totals, 'incremental totals equal a full recount');
  // An unbalanced entry written behind the journal's back is found among the new postings.
  db.prepare("INSERT INTO journal_entries(id,ts,kind,memo) VALUES('je_ckpt_bad',?,'adjustment','broken')").run(Date.now());
  const bad = db.prepare("INSERT INTO journal_postings(entry_id,account,amount_cents) VALUES('je_ckpt_bad','house:ckpt_test_a',13)").run().lastInsertRowid;
  const broken = await LA.runAudit(db, { payments: true });
  assert.equal(broken.recount, 'incremental');
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some((p) => p.check === 'entry_balanced' && p.entry_id === 'je_ckpt_bad'), JSON.stringify(broken.problems));
  assert.ok(broken.problems.some((p) => p.check === 'trial_balance'));
  // Rows the last recount counted are gone: the next audit recounts everything (and is clean again).
  db.prepare('DELETE FROM journal_postings WHERE id=?').run(bad);
  db.prepare("DELETE FROM journal_entries WHERE id='je_ckpt_bad'").run();
  const again = await LA.runAudit(db, { payments: true });
  assert.equal(again.recount, 'full', 'a changed prefix is recounted');
  assert.equal(again.ok, true, JSON.stringify(again.problems));
});
