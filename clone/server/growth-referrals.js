'use strict';
// Predictions referrals (PLAN P8.1, CLONE_SPEC.md §38.2): the second program of the reusable referral module
// (server/referrals.js, §34.8). Flag `referrals.predictions`.
//
//   offer        owner decision 2026-11-08 (ground rule 6): ₦1,000 to the referrer and ₦500 to the friend once the friend
//                has traded ₦10,000 (1 internal cent = ₦1, §30), editable in Admin › Growth › Referrals (users.money, a
//                reason, step-up, audited). Lifetime caps per referrer: 20 rewards / ₦20,000.
//   attribution  a code typed on Rewards, the `plx_ref` cookie of a referral or share link (read at sign-up), or the
//                `ref` a guest gave the real-money waitlist (applied when the account's email is verified and the entry
//                links to it, §36.2). Within 30 days of sign-up and before the friend's first trade.
//   volume       every Predictions fill of the friend (engine `fill` events), at its traded value; fills whose counterparty
//                is the referrer never count (the pair trading with each other), system accounts never qualify.
//   money        play mode: play money (minted, ledger kind `bonus`); production: the promotions treasury (the Central Bank
//                vault, §33.7) as a non-withdrawable credit, paid at once, queued FIFO or refused when the vault is empty;
//                without the Central Bank nothing is paid (status refused).
//   fraud        beyond the account (P3.7): the friend and the referrer on the same device, the same payment card / bank
//                account / wallet, many referred sign-ups from one network in 24 h (an owner setting), or a friend whose
//                P3.7 risk score is at or above the hold threshold. A qualifying referral with any signal is held in the
//                admin review queue (Admin › Growth): approve pays both sides, reject pays nothing; both audited.
const kc = require('./crypto');
const C = require('./currency');
const P = require('./pricing');
const { createReferrals, SPEC: REF_SPEC, ReferralError } = require('./referrals');
const { ApiError, E } = require('./util');
const { s: GS } = require('./content/growth');

const PROGRAM = 'predictions';
// Internal cents; the display rule 1 cent = ₦1 (§30) makes these ₦1,000, ₦500, ₦10,000 and ₦20,000.
const DEFAULTS = { reward_referrer_cents: 1000, reward_referee_cents: 500, threshold_cents: 10000, lifetime_cap_count: 20, lifetime_cap_cents: 20000 };
const DAY = 86400000;
const COOKIE = 'plx_ref';
const CODE_RE = /^[A-Z0-9]{6,16}$/;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

