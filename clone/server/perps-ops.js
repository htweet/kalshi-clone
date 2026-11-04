'use strict';
// Perps operations and growth (PLAN P6.2–P6.3, CLONE_SPEC.md §34): Admin › Perps ops (margin tiers, risk limits, APY,
// waitlist, referral settings, the perps journal), and the user side of the waitlist, collateral APY and Perps referrals.
//
// Money: APY and referral rewards are paid into Perps collateral through creditCollateral (server/perps.js), which posts
// the main journal (source → perps:collateral) and the perps journal (perps:bridge → the subaccount) in one transaction:
//   play mode            play money, minted from `play:mint`;
//   production           the promotions treasury (the Central Bank vault, §33): paid while the vault covers it, else
//                        queued (paid FIFO when funded) or refused, per the treasury setting;
//   production, no bank  refused (no budget, no payout), as for the signup bonus.
// Waitlist (flag `perps.waitlist`, off by default): while on, Perps writes that add risk or money (orders, amends,
// transfers in, subaccounts, order groups) need an approved waitlist entry; reads, cancels, closes, reduce-only orders,
// exit triggers and transfers back to Predictions always work, so nobody's money is trapped. Staff and users who already
// had Perps activity are approved automatically ("grandfathered"). Enforced in the flag gate, before any route runs.
const { tx } = require('./db');
const { newId, nowIso, dollars, ApiError, E } = require('./util');
const C = require('./currency');
const R = require('./perps-risk');
const PL = require('./perps-ledger');
const journal = require('./journal');
const { createReferrals, SPEC: REF_SPEC, ReferralError } = require('./referrals');
const { check: checkBody } = require('./validate');
const { s: PS } = require('./content/perps');

const DAY = 86400000;
const YEAR = 365 * DAY;
const APY_DEFAULTS = { enabled: false, rate_bps: 700, payout_interval_ms: DAY };
const APY_SPEC = { enabled: { type: 'boolean' }, rate_bps: { type: 'integer', min: 0, max: 5000 }, payout_interval_ms: { type: 'integer', min: 60000, max: 31 * DAY } };
const PERPS_REFERRAL_DEFAULTS = { reward_referrer_cents: 1000, reward_referee_cents: 500, threshold_cents: 10000 };
const SCHEMA = `
CREATE TABLE IF NOT EXISTS perp_waitlist (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL, joined_ts INTEGER NOT NULL, decided_ts INTEGER, decided_by TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS idx_perp_waitlist ON perp_waitlist(status, joined_ts);
CREATE TABLE IF NOT EXISTS perp_apy_accruals (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, subaccount INTEGER NOT NULL, accrued_cc REAL NOT NULL DEFAULT 0, base_cc INTEGER NOT NULL DEFAULT 0,
  updated_ts INTEGER NOT NULL, PRIMARY KEY (user_id, subaccount));
CREATE TABLE IF NOT EXISTS perp_apy_payouts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subaccount INTEGER NOT NULL, rate_bps INTEGER NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL,
  source TEXT NOT NULL, queue_id TEXT, created_ts INTEGER NOT NULL, epoch TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_perp_apy_payouts_user ON perp_apy_payouts(user_id, created_ts);
CREATE TABLE IF NOT EXISTS pm_archive_perps_balances (batch_id TEXT NOT NULL, user_id TEXT NOT NULL, subaccount INTEGER NOT NULL, available_cc INTEGER NOT NULL, apy_accrued_cc REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, user_id, subaccount));
`;

