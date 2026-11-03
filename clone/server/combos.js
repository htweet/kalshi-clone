'use strict';
// Combos (multivariate events, spec §17.1-17.3) and two-sided RFQ / quotes (spec §17.4-17.8).
// A combo is an ordinary binary market + event in the existing tables (series PLXCOMBO) whose legs live in
// combo_legs; it resolves from its legs and settles through the normal engine path. RFQs, quotes and the
// per-user combo slip are persisted; timers are only accelerators: every transition is re-derived on the
// engine tick from persisted timestamps, so a restart never loses or double-applies one.
const crypto = require('node:crypto');
const { tx } = require('./db');
const { nowIso, newId, dollars, ufp, ustr, toUnits, UNITS, E, ApiError } = require('./util');
const { takerFeeCents, takerPrincipal } = require('./engine');
const { marketVo } = require('./serialize');

const COMBO_SERIES = 'PLXCOMBO';
const ROLLING_SERIES = 'PLXFLASH';
const MIN_LEGS = 2;
const MAX_LEGS = 6;
const MAX_OPEN_RFQS = 100; // api-reference_communications_create-rfq.md
const DEFAULTS = { quoteTtlMs: 20000, rfqTtlMs: 10 * 60000, confirmWindowMs: 30000, makerDelayMs: 400, autoConfirmMs: 700, spreadCents: 3 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS combo_legs (
  combo_ticker TEXT NOT NULL REFERENCES markets(ticker), leg_index INTEGER NOT NULL,
  market_ticker TEXT NOT NULL REFERENCES markets(ticker), event_ticker TEXT NOT NULL, side TEXT NOT NULL,
  PRIMARY KEY (combo_ticker, leg_index)
);
CREATE INDEX IF NOT EXISTS idx_combo_legs_market ON combo_legs(market_ticker);
CREATE TABLE IF NOT EXISTS combo_slips (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, legs TEXT NOT NULL DEFAULT '[]',
  amount_cents INTEGER, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rfqs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), market_ticker TEXT NOT NULL REFERENCES markets(ticker),
  contracts_units INTEGER, target_cost_cents INTEGER, rest_remainder INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,              -- open|accepted|executed|expired|cancelled
  created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL, closed_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_rfqs_status ON rfqs(status, created_ts);
CREATE INDEX IF NOT EXISTS idx_rfqs_user ON rfqs(user_id, created_ts);
CREATE TABLE IF NOT EXISTS rfq_quotes (
  id TEXT PRIMARY KEY, rfq_id TEXT NOT NULL REFERENCES rfqs(id), maker_id TEXT NOT NULL REFERENCES users(id),
  yes_bid_cents INTEGER NOT NULL, no_bid_cents INTEGER NOT NULL, yes_units INTEGER NOT NULL, no_units INTEGER NOT NULL,
  status TEXT NOT NULL,              -- open|accepted|confirmed|executed|expired|cancelled
  accepted_side TEXT, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL,
  accepted_ts INTEGER, confirm_deadline_ts INTEGER, confirmed_ts INTEGER, executed_ts INTEGER, executed_units INTEGER,
  maker_order_id TEXT, taker_order_id TEXT, closed_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_quotes_rfq ON rfq_quotes(rfq_id, status);
CREATE INDEX IF NOT EXISTS idx_quotes_maker ON rfq_quotes(maker_id, created_ts);
CREATE TABLE IF NOT EXISTS combo_creations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, combo_ticker TEXT NOT NULL REFERENCES markets(ticker),
  created_ts INTEGER NOT NULL, PRIMARY KEY (user_id, combo_ticker)
);
`;

// Contracts a requester can buy at `price` cents for `cents` including the taker fee (spec §17.5 sizing).
function unitsForCost(cents, price, fractional) {
  const step = fractional ? 1 : UNITS;
  const cost = (u) => takerPrincipal(u, price) + takerFeeCents(u, price);
  let u = Math.floor((cents * UNITS) / (price + (0.07 * price * (100 - price)) / 100));
  u -= u % step;
  while (u > 0 && cost(u) > cents) u -= step;
  while (cost(u + step) <= cents) u += step;
  return Math.max(0, u);
}

function mountCombos({ v1, db, engine, requireUser, notify, eventFull, checkTrading, options = {} }) {
  const opt = { ...DEFAULTS, ...(options || {}) };
  db.exec(SCHEMA);
  if (!db.prepare('SELECT 1 FROM series WHERE ticker=?').get(COMBO_SERIES)) {
    db.prepare('INSERT INTO series(ticker,title,slug,category,tags,frequency,fee_type,fee_multiplier,settlement_sources,rules) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(COMBO_SERIES, 'Combos', 'combos', 'Combos', JSON.stringify(['Combos']), 'one_off', 'quadratic', 1,
        JSON.stringify([{ name: 'Settlement of each leg market', url: 'https://example.org/resolution' }]),
        'A combo resolves YES only if every selected leg resolves to its chosen side. It resolves NO as soon as any leg resolves against its chosen side.');
  }
  let salt = db.prepare("SELECT value FROM meta WHERE key='comms_salt'").get()?.value;
  if (!salt) { salt = crypto.randomBytes(16).toString('hex'); db.prepare("INSERT INTO meta(key,value) VALUES('comms_salt',?)").run(salt); }
  const commsId = (uid) => crypto.createHash('sha256').update(salt + uid).digest('hex').slice(0, 24); // pseudonymous (getting_started_rfqs.md)
  // G3 (PLAN §7, CLONE_SPEC.md §24.10): obscure_creator_id on RFQs; partial-size quotes and rest_remainder on quotes.
  { const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
    if (!has('rfqs', 'obscure_creator_id')) db.exec('ALTER TABLE rfqs ADD COLUMN obscure_creator_id INTEGER NOT NULL DEFAULT 0');
    if (!has('rfqs', 'remainder_order_id')) db.exec('ALTER TABLE rfqs ADD COLUMN remainder_order_id TEXT');
    if (!has('rfq_quotes', 'rest_remainder')) db.exec('ALTER TABLE rfq_quotes ADD COLUMN rest_remainder INTEGER NOT NULL DEFAULT 0'); }
  // Docs: other users see the empty-input SHA-256 placeholder until the RFQ executes; the creator always sees the real id.
  const OBSCURED_ID = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const rfqCreatorId = (r, viewer, revealed = r.status === 'executed') => (r.obscure_creator_id && viewer !== r.user_id && !revealed ? OBSCURED_ID : commsId(r.user_id));
  const lpId = () => db.prepare("SELECT id FROM users WHERE email='liquidity@parlance.local'").get()?.id;
  const userRow = (uid) => db.prepare('SELECT id, is_system FROM users WHERE id=?').get(uid);
  const isSystem = (uid) => !!userRow(uid)?.is_system;
  const rfqEnabled = (uid) => { const r = db.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='rfq_enabled'").get(uid); return !!(r && JSON.parse(r.value)); };
  const marketRow = (t) => db.prepare('SELECT m.*, e.series_ticker, e.title event_title FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.ticker=?').get(t);
  const emit = (uid, type, msg) => engine.emit('communications', uid, type, msg);
  const prob = (t) => {
    const q = engine.quote(t);
    if (q.last_price != null) return q.last_price;
    if (q.yes_bid != null && q.yes_ask != null) return (q.yes_bid + q.yes_ask) / 2;
    return 50;
  };
  const eventHref = (t) => { const r = db.prepare('SELECT e.ticker et, s.ticker st, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.ticker=?').get(t); return r ? `/markets/${r.st.toLowerCase()}/${r.slug}/${r.et.toLowerCase()}` : '/'; };

  // ======================= legs, combo markets, resolution =======================
  const legsOf = (combo) => db.prepare('SELECT * FROM combo_legs WHERE combo_ticker=? ORDER BY leg_index').all(combo);
  const legStatus = (leg, lm) => (!lm.result ? 'pending' : lm.result === leg.side ? 'won' : 'lost');
  function legVo(leg) {
    const lm = marketRow(leg.market_ticker);
    const p = prob(leg.market_ticker);
    return { market_ticker: leg.market_ticker, event_ticker: leg.event_ticker, side: leg.side, event_title: lm.event_title, outcome: lm.yes_sub_title,
      label: `${leg.side === 'yes' ? 'Yes' : 'No'} · ${lm.yes_sub_title}`, market_status: lm.status, market_result: lm.result, leg_status: legStatus(leg, lm),
      prob: Math.round(leg.side === 'yes' ? p : 100 - p), link: eventHref(leg.market_ticker) };
  }
  const combinedProb = (legs) => Math.round(legs.reduce((a, l) => a * (l.prob / 100), 1) * 10000) / 100; // percent, 2 dp

  // Validate {market_ticker, event_ticker?, side} legs; returns normalized legs sorted by market ticker.
  function normalizeLegs(raw, { min = MIN_LEGS } = {}) {
    if (!Array.isArray(raw)) throw E.badRequest('selected_markets must be an array');
    if (raw.length < min || raw.length > MAX_LEGS) throw new ApiError(400, 'invalid_leg_count', `a combo needs ${MIN_LEGS} to ${MAX_LEGS} legs`, `got ${raw.length}`);
    const seen = new Set();
    const legs = raw.map((l) => {
      const t = String((l && l.market_ticker) || '');
      const m = marketRow(t);
      if (!m) throw new ApiError(404, 'market_not_found', 'leg market not found', t);
      if (l.event_ticker != null && l.event_ticker !== m.event_ticker) throw E.badRequest(`event_ticker does not match market ${t}`);
      if (!['yes', 'no'].includes(l.side)) throw E.badRequest('each leg side must be yes or no');
      if (m.mve_collection_ticker || m.series_ticker === COMBO_SERIES) throw new ApiError(400, 'invalid_leg', 'a combo cannot be a leg of another combo', t);
      if (m.series_ticker === ROLLING_SERIES) throw new ApiError(400, 'invalid_leg', 'rolling short-window markets cannot be combo legs', t);
      if (m.status !== 'active') throw new ApiError(400, 'invalid_leg', 'every leg must be an open market', `${t} is ${m.status}`);
      if (seen.has(m.event_ticker)) throw new ApiError(400, 'duplicate_event', 'each leg must come from a different event', m.event_ticker);
      seen.add(m.event_ticker);
      return { market_ticker: t, event_ticker: m.event_ticker, side: l.side };
    });
    return legs.sort((a, b) => a.market_ticker.localeCompare(b.market_ticker));
  }
  const comboTickerFor = (legs) => `${COMBO_SERIES}-${crypto.createHash('sha256').update(legs.map((l) => `${l.market_ticker}:${l.side}`).join('|')).digest('hex').slice(0, 10).toUpperCase()}`;

  function createCombo(legs) {
    const ticker = comboTickerFor(legs);
    if (db.prepare('SELECT 1 FROM markets WHERE ticker=?').get(ticker)) return { ticker, created: false };
    const rows = legs.map((l) => ({ l, m: marketRow(l.market_ticker) }));
    const label = ({ l, m }) => `${l.side === 'yes' ? 'Yes' : 'No'} ${m.yes_sub_title}`;
    const title = rows.map(label).join(' + ');
    const close = rows.map((r) => r.m.close_time).sort()[0];
    const expiry = rows.map((r) => r.m.expected_expiration_time).sort().at(-1);
    const now = nowIso();
    tx(db, () => {
      db.prepare('INSERT INTO events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,created_at) VALUES(?,?,?,?,?,0,0,\'\',\'\',0,?)')
        .run(ticker, COMBO_SERIES, `Combo: ${title}`, `${legs.length}-leg combo`, 'Combos', now);
      db.prepare('INSERT INTO markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,status,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,created_at,updated_at,fractional_trading_enabled,mve_collection_ticker,mve_selected_legs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)')
        .run(ticker, ticker, `Combo: ${title}`, 'All legs hit', 'Any leg misses', '#8f7fff', 'active', now, close, expiry, 5,
          `Resolves YES if every leg resolves as selected: ${rows.map(({ l, m }) => `${m.event_title} → ${label({ l, m })}`).join('; ')}. Resolves NO as soon as any leg resolves the other way.`,
          now, now, COMBO_SERIES, JSON.stringify(legs));
      legs.forEach((l, i) => db.prepare('INSERT INTO combo_legs(combo_ticker,leg_index,market_ticker,event_ticker,side) VALUES(?,?,?,?,?)').run(ticker, i, l.market_ticker, l.event_ticker, l.side));
    });
    engine.emit('lifecycle', ticker, 'created', 'active');
    return { ticker, created: true };
  }

  function resolveCombo(combo) {
    const m = marketRow(combo);
    if (!m || !['active', 'inactive', 'closed'].includes(m.status)) return;
    const st = legsOf(combo).map((l) => legStatus(l, marketRow(l.market_ticker)));
    if (st.includes('lost')) engine.determine(combo, 'no');
    else if (st.length && st.every((s) => s === 'won')) engine.determine(combo, 'yes');
  }
  engine.on('lifecycle', (ticker, type, status) => {
    if (status !== 'determined') return;
    for (const r of db.prepare('SELECT DISTINCT combo_ticker FROM combo_legs WHERE market_ticker=?').all(ticker)) {
      try { resolveCombo(r.combo_ticker); } catch (e) { console.error('combo resolve', e); }
    }
  });
  function sweepResolutions() {
    const rows = db.prepare(`SELECT DISTINCT cl.combo_ticker FROM combo_legs cl JOIN markets lm ON lm.ticker=cl.market_ticker JOIN markets cm ON cm.ticker=cl.combo_ticker
      WHERE lm.result<>'' AND cm.status IN ('active','inactive','closed')`).all();
    for (const r of rows) resolveCombo(r.combo_ticker);
  }

  // ======================= collection endpoints =======================
  const eligibleEvents = () => db.prepare('SELECT * FROM events WHERE series_ticker NOT IN (?,?) ORDER BY rowid').all(COMBO_SERIES, ROLLING_SERIES)
    .map(eventFull).map((e) => ({ ...e, markets: e.markets.filter((m) => m.status === 'active') })).filter((e) => e.markets.length);
  const collectionVo = (withEvents) => ({ collection_ticker: COMBO_SERIES, series_ticker: COMBO_SERIES, title: 'Build a combo', description: 'Pick 2 to 6 outcomes from different events. The combo pays $1 per contract only if every leg hits.', min_legs: MIN_LEGS, max_legs: MAX_LEGS, ...(withEvents ? { events: eligibleEvents() } : {}) });
  v1.get('/multivariate_event_collections', (req, res) => res.json({ multivariate_contracts: [collectionVo(false)] }));
  v1.get('/multivariate_event_collections/:collection', (req, res) => {
    if (req.params.collection.toUpperCase() !== COMBO_SERIES) throw E.notFound();
    res.json({ multivariate_contract: collectionVo(true) });
  });
  const createHandler = (req, res) => {
    if (req.params.collection.toUpperCase() !== COMBO_SERIES) throw E.notFound();
    const legs = normalizeLegs(req.body && req.body.selected_markets);
    const { ticker, created } = createCombo(legs);
    db.prepare('INSERT INTO combo_creations(user_id,combo_ticker,created_ts) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(req.auth.user.id, ticker, Date.now()); // for History
    const m = db.prepare('SELECT * FROM markets WHERE ticker=?').get(ticker);
    res.status(created ? 201 : 200).json({ event_ticker: ticker, market_ticker: ticker, created, market: marketVo(m, engine.quote(ticker)) });
  };
  v1.post('/multivariate_event_collections/:collection/markets', requireUser, createHandler);
  v1.post('/multivariate_event_collections/:collection', requireUser, createHandler); // doc path alias
  v1.get('/combos/:ticker', (req, res) => {
    const m = db.prepare('SELECT * FROM markets WHERE ticker=? AND mve_collection_ticker IS NOT NULL').get(req.params.ticker.toUpperCase());
    if (!m) throw E.notFound();
    const legs = legsOf(m.ticker).map(legVo);
    res.json({ combo: { market_ticker: m.ticker, event_ticker: m.event_ticker, title: m.title, status: m.status, result: m.result, legs, combined_prob: combinedProb(legs), link: eventHref(m.ticker), market: marketVo(m, engine.quote(m.ticker)) } });
  });
  v1.get('/users/:uid/combos', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const open = db.prepare(`SELECT p.*, m.title, m.status, m.result FROM positions p JOIN markets m ON m.ticker=p.market_ticker WHERE p.user_id=? AND m.mve_collection_ticker IS NOT NULL AND (p.yes_count>0 OR p.no_count>0) ORDER BY p.updated_at DESC`).all(uid);
    const settled = db.prepare(`SELECT s.*, m.title FROM settlements s JOIN markets m ON m.ticker=s.market_ticker WHERE s.user_id=? AND m.mve_collection_ticker IS NOT NULL ORDER BY s.created_at DESC LIMIT 50`).all(uid);
    const vo = (t) => legsOf(t).map(legVo);
    res.json({
      total_open_combos: open.length,
      open_combos: open.map((p) => ({ market_ticker: p.market_ticker, title: p.title, status: p.status, result: p.result, side: p.yes_count > 0 ? 'yes' : 'no', position_fp: ufp(p.yes_count || p.no_count), cost_dollars: dollars(p.yes_cost_cents + p.no_cost_cents), legs: vo(p.market_ticker), link: eventHref(p.market_ticker) })),
      settled_combos: settled.map((s) => ({ market_ticker: s.market_ticker, title: s.title, result: s.result, yes_count_fp: ufp(s.yes_count), no_count_fp: ufp(s.no_count), payout_dollars: dollars(s.payout_cents), cost_dollars: dollars(s.cost_cents), settled_time: s.created_at, legs: vo(s.market_ticker), link: eventHref(s.market_ticker) })),
    });
  });

  // ======================= combo slip (persisted per user) =======================
  function slipVo(uid) {
    const r = db.prepare('SELECT * FROM combo_slips WHERE user_id=?').get(uid);
    const raw = r ? JSON.parse(r.legs) : [];
    const legs = raw.filter((l) => marketRow(l.market_ticker)).map(legVo);
    let comboTicker = null;
    if (legs.length >= MIN_LEGS) { const t = comboTickerFor([...raw].sort((a, b) => a.market_ticker.localeCompare(b.market_ticker))); if (db.prepare('SELECT 1 FROM markets WHERE ticker=?').get(t)) comboTicker = t; }
    return { legs, amount_dollars: r && r.amount_cents != null ? dollars(r.amount_cents) : null, combined_prob: legs.length ? combinedProb(legs) : null, combo_market_ticker: comboTicker, updated_time: r ? r.updated_at : null };
  }
  v1.get('/users/:uid/combo_slip', requireUser, (req, res) => res.json({ slip: slipVo(req.auth.user.id) }));
  v1.put('/users/:uid/combo_slip', requireUser, (req, res) => {
    const b = req.body || {};
    const legs = normalizeLegs(b.legs || [], { min: 0 }).sort((a, z) => (b.legs.findIndex((x) => x.market_ticker === a.market_ticker) - b.legs.findIndex((x) => x.market_ticker === z.market_ticker)));
    let amt = null;
    if (b.amount_dollars != null && b.amount_dollars !== '') {
      const a = Number(b.amount_dollars);
      if (!Number.isFinite(a) || a <= 0 || a > 100000 || Math.round(a * 100) !== Math.round(a * 1e6) / 1e4) throw E.badRequest('amount_dollars must be a positive amount with at most 2 decimals');
      amt = Math.round(a * 100);
    }
    db.prepare('INSERT INTO combo_slips(user_id,legs,amount_cents,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET legs=excluded.legs, amount_cents=excluded.amount_cents, updated_at=excluded.updated_at')
      .run(req.auth.user.id, JSON.stringify(legs), amt, nowIso());
    res.json({ slip: slipVo(req.auth.user.id) });
  });
  v1.delete('/users/:uid/combo_slip', requireUser, (req, res) => {
    db.prepare('DELETE FROM combo_slips WHERE user_id=?').run(req.auth.user.id);
    res.json({ slip: slipVo(req.auth.user.id) });
  });

  // ======================= RFQs and quotes =======================
  const rfqRow = (id) => db.prepare('SELECT * FROM rfqs WHERE id=?').get(id);
  const quoteRow = (id) => db.prepare('SELECT * FROM rfq_quotes WHERE id=?').get(id);
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  function rfqVo(r, viewer) {
    const m = marketRow(r.market_ticker);
    const vo = { id: r.id, market_ticker: r.market_ticker, market_title: m.title, event_ticker: m.event_ticker, outcome: m.yes_sub_title, is_combo: !!m.mve_collection_ticker,
      contracts_fp: r.contracts_units == null ? null : ufp(r.contracts_units), target_cost_dollars: r.target_cost_cents == null ? null : dollars(r.target_cost_cents),
      rest_remainder: !!r.rest_remainder, status: r.status, closed_reason: r.closed_reason, created_time: iso(r.created_ts), updated_time: iso(r.updated_ts), expires_time: iso(r.expires_ts),
      creator_id: rfqCreatorId(r, viewer), obscure_creator_id: !!r.obscure_creator_id, remainder_order_id: viewer === r.user_id ? r.remainder_order_id || null : undefined, is_mine: viewer === r.user_id, link: eventHref(r.market_ticker) };
    if (m.mve_collection_ticker) { vo.mve_collection_ticker = m.mve_collection_ticker; vo.mve_selected_legs = JSON.parse(m.mve_selected_legs || '[]'); }
    return vo;
  }
  function quoteVo(q, viewer) {
    const r = rfqRow(q.rfq_id);
    const m = marketRow(r.market_ticker);
    return { id: q.id, quote_id: q.id, rfq_id: q.rfq_id, market_ticker: r.market_ticker, market_title: m.title, is_combo: !!m.mve_collection_ticker,
      yes_bid_dollars: dollars(q.yes_bid_cents), no_bid_dollars: dollars(q.no_bid_cents), yes_contracts_fp: ufp(q.yes_units), no_contracts_fp: ufp(q.no_units),
      // What the requester pays per contract: accepting the NO bid buys YES at 100−no_bid; accepting the YES bid buys NO at 100−yes_bid.
      buy_yes_price_dollars: q.no_bid_cents > 0 ? dollars(100 - q.no_bid_cents) : null, buy_no_price_dollars: q.yes_bid_cents > 0 ? dollars(100 - q.yes_bid_cents) : null,
      status: q.status, accepted_side: q.accepted_side, closed_reason: q.closed_reason, created_time: iso(q.created_ts), updated_time: iso(q.updated_ts), expires_time: iso(q.expires_ts),
      accepted_time: iso(q.accepted_ts), confirm_deadline_time: iso(q.confirm_deadline_ts), confirmed_time: iso(q.confirmed_ts), executed_time: iso(q.executed_ts),
      executed_contracts_fp: q.executed_units == null ? null : ufp(q.executed_units), creator_order_id: q.maker_order_id, rfq_creator_order_id: q.taker_order_id,
      rfq_status: r.status, rfq_contracts_fp: r.contracts_units == null ? null : ufp(r.contracts_units), rfq_target_cost_dollars: r.target_cost_cents == null ? null : dollars(r.target_cost_cents),
      rfq_creator_id: rfqCreatorId(r, viewer, q.status === 'executed'), creator_id: commsId(q.maker_id), is_system_maker: isSystem(q.maker_id), rest_remainder: !!q.rest_remainder,
      role: viewer === q.maker_id ? 'maker' : viewer === r.user_id ? 'requester' : null, link: eventHref(r.market_ticker) };
  }
  const touchRfq = (id, status, reason = null) => db.prepare('UPDATE rfqs SET status=?, closed_reason=COALESCE(?,closed_reason), updated_ts=? WHERE id=?').run(status, reason, Date.now(), id);
  const touchQuote = (id, status, reason = null) => db.prepare('UPDATE rfq_quotes SET status=?, closed_reason=COALESCE(?,closed_reason), updated_ts=? WHERE id=?').run(status, reason, Date.now(), id);
  // Quote events go only to the requester and that maker (getting_started_rfqs.md "WebSocket").
  const emitQuote = (type, qid) => {
    const q = quoteRow(qid); const r = rfqRow(q.rfq_id);
    for (const uid of new Set([r.user_id, q.maker_id])) emit(uid, type, quoteVo(q, uid));
  };
  const emitRfq = (type, id) => emit(null, type, { ...rfqVo(rfqRow(id), null), is_mine: undefined });

  function closeOpenQuotes(rfqId, reason) {
    for (const q of db.prepare("SELECT id FROM rfq_quotes WHERE rfq_id=? AND status IN ('open','accepted')").all(rfqId)) { touchQuote(q.id, 'cancelled', reason); emitQuote('quote_deleted', q.id); }
  }
  function sizeFor(r, m, price) {
    if (price <= 0 || price >= 100) return 0;
    if (r.contracts_units != null) return r.contracts_units;
    return unitsForCost(r.target_cost_cents, price, !!m.fractional_trading_enabled);
  }

  function createRfq(uid, b) {
    const m = marketRow(String(b.market_ticker || ''));
    if (!m) throw E.notFound();
    if (m.status !== 'active') throw E.conflict('market_inactive', 'market is not open for trading', `market status is ${m.status}`);
    const isCombo = !!m.mve_collection_ticker;
    if (!isCombo && !rfqEnabled(uid)) throw new ApiError(403, 'rfq_not_enabled', 'turn on RFQs (Portfolio → RFQs) to request quotes on single markets');
    const hasC = b.contracts != null || b.contracts_fp != null;
    const hasT = b.target_cost_dollars != null;
    if (hasC === hasT) throw E.badRequest('specify exactly one of contracts_fp or target_cost_dollars');
    let units = null; let target = null;
    if (hasC) {
      units = toUnits(b.contracts_fp != null ? b.contracts_fp : b.contracts);
      if (units == null || units < 1) throw E.badRequest('contracts_fp must be at least 0.01 with at most 2 decimals');
      if (b.contracts_fp != null && b.contracts != null && toUnits(b.contracts) !== units) throw E.badRequest('contracts and contracts_fp must match');
      if (units > 100000 * UNITS) throw E.badRequest('contracts_fp must be at most 100000');
      if (units % UNITS && !m.fractional_trading_enabled) throw new ApiError(400, 'fractional_not_enabled', 'fractional contracts are not enabled on this market', 'request a whole number of contracts');
    } else {
      const a = Number(b.target_cost_dollars);
      if (!Number.isFinite(a) || a < 0.01 || a > 100000 || Math.abs(Math.round(a * 100) - a * 100) > 1e-6) throw E.badRequest('target_cost_dollars must be between 0.01 and 100000 with at most 2 decimals');
      target = Math.round(a * 100);
    }
    const now = Date.now();
    const existing = db.prepare("SELECT id FROM rfqs WHERE user_id=? AND market_ticker=? AND status IN ('open','accepted')").get(uid, m.ticker);
    const id = newId('rfq_');
    tx(db, () => {
      if (existing) {
        if (!b.replace_existing) throw E.conflict('rfq_exists', 'you already have an open RFQ on this market', 'cancel it first or pass replace_existing');
        touchRfq(existing.id, 'cancelled', 'replaced'); closeOpenQuotes(existing.id, 'rfq_cancelled');
      }
      if (db.prepare("SELECT COUNT(*) c FROM rfqs WHERE user_id=? AND status IN ('open','accepted')").get(uid).c >= MAX_OPEN_RFQS) throw E.conflict('too_many_rfqs', `at most ${MAX_OPEN_RFQS} open RFQs`);
      db.prepare('INSERT INTO rfqs(id,user_id,market_ticker,contracts_units,target_cost_cents,rest_remainder,status,created_ts,updated_ts,expires_ts,obscure_creator_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, uid, m.ticker, units, target, b.rest_remainder ? 1 : 0, 'open', now, now, now + opt.rfqTtlMs, b.obscure_creator_id === true ? 1 : 0);
    });
    if (existing) emitRfq('rfq_deleted', existing.id);
    emitRfq('rfq_created', id);
    if (isCombo) setTimeout(pumpSafe, opt.makerDelayMs + 5);
    return rfqRow(id);
  }

  function createQuote(makerId, b, { system = false } = {}) {
    const r = rfqRow(String(b.rfq_id || ''));
    if (!r) throw E.notFound();
    if (!system && r.user_id === makerId) throw E.badRequest('you cannot quote your own RFQ');
    if (!system && !rfqEnabled(makerId)) throw new ApiError(403, 'rfq_not_enabled', 'turn on RFQs (Portfolio → RFQs) to answer other traders\' RFQs');
    if (r.status !== 'open' || r.expires_ts <= Date.now()) throw new ApiError(409, 'rfq_closed', 'this RFQ is no longer open', `status ${r.status}`);
    const m = marketRow(r.market_ticker);
    const parse = (v, name) => {
      const n = Number(v);
      if (v == null || v === '' || !Number.isFinite(n) || n < 0 || n >= 1) throw new ApiError(400, 'invalid_parameters', `${name} must be a price in dollars between 0 and 0.99`);
      const c = Math.round(n * 100);
      if (Math.abs(c - n * 100) > 1e-6) throw new ApiError(400, 'invalid_parameters', `${name} must be on the 1¢ price grid`);
      return c;
    };
    const yb = parse(b.yes_bid, 'yes_bid'); const nb = parse(b.no_bid, 'no_bid');
    if (!yb && !nb) throw new ApiError(400, 'invalid_parameters', 'quote at least one side (yes_bid or no_bid above 0)');
    if (yb + nb > 100) throw new ApiError(400, 'invalid_parameters', 'yes_bid + no_bid must not exceed $1.00');
    if (db.prepare("SELECT 1 FROM rfq_quotes WHERE rfq_id=? AND maker_id=? AND status IN ('accepted','confirmed')").get(r.id, makerId)) throw E.conflict('quote_accepted', 'your quote on this RFQ was already accepted');
    // Parlance extension (G3): a maker may quote part of a contract-sized RFQ with contracts_fp (≤ the RFQ size).
    let cap = Infinity;
    if (b.contracts_fp != null && b.contracts_fp !== '') {
      if (r.contracts_units == null) throw new ApiError(400, 'invalid_parameters', 'contracts_fp is only valid on RFQs sized in contracts');
      cap = toUnits(b.contracts_fp);
      if (cap == null || cap < 1 || cap > r.contracts_units) throw new ApiError(400, 'invalid_parameters', `contracts_fp must be between 0.01 and the RFQ size (${ufp(r.contracts_units)})`);
      if (cap % UNITS && !m.fractional_trading_enabled) throw new ApiError(400, 'fractional_not_enabled', 'fractional contracts are not enabled on this market', 'quote a whole number of contracts');
    }
    const yesUnits = yb ? Math.min(sizeFor(r, m, 100 - yb), cap) : 0; // accepting the YES bid: requester buys NO at 100−yes_bid
    const noUnits = nb ? Math.min(sizeFor(r, m, 100 - nb), cap) : 0;
    if (!yesUnits && !noUnits) throw new ApiError(400, 'invalid_parameters', 'the target cost buys less than 0.01 contracts at these prices');
    const now = Date.now();
    const id = newId('q_');
    const replaced = db.prepare("SELECT id FROM rfq_quotes WHERE rfq_id=? AND maker_id=? AND status='open'").all(r.id, makerId);
    tx(db, () => {
      for (const o of replaced) touchQuote(o.id, 'cancelled', 'replaced'); // a new quote replaces the maker's previous one
      db.prepare('INSERT INTO rfq_quotes(id,rfq_id,maker_id,yes_bid_cents,no_bid_cents,yes_units,no_units,status,created_ts,updated_ts,expires_ts,rest_remainder) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, r.id, makerId, yb, nb, yesUnits, noUnits, 'open', now, now, Math.min(r.expires_ts, now + opt.quoteTtlMs), b.rest_remainder === true ? 1 : 0);
    });
    for (const o of replaced) emitQuote('quote_deleted', o.id);
    emitQuote('quote_created', id);
    if (!system) notify(r.user_id, { type: 'rfq_quote', title: `Quote received: ${nb ? `Yes ${100 - nb}¢` : ''}${nb && yb ? ' · ' : ''}${yb ? `No ${100 - yb}¢` : ''}`, body: m.title, link: '/portfolio?tab=rfqs' });
    return quoteRow(id);
  }

  // Simulated maker (liquidity@parlance.local): quotes combo RFQs from the product of leg probabilities plus a spread.
  function lpPrices(ticker) {
    const legs = legsOf(ticker).map(legVo);
    const fair = legs.reduce((a, l) => a * (l.prob / 100), 1) * 100;
    const s = Math.max(opt.spreadCents, Math.ceil(fair * 0.08));
    const yb = Math.max(0, Math.min(98, Math.floor(fair - s)));
    const nb = Math.max(1, Math.min(98, Math.floor(100 - fair - s)));
    return { yes_bid: (yb / 100).toFixed(2), no_bid: (nb / 100).toFixed(2), fair };
  }
  function lpQuoteSweep() {
    const lp = lpId();
    if (!lp) return;
    const rows = db.prepare(`SELECT r.* FROM rfqs r JOIN markets m ON m.ticker=r.market_ticker WHERE r.status='open' AND r.expires_ts>? AND m.mve_collection_ticker IS NOT NULL AND m.status='active' AND r.created_ts<=?
      AND NOT EXISTS (SELECT 1 FROM rfq_quotes q WHERE q.rfq_id=r.id AND q.maker_id=? AND q.status IN ('open','accepted','confirmed'))`).all(Date.now(), Date.now() - opt.makerDelayMs, lp);
    for (const r of rows) {
      try { createQuote(lp, { rfq_id: r.id, ...lpPrices(r.market_ticker) }, { system: true }); } catch (e) { if (!(e instanceof ApiError)) throw e; }
    }
  }

  function acceptQuote(uid, rfqId, qid, side) {
    const q = quoteRow(qid);
    if (!q || (rfqId && q.rfq_id !== rfqId)) throw E.notFound();
    const r = rfqRow(q.rfq_id);
    if (r.user_id !== uid) throw E.notFound();
    if (!['yes', 'no'].includes(side)) throw E.badRequest('accepted_side must be yes or no');
    const now = Date.now();
    if (r.status !== 'open' || r.expires_ts <= now) throw new ApiError(409, 'rfq_closed', 'this RFQ is no longer open', `status ${r.status}`);
    if (q.status !== 'open' || q.expires_ts <= now) throw new ApiError(409, 'quote_expired', 'this quote is no longer available', `status ${q.status}`);
    const bid = side === 'yes' ? q.yes_bid_cents : q.no_bid_cents;
    const units = side === 'yes' ? q.yes_units : q.no_units;
    if (!bid || !units) throw E.badRequest(`the maker declined the ${side} side of this quote`);
    const price = 100 - bid;
    const cost = takerPrincipal(units, price) + takerFeeCents(units, price);
    if (engine.balance(uid) < cost) throw E.conflict('insufficient_balance', 'insufficient balance', `this trade costs $${(cost / 100).toFixed(2)} including fees`);
    if (checkTrading) checkTrading(uid, takerPrincipal(units, price));
    tx(db, () => {
      db.prepare("UPDATE rfq_quotes SET status='accepted', accepted_side=?, accepted_ts=?, confirm_deadline_ts=?, updated_ts=? WHERE id=?").run(side, now, now + opt.confirmWindowMs, now, qid);
      touchRfq(r.id, 'accepted');
    });
    emitQuote('quote_accepted', qid);
    if (isSystem(q.maker_id)) setTimeout(pumpSafe, opt.autoConfirmMs + 5);
    else notify(q.maker_id, { type: 'rfq_accepted', title: `Your quote was accepted — confirm within ${Math.round(opt.confirmWindowMs / 1000)}s`, body: marketRow(r.market_ticker).title, link: '/portfolio?tab=quotes' });
    return quoteRow(qid);
  }

  // Maker confirms → execution through the real engine: the maker's post-only order rests at its bid, then the
  // requester's IOC order crosses exactly that order at the quoted price (fills, fees, ledger, positions,
  // notifications as usual). Any unfilled maker remainder is canceled.
  function execute(qid) {
    const q = quoteRow(qid);
    const r = rfqRow(q.rfq_id);
    const side = q.accepted_side;
    const makerSide = side; const makerPrice = side === 'yes' ? q.yes_bid_cents : q.no_bid_cents;
    const reqSide = side === 'yes' ? 'no' : 'yes'; const reqPrice = 100 - makerPrice;
    const units = side === 'yes' ? q.yes_units : q.no_units;
    db.prepare("UPDATE rfq_quotes SET status='confirmed', confirmed_ts=?, updated_ts=? WHERE id=?").run(Date.now(), Date.now(), qid);
    let makerOrder;
    try {
      makerOrder = engine.placeOrder(q.maker_id, { ticker: r.market_ticker, side: makerSide, price: makerPrice, count: units, post_only: true, source: 'rfq', order_type: 'rfq' });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'insufficient_balance' && !isSystem(q.maker_id)) {
        db.prepare("UPDATE rfq_quotes SET status='accepted', confirmed_ts=NULL, updated_ts=? WHERE id=?").run(Date.now(), qid); // maker may top up and retry within the window
        throw new ApiError(409, 'insufficient_balance', 'insufficient balance to execute this quote', e.details);
      }
      touchQuote(qid, 'cancelled', e.code === 'post_only_cross' ? 'would_cross' : 'maker_failed'); touchRfq(r.id, 'open');
      emitQuote('quote_deleted', qid); emitRfq('rfq_created', r.id);
      throw e instanceof ApiError ? e : new ApiError(500, 'execution_failed', 'execution failed');
    }
    let takerOrder;
    try {
      takerOrder = engine.placeOrder(r.user_id, { ticker: r.market_ticker, side: reqSide, price: reqPrice, count: units, time_in_force: 'ioc', exact_reserve: true, source: 'rfq', order_type: 'rfq', match_order_id: makerOrder.id });
    } catch (e) {
      try { engine.cancelOrder(q.maker_id, makerOrder.id); } catch { /* already gone */ }
      touchQuote(qid, 'cancelled', 'requester_insufficient_balance'); touchRfq(r.id, 'open');
      emitQuote('quote_deleted', qid); emitRfq('rfq_created', r.id);
      notify(r.user_id, { type: 'rfq_failed', title: 'RFQ trade failed: insufficient balance', body: marketRow(r.market_ticker).title, link: '/portfolio?tab=rfqs' });
      throw new ApiError(409, 'requester_insufficient_balance', 'the requester no longer has enough balance; the quote was cancelled', e.details || e.message);
    }
    const mo = db.prepare('SELECT * FROM orders WHERE id=?').get(makerOrder.id);
    // The quote's rest_remainder keeps an unfilled maker remainder on the book; otherwise it is canceled.
    if (mo.status === 'resting' && !q.rest_remainder) { try { engine.cancelOrder(q.maker_id, mo.id); } catch { /* ignore */ } }
    // The RFQ's rest_remainder (G3): when a partial quote filled less than the RFQ size, the requester's unfilled
    // remainder rests as a GTC limit order at the executed price (a normal order: limits, reservation, fills apply).
    let remainder = null; let remainderError = null;
    const wanted = r.contracts_units;
    if (r.rest_remainder && wanted != null && takerOrder.filled_count < wanted) {
      try {
        if (checkTrading) checkTrading(r.user_id, Math.ceil(((wanted - takerOrder.filled_count) * reqPrice) / UNITS));
        remainder = engine.placeOrder(r.user_id, { ticker: r.market_ticker, side: reqSide, price: reqPrice, count: wanted - takerOrder.filled_count, time_in_force: 'gtc', source: 'rfq_remainder', order_type: 'limit', allow_fractional: true });
        db.prepare('UPDATE rfqs SET remainder_order_id=? WHERE id=?').run(remainder.id, r.id);
      } catch (e) { remainderError = e; }
    }
    const now = Date.now();
    tx(db, () => {
      db.prepare("UPDATE rfq_quotes SET status='executed', executed_ts=?, executed_units=?, maker_order_id=?, taker_order_id=?, updated_ts=? WHERE id=?").run(now, takerOrder.filled_count, makerOrder.id, takerOrder.id, now, qid);
      touchRfq(r.id, 'executed');
    });
    closeOpenQuotes(r.id, 'rfq_executed');
    emitQuote('quote_executed', qid);
    emitRfq('rfq_deleted', r.id);
    const title = marketRow(r.market_ticker).title;
    notify(r.user_id, { type: 'rfq_executed', title: `RFQ executed: bought ${ustr(takerOrder.filled_count)} ${reqSide.toUpperCase()} @ ${reqPrice}¢${remainder ? ` · ${ustr(remainder.remaining_count ?? (wanted - takerOrder.filled_count))} resting` : ''}`, body: remainderError ? `${title} · the remainder could not rest: ${remainderError.message}` : title, link: eventHref(r.market_ticker) });
    if (!isSystem(q.maker_id)) notify(q.maker_id, { type: 'rfq_executed', title: `Quote executed: bought ${ustr(takerOrder.filled_count)} ${makerSide.toUpperCase()} @ ${makerPrice}¢`, body: title, link: '/portfolio?tab=quotes' });
    return quoteRow(qid);
  }

  function confirmQuote(uid, qid) {
    const q = quoteRow(qid);
    if (!q || q.maker_id !== uid) throw E.notFound();
    if (q.status !== 'accepted') throw new ApiError(409, 'quote_not_accepted', 'only an accepted quote can be confirmed', `status ${q.status}`);
    if (q.confirm_deadline_ts <= Date.now()) { pump(); throw new ApiError(409, 'quote_expired', 'the confirmation window has passed'); }
    // G4 (PLAN §7): the maker's daily trading limit applies to the order confirming a quote creates (maker bid × size).
    if (checkTrading) { const yes = q.accepted_side === 'yes'; checkTrading(uid, Math.ceil(((yes ? q.yes_units : q.no_units) * (yes ? q.yes_bid_cents : q.no_bid_cents)) / UNITS)); }
    return execute(qid);
  }

  // Expiries and the simulated maker; idempotent, driven by persisted timestamps.
  function pump() {
    const now = Date.now();
    sweepResolutions();
    for (const q of db.prepare("SELECT id FROM rfq_quotes WHERE status='open' AND expires_ts<=?").all(now)) { touchQuote(q.id, 'expired', 'quote_ttl'); emitQuote('quote_expired', q.id); }
    for (const q of db.prepare("SELECT q.id, q.rfq_id FROM rfq_quotes q WHERE q.status='accepted' AND q.confirm_deadline_ts<=?").all(now)) {
      touchQuote(q.id, 'expired', 'not_confirmed');
      const r = rfqRow(q.rfq_id);
      if (r.status === 'accepted') touchRfq(r.id, r.expires_ts > now ? 'open' : 'expired', r.expires_ts > now ? null : 'rfq_ttl');
      emitQuote('quote_expired', q.id);
      emitRfq(r.expires_ts > now ? 'rfq_created' : 'rfq_deleted', r.id);
    }
    for (const r of db.prepare("SELECT id FROM rfqs WHERE status='open' AND expires_ts<=?").all(now)) { touchRfq(r.id, 'expired', 'rfq_ttl'); closeOpenQuotes(r.id, 'rfq_expired'); emitRfq('rfq_deleted', r.id); }
    for (const r of db.prepare("SELECT r.id FROM rfqs r JOIN markets m ON m.ticker=r.market_ticker WHERE r.status IN ('open','accepted') AND m.status<>'active'").all()) { touchRfq(r.id, 'cancelled', 'market_closed'); closeOpenQuotes(r.id, 'market_closed'); emitRfq('rfq_deleted', r.id); }
    // Simulated maker auto-confirms its accepted quotes.
    const lp = lpId();
    for (const q of db.prepare("SELECT id FROM rfq_quotes WHERE status='accepted' AND maker_id=? AND accepted_ts<=?").all(lp || '', now - opt.autoConfirmMs)) {
      try { execute(q.id); } catch (e) { if (!(e instanceof ApiError)) console.error('rfq auto-confirm', e); }
    }
    lpQuoteSweep();
  }
  function pumpSafe() { try { if (db.isOpen !== false) pump(); } catch (e) { if (!/database is not open/i.test(String(e && e.message))) console.error('rfq pump', e); } }
  engine.on('tick', pumpSafe);

  // ---------- REST (paths mirror api-reference_communications_*.md under /v1/communications) ----------
  v1.get('/communications/id', requireUser, (req, res) => res.json({ communications_id: commsId(req.auth.user.id) }));
  v1.post('/communications/rfqs', requireUser, (req, res) => {
    const r = createRfq(req.auth.user.id, req.body || {});
    res.status(201).json({ id: r.id, rfq: rfqVo(r, req.auth.user.id) });
  });
  v1.get('/communications/rfqs', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const scope = String(req.query.scope || 'mine');
    if (!['mine', 'others'].includes(scope)) throw E.badRequest('scope must be mine or others');
    if (scope === 'others') {
      if (!rfqEnabled(uid)) return res.json({ rfqs: [], rfq_enabled: false });
      const rows = db.prepare("SELECT * FROM rfqs WHERE user_id<>? AND status IN ('open','accepted') AND expires_ts>? ORDER BY created_ts DESC LIMIT 100").all(uid, Date.now());
      return res.json({ rfq_enabled: true, rfqs: rows.map((r) => ({ ...rfqVo(r, uid), my_quote: (() => { const q = db.prepare("SELECT * FROM rfq_quotes WHERE rfq_id=? AND maker_id=? ORDER BY created_ts DESC LIMIT 1").get(r.id, uid); return q ? quoteVo(q, uid) : null; })() })) });
    }
    const rows = db.prepare('SELECT * FROM rfqs WHERE user_id=? ORDER BY created_ts DESC LIMIT 100').all(uid);
    res.json({ rfq_enabled: rfqEnabled(uid), rfqs: rows.map((r) => ({ ...rfqVo(r, uid), quotes: db.prepare('SELECT * FROM rfq_quotes WHERE rfq_id=? ORDER BY created_ts DESC').all(r.id).map((q) => quoteVo(q, uid)) })) });
  });
  v1.get('/communications/rfqs/:id', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const r = rfqRow(req.params.id);
    if (!r || (r.user_id !== uid && !rfqEnabled(uid))) throw E.notFound();
    const quotes = db.prepare(`SELECT * FROM rfq_quotes WHERE rfq_id=? ${r.user_id === uid ? '' : 'AND maker_id=?'} ORDER BY created_ts DESC`).all(...(r.user_id === uid ? [r.id] : [r.id, uid]));
    res.json({ rfq: { ...rfqVo(r, uid), quotes: quotes.map((q) => quoteVo(q, uid)) } });
  });
  v1.delete('/communications/rfqs/:id', requireUser, (req, res) => {
    const r = rfqRow(req.params.id);
    if (!r || r.user_id !== req.auth.user.id) throw E.notFound();
    if (!['open', 'accepted'].includes(r.status)) throw new ApiError(409, 'rfq_closed', 'this RFQ is already closed', `status ${r.status}`);
    touchRfq(r.id, 'cancelled', 'cancelled_by_requester');
    closeOpenQuotes(r.id, 'rfq_cancelled');
    emitRfq('rfq_deleted', r.id);
    res.json({ rfq: rfqVo(rfqRow(r.id), req.auth.user.id) });
  });
  const quoteHandler = (req, res) => {
    const q = createQuote(req.auth.user.id, { ...(req.body || {}), ...(req.params.id ? { rfq_id: req.params.id } : {}) });
    res.status(201).json({ id: q.id, quote: quoteVo(q, req.auth.user.id) });
  };
  v1.post('/communications/quotes', requireUser, quoteHandler);
  v1.post('/communications/rfqs/:id/quotes', requireUser, quoteHandler);
  v1.get('/communications/quotes', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const rows = db.prepare('SELECT q.* FROM rfq_quotes q JOIN rfqs r ON r.id=q.rfq_id WHERE q.maker_id=? OR r.user_id=? ORDER BY q.created_ts DESC LIMIT 200').all(uid, uid);
    res.json({ quotes: rows.map((q) => quoteVo(q, uid)) });
  });
  v1.get('/communications/quotes/:qid', requireUser, (req, res) => {
    const q = quoteRow(req.params.qid);
    if (!q || (q.maker_id !== req.auth.user.id && rfqRow(q.rfq_id).user_id !== req.auth.user.id)) throw E.notFound();
    res.json({ quote: quoteVo(q, req.auth.user.id) });
  });
  v1.delete('/communications/quotes/:qid', requireUser, (req, res) => {
    const q = quoteRow(req.params.qid);
    if (!q || q.maker_id !== req.auth.user.id) throw E.notFound();
    if (q.status !== 'open') throw new ApiError(409, 'quote_not_open', q.status === 'accepted' ? 'an accepted quote cannot be deleted; confirm it or let it lapse' : 'this quote is no longer open', `status ${q.status}`);
    touchQuote(q.id, 'cancelled', 'deleted_by_maker');
    emitQuote('quote_deleted', q.id);
    res.json({ quote: quoteVo(quoteRow(q.id), req.auth.user.id) });
  });
  const acceptHandler = (req, res) => res.json({ quote: quoteVo(acceptQuote(req.auth.user.id, req.params.id || null, req.params.qid, req.body && req.body.accepted_side), req.auth.user.id) });
  v1.put('/communications/rfqs/:id/quotes/:qid/accept', requireUser, acceptHandler);
  v1.put('/communications/quotes/:qid/accept', requireUser, acceptHandler);
  v1.put('/communications/quotes/:qid/confirm', requireUser, (req, res) => res.json({ quote: quoteVo(confirmQuote(req.auth.user.id, req.params.qid), req.auth.user.id) }));
  v1.put('/communications/rfqs/:id/quotes/:qid/confirm', requireUser, (req, res) => res.json({ quote: quoteVo(confirmQuote(req.auth.user.id, req.params.qid), req.auth.user.id) }));

  pumpSafe();
  return { pump, createCombo, normalizeLegs, unitsForCost };
}

module.exports = { mountCombos, COMBO_SERIES, unitsForCost };
