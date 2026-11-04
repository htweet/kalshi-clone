'use strict';
// Identity, sessions and login security (PLAN P1.4, P1.5, P1.6, P1.14, P1.15; CLONE_SPEC.md §22).
//
// createAuth() is called by createApp() before any route is mounted:
//   auth.attach      app-level: resolves the session cookie, enforces session CSRF and login CSRF
//   auth.guard       app-level on /v1: step-up verification for sensitive actions, privilege-change rotation
//   auth.mountRoutes v1 routes (sign-up, log in/out, two-factor, sessions, step-up, password/email, security log,
//                    admin identity tools); mounted after the admin module so its decorators/locks still apply
//   auth.bootstrap   first-admin setup (env / start option / one-time setup URL); no default admin password
// Everything is persisted in SQLite (tables created below; the shared `sessions` and `mfa` tables are migrated in
// place, idempotently).
const currency = require('./currency'); // new-account defaults (CLONE_SPEC.md §30)
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { tx } = require('./db');
const { nowIso, newId, token, ApiError, E } = require('./util');
const pw = require('./passwords');
const kc = require('./crypto');
const auditChain = require('./audit-chain');
const { totp, b32encode } = require('./features');
const { ROLE_PERMS } = require('./admin');

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const DEFAULTS = {
  idleMs: 7 * DAY, // sliding idle timeout, regular accounts
  adminIdleMs: 30 * MIN, // sliding idle timeout, any account with an admin role
  absoluteMs: 30 * DAY, // absolute lifetime of a session, however active
  stepUpMs: 10 * MIN, // a password/TOTP check this recent satisfies step-up
  accountThreshold: 5, // failed logins per account (or unknown email) before backoff starts
  ipThreshold: 20, // failed logins per client IP before backoff starts
  baseLockMs: 30000, // first lockout; doubles with every further failure
  maxLockMs: 15 * MIN,
  failureWindowMs: 60 * MIN, // failures older than this are forgotten
  largeDepositCents: 1_000_000, // deposits above $10,000 need step-up
  largeTransferCents: 1_000_000, // perps transfers above $10,000 need step-up
  preCsrfMs: 60 * MIN, // login-CSRF cookie lifetime
  mfaChallengeMs: 5 * MIN,
  setupTokenMs: 60 * MIN,
  changeTokenMs: 15 * MIN,
  powBaseBits: 12, // RS2: proof-of-work difficulty at the threshold (≈4k hashes), +1 bit per further failure
  powMaxBits: 18, // ≈262k hashes, well under a second in the browser
  secureCookies: null, // null = Secure + __Host- names when NODE_ENV=production, SECURE_COOKIES=1 or the request is HTTPS
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_events (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, user_id TEXT, type TEXT NOT NULL, ip_prefix TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_auth_events_ts ON auth_events(ts);
CREATE TABLE IF NOT EXISTS auth_throttle (key TEXT PRIMARY KEY, scope TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, last_failure INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS auth_tokens (hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id TEXT, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS auth_user_security (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, withdrawal_mfa INTEGER NOT NULL DEFAULT 0, must_change_password INTEGER NOT NULL DEFAULT 0,
  password_changed_at TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS email_outbox (id TEXT PRIMARY KEY, user_id TEXT, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_pow_used (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
`;
// RS2 (PLAN §10): after `accountThreshold` failures an account is not hard-locked; each further sign-in attempt must carry
// a proof of work (SHA-256(id:nonce) with `bits` leading zero bits), growing by one bit per failure up to powMaxBits.
const POW_TTL_MS = 2 * 60000;

// Seeded demo accounts and the passwords the first builds gave them (removed: see bootstrap()).
const LEGACY_DEFAULTS = [['admin@parlance.local', 'parlance-admin'], ['maple_quant@parlance.local', 'parlance-demo'], ['harborwatch@parlance.local', 'parlance-demo'], ['rainmaker@parlance.local', 'parlance-demo']];

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookie */ } }
  }
  return out;
}
const normEmail = (e) => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function ipOf(req) { return String(req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, ''); }
// Privacy: store only a network prefix (IPv4 /24, IPv6 /48), never the full address.
function ipPrefix(ip) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').slice(0, 3).join('.') + '.x';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::/48';
  return ip.slice(0, 40);
}
// User-agent summary ("Chrome on Linux"); the raw string is not stored.
function deviceOf(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown device';
  if (/^(node|undici|curl|python|go-http|axios)/i.test(s)) return 'API client';
  const b = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /HeadlessChrome/.test(s) ? 'Chrome (headless)' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Browser';
  const o = /Windows/.test(s) ? 'Windows' : /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'macOS' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : 'unknown OS';
  return `${b} on ${o}`;
}
const maskEmail = (e) => { const [l, d] = String(e).split('@'); return d ? `${(l || '?')[0]}***@${d}` : '***'; };

class StepUpError extends ApiError {
  constructor(methods, action) { super(403, 'step_up_required', 'please confirm it’s you', 'enter your password or a two-factor code to continue'); this.methods = methods; this.action = action; }
  toJSON() { return { error: { code: this.code, message: this.message, details: this.details, methods: this.methods, action: this.action } }; }
}
class ThrottleError extends ApiError {
  constructor(sec) { super(429, 'too_many_attempts', 'too many sign-in attempts', `try again in ${sec} seconds`); this.retry = sec; }
  toJSON() { return { error: { code: this.code, message: this.message, details: this.details, retry_after_sec: this.retry } }; }
}
// RS2: same code and fields as ThrottleError (retry_after_sec 0) plus the challenge, so old clients see "too many attempts".
class PowRequiredError extends ApiError {
  constructor(challenge) { super(429, 'too_many_attempts', 'too many sign-in attempts', 'solve the sign-in check to continue'); this.challenge = challenge; }
  toJSON() { return { error: { code: this.code, message: this.message, details: this.details, retry_after_sec: 0, pow: this.challenge } }; }
}
const invalidCredentials = () => new ApiError(401, 'invalid_credentials', 'incorrect email or password');
const lockedError = () => new ApiError(403, 'account_locked', 'this account is locked', 'contact support to restore access');
const policyError = (bad) => new ApiError(400, bad.code, 'password does not meet the requirements', bad.message);

function createAuth({ db, engine, options = {}, keyDir }) {
  const opt = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options || {}).filter(([, v]) => v !== undefined)) };
  const keys = { enc: kc.deriveKey('field-encryption:v1', { dir: keyDir }), csrf: kc.deriveKey('login-csrf:v1', { dir: keyDir }), pow: kc.deriveKey('login-pow:v1', { dir: keyDir }) };
  // 'revoked' (sids[]) — the WebSocket hub drops those connections; 'signup' / 'login' / 'email_change' ({user, req, …})
  // — identity onboarding, email verification and passkey policy hooks (server/identity.js, server/webauthn.js).
  const events = new EventEmitter();
  const hooks = { mailer: null, stepUpExtras: () => [], preSession: [], template: null }; // set by server/identity.js, server/webauthn.js and the CMS (template)
  let beginLogin = null; // defined in mountRoutes (needs the user serializer)
  let notify = () => {};
  let rolesOf = (u) => (u && u.is_admin ? ['admin'] : []);
  let publicUser = (u) => ({ user_id: u.id, email: u.email, display_name: u.display_name, is_admin: !!u.is_admin, created_at: u.created_at });

  // ------------------------------------------------------------------ schema + idempotent migrations
  db.exec(SCHEMA);
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  const sc = cols('sessions');
  for (const [c, def] of [['sid', 'TEXT'], ['token_hashed', 'INTEGER NOT NULL DEFAULT 0'], ['last_seen_ms', 'INTEGER NOT NULL DEFAULT 0'], ['idle_ms', 'INTEGER NOT NULL DEFAULT 0'],
    ['ip_prefix', "TEXT NOT NULL DEFAULT ''"], ['device', "TEXT NOT NULL DEFAULT ''"], ['auth_at', 'INTEGER NOT NULL DEFAULT 0'], ['totp_at', 'INTEGER NOT NULL DEFAULT 0'], ['privileged', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!sc.has(c)) db.exec(`ALTER TABLE sessions ADD COLUMN ${c} ${def}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_sid ON sessions(sid); CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
  // RS3: the last accepted TOTP time step per user; a code for that step (or an earlier one) is never accepted again.
  if (!cols('mfa').has('last_step')) db.exec('ALTER TABLE mfa ADD COLUMN last_step INTEGER NOT NULL DEFAULT 0');
  const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const isPrivileged = (u) => !!u.is_admin || (hasTable('admin_roles') && !!db.prepare('SELECT 1 FROM admin_roles WHERE user_id=? LIMIT 1').get(u.id));
  tx(db, () => {
    // Session tokens were stored in plaintext by earlier builds: replace each by its SHA-256 (cookies keep working).
    for (const s of db.prepare('SELECT s.token, s.user_id, u.is_admin FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.token_hashed=0').all()) {
      const priv = s.is_admin || (hasTable('admin_roles') && db.prepare('SELECT 1 FROM admin_roles WHERE user_id=?').get(s.user_id));
      db.prepare('UPDATE sessions SET token=?, sid=?, token_hashed=1, last_seen_ms=?, idle_ms=?, privileged=? WHERE token=?')
        .run(kc.sha256hex(s.token), `ses_${token(12)}`, Date.now(), priv ? opt.adminIdleMs : opt.idleMs, priv ? 1 : 0, s.token);
    }
    // TOTP secrets were stored in plaintext: encrypt in place (AES-256-GCM, bound to the user id).
    for (const m of db.prepare('SELECT user_id, secret FROM mfa').all()) {
      if (!kc.isEncrypted(m.secret)) db.prepare('UPDATE mfa SET secret=? WHERE user_id=?').run(kc.encrypt(m.secret, `mfa.secret:${m.user_id}`, keys.enc), m.user_id);
    }
    // MFA challenge tokens are now stored hashed (64 hex); drop any short-lived plaintext ones.
    db.prepare('DELETE FROM mfa_challenges WHERE length(token)<>64').run();
    db.prepare('DELETE FROM auth_events WHERE ts<?').run(Date.now() - 400 * DAY);
  });
  pw.warmup(); // computes the dummy hash used for unknown emails, so the first one is not slower

  // ------------------------------------------------------------------ helpers
  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const isLocked = (uid) => hasTable('acct_locks') && !!db.prepare('SELECT 1 FROM acct_locks WHERE user_id=?').get(uid);
  const secRow = (uid) => db.prepare('SELECT * FROM auth_user_security WHERE user_id=?').get(uid) || { withdrawal_mfa: 0, must_change_password: 0, password_changed_at: null };
  function setSec(uid, fields) {
    db.prepare('INSERT INTO auth_user_security(user_id,updated_at) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING').run(uid, nowIso());
    for (const [k, v] of Object.entries(fields)) db.prepare(`UPDATE auth_user_security SET ${k}=?, updated_at=? WHERE user_id=?`).run(v, nowIso(), uid);
  }
  const mfaRaw = (uid) => db.prepare('SELECT * FROM mfa WHERE user_id=?').get(uid);
  function mfaOf(uid) {
    const r = mfaRaw(uid);
    if (!r) return null;
    const secret = kc.isEncrypted(r.secret) ? kc.decrypt(r.secret, `mfa.secret:${uid}`, keys.enc) : r.secret;
    return { ...r, secret };
  }
  const mfaEnabled = (uid) => !!mfaRaw(uid)?.enabled;
  // RS3 (TOTP replay): a code is accepted at most once. Steps −1/0/+1 around now (clock-skew window) that are newer than
  // the last accepted step match; the matched step is recorded with a conditional update, so two concurrent requests with
  // the same code cannot both succeed.
  function verifyTotpOnce(uid, secret, code) {
    if (!/^\d{6}$/.test(String(code ?? ''))) return false;
    const now = Math.floor(Date.now() / 30000);
    const last = mfaRaw(uid)?.last_step || 0;
    for (const w of [-1, 0, 1]) {
      const step = now + w;
      if (step <= last || !kc.safeEqual(totp(secret, step * 30000), String(code))) continue;
      return db.prepare('UPDATE mfa SET last_step=? WHERE user_id=? AND last_step<?').run(step, uid, step).changes === 1;
    }
    return false;
  }

  function logEvent(userId, type, req, detail = {}) {
    db.prepare('INSERT INTO auth_events(id,ts,user_id,type,ip_prefix,device,detail) VALUES(?,?,?,?,?,?,?)')
      .run(newId('ae_'), Date.now(), userId || null, type, req ? ipPrefix(ipOf(req)) : '', req ? deviceOf(req.get?.('user-agent')) : 'server', JSON.stringify(detail));
  }
  // Email goes through the messaging provider (server/messaging.js: dev outbox or SMTP, RS6) once identity.js sets the
  // hook; before that (and in unit use) messages are written to the email_outbox table.
  function sendEmail(user, subject, body, to = user.email, html = null) {
    if (hooks.mailer) { hooks.mailer({ userId: user.id, to, subject, text: body, html }); return; }
    db.prepare('INSERT INTO email_outbox(id,user_id,to_email,subject,body,created_at) VALUES(?,?,?,?,?,?)').run(newId('em_'), user.id, to, subject, body, nowIso());
  }
  function alertUser(user, title, body) {
    try { notify(user.id, { type: 'security', title, body, link: '/account/security' }); } catch (e) { console.error('security notify', e); }
    // Template email.security_alert (Admin › Content › Templates, CLONE_SPEC.md §32.5).
    const em = hooks.template ? hooks.template('email.security_alert', { title, body }) : null;
    if (em) sendEmail(user, em.subject, em.text, user.email, em.html);
    else sendEmail(user, `Parlance security alert: ${title}`, `${body}\n\nIf this wasn't you, change your password and review your signed-in devices in Account › Security.`);
  }
  function audit(actor, action, targetType, targetId, before, after, reason = '') {
    if (!hasTable('admin_audit')) return;
    auditChain.append(db, { actor_id: actor?.id || null, actor_email: actor?.email || null, action, target_type: targetType, target_id: targetId, before, after, reason });
  }

  // One-time tokens (admin setup, forced password change): only the SHA-256 is stored.
  function issueToken(purpose, userId, ttlMs, data = {}) {
    const raw = token(24);
    db.prepare('INSERT INTO auth_tokens(hash,purpose,user_id,data,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(kc.sha256hex(raw), purpose, userId, JSON.stringify(data), Date.now(), Date.now() + ttlMs);
    return raw;
  }
  function peekToken(purpose, raw) {
    const r = raw ? db.prepare('SELECT * FROM auth_tokens WHERE hash=? AND purpose=?').get(kc.sha256hex(String(raw)), purpose) : null;
    return r && !r.used_at && r.expires_at > Date.now() ? { ...r, data: JSON.parse(r.data) } : null;
  }
  const useToken = (r) => db.prepare('UPDATE auth_tokens SET used_at=? WHERE hash=? AND used_at IS NULL').run(Date.now(), r.hash).changes === 1;

  // ------------------------------------------------------------------ cookies
  const secureFor = (req) => (opt.secureCookies != null ? !!opt.secureCookies : process.env.NODE_ENV === 'production' || process.env.SECURE_COOKIES === '1' || !!req.secure);
  // __Host- requires Secure, so plain-http localhost uses the unprefixed names.
  const names = (secure) => (secure ? { session: '__Host-plx_session', pre: '__Host-plx_pre' } : { session: 'plx_session', pre: 'plx_pre' });
  function cookie(res, req, name, value, { maxAgeSec, sameSite = 'Lax' }) {
    const secure = secureFor(req);
    res.append('Set-Cookie', `${names(secure)[name]}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
  }
  function rawSessionToken(cookieHeader) {
    const c = parseCookies(cookieHeader);
    return c['__Host-plx_session'] || c.plx_session || null;
  }

  // ------------------------------------------------------------------ sessions
  function check(s, o = {}) {
    const touch = o.touch !== false;
    if (!s) return null;
    const now = Date.now();
    if (Date.parse(s.expires_at) <= now || (s.idle_ms > 0 && now - s.last_seen_ms > s.idle_ms)) {
      db.prepare('DELETE FROM sessions WHERE token=?').run(s.token);
      logEvent(s.user_id, 'session_expired', null, { session: s.sid, reason: Date.parse(s.expires_at) <= now ? 'absolute' : 'idle' });
      return null;
    }
    const u = getUser(s.user_id);
    if (!u || isLocked(u.id)) return null;
    // RS10: only user-initiated activity extends the idle window. The SPA reports the seconds since the last real user
    // interaction (`X-Plx-Idle`, sent on every request including background polls), so the session is touched at
    // "now − idle", never later; clients that do not send it (API scripts) count every request as activity.
    const seen = now - Math.min(Math.max(0, Number(o.idleSec) || 0) * 1000, s.idle_ms || 0);
    if (touch && seen - s.last_seen_ms > Math.min(30000, s.idle_ms / 10)) { db.prepare('UPDATE sessions SET last_seen_ms=? WHERE token=?').run(seen, s.token); s.last_seen_ms = seen; }
    return { session: s, user: u };
  }
  const fromRaw = (raw, o) => (raw && raw.length <= 128 ? check(db.prepare('SELECT * FROM sessions WHERE token=?').get(kc.sha256hex(raw)), o) : null);
  const fromCookieHeader = (h, o) => fromRaw(rawSessionToken(h), o);
  const sessionAlive = (sid) => !!check(db.prepare('SELECT * FROM sessions WHERE sid=?').get(sid), { touch: false });

  function setSessionCookie(res, req, raw, privileged) {
    cookie(res, req, 'session', raw, { maxAgeSec: Math.floor(opt.absoluteMs / 1000), sameSite: privileged ? 'Strict' : 'Lax' });
  }
  // New session (log in, sign up, MFA completion, admin setup). The session the request arrived with, if any,
  // is deleted first so a planted cookie can never be upgraded (session fixation).
  function createSession(req, res, user, { totpVerified = false } = {}) {
    const old = rawSessionToken(req.headers.cookie);
    if (old) db.prepare('DELETE FROM sessions WHERE token=?').run(kc.sha256hex(old));
    const raw = token(32); const csrf = token(18); const sid = `ses_${token(12)}`; const now = Date.now();
    const privileged = isPrivileged(user);
    db.prepare('INSERT INTO sessions(token,user_id,csrf_token,created_at,expires_at,sid,token_hashed,last_seen_ms,idle_ms,ip_prefix,device,auth_at,totp_at,privileged) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?)')
      .run(kc.sha256hex(raw), user.id, csrf, new Date(now).toISOString(), new Date(now + opt.absoluteMs).toISOString(), sid, now, privileged ? opt.adminIdleMs : opt.idleMs,
        ipPrefix(ipOf(req)), deviceOf(req.get('user-agent')), now, totpVerified ? now : 0, privileged ? 1 : 0);
    setSessionCookie(res, req, raw, privileged);
    cookie(res, req, 'pre', '', { maxAgeSec: 0 }); // the login-CSRF cookie has done its job
    res.setHeader('X-Csrf-Token', csrf);
    return { csrf, sid };
  }
  // Same session (same sid, timestamps, device entry), new token + CSRF token: MFA enable, password change,
  // own privilege change. The WebSocket stays bound by sid.
  function rotate(req, res, session, user, extra = {}) {
    const raw = token(32); const csrf = token(18);
    const privileged = isPrivileged(user);
    db.prepare('UPDATE sessions SET token=?, csrf_token=?, privileged=?, idle_ms=?, auth_at=COALESCE(?,auth_at), totp_at=COALESCE(?,totp_at) WHERE sid=?')
      .run(kc.sha256hex(raw), csrf, privileged ? 1 : 0, privileged ? opt.adminIdleMs : opt.idleMs, extra.authAt ?? null, extra.totpAt ?? null, session.sid);
    setSessionCookie(res, req, raw, privileged);
    res.setHeader('X-Csrf-Token', csrf);
    return csrf;
  }
  // Revoke sessions of a user (all, or all but `keepSid`). Returns the revoked sids.
  function revokeAll(userId, { keepSid = null } = {}) {
    const sids = db.prepare('SELECT sid FROM sessions WHERE user_id=?').all(userId).map((r) => r.sid).filter((s) => s !== keepSid);
    for (const s of sids) db.prepare('DELETE FROM sessions WHERE sid=?').run(s);
    if (sids.length) events.emit('revoked', sids);
    return sids;
  }
  const clearSessionCookie = (res, req) => cookie(res, req, 'session', '', { maxAgeSec: 0 });

  // ------------------------------------------------------------------ login CSRF (pre-session token)
  // Cookie `plx_pre` = "<nonce>.<expiry ms>"; the matching token is HMAC(login-csrf key, cookie value) and must be
  // sent as x-csrf-token on the pre-session endpoints. A cross-site page can neither read the token nor set the
  // cookie, so it cannot log a victim into an attacker-controlled account.
  const preToken = (v) => kc.hmacHex(keys.csrf, v).slice(0, 43);
  function checkLoginCsrf(req) {
    const c = parseCookies(req.headers.cookie);
    const v = c['__Host-plx_pre'] || c.plx_pre;
    if (!v) return false;
    const exp = Number(v.split('.')[1]);
    return Number.isFinite(exp) && exp > Date.now() && kc.safeEqual(req.get('x-csrf-token') || '', preToken(v));
  }
  const PRE_SESSION = new Set(['/v1/log_in', '/v1/users', '/v1/log_in_mfa', '/v1/auth/setup_admin', '/v1/auth/complete_password_change']);
  // Further pre-session endpoints registered by identity modules: [method, RegExp on the full path] (password reset,
  // passkey sign-in, OAuth callback / link — server/identity.js, server/webauthn.js, server/oauth.js).
  const isPreSession = (req) => (req.method === 'POST' && PRE_SESSION.has(req.path)) || hooks.preSession.some(([m, re]) => m === req.method && re.test(req.path));

  function attach(req, res, next) {
    const idle = req.headers['x-plx-idle'];
    req.auth = fromCookieHeader(req.headers.cookie, idle != null ? { idleSec: Number(idle) } : {});
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (isPreSession(req)) {
        if (!checkLoginCsrf(req)) return next(E.forbidden('missing or invalid login csrf token'));
      } else if (req.auth && !kc.safeEqual(req.get('x-csrf-token') || '', req.auth.session.csrf_token)) {
        return next(E.forbidden('missing or invalid x-csrf-token'));
      }
    }
    next();
  }

  // ------------------------------------------------------------------ login throttling
  const acctKey = (email) => `acct:${kc.sha256hex(email)}`;
  const ipKey = (ip) => `ip:${ip}`;
  function assertOpen(keyList) {
    const now = Date.now();
    for (const k of keyList) {
      const r = db.prepare('SELECT locked_until FROM auth_throttle WHERE key=?').get(k);
      if (r && r.locked_until > now) throw new ThrottleError(Math.ceil((r.locked_until - now) / 1000));
    }
  }
  function bump(key, scope, threshold) {
    const now = Date.now();
    const r = db.prepare('SELECT * FROM auth_throttle WHERE key=?').get(key);
    const failures = r && now - r.last_failure <= opt.failureWindowMs ? r.failures + 1 : 1;
    const lockMs = failures >= threshold ? Math.min(opt.maxLockMs, opt.baseLockMs * 2 ** (failures - threshold)) : 0;
    db.prepare('INSERT INTO auth_throttle(key,scope,failures,last_failure,locked_until) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures, last_failure=excluded.last_failure, locked_until=excluded.locked_until')
      .run(key, scope, failures, now, lockMs ? now + lockMs : 0);
    return { failures, lockMs };
  }
  // Records a failed attempt for the email (existing account or not — the behaviour must not differ) and the IP.
  function recordFailure(req, email, user, kind) {
    const a = bump(acctKey(email), 'account', opt.accountThreshold);
    const i = bump(ipKey(ipOf(req)), 'ip', opt.ipThreshold);
    if (a.lockMs) {
      // RS2: sign-in for the account now needs a proof of work (no hard lock a stranger could hold); step-up and password
      // change from an existing session still back off for `seconds`.
      logEvent(user?.id, 'lockout', req, { scope: 'account', mode: 'proof_of_work', pow_bits: powBits(a.failures), seconds: Math.round(a.lockMs / 1000), failures: a.failures, after: kind, ...(user ? {} : { email: maskEmail(email) }) });
      if (user && a.failures === opt.accountThreshold) alertUser(user, 'Repeated failed sign-ins', `There were ${a.failures} failed attempts to sign in to your account. Further attempts now need an extra automatic check in the browser.`);
    }
    if (i.lockMs && i.failures === opt.ipThreshold) logEvent(null, 'lockout', req, { scope: 'ip', seconds: Math.round(i.lockMs / 1000), failures: i.failures });
  }
  const clearFailures = (email) => db.prepare('DELETE FROM auth_throttle WHERE key=?').run(acctKey(email));

  // ------------------------------------------------------------------ RS2: proof of work instead of an account lock
  const powBits = (failures) => Math.min(opt.powMaxBits, opt.powBaseBits + Math.max(0, failures - opt.accountThreshold));
  const powBinding = (email) => acctKey(email).slice(5, 21);
  const powMac = (payload) => kc.hmacHex(keys.pow, payload).slice(0, 43);
  function leadingZeroBits(buf) {
    let n = 0;
    for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
    return n;
  }
  function powChallenge(email, bits) {
    const id = token(12);
    const payload = Buffer.from(JSON.stringify({ id, k: powBinding(email), b: bits, t: Date.now() })).toString('base64url');
    return { token: `${payload}.${powMac(payload)}`, id, bits, algorithm: 'sha256-leading-zero-bits', input: 'id:nonce' };
  }
  // Returns the difficulty proven by a valid, unexpired, unused solution bound to this email, else 0.
  function powProven(email, pow) {
    if (!pow || typeof pow !== 'object' || typeof pow.token !== 'string' || typeof pow.nonce !== 'string' || pow.token.length > 300 || !/^\d{1,16}$/.test(pow.nonce)) return 0;
    const [payload, mac] = pow.token.split('.');
    if (!payload || !mac || !kc.safeEqual(mac, powMac(payload))) return 0;
    let o; try { o = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return 0; }
    if (!o || o.k !== powBinding(email) || !(Date.now() - o.t <= POW_TTL_MS)) return 0;
    if (leadingZeroBits(crypto.createHash('sha256').update(`${o.id}:${pow.nonce}`).digest()) < o.b) return 0;
    db.prepare('DELETE FROM login_pow_used WHERE expires_at<?').run(Date.now());
    if (db.prepare('INSERT INTO login_pow_used(id,expires_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(String(o.id), Date.now() + POW_TTL_MS).changes !== 1) return 0; // single use
    return o.b;
  }
  // Below the threshold: nothing. At or above: a solved challenge of the current difficulty is required, otherwise 429 with
  // a fresh challenge. Same behaviour for existing and unknown emails.
  function powGate(req, email) {
    const r = db.prepare('SELECT failures, last_failure FROM auth_throttle WHERE key=?').get(acctKey(email));
    const failures = r && Date.now() - r.last_failure <= opt.failureWindowMs ? r.failures : 0;
    if (failures < opt.accountThreshold) return;
    const need = powBits(failures);
    if (powProven(email, req.body && req.body.pow) >= need) return;
    throw new PowRequiredError(powChallenge(email, need));
  }

  // ------------------------------------------------------------------ step-up guard
  const amountCents = (b) => { const a = Number(b && b.amount_dollars); return Number.isFinite(a) ? Math.round(a * 100) : 0; };
  const transferCents = (b) => (b && b.amount_dollars != null ? amountCents(b) : Math.round(Number(b && b.amount) / 100) || 0);
  // Central list of sensitive actions (mirrors action_verification_mfa). API-key creation joins it in P7.1.
  const SENSITIVE = [
    ['POST', /^\/users\/[^/]+\/mfa\/disable$/, 'mfa_disable'],
    ['PUT', /^\/users\/[^/]+\/password$/, 'password_change'],
    ['PUT', /^\/users\/[^/]+\/email$/, 'email_change'],
    ['PUT', /^\/users\/[^/]+\/withdrawal_mfa$/, 'withdrawal_mfa'],
    ['POST', /^\/users\/[^/]+\/withdrawals$/, 'withdrawal'],
    // Payment rails (server/payments.js, CLONE_SPEC.md §26): every withdrawal, and every new payout destination (a linked
    // bank account or a crypto withdrawal address). Withdrawal two-factor (withdrawal_mfa) covers both.
    ['POST', /^\/users\/[^/]+\/(debit|bank_link|crypto)\/withdrawal$/, 'withdrawal'],
    ['POST', /^\/users\/[^/]+\/(banks\/linked_accounts|crypto\/wallets)$/, 'payout_destination'],
    ['POST', /^\/users\/[^/]+\/deposits$/, 'large_deposit', (req) => amountCents(req.body) > opt.largeDepositCents],
    ['POST', /^\/perps\/transfers$/, 'large_transfer', (req) => transferCents(req.body) > opt.largeTransferCents],
    ['PUT', /^\/admin\/roles\/[^/]+$/, 'admin_role_change'],
    ['POST', /^\/admin\/users\/[^/]+\/force_password_reset$/, 'admin_force_password_reset'],
    ['PUT', /^\/admin\/settings\/currency$/, 'admin_currency_settings'], // display currency + new-account defaults (§30)
  ];
  // Accepted step-up methods: password (+ two-factor code when on) plus any registered by identity modules (passkey).
  const stepUpMethods = (uid) => [...(mfaEnabled(uid) ? ['password', 'totp'] : ['password']), ...hooks.stepUpExtras(uid)];
  // For handlers that decide sensitivity themselves (data export, account closure, phone change, passkey and OAuth
  // linking — server/identity.js and friends): same freshness rule and error as the central list.
  function assertFresh(req, action) {
    if (!req.auth) throw E.unauthorized();
    if (Date.now() - req.auth.session.auth_at > opt.stepUpMs) throw new StepUpError(stepUpMethods(req.auth.user.id), action);
  }
  // A verification done elsewhere (passkey assertion) refreshes the step-up window of this session.
  const markStepUp = (sid) => db.prepare('UPDATE sessions SET auth_at=? WHERE sid=?').run(Date.now(), sid);
  // Password check with the same throttling as step-up (per-IP and per-account backoff, failure logging).
  async function checkPassword(req, user, password, kind = 'password_check') {
    assertOpen([acctKey(user.email), ipKey(ipOf(req))]);
    if (!(await pw.verifyPassword(String(password ?? ''), user.password_hash))) {
      recordFailure(req, user.email, user, kind);
      logEvent(user.id, 'step_up_fail', req, { method: 'password', at: kind });
      throw new ApiError(400, 'invalid_password', 'that password is not correct');
    }
    clearFailures(user.email);
  }

  function guard(req, res, next) {
    if (!req.auth) return next();
    const hit = SENSITIVE.find(([m, re, , when]) => req.method === m && re.test(req.path) && (!when || when(req)));
    if (hit) {
      const s = req.auth.session; const uid = req.auth.user.id; const now = Date.now();
      const hasMfa = mfaEnabled(uid);
      const totpOnly = (hit[2] === 'withdrawal' || hit[2] === 'payout_destination') && hasMfa && !!secRow(uid).withdrawal_mfa;
      const fresh = totpOnly ? now - s.totp_at <= opt.stepUpMs : now - s.auth_at <= opt.stepUpMs;
      if (!fresh) return next(new StepUpError(totpOnly ? ['totp'] : stepUpMethods(uid), hit[2]));
      // Withdrawal two-factor is per withdrawal: a successful one consumes the code verification.
      if (totpOnly) res.on('finish', () => { if (res.statusCode < 400) db.prepare('UPDATE sessions SET totp_at=0 WHERE sid=?').run(s.sid); });
    }
    // Privilege change: the target's sessions are revoked (own change: this session is rotated, others revoked).
    if (req.method === 'PUT' && /^\/admin\/roles\/[^/]+$/.test(req.path)) {
      const json = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode < 400 && body && body.user_id) {
          const target = getUser(body.user_id);
          if (target && target.id === req.auth.user.id) { rotate(req, res, req.auth.session, target); revokeAll(target.id, { keepSid: req.auth.session.sid }); }
          else if (target) { const n = revokeAll(target.id); if (n.length) logEvent(target.id, 'sessions_revoked', req, { reason: 'privilege_change', count: n.length, by: req.auth.user.email }); }
        }
        return json(body);
      };
    }
    next();
  }

  // ------------------------------------------------------------------ routes
  function mountRoutes({ v1, requireUser, notify: n, rolesOf: ro, publicUser: pu }) {
    if (n) notify = n;
    if (ro) rolesOf = ro;
    if (pu) publicUser = pu;
    const userBody = (u) => ({ ...publicUser(u), admin_roles: rolesOf(u) });
    const can = (perm) => (req, res, next) => {
      if (!req.auth) return next(E.unauthorized());
      const roles = rolesOf(req.auth.user);
      if (!roles.length) return next(new ApiError(403, 'forbidden', 'forbidden', 'admin access required'));
      if (!roles.some((r) => (ROLE_PERMS[r] || []).includes(perm))) return next(new ApiError(403, 'forbidden', 'forbidden', `your role does not include ${perm}`));
      next();
    };

    // Completes a successful sign-in: forced password change, or a new session.
    function finish(req, res, u, { method, totpVerified = false }) {
      clearFailures(u.email);
      if (secRow(u.id).must_change_password) {
        const t = issueToken('pw_change', u.id, opt.changeTokenMs, { totp: totpVerified });
        logEvent(u.id, 'password_change_required', req, { method });
        return res.json({ password_change_required: true, change_token: t });
      }
      const { sid } = createSession(req, res, u, { totpVerified });
      logEvent(u.id, 'login_ok', req, { method, session: sid });
      events.emit('login', { user: u, req, method, sid });
      return res.json({ user: userBody(u), csrf_token: res.getHeader('X-Csrf-Token') });
    }
    // Sign-in after a first factor verified elsewhere (passkey, OAuth, OAuth account linking): the TOTP step when two-factor
    // is on (unless the factor already satisfies it, e.g. a user-verified passkey), forced password change, else a session.
    beginLogin = (req, res, u, { method, mfaSatisfied = false }) => {
      if (isLocked(u.id)) throw lockedError();
      if (!mfaSatisfied && mfaEnabled(u.id)) {
        const t = token(24);
        db.prepare('DELETE FROM mfa_challenges WHERE user_id=? OR expires_at<?').run(u.id, nowIso());
        db.prepare('INSERT INTO mfa_challenges(token,user_id,expires_at) VALUES(?,?,?)').run(kc.sha256hex(t), u.id, new Date(Date.now() + opt.mfaChallengeMs).toISOString());
        return res.json({ mfa_required: true, mfa_token: t });
      }
      return finish(req, res, u, { method, totpVerified: mfaSatisfied });
    };

    v1.get('/auth/csrf', (req, res) => {
      // An unexpired login-CSRF cookie with at least 10 minutes left is kept (its token is returned again), so flows that
      // span a page load — the OAuth redirect, whose state is bound to this cookie (server/oauth.js) — stay bound.
      const c = parseCookies(req.headers.cookie);
      const cur = c['__Host-plx_pre'] || c.plx_pre;
      const curExp = cur && /^[A-Za-z0-9_-]{16,64}\.\d{13}$/.test(cur) ? Number(cur.split('.')[1]) : 0;
      const v = curExp - Date.now() > 10 * MIN && curExp - Date.now() <= opt.preCsrfMs ? cur : `${token(16)}.${Date.now() + opt.preCsrfMs}`;
      const left = Math.floor((Number(v.split('.')[1]) - Date.now()) / 1000);
      if (v !== cur) cookie(res, req, 'pre', v, { maxAgeSec: left });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ csrf_token: preToken(v), expires_in_sec: left });
    });

    v1.get('/session', (req, res) => {
      if (!req.auth) return res.json({ user: null });
      res.json({ user: publicUser(req.auth.user), csrf_token: req.auth.session.csrf_token, balance_dollars: (req.auth.user.balance_cents / 100).toFixed(4) });
    });

    v1.post('/users', async (req, res) => {
      const { email, password, display_name } = req.body || {};
      const em = normEmail(email);
      if (!EMAIL_RE.test(em) || em.length > 254) throw E.badRequest('a valid email is required');
      const name = String(display_name || '').trim();
      if (name.length < 2 || name.length > 40) throw E.badRequest('display name must be 2-40 characters');
      const bad = pw.checkPolicy(password, { email: em, name });
      if (bad) throw policyError(bad);
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(em)) throw E.conflict('email_taken', 'an account with this email already exists');
      const hash = await pw.hashPassword(password);
      const id = newId('u_');
      db.prepare('INSERT INTO users(id,email,display_name,password_hash,balance_cents,created_at) VALUES(?,?,?,?,0,?)').run(id, em, name, hash, nowIso());
      currency.applyAccountDefaults(db, id, nowIso()); // Admin › Currency & defaults: new-account settings (CLONE_SPEC.md §30)
      setSec(id, { password_changed_at: nowIso() });
      const u = getUser(id);
      const { sid } = createSession(req, res, u);
      logEvent(id, 'signup', req, { session: sid });
      events.emit('signup', { user: u, req, sid });
      res.status(201).json({ user: userBody(u), csrf_token: res.getHeader('X-Csrf-Token') });
    });

    // Uniform failures: unknown email and wrong password give the same status, body and (scrypt) work.
    v1.post('/log_in', async (req, res) => {
      const b = req.body || {};
      const email = normEmail(b.email);
      assertOpen([ipKey(ipOf(req))]); // per-IP backoff stays a hard limit; per account it is proof of work (RS2)
      powGate(req, email);
      const u = email ? db.prepare('SELECT * FROM users WHERE email=? AND is_system=0').get(email) : null;
      const ok = await pw.verifyOrDummy(String(b.password ?? ''), u ? u.password_hash : null);
      if (!ok) {
        recordFailure(req, email, u, 'password');
        logEvent(u?.id, 'login_fail', req, u ? { reason: 'password' } : { reason: 'password', email: maskEmail(email) });
        throw invalidCredentials();
      }
      if (isLocked(u.id)) throw lockedError();
      if (pw.needsRehash(u.password_hash)) {
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await pw.hashPassword(String(b.password)), u.id);
        logEvent(u.id, 'password_rehash', req, {});
      }
      if (mfaEnabled(u.id)) {
        const t = token(24);
        db.prepare('DELETE FROM mfa_challenges WHERE user_id=? OR expires_at<?').run(u.id, nowIso());
        db.prepare('INSERT INTO mfa_challenges(token,user_id,expires_at) VALUES(?,?,?)').run(kc.sha256hex(t), u.id, new Date(Date.now() + opt.mfaChallengeMs).toISOString());
        return res.json({ mfa_required: true, mfa_token: t });
      }
      return finish(req, res, u, { method: 'password' });
    });

    v1.post('/log_in_mfa', (req, res) => {
      const b = req.body || {};
      const ch = db.prepare('SELECT * FROM mfa_challenges WHERE token=?').get(kc.sha256hex(String(b.mfa_token || '')));
      if (!ch || Date.parse(ch.expires_at) < Date.now()) throw new ApiError(401, 'mfa_challenge_expired', 'your sign-in attempt expired, please log in again');
      const u = getUser(ch.user_id);
      if (!u || isLocked(u.id)) throw lockedError();
      if (ch.attempts >= 5) { db.prepare('DELETE FROM mfa_challenges WHERE token=?').run(ch.token); throw new ApiError(401, 'mfa_challenge_expired', 'too many attempts, please log in again'); }
      const m = mfaOf(u.id);
      if (!m || !m.enabled || !verifyTotpOnce(u.id, m.secret, b.code)) {
        db.prepare('UPDATE mfa_challenges SET attempts=attempts+1 WHERE token=?').run(ch.token);
        bump(acctKey(u.email), 'account', opt.accountThreshold);
        logEvent(u.id, 'mfa_fail', req, { at: 'login' });
        throw new ApiError(400, 'invalid_mfa_code', 'that code is not valid');
      }
      db.prepare('DELETE FROM mfa_challenges WHERE token=?').run(ch.token);
      return finish(req, res, u, { method: 'password+totp', totpVerified: true });
    });

    v1.post('/auth/complete_password_change', async (req, res) => {
      const b = req.body || {};
      const t = peekToken('pw_change', b.change_token);
      if (!t) throw new ApiError(401, 'change_token_expired', 'this password change link has expired, please log in again');
      const u = getUser(t.user_id);
      if (!u || isLocked(u.id)) throw lockedError();
      const bad = pw.checkPolicy(b.new_password, { email: u.email, name: u.display_name });
      if (bad) throw policyError(bad);
      if (await pw.verifyPassword(String(b.new_password), u.password_hash)) throw new ApiError(400, 'weak_password', 'password does not meet the requirements', 'choose a password different from your current one');
      const hash = await pw.hashPassword(b.new_password);
      if (!useToken(t)) throw new ApiError(401, 'change_token_expired', 'this password change link has already been used');
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, u.id);
      setSec(u.id, { must_change_password: 0, password_changed_at: nowIso() });
      revokeAll(u.id);
      logEvent(u.id, 'password_change', req, { forced: true });
      alertUser(u, 'Your password was changed', 'You set a new password after a reset requested by Parlance support.');
      const { sid } = createSession(req, res, u, { totpVerified: !!t.data.totp });
      logEvent(u.id, 'login_ok', req, { method: 'password_change', session: sid });
      res.json({ user: userBody(getUser(u.id)), csrf_token: res.getHeader('X-Csrf-Token') });
    });

    v1.post('/log_out', (req, res) => {
      if (req.auth) {
        db.prepare('DELETE FROM sessions WHERE sid=?').run(req.auth.session.sid);
        logEvent(req.auth.user.id, 'logout', req, { session: req.auth.session.sid });
      }
      clearSessionCookie(res, req);
      res.json({});
    });

    // ---- step-up
    v1.post('/step_up', requireUser, async (req, res) => {
      const b = req.body || {};
      const u = req.auth.user; const s = req.auth.session;
      assertOpen([acctKey(u.email), ipKey(ipOf(req))]);
      let method;
      if (b.code != null && b.code !== '') {
        const m = mfaOf(u.id);
        if (!m || !m.enabled) throw E.conflict('mfa_not_enabled', 'two-factor login is off; confirm with your password');
        if (!verifyTotpOnce(u.id, m.secret, b.code)) { recordFailure(req, u.email, u, 'step_up'); logEvent(u.id, 'step_up_fail', req, { method: 'totp' }); throw new ApiError(400, 'invalid_mfa_code', 'that code is not valid'); }
        method = 'totp';
      } else {
        if (!(await pw.verifyPassword(String(b.password ?? ''), u.password_hash))) { recordFailure(req, u.email, u, 'step_up'); logEvent(u.id, 'step_up_fail', req, { method: 'password' }); throw new ApiError(400, 'invalid_password', 'that password is not correct'); }
        method = 'password';
      }
      const now = Date.now();
      db.prepare(`UPDATE sessions SET auth_at=?${method === 'totp' ? ', totp_at=?' : ''} WHERE sid=?`).run(...(method === 'totp' ? [now, now, s.sid] : [now, s.sid]));
      clearFailures(u.email);
      logEvent(u.id, 'step_up', req, { method, session: s.sid });
      res.json({ ok: true, method, valid_until: new Date(now + opt.stepUpMs).toISOString() });
    });

    // ---- security overview, sessions, events
    v1.get('/users/:uid/security', requireUser, (req, res) => {
      const u = req.auth.user; const s = req.auth.session; const sec = secRow(u.id);
      res.json({
        mfa_enabled: mfaEnabled(u.id), withdrawal_mfa: !!sec.withdrawal_mfa, password_changed_time: sec.password_changed_at,
        step_up: { window_seconds: Math.round(opt.stepUpMs / 1000), fresh_until: s.auth_at ? new Date(s.auth_at + opt.stepUpMs).toISOString() : null },
        session: { idle_timeout_seconds: Math.round(s.idle_ms / 1000), absolute_expires_time: s.expires_at },
        password_policy: { min_length: pw.MIN_LEN, rules: ['at least 12 characters', 'at least two of: lowercase, uppercase, digits, symbols', 'must not contain your email or name', 'must not be a known breached password'] },
      });
    });
    const sessionVo = (s, current) => ({ id: s.sid, current: s.sid === current, device: s.device || 'Unknown device', ip_prefix: s.ip_prefix, created_time: s.created_at, last_seen_time: new Date(s.last_seen_ms).toISOString(),
      expires_time: new Date(Math.min(Date.parse(s.expires_at), s.last_seen_ms + s.idle_ms)).toISOString(), idle_timeout_seconds: Math.round(s.idle_ms / 1000) });
    v1.get('/users/:uid/sessions', requireUser, (req, res) => {
      const rows = db.prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY last_seen_ms DESC').all(req.auth.user.id).filter((s) => check(s, { touch: false }));
      res.json({ sessions: rows.map((s) => sessionVo(s, req.auth.session.sid)) });
    });
    v1.delete('/users/:uid/sessions/:sid', requireUser, (req, res) => {
      const s = db.prepare('SELECT * FROM sessions WHERE sid=? AND user_id=?').get(String(req.params.sid), req.auth.user.id);
      if (!s) throw E.notFound();
      db.prepare('DELETE FROM sessions WHERE sid=?').run(s.sid);
      events.emit('revoked', [s.sid]);
      const current = s.sid === req.auth.session.sid;
      if (current) clearSessionCookie(res, req);
      logEvent(req.auth.user.id, 'session_revoke', req, { session: s.sid, device: s.device, current });
      res.json({ revoked: [s.sid], signed_out: current });
    });
    v1.delete('/users/:uid/sessions', requireUser, (req, res) => {
      const sids = revokeAll(req.auth.user.id);
      clearSessionCookie(res, req);
      logEvent(req.auth.user.id, 'sessions_revoke_all', req, { count: sids.length });
      alertUser(req.auth.user, 'Signed out everywhere', `All ${sids.length} signed-in session(s) were signed out.`);
      res.json({ revoked: sids, signed_out: true });
    });
    const eventVo = (e) => ({ id: e.id, time: new Date(e.ts).toISOString(), type: e.type, ip_prefix: e.ip_prefix, device: e.device, detail: JSON.parse(e.detail || '{}') });
    v1.get('/users/:uid/security_events', requireUser, (req, res) => {
      res.json({ events: db.prepare('SELECT * FROM auth_events WHERE user_id=? ORDER BY ts DESC, rowid DESC LIMIT 100').all(req.auth.user.id).map(eventVo) });
    });

    // ---- password + email change (both behind step-up)
    v1.put('/users/:uid/password', requireUser, async (req, res) => {
      const b = req.body || {};
      const u = req.auth.user;
      assertOpen([acctKey(u.email), ipKey(ipOf(req))]);
      if (!(await pw.verifyPassword(String(b.current_password ?? ''), u.password_hash))) {
        recordFailure(req, u.email, u, 'password_change');
        logEvent(u.id, 'password_change_fail', req, {});
        throw new ApiError(400, 'invalid_password', 'your current password is not correct');
      }
      const bad = pw.checkPolicy(b.new_password, { email: u.email, name: u.display_name });
      if (bad) throw policyError(bad);
      if (String(b.new_password) === String(b.current_password)) throw new ApiError(400, 'weak_password', 'password does not meet the requirements', 'choose a password different from your current one');
      const hash = await pw.hashPassword(b.new_password);
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, u.id);
      setSec(u.id, { must_change_password: 0, password_changed_at: nowIso() });
      const revoked = revokeAll(u.id, { keepSid: req.auth.session.sid });
      const csrf = rotate(req, res, req.auth.session, u, { authAt: Date.now() });
      clearFailures(u.email);
      logEvent(u.id, 'password_change', req, { other_sessions_signed_out: revoked.length });
      alertUser(u, 'Your password was changed', `Your password was changed${revoked.length ? ` and ${revoked.length} other session(s) were signed out` : ''}.`);
      res.json({ ok: true, csrf_token: csrf, other_sessions_signed_out: revoked.length });
    });
    v1.put('/users/:uid/email', requireUser, (req, res) => {
      const u = req.auth.user;
      const em = normEmail(req.body && req.body.email);
      if (!EMAIL_RE.test(em) || em.length > 254) throw E.badRequest('a valid email is required');
      if (em === u.email) throw E.badRequest('that is already your email address');
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(em)) throw E.conflict('email_taken', 'an account with this email already exists');
      db.prepare('UPDATE users SET email=? WHERE id=?').run(em, u.id);
      clearFailures(u.email);
      logEvent(u.id, 'email_change', req, { from: maskEmail(u.email), to: maskEmail(em) });
      { // Template email.email_changed (CLONE_SPEC.md §32.5), to the old address.
        const m = hooks.template ? hooks.template('email.email_changed', { masked_email: maskEmail(em) }) : null;
        if (m) sendEmail(u, m.subject, m.text, u.email, m.html);
        else sendEmail(u, 'Parlance security alert: your email address was changed', `The email on your Parlance account was changed to ${maskEmail(em)}. If this wasn't you, contact support.`, u.email);
      }
      alertUser({ ...u, email: em }, 'Email address changed', `Your account email is now ${em}.`);
      events.emit('email_change', { user: getUser(u.id), req });
      res.json({ user: userBody(getUser(u.id)) });
    });
    v1.put('/users/:uid/withdrawal_mfa', requireUser, (req, res) => {
      const u = req.auth.user;
      const on = !!(req.body && req.body.enabled);
      if (on && !mfaEnabled(u.id)) throw E.conflict('mfa_not_enabled', 'turn on two-factor login first');
      setSec(u.id, { withdrawal_mfa: on ? 1 : 0 });
      logEvent(u.id, on ? 'withdrawal_mfa_on' : 'withdrawal_mfa_off', req, {});
      if (!on) alertUser(u, 'Withdrawal two-factor turned off', 'Withdrawals no longer ask for a two-factor code.');
      res.json({ withdrawal_mfa: on });
    });

    // ---- two-factor login (TOTP); secrets encrypted at rest
    v1.get('/users/:uid/mfa', requireUser, (req, res) => res.json({ enabled: mfaEnabled(req.auth.user.id) }));
    v1.post('/users/:uid/mfa/setup', requireUser, (req, res) => {
      const uid = req.auth.user.id;
      if (mfaEnabled(uid)) throw E.conflict('mfa_already_enabled', 'two-factor login is already on');
      const secret = b32encode(crypto.randomBytes(20));
      db.prepare('INSERT INTO mfa(user_id,secret,enabled,created_at) VALUES(?,?,0,?) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret, enabled=0, created_at=excluded.created_at')
        .run(uid, kc.encrypt(secret, `mfa.secret:${uid}`, keys.enc), nowIso());
      res.setHeader('Cache-Control', 'no-store');
      res.json({ secret, otpauth_url: `otpauth://totp/Parlance:${encodeURIComponent(req.auth.user.email)}?secret=${secret}&issuer=Parlance&digits=6&period=30` });
    });
    v1.post('/users/:uid/mfa/enable', requireUser, (req, res) => {
      const u = req.auth.user;
      const m = mfaOf(u.id);
      if (!m) throw E.conflict('mfa_not_set_up', 'start two-factor setup first');
      if (!verifyTotpOnce(u.id, m.secret, req.body && req.body.code)) { logEvent(u.id, 'mfa_fail', req, { at: 'enable' }); throw new ApiError(400, 'invalid_mfa_code', 'that code is not valid'); }
      db.prepare('UPDATE mfa SET enabled=1 WHERE user_id=?').run(u.id);
      const now = Date.now();
      const csrf = rotate(req, res, req.auth.session, u, { authAt: now, totpAt: now }); // privilege of the session changed: new token
      logEvent(u.id, 'mfa_on', req, {});
      notify(u.id, { type: 'security', title: 'Two-factor login turned on', link: '/account/security' });
      res.json({ enabled: true, csrf_token: csrf });
    });
    v1.post('/users/:uid/mfa/disable', requireUser, (req, res) => {
      const u = req.auth.user;
      const m = mfaOf(u.id);
      if (!m || !m.enabled) throw E.conflict('mfa_not_enabled', 'two-factor login is off');
      if (!verifyTotpOnce(u.id, m.secret, req.body && req.body.code)) { logEvent(u.id, 'mfa_fail', req, { at: 'disable' }); throw new ApiError(400, 'invalid_mfa_code', 'that code is not valid'); }
      db.prepare('DELETE FROM mfa WHERE user_id=?').run(u.id);
      setSec(u.id, { withdrawal_mfa: 0 });
      logEvent(u.id, 'mfa_off', req, {});
      alertUser(u, 'Two-factor login turned off', 'Two-factor login was turned off for your account.');
      res.json({ enabled: false });
    });

    // ---- admin: identity tools
    const findUser = (idOrEmail) => db.prepare('SELECT * FROM users WHERE id=? OR email=?').get(String(idOrEmail), normEmail(idOrEmail));
    v1.get('/admin/identity/events', can('audit.read'), (req, res) => {
      const where = []; const args = [];
      const qv = (k) => String(req.query[k] || '').trim();
      if (qv('type')) { where.push('e.type LIKE ?'); args.push(`${qv('type')}%`); }
      if (qv('user')) { where.push('(lower(u.email) LIKE ? OR e.user_id=?)'); args.push(`%${qv('user').toLowerCase()}%`, qv('user')); }
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 300));
      const rows = db.prepare(`SELECT e.*, u.email FROM auth_events e LEFT JOIN users u ON u.id=e.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.ts DESC, e.rowid DESC LIMIT ?`).all(...args, limit);
      res.json({ events: rows.map((e) => ({ ...eventVo(e), user_id: e.user_id, email: e.email || null })) });
    });
    v1.get('/admin/identity/outbox', can('users.support'), (req, res) => {
      res.json({ messages: db.prepare('SELECT * FROM email_outbox ORDER BY created_at DESC, rowid DESC LIMIT 100').all().map((m) => ({ id: m.id, to: m.to_email, subject: m.subject, body: m.body, time: m.created_at })) });
    });
    v1.get('/admin/audit/verify', can('audit.read'), (req, res) => {
      const r = auditChain.verify(db);
      res.json({ ...r, verified_time: nowIso() });
    });
    v1.post('/admin/users/:id/force_password_reset', can('users.support'), (req, res) => {
      const u = findUser(req.params.id);
      if (!u) throw E.notFound();
      if (u.is_system) throw E.conflict('system_account', 'system accounts cannot be changed here');
      if (u.id === req.auth.user.id) throw E.conflict('cannot_reset_self', 'change your own password in Account › Security');
      const reason = String((req.body && req.body.reason) || '').trim();
      if (reason.length < 3 || reason.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required');
      setSec(u.id, { must_change_password: 1 });
      const sids = revokeAll(u.id);
      db.prepare('DELETE FROM mfa_challenges WHERE user_id=?').run(u.id);
      audit(req.auth.user, 'users.force_password_reset', 'user', u.id, { must_change_password: false }, { must_change_password: true, sessions_signed_out: sids.length }, reason);
      logEvent(u.id, 'password_reset_forced', req, { by: req.auth.user.email, sessions_signed_out: sids.length });
      alertUser(u, 'Password reset required', 'Parlance support requires you to choose a new password the next time you log in. All your sessions were signed out.');
      res.json({ user_id: u.id, must_change_password: true, sessions_signed_out: sids.length });
    });

    // ---- first-admin setup (one-time URL)
    v1.get('/auth/setup', (req, res) => {
      const t = peekToken('admin_setup', req.query.token);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ valid: !!t && !usableAdminExists(), expires_time: t ? new Date(t.expires_at).toISOString() : null });
    });
    v1.post('/auth/setup_admin', async (req, res) => {
      const b = req.body || {};
      const t = peekToken('admin_setup', b.token);
      if (!t || usableAdminExists()) throw new ApiError(410, 'setup_token_invalid', 'this setup link is invalid, expired or already used');
      const em = normEmail(b.email);
      if (!EMAIL_RE.test(em)) throw E.badRequest('a valid email is required');
      const name = String(b.display_name || '').trim() || 'Exchange Admin';
      if (name.length < 2 || name.length > 40) throw E.badRequest('display name must be 2-40 characters');
      const bad = pw.checkPolicy(b.password, { email: em, name });
      if (bad) throw policyError(bad);
      const hash = await pw.hashPassword(b.password);
      if (!useToken(t)) throw new ApiError(410, 'setup_token_invalid', 'this setup link is invalid, expired or already used');
      const u = upsertAdmin(em, name, hash);
      logEvent(u.id, 'admin_bootstrap', req, { via: 'setup_url' });
      audit(u, 'admin.bootstrap', 'user', u.id, null, { email: u.email, via: 'setup_url' });
      const { sid } = createSession(req, res, u);
      logEvent(u.id, 'login_ok', req, { method: 'admin_setup', session: sid });
      res.status(201).json({ user: userBody(u), csrf_token: res.getHeader('X-Csrf-Token') });
    });
  }

  // ------------------------------------------------------------------ first admin
  function usableAdminExists() {
    const rows = db.prepare(`SELECT password_hash FROM users u WHERE u.is_system=0 AND (u.is_admin=1 ${hasTable('admin_roles') ? "OR EXISTS (SELECT 1 FROM admin_roles r WHERE r.user_id=u.id AND r.role='admin')" : ''})`).all();
    return rows.some((r) => pw.isUsable(r.password_hash));
  }
  function upsertAdmin(email, name, hash) {
    const ex = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    let id;
    if (ex) { id = ex.id; db.prepare('UPDATE users SET password_hash=?, is_admin=1 WHERE id=?').run(hash, id); }
    else { id = newId('u_'); db.prepare('INSERT INTO users(id,email,display_name,password_hash,is_admin,balance_cents,created_at) VALUES(?,?,?,?,1,0,?)').run(id, email, name, hash, nowIso()); }
    if (hasTable('admin_roles')) db.prepare("INSERT INTO admin_roles(user_id,role,granted_by,granted_at) VALUES(?,'admin',NULL,?) ON CONFLICT DO NOTHING").run(id, nowIso());
    setSec(id, { password_changed_at: nowIso(), must_change_password: 0 });
    return getUser(id);
  }
  // Runs at start-up. `admin` = {email, password, display_name?} from start() or ADMIN_EMAIL/ADMIN_PASSWORD.
  // Returns {setupPath} when no admin can sign in yet, plus any notices for the console.
  function bootstrap({ admin = null, demoPassword = null } = {}) {
    const notices = [];
    // 1. Default passwords from earlier builds stop working.
    const { verifyPassword: legacyVerify } = require('./util');
    for (const [email, old] of LEGACY_DEFAULTS) {
      const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      if (!u || !String(u.password_hash).startsWith('scrypt$') || !legacyVerify(old, u.password_hash)) continue;
      if (email.startsWith('admin@')) {
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(pw.UNUSABLE('default-password-removed'), u.id);
        logEvent(u.id, 'default_password_removed', null, {});
        notices.push(`The default admin password for ${email} was removed. Sign in after setting ADMIN_PASSWORD, running npm run create-admin, or using the setup link.`);
      } else {
        const p = demoPassword || pw.generatedPassword();
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(pw.hashPasswordSync(p), u.id);
        logEvent(u.id, 'default_password_removed', null, {});
        if (!demoPassword) notices.push(`Demo account ${email}: its default password was replaced by ${p} (shown once).`);
      }
    }
    // 2. Admin from the environment / start option, only while no admin can sign in or for that email's first setup.
    if (admin && admin.email && admin.password) {
      const em = normEmail(admin.email);
      if (!EMAIL_RE.test(em)) throw new Error('ADMIN_EMAIL is not a valid email address');
      const ex = db.prepare('SELECT * FROM users WHERE email=?').get(em);
      const needs = !ex || !pw.isUsable(ex.password_hash) || !usableAdminExists();
      if (needs) {
        const name = admin.display_name || ex?.display_name || 'Exchange Admin';
        const bad = pw.checkPolicy(admin.password, { email: em, name });
        if (bad) throw new Error(`ADMIN_PASSWORD does not meet the password policy: ${bad.message}`);
        const keepHash = ex && pw.isUsable(ex.password_hash) ? ex.password_hash : null;
        const u = upsertAdmin(em, name, keepHash || pw.hashPasswordSync(admin.password));
        logEvent(u.id, 'admin_bootstrap', null, { via: 'environment' });
        audit(null, 'admin.bootstrap', 'user', u.id, null, { email: u.email, via: 'environment' }, 'first admin from ADMIN_EMAIL/ADMIN_PASSWORD');
      }
    }
    // 3. Still nobody: a single-use setup link (previous unused links are invalidated).
    let setupPath = null;
    if (!usableAdminExists()) {
      db.prepare("UPDATE auth_tokens SET used_at=? WHERE purpose='admin_setup' AND used_at IS NULL").run(Date.now());
      setupPath = `/setup?token=${issueToken('admin_setup', null, opt.setupTokenMs)}`;
    }
    db.prepare('DELETE FROM auth_tokens WHERE expires_at<?').run(Date.now() - DAY);
    return { setupPath, notices };
  }

  return {
    attach, guard, mountRoutes, bootstrap, events, fromCookieHeader, sessionAlive, revokeAll, logEvent, usableAdminExists,
    initAuditChain: () => auditChain.init(db, { keyDir }), options: opt,
    // Identity-module hooks (Phase 3, CLONE_SPEC §25): mailer, step-up methods, pre-session paths, shared checks.
    hooks, assertFresh, markStepUp, checkPassword, clearSessionCookie, alertUser, isLocked, mfaEnabled,
    beginLogin: (...a) => beginLogin(...a),
  };
}

module.exports = { createAuth, parseCookies, deviceOf, ipPrefix, StepUpError };
