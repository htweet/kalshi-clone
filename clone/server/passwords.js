'use strict';
// Password hashing and policy (PLAN P1.5, SEC_IDENTITY_SPEC §22.4).
//
// Hash format (current):  scrypt2$<N>$<r>$<p>$<salt b64>$<key b64>   (cost parameters stored per hash)
// Legacy format:          scrypt$<salt b64>$<key b64>                 (N=16384, r=8, p=1 — first build)
// Unusable marker:        !<reason>                                   (no password can match; e.g. demo accounts)
// A successful login with an older format or weaker parameters is transparently re-hashed (needsRehash).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Default N=2^16, r=8, p=1 (64 MiB, 4x the first build's N=2^14). OWASP's reference point is N=2^17; set
// SCRYPT_LOG_N=17 where the hardware allows it. Parameters are stored in every hash, so raising them later only
// re-hashes each account on its next successful login.
const logN = Math.min(20, Math.max(14, Number(process.env.SCRYPT_LOG_N) || 16));
const CURRENT = { N: 2 ** logN, r: 8, p: 1 };
const LEGACY = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;
const maxmem = ({ N, r, p }) => 128 * N * r * (p + 2) + 1024 * 1024;

function parse(stored) {
  const s = String(stored || '');
  const a = s.split('$');
  if (a[0] === 'scrypt2' && a.length === 6) return { N: Number(a[1]), r: Number(a[2]), p: Number(a[3]), salt: Buffer.from(a[4], 'base64'), key: Buffer.from(a[5], 'base64') };
  if (a[0] === 'scrypt' && a.length === 3) return { ...LEGACY, salt: Buffer.from(a[1], 'base64'), key: Buffer.from(a[2], 'base64'), legacy: true };
  return null;
}
const fmt = (params, salt, key) => `scrypt2$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;

function scryptAsync(pw, salt, params) {
  return new Promise((resolve, reject) => crypto.scrypt(String(pw), salt, KEYLEN, { N: params.N, r: params.r, p: params.p, maxmem: maxmem(params) }, (e, k) => (e ? reject(e) : resolve(k))));
}

async function hashPassword(pw, params = CURRENT) {
  const salt = crypto.randomBytes(16);
  return fmt(params, salt, await scryptAsync(pw, salt, params));
}
function hashPasswordSync(pw, params = CURRENT) {
  const salt = crypto.randomBytes(16);
  return fmt(params, salt, crypto.scryptSync(String(pw), salt, KEYLEN, { ...params, maxmem: maxmem(params) }));
}

// A fixed hash used when the account does not exist, so unknown emails cost the same scrypt work as real ones.
let dummy = null;
const dummyHash = () => (dummy ||= hashPasswordSync(crypto.randomBytes(18).toString('base64')));

async function verifyPassword(pw, stored) {
  const h = parse(stored);
  if (!h || !h.key.length) { await scryptAsync(pw, parse(dummyHash()).salt, CURRENT); return false; } // unusable marker: same cost, never matches
  const k = await scryptAsync(pw, h.salt, h);
  return k.length === h.key.length && crypto.timingSafeEqual(k, h.key);
}
// Verify against the account hash, or against the dummy hash when there is no account (uniform timing).
const verifyOrDummy = (pw, stored) => (stored ? verifyPassword(pw, stored) : verifyPassword(pw, dummyHash()).then(() => false));

function needsRehash(stored) {
  const h = parse(stored);
  return !!h && (h.legacy || h.N < CURRENT.N || h.r < CURRENT.r || h.p < CURRENT.p);
}
const isUsable = (stored) => !!parse(stored);
const UNUSABLE = (why = 'disabled') => `!${why}`;

// ------------------------------------------------------------------ policy
let breached = null;
function breachedSet() {
  if (breached) return breached;
  const text = fs.readFileSync(path.join(__dirname, 'common-passwords.txt'), 'utf8');
  breached = new Set(text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  return breached;
}
const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase();
const DELEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
const deleet = (s) => s.replace(/[013457@$!]/g, (c) => DELEET[c]);
// Breached if the password, its de-leeted form, or its alphabetic core (leading/trailing digits and symbols
// removed, e.g. "Summer2024!!" -> "summer") appears in the bundled list.
function isBreached(pw) {
  const set = breachedSet();
  const low = String(pw).toLowerCase();
  const cands = new Set([low, deleet(low)]);
  for (const c of [...cands]) { const core = c.replace(/^[^a-z]+|[^a-z]+$/g, ''); if (core.length >= 4) cands.add(core); }
  for (const c of cands) if (set.has(sha1(c))) return true;
  return false;
}

const MIN_LEN = 12;
const MAX_LEN = 128;
// Returns null when acceptable, else {code, message} with a user-facing message.
function checkPolicy(pw, { email = '', name = '' } = {}) {
  const s = String(pw ?? '');
  if (s.length < MIN_LEN) return { code: 'weak_password', message: `password must be at least ${MIN_LEN} characters` };
  if (s.length > MAX_LEN) return { code: 'weak_password', message: `password must be at most ${MAX_LEN} characters` };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
  if (classes < 2) return { code: 'weak_password', message: 'password must mix at least two of: lowercase letters, uppercase letters, digits, symbols' };
  if (/^(.)\1+$/.test(s)) return { code: 'weak_password', message: 'password must not repeat a single character' };
  const low = s.toLowerCase();
  const em = String(email).toLowerCase();
  const local = em.split('@')[0] || '';
  const tokens = new Set([local, ...local.split(/[^a-z0-9]+/), ...String(name).toLowerCase().split(/[^a-z0-9]+/)].filter((t) => t.length >= 4 && !/^\d+$/.test(t)));
  if ((em && low.includes(em)) || [...tokens].some((t) => low.includes(t))) return { code: 'weak_password', message: 'password must not contain your email address or name' };
  if (isBreached(s)) return { code: 'breached_password', message: 'this password appears in lists of breached passwords; choose a different one' };
  return null;
}

// Random password that satisfies the policy (demo accounts, shown once).
function generatedPassword() {
  return `Demo-${crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}-${crypto.randomInt(10, 99)}`;
}

module.exports = { warmup: () => void dummyHash(), generatedPassword, hashPassword, hashPasswordSync, verifyPassword, verifyOrDummy, needsRehash, isUsable, UNUSABLE, checkPolicy, isBreached, CURRENT, LEGACY, MIN_LEN, parse };
