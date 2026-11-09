'use strict';
// Tamper-evident admin audit log (PLAN P1.14, CLONE_SPEC §22.7).
// Every admin_audit row carries chain_seq (1, 2, 3, …), prev_hash (the previous row's hash; 64 zeros for the
// first) and hash = HMAC-SHA256(audit-chain key, canonical row incl. prev_hash). Editing, deleting or re-ordering
// any row breaks verification from that row on; an HMAC (not a bare hash) means rows cannot be re-chained
// without the server's secret key. The newest row is also recorded as the chain head in `meta`, so deleting the
// tail is detected too.
// Key rotation (RS4, CLONE_SPEC.md §39.10): each row records the key id that sealed it (admin_audit.key_id, NULL = k1);
// new rows are sealed with the active key, verification uses each row's own key, so a rotation keeps every older row
// verifiable while the old key stays in the ring (verify-only).
const { newId } = require('./util');
const { deriveKey, hmacHex, safeEqual } = require('./crypto');
const { ensureSchema } = require('./migrations/schema-guard');

const GENESIS = '0'.repeat(64);
const HEAD_KEY = 'audit_chain_head';
const ready = new WeakMap(); // db -> key (active)
const dirs = new WeakMap(); // db -> the key directory given at the first init (later calls omit it)
const hasKeyCol = new WeakMap(); // db -> admin_audit.key_id exists (migration 0002)
const keyCol = (db) => { if (!hasKeyCol.has(db)) hasKeyCol.set(db, db.prepare('PRAGMA table_info(admin_audit)').all().some((c) => c.name === 'key_id')); return hasKeyCol.get(db); };
// The key a row was sealed with (NULL = k1, the only key before rotation existed).
const keyFor = (active, kid) => ((kid || 'k1') === (active.kid || 'k1') ? active : deriveKey('audit-chain:v1', { ...active.ringOpts, kid: kid || 'k1' }));

const FIELDS = ['id', 'ts', 'actor_id', 'actor_email', 'action', 'target_type', 'target_id', 'before_json', 'after_json', 'reason'];
const canonical = (r) => JSON.stringify([r.chain_seq, ...FIELDS.map((f) => (r[f] === undefined ? null : r[f])), r.prev_hash]);

// The chain columns (part of migration 0001, server/migrations/0001-baseline.js).
function schema(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(admin_audit)').all().map((c) => c.name));
  if (!cols.size) throw new Error('admin_audit table missing');
  if (!cols.has('chain_seq')) db.exec('ALTER TABLE admin_audit ADD COLUMN chain_seq INTEGER');
  if (!cols.has('prev_hash')) db.exec('ALTER TABLE admin_audit ADD COLUMN prev_hash TEXT');
  if (!cols.has('hash')) db.exec('ALTER TABLE admin_audit ADD COLUMN hash TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_audit_chain ON admin_audit(chain_seq)');
}

// Adds the chain columns (idempotent) and seals rows written before chaining existed. Only rows after the last
// chained row are sealed: a row whose hash was cleared in the middle of the chain stays unsealed and fails
// verification instead of being silently re-chained.
function init(db, { keyDir } = {}) {
  if (keyDir !== undefined && !dirs.has(db)) dirs.set(db, keyDir);
  if (ready.has(db)) return ready.get(db);
  const key = deriveKey('audit-chain:v1', { dir: dirs.get(db) });
  ensureSchema(db, schema);
  ready.set(db, key);
  const lastChained = db.prepare('SELECT rowid r FROM admin_audit WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1').get();
  const pending = db.prepare(`SELECT rowid r, * FROM admin_audit WHERE chain_seq IS NULL ${lastChained ? 'AND rowid>?' : ''} ORDER BY ts, rowid`).all(...(lastChained ? [lastChained.r] : []));
  for (const row of pending) seal(db, key, row);
  return key;
}

function head(db) {
  return db.prepare('SELECT chain_seq, hash FROM admin_audit WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1').get() || { chain_seq: 0, hash: GENESIS };
}
function seal(db, key, row) {
  const h = head(db);
  const r = { ...row, chain_seq: h.chain_seq + 1, prev_hash: h.hash };
  r.hash = hmacHex(key, canonical(r));
  db.prepare('UPDATE admin_audit SET chain_seq=?, prev_hash=?, hash=? WHERE id=?').run(r.chain_seq, r.prev_hash, r.hash, r.id);
  if (keyCol(db)) db.prepare('UPDATE admin_audit SET key_id=? WHERE id=?').run(key.kid || 'k1', r.id);
  writeHead(db, key, r);
  return r;
}
function writeHead(db, key, r) {
  const v = JSON.stringify({ chain_seq: r.chain_seq, hash: r.hash, mac: hmacHex(key, `head:${r.chain_seq}:${r.hash}`), ...(key.kid && key.kid !== 'k1' ? { kid: key.kid } : {}) });
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(HEAD_KEY, v);
}

