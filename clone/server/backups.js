'use strict';
// Backups, continuous WAL shipping and point-in-time restore (PLAN P9.2, CLONE_SPEC.md §39.3).
//
// Encryption: every object (snapshot or WAL segment) is sealed with AES-256-GCM under the BACKUP key, which is separate
// from the master key (BACKUP_KEY / BACKUP_KEY_FILE; a dev default `<data>/backup.key`, refused in production by the
// config guard). Object format: "PLXB1" | key-id length (1 byte) | key id (ASCII, 16 hex of SHA-256(key)) | IV (12) |
// ciphertext | GCM tag (16). The previous key (BACKUP_KEY_PREVIOUS) still opens older objects after a rotation.
// Every object also carries the SHA-256 of its plaintext and of its ciphertext in a sidecar manifest (JSON, no secrets)
// so a restore can list and check backups with no database at all.
//
// Snapshots ("interval" every N minutes, "nightly" once a day at the owner-set hour, "pre_production" before the play →
// real-money switch, "manual"): ship pending WAL frames, checkpoint (TRUNCATE) so the main file holds every committed
// page and the WAL is empty, then copy the main file page for page. All of it runs synchronously, so no write of this
// process (the only writer: server/db.js instance lock) can slip in between; the copy is then sealed and uploaded
// asynchronously from a temporary file. A snapshot therefore sits exactly at the start of a WAL generation.
//
// WAL shipping (Litestream-style): automatic checkpoints are switched off on the server's connection; every few seconds
// the new frames of the -wal file, up to the last commit frame, are sealed and uploaded as a segment of the current
// generation; when the WAL grows past a threshold it is checkpointed (TRUNCATE) right after shipping, and the next write
// starts a new generation (new salts). Restore to a time T: the newest snapshot taken at or before T, then every segment
// of the following generations shipped at or before T, applied generation by generation as a WAL file that SQLite
// recovers on open (checksummed frames; a partial generation stops cleanly at its last shipped commit). Loss window: the
// shipping interval (default 10 s).
//
// Retention (owner settings): interval snapshots for `backups.keep_interval_hours`; nightly snapshots 7 daily / 4 weekly /
// 12 monthly; WAL segments older than the oldest retained snapshot are deleted. Every deletion is recorded.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { newId } = require('./util');

const MAGIC = Buffer.from('PLXB1');
const WAL_HEADER = 32;
const FRAME_HEADER = 24;
const dayMs = 86400000;

