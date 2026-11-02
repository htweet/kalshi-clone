'use strict';
// Matching engine for binary contracts (spec §4.3, §4.4, §5).
// One book per market: a YES bid at p is equivalent to a NO ask at 100-p (cents).
// Every order is a *buy* of YES or NO; holding both sides nets to $1 per pair.
const { EventEmitter } = require('node:events');
const { tx } = require('./db');
const { nowIso, newId, E, ApiError, ustr } = require('./util');

const FEE_RATE_NUM = 7; // design choice for unknown U3: fee = ceil(0.07 * C * P * (1-P)) dollars
const UNITS = 100;      // quantities are integer hundredths of a contract (spec §16.1)
const MAX_COUNT = 100000;
const MAX_UNITS = MAX_COUNT * UNITS;

// Taker fee in cents for `units` hundredths of a contract at `price` cents: ceil(7·q·p·(100−p) / 1,000,000).
// For whole contracts (q = 100·C) this is exactly ceil(0.07·C·P·(1−P)) dollars, as before.
function takerFeeCents(units, price, multiplier = 1) {
  const raw = FEE_RATE_NUM * units * price * (100 - price) * multiplier; // in 1/1,000,000 cents
  return Math.ceil(raw / 1000000);
}
// Upper bound on per-contract fee for any execution price <= limit (P(1-P) peaks at 50).
function perContractFeeCap(limit, multiplier = 1) {
  const p = Math.min(limit, 50);
  return Math.ceil((FEE_RATE_NUM * p * (100 - p) * multiplier) / 10000);
}
// Cash split for a fill of q units at YES-side price p: the pair costs exactly q cents; the taker side pays
// ceil(p·q/100) and the maker side the remainder (spec §16.2).
const takerPrincipal = (units, price) => Math.ceil((units * price) / UNITS);

