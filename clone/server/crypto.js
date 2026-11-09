'use strict';
// Shared server-side secret handling (PLAN P1.15, key rotation RS4 / P9.6). A key ring of 32-byte master keys, each with
// an id (k1, k2, …); every use derives its own sub-key with HKDF so a key used for one purpose (field encryption, audit
// chain, login CSRF, client tokens…) is never reused for another.
//
// Key ring source, in order:
//   1. SECRET_KEYRING (JSON) or SECRET_KEYRING_FILE (path to the same JSON): {"active":"k2","hmac":"k1","keys":{"k1":"<64 hex>","k2":"<64 hex>"}}
//   2. `<dir>/secret.keyring.json` when it exists (written by `npm run keys -- rotate` in development)
//   3. SECRET_KEY environment variable (64 hex chars = raw key; any other string is hashed with SHA-256) → the ring {k1}
//   4. The key file: SECRET_KEY_FILE, else `<dir>/secret.key` (dir defaults to clone/data), created with mode 0600 on first
//      use when missing → the ring {k1}.
// Production (server/config-guard.js) refuses a key that lives in the data folder: it comes from the environment or a
// secrets file (Docker secret) outside the data volume.
//
// Versioned values: encrypt() writes `enc:v2:<kid>:<iv>.<tag>.<ciphertext>` with the active key; values written before
// rotation existed (`enc:v1:…`) belong to k1. decrypt() picks the key named by the value, so a rotation never breaks a
// read; the re-encrypt job (server/keyring.js) then rewrites every registered column under the active key and verifies.
// HMAC purposes (lookup hashes, signed tokens, the bot-management secret) are derived from the ring's `hmac` key (k1
// unless the ring names another): their values are compared, not decrypted, so changing that key needs a re-hash from
// plaintext (CLONE_SPEC.md §39.10 residual). The audit chain records the key id of each row (admin_audit.key_id) and
// moves to the active key at rotation.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = path.join(__dirname, '..', 'data');
const cache = new Map(); // resolved source -> ring
// Purposes whose values are encrypted (re-encryptable) and therefore follow the active key.
const ENCRYPTION_PURPOSES = new Set(['field-encryption:v1', 'identity-kek:v1', 'heist-code:v1', 'waitlist-email:v1', 'web-push:v1', 'audit-chain:v1', 'ops-secrets:v1']);

function parseKeyMaterial(s) {
  const t = String(s).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) { const b = Buffer.from(t, 'base64'); if (b.length === 32) return b; }
  return crypto.createHash('sha256').update(t, 'utf8').digest();
}
const fingerprint = (k) => crypto.createHash('sha256').update(Buffer.concat([Buffer.from('parlance-key-fp:'), k])).digest('hex').slice(0, 16);

function ringFromJson(text, source, file = null) {
  const j = JSON.parse(text);
  const keys = new Map(Object.entries(j.keys || {}).map(([kid, v]) => [kid, parseKeyMaterial(v)]));
  if (!keys.size) throw new Error('key ring has no keys');
  for (const kid of keys.keys()) if (!/^k\d{1,6}$/.test(kid)) throw new Error(`key ring id ${kid} must look like k1, k2, …`);
  const active = j.active && keys.has(j.active) ? j.active : [...keys.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).pop();
  const hmac = j.hmac && keys.has(j.hmac) ? j.hmac : keys.has('k1') ? 'k1' : active;
  return { active, hmac, keys, source, file, created: j.created || {} };
}

// Where the ring for `dir` comes from (no secrets in the answer).
function ringSource({ dir } = {}) {
  if (process.env.SECRET_KEYRING) return { kind: 'env_keyring' };
  if (process.env.SECRET_KEYRING_FILE) return { kind: 'keyring_file', file: path.resolve(process.env.SECRET_KEYRING_FILE) };
  const local = path.join(path.resolve(dir || DEFAULT_DIR), 'secret.keyring.json');
  if (fs.existsSync(local)) return { kind: 'keyring_file', file: local, inDataDir: true };
  if (process.env.SECRET_KEY) return { kind: 'env' };
  const file = path.resolve(process.env.SECRET_KEY_FILE || path.join(dir || DEFAULT_DIR, 'secret.key'));
  return { kind: 'key_file', file, inDataDir: !process.env.SECRET_KEY_FILE };
}