// ------------------------------------------------------------------------------------------------ backup key
function parseKey(s) {
  const t = String(s).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) { const b = Buffer.from(t, 'base64'); if (b.length === 32) return b; }
  return crypto.createHash('sha256').update(t, 'utf8').digest();
}
const keyId = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);
// Resolves the backup keys: { active, all: Map(id → key), source }. `dir`: where the dev key file lives.
function backupKeys({ dir, env = process.env } = {}) {
  let active; let source;
  if (env.BACKUP_KEY) { active = parseKey(env.BACKUP_KEY); source = 'env'; }
  else {
    const file = path.resolve(env.BACKUP_KEY_FILE || path.join(dir || path.join(__dirname, '..', 'data'), 'backup.key'));
    source = env.BACKUP_KEY_FILE ? 'file' : 'data_dir';
    try { active = parseKey(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT' || env.BACKUP_KEY_FILE) throw e;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const hex = crypto.randomBytes(32).toString('hex');
      try { fs.writeFileSync(file, `${hex}\n`, { mode: 0o600, flag: 'wx' }); active = Buffer.from(hex, 'hex'); } catch (w) { if (w.code !== 'EEXIST') throw w; active = parseKey(fs.readFileSync(file, 'utf8')); }
    }
  }
  const all = new Map([[keyId(active), active]]);
  if (env.BACKUP_KEY_PREVIOUS) { const p = parseKey(env.BACKUP_KEY_PREVIOUS); all.set(keyId(p), p); }
  return { active, activeId: keyId(active), all, source };
}

function seal(plain, keys) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys.active, iv);
  c.setAAD(MAGIC);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const kid = Buffer.from(keys.activeId, 'ascii');
  return Buffer.concat([MAGIC, Buffer.from([kid.length]), kid, iv, ct, c.getAuthTag()]);
}
function open(buf, keys) {
  if (!buf || buf.length < MAGIC.length + 1 + 12 + 16 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a Parlance backup object');
  const n = buf[MAGIC.length];
  const kid = buf.subarray(MAGIC.length + 1, MAGIC.length + 1 + n).toString('ascii');
  const key = keys.all.get(kid);
  if (!key) throw new Error(`backup object sealed with key ${kid}, which is not configured (set BACKUP_KEY or BACKUP_KEY_PREVIOUS)`);
  const at = MAGIC.length + 1 + n;
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(at, at + 12));
  d.setAAD(MAGIC);
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(at + 12, buf.length - 16)), d.final()]);
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------------------------------------ WAL file reading
function readWal(walFile) {
  let fd;
  try { fd = fs.openSync(walFile, 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < WAL_HEADER) return { size, header: null };
    const header = Buffer.alloc(WAL_HEADER);
    fs.readSync(fd, header, 0, WAL_HEADER, 0);
    const pageSize = header.readUInt32BE(8) === 1 ? 65536 : header.readUInt32BE(8);
    return { size, header, pageSize, salt: header.subarray(16, 24).toString('hex'), fd: null, read: (pos, len) => { const b = Buffer.alloc(len); const f = fs.openSync(walFile, 'r'); try { fs.readSync(f, b, 0, len, pos); } finally { fs.closeSync(f); } return b; } };
  } finally { fs.closeSync(fd); }
}

