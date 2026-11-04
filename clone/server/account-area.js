'use strict';
// Account area (PLAN A3–A6, A12; CLONE_SPEC §13.16, §13.19; CLONE_SPEC.md §25.8–§25.10):
//   • preferences shown on Settings — display mode, theme + accessible colours, security notifications, trade mechanics
//     toggles, market preview price type — strictly validated and stored in `user_settings` (the same rows
//     GET /users/:uid/properties returns, so the SPA applies them on every page and device);
//   • marketing-text consent with a versioned SMS disclosure and an append-only consent record (time, text version and
//     hash, revocation);
//   • connected apps (OAuth grants to third-party apps; the list is empty until the public API of Phase 7 issues them);
//   • Your activity (chips over server/history.js) with CSV;
//   • Documents (/account/taxes): realized P&L per year with and without fees, the year's transactions as CSV, and
//     simulated yearly statements as CSV and PDF — clearly "not tax advice";
//   • rewards: the new-user checklist and promo codes (created by staff, single use per user, credited to the ledger
//     as kind `credit`).
const CS = require('./content/currency-strings'); // keyed user-facing wording (CLONE_SPEC.md §30)
const C = require('./currency'); // display currency formatting (CLONE_SPEC.md §30)
const crypto = require('node:crypto');
const { tx } = require('./db');
const { nowIso, newId, dollars, usd, ApiError, E, encCursor, decCursor, UNITS } = require('./util');
const { check } = require('./validate');
const { textPdf } = require('./pdf');
const { ipPrefix, deviceOf } = require('./auth');
const auditChain = require('./audit-chain');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS marketing_consents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, action TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'sms',
  text_version TEXT NOT NULL, text_sha256 TEXT NOT NULL, phone_last4 TEXT, ip_prefix TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '', created_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_marketing_consents_user ON marketing_consents(user_id, created_ts);
