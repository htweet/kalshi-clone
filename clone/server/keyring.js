'use strict';
// Key rotation (RS4, PLAN P9.6; CLONE_SPEC.md §39.10). The master key ring lives in server/crypto.js; this module keeps
// its metadata (crypto_keys: id, fingerprint, created, status — never key material), adds a key, re-encrypts every
// registered encrypted column under the active key in the background, verifies, and retires the old key.
//
//   rotate      adds k<n+1> and makes it active. Possible from Admin › System when the ring is a file this process may
//               write (development: data/secret.keyring.json); in production the operator runs `npm run keys -- rotate
//               --file <keyring>` against the secrets file and restarts — the job below starts on its own.
//   re-encrypt  every value in REGISTRY not under the active key is decrypted (its own key id says which key) and
//               written again under the active key, in batches; progress in crypto_rotations.
//   verify      every registered value decrypts and names the active key → the rotation is verified and the old keys
//               are marked retired. A retired key stays in the ring as verify-only while the audit chain has rows it
//               sealed or it is the ring's HMAC key (lookup hashes); `removable` says when it can leave the ring.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const kc = require('./crypto');
const auditChain = require('./audit-chain');
const { newId } = require('./util');

const REGISTRY = [
  { table: 'mfa', id: 'user_id', col: 'secret', aad: (r) => `mfa.secret:${r.user_id}`, purpose: 'field-encryption:v1' },
  { table: 'cb_heists', id: 'id', col: 'code_enc', aad: (r) => `cb_heists.code:${r.id}`, purpose: 'heist-code:v1' },
  { table: 'identity_keys', id: 'user_id', col: 'wrapped_key', aad: (r) => `identity.dek:${r.user_id}`, purpose: 'identity-kek:v1' },
  { table: 'sms_outbox', id: 'id', col: 'to_enc', aad: (r) => `sms_outbox.to:${r.id}`, purpose: 'field-encryption:v1' },
  { table: 'mock_oidc_keys', id: 'provider', col: 'private_enc', aad: (r) => `mock_oidc.key:${r.provider}`, purpose: 'field-encryption:v1' },
  { table: 'oauth_requests', id: 'state_hash', col: 'verifier_enc', aad: (r) => `oauth.verifier:${r.state_hash}`, purpose: 'field-encryption:v1' },
  { table: 'waitlist_entries', id: 'id', col: 'email_enc', aad: (r) => `waitlist.email:${r.id}`, purpose: 'waitlist-email:v1' },
  { table: 'push_vapid', id: 'id', col: 'private_enc', aad: () => 'push_vapid.private:1', purpose: 'web-push:v1' },
  { table: 'push_subscriptions', id: 'id', col: 'endpoint_enc', aad: (r) => `push_subscriptions.endpoint:${r.id}`, purpose: 'web-push:v1' },
  { table: 'push_subscriptions', id: 'id', col: 'keys_enc', aad: (r) => `push_subscriptions.keys:${r.id}`, purpose: 'web-push:v1' },
  { table: 'push_outbox', id: 'id', col: 'payload_enc', aad: (r) => `push_outbox:${r.id}`, purpose: 'web-push:v1' },
  { table: 'ops_alert_contacts', id: 'id', col: 'target_enc', aad: (r) => `ops_alert_contacts.target:${r.id}`, purpose: 'ops-secrets:v1' },
];
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

