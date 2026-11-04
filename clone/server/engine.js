'use strict';
// Matching engine for binary contracts (spec §4.3, §4.4, §5).
// One book per market: a YES bid at p is equivalent to a NO ask at 100-p (cents).
// Every order is a *buy* of YES or NO; holding both sides nets to $1 per pair.
const CS = require('./content/currency-strings'); // keyed user-facing wording (CLONE_SPEC.md §30)
const C = require('./currency'); // display currency formatting (CLONE_SPEC.md §30)
const { EventEmitter } = require('node:events');
const { tx } = require('./db');
const { nowIso, newId, E, ApiError, ustr } = require('./util');
const journal = require('./journal'); // double-entry journal: every balance change below is posted there too (CLONE_SPEC.md §26.6)
// Phase 5A (CLONE_SPEC.md §28): prices are integer centi-cents ("cc", $0.0001) on the market's price grid; the taker fee
// is computed exactly in $0.000001 units and charged through a per-order accumulator (G1); scalar markets settle at a
// fraction of $1. Callers may still pass `price` in whole cents (every grid contains every whole cent).
const P = require('./pricing');

// Taker fee coefficient (design choice for unknown U3: fee = ceil(0.07 * C * P * (1-P)) dollars), held as an integer number
// of 1/10,000ths so the fee arithmetic stays exact. Editable at runtime from Admin › Settings (gap G7, server/admin.js);
// the value is per process (one exchange per process; set at boot from the persisted setting).
const DEFAULT_TAKER_FEE_COEFFICIENT = 0.07;
let feeK = 700;
function setTakerFeeCoefficient(c) {
  const k = Math.round(Number(c) * 10000);
  if (!Number.isInteger(k) || k < 0 || k > 2500) throw new RangeError('taker fee coefficient must be between 0 and 0.25');
  feeK = k;
  return feeK / 10000;
}
const takerFeeCoefficient = () => feeK / 10000;
const UNITS = 100;      // quantities are integer hundredths of a contract (spec §16.1)
const MAX_COUNT = 100000;
const MAX_UNITS = MAX_COUNT * UNITS;

// Exact taker fee of one fill in $0.000001 units (server/pricing.js feeMicro) at `pcc` centi-cents.
const takerFeeMicro = (units, pcc, multiplier = 1) => P.feeMicro(units, pcc, feeK, P.multK(multiplier));
// Taker fee of a single fill in whole cents, rounded up: ceil(k·q·p·(100−p) / 10^8) for a whole-cent price p. For whole
// contracts and k = 700 this is exactly ceil(0.07·C·P·(1−P)) dollars, as before. `takerFeeCentsCc` takes cc.
const takerFeeCentsCc = (units, pcc, multiplier = 1) => Math.ceil(takerFeeMicro(units, pcc, multiplier) / P.MICRO_PER_CENT);
const takerFeeCents = (units, price, multiplier = 1) => takerFeeCentsCc(units, price * P.CC_PER_CENT, multiplier);
// Upper bound on the per-contract fee (whole cents) for any execution price <= limit (P(1-P) peaks at 50¢).
const perContractFeeCapCc = (limitCc, multiplier = 1) => P.feeCapPerContract(limitCc, feeK, P.multK(multiplier));
const perContractFeeCap = (limit, multiplier = 1) => perContractFeeCapCc(limit * P.CC_PER_CENT, multiplier);
// Cash split for a fill of q units at YES-side price p: the pair costs exactly q cents; the taker side pays
// ceil(p·q/100) and the maker side the remainder (spec §16.2). `takerPrincipalCc` takes cc.
const takerPrincipalCc = P.takerPrincipal;
const takerPrincipal = (units, price) => P.takerPrincipal(units, price * P.CC_PER_CENT);
// Fees of a sequence of fills of ONE order through the G1 accumulator (positions' sell estimate, RFQ sizing).
function feeSequence(multiplier = 1, state = { micro: 0, cents: 0 }) {
  let st = state;
  return (units, pcc) => { const c = P.chargeFill(st, takerFeeMicro(units, pcc, multiplier)); st = c.next; return c.cents; };
}
const toCents = (cc) => (cc == null ? null : Math.round(cc / P.CC_PER_CENT)); // legacy whole-cent views of cc prices

// Scalar settlement value in cc: clamp((value − floor) / (cap − floor), 0, 1) to the nearest $0.0001.
function scalarSettlementCc(m, value) {
  const lo = Number(m.floor_strike); const hi = Number(m.cap_strike);
  if (!(hi > lo)) throw E.conflict('invalid_market', 'this scalar market has no valid floor and cap');
  const f = Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
  return Math.round(f * P.CC);
}
// Settlement payout in cents for a holder of `yes` / `no` units when YES settles at s cc: floor(yes·s/10^4) +
// floor(no·(10^4−s)/10^4). For a binary result (s = 0 or 10^4) this is exactly the winning units, as before.
const settlementPayout = (yes, no, s) => Math.floor((yes * s) / P.CC) + Math.floor((no * (P.CC - s)) / P.CC);

