'use strict';
// Shared server-side secret handling (PLAN P1.15). One 32-byte master key per deployment; every use derives its
// own sub-key with HKDF so a key used for one purpose (field encryption, audit chain, login CSRF, client tokens…)
// is never reused for another.
//
// Key source, in order:
//   1. SECRET_KEY environment variable (64 hex chars = raw key; any other string is hashed with SHA-256).
//   2. The key file: SECRET_KEY_FILE, else `<dir>/secret.key` (dir defaults to clone/data). Created with mode 0600
//      on first use when missing. The file holds 64 hex chars (a 32-byte key).
// The file lives next to the database and is git-ignored (*.key) and covered by the .claude deny rules.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = path.join(__dirname, '..', 'data');
const cache = new Map(); // resolved key file (or 'env') -> Buffer

function parseKeyMaterial(s) {
  const t = String(s).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) { const b = Buffer.from(t, 'base64'); if (b.length === 32) return b; }
  return crypto.createHash('sha256').update(t, 'utf8').digest();
}

// The 32-byte master key. `dir` selects where the key file lives when SECRET_KEY / SECRET_KEY_FILE are unset.
function secretKey({ dir } = {}) {
  if (process.env.SECRET_KEY) {
    if (!cache.has('env')) cache.set('env', parseKeyMaterial(process.env.SECRET_KEY));
    return cache.get('env');
  }
  const file = path.resolve(process.env.SECRET_KEY_FILE || path.join(dir || DEFAULT_DIR, 'secret.key'));
  if (cache.has(file)) return cache.get(file);
  let key;
  try {
    key = parseKeyMaterial(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const hex = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(file, hex + '\n', { mode: 0o600, flag: 'wx' }); // wx: never overwrite a key another process just wrote
      key = Buffer.from(hex, 'hex');
    } catch (w) {
      if (w.code !== 'EEXIST') throw w;
      key = parseKeyMaterial(fs.readFileSync(file, 'utf8'));
    }
  }
  cache.set(file, key);
  return key;
}

// Purpose-bound sub-key (HKDF-SHA256).
function deriveKey(purpose, opts) {
  return Buffer.from(crypto.hkdfSync('sha256', secretKey(opts), Buffer.alloc(0), `parlance:${purpose}`, 32));
}

const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const hmacHex = (key, s) => crypto.createHmac('sha256', key).update(String(s), 'utf8').digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// AES-256-GCM field encryption. `aad` binds the ciphertext to its row/column (e.g. "mfa.secret:u_123"), so a value
// copied into another row fails to decrypt. Output: enc:v1:<iv>.<tag>.<ciphertext> (base64url).
const ENC_PREFIX = 'enc:v1:';
const isEncrypted = (v) => typeof v === 'string' && v.startsWith(ENC_PREFIX);
function encrypt(plaintext, aad, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `${ENC_PREFIX}${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}
function decrypt(value, aad, key) {
  if (!isEncrypted(value)) throw new Error('value is not encrypted');
  const [iv, tag, ct] = value.slice(ENC_PREFIX.length).split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

module.exports = { secretKey, deriveKey, sha256hex, hmacHex, safeEqual, encrypt, decrypt, isEncrypted, ENC_PREFIX };
