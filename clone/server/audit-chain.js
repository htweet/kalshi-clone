'use strict';
// Tamper-evident admin audit log (PLAN P1.14, SEC_IDENTITY_SPEC §22.7).
// Every admin_audit row carries chain_seq (1, 2, 3, …), prev_hash (the previous row's hash; 64 zeros for the
// first) and hash = HMAC-SHA256(audit-chain key, canonical row incl. prev_hash). Editing, deleting or re-ordering
// any row breaks verification from that row on; an HMAC (not a bare hash) means rows cannot be re-chained
// without the server's secret key. The newest row is also recorded as the chain head in `meta`, so deleting the
// tail is detected too.
const { newId } = require('./util');
const { deriveKey, hmacHex, safeEqual } = require('./crypto');

const GENESIS = '0'.repeat(64);
const HEAD_KEY = 'audit_chain_head';
const ready = new WeakMap(); // db -> key

const FIELDS = ['id', 'ts', 'actor_id', 'actor_email', 'action', 'target_type', 'target_id', 'before_json', 'after_json', 'reason'];
const canonical = (r) => JSON.stringify([r.chain_seq, ...FIELDS.map((f) => (r[f] === undefined ? null : r[f])), r.prev_hash]);

// Adds the chain columns (idempotent) and seals rows written before chaining existed. Only rows after the last
// chained row are sealed: a row whose hash was cleared in the middle of the chain stays unsealed and fails
// verification instead of being silently re-chained.
function init(db, { keyDir } = {}) {
  if (ready.has(db)) return ready.get(db);
  const key = deriveKey('audit-chain:v1', { dir: keyDir });
  const cols = new Set(db.prepare('PRAGMA table_info(admin_audit)').all().map((c) => c.name));
  if (!cols.size) throw new Error('admin_audit table missing');
  if (!cols.has('chain_seq')) db.exec('ALTER TABLE admin_audit ADD COLUMN chain_seq INTEGER');
  if (!cols.has('prev_hash')) db.exec('ALTER TABLE admin_audit ADD COLUMN prev_hash TEXT');
  if (!cols.has('hash')) db.exec('ALTER TABLE admin_audit ADD COLUMN hash TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_audit_chain ON admin_audit(chain_seq)');
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
  writeHead(db, key, r);
  return r;
}
function writeHead(db, key, r) {
  const v = JSON.stringify({ chain_seq: r.chain_seq, hash: r.hash, mac: hmacHex(key, `head:${r.chain_seq}:${r.hash}`) });
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
  db.prepare('INSERT INTO admin_audit(id,ts,actor_id,actor_email,action,target_type,target_id,before_json,after_json,reason,chain_seq,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(r.id, r.ts, r.actor_id, r.actor_email, r.action, r.target_type, r.target_id, r.before_json, r.after_json, r.reason, r.chain_seq, r.prev_hash, r.hash);
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
    if (!row.hash || !safeEqual(hmacHex(key, canonical(row)), row.hash)) { problem = bad(row, 'row contents do not match its hash (edited)'); break; }
    prev = row.hash;
  }
  if (!problem && unsealed) problem = bad(unsealed, 'row has no chain hash (inserted outside the audit API or hash removed)');
  if (!problem) {
    let h = null; try { h = JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get(HEAD_KEY)?.value || 'null'); } catch { h = null; }
    if (n > 0 && (!h || !safeEqual(h.mac || '', hmacHex(key, `head:${h.chain_seq}:${h.hash}`)))) problem = { chain_seq: null, id: null, reason: 'chain head record is missing or invalid' };
    else if (h && (h.chain_seq !== n || h.hash !== prev)) problem = { chain_seq: h.chain_seq, id: null, reason: h.chain_seq > n ? `newest ${h.chain_seq - n} row(s) were deleted` : 'chain head does not match the newest row' };
  }
  return { ok: !problem, checked: n, head_seq: n, ...(problem ? { problem } : {}) };
}

module.exports = { init, append, verify, GENESIS };
