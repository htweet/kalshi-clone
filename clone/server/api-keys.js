'use strict';
// Public trading API keys and signed requests (PLAN P7.1, CLONE_SPEC.md §35.2–§35.4).
//
// Keys. A user creates keys in Account › API keys (step-up + the A2 identity lock of server/identity.js). Each key has a
// label, scopes (`read` always; `trade` adds order entry; `perps` adds the margin product, read and — with `trade` —
// order entry), an optional IP allowlist (IPv4 / IPv6 addresses and CIDR ranges) and an optional expiry. Two modes:
//   generate    the server makes an RSA-2048 key pair, returns the PKCS#8 private key PEM in the create response once
//               (Cache-Control: no-store) and keeps only the public key;
//   public_key  the user pastes an RSA (2048-8192 bit) or Ed25519 SPKI public key; a pasted private key is refused.
// Stored: id, public key, SHA-256 fingerprint of the SPKI DER, created / last-used time and last-used IP. Never stored
// or logged: private keys, signatures.
//
// Signed requests. Headers PARLANCE-ACCESS-KEY, PARLANCE-ACCESS-TIMESTAMP (unix ms) and PARLANCE-ACCESS-SIGNATURE:
// base64 over `timestamp + METHOD + path` (path without the query string). RSA keys: RSA-PSS with SHA-256 and a salt as
// long as the digest (32 bytes); Ed25519 keys: Ed25519. The KALSHI-ACCESS-* names are deliberately not accepted
// (clean-room naming; one spelling avoids ambiguity when both are sent). Checks, in order:
//   headers present and well formed → key-id environment prefix (plxk_ production, plxdemo_ demo) → timestamp inside
//   the window (default 5 s past / 1 s future, configurable) → signature (unknown keys verify against a dummy key, so
//   timing does not reveal which ids exist) → key active and unexpired → owner not locked, frozen or closed → replay
//   (state-changing requests: (key, signature) remembered for the window, persisted) → IP allowlist (403).
// Failures are the usual 401 token_authentication_failure envelope with a `reason`; the security log keeps the detail.
//
// Rate tiers. Each key has a tier (Basic / Advanced / Premier / Prime, admin-assigned) with token-bucket read and write
// budgets per second (bucket capacity = one second of budget), per-endpoint token costs, WebSocket connection caps and
// FIX session caps. Buckets live in a RateStore (in memory per process today; the interface takes a shared store
// later, PLAN RS1). Usage (requests, 429s, errors per key per UTC day) is persisted.
//
// Rotation creates a new key with the same settings; the old key keeps working for the admin-set grace period.
// Revocation (user or admin) is immediate: the `revoked` event signs out the key's WebSocket and FIX sessions.
const crypto = require('node:crypto');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { tx } = require('./db');
const auditChain = require('./audit-chain');
const { ApiError, E, newId, nowIso } = require('./util');
const { s } = require('./content/api');

const SCOPES = ['read', 'trade', 'perps'];
const DAY = 86400000;
// Tokens per second for reads and writes; each request costs its endpoint's tokens (10 by default, like the observed
// docs' token costs). A bucket holds one second of budget.
const DEFAULT_TIERS = {
  basic: { label: 'Basic', read_per_sec: 200, write_per_sec: 100, ws_connections: 5, fix_sessions: 1 },
  advanced: { label: 'Advanced', read_per_sec: 300, write_per_sec: 300, ws_connections: 10, fix_sessions: 2 },
  premier: { label: 'Premier', read_per_sec: 1000, write_per_sec: 1000, ws_connections: 25, fix_sessions: 5 },
  prime: { label: 'Prime', read_per_sec: 4000, write_per_sec: 4000, ws_connections: 50, fix_sessions: 10 },
};
const DEFAULT_SETTINGS = { rotation_grace_seconds: 86400, window_past_ms: 5000, window_future_ms: 1000, max_keys_per_user: 10, expiry_notice_days: 3, default_tier: 'basic' };
const KEY_PREFIX = { main: 'plxk_', demo: 'plxdemo_' };
const KEY_ID = /^(plxk|plxdemo)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MAX_IPS = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL,
  algorithm TEXT NOT NULL, public_key_pem TEXT NOT NULL, fingerprint TEXT NOT NULL, origin TEXT NOT NULL, scopes TEXT NOT NULL,
  ip_allowlist TEXT NOT NULL DEFAULT '[]', tier TEXT NOT NULL DEFAULT 'basic', status TEXT NOT NULL DEFAULT 'active', env TEXT NOT NULL DEFAULT 'main',
  created_ts INTEGER NOT NULL, expires_ts INTEGER, revoked_ts INTEGER, revoked_by TEXT, revoke_reason TEXT, rotated_from TEXT, rotated_to TEXT,
  last_used_ts INTEGER, last_used_ip TEXT, expiry_notified INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, status);
