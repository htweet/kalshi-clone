'use strict';
// Data durability (PLAN P9.2, §8 item 6; CLONE_SPEC.md §39.3-§39.4), real servers + SQLite files, no network:
//   • backup / destroy / restore: encrypted snapshots and continuous WAL shipping; the database files are deleted; the
//     one-command restore (npm run restore) brings back everything shipped, and the integrity, ledger / journal and
//     audit-chain verifiers pass; point-in-time restore to a moment between two writes keeps only the first;
//   • the objects are encrypted with the backup key (no SQLite header, no email in the clear), checksummed (a tampered
//     object is refused), and open with BACKUP_KEY_PREVIOUS after a backup-key change;
//   • retention keeps 7 daily / 4 weekly / 12 monthly nightly backups and the interval window, and deletes WAL older
//     than the oldest kept snapshot;
//   • the point-in-time window (owner setting backups.wal_keep_days): WAL older than it goes although a year-old manual
//     snapshot is kept, and that snapshot still restores as it was taken; WAL segments are compact and compressed
//     (PLXB3) and restore to the same database as the source, to a segment boundary in time, and after PLXB1 segments;
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
const { restore, backupKeys, seal, open: openObject, parseSegment } = require('../server/backups');
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
    // Snapshots are sealed as a stream in the chunked format since the database growth fix (PLXB2, CLONE_SPEC.md §39.17).
    assert.ok(raw.subarray(0, 5).equals(Buffer.from('PLXB2')) && !raw.includes(Buffer.from('SQLite format 3')) && !raw.includes(Buffer.from(email('ada'))), 'encrypted at rest');
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
    // By count as well (owner setting backups.keep_interval_count, 8): twelve interval snapshots in the last two hours
    // keep the newest eight (a large database cannot fill the disk; CLONE_SPEC.md §39.17).
    // (Each one strictly newer than everything above: the first part's newest, iv0, was taken at `now` too.)
    for (let i = 0; i < 12; i++) await put(`ic${i}`, 'interval', now + 60000 - i * 1000, 3000 + i);
    await B.prune();
    const recent = db.prepare("SELECT id FROM ops_backups WHERE deleted_ts IS NULL AND status='ok' AND kind='interval' ORDER BY created_ts DESC").all().map((r) => r.id);
    assert.deepEqual(recent, ['ic0', 'ic1', 'ic2', 'ic3', 'ic4', 'ic5', 'ic6', 'ic7'], 'the newest 8 interval snapshots are kept');
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

// Database growth fix (CLONE_SPEC.md §39.17): large objects never pass through memory whole. A file goes to S3 as one
// streamed PUT signed with its SHA-256, or above the part size as a multipart upload; a snapshot sealed and uploaded by
// the operations worker that way restores through a streamed download.
test('S3: streamed and multipart uploads of large objects; a snapshot uploaded in parts restores', async () => {
  const s3 = storageLib.s3Driver({ endpoint: fakeBase, bucket: 'parlance-big', accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey, partSize: 1048576 });
  const dir = path.join(TMP, 's3big'); fs.mkdirSync(dir, { recursive: true });
  const small = path.join(dir, 'small.bin'); fs.writeFileSync(small, crypto.randomBytes(300000));
  const big = path.join(dir, 'big.bin'); fs.writeFileSync(big, crypto.randomBytes(3 * 1048576 + 123));
  await s3.putFile('o/small.bin', small);
  await s3.putFile('o/big.bin', big);
  assert.ok(fs.readFileSync(small).equals(await s3.get('o/small.bin')), 'streamed single PUT');
  assert.ok(fake.multipartDone.some((m) => m.key === 'o/big.bin' && m.parts === 4), 'multipart upload in 4 parts');
  const back = path.join(dir, 'back.bin');
  assert.deepEqual(await s3.getFile('o/big.bin', back), { size: fs.statSync(big).size });
  assert.ok(fs.readFileSync(back).equals(fs.readFileSync(big)), 'streamed download');
  assert.equal(await s3.getFile('o/missing.bin', path.join(dir, 'x')), null);
  // A server whose backup store is that bucket: the snapshot (a few MB) is sealed and sent in parts by the worker.
  const file = path.join(dir, 'b.db');
  const backupStorage = { driver: 's3', endpoint: fakeBase, region: 'auto', bucket: 'parlance-big-backups', accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey, partSize: 1048576 };
  const srv = await start(opts(file, { ops: { backupStorage } }));
  let snap;
  try {
    srv.db.prepare("INSERT INTO meta(key,value) VALUES('s3_big_probe','yes')").run();
    snap = await srv.app.locals.backups.snapshot('manual');
  } finally { await srv.close(); }
  assert.ok(snap.bytes > 1048576 && fake.multipartDone.some((m) => m.key === snap.object_key), 'the snapshot went up in parts');
  const out = path.join(dir, 'restored.db');
  await restore({ storage: storageLib.create(backupStorage), outFile: out, keyDir: dir });
  const d = new DatabaseSync(out);
  assert.equal(d.prepare("SELECT value FROM meta WHERE key='s3_big_probe'").get().value, 'yes');
  d.close();
});