function mountPredictionReferrals({ v1, db, engine, auth, admin, flags, feat, centralBank, identity, security, waitlists, keyDir, options = {} }) {
  const epoch = () => (engine.money ? engine.money.epoch() : '');
  const referrals = createReferrals({ db, epoch });
  const OS = engine.ownerSettings;
  const ipKey = kc.deriveKey('referral-ip:v1', { dir: keyDir });
  const ipHash = (req) => { const ip = security && security.clientIp ? security.clientIp(req) : req.ip; return ip ? kc.hmacHex(ipKey, String(ip)).slice(0, 32) : null; };
  const isSystem = (uid) => !!db.prepare('SELECT is_system FROM users WHERE id=?').get(uid)?.is_system;
  const emailOf = (id) => db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || id;
  const can = admin.can;
  const notify = (uid, msg) => { try { feat.notify(uid, msg); } catch (e) { console.error('referral notify', e.message); } };

  // ---------------------------------------------------------------- money
  if (centralBank) {
    // Queued treasury payouts land here when the vault is funded: the credit, then the reward row is marked paid.
    centralBank.destinations.predictions_referral = (q, contra) => {
      engine.credit(q.user_id, q.amount_cents, 'credit', q.ref, q.memo, { contra });
      if (q.dest.reward_id) db.prepare("UPDATE referral_rewards SET status='paid' WHERE id=? AND status='queued'").run(q.dest.reward_id);
    };
  }
  function payout({ uid, cents, role, referral, rewardId }) {
    const memo = GS(role === 'referrer' ? 'referral.memo_referrer' : 'referral.memo_referee');
    if (engine.money && engine.money.playOn()) {
      engine.credit(uid, cents, 'bonus', referral.id, memo, { contra: 'play:mint' });
      return { paid: true };
    }
    if (engine.treasury && engine.treasury.active()) return engine.treasury.pay({ uid, cents, mode: 'credit', kind: 'credit', purpose: 'referral', ref: referral.id, memo, dest: { kind: 'predictions_referral', reward_id: rewardId } });
    return { refused: true, reason: 'treasury_off' };
  }

  // ---------------------------------------------------------------- fraud signals (beyond the account)
  function review(r) {
    const out = [];
    const shared = db.prepare('SELECT COUNT(*) c FROM device_sightings a JOIN device_sightings b ON a.device_hash=b.device_hash WHERE a.user_id=? AND b.user_id=?');
    try { if (shared.get(r.referee_id, r.referrer_id).c > 0) out.push({ signal: 'shared_device', detail: GS('referral.signal.shared_device') }); } catch { /* no compliance module */ }
    try {
      const pm = db.prepare(`SELECT COUNT(*) c FROM payment_methods a JOIN payment_methods b ON a.type=b.type AND (
          (a.type='card' AND a.brand=b.brand AND a.last4=b.last4 AND a.exp_month=b.exp_month AND a.exp_year=b.exp_year)
          OR (a.type='bank' AND a.institution=b.institution AND a.mask=b.mask)
          OR (a.address IS NOT NULL AND a.address<>'' AND a.address=b.address))
        WHERE a.user_id=? AND b.user_id=?`).get(r.referee_id, r.referrer_id).c;
      if (pm > 0) out.push({ signal: 'shared_payment_instrument', detail: GS('referral.signal.shared_payment_instrument') });
    } catch { /* no payments module */ }
    if (r.ip_hash) {
      const n = db.prepare('SELECT COUNT(*) c FROM referrals WHERE program=? AND referrer_id=? AND ip_hash=? AND created_ts>?').get(PROGRAM, r.referrer_id, r.ip_hash, r.created_ts - DAY).c;
      const limit = OS.get('referrals.review_ip_signups_per_day');
      if (n >= limit) out.push({ signal: 'ip_velocity', detail: GS('referral.signal.ip_velocity', { count: n }) });
    }
    try {
      const risk = identity && identity.compliance ? identity.compliance.riskSummary(r.referee_id) : null;
      const threshold = identity && identity.settings ? identity.settings().fraud.hold_threshold : 60;
      if (risk && risk.latest_score != null && threshold != null && risk.latest_score >= threshold) out.push({ signal: 'high_risk_score', detail: GS('referral.signal.high_risk_score', { score: risk.latest_score, threshold }) });
    } catch { /* no identity module */ }
    return out;
  }

  referrals.register(PROGRAM, {
    defaults: DEFAULTS,
    rewardType: 'predictions_cash',
    eligible: (uid) => !db.prepare('SELECT 1 FROM fills WHERE user_id=? LIMIT 1').get(uid), // before the friend's first trade
    payout,
    review,
  });
  const settings = () => referrals.settings(PROGRAM);

  // ---------------------------------------------------------------- volume from fills
  const announce = (r) => {
    if (!r) return;
    for (const w of r.rewards) {
      if (w.status !== 'paid' && w.status !== 'queued') continue;
      const amount = C.moneyCents(w.amount_cents);
      notify(w.user_id, { type: 'referral_reward', title: GS('referral.notify.title', { amount }), body: w.status === 'queued' ? GS('referral.notify.queued', { amount }) : GS(w.role === 'referrer' ? 'referral.notify.body_referrer' : 'referral.notify.body_referee', { amount }), link: '/rewards' });
      engine.emit('user_balance', w.user_id, engine.balance(w.user_id));
    }
    if (r.review) {
      for (const uid of [r.referral.referrer_id, r.referral.referee_id]) notify(uid, { type: 'referral_reward', title: GS('referral.notify.review.title'), body: GS('referral.notify.review.body'), link: '/rewards' });
      const ROLE_PERMS = require('./admin').ROLE_PERMS;
      for (const u of db.prepare('SELECT * FROM users WHERE is_admin=1 OR id IN (SELECT user_id FROM admin_roles)').all()) {
        if (admin.rolesOf(u).some((role) => (ROLE_PERMS[role] || []).includes('users.money'))) notify(u.id, { type: 'admin_approval', title: GS('referral.notify.admin.title'), body: GS('referral.notify.admin.body', { signals: r.review.signals.map((x) => x.detail).join('; ') }), link: '/admin/growth' });
      }
    }
    if (centralBank && r.rewards.length) centralBank.emitVault();
    engine.emit('referrals', { program: PROGRAM, type: 'changed' });
  };
  engine.on('fill', (uid, f) => {
    try {
      if (!flags.jobOn('referrals.predictions') || isSystem(uid)) return;
      const cents = Math.round((Number(f.count) * Number(f.price_cc)) / P.CC);
      const other = db.prepare('SELECT user_id FROM fills WHERE trade_id=? AND user_id<>? LIMIT 1').get(f.trade_id, uid);
      announce(referrals.progress(uid, PROGRAM, cents, { counterparty: other ? other.user_id : null }));
    } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('referral progress', e.message); }
  });
  let lastExpire = 0;
  engine.on('tick', () => { if (Date.now() - lastExpire > 60000 && flags.jobOn('referrals.predictions')) { lastExpire = Date.now(); try { referrals.expire(PROGRAM); } catch { /* closing */ } } });

  // ---------------------------------------------------------------- attribution
  // A code that arrives with an account (cookie at sign-up, waitlist ref on verification) is applied quietly: a wrong,
  // own or late code is ignored (the member can still type one on Rewards).
  function attribute(uid, code, source, req = null) {
    const c = String(code || '').trim().toUpperCase();
    if (!CODE_RE.test(c) || !flags.on('referrals.predictions', { uid })) return null;
    try {
      const r = referrals.apply(uid, c, PROGRAM, { source, ipHash: req ? ipHash(req) : null, skipLimit: true });
      engine.emit('referrals', { program: PROGRAM, type: 'changed' });
      return r;
    } catch (e) { if (!(e instanceof ReferralError)) console.error('referral attribution', e.message); return null; }
  }
  auth.events.on('signup', ({ user, req }) => { const c = parseCookies(req && req.headers && req.headers.cookie)[COOKIE]; if (c) attribute(user.id, c, 'link', req); });
  // The waitlist's `ref` carries over once the entry joins the verified account (CLONE_SPEC.md §36.2, §38.2).
  if (waitlists && waitlists.hooks) {
    waitlists.hooks.verified.push((uid) => {
      const e = db.prepare("SELECT ref_code FROM waitlist_entries WHERE user_id=? AND ref_code IS NOT NULL ORDER BY joined_ts LIMIT 1").get(uid);
      if (e && e.ref_code) attribute(uid, e.ref_code, 'waitlist');
    });
  }

  // ---------------------------------------------------------------- routes
  const REF_ERR = {
    referral_program_off: () => E.conflict('referral_program_off', GS('error.referral_off')),
    referral_rate_limited: () => new ApiError(429, 'too_many_requests', GS('error.referral_rate')),
    referral_code_invalid: () => new ApiError(400, 'referral_code_invalid', GS('error.referral_code')),
    referral_self: () => E.conflict('referral_self', GS('error.referral_self')),
    referral_already_used: () => E.conflict('referral_already_used', GS('error.referral_used')),
    referral_too_late: () => E.conflict('referral_too_late', GS('error.referral_late', { days: settings().signup_window_days })),
    referral_review_closed: () => E.conflict('referral_review_closed', GS('error.referral_review_closed')),
    referral_review_not_found: () => E.notFound(),
  };
  const wrap = (fn) => (req, res) => { try { return fn(req, res); } catch (e) { if (e instanceof ReferralError && REF_ERR[e.code]) throw REF_ERR[e.code](); throw e; } };
  const requireUser = (req, res, next) => (req.auth ? next() : next(E.unauthorized()));
  const offerVo = () => { const s = settings(); return { enabled: !!s.enabled, referrer_reward: C.moneyCents(s.reward_referrer_cents), referee_reward: C.moneyCents(s.reward_referee_cents), threshold: C.moneyCents(s.threshold_cents), referrer_reward_cents: s.reward_referrer_cents, referee_reward_cents: s.reward_referee_cents, threshold_cents: s.threshold_cents, expiry_days: s.expiry_days, signup_window_days: s.signup_window_days }; };
  v1.get('/referrals/offer', (req, res) => res.json({ offer: offerVo() }));
  v1.get('/referrals', requireUser, (req, res) => res.json({ referrals: { ...referrals.summary(req.auth.user.id, PROGRAM), offer: offerVo(), link_path: `/?ref=${referrals.codeFor(req.auth.user.id, PROGRAM)}` } }));
  v1.post('/referrals/apply', requireUser, wrap((req, res) => {
    const code = String((req.body || {}).code || '');
    if (code.length > 32) throw REF_ERR.referral_code_invalid();
    const r = referrals.apply(req.auth.user.id, code, PROGRAM, { source: 'code', ipHash: ipHash(req) });
    engine.emit('referrals', { program: PROGRAM, type: 'changed' });
    void r;
    res.status(201).json({ referrals: { ...referrals.summary(req.auth.user.id, PROGRAM), offer: offerVo() } });
  }));

  // ---------------------------------------------------------------- admin: Admin › Growth › Referrals
  const reasonOf = (b) => { const r = String((b && b.reason) || '').trim(); if (r.length < 3 || r.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); return r; };
  v1.get('/admin/referrals', can('users.read'), (req, res) => res.json({ ...referrals.adminList(PROGRAM), offer: offerVo(), spec: REF_SPEC, ip_signups_review: OS.get('referrals.review_ip_signups_per_day') }));
  v1.put('/admin/referrals/settings', can('users.money'), (req, res) => {
    const b = req.body || {};
    const errs = {}; const next = {};
    for (const [k, v] of Object.entries(b)) {
      if (k === 'reason') continue;
      const sp = REF_SPEC[k];
      if (!sp) { errs[k] = 'is not a referral setting'; continue; }
      if (sp.type === 'boolean') { if (typeof v !== 'boolean') errs[k] = 'must be true or false'; else next[k] = v; continue; }
      const n = Number(v);
      if (v === '' || v == null || !Number.isInteger(n) || n < sp.min || n > sp.max) errs[k] = `must be a whole number from ${sp.min} to ${sp.max}`; else next[k] = n;
    }
    let reason = null;
    try { reason = reasonOf(b); } catch { errs.reason = 'a reason of 3-500 characters is required'; }
    if (!Object.keys(next).length && !errs.reason) errs.body = 'nothing to change';
    if (Object.keys(errs).length) { const e = new ApiError(400, 'validation_failed', 'validation failed', Object.entries(errs).map(([k, m]) => `${k}: ${m}`).join('; ')); e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: errs } }); throw e; }
    auth.assertFresh(req, 'referral_settings'); // rewards are money
    const before = settings();
    const after = { ...before, ...next };
    admin.putSetting(`referrals:${PROGRAM}`, after, req.auth.user.id);
    admin.audit(req, 'referrals.settings', 'settings', `referrals:${PROGRAM}`, before, after, reason);
    engine.emit('referrals', { program: PROGRAM, type: 'changed' });
    res.json({ ...referrals.adminList(PROGRAM), offer: offerVo() });
  });
  const decide = (approve) => wrap((req, res) => {
    const note = String((req.body || {}).note || '').trim();
    if (note.length < 3 || note.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'note: a reason of 3-500 characters is required');
    if (approve) auth.assertFresh(req, 'referral_review'); // approving pays money
    const out = referrals.decideReview(String(req.params.id), approve, { actorId: req.auth.user.id, note });
    admin.audit(req, approve ? 'referrals.review.approve' : 'referrals.review.reject', 'referral', out.review.referral_id, { status: 'review' }, { status: out.referral ? out.referral.status : null, rewards: out.rewards.map((w) => ({ user: emailOf(w.user_id), role: w.role, amount_cents: w.amount_cents, status: w.status })) }, note);
    if (approve) announce({ rewards: out.rewards });
    else if (out.referral) for (const uid of [out.referral.referrer_id, out.referral.referee_id]) notify(uid, { type: 'referral_reward', title: GS('referral.notify.rejected.title'), body: GS('referral.notify.rejected.body'), link: '/rewards' });
    engine.emit('referrals', { program: PROGRAM, type: 'changed' });
    res.json({ ...referrals.adminList(PROGRAM), offer: offerVo() });
  });
  v1.post('/admin/referrals/reviews/:id/approve', can('users.money'), decide(true));
  v1.post('/admin/referrals/reviews/:id/reject', can('users.money'), decide(false));

  void options; void DAY;
  return { referrals, attribute, codeFor: (uid) => referrals.codeFor(uid, PROGRAM), settings, COOKIE };
}

module.exports = { mountPredictionReferrals, PROGRAM };
