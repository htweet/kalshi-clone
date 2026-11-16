'use strict';
// Backups, continuous WAL shipping and point-in-time restore (PLAN P9.2, CLONE_SPEC.md §39.3).
//
// Encryption: every object (snapshot or WAL segment) is sealed with AES-256-GCM under the BACKUP key, which is separate
// from the master key (BACKUP_KEY / BACKUP_KEY_FILE; a dev default `<data>/backup.key`, refused in production by the
// config guard). Two object formats (SECURITY.md › Backups):
//   PLXB1 (WAL segments; snapshots before 2026-11-13): "PLXB1" | key-id length (1 byte) | key id (ASCII, 16 hex of
//         SHA-256(key)) | IV (12) | ciphertext | GCM tag (16) — one GCM message.
//   PLXB2 (snapshots since the database growth fix, CLONE_SPEC.md §39.17): chunked AES-256-GCM, sealed and opened as a
//         stream so memory stays bounded whatever the database size: "PLXB2" | key-id length (1) | key id | chunk size
//         (4, big-endian) | nonce prefix (8, random per object) | chunks. Chunk i = the ciphertext of up to `chunk size`
//         plaintext bytes | its GCM tag (16), under IV = nonce prefix | i (4, big-endian) and AAD = the header bytes | i (4)
//         | final flag (1). Every chunk but the last holds exactly `chunk size` bytes; the last one (possibly empty) carries
//         the final flag, so a truncated, reordered, spliced or re-headed object fails authentication.
// Both formats always open (PLXB1 too as a stream, its tag read first). The previous key (BACKUP_KEY_PREVIOUS) still
// opens older objects after a rotation.
// Every object also carries the SHA-256 of its plaintext and of its ciphertext in a sidecar manifest (JSON, no secrets)
// so a restore can list and check backups with no database at all.
//
// Snapshots ("interval" every N minutes, "nightly" once a day at the owner-set hour, "pre_production" before the play →
// real-money switch, "pre_compaction" before `npm run db:compact`, "manual"). Without WAL shipping: checkpoint (TRUNCATE)
// so the main file holds every committed page and the WAL is empty, synchronously. With WAL shipping (CLONE_SPEC.md
// §39.20 item 11): a shipment in the operations worker first ships and checkpoints what is committed; the snapshot then
// records which generation applies on top of the main file (`wal_generation`) and how many of its frames the file may
// already hold (`wal_frame`). Either way the operations worker then reads the main file as a stream, seals it (PLXB2)
// into a staging file and uploads that as a stream; no checkpoint runs while the main file is read (new writes go to the
// WAL); no plaintext copy is written and memory stays bounded whatever the database size (CLONE_SPEC.md §39.17).
//
// WAL shipping (Litestream-style): automatic checkpoints are switched off on the server's connection; every few seconds
// the operations worker reads the new frames of the -wal file up to the last commit frame (checksums checked, as SQLite's
// recovery does), seals and uploads them as segments of the current generation, and when the generation is past a
// threshold checkpoints (PASSIVE) only frames it has shipped; once everything is copied back the WAL starts over and the
// next frames are a new generation (new salts) — walShipTask below. Restore to a time T: the newest snapshot taken at or
// before T, then every segment of its generation and the following ones shipped at or before T, applied generation by
// generation as a WAL file that SQLite recovers on open (checksummed frames; a partial generation stops cleanly at its
// last shipped commit; replaying frames the main file already holds rewrites the same pages). Loss window: the shipping
// interval (default 10 s).
//
// Retention (owner settings): interval snapshots for `backups.keep_interval_hours` and at most the newest
// `backups.keep_interval_count` of them (a large database cannot fill a laptop's disk); nightly snapshots 7 daily / 4 weekly
// / 12 monthly; WAL segments older than the oldest retained snapshot are deleted. Every deletion is recorded.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transform, Writable, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
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
// Opens a whole object held in memory (PLXB1, or a PLXB2 object read into a buffer).
function open(buf, keys) {
  if (buf && buf.length >= MAGIC2.length && buf.subarray(0, MAGIC2.length).equals(MAGIC2)) {
    const dec = chunkDecoder(keys);
    const out = dec.write(buf);
    out.push(dec.end());
    return Buffer.concat(out);
  }
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

// ---- PLXB2: chunked AES-256-GCM as streams (format above).
const MAGIC2 = Buffer.from('PLXB2');
const CHUNK = 1 << 20; // 1 MiB of plaintext per chunk
const TAG = 16;
const ivOf = (prefix, i) => { const iv = Buffer.alloc(12); prefix.copy(iv, 0); iv.writeUInt32BE(i, 8); return iv; };
const aadOf = (header, i, final) => { const t = Buffer.alloc(5); t.writeUInt32BE(i, 0); t[4] = final ? 1 : 0; return Buffer.concat([header, t]); };
function createSealStream(keys, { chunkSize = CHUNK } = {}) {
  const kid = Buffer.from(keys.activeId, 'ascii');
  const size = Buffer.alloc(4); size.writeUInt32BE(chunkSize, 0);
  const header = Buffer.concat([MAGIC2, Buffer.from([kid.length]), kid, size, crypto.randomBytes(8)]);
  const prefix = header.subarray(header.length - 8);
  let i = 0; let pending = []; let have = 0; let started = false;
  const chunk = (plain, final) => {
    if (i >= 0xffffffff) throw new Error('backup object too large');
    const c = crypto.createCipheriv('aes-256-gcm', keys.active, ivOf(prefix, i));
    c.setAAD(aadOf(header, i, final));
    const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    i += 1;
    return out;
  };
  return new Transform({
    transform(data, enc, cb) {
      try {
        if (!started) { started = true; this.push(header); }
        pending.push(data); have += data.length;
        if (have >= chunkSize) {
          let all = pending.length === 1 ? pending[0] : Buffer.concat(pending);
          while (all.length >= chunkSize) { this.push(chunk(all.subarray(0, chunkSize), false)); all = all.subarray(chunkSize); }
          pending = all.length ? [Buffer.from(all)] : []; have = all.length;
        }
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        if (!started) { started = true; this.push(header); }
        this.push(chunk(Buffer.concat(pending), true));
        cb();
      } catch (e) { cb(e); }
    },
  });
}
// PLXB2 decoder: write(bytes) → plaintext buffers ready so far; end() → the last plaintext. Throws on a wrong key, any
// altered byte, reordering, truncation or trailing data.
function chunkDecoder(keys) {
  let header = null; let key = null; let chunkSize = 0; let prefix = null;
  let buf = Buffer.alloc(0); let i = 0;
  const open1 = (body, final) => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, ivOf(prefix, i));
    d.setAAD(aadOf(header, i, final));
    d.setAuthTag(body.subarray(body.length - TAG));
    const out = Buffer.concat([d.update(body.subarray(0, body.length - TAG)), d.final()]);
    i += 1;
    return out;
  };
  return {
    write(data) {
      const out = [];
      buf = buf.length ? Buffer.concat([buf, data]) : data;
      if (!header) {
        if (buf.length < MAGIC2.length + 1) return out;
        if (!buf.subarray(0, MAGIC2.length).equals(MAGIC2)) throw new Error('not a Parlance backup object');
        const n = buf[MAGIC2.length];
        const hl = MAGIC2.length + 1 + n + 4 + 8;
        if (buf.length < hl) return out;
        header = Buffer.from(buf.subarray(0, hl));
        const kid = header.subarray(MAGIC2.length + 1, MAGIC2.length + 1 + n).toString('ascii');
        key = keys.all.get(kid);
        if (!key) throw new Error(`backup object sealed with key ${kid}, which is not configured (set BACKUP_KEY or BACKUP_KEY_PREVIOUS)`);
        chunkSize = header.readUInt32BE(MAGIC2.length + 1 + n);
        if (!(chunkSize > 0 && chunkSize <= 64 << 20)) throw new Error('backup object header is damaged');
        prefix = header.subarray(hl - 8);
        buf = buf.subarray(hl);
      }
      // A full chunk is opened only once more bytes follow it: the last chunk is the one marked final.
      while (buf.length > chunkSize + TAG) { out.push(open1(buf.subarray(0, chunkSize + TAG), false)); buf = buf.subarray(chunkSize + TAG); }
      if (buf.length) buf = Buffer.from(buf);
      return out;
    },
    end() {
      if (!header || buf.length < TAG || buf.length >= chunkSize + TAG) throw new Error('backup object is truncated');
      return open1(buf, true);
    },
  };
}
function createOpenStream(keys) {
  const dec = chunkDecoder(keys);
  return new Transform({
    transform(data, enc, cb) { try { for (const b of dec.write(data)) this.push(b); cb(); } catch (e) { cb(e); } },
    flush(cb) { try { this.push(dec.end()); cb(); } catch (e) { cb(e); } },
  });
}
// A pass-through that hashes (SHA-256) and counts what flows through it.
function hashTap() {
  const h = crypto.createHash('sha256'); let n = 0;
  const t = new Transform({ transform(d, e, cb) { h.update(d); n += d.length; cb(null, d); } });
  t.result = () => ({ sha256: h.digest('hex'), bytes: n });
  return t;
}
const sink = () => new Writable({ write(d, e, cb) { cb(); } });
// Seals a file into another as PLXB2 → { plain_sha256, sha256, bytes (sealed), plain_bytes }. Memory: about one chunk.
async function sealFile(inFile, outFile, keys, { chunkSize = CHUNK } = {}) {
  const plain = hashTap(); const sealed = hashTap();
  await pipeline(fs.createReadStream(inFile, { highWaterMark: chunkSize }), plain, createSealStream(keys, { chunkSize }), sealed, fs.createWriteStream(outFile, { mode: 0o600 }));
  const p = plain.result(); const c = sealed.result();
  return { plain_sha256: p.sha256, sha256: c.sha256, bytes: c.bytes, plain_bytes: p.bytes };
}
// SHA-256 and size of a file, streamed.
async function hashFile(file) { const t = hashTap(); await pipeline(fs.createReadStream(file, { highWaterMark: CHUNK }), t, sink()); return t.result(); }
// Opens a sealed object file (PLXB1 or PLXB2) into outFile as a stream → { plain_sha256, bytes }. Plaintext reaches
// outFile before authentication completes, so callers write to a temporary name and rename it afterwards; on failure
// the partial file is removed.
async function openFile(inFile, outFile, keys) {
  const size = (await fs.promises.stat(inFile)).size;
  const head = Buffer.alloc(Math.min(size, 64));
  const fd = await fs.promises.open(inFile, 'r');
  try { await fd.read(head, 0, head.length, 0); } finally { await fd.close(); }
  const plain = hashTap();
  try {
    if (head.subarray(0, MAGIC2.length).equals(MAGIC2)) {
      await pipeline(fs.createReadStream(inFile, { highWaterMark: CHUNK }), createOpenStream(keys), plain, fs.createWriteStream(outFile, { mode: 0o600 }));
    } else {
      // PLXB1: one GCM message whose tag is the last 16 bytes; the tag is set first and the ciphertext streams through.
      if (size < MAGIC.length + 1 + 12 + 16 || !head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a Parlance backup object');
      const n = head[MAGIC.length];
      const kid = head.subarray(MAGIC.length + 1, MAGIC.length + 1 + n).toString('ascii');
      const key = keys.all.get(kid);
      if (!key) throw new Error(`backup object sealed with key ${kid}, which is not configured (set BACKUP_KEY or BACKUP_KEY_PREVIOUS)`);
      const at = MAGIC.length + 1 + n;
      const iv = Buffer.alloc(12); const tag = Buffer.alloc(16);
      const f = await fs.promises.open(inFile, 'r');
      try { await f.read(iv, 0, 12, at); await f.read(tag, 0, 16, size - 16); } finally { await f.close(); }
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAAD(MAGIC); d.setAuthTag(tag);
      const body = at + 12 < size - 16 ? fs.createReadStream(inFile, { start: at + 12, end: size - 17, highWaterMark: CHUNK }) : Readable.from([]);
      await pipeline(body, d, plain, fs.createWriteStream(outFile, { mode: 0o600 }));
    }
  } catch (e) { try { fs.unlinkSync(outFile); } catch { /* none */ } throw e; }
  const r = plain.result();
  return { plain_sha256: r.sha256, bytes: r.bytes };
}

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

// ------------------------------------------------------------------------------------------------ WAL shipping (worker)
// WAL shipping runs in the operations worker (soak follow-up 2026-11-16, CLONE_SPEC.md §39.20 item 11): reading the new
// frames (up to ~200 MB per shipment at 40 orders/s), sealing and uploading them, and the checkpoint that follows took
// the request thread for seconds when the disk was busy. The worker reads the -wal file while the server keeps writing,
// so a frame is shipped only when SQLite itself would recover it: its salt matches the header and its cumulative
// checksum (SQLite's WAL checksum, words big- or little-endian as the header's magic says) matches; a frame still being
// written fails the checksum and waits for the next shipment.
//
// Ordering guarantee (the reason the old code checkpointed on the request thread): SQLite starts the WAL over — and
// overwrites frames — only in a write transaction that began when every frame had been copied into the database file.
// The worker's checkpoints are PASSIVE (never the write lock, never wait) and run while its own read transaction (the
// "pin", begun before the frames were read) is open: a checkpoint never copies a frame newer than an open reader's
// snapshot, so it never copies a frame that was not read — and the WAL cannot start over before every frame is shipped.
// Frames read for a checkpoint are uploaded before it runs; only the short tail read in the catch-up passes that end
// with the WAL starting over is uploaded right after (as the old code uploaded after its TRUNCATE).
const WAL_MAGIC_LE = 0x377f0682; const WAL_MAGIC_BE = 0x377f0683;
const LE_HOST = os.endianness() === 'LE';
// SQLite's WAL checksum over `len` bytes of `buf` from `off` (len a multiple of 8), continuing from [s1, s2].
function walSum(buf, off, len, s, be) {
  let s1 = s[0]; let s2 = s[1];
  if (!be && LE_HOST && (buf.byteOffset + off) % 4 === 0) {
    const w = new Uint32Array(buf.buffer, buf.byteOffset + off, len >> 2);
    for (let i = 0; i < w.length; i += 2) { s1 = (s1 + w[i] + s2) >>> 0; s2 = (s2 + w[i + 1] + s1) >>> 0; }
  } else {
    const rd = be ? (i) => buf.readUInt32BE(i) : (i) => buf.readUInt32LE(i);
    for (let i = off; i < off + len; i += 8) { s1 = (s1 + rd(i) + s2) >>> 0; s2 = (s2 + rd(i + 4) + s1) >>> 0; }
  }
  return [s1, s2];
}
// The -wal header if it is complete and valid: { salt, pageSize, be, header, ck (the first frame's running checksum) }.
function walHeader(fd) {
  const h = Buffer.alloc(WAL_HEADER);
  if (fs.readSync(fd, h, 0, WAL_HEADER, 0) < WAL_HEADER) return null;
  const magic = h.readUInt32BE(0);
  if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) return null;
  const be = magic === WAL_MAGIC_BE;
  const ck = walSum(h, 0, 24, [0, 0], be);
  if (ck[0] !== h.readUInt32BE(24) || ck[1] !== h.readUInt32BE(28)) return null; // torn or not yet written
  const ps = h.readUInt32BE(8);
  return { salt: h.subarray(16, 24).toString('hex'), pageSize: ps === 1 ? 65536 : ps, be, header: h, ck };
}
function walHeaderOf(walFile) {
  let fd;
  try { fd = fs.openSync(walFile, 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { return walHeader(fd); } finally { fs.closeSync(fd); }
}
// Reads the next segment of committed frames after `state` (at most about `maxBytes`, always ending at a commit frame).
// → null (no valid WAL) or { next (the shipping state after this segment), seg (null when nothing new is committed) }.
function readSegment(walFile, state, { maxBytes = Infinity, ts = Date.now() } = {}) {
  let fd;
  try { fd = fs.openSync(walFile, 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const h = walHeader(fd);
    if (!h) return null;
    const frameSize = FRAME_HEADER + h.pageSize;
    let g = state;
    if (h.salt !== state.salt) g = { generation: (state.generation || 0) + 1, salt: h.salt, frames: 0, header: h.header.toString('base64'), page_size: h.pageSize, ck: h.ck };
    const size = fs.fstatSync(fd).size;
    const total = Math.floor((size - WAL_HEADER) / frameSize);
    // A state saved before the checksums were tracked: the running checksum is recomputed from the first frame.
    if (!Array.isArray(g.ck)) {
      let s = h.ck; const b = Buffer.allocUnsafeSlow(frameSize);
      for (let i = 0; i < Math.min(g.frames, total); i++) { fs.readSync(fd, b, 0, frameSize, WAL_HEADER + i * frameSize); s = walSum(b, FRAME_HEADER, h.pageSize, walSum(b, 0, 8, s, h.be), h.be); }
      g = { ...g, ck: s, page_size: h.pageSize };
    }
    if (total <= g.frames) return { next: g, seg: null };
    const chunks = []; let n = 0; let commit = 0; let ckCommit = g.ck; let s = g.ck; let done = false;
    const BATCH = 256;
    for (let at = g.frames; at < total && !done;) {
      const k = Math.min(BATCH, total - at);
      const b = Buffer.allocUnsafeSlow(k * frameSize);
      const got = Math.floor(fs.readSync(fd, b, 0, k * frameSize, WAL_HEADER + at * frameSize) / frameSize);
      let i = 0;
      for (; i < got; i++) {
        const o = i * frameSize;
        if (b.subarray(o + 8, o + 16).toString('hex') !== g.salt) { done = true; break; }
        s = walSum(b, o + FRAME_HEADER, h.pageSize, walSum(b, o, 8, s, h.be), h.be);
        if (s[0] !== b.readUInt32BE(o + 16) || s[1] !== b.readUInt32BE(o + 20)) { done = true; break; } // being written
        n += 1;
        if (b.readUInt32BE(o + 4) !== 0) { commit = n; ckCommit = s; if (commit * frameSize >= maxBytes) { done = true; i += 1; break; } }
      }
      chunks.push(b.subarray(0, i * frameSize));
      if (got < k) done = true;
      at += k;
    }
    if (!commit) return { next: g, seg: null };
    const data = Buffer.concat(chunks, commit * frameSize);
    const seg = { generation: g.generation, first_frame: g.frames, frames: commit, header: Buffer.from(g.header, 'base64'), page_size: h.pageSize, data, ts };
    return { next: { ...g, frames: g.frames + commit, ck: ckCommit, page_size: h.pageSize }, seg };
  } finally { fs.closeSync(fd); }
}
const segKey = (seg) => `wal/${String(seg.generation).padStart(8, '0')}/${String(seg.first_frame).padStart(10, '0')}-${new Date(seg.ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.plxw`;
// Seals a segment (PLXB1, same bytes as seal() of its plaintext, without joining the plaintext first) and uploads it with
// its manifest → the manifest fields recorded in ops_wal_segments.
async function putSegment(store, keys, seg) {
  // Segment plaintext: JSON line with the geometry, newline, then the WAL header (first segment only) and the frames.
  const head = Buffer.from(`${JSON.stringify({ v: 1, generation: seg.generation, first_frame: seg.first_frame, frames: seg.frames, page_size: seg.page_size, ts: seg.ts })}\n`);
  const parts = [head, seg.first_frame === 0 ? seg.header : Buffer.alloc(0), seg.data];
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys.active, iv);
  c.setAAD(MAGIC);
  const ph = crypto.createHash('sha256'); const ct = [];
  for (const p of parts) { ph.update(p); ct.push(c.update(p)); }
  ct.push(c.final());
  const kid = Buffer.from(keys.activeId, 'ascii');
  const body = Buffer.concat([MAGIC, Buffer.from([kid.length]), kid, iv, ...ct, c.getAuthTag()]);
  ct.length = 0;
  const key = segKey(seg);
  const manifest = { type: 'wal', generation: seg.generation, first_frame: seg.first_frame, frames: seg.frames, ts: seg.ts, page_size: seg.page_size, key_id: keys.activeId, plain_sha256: ph.digest('hex'), sha256: sha(body), bytes: body.length };
  await store.put(key, body, { contentType: 'application/octet-stream', meta: { sha256: manifest.sha256 } });
  await store.put(`${key}.json`, Buffer.from(JSON.stringify(manifest)), { contentType: 'application/json' });
  return { key, generation: seg.generation, first_frame: seg.first_frame, frames: seg.frames, ts: seg.ts, bytes: manifest.bytes, sha256: manifest.sha256 };
}
// Contiguous segments of one generation joined into one (the catch-up passes read a few frames each).
function joinSegments(list) {
  const out = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && last.generation === s.generation && last.first_frame + last.frames === s.first_frame) { last.data = Buffer.concat([last.data, s.data]); last.frames += s.frames; } else out.push({ ...s });
  }
  return out;
}