CREATE INDEX IF NOT EXISTS idx_api_keys_fp ON api_keys(fingerprint);
CREATE TABLE IF NOT EXISTS api_key_usage (key_id TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, throttled INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0, ws_connections INTEGER NOT NULL DEFAULT 0, fix_messages INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key_id, day));
CREATE TABLE IF NOT EXISTS api_replay (key_id TEXT NOT NULL, sig_hash TEXT NOT NULL, expires_ts INTEGER NOT NULL, PRIMARY KEY (key_id, sig_hash));
CREATE INDEX IF NOT EXISTS idx_api_replay_exp ON api_replay(expires_ts);
`;

// ------------------------------------------------------------------------------------------------ rate store
// Token buckets. take() returns 0 when the cost fits (and spends it), else the seconds to wait. A shared store (Redis,
// Postgres) implements the same two methods (PLAN RS1).
class MemoryRateStore {
  constructor() { this.b = new Map(); }
  take(key, capacity, perSec, cost, now = Date.now()) {
    const b = this.b.get(key) || { t: capacity, ts: now };
    b.t = Math.min(capacity, b.t + ((now - b.ts) / 1000) * perSec); b.ts = now;
    this.b.set(key, b);
    if (this.b.size > 100000) this.b.clear();
    if (b.t < cost) return Math.max(1, Math.ceil((cost - b.t) / perSec));
    b.t -= cost;
    return 0;
  }
  level(key, capacity, perSec, now = Date.now()) {
    const b = this.b.get(key);
    return b ? Math.min(capacity, b.t + ((now - b.ts) / 1000) * perSec) : capacity;
  }
}

// ------------------------------------------------------------------------------------------------ helpers
const fingerprintOf = (keyObj) => `SHA256:${crypto.createHash('sha256').update(keyObj.export({ type: 'spki', format: 'der' })).digest('base64').replace(/=+$/, '')}`;
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const iso = (t) => (t ? new Date(t).toISOString() : null);
const plain = (v, max) => { const x = String(v ?? '').trim(); return x.length >= 1 && x.length <= max && !/[<>\u0000-\u001f]/.test(x) ? x : null; };

// IP allowlist entries: an address or CIDR; returns a normalised string or null.
function parseCidr(raw) {
  const x = String(raw || '').trim();
  const [addr, bits, extra] = x.split('/');
  if (extra !== undefined) return null;
  const v = net.isIP(addr);
  if (!v) return null;
  const max = v === 4 ? 32 : 128;
  if (bits === undefined) return `${addr}/${max}`;
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return null;
  return `${addr}/${Number(bits)}`;
}
function blockListOf(list) {
  const bl = new net.BlockList();
  for (const c of list) { const [a, b] = c.split('/'); bl.addSubnet(a, Number(b), net.isIP(a) === 4 ? 'ipv4' : 'ipv6'); }
  return bl;
}
function ipAllowed(list, ip) {
  if (!list.length) return true;
  let a = String(ip || '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  const v = net.isIP(a);
  if (!v) return false;
  try { return blockListOf(list).check(a, v === 4 ? 'ipv4' : 'ipv6'); } catch { a = null; return false; }
}

// A public key from a PEM string → { keyObj, algorithm } or a field error.
function parsePublicKey(pem) {
  const p = String(pem || '').trim();
  if (!p) throw { public_key: s('error.public_key_missing') };
  if (p.length > 16000) throw { public_key: s('error.public_key_invalid') };
  if (/PRIVATE KEY/.test(p)) throw { public_key: s('error.public_key_private'), code: 'private_key_refused' };
  if (!/^-----BEGIN (RSA )?PUBLIC KEY-----[\s\S]+-----END (RSA )?PUBLIC KEY-----$/.test(p)) throw { public_key: s('error.public_key_invalid') };
  let k;
  try { k = crypto.createPublicKey({ key: p, format: 'pem' }); } catch { throw { public_key: s('error.public_key_invalid') }; }
  if (k.asymmetricKeyType === 'ed25519') return { keyObj: k, algorithm: 'ed25519' };
  if (k.asymmetricKeyType === 'rsa') {
    const bits = k.asymmetricKeyDetails?.modulusLength || 0;
    if (bits < 2048 || bits > 8192) throw { public_key: s('error.public_key_type') };
    return { keyObj: k, algorithm: 'rsa' };
  }
  throw { public_key: s('error.public_key_type') };
}

function verifyWith(keyObj, algorithm, message, sig) {
  try {
    if (algorithm === 'ed25519') return crypto.verify(null, Buffer.from(message), keyObj, sig);
    return crypto.verify('sha256', Buffer.from(message), { key: keyObj, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, sig);
  } catch { return false; }
}

class AuthError extends ApiError {
  constructor(reason, details, extra = {}) {
    super(401, 'token_authentication_failure', 'token authentication failure', details);
    this.reason = reason; this.extra = extra;
  }
  toJSON() { return { error: { code: this.code, message: this.message, details: this.details, reason: this.reason, ...this.extra } }; }
}
const forbiddenError = (reason, details) => { const e = new ApiError(403, 'forbidden', 'forbidden', details); e.reason = reason; e.toJSON = () => ({ error: { code: 'forbidden', message: 'forbidden', details, reason } }); return e; };
const fieldError = (errs) => {
  const { code, ...fields } = errs;
  const e = new ApiError(400, code || 'validation_failed', 'validation failed', Object.entries(fields).map(([k, m]) => `${k}: ${m}`).join('; '));
  e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields } });
  return e;
};

// ------------------------------------------------------------------------------------------------ module
function createApiKeys({ db, env = 'main', options = {}, security = null, flags = null }) {
  db.exec(SCHEMA);
  const events = new EventEmitter();
  events.setMaxListeners(50);
  const store = options.rateStore || new MemoryRateStore();
  const readSetting = () => { try { const r = db.prepare("SELECT value FROM admin_settings WHERE key='api.settings'").get(); return r ? JSON.parse(r.value) : {}; } catch { return {}; } };
  // Settings: code defaults ← start options (tests, operators) ← Admin › API keys (persisted).
  function settings() {
    const saved = readSetting();
    const tiers = {};
    for (const [k, v] of Object.entries(DEFAULT_TIERS)) tiers[k] = { ...v, ...(options.tiers?.[k] || {}), ...(saved.tiers?.[k] || {}) };
    return {
      ...DEFAULT_SETTINGS,
      ...(options.windowPastMs != null ? { window_past_ms: options.windowPastMs } : {}),
      ...(options.windowFutureMs != null ? { window_future_ms: options.windowFutureMs } : {}),
      ...(options.rotationGraceSeconds != null ? { rotation_grace_seconds: options.rotationGraceSeconds } : {}),
      ...Object.fromEntries(Object.entries(saved).filter(([k]) => k !== 'tiers')),
      tiers,
    };
  }
  const tierOf = (key) => { const st = settings(); return st.tiers[key.tier] || st.tiers.basic; };

  // Public key objects are parsed once per key (the PEM never changes).
  const keyCache = new Map();
  const keyObjOf = (row) => { let k = keyCache.get(row.id); if (!k) { k = crypto.createPublicKey(row.public_key_pem); keyCache.set(row.id, k); if (keyCache.size > 5000) keyCache.clear(); } return k; };
  // Unknown key ids are verified against this key (same RSA work as a real key), so response time does not reveal
  // whether a key id exists.
  const dummy = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;

  const getKey = (id) => db.prepare('SELECT * FROM api_keys WHERE id=?').get(String(id || ''));
  const userOf = (uid) => db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const effectiveStatus = (k, now = Date.now()) => (k.status === 'revoked' ? 'revoked' : k.expires_ts && k.expires_ts <= now ? 'expired' : 'active');
  // Why the owner cannot use the API: locked by support, account closed (self-exclusion / closure), or frozen (support
  // switched off both deposits and withdrawals for the account). Modules may add blockers.
  const blockers = [
    (uid) => (hasTable('acct_locks') && db.prepare('SELECT 1 FROM acct_locks WHERE user_id=?').get(uid) ? 'locked' : null),
    (uid) => (hasTable('identity_profiles') && db.prepare("SELECT 1 FROM identity_profiles WHERE user_id=? AND status='closed'").get(uid) ? 'closed' : null),
    (uid) => (hasTable('money_controls') && db.prepare('SELECT 1 FROM money_controls WHERE user_id=? AND deposits_revoked=1 AND withdrawals_revoked=1').get(uid) ? 'frozen' : null),
  ];
  const blockedReason = (uid) => { for (const f of blockers) { const r = f(uid); if (r) return r; } return null; };

  // ---------------------------------------------------------------- usage (persisted, flushed every 2 s)
  const pending = new Map(); // key_id -> { day, requests, throttled, errors, ws, fix, last_ts, last_ip }
  const bumpUsage = (keyId, field, n = 1, ip = null) => {
    const day = dayKey();
    let u = pending.get(keyId);
    if (!u || u.day !== day) { if (u) flushOne(keyId, u); u = { day, requests: 0, throttled: 0, errors: 0, ws: 0, fix: 0, last_ts: null, last_ip: null }; pending.set(keyId, u); }
    u[field] += n;
    if (field === 'requests' || field === 'ws' || field === 'fix') { u.last_ts = Date.now(); if (ip) u.last_ip = ip; }
  };
  const upsertUsage = db.prepare(`INSERT INTO api_key_usage(key_id,day,requests,throttled,errors,ws_connections,fix_messages) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(key_id,day) DO UPDATE SET requests=requests+excluded.requests, throttled=throttled+excluded.throttled, errors=errors+excluded.errors,
    ws_connections=ws_connections+excluded.ws_connections, fix_messages=fix_messages+excluded.fix_messages`);
  const touchKey = db.prepare('UPDATE api_keys SET last_used_ts=?, last_used_ip=? WHERE id=?');
  function flushOne(keyId, u) {
    upsertUsage.run(keyId, u.day, u.requests, u.throttled, u.errors, u.ws, u.fix);
    if (u.last_ts) touchKey.run(u.last_ts, u.last_ip, keyId);
  }
  function flush() {
    if (!pending.size || !db.isOpen || db.isTransaction) return;
    try {
      tx(db, () => { for (const [k, u] of pending) flushOne(k, u); });
      pending.clear();
    } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('api usage flush', e.message); }
  }
  const flushTimer = setInterval(flush, 2000);
  flushTimer.unref?.();

  // ---------------------------------------------------------------- authentication
  const clientIp = (req) => (security ? security.clientIp(req) : String(req.socket?.remoteAddress || '')).replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  const record = (kind, req, detail) => { try { security?.bot.record(kind, req, detail); } catch { /* best effort */ } };
  const header = (req, name) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };
  // Returns null (no credentials sent) or { key, user, tier }; throws AuthError / 403 otherwise.
  // `paths`: the signed path candidates (the demo environment also accepts its /demo-api-prefixed public path).
  function authenticate(req, { method = req.method, paths, now = Date.now(), stateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(method) } = {}) {
    const id = header(req, 'parlance-access-key'); const ts = header(req, 'parlance-access-timestamp'); const sig = header(req, 'parlance-access-signature');
    if (id === undefined && ts === undefined && sig === undefined) return null;
    if (!id || !ts || !sig) throw new AuthError('missing_headers', s('auth.missing_headers'));
    if (!KEY_ID.test(id) || !/^\d{10,16}$/.test(ts) || !B64.test(sig) || sig.length > 1400) throw new AuthError('malformed', s('auth.malformed'));
    if (!id.startsWith(KEY_PREFIX[env])) throw new AuthError('wrong_environment', s(env === 'main' ? 'auth.wrong_environment_demo' : 'auth.wrong_environment_main'));
    const st = settings();
    const t = Number(ts);
    if (now - t > st.window_past_ms || t - now > st.window_future_ms) {
      const past = now - t > 0;
      record('api_auth_failed', req, { reason: 'clock_skew', key: id, skew_ms: now - t });
      throw new AuthError('clock_skew', s(past ? 'auth.clock_skew_past' : 'auth.clock_skew_future', { seconds: (Math.abs(now - t) / 1000).toFixed(1), past: st.window_past_ms / 1000, future: st.window_future_ms / 1000, now }), { server_time_ms: now });
    }
    const row = getKey(id);
    const sigBuf = Buffer.from(sig, 'base64');
    const candidates = paths || [String(req.originalUrl || req.url).split('?')[0]];
    const ok = candidates.map((p) => `${ts}${String(method).toUpperCase()}${p}`).some((msg) => (row ? verifyWith(keyObjOf(row), row.algorithm, msg, sigBuf) : verifyWith(dummy, 'rsa', msg, sigBuf)));
    if (!row || !ok) {
      record('api_auth_failed', req, { reason: 'invalid_signature', key: id });
      if (row) bumpUsage(row.id, 'errors');
      throw new AuthError('invalid_signature', s('auth.invalid_signature'));
    }
    // From here the caller has proven possession of the private key: precise reasons are safe to return.
    const status = effectiveStatus(row, now);
    if (status !== 'active') { record('api_auth_failed', req, { reason: `key_${status}`, key: id }); bumpUsage(row.id, 'errors'); throw new AuthError(`key_${status}`, s(`auth.key_${status}`)); }
    const blocked = blockedReason(row.user_id);
    if (blocked) { record('api_auth_failed', req, { reason: `account_${blocked}`, key: id }); bumpUsage(row.id, 'errors'); throw new AuthError('account_unavailable', s('auth.account_unavailable')); }
    if (flags && !flags.on('api.keys', { uid: row.user_id })) { const e = flags.disabledError('api.keys'); throw e; }
    if (stateChanging) {
      const h = crypto.createHash('sha256').update(`${ts}|${sig}`).digest('hex');
      db.prepare('DELETE FROM api_replay WHERE expires_ts<?').run(now);
      const ins = db.prepare('INSERT INTO api_replay(key_id,sig_hash,expires_ts) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(row.id, h, t + st.window_past_ms + st.window_future_ms + 1000);
      if (!ins.changes) { record('api_replay', req, { key: id }); bumpUsage(row.id, 'errors'); throw new AuthError('replayed_request', s('auth.replayed')); }
    }
    const ip = clientIp(req);
    const ips = JSON.parse(row.ip_allowlist || '[]');
    if (!ipAllowed(ips, ip)) { record('api_ip_refused', req, { key: id }); bumpUsage(row.id, 'errors'); throw forbiddenError('ip_not_allowed', s('forbidden.ip', { ip })); }
    const user = userOf(row.user_id);
    if (!user) throw new AuthError('invalid_signature', s('auth.invalid_signature'));
    return { key: { ...row, scopes: JSON.parse(row.scopes) }, user, tier: tierOf(row), ip };
  }
  function requireScopes(principal, scopes) {
    for (const sc of scopes) if (!principal.key.scopes.includes(sc)) throw forbiddenError('insufficient_scope', s('forbidden.scope', { scope: sc }));
  }
  // Token bucket for the key's tier. bucket 'read' | 'write'. Throws 429 (with Retry-After on `res`).
  function charge(principal, bucket, cost, res) {
    const t = principal.tier; const cap = bucket === 'write' ? t.write_per_sec : t.read_per_sec;
    const tooMany = (details, retry) => {
      bumpUsage(principal.key.id, 'throttled');
      if (res) res.setHeader('Retry-After', String(retry));
      const e = new ApiError(429, 'too_many_requests', 'too many requests', details);
      e.toJSON = () => ({ error: { code: 'too_many_requests', message: 'too many requests', details, tier: principal.key.tier, bucket, retry_after_seconds: retry } });
      return e;
    };
    if (cost > cap) throw tooMany(s('rate.batch_too_large', { cost, tier: t.label, bucket, capacity: cap }), 60);
    const retry = store.take(`${principal.key.id}:${bucket}`, cap, cap, cost);
    if (retry) throw tooMany(s('rate.limited', { bucket, tier: t.label, seconds: retry }), retry);
  }
  const limitsVo = (principal) => {
    const t = principal.tier; const k = principal.key.id;
    return { tier: principal.key.tier, tier_label: t.label, read: { tokens_per_second: t.read_per_sec, bucket_capacity: t.read_per_sec, available_tokens: Math.floor(store.level(`${k}:read`, t.read_per_sec, t.read_per_sec)) },
      write: { tokens_per_second: t.write_per_sec, bucket_capacity: t.write_per_sec, available_tokens: Math.floor(store.level(`${k}:write`, t.write_per_sec, t.write_per_sec)) },
      websocket_connections: t.ws_connections, fix_sessions: t.fix_sessions };
  };

  // ---------------------------------------------------------------- key lifecycle
  const keyVo = (k) => ({
    api_key_id: k.id, label: k.label, scopes: JSON.parse(k.scopes), ip_allowlist: JSON.parse(k.ip_allowlist || '[]'), algorithm: k.algorithm, origin: k.origin,
    fingerprint: k.fingerprint, public_key: k.public_key_pem, tier: k.tier, status: effectiveStatus(k), created_time: iso(k.created_ts), expires_time: iso(k.expires_ts),
    revoked_time: iso(k.revoked_ts), revoked_by: k.revoked_by ? (k.revoked_by === k.user_id ? 'user' : k.revoked_by === 'rotation' ? 'rotation' : 'staff') : null,
    rotated_from: k.rotated_from, rotated_to: k.rotated_to, last_used_time: iso(k.last_used_ts), last_used_ip: k.last_used_ip,
  });
  // Validates a create / rotate body → { label, scopes, ips, expires, mode, keyObj, algorithm }.
  function parseBody(b, { inherit = null } = {}) {
    const errs = {};
    const out = {};
    if (inherit) { out.label = inherit.label; out.scopes = JSON.parse(inherit.scopes); out.ips = JSON.parse(inherit.ip_allowlist || '[]'); out.expires = inherit.expires_ts; out.tier = inherit.tier; } else {
      out.label = plain(b.label, 60); if (!out.label) errs.label = s('error.label');
      const sc = Array.isArray(b.scopes) ? b.scopes.map(String) : typeof b.scopes === 'string' ? b.scopes.split(/[\s,]+/).filter(Boolean) : null;
      if (!sc || !sc.length) errs.scopes = s('error.scopes');
      else { const bad = sc.find((x) => !SCOPES.includes(x)); if (bad) errs.scopes = s('error.scope_unknown', { scope: String(bad).slice(0, 20) }); else if (!sc.includes('read')) errs.scopes = s('error.scopes'); else out.scopes = SCOPES.filter((x) => sc.includes(x)); }
      const rawIps = b.ip_allowlist == null || b.ip_allowlist === '' ? [] : Array.isArray(b.ip_allowlist) ? b.ip_allowlist : String(b.ip_allowlist).split(/[\s,]+/).filter(Boolean);
      if (!Array.isArray(rawIps) || rawIps.length > MAX_IPS) errs.ip_allowlist = s('error.ip_list', { max: MAX_IPS });
      else { const ips = []; for (const x of rawIps) { const c = parseCidr(x); if (!c) { errs.ip_allowlist = s('error.ip_entry', { entry: String(x).slice(0, 60) }); break; } if (!ips.includes(c)) ips.push(c); } out.ips = ips; }
      if (b.expires_at == null || b.expires_at === '') out.expires = null;
      else { const t = typeof b.expires_at === 'number' ? b.expires_at : Date.parse(String(b.expires_at)); if (!Number.isFinite(t) || t <= Date.now() || t > Date.now() + 2 * 366 * DAY) errs.expires_at = s('error.expiry'); else out.expires = Math.round(t); }
      out.tier = settings().default_tier;
    }
    const mode = b.mode || 'generate';
    if (!['generate', 'public_key'].includes(mode)) errs.mode = s('error.mode');
    out.mode = mode;
    if (mode === 'public_key' && !errs.mode) { try { Object.assign(out, parsePublicKey(b.public_key)); } catch (e) { if (e instanceof Error) throw e; Object.assign(errs, e); } }
    if (Object.keys(errs).filter((k) => k !== 'code').length) throw fieldError(errs);
    return out;
  }
  // Creates the key row. Returns { row, privateKeyPem? }.
  function insertKey(userId, p, { rotatedFrom = null } = {}) {
    let privateKeyPem = null; let keyObj = p.keyObj; let algorithm = p.algorithm; let origin = 'uploaded';
    if (p.mode === 'generate') {
      const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      privateKeyPem = kp.privateKey; keyObj = crypto.createPublicKey(kp.publicKey); algorithm = 'rsa'; origin = 'generated';
    }
    const fp = fingerprintOf(keyObj);
    const dup = db.prepare("SELECT id, status, expires_ts FROM api_keys WHERE fingerprint=? AND status='active'").all(fp).find((r) => effectiveStatus(r) === 'active');
    if (dup) throw fieldError({ public_key: s('error.public_key_duplicate'), code: 'duplicate_public_key' });
    const id = `${KEY_PREFIX[env]}${crypto.randomUUID()}`;
    const pem = keyObj.export({ type: 'spki', format: 'pem' }).toString().trim();
    db.prepare('INSERT INTO api_keys(id,user_id,label,algorithm,public_key_pem,fingerprint,origin,scopes,ip_allowlist,tier,status,env,created_ts,expires_ts,rotated_from) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, userId, p.label, algorithm, pem, fp, origin, JSON.stringify(p.scopes), JSON.stringify(p.ips), p.tier, 'active', env, Date.now(), p.expires ?? null, rotatedFrom);
    return { row: getKey(id), privateKeyPem };
  }
  const activeCount = (uid) => db.prepare("SELECT id, status, expires_ts FROM api_keys WHERE user_id=? AND status='active'").all(uid).filter((r) => effectiveStatus(r) === 'active').length;
  const audit = (actor, action, k, before, after, reason = '') => {
    try { auditChain.append(db, { actor_id: actor?.id || null, actor_email: actor?.email || null, action, target_type: 'api_key', target_id: k.id, before, after, reason }); } catch (e) { console.error('api key audit', e.message); }
  };
  const brief = (k) => (k ? { id: k.id, user_id: k.user_id, label: k.label, scopes: JSON.parse(k.scopes), tier: k.tier, status: effectiveStatus(k), fingerprint: k.fingerprint, expires_ts: k.expires_ts, ip_allowlist: JSON.parse(k.ip_allowlist || '[]') } : null);

  function create(user, body) {
    const p = parseBody(body || {});
    if (activeCount(user.id) >= settings().max_keys_per_user) throw new ApiError(409, 'api_key_limit', s('error.key_limit', { max: settings().max_keys_per_user }));
    const { row, privateKeyPem } = tx(db, () => insertKey(user.id, p));
    audit(user, 'api_key.create', row, null, brief(row));
    events.emit('created', row, user);
    return { row, privateKeyPem };
  }
  function rotate(user, keyId, body, { actor = user } = {}) {
    const old = db.prepare('SELECT * FROM api_keys WHERE id=? AND user_id=?').get(String(keyId), user.id);
    if (!old) throw new ApiError(404, 'not_found', s('error.key_not_found'));
    if (effectiveStatus(old) !== 'active') throw new ApiError(409, 'api_key_inactive', s('error.key_inactive'));
    const p = parseBody(body || {}, { inherit: old });
    const grace = settings().rotation_grace_seconds * 1000;
    const out = tx(db, () => {
      const r = insertKey(user.id, p, { rotatedFrom: old.id });
      const exp = Math.min(old.expires_ts || Infinity, Date.now() + grace);
      db.prepare('UPDATE api_keys SET rotated_to=?, expires_ts=? WHERE id=?').run(r.row.id, exp, old.id);
      return r;
    });
    const after = getKey(old.id);
    audit(actor, 'api_key.rotate', old, brief(old), { ...brief(after), rotated_to: out.row.id });
    audit(actor, 'api_key.create', out.row, null, { ...brief(out.row), rotated_from: old.id });
    events.emit('rotated', after, out.row, user);
    if (grace === 0) events.emit('revoked', after, 'rotation');
    return { ...out, old: after };
  }
  function revoke(keyId, { actor, ownerId = null, reason = '', by = 'user' } = {}) {
    const k = ownerId ? db.prepare('SELECT * FROM api_keys WHERE id=? AND user_id=?').get(String(keyId), ownerId) : getKey(keyId);
    if (!k) throw new ApiError(404, 'not_found', s('error.key_not_found'));
    if (k.status === 'revoked') throw new ApiError(409, 'api_key_inactive', s('error.key_inactive'));
    db.prepare("UPDATE api_keys SET status='revoked', revoked_ts=?, revoked_by=?, revoke_reason=? WHERE id=?").run(Date.now(), by === 'user' ? k.user_id : actor?.id || by, String(reason || '').slice(0, 500), k.id);
    const after = getKey(k.id);
    audit(actor, by === 'user' ? 'api_key.revoke' : 'api_key.admin_revoke', k, brief(k), brief(after), reason);
    keyCache.delete(k.id);
    events.emit('revoked', after, by);
    return after;
  }
  function setTier(keyId, tier, actor, reason) {
    const k = getKey(keyId);
    if (!k) throw new ApiError(404, 'not_found', s('error.key_not_found'));
    if (!settings().tiers[tier]) throw fieldError({ tier: s('error.tier', { tier: String(tier).slice(0, 30) }) });
    db.prepare('UPDATE api_keys SET tier=? WHERE id=?').run(tier, k.id);
    const after = getKey(k.id);
    audit(actor, 'api_key.tier', k, brief(k), brief(after), reason);
    events.emit('tier', after);
    return after;
  }
  function usage(keyIds, days = 14) {
    flush();
    if (!keyIds.length) return [];
    const from = dayKey(Date.now() - (days - 1) * DAY);
    return db.prepare(`SELECT * FROM api_key_usage WHERE key_id IN (${keyIds.map(() => '?').join(',')}) AND day>=? ORDER BY day DESC, key_id`).all(...keyIds, from)
      .map((u) => ({ api_key_id: u.key_id, day: u.day, requests: u.requests, throttled: u.throttled, errors: u.errors, ws_connections: u.ws_connections, fix_messages: u.fix_messages }));
  }

  // Keys that pass their expiry (or a rotation grace period) are signed out like a revocation.
  const expiredSeen = new Set();
  function expirySweep() {
    const now = Date.now();
    for (const k of db.prepare("SELECT * FROM api_keys WHERE status='active' AND expires_ts IS NOT NULL AND expires_ts<=?").all(now)) {
      if (expiredSeen.has(k.id)) continue;
      expiredSeen.add(k.id);
      events.emit('revoked', k, k.rotated_to ? 'rotation' : 'expired');
    }
    if (expiredSeen.size > 10000) expiredSeen.clear();
    const notice = settings().expiry_notice_days * DAY;
    const soon = db.prepare("SELECT * FROM api_keys WHERE status='active' AND expiry_notified=0 AND rotated_to IS NULL AND expires_ts IS NOT NULL AND expires_ts>? AND expires_ts<=?").all(now, now + notice);
    for (const k of soon) { db.prepare('UPDATE api_keys SET expiry_notified=1 WHERE id=?').run(k.id); events.emit('expiring', k); }
    try { db.prepare('DELETE FROM api_replay WHERE expires_ts<?').run(now); } catch { /* closed */ }
  }

  return {
    SCOPES, DEFAULT_TIERS, env, events, store, settings, tierOf, authenticate, requireScopes, charge, limitsVo, keyVo, brief, create, rotate, revoke, setTier, usage, getKey,
    effectiveStatus, blockers, blockedReason, bumpUsage, flush, expirySweep, parseCidr, ipAllowed, parsePublicKey, fingerprintOf, verifyWith, AuthError, forbiddenError, fieldError,
    close: () => { clearInterval(flushTimer); flush(); },
  };
}

// ------------------------------------------------------------------------------------------------ routes
// Account › API keys (owner) and Admin › API keys (staff). Creating and rotating need a fresh step-up; the identity
// module's A2 lock (server/identity.js) answers 403 permission_denied until identity verification is approved.
// Revoking needs neither: a user must always be able to switch a key off.
function mountApiKeys({ v1, db, engine, auth, admin, flags, feat, cms = null, apiKeys, security = null }) {
  const can = admin.can;
  const requireUser = (req, res, next) => {
    if (!req.auth) return next(E.unauthorized());
    if (req.params.uid && req.params.uid !== req.auth.user.id) return next(E.forbidden('cannot access another user'));
    next();
  };
  const reasonOf = (b) => { const r = String((b && b.reason) || '').trim(); if (r.length < 3 || r.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); return r; };
  const originOf = (req) => (process.env.PUBLIC_ORIGIN || (req && security ? security.selfOrigin(req) : '') || 'http://localhost').replace(/\/+$/, '');
  const fmtTime = (t) => `${new Date(t).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  // In-app notice (the notification matrix decides push / email copies) plus a direct security email from the CMS
  // templates email.api_key_* (Admin › Content › Templates, CLONE_SPEC.md §32.5).
  function tell(uid, type, title, body, emailKey, vars, req = null) {
    try { feat.notify(uid, { type, title, body, link: '/account/api-keys' }); } catch (e) { console.error('api key notify', e.message); }
    const u = db.prepare('SELECT id, email, display_name FROM users WHERE id=?').get(uid);
    if (!u || !cms || !flags.on('notify.email', { uid })) return;
    try {
      const origin = originOf(req);
      const em = cms.renderSystem(emailKey, { name: u.display_name, link: `${origin}/account/api-keys`, ...vars }, { origin });
      if (auth.hooks.mailer) auth.hooks.mailer({ userId: u.id, to: u.email, subject: em.subject, text: em.text, html: em.html });
      else db.prepare('INSERT INTO email_outbox(id,user_id,to_email,subject,body,created_at) VALUES(?,?,?,?,?,?)').run(newId('em_'), u.id, u.email, em.subject, em.text, nowIso());
    } catch (e) { console.error('api key email', e.message); }
  }
  apiKeys.events.on('expiring', (k) => tell(k.user_id, 'api_key_expiring', s('notify.expiring.title', { label: k.label }), s('notify.expiring.body', { label: k.label, key: k.id.slice(0, 13), time: fmtTime(k.expires_ts) }), 'email.api_key_expiring', { label: k.label, key_id: k.id, expires: fmtTime(k.expires_ts) }));
  apiKeys.events.on('revoked', (k, by) => {
    if (by === 'expired') return;
    const who = s(by === 'user' ? 'notify.revoked.by_you' : by === 'rotation' ? 'notify.revoked.by_rotation' : 'notify.revoked.by_staff');
    tell(k.user_id, 'api_key_revoked', s('notify.revoked.title', { label: k.label }), s('notify.revoked.body', { label: k.label, key: k.id.slice(0, 13), by: who }), 'email.api_key_revoked', { label: k.label, key_id: k.id, by: who });
  });
  // The expiry job: keys reaching their expiry (or the end of a rotation grace period) are signed out; owners hear
  // `expiry_notice_days` before a key expires. Paused while the api.keys flag is off.
  engine.on('tick', () => { if (flags.jobOn('api.keys')) { try { apiKeys.expirySweep(); } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('api key sweep', e.message); } } });

  // ---------------------------------------------------------------- Account › API keys
  const listVo = (uid) => db.prepare('SELECT * FROM api_keys WHERE user_id=? ORDER BY created_ts DESC').all(uid).map(apiKeys.keyVo);
  v1.get('/users/:uid/api_keys', requireUser, (req, res) => {
    const st = apiKeys.settings();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ api_keys: listVo(req.auth.user.id), scopes: apiKeys.SCOPES, max_active_keys: st.max_keys_per_user, rotation_grace_seconds: st.rotation_grace_seconds,
      tiers: Object.fromEntries(Object.entries(st.tiers).map(([k, t]) => [k, { label: t.label, read_per_sec: t.read_per_sec, write_per_sec: t.write_per_sec, ws_connections: t.ws_connections, fix_sessions: t.fix_sessions }])) });
  });
  v1.post('/users/:uid/api_keys', requireUser, (req, res) => {
    const b = req.body || {};
    auth.assertFresh(req, 'api_key_create'); // step-up (CLONE_SPEC.md §22.6)
    const { row, privateKeyPem } = apiKeys.create(req.auth.user, b);
    auth.logEvent(req.auth.user.id, 'api_key_created', req, { key: row.id, label: row.label, scopes: JSON.parse(row.scopes), origin: row.origin });
    tell(req.auth.user.id, 'api_key_created', s('notify.created.title', { label: row.label }), s('notify.created.body', { label: row.label, scopes: JSON.parse(row.scopes).join(', '), fingerprint: row.fingerprint.slice(0, 19) }),
      'email.api_key_created', { label: row.label, key_id: row.id, scopes: JSON.parse(row.scopes).join(', '), fingerprint: row.fingerprint }, req);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ api_key: apiKeys.keyVo(row), ...(privateKeyPem ? { private_key: privateKeyPem } : {}) });
  });
  v1.post('/users/:uid/api_keys/:id/rotate', requireUser, (req, res) => {
    auth.assertFresh(req, 'api_key_rotate');
    const r = apiKeys.rotate(req.auth.user, req.params.id, req.body || {});
    auth.logEvent(req.auth.user.id, 'api_key_rotated', req, { key: r.old.id, new_key: r.row.id });
    tell(req.auth.user.id, 'api_key_created', s('notify.rotated.title', { label: r.row.label }), s('notify.rotated.body', { old: r.old.id.slice(0, 13), time: fmtTime(r.old.expires_ts) }),
      'email.api_key_created', { label: r.row.label, key_id: r.row.id, scopes: JSON.parse(r.row.scopes).join(', '), fingerprint: r.row.fingerprint }, req);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ api_key: apiKeys.keyVo(r.row), previous: apiKeys.keyVo(r.old), ...(r.privateKeyPem ? { private_key: r.privateKeyPem } : {}) });
  });
  v1.delete('/users/:uid/api_keys/:id', requireUser, (req, res) => {
    const k = apiKeys.revoke(req.params.id, { actor: req.auth.user, ownerId: req.auth.user.id, by: 'user', reason: 'revoked by the owner' });
    auth.logEvent(req.auth.user.id, 'api_key_revoked', req, { key: k.id });
    res.json({ api_key: apiKeys.keyVo(k) });
  });
  v1.get('/users/:uid/api_keys/usage', requireUser, (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const ids = db.prepare('SELECT id FROM api_keys WHERE user_id=?').all(req.auth.user.id).map((r) => r.id);
    res.json({ days, usage: apiKeys.usage(ids, days) });
  });

  // ---------------------------------------------------------------- Admin › API keys
  const emailOf = (id) => db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || id;
  const adminVo = (k) => ({ ...apiKeys.keyVo(k), user_id: k.user_id, user_email: emailOf(k.user_id), revoke_reason: k.revoke_reason || null });
  v1.get('/admin/api_keys/settings', can('settings.write'), (req, res) => res.json({ settings: apiKeys.settings(), defaults: { tiers: DEFAULT_TIERS, ...DEFAULT_SETTINGS } }));
  v1.put('/admin/api_keys/settings', can('settings.write'), (req, res) => {
    const b = req.body || {};
    const reason = reasonOf(b);
    const errs = {}; const next = {};
    const intIn = (k, lo, hi) => { if (b[k] === undefined) return; const n = Number(b[k]); if (!Number.isInteger(n) || n < lo || n > hi) errs[k] = `must be a whole number from ${lo} to ${hi}`; else next[k] = n; };
    intIn('rotation_grace_seconds', 0, 30 * 86400); intIn('window_past_ms', 1000, 60000); intIn('window_future_ms', 0, 10000); intIn('max_keys_per_user', 1, 50); intIn('expiry_notice_days', 1, 30);
    if (b.default_tier !== undefined) { if (!DEFAULT_TIERS[b.default_tier]) errs.default_tier = 'unknown tier'; else next.default_tier = b.default_tier; }
    if (b.tiers !== undefined) {
      if (!b.tiers || typeof b.tiers !== 'object') errs.tiers = 'must be an object of tiers';
      else {
        next.tiers = {};
        for (const [k, v] of Object.entries(b.tiers)) {
          if (!DEFAULT_TIERS[k]) { errs[`tiers.${k}`] = 'unknown tier'; continue; }
          const t = {};
          for (const [f, lo, hi] of [['read_per_sec', 1, 1e6], ['write_per_sec', 1, 1e6], ['ws_connections', 0, 1000], ['fix_sessions', 0, 100]]) {
            if (v?.[f] === undefined) continue;
            const n = Number(v[f]); if (!Number.isInteger(n) || n < lo || n > hi) errs[`tiers.${k}.${f}`] = `must be a whole number from ${lo} to ${hi}`; else t[f] = n;
          }
          next.tiers[k] = t;
        }
      }
    }
    if (Object.keys(errs).length) throw apiKeys.fieldError(errs);
    auth.assertFresh(req, 'api_settings');
    const before = apiKeys.settings();
    const cur = (() => { const r = db.prepare("SELECT value FROM admin_settings WHERE key='api.settings'").get(); return r ? JSON.parse(r.value) : {}; })();
    const merged = { ...cur, ...next, tiers: { ...(cur.tiers || {}) } };
    for (const [k, t] of Object.entries(next.tiers || {})) merged.tiers[k] = { ...(cur.tiers?.[k] || {}), ...t };
    db.prepare("INSERT INTO admin_settings(key,value,updated_at,updated_by) VALUES('api.settings',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by").run(JSON.stringify(merged), nowIso(), req.auth.user.id);
    admin.audit(req, 'api.settings', 'settings', 'api.settings', before, apiKeys.settings(), reason);
    res.json({ settings: apiKeys.settings() });
  });
  v1.get('/admin/api_keys', can('users.read'), (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const where = []; const args = [];
    if (q) { where.push('(k.id=? OR lower(u.email) LIKE ? OR lower(k.label) LIKE ?)'); args.push(q, `%${q}%`, `%${q}%`); }
    if (req.query.user_id) { where.push('k.user_id=?'); args.push(String(req.query.user_id)); }
    const rows = db.prepare(`SELECT k.* FROM api_keys k JOIN users u ON u.id=k.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY k.created_ts DESC LIMIT 500`).all(...args);
    const today = new Map(apiKeys.usage(rows.map((r) => r.id), 1).map((u) => [u.api_key_id, u]));
    res.json({ api_keys: rows.map((k) => ({ ...adminVo(k), today: today.get(k.id) || { requests: 0, throttled: 0, errors: 0 } })), tiers: Object.keys(apiKeys.settings().tiers) });
  });
  v1.get('/admin/api_keys/:id', can('users.read'), (req, res) => {
    const k = apiKeys.getKey(req.params.id);
    if (!k) throw E.notFound();
    res.json({ api_key: adminVo(k), usage: apiKeys.usage([k.id], 30) });
  });
  v1.put('/admin/api_keys/:id/tier', can('users.support'), (req, res) => {
    const b = req.body || {};
    const reason = reasonOf(b);
    res.json({ api_key: adminVo(apiKeys.setTier(req.params.id, String(b.tier || ''), req.auth.user, reason)) });
  });
  v1.post('/admin/api_keys/:id/revoke', can('users.support'), (req, res) => {
    const reason = reasonOf(req.body);
    const k = apiKeys.revoke(req.params.id, { actor: req.auth.user, by: 'staff', reason }); // audited (hash chain) inside
    res.json({ api_key: adminVo(k) });
  });
}

module.exports = { createApiKeys, mountApiKeys, MemoryRateStore, DEFAULT_TIERS, DEFAULT_SETTINGS, SCOPES, KEY_PREFIX, parseCidr, ipAllowed };