// ------------------------------------------------------------------------------------------------ the service
function createBackups({ db, dbFile, storage, keyDir, settings, audit = () => {}, log = () => {}, now = () => Date.now(), options = {} }) {
  const file = dbFile && dbFile !== ':memory:' ? path.resolve(dbFile) : null;
  const walFile = file ? `${file}-wal` : null;
  const keys = backupKeys({ dir: keyDir });
  const S = (k, d) => { try { const v = settings ? settings(k) : undefined; return v == null ? d : v; } catch { return d; } };
  const metaGet = (k) => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value;
  const metaSet = (k, v) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const shipping = !!(file && storage && options.walShipping !== false);
  if (shipping) db.exec('PRAGMA wal_autocheckpoint = 0'); // this module checkpoints, right after shipping (see above)
  let state = (() => { try { return JSON.parse(metaGet('wal_ship_state') || 'null'); } catch { return null; } })() || { generation: 0, salt: null, frames: 0 };
  const saveState = () => metaSet('wal_ship_state', JSON.stringify(state));
  let busy = Promise.resolve();
  const serial = (fn) => { const p = busy.then(fn, fn); busy = p.catch(() => {}); return p; }; // one upload at a time, in order
  const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

  async function putObject(key, plain, meta) {
    const body = seal(plain, keys);
    const manifest = { ...meta, key_id: keys.activeId, plain_sha256: sha(plain), sha256: sha(body), bytes: body.length };
    await storage.put(key, body, { contentType: 'application/octet-stream', meta: { sha256: manifest.sha256 } });
    await storage.put(`${key}.json`, Buffer.from(JSON.stringify(manifest)), { contentType: 'application/json' });
    return manifest;
  }

  // ---- WAL shipping. Synchronous read of new frames; the upload is queued (ordered) and recorded when it lands.
  function collectFrames() {
    if (!shipping) return null;
    const w = readWal(walFile);
    if (!w || !w.header) return null;
    if (w.salt !== state.salt) { state = { generation: state.generation + 1, salt: w.salt, frames: 0, header: w.header.toString('base64') }; saveState(); }
    const frameSize = FRAME_HEADER + w.pageSize;
    const total = Math.floor((w.size - WAL_HEADER) / frameSize);
    if (total <= state.frames) return null;
    // Only up to the last commit frame (bytes 4-7 of a frame header: database size after a commit, 0 otherwise), and only
    // frames whose salt matches the header (stale frames of an earlier generation can sit past the valid end).
    const buf = w.read(WAL_HEADER + state.frames * frameSize, (total - state.frames) * frameSize);
    let lastCommit = -1;
    for (let i = 0; i < total - state.frames; i++) {
      const fh = buf.subarray(i * frameSize, i * frameSize + FRAME_HEADER);
      if (fh.subarray(8, 16).toString('hex') !== w.salt) break;
      if (fh.readUInt32BE(4) !== 0) lastCommit = i;
    }
    if (lastCommit < 0) return null;
    const n = lastCommit + 1;
    const seg = { generation: state.generation, first_frame: state.frames, frames: n, header: Buffer.from(state.header, 'base64'), page_size: w.pageSize, data: buf.subarray(0, n * frameSize), ts: now() };
    state.frames += n;
    saveState();
    return seg;
  }
  function queueSegment(seg) {
    const id = newId('wal_');
    const key = `wal/${String(seg.generation).padStart(8, '0')}/${String(seg.first_frame).padStart(10, '0')}-${stamp(seg.ts)}.plxw`;
    // Segment plaintext: JSON line with the geometry, newline, then the WAL header (first segment only) and the frames.
    const head = Buffer.from(`${JSON.stringify({ v: 1, generation: seg.generation, first_frame: seg.first_frame, frames: seg.frames, page_size: seg.page_size, ts: seg.ts })}\n`);
    const plain = Buffer.concat([head, seg.first_frame === 0 ? seg.header : Buffer.alloc(0), seg.data]);
    return serial(async () => {
      const m = await putObject(key, plain, { type: 'wal', generation: seg.generation, first_frame: seg.first_frame, frames: seg.frames, ts: seg.ts, page_size: seg.page_size });
      db.prepare('INSERT INTO ops_wal_segments(id,generation,first_frame,frames,last_commit_ts,object_key,bytes,sha256,created_ts) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, seg.generation, seg.first_frame, seg.frames, seg.ts, key, m.bytes, m.sha256, now());
      return key;
    });
  }
  // Checkpoint (TRUNCATE) once everything is collected: the main file then holds every committed page and the next
  // write starts a new generation. Returns true when the WAL is empty.
  function checkpoint() {
    const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    return r && r.busy === 0;
  }
  function shipWal({ force = false } = {}) {
    if (!shipping) return null;
    const seg = collectFrames();
    const p = seg ? queueSegment(seg) : null;
    const w = readWal(walFile);
    if (w && (force || w.size > Number(S('backups.wal_checkpoint_mb', 16)) * 1048576)) checkpoint();
    return p;
  }

  // ---- snapshots
  function snapshot(kind = 'interval', { note = '', actor = null } = {}) {
    if (!file || !storage) return Promise.reject(new Error('backups need a database file and a storage adapter'));
    const id = newId('bk_');
    const t0 = now();
    const schemaVersion = (() => { try { return require('./migrations').version(db); } catch { return null; } })();
    let tmp;
    try {
      const seg = shipping ? collectFrames() : null;
      if (seg) queueSegment(seg);
      if (!checkpoint()) throw new Error('could not checkpoint the database (busy); will retry');
      const generation = shipping ? state.generation + 1 : null; // the next write opens this generation
      tmp = path.join(os.tmpdir(), `parlance-snap-${process.pid}-${id}.db`);
      fs.copyFileSync(file, tmp); // page-for-page copy: WAL segments of later generations apply to it
      db.prepare('INSERT INTO ops_backups(id,kind,status,created_ts,schema_version,wal_generation,note) VALUES(?,?,?,?,?,?,?)').run(id, kind, 'running', t0, schemaVersion, generation, String(note).slice(0, 200));
      if (shipping) { state = { generation: state.generation, salt: '__checkpointed__', frames: 0 }; saveState(); } // next header = next generation
      const key = `snapshots/${new Date(t0).toISOString().slice(0, 10).replace(/-/g, '/')}/${stamp(t0)}-${kind}-${id}.plxb`;
      return serial(async () => {
        try {
          const plain = fs.readFileSync(tmp);
          const m = await putObject(key, plain, { type: 'snapshot', id, kind, ts: t0, schema_version: schemaVersion, wal_generation: generation });
          db.prepare("UPDATE ops_backups SET status='ok', finished_ts=?, object_key=?, bytes=?, sha256=?, plain_sha256=?, key_id=? WHERE id=?").run(now(), key, m.bytes, m.sha256, m.plain_sha256, m.key_id, id);
          log({ msg: 'backup written', kind, id, bytes: m.bytes, ms: now() - t0 });
          audit({ action: 'ops.backup', target_id: id, after: { kind, object_key: key, bytes: m.bytes, sha256: m.sha256 }, reason: note || kind, actor });
          return { id, kind, object_key: key, bytes: m.bytes, sha256: m.sha256, created_ts: t0 };
        } catch (e) {
          db.prepare("UPDATE ops_backups SET status='failed', finished_ts=?, error=? WHERE id=?").run(now(), String(e.message).slice(0, 500), id);
          log({ level: 'error', msg: 'backup failed', kind, id, error: e.message });
          throw e;
        } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
      });
    } catch (e) {
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
      try { db.prepare("INSERT INTO ops_backups(id,kind,status,created_ts,finished_ts,error) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='failed', error=excluded.error").run(id, kind, 'failed', t0, now(), String(e.message).slice(0, 500)); } catch { /* closed */ }
      return Promise.reject(e);
    }
  }

  // ---- retention (owner settings); returns what was deleted
  async function prune() {
    const t = now();
    const ok = db.prepare("SELECT * FROM ops_backups WHERE status='ok' AND deleted_ts IS NULL ORDER BY created_ts DESC").all();
    const keep = new Set();
    const intervalCut = t - Number(S('backups.keep_interval_hours', 48)) * 3600000;
    for (const b of ok) if (b.kind !== 'nightly' && b.created_ts >= intervalCut) keep.add(b.id);
    for (const b of ok.filter((x) => x.kind === 'pre_production' || x.kind === 'manual')) if (b.created_ts >= t - 365 * dayMs) keep.add(b.id); // kept a year
    const nightly = ok.filter((b) => b.kind === 'nightly');
    const pick = (n, bucketOf) => { const seen = new Set(); for (const b of nightly) { const k = bucketOf(new Date(b.created_ts)); if (seen.has(k)) continue; seen.add(k); if (seen.size > n) break; keep.add(b.id); } };
    pick(Number(S('backups.retention_daily', 7)), (d) => d.toISOString().slice(0, 10));
    pick(Number(S('backups.retention_weekly', 4)), (d) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); });
    pick(Number(S('backups.retention_monthly', 12)), (d) => d.toISOString().slice(0, 7));
    if (ok.length) keep.add(ok[0].id); // never delete the newest backup
    const removed = { snapshots: 0, segments: 0 };
    for (const b of ok) {
      if (keep.has(b.id)) continue;
      await storage.delete(b.object_key); await storage.delete(`${b.object_key}.json`);
      db.prepare('UPDATE ops_backups SET deleted_ts=? WHERE id=?').run(now(), b.id);
      removed.snapshots += 1;
    }
    const oldest = db.prepare("SELECT MIN(wal_generation) g FROM ops_backups WHERE status='ok' AND deleted_ts IS NULL AND wal_generation IS NOT NULL").get().g;
    if (oldest != null) {
      for (const s of db.prepare('SELECT * FROM ops_wal_segments WHERE generation<? AND deleted_ts IS NULL').all(oldest)) {
        await storage.delete(s.object_key); await storage.delete(`${s.object_key}.json`);
        db.prepare('UPDATE ops_wal_segments SET deleted_ts=? WHERE id=?').run(now(), s.id);
        removed.segments += 1;
      }
    }
    if (removed.snapshots || removed.segments) audit({ action: 'ops.backup_prune', target_id: 'retention', after: removed, reason: 'retention (owner settings)' });
    return removed;
  }

  // ---- schedule: interval snapshots, nightly (WAT hour), WAL shipping, retention, restore drill
  const timers = [];
  let lastShip = 0; let lastPrune = 0;
  const watHour = (t) => (new Date(t).getUTCHours() + 1) % 24; // West Africa Time = UTC+1, no daylight saving
  const watDay = (t) => new Date(t + 3600000).toISOString().slice(0, 10);
  function tick() {
    if (!file || !storage) return;
    const t = now();
    try {
      if (shipping && t - lastShip >= Number(S('backups.wal_ship_seconds', 10)) * 1000) { lastShip = t; const p = shipWal(); if (p) p.catch((e) => log({ level: 'error', msg: 'wal shipping failed', error: e.message })); }
      const last = db.prepare("SELECT MAX(created_ts) t FROM ops_backups WHERE status IN ('ok','running') AND kind IN ('interval','nightly','manual','pre_production')").get().t || 0;
      const lastNightly = db.prepare("SELECT MAX(created_ts) t FROM ops_backups WHERE status IN ('ok','running') AND kind='nightly'").get().t || 0;
      if (watHour(t) === Number(S('backups.nightly_hour_wat', 2)) && watDay(lastNightly) !== watDay(t)) snapshot('nightly').catch(() => {});
      else if (t - last >= Number(S('backups.interval_minutes', 15)) * 60000) snapshot('interval').catch(() => {});
      if (t - lastPrune >= 3600000) { lastPrune = t; prune().catch((e) => log({ level: 'error', msg: 'backup retention failed', error: e.message })); }
    } catch (e) { if (!/not open|closed/i.test(e.message)) log({ level: 'error', msg: 'backup tick failed', error: e.message }); }
  }
  function startSchedule(everyMs = 5000) {
    if (!file || !storage || timers.length) return;
    timers.push(setInterval(tick, everyMs));
    timers.forEach((x) => x.unref?.());
  }
  async function close() {
    timers.splice(0).forEach(clearInterval);
    try { const p = shipWal({ force: false }); if (p) await p; } catch { /* best effort at shutdown */ }
    await busy;
  }

  const status = () => {
    const last = db.prepare("SELECT * FROM ops_backups WHERE status='ok' AND deleted_ts IS NULL ORDER BY created_ts DESC LIMIT 1").get();
    const lastSeg = db.prepare('SELECT * FROM ops_wal_segments WHERE deleted_ts IS NULL ORDER BY created_ts DESC LIMIT 1').get();
    const failed = db.prepare("SELECT * FROM ops_backups WHERE status='failed' ORDER BY created_ts DESC LIMIT 1").get();
    return {
      enabled: !!(file && storage), storage: storage ? storage.describe() : null, key: { id: keys.activeId, source: keys.source }, wal_shipping: shipping,
      last_backup: last ? { id: last.id, kind: last.kind, time: new Date(last.created_ts).toISOString(), age_sec: Math.round((now() - last.created_ts) / 1000), bytes: last.bytes, sha256: last.sha256, object_key: last.object_key } : null,
      last_wal_segment: lastSeg ? { time: new Date(lastSeg.last_commit_ts).toISOString(), age_sec: Math.round((now() - lastSeg.last_commit_ts) / 1000), generation: lastSeg.generation } : null,
      last_failure: failed ? { time: new Date(failed.created_ts).toISOString(), error: failed.error } : null,
      counts: db.prepare("SELECT kind, COUNT(*) n FROM ops_backups WHERE status='ok' AND deleted_ts IS NULL GROUP BY kind").all(),
    };
  };
  const list = (limit = 50) => db.prepare('SELECT * FROM ops_backups ORDER BY created_ts DESC LIMIT ?').all(limit);

  return { snapshot, shipWal, prune, tick, startSchedule, close, status, list, keys, flush: () => busy, storage, shipping };
}