class Engine extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.tradingActive = true;
    const row = db.prepare("SELECT value FROM meta WHERE key='order_seq'").get();
    this.seq = row ? Number(row.value) : 0;
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

  // Aggregated book: { yes: Map(price->count), no: Map(price->count) }
  book(ticker) {
    const rows = this.db.prepare("SELECT side, price_cents p, SUM(remaining_count) c FROM orders WHERE market_ticker=? AND status='resting' GROUP BY side, price_cents").all(ticker);
    const b = { yes: new Map(), no: new Map() };
    for (const r of rows) b[r.side].set(r.p, r.c);
    return b;
  }

  quote(ticker) {
    const best = (side) => this.db.prepare("SELECT MAX(price_cents) p FROM orders WHERE market_ticker=? AND status='resting' AND side=?").get(ticker, side).p;
    const sizeAt = (side, p) => (p == null ? 0 : this.db.prepare("SELECT COALESCE(SUM(remaining_count),0) c FROM orders WHERE market_ticker=? AND status='resting' AND side=? AND price_cents=?").get(ticker, side, p).c);
    const yb = best('yes');
    const nb = best('no');
    const last = this.db.prepare('SELECT yes_price_cents p FROM trades WHERE market_ticker=? ORDER BY created_ts DESC, rowid DESC LIMIT 1').get(ticker);
    const dayAgo = Date.now() - 86400000;
    const prev = this.db.prepare('SELECT yes_price_cents p FROM trades WHERE market_ticker=? AND created_ts<=? ORDER BY created_ts DESC LIMIT 1').get(ticker, dayAgo);
    const priceAt = (ms) => this.db.prepare('SELECT yes_price_cents p FROM trades WHERE market_ticker=? AND created_ts<=? ORDER BY created_ts DESC LIMIT 1').get(ticker, ms)?.p ?? null;
    const hourAgo = priceAt(Date.now() - 3600000);
    const weekAgo = priceAt(Date.now() - 7 * 86400000);
    const vol = this.db.prepare('SELECT COALESCE(SUM(count),0) v FROM trades WHERE market_ticker=?').get(ticker).v;
    const dvol = this.db.prepare('SELECT COALESCE(SUM(count*yes_price_cents),0) v FROM trades WHERE market_ticker=?').get(ticker).v;
    const vol24 = this.db.prepare('SELECT COALESCE(SUM(count),0) v FROM trades WHERE market_ticker=? AND created_ts>?').get(ticker, dayAgo).v;
    const oi = this.db.prepare('SELECT COALESCE(SUM(yes_count),0) v FROM positions WHERE market_ticker=?').get(ticker).v;
    return {
      yes_bid: yb ?? null,
      yes_ask: nb != null ? 100 - nb : null,
      no_bid: nb ?? null,
      no_ask: yb != null ? 100 - yb : null,
      yes_bid_size: sizeAt('yes', yb),
      yes_ask_size: sizeAt('no', nb),
      last_price: last ? last.p : null,
      previous_price: prev ? prev.p : (last ? last.p : null),
      previous_hour_price: hourAgo ?? (last ? last.p : null),
      previous_week_price: weekAgo ?? (prev ? prev.p : (last ? last.p : null)),
      volume: vol, // units
      dollar_volume_cents: Math.round(dvol / UNITS),
      volume_24h: vol24,
      open_interest: oi,
    };
  }

  credit(userId, cents, kind, ref, memo = '') {
    if (cents === 0) return;
    this.db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id=?').run(cents, userId);
    this.db.prepare('INSERT INTO ledger(id,user_id,kind,amount_cents,ref,memo,created_at) VALUES(?,?,?,?,?,?,?)').run(newId('l_'), userId, kind, cents, ref ?? null, memo, nowIso());
  }

  balance(userId) {
    const u = this.db.prepare('SELECT balance_cents FROM users WHERE id=?').get(userId);
    return u ? u.balance_cents : 0;
  }

  // ---- order placement -------------------------------------------------
  // `count` is in units (hundredths of a contract). Options: post_only (reject instead of crossing),
  // exact_reserve (IOC only: reserve exactly the planned cost instead of the limit-price bound),
  // max_cost_cents (shrink the order until its reservation fits), allow_fractional (sell a held fractional position).
  placeOrder(userId, { ticker, side, price, count, time_in_force = 'gtc', client_order_id, post_only = false, exact_reserve = false, max_cost_cents = null, allow_fractional = false, source = 'user' }) {
    if (!['yes', 'no'].includes(side)) throw E.badRequest('side must be yes or no');
    if (!['gtc', 'ioc'].includes(time_in_force)) throw E.badRequest('time_in_force must be gtc or ioc');
    if (!Number.isInteger(price) || price < 1 || price > 99) throw E.badRequest('price must be an integer number of cents between 1 and 99');
    if (!Number.isInteger(count) || count < 1 || count > MAX_UNITS) throw E.badRequest(`count must be between 0.01 and ${MAX_COUNT} contracts`);
    const exact = exact_reserve && time_in_force === 'ioc';

    const touched = new Set([userId]);
    const fills = [];
    const makerOrders = new Set();
    const before = this.book(ticker);
    const order = tx(this.db, () => {
      const m = this.market(ticker);
      if (!this.tradingActive) throw E.conflict('trading_paused', 'trading is paused');
      if (m.status !== 'active') throw E.conflict('market_inactive', 'market is not open for trading', `market status is ${m.status}`);
      if (count % UNITS !== 0 && !m.fractional_trading_enabled && !allow_fractional) throw new ApiError(400, 'fractional_not_enabled', 'fractional contracts are not enabled on this market', 'order a whole number of contracts');
      const opp = side === 'yes' ? 'no' : 'yes';
      const makers = this.db.prepare(`SELECT * FROM orders WHERE market_ticker=? AND status='resting' AND side=? AND price_cents>=? AND user_id<>? ORDER BY price_cents DESC, seq ASC`).all(ticker, opp, 100 - price, userId);
      const feeCap = perContractFeeCap(price, m.fee_multiplier);
      const R = (n) => Math.ceil((n * (price + feeCap)) / UNITS); // reservation bound for n units at the limit
      // Plan the taker fills first so the reservation covers per-fill cent rounding exactly.
      const plan = (cnt) => {
        const out = []; let rem = cnt; let r = cnt;
        for (const mk of makers) {
          if (rem === 0) break;
          const q = Math.min(rem, mk.remaining_count);
          const tp = 100 - mk.price_cents; // price improvement goes to the taker
          const principal = takerPrincipal(q, tp);
          const fee = takerFeeCents(q, tp, m.fee_multiplier);
          out.push({ mk, q, tp, principal, fee, cost: principal + fee, delta: exact ? principal + fee : R(r) - R(r - q) });
          rem -= q; r -= q;
        }
        // suffix[i] = buffer still needed before fill i so no later fill's refund goes negative.
        const suffix = new Array(out.length + 1).fill(0);
        for (let i = out.length - 1; i >= 0; i--) suffix[i] = Math.max(0, out[i].cost - out[i].delta + suffix[i + 1]);
        const base = exact ? out.reduce((a, f) => a + f.cost, 0) : R(cnt);
        return { fills: out, rem, suffix, required: base + suffix[0] };
      };
      let pl = plan(count);
      if (max_cost_cents != null) {
        const step = m.fractional_trading_enabled ? 1 : UNITS;
        for (let i = 0; i < 1000 && pl.required > max_cost_cents && count > step; i++) { count -= step; pl = plan(count); }
      }
      if (post_only && pl.fills.length) throw E.conflict('post_only_cross', 'post-only order would cross the book');
      const reserve = pl.required;
      if (this.balance(userId) < reserve) throw E.conflict('insufficient_balance', 'insufficient balance', `order requires $${(reserve / 100).toFixed(2)} including max fees`);

      const id = newId('o_');
      const ts = nowIso();
      this.db.prepare('INSERT INTO orders(id,seq,user_id,market_ticker,side,price_cents,initial_count,remaining_count,reserved_cents,status,time_in_force,client_order_id,created_at,updated_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, this.nextSeq(), userId, ticker, side, price, count, count, reserve, 'resting', time_in_force, client_order_id ?? null, ts, ts, source);
      this.db.prepare('UPDATE users SET balance_cents = balance_cents - ? WHERE id=?').run(reserve, userId);

      let carry = pl.suffix[0];
      pl.fills.forEach((f, i) => {
        const { mk, q, tp, principal, fee } = f;
        const makerPrice = mk.price_cents;
        const makerCost = q - principal;
        const tradeId = newId('t_');
        const nowMs = Date.now();
        const yesPrice = side === 'yes' ? tp : makerPrice;
        this.db.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,count,taker_side,created_ts) VALUES(?,?,?,?,?,?)').run(tradeId, ticker, yesPrice, q, side, nowMs);

        // maker side: release its reservation for q units (all of it when the order completes)
        const mkFeeCap = perContractFeeCap(makerPrice, m.fee_multiplier);
        const mkR = (n) => Math.ceil((n * (makerPrice + mkFeeCap)) / UNITS);
        const mkRemaining = mk.remaining_count - q;
        const mkReleased = mkRemaining === 0 ? mk.reserved_cents : Math.min(mk.reserved_cents, mkR(mk.remaining_count) - mkR(mkRemaining));
        this.db.prepare('UPDATE orders SET remaining_count=?, filled_count=filled_count+?, reserved_cents=reserved_cents-?, status=?, updated_at=? WHERE id=?')
          .run(mkRemaining, q, mkReleased, mkRemaining === 0 ? 'executed' : 'resting', nowIso(), mk.id);
        this.credit(mk.user_id, mkReleased - makerCost, 'refund', mk.id, 'unused fee reserve');
        this.ledgerOnly(mk.user_id, -makerCost, 'trade', tradeId, `bought ${ustr(q)} ${opp.toUpperCase()} @ ${makerPrice}¢`);
        this.applyFill(mk.user_id, mk.id, tradeId, ticker, opp, makerPrice, q, makerCost, false, 0, nowMs, fills);
        touched.add(mk.user_id);
        makerOrders.add(mk.id);

        // taker side
        carry -= f.cost - f.delta;
        const refund = carry - pl.suffix[i + 1];
        carry = pl.suffix[i + 1];
        this.db.prepare('UPDATE orders SET remaining_count=remaining_count-?, filled_count=filled_count+?, reserved_cents=reserved_cents-?, fees_cents=fees_cents+?, updated_at=? WHERE id=?')
          .run(q, q, f.cost + refund, fee, nowIso(), id);
        this.credit(userId, refund, 'refund', id, 'price improvement / unused fee reserve');
        this.ledgerOnly(userId, -principal, 'trade', tradeId, `bought ${ustr(q)} ${side.toUpperCase()} @ ${tp}¢`);
        this.ledgerOnly(userId, -fee, 'fee', tradeId, 'taker fee');
        this.applyFill(userId, id, tradeId, ticker, side, tp, q, principal, true, fee, nowMs, fills);
        this.emit('trade', { market_ticker: ticker, trade_id: tradeId, yes_price: yesPrice, count: q, taker_side: side, ts: nowMs });
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

  // ledger entry with no balance movement (cost already held in reservation)
  ledgerOnly(userId, cents, kind, ref, memo) {
    if (cents === 0) return;
    this.db.prepare('INSERT INTO ledger(id,user_id,kind,amount_cents,ref,memo,created_at) VALUES(?,?,?,?,?,?,?)').run(newId('l_'), userId, kind, cents, ref, memo, nowIso());
  }

  // qty in units; cost = cents actually paid for this fill (taker: ceil share, maker: remainder).
  applyFill(userId, orderId, tradeId, ticker, side, price, qty, cost, isTaker, fee, ts, fills) {
    const fid = newId('f_');
    this.db.prepare('INSERT INTO fills(id,trade_id,order_id,user_id,market_ticker,side,price_cents,count,is_taker,fee_cents,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(fid, tradeId, orderId, userId, ticker, side, price, qty, isTaker ? 1 : 0, fee, ts);
    fills.push({ user_id: userId, fill_id: fid, order_id: orderId, trade_id: tradeId, market_ticker: ticker, side, price_cents: price, count: qty, is_taker: isTaker, fee_cents: fee, ts });
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
  }

  // Cancel / expire: return remaining reservation to the user.
  releaseOrder(orderId, status = 'canceled') {
    const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o || o.status !== 'resting') return o;
    this.db.prepare('UPDATE orders SET status=?, reserved_cents=0, updated_at=? WHERE id=?').run(status, nowIso(), orderId);
    this.credit(o.user_id, o.reserved_cents, 'refund', orderId, 'order canceled');
    return this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  }

  cancelOrder(userId, orderId) {
    const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o || o.user_id !== userId) throw E.notFound();
    const m = this.market(o.market_ticker);
    if (m.status !== 'active' && m.status !== 'inactive') throw E.conflict('market_inactive', 'market is not open for trading', `market status is ${m.status}`);
    if (o.status !== 'resting') throw E.conflict('order_not_resting', 'order is not resting', `order status is ${o.status}`);
    const before = this.book(o.market_ticker);
    const res = tx(this.db, () => this.releaseOrder(orderId, 'canceled'));
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

  determine(ticker, result) {
    if (!['yes', 'no'].includes(result)) throw E.badRequest('result must be yes or no');
    const m = this.market(ticker);
    if (['determined', 'finalized'].includes(m.status)) throw E.conflict('invalid_transition', `market already ${m.status}`);
    if (m.status === 'initialized') throw E.conflict('invalid_transition', 'market never opened');
    if (m.status !== 'closed') this.close(ticker);
    this.db.prepare("UPDATE markets SET status='determined', result=?, determined_at=?, updated_at=? WHERE ticker=?").run(result, nowIso(), nowIso(), ticker);
    this.emit('lifecycle', ticker, 'determined', 'determined');
  }

  finalize(ticker) {
    const m = this.market(ticker);
    if (m.status !== 'determined') return;
    const touched = new Set();
    const paid = [];
    tx(this.db, () => {
      for (const p of this.db.prepare('SELECT * FROM positions WHERE market_ticker=? AND (yes_count>0 OR no_count>0)').all(ticker)) {
        const payout = m.result === 'yes' ? p.yes_count : p.no_count; // q units pay q cents
        const cost = p.yes_cost_cents + p.no_cost_cents;
        this.db.prepare('INSERT INTO settlements(id,user_id,market_ticker,result,yes_count,no_count,payout_cents,cost_cents,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(newId('s_'), p.user_id, ticker, m.result, p.yes_count, p.no_count, payout, cost, nowIso());
        this.db.prepare('UPDATE positions SET yes_count=0, no_count=0, yes_cost_cents=0, no_cost_cents=0, realized_pnl_cents=realized_pnl_cents+?, updated_at=? WHERE user_id=? AND market_ticker=?')
          .run(payout - cost, nowIso(), p.user_id, ticker);
        this.credit(p.user_id, payout, 'settlement', ticker, `settled ${m.result.toUpperCase()}`);
        touched.add(p.user_id);
        paid.push({ user_id: p.user_id, market_ticker: ticker, result: m.result, payout_cents: payout });
      }
      this.db.prepare("UPDATE markets SET status='finalized', settled_at=?, updated_at=? WHERE ticker=?").run(nowIso(), nowIso(), ticker);
    });
    this.emit('lifecycle', ticker, 'settled', 'finalized');
    for (const u of touched) this.emit('user_balance', u, this.balance(u));
    for (const s of paid) this.emit('settlement', s.user_id, s);
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
    this.emit('tick');
  }
}

module.exports = { Engine, takerFeeCents, perContractFeeCap, takerPrincipal, MAX_COUNT, MAX_UNITS, UNITS };