// Writes a ring file with one more key (k<n+1>, active). Used by Admin › System (dev) and scripts/keys.js.
function addKeyToFile({ file, fromKey = null, fromRing = null }) {
  let ring = fromRing;
  if (!ring) ring = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { active: 'k1', hmac: 'k1', keys: { k1: Buffer.from(fromKey).toString('hex') }, created: {} };
  const n = Math.max(...Object.keys(ring.keys).map((k) => Number(k.slice(1)))) + 1;
  const kid = `k${n}`;
  ring.keys[kid] = crypto.randomBytes(32).toString('hex');
  ring.created = { ...(ring.created || {}), [kid]: new Date().toISOString() };
  ring.active = kid;
  ring.hmac = ring.hmac || 'k1';
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(ring, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return kid;
}

function createKeyring({ db, keyDir, audit = () => {}, log = () => {}, now = () => Date.now() }) {
  const ringOpts = { dir: keyDir };
  const ring = () => kc.keyring(ringOpts);
  // Metadata rows for every key in the ring (fingerprints only).
  function register() {
    const r = ring();
    for (const [kid, key] of r.keys) {
      const fp = kc.fingerprint(key);
      const row = db.prepare('SELECT * FROM crypto_keys WHERE kid=?').get(kid);
      const created = r.created && r.created[kid] ? Date.parse(r.created[kid]) : now();
      if (!row) db.prepare('INSERT INTO crypto_keys(kid,purpose,status,fingerprint,created_ts,activated_ts) VALUES(?,?,?,?,?,?)').run(kid, 'master', kid === r.active ? 'active' : 'decrypt_only', fp, created, kid === r.active ? now() : null);
      else if (row.fingerprint !== fp) throw new Error(`key ${kid} in the ring does not match the key this database was used with (fingerprint ${row.fingerprint}); refusing to start`);
      else if (kid === r.active && row.status !== 'active') db.prepare("UPDATE crypto_keys SET status='active', activated_ts=? WHERE kid=?").run(now(), kid);
      else if (kid !== r.active && row.status === 'active') db.prepare("UPDATE crypto_keys SET status='decrypt_only' WHERE kid=?").run(kid);
    }
  }
  // Counts of registered values per key id.
  function census() {
    const out = {};
    for (const e of REGISTRY) {
      if (!hasTable(db, e.table)) continue;
      for (const r of db.prepare(`SELECT ${e.col} v FROM ${e.table} WHERE ${e.col} IS NOT NULL`).iterate()) { const kid = kc.keyIdOf(r.v); if (kid) out[kid] = (out[kid] || 0) + 1; }
    }
    return out;
  }
  const pendingCount = () => { const c = census(); return Object.entries(c).filter(([k]) => k !== ring().active).reduce((a, [, n]) => a + n, 0); };

  let running = null;
  // Re-encrypts in batches (setImmediate between them, so requests keep flowing). Resolves with the counts.
  function reencrypt({ actor = null, batch = 200 } = {}) {
    if (running) return running;
    const active = ring().active;
    const id = newId('rot_');
    db.prepare("INSERT INTO crypto_rotations(id,from_kid,to_kid,status,started_ts,actor_id) VALUES(?,?,?,'running',?,?)").run(id, null, active, now(), actor);
    const counts = {};
    running = (async () => {
      try {
        for (const e of REGISTRY) {
          if (!hasTable(db, e.table)) continue;
          const key = kc.deriveKey(e.purpose, ringOpts); // active
          for (;;) {
            // Values under another key: v1 (= k1) unless k1 is active, and v2 values naming another key.
            const where = active === 'k1' ? `${e.col} LIKE 'enc:v2:%'` : `(${e.col} LIKE 'enc:v1:%' OR (${e.col} LIKE 'enc:v2:%' AND ${e.col} NOT LIKE 'enc:v2:${active}:%'))`;
            const rows = db.prepare(`SELECT ${e.id} AS __id, * FROM ${e.table} WHERE ${where} LIMIT ?`).all(batch).filter((r) => kc.keyIdOf(r[e.col]) && kc.keyIdOf(r[e.col]) !== active);
            if (!rows.length) break;
            db.exec('BEGIN IMMEDIATE');
            try {
              for (const r of rows) {
                const plain = kc.decrypt(r[e.col], e.aad(r), key);
                db.prepare(`UPDATE ${e.table} SET ${e.col}=? WHERE ${e.id}=?`).run(kc.encrypt(plain, e.aad(r), key), r.__id);
              }
              db.exec('COMMIT');
            } catch (err) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw err; }
            counts[`${e.table}.${e.col}`] = (counts[`${e.table}.${e.col}`] || 0) + rows.length;
            await new Promise((r) => setImmediate(r));
          }
        }
        const v = verify();
        db.prepare('UPDATE crypto_rotations SET status=?, finished_ts=?, counts_json=?, verified_ts=?, error=? WHERE id=?').run(v.ok ? 'verified' : 'failed', now(), JSON.stringify(counts), v.ok ? now() : null, v.ok ? null : v.detail, id);
        if (v.ok) {
          for (const k of db.prepare("SELECT kid FROM crypto_keys WHERE kid<>? AND status IN ('decrypt_only','active')").all(active)) db.prepare("UPDATE crypto_keys SET status='retired', retired_ts=? WHERE kid=?").run(now(), k.kid);
        }
        audit({ action: 'ops.key_rotation', target_id: active, after: { counts, verified: v.ok }, reason: v.ok ? 're-encrypted and verified' : v.detail });
        log({ msg: 'key rotation finished', active, verified: v.ok });
        return { id, counts, verified: v.ok, detail: v.detail };
      } catch (e) {
        db.prepare("UPDATE crypto_rotations SET status='failed', finished_ts=?, error=? WHERE id=?").run(now(), String(e.message).slice(0, 300), id);
        log({ level: 'error', msg: 'key rotation failed', error: e.message });
        throw e;
      } finally { running = null; }
    })();
    return running;
  }
  // Every registered value decrypts and is under the active key.
  function verify() {
    const active = ring().active;
    let checked = 0;
    for (const e of REGISTRY) {
      if (!hasTable(db, e.table)) continue;
      const key = kc.deriveKey(e.purpose, ringOpts);
      for (const r of db.prepare(`SELECT ${e.id} AS __id, * FROM ${e.table} WHERE ${e.col} IS NOT NULL`).iterate()) {
        const kid = kc.keyIdOf(r[e.col]);
        if (!kid) continue;
        if (kid !== active) return { ok: false, detail: `${e.table}.${e.col} ${r.__id} is still under ${kid}`, checked };
        try { kc.decrypt(r[e.col], e.aad(r), key); } catch { return { ok: false, detail: `${e.table}.${e.col} ${r.__id} does not decrypt`, checked }; }
        checked += 1;
      }
    }
    return { ok: true, checked, detail: `${checked} values under ${active}` };
  }
  // Adds a key to a writable ring file and starts the re-encryption.
  function rotate({ actor = null } = {}) {
    const src = kc.ringSource(ringOpts);
    let file;
    if (src.kind === 'keyring_file') file = src.file;
    else if (src.kind === 'key_file' && src.inDataDir) file = path.join(path.dirname(src.file), 'secret.keyring.json');
    else { const e = new Error('the key ring comes from the environment or a read-only secrets file: run `npm run keys -- rotate --file <keyring file>` and restart'); e.code = 'rotation_manual'; throw e; }
    const r = ring();
    const kid = addKeyToFile({ file, fromKey: src.kind === 'key_file' ? r.keys.get('k1') : null, fromRing: src.kind === 'keyring_file' ? { active: r.active, hmac: r.hmac, keys: Object.fromEntries([...r.keys].map(([k, v]) => [k, v.toString('hex')])), created: r.created } : null });
    kc.reloadKeyring();
    auditChain.resetKey(db);
    register();
    audit({ action: 'ops.key_added', target_id: kid, after: { kid, fingerprint: kc.fingerprint(ring().keys.get(kid)) }, reason: 'key rotation started', actor });
    const p = reencrypt({ actor });
    p.catch(() => {});
    return { kid, rotation: p };
  }
  function status() {
    const r = ring();
    const c = census();
    const keys = db.prepare('SELECT * FROM crypto_keys ORDER BY created_ts').all().map((k) => {
      const auditRows = (() => { try { return db.prepare('SELECT COUNT(*) c FROM admin_audit WHERE COALESCE(key_id,\'k1\')=?').get(k.kid).c; } catch { return 0; } })();
      return { kid: k.kid, status: k.status, fingerprint: k.fingerprint, created_time: new Date(k.created_ts).toISOString(), age_days: Math.floor((now() - k.created_ts) / 86400000), values: c[k.kid] || 0, audit_rows: auditRows, hmac: k.kid === r.hmac,
        removable: k.kid !== r.active && k.kid !== r.hmac && !(c[k.kid] || 0) && !auditRows };
    });
    const last = db.prepare('SELECT * FROM crypto_rotations ORDER BY started_ts DESC LIMIT 1').get();
    return { source: r.source, in_data_dir: !!r.inDataDir, active: r.active, hmac: r.hmac, keys, pending: Object.entries(c).filter(([k]) => k !== r.active).reduce((a, [, n]) => a + n, 0), running: !!running,
      last_rotation: last ? { id: last.id, to: last.to_kid, status: last.status, started_time: new Date(last.started_ts).toISOString(), finished_time: last.finished_ts ? new Date(last.finished_ts).toISOString() : null, counts: JSON.parse(last.counts_json || '{}'), error: last.error } : null,
      rotatable: (() => { const s = kc.ringSource(ringOpts); return s.kind === 'keyring_file' || (s.kind === 'key_file' && s.inDataDir); })() };
  }
  // At start: metadata, and a rotation done offline (a new active key) re-encrypts on its own.
  function startup() {
    register();
    if (pendingCount() > 0) reencrypt({}).catch(() => {});
  }
  return { REGISTRY, register, census, reencrypt, verify, rotate, status, startup, pendingCount, running: () => running };
}

module.exports = { createKeyring, addKeyToFile, REGISTRY };
