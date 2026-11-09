'use strict';
// Audit-chain anchoring (RS5, PLAN P9.4; CLONE_SPEC.md §39.5). Every `anchors.interval_minutes` (owner setting, 60) the
// head of the hash-chained admin audit log (server/audit-chain.js) is signed with an Ed25519 key derived from the master
// key and shipped outside the database: one `audit_anchor` log line (collected by Loki) and one object in the backup
// store (`anchors/YYYY/MM/DD/<time>-<seq>.json`). The public key is shown in Admin › System, so anyone holding an anchor
// can check its signature without any secret. The verifier (server/verify.js, Admin › System, the restore drill, the
// Launch readiness check) compares the database against the newest anchor in the store: rows deleted or rewritten after
// an anchor no longer contain the anchored row with the anchored hash, so a rewritten database is detected even when the
// rewrite re-chained the rows behind it.
const crypto = require('node:crypto');
const kc = require('./crypto');
const auditChain = require('./audit-chain');

// Ed25519 private key from a 32-byte seed (PKCS#8 DER: fixed prefix + seed).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function signingKey(keyDir) {
  const seed = kc.deriveKey('audit-anchor-ed25519:v1', { dir: keyDir });
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv);
  const spki = pub.export({ format: 'der', type: 'spki' });
  return { priv, pub, publicKey: spki.subarray(spki.length - 32).toString('base64url'), kid: crypto.createHash('sha256').update(spki).digest('hex').slice(0, 16), pem: pub.export({ format: 'pem', type: 'spki' }) };
}
const canonical = (a) => JSON.stringify({ v: 1, seq: a.seq, ts: a.ts, chain_seq: a.chain_seq, chain_hash: a.chain_hash, key_id: a.key_id });
function verifyAnchor(a, publicKeyB64u) {
  try {
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64u, 'base64url')]);
    const pub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canonical(a)), pub, Buffer.from(a.signature, 'base64url'));
  } catch { return false; }
}

function createAnchors({ db, keyDir, storage, logger, settings, audit = () => {}, now = () => Date.now() }) {
  const key = signingKey(keyDir);
  const S = (k, d) => { try { const v = settings ? settings(k) : undefined; return v == null ? d : v; } catch { return d; } };
  async function anchor({ reason = 'schedule' } = {}) {
    auditChain.init(db, { keyDir });
    const h = auditChain.head(db);
    const seq = (db.prepare('SELECT MAX(seq) s FROM ops_anchors').get().s || 0) + 1;
    const a = { seq, ts: now(), chain_seq: h.chain_seq, chain_hash: h.hash, key_id: key.kid };
    a.signature = crypto.sign(null, Buffer.from(canonical(a)), key.priv).toString('base64url');
    db.prepare('INSERT INTO ops_anchors(seq,ts,chain_seq,chain_hash,key_id,signature) VALUES(?,?,?,?,?,?)').run(a.seq, a.ts, a.chain_seq, a.chain_hash, a.key_id, a.signature);
    if (logger) logger.info('audit_anchor', { anchor: { ...a, public_key: key.publicKey } }); // shipped by the log collector
    if (storage) {
      const d = new Date(a.ts).toISOString();
      const objectKey = `anchors/${d.slice(0, 10).replace(/-/g, '/')}/${d.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${String(seq).padStart(8, '0')}.json`;
      await storage.put(objectKey, Buffer.from(JSON.stringify({ ...a, public_key: key.publicKey })), { contentType: 'application/json' });
      db.prepare('UPDATE ops_anchors SET object_key=?, shipped_ts=? WHERE seq=?').run(objectKey, now(), seq);
      a.object_key = objectKey;
    }
    if (reason !== 'schedule') audit({ action: 'ops.audit_anchor', target_id: String(seq), after: { chain_seq: a.chain_seq, object_key: a.object_key || null }, reason });
    return a;
  }
  // The newest anchor in the store (falls back to the database row when no store is configured).
  async function latest() {
    if (storage) {
      const list = (await storage.list('anchors/')).filter((o) => o.key.endsWith('.json'));
      for (let i = list.length - 1; i >= 0 && i >= list.length - 5; i--) {
        try { const a = JSON.parse((await storage.get(list[i].key)).toString('utf8')); if (verifyAnchor(a, a.public_key) && a.public_key === key.publicKey) return { ...a, object_key: list[i].key, source: 'store' }; } catch { /* next */ }
      }
    }
    const r = db.prepare('SELECT * FROM ops_anchors ORDER BY seq DESC LIMIT 1').get();
    return r ? { ...r, source: 'database' } : null;
  }
  // Compares the live chain with the newest stored anchor.
  async function check() {
    const a = await latest();
    if (!a) return { ok: false, detail: 'no anchor yet', anchor: null };
    const row = db.prepare('SELECT chain_seq, hash FROM admin_audit WHERE chain_seq=?').get(a.chain_seq);
    const ok = a.chain_seq === 0 ? true : !!row && row.hash === a.chain_hash;
    return { ok, anchor: { seq: a.seq, time: new Date(a.ts).toISOString(), chain_seq: a.chain_seq, source: a.source, age_sec: Math.round((now() - a.ts) / 1000) }, detail: ok ? 'the chain contains the anchored head' : row ? 'the anchored row was rewritten' : 'the anchored row is missing' };
  }
  let timer = null; let last = 0;
  function tick(onDone) {
    const every = Number(S('anchors.interval_minutes', 60)) * 60000;
    const lastTs = db.prepare('SELECT MAX(ts) t FROM ops_anchors').get().t || 0;
    if (now() - Math.max(last, lastTs) < every) return;
    last = now();
    anchor().then(() => onDone && onDone(true), (e) => { if (logger) logger.error('audit anchor failed', { error: e.message }); if (onDone) onDone(false, e); });
  }
  const start = (onDone, everyMs = 30000) => { if (!timer) { timer = setInterval(() => tick(onDone), everyMs); timer.unref(); } };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  return { anchor, latest, check, start, stop, tick, publicKey: key.publicKey, keyId: key.kid, publicKeyPem: key.pem };
}

module.exports = { createAnchors, verifyAnchor, signingKey, canonical };
