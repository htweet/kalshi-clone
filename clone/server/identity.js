'use strict';
// Accounts, identity and compliance (PLAN Phase 3; CLONE_SPEC §13.14 observed flow, §4.7 call sites; spec §25).
//
// mountIdentity() is called once by createApp() right after the idempotency middleware. It owns:
//   • the personal-data vault (P3.1a): per-user data key (AES-256-GCM, wrapped by an HKDF sub-key of the master key),
//     field-level encryption of legal name, date of birth, address, phone and national ID, a keyed hash of the national
//     ID for duplicate detection, masking, crypto-shredding on account closure, the retention job;
//   • onboarding (P3.1): phone code → legal name → birthday (18+) → address + country-specific national ID → submit,
//     persisted per step with "Not now" / resume (`/resume_sign_up`), and the compliance gate on trading, deposits and
//     withdrawals (`identity_verification_required`);
//   • phone verification (P3.2): E.164, 4-digit codes stored as HMACs, expiry, attempts, resend cooldown, per-number /
//     per-IP / per-account / per-country send limits;
//   • email verification and password reset (signed single-use tokens) through server/messaging.js;
//   • data export and account closure (P3.8); admin identity views with masked values and audited unmasking;
// and wires the sibling modules: server/kyc.js (P3.5), server/compliance.js (P3.6 geo, P3.7 fraud), server/oauth.js
// (P3.3), server/webauthn.js (P3.4).
// Personal data is never logged, never written to audit or security-event payloads, never echoed in error messages,
// and the national ID is never returned in full by any endpoint.
const crypto = require('node:crypto');
const { tx } = require('./db');
const { nowIso, newId, token, ApiError, E, dollars } = require('./util');
const kc = require('./crypto');
const pw = require('./passwords');
const auditChain = require('./audit-chain');
const { check, ValidationError } = require('./validate');
const C = require('./countries');
const { createMessaging } = require('./messaging');
const { createKyc } = require('./kyc');
const { createCompliance } = require('./compliance');
const { mountOAuth } = require('./oauth');
const { mountWebAuthn } = require('./webauthn');
const { createDocv } = require('./docv');

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS identity_profiles (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'not_started',  -- not_started|in_progress|pending|documents_required|review|approved|rejected|retry|closed
  skipped_at TEXT, resumed_at TEXT,
  email_verified_at TEXT,
  phone_enc TEXT, phone_hash TEXT, phone_last4 TEXT, phone_country TEXT, phone_verified_at TEXT,
  name_enc TEXT, dob_enc TEXT, age_verified INTEGER NOT NULL DEFAULT 0,
  address_enc TEXT, country TEXT,
  national_id_enc TEXT, national_id_hash TEXT, national_id_last TEXT, national_id_type TEXT,
  kyc_reason TEXT, kyc_reference TEXT, kyc_attempts INTEGER NOT NULL DEFAULT 0, submitted_at TEXT, decided_at TEXT, decided_by TEXT,
  closed_at TEXT, shredded_at TEXT, retain_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_nid ON identity_profiles(national_id_hash);
CREATE INDEX IF NOT EXISTS idx_identity_phone ON identity_profiles(phone_hash);
CREATE INDEX IF NOT EXISTS idx_identity_status ON identity_profiles(status);
CREATE TABLE IF NOT EXISTS identity_keys (user_id TEXT PRIMARY KEY, wrapped_key TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS phone_challenges (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, number_hash TEXT NOT NULL, number_enc TEXT NOT NULL, masked TEXT NOT NULL,
  country TEXT NOT NULL, code_hash TEXT NOT NULL, created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  verified_ts INTEGER, superseded INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_phone_ch_user ON phone_challenges(user_id, created_ts);
CREATE TABLE IF NOT EXISTS sms_send_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, number_hash TEXT NOT NULL, ip_hash TEXT NOT NULL, country TEXT NOT NULL, outcome TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sms_log_ts ON sms_send_log(ts);
CREATE TABLE IF NOT EXISTS identity_tokens (hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id TEXT, created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL, used_ts INTEGER);
CREATE TABLE IF NOT EXISTS identity_request_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, key_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_identity_req_log ON identity_request_log(kind, key_hash, ts);
`;

// Reason categories shown to the user on the outcome screens (no detail about which datum failed).
const REASONS = {
  identity_mismatch: 'The details you entered didn’t match official records.',
  data_mismatch: 'We couldn’t match some of your details. Check them for typos and try again.',
  provider_unavailable: 'Our verification partner couldn’t be reached. Please try again.',
  duplicate_account: 'This identity is already linked to another Parlance account. Contact support if you need help getting back in.',
  age_requirement: 'You must be 18 or over to use Parlance.',
  unsupported_region: 'Parlance isn’t available where you live yet.',
  fraud_suspected: 'We couldn’t verify this account. Contact support for help.',
  manual_review: 'Our team is reviewing your details. This usually takes 1–2 business days.',
  documents_unreadable: 'We couldn’t read your ID photos. Take new photos in good light and try again.',
  other: 'We couldn’t verify your identity. Contact support for help.',
};
const DEFAULT_SETTINGS = {
  enforce: null, // null = the start option / KYC_REQUIRED default
  blocked_countries: ['CU', 'IR', 'KP', 'SY'],
  unknown_ip: 'allow', // loopback / private / unmapped addresses (ZZ)
  ip_overrides: [], // [{cidr, country}] simulated IP-country entries
  fraud: { hold_withdrawals: null, hold_threshold: 60 },
  admin_passkey_required: false,
  sms: { per_number_hour: 5, per_ip_hour: 10, per_account_day: 10, per_country_hour: 200, country_limits: {}, blocked_countries: [] },
  retention: { kyc_days: 1825, outbox_days: 30, geo_days: 30, device_days: 180, documents_days: 30 },
};
const DEFAULTS = {
  phoneCodeTtlMs: 10 * MIN, phoneMaxAttempts: 5, phoneCooldownSec: 30,
  emailTokenTtlMs: DAY, resetTokenTtlMs: 30 * MIN, resetPerEmailHour: 3, resetPerIpHour: 20, verifyResendSec: 60,
  maxKycAttempts: 3, retentionIntervalMs: 6 * HOUR,
};

const mask = {
  name: (n) => (n ? `${(n.first || '?')[0]}*** ${(n.last || '?')[0]}***` : null),
  dob: (d) => (d ? '••/••/••••' : null),
  address: (a) => (a ? `•••• ${a.region ? `${a.region}, ` : ''}${a.country} · ${String(a.postal_code || '').slice(0, 2)}•••` : null),
  nationalId: (last, type) => (last ? `${type === 'ssn' ? '•••-••-' : '•••• '}${last}` : null),
};
const lastOf = (n) => n.slice(n.length >= 9 ? -4 : -2);

function mountIdentity({ v1, app, db, engine, auth, admin, security, notify, keyDir, options = {} }) {
  db.exec(SCHEMA);
  if (!new Set(db.prepare('PRAGMA table_info(identity_profiles)').all().map((c) => c.name)).has('kyc_stage')) db.exec("ALTER TABLE identity_profiles ADD COLUMN kyc_stage TEXT NOT NULL DEFAULT 'data'");
  const production = process.env.NODE_ENV === 'production';
  const opt = { ...DEFAULTS, ...(options.timings || {}) };
  const phoneOpt = { ...(options.phone || {}) };
  if (phoneOpt.cooldownSec != null) opt.phoneCooldownSec = phoneOpt.cooldownSec;
  const sandbox = options.sandbox ?? !production; // sandbox KYC adapter + sandbox test-number rules
  const kycDefault = options.kycRequired ?? (process.env.KYC_REQUIRED != null ? process.env.KYC_REQUIRED === '1' : production);
  const keys = {
    kek: kc.deriveKey('identity-kek:v1', { dir: keyDir }), // wraps the per-user data keys
    nid: kc.deriveKey('national-id-hash:v1', { dir: keyDir }),
    phone: kc.deriveKey('phone-hash:v1', { dir: keyDir }),
    code: kc.deriveKey('phone-code:v1', { dir: keyDir }),
    tok: kc.deriveKey('identity-token:v1', { dir: keyDir }),
    ip: kc.deriveKey('identity-ip:v1', { dir: keyDir }),
  };
  const messaging = createMessaging({ db, keyDir, options: options.messaging || {} });
  auth.hooks.mailer = (m) => { messaging.sendEmail(m); };
  const timers = [];

  // ------------------------------------------------------------------ settings (admin_settings 'compliance')
  // Defaults: DEFAULT_SETTINGS, then the `identity.settings` start option, then what an admin saved (persisted, wins).
  const base = options.settings || {};
  const D = { ...DEFAULT_SETTINGS, ...base, fraud: { ...DEFAULT_SETTINGS.fraud, ...(base.fraud || {}) }, sms: { ...DEFAULT_SETTINGS.sms, ...(base.sms || {}) }, retention: { ...DEFAULT_SETTINGS.retention, ...(base.retention || {}) } };
  function settings() {
    const r = db.prepare("SELECT value FROM admin_settings WHERE key='compliance'").get();
    const v = r ? JSON.parse(r.value) : {};
    return { ...D, ...v, fraud: { ...D.fraud, ...(v.fraud || {}) }, sms: { ...D.sms, ...(v.sms || {}) }, retention: { ...D.retention, ...(v.retention || {}) } };
  }
  function saveSettings(value, by) {
    db.prepare("INSERT INTO admin_settings(key,value,updated_at,updated_by) VALUES('compliance',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by")
      .run(JSON.stringify(value), nowIso(), by || null);
  }
  const enforced = () => { const s = settings(); return s.enforce == null ? !!kycDefault : !!s.enforce; };

  // ------------------------------------------------------------------ vault (P3.1a)
  function dataKey(uid, create = false) {
    const r = db.prepare('SELECT wrapped_key FROM identity_keys WHERE user_id=?').get(uid);
    if (r) return Buffer.from(kc.decrypt(r.wrapped_key, `identity.dek:${uid}`, keys.kek), 'hex');
    if (!create) return null;
    const k = crypto.randomBytes(32);
    db.prepare('INSERT INTO identity_keys(user_id,wrapped_key,created_at) VALUES(?,?,?)').run(uid, kc.encrypt(k.toString('hex'), `identity.dek:${uid}`, keys.kek), nowIso());
    return k;
  }
  const seal = (uid, field, value) => kc.encrypt(JSON.stringify(value), `identity.${field}:${uid}`, dataKey(uid, true));
  function open(uid, field, enc) {
    if (!enc) return null;
    const k = dataKey(uid);
    if (!k) return null; // shredded
    try { return JSON.parse(kc.decrypt(enc, `identity.${field}:${uid}`, k)); } catch { return null; }
  }
  const nidHash = (country, n) => kc.hmacHex(keys.nid, `${country}:${n}`);
  const phoneHash = (e164) => kc.hmacHex(keys.phone, e164);
  const ipHash = (req) => kc.hmacHex(keys.ip, security.clientIp(req)).slice(0, 32);

  const profile = (uid) => db.prepare('SELECT * FROM identity_profiles WHERE user_id=?').get(uid);
  function ensureProfile(uid) {
    db.prepare('INSERT INTO identity_profiles(user_id,status,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO NOTHING').run(uid, 'not_started', nowIso(), nowIso());
    return profile(uid);
  }
  function setProfile(uid, fields) {
    ensureProfile(uid);
    const ks = Object.keys(fields);
    db.prepare(`UPDATE identity_profiles SET ${ks.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE user_id=?`).run(...ks.map((k) => fields[k]), nowIso(), uid);
  }
  const statusOf = (uid) => profile(uid)?.status || 'not_started';

  // ------------------------------------------------------------------ helpers
  const logEvent = (uid, type, req, detail = {}) => auth.logEvent(uid, type, req, detail);
  // `selfService`: the account holder acting on their own account (closure) — no email in the audit row (PII-free).
  function audit(req, action, targetId, before, after, reason = '', { selfService = false } = {}) {
    auditChain.append(db, { actor_id: req?.auth?.user.id || null, actor_email: selfService ? null : req?.auth?.user.email || null, action, target_type: 'user', target_id: targetId, before, after, reason });
  }
  const requireUser = (req, res, next) => {
    if (!req.auth) return next(E.unauthorized());
    if (req.params.uid && req.params.uid !== req.auth.user.id) return next(E.forbidden('cannot access another user'));
    next();
  };
  const can = admin.can;
  const origin = (req) => (options.publicOrigin || process.env.PUBLIC_ORIGIN || security.selfOrigin(req) || 'http://localhost').replace(/\/+$/, '');
  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const findUser = (idOrEmail) => db.prepare('SELECT * FROM users WHERE id=? OR email=?').get(String(idOrEmail), String(idOrEmail).trim().toLowerCase());
  const fieldError = (fields) => new ValidationError(fields);
  // Counts requests of a kind for a hashed key within a window (password reset, verification resends).
  function countRecent(kind, keyHash, windowMs) { return db.prepare('SELECT COUNT(*) c FROM identity_request_log WHERE kind=? AND key_hash=? AND ts>?').get(kind, keyHash, Date.now() - windowMs).c; }
  const logRequest = (kind, keyHash) => db.prepare('INSERT INTO identity_request_log(ts,kind,key_hash) VALUES(?,?,?)').run(Date.now(), kind, keyHash);

  // Signed single-use tokens (email verification, password reset): base64url(JSON payload) + "." + HMAC; the SHA-256 of
  // the whole token is the database key, used_ts makes it single use. The signature lets a forged token be refused before
  // any lookup; the payload carries a fingerprint of the state it was issued for (email, password hash), so a token is
  // also dead once that state changes.
  function signToken(purpose, uid, ttlMs, data = {}) {
    const payload = Buffer.from(JSON.stringify({ p: purpose, u: uid, e: Date.now() + ttlMs, n: token(9), ...data })).toString('base64url');
    const t = `${payload}.${kc.hmacHex(keys.tok, payload).slice(0, 43)}`;
    db.prepare('INSERT INTO identity_tokens(hash,purpose,user_id,created_ts,expires_ts) VALUES(?,?,?,?,?)').run(kc.sha256hex(t), purpose, uid, Date.now(), Date.now() + ttlMs);
    return t;
  }
  function openToken(purpose, t, { allowUsed = false } = {}) {
    const s = String(t || '');
    if (s.length > 600) return null;
    const [payload, mac] = s.split('.');
    if (!payload || !mac || !kc.safeEqual(mac, kc.hmacHex(keys.tok, payload).slice(0, 43))) return null;
    let o; try { o = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
    if (!o || o.p !== purpose || !(o.e > Date.now())) return null;
    const row = db.prepare('SELECT * FROM identity_tokens WHERE hash=? AND purpose=?').get(kc.sha256hex(s), purpose);
    if (!row || (row.used_ts && !allowUsed)) return null;
    return { ...o, hash: row.hash, used: !!row.used_ts };
  }
  const useToken = (o) => db.prepare('UPDATE identity_tokens SET used_ts=? WHERE hash=? AND used_ts IS NULL').run(Date.now(), o.hash).changes === 1;
  const pwFingerprint = (hash) => kc.sha256hex(`pw:${hash}`).slice(0, 16);
  const emailFingerprint = (email) => kc.sha256hex(`em:${email}`).slice(0, 16);

  // ------------------------------------------------------------------ state for the client
  function stepsOf(p) {
    return { phone: !!p?.phone_verified_at, name: !!p?.name_enc, birthday: !!p?.dob_enc && !!p?.age_verified, address: !!p?.address_enc && !!p?.national_id_enc };
  }
  function nextStep(p) {
    if (!p) return 'phone';
    if (p.status === 'documents_required') return 'documents';
    if (['pending', 'review', 'approved', 'rejected', 'closed'].includes(p.status)) return p.status === 'pending' ? 'verifying' : 'outcome';
    const s = stepsOf(p);
    if (!s.phone) return 'phone';
    if (p.status === 'retry') return 'name';
    if (!s.name) return 'name';
    if (!s.birthday) return 'birthday';
    if (!s.address) return 'address';
    return 'submit';
  }
  function activeChallenge(uid) {
    return db.prepare('SELECT * FROM phone_challenges WHERE user_id=? AND superseded=0 AND verified_ts IS NULL AND expires_ts>? ORDER BY created_ts DESC LIMIT 1').get(uid, Date.now());
  }
  function lastSendTs(uid) { return db.prepare("SELECT MAX(ts) t FROM sms_send_log WHERE user_id=? AND outcome='sent'").get(uid).t || 0; }
  function stateFor(uid, { details = false } = {}) {
    const p = profile(uid);
    const st = p?.status || 'not_started';
    const ch = activeChallenge(uid);
    const reason = p?.kyc_reason || null;
    const out = {
      kyc_required: enforced(), status: st, stage: p?.kyc_stage || null, next_step: nextStep(p), skipped: !!(p && p.skipped_at && !['pending', 'review', 'approved', 'rejected', 'closed'].includes(st)),
      steps: stepsOf(p),
      phone: p?.phone_verified_at ? { masked: C.maskPhone(open(uid, 'phone', p.phone_enc)?.e164 || '', null), country: p.phone_country, verified_time: p.phone_verified_at } : null,
      pending_phone: ch ? { masked: ch.masked, country: ch.country, expires_time: new Date(ch.expires_ts).toISOString(), attempts_left: Math.max(0, opt.phoneMaxAttempts - ch.attempts),
        resend_available_time: new Date(lastSendTs(uid) + opt.phoneCooldownSec * 1000).toISOString() } : null,
      country: p?.country || null,
      national_id: p?.national_id_last ? { type: p.national_id_type, masked: mask.nationalId(p.national_id_last, p.national_id_type) } : null,
      verification: { status: st, reason_category: reason, reason_message: reason ? REASONS[reason] || REASONS.other : null, submitted_time: p?.submitted_at || null, decided_time: p?.decided_at || null,
        attempts: p?.kyc_attempts || 0, attempts_left: Math.max(0, opt.maxKycAttempts - (p?.kyc_attempts || 0)) },
      can_trade: !enforced() || st === 'approved', can_deposit: !enforced() || st === 'approved',
      email_verified: !!p?.email_verified_at,
      documents: st === 'documents_required' && ctx.docv ? ctx.docv.stateFor(uid).documents : null,
    };
    if (details && p) {
      // The owner's own details, to prefill the form when going back or retrying. The national ID is never returned.
      const n = open(uid, 'name', p.name_enc); const d = open(uid, 'dob', p.dob_enc); const a = open(uid, 'address', p.address_enc);
      out.details = { first_name: n?.first || '', last_name: n?.last || '', dob: d || null, address: a ? { country: a.country, line1: a.line1, line2: a.line2, city: a.city, region: a.region, postal_code: a.postal_code } : null };
    }
    return out;
  }

  // ------------------------------------------------------------------ sibling modules
  const ctx = {
    db, engine, auth, admin, security, notify: (...a) => notify(...a), messaging, settings, saveSettings, enforced, profile, ensureProfile, setProfile, statusOf, open, seal,
    nidHash, phoneHash, logEvent, audit, requireUser, can, origin, getUser, sandbox, production, REASONS, stateFor, options, keyDir, opt, mask,
    vault: { dataKey },
  };
  const compliance = createCompliance(ctx);
  ctx.compliance = compliance;
  const kyc = createKyc(ctx);
  ctx.kyc = kyc;
  const docv = createDocv(ctx);
  ctx.docv = docv;
  kyc.attachDocv(docv);

  // ------------------------------------------------------------------ compliance gate (trading, deposits, withdrawals)
  // Re-checked on every such request: location (P3.6), identity verification when enforced (P3.1/P3.5), then fraud
  // scoring with withdrawal holds (P3.7). Runs after authentication, step-up, validation and idempotency.
  // Payment rails (server/payments.js, CLONE_SPEC.md §26): location and identity here; risk scoring, AML rules and holds
  // run in the payments handler, which knows the payment method (`ownRisk`; on the generic routes when method_id is set).
  const rail = { ownRisk: (req) => !!(req.body && req.body.method_id) };
  const GATED = [
    ['POST', /^\/users\/([^/]+)\/deposits$/, 'deposit', rail],
    ['POST', /^\/users\/([^/]+)\/withdrawals$/, 'withdrawal', rail],
    ['POST', /^\/users\/([^/]+)\/(debit\/payment|bank_link\/deposit)$/, 'deposit', { ownRisk: true }],
    ['POST', /^\/users\/([^/]+)\/(debit|bank_link|crypto)\/withdrawal$/, 'withdrawal', { ownRisk: true }],
    ['POST', /^\/users\/([^/]+)\/(debit\/payment_session|bank_link\/accounts|banks\/linked_accounts|crypto\/wallets|crypto\/simulate_deposit)$/, 'deposit', { ownRisk: true }],
    ['PUT', /^\/users\/([^/]+)\/crypto\/account$/, 'deposit', { ownRisk: true }],
    ['POST', /^\/users\/([^/]+)\/orders$/, 'trade'],
    ['POST', /^\/users\/([^/]+)\/orders\/[^/]+\/amend$/, 'trade'],
    ['POST', /^\/perps\/orders$/, 'trade'],
    ['POST', /^\/perps\/transfers$/, 'transfer'],
    ['POST', /^\/communications\/(rfqs|quotes)$/, 'trade'],
    ['POST', /^\/communications\/rfqs\/[^/]+\/quotes$/, 'trade'],
    ['PUT', /^\/communications\/(rfqs\/[^/]+\/)?quotes\/[^/]+\/(accept|confirm)$/, 'trade'],
  ];
  const KIND_TEXT = { deposit: 'deposit', withdrawal: 'withdraw', trade: 'trade', transfer: 'move funds' };
  function gate(req, res, next) {
    if (!req.auth || req.adminInternal) return next();
    const hit = GATED.find(([m, re]) => m === req.method && re.test(req.path));
    if (!hit) return next();
    const m = hit[1].exec(req.path);
    if (hit[1].source.startsWith('^\\/users') && m[1] !== req.auth.user.id) return next(); // the route answers 403
    const u = req.auth.user;
    if (u.is_system) return next();
    const kind = hit[2];
    try {
      compliance.geoCheck(req, kind);
      const st = statusOf(u.id);
      if (st === 'closed') throw new ApiError(403, 'account_closed', 'this account is closed');
      if (enforced() && st !== 'approved') {
        const e = new ApiError(403, 'identity_verification_required', `verify your identity to ${KIND_TEXT[kind]}`,
          st === 'pending' || st === 'review' ? 'your identity verification is in progress' : st === 'rejected' ? 'your identity could not be verified; contact support' : 'finish identity verification to continue');
        e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, identity_status: st, action: kind, next: '/sign-up/identity' } });
        throw e;
      }
    } catch (e) { return next(e); }
    if (hit[3] && (typeof hit[3].ownRisk === 'function' ? hit[3].ownRisk(req) : hit[3].ownRisk)) { try { compliance.recordDevice(u.id, req); } catch { /* best effort */ } return next(); }
    return compliance.fraudGate(req, res, next, kind);
  }
  v1.use(gate);

  // ------------------------------------------------------------------ hooks from auth.js
  auth.events.on('signup', ({ user, req }) => {
    try {
      ensureProfile(user.id);
      compliance.recordDevice(user.id, req);
      sendVerification(user, req).catch(() => {});
    } catch (e) { console.error('identity signup hook', e.message); }
  });
  auth.events.on('login', ({ user, req }) => { try { compliance.recordDevice(user.id, req); } catch (e) { console.error('identity login hook', e.message); } });
  auth.events.on('email_change', ({ user, req }) => {
    try { setProfile(user.id, { email_verified_at: null }); sendVerification(user, req).catch(() => {}); } catch (e) { console.error('identity email hook', e.message); }
  });
  auth.hooks.preSession.push(['POST', /^\/v1\/passwords\/reset$/], ['PUT', /^\/v1\/passwords\/reset\/[^/]+\/confirm$/]);

  // ------------------------------------------------------------------ public configuration
  v1.get('/identity/config', (req, res) => {
    res.json({
      kyc_required: enforced(), sandbox, dev_outbox: messaging.info().dev_outbox, oauth_providers: oauth.providers(), passkeys: true, document_verification: { provider: 'Parlance Verify (sandbox)', kinds: docv.KINDS },
      retention: { kyc_records_days: settings().retention.kyc_days }, phone: { code_length: 4, code_ttl_seconds: Math.round(opt.phoneCodeTtlMs / 1000), resend_cooldown_seconds: opt.phoneCooldownSec },
    });
  });
  v1.get('/identity/countries', (req, res) => { res.setHeader('Cache-Control', 'public, max-age=3600'); res.json({ countries: C.publicTable() }); });

  // ------------------------------------------------------------------ onboarding state + resume (spec §4.7: sign_up, resume_sign_up)
  v1.get('/users/:uid/sign_up', requireUser, (req, res) => res.json(stateFor(req.auth.user.id, { details: req.query.include === 'details' })));
  v1.post('/resume_sign_up', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    ensureProfile(uid);
    setProfile(uid, { skipped_at: null, resumed_at: nowIso() });
    res.json(stateFor(uid, { details: true }));
  });
  v1.post('/users/:uid/sign_up/skip', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    ensureProfile(uid);
    setProfile(uid, { skipped_at: nowIso() });
    logEvent(uid, 'identity_skipped', req, { step: nextStep(profile(uid)) });
    res.json(stateFor(uid));
  });
  const editable = (uid) => {
    const st = statusOf(uid);
    if (['pending', 'documents_required', 'review', 'approved', 'rejected', 'closed'].includes(st)) throw E.conflict('identity_locked', 'your identity details can no longer be changed here', st === 'approved' ? 'your identity is verified' : 'contact support to update your details');
    const p = ensureProfile(uid);
    if (!p.phone_verified_at) throw E.conflict('phone_not_verified', 'verify your phone number first');
    return p;
  };

  // ---- phone (P3.2)
  v1.post('/users/:uid/verify_phone/send', requireUser, async (req, res) => {
    const b = check(req.body, { country: { type: 'string', maxLen: 2, required: true }, number: { type: 'string', maxLen: 32, required: true } }, { unknown: 'reject' });
    const uid = req.auth.user.id;
    const st = statusOf(uid);
    if (st === 'closed') throw new ApiError(403, 'account_closed', 'this account is closed');
    const country = b.country.toUpperCase();
    const n = C.normalizePhone(country, b.number);
    if (n.error) throw fieldError({ number: n.error });
    const p = ensureProfile(uid);
    const hash = phoneHash(n.e164);
    if (p.phone_verified_at) {
      if (p.phone_hash === hash) throw E.conflict('phone_already_verified', 'this number is already verified');
      // Changing a verified number is a SIM-swap-style takeover vector: it needs a fresh password / code / passkey check.
      auth.assertFresh(req, 'phone_change');
    }
    const s = settings().sms;
    if ((s.blocked_countries || []).includes(country)) throw fieldError({ number: 'we can’t send codes to numbers in this country' });
    // Limits (SMS-pumping protection): cooldown, per number, per IP, per account, per destination country.
    const now = Date.now();
    const ip = ipHash(req);
    const since = (ms) => now - ms;
    const q = (where, ...a) => db.prepare(`SELECT COUNT(*) c FROM sms_send_log WHERE outcome='sent' AND ${where}`).get(...a).c;
    const last = lastSendTs(uid);
    const limited = (scope, retryMs, msg) => {
      db.prepare('INSERT INTO sms_send_log(ts,user_id,number_hash,ip_hash,country,outcome) VALUES(?,?,?,?,?,?)').run(now, uid, hash, ip, country, `limited:${scope}`);
      logEvent(uid, 'phone_code_limited', req, { scope, country });
      const e = new ApiError(429, scope === 'cooldown' ? 'sms_cooldown' : 'sms_rate_limited', msg, `try again in ${Math.ceil(retryMs / 1000)} seconds`);
      e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, scope, retry_after_sec: Math.ceil(retryMs / 1000) } });
      return e;
    };
    if (last && now - last < opt.phoneCooldownSec * 1000) throw limited('cooldown', opt.phoneCooldownSec * 1000 - (now - last), 'please wait before requesting another code');
    if (q('number_hash=? AND ts>?', hash, since(HOUR)) >= s.per_number_hour) throw limited('number', HOUR, 'too many codes were sent to this number');
    if (q('ip_hash=? AND ts>?', ip, since(HOUR)) >= s.per_ip_hour) throw limited('ip', HOUR, 'too many codes were requested from your network');
    if (q('user_id=? AND ts>?', uid, since(DAY)) >= s.per_account_day) throw limited('account', DAY, 'too many codes were requested for this account today');
    const countryCap = (s.country_limits || {})[country] ?? s.per_country_hour;
    if (q('country=? AND ts>?', country, since(HOUR)) >= countryCap) throw limited('country', HOUR, 'we can’t send more codes to this country right now');
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const id = newId('pc_');
    const masked = C.maskPhone(n.e164, n.dial);
    tx(db, () => {
      db.prepare('UPDATE phone_challenges SET superseded=1 WHERE user_id=? AND verified_ts IS NULL').run(uid);
      db.prepare('INSERT INTO phone_challenges(id,user_id,number_hash,number_enc,masked,country,code_hash,created_ts,expires_ts) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, uid, hash, seal(uid, 'phone_pending', { e164: n.e164 }), masked, country, kc.hmacHex(keys.code, `${id}:${code}`), now, now + opt.phoneCodeTtlMs);
      db.prepare('INSERT INTO sms_send_log(ts,user_id,number_hash,ip_hash,country,outcome) VALUES(?,?,?,?,?,?)').run(now, uid, hash, ip, country, 'sent');
    });
    // Template sms.phone_code (CLONE_SPEC.md §32.5).
    await messaging.sendSms({ userId: uid, to: n.e164, masked, kind: 'phone_verification', body: app.locals.cms.renderSystem('sms.phone_code', { code, minutes: String(Math.round(opt.phoneCodeTtlMs / MIN)) }).sms });
    logEvent(uid, 'phone_code_sent', req, { to: masked, country });
    res.status(201).json({ sent: true, masked, expires_time: new Date(now + opt.phoneCodeTtlMs).toISOString(), resend_available_time: new Date(now + opt.phoneCooldownSec * 1000).toISOString(), attempts_left: opt.phoneMaxAttempts, code_length: 4 });
  });

  v1.post('/users/:uid/verify_phone', requireUser, (req, res) => {
    const b = check(req.body, { code: { type: 'string', maxLen: 8, required: true } }, { unknown: 'reject' });
    const uid = req.auth.user.id;
    const ch = activeChallenge(uid);
    if (!ch) throw new ApiError(400, 'code_expired', 'this code has expired', 'request a new code');
    if (ch.attempts >= opt.phoneMaxAttempts) throw new ApiError(429, 'too_many_code_attempts', 'too many incorrect codes', 'request a new code');
    const ok = /^\d{4}$/.test(b.code) && kc.safeEqual(kc.hmacHex(keys.code, `${ch.id}:${b.code}`), ch.code_hash);
    if (!ok) {
      db.prepare('UPDATE phone_challenges SET attempts=attempts+1 WHERE id=?').run(ch.id);
      const left = Math.max(0, opt.phoneMaxAttempts - ch.attempts - 1);
      logEvent(uid, 'phone_verify_fail', req, { to: ch.masked, attempts_left: left });
      const e = new ApiError(400, 'invalid_code', 'that code is not correct', left ? `${left} attempt${left === 1 ? '' : 's'} left` : 'request a new code');
      e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, attempts_left: left } });
      throw e;
    }
    const e164 = open(uid, 'phone_pending', ch.number_enc)?.e164;
    if (!e164 || db.prepare('UPDATE phone_challenges SET verified_ts=? WHERE id=? AND verified_ts IS NULL').run(Date.now(), ch.id).changes !== 1) throw new ApiError(400, 'code_expired', 'this code has expired', 'request a new code');
    const p = profile(uid);
    const changed = !!p.phone_verified_at;
    setProfile(uid, { phone_enc: seal(uid, 'phone', { e164 }), phone_hash: ch.number_hash, phone_last4: e164.slice(-4), phone_country: ch.country, phone_verified_at: nowIso(),
      status: p.status === 'not_started' ? 'in_progress' : p.status });
    logEvent(uid, changed ? 'phone_changed' : 'phone_verified', req, { to: ch.masked });
    if (changed) auth.alertUser(req.auth.user, 'Phone number changed', `The phone number on your account is now ${ch.masked}.`);
    res.json(stateFor(uid));
  });

  // ---- legal name
  const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,49}$/u;
  v1.put('/users/:uid/sign_up/name', requireUser, (req, res) => {
    const b = check(req.body, { first_name: { type: 'string', maxLen: 50, required: true }, last_name: { type: 'string', maxLen: 50, required: true } }, { unknown: 'reject' });
    const uid = req.auth.user.id;
    editable(uid);
    const first = b.first_name.trim().replace(/\s+/g, ' '); const last = b.last_name.trim().replace(/\s+/g, ' ');
    const errs = {};
    if (!NAME_RE.test(first)) errs.first_name = 'enter your legal first name (letters, spaces, hyphens and apostrophes)';
    if (!NAME_RE.test(last)) errs.last_name = 'enter your legal last name (letters, spaces, hyphens and apostrophes)';
    if (Object.keys(errs).length) throw fieldError(errs);
    setProfile(uid, { name_enc: seal(uid, 'name', { first, last }), status: 'in_progress', skipped_at: null });
    logEvent(uid, 'identity_step', req, { step: 'name' });
    res.json(stateFor(uid));
  });

  // ---- date of birth (18+ checked here, server-side)
  v1.put('/users/:uid/sign_up/birthday', requireUser, (req, res) => {
    const INT = (min, max) => ({ type: ['integer', 'string'], maxLen: 4, required: true, min, max });
    const b = check(req.body, { month: INT(1, 12), day: INT(1, 31), year: INT(1900, 2100) }, { unknown: 'reject' });
    const uid = req.auth.user.id;
    editable(uid);
    const [mo, d, y] = [b.month, b.day, b.year].map((v) => (/^\d{1,4}$/.test(String(v)) ? Number(v) : NaN));
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (!Number.isInteger(mo) || !Number.isInteger(d) || !Number.isInteger(y) || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw fieldError({ date: 'enter a valid date' });
    const now = new Date();
    let age = now.getUTCFullYear() - y;
    if (now.getUTCMonth() < mo - 1 || (now.getUTCMonth() === mo - 1 && now.getUTCDate() < d)) age -= 1;
    if (dt > now || age > 120) throw fieldError({ date: 'enter a valid date of birth' });
    if (age < 18) {
      logEvent(uid, 'identity_underage', req, {}); // the date itself is not logged
      throw new ApiError(400, 'age_requirement', 'you must be 18 or over to use Parlance');
    }
    setProfile(uid, { dob_enc: seal(uid, 'dob', { month: mo, day: d, year: y }), age_verified: 1, status: 'in_progress', skipped_at: null });
    logEvent(uid, 'identity_step', req, { step: 'birthday' });
    res.json(stateFor(uid));
  });

  // ---- address + national ID
  const TEXT = (n, req = false) => ({ type: 'string', maxLen: n, required: req });
  v1.put('/users/:uid/sign_up/address', requireUser, (req, res) => {
    const b = check(req.body, { country: TEXT(2, true), line1: TEXT(100, true), line2: TEXT(60), city: TEXT(60, true), region: TEXT(60, true), postal_code: TEXT(12, true), national_id: TEXT(24, true) }, { unknown: 'reject' });
    const uid = req.auth.user.id;
    editable(uid);
    const country = b.country.toUpperCase();
    const c = C.COUNTRIES[country];
    const rule = C.NATIONAL_IDS[country];
    if (!c || !rule) throw fieldError({ country: 'choose a supported country' });
    const a = { country, line1: b.line1.trim().replace(/\s+/g, ' '), line2: String(b.line2 || '').trim().replace(/\s+/g, ' '), city: b.city.trim().replace(/\s+/g, ' '), region: b.region.trim(), postal_code: b.postal_code.trim().toUpperCase() };
    const errs = {};
    if (a.line1.length < 3 || !/\d|[\p{L}]{3}/u.test(a.line1)) errs.line1 = 'enter your residential street address';
    else if (C.PO_BOX.test(a.line1) || C.PO_BOX.test(a.line2)) errs.line1 = 'use your residential address, not a PO box or business address';
    if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]{1,59}$/u.test(a.city)) errs.city = 'enter your city';
    if (c.regions) { if (!c.regions.some(([code]) => code === a.region)) errs.region = `choose your ${c.regionLabel.toLowerCase()}`; } else if (a.region.length < 2) errs.region = `enter your ${c.regionLabel.toLowerCase()}`;
    if (!c.postal.test(a.postal_code)) errs.postal_code = `enter a valid ${c.postalLabel.toLowerCase()} (${c.postalHint})`;
    const nid = rule.normalize(b.national_id);
    const nidErr = rule.validate(nid, { sandbox });
    if (nidErr) errs.national_id = nidErr; // never echoes the value
    if (Object.keys(errs).length) throw fieldError(errs);
    setProfile(uid, { address_enc: seal(uid, 'address', a), country, national_id_enc: seal(uid, 'national_id', { country, type: rule.type, value: nid }), national_id_hash: nidHash(country, nid),
      national_id_last: lastOf(nid), national_id_type: rule.type, status: 'in_progress', skipped_at: null });
    logEvent(uid, 'identity_step', req, { step: 'address', country });
    res.json(stateFor(uid));
  });

  // ---- submit for verification (async KYC job, P3.5)
  v1.post('/users/:uid/sign_up/submit', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const p = editable(uid);
    const s = stepsOf(p);
    const missing = Object.entries(s).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw E.conflict('identity_incomplete', 'finish every step first', `missing: ${missing.join(', ')}`);
    if (p.kyc_attempts >= opt.maxKycAttempts) throw E.conflict('too_many_attempts', 'too many verification attempts', 'contact support');
    kyc.submit(uid, req);
    res.status(202).json(stateFor(uid));
  });

  // ---- address autocomplete (simulated lookup provider with invented addresses; signed-in users only)
  const STREETS = ['Maple Test Avenue', 'Sample Street', 'Placeholder Road', 'Example Lane', 'Mockingbird Test Way', 'Fixture Court', 'Sandbox Boulevard'];
  const TOWNS = { US: [['Sampleton', 'NY', '10001'], ['Testville', 'CA', '94016'], ['Demo City', 'TX', '73301']], CA: [['Sampleton', 'ON', 'K1A 0B1'], ['Testville', 'BC', 'V5K 0A1']],
    GB: [['Sampleton', 'ENG', 'SW1A 1AA'], ['Testville', 'SCT', 'EH1 1YZ']], NG: [['Sampleton', 'LAG', '100001'], ['Testville', 'FED', '900001']], AU: [['Sampleton', 'NSW', '2000'], ['Testville', 'VIC', '3000']],
    DE: [['Musterstadt', 'DE11', '10115']], BR: [['Cidade Exemplo', 'SP', '01001-000']], KE: [['Sampleton', 'Nairobi', '00100']], IN: [['Sampleton', 'Delhi', '110001']], MX: [['Ciudad Ejemplo', 'CDMX', '01000']] };
  v1.get('/address/suggest', requireUser, (req, res) => {
    const country = String(req.query.country || '').toUpperCase();
    const qv = String(req.query.q || '').trim().slice(0, 80);
    const m = /^(\d{1,6})\s*(.*)$/.exec(qv);
    const towns = TOWNS[country] || [];
    if (!m || !towns.length) return res.json({ suggestions: [] });
    const rest = m[2].toLowerCase();
    const list = STREETS.filter((s) => !rest || s.toLowerCase().startsWith(rest)).slice(0, 3)
      .flatMap((s) => towns.slice(0, 2).map(([city, region, postal]) => ({ line1: `${m[1]} ${s}`, city, region, postal_code: postal, country })));
    res.json({ suggestions: list.slice(0, 5) });
  });

  // ------------------------------------------------------------------ email verification (P3.1)
  async function sendVerification(user, req) {
    const t = signToken('email_verify', user.id, opt.emailTokenTtlMs, { em: emailFingerprint(user.email) });
    // Template email.verify_email (Admin › Content › Templates, CLONE_SPEC.md §32.5).
    const em = app.locals.cms.renderSystem('email.verify_email', { name: user.display_name, link: `${origin(req)}/verify-email?token=${t}`, hours: String(Math.round(opt.emailTokenTtlMs / 3600000)) }, { origin: origin(req) });
    await messaging.sendEmail({ userId: user.id, to: user.email, subject: em.subject, text: em.text, html: em.html });
    logRequest('email_verify', kc.sha256hex(user.id));
  }
  v1.post('/users/:uid/email_verification', requireUser, async (req, res) => {
    const u = req.auth.user;
    if (profile(u.id)?.email_verified_at) throw E.conflict('email_already_verified', 'your email is already verified');
    const recent = db.prepare("SELECT MAX(ts) t FROM identity_request_log WHERE kind='email_verify' AND key_hash=?").get(kc.sha256hex(u.id)).t || 0;
    // A resend within the cooldown is a 409 (the account state "an email was just sent"), not a 429 rate-limit answer.
    if (Date.now() - recent < opt.verifyResendSec * 1000) throw E.conflict('verification_recently_sent', 'we just sent a verification email', `check your inbox, or try again in ${Math.ceil((opt.verifyResendSec * 1000 - (Date.now() - recent)) / 1000)} seconds`);
    ensureProfile(u.id);
    await sendVerification(u, req);
    res.status(202).json({ sent: true });
  });
  v1.post('/verify_email', async (req, res) => {
    const b = check(req.body, { token: { type: 'string', maxLen: 600, required: true } }, { unknown: 'reject' });
    const o = openToken('email_verify', b.token, { allowUsed: true });
    if (o && o.used) throw new ApiError(400, 'token_invalid', 'this link was already used', 'your email may already be verified');
    const u = o && getUser(o.u);
    if (!o || !u || o.em !== emailFingerprint(u.email) || statusOf(u.id) === 'closed') throw new ApiError(400, 'token_invalid', 'this link is invalid or has expired', 'request a new verification email from Account › Identity & privacy');
    if (!useToken(o)) throw new ApiError(400, 'token_invalid', 'this link was already used');
    ensureProfile(u.id);
    setProfile(u.id, { email_verified_at: nowIso() });
    logEvent(u.id, 'email_verified', req, {});
    res.json({ verified: true });
  });

  // ------------------------------------------------------------------ password reset (P3.1; spec §4.7 /passwords/reset)
  const uniformReset = { ok: true, message: 'If an account exists for that email, we sent a link to reset the password.' };
  v1.post('/passwords/reset', async (req, res) => {
    const b = check(req.body, { email: { type: 'string', maxLen: 254, required: true } }, { unknown: 'reject' });
    const email = b.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fieldError({ email: 'enter a valid email address' });
    const ek = kc.sha256hex(`reset:${email}`); const ik = ipHash(req);
    const allowed = countRecent('reset_email', ek, HOUR) < opt.resetPerEmailHour && countRecent('reset_ip', ik, HOUR) < opt.resetPerIpHour;
    logRequest('reset_email', ek); logRequest('reset_ip', ik);
    const u = db.prepare('SELECT * FROM users WHERE email=? AND is_system=0').get(email);
    if (allowed && u && statusOf(u.id) !== 'closed') {
      const t = signToken('password_reset', u.id, opt.resetTokenTtlMs, { fp: pwFingerprint(u.password_hash) });
      // Template email.password_reset (CLONE_SPEC.md §32.5).
      const em = app.locals.cms.renderSystem('email.password_reset', { link: `${origin(req)}/reset-password?token=${t}`, minutes: String(Math.round(opt.resetTokenTtlMs / MIN)) }, { origin: origin(req) });
      await messaging.sendEmail({ userId: u.id, to: u.email, subject: em.subject, text: em.text, html: em.html });
      logEvent(u.id, 'password_reset_requested', req, {});
    }
    res.status(202).json(uniformReset); // same answer for unknown emails and when rate-limited (no account-existence signal)
  });
  const resetToken = (raw) => { const o = openToken('password_reset', raw); const u = o && getUser(o.u); return o && u && o.fp === pwFingerprint(u.password_hash) && statusOf(u.id) !== 'closed' ? { o, u } : null; };
  v1.get('/passwords/reset/:token', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ valid: !!resetToken(req.params.token) }); });
  v1.put('/passwords/reset/:token/confirm', async (req, res) => {
    const b = check(req.body, { password: { type: 'string', maxLen: 256, required: true } }, { unknown: 'reject' });
    const t = resetToken(req.params.token);
    if (!t) throw new ApiError(400, 'token_invalid', 'this reset link is invalid, expired or already used', 'request a new link');
    const { o, u } = t;
    const bad = pw.checkPolicy(b.password, { email: u.email, name: u.display_name });
    if (bad) throw new ApiError(400, bad.code, 'password does not meet the requirements', bad.message);
    if (await pw.verifyPassword(b.password, u.password_hash)) throw new ApiError(400, 'weak_password', 'password does not meet the requirements', 'choose a password different from your current one');
    const hash = await pw.hashPassword(b.password);
    if (!useToken(o)) throw new ApiError(400, 'token_invalid', 'this reset link was already used');
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, u.id);
      db.prepare('INSERT INTO auth_user_security(user_id,updated_at) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING').run(u.id, nowIso());
      db.prepare('UPDATE auth_user_security SET must_change_password=0, password_changed_at=?, updated_at=? WHERE user_id=?').run(nowIso(), nowIso(), u.id);
      db.prepare('DELETE FROM auth_throttle WHERE key=?').run(`acct:${kc.sha256hex(u.email)}`);
      db.prepare("UPDATE identity_tokens SET used_ts=? WHERE user_id=? AND purpose='password_reset' AND used_ts IS NULL").run(Date.now(), u.id); // other outstanding links die too
    });
    const revoked = auth.revokeAll(u.id);
    logEvent(u.id, 'password_reset', req, { sessions_signed_out: revoked.length });
    auth.alertUser(u, 'Your password was reset', `Your password was reset with an emailed link${revoked.length ? ` and ${revoked.length} session(s) were signed out` : ''}.`);
    res.json({ ok: true, sessions_signed_out: revoked.length });
  });

  // ------------------------------------------------------------------ owner's identity summary (Account › Identity & privacy)
  v1.get('/users/:uid/identity', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const s = stateFor(uid);
    const p = profile(uid);
    res.json({ ...s, name_masked: mask.name(open(uid, 'name', p?.name_enc)), dob_masked: mask.dob(p?.dob_enc), address_masked: mask.address(open(uid, 'address', p?.address_enc)),
      retention_policy: retentionText() });
  });
  function retentionText() {
    const r = settings().retention;
    return [
      'Identity details (legal name, date of birth, address, phone, national ID) and your ID photos are encrypted with a key unique to your account.',
      `ID photos are erased as soon as a verification decision is made (or after ${r.documents_days} days if you never finish).`,
      `When you close your account that key is destroyed, so the details can no longer be read. A one-way fingerprint of your national ID and the verification decision are kept for ${Math.round(r.kyc_days / 365)} years to meet anti-fraud and anti-money-laundering record-keeping rules, then deleted.`,
      `Verification codes and emails are deleted after ${r.outbox_days} days, location checks after ${r.geo_days} days and device records after ${r.device_days} days.`,
    ];
  }

  // ------------------------------------------------------------------ data export (P3.8)
  v1.post('/users/:uid/data_export', requireUser, (req, res) => {
    auth.assertFresh(req, 'data_export');
    const u = getUser(req.auth.user.id);
    const uid = u.id;
    const p = profile(uid);
    const all = (sql, ...a) => db.prepare(sql).all(...a);
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    const nid = p?.national_id_last ? { type: p.national_id_type, masked: mask.nationalId(p.national_id_last, p.national_id_type), note: 'National ID numbers are never shown in full, even to you.' } : null;
    const data = {
      format: 'parlance-data-export', version: 1, exported_time: nowIso(),
      account: { user_id: uid, email: u.email, display_name: u.display_name, created_time: u.created_at, balance_dollars: dollars(u.balance_cents) },
      identity: p ? {
        status: p.status, email_verified_time: p.email_verified_at, phone: open(uid, 'phone', p.phone_enc)?.e164 || null, phone_verified_time: p.phone_verified_at,
        legal_name: open(uid, 'name', p.name_enc), date_of_birth: open(uid, 'dob', p.dob_enc), address: open(uid, 'address', p.address_enc), national_id: nid,
        verification: { reason_category: p.kyc_reason, submitted_time: p.submitted_at, decided_time: p.decided_at, attempts: p.kyc_attempts },
      } : null,
      settings: all('SELECT key, value, updated_at FROM user_settings WHERE user_id=?', uid).map((r) => ({ key: r.key, value: JSON.parse(r.value), updated_time: r.updated_at })),
      orders: all('SELECT id, market_ticker, side, price_cents, initial_count, remaining_count, filled_count, status, created_at FROM orders WHERE user_id=? ORDER BY seq', uid),
      fills: all('SELECT * FROM fills WHERE user_id=? ORDER BY created_ts', uid),
      positions: all('SELECT * FROM positions WHERE user_id=?', uid),
      settlements: all('SELECT * FROM settlements WHERE user_id=?', uid),
      ledger: all('SELECT id, kind, amount_cents, ref, memo, created_at FROM ledger WHERE user_id=? ORDER BY created_at', uid),
      watchlist: all('SELECT event_ticker, created_at FROM watchlist WHERE user_id=?', uid),
      notifications: all('SELECT type, title, body, link, created_ts FROM notifications WHERE user_id=? ORDER BY created_ts', uid),
      price_alerts: all('SELECT * FROM price_targets WHERE user_id=?', uid),
      limits: all('SELECT * FROM user_limits WHERE user_id=?', uid),
      social: { profile: all('SELECT nickname, bio, share_trades, created_at FROM social_profiles WHERE user_id=?', uid)[0] || null, posts: all('SELECT id, body, event_ticker, created_ts FROM posts WHERE user_id=?', uid), comments: all('SELECT id, post_id, body, created_ts FROM comments WHERE user_id=?', uid) },
      chat_messages: has('chat_messages') ? all('SELECT id, room, body, created_ts FROM chat_messages WHERE user_id=? AND deleted=0', uid) : [],
      // Web Push devices (§31): metadata only; endpoints and keys are capability secrets and stay encrypted server-side.
      push_devices: has('push_subscriptions') ? all('SELECT id, label, service, created_at, last_success_ts FROM push_subscriptions WHERE user_id=?', uid) : [],
      perps: has('perp_accounts') ? { account: all('SELECT * FROM perp_accounts WHERE user_id=?', uid)[0] || null, positions: all('SELECT * FROM perp_positions WHERE user_id=?', uid), orders: all('SELECT * FROM perp_orders WHERE user_id=?', uid) } : null,
      security: {
        two_factor: auth.mfaEnabled(uid), sessions: all('SELECT sid, device, ip_prefix, created_at, last_seen_ms FROM sessions WHERE user_id=?', uid),
        events: all('SELECT ts, type, ip_prefix, device FROM auth_events WHERE user_id=? ORDER BY ts', uid).map((e) => ({ ...e, time: new Date(e.ts).toISOString() })),
        passkeys: has('passkeys') ? all('SELECT name, created_at, last_used_at, aaguid FROM passkeys WHERE user_id=?', uid) : [],
        linked_sign_in: has('oauth_links') ? all('SELECT provider, email_verified, created_at FROM oauth_links WHERE user_id=?', uid) : [],
        devices: compliance.devicesOf(uid),
      },
      withdrawal_holds: compliance.holdsOf(uid),
      identity_documents: docv.documentsMeta(uid).map((d) => ({ kind: d.kind, uploaded_time: d.uploaded_time, note: 'Photos are not included in the export; they are erased after the verification decision.' })),
      account_area: ctx.accountArea ? ctx.accountArea.exportFor(uid) : null,
    };
    logEvent(uid, 'data_export', req, {});
    res.setHeader('Content-Disposition', `attachment; filename="parlance-data-${uid.slice(-8)}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  });

  // ------------------------------------------------------------------ account closure (P3.8)
  v1.post('/users/:uid/close_account', requireUser, (req, res) => {
    const b = check(req.body, { confirm: { type: 'string', maxLen: 16, required: true }, reason: { type: 'string', maxLen: 200 } }, { unknown: 'reject' });
    if (b.confirm !== 'CLOSE') throw fieldError({ confirm: 'type CLOSE to confirm' });
    auth.assertFresh(req, 'account_closure');
    const uid = req.auth.user.id;
    const units = db.prepare("SELECT COUNT(*) c FROM positions p JOIN markets m ON m.ticker=p.market_ticker WHERE p.user_id=? AND (p.yes_count>0 OR p.no_count>0) AND m.status<>'finalized'").get(uid).c;
    if (units) throw E.conflict('open_positions', 'close your open positions first', `you have ${units} open position${units === 1 ? '' : 's'}; sell them or wait for the markets to settle`);
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (has('perp_positions') && db.prepare('SELECT COUNT(*) c FROM perp_positions WHERE user_id=? AND qty<>0').get(uid).c) throw E.conflict('open_positions', 'close your perps positions first');
    if (has('perp_orders') && db.prepare("SELECT COUNT(*) c FROM perp_orders WHERE user_id=? AND status='resting'").get(uid).c) throw E.conflict('open_orders', 'cancel your resting perps orders first');
    if (has('perp_accounts') && (db.prepare('SELECT available_cc c FROM perp_accounts WHERE user_id=?').get(uid)?.c || 0) > 0) throw E.conflict('perps_balance', 'move your perps collateral back to cash first');
    if (compliance.holdsOf(uid).some((h) => h.status === 'held')) throw E.conflict('withdrawal_on_hold', 'a withdrawal is under review', 'wait for it to be released or reversed');
    let canceled = 0;
    for (const o of db.prepare("SELECT id FROM orders WHERE user_id=? AND status='resting'").all(uid)) { try { engine.cancelOrder(uid, o.id, 'account_closed'); canceled += 1; } catch { /* market not open: reservation stays until settlement */ } }
    if (has('rfqs')) db.prepare("UPDATE rfqs SET status='cancelled', closed_reason='account_closed', updated_ts=? WHERE user_id=? AND status='open'").run(Date.now(), uid);
    if (has('rfq_quotes')) db.prepare("UPDATE rfq_quotes SET status='cancelled', closed_reason='account_closed', updated_ts=? WHERE maker_id=? AND status='open'").run(Date.now(), uid);
    const balance = engine.balance(uid);
    const r = settings().retention;
    const closedAt = nowIso();
    tx(db, () => {
      if (balance > 0) engine.credit(uid, -balance, 'closure_payout', null, 'account closed: remaining cash paid out (simulated)');
      // Crypto-shredding: the per-user data key is destroyed, then the ciphertexts are cleared as well.
      docv.eraseDocuments(uid, 'account_closed');
      db.prepare('DELETE FROM identity_keys WHERE user_id=?').run(uid);
      ensureProfile(uid);
      setProfile(uid, { status: 'closed', closed_at: closedAt, shredded_at: closedAt, retain_until: new Date(Date.now() + r.kyc_days * DAY).toISOString(),
        phone_enc: null, phone_hash: null, phone_last4: null, name_enc: null, dob_enc: null, address_enc: null, national_id_enc: null, national_id_last: null, email_verified_at: null, skipped_at: null });
      db.prepare('DELETE FROM phone_challenges WHERE user_id=?').run(uid);
      db.prepare('DELETE FROM email_outbox WHERE user_id=?').run(uid);
      db.prepare('DELETE FROM sms_outbox WHERE user_id=?').run(uid);
      db.prepare('DELETE FROM identity_tokens WHERE user_id=?').run(uid);
      db.prepare('DELETE FROM mfa WHERE user_id=?').run(uid);
      if (has('passkeys')) db.prepare('DELETE FROM passkeys WHERE user_id=?').run(uid);
      if (has('oauth_links')) db.prepare('DELETE FROM oauth_links WHERE user_id=?').run(uid);
      if (has('push_subscriptions')) { db.prepare('DELETE FROM push_outbox WHERE user_id=?').run(uid); db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(uid); } // Web Push (§31)
      compliance.forgetUser(uid);
      // The account row stays (ledger, fills and audit keep their references) without personal data.
      db.prepare('UPDATE users SET email=?, display_name=?, password_hash=? WHERE id=?').run(`closed+${uid.slice(-12)}@closed.invalid`, 'Closed account', pw.UNUSABLE('account-closed'), uid);
      audit(req, 'privacy.account_closed', uid, null, { orders_canceled: canceled, payout_cents: Math.max(0, balance), retain_until: new Date(Date.now() + r.kyc_days * DAY).toISOString() }, 'closed by the account holder', { selfService: true });
    });
    logEvent(uid, 'account_closed', req, { orders_canceled: canceled });
    auth.revokeAll(uid);
    auth.clearSessionCookie(res, req);
    res.json({ closed: true, orders_canceled: canceled, payout_dollars: dollars(Math.max(0, balance)) });
  });

  // ------------------------------------------------------------------ admin: identity lookup (masked) + audited unmask
  function adminView(uid) {
    const u = getUser(uid);
    const p = profile(uid);
    return {
      user_id: uid, email: u.email, display_name: u.display_name, created_time: u.created_at, status: p?.status || 'not_started',
      phone: p?.phone_last4 ? { masked: `${'•'.repeat(6)}${p.phone_last4}`, country: p.phone_country, verified_time: p.phone_verified_at } : null,
      legal_name: mask.name(open(uid, 'name', p?.name_enc)), date_of_birth: mask.dob(p?.dob_enc), age_verified: !!p?.age_verified, address: mask.address(open(uid, 'address', p?.address_enc)), country: p?.country || null,
      national_id: p?.national_id_last ? mask.nationalId(p.national_id_last, p.national_id_type) : null, national_id_type: p?.national_id_type || null,
      duplicate_national_id: !!(p?.national_id_hash && db.prepare('SELECT 1 FROM identity_profiles WHERE national_id_hash=? AND user_id<>? LIMIT 1').get(p.national_id_hash, uid)),
      verification: { reason_category: p?.kyc_reason || null, attempts: p?.kyc_attempts || 0, submitted_time: p?.submitted_at || null, decided_time: p?.decided_at || null, decided_by: p?.decided_by || null },
      email_verified: !!p?.email_verified_at, closed_time: p?.closed_at || null, shredded: !!p?.shredded_at,
      risk: compliance.riskSummary(uid), kyc_history: kyc.historyOf(uid), stage: p?.kyc_stage || null, documents: docv.documentsMeta(uid),
    };
  }
  v1.get('/admin/identity/users/:id', can('users.read'), (req, res) => {
    const u = findUser(req.params.id);
    if (!u || u.is_system) throw E.notFound();
    res.json({ identity: adminView(u.id) });
  });
  const UNMASKABLE = { legal_name: 'name', date_of_birth: 'dob', address: 'address', phone: 'phone' };
  v1.post('/admin/identity/users/:id/unmask', can('users.support'), (req, res) => {
    const b = check(req.body, { field: { type: 'string', enum: [...Object.keys(UNMASKABLE), 'national_id'], required: true }, reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
    const u = findUser(req.params.id);
    if (!u || u.is_system) throw E.notFound();
    if (b.field === 'national_id') throw new ApiError(403, 'not_unmaskable', 'national ID numbers are never shown in full', 'compare the last digits with the customer instead');
    const reason = b.reason.trim();
    if (reason.length < 5) throw fieldError({ reason: 'give a reason of at least 5 characters (recorded in the audit log)' });
    const p = profile(u.id);
    const value = open(u.id, UNMASKABLE[b.field], p && p[`${UNMASKABLE[b.field]}_enc`]);
    if (value == null) throw E.notFound();
    // Audit the access (who, whose, which field, why) — never the value.
    audit(req, 'identity.unmask', u.id, null, { field: b.field }, reason);
    logEvent(u.id, 'identity_viewed_by_staff', req, { field: b.field });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ field: b.field, value: b.field === 'phone' ? value.e164 : value });
  });

  // ------------------------------------------------------------------ admin: compliance settings
  const COUNTRY_RE = /^[A-Z]{2}$/;
  function settingsView() { const s = settings(); return { ...s, enforce_effective: enforced(), default_enforce: !!kycDefault }; }
  v1.get('/admin/compliance/settings', can('settings.write'), (req, res) => res.json({ settings: settingsView(), countries: Object.keys(C.COUNTRIES).concat(['CU', 'IR', 'KP', 'SY', 'RU', 'FR', 'JP']).map((c) => ({ code: c, name: C.countryName(c) })) }));
  v1.put('/admin/compliance/settings', can('settings.write'), (req, res) => {
    const b = check(req.body, {
      enforce: { type: 'boolean', nullable: true }, blocked_countries: { type: 'array', maxItems: 100, items: { type: 'string', pattern: COUNTRY_RE } }, unknown_ip: { type: 'string', enum: ['allow', 'block'] },
      ip_overrides: { type: 'array', maxItems: 100, items: { type: 'object' } }, fraud: { type: 'object' }, admin_passkey_required: { type: 'boolean' }, sms: { type: 'object' }, retention: { type: 'object' },
      reason: { type: 'string', maxLen: 500 },
    }, { unknown: 'reject' });
    const before = settings();
    const next = { ...before };
    const errs = {};
    if ('enforce' in b) next.enforce = b.enforce;
    if (b.blocked_countries) next.blocked_countries = [...new Set(b.blocked_countries)];
    if (b.unknown_ip) next.unknown_ip = b.unknown_ip;
    if (b.ip_overrides) {
      const list = b.ip_overrides.map((o) => ({ cidr: String(o?.cidr || '').trim(), country: String(o?.country || '').trim().toUpperCase() }));
      if (list.some((o) => !C.validCidr(o.cidr) || !COUNTRY_RE.test(o.country))) errs.ip_overrides = 'each entry needs an IPv4 CIDR (e.g. 192.0.2.0/24) and a 2-letter country code';
      next.ip_overrides = list;
    }
    if (b.fraud) {
      const t = b.fraud.hold_threshold;
      if (t != null && !(Number.isInteger(t) && t >= 10 && t <= 200)) errs['fraud.hold_threshold'] = 'must be a whole number from 10 to 200';
      if (b.fraud.hold_withdrawals != null && typeof b.fraud.hold_withdrawals !== 'boolean') errs['fraud.hold_withdrawals'] = 'must be true, false or null';
      next.fraud = { ...before.fraud, ...(t != null ? { hold_threshold: t } : {}), ...('hold_withdrawals' in b.fraud ? { hold_withdrawals: b.fraud.hold_withdrawals } : {}) };
    }
    if ('admin_passkey_required' in b) next.admin_passkey_required = b.admin_passkey_required;
    if (b.sms) {
      const s = { ...before.sms };
      for (const k of ['per_number_hour', 'per_ip_hour', 'per_account_day', 'per_country_hour']) {
        if (b.sms[k] == null) continue;
        if (!(Number.isInteger(b.sms[k]) && b.sms[k] >= 0 && b.sms[k] <= 100000)) errs[`sms.${k}`] = 'must be a whole number from 0 to 100000'; else s[k] = b.sms[k];
      }
      if (b.sms.country_limits != null) {
        const cl = b.sms.country_limits;
        if (typeof cl !== 'object' || Array.isArray(cl) || Object.entries(cl).some(([k, v]) => !COUNTRY_RE.test(k) || !(Number.isInteger(v) && v >= 0 && v <= 100000))) errs['sms.country_limits'] = 'map of 2-letter country code to a whole number';
        else s.country_limits = cl;
      }
      if (b.sms.blocked_countries != null) {
        if (!Array.isArray(b.sms.blocked_countries) || b.sms.blocked_countries.some((c) => !COUNTRY_RE.test(String(c)))) errs['sms.blocked_countries'] = 'list of 2-letter country codes'; else s.blocked_countries = b.sms.blocked_countries;
      }
      next.sms = s;
    }
    if (b.retention) {
      const r = { ...before.retention };
      for (const [k, [lo, hi]] of Object.entries({ kyc_days: [365, 3650], outbox_days: [1, 365], geo_days: [1, 365], device_days: [30, 730] })) {
        if (b.retention[k] == null) continue;
        if (!(Number.isInteger(b.retention[k]) && b.retention[k] >= lo && b.retention[k] <= hi)) errs[`retention.${k}`] = `must be a whole number from ${lo} to ${hi}`; else r[k] = b.retention[k];
      }
      next.retention = r;
    }
    if (Object.keys(errs).length) throw fieldError(errs);
    saveSettings(next, req.auth.user.id);
    audit(req, 'compliance.settings', 'compliance', before, next, String(b.reason || '').trim());
    res.json({ settings: settingsView() });
  });

  // ------------------------------------------------------------------ dev outboxes (never in production)
  messaging.mountDevRoutes(v1, { clientIp: security.clientIp });

  // ------------------------------------------------------------------ A2: sensitive sign-in settings locked until verified
  // Observed (CLONE_SPEC §13.19): mid-verification, GET …/passkeys, …/sign_in_methods and …/api_keys answer 403
  // permission_denied with this exact envelope. The clone locks reads and changes of passkeys, sign-in methods
  // (provider links) and API keys until identity verification is approved; changes also need a fresh step-up.
  const PERMISSION_DENIED = { code: 'permission_denied', message: 'You do not have permission to perform this action', details: 'Please make sure you are logged in with the correct account. Contact support if you believe this is an error.', support_action: 'support_chat' };
  const permissionDenied = () => { const e = new ApiError(403, PERMISSION_DENIED.code, PERMISSION_DENIED.message, PERMISSION_DENIED.details); e.toJSON = () => ({ error: { ...PERMISSION_DENIED } }); return e; };
  const LOCKED_A2 = [
    ['GET', /^\/users\/([^/]+)\/(passkeys|sign_in_methods|api_keys)$/],
    ['POST', /^\/users\/([^/]+)\/passkeys\/registration(\/options)?$/],
    ['POST', /^\/users\/([^/]+)\/oauth\/[^/]+\/link$/],
    ['POST', /^\/users\/([^/]+)\/api_keys$/],
  ];
  v1.use((req, res, next) => {
    if (!req.auth) return next();
    const hit = LOCKED_A2.find(([m, re]) => m === req.method && re.test(req.path));
    if (!hit) return next();
    if (hit[1].exec(req.path)[1] !== req.auth.user.id) return next(); // the route answers 403 forbidden
    // Staff accounts are exempt: they can be required to use passkeys for the admin panel (compliance setting).
    if (statusOf(req.auth.user.id) !== 'approved' && !req.auth.user.is_admin && !admin.rolesOf(req.auth.user).length) { logEvent(req.auth.user.id, 'permission_denied', req, { path: req.path.replace(/\/users\/[^/]+/, '/users/:uid') }); return next(permissionDenied()); }
    next();
  });
  v1.get('/users/:uid/sign_in_methods', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    res.json({
      password: pw.isUsable(getUser(uid).password_hash), two_factor: auth.mfaEnabled(uid),
      passkeys: has('passkeys') ? db.prepare('SELECT COUNT(*) c FROM passkeys WHERE user_id=?').get(uid).c : 0,
      providers: has('oauth_links') ? db.prepare('SELECT provider, created_at FROM oauth_links WHERE user_id=? ORDER BY created_at').all(uid).map((l) => ({ provider: l.provider, linked_time: l.created_at })) : [],
    });
  });
  // API keys are Phase 7 (PLAN P7.1); the endpoint exists now so the lock above is real and testable.
  v1.get('/users/:uid/api_keys', requireUser, (req, res) => res.json({ api_keys: [], available: false, note: 'API keys arrive with the public trading API (Phase 7).' }));

  // ------------------------------------------------------------------ OAuth + passkeys
  const oauth = mountOAuth({ ...ctx, v1, app });
  ctx.oauth = oauth;
  const webauthn = mountWebAuthn({ ...ctx, v1, app });
  ctx.webauthn = webauthn;
  kyc.mountRoutes(v1);
  docv.mountRoutes(v1);
  compliance.mountRoutes(v1);

  // ------------------------------------------------------------------ retention job (P3.1a / P3.8)
  function retention() {
    try {
      const r = settings().retention;
      messaging.purge(r.outbox_days * DAY);
      db.prepare('DELETE FROM phone_challenges WHERE created_ts<?').run(Date.now() - DAY);
      db.prepare('DELETE FROM identity_tokens WHERE expires_ts<?').run(Date.now() - DAY);
      db.prepare('DELETE FROM sms_send_log WHERE ts<?').run(Date.now() - 7 * DAY);
      db.prepare('DELETE FROM identity_request_log WHERE ts<?').run(Date.now() - 7 * DAY);
      // Closed accounts past the record-keeping window: the remaining verification record goes too.
      db.prepare("DELETE FROM identity_profiles WHERE status='closed' AND retain_until IS NOT NULL AND retain_until<?").run(nowIso());
      compliance.purge(r);
      kyc.purge();
      docv.purge(r.documents_days);
    } catch (e) { console.error('identity retention', e.message); }
  }
  retention();
  timers.push(setInterval(retention, opt.retentionIntervalMs));
  for (const t of timers) t.unref?.();
  kyc.start();

  return {
    gate, settings, enforced, stateFor, kyc, compliance, oauth, webauthn, messaging, docv, statusOf, setAccountArea: (a) => { ctx.accountArea = a; },
    close: () => { for (const t of timers) clearInterval(t); kyc.stop(); webauthn.close?.(); oauth.close?.(); },
  };
}

module.exports = { mountIdentity, REASONS, DEFAULT_SETTINGS };