class Engine extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.tradingActive = true;
    const row = db.prepare("SELECT value FROM meta WHERE key='order_seq'").get();
    this.seq = row ? Number(row.value) : 0;
    this.positionHooks = []; // (userId, ticker) after a fill changed a position, inside the fill's transaction
    this.settleHooks = [];   // (ticker, userIds) after a market settled or a settlement was corrected, inside its transaction
  }

  nextSeq() {
    this.seq += 1;
    this.db.prepare("INSERT INTO meta(key,value) VALUES('order_seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.seq));
    return this.seq;
  }

  market(ticker) {
    const m = this.db.prepare('SELECT m.*, s.fee_multiplier FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.ticker=?').get(ticker);
    if (!m) throw E.notFound();
    return m;
  }

  // Aggregated book: { yes: Map(price cc->units), no: Map(price cc->units) }
  book(ticker) {
    const rows = this.db.prepare("SELECT side, price_cc p, SUM(remaining_count) c FROM orders WHERE market_ticker=? AND status='resting' GROUP BY side, price_cc").all(ticker);
    const b = { yes: new Map(), no: new Map() };
    for (const r of rows) b[r.side].set(r.p, r.c);
    return b;
  }

  // Best prices, last trade and volumes. `*_cc` fields are exact (centi-cents); the unsuffixed fields are the legacy
  // whole-cent view (rounded) used by integer-cent callers (simulated liquidity, alerts).
  quote(ticker) {
    const best = (side) => this.db.prepare("SELECT MAX(price_cc) p FROM orders WHERE market_ticker=? AND status='resting' AND side=?").get(ticker, side).p;
    const sizeAt = (side, p) => (p == null ? 0 : this.db.prepare("SELECT COALESCE(SUM(remaining_count),0) c FROM orders WHERE market_ticker=? AND status='resting' AND side=? AND price_cc=?").get(ticker, side, p).c);
    const yb = best('yes');
    const nb = best('no');
    const last = this.db.prepare('SELECT yes_price_cc p FROM trades WHERE market_ticker=? ORDER BY created_ts DESC, rowid DESC LIMIT 1').get(ticker);
    const dayAgo = Date.now() - 86400000;
    const priceAt = (ms) => this.db.prepare('SELECT yes_price_cc p FROM trades WHERE market_ticker=? AND created_ts<=? ORDER BY created_ts DESC LIMIT 1').get(ticker, ms)?.p ?? null;
    const prev = priceAt(dayAgo);
    const hourAgo = priceAt(Date.now() - 3600000);
    const weekAgo = priceAt(Date.now() - 7 * 86400000);
    const vol = this.db.prepare('SELECT COALESCE(SUM(count),0) v FROM trades WHERE market_ticker=?').get(ticker).v;
    const dvol = this.db.prepare('SELECT COALESCE(SUM(count*yes_price_cc),0) v FROM trades WHERE market_ticker=?').get(ticker).v;
    const vol24 = this.db.prepare('SELECT COALESCE(SUM(count),0) v FROM trades WHERE market_ticker=? AND created_ts>?').get(ticker, dayAgo).v;
    const oi = this.db.prepare('SELECT COALESCE(SUM(yes_count),0) v FROM positions WHERE market_ticker=?').get(ticker).v;
    const lastP = last ? last.p : null;
    const cc = {
      yes_bid_cc: yb ?? null,
      yes_ask_cc: nb != null ? P.CC - nb : null,
      no_bid_cc: nb ?? null,
      no_ask_cc: yb != null ? P.CC - yb : null,
      last_price_cc: lastP,
      previous_price_cc: prev ?? lastP,
      previous_hour_price_cc: hourAgo ?? lastP,
      previous_week_price_cc: weekAgo ?? prev ?? lastP,
    };
    return {
      ...cc,
      yes_bid: toCents(cc.yes_bid_cc), yes_ask: toCents(cc.yes_ask_cc), no_bid: toCents(cc.no_bid_cc), no_ask: toCents(cc.no_ask_cc),
      last_price: toCents(cc.last_price_cc), previous_price: toCents(cc.previous_price_cc), previous_hour_price: toCents(cc.previous_hour_price_cc), previous_week_price: toCents(cc.previous_week_price_cc),
      yes_bid_size: sizeAt('yes', yb),
      yes_ask_size: sizeAt('no', nb),
      volume: vol, // units
      dollar_volume_cents: Math.round(dvol / (UNITS * P.CC_PER_CENT)),
      volume_24h: vol24,
      open_interest: oi,
    };
  }

  // `contra` (optional): the journal account the money comes from / goes to; by default derived from the kind
  // (server/journal.js contraFor). Payment rails pass their provider clearing / payout accounts.
  credit(userId, cents, kind, ref, memo = '', { contra } = {}) {
    if (cents === 0) return;
    tx(this.db, () => {
      const lid = newId('l_');
      this.db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id=?').run(cents, userId);
      this.db.prepare('INSERT INTO ledger(id,user_id,kind,amount_cents,ref,memo,created_at) VALUES(?,?,?,?,?,?,?)').run(lid, userId, kind, cents, ref ?? null, memo, nowIso());
      journal.onCredit(this.db, { userId, cents, kind, ref: ref ?? null, memo, ledgerId: lid, contra });
    });
  }

  balance(userId) {
    const u = this.db.prepare('SELECT balance_cents FROM users WHERE id=?').get(userId);
    return u ? u.balance_cents : 0;
  }

  // ---- order placement -------------------------------------------------
  // `count` is in units (hundredths of a contract). The limit is `price_cc` (centi-cents, on the market's grid) or
  // `price` (whole cents). Options: post_only (reject instead of crossing), exact_reserve (IOC only: reserve exactly the
  // planned cost instead of the limit-price bound), match_order_id, max_cost_cents (shrink the order until its
  // reservation fits), allow_fractional (sell a held fractional position), flip_units (a flip sell's opening part, A8).
  placeOrder(userId, { ticker, side, price, price_cc = null, count, time_in_force = 'gtc', client_order_id, post_only = false, exact_reserve = false, max_cost_cents = null, allow_fractional = false, source = 'user', action = 'buy', order_type = null, match_order_id = null, expiration_ts = null, reuse_order_id = null, flip_units = 0 }) {
    if (!['yes', 'no'].includes(side)) throw E.badRequest('side must be yes or no');
    if (!['gtc', 'ioc'].includes(time_in_force)) throw E.badRequest('time_in_force must be gtc or ioc');
    const pcc = price_cc != null ? price_cc : Number.isInteger(price) ? price * P.CC_PER_CENT : NaN;
    if (!Number.isInteger(pcc) || pcc < 1 || pcc >= P.CC) throw E.badRequest(CS.t('error.price_range_cc', { min: C.priceCc(1), max: C.priceCc(9999), minCent: C.priceCents(1), maxCent: C.priceCents(99) }));
    if (!Number.isInteger(count) || count < 1 || count > MAX_UNITS) throw E.badRequest(`count must be between 0.01 and ${MAX_COUNT} contracts`);
    let exact = exact_reserve && time_in_force === 'ioc';
    if (expiration_ts != null) {
      if (time_in_force !== 'gtc') throw E.badRequest('an expiration time cannot be combined with immediate-or-cancel');
      if (!Number.isFinite(expiration_ts) || expiration_ts <= Date.now()) throw E.badRequest('expiration_time must be in the future');
    }

    const touched = new Set([userId]);
    const fills = [];
    const makerOrders = new Set();
    const before = this.book(ticker);
    const order = tx(this.db, () => {
      const m = this.market(ticker);
      if (!this.tradingActive) throw E.conflict('trading_paused', 'trading is paused');
      if (m.status !== 'active') throw E.conflict('market_inactive', 'market is not open for trading', `market status is ${m.status}`);
      // P5.1: the limit must sit on the market's price grid (spec §28.1).
      if (!P.onGrid(m.price_level_structure, pcc)) throw new ApiError(400, 'invalid_price', 'price is not on this market\'s tick grid', `${m.price_level_structure} ticks: ${P.priceRanges(m.price_level_structure).map((r) => `${r.start}–${r.end} by ${r.step}`).join(', ')}`);
      if (count % UNITS !== 0 && !m.fractional_trading_enabled && !allow_fractional) throw new ApiError(400, 'fractional_not_enabled', 'fractional contracts are not enabled on this market', 'order a whole number of contracts');
      const opp = side === 'yes' ? 'no' : 'yes';
      // match_order_id: RFQ execution crosses only the confirming maker's order (spec §17.5).
      const makers = this.db.prepare(`SELECT * FROM orders WHERE market_ticker=? AND status='resting' AND side=? AND price_cc>=? AND user_id<>? ${match_order_id ? 'AND id=?' : ''} ORDER BY price_cc DESC, seq ASC`).all(ticker, opp, P.CC - pcc, userId, ...(match_order_id ? [match_order_id] : []));
      const feeCap = perContractFeeCapCc(pcc, m.fee_multiplier);
      const R = (n) => Math.ceil((n * (pcc + feeCap * P.CC_PER_CENT)) / P.CC); // reservation bound for n units at the limit
      // G1: the order's fee accumulator (an amend re-enters with the accumulator it already has).
      const prior = reuse_order_id ? this.db.prepare('SELECT fee_micro, fees_cents FROM orders WHERE id=?').get(reuse_order_id) : null;
      const acc0 = { micro: prior ? prior.fee_micro : 0, cents: prior ? prior.fees_cents : 0 };
      // Plan the taker fills first so the reservation covers per-fill cent rounding exactly.
      const plan = (cnt) => {
        const out = []; let rem = cnt; let r = cnt; let acc = acc0;
        for (const mk of makers) {
          if (rem === 0) break;
          const q = Math.min(rem, mk.remaining_count);
          const tp = P.CC - mk.price_cc; // price improvement goes to the taker
          const principal = takerPrincipalCc(q, tp);
          const ch = P.chargeFill(acc, takerFeeMicro(q, tp, m.fee_multiplier));
          acc = ch.next;
          out.push({ mk, q, tp, principal, fee: ch.cents, charge: ch, cost: principal + ch.cents, delta: exact ? principal + ch.cents : R(r) - R(r - q) });
          rem -= q; r -= q;
        }
        // suffix[i] = buffer still needed before fill i so no later fill's refund goes negative.
        const suffix = new Array(out.length + 1).fill(0);
        for (let i = out.length - 1; i >= 0; i--) suffix[i] = Math.max(0, out[i].cost - out[i].delta + suffix[i + 1]);
        const base = exact ? out.reduce((a, f) => a + f.cost, 0) : R(cnt);
        return { fills: out, rem, suffix, required: base + suffix[0] };
      };
      let pl;
      if (max_cost_cents != null) {
        // Dollars / target-cost orders (gap G2): size against the exact planned cost, fill by fill, so the per-maker
        // cent rounding (ceil of each fill's principal and fee) is part of the budget. The order is IOC and reserves
        // exactly that cost; the spend can never exceed the cap however many makers it crosses.
        if (time_in_force !== 'ioc') throw E.badRequest('a cost cap requires an immediate-or-cancel order');
        exact = true;
        const step = m.fractional_trading_enabled || allow_fractional ? 1 : UNITS;
        const fits = (n) => plan(n).required <= max_cost_cents;
        // Planned cost is non-decreasing in size, so binary-search the largest multiple of `step` that fits.
        let lo = 0; let hi = Math.floor(count / step);
        while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid * step)) lo = mid; else hi = mid - 1; }
        if (lo === 0) throw E.badRequest('amount is below the cost of the smallest order size at the current price, fee included');
        count = lo * step;
      }
      pl = plan(count);
      if (max_cost_cents != null && pl.required > max_cost_cents) throw new Error('invariant: cost-capped plan exceeds its cap');
      if (post_only && pl.fills.length) throw E.conflict('post_only_cross', 'post-only order would cross the book');
      const reserve = pl.required;
      if (this.balance(userId) < reserve) throw E.conflict('insufficient_balance', 'insufficient balance', CS.t('error.order_reserve', { amount: C.moneyCents(reserve) }));

      const id = reuse_order_id || newId('o_');
      const ts = nowIso();
      if (reuse_order_id) {
        // Amend that forfeits priority (spec §17.10): same order id, new price/size, back of the queue (new seq).
        this.db.prepare("UPDATE orders SET seq=?, price_cents=?, price_cc=?, initial_count=filled_count+?, remaining_count=?, reserved_cents=?, status='resting', expiration_ts=?, updated_at=? WHERE id=?")
          .run(this.nextSeq(), toCents(pcc), pcc, count, count, reserve, expiration_ts, ts, id);
      } else {
        this.db.prepare('INSERT INTO orders(id,seq,user_id,market_ticker,side,price_cents,price_cc,initial_count,remaining_count,reserved_cents,status,time_in_force,client_order_id,created_at,updated_at,source,action,order_type,expiration_ts,flip_units) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, this.nextSeq(), userId, ticker, side, toCents(pcc), pcc, count, count, reserve, 'resting', time_in_force, client_order_id ?? null, ts, ts, source, action === 'sell' ? 'sell' : 'buy', order_type || (time_in_force === 'ioc' ? 'market' : 'limit'), expiration_ts, flip_units || 0);
      }
      this.db.prepare('UPDATE users SET balance_cents = balance_cents - ? WHERE id=?').run(reserve, userId);
      journal.onReserve(this.db, userId, id, reserve);

      let carry = pl.suffix[0];
      pl.fills.forEach((f, i) => {
        const { mk, q, tp, principal, fee, charge } = f;
        const makerPrice = mk.price_cc;
        const makerCost = q - principal;
        const tradeId = newId('t_');
        const nowMs = Date.now();
        const yesPrice = side === 'yes' ? tp : makerPrice;
        this.db.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,yes_price_cc,count,taker_side,created_ts) VALUES(?,?,?,?,?,?,?)').run(tradeId, ticker, toCents(yesPrice), yesPrice, q, side, nowMs);

        // maker side: release its reservation for q units (all of it when the order completes)
        const mkFeeCap = perContractFeeCapCc(makerPrice, m.fee_multiplier);
        const mkR = (n) => Math.ceil((n * (makerPrice + mkFeeCap * P.CC_PER_CENT)) / P.CC);
        const mkRemaining = mk.remaining_count - q;
        const mkReleased = mkRemaining === 0 ? mk.reserved_cents : Math.min(mk.reserved_cents, mkR(mk.remaining_count) - mkR(mkRemaining));
        this.db.prepare('UPDATE orders SET remaining_count=?, filled_count=filled_count+?, reserved_cents=reserved_cents-?, status=?, updated_at=? WHERE id=?')
          .run(mkRemaining, q, mkReleased, mkRemaining === 0 ? 'executed' : 'resting', nowIso(), mk.id);
        this.credit(mk.user_id, mkReleased - makerCost, 'refund', mk.id, 'unused fee reserve');
        this.ledgerOnly(mk.user_id, -makerCost, 'trade', tradeId, `bought ${ustr(q)} ${opp.toUpperCase()} @ ${P.centsLabel(makerPrice)}`);
        this.applyFill(mk.user_id, mk.id, tradeId, ticker, opp, makerPrice, q, makerCost, false, 0, nowMs, fills, 0);
        touched.add(mk.user_id);
        makerOrders.add(mk.id);

        // taker side
        carry -= f.cost - f.delta;
        const refund = carry - pl.suffix[i + 1];
        carry = pl.suffix[i + 1];
        this.db.prepare('UPDATE orders SET remaining_count=remaining_count-?, filled_count=filled_count+?, reserved_cents=reserved_cents-?, fees_cents=fees_cents+?, fee_micro=fee_micro+?, updated_at=? WHERE id=?')
          .run(q, q, f.cost + refund, fee, charge.micro, nowIso(), id);
        this.credit(userId, refund, 'refund', id, 'price improvement / unused fee reserve');
        this.ledgerOnly(userId, -principal, 'trade', tradeId, `bought ${ustr(q)} ${side.toUpperCase()} @ ${P.centsLabel(tp)}`);
        this.feeEntry(userId, charge, tradeId);
        this.applyFill(userId, id, tradeId, ticker, side, tp, q, principal, true, fee, nowMs, fills, charge.micro);
        this.emit('trade', { market_ticker: ticker, trade_id: tradeId, yes_price: toCents(yesPrice), yes_price_cc: yesPrice, count: q, taker_side: side, ts: nowMs });
      });

      if (pl.rem === 0) {
        this.db.prepare("UPDATE orders SET status='executed' WHERE id=?").run(id);
      } else if (time_in_force === 'ioc') {
        this.releaseOrder(id, 'canceled');
      }
      return this.db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    });

    this.afterBookChange(ticker, before, touched, fills);
    this.emit('user_order', order.user_id, order);
    // Makers must also learn about their (partially) executed orders.
    for (const id of makerOrders) {
      const mo = this.db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      this.emit('user_order', mo.user_id, mo);
    }
    return order;
  }

  // G1: the taker fee of one fill, in whole cents, split in the journal between house:fees (whole cents of exact fee)
  // and house:fees:rounding (the accumulator's rounding cent, which a later fill of the same order can give back).
  feeEntry(userId, charge, tradeId) {
    if (charge.cents === 0 && charge.toRounding === 0) return;
    const lid = newId('l_');
    if (charge.cents !== 0) this.db.prepare('INSERT INTO ledger(id,user_id,kind,amount_cents,ref,memo,created_at) VALUES(?,?,?,?,?,?,?)').run(lid, userId, 'fee', -charge.cents, tradeId, 'taker fee', nowIso());
    journal.post(this.db, { kind: 'fee', ref: tradeId, userId, memo: CS.t('memo.taker_fee', { amount: C.moneyCents(charge.micro / 1e4, { exact: C.config().code === 'USD' ? 6 : 4 }) }), ledgerId: charge.cents !== 0 ? lid : null },
      [[journal.accounts.reserved(userId), -charge.cents], ['house:fees', charge.toFees], ['house:fees:rounding', charge.toRounding]]);
  }

  // ledger entry with no balance movement (cost already held in reservation)
  ledgerOnly(userId, cents, kind, ref, memo) {
    if (cents === 0) return;
    const lid = newId('l_');
    this.db.prepare('INSERT INTO ledger(id,user_id,kind,amount_cents,ref,memo,created_at) VALUES(?,?,?,?,?,?,?)').run(lid, userId, kind, cents, ref, memo, nowIso());
    journal.onLedgerOnly(this.db, { userId, cents, kind, ref, memo, ledgerId: lid });
  }

  // qty in units; price in cc; cost = cents actually paid for this fill (taker: ceil share, maker: remainder).
  applyFill(userId, orderId, tradeId, ticker, side, price, qty, cost, isTaker, fee, ts, fills, feeMicro = 0) {
    const fid = newId('f_');
    this.db.prepare('INSERT INTO fills(id,trade_id,order_id,user_id,market_ticker,side,price_cents,price_cc,count,is_taker,fee_cents,fee_micro,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(fid, tradeId, orderId, userId, ticker, side, toCents(price), price, qty, isTaker ? 1 : 0, fee, feeMicro, ts);
    fills.push({ user_id: userId, fill_id: fid, order_id: orderId, trade_id: tradeId, market_ticker: ticker, side, price_cents: toCents(price), price_cc: price, count: qty, is_taker: isTaker, fee_cents: fee, fee_micro: feeMicro, ts });
    const now = nowIso();
    this.db.prepare('INSERT INTO positions(user_id,market_ticker,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(userId, ticker, now);
    const col = side === 'yes' ? 'yes' : 'no';
    this.db.prepare(`UPDATE positions SET ${col}_count=${col}_count+?, ${col}_cost_cents=${col}_cost_cents+?, fees_paid_cents=fees_paid_cents+?, realized_pnl_cents=realized_pnl_cents-?, updated_at=? WHERE user_id=? AND market_ticker=?`)
      .run(qty, cost, fee, fee, now, userId, ticker);
    // Netting: one YES + one NO always redeems for $1 (q units of pairs redeem for q cents).
    const p = this.db.prepare('SELECT * FROM positions WHERE user_id=? AND market_ticker=?').get(userId, ticker);
    const pairs = Math.min(p.yes_count, p.no_count);
    if (pairs > 0) {
      const yesCost = Math.round((p.yes_cost_cents * pairs) / p.yes_count);
      const noCost = Math.round((p.no_cost_cents * pairs) / p.no_count);
      this.db.prepare('UPDATE positions SET yes_count=yes_count-?, no_count=no_count-?, yes_cost_cents=yes_cost_cents-?, no_cost_cents=no_cost_cents-?, realized_pnl_cents=realized_pnl_cents+? WHERE user_id=? AND market_ticker=?')
        .run(pairs, pairs, yesCost, noCost, pairs - yesCost - noCost, userId, ticker);
      this.credit(userId, pairs, 'netting', ticker, `${ustr(pairs)} YES/NO pairs redeemed`);
    }
    for (const h of this.positionHooks) h(userId, ticker); // collateral return (A9) re-derives inside this transaction
  }

  // Cancel / expire: return remaining reservation to the user.
  releaseOrder(orderId, status = 'canceled', reason = null) {
    const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o || o.status !== 'resting') return o;
    this.db.prepare('UPDATE orders SET status=?, reserved_cents=0, cancel_reason=COALESCE(?,cancel_reason), updated_at=? WHERE id=?').run(status, reason, nowIso(), orderId);
    this.credit(o.user_id, o.reserved_cents, 'refund', orderId, reason === 'expired' ? 'order expired' : 'order canceled');
    return this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  }

  // ---- resting-order management (spec §17.10) ----------------------------
  ownResting(userId, orderId) {
    const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o || o.user_id !== userId) throw E.notFound();
    if (o.status !== 'resting') throw E.conflict('order_not_resting', 'order is not resting', `order status is ${o.status}`);
    const m = this.market(o.market_ticker);
    if (m.status !== 'active') throw E.conflict('market_inactive', 'market is not open for trading', `market status is ${m.status}`);
    return { o, m };
  }
  reserveFor(o, units, m) { return Math.ceil((units * (o.price_cc + perContractFeeCapCc(o.price_cc, m.fee_multiplier) * P.CC_PER_CENT)) / P.CC); }
  // Reduce the remaining size in place: keeps time priority; the freed reservation is refunded exactly.
  decreaseOrder(userId, orderId, newRemaining, { expiration_ts } = {}) {
    const { o, m } = this.ownResting(userId, orderId);
    if (!Number.isInteger(newRemaining) || newRemaining < 0 || newRemaining > o.remaining_count) throw E.badRequest('the new remaining size must be between 0 and the current remaining size');
    if (newRemaining === 0) return this.cancelOrder(userId, orderId, 'decreased_to_zero');
    if (newRemaining % UNITS && !m.fractional_trading_enabled) throw new ApiError(400, 'fractional_not_enabled', 'fractional contracts are not enabled on this market');
    const before = this.book(o.market_ticker);
    const res = tx(this.db, () => {
      const keep = this.reserveFor(o, newRemaining, m);
      const release = Math.max(0, o.reserved_cents - keep);
      this.db.prepare('UPDATE orders SET remaining_count=?, initial_count=filled_count+?, reserved_cents=reserved_cents-?, expiration_ts=?, updated_at=? WHERE id=?')
        .run(newRemaining, newRemaining, release, expiration_ts === undefined ? o.expiration_ts : expiration_ts, nowIso(), orderId);
      this.credit(userId, release, 'refund', orderId, 'order decreased');
      return this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    });
    this.afterBookChange(o.market_ticker, before, new Set([userId]), []);
    this.emit('user_order', userId, res);
    return res;
  }
  // Amend price / total size / expiry. A price change or a size increase forfeits queue position (new seq) and the
  // order is re-entered (it may fill immediately); a pure decrease or expiry change keeps it
  // (api-reference_orders_amend-order-v2.md).
  // `price_cc` (centi-cents, stored side) or legacy `price` (whole cents).
  amendOrder(userId, orderId, { price, price_cc, total, expiration_ts }) {
    const { o, m } = this.ownResting(userId, orderId);
    const newPrice = price_cc != null ? price_cc : price != null ? price * P.CC_PER_CENT : o.price_cc;
    const newRem = (total == null ? o.filled_count + o.remaining_count : total) - o.filled_count;
    const exp = expiration_ts === undefined ? o.expiration_ts : expiration_ts;
    if (!Number.isInteger(newPrice) || !P.onGrid(m.price_level_structure, newPrice)) throw new ApiError(400, 'invalid_price', 'price is not on this market\'s tick grid');
    if (!Number.isInteger(newRem) || newRem < 1) throw E.badRequest('count must exceed the filled count by at least 0.01 contracts');
    if (exp != null && exp <= Date.now()) throw E.badRequest('expiration_time must be in the future');
    if (newPrice === o.price_cc && newRem <= o.remaining_count) return this.decreaseOrder(userId, orderId, newRem, { expiration_ts: exp });
    return tx(this.db, () => {
      this.db.prepare('UPDATE orders SET reserved_cents=0 WHERE id=?').run(orderId);
      this.credit(userId, o.reserved_cents, 'refund', orderId, 'order amended');
      return this.placeOrder(userId, { ticker: o.market_ticker, side: o.side, price_cc: newPrice, count: newRem, time_in_force: 'gtc', reuse_order_id: o.id, expiration_ts: exp, action: o.action, order_type: o.order_type, source: o.source });
    });
  }
  // Contracts ahead of this order at its price level (price-time priority).
  queuePosition(o) {
    if (o.status !== 'resting') return 0;
    return this.db.prepare("SELECT COALESCE(SUM(remaining_count),0) n FROM orders WHERE market_ticker=? AND status='resting' AND side=? AND price_cc=? AND seq<?").get(o.market_ticker, o.side, o.price_cc, o.seq).n;
  }
  expireOrders() {
    for (const r of this.db.prepare("SELECT id FROM orders WHERE status='resting' AND expiration_ts IS NOT NULL AND expiration_ts<=?").all(Date.now())) {
      const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(r.id);
      const before = this.book(o.market_ticker);
      const res = tx(this.db, () => this.releaseOrder(o.id, 'canceled', 'expired'));
      this.afterBookChange(o.market_ticker, before, new Set([o.user_id]), []);
      this.emit('user_order', o.user_id, res);
      this.emit('order_expired', o.user_id, res);
    }
  }

  cancelOrder(userId, orderId, reason = 'canceled_by_user') {
    const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o || o.user_id !== userId) throw E.notFound();
    const m = this.market(o.market_ticker);
    if (m.status !== 'active' && m.status !== 'inactive') throw E.conflict('market_inactive', 'market is not open for trading', `market status is ${m.status}`);
    if (o.status !== 'resting') throw E.conflict('order_not_resting', 'order is not resting', `order status is ${o.status}`);
    const before = this.book(o.market_ticker);
    const res = tx(this.db, () => this.releaseOrder(orderId, 'canceled', reason));
    this.afterBookChange(o.market_ticker, before, new Set([userId]), []);
    this.emit('user_order', userId, res);
    return res;
  }

  cancelAllResting(ticker) {
    const before = this.book(ticker);
    const touched = new Set();
    const canceled = [];
    tx(this.db, () => {
      for (const o of this.db.prepare("SELECT id,user_id FROM orders WHERE market_ticker=? AND status='resting'").all(ticker)) {
        canceled.push(this.releaseOrder(o.id, 'canceled'));
        touched.add(o.user_id);
      }
    });
    this.afterBookChange(ticker, before, touched, []);
    for (const o of canceled) this.emit('user_order', o.user_id, o);
  }

  afterBookChange(ticker, before, touchedUsers, fills) {
    const after = this.book(ticker);
    const deltas = [];
    for (const side of ['yes', 'no']) {
      const prices = new Set([...before[side].keys(), ...after[side].keys()]);
      for (const p of prices) {
        const d = (after[side].get(p) || 0) - (before[side].get(p) || 0);
        if (d !== 0) deltas.push({ side, price: p, delta: d });
      }
    }
    if (deltas.length) this.emit('book_delta', ticker, deltas);
    this.emit('ticker', ticker, this.quote(ticker));
    for (const f of fills) this.emit('fill', f.user_id, f);
    for (const u of touchedUsers) this.emit('user_balance', u, this.balance(u));
  }

  // ---- lifecycle (spec §4.4) -------------------------------------------
  setStatus(ticker, status, eventType) {
    this.db.prepare('UPDATE markets SET status=?, updated_at=? WHERE ticker=?').run(status, nowIso(), ticker);
    this.emit('lifecycle', ticker, eventType, status);
  }

  deactivate(ticker) {
    const m = this.market(ticker);
    if (m.status !== 'active') throw E.conflict('invalid_transition', `cannot deactivate a ${m.status} market`);
    this.setStatus(ticker, 'inactive', 'deactivated');
  }

  activate(ticker) {
    const m = this.market(ticker);
    if (m.status !== 'inactive') throw E.conflict('invalid_transition', `cannot activate a ${m.status} market`);
    this.cancelAllResting(ticker); // spec: reactivation cancels resting orders
    this.setStatus(ticker, 'active', 'activated');
  }

  close(ticker) {
    const m = this.market(ticker);
    if (!['active', 'inactive'].includes(m.status)) throw E.conflict('invalid_transition', `cannot close a ${m.status} market`);
    this.db.prepare('UPDATE markets SET close_time=? WHERE ticker=?').run(nowIso(), ticker);
    this.cancelAllResting(ticker);
    this.setStatus(ticker, 'closed', 'close_date_updated');
  }

  // Binary result 'yes' | 'no', or a scalar market's `expiration_value` (CLONE_SPEC.md §28.4): the YES side then settles
  // at s = clamp((value − floor) / (cap − floor), 0, 1), rounded to the nearest $0.0001, and NO at 1 − s.
  determine(ticker, result, { expiration_value: value = null } = {}) {
    const m = this.market(ticker);
    let settleCc;
    if (m.market_type === 'scalar') {
      if (value == null || !Number.isFinite(Number(value))) throw E.badRequest('a scalar market resolves to a numeric expiration_value');
      settleCc = scalarSettlementCc(m, Number(value));
      result = 'scalar';
    } else {
      if (!['yes', 'no'].includes(result)) throw E.badRequest('result must be yes or no');
      settleCc = result === 'yes' ? P.CC : 0;
    }
    if (['determined', 'finalized'].includes(m.status)) throw E.conflict('invalid_transition', `market already ${m.status}`);
    if (m.status === 'initialized') throw E.conflict('invalid_transition', 'market never opened');
    if (m.status !== 'closed') this.close(ticker);
    this.db.prepare("UPDATE markets SET status='determined', result=?, expiration_value=?, settlement_value_cc=?, determined_at=?, updated_at=? WHERE ticker=?").run(result, m.market_type === 'scalar' ? Number(value) : null, settleCc, nowIso(), nowIso(), ticker);
    this.emit('lifecycle', ticker, 'determined', 'determined');
  }

  finalize(ticker) {
    const m = this.market(ticker);
    if (m.status !== 'determined') return;
    const s = m.settlement_value_cc ?? (m.result === 'yes' ? P.CC : 0);
    const touched = new Set();
    const paid = [];
    tx(this.db, () => {
      let oi = 0; let total = 0;
      for (const p of this.db.prepare('SELECT * FROM positions WHERE market_ticker=? AND (yes_count>0 OR no_count>0)').all(ticker)) {
        const payout = settlementPayout(p.yes_count, p.no_count, s); // q winning units pay q cents; scalar: floor of the fraction
        oi += p.yes_count; total += payout;
        const cost = p.yes_cost_cents + p.no_cost_cents;
        this.db.prepare('INSERT INTO settlements(id,user_id,market_ticker,result,yes_count,no_count,payout_cents,cost_cents,created_at,settlement_value_cc,effective_payout_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(newId('s_'), p.user_id, ticker, m.result, p.yes_count, p.no_count, payout, cost, nowIso(), s, payout);
        this.db.prepare('UPDATE positions SET yes_count=0, no_count=0, yes_cost_cents=0, no_cost_cents=0, realized_pnl_cents=realized_pnl_cents+?, updated_at=? WHERE user_id=? AND market_ticker=?')
          .run(payout - cost, nowIso(), p.user_id, ticker);
        this.credit(p.user_id, payout, 'settlement', ticker, m.result === 'scalar' ? CS.t('memo.settled_scalar', { price: C.priceCc(s) }) : `settled ${m.result.toUpperCase()}`);
        touched.add(p.user_id);
        paid.push({ user_id: p.user_id, market_ticker: ticker, result: m.result, payout_cents: payout });
      }
      // Scalar rounding: each holder is paid floor(q·s), so up to a cent per holder stays in escrow. It goes to the house
      // (house:settlement_rounding) so the market's escrow ends at exactly zero (spec §28.4).
      this.settlementResidual(ticker, oi - total);
      this.db.prepare("UPDATE markets SET status='finalized', settled_at=?, updated_at=? WHERE ticker=?").run(nowIso(), nowIso(), ticker);
      for (const h of this.settleHooks) h(ticker, [...touched]);
    });
    this.emit('lifecycle', ticker, 'settled', 'finalized');
    for (const u of touched) this.emit('user_balance', u, this.balance(u));
    for (const s2 of paid) this.emit('settlement', s2.user_id, s2);
  }
  settlementResidual(ticker, cents) {
    if (cents) journal.post(this.db, { kind: 'settlement_rounding', ref: ticker, memo: 'scalar settlement rounding' }, [[`escrow:${ticker}`, -cents], ['house:settlement_rounding', cents]]);
  }

  // G6 (CLONE_SPEC.md §28.7): reverse or correct a finalized market. Every holder's settlement is re-priced at the new
  // result; the difference (claw-back or re-pay) is a `settlement_correction` ledger entry against the market's escrow,
  // which may leave cash negative (the Phase 4 debt rule: withdrawals stop until a deposit repays it). Settlement rows are
  // never rewritten: they keep what was paid, and `effective_payout_cents` tracks the corrected amount.
  correctSettlement(ticker, { result = null, expiration_value = null, memo = 'settlement corrected' } = {}) {
    const m = this.market(ticker);
    if (m.status !== 'finalized') throw E.conflict('not_settled', 'only a settled market can be corrected', `market status is ${m.status}`);
    let s; let newResult;
    if (m.market_type === 'scalar') {
      if (expiration_value == null || !Number.isFinite(Number(expiration_value))) throw E.badRequest('a scalar market is corrected to a numeric expiration_value');
      s = scalarSettlementCc(m, Number(expiration_value)); newResult = 'scalar';
    } else {
      if (!['yes', 'no'].includes(result)) throw E.badRequest('result must be yes or no');
      s = result === 'yes' ? P.CC : 0; newResult = result;
    }
    const oldS = m.settlement_value_cc ?? (m.result === 'yes' ? P.CC : 0);
    if (s === oldS) throw E.conflict('no_change', 'the market already settled at this result');
    const changes = [];
    tx(this.db, () => {
      let oldTotal = 0; let newTotal = 0;
      for (const r of this.db.prepare('SELECT * FROM settlements WHERE market_ticker=?').all(ticker)) {
        const eff = r.effective_payout_cents ?? r.payout_cents;
        const next = settlementPayout(r.yes_count, r.no_count, s);
        oldTotal += eff; newTotal += next;
        const delta = next - eff;
        this.db.prepare('UPDATE settlements SET effective_payout_cents=?, corrected_at=? WHERE id=?').run(next, nowIso(), r.id);
        if (delta) {
          this.db.prepare('UPDATE positions SET realized_pnl_cents=realized_pnl_cents+?, updated_at=? WHERE user_id=? AND market_ticker=?').run(delta, nowIso(), r.user_id, ticker);
          this.credit(r.user_id, delta, 'settlement_correction', ticker, `${memo}: ${newResult === 'scalar' ? CS.t('memo.correction_scalar', { price: C.priceCc(s) }) : `now ${newResult.toUpperCase()}`}`);
        }
        changes.push({ user_id: r.user_id, before_cents: eff, after_cents: next, delta_cents: delta });
      }
      // Rounding residual follows the new payouts: (oi − newTotal) − (oi − oldTotal).
      this.settlementResidual(ticker, oldTotal - newTotal);
      this.db.prepare('UPDATE markets SET result=?, expiration_value=?, settlement_value_cc=?, updated_at=? WHERE ticker=?').run(newResult, m.market_type === 'scalar' ? Number(expiration_value) : null, s, nowIso(), ticker);
      for (const h of this.settleHooks) h(ticker, changes.map((c) => c.user_id));
    });
    this.emit('lifecycle', ticker, 'settlement_corrected', 'finalized');
    for (const c of changes) this.emit('user_balance', c.user_id, this.balance(c.user_id));
    return { ticker, result: newResult, settlement_value_cc: s, previous_settlement_value_cc: oldS, changes };
  }

  // Time-driven transitions; persisted timestamps make this restart-safe.
  tick() {
    const now = nowIso();
    for (const m of this.db.prepare("SELECT ticker FROM markets WHERE status='initialized' AND open_time<=?").all(now)) this.setStatus(m.ticker, 'active', 'activated');
    for (const m of this.db.prepare("SELECT ticker FROM markets WHERE status IN ('active','inactive') AND close_time<=?").all(now)) {
      this.cancelAllResting(m.ticker);
      this.setStatus(m.ticker, 'closed', 'close_date_updated');
    }
    for (const m of this.db.prepare("SELECT ticker, determined_at, settlement_timer_seconds t FROM markets WHERE status='determined'").all()) {
      if (Date.parse(m.determined_at) + m.t * 1000 <= Date.now()) this.finalize(m.ticker);
    }
    this.expireOrders(); // good-til-time orders (persisted expiration_ts → restart-safe)
    this.emit('tick');
  }
}

module.exports = { Engine, takerFeeCents, takerFeeCentsCc, takerFeeMicro, feeSequence, perContractFeeCap, perContractFeeCapCc, takerPrincipal, takerPrincipalCc, scalarSettlementCc, settlementPayout, setTakerFeeCoefficient, takerFeeCoefficient, DEFAULT_TAKER_FEE_COEFFICIENT, MAX_COUNT, MAX_UNITS, UNITS };
