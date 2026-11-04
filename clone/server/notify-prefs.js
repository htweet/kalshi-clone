'use strict';
// Notification preferences and delivery channels (PLAN P2.4 and §11 A6; CLONE_SPEC §13.7 call sites, §13.16 matrix;
// CLONE_SPEC.md §24.5).
//
// The matrix below is the observed Settings › Notifications list (groups, type names, which channel pills each type
// offers). Defaults, the ⌄ sub-options and the channels of rows whose pills were not listed are Parlance design
// choices. Every notification the server sends goes through features.notify(), which calls gate() here:
//   - mutes: a notification caused by someone the recipient muted is dropped;
//   - type × channel: in-app (inbox row + live toast), email (the dev mailbox `email_outbox`, no SMTP) and push (the
//     dev push outbox `notif_deliveries`, delivered live to the user's registered browsers, which show a browser
//     Notification when the user turned that on, and as real Web Push to every subscribed device, server/webpush.js);
//   - sub-options: trade confirmations every fill vs when the order completes, auto-cancel reasons, price-move
//     threshold / window, sports major-event moments;
//   - quiet hours: email and push are held (status `deferred`) until the window ends; in-app rows are stored
//     without a live toast.
// Types not in the matrix (RFQ, perps, announcements, badges, account notices) are always in-app only, as before.
const CS = require('./content/currency-strings'); // keyed user-facing wording (CLONE_SPEC.md §30)
const { tx } = require('./db');
const currency = require('./currency'); // display money in notifications (CLONE_SPEC.md §30)
const { nowIso, newId, ApiError, E } = require('./util');
const { bucket, limit, schemaGuard, iso, NICK, TICKER } = require('./community-util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notif_prefs (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, types TEXT NOT NULL DEFAULT '{}', quiet TEXT NOT NULL DEFAULT '{}',
  security INTEGER NOT NULL DEFAULT 1, pm_held INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notif_deliveries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, notification_id TEXT, type TEXT NOT NULL, pref TEXT,
  channel TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, devices INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL, send_after_ts INTEGER NOT NULL, sent_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_notif_deliveries_due ON notif_deliveries(status, send_after_ts);
CREATE INDEX IF NOT EXISTS idx_notif_deliveries_user ON notif_deliveries(user_id, created_ts);
CREATE TABLE IF NOT EXISTS push_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notif_order_done (order_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS price_move_subs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, market_ticker TEXT NOT NULL, threshold_cents INTEGER NOT NULL,
  window_minutes INTEGER NOT NULL, direction TEXT NOT NULL DEFAULT 'any', created_at TEXT NOT NULL, last_notified_ts INTEGER, last_notified_price INTEGER, last_move_cents INTEGER);
CREATE INDEX IF NOT EXISTS idx_price_move_market ON price_move_subs(market_ticker);
CREATE TABLE IF NOT EXISTS price_move_held (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, market_ticker TEXT NOT NULL, last_notified_ts INTEGER NOT NULL, PRIMARY KEY (user_id, market_ticker));
CREATE TABLE IF NOT EXISTS social_account_subs (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trades INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY (user_id, target_id));
`;

const CH = ['in_app', 'email', 'push'];
const ALL = { in_app: true, email: true, push: true };
const WINDOWS = [5, 15, 60, 240, 1440];
// [key, group, label, offered channels, defaults, fixed states of channels not offered, sub-option spec]
const TYPES = [
  ['transfers', 'general', 'Transfers', ['email', 'push'], { email: true, push: true }, { in_app: true }],
  ['referral_rewards', 'general', 'Referral rewards', CH, { in_app: true, email: true, push: true }],
  ['referral_activity', 'general', 'Referral activity', CH, { in_app: true, email: false, push: true }],
  ['market_rewards', 'general', 'Market rewards', CH, { in_app: true, email: true, push: true }],
  ['price_movement', 'predictions', 'Price movement', CH, { in_app: true, email: false, push: true }, null,
    { threshold_cents: { kind: 'int', min: 1, max: 50, def: 10, get label() { return CS.t('notify_prefs.price_move_threshold', { unit: currency.priceUnit() }); } },
      window_minutes: { kind: 'enum', values: WINDOWS, def: 60, label: 'Within' },
      held_markets: { kind: 'bool', def: false, label: 'Also alert on markets I hold' } }],
  ['market_settlement', 'predictions', 'Market settlement', ['email', 'push'], { email: true, push: true }, { in_app: true }],
  ['order_auto_cancel', 'predictions', 'Order auto-cancellation', CH, { in_app: true, email: false, push: true }, null,
    { expired: { kind: 'bool', def: true, label: 'Good-til-time orders that expire' }, market_closed: { kind: 'bool', def: true, label: 'Resting orders canceled when a market closes or reopens' } }],
  ['taker_trade', 'predictions', 'Taker-side trade confirmation', CH, { in_app: true, email: false, push: false }, null,
    { fills: { kind: 'enum', values: ['all', 'complete'], def: 'all', label: 'Confirm', labels: { all: 'Every fill, including partial fills', complete: 'Only when the order completes' } } }],
  ['maker_trade', 'predictions', 'Maker-side trade confirmation', CH, { in_app: true, email: false, push: true }, null,
    { fills: { kind: 'enum', values: ['all', 'complete'], def: 'all', label: 'Confirm', labels: { all: 'Every fill, including partial fills', complete: 'Only when the order completes' } } }],
  ['major_events', 'sports', 'Major events', ['in_app', 'push'], { in_app: true, push: true }, { email: false },
    { game_start: { kind: 'bool', def: true, label: 'Game starts' }, final: { kind: 'bool', def: true, label: 'Final score' },
      scope: { kind: 'enum', values: ['positions', 'watchlist'], def: 'positions', label: 'For games', labels: { positions: 'I have positions in', watchlist: 'I hold or watch' } } }],
  ['post_alerts', 'social', 'Post alerts', ['in_app', 'push'], { in_app: true, push: true }, { email: false }],
  ['trade_alerts', 'social', 'Trade alerts', ['in_app', 'push'], { in_app: true, push: false }, { email: false }],
  ['position_alerts', 'social', 'Position alerts', ['in_app', 'push'], { in_app: true, push: false }, { email: false }],
  ['social_engagement', 'social', 'Likes, comments & follows', ['in_app', 'push'], { in_app: true, push: true }, { email: false }],
  ['circle_requests', 'social', 'Inner Circle requests', ['in_app', 'push'], { in_app: true, push: true }, { email: false }],
  ['circle_accepted', 'social', 'Inner Circle accepted', ['in_app', 'push'], { in_app: true, push: true }, { email: false }],
  ['group_chats', 'social', 'Group chats', ['in_app', 'push'], { in_app: true, push: true }, { email: false }],
  ['leaderboard', 'social', 'Leaderboard', ['push'], { push: true }, { in_app: false, email: false }],
  ['breaking_events', 'promotional', 'Breaking events', CH, { in_app: true, email: false, push: false }],
  ['new_markets', 'promotional', 'New markets', CH, { in_app: true, email: false, push: false }],
  ['politics', 'promotional', 'Politics', CH, { in_app: true, email: false, push: false }],
  ['crypto', 'promotional', 'Crypto', ['in_app', 'push'], { in_app: true, push: false }, { email: false }],
  ['commodities', 'promotional', 'Commodities', ['in_app', 'push'], { in_app: true, push: false }, { email: false }],
];
const GROUPS = [['general', 'General'], ['predictions', 'Predictions'], ['sports', 'Sports'], ['social', 'Social'], ['promotional', 'Promotional']];
const TYPE = new Map(TYPES.map(([key, group, label, offered, def, fixed, options]) => [key, { key, group, label, offered, def, fixed: fixed || {}, options: options || null }]));
const PROMO_TOPICS = ['breaking_events', 'new_markets', 'politics', 'crypto', 'commodities'];

// Internal notification type (features.notify callers) → matrix row; null = always in-app, not configurable.
function prefKeyOf(type) {
  switch (type) {
    case 'fill': return 'fill'; // taker_trade / maker_trade, decided from meta.is_taker in gate()
    case 'settlement': return 'market_settlement';
    case 'price_target': case 'price_movement': return 'price_movement';
    case 'order_expired': case 'order_canceled_market': return 'order_auto_cancel';
    case 'transfer': case 'margin_transfer_completed': return 'transfers';
    case 'social_post': case 'social_topic': return 'post_alerts';
    case 'trade_alert': return 'trade_alerts';
    case 'position_alert': return 'position_alerts';
    case 'social_like': case 'social_comment': case 'social_follow': return 'social_engagement';
    case 'circle_request': return 'circle_requests';
    case 'circle_accepted': return 'circle_accepted';
    case 'group_chat': return 'group_chats';
    case 'leaderboard': return 'leaderboard';
    case 'sports_major': return 'major_events';
    case 'market_reward': return 'market_rewards'; // liquidity incentive payouts (Phase 5B, server/incentives.js)
    case 'security': case 'account': return 'security';
    default: return type && type.startsWith('promo_') && PROMO_TOPICS.includes(type.slice(6)) ? type.slice(6) : null;
  }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch { return false; } }
const minutesIn = (tz, ms) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return Number(parts.find((x) => x.type === 'hour').value) * 60 + Number(parts.find((x) => x.type === 'minute').value);
};
const toMin = (s) => { const m = HHMM.exec(s); return Number(m[1]) * 60 + Number(m[2]); };
function inQuiet(q, ms = Date.now()) {
  if (!q.enabled) return false;
  const now = minutesIn(q.timezone, ms); const a = toMin(q.start); const b = toMin(q.end);
  return a === b ? true : a < b ? now >= a && now < b : now >= a || now < b;
}
// Epoch ms when the current quiet window ends (next minute boundary at `end` in the user's zone).
const quietEndsAt = (q, ms = Date.now()) => { const d = (toMin(q.end) - minutesIn(q.timezone, ms) + 1440) % 1440 || 1440; return Math.floor(ms / 60000) * 60000 + d * 60000; };

function mountNotifyPrefs({ v1, app, db, engine, requireUser, rolesOf, can, getFeat, isMuted, webpush = null }) {
  db.exec(SCHEMA);
  // New-account default channels (Admin › Currency & defaults, CLONE_SPEC.md §30) switch a channel off on every row offering it.
  currency.hooks.channelTypes = () => TYPES.map(([key, , , offered]) => ({ key, offered }));
  const writes = bucket(30, 1); // preference / subscription writes per user
  const delivered = new Map(); // per-user push / email counters for the hourly cap
  const CAP_PER_HOUR = 120;

  v1.use(schemaGuard([
    ['PUT', /^\/users\/([^/]+)\/notifications\/preferences$/, { types: { type: 'object' }, quiet_hours: { type: 'object' }, security_notifications: { type: 'boolean' } }, { unknown: 'reject' }, 'owner'],
    ['PUT', /^\/users\/([^/]+)\/notifications\/settings\/[^/]+$/, { in_app: { type: 'boolean' }, email: { type: 'boolean' }, push: { type: 'boolean' }, options: { type: 'object' } }, { unknown: 'reject' }, 'owner'],
    ['POST', /^\/users\/([^/]+)\/notifications\/price_movement_subscriptions$/, { market_ticker: { type: 'string', maxLen: 64, required: true }, threshold_cents: { type: 'integer', min: 1, max: 99, required: true }, window_minutes: { type: 'integer', min: 1, max: 1440, required: true }, direction: { type: 'string', maxLen: 8 } }, { unknown: 'reject' }, 'owner'],
    ['POST', /^\/users\/([^/]+)\/notifications\/social_account_subscriptions$/, { nickname: { type: 'string', maxLen: 20, required: true } }, { unknown: 'reject' }, 'owner'],
    ['POST', /^\/users\/([^/]+)\/notifications\/push_devices$/, { label: { type: 'string', maxLen: 60 } }, { unknown: 'reject' }, 'owner'],
  ], { rolesOf }));

  // ---------------------------------------------------------------- preferences
  function rawPrefs(uid) {
    const r = db.prepare('SELECT * FROM notif_prefs WHERE user_id=?').get(uid);
    return { types: r ? JSON.parse(r.types) : {}, quiet: r ? JSON.parse(r.quiet) : {}, security: r ? !!r.security : true };
  }
  const optionDefaults = (t) => Object.fromEntries(Object.entries(t.options || {}).map(([k, s]) => [k, s.def]));
  function channelsOf(saved, t) {
    const s = saved[t.key] || {};
    const out = {};
    for (const c of CH) out[c] = t.offered.includes(c) ? (typeof s[c] === 'boolean' ? s[c] : !!t.def[c]) : !!t.fixed[c];
    return out;
  }
  function optionsOf(saved, t) { return { ...optionDefaults(t), ...((saved[t.key] || {}).options || {}) }; }
  const quietOf = (raw) => ({ enabled: !!raw.enabled, start: raw.start || '22:00', end: raw.end || '07:00', timezone: raw.timezone || 'UTC' });
  function prefsVo(uid) {
    const p = rawPrefs(uid);
    const q = quietOf(p.quiet);
    return {
      channels: CH,
      groups: GROUPS.map(([g, label]) => ({ key: g, label, types: TYPES.filter((x) => x[1] === g).map(([key]) => {
        const t = TYPE.get(key);
        return { type: key, label: t.label, offered: t.offered, channels: channelsOf(p.types, t), options: t.options ? optionsOf(p.types, t) : null,
          option_spec: t.options ? Object.entries(t.options).map(([k, s]) => ({ key: k, kind: s.kind, label: s.label, values: s.values || null, labels: s.labels || null, min: s.min ?? null, max: s.max ?? null, default: s.def })) : null };
      }) })),
      quiet_hours: q, in_quiet_hours: inQuiet(q), security_notifications: p.security,
      push_devices: db.prepare('SELECT COUNT(*) c FROM push_devices WHERE user_id=?').get(uid).c,
      web_push: webpush ? { public_key: webpush.publicKey(), devices: db.prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id=?').get(uid).c } : null,
    };
  }
  function parseOptions(t, v, cur) {
    if (!t.options) throw new ApiError(400, 'validation_failed', 'validation failed', `${t.key} has no sub-options`);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw E.badRequest(`types.${t.key}.options must be an object`);
    const out = { ...cur };
    for (const [k, val] of Object.entries(v)) {
      const s = t.options[k];
      if (!s) throw E.badRequest(`unknown option ${t.key}.${k}`);
      if (s.kind === 'bool' && typeof val !== 'boolean') throw E.badRequest(`${t.key}.${k} must be true or false`);
      if (s.kind === 'int' && (!Number.isInteger(val) || val < s.min || val > s.max)) throw E.badRequest(`${t.key}.${k} must be a whole number from ${s.min} to ${s.max}`);
      if (s.kind === 'enum' && !s.values.includes(val)) throw E.badRequest(`${t.key}.${k} must be one of ${s.values.join(', ')}`);
      out[k] = val;
    }
    return out;
  }
  function savePrefs(uid, b) {
    const p = rawPrefs(uid);
    const types = { ...p.types };
    let quiet = { ...p.quiet };
    let security = p.security;
    if (b.types !== undefined) {
      if (!b.types || typeof b.types !== 'object' || Array.isArray(b.types)) throw E.badRequest('types must be an object keyed by notification type');
      if (Object.keys(b.types).length > TYPES.length) throw E.badRequest('too many types');
      for (const [k, v] of Object.entries(b.types)) {
        const t = TYPE.get(k);
        if (!t) throw E.badRequest(`unknown notification type ${k}`);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw E.badRequest(`types.${k} must be an object`);
        const next = { ...(types[k] || {}) };
        for (const [ch, on] of Object.entries(v)) {
          if (ch === 'options') { next.options = parseOptions(t, on, optionsOf(types, t)); continue; }
          if (!CH.includes(ch)) throw E.badRequest(`types.${k}.${ch} is not a channel (in_app, email, push)`);
          if (typeof on !== 'boolean') throw E.badRequest(`types.${k}.${ch} must be true or false`);
          if (!t.offered.includes(ch)) throw new ApiError(400, 'channel_not_offered', `${t.label} notifications are not offered by ${ch === 'in_app' ? 'in-app' : ch}`);
          next[ch] = on;
        }
        types[k] = next;
      }
    }
    if (b.quiet_hours !== undefined) {
      const q = b.quiet_hours;
      if (!q || typeof q !== 'object' || Array.isArray(q)) throw E.badRequest('quiet_hours must be an object');
      for (const k of Object.keys(q)) if (!['enabled', 'start', 'end', 'timezone'].includes(k)) throw E.badRequest(`quiet_hours.${k} is not accepted`);
      if (q.enabled !== undefined) { if (typeof q.enabled !== 'boolean') throw E.badRequest('quiet_hours.enabled must be true or false'); quiet.enabled = q.enabled; }
      for (const k of ['start', 'end']) if (q[k] !== undefined) { if (typeof q[k] !== 'string' || !HHMM.test(q[k])) throw E.badRequest(`quiet_hours.${k} must be HH:MM (24-hour)`); quiet[k] = q[k]; }
      if (q.timezone !== undefined) { if (typeof q.timezone !== 'string' || q.timezone.length > 64 || !validTz(q.timezone)) throw E.badRequest('quiet_hours.timezone must be an IANA time zone such as Europe/London'); quiet.timezone = q.timezone; }
      quiet = quietOf(quiet);
      if (quiet.enabled && quiet.start === quiet.end) throw E.badRequest('quiet hours need different start and end times');
    }
    if (b.security_notifications !== undefined) { if (typeof b.security_notifications !== 'boolean') throw E.badRequest('security_notifications must be true or false'); security = b.security_notifications; }
    const pmHeld = optionsOf(types, TYPE.get('price_movement')).held_markets ? 1 : 0;
    db.prepare('INSERT INTO notif_prefs(user_id,types,quiet,security,pm_held,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET types=excluded.types, quiet=excluded.quiet, security=excluded.security, pm_held=excluded.pm_held, updated_at=excluded.updated_at')
      .run(uid, JSON.stringify(types), JSON.stringify(quiet), security ? 1 : 0, pmHeld, nowIso());
    // Quiet hours switched off (or moved so that now is outside them): held email / push go out on the next flush.
    if (b.quiet_hours !== undefined && !inQuiet(quietOf(quiet))) db.prepare("UPDATE notif_deliveries SET send_after_ts=? WHERE user_id=? AND status='deferred'").run(Date.now(), uid);
  }
  v1.get('/users/:uid/notifications/preferences', requireUser, (req, res) => res.json(prefsVo(req.auth.user.id)));
  v1.put('/users/:uid/notifications/preferences', requireUser, (req, res) => {
    limit(res, [[writes, req.auth.user.id]]);
    savePrefs(req.auth.user.id, req.body || {});
    res.json(prefsVo(req.auth.user.id));
  });
  // Observed call site users/{u}/notifications/settings/{t}: one type's channels and sub-options.
  v1.put('/users/:uid/notifications/settings/:type', requireUser, (req, res) => {
    if (!TYPE.has(req.params.type)) throw E.notFound();
    limit(res, [[writes, req.auth.user.id]]);
    savePrefs(req.auth.user.id, { types: { [req.params.type]: req.body || {} } });
    res.json(prefsVo(req.auth.user.id));
  });

  // ---------------------------------------------------------------- push devices ("this browser")
  const deviceVo = (d) => ({ id: d.id, label: d.label, created_time: d.created_at, last_seen_time: d.last_seen_at });
  v1.get('/users/:uid/notifications/push_devices', requireUser, (req, res) => {
    res.json({ devices: db.prepare('SELECT * FROM push_devices WHERE user_id=? ORDER BY created_at DESC').all(req.auth.user.id).map(deviceVo) });
  });
  v1.post('/users/:uid/notifications/push_devices', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limit(res, [[writes, uid]]);
    if (db.prepare('SELECT COUNT(*) c FROM push_devices WHERE user_id=?').get(uid).c >= 10) throw E.conflict('too_many_devices', 'at most 10 browsers can receive push notifications; remove one first');
    const raw = typeof req.body?.label === 'string' ? req.body.label : '';
    const label = raw.normalize('NFC').replace(/[^\p{L}\p{N} .,'()/-]/gu, '').trim().slice(0, 60) || 'This browser';
    const d = { id: newId('pd_'), label, at: nowIso() };
    db.prepare('INSERT INTO push_devices(id,user_id,label,created_at,last_seen_at) VALUES(?,?,?,?,?)').run(d.id, uid, d.label, d.at, d.at);
    res.status(201).json({ device: deviceVo(db.prepare('SELECT * FROM push_devices WHERE id=?').get(d.id)) });
  });
  v1.delete('/users/:uid/notifications/push_devices/:id', requireUser, (req, res) => {
    const r = db.prepare('DELETE FROM push_devices WHERE id=? AND user_id=?').run(String(req.params.id), req.auth.user.id);
    if (!r.changes) throw E.notFound();
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- deliveries (email / push outbox)
  const deliveryVo = (d) => ({ id: d.id, type: d.type, preference: d.pref, channel: d.channel, title: d.title, body: d.body, link: d.link, status: d.status, devices: d.devices,
    created_time: iso(d.created_ts), send_after_time: iso(d.send_after_ts), sent_time: iso(d.sent_ts) });
  v1.get('/users/:uid/notifications/deliveries', requireUser, (req, res) => {
    res.json({ deliveries: db.prepare('SELECT * FROM notif_deliveries WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 100').all(req.auth.user.id).map(deliveryVo) });
  });
  v1.get('/admin/notifications/deliveries', can('users.support'), (req, res) => {
    const ch = ['email', 'push'].includes(req.query.channel) ? req.query.channel : null;
    const rows = db.prepare(`SELECT d.*, u.email FROM notif_deliveries d JOIN users u ON u.id=d.user_id ${ch ? 'WHERE d.channel=?' : ''} ORDER BY d.created_ts DESC, d.rowid DESC LIMIT 200`).all(...(ch ? [ch] : []));
    res.json({ deliveries: rows.map((d) => ({ ...deliveryVo(d), user_email: d.email })) });
  });

  function send(d) {
    const now = Date.now();
    if (d.channel === 'email') {
      const u = db.prepare('SELECT id, email FROM users WHERE id=?').get(d.user_id);
      if (!u) return;
      // Email channel template + shared layout (CLONE_SPEC.md §32.5), rendered when the email is sent (a deferred one uses
      // the template published by then). Dev mailbox stub shared with the sign-in alerts (email_outbox, server/auth.js).
      const cms = app?.locals?.cms;
      const em = cms ? cms.renderNotificationEmail(d.type, { title: d.title, body: d.body, link: d.link }) : { subject: `Parlance: ${d.title}`, text: `${d.body}${d.link ? `\n\nOpen: ${d.link}` : ''}`, html: null };
      if (!db.prepare('PRAGMA table_info(email_outbox)').all().some((c) => c.name === 'html')) db.exec('ALTER TABLE email_outbox ADD COLUMN html TEXT');
      db.prepare('INSERT INTO email_outbox(id,user_id,to_email,subject,body,html,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(newId('em_'), u.id, u.email, String(em.subject).slice(0, 200), String(em.text).slice(0, 4000), em.html ? String(em.html).slice(0, 40000) : null, nowIso());
      db.prepare("UPDATE notif_deliveries SET status='sent', sent_ts=? WHERE id=?").run(now, d.id);
    } else {
      const devices = db.prepare('SELECT id FROM push_devices WHERE user_id=?').all(d.user_id).map((x) => x.id);
      // Push channel template (CLONE_SPEC.md §32.5): Web Push payloads and the in-browser push use the same text.
      const tpl = app?.locals?.cms ? app.locals.cms.renderNotification(d.type, { title: d.title, body: d.body, link: d.link }) : null;
      if (tpl) d = { ...d, title: String(tpl.push.title).slice(0, 200), body: String(tpl.push.body).slice(0, 1000) };
      // Web Push (server/webpush.js, CLONE_SPEC §31): one encrypted outbox row per subscribed browser, sent by its pump.
      const web = webpush ? webpush.enqueueUser(d.user_id, { id: d.id, pref: d.pref, title: d.title, body: d.body, link: d.link }) : 0;
      db.prepare('UPDATE notif_deliveries SET status=?, devices=?, sent_ts=? WHERE id=?').run(devices.length || web ? 'sent' : 'no_device', devices.length + web, now, d.id);
      if (devices.length) {
        db.prepare('UPDATE push_devices SET last_seen_at=? WHERE user_id=?').run(nowIso(), d.user_id);
        engine.emit('push', d.user_id, { id: d.id, type: d.type, title: d.title, body: d.body, link: d.link, devices });
      }
    }
  }
  function enqueue(uid, msg, pref, channel, quiet, q) {
    const now = Date.now();
    const hour = Math.floor(now / 3600000);
    const k = `${uid}:${channel}`;
    const c = delivered.get(k);
    const n = c && c.hour === hour ? c.n + 1 : 1;
    delivered.set(k, { hour, n });
    const status = n > CAP_PER_HOUR ? 'dropped_rate' : quiet ? 'deferred' : 'queued';
    const d = { id: newId('nd_'), user_id: uid, type: msg.type, pref, channel, title: String(msg.title).slice(0, 200), body: String(msg.body || '').slice(0, 1000), link: String(msg.link || '').slice(0, 300),
      status, created_ts: now, send_after_ts: quiet ? quietEndsAt(q, now) : now };
    db.prepare('INSERT INTO notif_deliveries(id,user_id,notification_id,type,pref,channel,title,body,link,status,devices,created_ts,send_after_ts,sent_ts) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,NULL)')
      .run(d.id, uid, null, d.type, pref, channel, d.title, d.body, d.link, d.status, d.created_ts, d.send_after_ts);
    if (status === 'queued') send(d);
  }
  function flush() {
    for (const d of db.prepare("SELECT * FROM notif_deliveries WHERE status='deferred' AND send_after_ts<=? ORDER BY created_ts LIMIT 200").all(Date.now())) send(d);
  }

  // ---------------------------------------------------------------- the gate (features.notify → hooks.notifyGate)
  const isSystem = (uid) => !!db.prepare('SELECT is_system FROM users WHERE id=?').get(uid)?.is_system;
  function gate(uid, msg) {
    if (msg.actor && isMuted(uid, msg.actor)) return { store: false };
    let key = prefKeyOf(msg.type);
    if (key === null) return { store: true };
    const p = rawPrefs(uid);
    const q = quietOf(p.quiet);
    const quiet = inQuiet(q);
    if (key === 'security') {
      // Account protection: always in the inbox (sign-in alerts also email from server/auth.js); the Settings toggle
      // "Security notifications" adds push for every sensitive action.
      if (p.security) enqueue(uid, msg, 'security', 'push', false, q);
      return { store: true };
    }
    const meta = msg.meta || {};
    let title = null;
    if (key === 'fill') {
      key = meta.is_taker === false ? 'maker_trade' : 'taker_trade';
      const opts = optionsOf(p.types, TYPE.get(key));
      if (opts.fills === 'complete' && meta.order_id) {
        const o = db.prepare('SELECT status, filled_count, side, market_ticker FROM orders WHERE id=?').get(meta.order_id);
        if (!o || o.status === 'resting') return { store: false };
        if (!db.prepare('INSERT INTO notif_order_done(order_id,user_id,created_ts) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(meta.order_id, uid, Date.now()).changes) return { store: false };
        const f = db.prepare('SELECT COALESCE(SUM(count),0) n, COALESCE(SUM(count*price_cc),0)/100 v FROM fills WHERE order_id=? AND user_id=?').get(meta.order_id, uid);
        title = CS.t('notify.order_done.title', { verb: o.status === 'executed' ? 'filled' : 'completed', count: (f.n / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }), side: String(o.side).toUpperCase(), price: currency.priceCents(f.n ? Math.round(f.v / f.n) : 0) });
      }
    }
    const t = TYPE.get(key);
    if (!t) return { store: true };
    const opts = optionsOf(p.types, t);
    if (key === 'order_auto_cancel' && ((msg.type === 'order_expired' && !opts.expired) || (msg.type === 'order_canceled_market' && !opts.market_closed))) return { store: false };
    const ch = channelsOf(p.types, t);
    const out = title ? { ...msg, title } : msg;
    if (ch.email) enqueue(uid, out, key, 'email', quiet, q);
    if (ch.push) enqueue(uid, out, key, 'push', quiet, q);
    return { store: ch.in_app, quiet, title };
  }

  // ---------------------------------------------------------------- producers that need no shared-file edits
  // Transfers: a 201 from the deposit / withdrawal routes (response decorator; the money routes are unchanged).
  v1.use((req, res, next) => {
    const m = req.method === 'POST' && /^\/users\/[^/]+\/(deposits|withdrawals)$/.exec(req.path);
    // A payment-rail request (method_id) notifies when the provider confirms it (server/payments.js), not on 201.
    if (!m || !req.auth || (req.body && req.body.method_id)) return next();
    const json = res.json.bind(res);
    res.json = (body) => {
      try {
        const amt = Number(req.body?.amount_dollars);
        if (res.statusCode === 201 && Number.isFinite(amt)) {
          getFeat().notify(req.auth.user.id, { type: 'transfer', title: CS.t('notify.transfer.title', { kind: m[1] === 'deposits' ? 'Deposit' : 'Withdrawal', amount: currency.moneyDollars(amt) }), body: CS.t('notify.transfer.body', { amount: currency.moneyDollars(body?.balance_dollars || 0) }), link: '/portfolio' });
        }
      } catch (e) { console.error('transfer notify', e); }
      return json(body);
    };
    next();
  });
  // Resting orders canceled by a market closing or reopening (engine.cancelAllResting leaves cancel_reason empty and is
  // followed synchronously by the lifecycle event of that market).
  const canceledNow = new Map(); // ticker -> [{uid, order, ts}]
  engine.on('user_order', (uid, o) => {
    if (o && o.status === 'canceled' && !o.cancel_reason && !isSystem(uid)) {
      const a = canceledNow.get(o.market_ticker) || [];
      a.push({ uid, o, ts: Date.now() });
      canceledNow.set(o.market_ticker, a);
    }
  });
  engine.on('lifecycle', (ticker, eventType) => {
    const list = canceledNow.get(ticker);
    canceledNow.delete(ticker);
    if (!list || !['close_date_updated', 'activated'].includes(eventType)) return;
    const title = db.prepare('SELECT title FROM markets WHERE ticker=?').get(ticker)?.title || ticker;
    for (const { uid, o, ts } of list) {
      if (Date.now() - ts > 2000) continue;
      try { getFeat().notify(uid, { type: 'order_canceled_market', title: `Resting order canceled: market ${eventType === 'activated' ? 'reopened' : 'closed'} (${(o.remaining_count / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} unfilled released)`, body: title, link: '/portfolio?tab=orders' }); } catch (e) { console.error('auto-cancel notify', e); }
    }
  });

  // ---------------------------------------------------------------- price-movement subscriptions (spec §13.7)
  const marketInfo = (t) => db.prepare('SELECT m.ticker, m.title, m.yes_sub_title, m.event_ticker, e.title et FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.ticker=?').get(t);
  const subVo = (s) => { const m = marketInfo(s.market_ticker); return { id: s.id, market_ticker: s.market_ticker, market_title: m ? (m.title || m.et) : s.market_ticker, outcome: m ? m.yes_sub_title : '', threshold_cents: s.threshold_cents, window_minutes: s.window_minutes, direction: s.direction, created_time: s.created_at, last_notified_time: iso(s.last_notified_ts), last_move_cents: s.last_move_cents, link: m ? getFeat().eventLink(s.market_ticker) : null }; };
  v1.get('/users/:uid/notifications/price_movement_subscriptions', requireUser, (req, res) => {
    const args = [req.auth.user.id]; let extra = '';
    if (req.query.market_ticker) { extra = ' AND market_ticker=?'; args.push(String(req.query.market_ticker)); }
    res.json({ subscriptions: db.prepare(`SELECT * FROM price_move_subs WHERE user_id=?${extra} ORDER BY created_at DESC`).all(...args).map(subVo) });
  });
  v1.post('/users/:uid/notifications/price_movement_subscriptions', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limit(res, [[writes, uid]]);
    const b = req.body || {};
    const t = typeof b.market_ticker === 'string' ? b.market_ticker.toUpperCase() : '';
    if (!TICKER.test(t)) throw E.badRequest('market_ticker is required');
    if (!marketInfo(t)) throw E.notFound();
    const th = b.threshold_cents;
    if (!Number.isInteger(th) || th < 1 || th > 99) throw E.badRequest('threshold_cents must be a whole number of cents from 1 to 99');
    if (!WINDOWS.includes(b.window_minutes)) throw E.badRequest(`window_minutes must be one of ${WINDOWS.join(', ')}`);
    const dir = b.direction ?? 'any';
    if (!['any', 'up', 'down'].includes(dir)) throw E.badRequest('direction must be any, up or down');
    if (db.prepare('SELECT COUNT(*) c FROM price_move_subs WHERE user_id=?').get(uid).c >= 50) throw E.conflict('too_many_subscriptions', 'at most 50 price-movement alerts');
    if (db.prepare('SELECT 1 FROM price_move_subs WHERE user_id=? AND market_ticker=? AND threshold_cents=? AND window_minutes=? AND direction=?').get(uid, t, th, b.window_minutes, dir)) throw E.conflict('subscription_exists', 'you already have this alert');
    const id = newId('pm_');
    db.prepare('INSERT INTO price_move_subs(id,user_id,market_ticker,threshold_cents,window_minutes,direction,created_at) VALUES(?,?,?,?,?,?,?)').run(id, uid, t, th, b.window_minutes, dir, nowIso());
    res.status(201).json({ subscription: subVo(db.prepare('SELECT * FROM price_move_subs WHERE id=?').get(id)) });
  });
  v1.delete('/users/:uid/notifications/price_movement_subscriptions', requireUser, (req, res) => {
    limit(res, [[writes, req.auth.user.id]]);
    const r = db.prepare('DELETE FROM price_move_subs WHERE id=? AND user_id=?').run(String(req.query.id || ''), req.auth.user.id);
    if (!r.changes) throw E.notFound();
    res.json({ ok: true });
  });
  // Reference price = last trade at or before (now − window), else the first trade inside the window. Fires when
  // |last − reference| ≥ threshold in the chosen direction, at most once per window (persisted, restart-safe).
  const refPrice = (ticker, sinceMs) => db.prepare('SELECT yes_price_cents p FROM trades WHERE market_ticker=? AND created_ts<=? ORDER BY created_ts DESC, rowid DESC LIMIT 1').get(ticker, sinceMs)
    || db.prepare('SELECT yes_price_cents p FROM trades WHERE market_ticker=? AND created_ts>? ORDER BY created_ts, rowid LIMIT 1').get(ticker, sinceMs);
  const fmtWin = (min) => (min >= 60 ? `${min / 60} h` : `${min} min`);
  const moveTitle = (m, ticker, move, min, last) => CS.t('notify.price_move.title', { market: m ? m.yes_sub_title : ticker, arrow: move > 0 ? '▲' : '▼', move: currency.priceCents(Math.abs(move)), window: fmtWin(min), price: currency.priceCents(last) });
  engine.on('ticker', (ticker, qq) => {
    if (qq.last_price == null) return;
    try {
      const now = Date.now();
      const m = marketInfo(ticker);
      for (const s of db.prepare('SELECT * FROM price_move_subs WHERE market_ticker=?').all(ticker)) {
        const winMs = s.window_minutes * 60000;
        if (s.last_notified_ts && now - s.last_notified_ts < winMs) continue;
        const ref = refPrice(ticker, now - winMs);
        if (!ref) continue;
        const move = qq.last_price - ref.p;
        if (Math.abs(move) < s.threshold_cents || (s.direction === 'up' && move <= 0) || (s.direction === 'down' && move >= 0)) continue;
        db.prepare('UPDATE price_move_subs SET last_notified_ts=?, last_notified_price=?, last_move_cents=? WHERE id=?').run(now, qq.last_price, move, s.id);
        getFeat().notify(s.user_id, { type: 'price_movement', title: moveTitle(m, ticker, move, s.window_minutes, qq.last_price), body: m ? (m.title || m.et) : ticker, link: getFeat().eventLink(ticker) });
      }
      // "Also alert on markets I hold" (Price movement ⌄): the user's own threshold and window.
      const holders = db.prepare('SELECT p.user_id, n.types FROM positions p JOIN notif_prefs n ON n.user_id=p.user_id WHERE p.market_ticker=? AND (p.yes_count>0 OR p.no_count>0) AND n.pm_held=1').all(ticker);
      for (const h of holders) {
        const o = optionsOf(JSON.parse(h.types), TYPE.get('price_movement'));
        const winMs = o.window_minutes * 60000;
        const last = db.prepare('SELECT last_notified_ts FROM price_move_held WHERE user_id=? AND market_ticker=?').get(h.user_id, ticker);
        if (last && now - last.last_notified_ts < winMs) continue;
        const ref = refPrice(ticker, now - winMs);
        if (!ref || Math.abs(qq.last_price - ref.p) < o.threshold_cents) continue;
        db.prepare('INSERT INTO price_move_held(user_id,market_ticker,last_notified_ts) VALUES(?,?,?) ON CONFLICT(user_id,market_ticker) DO UPDATE SET last_notified_ts=excluded.last_notified_ts').run(h.user_id, ticker, now);
        getFeat().notify(h.user_id, { type: 'price_movement', title: moveTitle(m, ticker, qq.last_price - ref.p, o.window_minutes, qq.last_price), body: `${m ? (m.title || m.et) : ticker} · a market you hold`, link: getFeat().eventLink(ticker) });
      }
    } catch (e) { if (!/database is not open/i.test(String(e && e.message))) console.error('price movement', e); }
  });

  // ---------------------------------------------------------------- social account subscriptions (spec §13.7)
  // Trade alerts are opt-in per followed trader (the bell on a profile); post and position alerts reach all followers.
  const byNick = (n) => db.prepare('SELECT * FROM social_profiles WHERE nickname=?').get(String(n || ''));
  v1.get('/users/:uid/notifications/social_account_subscriptions', requireUser, (req, res) => {
    const rows = db.prepare('SELECT s.*, sp.nickname FROM social_account_subs s JOIN social_profiles sp ON sp.user_id=s.target_id WHERE s.user_id=? ORDER BY s.created_at DESC').all(req.auth.user.id);
    res.json({ subscriptions: rows.map((r) => ({ nickname: r.nickname, trades: !!r.trades, created_time: r.created_at })) });
  });
  v1.post('/users/:uid/notifications/social_account_subscriptions', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limit(res, [[writes, uid]]);
    const nick = req.body?.nickname;
    if (typeof nick !== 'string' || !NICK.test(nick)) throw E.badRequest('nickname is required');
    const t = byNick(nick);
    if (!t || t.user_id === uid) throw E.notFound();
    if (!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?').get(uid, t.user_id)) throw E.conflict('not_following', 'follow this trader first to get their trade alerts');
    if (db.prepare('SELECT COUNT(*) c FROM social_account_subs WHERE user_id=?').get(uid).c >= 200) throw E.conflict('too_many_subscriptions', 'at most 200 trade-alert subscriptions');
    db.prepare('INSERT INTO social_account_subs(user_id,target_id,trades,created_at) VALUES(?,?,1,?) ON CONFLICT DO NOTHING').run(uid, t.user_id, nowIso());
    res.status(201).json({ subscription: { nickname: t.nickname, trades: true } });
  });
  v1.delete('/users/:uid/notifications/social_account_subscriptions', requireUser, (req, res) => {
    limit(res, [[writes, req.auth.user.id]]);
    const t = byNick(req.query.nickname);
    if (!t) throw E.notFound();
    db.prepare('DELETE FROM social_account_subs WHERE user_id=? AND target_id=?').run(req.auth.user.id, t.user_id);
    res.json({ ok: true });
  });
  // Unfollowing ends the trade-alert subscription too (app level: runs ahead of the features.js follow route).
  app.use('/v1', (req, res, next) => {
    if (req.method === 'DELETE' && req.auth && /^\/users\/[^/]+\/social\/follow$/.test(req.path)) {
      const t = byNick(req.query.nickname);
      if (t) res.on('finish', () => { if (res.statusCode < 400) { try { db.prepare('DELETE FROM social_account_subs WHERE user_id=? AND target_id=?').run(req.auth.user.id, t.user_id); } catch { /* closed */ } } });
    }
    next();
  });

  // ---------------------------------------------------------------- sports major events (live_data transitions)
  // First observation of a game sets its baseline (no alert); later scheduled→live and →final transitions notify the
  // users with positions in (or, by preference, watching) the game's event.
  const gameStatus = new Map();
  engine.on('live_data', (id, msg) => {
    try {
      if (!msg || !msg.event_ticker) return;
      const st = msg.status === 'complete' ? 'final' : msg.status;
      const prev = gameStatus.get(id);
      gameStatus.set(id, st);
      if (!prev || prev === st || !['live', 'final'].includes(st)) return;
      const which = st === 'live' ? 'game_start' : 'final';
      const holders = new Set(db.prepare('SELECT DISTINCT p.user_id FROM positions p JOIN markets m ON m.ticker=p.market_ticker WHERE m.event_ticker=? AND (p.yes_count>0 OR p.no_count>0)').all(msg.event_ticker).map((r) => r.user_id));
      const watchers = new Set(db.prepare('SELECT user_id FROM watchlist WHERE event_ticker=?').all(msg.event_ticker).map((r) => r.user_id));
      const d = msg.details || {};
      const score = d.home_score != null && d.away_score != null ? ` ${d.home_score}-${d.away_score}` : '';
      const title = st === 'live' ? `Game started: ${msg.title || msg.event_ticker}` : `Final${score}: ${msg.title || msg.event_ticker}`;
      for (const uid of new Set([...holders, ...watchers])) {
        if (isSystem(uid)) continue;
        const o = optionsOf(rawPrefs(uid).types, TYPE.get('major_events'));
        if (!o[which]) continue;
        if (!holders.has(uid) && o.scope !== 'watchlist') continue;
        getFeat().notify(uid, { type: 'sports_major', title, body: msg.live_label || '', link: getFeat().eventLink(msg.event_ticker) });
      }
    } catch (e) { if (!/database is not open/i.test(String(e && e.message))) console.error('sports major events', e); }
  });

  let lastFlush = 0; let lastPrune = Date.now();
  engine.on('tick', () => {
    const now = Date.now();
    try {
      if (now - lastFlush >= 1000) { lastFlush = now; flush(); }
      if (now - lastPrune > 60000) {
        lastPrune = now; writes.prune();
        for (const [k, v] of canceledNow) if (!v.length || now - v[v.length - 1].ts > 5000) canceledNow.delete(k);
        db.prepare('DELETE FROM notif_order_done WHERE created_ts<?').run(now - 7 * 86400000);
      }
    } catch (e) { if (!/database is not open/i.test(String(e && e.message))) console.error('notify flush', e); }
  });
  void tx;

  return { gate, prefsVo, prefKeyOf, inQuiet, TYPES, GROUPS, flush };
}

module.exports = { mountNotifyPrefs, TYPES, GROUPS, prefKeyOf, inQuiet, quietEndsAt, PROMO_TOPICS };
