'use strict';
// Phase 5A trading core (CLONE_SPEC.md §28). The engine (server/engine.js) owns prices on a grid, the G1 fee
// accumulator, scalar settlement and the settlement correction primitive; this module adds what sits around them:
//   • invented seed content for the new market kinds (a scalar market, a 0.1¢ market and a tapered market);
//   • A9 collateral return (MECNET): cash released early while a user's positions across the outcomes of one mutually
//     exclusive event guarantee a minimum payout, journaled as an advance against that payout;
//   • G6 settlement correction of a settled market (claw-back / re-pay through the ledger, step-up, audit chain, user
//     notifications) and the optional two-person rule for resolutions and corrections;
//   • read endpoints for Portfolio (collateral returned) and the admin resolution desk (approvals, policy, corrections).
const { tx } = require('./db');
const P = require('./pricing');
const journal = require('./journal');
const { newId, nowIso, dollars, ufp, ustr, E, ApiError, UNITS } = require('./util');
const { scalarSettlementCc } = require('./engine');
const { ROLE_PERMS } = require('./admin');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collateral_returns (user_id TEXT NOT NULL, event_ticker TEXT NOT NULL, amount_cents INTEGER NOT NULL, guaranteed_cents INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL, PRIMARY KEY (user_id, event_ticker));
CREATE TABLE IF NOT EXISTS res_approvals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, market_ticker TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
  requested_by TEXT NOT NULL, requested_ts INTEGER NOT NULL, decided_by TEXT, decided_ts INTEGER, decision_note TEXT, outcome TEXT);