function keyring(opts = {}) {
  const src = ringSource(opts);
  const cacheKey = `${src.kind}:${src.file || ''}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let ring;
  if (src.kind === 'env_keyring') ring = ringFromJson(process.env.SECRET_KEYRING, 'env_keyring');
  else if (src.kind === 'keyring_file') ring = ringFromJson(fs.readFileSync(src.file, 'utf8'), 'keyring_file', src.file);
  else if (src.kind === 'env') ring = { active: 'k1', hmac: 'k1', keys: new Map([['k1', parseKeyMaterial(process.env.SECRET_KEY)]]), source: 'env', file: null, created: {} };
  else {
    let key;
    try { key = parseKeyMaterial(fs.readFileSync(src.file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      fs.mkdirSync(path.dirname(src.file), { recursive: true });
      const hex = crypto.randomBytes(32).toString('hex');
      try {
        fs.writeFileSync(src.file, `${hex}\n`, { mode: 0o600, flag: 'wx' }); // wx: never overwrite a key another process just wrote
        key = Buffer.from(hex, 'hex');
      } catch (w) {
        if (w.code !== 'EEXIST') throw w;
        key = parseKeyMaterial(fs.readFileSync(src.file, 'utf8'));
      }
    }
    ring = { active: 'k1', hmac: 'k1', keys: new Map([['k1', key]]), source: 'key_file', file: src.file, created: {} };
  }
  ring.inDataDir = !!src.inDataDir;
  cache.set(cacheKey, ring);
  return ring;
}
const reloadKeyring = () => cache.clear();

// The 32-byte active master key (kept for callers that need the raw key).
function secretKey(opts = {}) { const r = keyring(opts); return r.keys.get(r.active); }

// Purpose-bound sub-key (HKDF-SHA256). The Buffer carries its key id and purpose so decrypt() can switch keys.
function deriveKey(purpose, opts = {}) {
  const r = keyring(opts);
  const kid = opts.kid || (ENCRYPTION_PURPOSES.has(purpose) ? r.active : r.hmac);
  const master = r.keys.get(kid);
  if (!master) throw new Error(`key ${kid} is not in the key ring`);
  const k = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `parlance:${purpose}`, 32));
  Object.defineProperties(k, { kid: { value: kid }, purpose: { value: purpose }, ringOpts: { value: { dir: opts.dir } } });
  return k;
}

const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const hmacHex = (key, s) => crypto.createHmac('sha256', key).update(String(s), 'utf8').digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// AES-256-GCM field encryption. `aad` binds the ciphertext to its row/column (e.g. "mfa.secret:u_123"), so a value
// copied into another row fails to decrypt. Output: enc:v2:<kid>:<iv>.<tag>.<ciphertext> (base64url) for keys after the
// first rotation, enc:v1:<iv>.<tag>.<ciphertext> for k1 and raw keys (per-user data keys).
const ENC_PREFIX = 'enc:v1:';
const isEncrypted = (v) => typeof v === 'string' && /^enc:v[12]:/.test(v);
function encrypt(plaintext, aad, key) {
  // A key derived before a rotation follows the ring's new active key at once (no restart needed).
  if (key.purpose && ENCRYPTION_PURPOSES.has(key.purpose) && keyring(key.ringOpts).active !== key.kid) key = deriveKey(key.purpose, key.ringOpts);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  const body = `${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
  // k1 keeps the original format, so a deployment that never rotated stores exactly what earlier builds stored.
  return key.kid && key.kid !== 'k1' ? `enc:v2:${key.kid}:${body}` : `${ENC_PREFIX}${body}`;
}
// The key id a stored value was written with ('k1' for v1 values), or null when it is not an encrypted value.
function keyIdOf(value) {
  if (!isEncrypted(value)) return null;
  if (value.startsWith('enc:v1:')) return 'k1';
  return /^enc:v2:(k\d+):/.exec(value)?.[1] || null;
}
function decrypt(value, aad, key) {
  if (!isEncrypted(value)) throw new Error('value is not encrypted');
  let body; let k = key;
  if (value.startsWith('enc:v1:')) {
    body = value.slice(7);
    if (key.kid && key.kid !== 'k1') k = deriveKey(key.purpose, { ...key.ringOpts, kid: 'k1' });
  } else {
    const m = /^enc:v2:(k\d+):(.*)$/.exec(value);
    if (!m) throw new Error('malformed encrypted value');
    body = m[2];
    if (key.kid && m[1] !== key.kid) k = deriveKey(key.purpose, { ...key.ringOpts, kid: m[1] });
  }
  const [iv, tag, ct] = body.split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
  if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

module.exports = { secretKey, deriveKey, keyring, reloadKeyring, ringSource, ringFromJson, fingerprint, parseKeyMaterial, sha256hex, hmacHex, safeEqual, encrypt, decrypt, isEncrypted, keyIdOf, ENC_PREFIX, ENCRYPTION_PURPOSES };
