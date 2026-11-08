'use strict';
// Waitlists (PLAN Phase 7A, CLONE_SPEC.md §36). One reusable module; a list is a key:
//   perps               access by invitation to Perps (Phase 6, §34.9): signed-in users only, waiting → approved /
//                       revoked by staff; the gate and the grandfathering stay in server/perps-ops.js, the rows live here.
//   real_money_launch   the real-money launch waitlist: demand while the exchange runs on play money. Signed-in users join
//                       with one click; guests by email with double opt-in (a single-use, expiring confirmation link,
//                       stored only as a SHA-256 hash). pending → confirmed → unsubscribed.
// Privacy (Nigeria Data Protection Act 2023): every join records its consent (time, wording version and hash, source, a
// keyed hash of the IP address); guest emails are encrypted at rest (AES-256-GCM bound to the row) with a keyed HMAC for
// dedupe and lookups; every email carries a one-click unsubscribe link (and a List-Unsubscribe / List-Unsubscribe-Post
// header pair, RFC 8058); members can leave and delete their data, and the account data export and closure include it.
// Join responses never say whether an email is already on the list (no enumeration); the guest form is rate limited per
// IP and per email, needs the signed client token like every /v1 write (the bot challenge) and has a honeypot field.
// One click is for accounts whose email is verified; an unverified account's join is a confirmation request like a
// guest's (the same link to the account email, the same non-enumerating reply), linked to the account only when the
// link is confirmed. A guest entry links to an account with the same email only once that account's email is verified
// (on verification, or on confirmation), and then its encrypted copy is dropped.
//
// Opinion survey: questions are CMS entries of type `survey` (drafts, publish with reason, versions, rollback, audit;
// defaults in server/content/waitlists.js): single choice, multiple choice, naira band and free text (length-capped,
// stripped of markup and control characters, flagged for moderation). Answers can be edited until the launch (the
// production switch locks them); admins see aggregates, and free text only in a moderated list without identities.
// Newsletter: the CMS template email.waitlist_newsletter (preview and test send), sent now or scheduled through a
// persisted, throttled outbox that resumes after a restart; unconfirmed and unsubscribed members are skipped and counted.
// Target: an admin-set target N (reason, audited); reaching it alerts the admins once (in-app and email) and shows on
// Admin › Play mode. Nothing switches automatically: going live stays the two-person RESET production switch, which
// keeps every waitlist row and offers (never sends by itself) the "We're live with real money" email.
const crypto = require('node:crypto');
const { tx } = require('./db');
const { newId, nowIso, ApiError, E } = require('./util');
const kc = require('./crypto');
const C = require('./currency');
const templates = require('./cms/templates');
const { esc } = require('./cms/sanitize');
const { createLimiter } = require('./content-rate');
const { check: checkBody } = require('./validate');
const { s: WS, SURVEY_DEFAULTS, BLOCKED_WORDS } = require('./content/waitlists');

const DAY = 86400000;
const LAUNCH = 'real_money_launch';
const LISTS = { perps: { guests: false, public: false }, [LAUNCH]: { guests: true, public: true } };
const SOURCES = ['banner', 'funds', 'home', 'direct', 'email', 'social', 'referral', 'other'];
const KINDS = ['single', 'multi', 'naira_band', 'text'];
const SCHEMA = `
CREATE TABLE IF NOT EXISTS waitlist_entries (id TEXT PRIMARY KEY, list_key TEXT NOT NULL, user_id TEXT, email_enc TEXT, email_hash TEXT, status TEXT NOT NULL,
  joined_ts INTEGER NOT NULL, confirmed_ts INTEGER, unsubscribed_ts INTEGER, decided_ts INTEGER, decided_by TEXT, note TEXT,
  source TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, ref_code TEXT,
  consent_ts INTEGER, consent_version TEXT, consent_text_sha256 TEXT, consent_source TEXT, consent_ip_hash TEXT, updated_ts INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_waitlist_entries_user ON waitlist_entries(list_key, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_waitlist_entries_email ON waitlist_entries(list_key, email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_waitlist_entries_status ON waitlist_entries(list_key, status, joined_ts);
CREATE TABLE IF NOT EXISTS waitlist_tokens (hash TEXT PRIMARY KEY, entry_id TEXT NOT NULL, purpose TEXT NOT NULL, expires_ts INTEGER NOT NULL, used_ts INTEGER, created_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_waitlist_tokens_entry ON waitlist_tokens(entry_id);
CREATE TABLE IF NOT EXISTS waitlist_survey_answers (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, list_key TEXT NOT NULL, question_key TEXT NOT NULL, value_json TEXT NOT NULL,
  moderation TEXT, flag_reason TEXT, updated_ts INTEGER NOT NULL, UNIQUE (entry_id, question_key));
CREATE INDEX IF NOT EXISTS idx_waitlist_answers_list ON waitlist_survey_answers(list_key, question_key);
CREATE TABLE IF NOT EXISTS waitlist_newsletters (id TEXT PRIMARY KEY, list_key TEXT NOT NULL, kind TEXT NOT NULL, template_key TEXT NOT NULL, template_json TEXT, subject TEXT NOT NULL,
  status TEXT NOT NULL, scheduled_ts INTEGER, origin TEXT NOT NULL, reason TEXT NOT NULL, created_by TEXT, created_ts INTEGER NOT NULL, started_ts INTEGER, finished_ts INTEGER, canceled_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_waitlist_newsletters_status ON waitlist_newsletters(status, scheduled_ts);
CREATE TABLE IF NOT EXISTS waitlist_newsletter_outbox (newsletter_id TEXT NOT NULL, entry_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL,
  PRIMARY KEY (newsletter_id, entry_id));
CREATE INDEX IF NOT EXISTS idx_waitlist_outbox_status ON waitlist_newsletter_outbox(newsletter_id, status);
`;

// The Phase 6 table perp_waitlist moves into waitlist_entries (list 'perps'); a read-only view keeps its old shape.
function migratePerps(db) {
  const t = db.prepare("SELECT type FROM sqlite_master WHERE name='perp_waitlist'").get();
  if (t && t.type === 'table') {
    tx(db, () => {
      const ins = db.prepare("INSERT INTO waitlist_entries(id,list_key,user_id,status,joined_ts,decided_ts,decided_by,note,source,updated_ts) VALUES(?,'perps',?,?,?,?,?,?,'perps',?) ON CONFLICT DO NOTHING");
      for (const r of db.prepare('SELECT * FROM perp_waitlist').all()) ins.run(newId('wl_'), r.user_id, r.status, r.joined_ts, r.decided_ts, r.decided_by, r.note, Date.now());
      db.exec('DROP INDEX IF EXISTS idx_perp_waitlist; DROP TABLE perp_waitlist;');
    });
  }
  db.exec("CREATE VIEW IF NOT EXISTS perp_waitlist AS SELECT user_id, status, joined_ts, decided_ts, decided_by, note FROM waitlist_entries WHERE list_key='perps'");
}

// One registration per process for the shared account-created hook; each call is routed to its database's instance.
const INSTANCES = new WeakMap();
let hookInstalled = false;

