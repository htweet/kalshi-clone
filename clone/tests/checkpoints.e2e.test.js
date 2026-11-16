'use strict';
// WAL checkpoints and the ledger audit's read snapshot (one-hour soak finding 2026-11-16, CLONE_SPEC.md §39.20 item 9).
// Real server on a SQLite file. Each check fails on the code before the fix:
//   • the server's connection never checkpoints (wal_autocheckpoint 0; the operations worker does it): a reader holds the
//     WAL while ~200 MB is written, then lets go, and no request-sized write transaction afterwards takes long — the old
//     automatic checkpoint copied the whole backlog into the database file and synced it inside the next COMMIT on the
//     request thread; and the WAL still starts over (bounded file) while the server keeps writing;
//   • with WAL shipping on (item 11), a shipment of ~150 MB and its checkpoint run in the operations worker while
//     request-sized writes continue (the old code read, sealed and checkpointed on the request thread), a snapshot taken
//     in the middle is a valid base, the WAL starts over, and the shipped chain restores every write;
//   • the scheduled ledger audit reads only the postings added since its previous recount (it re-read the whole journal,
//     a read snapshot that grew with the database), still finds a broken entry among the new ones, and recounts
//     everything when the earlier rows are no longer the ones it counted.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { restore } = require('../server/backups');
const storageLib = require('../server/storage');
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

// With WAL shipping on (npm start, production; CLONE_SPEC.md §39.20 item 11) the shipments read the new frames, sealed
// and uploaded them and checkpointed (TRUNCATE) on the request thread: ~150 MB of WAL held it for seconds. Now a
// shipment and its checkpoint run in the operations worker while request-sized writes continue, a snapshot is taken in
// the middle, the WAL still starts over, and the shipped chain (snapshot + generations) restores to the last write.
test('WAL shipping and its checkpoints run off the request thread; the chain they ship restores', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'ship-'));
  const file = path.join(dir, 'ship.db');
  // The schedule's own tick is far away: this test starts every shipment itself.
  const s2 = await start({ port: 0, dbFile: file, quiet: true, sports: false, tickMs: 1000, ops: { schedule: true, backupTickMs: 3600000 } });
  const db = s2.db; const B = s2.app.locals.backups;
  try {
    assert.equal(B.shipping, true);
    assert.equal(db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, 0, 'the server connection never checkpoints');
    db.exec('CREATE TABLE IF NOT EXISTS ship_pad (id INTEGER PRIMARY KEY, v BLOB NOT NULL)');
    const ins = db.prepare('INSERT INTO ship_pad(v) VALUES(randomblob(3900))');
    await B.shipWal({ force: true });
    for (let i = 0; i < 40; i++) { db.exec('BEGIN IMMEDIATE'); for (let j = 0; j < 1000; j++) ins.run(); db.exec('COMMIT'); } // ~150 MB not shipped yet
    assert.ok(fs.statSync(`${file}-wal`).size > 140 * 1048576, 'a large backlog of WAL to ship');
    const eld = monitorEventLoopDelay({ resolution: 10 }); eld.enable();
    let worstTx = 0; let worstCall = 0; const ships = []; let snap = null;
    const t0 = Date.now(); let nextShip = t0;
    while (Date.now() - t0 < 4000) {
      if (Date.now() >= nextShip) {
        nextShip += 700;
        const t = process.hrtime.bigint();
        ships.push(B.shipWal({ force: true }));
        worstCall = Math.max(worstCall, Number(process.hrtime.bigint() - t) / 1e6);
      }
      if (!snap && Date.now() - t0 > 1500) snap = B.snapshot('manual', { note: 'while shipping' });
      const t = process.hrtime.bigint();
      db.exec('BEGIN IMMEDIATE'); for (let j = 0; j < 5; j++) ins.run(); db.exec('COMMIT');
      worstTx = Math.max(worstTx, Number(process.hrtime.bigint() - t) / 1e6);
      await sleep(5);
    }
    eld.disable();
    const stall = eld.max / 1e6;
    await Promise.all(ships); const sn = await snap;
    assert.ok(worstCall < 50, `starting a shipment took ${worstCall.toFixed(0)} ms on the request thread`);
    assert.ok(worstTx < 300, `the slowest write transaction took ${worstTx.toFixed(0)} ms while shipping`);
    assert.ok(stall < 300, `the event loop was blocked for ${stall.toFixed(0)} ms while shipping and checkpointing`);
    // The WAL starts over (a new generation) while writes continue, and its file is trimmed.
    const t1 = Date.now(); let st;
    for (;;) {
      db.exec('BEGIN IMMEDIATE'); ins.run(); db.exec('COMMIT');
      await B.shipWal({ force: true });
      st = B.checkpointStats();
      if (st.restarts > 0 && fs.statSync(`${file}-wal`).size <= 64 * 1048576) break;
      assert.ok(Date.now() - t1 < 30000, `the WAL starts over within 30 s (${JSON.stringify(st)})`);
      await sleep(20);
    }
    assert.equal(st.in_worker, true);
    assert.equal(st.shipping.inline_runs, 0, 'every shipment ran in the operations worker');
    assert.equal(st.shipping.failures, 0, JSON.stringify(st.shipping));
    assert.ok(db.prepare('SELECT COUNT(DISTINCT generation) n FROM ops_wal_segments').get().n >= 2, 'more than one generation shipped');
    db.prepare("INSERT INTO meta(key,value) VALUES('ship_probe','last') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    await B.shipWal(); await B.flush();
    const rows = db.prepare('SELECT COUNT(*) n FROM ship_pad').get().n;
    // A segment shipped twice (a result lost before it was recorded) does not stop the replay.
    const store = path.join(dir, 'backups');
    const first = db.prepare('SELECT object_key FROM ops_wal_segments WHERE generation=(SELECT MAX(wal_generation) FROM ops_backups WHERE id=?) ORDER BY first_frame LIMIT 1').get(sn.id);
    if (first) for (const ext of ['', '.json']) fs.copyFileSync(path.join(store, ...`${first.object_key}${ext}`.split('/')), path.join(store, ...`${first.object_key.replace(/\.plxw$/, '-dup.plxw')}${ext}`.split('/')));
    const out = path.join(dir, 'restored.db');
    const r = await restore({ storage: storageLib.localDriver({ dir: store }), outFile: out, keyDir: dir });
    assert.equal(r.snapshot.id, sn.id, 'the snapshot taken while shipping is the base');
    const d = new DatabaseSync(out);
    try {
      assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(d.prepare("SELECT value FROM meta WHERE key='ship_probe'").get()?.value, 'last', 'the last shipped write is restored');
      assert.equal(d.prepare('SELECT COUNT(*) n FROM ship_pad').get().n, rows, 'every shipped row is restored');
    } finally { d.close(); }
  } finally { await s2.close(); }
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
