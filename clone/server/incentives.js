'use strict';
// Liquidity Incentive Program (Phase 5B, PLAN A13; CLONE_SPEC.md §13.17 observed page, §13.19 `incentive_programs`
// endpoint, §29.7 design). Programs run per event with a start and end, a reward pool, a competition level, a target
// size, a spread window and a discount factor. Rewards accrue from resting liquidity and are paid out through the
// double-entry journal (server/journal.js) as cash (contra house:incentives) or as non-withdrawable credits.
//
// Accrual formula (design choice; the public docs describe a pool shared by resting orders near the best price, but the
// exact weighting, cadence and caps are UNKNOWN to us):
//   every snapshot (default 60 s), for each active program, the slice of the pool for the elapsed time
//     pool_slice = reward_pool × Δt / (end − start)
//   is split equally between the program's market sides (each market's YES bids and NO bids). On a side, the best
//   resting price b is taken from the whole book; each enrolled, eligible, non-system user scores
//     score_u = min(target_size, Σ_orders remaining_units × discount^(b − price))   for orders with b − price ≤ max_spread
//   and receives side_slice × score_u / Σ score. Amounts accrue in micro-cents (1 ¢ = 10⁶) so nothing is lost to
//   rounding; a payout pays the whole cents accrued and not yet paid. A side nobody qualifies on is not distributed.
// Eligibility: the user enrols by accepting the terms from an allowed region (simulated geo from server/compliance.js
// plus the program's blocked-region list); every visit re-checks the region and suspends accrual when it fails.
const CS = require('./content/currency-strings'); // keyed user-facing wording (CLONE_SPEC.md §30)
const C = require('./currency'); // display currency formatting (CLONE_SPEC.md §30)
const { tx } = require('./db');
const { newId, nowIso, dollars, ufp, UNITS, ApiError, E } = require('./util');
const { check } = require('./validate');
const auditChain = require('./audit-chain');