// ------------------------------------------------------------------------------------------------ storage
function createWaitlists({ db, keyDir }) {
  db.exec(SCHEMA);
  migratePerps(db);
  // The account that asked for a confirmation link (an unverified one-click join): confirming links that account.
  if (!db.prepare('PRAGMA table_info(waitlist_tokens)').all().some((c) => c.name === 'user_id')) db.exec('ALTER TABLE waitlist_tokens ADD COLUMN user_id TEXT');
  const keys = {
    enc: kc.deriveKey('waitlist-email:v1', { dir: keyDir }),
    hash: kc.deriveKey('waitlist-email-hash:v1', { dir: keyDir }),
    tok: kc.deriveKey('waitlist-token:v1', { dir: keyDir }),
    ip: kc.deriveKey('waitlist-ip:v1', { dir: keyDir }),
  };
  const norm = (e) => String(e || '').trim().toLowerCase();
  const emailHash = (e) => kc.hmacHex(keys.hash, norm(e));
  const ipHash = (ip) => kc.hmacHex(keys.ip, String(ip || '')).slice(0, 32);
  const encEmail = (id, e) => kc.encrypt(norm(e), `waitlist.email:${id}`, keys.enc);
  const decEmail = (r) => { if (!r || !r.email_enc) return null; try { return kc.decrypt(r.email_enc, `waitlist.email:${r.id}`, keys.enc); } catch { return null; } };
  // Manage / unsubscribe token: "<entry id>.<HMAC>", derived (never stored); it dies with the entry.
  const manageToken = (id) => `${id}.${crypto.createHmac('sha256', keys.tok).update(`manage:${id}`).digest('base64url').slice(0, 32)}`;
  function entryOfToken(token) {
    const s = String(token || '');
    if (s.length > 120) return null;
    const i = s.lastIndexOf('.');
    if (i < 4) return null;
    const id = s.slice(0, i);
    if (!/^wl_[A-Za-z0-9_-]{4,60}$/.test(id) || !kc.safeEqual(s, manageToken(id))) return null;
    return db.prepare('SELECT * FROM waitlist_entries WHERE id=?').get(id) || null;
  }
  const entry = (id) => db.prepare('SELECT * FROM waitlist_entries WHERE id=?').get(id);
  const entryOfUser = (list, uid) => db.prepare('SELECT * FROM waitlist_entries WHERE list_key=? AND user_id=?').get(list, uid);
  const entryOfEmail = (list, email) => db.prepare('SELECT * FROM waitlist_entries WHERE list_key=? AND email_hash=?').get(list, emailHash(email));
  const recipientOf = (e) => (e.user_id ? db.prepare('SELECT email FROM users WHERE id=?').get(e.user_id)?.email || null : decEmail(e));
  function deleteEntry(id) {
    db.prepare('DELETE FROM waitlist_survey_answers WHERE entry_id=?').run(id);
    db.prepare('DELETE FROM waitlist_tokens WHERE entry_id=?').run(id);
    db.prepare('DELETE FROM waitlist_newsletter_outbox WHERE entry_id=?').run(id);
    return db.prepare('DELETE FROM waitlist_entries WHERE id=?').run(id).changes;
  }

  // ---- the Perps list (server/perps-ops.js): same rows, same ordering as the Phase 6 table
  const PCOLS = 'user_id, status, joined_ts, decided_ts, decided_by, note';
  const perps = {
    row: (uid) => db.prepare(`SELECT ${PCOLS} FROM waitlist_entries WHERE list_key='perps' AND user_id=?`).get(uid),
    count: (status) => db.prepare("SELECT COUNT(*) c FROM waitlist_entries WHERE list_key='perps' AND status=?").get(status).c,
    position(uid) {
      const r = perps.row(uid);
      if (!r || r.status !== 'waiting') return null;
      return db.prepare("SELECT COUNT(*) c FROM waitlist_entries WHERE list_key='perps' AND status='waiting' AND (joined_ts<? OR (joined_ts=? AND user_id<=?))").get(r.joined_ts, r.joined_ts, uid).c;
    },
    insertIfAbsent(uid, { status, joinedTs, decidedTs = null, note = null }) {
      return db.prepare("INSERT INTO waitlist_entries(id,list_key,user_id,status,joined_ts,decided_ts,note,source,updated_ts) VALUES(?,'perps',?,?,?,?,?,'perps',?) ON CONFLICT DO NOTHING")
        .run(newId('wl_'), uid, status, joinedTs, decidedTs, note, Date.now()).changes;
    },
    decide(uid, { status, joinedTs, decidedTs, decidedBy, note }) {
      const cur = perps.row(uid);
      if (cur) db.prepare("UPDATE waitlist_entries SET status=?, decided_ts=?, decided_by=?, note=?, updated_ts=? WHERE list_key='perps' AND user_id=?").run(status, decidedTs, decidedBy, note, Date.now(), uid);
      else db.prepare("INSERT INTO waitlist_entries(id,list_key,user_id,status,joined_ts,decided_ts,decided_by,note,source,updated_ts) VALUES(?,'perps',?,?,?,?,?,?,'perps',?)").run(newId('wl_'), uid, status, joinedTs, decidedTs, decidedBy, note, Date.now());
    },
    adminRows(status) {
      const where = status ? 'AND w.status=?' : '';
      return db.prepare(`SELECT w.user_id, w.status, w.joined_ts, w.decided_ts, w.decided_by, w.note, u.email, u.display_name FROM waitlist_entries w JOIN users u ON u.id=w.user_id WHERE w.list_key='perps' ${where} ORDER BY CASE w.status WHEN 'waiting' THEN 0 ELSE 1 END, w.joined_ts, w.user_id LIMIT 500`).all(...(status ? [status] : []));
    },
    counts: () => Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM waitlist_entries WHERE list_key='perps' GROUP BY status").all().map((r) => [r.status, r.n])),
    nextWaiting: (n) => db.prepare("SELECT user_id FROM waitlist_entries WHERE list_key='perps' AND status='waiting' ORDER BY joined_ts, user_id LIMIT ?").all(n).map((r) => r.user_id),
  };

  // ---- linking: a guest entry joins the account with the same email once that email is verified (server/identity.js);
  // an unverified sign-up proves nothing about the inbox, so it never takes over someone's entry.
  const emailVerified = (uid) => {
    try { return !!db.prepare('SELECT email_verified_at v FROM identity_profiles WHERE user_id=?').get(uid)?.v; } catch { return false; } // no identity module: unverified
  };
  function linkUser(uid) {
    const u = db.prepare('SELECT id, email, is_system FROM users WHERE id=?').get(uid);
    if (!u || u.is_system || !emailVerified(uid)) return 0;
    let n = 0;
    for (const e of db.prepare('SELECT * FROM waitlist_entries WHERE email_hash=? AND user_id IS NULL').all(emailHash(u.email))) {
      if (entryOfUser(e.list_key, uid)) continue;
      db.prepare('UPDATE waitlist_entries SET user_id=?, email_enc=NULL, updated_ts=? WHERE id=?').run(uid, Date.now(), e.id); // the account email is the contact now
      n += 1;
    }
    return n;
  }
  // ---- privacy: account data export and closure (server/identity.js)
  function exportFor(uid) {
    const rows = db.prepare('SELECT * FROM waitlist_entries WHERE user_id=? ORDER BY joined_ts').all(uid);
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    return rows.map((e) => ({
      list: e.list_key, status: e.status, joined_time: iso(e.joined_ts), confirmed_time: iso(e.confirmed_ts), unsubscribed_time: iso(e.unsubscribed_ts), decided_time: iso(e.decided_ts),
      source: e.source, utm_source: e.utm_source, utm_medium: e.utm_medium, utm_campaign: e.utm_campaign, ref_code: e.ref_code,
      consent: e.consent_ts ? { time: iso(e.consent_ts), version: e.consent_version, text_sha256: e.consent_text_sha256, source: e.consent_source, ip_hash: e.consent_ip_hash } : null,
      survey_answers: db.prepare('SELECT question_key, value_json, updated_ts FROM waitlist_survey_answers WHERE entry_id=? ORDER BY question_key').all(e.id).map((a) => ({ question: a.question_key, answer: JSON.parse(a.value_json), updated_time: iso(a.updated_ts) })),
    }));
  }
  function forgetUser(uid) {
    let n = 0;
    for (const e of db.prepare('SELECT id FROM waitlist_entries WHERE user_id=?').all(uid)) n += deleteEntry(e.id);
    return n;
  }
  // The account email was just verified (POST /verify_email): link entries with that email, then the hooks (the
  // auto-confirm switch of mountWaitlists, the referral attribution of server/growth.js).
  const hooks = { verified: [] };
  function emailVerifiedNow(uid) {
    const n = linkUser(uid);
    for (const h of hooks.verified) { try { h(uid); } catch (e) { console.error('waitlist verified hook', e.message); } }
    return n;
  }
  const api = { db, emailHash, ipHash, encEmail, decEmail, manageToken, entryOfToken, entry, entryOfUser, entryOfEmail, recipientOf, deleteEntry, perps, linkUser, emailVerified, emailVerifiedNow, hooks, exportFor, forgetUser, norm };
  INSTANCES.set(db, api);
  if (!hookInstalled) { hookInstalled = true; C.hooks.accountCreated.push((uid, d) => { try { INSTANCES.get(d)?.linkUser(uid); } catch (e) { console.error('waitlist link', e.message); } }); }
  return api;
}