// The connections WAL shipping uses, per database file and thread: `pin`, read-only, holds the read transaction that
// bounds the checkpoint; `ck`, read-write, runs the PASSIVE checkpoints and the one-row write that starts the WAL over.
const shipConns = new Map();
const shipPending = new Map(); // dbFile → segments read and copied back but not uploaded yet (an upload failed)
function shipConnsOf(dbFile, walSizeLimitBytes) {
  let c = shipConns.get(dbFile);
  if (!c) {
    const pin = new DatabaseSync(dbFile, { readOnly: true });
    pin.exec('PRAGMA busy_timeout = 2000'); // a read transaction only waits out a recovery (off the request thread)
    const ck = new DatabaseSync(dbFile);
    ck.exec('PRAGMA busy_timeout = 0');
    ck.exec('PRAGMA synchronous = NORMAL'); // the restart commit does not wait for the disk (checkpoints still sync)
    ck.exec(`PRAGMA journal_size_limit = ${Number(walSizeLimitBytes) || 64 * 1048576}`); // the restarting commit trims the file
    c = { pin, ck, ckSt: ck.prepare('PRAGMA wal_checkpoint(PASSIVE)'), pinSt: pin.prepare('SELECT 1 FROM sqlite_schema LIMIT 1') };
    shipConns.set(dbFile, c);
  }
  return c;
}
function walShipClose(dbFile) {
  const c = shipConns.get(dbFile);
  shipConns.delete(dbFile); shipPending.delete(dbFile);
  if (c) { for (const d of [c.pin, c.ck]) { try { d.close(); } catch { /* already closed */ } } }
  return true;
}
// One shipment (the operations worker's `shipWal` task; on the request thread only as the fallback):
//   1. segments read earlier but not uploaded (a failed upload) go first, in order;
//   2. with the pin held: every committed frame after `state` is read and uploaded (segments of at most `segmentBytes`);
//      when `checkpoint` is allowed (no snapshot is reading the main file) and the generation is past `thresholdBytes`
//      (or `force`), a PASSIVE checkpoint copies what the pin allows — only shipped frames;
//   3. catch-up passes (at most `passes`): pin, read the few frames committed since, checkpoint, unpin; once a pass has
//      copied every frame, one meta row written by this connection starts the WAL over (a new generation) — skipped
//      without waiting when the server is writing; the server's own next write then starts it over instead;
//   4. the frames read in step 3 are uploaded.
// Returns { state, segments (uploaded, in order), pending, checkpoint, error? }; progress made before an error is kept.
async function walShipTask({ dbFile, storageConfig, storage = null, keyHex, keyId, keys: liveKeys = null, state, ts = Date.now(), checkpoint = true, force = false, thresholdBytes = 16 * 1048576, segmentBytes = 64 * 1048576, walSizeLimitBytes, passes = 12 }) {
  const t0 = Date.now();
  const walFile = `${dbFile}-wal`;
  const keys = liveKeys || { active: Buffer.from(keyHex, 'hex'), activeId: keyId };
  const store = storage || require('./storage').create(storageConfig);
  const c = shipConnsOf(dbFile, walSizeLimitBytes);
  const out = { state: { ...state }, segments: [], pending: 0, checkpoint: null };
  const pending = shipPending.get(dbFile) || [];
  shipPending.set(dbFile, pending);
  const pin = () => { c.pin.exec('BEGIN'); c.pinSt.get(); };
  const unpin = () => { try { c.pin.exec('COMMIT'); } catch { /* not in a transaction */ } };
  const salt = () => { const h = walHeaderOf(walFile); return h ? h.salt : null; };
  try {
    while (pending.length) { out.segments.push(await putSegment(store, keys, pending[0])); pending.shift(); }
    let r = null;
    pin();
    try {
      for (;;) {
        const x = readSegment(walFile, out.state, { maxBytes: segmentBytes, ts });
        if (!x) break;
        if (!x.seg) { out.state = x.next; break; }
        out.segments.push(await putSegment(store, keys, x.seg));
        out.state = x.next;
      }
      const genBytes = out.state.frames * (FRAME_HEADER + (out.state.page_size || 4096));
      if (!checkpoint || !(force || genBytes > thresholdBytes)) return out;
      r = c.ckSt.get();
      // The pin bounds the copy: never more than the frames shipped (checked, never expected to fire).
      if (salt() === out.state.salt && r.checkpointed > out.state.frames) out.violation = { checkpointed: r.checkpointed, shipped: out.state.frames };
    } finally { unpin(); }
    const cp = { busy: r.busy, log: r.log, checkpointed: r.checkpointed, passes: 1, restarted: false };
    const gen = out.state.salt;
    for (let n = 0; n < passes && r.busy === 0; n++) {
      pin();
      try {
        const x = readSegment(walFile, out.state, { ts });
        if (x) { if (x.seg) pending.push(x.seg); out.state = x.next; } // read: uploaded below (or by the next shipment)
        r = c.ckSt.get(); cp.passes += 1;
      } finally { unpin(); }
      cp.log = r.log; cp.checkpointed = r.checkpointed;
      const cur = salt();
      if (cur && cur !== gen) { cp.restarted = true; break; } // the server's own write started it over (all was copied)
      if (r.busy !== 0 || r.log !== r.checkpointed || r.log !== out.state.frames || cur !== out.state.salt) continue;
      // Every frame is copied and read: a write that begins now starts the WAL over.
      const before = out.state.salt;
      try {
        c.ck.exec('BEGIN IMMEDIATE');
        try { c.ck.prepare("INSERT INTO meta(key,value) VALUES('wal_restart_ts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now())); c.ck.exec('COMMIT'); } catch (e) { try { c.ck.exec('ROLLBACK'); } catch { /* none */ } throw e; }
      } catch (e) { if (!/locked|busy/i.test(e.message)) throw e; }
      // Not started over (a reader still held old frames, or the server wrote first): that row is a frame of this
      // generation, read by the next pass.
      const now = salt();
      if (now && now !== before) { cp.restarted = true; break; }
    }
    out.checkpoint = cp;
    const joined = joinSegments(pending); pending.length = 0; pending.push(...joined);
    while (pending.length) { out.segments.push(await putSegment(store, keys, pending[0])); pending.shift(); }
  } catch (e) {
    out.error = e.message || String(e);
  } finally {
    unpin();
    out.pending = pending.length;
    out.ms = Date.now() - t0;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the service
function createBackups({ db, dbFile, storage, keyDir, settings, audit = () => {}, log = () => {}, now = () => Date.now(), options = {} }) {
  const file = dbFile && dbFile !== ':memory:' ? path.resolve(dbFile) : null;
  const walFile = file ? `${file}-wal` : null;
  const keys = backupKeys({ dir: keyDir });
  const S = (k, d) => { try { const v = settings ? settings(k) : undefined; return v == null ? d : v; } catch { return d; } };
  const metaGet = (k) => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value;
  const metaSet = (k, v) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const opsWorker = require('./ops-worker');
  const shipping = !!(file && storage && options.walShipping !== false);
  // With WAL shipping the server's connection never checkpoints: the shipments in the operations worker do, copying
  // back only shipped frames (walShipTask above); journal_size_limit trims the -wal file when it starts over.
  const walLimit = Number(options.walSizeLimitBytes || 64 * 1048576);
  if (shipping) { db.exec('PRAGMA wal_autocheckpoint = 0'); db.exec(`PRAGMA journal_size_limit = ${walLimit}`); }
  // Without WAL shipping, checkpoints run in the operations worker (soak finding 2026-11-16, CLONE_SPEC.md §39.20 item 9;
  // server/ops-worker.js `checkpoint`): SQLite's automatic checkpoint ran inside whichever COMMIT crossed 1,000 pages —
  // on the request thread — copying the WAL into the database file and fsyncing both (up to 2 s with the disk busy, more
  // after a reader had held the WAL). The server's connection never checkpoints now; every `checkpointMs` the worker runs
  // a PASSIVE checkpoint on its own connection (no write lock, no waiting for readers), and the server's next write
  // restarts the WAL once it is fully copied. journal_size_limit gives back the disk of a WAL that grew while a long
  // reader held it. With WAL shipping the shipments checkpoint instead (a checkpoint must follow the shipping of the
  // frames it copies), also in the worker. If the worker fails, the automatic checkpoint is switched back on until it
  // works again (without shipping) or the next shipment runs on this thread (with shipping).
  const ckptInWorker = !!(file && !shipping && options.checkpointInWorker !== false);
  const autoPages = () => (ckptInWorker && !ckptFallback ? 0 : 1000);
  let ckptFallback = false; let ckptRun = null; let ckptTimer = null;
  const ckptStats = { runs: 0, restarts: 0, failures: 0, max_ms: 0, last: null };
  function bgCheckpoint() {
    if (ckptRun || copying || !ckptTimer) return ckptRun;
    ckptRun = opsWorker.run('checkpoint', { dbFile: file, walSizeLimitBytes: walLimit }).then((r) => {
      ckptStats.runs += 1; if (r.restarted) ckptStats.restarts += 1; ckptStats.last = r; if (r.ms > ckptStats.max_ms) ckptStats.max_ms = r.ms;
      if (ckptFallback) { ckptFallback = false; try { db.exec(`PRAGMA wal_autocheckpoint = ${autoPages()}`); } catch { /* closed */ } }
    }, (e) => {
      ckptStats.failures += 1;
      if (!ckptFallback) { ckptFallback = true; try { db.exec(`PRAGMA wal_autocheckpoint = ${autoPages()}`); } catch { /* closed */ } log({ level: 'error', msg: 'checkpoint in the operations worker failed; automatic checkpoints are back on', error: e.message }); }
    }).finally(() => { ckptRun = null; });
    return ckptRun;
  }
  let state = (() => { try { return JSON.parse(metaGet('wal_ship_state') || 'null'); } catch { return null; } })() || { generation: 0, salt: null, frames: 0 };
  const saveState = () => metaSet('wal_ship_state', JSON.stringify(state));
  let busy = Promise.resolve();
  const serial = (fn) => { const p = busy.then(fn, fn); busy = p.catch(() => {}); return p; }; // one upload at a time, in order
  const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

  // A snapshot is sealed and uploaded in the operations worker (server/ops-worker.js) as a stream: reading, encrypting,
  // hashing and uploading a large database must neither hold up requests nor hold the database in memory. The worker
  // rebuilds the storage driver from its config; an injected driver (tests) or `useWorker: false` keeps the streaming
  // on this thread.
  // `release()` is called once the main file has been read (sealed into the staging file), before the upload.
  async function sealSnapshot(key, meta, release) {
    const cfg = storage.config ? storage.config() : null;
    const inWorker = !!cfg && options.useWorker !== false;
    // Local store: staged beside the object, moved in with a rename (no second copy). Elsewhere: a temporary file.
    const staging = storage.stagingFile ? storage.stagingFile(key) : path.join(os.tmpdir(), `parlance-snap-${process.pid}-${newId('s')}.plxb`);
    try {
      const sealed = inWorker ? await opsWorker.run('sealFile', { file, out: staging, keyHex: keys.active.toString('hex'), keyId: keys.activeId }) : await sealFile(file, staging, keys);
      release();
      const putOpts = { contentType: 'application/octet-stream', meta: { sha256: sealed.sha256 }, move: true };
      if (inWorker) await opsWorker.run('putFile', { storageConfig: cfg, key, src: staging, opts: putOpts });
      else if (typeof storage.putFile === 'function') await storage.putFile(key, staging, putOpts);
      else await storage.put(key, await fs.promises.readFile(staging), putOpts); // an injected driver without streaming (tests)
      const manifest = { ...meta, key_id: keys.activeId, plain_sha256: sealed.plain_sha256, sha256: sealed.sha256, bytes: sealed.bytes };
      await storage.put(`${key}.json`, Buffer.from(JSON.stringify(manifest)), { contentType: 'application/json' });
      return manifest;
    } finally { await fs.promises.unlink(staging).catch(() => {}); }
  }
  // ---- WAL shipping in the operations worker (walShipTask above; CLONE_SPEC.md §39.20 item 11). This thread only starts a
  // shipment, then records what it reports: the uploaded segments (ops_wal_segments) and the shipping state (meta). The
  // worker rebuilds the store from its config; an injected driver (tests), `useWorker: false`, or a worker that failed
  // (the next shipment) runs the same task on this thread.
  let shipRun = null; let shipInline = false; let lastInline = false;
  const shipStats = { runs: 0, inline_runs: 0, segments: 0, bytes: 0, failures: 0, max_ms: 0, last: null };
  function shipNow({ force = false } = {}) {
    if (!shipping) return Promise.resolve(null);
    if (shipRun) return shipRun.then(() => shipNow({ force }), () => shipNow({ force }));
    const cfg = storage.config ? storage.config() : null;
    const inline = !cfg || options.useWorker === false || shipInline;
    const args = { dbFile: file, storageConfig: cfg, keyHex: keys.active.toString('hex'), keyId: keys.activeId, state, ts: now(),
      checkpoint: !copying, force, thresholdBytes: Number(S('backups.wal_checkpoint_mb', 16)) * 1048576,
      segmentBytes: Number(options.walSegmentBytes || 64 * 1048576), walSizeLimitBytes: walLimit };
    if (inline) { args.storage = storage; args.keys = keys; }
    shipRun = opsWorker.run('shipWal', args, { inline }).then((r) => {
      if (inline) shipStats.inline_runs += 1;
      lastInline = inline;
      shipInline = false;
      const ins = db.prepare('INSERT INTO ops_wal_segments(id,generation,first_frame,frames,last_commit_ts,object_key,bytes,sha256,created_ts) VALUES(?,?,?,?,?,?,?,?,?)');
      for (const m of r.segments) { ins.run(newId('wal_'), m.generation, m.first_frame, m.frames, m.ts, m.key, m.bytes, m.sha256, now()); shipStats.segments += 1; shipStats.bytes += m.bytes; }
      if (JSON.stringify(r.state) !== JSON.stringify(state)) { state = r.state; saveState(); }
      shipStats.runs += 1; if (r.ms > shipStats.max_ms) shipStats.max_ms = r.ms;
      shipStats.last = { ms: r.ms, segments: r.segments.length, pending: r.pending, generation: state.generation, frames: state.frames, checkpoint: r.checkpoint, error: r.error || null };
      if (r.checkpoint) { const c = r.checkpoint; ckptStats.runs += 1; if (c.restarted) ckptStats.restarts += 1; ckptStats.last = { ...c, ms: r.ms }; if (r.ms > ckptStats.max_ms) ckptStats.max_ms = r.ms; }
      if (r.violation) log({ level: 'error', msg: 'wal checkpoint copied frames that were not shipped', ...r.violation });
      if (r.error) { shipStats.failures += 1; throw new Error(r.error); }
      return r;
    }, (e) => {
      // The worker itself failed (it exited or could not start): the next shipment runs on this thread.
      shipStats.failures += 1; shipInline = true;
      throw e;
    }).finally(() => { shipRun = null; });
    return shipRun;
  }
  // Ships what is committed (and, past the threshold or with `force`, checkpoints in the worker). Resolves when recorded.
  const shipWal = ({ force = false } = {}) => shipNow({ force });
  // Waits for the shipment in flight and the queued snapshot uploads.
  async function flush() { while (shipRun) await shipRun.catch(() => {}); await busy; }

  // ---- snapshots
  // `copying`: the main file is being read for a snapshot — no checkpoint may change it until the read ends.
  let copying = false; let current = null;
  if (ckptInWorker) {
    db.exec('PRAGMA wal_autocheckpoint = 0');
    db.exec(`PRAGMA journal_size_limit = ${walLimit}`);
    ckptTimer = setInterval(bgCheckpoint, Number(options.checkpointMs || 250));
    ckptTimer.unref?.();
  }
  // TRUNCATE checkpoint on this thread, never waiting (busy → false): only for a snapshot without WAL shipping (with
  // shipping, checkpoints happen in the worker's shipments). A TRUNCATE checkpoint calls the busy handler until every
  // reader has moved past the WAL, and the operations worker's read snapshot can last seconds, so busy means "retry".
  function checkpoint() {
    db.exec('PRAGMA busy_timeout = 0');
    try {
      const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      return r && r.busy === 0;
    } finally { db.exec('PRAGMA busy_timeout = 5000'); }
  }
  function snapshot(kind = 'interval', opts = {}) {
    if (!file || !storage) return Promise.reject(new Error('backups need a database file and a storage adapter'));
    // One snapshot reads the main file at a time; a second request starts when the first has finished reading.
    if (copying && current) return current.then(() => snapshot(kind, opts), () => snapshot(kind, opts));
    // A checkpoint in the worker holds SQLite's checkpoint lock: the snapshot's own checkpoint starts once it is done.
    if (ckptRun) return ckptRun.then(() => snapshot(kind, opts));
    // With WAL shipping: first a shipment that checkpoints everything shipped (in the worker), so the copy is recent; a
    // failed shipment does not stop the snapshot (the copy is valid whatever was copied back, see below). Then no
    // shipment may be running when the copy starts: none checkpoints until the main file has been read.
    if (shipping && !opts.shipped) return shipNow({ force: true }).catch(() => {}).then(() => snapshot(kind, { ...opts, shipped: true }));
    if (shipRun) return shipRun.then(() => snapshot(kind, opts), () => snapshot(kind, opts));
    const { note = '', actor = null } = opts;
    const id = newId('bk_');
    const t0 = now();
    const schemaVersion = (() => { try { return require('./migrations').version(db); } catch { return null; } })();
    try {
      // Which WAL generation applies on top of the copy. Without shipping: none. With shipping the main file holds the
      // current generation's frames up to some frame (checkpoints copy only shipped frames, the worker's pin) — a restore
      // replays that generation from its first frame (replaying frames the file already holds is what SQLite's own
      // recovery does) and every later one. If the -wal file shows a generation the worker has not read yet, nothing of
      // it is copied back yet: the file is the end of the previous one, i.e. the start of this one. `wal_frame`: at most
      // this many frames of the generation are in the copy, so a restore never replays fewer (CLONE_SPEC.md §39.3).
      let generation = null; let walFrame = 0;
      if (shipping) {
        const h = walHeaderOf(walFile);
        if (h && h.salt === state.salt) { generation = state.generation; walFrame = state.frames; } else generation = state.generation + 1;
      } else if (!checkpoint()) throw new Error('could not checkpoint the database (busy); will retry');
      // From here the main file is read as it is: automatic checkpoints stay off (always off while WAL shipping runs, and
      // shipments do not checkpoint while `copying`; switched off here otherwise).
      copying = true;
      if (!shipping) db.exec('PRAGMA wal_autocheckpoint = 0');
      const release = () => { if (!copying) return; copying = false; if (!shipping) { try { db.exec(`PRAGMA wal_autocheckpoint = ${autoPages()}`); } catch { /* closed */ } } };
      db.prepare('INSERT INTO ops_backups(id,kind,status,created_ts,schema_version,wal_generation,note) VALUES(?,?,?,?,?,?,?)').run(id, kind, 'running', t0, schemaVersion, generation, String(note).slice(0, 200));
      const key = `snapshots/${new Date(t0).toISOString().slice(0, 10).replace(/-/g, '/')}/${stamp(t0)}-${kind}-${id}.plxb`;
      const p = serial(async () => {
        try {
          const m = await sealSnapshot(key, { type: 'snapshot', id, kind, ts: t0, schema_version: schemaVersion, wal_generation: generation, ...(shipping ? { wal_frame: walFrame } : {}) }, release);
          db.prepare("UPDATE ops_backups SET status='ok', finished_ts=?, object_key=?, bytes=?, sha256=?, plain_sha256=?, key_id=? WHERE id=?").run(now(), key, m.bytes, m.sha256, m.plain_sha256, m.key_id, id);
          log({ msg: 'backup written', kind, id, bytes: m.bytes, ms: now() - t0 });
          audit({ action: 'ops.backup', target_id: id, after: { kind, object_key: key, bytes: m.bytes, sha256: m.sha256 }, reason: note || kind, actor });
          return { id, kind, object_key: key, bytes: m.bytes, sha256: m.sha256, created_ts: t0 };
        } catch (e) {
          release();
          db.prepare("UPDATE ops_backups SET status='failed', finished_ts=?, error=? WHERE id=?").run(now(), String(e.message).slice(0, 500), id);
          log({ level: 'error', msg: 'backup failed', kind, id, error: e.message });
          throw e;
        }
      });
      current = p.catch(() => {});
      return p;
    } catch (e) {
      if (copying) { copying = false; if (!shipping) { try { db.exec(`PRAGMA wal_autocheckpoint = ${autoPages()}`); } catch { /* closed */ } } }
      try { db.prepare("INSERT INTO ops_backups(id,kind,status,created_ts,finished_ts,error) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='failed', error=excluded.error").run(id, kind, 'failed', t0, now(), String(e.message).slice(0, 500)); } catch { /* closed */ }
      return Promise.reject(e);
    }
  }

  // ---- retention (owner settings); returns what was deleted
  async function prune() {
    const t = now();
    // Newest first; the row order breaks a tie of equal times, so which backups are kept never depends on chance.
    const ok = db.prepare("SELECT * FROM ops_backups WHERE status='ok' AND deleted_ts IS NULL ORDER BY created_ts DESC, rowid DESC").all();
    const keep = new Set();
    const intervalCut = t - Number(S('backups.keep_interval_hours', 48)) * 3600000;
    // Interval snapshots: within the hours window and among the newest `keep_interval_count` (newest first).
    const maxInterval = Number(S('backups.keep_interval_count', 8));
    let intervals = 0;
    for (const b of ok) {
      if (b.kind === 'nightly' || b.created_ts < intervalCut) continue;
      if (b.kind === 'interval') { intervals += 1; if (intervals > maxInterval) continue; }
      keep.add(b.id);
    }
    for (const b of ok.filter((x) => x.kind === 'pre_production' || x.kind === 'manual' || x.kind === 'pre_compaction')) if (b.created_ts >= t - 365 * dayMs) keep.add(b.id); // kept a year
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
  const startedAt = now(); // scheduled snapshots wait `firstSnapshotDelayMs` after start (npm start: 2 min)
  const watHour = (t) => (new Date(t).getUTCHours() + 1) % 24; // West Africa Time = UTC+1, no daylight saving
  const watDay = (t) => new Date(t + 3600000).toISOString().slice(0, 10);
  function tick() {
    if (!file || !storage) return;
    const t = now();
    try {
      if (shipping && !shipRun && t - lastShip >= Number(S('backups.wal_ship_seconds', 10)) * 1000) { lastShip = t; shipWal().catch((e) => log({ level: 'error', msg: 'wal shipping failed', error: e.message })); }
      const last = db.prepare("SELECT MAX(created_ts) t FROM ops_backups WHERE status IN ('ok','running') AND kind IN ('interval','nightly','manual','pre_production')").get().t || 0;
      const lastNightly = db.prepare("SELECT MAX(created_ts) t FROM ops_backups WHERE status IN ('ok','running') AND kind='nightly'").get().t || 0;
      const settled = t - startedAt >= Number(options.firstSnapshotDelayMs || 0);
      if (!settled) { /* start-up: the first snapshot waits */ } else if (watHour(t) === Number(S('backups.nightly_hour_wat', 2)) && watDay(lastNightly) !== watDay(t)) snapshot('nightly').catch(() => {});
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
    if (ckptTimer) { clearInterval(ckptTimer); ckptTimer = null; }
    try { await shipWal({ force: false }); } catch { /* best effort at shutdown */ }
    await busy;
    if (ckptRun) await ckptRun;
    if (ckptInWorker || shipping) await opsWorker.closeCheckpoints(file);
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

  return { snapshot, shipWal, prune, tick, startSchedule, close, status, list, keys, flush, storage, shipping, checkpoint: bgCheckpoint,
    checkpointStats: () => ({ in_worker: shipping ? !(lastInline || shipInline) : ckptInWorker && !ckptFallback, ...ckptStats, ...(shipping ? { shipping: { ...shipStats } } : {}) }) };
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
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}.obj`]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  // The snapshot as a stream (memory bounded whatever its size): the local store's own file, else a download into a
  // temporary file; its checksum is checked first, then it is decrypted into the restore file.
  {
    let src = storage.pathOf ? storage.pathOf(snap.key) : null; let fetched = null;
    if (!src || !fs.existsSync(src)) {
      fetched = `${tmp}.obj`;
      if (typeof storage.getFile === 'function') { if (!(await storage.getFile(snap.key, fetched))) throw new Error(`object ${snap.key} is missing`); }
      else { const body = await storage.get(snap.key); if (!body) throw new Error(`object ${snap.key} is missing`); fs.writeFileSync(fetched, body, { mode: 0o600 }); } // an injected driver (tests)
      src = fetched;
    }
    try {
      if ((await hashFile(src)).sha256 !== snap.sha256) throw new Error(`object ${snap.key} is corrupt (checksum mismatch)`);
      const r = await openFile(src, tmp, k);
      if (r.plain_sha256 !== snap.plain_sha256) { try { fs.unlinkSync(tmp); } catch { /* none */ } throw new Error(`object ${snap.key} decrypted to unexpected content`); }
    } finally { if (fetched) { try { fs.unlinkSync(fetched); } catch { /* none */ } } }
  }
  log({ msg: 'snapshot restored', key: snap.key, ts: snap.ts });
  // WAL generations after the snapshot, each from its first frame, segments contiguous, shipped at or before the target.
  const segs = manifests.filter((m) => m.type === 'wal' && snap.wal_generation != null && m.generation >= snap.wal_generation && m.ts <= targetTs)
    .sort((a, b) => a.generation - b.generation || a.first_frame - b.first_frame || b.frames - a.frames);
  const byGen = new Map();
  for (const s of segs) { if (!byGen.has(s.generation)) byGen.set(s.generation, []); byGen.get(s.generation).push(s); }
  let applied = 0; let reached = snap.ts; let generations = 0;
  let nextGen = snap.wal_generation;
  for (const [gen, list] of [...byGen].sort((a, b) => a[0] - b[0])) {
    // Generations apply in an unbroken run from the snapshot's own: a missing generation (never shipped, e.g. the writes
    // of `npm run db:compact` while the server was stopped) ends the replay — a later one belongs to another base.
    if (gen !== nextGen) { log({ level: 'warn', msg: 'wal generation missing, stopping', generation: nextGen }); break; }
    nextGen += 1;
    if (list[0].first_frame !== 0) { log({ level: 'warn', msg: 'wal generation incomplete, stopping', generation: gen }); break; }
    // The generation's WAL file, written segment by segment (one segment in memory at a time).
    let expect = 0; let header = null; let fd = null;
    try {
      for (const s of list) {
        if (s.first_frame > expect) break; // a gap: stop at the last contiguous segment
        // A segment shipped twice (a shipment whose result was not recorded before the process stopped is shipped again,
        // possibly longer): the frames are the same bytes; only the ones not written yet are added.
        if (s.first_frame + s.frames <= expect) continue;
        const plain = await getChecked(s);
        const nl = plain.indexOf(10);
        const meta = JSON.parse(plain.subarray(0, nl).toString('utf8'));
        let body = plain.subarray(nl + 1);
        if (meta.first_frame === 0) { body = body.subarray(WAL_HEADER); if (!header) { header = plain.subarray(nl + 1, nl + 1 + WAL_HEADER); fd = fs.openSync(`${tmp}-wal`, 'w', 0o600); fs.writeSync(fd, header); } }
        if (fd == null) break;
        const skip = expect - meta.first_frame;
        fs.writeSync(fd, body.subarray(skip * (FRAME_HEADER + meta.page_size)));
        expect = meta.first_frame + meta.frames; applied += 1; reached = Math.max(reached, meta.ts);
      }
    } finally { if (fd != null) fs.closeSync(fd); }
    if (!header) break;
    // The snapshot's own generation: its copy already holds up to `wal_frame` of these frames (shipping in the worker,
    // CLONE_SPEC.md §39.20 item 11). Replaying fewer would put older pages over newer ones: the copy stays as it is.
    if (gen === snap.wal_generation && expect < Number(snap.wal_frame || 0)) {
      log({ level: 'warn', msg: 'wal generation shorter than the snapshot, stopping', generation: gen, frames: expect, wal_frame: snap.wal_frame });
      for (const f of [`${tmp}-wal`, `${tmp}-shm`]) { try { fs.unlinkSync(f); } catch { /* none */ } }
      break;
    }
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

module.exports = { createBackups, restore, backupKeys, seal, open, keyId, readWal, readSegment, walHeaderOf, walShipTask, walShipClose, sealFile, openFile, hashFile, createSealStream, createOpenStream, CHUNK };