function mountPerpsOps({ v1, db, engine, auth, admin, flags, feat, centralBank, options = {} }) {
  const P = engine.perps;
  if (!P) return null;
  db.exec(SCHEMA);
  const production = process.env.NODE_ENV === 'production';
  const apyOpts = options.apy || {};
  if (apyOpts.now && production) console.warn('perps.apy.now is ignored in production');
  const clock = !production && typeof apyOpts.now === 'function' ? apyOpts.now : () => Date.now(); // test clock: start options only
  const epoch = () => (engine.money ? engine.money.epoch() : '');
  const can = admin.can;
  const notify = (uid, msg) => { try { feat.notify(uid, msg); } catch (e) { console.error('perps notify', e.message); } };
  const setting = (key, def) => { const r = db.prepare('SELECT value FROM admin_settings WHERE key=?').get(key); return { ...def, ...(r ? JSON.parse(r.value) : {}) }; };
  const reasonOf = (b) => { const r = String((b && b.reason) || '').trim(); if (r.length < 3 || r.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); return r; };
  const fieldErr = (errs) => { const e = new ApiError(400, 'validation_failed', 'validation failed', Object.entries(errs).map(([k, m]) => `${k}: ${m}`).join('; ')); e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: errs } }); return e; };
  const emailOf = (id) => (id ? db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || id : null);
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const requireUser = (req, res, next) => (req.auth ? next() : next(E.unauthorized()));
  const isSystem = (uid) => !!db.prepare('SELECT is_system FROM users WHERE id=?').get(uid)?.is_system;

  // ---------------------------------------------------------------- treasury → Perps collateral
  if (centralBank) {
    centralBank.destinations.perps = (q, contra) => {
      const sub = q.dest.subaccount || 0;
      P.creditCollateral(q.user_id, sub, q.amount_cents, { kind: q.dest.ledger_kind || 'reward', ref: q.ref, memo: q.memo, contra });
      if (q.dest.apy_payout_id) db.prepare("UPDATE perp_apy_payouts SET status='paid' WHERE id=? AND status='queued'").run(q.dest.apy_payout_id);
      if (q.dest.reward_id) db.prepare("UPDATE referral_rewards SET status='paid' WHERE id=? AND status='queued'").run(q.dest.reward_id);
      P.emitUser(q.user_id, []);
    };
  }
  function payToPerps({ uid, sub = 0, cents, kind, purpose, ref, memo, link = {} }) {
    if (engine.money && engine.money.playOn()) {
      P.creditCollateral(uid, sub, cents, { kind, ref, memo, contra: 'play:mint' });
      return { paid: true, source: 'play' };
    }
    if (engine.treasury && engine.treasury.active()) {
      const r = engine.treasury.pay({ uid, cents, kind, purpose, ref, memo, dest: { kind: 'perps', subaccount: sub, ledger_kind: kind, ...link } });
      return { ...r, source: 'treasury' };
    }
    return { refused: true, reason: 'treasury_off', source: 'none' };
  }

  // ---------------------------------------------------------------- APY on Perps collateral
  const apySettings = () => setting('perps_apy', APY_DEFAULTS);
  const apyState = () => setting('perps_apy_state', { last_ts: null, next_payout_ts: null });
  const putState = (v) => admin.putSetting('perps_apy_state', v, null);
  // Collateral that earns: free + held by orders + locked in positions (unrealized PnL does not), per subaccount.
  function bases() {
    const out = new Map();
    const add = (uid, sub, cc) => { if (!cc) return; const k = `${uid}\u0000${sub}`; const x = out.get(k) || { uid, sub, base: 0 }; x.base += cc; out.set(k, x); };
    const cust = "user_id IN (SELECT id FROM users WHERE is_system=0)";
    for (const r of db.prepare(`SELECT user_id, available_cc c FROM perp_accounts WHERE available_cc>0 AND ${cust}`).all()) add(r.user_id, 0, r.c);
    for (const r of db.prepare(`SELECT user_id, subaccount, available_cc c FROM perp_subaccounts WHERE subaccount>0 AND available_cc>0 AND ${cust}`).all()) add(r.user_id, r.subaccount, r.c);
    for (const r of db.prepare(`SELECT user_id, subaccount, SUM(reserved_cc) c FROM perp_orders WHERE status='resting' AND reserved_cc>0 AND ${cust} GROUP BY user_id, subaccount`).all()) add(r.user_id, r.subaccount, r.c);
    for (const r of db.prepare(`SELECT user_id, subaccount, SUM(margin_cc) c FROM perp_positions WHERE margin_cc>0 AND ${cust} GROUP BY user_id, subaccount`).all()) add(r.user_id, r.subaccount, r.c);
    return [...out.values()];
  }
  const lastApyNotice = new Map();
  function accrue(now) {
    const s = apySettings(); const st = apyState();
    const on = s.enabled && s.rate_bps > 0 && flags.jobOn('perps.apy');
    if (!on) { if (st.last_ts != null || st.next_payout_ts != null) putState({ last_ts: null, next_payout_ts: null }); return; }
    if (st.last_ts == null) { putState({ last_ts: now, next_payout_ts: now + s.payout_interval_ms }); return; }
    const dt = now - st.last_ts;
    if (dt < 1000) return; // one accrual step per second of the clock at most
    const k = (s.rate_bps / 10000) * (dt / YEAR);
    tx(db, () => {
      const up = db.prepare('INSERT INTO perp_apy_accruals(user_id,subaccount,accrued_cc,base_cc,updated_ts) VALUES(?,?,?,?,?) ON CONFLICT(user_id,subaccount) DO UPDATE SET accrued_cc=accrued_cc+excluded.accrued_cc, base_cc=excluded.base_cc, updated_ts=excluded.updated_ts');
      for (const b of bases()) up.run(b.uid, b.sub, b.base * k, b.base, now);
      putState({ last_ts: now, next_payout_ts: st.next_payout_ts ?? now + s.payout_interval_ms });
    });
    if (st.next_payout_ts != null && now >= st.next_payout_ts) payout(now, s);
  }
  function payout(now, s = apySettings()) {
    const done = [];
    tx(db, () => {
      for (const a of db.prepare('SELECT * FROM perp_apy_accruals WHERE accrued_cc>=100 ORDER BY user_id, subaccount').all()) {
        const cents = Math.floor(a.accrued_cc / 100);
        const id = newId('apy_');
        const r = payToPerps({ uid: a.user_id, sub: a.subaccount, cents, kind: 'apy', purpose: 'perps_apy', ref: id, memo: PS('memo.apy'), link: { apy_payout_id: id } });
        const status = r.paid ? 'paid' : r.queued ? 'queued' : 'refused';
        db.prepare('INSERT INTO perp_apy_payouts(id,user_id,subaccount,rate_bps,amount_cents,status,source,queue_id,created_ts,epoch) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, a.user_id, a.subaccount, s.rate_bps, cents, status, r.source, r.id || null, now, epoch());
        db.prepare('UPDATE perp_apy_accruals SET accrued_cc=accrued_cc-? WHERE user_id=? AND subaccount=?').run(cents * 100, a.user_id, a.subaccount); // refused: dropped (no budget, no payout)
        done.push({ uid: a.user_id, sub: a.subaccount, cents, status });
      }
      putState({ last_ts: apyState().last_ts, next_payout_ts: now + s.payout_interval_ms });
    });
    for (const x of done) {
      P.emitUser(x.uid, []);
      P.emitEvent(x.uid, 'perp_apy', { subaccount: x.sub, amount_dollars: dollars(x.cents), status: x.status });
      const last = lastApyNotice.get(x.uid) || 0;
      if (x.status !== 'refused' && Date.now() - last >= 3600000) { // at most one interest notice per user per hour
        lastApyNotice.set(x.uid, Date.now());
        const amount = C.moneyCents(x.cents);
        notify(x.uid, { type: 'perps_apy', title: PS('notify.apy.title', { amount }), body: x.status === 'queued' ? PS('notify.apy.queued', { amount }) : PS('notify.apy.body', { rate: (s.rate_bps / 100).toFixed(2) }), link: '/portfolio?perpsTab=positions' });
      }
    }
    if (centralBank && done.some((x) => x.status === 'paid')) centralBank.emitVault();
    return done.length;
  }
  P.tickHooks.push(() => accrue(clock()));
  function apyVo(uid) {
    const s = apySettings(); const st = apyState();
    const rows = db.prepare('SELECT * FROM perp_apy_accruals WHERE user_id=? ORDER BY subaccount').all(uid);
    return {
      enabled: !!(s.enabled && s.rate_bps > 0), rate_bps: s.rate_bps, rate_percent: Number((s.rate_bps / 100).toFixed(2)), payout_interval_ms: s.payout_interval_ms,
      next_payout_time: iso(st.next_payout_ts), accrued: rows.map((r) => ({ subaccount: r.subaccount, accrued_dollars: (r.accrued_cc / 10000).toFixed(6), base_dollars: dollars(r.base_cc / 100) })),
      total_accrued_dollars: (rows.reduce((a, r) => a + r.accrued_cc, 0) / 10000).toFixed(6),
      total_paid_dollars: dollars(db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM perp_apy_payouts WHERE user_id=? AND status='paid'").get(uid).c),
      payouts: db.prepare('SELECT * FROM perp_apy_payouts WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 50').all(uid).map((p) => ({ id: p.id, subaccount: p.subaccount, amount_dollars: dollars(p.amount_cents), rate_bps: p.rate_bps, status: p.status, source: p.source, created_time: iso(p.created_ts) })),
    };
  }
  v1.get('/perps/apy', requireUser, (req, res) => res.json({ apy: apyVo(req.auth.user.id) }));

  // ---------------------------------------------------------------- waitlist
  const wlRow = (uid) => db.prepare('SELECT * FROM perp_waitlist WHERE user_id=?').get(uid);
  const waitingCount = () => db.prepare("SELECT COUNT(*) c FROM perp_waitlist WHERE status='waiting'").get().c;
  function positionOf(uid) {
    const r = wlRow(uid);
    if (!r || r.status !== 'waiting') return null;
    return db.prepare("SELECT COUNT(*) c FROM perp_waitlist WHERE status='waiting' AND (joined_ts<? OR (joined_ts=? AND user_id<=?))").get(r.joined_ts, r.joined_ts, uid).c;
  }
  function approved(user) {
    const r = wlRow(user.id);
    if (r) return r.status === 'approved';
    if (admin.rolesOf(user).length) return true; // staff
    // Grandfathered: Perps activity from before the waitlist (a transfer in or an open position).
    if (db.prepare("SELECT 1 FROM perp_transfers WHERE user_id=? AND source='event_contract' LIMIT 1").get(user.id) || db.prepare('SELECT 1 FROM perp_positions WHERE user_id=? AND qty<>0 LIMIT 1').get(user.id)) {
      db.prepare("INSERT INTO perp_waitlist(user_id,status,joined_ts,decided_ts,note) VALUES(?, 'approved', ?, ?, 'grandfathered') ON CONFLICT(user_id) DO NOTHING").run(user.id, Date.now(), Date.now());
      return true;
    }
    return false;
  }
  function waitlistVo(user, req) {
    const r = wlRow(user.id);
    const ok = approved(user);
    return { gate_active: flags.on('perps.waitlist', { req }), has_joined: !!r, status: r ? r.status : ok ? 'approved' : 'not_joined', position: positionOf(user.id), waiting_count: waitingCount(),
      beta_unlocked: ok, can_start_onboarding: ok, x_share_completed: false, fcm_application_completed: false, joined_time: r ? iso(r.joined_ts) : null, approved_time: r && r.status === 'approved' ? iso(r.decided_ts) : null };
  }
  // Writes that never need access: leaving positions and money, protection, joining, cancels (CLONE_SPEC.md §34.9).
  function alwaysAllowed(req) {
    const p = req.path; const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (req.method === 'DELETE') return true;
    if (/^\/perps\/(waitlist|referrals\/apply)$/.test(p)) return true;
    if (/^\/perps\/positions\/[^/]+\/(close|exit_trigger)$/.test(p)) return true;
    if (/^\/perps\/orders\/[^/]+\/decrease$/.test(p)) return true;
    if (p === '/perps/orders' && (b.reduce_only === true || b.reduce_only === 'true' || b.reduce_only === 1)) return true;
    if (p === '/perps/transfers' && (b.direction === 'to_predictions' || (b.source === 'margined' && b.destination === 'event_contract'))) return true;
    return false;
  }
  flags.gates.push((req) => {
    if (req.method === 'GET' || !/^\/perps\//.test(req.path) || /^\/perps\/admin\//.test(req.path) || !req.auth) return null;
    if (!flags.on('perps.waitlist', { req }) || alwaysAllowed(req) || approved(req.auth.user)) return null;
    const e = new ApiError(403, 'perps_waitlist', PS('error.waitlist'), PS('error.waitlist_details'));
    e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, waitlist: waitlistVo(req.auth.user, req) } });
    return e;
  });
  v1.get('/perps/waitlist', requireUser, (req, res) => res.json({ waitlist: waitlistVo(req.auth.user, req) }));
  v1.post('/perps/waitlist', requireUser, (req, res) => {
    const u = req.auth.user;
    const fresh = !wlRow(u.id) && !approved(u);
    if (fresh) db.prepare("INSERT INTO perp_waitlist(user_id,status,joined_ts) VALUES(?, 'waiting', ?) ON CONFLICT(user_id) DO NOTHING").run(u.id, Date.now());
    const vo = waitlistVo(u, req);
    if (fresh) {
      notify(u.id, { type: 'perps_waitlist_joined', title: PS('notify.waitlist_joined.title'), body: PS('notify.waitlist_joined.body', { position: vo.position }), link: '/perps' });
      P.emitEvent(u.id, 'perp_waitlist', vo);
    }
    res.status(fresh ? 201 : 200).json({ waitlist: vo });
  });
  function decide(ids, status, actor, note) {
    const now = Date.now(); const changed = [];
    tx(db, () => {
      for (const id of ids) {
        const cur = wlRow(id);
        if (cur && cur.status === status) continue;
        db.prepare('INSERT INTO perp_waitlist(user_id,status,joined_ts,decided_ts,decided_by,note) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, decided_ts=excluded.decided_ts, decided_by=excluded.decided_by, note=excluded.note')
          .run(id, status, cur ? cur.joined_ts : now, now, actor.id, note);
        changed.push(id);
      }
    });
    for (const id of changed) {
      if (status === 'approved') notify(id, { type: 'perps_waitlist_approved', title: PS('notify.waitlist_approved.title'), body: PS('notify.waitlist_approved.body'), link: '/perps' });
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (u) P.emitEvent(id, 'perp_waitlist', waitlistVo(u, null));
    }
    return changed;
  }

  // ---------------------------------------------------------------- referrals (the 'perps' program)
  const referrals = createReferrals({ db, epoch });
  referrals.register('perps', {
    defaults: PERPS_REFERRAL_DEFAULTS,
    eligible: (uid) => !db.prepare("SELECT 1 FROM perp_fills WHERE user_id=? AND source='user' LIMIT 1").get(uid), // before the first Perps trade
    payout: ({ uid, cents, role, referral, rewardId }) => payToPerps({ uid, sub: 0, cents, kind: 'referral', purpose: 'referral', ref: referral.id, memo: PS(role === 'referrer' ? 'memo.referral_referrer' : 'memo.referral_referee'), link: { reward_id: rewardId } }),
  });
  P.fillHooks.push((uid, notionalCc) => {
    if (!flags.jobOn('perps.referrals') || isSystem(uid)) return;
    const r = referrals.progress(uid, 'perps', Math.floor(notionalCc / 100));
    if (!r) return;
    for (const w of r.rewards) {
      if (w.status !== 'paid' && w.status !== 'queued') continue;
      const amount = C.moneyCents(w.amount_cents);
      notify(w.user_id, { type: 'referral_reward', title: PS('notify.referral.title', { amount }), body: w.status === 'queued' ? PS('notify.referral.queued', { amount }) : PS(w.role === 'referrer' ? 'notify.referral.body_referrer' : 'notify.referral.body_referee', { amount }), link: '/portfolio?perpsTab=positions' });
      P.emitEvent(w.user_id, 'perp_referral', { role: w.role, amount_dollars: dollars(w.amount_cents), status: w.status });
    }
    if (centralBank) centralBank.emitVault();
  });
  let lastExpire = 0;
  P.tickHooks.push(() => { if (Date.now() - lastExpire > 60000 && flags.jobOn('perps.referrals')) { lastExpire = Date.now(); referrals.expire('perps'); } });
  const REF_ERR = {
    referral_program_off: () => E.conflict('referral_program_off', PS('error.referral_off')),
    referral_rate_limited: () => new ApiError(429, 'too_many_requests', PS('error.referral_rate')),
    referral_code_invalid: () => new ApiError(400, 'referral_code_invalid', PS('error.referral_code')),
    referral_self: () => E.conflict('referral_self', PS('error.referral_self')),
    referral_already_used: () => E.conflict('referral_already_used', PS('error.referral_used')),
    referral_too_late: () => E.conflict('referral_too_late', PS('error.referral_late', { days: referrals.settings('perps').signup_window_days })),
  };
  v1.get('/perps/referrals', requireUser, (req, res) => res.json({ referrals: referrals.summary(req.auth.user.id, 'perps') }));
  v1.post('/perps/referrals/apply', requireUser, (req, res) => {
    try {
      const r = referrals.apply(req.auth.user.id, (req.body || {}).code, 'perps');
      P.emitEvent(r.referrer_id, 'perp_referral', { role: 'referrer', status: 'pending' });
      res.status(201).json({ referrals: referrals.summary(req.auth.user.id, 'perps') });
    } catch (e) { if (e instanceof ReferralError && REF_ERR[e.code]) throw REF_ERR[e.code](); throw e; }
  });

  // ---------------------------------------------------------------- admin: Admin › Perps ops
  const A = '/admin/perps_ops';
  const tiersAdminVo = () => ({
    markets: db.prepare('SELECT ticker, title, max_leverage FROM perp_markets ORDER BY sort_order').all().map((m) => ({ ticker: m.ticker, title: m.title, max_leverage: m.max_leverage, max_position_notional_dollars: dollars(R.maxNotional(P.tiersOf(m.ticker)) / 100), tiers: P.tiersOf(m.ticker).map(P.tierVo) })),
    risk: P.riskSettings(),
  });
  v1.get(`${A}/margin_tiers`, can('perps.ops'), (req, res) => res.json(tiersAdminVo()));
  v1.put(`${A}/margin_tiers/:ticker`, can('perps.ops'), (req, res) => {
    const m = P.market(req.params.ticker);
    if (!m) throw E.notFound();
    const b = req.body || {};
    let tiers;
    try { tiers = R.validateTiers(b.tiers); } catch (e) { throw fieldErr({ tiers: e.message }); }
    const reason = reasonOf(b);
    auth.assertFresh(req, 'perps_margin_tiers'); // step-up: a risk change
    const before = P.tiersOf(m.ticker).map(P.tierVo);
    P.setTiers(m.ticker, tiers);
    admin.audit(req, 'perps.margin_tiers', 'perp_market', m.ticker, { tiers: before }, { tiers: P.tiersOf(m.ticker).map(P.tierVo) }, reason);
    res.json(tiersAdminVo());
  });
  v1.get(`${A}/risk`, can('perps.ops'), (req, res) => res.json({ risk: P.riskSettings(), defaults: R.RISK_DEFAULTS }));
  v1.put(`${A}/risk`, can('perps.ops'), (req, res) => {
    const b = req.body || {};
    const errs = {}; let v = {};
    const src = { ...b }; delete src.reason;
    try { v = checkBody(src, R.RISK_SPEC, { unknown: 'reject' }); } catch (e) { if (e.fields) Object.assign(errs, e.fields); else throw e; }
    if (!Object.keys(src).length && !Object.keys(errs).length) errs.body = 'nothing to change';
    if (Object.keys(errs).length) throw fieldErr(errs);
    const reason = reasonOf(b);
    auth.assertFresh(req, 'perps_risk_limits');
    const before = P.riskSettings();
    const next = { ...before, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) };
    admin.putSetting('perps_risk', next, req.auth.user.id);
    admin.audit(req, 'perps.risk_limits', 'settings', 'perps_risk', before, next, reason);
    res.json({ risk: P.riskSettings(), defaults: R.RISK_DEFAULTS });
  });
  const apyAdminVo = () => {
    const st = apyState();
    const sum = (status) => db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) c FROM perp_apy_payouts WHERE status=?').get(status);
    const paid = sum('paid'); const queued = sum('queued'); const refused = sum('refused');
    return { settings: apySettings(), job_on: flags.jobOn('perps.apy'), last_accrual_time: iso(st.last_ts), next_payout_time: iso(st.next_payout_ts),
      accrued_outstanding_dollars: (db.prepare('SELECT COALESCE(SUM(accrued_cc),0) c FROM perp_apy_accruals').get().c / 10000).toFixed(6),
      paid: { count: paid.n, dollars: dollars(paid.c) }, queued: { count: queued.n, dollars: dollars(queued.c) }, refused: { count: refused.n, dollars: dollars(refused.c) },
      funding_source: engine.money && engine.money.playOn() ? 'play' : engine.treasury && engine.treasury.active() ? 'treasury' : 'none',
      payouts: db.prepare('SELECT * FROM perp_apy_payouts ORDER BY created_ts DESC, rowid DESC LIMIT 50').all().map((p) => ({ id: p.id, user: emailOf(p.user_id), subaccount: p.subaccount, amount_dollars: dollars(p.amount_cents), status: p.status, source: p.source, created_time: iso(p.created_ts) })) };
  };
  v1.get(`${A}/apy`, can('perps.ops'), (req, res) => res.json(apyAdminVo()));
  v1.put(`${A}/apy`, can('perps.ops'), (req, res) => {
    const b = req.body || {};
    const errs = {}; let v = {};
    const src = { ...b }; delete src.reason;
    if (src.rate_percent !== undefined) { const n = Number(src.rate_percent); if (!Number.isFinite(n) || n < 0 || n > 50 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) errs.rate_percent = 'a percentage from 0 to 50 with at most 2 decimals'; else src.rate_bps = Math.round(n * 100); delete src.rate_percent; }
    try { v = checkBody(src, APY_SPEC, { unknown: 'reject' }); } catch (e) { if (e.fields) Object.assign(errs, e.fields); else throw e; }
    if (!Object.keys(src).length && !Object.keys(errs).length) errs.body = 'nothing to change';
    if (Object.keys(errs).length) throw fieldErr(errs);
    const reason = reasonOf(b);
    auth.assertFresh(req, 'perps_apy'); // step-up: a money setting
    const before = apySettings();
    const next = { ...before, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) };
    admin.putSetting('perps_apy', next, req.auth.user.id);
    if (next.payout_interval_ms !== before.payout_interval_ms) { const st = apyState(); if (st.last_ts != null) putState({ ...st, next_payout_ts: clock() + next.payout_interval_ms }); }
    admin.audit(req, 'perps.apy', 'settings', 'perps_apy', before, next, reason);
    res.json(apyAdminVo());
  });
  v1.post(`${A}/apy/payout`, can('perps.ops'), (req, res) => {
    const reason = reasonOf(req.body);
    auth.assertFresh(req, 'perps_apy');
    const n = payout(clock());
    admin.audit(req, 'perps.apy.payout', 'settings', 'perps_apy', null, { payouts: n }, reason);
    res.json({ payouts: n, ...apyAdminVo() });
  });
  const waitlistAdminVo = (status) => {
    const where = status ? 'WHERE w.status=?' : '';
    const rows = db.prepare(`SELECT w.*, u.email, u.display_name FROM perp_waitlist w JOIN users u ON u.id=w.user_id ${where} ORDER BY CASE w.status WHEN 'waiting' THEN 0 ELSE 1 END, w.joined_ts, w.user_id LIMIT 500`).all(...(status ? [status] : []));
    let pos = 0;
    return { gate_active: flags.jobOn('perps.waitlist'), counts: Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM perp_waitlist GROUP BY status').all().map((r) => [r.status, r.n])),
      entries: rows.map((r) => ({ user_id: r.user_id, email: r.email, display_name: r.display_name, status: r.status, position: r.status === 'waiting' ? ++pos : null, joined_time: iso(r.joined_ts), decided_time: iso(r.decided_ts), decided_by: emailOf(r.decided_by), note: r.note })) };
  };
  v1.get(`${A}/waitlist`, can('perps.ops'), (req, res) => res.json(waitlistAdminVo(req.query.status ? String(req.query.status) : null)));
  const idsOf = (b) => {
    const list = Array.isArray(b.user_ids) ? b.user_ids : Array.isArray(b.emails) ? b.emails : null;
    if (!list || !list.length || list.length > 500) throw fieldErr({ user_ids: 'send 1 to 500 user ids or emails' });
    const out = [];
    for (const x of list) { const s = String(x || '').trim(); const u = db.prepare('SELECT id FROM users WHERE id=? OR email=?').get(s, s.toLowerCase()); if (!u) throw fieldErr({ user_ids: `unknown user ${s.slice(0, 80)}` }); if (!out.includes(u.id)) out.push(u.id); }
    return out;
  };
  for (const [path, status, action] of [['approve', 'approved', 'perps.waitlist.approve'], ['revoke', 'revoked', 'perps.waitlist.revoke']]) {
    v1.post(`${A}/waitlist/${path}`, can('perps.ops'), (req, res) => {
      const b = req.body || {};
      const ids = idsOf(b);
      const reason = reasonOf(b);
      const changed = decide(ids, status, req.auth.user, reason);
      admin.audit(req, action, 'perps_waitlist', ids.length === 1 ? ids[0] : `${ids.length} users`, null, { users: changed.map(emailOf), status }, reason);
      res.json({ changed: changed.length, ...waitlistAdminVo() });
    });
  }
  // Bulk invite: approve the next N people in line (FIFO).
  v1.post(`${A}/waitlist/invite`, can('perps.ops'), (req, res) => {
    const b = req.body || {};
    const n = Number(b.count);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw fieldErr({ count: 'a whole number from 1 to 1000' });
    const reason = reasonOf(b);
    const ids = db.prepare("SELECT user_id FROM perp_waitlist WHERE status='waiting' ORDER BY joined_ts, user_id LIMIT ?").all(n).map((r) => r.user_id);
    const changed = decide(ids, 'approved', req.auth.user, reason);
    admin.audit(req, 'perps.waitlist.invite', 'perps_waitlist', `${changed.length} users`, null, { users: changed.map(emailOf) }, reason);
    res.json({ changed: changed.length, ...waitlistAdminVo() });
  });
  v1.get(`${A}/referrals`, can('perps.ops'), (req, res) => res.json(referrals.adminList('perps')));
  v1.put(`${A}/referrals`, can('perps.ops'), (req, res) => {
    const b = req.body || {};
    const src = { ...b }; delete src.reason;
    const errs = {}; let v = {};
    try { v = checkBody(src, REF_SPEC, { unknown: 'reject' }); } catch (e) { if (e.fields) Object.assign(errs, e.fields); else throw e; }
    if (!Object.keys(src).length && !Object.keys(errs).length) errs.body = 'nothing to change';
    if (Object.keys(errs).length) throw fieldErr(errs);
    const reason = reasonOf(b);
    auth.assertFresh(req, 'perps_referrals'); // step-up: rewards are money
    const before = referrals.settings('perps');
    const next = { ...before, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) };
    admin.putSetting('referrals:perps', next, req.auth.user.id);
    admin.audit(req, 'perps.referrals', 'settings', 'referrals:perps', before, next, reason);
    res.json(referrals.adminList('perps'));
  });
  // The perps journal: its audit (also part of the main ledger audit) and account totals.
  v1.get(`${A}/ledger`, can('perps.ops'), (req, res) => {
    const sums = new Map(db.prepare('SELECT account, SUM(amount_cents) s FROM journal_postings GROUP BY account').all().map((r) => [r.account, r.s]));
    const a = PL.audit(db, { mainGot: (x) => sums.get(x) || 0 });
    res.json({ ok: a.ok, problems: a.problems.slice(0, 50), entries: a.entries, totals_dollars: Object.fromEntries(Object.entries(a.totals).map(([k, v]) => [k, (v / 10000).toFixed(4)])), insurance_dollars: (PL.balanceOf(db, PL.H.insurance) / 10000).toFixed(4), backstop_dollars: (PL.balanceOf(db, PL.H.backstop) / 10000).toFixed(4), fees_dollars: (PL.balanceOf(db, PL.H.fees) / 10000).toFixed(4) });
  });

  // ---------------------------------------------------------------- the switch to production (server/play-mode.js)
  // Inside the reset transaction, before the new epoch: archive every subaccount balance and APY accrual, void pending
  // referrals and queued rewards, cancel order groups, zero the tables and close every perps journal account into the
  // batch's reset account. After the epoch switch (`reopen`) the liquidity float is opened again in the real epoch.
  function previewCounts() {
    const q = (sql) => db.prepare(sql).get();
    const subs = q("SELECT COUNT(*) n, COALESCE(SUM(available_cc),0) c FROM perp_subaccounts WHERE subaccount>0 AND available_cc<>0 AND user_id IN (SELECT id FROM users WHERE is_system=0)");
    const apy = q('SELECT COUNT(*) n, COALESCE(SUM(accrued_cc),0) c FROM perp_apy_accruals WHERE accrued_cc>0');
    const ref = referrals.pending();
    return { counts: { perps_subaccounts: subs.n, perps_apy_accruals: apy.n, perps_apy_queued: q("SELECT COUNT(*) n FROM perp_apy_payouts WHERE status='queued'").n, referrals_pending: ref.referrals, referral_rewards_queued: ref.queued_rewards.n, perps_order_groups: q("SELECT COUNT(*) n FROM perp_order_groups WHERE status='active'").n },
      totals: { perps_subaccounts_cc: subs.c, perps_apy_accrued_cc: Math.round(apy.c), referral_rewards_queued_dollars: dollars(ref.queued_rewards.c) } };
  }
  function resetForProduction(batch) {
    const reset = `perps:reset:${batch}`;
    const counts = previewCounts().counts;
    const LP = P.lpId();
    const t0 = Date.now();
    // Archive (customers): subaccount balances with their APY accruals.
    for (const r of db.prepare('SELECT user_id, 0 subaccount, available_cc FROM perp_accounts UNION ALL SELECT user_id, subaccount, available_cc FROM perp_subaccounts WHERE subaccount>0').all()) {
      if (isSystem(r.user_id)) continue;
      const acc = db.prepare('SELECT accrued_cc FROM perp_apy_accruals WHERE user_id=? AND subaccount=?').get(r.user_id, r.subaccount)?.accrued_cc || 0;
      if (!r.available_cc && !acc) continue;
      db.prepare('INSERT OR REPLACE INTO pm_archive_perps_balances(batch_id,user_id,subaccount,available_cc,apy_accrued_cc) VALUES(?,?,?,?,?)').run(batch, r.user_id, r.subaccount, r.available_cc, acc);
    }
    db.prepare('DELETE FROM perp_apy_accruals').run();
    db.prepare("UPDATE perp_apy_payouts SET status='canceled' WHERE status='queued'").run();
    referrals.voidPlay();
    db.prepare("UPDATE perp_order_groups SET status='canceled', status_reason='production_reset', updated_ts=? WHERE status='active'").run(t0);
    db.prepare("UPDATE perp_orders SET status='canceled', reserved_cc=0, cancel_reason='production_reset', updated_ts=? WHERE status='resting'").run(t0); // the liquidity account's too: it requotes
    db.prepare('DELETE FROM perp_positions').run();
    db.prepare('UPDATE perp_accounts SET available_cc=0, updated_at=?').run(nowIso());
    db.prepare('UPDATE perp_subaccounts SET available_cc=0, updated_ts=?').run(t0);
    db.prepare("INSERT INTO perp_meta(key,value) VALUES('rounding_ucc','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
    const open = db.prepare('SELECT account, balance_cc b FROM perp_journal_balances WHERE balance_cc<>0').all();
    if (open.length) PL.post(db, { kind: 'play_reset', ref: batch, memo: `production switch ${batch}` }, [...open.map((x) => [x.account, -x.b]), [reset, open.reduce((a, x) => a + x.b, 0)]]);
    admin.putSetting('perps_apy_state', { last_ts: null, next_payout_ts: null }, null);
    void LP;
    return counts;
  }
  function reopenAfterReset() {
    const LP = P.lpId();
    if (!LP) return;
    db.prepare('UPDATE perp_accounts SET available_cc=? WHERE user_id=?').run(1e12, LP);
    PL.post(db, { kind: 'lp_float', userId: LP, memo: 'liquidity account float' }, [[PL.A.avail(LP, 0), 1e12], [PL.H.lp, -1e12]]);
  }
  const api = { previewCounts, resetForProduction, reopenAfterReset, payToPerps, payout, accrue: () => accrue(clock()), referrals, approved };
  engine.perpsOps = api;
  void journal;
  return api;
}

module.exports = { mountPerpsOps, APY_DEFAULTS };