// ---- WAL volume fix (soak 2026-11-16, CLONE_SPEC.md §39.3 and §39.20 item 11)
const day = 86400000;
// Every table's rows, hashed (a logical comparison of two databases). The record of the last shipment itself (its
// ops_wal_segments rows and the shipping state in meta) is written after that shipment, so no backup can hold it.
function tableHashes(d) {
  const out = {};
  for (const { name } of d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_stat%' AND name<>'ops_wal_segments' ORDER BY name").all()) {
    const rows = d.prepare(name === 'meta' ? "SELECT * FROM meta WHERE key<>'wal_ship_state'" : `SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r, (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? String(v) : v))).sort();
    out[name] = `${rows.length}:${crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16)}`;
  }
  return out;
}
// Many small commits that rewrite the same pages (as order traffic does).
function churn(d, rounds, tag) {
  d.exec('CREATE TABLE IF NOT EXISTS zz_churn(id INTEGER PRIMARY KEY, v TEXT, n INTEGER)');
  if (!d.prepare('SELECT COUNT(*) c FROM zz_churn').get().c) { const ins = d.prepare('INSERT INTO zz_churn(id,v,n) VALUES(?,?,0)'); d.exec('BEGIN'); for (let i = 1; i <= 400; i++) ins.run(i, crypto.randomBytes(120).toString('hex')); d.exec('COMMIT'); }
  const up = d.prepare('UPDATE zz_churn SET n=n+1, v=? WHERE id=?'); const add = d.prepare('INSERT INTO zz_churn(v,n) VALUES(?,0)');
  for (let r = 0; r < rounds; r++) { d.exec('BEGIN'); for (let k = 0; k < 15; k++) up.run(`${tag}-${r}-${k}-${crypto.randomBytes(40).toString('hex')}`, 1 + ((r * 37 + k * 11) % 400)); add.run(`${tag}-${r}`); d.exec('COMMIT'); }
}
const backdate = async (store, db, id, ts) => {
  const row = db.prepare('SELECT object_key FROM ops_backups WHERE id=?').get(id);
  db.prepare('UPDATE ops_backups SET created_ts=? WHERE id=?').run(ts, id);
  const m = JSON.parse(String(await store.get(`${row.object_key}.json`)));
  await store.put(`${row.object_key}.json`, Buffer.from(JSON.stringify({ ...m, ts })), { contentType: 'application/json' });
};

test('point-in-time window: WAL older than backups.wal_keep_days goes although a year-old manual snapshot is kept; that snapshot restores as taken', async () => {
  const dir = path.join(TMP, 'window'); const file = path.join(dir, 'w.db');
  const srv = await start(opts(file, { ops: { schedule: true, backupTickMs: 150 } }));
  const B = srv.app.locals.backups; const db = srv.db; const store = B.storage;
  let oldTs; let newSnap;
  try {
    await trader(`http://127.0.0.1:${srv.port}`, 'win');
    db.prepare("INSERT INTO meta(key,value) VALUES('win_old_1','x')").run();
    const old = await B.snapshot('manual', { note: 'a year ago' });
    db.prepare("INSERT INTO meta(key,value) VALUES('win_old_2','x')").run();
    churn(db, 40, 'a');
    await B.shipWal(); await B.flush();
    newSnap = await B.snapshot('interval');
    db.prepare("INSERT INTO meta(key,value) VALUES('win_new_1','x')").run();
    await B.shipWal(); await B.flush();
    // Everything before the new snapshot moves a year back; the manual one is kept a year, interval ones go after 48 h.
    oldTs = Date.now() - 360 * day;
    for (const r of db.prepare('SELECT id FROM ops_backups WHERE status=\'ok\' AND created_ts<?').all(newSnap.created_ts)) await backdate(store, db, r.id, r.id === old.id ? oldTs : oldTs - 60000);
    const genNew = db.prepare('SELECT wal_generation g FROM ops_backups WHERE id=?').get(newSnap.id).g;
    const oldGen = db.prepare('SELECT wal_generation g FROM ops_backups WHERE id=?').get(old.id).g;
    assert.ok(db.prepare('SELECT COUNT(*) c FROM ops_wal_segments WHERE generation<? AND deleted_ts IS NULL').get(genNew).c > 0, 'WAL shipped between the two snapshots');
    const removed = await B.prune();
    assert.ok(removed.segments > 0, `WAL older than the window is deleted (${JSON.stringify(removed)})`);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ops_wal_segments WHERE generation<? AND deleted_ts IS NULL').get(genNew).c, 0, 'no WAL before the window\'s base snapshot');
    assert.ok(db.prepare('SELECT COUNT(*) c FROM ops_wal_segments WHERE generation>=? AND deleted_ts IS NULL').get(genNew).c > 0, 'the window\'s WAL is kept');
    assert.ok(db.prepare('SELECT 1 FROM ops_backups WHERE id=? AND deleted_ts IS NULL').get(old.id), 'the year-old manual snapshot is kept');
    assert.ok(oldGen < genNew);
    assert.equal((await store.list(`wal/${String(oldGen).padStart(8, '0')}/`)).length, 0, 'its WAL objects are gone from the store');
    const w = B.status().wal_window;
    assert.equal(w.keep_days, 7);
    assert.equal(w.oldest_point, new Date(newSnap.created_ts).toISOString(), JSON.stringify(w));
    assert.ok(w.segments > 0 && w.bytes > 0 && w.last_hour_bytes > 0, JSON.stringify(w));
    const admin = await new Client(`http://127.0.0.1:${srv.port}`, 'admin').logIn(`root.${stamp}@example.test`, PW);
    const sys = await admin.call('GET', '/v1/admin/system');
    assert.equal(sys.body.backups.wal_window.keep_days, 7, 'Admin › System shows the window');
  } finally { await srv.close(); }
  // The year-old snapshot restores as it was taken (its WAL is gone); the verifiers pass on it.
  const st = storageLib.localDriver({ dir: path.join(dir, 'backups') });
  const r1 = await restore({ storage: st, outFile: path.join(dir, 'year.db'), targetTs: oldTs + 1000, keyDir: dir });
  assert.equal(r1.wal_kept, false); assert.equal(r1.segments, 0);
  let d = new DatabaseSync(path.join(dir, 'year.db'));
  assert.deepEqual(d.prepare("SELECT key FROM meta WHERE key LIKE 'win_%' ORDER BY key").all().map((x) => x.key), ['win_old_1']);
  assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.ok(verifyDatabase(d, { keyDir: dir }).ok, 'the year-old snapshot verifies');
  d.close();
  // Now: the newest snapshot and the window's WAL.
  const r2 = await restore({ storage: st, outFile: path.join(dir, 'now.db'), keyDir: dir });
  assert.equal(r2.wal_kept, true); assert.ok(r2.segments > 0);
  d = new DatabaseSync(path.join(dir, 'now.db'));
  assert.deepEqual(d.prepare("SELECT key FROM meta WHERE key LIKE 'win_%' ORDER BY key").all().map((x) => x.key), ['win_new_1', 'win_old_1', 'win_old_2']);
  d.close();
  // The owner setting exists, is live and needs step-up like the other backup settings.
  const def = require('../server/owner-settings').DEFS.get('backups.wal_keep_days');
  assert.ok(def && def.default === 7 && def.stepUp === true && def.group === 'backups', JSON.stringify(def));
});

