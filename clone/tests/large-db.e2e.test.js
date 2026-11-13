'use strict';
// Large-database regressions (owner report 2026-11-13: a 3.8 GB database after ten days of `npm start` answered "request
// timed out"; CLONE_SPEC.md §39.17). Real servers on SQLite files, no network:
//   • with over a million orders and five million journal postings (tests/lib/big-db.js), the scheduled ledger audit,
//     Admin › Payments › Ledger audit (view and "run now"), Admin › Perps ops › Ledger, a backup and a restore drill never
//     hold the request thread above 700 ms (a client asks the server every 40 ms the whole time) — the old code ran the
//     audits on the request thread (seconds each);
//   • a backup and a restore of a database larger than 2 GiB keep the process's memory bounded (resident set sampled
//     every 50 ms) and restore exactly; a backup object in the earlier one-piece format (PLXB1) still restores — the old
//     code read the whole file into memory and could not back up a database over 2 GiB at all.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { restore, backupKeys, seal } = require('../server/backups');
const storageLib = require('../server/storage');
const { amplify } = require('./lib/big-db');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-large-'));
const PW = 'Benue-Copper-Halyard-6604';
const HIGH = { burst: 1e6, per_second: 1e6 };
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const opts = (dbFile, extra = {}) => ({ port: 0, dbFile, quiet: true, sports: false, tickMs: 300, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, admin: ADMIN, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Asks the server every 40 ms until stopped; returns every answer's time.
function prober(base) {
  const lat = []; let on = true;
  const done = (async () => {
    while (on) {
      const s = Date.now();
      try { await fetch(`${base}/v1/exchange/status`, { signal: AbortSignal.timeout(30000) }); } catch { /* counted as slow */ }
      lat.push(Date.now() - s);
      await sleep(40);
    }
  })();
  return { lat, stop: async () => { on = false; await done; return lat; } };
}
const stepUp = (c) => async (method, p, body) => {
  let r = await c.call(method, p, body);
  if (r.code === 'step_up_required') { assert.equal((await c.call('POST', '/v1/step_up', { password: PW })).status, 200); r = await c.call(method, p, body); }
  return r;
};

test('a million orders, five million postings: the ledger audits (scheduled and admin), a backup and a restore drill never hold up requests', async () => {
  const dir = path.join(TMP, 'big'); const file = path.join(dir, 'big.db');
  let srv = await start(opts(file));
  await srv.close();
  const built = amplify(file, { orders: 1_050_000, entries: 2_600_000, fills: 520_000, trades: 260_000, ledger: 600_000 });
  const d = new DatabaseSync(file);
  const n = (t) => d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  assert.ok(n('orders') >= 1_000_000 && n('journal_postings') >= 5_000_000 && n('fills') >= 500_000, `built in ${built.ms} ms`);
  d.close();
  // The scheduled ledger audit every 4 s (10 minutes in production) so it runs while the client asks.
  srv = await start(opts(file, { payments: { auditIntervalMs: 4000 } }));
  const base = `http://127.0.0.1:${srv.port}`;
  const p = prober(base);
  try {
    await sleep(300);
    const admin = await new Client(base, 'admin').logIn(ADMIN.email, PW);
    const call = stepUp(admin);
    for (let i = 0; i < 300 && !srv.db.prepare("SELECT 1 FROM ledger_audits WHERE trigger='job'").get(); i++) await sleep(100);
    const job = srv.db.prepare("SELECT * FROM ledger_audits WHERE trigger='job' ORDER BY ts DESC LIMIT 1").get();
    assert.ok(job && job.ok === 1, 'the scheduled audit ran (clean) on the large database');
    const view = await call('GET', '/v1/admin/payments/ledger_audit');
    assert.equal(view.status, 200, view.text);
    assert.equal(view.body.live.ok, true, JSON.stringify(view.body.live.problems.slice(0, 3)));
    const now = await call('POST', '/v1/admin/payments/ledger_audit/run', {});
    assert.equal(now.status, 200, now.text);
    assert.equal(now.body.ok, true);
    const perps = await call('GET', '/v1/admin/perps_ops/ledger');
    assert.equal(perps.status, 200, perps.text);
    assert.equal(perps.body.ok, true, JSON.stringify(perps.body.problems));
    const b = await srv.app.locals.backups.snapshot('manual', { note: 'large database regression' });
    assert.ok(b.bytes > 500 * 1048576, 'the backup holds the whole database');
    const drill = await srv.app.locals.ops.restoreDrill({ trigger: 'manual' });
    assert.equal(drill.status, 'ok', JSON.stringify(drill.checks));
  } finally {
    const lat = await p.stop();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    const worst = Math.max(...lat);
    assert.ok(lat.length > 20, `only ${lat.length} answers`);
    assert.ok(worst < 700, `the slowest answer took ${worst} ms while the audits, the backup and the drill ran (${lat.length} answers)`);
  }
});

test('a database over 2 GiB: backup and restore stream with bounded memory; a backup in the earlier format still restores', async () => {
  const dir = path.join(TMP, 'huge'); const file = path.join(dir, 'huge.db');
  let srv = await start(opts(file));
  await srv.close();
  amplify(file, { orders: 20_000, entries: 40_000, fills: 10_000, trades: 5_000, ledger: 10_000, padMb: 2150, padZero: true });
  const size = fs.statSync(file).size;
  assert.ok(size > 2 * 1073741824, `the database is over 2 GiB (${size} bytes)`);
  const plainSha = await new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', (x) => h.update(x)).on('end', () => res(h.digest('hex'))).on('error', rej); });
  srv = await start(opts(file));
  global.gc?.();
  const base0 = process.memoryUsage().rss;
  let peak = base0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  let b;
  try {
    b = await srv.app.locals.backups.snapshot('manual', { note: 'over 2 GiB' });
    assert.ok(b.bytes > size, 'sealed: the whole database plus the chunk tags');
    const raw = fs.openSync(path.join(dir, 'backups', ...b.object_key.split('/')), 'r');
    const head = Buffer.alloc(5); fs.readSync(raw, head, 0, 5, 0); fs.closeSync(raw);
    assert.equal(head.toString(), 'PLXB2', 'the chunked, streamed format');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'backups', ...`${b.object_key}.json`.split('/')), 'utf8'));
    assert.equal(manifest.plain_sha256, plainSha, 'the manifest holds the plaintext checksum of the database as it was');
  } finally { clearInterval(sampler); await srv.close(); }
  const grew = (peak - base0) / 1048576;
  assert.ok(grew < 400, `memory grew by ${grew.toFixed(0)} MB while a ${(size / 1073741824).toFixed(2)} GiB database was backed up`);
  // Restore it (streamed): bounded memory and the same bytes.
  fs.rmSync(file); for (const x of ['-wal', '-shm']) fs.rmSync(file + x, { force: true });
  const out = path.join(dir, 'restored.db');
  peak = process.memoryUsage().rss; const base1 = peak;
  const s2 = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  try { await restore({ storage: storageLib.localDriver({ dir: path.join(dir, 'backups') }), outFile: out, keyDir: dir }); } finally { clearInterval(s2); }
  assert.ok((peak - base1) / 1048576 < 400, `memory grew by ${((peak - base1) / 1048576).toFixed(0)} MB during the restore`);
  const rd = new DatabaseSync(out);
  try {
    assert.equal(rd.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(rd.prepare('SELECT COUNT(*) c FROM zz_pad').get().c, 2150);
  } finally { rd.close(); }
  fs.rmSync(path.join(dir, 'backups'), { recursive: true, force: true }); fs.rmSync(out, { force: true });
  // A snapshot written in the earlier one-piece format (PLXB1) by the previous build still restores.
  const small = path.join(dir, 'small.db');
  { const s = new DatabaseSync(small); s.exec("PRAGMA journal_mode=DELETE; CREATE TABLE t(v TEXT); INSERT INTO t VALUES('from the old format')"); s.close(); }
  const plain = fs.readFileSync(small);
  const keys = backupKeys({ dir });
  const store = storageLib.localDriver({ dir: path.join(dir, 'old-store') });
  const body = seal(plain, keys);
  const key = 'snapshots/2026/11/01/20261101T000000Z-interval-bk_old.plxb';
  await store.put(key, body);
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  await store.put(`${key}.json`, Buffer.from(JSON.stringify({ type: 'snapshot', id: 'bk_old', kind: 'interval', ts: Date.parse('2026-11-01T00:00:00Z'), schema_version: 2, wal_generation: 1, key_id: keys.activeId, plain_sha256: sha(plain), sha256: sha(body), bytes: body.length })));
  const old = path.join(dir, 'old-restored.db');
  await restore({ storage: store, outFile: old, keyDir: dir });
  const od = new DatabaseSync(old);
  try { assert.equal(od.prepare('SELECT v FROM t').get().v, 'from the old format'); } finally { od.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
});