// ------------------------------------------------------------------------------------------------ routes + jobs
function mountWaitlists({ v1, app, db, engine, auth, admin, flags, feat, cms, security, waitlists: W, options = {} }) {
  const production = process.env.NODE_ENV === 'production';
  const can = admin.can;
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  // Owner settings (ground rule 6, CLONE_SPEC.md §38.1), read on every use so a change takes effect live: the confirmation
  // link lifetime (48 h), the deletion of unconfirmed requests (7 days after the link expired) and the newsletter rate (120 a
  // minute, NEWSLETTER_PER_MINUTE as the upper bound). The start options (tests) win over the settings.
  const OS = engine.ownerSettings;
  const confirmTtlMs = () => (options.confirmTtlMs ? Math.max(60000, Number(options.confirmTtlMs)) : OS.get('waitlists.confirm_link_hours') * 3600000);
  const perMinute = () => Math.max(1, Number(options.newsletterPerMinute || OS.get('waitlists.newsletter_per_minute')));
  const clock = !production && typeof options.now === 'function' ? options.now : () => Date.now(); // test clock: start options only
  const ipLimit = createLimiter(db, 'waitlist_guest_ip', { limit: Number(options.guestJoinsPerIp || 10), windowMs: Number(options.guestWindowMs || 3600000) });
  const emailLimit = createLimiter(db, 'waitlist_guest_email', { limit: 3, windowMs: 3600000 });
  const tokenLimit = createLimiter(db, 'waitlist_token', { limit: Number(options.tokenAttemptsPerIp || 60), windowMs: 600000 });
  const testSends = createLimiter(db, 'waitlist_test_send', { limit: 10, windowMs: 60000 });
  const ipOf = (req) => (security && security.clientIp ? security.clientIp(req) : req.ip);
  const originOf = (req) => (process.env.PUBLIC_ORIGIN || (req && security && security.selfOrigin ? security.selfOrigin(req) : '') || 'http://localhost').replace(/\/+$/, '');
  const reasonOf = (b) => { const r = String((b && b.reason) || '').trim(); if (r.length < 3 || r.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); return r; };
  const fieldErr = (errs) => { const e = new ApiError(400, 'validation_failed', 'validation failed', Object.entries(errs).map(([k, m]) => `${k}: ${m}`).join('; ')); e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: errs } }); return e; };
  const err = (status, code, key) => new ApiError(status, code, WS(key));
  const listOf = (k) => { if (!Object.prototype.hasOwnProperty.call(LISTS, k)) throw E.notFound(); return k; };
  const requireUser = (req, res, next) => (req.auth ? next() : next(E.unauthorized()));

  // ---------------------------------------------------------------- settings per list (admin_settings waitlist:<key>)
  const SKEY = (list) => `waitlist:${list}`;
  const settings = (list = LAUNCH) => ({ target: null, target_alert: null, survey_locked_ts: null, ...(admin.setting(SKEY(list)) || {}) });
  const putSettings = (list, v, by = null) => admin.putSetting(SKEY(list), v, by);
  const confirmedCount = (list = LAUNCH) => db.prepare("SELECT COUNT(*) c FROM waitlist_entries WHERE list_key=? AND status='confirmed'").get(list).c;

  // ---------------------------------------------------------------- consent wording (CMS text server.waitlists.consent.text)
  function consent() {
    const text = WS('consent.text');
    const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    let v = 0;
    try { v = cms.store.get('text', 'server.waitlists.consent.text').published_version || 0; } catch { /* default wording */ }
    return { text, sha256: sha, version: `cms${v}-${sha.slice(0, 12)}` };
  }

  // ---------------------------------------------------------------- email (CMS templates, one-click unsubscribe)
  const mailer = (m) => {
    if (auth.hooks.mailer) return auth.hooks.mailer(m);
    db.prepare('INSERT INTO email_outbox(id,user_id,to_email,subject,body,created_at) VALUES(?,?,?,?,?,?)').run(newId('em_'), m.userId || null, m.to, m.subject, m.text, nowIso());
    return null;
  };
  const UNSUB = /\{\{\s*unsubscribe_link\s*\}\}/;
  function deliver(e, key, vars, { origin, override, prefix = '' } = {}) {
    const to = W.recipientOf(e);
    if (!to) return false;
    const tok = W.manageToken(e.id);
    const unsub = `${origin}/waitlist/unsubscribe?token=${tok}`;
    const name = e.user_id ? db.prepare('SELECT display_name FROM users WHERE id=?').get(e.user_id)?.display_name : null;
    const em = cms.renderSystem(key, { name: name || WS('greeting.guest'), list_name: WS(`list.${e.list_key}`), manage_link: e.user_id ? `${origin}/waitlist` : `${origin}/waitlist/manage?token=${tok}`, ...vars, unsubscribe_link: unsub }, { origin, ...(override !== undefined ? { override } : {}) });
    // The unsubscribe link is mandatory: appended when an override's text or HTML leaves the placeholder out.
    const f = templates.fields(key, override !== undefined ? override : cms.templateOverride(key));
    let text = em.text; let html = em.html;
    if (!UNSUB.test(f.email_text || '')) text = `${text}\n\n${WS('email.unsubscribe_line', { link: unsub })}`;
    if (!UNSUB.test(f.email_html || '')) html = html.replace('</div><hr>', `<p><a href="${esc(unsub)}">${esc(WS('email.unsubscribe_html'))}</a></p></div><hr>`);
    const headers = { 'List-Unsubscribe': `<${origin}/v1/waitlists/one_click_unsubscribe?token=${tok}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
    try { mailer({ userId: e.user_id || null, to, subject: prefix + em.subject, text, html, headers }); } catch (x) { console.error('waitlist email', x.message); return false; }
    return true;
  }
  function staffWith(perm) {
    const ROLE_PERMS = require('./admin').ROLE_PERMS;
    return db.prepare('SELECT * FROM users WHERE is_admin=1 OR id IN (SELECT user_id FROM admin_roles)').all().filter((u) => admin.rolesOf(u).some((r) => (ROLE_PERMS[r] || []).includes(perm)));
  }

  // ---------------------------------------------------------------- target reached: one alert per target value
  function checkTarget(origin) {
    const st = settings(LAUNCH);
    if (!st.target) return false;
    const n = confirmedCount(LAUNCH);
    if (n < st.target || (st.target_alert && st.target_alert.target === st.target)) return false;
    putSettings(LAUNCH, { ...st, target_alert: { target: st.target, count: n, ts: Date.now() } });
    const count = n.toLocaleString('en-NG'); const target = st.target.toLocaleString('en-NG');
    const link = `${origin || originOf(null)}/admin/waitlists`;
    for (const u of staffWith('settings.write')) {
      try { feat.notify(u.id, { type: 'waitlist_target', title: WS('notify.target.title'), body: WS('notify.target.body', { count, target }), link: '/admin/waitlists' }); } catch (x) { console.error('waitlist target notify', x.message); }
      try { const em = cms.renderSystem('email.waitlist_target_admin', { count, target, link }, { origin }); mailer({ userId: u.id, to: u.email, subject: em.subject, text: em.text, html: em.html }); } catch (x) { console.error('waitlist target email', x.message); }
    }
    engine.emit('waitlists', { list: LAUNCH, type: 'target_reached' });
    return true;
  }
  const changed = (list = LAUNCH) => { try { engine.emit('waitlists', { list, type: 'changed' }); } catch { /* best effort */ } };

  // ---------------------------------------------------------------- survey (CMS type `survey`)
  const QKEY = /^(perps|real_money_launch)\.[a-z0-9_]{1,40}$/;
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  cms.store.register('survey', {
    validate(key, v) {
      if (!QKEY.test(key)) throw { key: 'a question key is <list>.<id>, the id 1-40 lowercase letters, digits and underscores' };
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw { value: 'must be a question object' };
      const errs = {}; const out = {};
      out.kind = KINDS.includes(v.kind) ? v.kind : (errs.kind = `one of ${KINDS.join(', ')}`, null);
      const prompt = str(v.prompt, 1000);
      if (!prompt || prompt.length > 200 || /[<>]/.test(prompt) || /[\u0000-\u001f]/.test(prompt)) errs.prompt = 'plain text, 1-200 characters'; else out.prompt = prompt;
      out.sort = Number.isInteger(v.sort) && v.sort >= 0 && v.sort <= 10000 ? v.sort : 100;
      out.required = v.required === true;
      out.active = v.active !== false;
      if (out.kind === 'single' || out.kind === 'multi') {
        const opts = Array.isArray(v.options) ? v.options : [];
        if (opts.length < 2 || opts.length > 12) errs.options = 'between 2 and 12 options';
        else {
          const ids = new Set();
          out.options = opts.map((o, i) => {
            const id = str(o && o.id, 40); const label = str(o && o.label, 200);
            if (!/^[a-z0-9_]{1,40}$/.test(id) || ids.has(id)) errs[`options.${i}.id`] = 'a unique id of lowercase letters, digits and underscores';
            if (!label || label.length > 120 || /[<>]/.test(label)) errs[`options.${i}.label`] = 'plain text, 1-120 characters';
            ids.add(id);
            return { id, label };
          });
        }
      }
      if (out.kind === 'naira_band') {
        const bands = Array.isArray(v.bands) ? v.bands : [];
        if (bands.length < 2 || bands.length > 10) errs.bands = 'between 2 and 10 bands';
        else {
          const ids = new Set(); let last = -1;
          out.bands = bands.map((b, i) => {
            const id = str(b && b.id, 40); const min = Number(b && b.min_cents); const max = b && b.max_cents != null ? Number(b.max_cents) : null;
            if (!/^[a-z0-9_]{1,40}$/.test(id) || ids.has(id)) errs[`bands.${i}.id`] = 'a unique id';
            if (!Number.isInteger(min) || min < 0 || min < last || (max != null && (!Number.isInteger(max) || max <= min)) || (max == null && i !== bands.length - 1)) errs[`bands.${i}`] = 'ascending whole amounts in internal cents (₦1 each at the NGN default); only the last band is open-ended';
            ids.add(id); last = max ?? min;
            return { id, min_cents: min, max_cents: max };
          });
        }
      }
      if (out.kind === 'text') { const n = Number(v.max_len ?? 500); out.max_len = Number.isInteger(n) && n >= 10 && n <= 2000 ? n : (errs.max_len = 'a whole number from 10 to 2000', 500); }
      if (Object.keys(errs).length) throw errs;
      return out;
    },
    changed: () => changed(LAUNCH),
  });
  function questions(list = LAUNCH, { all = false } = {}) {
    const pub = cms.store.published('survey');
    const keys = new Set([...Object.keys(SURVEY_DEFAULTS), ...pub.keys()].filter((k) => k.startsWith(`${list}.`)));
    const out = [];
    for (const k of keys) {
      const q = pub.has(k) ? pub.get(k) : SURVEY_DEFAULTS[k];
      if (!q || (!all && !q.active)) continue;
      out.push({ key: k, ...q, customised: pub.has(k), default: SURVEY_DEFAULTS[k] || null });
    }
    return out.sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
  }
  const bandLabel = (b) => (b.max_cents == null ? WS('survey.band_open', { min: C.moneyCents(b.min_cents) }) : WS('survey.band', { min: C.moneyCents(b.min_cents), max: C.moneyCents(b.max_cents) }));
  const publicQuestion = (q) => ({ key: q.key, kind: q.kind, prompt: q.prompt, required: q.required, options: q.options || null, bands: q.bands ? q.bands.map((b) => ({ ...b, label: bandLabel(b) })) : null, max_len: q.max_len || null });
  const surveyLocked = (list = LAUNCH) => !!settings(list).survey_locked_ts;
  function cleanText(v, max) {
    return String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  }
  function flagOf(text) {
    const t = text.toLowerCase();
    if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|ng|io|xyz|ru)\b/.test(t)) return WS('survey.flag.link');
    if (BLOCKED_WORDS.some((w) => t.includes(w))) return WS('survey.flag.word');
    if (/(.)\1{9,}/.test(t)) return WS('survey.flag.repeat');
    return null;
  }
  function answersOf(entryId) {
    const out = {};
    for (const a of db.prepare('SELECT question_key, value_json FROM waitlist_survey_answers WHERE entry_id=?').all(entryId)) out[a.question_key] = JSON.parse(a.value_json);
    return out;
  }
  function saveAnswers(e, answers) {
    if (!flags.on('waitlist.launch.survey', e.user_id ? { uid: e.user_id } : {})) throw flags.disabledError('waitlist.launch.survey');
    if (surveyLocked(e.list_key)) throw err(409, 'survey_closed', 'error.survey_closed');
    if (e.status !== 'confirmed') throw err(409, 'waitlist_not_confirmed', 'error.not_confirmed');
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length > 40) throw fieldErr({ answers: 'an object of question key → answer' });
    const qs = new Map(questions(e.list_key).map((q) => [q.key, q]));
    const errs = {}; const writes = [];
    for (const [k, v] of Object.entries(answers)) {
      const q = qs.get(k);
      if (!q) { errs[k] = 'unknown question'; continue; }
      if (v === null || v === '' || (Array.isArray(v) && !v.length)) { writes.push([k, null]); continue; }
      if (q.kind === 'single') { if (typeof v !== 'string' || !q.options.some((o) => o.id === v)) errs[k] = 'pick one of the options'; else writes.push([k, v]); }
      else if (q.kind === 'naira_band') { if (typeof v !== 'string' || !q.bands.some((o) => o.id === v)) errs[k] = 'pick one of the bands'; else writes.push([k, v]); }
      else if (q.kind === 'multi') { if (!Array.isArray(v) || v.length > q.options.length || v.some((x) => typeof x !== 'string' || !q.options.some((o) => o.id === x)) || new Set(v).size !== v.length) errs[k] = 'pick from the options'; else writes.push([k, v]); }
      else if (q.kind === 'text') {
        if (typeof v !== 'string' || v.length > q.max_len * 4) { errs[k] = `text of at most ${q.max_len} characters`; continue; }
        const t = cleanText(v, q.max_len);
        writes.push([k, t || null]);
      }
    }
    const merged = { ...answersOf(e.id), ...Object.fromEntries(writes) };
    for (const q of qs.values()) if (q.required && (merged[q.key] == null)) errs[q.key] = 'is required';
    if (Object.keys(errs).length) { const x = fieldErr(errs); x.code = 'survey_invalid'; x.message = WS('error.survey_invalid'); throw x; }
    const now = Date.now();
    tx(db, () => {
      for (const [k, v] of writes) {
        if (v == null) { db.prepare('DELETE FROM waitlist_survey_answers WHERE entry_id=? AND question_key=?').run(e.id, k); continue; }
        const isText = qs.get(k).kind === 'text';
        const prev = db.prepare('SELECT value_json FROM waitlist_survey_answers WHERE entry_id=? AND question_key=?').get(e.id, k);
        if (prev && prev.value_json === JSON.stringify(v)) continue;
        db.prepare('INSERT INTO waitlist_survey_answers(id,entry_id,list_key,question_key,value_json,moderation,flag_reason,updated_ts) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(entry_id,question_key) DO UPDATE SET value_json=excluded.value_json, moderation=excluded.moderation, flag_reason=excluded.flag_reason, updated_ts=excluded.updated_ts')
          .run(newId('wsa_'), e.id, e.list_key, k, JSON.stringify(v), isText ? 'pending' : null, isText ? flagOf(v) : null, now);
      }
      db.prepare('UPDATE waitlist_entries SET updated_ts=? WHERE id=?').run(now, e.id);
    });
    return answersOf(e.id);
  }
  function surveyVo(e) {
    const on = flags.on('waitlist.launch.survey', e && e.user_id ? { uid: e.user_id } : {});
    return { enabled: on, locked: surveyLocked(), questions: on ? questions(LAUNCH).map(publicQuestion) : [], answers: e && on ? answersOf(e.id) : {} };
  }

  // ---------------------------------------------------------------- views
  const maskEmail = (m) => { const [l, d] = String(m || '').split('@'); return d ? `${(l || '?')[0]}***@${d}` : null; };
  const meVo = (e) => (e ? { entry_status: e.status, joined_time: iso(e.joined_ts), confirmed_time: iso(e.confirmed_ts), unsubscribed_time: iso(e.unsubscribed_ts), linked: !!e.user_id } : null);
  function listVo(req, e) {
    const c = consent();
    return { list: LAUNCH, consent: { text: c.text, version: c.version }, confirm_hours: Math.round(confirmTtlMs() / 3600000), me: meVo(e), survey: e && e.status === 'confirmed' ? surveyVo(e) : { enabled: flags.on('waitlist.launch.survey', { req }), locked: surveyLocked(), questions: [], answers: {} } };
  }
  const tokenEntry = (req, token) => {
    tokenLimit.hit(`ip:${ipOf(req)}`);
    const e = W.entryOfToken(token);
    if (!e) throw err(404, 'waitlist_link_invalid', 'error.link_invalid');
    return e;
  };

  // ---------------------------------------------------------------- inputs
  const UTM = { type: 'string', maxLen: 64 };
  const JOIN = { consent: { type: 'boolean', required: true }, consent_version: { type: 'string', maxLen: 80, required: true }, source: { type: 'string', maxLen: 32 }, utm_source: UTM, utm_medium: UTM, utm_campaign: UTM, ref: { type: 'string', maxLen: 32 } };
  function attribution(b) {
    const clean = (v) => { const t = String(v || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64); return t || null; };
    const ref = String(b.ref || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    return { source: SOURCES.includes(String(b.source || '')) ? String(b.source) : b.utm_source || ref ? 'other' : 'direct', utm_source: clean(b.utm_source), utm_medium: clean(b.utm_medium), utm_campaign: clean(b.utm_campaign), ref_code: ref.length >= 4 ? ref : null };
  }
  function consentOf(req, b, kind) {
    if (b.consent !== true) throw err(400, 'consent_required', 'error.consent_required');
    const c = consent();
    if (b.consent_version !== c.version) throw err(409, 'consent_changed', 'error.consent_changed');
    return { consent_ts: Date.now(), consent_version: c.version, consent_text_sha256: c.sha256, consent_source: kind, consent_ip_hash: W.ipHash(ipOf(req)) };
  }
  const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

  // ---------------------------------------------------------------- user routes
  v1.get(`/waitlists/${LAUNCH}`, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(listVo(req, req.auth ? W.entryOfUser(LAUNCH, req.auth.user.id) : null));
  });
  v1.get(`/waitlists/${LAUNCH}/progress`, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ progress: { count: confirmedCount(LAUNCH), target: settings(LAUNCH).target } });
  });
  // Signed in with a verified email: one click. A guest entry with the account's email (or an unsubscribed entry) is taken
  // over and confirmed. An unverified email proves nothing about the inbox: the join becomes a confirmation request to the
  // account email (double opt-in, as for guests), with the same reply whatever exists for that address.
  v1.post(`/waitlists/${LAUNCH}/join`, requireUser, (req, res) => {
    const b = checkBody(req.body, JOIN, { unknown: 'reject' });
    const u = req.auth.user;
    const verified = W.emailVerified(u.id);
    const cs = consentOf(req, b, verified ? 'signed_in' : 'signed_in_unverified');
    const at = attribution(b);
    const now = Date.now();
    const own = W.entryOfUser(LAUNCH, u.id);
    if (own && own.status === 'confirmed') return res.json(listVo(req, own));
    if (!verified) {
      try { emailLimit.hit(`email:${W.emailHash(u.email)}`); requestConfirmation(req, u.email, cs, at, { requester: u.id }); } catch (x) { if (x.status !== 429) throw x; }
      return res.status(202).json({ status: 'check_email', ...listVo(req, null) });
    }
    // The caller's own entry, else an unlinked guest entry with the account's email (taken over and confirmed).
    const byEmail = W.entryOfEmail(LAUNCH, u.email);
    let e = W.entryOfUser(LAUNCH, u.id) || (byEmail && !byEmail.user_id ? byEmail : null);
    const hash = !byEmail || (e && byEmail.id === e.id) ? W.emailHash(u.email) : null; // the dedupe key, unless another entry holds it
    let fresh = false;
    if (e && e.status === 'confirmed' && e.user_id === u.id) return res.json(listVo(req, e));
    tx(db, () => {
      if (e) {
        db.prepare(`UPDATE waitlist_entries SET user_id=?, email_enc=NULL, email_hash=COALESCE(?, email_hash), status='confirmed', confirmed_ts=?, unsubscribed_ts=NULL, consent_ts=?, consent_version=?, consent_text_sha256=?, consent_source=?, consent_ip_hash=?, updated_ts=? WHERE id=?`)
          .run(u.id, hash, now, cs.consent_ts, cs.consent_version, cs.consent_text_sha256, cs.consent_source, cs.consent_ip_hash, now, e.id);
        db.prepare('UPDATE waitlist_tokens SET used_ts=? WHERE entry_id=? AND used_ts IS NULL').run(now, e.id);
      } else {
        fresh = true;
        const id = newId('wl_');
        db.prepare(`INSERT INTO waitlist_entries(id,list_key,user_id,email_hash,status,joined_ts,confirmed_ts,source,utm_source,utm_medium,utm_campaign,ref_code,consent_ts,consent_version,consent_text_sha256,consent_source,consent_ip_hash,updated_ts)
          VALUES(?,?,?,?,'confirmed',?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, LAUNCH, u.id, hash, now, now, at.source, at.utm_source, at.utm_medium, at.utm_campaign, at.ref_code, cs.consent_ts, cs.consent_version, cs.consent_text_sha256, cs.consent_source, cs.consent_ip_hash, now);
      }
    });
    e = W.entryOfUser(LAUNCH, u.id);
    const origin = originOf(req);
    try { feat.notify(u.id, { type: 'waitlist_joined', title: WS('notify.joined.title'), body: WS('notify.joined.body'), link: '/waitlist' }); } catch (x) { console.error('waitlist notify', x.message); }
    deliver(e, 'email.waitlist_welcome', {}, { origin });
    checkTarget(origin);
    changed();
    res.status(fresh ? 201 : 200).json(listVo(req, e));
  });
  // Guests: double opt-in. The answer is the same whatever the email's state (no enumeration).
  const accepted = (res) => res.status(202).json({ status: 'check_email' });
  auth.hooks.preSession.push(['POST', new RegExp(`^/v1/waitlists/${LAUNCH}/guest_join$`)]); // login CSRF (a cross-site form cannot post it)
  v1.post(`/waitlists/${LAUNCH}/guest_join`, (req, res) => {
    const b = checkBody(req.body, { ...JOIN, email: { type: 'string', maxLen: 254, required: true }, website: { type: 'string', maxLen: 200 } }, { unknown: 'reject' });
    const email = W.norm(b.email);
    if (!EMAIL_RE.test(email)) throw fieldErr({ email: WS('error.email_invalid') });
    const cs = consentOf(req, b, 'guest_form');
    ipLimit.hit(`ip:${ipOf(req)}`);
    if (b.website) { try { security?.bot?.record('waitlist_honeypot', req, {}); } catch { /* best effort */ } return accepted(res); } // a bot filled the hidden field
    try { emailLimit.hit(`email:${W.emailHash(email)}`); } catch { return accepted(res); } // the same reply; no more mail to that inbox this hour
    requestConfirmation(req, email, cs, attribution(b));
    return accepted(res);
  });
  // One confirmation request (the guest form, or an account whose email is not verified). A confirmed entry gets an
  // "already on the list" email; otherwise the entry (new, pending or unsubscribed) is pending with a fresh consent record
  // and one live link. `requester`: the account that asked, stored on the link (confirming links that account's entry).
  function requestConfirmation(req, email, cs, at, { requester = null } = {}) {
    const origin = originOf(req);
    const now = Date.now();
    const account = db.prepare('SELECT id FROM users WHERE email=? AND is_system=0').get(email);
    let e = W.entryOfEmail(LAUNCH, email) || (account ? W.entryOfUser(LAUNCH, account.id) : null);
    if (e && e.status === 'confirmed') { deliver(e, 'email.waitlist_already', {}, { origin }); return; }
    const token = crypto.randomBytes(32).toString('base64url');
    tx(db, () => {
      if (e) {
        db.prepare(`UPDATE waitlist_entries SET status='pending', unsubscribed_ts=NULL, consent_ts=?, consent_version=?, consent_text_sha256=?, consent_source=?, consent_ip_hash=?, updated_ts=? WHERE id=?`)
          .run(cs.consent_ts, cs.consent_version, cs.consent_text_sha256, cs.consent_source, cs.consent_ip_hash, now, e.id);
      } else {
        const id = newId('wl_');
        db.prepare(`INSERT INTO waitlist_entries(id,list_key,email_enc,email_hash,status,joined_ts,source,utm_source,utm_medium,utm_campaign,ref_code,consent_ts,consent_version,consent_text_sha256,consent_source,consent_ip_hash,updated_ts)
          VALUES(?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, LAUNCH, W.encEmail(id, email), W.emailHash(email), now, at.source, at.utm_source, at.utm_medium, at.utm_campaign, at.ref_code, cs.consent_ts, cs.consent_version, cs.consent_text_sha256, cs.consent_source, cs.consent_ip_hash, now);
        e = W.entry(id);
      }
      db.prepare("DELETE FROM waitlist_tokens WHERE entry_id=? AND used_ts IS NULL AND purpose='confirm'").run(e.id); // one live link per entry
      db.prepare("INSERT INTO waitlist_tokens(hash,entry_id,purpose,expires_ts,created_ts,user_id) VALUES(?,?,'confirm',?,?,?)").run(kc.sha256hex(token), e.id, now + confirmTtlMs(), now, requester);
    });
    e = W.entry(e.id);
    deliver(e, 'email.waitlist_confirm', { link: `${origin}/waitlist/confirm?token=${token}`, hours: String(Math.round(confirmTtlMs() / 3600000)) }, { origin });
  }
  // Ground rule 6 switch `waitlist.launch.auto_confirm_verified` (on; owner decision 2026-11-08, CLONE_SPEC.md §38.1): a
  // member who clicked one-click join while their account email was unverified gave explicit consent then; verifying the
  // email later proves the inbox, so their pending entry is confirmed (consent source `signed_in_verified_later`). Only
  // entries this account asked for (its confirmation link carries the account id) are confirmed: a guest-form request by
  // someone else for the same address is linked, never confirmed on that person's behalf.
  W.hooks.verified.push((uid) => {
    if (!flags.jobOn('waitlist.launch.auto_confirm_verified')) return;
    const u = db.prepare('SELECT id, email FROM users WHERE id=?').get(uid);
    if (!u) return;
    const e = db.prepare("SELECT * FROM waitlist_entries WHERE list_key=? AND status='pending' AND (user_id=? OR (user_id IS NULL AND email_hash=?))").get(LAUNCH, uid, W.emailHash(u.email));
    if (!e || !db.prepare('SELECT 1 FROM waitlist_tokens WHERE entry_id=? AND user_id=?').get(e.id, uid)) return;
    if (W.entryOfUser(LAUNCH, uid) && W.entryOfUser(LAUNCH, uid).id !== e.id) return;
    const now = Date.now();
    tx(db, () => {
      db.prepare("UPDATE waitlist_entries SET user_id=?, email_enc=NULL, status='confirmed', confirmed_ts=?, unsubscribed_ts=NULL, consent_source='signed_in_verified_later', updated_ts=? WHERE id=? AND status='pending'").run(uid, now, now, e.id);
      db.prepare('UPDATE waitlist_tokens SET used_ts=? WHERE entry_id=? AND used_ts IS NULL').run(now, e.id);
    });
    const origin = originOf(null);
    try { feat.notify(uid, { type: 'waitlist_joined', title: WS('notify.joined.title'), body: WS('notify.joined.body'), link: '/waitlist' }); } catch (x) { console.error('waitlist notify', x.message); }
    deliver(W.entry(e.id), 'email.waitlist_welcome', {}, { origin });
    checkTarget(origin);
    changed();
  });
  v1.post('/waitlists/confirm', (req, res) => {
    const b = checkBody(req.body, { token: { type: 'string', maxLen: 100, required: true } }, { unknown: 'reject' });
    tokenLimit.hit(`ip:${ipOf(req)}`);
    const t = db.prepare("SELECT * FROM waitlist_tokens WHERE hash=? AND purpose='confirm'").get(kc.sha256hex(b.token));
    if (!t) throw err(400, 'waitlist_link_invalid', 'error.link_invalid');
    if (t.used_ts) throw err(410, 'waitlist_link_used', 'error.link_used');
    if (t.expires_ts <= Date.now()) throw err(410, 'waitlist_link_expired', 'error.link_expired');
    let e = W.entry(t.entry_id);
    if (!e) throw err(400, 'waitlist_link_invalid', 'error.link_invalid');
    const now = Date.now();
    tx(db, () => {
      if (db.prepare('UPDATE waitlist_tokens SET used_ts=? WHERE hash=? AND used_ts IS NULL').run(now, t.hash).changes !== 1) throw err(410, 'waitlist_link_used', 'error.link_used'); // single use, also under a race
      db.prepare("UPDATE waitlist_entries SET status='confirmed', confirmed_ts=?, unsubscribed_ts=NULL, updated_ts=? WHERE id=?").run(now, now, e.id);
    });
    if (!e.user_id) {
      // The account that asked for this link (an unverified one-click join) gets the entry, if it still has that email;
      // otherwise an account with this email whose email is verified (W.linkUser checks).
      const asker = t.user_id ? db.prepare('SELECT id, email FROM users WHERE id=?').get(t.user_id) : null;
      if (asker && e.email_hash === W.emailHash(asker.email) && !W.entryOfUser(e.list_key, asker.id)) db.prepare('UPDATE waitlist_entries SET user_id=?, email_enc=NULL, updated_ts=? WHERE id=?').run(asker.id, now, e.id);
      else W.linkUser(db.prepare('SELECT id FROM users WHERE email=? AND is_system=0').get(W.decEmail(e) || '')?.id || '');
    }
    e = W.entry(e.id);
    const origin = originOf(req);
    deliver(e, 'email.waitlist_welcome', {}, { origin });
    checkTarget(origin);
    changed();
    res.json({ status: 'confirmed', list: e.list_key, manage_token: W.manageToken(e.id), survey: surveyVo(e) });
  });
  // Token-holders (the link in every email): status, survey, unsubscribe, delete. Signed-in members use the list routes.
  v1.post('/waitlists/manage', (req, res) => {
    const b = checkBody(req.body, { token: { type: 'string', maxLen: 120, required: true } }, { unknown: 'reject' });
    const e = tokenEntry(req, b.token);
    res.json({ list: e.list_key, email_masked: maskEmail(W.recipientOf(e)), me: meVo(e), survey: e.status === 'confirmed' ? surveyVo(e) : { enabled: false, locked: surveyLocked(), questions: [], answers: {} } });
  });
  const unsubscribe = (e) => {
    if (e.status === 'unsubscribed') return e;
    const now = Date.now();
    db.prepare("UPDATE waitlist_entries SET status='unsubscribed', unsubscribed_ts=?, updated_ts=? WHERE id=?").run(now, now, e.id);
    db.prepare("UPDATE waitlist_newsletter_outbox SET status='skipped_unsubscribed', updated_ts=? WHERE entry_id=? AND status='queued'").run(now, e.id);
    changed(e.list_key);
    return W.entry(e.id);
  };
  v1.post('/waitlists/unsubscribe', (req, res) => {
    const b = checkBody(req.body, { token: { type: 'string', maxLen: 120, required: true } }, { unknown: 'reject' });
    const e = tokenEntry(req, b.token);
    if (e.list_key !== LAUNCH) throw err(404, 'waitlist_link_invalid', 'error.link_invalid');
    res.json({ status: 'unsubscribed', list: e.list_key, me: meVo(unsubscribe(e)) });
  });
  v1.post('/waitlists/delete', (req, res) => {
    const b = checkBody(req.body, { token: { type: 'string', maxLen: 120, required: true } }, { unknown: 'reject' });
    const e = tokenEntry(req, b.token);
    if (e.list_key !== LAUNCH) throw err(404, 'waitlist_link_invalid', 'error.link_invalid');
    W.deleteEntry(e.id);
    changed(e.list_key);
    res.json({ deleted: true });
  });
  v1.put(`/waitlists/${LAUNCH}/survey`, (req, res) => {
    const b = checkBody(req.body, { answers: { type: 'object', required: true }, token: { type: 'string', maxLen: 120 } }, { unknown: 'reject' });
    const e = b.token ? tokenEntry(req, b.token) : req.auth ? W.entryOfUser(LAUNCH, req.auth.user.id) : null;
    if (!b.token && !req.auth) throw E.unauthorized();
    if (!e || e.list_key !== LAUNCH) throw err(404, 'waitlist_not_joined', 'error.not_joined');
    res.json({ survey: { ...surveyVo(e), answers: saveAnswers(e, b.answers) } });
  });
  v1.post(`/waitlists/${LAUNCH}/unsubscribe`, requireUser, (req, res) => {
    const e = W.entryOfUser(LAUNCH, req.auth.user.id);
    if (!e) throw err(404, 'waitlist_not_joined', 'error.not_joined');
    res.json(listVo(req, unsubscribe(e)));
  });
  v1.delete(`/waitlists/${LAUNCH}/me`, requireUser, (req, res) => {
    const e = W.entryOfUser(LAUNCH, req.auth.user.id);
    if (!e) throw err(404, 'waitlist_not_joined', 'error.not_joined');
    W.deleteEntry(e.id);
    changed();
    res.json({ deleted: true, ...listVo(req, null) });
  });
  // RFC 8058 one-click unsubscribe: mail providers POST "List-Unsubscribe=One-Click" without cookies or tokens, so this
  // runs before the session, CSRF and client-token middleware (server/app.js), authenticated by the HMAC token alone.
  app.locals.waitlistOneClick = (req, res) => {
    try {
      tokenLimit.hit(`ip:${ipOf(req)}`);
      const e = W.entryOfToken(req.query.token);
      if (e && e.list_key === LAUNCH) unsubscribe(e);
      res.setHeader('Cache-Control', 'no-store');
      res.status(e ? 200 : 404).json(e ? { status: 'unsubscribed' } : { error: { code: 'waitlist_link_invalid', message: WS('error.link_invalid') } });
    } catch (x) { res.status(x.status || 500).json({ error: { code: x.code || 'internal_server_error', message: x.message } }); }
  };

  // ---------------------------------------------------------------- newsletter outbox (throttled, persisted, resumable)
  const nlRow = (id) => db.prepare('SELECT * FROM waitlist_newsletters WHERE id=?').get(id);
  function nlStats(id) {
    const c = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM waitlist_newsletter_outbox WHERE newsletter_id=? GROUP BY status').all(id).map((r) => [r.status, r.n]));
    const total = Object.values(c).reduce((a, n) => a + n, 0);
    return { total, queued: c.queued || 0, sent: c.sent || 0, skipped_unconfirmed: c.skipped_unconfirmed || 0, skipped_unsubscribed: c.skipped_unsubscribed || 0, skipped_deleted: c.skipped_deleted || 0, failed: c.failed || 0 };
  }
  const nlVo = (n) => ({ id: n.id, list: n.list_key, kind: n.kind, template: n.template_key, subject: n.subject, status: n.status, scheduled_time: iso(n.scheduled_ts), created_time: iso(n.created_ts), started_time: iso(n.started_ts), finished_time: iso(n.finished_ts), canceled_time: iso(n.canceled_ts), reason: n.reason, created_by: n.created_by ? db.prepare('SELECT email FROM users WHERE id=?').get(n.created_by)?.email || null : null, stats: nlStats(n.id) });
  function startSend(n, now) {
    tx(db, () => {
      db.prepare("INSERT INTO waitlist_newsletter_outbox(newsletter_id,entry_id,status,updated_ts) SELECT ?, id, 'queued', ? FROM waitlist_entries WHERE list_key=? ON CONFLICT DO NOTHING").run(n.id, now, n.list_key);
      db.prepare("UPDATE waitlist_newsletters SET status='sending', started_ts=? WHERE id=? AND status IN ('scheduled','sending')").run(now, n.id);
    });
  }
  const nlVars = (n) => { const st = settings(n.list_key); return n.kind === 'launch' ? { link: `${n.origin}/funds` } : { count: confirmedCount(n.list_key).toLocaleString('en-NG'), target: st.target ? st.target.toLocaleString('en-NG') : '', link: `${n.origin}/waitlist` }; };
  function sendOne(n, entryId, now) {
    const e = W.entry(entryId);
    const status = !e ? 'skipped_deleted' : e.status === 'unsubscribed' ? 'skipped_unsubscribed' : e.status !== 'confirmed' ? 'skipped_unconfirmed' : null;
    if (status) { db.prepare('UPDATE waitlist_newsletter_outbox SET status=?, updated_ts=? WHERE newsletter_id=? AND entry_id=?').run(status, now, n.id, entryId); return false; }
    db.prepare('UPDATE waitlist_newsletter_outbox SET attempts=attempts+1, updated_ts=? WHERE newsletter_id=? AND entry_id=?').run(now, n.id, entryId);
    const ok = deliver(e, n.template_key, nlVars(n), { origin: n.origin, override: n.template_json ? JSON.parse(n.template_json) : null });
    db.prepare('UPDATE waitlist_newsletter_outbox SET status=?, updated_ts=? WHERE newsletter_id=? AND entry_id=?').run(ok ? 'sent' : 'failed', now, n.id, entryId);
    return ok;
  }
  let allowance = 0; let lastTick = clock();
  function pump() {
    const now = clock();
    const dt = Math.max(0, now - lastTick); lastTick = now;
    if (!flags.jobOn('newsletter')) return; // paused while the flag is off (nothing accrues, nothing is lost)
    for (const n of db.prepare("SELECT * FROM waitlist_newsletters WHERE status='scheduled' AND scheduled_ts<=? ORDER BY scheduled_ts").all(now)) startSend(n, now);
    const sending = db.prepare("SELECT * FROM waitlist_newsletters WHERE status='sending' ORDER BY created_ts").all();
    if (!sending.length) { allowance = 0; return; }
    const rate = perMinute();
    allowance = Math.min(rate, allowance + (rate * dt) / 60000);
    for (const n of sending) {
      for (const r of db.prepare("SELECT entry_id FROM waitlist_newsletter_outbox WHERE newsletter_id=? AND status='queued' ORDER BY entry_id LIMIT 200").all(n.id)) {
        if (allowance < 1) break;
        const e = W.entry(r.entry_id);
        const willSend = e && e.status === 'confirmed';
        try { sendOne(n, r.entry_id, now); } catch (x) { console.error('newsletter send', x.message); db.prepare("UPDATE waitlist_newsletter_outbox SET status='failed', updated_ts=? WHERE newsletter_id=? AND entry_id=?").run(now, n.id, r.entry_id); }
        if (willSend) allowance -= 1; // skips cost nothing: only delivered mail is throttled
      }
      if (!db.prepare("SELECT 1 FROM waitlist_newsletter_outbox WHERE newsletter_id=? AND status='queued' LIMIT 1").get(n.id)) {
        db.prepare("UPDATE waitlist_newsletters SET status='sent', finished_ts=? WHERE id=? AND status='sending'").run(now, n.id);
        changed(n.list_key);
      }
      if (allowance < 1) break;
    }
  }
  engine.on('tick', () => { try { pump(); } catch (x) { if (!/not open|closed/i.test(x.message)) console.error('newsletter job', x.message); } });
  // Pending guest entries whose confirmation links all expired more than the owner setting's days ago (default 7) are
  // deleted (data minimisation). Hourly; a change of the setting runs the purge at the next tick.
  let lastPurge = 0;
  const purgeEveryMs = Math.max(1000, Number(options.purgeEveryMs || 3600000));
  OS.listeners.push((k) => { if (k === 'waitlists.unconfirmed_delete_days') lastPurge = 0; });
  engine.on('tick', () => {
    const now = clock();
    if (now - lastPurge < purgeEveryMs) return;
    lastPurge = now;
    try {
      const keep = OS.get('waitlists.unconfirmed_delete_days') * DAY;
      for (const e of db.prepare("SELECT id FROM waitlist_entries WHERE status='pending' AND user_id IS NULL AND updated_ts<? AND NOT EXISTS (SELECT 1 FROM waitlist_tokens t WHERE t.entry_id=waitlist_entries.id AND t.expires_ts>?)").all(now - keep, now - keep)) W.deleteEntry(e.id);
    } catch (x) { if (!/not open|closed/i.test(x.message)) console.error('waitlist purge', x.message); }
  });
  function createNewsletter(req, { kind, list, sendAt, reason }) {
    const key = kind === 'launch' ? 'email.waitlist_launch' : 'email.waitlist_newsletter';
    const override = cms.templateOverride(key) || null;
    const origin = originOf(req);
    // The subject as members will see it (a {{name}} in an override shows the guest greeting here).
    const subject = cms.renderSystem(key, { name: WS('greeting.guest'), ...nlVars({ list_key: list, kind, origin }) }, { origin, override }).subject;
    const now = Date.now();
    const id = newId('wnl_');
    db.prepare('INSERT INTO waitlist_newsletters(id,list_key,kind,template_key,template_json,subject,status,scheduled_ts,origin,reason,created_by,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, list, kind, key, override ? JSON.stringify(override) : null, subject, 'scheduled', sendAt || now, originOf(req), reason, req.auth.user.id, now);
    if (!sendAt) startSend(nlRow(id), now);
    return nlRow(id);
  }

  // ---------------------------------------------------------------- admin
  const A = '/admin/waitlists';
  const days = (n = 30) => { const out = []; const now = Date.now(); for (let i = n - 1; i >= 0; i--) out.push(C.dayKey(now - i * DAY)); return out; };
  function growth(list) {
    const keys = days(30); const since = Date.now() - 31 * DAY;
    const joined = new Map(keys.map((k) => [k, 0])); const confirmed = new Map(keys.map((k) => [k, 0]));
    for (const r of db.prepare('SELECT joined_ts, confirmed_ts FROM waitlist_entries WHERE list_key=? AND (joined_ts>=? OR confirmed_ts>=?)').all(list, since, since)) {
      const j = C.dayKey(r.joined_ts); if (joined.has(j)) joined.set(j, joined.get(j) + 1);
      if (r.confirmed_ts) { const c = C.dayKey(r.confirmed_ts); if (confirmed.has(c)) confirmed.set(c, confirmed.get(c) + 1); }
    }
    return keys.map((k) => ({ day: k, joined: joined.get(k), confirmed: confirmed.get(k) }));
  }
  function aggregates(list) {
    const counted = "entry_id IN (SELECT id FROM waitlist_entries WHERE list_key=? AND status IN ('confirmed','unsubscribed'))";
    return questions(list, { all: true }).map((q) => {
      const rows = db.prepare(`SELECT value_json, moderation, flag_reason FROM waitlist_survey_answers WHERE list_key=? AND question_key=? AND ${counted}`).all(list, q.key, list);
      const base = { key: q.key, kind: q.kind, prompt: q.prompt, active: q.active, respondents: rows.length };
      if (q.kind === 'text') return { ...base, pending: rows.filter((r) => r.moderation === 'pending').length, approved: rows.filter((r) => r.moderation === 'approved').length, hidden: rows.filter((r) => r.moderation === 'hidden').length, flagged: rows.filter((r) => r.flag_reason).length };
      const opts = q.kind === 'naira_band' ? q.bands.map((b) => ({ id: b.id, label: bandLabel(b) })) : q.options;
      const counts = new Map(opts.map((o) => [o.id, 0]));
      for (const r of rows) for (const v of [].concat(JSON.parse(r.value_json))) if (counts.has(v)) counts.set(v, counts.get(v) + 1);
      return { ...base, options: opts.map((o) => ({ id: o.id, label: o.label, count: counts.get(o.id) })) };
    });
  }
  function listAdminVo(list) {
    if (list === 'perps') {
      const c = W.perps.counts();
      return { list, total: Object.values(c).reduce((a, n) => a + n, 0), counts: c, gate_active: flags.jobOn('perps.waitlist'), growth: growth(list) };
    }
    const c = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM waitlist_entries WHERE list_key=? GROUP BY status').all(list).map((r) => [r.status, r.n]));
    const st = settings(list);
    const by = (col) => db.prepare(`SELECT COALESCE(${col}, '') k, COUNT(*) n FROM waitlist_entries WHERE list_key=? AND status<>'pending' GROUP BY k ORDER BY n DESC LIMIT 20`).all(list).map((r) => ({ key: r.k, count: r.n }));
    const launch = launchSummary();
    return {
      list, total: Object.values(c).reduce((a, n) => a + n, 0), counts: { pending: c.pending || 0, confirmed: c.confirmed || 0, unsubscribed: c.unsubscribed || 0 },
      target: st.target, target_reached: !!(st.target && (c.confirmed || 0) >= st.target), target_alert: st.target_alert ? { target: st.target_alert.target, count: st.target_alert.count, time: iso(st.target_alert.ts) } : null,
      public_count: flags.jobOn('waitlist.launch.public_count'), survey_enabled: flags.jobOn('waitlist.launch.survey'), survey_locked_time: iso(st.survey_locked_ts),
      sources: { source: by('source'), utm_source: by('utm_source'), utm_campaign: by('utm_campaign'), ref_code: by('ref_code') },
      growth: growth(list), survey: aggregates(list), newsletter_flag: flags.jobOn('newsletter'), newsletter_per_minute: perMinute(), export_includes_email: OS.get('waitlists.export_includes_email'), confirm_link_hours: Math.round(confirmTtlMs() / 3600000), launch_email: launch.launch_email,
    };
  }
  v1.get(A, can('users.read'), (req, res) => res.json({ lists: Object.keys(LISTS).map((k) => ({ key: k, name: WS(`list.${k}`), ...(k === LAUNCH ? { confirmed: confirmedCount(k), target: settings(k).target } : { waiting: W.perps.count('waiting') }) })) }));
  v1.get(`${A}/:list`, can('users.read'), (req, res) => res.json({ waitlist: listAdminVo(listOf(req.params.list)) }));
  v1.put(`${A}/:list/target`, can('settings.write'), (req, res) => {
    const list = listOf(req.params.list);
    if (list !== LAUNCH) throw E.notFound();
    const b = checkBody(req.body, { target: { type: 'integer', nullable: true, min: 1, max: 100000000 }, reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
    if (b.target === undefined) throw fieldErr({ target: 'a whole number of members, or null for no target' });
    const reason = reasonOf(b);
    const before = settings(list);
    putSettings(list, { ...before, target: b.target }, req.auth.user.id);
    admin.audit(req, 'waitlists.target', 'waitlist', list, { target: before.target }, { target: b.target }, reason);
    checkTarget(originOf(req));
    changed(list);
    res.json({ waitlist: listAdminVo(list) });
  });
  // Export: consent fields only (no survey answers), behind step-up, audited.
  v1.get(`${A}/:list/export.csv`, can('users.support'), (req, res) => {
    const list = listOf(req.params.list);
    if (list !== LAUNCH) throw E.notFound();
    auth.assertFresh(req, 'waitlist_export');
    const csv = (v) => { const t = String(v ?? ''); return /[",\n\r]/.test(t) || /^[=+\-@\t]/.test(t) ? `"${(/^[=+\-@\t]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"` : t; };
    const rows = db.prepare('SELECT * FROM waitlist_entries WHERE list_key=? ORDER BY joined_ts, id').all(list);
    const lines = [WS('csv.header')];
    const withEmail = OS.get('waitlists.export_includes_email'); // owner setting (default on): proves consent per person
    for (const e of rows) lines.push([e.id, e.list_key, e.status, withEmail ? W.recipientOf(e) : '', iso(e.joined_ts), iso(e.confirmed_ts), iso(e.unsubscribed_ts), iso(e.consent_ts), e.consent_version, e.consent_text_sha256, e.consent_source, e.consent_ip_hash, e.source, e.utm_source, e.utm_medium, e.utm_campaign, e.ref_code].map(csv).join(','));
    admin.audit(req, 'waitlists.export', 'waitlist', list, null, { rows: rows.length, fields: 'consent', email: withEmail }, 'consent export');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="parlance-waitlist-${list}-${nowIso().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(`${lines.join('\r\n')}\r\n`);
  });
  // Free-text survey answers: a moderated list without identities.
  v1.get(`${A}/:list/survey/comments`, can('users.read'), (req, res) => {
    const list = listOf(req.params.list);
    const status = ['pending', 'approved', 'hidden'].includes(String(req.query.status || '')) ? String(req.query.status) : null;
    const textKeys = questions(list, { all: true }).filter((q) => q.kind === 'text').map((q) => q.key);
    if (!textKeys.length) return res.json({ comments: [] });
    const rows = db.prepare(`SELECT id, question_key, value_json, moderation, flag_reason, updated_ts FROM waitlist_survey_answers WHERE list_key=? AND question_key IN (${textKeys.map(() => '?').join(',')}) ${status ? 'AND moderation=?' : ''} ORDER BY CASE moderation WHEN 'pending' THEN 0 ELSE 1 END, flag_reason IS NULL, updated_ts DESC LIMIT 500`)
      .all(list, ...textKeys, ...(status ? [status] : []));
    res.json({ comments: rows.map((r) => ({ id: r.id, question: r.question_key, text: JSON.parse(r.value_json), status: r.moderation, flag: r.flag_reason, time: iso(r.updated_ts) })) });
  });
  v1.post(`${A}/:list/survey/comments/:id/:action`, can('users.support'), (req, res) => {
    const list = listOf(req.params.list);
    const action = { approve: 'approved', hide: 'hidden' }[req.params.action];
    if (!action) throw E.notFound();
    const a = db.prepare('SELECT * FROM waitlist_survey_answers WHERE id=? AND list_key=?').get(String(req.params.id), list);
    if (!a || a.moderation == null) throw E.notFound();
    db.prepare('UPDATE waitlist_survey_answers SET moderation=? WHERE id=?').run(action, a.id);
    admin.audit(req, `waitlists.survey.${req.params.action}`, 'waitlist_answer', a.id, { status: a.moderation }, { status: action }, 'moderation');
    res.json({ id: a.id, status: action });
  });
  // Newsletter (flag `newsletter`: the routes answer feature_disabled and the job pauses while off).
  v1.get(`${A}/:list/newsletters`, can('announce'), (req, res) => {
    const list = listOf(req.params.list);
    res.json({ newsletters: db.prepare('SELECT * FROM waitlist_newsletters WHERE list_key=? ORDER BY created_ts DESC LIMIT 50').all(list).map(nlVo), per_minute: perMinute(), recipients: confirmedCount(list) });
  });
  const sample = (key) => { const { app_name: _a, ...rest } = templates.definition(key)?.sample || {}; void _a; return rest; }; // app_name: the live brand
  v1.post(`${A}/:list/newsletters/preview`, can('announce'), (req, res) => {
    listOf(req.params.list);
    const b = checkBody(req.body, { kind: { type: 'string', enum: ['newsletter', 'launch'] } }, { unknown: 'reject' });
    const key = b.kind === 'launch' ? 'email.waitlist_launch' : 'email.waitlist_newsletter';
    const em = cms.renderSystem(key, sample(key), { origin: originOf(req) });
    res.json({ preview: { key, subject: em.subject, text: em.text, html: em.html } });
  });
  v1.post(`${A}/:list/newsletters/test`, can('announce'), (req, res) => {
    const list = listOf(req.params.list);
    if (list !== LAUNCH) throw E.notFound();
    const b = checkBody(req.body, { kind: { type: 'string', enum: ['newsletter', 'launch'] } }, { unknown: 'reject' });
    testSends.hit(`u:${req.auth.user.id}`);
    const key = b.kind === 'launch' ? 'email.waitlist_launch' : 'email.waitlist_newsletter';
    const origin = originOf(req);
    const fake = { id: 'wl_test_send', list_key: list, user_id: req.auth.user.id, status: 'confirmed' };
    const ok = deliver(fake, key, nlVars({ list_key: list, kind: b.kind || 'newsletter', origin }), { origin, prefix: '[Test] ' });
    admin.audit(req, 'waitlists.newsletter.test', 'waitlist', list, null, { template: key, to: req.auth.user.email });
    res.json({ sent: ok, to: req.auth.user.email });
  });
  v1.post(`${A}/:list/newsletters`, can('announce'), (req, res) => {
    const list = listOf(req.params.list);
    if (list !== LAUNCH) throw E.notFound();
    const b = checkBody(req.body, { send_at: { type: 'string', nullable: true, maxLen: 40 }, reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
    const reason = reasonOf(b);
    let at = null;
    if (b.send_at) { at = Date.parse(b.send_at); if (!Number.isFinite(at) || at <= Date.now() || at > Date.now() + 366 * DAY) throw fieldErr({ send_at: 'a date and time in the next year, or empty to send now' }); }
    auth.assertFresh(req, 'newsletter_send');
    const n = createNewsletter(req, { kind: 'newsletter', list, sendAt: at, reason });
    admin.audit(req, at ? 'waitlists.newsletter.schedule' : 'waitlists.newsletter.send', 'waitlist_newsletter', n.id, null, { list, subject: n.subject, scheduled_time: iso(n.scheduled_ts), recipients: confirmedCount(list) }, reason);
    res.status(201).json({ newsletter: nlVo(n) });
  });
  v1.post(`${A}/:list/newsletters/:id/cancel`, can('announce'), (req, res) => {
    const list = listOf(req.params.list);
    const reason = reasonOf(req.body);
    const n = db.prepare('SELECT * FROM waitlist_newsletters WHERE id=? AND list_key=?').get(String(req.params.id), list);
    if (!n) throw E.notFound();
    if (!['scheduled', 'sending'].includes(n.status)) throw E.conflict('newsletter_closed', `this send is ${n.status}`);
    const now = Date.now();
    tx(db, () => {
      db.prepare("UPDATE waitlist_newsletters SET status='canceled', canceled_ts=? WHERE id=?").run(now, n.id);
      db.prepare("UPDATE waitlist_newsletter_outbox SET status='canceled', updated_ts=? WHERE newsletter_id=? AND status='queued'").run(now, n.id);
    });
    admin.audit(req, 'waitlists.newsletter.cancel', 'waitlist_newsletter', n.id, { status: n.status }, { status: 'canceled' }, reason);
    res.json({ newsletter: nlVo(nlRow(n.id)) });
  });
  // "We're live with real money": offered to the admins once the production switch has run; never sent by itself.
  function launchSummary() {
    const st = settings(LAUNCH);
    const n = confirmedCount(LAUNCH);
    const switched = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pm_reset_batches'").get() && !!db.prepare('SELECT 1 FROM pm_reset_batches LIMIT 1').get();
    const sent = db.prepare("SELECT * FROM waitlist_newsletters WHERE list_key=? AND kind='launch' AND status<>'canceled' ORDER BY created_ts DESC LIMIT 1").get(LAUNCH);
    return { confirmed: n, target: st.target, reached: !!(st.target && n >= st.target), reached_time: st.target_alert && st.target_alert.target === st.target ? iso(st.target_alert.ts) : null,
      launch_email: { available: switched && !sent, offered: switched, recipients: n, newsletter: sent ? nlVo(sent) : null } };
  }
  v1.post(`${A}/:list/launch_email`, can('announce'), (req, res) => {
    const list = listOf(req.params.list);
    if (list !== LAUNCH) throw E.notFound();
    const reason = reasonOf(req.body);
    const ls = launchSummary();
    if (!ls.launch_email.offered) throw err(409, 'launch_email_unavailable', 'error.launch_email_unavailable');
    if (!ls.launch_email.available) throw err(409, 'launch_email_sent', 'error.launch_email_sent');
    auth.assertFresh(req, 'newsletter_send');
    const n = createNewsletter(req, { kind: 'launch', list, sendAt: null, reason });
    admin.audit(req, 'waitlists.launch_email', 'waitlist_newsletter', n.id, null, { list, recipients: ls.recipients }, reason);
    res.status(201).json({ newsletter: nlVo(n) });
  });

  // ---------------------------------------------------------------- the production switch (server/play-mode.js)
  function previewCounts() {
    const q = (sql) => db.prepare(sql).get().c;
    return { kept_waitlist_members: q('SELECT COUNT(*) c FROM waitlist_entries'), kept_waitlist_consents: q('SELECT COUNT(*) c FROM waitlist_entries WHERE consent_ts IS NOT NULL'), kept_survey_answers: q('SELECT COUNT(*) c FROM waitlist_survey_answers') };
  }
  function afterProductionSwitch(batch) {
    const st = settings(LAUNCH);
    if (!st.survey_locked_ts) putSettings(LAUNCH, { ...st, survey_locked_ts: Date.now(), survey_locked_batch: batch });
    for (const u of staffWith('announce')) {
      try { feat.notify(u.id, { type: 'waitlist_launch_offer', title: WS('notify.launch_offer.title'), body: WS('notify.launch_offer.body', { count: confirmedCount(LAUNCH).toLocaleString('en-NG') }), link: '/admin/play_mode' }); } catch { /* best effort */ }
    }
    changed();
  }
  engine.waitlistOps = { previewCounts, afterProductionSwitch, launchSummary };
  return { questions, settings, confirmedCount, checkTarget, pump, launchSummary, previewCounts };
}

module.exports = { createWaitlists, mountWaitlists, LISTS, LAUNCH, migratePerps };