CREATE INDEX IF NOT EXISTS idx_res_approvals_status ON res_approvals(status, requested_ts);
CREATE TABLE IF NOT EXISTS settlement_corrections (id TEXT PRIMARY KEY, market_ticker TEXT NOT NULL, from_result TEXT NOT NULL, to_result TEXT NOT NULL, from_value_cc INTEGER, to_value_cc INTEGER,
  expiration_value REAL, reason TEXT NOT NULL, requested_by TEXT NOT NULL, approved_by TEXT, users INTEGER NOT NULL, clawback_cents INTEGER NOT NULL, repaid_cents INTEGER NOT NULL, created_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_settlement_corrections_market ON settlement_corrections(market_ticker, created_ts);
`;
const POLICY_KEY = 'resolution_policy';
const APPROVAL_TTL_MS = 24 * 3600 * 1000; // a pending resolution request lapses after a day (design choice)

// ------------------------------------------------------------------------------------------------ seed content
// Invented markets for the new structures; inserted once (idempotent) through the engine so the journal sees the
// liquidity reservations. Prices are cc.
const SEED = [
  { series: 'PLXGDP', title: 'Harbor economy growth', cat: 'Economics', tags: ['GDP'], event: 'PLXGDP-26Q4', etitle: 'Harbor GDP growth in Q4 2026', sub: 'Annualized %, first estimate',
    market: { t: 'PLXGDP-26Q4', yes: 'Growth (scalar)', no: 'Below the range', grid: 'deci_cent', type: 'scalar', floor: -2, cap: 6, unit: '%', fair: 4750, tick: 10,
      rules: 'Scalar market. At expiration the Harbor statistics office first estimate of Q4 2026 annualized GDP growth sets the payout: each YES contract pays (growth − (−2%)) ÷ 8% of $1, clamped between $0 and $1; each NO contract pays the rest. Example: 1.8% growth pays $0.4750 per YES and $0.5250 per NO.' } },
  { series: 'PLXSNOW', title: 'First snowfall', cat: 'Climate and Weather', tags: ['Snow'], event: 'PLXSNOW-26DEC', etitle: 'Will Harbor City see snow before December 15?', sub: 'Measurable snowfall at the harbor station',
    market: { t: 'PLXSNOW-26DEC', yes: 'Snow before Dec 15', no: 'No snow', grid: 'deci_cent', fair: 1240, tick: 10,
      rules: 'If the harbor weather station records measurable snowfall before December 15, this market resolves YES. Otherwise it resolves NO. Prices move in 0.1¢ steps.' } },
  { series: 'PLXCOMET', title: 'Sky watch', cat: 'Science and Technology', tags: ['Space'], event: 'PLXCOMET-26', etitle: 'Will Comet Ardent be visible to the naked eye this year?', sub: 'Before December 31, 2026',
    market: { t: 'PLXCOMET-26', yes: 'Naked-eye visible', no: 'Not visible', grid: 'tapered', fair: 230, tick: 10,
      rules: 'If two observatories report Comet Ardent at magnitude 6 or brighter before December 31, 2026, this market resolves YES. Otherwise it resolves NO. Ticks are finer near 0¢ and 100¢ (tapered grid).' } },
];

function mountTradingCore({ v1, db, engine, auth, admin, requireUser, notify }) {
  db.exec(SCHEMA);
  const can = admin.can;
  const lpId = () => db.prepare("SELECT id FROM users WHERE email='liquidity@parlance.local'").get()?.id;
  const isSystem = (uid) => !!db.prepare('SELECT is_system FROM users WHERE id=?').get(uid)?.is_system;
  const marketRow = (t) => db.prepare('SELECT m.*, e.mutually_exclusive me, e.title event_title, e.series_ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.ticker=?').get(t);
  const userPref = (uid, key, def) => { const r = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(uid, key); if (!r) return def; try { return JSON.parse(r.value); } catch { return def; } };

  function seedContent() {
    const lp = lpId();
    if (!lp) return; // an unseeded database (the seed creates the liquidity account)
    for (const s of SEED) {
      if (db.prepare('SELECT 1 FROM series WHERE ticker=?').get(s.series)) continue;
      const now = Date.now(); const m = s.market;
      tx(db, () => {
        db.prepare('INSERT INTO series(ticker,title,slug,category,tags,frequency,fee_type,fee_multiplier,settlement_sources,rules) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(s.series, s.title, s.series.toLowerCase().slice(3), s.cat, JSON.stringify(s.tags), 'one_off', 'quadratic', 1, JSON.stringify([{ name: 'Parlance Resolution Desk', url: 'https://example.org/resolution' }]),
            m.type === 'scalar' ? 'Scalar contracts pay a fraction of $1.00 set by the reported value within the published floor and cap.' : 'Each contract pays $1.00 if its outcome occurs, otherwise $0.00.');
        db.prepare("INSERT INTO events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,created_at) VALUES(?,?,?,?,?,0,0,'','',0,?)").run(s.event, s.series, s.etitle, s.sub, s.cat, new Date(now - 10 * 86400000).toISOString());
        const close = new Date(now + 40 * 86400000).toISOString();
        db.prepare(`INSERT INTO markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,status,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,created_at,updated_at,fractional_trading_enabled,price_level_structure,market_type,floor_strike,cap_strike,scalar_unit)
          VALUES(?,?,?,?,?,?,'active',?,?,?,5,?,?,?,1,?,?,?,?,?)`).run(m.t, s.event, s.etitle, m.yes, m.no, '#3a7bff', new Date(now - 10 * 86400000).toISOString(), close, close, m.rules, nowIso(), nowIso(), m.grid, m.type || 'binary', m.floor ?? null, m.cap ?? null, m.unit || '');
        // Two days of hourly prints on the grid, ending at the fair price (history only: no money moves).
        let p = m.fair; const path = [];
        for (let i = 0; i < 48; i++) { path.unshift(p); p = P.floorToGrid(m.grid, Math.max(m.tick * 2, Math.min(P.CC - m.tick * 2, p + (((i * 7919) % 5) - 2) * m.tick))); }
        path.forEach((px, i) => db.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,yes_price_cc,count,taker_side,created_ts) VALUES(?,?,?,?,?,?,?)')
          .run(newId('t_'), m.t, Math.round(px / 100), px, (20 + ((i * 37) % 300)) * UNITS, i % 2 ? 'yes' : 'no', now - (48 - i) * 3600000));
      });
      // Resting liquidity on both sides, through the engine (reservations are journaled).
      for (const [lvl, k] of [[1, 2], [2, 5], [3, 10], [4, 20]]) {
        const bid = P.floorToGrid(m.grid, m.fair - k * m.tick); const ask = P.floorToGrid(m.grid, m.fair + k * m.tick);
        try { engine.placeOrder(lp, { ticker: m.t, side: 'yes', price_cc: bid, count: (100 * lvl) * UNITS, post_only: true, source: 'liquidity' }); } catch { /* optional */ }
        try { engine.placeOrder(lp, { ticker: m.t, side: 'no', price_cc: P.CC - ask, count: (100 * lvl) * UNITS, post_only: true, source: 'liquidity' }); } catch { /* optional */ }
      }
    }
  }
  seedContent();

  // ------------------------------------------------------------------------------------------- A9 collateral return
  // Guaranteed payout (cents) of a user's positions across the open outcomes of one mutually exclusive event: at most
  // one outcome resolves YES, and possibly none. Scenario "outcome i is YES" pays Σ no_j (j≠i) + yes_i; "none" pays
  // Σ no_j. The minimum is Σ no − max(0, maxᵢ(noᵢ − yesᵢ)). Determined outcomes count at their known payout; once any
  // outcome is known YES, every other one pays its NO side exactly. Scalar markets never qualify.
  function guaranteedCents(uid, eventTicker) {
    const rows = db.prepare(`SELECT m.status, m.result, m.market_type, COALESCE(p.yes_count,0) y, COALESCE(p.no_count,0) n FROM markets m
      LEFT JOIN positions p ON p.market_ticker=m.ticker AND p.user_id=? WHERE m.event_ticker=?`).all(uid, eventTicker);
    if (!rows.length || rows.some((r) => r.market_type === 'scalar')) return 0;
    const yesKnown = rows.some((r) => r.result === 'yes');
    let fixed = 0; let sumNo = 0; let worst = 0;
    for (const r of rows) {
      if (r.status === 'finalized') continue; // paid out already (any advance was settled against it)
      if (r.status === 'determined' && (r.result === 'yes' || r.result === 'no')) { fixed += r.result === 'yes' ? r.y : r.n; continue; }
      if (yesKnown) { fixed += r.n; continue; }
      sumNo += r.n; worst = Math.max(worst, r.n - r.y);
    }
    return Math.max(0, fixed + sumNo - worst);
  }
  const crRow = (uid, et) => db.prepare('SELECT * FROM collateral_returns WHERE user_id=? AND event_ticker=?').get(uid, et);
  // Bring the user's advance for the event to its target: the guaranteed payout when Collateral return is on (default),
  // otherwise never more than what is already out. Runs inside the fill / settlement transaction.
  function rebalance(uid, eventTicker) {
    if (isSystem(uid)) return;
    const ev = db.prepare('SELECT mutually_exclusive me, title FROM events WHERE ticker=?').get(eventTicker);
    if (!ev || !ev.me) return;
    const cur = crRow(uid, eventTicker);
    const have = cur ? cur.amount_cents : 0;
    const g = guaranteedCents(uid, eventTicker);
    const target = userPref(uid, 'trade_collateral_return', true) === false ? Math.min(have, g) : g;
    if (!cur && target === 0) return;
    tx(db, () => {
      if (target !== have) engine.credit(uid, target - have, 'collateral_return', eventTicker, target > have ? `collateral returned early: ${ev.title}` : `collateral return repaid: ${ev.title}`);
      if (target === 0 && g === 0) db.prepare('DELETE FROM collateral_returns WHERE user_id=? AND event_ticker=?').run(uid, eventTicker);
      else db.prepare('INSERT INTO collateral_returns(user_id,event_ticker,amount_cents,guaranteed_cents,updated_ts) VALUES(?,?,?,?,?) ON CONFLICT(user_id,event_ticker) DO UPDATE SET amount_cents=excluded.amount_cents, guaranteed_cents=excluded.guaranteed_cents, updated_ts=excluded.updated_ts')
        .run(uid, eventTicker, target, g, Date.now());
    });
  }
  engine.positionHooks.push((uid, ticker) => { const m = marketRow(ticker); if (m && m.me) rebalance(uid, m.event_ticker); });
  engine.settleHooks.push((ticker) => {
    const m = marketRow(ticker);
    if (!m || !m.me) return;
    for (const r of db.prepare('SELECT user_id FROM collateral_returns WHERE event_ticker=?').all(m.event_ticker)) rebalance(r.user_id, m.event_ticker);
  });
  // Turning the setting back on (or off) re-derives the advances at once.
  function rebalanceUser(uid) {
    const evs = db.prepare(`SELECT DISTINCT m.event_ticker et FROM positions p JOIN markets m ON m.ticker=p.market_ticker JOIN events e ON e.ticker=m.event_ticker
      WHERE p.user_id=? AND e.mutually_exclusive=1 AND (p.yes_count>0 OR p.no_count>0)
      UNION SELECT event_ticker FROM collateral_returns WHERE user_id=?`).all(uid, uid);
    for (const e of evs) rebalance(uid, e.et);
    engine.emit('user_balance', uid, engine.balance(uid));
  }
  const collateralVo = (uid) => {
    const rows = db.prepare('SELECT c.*, e.title FROM collateral_returns c JOIN events e ON e.ticker=c.event_ticker WHERE c.user_id=? ORDER BY c.updated_ts DESC').all(uid);
    return {
      enabled: userPref(uid, 'trade_collateral_return', true) !== false,
      total_returned_dollars: dollars(rows.reduce((a, r) => a + r.amount_cents, 0)),
      events: rows.map((r) => ({ event_ticker: r.event_ticker, title: r.title, returned_dollars: dollars(r.amount_cents), guaranteed_payout_dollars: dollars(r.guaranteed_cents),
        positions: db.prepare(`SELECT m.ticker, m.yes_sub_title outcome, p.yes_count, p.no_count FROM positions p JOIN markets m ON m.ticker=p.market_ticker WHERE p.user_id=? AND m.event_ticker=? AND (p.yes_count>0 OR p.no_count>0) ORDER BY m.rowid`).all(uid, r.event_ticker)
          .map((p) => ({ ticker: p.ticker, outcome: p.outcome, side: p.yes_count ? 'yes' : 'no', position_fp: ufp(p.yes_count || p.no_count) })) })),
    };
  };
  v1.get('/users/:uid/collateral_returns', requireUser, (req, res) => res.json(collateralVo(req.auth.user.id)));
  v1.post('/users/:uid/collateral_returns/refresh', requireUser, (req, res) => { rebalanceUser(req.auth.user.id); res.json(collateralVo(req.auth.user.id)); });

  // ------------------------------------------------------------------------------------------- resolution integrity
  const policy = () => { const r = db.prepare('SELECT value FROM admin_settings WHERE key=?').get(POLICY_KEY); try { return { two_person_rule: false, ...(r ? JSON.parse(r.value) : {}) }; } catch { return { two_person_rule: false }; } };
  const emailOf = (uid) => (uid ? db.prepare('SELECT email FROM users WHERE id=?').get(uid)?.email || uid : null);
  const approvalVo = (a) => ({ id: a.id, kind: a.kind, market_ticker: a.market_ticker, payload: JSON.parse(a.payload), reason: a.reason, status: a.status,
    requested_by: emailOf(a.requested_by), requested_time: new Date(a.requested_ts).toISOString(), expires_time: new Date(a.requested_ts + APPROVAL_TTL_MS).toISOString(),
    decided_by: emailOf(a.decided_by), decided_time: a.decided_ts ? new Date(a.decided_ts).toISOString() : null, decision_note: a.decision_note, outcome: a.outcome ? JSON.parse(a.outcome) : null });
  const staffWith = (perm) => db.prepare('SELECT * FROM users WHERE is_admin=1 OR id IN (SELECT user_id FROM admin_roles)').all().filter((u) => {
    const roles = admin.rolesOf(u); return roles.length && roles.some((r) => (ROLE_PERMS[r] || []).includes(perm));
  });
  // Two-person rule (PLAN §3 Phase 5 security gate): with it on, a resolution or a correction is a request that a
  // different admin with resolution.write must approve; nothing changes until then.
  function gate(req, kind, ticker, payload, reason) {
    if (!policy().two_person_rule) return null;
    if (db.prepare("SELECT 1 FROM res_approvals WHERE market_ticker=? AND status='pending' AND requested_ts>?").get(ticker, Date.now() - APPROVAL_TTL_MS)) throw E.conflict('approval_pending', 'a request for this market is already waiting for a second admin');
    const id = newId('ra_');
    db.prepare('INSERT INTO res_approvals(id,kind,market_ticker,payload,reason,status,requested_by,requested_ts) VALUES(?,?,?,?,?,?,?,?)').run(id, kind, ticker, JSON.stringify(payload), reason, 'pending', req.auth.user.id, Date.now());
    const a = db.prepare('SELECT * FROM res_approvals WHERE id=?').get(id);
    admin.audit(req, `resolution.${kind}.requested`, 'market', ticker, null, approvalVo(a), reason);
    for (const u of staffWith('resolution.write')) if (u.id !== req.auth.user.id) notify(u.id, { type: 'admin_approval', title: `Second approval needed: ${kind === 'correct' ? 'settlement correction' : 'resolution'} of ${ticker}`, body: reason.slice(0, 140), link: '/admin/resolution' });
    return { status: 'pending_approval', approval: approvalVo(a) };
  }
  admin.hooks.resolutionGate = (req, kind, ticker, p) => gate(req, kind, ticker, p, p.source_note);

  v1.get('/admin/resolution/policy', can('resolution.write'), (req, res) => res.json({ policy: policy() }));
  v1.put('/admin/resolution/policy', can('settings.write'), (req, res) => {
    const b = req.body || {};
    if (typeof b.two_person_rule !== 'boolean') throw new ApiError(400, 'validation_failed', 'validation failed', 'two_person_rule: must be true or false');
    auth.assertFresh(req, 'resolution_policy');
    const before = policy();
    const after = { ...before, two_person_rule: b.two_person_rule };
    admin.putSetting(POLICY_KEY, after, req.auth.user.id);
    admin.audit(req, 'resolution.policy', 'settings', POLICY_KEY, before, after);
    res.json({ policy: after });
  });
  v1.get('/admin/resolution/approvals', can('catalog.read'), (req, res) => {
    db.prepare("UPDATE res_approvals SET status='expired' WHERE status='pending' AND requested_ts<=?").run(Date.now() - APPROVAL_TTL_MS);
    const st = String(req.query.status || 'pending');
    if (!['pending', 'approved', 'rejected', 'expired', 'all'].includes(st)) throw E.badRequest('status must be pending, approved, rejected, expired or all');
    const rows = db.prepare(`SELECT * FROM res_approvals ${st === 'all' ? '' : 'WHERE status=?'} ORDER BY requested_ts DESC LIMIT 200`).all(...(st === 'all' ? [] : [st]));
    res.json({ approvals: rows.map(approvalVo), policy: policy() });
  });
  const pendingApproval = (id) => {
    const a = db.prepare('SELECT * FROM res_approvals WHERE id=?').get(String(id));
    if (!a) throw E.notFound();
    if (a.status === 'pending' && a.requested_ts <= Date.now() - APPROVAL_TTL_MS) { db.prepare("UPDATE res_approvals SET status='expired' WHERE id=?").run(a.id); a.status = 'expired'; }
    if (a.status !== 'pending') throw E.conflict('approval_closed', `this request is ${a.status}`);
    return a;
  };
  v1.post('/admin/resolution/approvals/:id/approve', can('resolution.write'), (req, res) => {
    const a = pendingApproval(req.params.id);
    if (a.requested_by === req.auth.user.id) throw E.conflict('same_admin', 'a different admin must approve this request', 'the two-person rule needs a second admin');
    if (a.kind === 'correct') auth.assertFresh(req, 'settlement_correction');
    const note = String((req.body || {}).note || '').trim().slice(0, 500);
    const payload = JSON.parse(a.payload);
    let outcome;
    if (a.kind === 'resolve') outcome = { market: admin.executeResolve(req, a.market_ticker, payload, { approval_id: a.id, requested_by: emailOf(a.requested_by) }) };
    else outcome = doCorrect(req, a.market_ticker, payload, { requestedBy: a.requested_by, approvalId: a.id });
    db.prepare("UPDATE res_approvals SET status='approved', decided_by=?, decided_ts=?, decision_note=?, outcome=? WHERE id=?").run(req.auth.user.id, Date.now(), note, JSON.stringify({ market_status: outcome.market?.status, correction_id: outcome.correction?.id || null }), a.id);
    admin.audit(req, `resolution.${a.kind}.approved`, 'market', a.market_ticker, approvalVo(a), approvalVo(db.prepare('SELECT * FROM res_approvals WHERE id=?').get(a.id)), note);
    res.json({ approval: approvalVo(db.prepare('SELECT * FROM res_approvals WHERE id=?').get(a.id)), ...outcome });
  });
  v1.post('/admin/resolution/approvals/:id/reject', can('resolution.write'), (req, res) => {
    const a = pendingApproval(req.params.id);
    const note = String((req.body || {}).note || '').trim();
    if (note.length < 3 || note.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'note: give a reason of 3-500 characters');
    db.prepare("UPDATE res_approvals SET status='rejected', decided_by=?, decided_ts=?, decision_note=? WHERE id=?").run(req.auth.user.id, Date.now(), note, a.id);
    admin.audit(req, `resolution.${a.kind}.rejected`, 'market', a.market_ticker, approvalVo(a), null, note);
    notify(a.requested_by, { type: 'admin_approval', title: `Request rejected: ${a.market_ticker}`, body: note, link: '/admin/resolution' });
    res.json({ approval: approvalVo(db.prepare('SELECT * FROM res_approvals WHERE id=?').get(a.id)) });
  });

  // G6: correct (or reverse) a settled market. Validates, then runs now or waits for the second admin.
  function validateCorrect(m, b) {
    const errs = {};
    const scalar = m.market_type === 'scalar';
    const value = Number(b.expiration_value);
    if (scalar) { if (b.expiration_value === undefined || b.expiration_value === null || b.expiration_value === '' || !Number.isFinite(value)) errs.expiration_value = 'enter the corrected settlement value'; }
    else if (!['yes', 'no'].includes(b.result)) errs.result = 'choose the corrected result, YES or NO';
    const reason = String(b.reason || '').trim();
    if (reason.length < 10 || reason.length > 1000) errs.reason = 'a reason of 10-1000 characters is required';
    if (Object.keys(errs).length) throw new ApiError(400, 'validation_failed', 'validation failed', Object.entries(errs).map(([k, v]) => `${k}: ${v}`).join('; '));
    if (m.status !== 'finalized') throw E.conflict('not_settled', 'only a settled market can be corrected; use reverse before settlement', `market status is ${m.status}`);
    if (m.mve_collection_ticker) throw E.conflict('combo_market', 'combo markets resolve from their legs');
    const dep = db.prepare("SELECT cm.ticker FROM combo_legs cl JOIN markets cm ON cm.ticker=cl.combo_ticker WHERE cl.market_ticker=? AND cm.status IN ('determined','finalized') LIMIT 1").get(m.ticker);
    if (dep) throw E.conflict('combo_dependency', 'a combo has already resolved from this result; it cannot be corrected', dep.ticker);
    const s = scalar ? scalarSettlementCc(m, value) : b.result === 'yes' ? P.CC : 0;
    if (s === (m.settlement_value_cc ?? (m.result === 'yes' ? P.CC : 0))) throw E.conflict('no_change', 'the market already settled at this result');
    return { result: scalar ? 'scalar' : b.result, expiration_value: scalar ? value : null, reason };
  }
  function doCorrect(req, ticker, p, { requestedBy = req.auth.user.id, approvalId = null } = {}) {
    const m = marketRow(ticker);
    if (!m) throw E.notFound();
    const v = validateCorrect(m, p);
    const before = admin.deskRow(admin.getMarket(ticker));
    const r = engine.correctSettlement(ticker, { result: v.result === 'scalar' ? null : v.result, expiration_value: v.expiration_value, memo: 'settlement corrected' });
    const claw = r.changes.filter((c) => c.delta_cents < 0).reduce((a, c) => a - c.delta_cents, 0);
    const repaid = r.changes.filter((c) => c.delta_cents > 0).reduce((a, c) => a + c.delta_cents, 0);
    const id = newId('sc_');
    db.prepare('INSERT INTO settlement_corrections(id,market_ticker,from_result,to_result,from_value_cc,to_value_cc,expiration_value,reason,requested_by,approved_by,users,clawback_cents,repaid_cents,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, ticker, m.result, r.result, r.previous_settlement_value_cc, r.settlement_value_cc, v.expiration_value, v.reason, requestedBy, approvalId ? req.auth.user.id : null, r.changes.length, claw, repaid, Date.now());
    db.prepare('INSERT INTO res_resolutions(id,market_ticker,result,source_note,settlement_delay_sec,status,resolved_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(newId('res_'), ticker, r.result === 'scalar' ? `scalar:${v.expiration_value}` : r.result, `Correction: ${v.reason}`, 0, 'corrected', req.auth.user.id, nowIso());
    const after = admin.deskRow(admin.getMarket(ticker));
    admin.audit(req, 'resolution.correct', 'market', ticker, before, { ...after, correction_id: id, clawback_dollars: dollars(claw), repaid_dollars: dollars(repaid), approval_id: approvalId, requested_by: emailOf(requestedBy) }, v.reason);
    const label = r.result === 'scalar' ? `$${P.ccToDollars(r.settlement_value_cc)} per YES` : r.result.toUpperCase();
    for (const c of r.changes) {
      if (!c.delta_cents) continue;
      const bal = journal.balanceOf(db, journal.accounts.cash(c.user_id));
      notify(c.user_id, { type: 'settlement_correction', title: `Settlement corrected: ${m.title} now resolves ${label}`,
        body: c.delta_cents > 0 ? `You were paid $${(c.delta_cents / 100).toFixed(2)} more. Reason: ${v.reason.slice(0, 160)}` : `$${Math.abs(c.delta_cents / 100).toFixed(2)} was taken back from your balance.${bal < 0 ? ` Your cash is now negative ($${(-bal / 100).toFixed(2)} owed); withdrawals are paused until a deposit repays it.` : ''} Reason: ${v.reason.slice(0, 160)}`,
        link: '/portfolio?tab=history' });
    }
    return { market: after, correction: correctionVo(db.prepare('SELECT * FROM settlement_corrections WHERE id=?').get(id)) };
  }
  const correctionVo = (c) => ({ id: c.id, market_ticker: c.market_ticker, from_result: c.from_result, to_result: c.to_result, from_settlement_value_dollars: P.ccToDollars(c.from_value_cc), to_settlement_value_dollars: P.ccToDollars(c.to_value_cc),
    expiration_value: c.expiration_value, reason: c.reason, requested_by: emailOf(c.requested_by), approved_by: emailOf(c.approved_by), users: c.users,
    clawback_dollars: dollars(c.clawback_cents), repaid_dollars: dollars(c.repaid_cents), created_time: new Date(c.created_ts).toISOString() });
  v1.post('/admin/resolution/:ticker/correct', can('resolution.write'), (req, res) => {
    const m = marketRow(String(req.params.ticker));
    if (!m) throw E.notFound();
    const v = validateCorrect(m, req.body || {});
    auth.assertFresh(req, 'settlement_correction'); // step-up (CLONE_SPEC.md §22.6)
    const pending = gate(req, 'correct', m.ticker, v, v.reason);
    if (pending) return res.status(202).json(pending);
    res.json(doCorrect(req, m.ticker, v));
  });
  v1.get('/admin/resolution/:ticker/corrections', can('catalog.read'), (req, res) => res.json({ corrections: db.prepare('SELECT * FROM settlement_corrections WHERE market_ticker=? ORDER BY created_ts DESC').all(String(req.params.ticker)).map(correctionVo) }));

  // Ticket helpers: what an order would do before it is placed (A7 review, A8 flip line). Read-only.
  v1.get('/users/:uid/positions/:ticker/flip_preview', requireUser, (req, res) => {
    const p = db.prepare('SELECT yes_count, no_count FROM positions WHERE user_id=? AND market_ticker=?').get(req.auth.user.id, req.params.ticker) || { yes_count: 0, no_count: 0 };
    const side = req.query.side === 'no' ? 'no' : 'yes';
    const held = side === 'yes' ? p.yes_count : p.no_count;
    const raw = String(req.query.count || '');
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw E.badRequest('count must be a number of contracts with at most 2 decimal places');
    const units = Math.round(Number(raw) * UNITS);
    const flip = Math.max(0, units - held);
    res.json({ side, held_fp: ufp(held), count_fp: ufp(units), closes_fp: ufp(Math.min(units, held)), opens_side: side === 'yes' ? 'no' : 'yes', opens_fp: ufp(flip),
      flip_enabled: userPref(req.auth.user.id, 'trade_flip_sell', false) === true, line: flip ? `Sells ${ustr(Math.min(units, held))} ${side.toUpperCase()} you hold and buys ${ustr(flip)} ${side === 'yes' ? 'NO' : 'YES'}` : null });
  });

  return { guaranteedCents, rebalance, rebalanceUser, policy };
}

module.exports = { mountTradingCore, SEED };