CREATE TABLE IF NOT EXISTS oauth_grants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_id TEXT NOT NULL, client_name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id);
CREATE TABLE IF NOT EXISTS promo_codes (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', amount_cents INTEGER NOT NULL, max_redemptions INTEGER,
  redeemed_count INTEGER NOT NULL DEFAULT 0, starts_at TEXT, ends_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS promo_redemptions (id TEXT PRIMARY KEY, promo_id TEXT NOT NULL REFERENCES promo_codes(id), user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL, ledger_id TEXT, created_ts INTEGER NOT NULL, UNIQUE (promo_id, user_id));
CREATE TABLE IF NOT EXISTS promo_attempts (user_id TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_promo_attempts ON promo_attempts(user_id, ts);
`;

// Settings page (CLONE_SPEC §13.16, in page order). `phase5` marked trade mechanics stored before their behaviour existed;
// Phase 5A made them live, so the list it produces is now empty. `rfq_enabled` is the existing RFQ opt-in (spec §17.6).
const PREFS = {
  display_mode: { values: ['payout', 'shares'], def: 'payout' },
  theme: { values: ['system', 'light', 'dark'], def: 'dark' },
  accessible_colors: { bool: true, def: false },
  // Live since Phase 5A (CLONE_SPEC.md §28.5–§28.6): read by the ticket (review, auto-sell), POST orders (flip sell) and
  // server/trading-core.js (collateral return).
  trade_flip_sell: { bool: true, def: false },
  trade_auto_sell_prompt: { bool: true, def: false },
  trade_skip_review: { bool: true, def: false },
  trade_collateral_return: { bool: true, def: true },
  rfq_enabled: { bool: true, def: false },
  market_price_type: { values: ['last_traded', 'current_buy'], def: 'last_traded' },
};

// Marketing-text disclosure (our own wording). Changing the text means a new version: consent is recorded per version.
const SMS_DISCLOSURE = {
  version: '2026-11-03.1',
  text: 'By opting in, you agree that Parlance may send you recurring automated marketing text messages (for example new markets, promotions and product news) to the mobile number on your account. Parlance also texts you about security, identity verification and two-factor sign-in; those messages are separate from this choice. Consent is not a condition of any purchase or of opening an account. Message frequency varies (up to 8 messages a month). Message and data rates may apply. Reply STOP to unsubscribe at any time or HELP for help. You can also opt out here in Settings.',
};
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

const STEPS = [
  ['verify_identity', 'Verify your identity', '/sign-up/identity'],
  ['first_deposit', 'Make your first deposit', '/portfolio'],
  ['first_trade', 'Place your first trade', '/browse'],
  ['complete_profile', 'Create your profile', '/account/profile'],
];

function mountAccountArea({ v1, db, engine, auth, admin, identity, history, requireUser, notify }) {
  db.exec(SCHEMA);
  const can = admin.can;
  const pref = (uid, key) => {
    const r = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(uid, key);
    if (!r) return PREFS[key].def;
    try { return JSON.parse(r.value); } catch { return PREFS[key].def; }
  };
  const prefsOf = (uid) => Object.fromEntries(Object.keys(PREFS).map((k) => [k, pref(uid, k)]));
  const savePref = (uid, k, v) => db.prepare('INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(uid, k, JSON.stringify(v), nowIso());
  // "Security notifications" (Settings item 5) belongs to the Phase 2 notification preferences (server/notify-prefs.js);
  // the Settings page mounts that module's toggle, so there is a single source of truth for it.
  const audit = (req, action, targetType, targetId, before, after, reason = '') => auditChain.append(db, { actor_id: req.auth.user.id, actor_email: req.auth.user.email, action, target_type: targetType, target_id: targetId, before, after, reason });

  // ------------------------------------------------------------------ preferences (Settings)
  const prefsVo = (uid) => ({ preferences: prefsOf(uid), phase5: Object.keys(PREFS).filter((k) => PREFS[k].phase5) });
  v1.get('/users/:uid/preferences', requireUser, (req, res) => res.json(prefsVo(req.auth.user.id)));
  v1.put('/users/:uid/preferences', requireUser, (req, res) => {
    const b = check(req.body, { preferences: { type: 'object', required: true } }, { unknown: 'reject' });
    const p = b.preferences;
    const errs = {};
    for (const [k, v] of Object.entries(p)) {
      const spec = PREFS[k];
      if (!spec) { errs[k] = 'is not a setting'; continue; }
      if (spec.bool ? typeof v !== 'boolean' : !spec.values.includes(v)) errs[k] = spec.bool ? 'must be true or false' : `must be one of ${spec.values.join(', ')}`;
    }
    if (!Object.keys(p).length) errs.preferences = 'nothing to change';
    if (Object.keys(errs).length) throw new ApiError(400, 'validation_failed', 'validation failed', Object.entries(errs).map(([k, v]) => `${k}: ${v}`).join('; '));
    const uid = req.auth.user.id;
    tx(db, () => { for (const [k, v] of Object.entries(p)) savePref(uid, k, v); });
    res.json(prefsVo(uid));
  });

  // ------------------------------------------------------------------ marketing texts (consent record)
  const phoneOf = (uid) => { const p = db.prepare('SELECT phone_last4, phone_verified_at FROM identity_profiles WHERE user_id=?').get(uid); return p && p.phone_verified_at ? p.phone_last4 : null; };
  const lastConsent = (uid) => db.prepare('SELECT * FROM marketing_consents WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 1').get(uid);
  function consentVo(uid) {
    const last = lastConsent(uid);
    const optedIn = !!last && last.action === 'opt_in' && last.text_version === SMS_DISCLOSURE.version;
    const firstIn = last && last.action === 'opt_in' ? last : null;
    return {
      status: !last ? 'not_set' : last.action === 'opt_in' ? (optedIn ? 'opted_in' : 'reconsent_required') : 'opted_out',
      opted_in: optedIn, disclosure: SMS_DISCLOSURE, phone_last4: phoneOf(uid),
      consented_time: firstIn ? new Date(firstIn.created_ts).toISOString() : null, consented_text_version: firstIn ? firstIn.text_version : null,
      revoked_time: last && last.action === 'opt_out' ? new Date(last.created_ts).toISOString() : null,
      history: db.prepare('SELECT action, text_version, created_ts FROM marketing_consents WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 20').all(uid)
        .map((r) => ({ action: r.action, text_version: r.text_version, time: new Date(r.created_ts).toISOString() })),
    };
  }
  const recordConsent = (req, uid, action, version) => db.prepare('INSERT INTO marketing_consents(id,user_id,action,channel,text_version,text_sha256,phone_last4,ip_prefix,device,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(newId('mc_'), uid, action, 'sms', version, sha(SMS_DISCLOSURE.text), phoneOf(uid), ipPrefix(String(req.ip || '').replace(/^::ffff:/, '')), deviceOf(req.get('user-agent')), Date.now());
  v1.get('/users/:uid/marketing_consent', requireUser, (req, res) => res.json(consentVo(req.auth.user.id)));
  v1.post('/users/:uid/marketing_consent', requireUser, (req, res) => {
    const b = check(req.body, { opt_in: { type: 'boolean', required: true }, text_version: { type: 'string', maxLen: 40 }, agreed: { type: 'boolean' } }, { unknown: 'reject' });
    const uid = req.auth.user.id;
    if (b.opt_in) {
      if (b.agreed !== true) throw new ApiError(400, 'validation_failed', 'validation failed', 'agreed: tick the box to agree to the disclosure');
      if (b.text_version !== SMS_DISCLOSURE.version) throw E.conflict('disclosure_changed', 'the disclosure text changed', 'reload the page and read the current text');
      if (!phoneOf(uid)) throw E.conflict('phone_required', 'verify a mobile number first', 'add your phone number in identity verification');
      recordConsent(req, uid, 'opt_in', SMS_DISCLOSURE.version);
      auth.logEvent(uid, 'marketing_sms_opt_in', req, { text_version: SMS_DISCLOSURE.version });
    } else {
      const last = lastConsent(uid);
      recordConsent(req, uid, 'opt_out', last ? last.text_version : SMS_DISCLOSURE.version);
      auth.logEvent(uid, 'marketing_sms_opt_out', req, {});
    }
    res.json(consentVo(uid));
  });

  // ------------------------------------------------------------------ connected apps (OAuth grants; issued from Phase 7)
  const grantVo = (g) => ({ id: g.id, name: g.client_name, client_id: g.client_id, scopes: JSON.parse(g.scopes || '[]'), authorized_time: g.created_at, last_used_time: g.last_used_at });
  v1.get('/users/:uid/connected_apps', requireUser, (req, res) => res.json({ apps: db.prepare('SELECT * FROM oauth_grants WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC').all(req.auth.user.id).map(grantVo) }));
  v1.delete('/users/:uid/connected_apps/:id', requireUser, (req, res) => {
    const g = db.prepare('SELECT * FROM oauth_grants WHERE id=? AND user_id=? AND revoked_at IS NULL').get(String(req.params.id), req.auth.user.id);
    if (!g) throw E.notFound();
    db.prepare('UPDATE oauth_grants SET revoked_at=? WHERE id=?').run(nowIso(), g.id);
    auth.logEvent(req.auth.user.id, 'connected_app_revoked', req, { app: g.client_name });
    res.json({ revoked: true });
  });

  // ------------------------------------------------------------------ Your activity (CLONE_SPEC §13.16)
  const activityFilters = (q) => history.parseFilters({ activity: String(q.type || 'all') });
  v1.get('/users/:uid/activity', requireUser, (req, res) => {
    const f = activityFilters(req.query);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const cursor = req.query.cursor ? decCursor(req.query.cursor) : null;
    const rows = history.query(req.auth.user.id, f, { limit, cursor });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    res.json({ activity: page.map(history.rowVo), cursor: rows.length > limit ? encCursor({ ts: last.ts, p: last.prio, id: last.id }) : '', type: f.activity || 'all' });
  });
  v1.get('/users/:uid/activity.csv', requireUser, (req, res) => {
    const f = activityFilters(req.query);
    const rows = history.query(req.auth.user.id, f, { limit: 10000, cursor: null }).slice(0, 10000).map(history.rowVo);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="parlance-activity-${f.activity || 'all'}.csv"`);
    res.send(history.csvOf(rows));
  });

  // ------------------------------------------------------------------ Documents: yearly P&L and simulated statements
  const yearOf = (ms) => new Date(ms).getUTCFullYear();
  // Realized P&L by year, replaying fills in time order per market (average cost; YES+NO pairs redeem for $1 as the
  // engine nets them) plus settlements (payout − remaining cost). Fees are the fills' fees; credits are promo/rebate
  // ledger credits; interest is reported separately (simulated 1099-INT).
  function yearly(uid) {
    const out = new Map();
    const Y = (y) => { if (!out.has(y)) out.set(y, { year: y, realized: 0, fees: 0, credits: 0, interest: 0, trades: 0 }); return out.get(y); };
    const fills = db.prepare('SELECT market_ticker, side, price_cc, count, fee_cents, is_taker, created_ts ts FROM fills WHERE user_id=?').all(uid).map((f) => ({ ...f, kind: 'fill' }));
    const setts = db.prepare('SELECT market_ticker, COALESCE(effective_payout_cents, payout_cents) payout_cents, cost_cents, created_at FROM settlements WHERE user_id=?').all(uid).map((s) => ({ ...s, kind: 'settle', ts: Date.parse(s.created_at) }));
    const inv = new Map();
    for (const e of [...fills, ...setts].sort((a, b) => a.ts - b.ts || (a.kind === 'fill' ? -1 : 1))) {
      const m = inv.get(e.market_ticker) || { yes: { u: 0, c: 0 }, no: { u: 0, c: 0 } };
      inv.set(e.market_ticker, m);
      const y = Y(yearOf(e.ts));
      if (e.kind === 'fill') {
        const cost = e.is_taker ? Math.ceil((e.count * e.price_cc) / (UNITS * 100)) : Math.floor((e.count * e.price_cc) / (UNITS * 100)); // price in cc (CLONE_SPEC.md §28.1)
        m[e.side].u += e.count; m[e.side].c += cost; y.fees += e.fee_cents; y.trades += 1;
        const pairs = Math.min(m.yes.u, m.no.u);
        if (pairs > 0) {
          const yc = Math.round((m.yes.c * pairs) / m.yes.u); const nc = Math.round((m.no.c * pairs) / m.no.u);
          m.yes.u -= pairs; m.no.u -= pairs; m.yes.c -= yc; m.no.c -= nc;
          y.realized += pairs - yc - nc; // `pairs` units redeem for the same number of cents
        }
      } else {
        y.realized += e.payout_cents - e.cost_cents;
        inv.delete(e.market_ticker);
      }
    }
    for (const l of db.prepare("SELECT kind, amount_cents, created_at FROM ledger WHERE user_id=? AND kind IN ('credit','interest')").all(uid)) {
      const y = Y(yearOf(Date.parse(l.created_at)));
      if (l.kind === 'credit') y.credits += l.amount_cents; else y.interest += l.amount_cents;
    }
    const u = db.prepare('SELECT created_at FROM users WHERE id=?').get(uid);
    const first = Math.min(yearOf(Date.parse(u.created_at)), ...[...out.keys()]);
    const now = yearOf(Date.now());
    for (let y = first; y <= now; y++) Y(y);
    return [...out.values()].sort((a, b) => b.year - a.year);
  }
  const FORMS = { '1099-INT': 'Interest income (simulated 1099-INT)', '1099-MISC': 'Credits and rewards (simulated 1099-MISC)', 'PNL': 'Realized profit and loss summary' };
  const formsFor = (r) => [...(r.interest > 0 ? ['1099-INT'] : []), ...(r.credits > 0 ? ['1099-MISC'] : []), 'PNL'];
  const yearVo = (uid, r) => ({
    year: r.year, pnl_with_fees_dollars: dollars(r.realized - r.fees + r.credits), pnl_without_fees_dollars: dollars(r.realized), fees_dollars: dollars(r.fees),
    credits_dollars: dollars(r.credits), interest_dollars: dollars(r.interest), trades: r.trades,
    transactions_csv: `/v1/users/${uid}/tax_documents/${r.year}/transactions.csv`,
    forms: formsFor(r).map((f) => ({ form: f, title: FORMS[f], csv: `/v1/users/${uid}/tax_documents/${r.year}/${f}.csv`, pdf: `/v1/users/${uid}/tax_documents/${r.year}/${f}.pdf` })),
  });
  const NOT_ADVICE = 'Simulated statement for a demo exchange that uses simulated funds. Not a tax form, not filed with any tax authority, and not tax advice.';
  v1.get('/users/:uid/tax_documents', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    res.json({ years: yearly(uid).map((r) => yearVo(uid, r)), not_tax_advice: true, notice: NOT_ADVICE, updated: 'monthly (simulated: computed on request)' });
  });
  const yearParam = (req) => { const y = Number(req.params.year); if (!/^\d{4}$/.test(String(req.params.year)) || y < 2000 || y > 2100) throw E.notFound(); return y; };
  const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  v1.get('/users/:uid/tax_documents/:year/transactions.csv', requireUser, (req, res) => {
    const y = yearParam(req);
    const rows = db.prepare('SELECT * FROM ledger WHERE user_id=? AND created_at>=? AND created_at<? ORDER BY created_at, rowid').all(req.auth.user.id, `${y}-01-01T00:00:00.000Z`, `${y + 1}-01-01T00:00:00.000Z`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="parlance-transactions-${y}.csv"`);
    res.send([`time,type,${C.csvCol('amount', 'amount_usd')},reference,memo`, ...rows.map((l) => [l.created_at, l.kind, C.csvCents(l.amount_cents), l.ref || '', l.memo].map(csvCell).join(','))].join('\n') + '\n');
  });
  function statement(uid, y, form) {
    const r = yearly(uid).find((x) => x.year === y);
    if (!r || !formsFor(r).includes(form)) throw E.notFound();
    const u = db.prepare('SELECT id, email, display_name FROM users WHERE id=?').get(uid);
    const rows = [['Statement', FORMS[form]], ['Tax year', String(y)], ['Account', `${u.display_name} (${u.id.slice(-8)})`]];
    if (form === '1099-INT') rows.push(['Interest credited', C.moneyCents(r.interest)]);
    if (form === '1099-MISC') rows.push(['Credits and rewards', C.moneyCents(r.credits)]);
    if (form === 'PNL') rows.push(['Trades (fills)', String(r.trades)], ['Realized P&L without fees', C.moneyCents(r.realized)], ['Fees', C.moneyCents(r.fees)], ['Credits and rebates', C.moneyCents(r.credits)], ['Realized P&L with fees', C.moneyCents(r.realized - r.fees + r.credits)]);
    return { rows, title: `Parlance ${form} ${y}` };
  }
  v1.get('/users/:uid/tax_documents/:year/:form.csv', requireUser, (req, res) => {
    const s = statement(req.auth.user.id, yearParam(req), String(req.params.form));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="parlance-${req.params.form}-${req.params.year}.csv"`);
    res.send(['field,value', ...s.rows.map((r) => r.map(csvCell).join(',')), `notice,${csvCell(NOT_ADVICE)}`].join('\n') + '\n');
  });
  v1.get('/users/:uid/tax_documents/:year/:form.pdf', requireUser, (req, res) => {
    const s = statement(req.auth.user.id, yearParam(req), String(req.params.form));
    const lines = [{ text: 'Parlance Exchange', size: 18, bold: true }, { text: s.title, size: 13, bold: true, gap: 4 }, { text: 'SIMULATED STATEMENT - NOT A TAX FORM - NOT TAX ADVICE', size: 10, bold: true, gap: 6 },
      ...s.rows.map(([k, v], i) => ({ text: `${k}: ${v}`, size: 11, gap: i ? 0 : 10 })),
      { text: CS.t('statement.currency_line', { name: C.descriptor().name, code: C.config().code, rule: C.descriptor().rule }), size: 9, gap: 10 }, // display currency (CLONE_SPEC.md §30)
      { text: NOT_ADVICE, size: 9, gap: 14 }, { text: CS.t('statement.generated', { local: C.dateTimeLabel(Date.now()), iso: nowIso() }), size: 8, gap: 4 }];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="parlance-${req.params.form}-${req.params.year}.pdf"`);
    res.send(textPdf(lines, { title: s.title }));
  });

  // ------------------------------------------------------------------ rewards: new-user checklist (CLONE_SPEC §13.19)
  function checklist(uid) {
    const done = {
      verify_identity: identity.statusOf(uid) === 'approved',
      first_deposit: !!db.prepare("SELECT 1 FROM ledger WHERE user_id=? AND kind='deposit' LIMIT 1").get(uid),
      first_trade: !!db.prepare('SELECT 1 FROM fills WHERE user_id=? LIMIT 1').get(uid),
      complete_profile: !!db.prepare('SELECT 1 FROM social_profiles WHERE user_id=?').get(uid),
    };
    return { variant: 'standard', revamp_enabled: false, steps: STEPS.map(([step, title, link]) => ({ step, title, link, status: done[step] ? 'completed' : 'incomplete' })), completed: Object.values(done).filter(Boolean).length };
  }
  v1.get('/rewards/new_user_checklist', (req, res) => { if (!req.auth) throw E.unauthorized(); res.json(checklist(req.auth.user.id)); });

  // ------------------------------------------------------------------ promo codes (A12)
  const CODE_RE = /^[A-Z0-9][A-Z0-9-]{3,31}$/;
  const promoVo = (p) => ({ id: p.id, code: p.code, description: p.description, amount_dollars: dollars(p.amount_cents), max_redemptions: p.max_redemptions, redeemed_count: p.redeemed_count,
    starts_time: p.starts_at, ends_time: p.ends_at, active: !!p.active, created_time: p.created_at });
  v1.get('/users/:uid/promo_codes', requireUser, (req, res) => {
    res.json({ redemptions: db.prepare('SELECT r.*, p.code, p.description FROM promo_redemptions r JOIN promo_codes p ON p.id=r.promo_id WHERE r.user_id=? ORDER BY r.created_ts DESC').all(req.auth.user.id)
      .map((r) => ({ code: r.code, description: r.description, amount_dollars: dollars(r.amount_cents), redeemed_time: new Date(r.created_ts).toISOString() })) });
  });
  v1.post('/users/:uid/promo_codes', requireUser, (req, res) => {
    const b = check(req.body, { code: { type: 'string', maxLen: 40, required: true } }, { unknown: 'reject' });
    const uid = req.auth.user.id;
    const now = Date.now();
    db.prepare('DELETE FROM promo_attempts WHERE ts<?').run(now - 3600000);
    if (db.prepare('SELECT COUNT(*) c FROM promo_attempts WHERE user_id=?').get(uid).c >= 10) throw new ApiError(429, 'too_many_attempts', 'too many promo code attempts', 'try again in an hour');
    const code = b.code.trim().toUpperCase();
    const invalid = () => { db.prepare('INSERT INTO promo_attempts(user_id,ts) VALUES(?,?)').run(uid, now); return new ApiError(400, 'promo_invalid', 'this promo code isn’t valid', 'check the code and try again'); };
    if (!CODE_RE.test(code)) throw invalid();
    const p = db.prepare('SELECT * FROM promo_codes WHERE code=?').get(code);
    if (!p || !p.active || (p.starts_at && Date.parse(p.starts_at) > now) || (p.ends_at && Date.parse(p.ends_at) <= now)) throw invalid();
    if (identity.enforced() && identity.statusOf(uid) !== 'approved') throw new ApiError(403, 'identity_verification_required', 'verify your identity to redeem promo codes', 'finish identity verification to continue');
    if (db.prepare('SELECT 1 FROM promo_redemptions WHERE promo_id=? AND user_id=?').get(p.id, uid)) throw E.conflict('promo_already_redeemed', 'you already used this promo code');
    let ledgerId = null;
    tx(db, () => {
      // Cap check and increment in one conditional update, so concurrent redemptions cannot exceed max_redemptions.
      if (db.prepare('UPDATE promo_codes SET redeemed_count=redeemed_count+1 WHERE id=? AND (max_redemptions IS NULL OR redeemed_count<max_redemptions)').run(p.id).changes !== 1) throw E.conflict('promo_exhausted', 'this promo code has been fully redeemed');
      const rid = newId('pr_');
      db.prepare('INSERT INTO promo_redemptions(id,promo_id,user_id,amount_cents,created_ts) VALUES(?,?,?,?,?)').run(rid, p.id, uid, p.amount_cents, now);
      engine.credit(uid, p.amount_cents, 'credit', p.id, `Promo code ${p.code}`);
      ledgerId = db.prepare("SELECT id FROM ledger WHERE user_id=? AND kind='credit' AND ref=? ORDER BY rowid DESC LIMIT 1").get(uid, p.id)?.id || null;
      db.prepare('UPDATE promo_redemptions SET ledger_id=? WHERE id=?').run(ledgerId, rid);
    });
    engine.emit('user_balance', uid, engine.balance(uid));
    auth.logEvent(uid, 'promo_redeemed', req, { code: p.code });
    try { notify(uid, { type: 'reward', title: CS.t('notify.promo.title', { amount: C.moneyCents(p.amount_cents) }), body: p.description || p.code, link: '/account/activity' }); } catch { /* ignore */ }
    res.status(201).json({ code: p.code, amount_dollars: dollars(p.amount_cents), balance_dollars: dollars(engine.balance(uid)) });
  });
  v1.get('/admin/promo_codes', can('users.money'), (req, res) => res.json({ promo_codes: db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 500').all().map(promoVo) }));
  v1.post('/admin/promo_codes', can('users.money'), (req, res) => {
    const b = check(req.body, { code: { type: 'string', maxLen: 32, required: true }, amount_dollars: { type: ['number', 'string'], maxLen: 12, required: true }, description: { type: 'string', maxLen: 140 },
      max_redemptions: { type: 'integer', min: 1, max: 1000000, nullable: true }, starts_time: { type: 'string', maxLen: 40, nullable: true }, ends_time: { type: 'string', maxLen: 40, nullable: true }, reason: { type: 'string', maxLen: 500 } }, { unknown: 'reject' });
    const errs = {};
    const code = b.code.trim().toUpperCase();
    if (!CODE_RE.test(code)) errs.code = '4-32 characters: A-Z, 0-9 and dashes';
    else if (db.prepare('SELECT 1 FROM promo_codes WHERE code=?').get(code)) errs.code = 'is already used';
    const amt = Number(b.amount_dollars);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1000 || Math.round(amt * 100) !== amt * 100) errs.amount_dollars = CS.t('error.promo_amount', { max: C.moneyCents(100000) });
    const time = (v, k) => { if (v == null || v === '') return null; const t = Date.parse(v); if (!Number.isFinite(t)) { errs[k] = 'must be a date and time'; return null; } return new Date(t).toISOString(); };
    const starts = time(b.starts_time, 'starts_time'); const ends = time(b.ends_time, 'ends_time');
    if (starts && ends && Date.parse(ends) <= Date.parse(starts)) errs.ends_time = 'must be after the start';
    if (Object.keys(errs).length) throw new ApiError(400, 'validation_failed', 'validation failed', Object.entries(errs).map(([k, v]) => `${k}: ${v}`).join('; '));
    const id = newId('promo_');
    db.prepare('INSERT INTO promo_codes(id,code,description,amount_cents,max_redemptions,starts_at,ends_at,active,created_by,created_at) VALUES(?,?,?,?,?,?,?,1,?,?)')
      .run(id, code, String(b.description || '').trim(), Math.round(amt * 100), b.max_redemptions ?? null, starts, ends, req.auth.user.id, nowIso());
    const p = db.prepare('SELECT * FROM promo_codes WHERE id=?').get(id);
    audit(req, 'promo.create', 'promo_code', id, null, promoVo(p), String(b.reason || '').trim());
    res.status(201).json({ promo_code: promoVo(p) });
  });
  v1.put('/admin/promo_codes/:id', can('users.money'), (req, res) => {
    const b = check(req.body, { active: { type: 'boolean', required: true }, reason: { type: 'string', maxLen: 500 } }, { unknown: 'reject' });
    const p = db.prepare('SELECT * FROM promo_codes WHERE id=?').get(String(req.params.id));
    if (!p) throw E.notFound();
    db.prepare('UPDATE promo_codes SET active=? WHERE id=?').run(b.active ? 1 : 0, p.id);
    const after = db.prepare('SELECT * FROM promo_codes WHERE id=?').get(p.id);
    audit(req, b.active ? 'promo.enable' : 'promo.disable', 'promo_code', p.id, promoVo(p), promoVo(after), String(b.reason || '').trim());
    res.json({ promo_code: promoVo(after) });
  });

  // ------------------------------------------------------------------ data export section (server/identity.js)
  function exportFor(uid) {
    return {
      preferences: prefsOf(uid),
      marketing_consent: db.prepare('SELECT action, channel, text_version, created_ts FROM marketing_consents WHERE user_id=? ORDER BY created_ts').all(uid).map((r) => ({ ...r, time: new Date(r.created_ts).toISOString() })),
      connected_apps: db.prepare('SELECT client_name, scopes, created_at, revoked_at FROM oauth_grants WHERE user_id=?').all(uid),
      promo_redemptions: db.prepare('SELECT p.code, r.amount_cents, r.created_ts FROM promo_redemptions r JOIN promo_codes p ON p.id=r.promo_id WHERE r.user_id=?').all(uid),
    };
  }
  identity.setAccountArea({ exportFor });
  return { prefsOf, exportFor, checklist, SMS_DISCLOSURE, PREFS };
}

module.exports = { mountAccountArea, PREFS, SMS_DISCLOSURE };
