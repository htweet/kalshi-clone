'use strict';
// Built for Nigerian networks and phones (PLAN P8.6, CLONE_SPEC.md §38.7). Flags `data_saver` and `sms` (off).
//
//   data saver   a member setting (`data_saver` in user_settings; guests keep it in their browser) with an admin default
//                (owner setting `data_saver.default_on`, off). On: lighter images (no promo art, small media variants),
//                fewer live updates (price ticks batched every 10 s instead of every message), polling instead of the
//                WebSocket when the connection is unstable, no autoplay (the elections timeline never starts by itself).
//                The client does the work (public/js/datasaver.js); the server stores the choice.
//   SMS          a notification channel through a provider adapter interface ({ name, send({to, body}) }). Only the
//                simulated adapter exists: it writes to the development SMS outbox (server/messaging.js), never to a network.
//                Behind the flag `sms` (off by default: no real provider is contracted, owner decision 2026-11-08). Members
//                opt in from Settings with a verified phone number and an explicit consent (wording version and hash
//                recorded, NDPA 2023); opting out always works, whatever the flags. Money, security, fills and price-alert
//                notices are queued in a persisted outbox (resumes after a restart) and sent at most `sms.per_user_per_day`
//                (owner setting, 10) per member per 24 hours, the rest marked `skipped_cap`; the message is the CMS template
//                `sms.notification`.
const crypto = require('node:crypto');
const { newId, nowIso, ApiError, E } = require('./util');
const { check } = require('./validate');
const { s: GS } = require('./content/growth');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sms_consents (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, enabled INTEGER NOT NULL, consent_ts INTEGER, consent_version TEXT, consent_text_sha256 TEXT, updated_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sms_notify_outbox (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, notification_id TEXT, type TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL, provider TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL, sent_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_sms_notify_status ON sms_notify_outbox(status, created_ts);
CREATE INDEX IF NOT EXISTS idx_sms_notify_user ON sms_notify_outbox(user_id, sent_ts);
`;
// Notification types that may go out by SMS: money, security, account, fills and price alerts (never social or marketing).
const SMS_TYPES = new Set(['security', 'account', 'money_controls', 'fill', 'price_movement', 'price_target', 'trade_alert', 'referral_reward', 'reward', 'bonus_credited', 'deposit', 'withdrawal', 'withdrawal_hold', 'settlement']);
const DAY = 86400000;

function mountReach({ v1, db, engine, auth, admin, flags, feat, cms, identity, options = {} }) {
  db.exec(SCHEMA);
  const OS = engine.ownerSettings;
  const requireOwner = (req, res, next) => { if (!req.auth) return next(E.unauthorized()); if (req.params.uid !== req.auth.user.id) return next(E.forbidden('cannot access another user')); next(); };
  const setting = (uid, key) => { const r = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(uid, key); try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
  const putSetting = (uid, key, v) => db.prepare('INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(uid, key, JSON.stringify(v), nowIso());
  const dataSaverOf = (uid) => { const v = setting(uid, 'data_saver'); return typeof v === 'boolean' ? v : !!OS.get('data_saver.default_on'); };
  const phoneOf = (uid) => (identity && identity.phoneOf ? identity.phoneOf(uid) : null);
  function consentWording() {
    const text = GS('sms.consent');
    const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    let v = 0; try { v = cms.store.get('text', 'server.growth.sms.consent').published_version || 0; } catch { /* default wording */ }
    return { text, sha256: sha, version: `cms${v}-${sha.slice(0, 12)}` };
  }
  const consentRow = (uid) => db.prepare('SELECT * FROM sms_consents WHERE user_id=?').get(uid);
  const sentToday = (uid) => db.prepare("SELECT COUNT(*) c FROM sms_notify_outbox WHERE user_id=? AND status='sent' AND sent_ts>?").get(uid, Date.now() - DAY).c;
  const reachVo = (req) => {
    const uid = req.auth.user.id; const c = consentRow(uid); const w = consentWording();
    return { data_saver: dataSaverOf(uid), data_saver_default: !!OS.get('data_saver.default_on'), data_saver_available: flags.on('data_saver', { req }),
      sms: { available: flags.on('sms', { req }), enabled: !!(c && c.enabled), phone_verified: !!phoneOf(uid), consent: { text: w.text, version: w.version }, consent_time: c && c.consent_ts ? new Date(c.consent_ts).toISOString() : null, per_day: OS.get('sms.per_user_per_day'), sent_24h: sentToday(uid) } };
  };
  v1.get('/users/:uid/reach', requireOwner, (req, res) => res.json({ reach: reachVo(req) }));
  v1.put('/users/:uid/data_saver', requireOwner, (req, res) => {
    const b = check(req.body || {}, { enabled: { type: 'boolean', required: true } }, { unknown: 'reject' });
    putSetting(req.auth.user.id, 'data_saver', b.enabled);
    res.json({ reach: reachVo(req) });
  });
  v1.put('/users/:uid/sms_notifications', requireOwner, (req, res) => {
    const b = check(req.body || {}, { enabled: { type: 'boolean', required: true }, consent_version: { type: 'string', maxLen: 80 } }, { unknown: 'reject' });
    const uid = req.auth.user.id; const now = Date.now();
    if (b.enabled) {
      if (!phoneOf(uid)) throw E.conflict('sms_phone_required', GS('error.sms_phone'));
      const w = consentWording();
      if (b.consent_version !== w.version) throw new ApiError(409, 'consent_changed', GS('error.sms_consent_changed'));
      db.prepare('INSERT INTO sms_consents(user_id,enabled,consent_ts,consent_version,consent_text_sha256,updated_ts) VALUES(?,1,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=1, consent_ts=excluded.consent_ts, consent_version=excluded.consent_version, consent_text_sha256=excluded.consent_text_sha256, updated_ts=excluded.updated_ts')
        .run(uid, now, w.version, w.sha256, now);
    } else {
      // Opting out always works (no flag, no phone needed); the consent record stays with its time for the audit trail.
      db.prepare('INSERT INTO sms_consents(user_id,enabled,updated_ts) VALUES(?,0,?) ON CONFLICT(user_id) DO UPDATE SET enabled=0, updated_ts=excluded.updated_ts').run(uid, now);
      db.prepare("UPDATE sms_notify_outbox SET status='skipped_opt_out' WHERE user_id=? AND status='queued'").run(uid);
    }
    res.json({ reach: reachVo(req) });
  });

  // ---------------------------------------------------------------- provider adapters
  // A real provider later implements the same interface. The simulated one writes to the development SMS outbox only.
  const PROVIDERS = {
    simulated: { name: 'simulated', send: async ({ uid, to, body }) => { await identity.messaging.sendSms({ userId: uid, to, masked: `${'•'.repeat(6)}${String(to).slice(-4)}`, body, kind: 'notification' }); return { ok: true }; } },
  };
  const provider = PROVIDERS[options.provider || 'simulated'];

  // ---------------------------------------------------------------- queue: every stored notification of an SMS type
  engine.on('notification', (uid, n) => {
    try {
      if (!n || !SMS_TYPES.has(n.type) || !flags.jobOn('sms')) return;
      const c = consentRow(uid);
      if (!c || !c.enabled || !flags.on('sms', { uid })) return;
      let body = `${n.title}. ${n.body || ''}`.trim();
      try { body = cms.renderSystem('sms.notification', { title: n.title || '', body: n.body || '' }).sms; } catch { /* template missing: plain text */ }
      db.prepare("INSERT INTO sms_notify_outbox(id,user_id,notification_id,type,body,status,created_ts) VALUES(?,?,?,?,?,'queued',?)").run(newId('smsn_'), uid, n.id || null, n.type, String(body).slice(0, 480), Date.now());
    } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('sms queue', e.message); }
  });
  let busy = false;
  async function pump() {
    if (busy || !flags.jobOn('sms')) return; // paused while off: queued messages wait (nothing is lost)
    busy = true;
    try {
      for (const m of db.prepare("SELECT * FROM sms_notify_outbox WHERE status='queued' ORDER BY created_ts LIMIT 50").all()) {
        const c = consentRow(m.user_id); const to = phoneOf(m.user_id);
        const mark = (status) => db.prepare('UPDATE sms_notify_outbox SET status=?, provider=?, attempts=attempts+1, sent_ts=? WHERE id=?').run(status, provider.name, status === 'sent' ? Date.now() : null, m.id);
        if (!c || !c.enabled) { mark('skipped_opt_out'); continue; }
        if (!to) { mark('skipped_no_phone'); continue; }
        if (sentToday(m.user_id) >= OS.get('sms.per_user_per_day')) { mark('skipped_cap'); continue; } // abuse and cost limit
        try { const r = await provider.send({ uid: m.user_id, to, body: m.body }); mark(r && r.ok ? 'sent' : 'failed'); } catch (e) { console.error('sms send', e.message); mark('failed'); }
      }
    } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('sms pump', e.message); } finally { busy = false; }
  }
  engine.on('tick', () => { pump(); });

  // ---------------------------------------------------------------- admin
  v1.get('/admin/sms/outbox', admin.can('users.support'), (req, res) => {
    const email = (id) => db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || id;
    res.json({ provider: provider.name, flag_on: flags.jobOn('sms'), per_user_per_day: OS.get('sms.per_user_per_day'),
      counts: Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM sms_notify_outbox GROUP BY status').all().map((r) => [r.status, r.n])),
      opted_in: db.prepare('SELECT COUNT(*) c FROM sms_consents WHERE enabled=1').get().c,
      messages: db.prepare('SELECT * FROM sms_notify_outbox ORDER BY created_ts DESC LIMIT 100').all().map((m) => ({ id: m.id, user: email(m.user_id), type: m.type, status: m.status, provider: m.provider, created_time: new Date(m.created_ts).toISOString(), sent_time: m.sent_ts ? new Date(m.sent_ts).toISOString() : null })) });
  });
  void auth; void feat;
  return { dataSaverOf, PROVIDERS, pump, SMS_TYPES };
}

module.exports = { mountReach, SMS_TYPES };
