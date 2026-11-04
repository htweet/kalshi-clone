'use strict';
// Web Push for the notification matrix's Push channel (CLONE_SPEC.md §31.5). node:crypto only, no dependency.
//
//   VAPID (RFC 8292)        one P-256 key pair per deployment, generated on first start. The private key is stored
//                           AES-256-GCM encrypted (server/crypto.js, sub-key "web-push:v1", AAD bound to the row); the
//                           public key is published at GET /v1/push/vapid_public_key. Every request carries
//                           `Authorization: vapid t=<ES256 JWT {aud: push-service origin, exp ≤ 12 h, sub}>, k=<key>`.
//   Encryption (RFC 8291)   aes128gcm (RFC 8188): ephemeral ECDH P-256 with the browser's p256dh key, HKDF with its
//                           auth secret, one record, padded to a 128-byte boundary so the length leaks less.
//   Subscriptions           one row per browser (`push_subscriptions`): endpoint and keys encrypted at rest, a SHA-256
//                           of the endpoint for lookups. HTTPS endpoints on known push services only (SSRF guard); an
//                           explicit test allowlist (`push.insecureEndpointHosts`) is refused in production.
//   Outbox                  `push_outbox` rows (payload encrypted at rest) are sent by a pump on the engine tick:
//                           201/202 → sent; 404/410 → the subscription is deleted; 429/5xx/network → retried with
//                           exponential backoff (Retry-After honoured) up to `maxAttempts`, then failed; other 4xx →
//                           failed. Rows caught mid-send by a restart go back to pending (at-least-once; the
//                           notification tag is the delivery id, so a duplicate replaces rather than stacks).
// The payload is exactly what the in-app notification shows: title, body, same-origin deep link, a tag and a time.
const crypto = require('node:crypto');
const net = require('node:net');
const kc = require('./crypto');
const { newId, nowIso, ApiError, E } = require('./util');
const { bucket, limit } = require('./community-util');
const content = require('./content/pwa'); // keyed user-facing text (CMS-ready, CLONE_SPEC §31.12)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_vapid (id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, private_enc TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint_hash TEXT NOT NULL UNIQUE,
  endpoint_enc TEXT NOT NULL, keys_enc TEXT NOT NULL, service TEXT NOT NULL, label TEXT NOT NULL, expires_ts INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_success_ts INTEGER, last_failure_ts INTEGER, failures INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS push_outbox (id TEXT PRIMARY KEY, sub_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, delivery_id TEXT,
  payload_enc TEXT NOT NULL, ttl INTEGER NOT NULL, urgency TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ts INTEGER NOT NULL,
  last_status INTEGER, last_error TEXT, created_ts INTEGER NOT NULL, sent_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_push_outbox_due ON push_outbox(status, next_attempt_ts);
CREATE INDEX IF NOT EXISTS idx_push_outbox_sub ON push_outbox(sub_id, status);
`;

// Push services of the browsers in use (host or parent domain). PUSH_ALLOWED_HOSTS adds more (comma-separated).
const DEFAULT_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
const SERVICE_NAMES = [['googleapis.com', 'Chrome / Android (FCM)'], ['mozilla.com', 'Firefox (Mozilla)'], ['apple.com', 'Safari (Apple)'], ['windows.com', 'Edge (Windows)']];
const MAX_PER_USER = 10;
const RS = 4096; // record size; one record holds the whole payload
const MAX_PLAINTEXT = 3000; // well under RS - 16 (tag) - 1 (delimiter) after padding
const b64u = (b) => Buffer.from(b).toString('base64url');
const B64U = /^[A-Za-z0-9_-]+={0,2}$/;

// ------------------------------------------------------------------------------------------------ RFC 8291 / 8188
// Encrypt `plaintext` (Buffer) for a subscription's p256dh / auth keys (base64url). Returns the aes128gcm body.
function encryptPayload(plaintext, p256dh, auth) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // 65 bytes, uncompressed
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const padded = Math.min(RS - 17, Math.ceil((plaintext.length + 1) / 128) * 128);
  const record = Buffer.alloc(Math.max(padded, plaintext.length + 1)); // zero-filled padding after the delimiter
  plaintext.copy(record, 0);
  record[plaintext.length] = 0x02; // last-record delimiter
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(record), c.final(), c.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RS, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ct]);
}

// The inverse (used by the tests' fake push service and kept here so both sides share one definition of the format).
function decryptPayload(body, uaPrivate, uaPublic, auth) {
  const salt = body.subarray(0, 16); const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const rec = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = rec.length - 1;
  while (end >= 0 && rec[end] === 0) end--;
  if (end < 0 || rec[end] !== 0x02) throw new Error('bad padding delimiter');
  return rec.subarray(0, end);
}

// ------------------------------------------------------------------------------------------------ module
function mountWebPush({ v1, db, engine, requireUser, keyDir, options = {}, template = null }) {
  db.exec(SCHEMA);
  const production = process.env.NODE_ENV === 'production';
  const encKey = kc.deriveKey('web-push:v1', { dir: keyDir });
  const subject = String(options.subject || process.env.VAPID_SUBJECT || 'mailto:push@parlance.invalid');
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) throw new Error('VAPID_SUBJECT must be a mailto: address or an https: URL');
  const extra = String(process.env.PUSH_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowedHosts = (options.allowedHosts || [...DEFAULT_HOSTS, ...extra]).map((h) => String(h).toLowerCase());
  const insecure = new Set((options.insecureEndpointHosts || []).map((h) => String(h).toLowerCase()));
  if (insecure.size && production) throw new Error('push.insecureEndpointHosts is a test-only option and is refused when NODE_ENV=production');
  const retryBaseMs = Math.max(10, Number(options.retryBaseMs) || 30000);
  const maxAttempts = Math.max(1, Math.min(20, Number(options.maxAttempts) || 8));
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 10000);
  const writes = bucket(20, 0.5); // subscription writes per user
  const tests = bucket(5, 1 / 30); // test notifications per user

  // ---------------------------------------------------------------- VAPID keys
  function rawPublic(jwk) { return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]); }
  function generateVapid() {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    const pub = b64u(rawPublic(jwk));
    db.prepare('INSERT INTO push_vapid(id,public_key,private_enc,created_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key, private_enc=excluded.private_enc, created_at=excluded.created_at')
      .run(pub, kc.encrypt(JSON.stringify(jwk), 'push_vapid.private:1', encKey), nowIso());
    return { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), publicKey: pub };
  }
  function loadVapid() {
    const row = db.prepare('SELECT * FROM push_vapid WHERE id=1').get();
    if (!row) return generateVapid();
    try {
      const jwk = JSON.parse(kc.decrypt(row.private_enc, 'push_vapid.private:1', encKey));
      return { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), publicKey: row.public_key };
    } catch {
      // The server key changed: the old VAPID key is unreadable, and every subscription is bound to it.
      console.error('web push: the stored VAPID key cannot be decrypted with this server key; a new key was generated and existing push subscriptions were removed');
      db.prepare('DELETE FROM push_subscriptions').run();
      return generateVapid();
    }
  }
  const vapid = loadVapid();
  const jwtCache = new Map(); // audience -> { exp, header }
  function vapidAuthorization(endpoint) {
    const aud = new URL(endpoint).origin;
    const now = Math.floor(Date.now() / 1000);
    const hit = jwtCache.get(aud);
    if (hit && hit.exp - now > 3600) return hit.header;
    const exp = now + 12 * 3600;
    const signing = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud, exp, sub: subject }))}`;
    const sig = crypto.sign('sha256', Buffer.from(signing), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
    const header = `vapid t=${signing}.${b64u(sig)}, k=${vapid.publicKey}`;
    jwtCache.set(aud, { exp, header });
    return header;
  }

  // ---------------------------------------------------------------- validation
  const bad = (field, why) => new ApiError(400, 'validation_failed', 'validation failed', `${field}: ${why}`);
  function checkEndpoint(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 2048) throw bad('endpoint', 'must be a URL of at most 2048 characters');
    let u; try { u = new URL(raw); } catch { throw bad('endpoint', 'must be a URL'); }
    if (u.username || u.password || u.hash) throw bad('endpoint', 'must not contain credentials or a fragment');
    if (insecure.has(u.host.toLowerCase())) { if (!/^https?:$/.test(u.protocol)) throw bad('endpoint', 'must be http(s)'); return u; }
    if (u.protocol !== 'https:') throw bad('endpoint', 'must be an https URL');
    if (u.port && u.port !== '443') throw bad('endpoint', 'must use the default https port');
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    if (net.isIP(h.replace(/^\[|\]$/g, '')) || h === 'localhost') throw bad('endpoint', 'must be a push service host name');
    if (!allowedHosts.some((s) => h === s || h.endsWith(`.${s}`))) throw new ApiError(400, 'push_service_not_supported', content.s('push.error_service_unsupported'), h);
    return u;
  }
  function checkKeys(keys) {
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw bad('keys', 'must be an object with p256dh and auth');
    const { p256dh, auth } = keys;
    if (typeof p256dh !== 'string' || p256dh.length > 128 || !B64U.test(p256dh)) throw bad('keys.p256dh', 'must be base64url');
    if (typeof auth !== 'string' || auth.length > 64 || !B64U.test(auth)) throw bad('keys.auth', 'must be base64url');
    const pk = Buffer.from(p256dh, 'base64url'); const as = Buffer.from(auth, 'base64url');
    if (pk.length !== 65 || pk[0] !== 4) throw bad('keys.p256dh', 'must be an uncompressed P-256 public key');
    try { const e = crypto.createECDH('prime256v1'); e.generateKeys(); e.computeSecret(pk); } catch { throw bad('keys.p256dh', 'is not a point on P-256'); }
    if (as.length !== 16) throw bad('keys.auth', 'must be 16 bytes');
    return { p256dh: b64u(pk), auth: b64u(as) };
  }
  const cleanLabel = (raw) => (typeof raw === 'string' ? raw : '').normalize('NFC').replace(/[^\p{L}\p{N} .,'()/-]/gu, '').trim().slice(0, 60) || 'This device';
  const serviceOf = (u) => { const h = u.hostname.toLowerCase(); return (SERVICE_NAMES.find(([d]) => h === d || h.endsWith(`.${d}`)) || [null, h])[1]; };
  const hashOf = (endpoint) => crypto.createHmac('sha256', encKey).update(endpoint).digest('hex');

  // ---------------------------------------------------------------- subscriptions
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  const subVo = (s) => ({ id: s.id, label: s.label, service: s.service, created_time: s.created_at, updated_time: s.updated_at, last_success_time: iso(s.last_success_ts),
    last_failure_time: iso(s.last_failure_ts), failures: s.failures, expires_time: iso(s.expires_ts) });
  const secretsOf = (s) => ({ endpoint: kc.decrypt(s.endpoint_enc, `push_subscriptions.endpoint:${s.id}`, encKey), keys: JSON.parse(kc.decrypt(s.keys_enc, `push_subscriptions.keys:${s.id}`, encKey)) });
  function removeSub(id, reason) {
    db.prepare("UPDATE push_outbox SET status='gone', last_error=? WHERE sub_id=? AND status IN ('pending','sending')").run(reason, id);
    return db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(id).changes;
  }

  v1.get('/push/vapid_public_key', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.json({ public_key: vapid.publicKey }); });

  v1.get('/users/:uid/push_subscriptions', requireUser, (req, res) => {
    res.json({ subscriptions: db.prepare('SELECT * FROM push_subscriptions WHERE user_id=? ORDER BY created_at DESC, rowid DESC').all(req.auth.user.id).map(subVo) });
  });
  v1.post('/users/:uid/push_subscriptions', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limit(res, [[writes, uid]]);
    const b = req.body || {};
    const u = checkEndpoint(b.endpoint);
    const keys = checkKeys(b.keys);
    const exp = b.expiration_time == null ? null : Number(b.expiration_time);
    if (exp != null && (!Number.isFinite(exp) || exp < Date.now())) throw bad('expiration_time', 'must be a future time in epoch milliseconds or null');
    const endpoint = u.href;
    const h = hashOf(endpoint);
    const label = cleanLabel(b.label);
    const at = nowIso();
    const existing = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint_hash=?').get(h);
    if (existing) {
      // The same browser subscribed again (keys rotated, or another account signed in on it): the row moves to this
      // account and anything still queued for the previous owner is dropped.
      if (existing.user_id !== uid) db.prepare("UPDATE push_outbox SET status='gone', last_error='resubscribed' WHERE sub_id=? AND status IN ('pending','sending')").run(existing.id);
      db.prepare('UPDATE push_subscriptions SET user_id=?, keys_enc=?, label=?, expires_ts=?, updated_at=?, failures=0 WHERE id=?')
        .run(uid, kc.encrypt(JSON.stringify(keys), `push_subscriptions.keys:${existing.id}`, encKey), label, exp, at, existing.id);
      return res.status(200).json({ subscription: subVo(db.prepare('SELECT * FROM push_subscriptions WHERE id=?').get(existing.id)) });
    }
    if (db.prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id=?').get(uid).c >= MAX_PER_USER) throw E.conflict('too_many_devices', content.s('push.error_too_many_devices', { max: MAX_PER_USER }));
    const id = newId('ps_');
    db.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint_hash,endpoint_enc,keys_enc,service,label,expires_ts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, uid, h, kc.encrypt(endpoint, `push_subscriptions.endpoint:${id}`, encKey), kc.encrypt(JSON.stringify(keys), `push_subscriptions.keys:${id}`, encKey), serviceOf(u), label, exp, at, at);
    res.status(201).json({ subscription: subVo(db.prepare('SELECT * FROM push_subscriptions WHERE id=?').get(id)) });
  });
  // This browser unsubscribes itself (sign-out, "Turn off on this device"): identified by its endpoint.
  v1.delete('/users/:uid/push_subscriptions', requireUser, (req, res) => {
    limit(res, [[writes, req.auth.user.id]]);
    const ep = req.body && req.body.endpoint;
    if (typeof ep !== 'string' || !ep || ep.length > 2048) throw bad('endpoint', 'is required');
    let href; try { href = new URL(ep).href; } catch { throw bad('endpoint', 'must be a URL'); }
    const s = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint_hash=? AND user_id=?').get(hashOf(href), req.auth.user.id);
    if (!s) throw E.notFound();
    removeSub(s.id, 'unsubscribed');
    res.json({ ok: true });
  });
  v1.delete('/users/:uid/push_subscriptions/:id', requireUser, (req, res) => {
    limit(res, [[writes, req.auth.user.id]]);
    const s = db.prepare('SELECT id FROM push_subscriptions WHERE id=? AND user_id=?').get(String(req.params.id), req.auth.user.id);
    if (!s) throw E.notFound();
    removeSub(s.id, 'removed');
    res.json({ ok: true });
  });
  v1.post('/users/:uid/push_subscriptions/:id/test', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const s = db.prepare('SELECT id FROM push_subscriptions WHERE id=? AND user_id=?').get(String(req.params.id), uid);
    if (!s) throw E.notFound();
    limit(res, [[tests, uid]]);
    const tp = template ? template('push.test', {}) : null; // template push.test (Admin › Content › Templates, CLONE_SPEC.md §32.5)
    const id = enqueue(s.id, uid, null, { title: tp ? tp.push_title : 'Test notification', body: tp ? tp.push_body : '', link: content.s('push.test_link') }, 'normal', 600);
    pumpSoon();
    res.status(202).json({ queued: true, id });
  });

  // ---------------------------------------------------------------- outbox
  function payloadOf(msg, tag) {
    const p = { title: String(msg.title || content.PWA_CONFIG.short_name).slice(0, 120), body: String(msg.body || '').slice(0, 300), link: /^\/(?!\/)/.test(String(msg.link || '')) ? String(msg.link).slice(0, 300) : '/', tag, ts: Date.now() };
    while (Buffer.byteLength(JSON.stringify(p)) > MAX_PLAINTEXT && p.body) p.body = p.body.slice(0, Math.floor(p.body.length / 2));
    return JSON.stringify(p);
  }
  function enqueue(subId, uid, deliveryId, msg, urgency, ttl) {
    const id = newId('po_');
    db.prepare("INSERT INTO push_outbox(id,sub_id,user_id,delivery_id,payload_enc,ttl,urgency,status,attempts,next_attempt_ts,created_ts) VALUES(?,?,?,?,?,?,?,'pending',0,?,?)")
      .run(id, subId, uid, deliveryId, kc.encrypt(payloadOf(msg, deliveryId || id), `push_outbox:${id}`, encKey), ttl, urgency, Date.now(), Date.now());
    return id;
  }
  const PROMO = new Set(['breaking_events', 'new_markets', 'politics', 'crypto', 'commodities']);
  // From server/notify-prefs.js send(): one outbox row per subscribed browser of the user. Returns the count.
  function enqueueUser(uid, msg) {
    const subs = db.prepare('SELECT id FROM push_subscriptions WHERE user_id=?').all(uid);
    const urgency = msg.pref === 'security' ? 'high' : PROMO.has(msg.pref) ? 'low' : 'normal';
    const ttl = msg.pref === 'security' ? 86400 : PROMO.has(msg.pref) ? 3600 : 43200;
    for (const s of subs) enqueue(s.id, uid, msg.id || null, msg, urgency, ttl);
    if (subs.length) pumpSoon();
    return subs.length;
  }

  const backoff = (attempts) => Math.min(3600000, retryBaseMs * 2 ** Math.max(0, attempts - 1)) * (0.8 + Math.random() * 0.4);
  const retryAfterMs = (h) => { if (!h) return 0; const n = Number(h); if (Number.isFinite(n)) return Math.min(3600000, n * 1000); const t = Date.parse(h); return Number.isFinite(t) ? Math.min(3600000, Math.max(0, t - Date.now())) : 0; };
  function settle(row, outcome) {
    const now = Date.now();
    const { status, http = null, error = null, retryAfter = 0 } = outcome;
    if (status === 'retry') {
      if (row.attempts >= maxAttempts) {
        db.prepare("UPDATE push_outbox SET status='failed', last_status=?, last_error=? WHERE id=?").run(http, error, row.id);
      } else {
        db.prepare("UPDATE push_outbox SET status='pending', next_attempt_ts=?, last_status=?, last_error=? WHERE id=?").run(now + Math.max(retryAfter, backoff(row.attempts)), http, error, row.id);
      }
      db.prepare('UPDATE push_subscriptions SET failures=failures+1, last_failure_ts=? WHERE id=?').run(now, row.sub_id);
    } else if (status === 'sent') {
      db.prepare("UPDATE push_outbox SET status='sent', sent_ts=?, last_status=?, last_error=NULL WHERE id=?").run(now, http, row.id);
      db.prepare('UPDATE push_subscriptions SET failures=0, last_success_ts=? WHERE id=?').run(now, row.sub_id);
    } else if (status === 'gone') {
      db.prepare("UPDATE push_outbox SET status='gone', last_status=?, last_error=? WHERE id=?").run(http, error, row.id);
      removeSub(row.sub_id, error || 'gone');
    } else {
      db.prepare('UPDATE push_outbox SET status=?, last_status=?, last_error=? WHERE id=?').run(status, http, error, row.id);
      if (status === 'failed') db.prepare('UPDATE push_subscriptions SET failures=failures+1, last_failure_ts=? WHERE id=?').run(now, row.sub_id);
    }
  }
  async function deliver(row) {
    const sub = db.prepare('SELECT * FROM push_subscriptions WHERE id=?').get(row.sub_id);
    if (!sub) return settle(row, { status: 'gone', error: 'subscription removed' });
    if (sub.expires_ts && sub.expires_ts < Date.now()) return settle(row, { status: 'gone', error: 'subscription expired' });
    const left = row.ttl - Math.floor((Date.now() - row.created_ts) / 1000);
    if (left <= 0) return settle(row, { status: 'expired', error: 'ttl elapsed before delivery' });
    let endpoint; let keys; let body;
    try {
      ({ endpoint, keys } = secretsOf(sub));
      checkEndpoint(endpoint);
      body = encryptPayload(Buffer.from(kc.decrypt(row.payload_enc, `push_outbox:${row.id}`, encKey), 'utf8'), keys.p256dh, keys.auth);
    } catch (e) { return settle(row, { status: 'failed', error: String(e.code || e.message || e).slice(0, 120) }); }
    let r;
    try {
      r = await fetch(endpoint, {
        method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { TTL: String(left), Urgency: row.urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuthorization(endpoint) },
      });
      await r.arrayBuffer().catch(() => null);
    } catch (e) {
      if (closed) return undefined;
      return settle(row, { status: 'retry', error: `network: ${String(e.cause?.code || e.name || 'error').slice(0, 60)}` });
    }
    if (closed) return undefined;
    if (r.status >= 200 && r.status < 300) return settle(row, { status: 'sent', http: r.status });
    if (r.status === 404 || r.status === 410) return settle(row, { status: 'gone', http: r.status, error: 'push service reports the subscription is gone' });
    if (r.status === 429 || r.status >= 500) return settle(row, { status: 'retry', http: r.status, error: `push service ${r.status}`, retryAfter: retryAfterMs(r.headers.get('retry-after')) });
    return settle(row, { status: 'failed', http: r.status, error: `push service ${r.status}` });
  }

  let busy = false; let closed = false; let again = false;
  async function pump() {
    if (busy) { again = true; return; }
    if (closed) return;
    busy = true;
    try {
      do {
        again = false;
        const rows = db.prepare("SELECT * FROM push_outbox WHERE status='pending' AND next_attempt_ts<=? ORDER BY next_attempt_ts, rowid LIMIT 25").all(Date.now());
        const claimed = rows.filter((r) => db.prepare("UPDATE push_outbox SET status='sending', attempts=attempts+1 WHERE id=? AND status='pending'").run(r.id).changes)
          .map((r) => ({ ...r, attempts: r.attempts + 1 }));
        await Promise.all(claimed.map((r) => deliver(r).catch((e) => { if (!closed) console.error('web push delivery', e); })));
        if (rows.length === 25) again = true;
      } while (again && !closed);
    } catch (e) {
      if (!closed && !/database is not open/i.test(String(e && e.message))) console.error('web push pump', e);
    } finally { busy = false; }
  }
  const pumpSoon = () => setImmediate(() => { pump(); });

  // Resume after a restart: rows that were mid-send go back to the queue.
  db.prepare("UPDATE push_outbox SET status='pending' WHERE status='sending'").run();
  let lastPrune = 0;
  const onTick = () => {
    if (closed) return;
    pump();
    const now = Date.now();
    if (now - lastPrune > 60000) {
      lastPrune = now;
      try { writes.prune(); tests.prune(); db.prepare("DELETE FROM push_outbox WHERE status IN ('sent','failed','gone','expired') AND created_ts<?").run(now - 7 * 86400000); } catch { /* closing */ }
    }
  };
  engine.on('tick', () => { if (engine.flags && !(engine.flags.jobOn('notify.push') && engine.flags.jobOn('pwa.push'))) return; onTick(); }); // paused while a push flag is off (§33)

  return {
    enqueueUser, pump, publicKey: () => vapid.publicKey, subject: () => subject,
    close() { closed = true; engine.off?.('tick', onTick); },
  };
}

module.exports = { mountWebPush, encryptPayload, decryptPayload, DEFAULT_HOSTS };
