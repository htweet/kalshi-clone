'use strict';
// Resting-order management for event contracts (spec §17.10): amend, decrease, cancel all (optionally per
// market / event), queue positions, good-til-time expiry notifications. Paths mirror the documented
// /portfolio/events/orders/{id}/amend|decrease, DELETE /portfolio/events/orders and /portfolio/orders/queue_positions
// (api-reference_orders_*.md) under the web client's /v1/users/:uid/orders prefix.
const C = require('./currency'); // display currency formatting (CLONE_SPEC.md §30)
const { ufp, ustr, toUnits, E } = require('./util');
const { orderVo } = require('./serialize');
const P = require('./pricing');

// expiration_time: ISO string or unix ms; null clears (GTC). Returns undefined when absent.
function parseExpiry(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(t)) throw E.badRequest('expiration_time must be an ISO-8601 time or unix milliseconds');
  return Math.round(t);
}

function mountOrders({ v1, db, engine, requireUser, notify }) {
  const marketOf = (t) => db.prepare('SELECT m.title, m.yes_sub_title, m.fractional_trading_enabled, m.event_ticker, e.title event_title, s.ticker st, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.ticker=?').get(t);
  const richVo = (o) => {
    const m = marketOf(o.market_ticker);
    return { ...orderVo(o), market_title: m.title, outcome: m.yes_sub_title, event_ticker: m.event_ticker, event_title: m.event_title,
      fractional_trading_enabled: !!m.fractional_trading_enabled, link: `/markets/${m.st.toLowerCase()}/${m.slug}/${m.event_ticker.toLowerCase()}`, queue_position_fp: o.status === 'resting' ? ufp(engine.queuePosition(o)) : null };
  };
  const own = (req) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.params.oid, req.auth.user.id);
    if (!o) throw E.notFound();
    return o;
  };
  // User-facing price in cc (CLONE_SPEC.md §28.1): `price_dollars` or `price` in cents; sells are stored as buys of the
  // other side at 100 − p. The engine checks the market's grid.
  const storedPrice = (o, b) => {
    let p = null;
    if (b.price_dollars != null && b.price_dollars !== '') { p = P.ccFromDollars(b.price_dollars); if (p == null) throw E.badRequest('price_dollars must be a dollar amount with at most 4 decimals'); }
    else if (b.price != null && b.price !== '') { p = P.ccFromCents(b.price); if (p == null) throw E.badRequest('price must be a number of cents'); }
    if (p == null) return null;
    if (p < 1 || p >= P.CC) throw E.badRequest(`price must be between ${C.priceCents(1)} and ${C.priceCents(99)} (sub-cent ticks where the market allows them)`);
    return o.action === 'sell' ? P.CC - p : p;
  };
  const units = (v, name) => {
    if (v == null || v === '') return null;
    const u = toUnits(v);
    if (u == null) throw E.badRequest(`${name} must be a number of contracts with at most 2 decimal places`);
    return u;
  };

  engine.on('order_expired', (uid, o) => {
    if (db.prepare('SELECT is_system FROM users WHERE id=?').get(uid)?.is_system) return;
    const m = marketOf(o.market_ticker);
    notify(uid, { type: 'order_expired', title: `Order expired: ${ustr(o.remaining_count)} unfilled released`, body: m ? m.title : o.market_ticker, link: '/portfolio?tab=orders' });
  });

  v1.get('/users/:uid/orders/queue_positions', requireUser, (req, res) => {
    const rows = db.prepare("SELECT * FROM orders WHERE user_id=? AND status='resting' ORDER BY seq").all(req.auth.user.id);
    res.json({ queue_positions: rows.map((o) => ({ order_id: o.id, market_ticker: o.market_ticker, queue_position_fp: ufp(engine.queuePosition(o)) })) });
  });
  v1.get('/users/:uid/orders/:oid/queue_position', requireUser, (req, res) => res.json({ queue_position_fp: ufp(engine.queuePosition(own(req))) }));
  v1.get('/users/:uid/orders/:oid', requireUser, (req, res) => res.json({ order: richVo(own(req)) }));
  v1.post('/users/:uid/orders/:oid/amend', requireUser, (req, res) => {
    const o = own(req);
    const b = req.body || {};
    const total = units(b.count_fp != null ? b.count_fp : b.count, 'count');
    const price = storedPrice(o, b);
    const exp = parseExpiry(b.expiration_time);
    if (price == null && total == null && exp === undefined) throw E.badRequest('provide price, count and/or expiration_time');
    const before = o.seq;
    const r = engine.amendOrder(req.auth.user.id, o.id, { price_cc: price, total, expiration_ts: exp });
    res.json({ order: richVo(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)), queue_priority_kept: r.seq === before });
  });
  v1.post('/users/:uid/orders/:oid/decrease', requireUser, (req, res) => {
    const o = own(req);
    const b = req.body || {};
    const by = units(b.reduce_by, 'reduce_by'); const to = units(b.reduce_to, 'reduce_to');
    if ((by == null) === (to == null)) throw E.badRequest('exactly one of reduce_by or reduce_to must be provided');
    const next = to != null ? to : o.remaining_count - by;
    if (by != null && by < 1) throw E.badRequest('reduce_by must be at least 0.01');
    if (next < 0 || next >= o.remaining_count) throw E.badRequest(`the order has ${ustr(o.remaining_count)} contracts remaining; reduce to a smaller size`);
    engine.decreaseOrder(req.auth.user.id, o.id, next);
    res.json({ order: richVo(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)), reduced_by_fp: ufp(o.remaining_count - next) });
  });
  // Cancel all resting orders, optionally scoped to one market or one event.
  v1.delete('/users/:uid/orders', requireUser, (req, res) => {
    const where = ["user_id=?", "status='resting'"]; const args = [req.auth.user.id];
    if (req.query.market_ticker) { where.push('market_ticker=?'); args.push(String(req.query.market_ticker)); }
    if (req.query.event_ticker) { where.push('market_ticker IN (SELECT ticker FROM markets WHERE event_ticker=?)'); args.push(String(req.query.event_ticker)); }
    const canceled = [];
    for (const o of db.prepare(`SELECT id FROM orders WHERE ${where.join(' AND ')} ORDER BY seq`).all(...args)) {
      try { canceled.push(engine.cancelOrder(req.auth.user.id, o.id)); } catch { /* market no longer open: skip */ }
    }
    res.json({ canceled_count: canceled.length, orders: canceled.map(orderVo) });
  });
  return { richVo, parseExpiry };
}

module.exports = { mountOrders, parseExpiry };
