'use strict';
// Data durability (PLAN P9.2, §8 item 6; CLONE_SPEC.md §39.3-§39.4), real servers + SQLite files, no network:
//   • backup / destroy / restore: encrypted snapshots and continuous WAL shipping; the database files are deleted; the
//     one-command restore (npm run restore) brings back everything shipped, and the integrity, ledger / journal and
//     audit-chain verifiers pass; point-in-time restore to a moment between two writes keeps only the first;
//   • the objects are encrypted with the backup key (no SQLite header, no email in the clear), checksummed (a tampered
//     object is refused), and open with BACKUP_KEY_PREVIOUS after a backup-key change;
//   • retention keeps 7 daily / 4 weekly / 12 monthly nightly backups and the interval window, and deletes WAL older
//     than the oldest kept snapshot;
//   • the S3-compatible adapter against an in-process fake S3 that checks every SigV4 signature (round trip, listing
//     with pagination, a wrong secret refused) — and a backup + restore through it;
//   • CMS media and identity documents move from SQLite to object storage (migration of existing blobs) and are served
//     from there; the restore drill in the app restores the newest backup and records every verifier.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { restore, backupKeys, seal } = require('../server/backups');
const storageLib = require('../server/storage');
const { verifyDatabase } = require('../server/verify');
const { Client } = require('./lib/client');
const { createFakeS3 } = require('./lib/fake-s3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-backups-'));
const PW = 'Benue-Copper-Halyard-6604';
const HIGH = { burst: 1e6, per_second: 1e6 };
const stamp = Date.now();
const email = (n) => `${n}.${stamp}@example.test`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = (dbFile, extra = {}) => ({ port: 0, dbFile, quiet: true, sports: false, tickMs: 300, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH },
  admin: { email: `root.${stamp}@example.test`, password: PW }, ...extra });
let fake; let fakeBase;
before(async () => { fake = createFakeS3(); fakeBase = await fake.listen(); });
after(async () => { await fake.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

async function trader(base, n) {
  const c = await new Client(base, n).signUp(email(n), PW, `Trader ${n}`);
  const r = await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: 250 }, { 'idempotency-key': crypto.randomUUID() });
  assert.equal(r.status, 201, r.text);
  return c;
}