test('PLXB3 WAL segments: compact and compressed, restore equals the source, point in time to a segment boundary, after PLXB1 segments', async () => {
  const dir = path.join(TMP, 'plxb3'); const file = path.join(dir, 'p.db');
  // First run: segments in the old format (PLXB1), as a store written before the fix holds them.
  let srv = await start(opts(file, { ops: { schedule: true, backupTickMs: 150, walFormat: 1 } }));
  try {
    await trader(`http://127.0.0.1:${srv.port}`, 'px1');
    await srv.app.locals.backups.snapshot('manual');
    churn(srv.db, 60, 'v1');
    await srv.app.locals.backups.shipWal(); await srv.app.locals.backups.flush();
  } finally { await srv.close(); }
  // Second run: the new format.
  let mid; let tMid;
  srv = await start(opts(file, { ops: { schedule: true, backupTickMs: 150 } }));
  try {
    const B = srv.app.locals.backups;
    await trader(`http://127.0.0.1:${srv.port}`, 'px2');
    churn(srv.db, 150, 'v3a');
    await B.shipWal(); await B.flush();
    mid = tableHashes(srv.db).zz_churn; tMid = Date.now();
    await sleep(60);
    churn(srv.db, 150, 'v3b');
    await B.shipWal(); await B.flush();
  } finally { await srv.close(); }
  const st = storageLib.localDriver({ dir: path.join(dir, 'backups') });
  const keys = backupKeys({ dir });
  const segs = [];
  for (const o of (await st.list('wal/')).filter((x) => x.key.endsWith('.plxw'))) {
    const raw = await st.get(o.key);
    const m = JSON.parse(String(await st.get(`${o.key}.json`)));
    segs.push({ magic: raw.subarray(0, 5).toString(), m, parsed: parseSegment(openObject(raw, keys)) });
  }
  const v1 = segs.filter((x) => x.magic === 'PLXB1'); const v3 = segs.filter((x) => x.magic === 'PLXB3');
  assert.ok(v1.length > 0 && v3.length > 0, `both formats in the store (${v1.length} PLXB1, ${v3.length} PLXB3)`);
  assert.ok(v1.every((x) => x.m.format !== 'PLXB3' && x.parsed.meta.v === 1));
  assert.ok(v3.every((x) => x.m.format === 'PLXB3' && x.parsed.meta.v === 3 && x.m.stored <= x.m.frames && x.parsed.frames.length === x.m.stored * (24 + x.m.page_size)));
  const frames = v3.reduce((a, x) => a + x.m.frames, 0); const stored = v3.reduce((a, x) => a + x.m.stored, 0);
  const raw = v3.reduce((a, x) => a + x.m.raw_bytes, 0); const sealed = v3.reduce((a, x) => a + x.m.bytes, 0);
  assert.ok(stored < frames / 2, `pages rewritten within a segment are stored once (${stored} of ${frames} frames)`);
  assert.ok(sealed * 4 < raw, `compact + compressed: ${sealed} bytes sealed for ${raw} bytes of frames`);
  // Restore to now: the same database as the source, table by table; integrity and the verifiers (ledger audit) pass.
  const src = new DatabaseSync(file); const want = tableHashes(src); src.close();
  const r = await restore({ storage: st, outFile: path.join(dir, 'r.db'), keyDir: dir });
  assert.ok(r.generations >= 2 && r.segments >= v1.length + 1, JSON.stringify(r));
  let d = new DatabaseSync(path.join(dir, 'r.db'));
  assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(tableHashes(d), want, 'every table equals the source');
  const v = verifyDatabase(d, { keyDir: dir });
  assert.ok(v.ok, JSON.stringify(v.checks));
  d.close();
  // Point in time: between the two shipments, the churn table is as it was at the first one.
  const r2 = await restore({ storage: st, outFile: path.join(dir, 'mid.db'), targetTs: tMid, keyDir: dir });
  assert.ok(r2.reached_ts <= tMid);
  d = new DatabaseSync(path.join(dir, 'mid.db'));
  assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(tableHashes(d).zz_churn, mid, 'the state at the segment boundary');
  d.close();
});