const MICRO = 1_000_000;
const TERMS_VERSION = '2026-11';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS incentive_programs (id TEXT PRIMARY KEY, event_ticker TEXT NOT NULL, market_tickers TEXT NOT NULL DEFAULT '[]', title TEXT NOT NULL DEFAULT '', incentive_type TEXT NOT NULL DEFAULT 'liquidity',
  start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, reward_pool_cents INTEGER NOT NULL, competition TEXT NOT NULL DEFAULT 'auto', target_size_units INTEGER NOT NULL, max_spread_cents INTEGER NOT NULL DEFAULT 3,
  discount REAL NOT NULL DEFAULT 0.5, payout_mode TEXT NOT NULL DEFAULT 'cash', status TEXT NOT NULL DEFAULT 'scheduled', last_snapshot_ts INTEGER, last_participants INTEGER NOT NULL DEFAULT 0,
  accrued_micro INTEGER NOT NULL DEFAULT 0, paid_cents INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_incentive_programs_status ON incentive_programs(status, start_ts);
CREATE TABLE IF NOT EXISTS incentive_enrollments (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, terms_version TEXT NOT NULL, country TEXT NOT NULL, eligible INTEGER NOT NULL, enrolled_at TEXT NOT NULL, checked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS incentive_accruals (program_id TEXT NOT NULL, user_id TEXT NOT NULL, micro_cents INTEGER NOT NULL DEFAULT 0, paid_cents INTEGER NOT NULL DEFAULT 0, last_score REAL NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL, PRIMARY KEY (program_id, user_id));
CREATE TABLE IF NOT EXISTS incentive_snapshots (id TEXT PRIMARY KEY, program_id TEXT NOT NULL, ts INTEGER NOT NULL, dt_ms INTEGER NOT NULL, pool_micro INTEGER NOT NULL, distributed_micro INTEGER NOT NULL, participants INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_incentive_snapshots_prog ON incentive_snapshots(program_id, ts);
CREATE TABLE IF NOT EXISTS incentive_rewards (id TEXT PRIMARY KEY, program_id TEXT NOT NULL, user_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, mode TEXT NOT NULL, month TEXT NOT NULL, created_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_incentive_rewards_user ON incentive_rewards(user_id, created_ts);
`;
const DEFAULT_SETTINGS = { blocked_regions: ['CU', 'IR', 'KP', 'SY'], auto_payout: true };
const PROGRAM = {
  event_ticker: { type: 'string', maxLen: 64, pattern: /^[A-Za-z0-9._-]+$/ }, market_tickers: { type: 'array', maxItems: 20, items: { type: 'string', maxLen: 64, pattern: /^[A-Za-z0-9._-]+$/ } },
  title: { type: 'string', maxLen: 120 }, start_time: { type: 'string', maxLen: 40 }, end_time: { type: 'string', maxLen: 40 }, reward_pool_dollars: { type: ['number', 'string'], maxLen: 16 },
  competition: { type: 'string', enum: ['auto', 'low', 'high'] }, target_size: { type: ['number', 'string'], maxLen: 16 }, max_spread_cents: { type: 'integer', min: 0, max: 20 },
  discount: { type: 'number', min: 0.05, max: 1 }, payout_mode: { type: 'string', enum: ['cash', 'credits'] }, status: { type: 'string', enum: ['canceled'] }, reason: { type: 'string', maxLen: 500, required: true },
};
const SETTINGS = { blocked_regions: { type: 'array', maxItems: 60, items: { type: 'string', maxLen: 2, pattern: /^[A-Z]{2}$/ } }, auto_payout: { type: 'boolean' }, reason: { type: 'string', maxLen: 500, required: true } };
const ENROLL = { accept_terms: { type: 'boolean', required: true }, terms_version: { type: 'string', maxLen: 16 } };
const REASON = { reason: { type: 'string', maxLen: 500, required: true } };
const monthKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 7);
const monthLabel = (ms = Date.now()) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

const TERMS = [
  'Liquidity incentive rewards are a Parlance demonstration programme paid in simulated funds.',
  'To take part you accept these terms from an eligible region. We re-check your region whenever you open the Liquidity Incentive Program page; while it is not eligible your resting orders earn nothing.',
  'Each program names its markets, start and end time, reward pool, target size, spread window and discount factor. Rewards accrue from your resting orders within the spread window of the best price on either side of each market, weighted by the discount factor for every cent behind the best price, up to the target size per market side.',
  'At each snapshot the pool for the elapsed time is shared by everyone who qualifies, in proportion to their scores. Parts of the pool nobody qualifies for are not paid out.',
  'Rewards are paid after the program ends (or earlier, at our discretion) as cash or as non-withdrawable credits, as stated on the program. Self-matching, wash trading or quoting you do not intend to honour forfeits rewards.',
];

function mountIncentives({ v1, db, engine, auth, admin, identity, feat, requireUser, getEvent, eventFull, options = {} }) {
  db.exec(SCHEMA);
  const SNAPSHOT_MS = Number(options.snapshotMs ?? 60000);
  const settings = () => { const r = db.prepare("SELECT value FROM admin_settings WHERE key='incentives'").get(); return { ...DEFAULT_SETTINGS, ...(r ? JSON.parse(r.value) : {}) }; };
  const audit = (req, action, id, before, after, reason) => auditChain.append(db, { actor_id: req.auth.user.id, actor_email: req.auth.user.email, action, target_type: 'incentive_program', target_id: id, before, after, reason });
  const reasonOf = (b) => { const r = String(b.reason || '').trim(); if (r.length < 3) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); return r; };
  const fieldErr = (f, m) => { const e = new ApiError(400, 'validation_failed', 'validation failed', `${f}: ${m}`); e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: { [f]: m } } }); return e; };
  const getProgram = (id) => db.prepare('SELECT * FROM incentive_programs WHERE id=?').get(id);
  const isSystem = (uid) => !!db.prepare('SELECT is_system FROM users WHERE id=?').get(uid)?.is_system;

  // ------------------------------------------------------------------ region
  function region(req) {
    const geo = identity?.compliance?.geoDecision ? identity.compliance.geoDecision(req) : { allowed: true, country: 'ZZ', country_name: 'Unknown' };
    const blocked = new Set(settings().blocked_regions || []);
    const eligible = geo.allowed && !blocked.has(geo.country);
    return { eligible, country: geo.country, country_name: geo.country_name };
  }
  function recheck(req) {
    const r = region(req);
    if (req.auth) db.prepare('UPDATE incentive_enrollments SET eligible=?, country=?, checked_at=? WHERE user_id=?').run(r.eligible ? 1 : 0, r.country, nowIso(), req.auth.user.id);
    return r;
  }

  // ------------------------------------------------------------------ status + views
  function refreshStatus(now = Date.now()) {
    db.prepare("UPDATE incentive_programs SET status='active', updated_at=? WHERE status='scheduled' AND start_ts<=? AND end_ts>?").run(nowIso(), now, now);
    const ended = db.prepare("SELECT * FROM incentive_programs WHERE status IN ('scheduled','active') AND end_ts<=?").all(now);
    for (const p of ended) {
      if (p.status === 'active') snapshotProgram(p, now); // the last slice up to the end
      db.prepare("UPDATE incentive_programs SET status='ended', updated_at=? WHERE id=?").run(nowIso(), p.id);
      if (settings().auto_payout) payout(getProgram(p.id), null, 'program ended');
      engine.emit('incentives', null, { type: 'program_ended', id: p.id });
    }
  }
  const marketsOf = (p) => { const list = JSON.parse(p.market_tickers || '[]'); return list.length ? list : db.prepare("SELECT ticker FROM markets WHERE event_ticker=? ORDER BY rowid").all(p.event_ticker).map((r) => r.ticker); };
  const competitionOf = (p) => (p.competition !== 'auto' ? p.competition : p.last_participants >= 3 ? 'high' : 'low');
  function programVo(p) {
    const e = getEvent(p.event_ticker); const ev = e ? eventFull(e) : null;
    const ms = marketsOf(p);
    return {
      id: p.id, incentive_type: p.incentive_type, event_ticker: p.event_ticker, title: p.title || (ev ? ev.title : p.event_ticker), event_title: ev ? ev.title : p.event_ticker, event_sub_title: ev ? ev.sub_title : '',
      series_ticker: ev ? ev.series_ticker : null, series_slug: ev ? ev.series_slug : null, category: ev ? ev.category : null,
      markets: ms.map((t) => { const m = ev && ev.markets.find((x) => x.ticker === t); return { ticker: t, title: m ? m.yes_sub_title : t, status: m ? m.status : null }; }),
      start_date: new Date(p.start_ts).toISOString(), end_date: new Date(p.end_ts).toISOString(), period_reward_dollars: dollars(p.reward_pool_cents),
      competition: competitionOf(p), competition_setting: p.competition, target_size_fp: ufp(p.target_size_units), max_spread_cents: p.max_spread_cents, discount_factor_bps: Math.round(p.discount * 10000),
      payout_mode: p.payout_mode, status: p.status, paid_out: p.status === 'paid', participants: p.last_participants, accrued_dollars: dollars(Math.floor(p.accrued_micro / MICRO)), paid_dollars: dollars(p.paid_cents),
    };
  }

  // ------------------------------------------------------------------ accrual
  function snapshotProgram(p, now) {
    const start = Math.max(p.start_ts, p.last_snapshot_ts || p.start_ts);
    const until = Math.min(now, p.end_ts);
    const dt = Math.min(until - start, Math.max(2 * SNAPSHOT_MS, 1000)); // never back-fill a long outage
    if (dt <= 0) return null;
    const pool = Math.floor((p.reward_pool_cents * MICRO * dt) / (p.end_ts - p.start_ts));
    const sides = marketsOf(p).flatMap((t) => [[t, 'yes'], [t, 'no']]);
    const slice = sides.length ? Math.floor(pool / sides.length) : 0;
    const eligible = new Set(db.prepare('SELECT user_id FROM incentive_enrollments WHERE eligible=1').all().map((r) => r.user_id));
    const add = new Map(); const scores = new Map(); let distributed = 0;
    for (const [t, side] of sides) {
      const orders = db.prepare("SELECT user_id, price_cents, remaining_count FROM orders WHERE market_ticker=? AND side=? AND status='resting'").all(t, side);
      if (!orders.length) continue;
      const best = Math.max(...orders.map((o) => o.price_cents));
      const per = new Map();
      for (const o of orders) {
        const dist = best - o.price_cents;
        if (dist > p.max_spread_cents || !eligible.has(o.user_id) || isSystem(o.user_id)) continue;
        per.set(o.user_id, (per.get(o.user_id) || 0) + o.remaining_count * p.discount ** dist);
      }
      let total = 0;
      for (const [u, s] of per) { const c = Math.min(s, p.target_size_units); per.set(u, c); total += c; }
      if (total <= 0) continue;
      for (const [u, s] of per) {
        const amt = Math.floor((slice * s) / total);
        add.set(u, (add.get(u) || 0) + amt); scores.set(u, (scores.get(u) || 0) + s); distributed += amt;
      }
    }
    tx(db, () => {
      for (const [u, amt] of add) {
        db.prepare('INSERT INTO incentive_accruals(program_id,user_id,micro_cents,last_score,updated_ts) VALUES(?,?,?,?,?) ON CONFLICT(program_id,user_id) DO UPDATE SET micro_cents=micro_cents+excluded.micro_cents, last_score=excluded.last_score, updated_ts=excluded.updated_ts')
          .run(p.id, u, amt, scores.get(u) / UNITS, now);
      }
      db.prepare('UPDATE incentive_programs SET last_snapshot_ts=?, last_participants=?, accrued_micro=accrued_micro+?, updated_at=? WHERE id=?').run(start + dt, add.size, distributed, nowIso(), p.id);
      db.prepare('INSERT INTO incentive_snapshots(id,program_id,ts,dt_ms,pool_micro,distributed_micro,participants) VALUES(?,?,?,?,?,?,?)').run(newId('isn_'), p.id, now, dt, pool, distributed, add.size);
      db.prepare('DELETE FROM incentive_snapshots WHERE program_id=? AND ts<?').run(p.id, now - 14 * 86400000);
    });
    for (const u of add.keys()) engine.emit('incentive_reward', u, { type: 'accrued', program_id: p.id });
    return { pool, distributed, participants: add.size, dt };
  }
  function snapshotAll(now = Date.now()) {
    refreshStatus(now);
    const out = [];
    for (const p of db.prepare("SELECT * FROM incentive_programs WHERE status='active'").all()) out.push({ id: p.id, ...(snapshotProgram(p, now) || { pool: 0, distributed: 0, participants: 0, dt: 0 }) });
    return out;
  }
  let lastSnap = 0;
  engine.on('tick', () => {
    const now = Date.now();
    if (now - lastSnap < SNAPSHOT_MS) return;
    lastSnap = now;
    try { snapshotAll(now); } catch (e) { console.error('incentives', e); }
  });

  // ------------------------------------------------------------------ payout (journaled)
  function payout(p, actor, memo) {
    const paid = [];
    tx(db, () => {
      for (const a of db.prepare('SELECT * FROM incentive_accruals WHERE program_id=?').all(p.id)) {
        const due = Math.floor(a.micro_cents / MICRO) - a.paid_cents;
        if (due <= 0) continue;
        const label = `Liquidity incentive · ${p.title || p.event_ticker}`;
        // Cash: user cash ← house:incentives. Credits: user credits ← house:promotions, with an expiring grant.
        if (p.payout_mode === 'credits') engine.credit(a.user_id, due, 'credit', p.id, label);
        else engine.credit(a.user_id, due, 'incentive', p.id, label, { contra: 'house:incentives' });
        db.prepare('UPDATE incentive_accruals SET paid_cents=paid_cents+? WHERE program_id=? AND user_id=?').run(due, p.id, a.user_id);
        db.prepare('INSERT INTO incentive_rewards(id,program_id,user_id,amount_cents,mode,month,created_ts) VALUES(?,?,?,?,?,?,?)').run(newId('irw_'), p.id, a.user_id, due, p.payout_mode, monthKey(), Date.now());
        paid.push({ user_id: a.user_id, cents: due });
      }
      const total = paid.reduce((s, x) => s + x.cents, 0);
      db.prepare(`UPDATE incentive_programs SET paid_cents=paid_cents+?, status=CASE WHEN status='ended' THEN 'paid' ELSE status END, updated_at=? WHERE id=?`).run(total, nowIso(), p.id);
    });
    for (const x of paid) {
      engine.emit('user_balance', x.user_id, engine.balance(x.user_id));
      try { feat.notify(x.user_id, { type: 'market_reward', title: CS.t('notify.market_reward.title', { amount: C.moneyCents(x.cents) }), body: p.title || p.event_ticker, link: '/incentives' }); } catch (e) { console.error('incentive notify', e.message); }
      engine.emit('incentive_reward', x.user_id, { type: 'paid', program_id: p.id, amount_dollars: dollars(x.cents) });
    }
    void actor; void memo;
    return paid;
  }

  // ------------------------------------------------------------------ public + user routes
  v1.get('/incentive_programs', (req, res) => {
    refreshStatus();
    const st = String(req.query.status || 'active');
    if (!['active', 'upcoming', 'ended', 'all'].includes(st)) throw E.badRequest('status must be active, upcoming, ended or all');
    if (req.query.type && req.query.type !== 'liquidity') throw E.badRequest('type must be liquidity');
    const size = Math.min(200, Math.max(1, Number(req.query.page_size) || 100));
    const r = recheck(req);
    // Observed: the list is empty where the program is not offered, with the region banner on the page (§13.19).
    if (!r.eligible) return res.json({ incentive_programs: [], region: r });
    const where = { active: "status='active'", upcoming: "status='scheduled'", ended: "status IN ('ended','paid')", all: "status<>'canceled'" }[st];
    const rows = db.prepare(`SELECT * FROM incentive_programs WHERE ${where} ORDER BY reward_pool_cents DESC, start_ts LIMIT ?`).all(size);
    res.json({ incentive_programs: rows.map(programVo), region: r });
  });
  v1.get('/incentive_programs/terms', (req, res) => res.json({ version: TERMS_VERSION, paragraphs: TERMS }));
  v1.get('/users/:uid/incentives', requireUser, (req, res) => {
    const uid = req.auth.user.id; const r = recheck(req);
    const en = db.prepare('SELECT * FROM incentive_enrollments WHERE user_id=?').get(uid);
    const rewards = db.prepare('SELECT r.*, p.title, p.event_ticker FROM incentive_rewards r LEFT JOIN incentive_programs p ON p.id=r.program_id WHERE r.user_id=? ORDER BY r.created_ts DESC LIMIT 100').all(uid);
    const month = monthKey();
    const pending = db.prepare('SELECT COALESCE(SUM(micro_cents),0) m, COALESCE(SUM(paid_cents),0) p FROM incentive_accruals WHERE user_id=?').get(uid);
    const pendingCents = Math.max(0, Math.floor(pending.m / MICRO) - pending.p);
    const programs = db.prepare('SELECT a.*, p.title, p.event_ticker, p.status FROM incentive_accruals a JOIN incentive_programs p ON p.id=a.program_id WHERE a.user_id=? ORDER BY a.updated_ts DESC').all(uid);
    res.json({
      enrolled: !!en, eligible: r.eligible, region: r, terms_version: TERMS_VERSION, accepted_terms_version: en ? en.terms_version : null,
      month: { key: month, label: monthLabel(), rewards_dollars: dollars(rewards.filter((x) => x.month === month).reduce((s, x) => s + x.amount_cents, 0)), pending_dollars: dollars(pendingCents) },
      lifetime_dollars: dollars(rewards.reduce((s, x) => s + x.amount_cents, 0)),
      rewards: rewards.map((x) => ({ id: x.id, program_id: x.program_id, title: x.title || x.event_ticker, amount_dollars: dollars(x.amount_cents), mode: x.mode, paid_time: new Date(x.created_ts).toISOString() })),
      programs: programs.map((a) => ({ program_id: a.program_id, title: a.title || a.event_ticker, status: a.status, accrued_dollars: dollars(Math.floor(a.micro_cents / MICRO)), accrued_micro_cents: a.micro_cents, paid_dollars: dollars(a.paid_cents), last_score_fp: String(Math.round(a.last_score * 100) / 100) })),
    });
  });
  v1.post('/users/:uid/incentives/enrollment', requireUser, (req, res) => {
    const b = check(req.body, ENROLL, { unknown: 'reject', maxKeys: 2 });
    if (b.accept_terms !== true) throw E.badRequest('accept the program terms to take part');
    if (b.terms_version && b.terms_version !== TERMS_VERSION) throw E.conflict('terms_changed', 'the terms have changed', 'reload the page and review the current terms');
    const r = region(req);
    if (!r.eligible) throw new ApiError(403, 'region_not_eligible', 'Incentive programs are not available in your region', r.country_name);
    const at = nowIso();
    db.prepare('INSERT INTO incentive_enrollments(user_id,terms_version,country,eligible,enrolled_at,checked_at) VALUES(?,?,?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET terms_version=excluded.terms_version, country=excluded.country, eligible=1, checked_at=excluded.checked_at').run(req.auth.user.id, TERMS_VERSION, r.country, at, at);
    res.status(201).json({ enrolled: true, terms_version: TERMS_VERSION });
  });
  v1.delete('/users/:uid/incentives/enrollment', requireUser, (req, res) => {
    db.prepare('DELETE FROM incentive_enrollments WHERE user_id=?').run(req.auth.user.id);
    res.json({ enrolled: false });
  });

  // ------------------------------------------------------------------ admin
  const A = '/admin/incentives';
  const parseProgram = (b, cur = null) => {
    const v = {};
    const et = b.event_ticker != null ? String(b.event_ticker).toUpperCase() : cur?.event_ticker;
    if (!et || !getEvent(et)) throw fieldErr('event_ticker', 'no such event');
    v.event_ticker = et;
    const evMarkets = new Set(db.prepare('SELECT ticker FROM markets WHERE event_ticker=?').all(et).map((r) => r.ticker));
    const mts = b.market_tickers != null ? b.market_tickers.map((t) => String(t).toUpperCase()) : cur ? JSON.parse(cur.market_tickers) : [];
    if (mts.some((t) => !evMarkets.has(t))) throw fieldErr('market_tickers', 'every market must belong to the event');
    v.market_tickers = JSON.stringify(mts);
    v.title = b.title != null ? String(b.title).trim() : cur?.title || '';
    const time = (x, f) => { const n = Date.parse(x); if (!Number.isFinite(n)) throw fieldErr(f, 'must be a date and time'); return n; };
    v.start_ts = b.start_time != null ? time(b.start_time, 'start_time') : cur ? cur.start_ts : null;
    v.end_ts = b.end_time != null ? time(b.end_time, 'end_time') : cur ? cur.end_ts : null;
    if (v.start_ts == null) throw fieldErr('start_time', 'is required');
    if (v.end_ts == null) throw fieldErr('end_time', 'is required');
    if (v.end_ts <= v.start_ts) throw fieldErr('end_time', 'must be after the start');
    const pool = b.reward_pool_dollars != null ? Math.round(Number(b.reward_pool_dollars) * 100) : cur?.reward_pool_cents;
    if (!Number.isInteger(pool) || pool < 1 || pool > 10_000_000_00) throw fieldErr('reward_pool_dollars', CS.t('error.reward_pool', { min: C.moneyCents(1), max: C.moneyCents(10_000_000_00) }));
    v.reward_pool_cents = pool;
    const size = b.target_size != null ? Math.round(Number(b.target_size) * UNITS) : cur?.target_size_units ?? 100 * UNITS;
    if (!Number.isInteger(size) || size < 1 || size > 1e6 * UNITS) throw fieldErr('target_size', 'must be a positive number of contracts');
    v.target_size_units = size;
    v.competition = b.competition ?? cur?.competition ?? 'auto';
    v.max_spread_cents = b.max_spread_cents ?? cur?.max_spread_cents ?? 3;
    v.discount = b.discount ?? cur?.discount ?? 0.5;
    v.payout_mode = b.payout_mode ?? cur?.payout_mode ?? 'cash';
    return v;
  };
  v1.get(`${A}/programs`, admin.can('markets.ops'), (req, res) => {
    refreshStatus();
    const rows = db.prepare('SELECT * FROM incentive_programs ORDER BY created_at DESC').all();
    res.json({ programs: rows.map((p) => ({ ...programVo(p), accruals: db.prepare('SELECT COUNT(*) n FROM incentive_accruals WHERE program_id=?').get(p.id).n })), settings: settings() });
  });
  v1.post(`${A}/programs`, admin.can('markets.ops'), (req, res) => {
    const b = check(req.body, PROGRAM, { unknown: 'reject', maxKeys: 16 }); const reason = reasonOf(b);
    const v = parseProgram(b);
    const id = newId('lip_'); const at = nowIso();
    const status = v.start_ts <= Date.now() ? 'active' : 'scheduled';
    db.prepare('INSERT INTO incentive_programs(id,event_ticker,market_tickers,title,start_ts,end_ts,reward_pool_cents,competition,target_size_units,max_spread_cents,discount,payout_mode,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, v.event_ticker, v.market_tickers, v.title, v.start_ts, v.end_ts, v.reward_pool_cents, v.competition, v.target_size_units, v.max_spread_cents, v.discount, v.payout_mode, status, req.auth.user.id, at, at);
    const p = getProgram(id);
    audit(req, 'incentives.program.create', id, null, p, reason);
    engine.emit('incentives', null, { type: 'program_created', id });
    res.status(201).json({ program: programVo(p) });
  });
  v1.put(`${A}/programs/:id`, admin.can('markets.ops'), (req, res) => {
    const cur = getProgram(req.params.id); if (!cur) throw E.notFound();
    const b = check(req.body, PROGRAM, { unknown: 'reject', maxKeys: 16 }); const reason = reasonOf(b);
    if (['paid', 'canceled'].includes(cur.status)) throw E.conflict('program_closed', 'this program can no longer be changed');
    if (b.status === 'canceled') {
      db.prepare("UPDATE incentive_programs SET status='canceled', updated_at=? WHERE id=?").run(nowIso(), cur.id);
    } else {
      const v = parseProgram(b, cur);
      if (cur.status !== 'scheduled' && (v.start_ts !== cur.start_ts || v.event_ticker !== cur.event_ticker)) throw E.conflict('program_started', 'the event and start of a started program cannot change');
      db.prepare('UPDATE incentive_programs SET event_ticker=?, market_tickers=?, title=?, start_ts=?, end_ts=?, reward_pool_cents=?, competition=?, target_size_units=?, max_spread_cents=?, discount=?, payout_mode=?, updated_at=? WHERE id=?')
        .run(v.event_ticker, v.market_tickers, v.title, v.start_ts, v.end_ts, v.reward_pool_cents, v.competition, v.target_size_units, v.max_spread_cents, v.discount, v.payout_mode, nowIso(), cur.id);
    }
    const p = getProgram(cur.id);
    audit(req, 'incentives.program.update', cur.id, cur, p, reason);
    engine.emit('incentives', null, { type: 'program_updated', id: cur.id });
    res.json({ program: programVo(p) });
  });
  // Pays every user the whole cents accrued and not yet paid (also before the end). Money moves: users.money + step-up.
  v1.post(`${A}/programs/:id/payout`, admin.can('users.money'), (req, res) => {
    const p = getProgram(req.params.id); if (!p) throw E.notFound();
    const b = check(req.body, REASON, { unknown: 'reject', maxKeys: 1 }); const reason = reasonOf(b);
    if (auth?.assertFresh) auth.assertFresh(req, 'incentive_payout');
    if (p.status === 'canceled') throw E.conflict('program_canceled', 'a canceled program pays nothing');
    const paid = payout(p, req.auth.user.id, reason);
    const total = paid.reduce((s, x) => s + x.cents, 0);
    audit(req, 'incentives.program.payout', p.id, { paid_cents: p.paid_cents, status: p.status }, { paid_cents: p.paid_cents + total, recipients: paid.length }, reason);
    res.json({ program: programVo(getProgram(p.id)), paid: paid.map((x) => ({ user_id: x.user_id, amount_dollars: dollars(x.cents) })), total_dollars: dollars(total) });
  });
  v1.post(`${A}/snapshot`, admin.can('markets.ops'), (req, res) => { check(req.body, {}, { maxKeys: 0 }); res.json({ snapshots: snapshotAll() }); });
  v1.get(`${A}/settings`, admin.can('settings.write'), (req, res) => res.json({ settings: settings() }));
  v1.put(`${A}/settings`, admin.can('settings.write'), (req, res) => {
    const b = check(req.body, SETTINGS, { unknown: 'reject', maxKeys: 3 }); const reason = reasonOf(b);
    const before = settings(); const next = { ...before, ...(b.blocked_regions ? { blocked_regions: [...new Set(b.blocked_regions)] } : {}), ...(b.auto_payout != null ? { auto_payout: b.auto_payout } : {}) };
    db.prepare("INSERT INTO admin_settings(key,value,updated_at,updated_by) VALUES('incentives',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by").run(JSON.stringify(next), nowIso(), req.auth.user.id);
    auditChain.append(db, { actor_id: req.auth.user.id, actor_email: req.auth.user.email, action: 'incentives.settings', target_type: 'settings', target_id: 'incentives', before, after: next, reason });
    res.json({ settings: next });
  });

  // Seed helper (demo data, server/hubs.js).
  function createProgram(v) {
    const id = newId('lip_'); const at = nowIso();
    db.prepare('INSERT INTO incentive_programs(id,event_ticker,market_tickers,title,start_ts,end_ts,reward_pool_cents,competition,target_size_units,max_spread_cents,discount,payout_mode,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, v.event_ticker, JSON.stringify(v.market_tickers || []), v.title || '', v.start_ts, v.end_ts, v.reward_pool_cents, v.competition || 'auto', v.target_size_units || 100 * UNITS, v.max_spread_cents ?? 3, v.discount ?? 0.5, v.payout_mode || 'cash', v.start_ts <= Date.now() ? 'active' : 'scheduled', null, at, at);
    return id;
  }
  return { snapshotAll, payout, createProgram, TERMS_VERSION };
}

module.exports = { mountIncentives, MICRO, TERMS_VERSION };