test('backup, destroy, restore with one command; point in time; the verifiers pass on the result', async () => {
  const dir = path.join(TMP, 'live'); const file = path.join(dir, 'live.db');
  const srv = await start(opts(file, { ops: { schedule: true, backupTickMs: 150 } }));
  const base = `http://127.0.0.1:${srv.port}`;
  const B = srv.app.locals.backups;
  let tA; let tB;
  try {
    await trader(base, 'ada');
    const admin = await new Client(base, 'admin').logIn(`root.${stamp}@example.test`, PW);
    assert.equal((await admin.call('PUT', '/v1/admin/flags/social', { enabled: false, reason: 'backup test audit row' })).status, 200);
    const r = await admin.call('POST', '/v1/admin/system/backups', { reason: 'before the drill' });
    assert.equal(r.status, 201, r.text);
    assert.ok(r.body.backup.object_key.startsWith('snapshots/'), 'snapshot written');
    srv.db.prepare("INSERT INTO meta(key,value) VALUES('pitr_probe_1','first')").run();
    await B.shipWal(); await B.flush();
    tA = Date.now(); await sleep(400);
    await trader(base, 'bola');
    srv.db.prepare("INSERT INTO meta(key,value) VALUES('pitr_probe_2','second')").run();
    await B.shipWal(); await B.flush();
    tB = Date.now();
    // Admin › System reports the backup and the WAL shipping.
    const sys = await admin.call('GET', '/v1/admin/system');
    assert.ok(sys.body.backups.last_backup && sys.body.backups.last_wal_segment, JSON.stringify(sys.body.backups));
    // The objects are sealed: no SQLite header, no email in the clear, checksum in the manifest.
    const objDir = path.join(dir, 'backups');
    const snapKey = r.body.backup.object_key;
    const raw = fs.readFileSync(path.join(objDir, ...snapKey.split('/')));
    assert.ok(raw.subarray(0, 5).equals(Buffer.from('PLXB1')) && !raw.includes(Buffer.from('SQLite format 3')) && !raw.includes(Buffer.from(email('ada'))), 'encrypted at rest');
    const manifest = JSON.parse(fs.readFileSync(path.join(objDir, ...`${snapKey}.json`.split('/')), 'utf8'));
    assert.equal(manifest.sha256, crypto.createHash('sha256').update(raw).digest('hex'));
  } finally { await srv.close(); }
  // Destroy the database (the backup store survives elsewhere).
  for (const f of fs.readdirSync(dir)) if (f.startsWith('live.db')) fs.rmSync(path.join(dir, f));
  assert.ok(!fs.existsSync(file));
  // One command: restore to "now" with verification.
  const env = { ...process.env, BACKUP_STORAGE: `local:${path.join(dir, 'backups')}` };
  const out = spawnSync(process.execPath, ['--no-warnings', 'scripts/restore.js', '--to', 'now', '--out', file, '--data-dir', dir, '--verify'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.match(out.stdout, /verify journal: ok/); assert.match(out.stdout, /verify audit_chain: ok/); assert.match(out.stdout, /verify integrity: ok/);
  let d = new DatabaseSync(file);
  assert.deepEqual(d.prepare("SELECT key FROM meta WHERE key LIKE 'pitr_probe_%' ORDER BY key").all().map((x) => x.key), ['pitr_probe_1', 'pitr_probe_2'], 'everything shipped is back');
  assert.equal(d.prepare('SELECT COUNT(*) c FROM users WHERE email IN (?,?)').get(email('ada'), email('bola')).c, 2);
  d.close();
  // Point in time: between the two writes only the first is there.
  const pit = path.join(dir, 'pit.db');
  const r2 = await restore({ storage: storageLib.localDriver({ dir: path.join(dir, 'backups') }), outFile: pit, targetTs: tA, keyDir: dir });
  assert.ok(r2.reached_ts <= tA && tB > tA);
  d = new DatabaseSync(pit);
  assert.deepEqual(d.prepare("SELECT key FROM meta WHERE key LIKE 'pitr_probe_%'").all().map((x) => x.key), ['pitr_probe_1']);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM users WHERE email=?').get(email('bola')).c, 0, 'the later account is not there');
  assert.ok(verifyDatabase(d, { keyDir: dir }).ok, 'the point-in-time copy verifies');
  d.close();
  // The restored database starts and serves.
  const back = await start(opts(file));
  try { assert.equal((await fetch(`http://127.0.0.1:${back.port}/readyz`)).status, 200); } finally { await back.close(); }
});

test('integrity: a tampered object is refused, a previous backup key still opens old objects, the restore drill records its checks', async () => {
  const dir = path.join(TMP, 'keys'); const file = path.join(dir, 'k.db');
  const srv = await start(opts(file));
  try {
    const admin = await new Client(`http://127.0.0.1:${srv.port}`, 'admin').logIn(`root.${stamp}@example.test`, PW);
    const b = await admin.call('POST', '/v1/admin/system/backups', { reason: 'drill source' });
    assert.equal(b.status, 201);
    const drill = await admin.call('POST', '/v1/admin/system/restore_drill', { reason: 'monthly drill' });
    assert.equal(drill.status, 201, drill.text);
    assert.equal(drill.body.drill.status, 'ok');
    for (const k of ['integrity', 'journal', 'audit_chain', 'schema']) assert.equal(drill.body.drill.checks[k].ok, true, `drill check ${k}`);
    assert.equal(drill.body.system.restore_drill.last_ok.id, drill.body.drill.id);
  } finally { await srv.close(); }
  const store = storageLib.localDriver({ dir: path.join(dir, 'backups') });
  const snap = (await store.list('snapshots/')).find((o) => o.key.endsWith('.plxb'));
  // A different backup key cannot open it; with the old one as BACKUP_KEY_PREVIOUS it can.
  const oldKey = fs.readFileSync(path.join(dir, 'backup.key'), 'utf8').trim();
  const newKeys = backupKeys({ dir, env: { BACKUP_KEY: crypto.randomBytes(32).toString('hex') } });
  await assert.rejects(restore({ storage: store, outFile: path.join(dir, 'x.db'), keys: newKeys, keyDir: dir }), /not configured/);
  const both = backupKeys({ dir, env: { BACKUP_KEY: crypto.randomBytes(32).toString('hex'), BACKUP_KEY_PREVIOUS: oldKey } });
  const ok = await restore({ storage: store, outFile: path.join(dir, 'y.db'), keys: both, keyDir: dir });
  assert.ok(ok.snapshot.key);
  // One flipped byte: the checksum in the manifest refuses it.
  const p = path.join(dir, 'backups', ...snap.key.split('/'));
  const buf = fs.readFileSync(p); buf[buf.length - 20] ^= 0xff; fs.writeFileSync(p, buf);
  await assert.rejects(restore({ storage: store, outFile: path.join(dir, 'z.db'), keyDir: dir }), /corrupt/);
});

test('retention: 7 daily, 4 weekly, 12 monthly nightly backups and the interval window are kept; older WAL goes', async () => {
  const dir = path.join(TMP, 'ret'); const file = path.join(dir, 'r.db');
  const srv = await start(opts(file));
  try {
    const db = srv.db; const B = srv.app.locals.backups; const store = B.storage;
    const now = Date.now(); const day = 86400000;
    const ins = db.prepare("INSERT INTO ops_backups(id,kind,status,created_ts,object_key,wal_generation) VALUES(?,?,'ok',?,?,?)");
    const put = async (id, kind, ts, gen) => { const key = `snapshots/test/${id}.plxb`; await store.put(key, seal(Buffer.from(id), B.keys)); await store.put(`${key}.json`, Buffer.from('{}')); ins.run(id, kind, ts, key, gen); };
    for (let i = 0; i < 400; i++) await put(`n${i}`, 'nightly', now - i * day - 3600000, 1000 - i); // a nightly every day for 400 days
    for (let i = 0; i < 10; i++) await put(`iv${i}`, 'interval', now - i * 8 * 3600000, 2000 + i); // every 8 h for 80 h
    db.prepare("INSERT INTO ops_wal_segments(id,generation,first_frame,frames,last_commit_ts,object_key,bytes,sha256,created_ts) VALUES('w_old',1,0,1,0,'wal/old.plxw',1,'x',0)").run();
    await store.put('wal/old.plxw', Buffer.from('x'));
    const removed = await B.prune();
    const kept = db.prepare("SELECT id, kind FROM ops_backups WHERE deleted_ts IS NULL AND status='ok'").all();
    const nightly = kept.filter((k) => k.kind === 'nightly').length;
    const interval = kept.filter((k) => k.kind === 'interval').length;
    assert.ok(nightly >= 12 + 4 && nightly <= 7 + 4 + 12, `nightly kept ${nightly} (7 daily + 4 weekly + 12 monthly, overlapping)`);
    assert.ok(kept.some((k) => k.id === 'n0') && kept.some((k) => k.id === 'n6') && !kept.some((k) => k.id === 'n399'), 'newest kept, the oldest deleted');
    assert.equal(interval, 6, 'interval snapshots of the last 48 hours');
    assert.ok(removed.snapshots > 350 && removed.segments === 1, JSON.stringify(removed));
    assert.equal(await store.get('wal/old.plxw'), null, 'the old WAL segment object is gone');
    assert.ok(db.prepare("SELECT 1 FROM admin_audit WHERE action='ops.backup_prune'").get(), 'audited');
  } finally { await srv.close(); }
});

test('S3-compatible adapter against a fake S3 that checks every signature; backups through it', async () => {
  const s3 = storageLib.s3Driver({ endpoint: fakeBase, region: 'auto', bucket: 'parlance-test', accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey, prefix: 'env1' });
  await s3.put('a/one.txt', Buffer.from('hello'), { meta: { purpose: 'test' } });
  assert.equal(String(await s3.get('a/one.txt')), 'hello');
  assert.equal((await s3.head('a/one.txt')).size, 5);
  assert.equal(await s3.get('a/missing.txt'), null);
  for (let i = 0; i < 5; i++) await s3.put(`many/${i}.bin`, Buffer.from([i]));
  const smallPages = createFakeS3({ pageSize: 2 });
  const sp = await smallPages.listen();
  const s3p = storageLib.s3Driver({ endpoint: sp, bucket: 'b', accessKeyId: smallPages.accessKeyId, secretAccessKey: smallPages.secretAccessKey });
  for (let i = 0; i < 5; i++) await s3p.put(`k/${i}`, Buffer.from('x'));
  assert.deepEqual((await s3p.list('k/')).map((o) => o.key), ['k/0', 'k/1', 'k/2', 'k/3', 'k/4'], 'listing follows continuation tokens');
  await smallPages.close();
  assert.deepEqual((await s3.list('many/')).map((o) => o.key), ['many/0.bin', 'many/1.bin', 'many/2.bin', 'many/3.bin', 'many/4.bin']);
  await s3.delete('a/one.txt');
  assert.equal(await s3.get('a/one.txt'), null);
  assert.ok(fake.buckets.get('parlance-test').has('env1/many/0.bin'), 'the prefix scopes the keys');
  const wrong = storageLib.s3Driver({ endpoint: fakeBase, bucket: 'parlance-test', accessKeyId: fake.accessKeyId, secretAccessKey: 'not-the-secret' });
  await assert.rejects(wrong.put('x', Buffer.from('1')), /SignatureDoesNotMatch/);
  assert.throws(() => storageLib.checkKey('../etc/passwd'));
  assert.throws(() => storageLib.s3Driver({ endpoint: 'http://example.com', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }), /https/);
  // A server whose backup store is the fake S3: snapshot + WAL there, and a restore from it.
  const dir = path.join(TMP, 's3'); const file = path.join(dir, 's.db');
  const backupStorage = { driver: 's3', endpoint: fakeBase, region: 'auto', bucket: 'parlance-backups', accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey };
  const srv = await start(opts(file, { ops: { schedule: true, backupTickMs: 150, backupStorage } }));
  try {
    srv.db.prepare("INSERT INTO meta(key,value) VALUES('s3_probe','yes')").run();
    await srv.app.locals.backups.snapshot('manual');
    srv.db.prepare("INSERT INTO meta(key,value) VALUES('s3_probe_after','yes')").run();
    await srv.app.locals.backups.shipWal(); await srv.app.locals.backups.flush();
    assert.ok([...fake.buckets.get('parlance-backups').keys()].some((k) => k.startsWith('wal/')), 'WAL shipped to the bucket');
  } finally { await srv.close(); }
  const out = path.join(dir, 'restored.db');
  await restore({ storage: storageLib.create(backupStorage), outFile: out, keyDir: dir });
  const d = new DatabaseSync(out);
  assert.deepEqual(d.prepare("SELECT key FROM meta WHERE key LIKE 's3_probe%' ORDER BY key").all().map((x) => x.key), ['s3_probe', 's3_probe_after']);
  d.close();
  assert.ok(fake.log.every((l) => l.status !== 403 || l.key === 'x'), 'only the wrong-secret request was refused');
});

test('media and identity documents move to object storage and are served from there', async () => {
  const dir = path.join(TMP, 'media'); const file = path.join(dir, 'm.db');
  let srv = await start(opts(file));
  await srv.close();
  // Blobs written by an earlier build: in SQLite, no storage key.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  let d = new DatabaseSync(file);
  d.prepare("INSERT INTO cms_media(id,parent_id,variant,mime,ext,width,height,bytes,sha256,data,original_name,created_by,created_at) VALUES('med_old1',NULL,'original','image/png','png',1,1,?,?,?,'old.png','test',?)")
    .run(png.length, crypto.createHash('sha256').update(png).digest('hex'), png, new Date().toISOString());
  d.close();
  srv = await start(opts(file));
  try {
    const st = await srv.app.locals.ops.moveBlobs();
    assert.equal(st.remaining, 0, JSON.stringify(st));
    const row = srv.db.prepare("SELECT storage_key, length(data) n FROM cms_media WHERE id='med_old1'").get();
    assert.equal(row.storage_key, 'media/med_old1.png'); assert.equal(row.n, 0, 'the bytes left SQLite');
    assert.ok(fs.existsSync(path.join(dir, 'objects', 'media', 'med_old1.png')), 'in the local object folder');
    const r = await fetch(`http://127.0.0.1:${srv.port}/media/med_old1.png`);
    assert.equal(r.status, 200);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(png), 'served from object storage');
  } finally { await srv.close(); }
});

// Regression (owner report 2026-11-09: "request timed out", the site slow after Phase 9A): on a long-running database the
// first backup, the restore drill and the live ledger / audit-chain checks each held the request thread for seconds
// (copy, encrypt and hash the whole file; restore and verify it), so every page waited. They now run in the operations
// worker (server/ops-worker.js) and the copy is asynchronous. A 250 MB database is backed up, drilled and verified while
// a client keeps asking the server; no answer may take longer than 700 ms (the old code took several seconds).
test('a large database: backup, restore drill and live verifiers never hold up requests', async () => {
  const dir = path.join(TMP, 'large'); const file = path.join(dir, 'large.db');
  let srv = await start(opts(file));
  await srv.close();
  {
    const d = new DatabaseSync(file);
    d.exec('CREATE TABLE IF NOT EXISTS zz_bulk(id INTEGER PRIMARY KEY, b BLOB)');
    const ins = d.prepare('INSERT INTO zz_bulk(b) VALUES(?)');
    d.exec('BEGIN'); for (let i = 0; i < 2500; i++) ins.run(crypto.randomBytes(100000)); d.exec('COMMIT');
    d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); d.close();
  }
  assert.ok(fs.statSync(file).size > 240 * 1048576, 'the database is large');
  srv = await start(opts(file));
  const lat = []; let probing = true;
  const probe = (async () => {
    while (probing) {
      const s = Date.now();
      try { await fetch(`http://127.0.0.1:${srv.port}/v1/exchange/status`, { signal: AbortSignal.timeout(20000) }); } catch { /* counted as slow below */ }
      lat.push(Date.now() - s);
      await new Promise((r) => setTimeout(r, 40));
    }
  })();
  try {
    await new Promise((r) => setTimeout(r, 300));
    const b = await srv.app.locals.backups.snapshot('manual', { note: 'large database regression' });
    assert.ok(b.bytes > 240 * 1048576, 'the backup holds the whole database');
    const drill = await srv.app.locals.ops.restoreDrill({ trigger: 'manual' });
    assert.equal(drill.status, 'ok', JSON.stringify(drill.checks));
    const v = await srv.app.locals.ops.verifiers({ fresh: true });
    assert.equal(v.ok, true, JSON.stringify(v.checks));
  } finally {
    probing = false; await probe;
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const worst = Math.max(...lat);
  assert.ok(worst < 700, `the slowest answer took ${worst} ms while the backup, drill and checks ran (${lat.length} requests)`);
  assert.ok(lat.length > 20, `only ${lat.length} answers while the backup, drill and checks ran`);
});