// Append one audit row. `e`: {actor_id, actor_email, action, target_type, target_id, before, after, reason, ts?}.
function append(db, e) {
  const key = init(db);
  const h = head(db);
  const r = {
    id: newId('au_'), ts: e.ts ?? Date.now(), actor_id: e.actor_id ?? null, actor_email: e.actor_email ?? null, action: e.action, target_type: e.target_type || '', target_id: String(e.target_id ?? ''),
    before_json: e.before === undefined || e.before === null ? null : JSON.stringify(e.before), after_json: e.after === undefined || e.after === null ? null : JSON.stringify(e.after), reason: e.reason || '',
    chain_seq: h.chain_seq + 1, prev_hash: h.hash,
  };
  r.hash = hmacHex(key, canonical(r));
  if (keyCol(db)) {
    db.prepare('INSERT INTO admin_audit(id,ts,actor_id,actor_email,action,target_type,target_id,before_json,after_json,reason,chain_seq,prev_hash,hash,key_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.id, r.ts, r.actor_id, r.actor_email, r.action, r.target_type, r.target_id, r.before_json, r.after_json, r.reason, r.chain_seq, r.prev_hash, r.hash, key.kid || 'k1');
  } else {
    db.prepare('INSERT INTO admin_audit(id,ts,actor_id,actor_email,action,target_type,target_id,before_json,after_json,reason,chain_seq,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.id, r.ts, r.actor_id, r.actor_email, r.action, r.target_type, r.target_id, r.before_json, r.after_json, r.reason, r.chain_seq, r.prev_hash, r.hash);
  }
  writeHead(db, key, r);
  return r;
}

// Recompute the whole chain. Returns {ok, checked, head_seq, problem?: {chain_seq, id, reason}}.
function verify(db) {
  const key = init(db);
  const bad = (row, reason) => ({ chain_seq: row ? row.chain_seq : null, id: row ? row.id : null, reason });
  const unsealed = db.prepare('SELECT * FROM admin_audit WHERE chain_seq IS NULL OR hash IS NULL ORDER BY rowid LIMIT 1').get();
  let prev = GENESIS; let n = 0; let problem = null;
  for (const row of db.prepare('SELECT * FROM admin_audit WHERE chain_seq IS NOT NULL ORDER BY chain_seq').iterate()) {
    n += 1;
    if (row.chain_seq !== n) { problem = bad(row, `row ${n} is missing (chain jumps to ${row.chain_seq})`); break; }
    if (row.prev_hash !== prev) { problem = bad(row, 'previous-hash link does not match the row before it'); break; }
    let rk;
    try { rk = keyFor(key, row.key_id); } catch { problem = bad(row, `row was sealed with key ${row.key_id}, which is not in the key ring`); break; }
    if (!row.hash || !safeEqual(hmacHex(rk, canonical(row)), row.hash)) { problem = bad(row, 'row contents do not match its hash (edited)'); break; }
    prev = row.hash;
  }
  if (!problem && unsealed) problem = bad(unsealed, 'row has no chain hash (inserted outside the audit API or hash removed)');
  if (!problem) {
    let h = null; try { h = JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get(HEAD_KEY)?.value || 'null'); } catch { h = null; }
    let hk = key; try { if (h) hk = keyFor(key, h.kid); } catch { hk = null; }
    if (n > 0 && (!h || !hk || !safeEqual(h.mac || '', hmacHex(hk, `head:${h.chain_seq}:${h.hash}`)))) problem = { chain_seq: null, id: null, reason: 'chain head record is missing or invalid' };
    else if (h && (h.chain_seq !== n || h.hash !== prev)) problem = { chain_seq: h.chain_seq, id: null, reason: h.chain_seq > n ? `newest ${h.chain_seq - n} row(s) were deleted` : 'chain head does not match the newest row' };
  }
  return { ok: !problem, checked: n, head_seq: n, ...(problem ? { problem } : {}) };
}

// After a key rotation (server/keyring.js): new rows use the new active key.
const resetKey = (db) => { ready.delete(db); hasKeyCol.delete(db); };

module.exports = { schema, init, append, verify, resetKey, head, GENESIS };