// ------------------------------------------------------------------------------------------------ restore (no DB needed)
// Lists the snapshots and WAL segments in `storage`, picks the newest snapshot at or before `targetTs` (default: now) and
// applies the shipped segments up to `targetTs`. Writes the result to `outFile` (refuses to overwrite unless `force`).
// Returns { snapshot, generations, segments, target_ts, reached_ts }.
async function restore({ storage, outFile, targetTs = Date.now(), keyDir, force = false, keys = null, log = () => {} }) {
  const k = keys || backupKeys({ dir: keyDir });
  if (!force && fs.existsSync(outFile)) throw new Error(`${outFile} exists; pass --force to replace it`);
  const objects = await storage.list('');
  const manifests = [];
  for (const o of objects.filter((x) => x.key.endsWith('.json') && (x.key.startsWith('snapshots/') || x.key.startsWith('wal/')))) {
    try { manifests.push({ key: o.key.slice(0, -5), ...JSON.parse((await storage.get(o.key)).toString('utf8')) }); } catch { /* unreadable manifest: skipped */ }
  }
  const snaps = manifests.filter((m) => m.type === 'snapshot' && m.ts <= targetTs).sort((a, b) => b.ts - a.ts);
  if (!snaps.length) throw new Error(`no snapshot at or before ${new Date(targetTs).toISOString()}`);
  const snap = snaps[0];
  const getChecked = async (m) => {
    const body = await storage.get(m.key);
    if (!body) throw new Error(`object ${m.key} is missing`);
    if (sha(body) !== m.sha256) throw new Error(`object ${m.key} is corrupt (checksum mismatch)`);
    const plain = open(body, k);
    if (sha(plain) !== m.plain_sha256) throw new Error(`object ${m.key} decrypted to unexpected content`);
    return plain;
  };
  const tmp = `${outFile}.restore-${process.pid}`;
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  fs.writeFileSync(tmp, await getChecked(snap), { mode: 0o600 });
  log({ msg: 'snapshot restored', key: snap.key, ts: snap.ts });
  // WAL generations after the snapshot, each from its first frame, segments contiguous, shipped at or before the target.
  const segs = manifests.filter((m) => m.type === 'wal' && snap.wal_generation != null && m.generation >= snap.wal_generation && m.ts <= targetTs)
    .sort((a, b) => a.generation - b.generation || a.first_frame - b.first_frame);
  const byGen = new Map();
  for (const s of segs) { if (!byGen.has(s.generation)) byGen.set(s.generation, []); byGen.get(s.generation).push(s); }
  let applied = 0; let reached = snap.ts; let generations = 0;
  for (const [gen, list] of [...byGen].sort((a, b) => a[0] - b[0])) {
    if (list[0].first_frame !== 0) { log({ level: 'warn', msg: 'wal generation incomplete, stopping', generation: gen }); break; }
    const parts = []; let expect = 0; let header = null;
    for (const s of list) {
      if (s.first_frame !== expect) break; // a gap: stop at the last contiguous segment
      const plain = await getChecked(s);
      const nl = plain.indexOf(10);
      const meta = JSON.parse(plain.subarray(0, nl).toString('utf8'));
      let body = plain.subarray(nl + 1);
      if (meta.first_frame === 0) { header = body.subarray(0, WAL_HEADER); body = body.subarray(WAL_HEADER); }
      parts.push(body);
      expect += meta.frames; applied += 1; reached = Math.max(reached, meta.ts);
    }
    if (!header) break;
    fs.writeFileSync(`${tmp}-wal`, Buffer.concat([header, ...parts]), { mode: 0o600 });
    const d = new DatabaseSync(tmp); // recovery replays the valid, committed frames of the WAL
    try { d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { d.close(); }
    generations += 1;
  }
  // Leave a self-contained file (no -wal / -shm beside it).
  { const d = new DatabaseSync(tmp); try { d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { d.close(); } }
  for (const f of [`${tmp}-wal`, `${tmp}-shm`]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  if (force) for (const f of [outFile, `${outFile}-wal`, `${outFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  fs.renameSync(tmp, outFile);
  return { snapshot: { key: snap.key, time: new Date(snap.ts).toISOString(), id: snap.id }, generations, segments: applied, target_ts: targetTs, reached_ts: reached };
}

module.exports = { createBackups, restore, backupKeys, seal, open, keyId, readWal };
