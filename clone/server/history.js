'use strict';
// Portfolio History (spec §17.9): one server-paginated timeline of everything that happened to an account, read
// from the persisted orders, fills, settlements, ledger, RFQ/quote and combo tables (perps transfers come from the
// ledger's perps_transfer rows; perps internals are not touched).
const C = require('./currency'); // display currency formatting (CLONE_SPEC.md §30)
const { dollars, ufp, ustr, UNITS, E, encCursor, decCursor } = require('./util');
const P = require('./pricing'); // `price` below is in centi-cents (CLONE_SPEC.md §28.1)

// ISO-8601 text → unix ms inside SQLite.
const ms = (col) => `CAST(ROUND((julianday(${col}) - 2440587.5) * 86400000) AS INTEGER)`;
const GROUPS = {
  trades: ['fill', 'netting', 'collateral_return'],
  orders: ['order', 'cancel'],
  settlements: ['settlement', 'settlement_correction'],
  combos: ['combo', 'rfq', 'quote', 'rfq_execution'],
  cash: ['deposit', 'withdrawal', 'interest', 'perps_transfer', 'credit', 'withdrawal_hold', 'withdrawal_hold_reversal', 'closure_payout', 'deposit_return', 'withdrawal_fee', 'withdrawal_reversal', 'credit_expired', 'incentive'],
};
// Account › Your activity chips (CLONE_SPEC §13.16: All · Deposit · Withdrawal · Order · Trade · Settlement · Credit).
const ACTIVITY = {
  deposit: ['deposit', 'deposit_return'],
  withdrawal: ['withdrawal', 'withdrawal_hold', 'withdrawal_hold_reversal', 'closure_payout', 'withdrawal_fee', 'withdrawal_reversal'],
  order: ['order', 'cancel', 'rfq', 'quote', 'combo'],
  trade: ['fill', 'netting', 'rfq_execution', 'collateral_return'],
  settlement: ['settlement', 'settlement_correction'],
  credit: ['credit', 'interest', 'credit_expired', 'incentive'],
};
const GROUP_OF = Object.fromEntries(Object.entries(GROUPS).flatMap(([g, ks]) => ks.map((k) => [k, g])));
const TYPE_LABEL = { fill: 'Trade', netting: 'Pairs redeemed', collateral_return: 'Collateral return', settlement_correction: 'Settlement correction', order: 'Order', cancel: 'Canceled', settlement: 'Settlement', combo: 'Combo', rfq: 'RFQ', quote: 'Quote', rfq_execution: 'RFQ executed', deposit: 'Deposit', withdrawal: 'Withdrawal', interest: 'Interest', perps_transfer: 'Perps transfer',
  credit: 'Credit', withdrawal_hold: 'Withdrawal (under review)', withdrawal_hold_reversal: 'Withdrawal returned', closure_payout: 'Closing payout',
  deposit_return: 'Deposit returned', withdrawal_fee: 'Network fee', withdrawal_reversal: 'Withdrawal returned', credit_expired: 'Credit expired', incentive: 'Liquidity reward' }; // payment rails (CLONE_SPEC.md §26); liquidity rewards (§29)

// Every source projected onto: id, ts, prio (tie-break within the same ms), kind, market, side, action, otype,
// price, qty, filled, amount, fee, status, role, extra (kind-specific number), memo.
const UNION = `
  SELECT 'order:'||o.id id, ${ms('o.created_at')} ts, 0 prio, 'order' kind, o.market_ticker market, o.side side, o.action action, o.order_type otype,
    o.price_cc price, o.initial_count qty, o.filled_count filled, NULL amount, o.fees_cents fee, o.status status, NULL role, NULL extra, '' memo
    FROM orders o WHERE o.user_id=:uid
  UNION ALL
  SELECT 'cancel:'||o.id, ${ms('o.updated_at')}, 3, 'cancel', o.market_ticker, o.side, o.action, o.order_type, o.price_cc, o.remaining_count, o.filled_count, NULL, NULL, CASE WHEN o.cancel_reason='expired' THEN 'expired' ELSE 'canceled' END, NULL, NULL, COALESCE(o.cancel_reason,'')
    FROM orders o WHERE o.user_id=:uid AND o.status='canceled'
  UNION ALL
  SELECT 'fill:'||f.id, f.created_ts, 1, 'fill', f.market_ticker, f.side, COALESCE(o.action,'buy'), o.order_type, f.price_cc, f.count, NULL,
    -(CASE WHEN f.is_taker=1 THEN (f.count*f.price_cc+${P.CC - 1})/${P.CC} ELSE (f.count*f.price_cc)/${P.CC} END), f.fee_cents, 'filled', CASE WHEN f.is_taker=1 THEN 'taker' ELSE 'maker' END, NULL, ''
    FROM fills f LEFT JOIN orders o ON o.id=f.order_id WHERE f.user_id=:uid
  UNION ALL
  SELECT 'settle:'||s.id, ${ms('s.created_at')}, 2, 'settlement', s.market_ticker, s.result, NULL, NULL, NULL, s.yes_count+s.no_count, NULL, s.payout_cents, NULL, s.result, NULL, s.cost_cents, ''
    FROM settlements s WHERE s.user_id=:uid
  UNION ALL
  SELECT 'ledger:'||l.id, ${ms('l.created_at')}, 2, l.kind, CASE WHEN l.kind IN ('netting','settlement_correction') THEN l.ref END, NULL, NULL, NULL, NULL, NULL, NULL, l.amount_cents, NULL, COALESCE((SELECT pt.status FROM payment_transactions pt WHERE pt.id=l.ref AND pt.rail<>'demo'), 'done'), NULL, NULL, l.memo
    FROM ledger l WHERE l.user_id=:uid AND l.kind IN ('deposit','withdrawal','interest','perps_transfer','netting','collateral_return','settlement_correction','incentive','credit','withdrawal_hold','withdrawal_hold_reversal','closure_payout','deposit_return','withdrawal_fee','withdrawal_reversal','credit_expired')
  UNION ALL
  SELECT 'combo:'||c.combo_ticker, c.created_ts, 0, 'combo', c.combo_ticker, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'created', NULL, NULL, ''
    FROM combo_creations c WHERE c.user_id=:uid
  UNION ALL
  SELECT 'rfq:'||r.id, r.created_ts, 0, 'rfq', r.market_ticker, NULL, NULL, NULL, NULL, r.contracts_units, NULL, NULL, NULL, r.status, 'requester', r.target_cost_cents, ''
    FROM rfqs r WHERE r.user_id=:uid
  UNION ALL
  SELECT 'quote:'||q.id, q.created_ts, 0, 'quote', r.market_ticker, NULL, NULL, NULL, q.yes_bid_cc, NULL, NULL, NULL, NULL, q.status, 'maker', q.no_bid_cc, ''
    FROM rfq_quotes q JOIN rfqs r ON r.id=q.rfq_id WHERE q.maker_id=:uid
  UNION ALL
  SELECT 'rfqx:'||q.id, q.executed_ts, 2, 'rfq_execution', r.market_ticker,
    CASE WHEN q.maker_id=:uid THEN q.accepted_side WHEN q.accepted_side='yes' THEN 'no' ELSE 'yes' END, 'buy', 'rfq',
    CASE WHEN q.maker_id=:uid AND q.accepted_side='yes' THEN q.yes_bid_cc WHEN q.maker_id=:uid THEN q.no_bid_cc
      WHEN q.accepted_side='yes' THEN ${P.CC}-q.yes_bid_cc ELSE ${P.CC}-q.no_bid_cc END,
    q.executed_units, NULL, NULL, NULL, 'executed', CASE WHEN q.maker_id=:uid THEN 'maker' ELSE 'requester' END, NULL, ''
    FROM rfq_quotes q JOIN rfqs r ON r.id=q.rfq_id WHERE q.status='executed' AND (q.maker_id=:uid OR r.user_id=:uid)`;

function mountHistory({ v1, db, requireUser }) {
  db.exec('CREATE TABLE IF NOT EXISTS combo_creations (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, combo_ticker TEXT NOT NULL REFERENCES markets(ticker), created_ts INTEGER NOT NULL, PRIMARY KEY (user_id, combo_ticker))');
  const linkOf = (t) => {
    const r = t && db.prepare('SELECT e.ticker et, s.ticker st, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.ticker=?').get(t);
    return r ? `/markets/${r.st.toLowerCase()}/${r.slug}/${r.et.toLowerCase()}` : null;
  };

  function parseFilters(q) {
    const type = String(q.type || 'all');
    if (type !== 'all' && !GROUPS[type]) throw E.badRequest('type must be one of all, trades, orders, settlements, combos, cash');
    const day = (v, name, end) => {
      if (v == null || v === '') return null;
      const s = String(v);
      const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) + (end ? 86400000 : 0) : /^\d+$/.test(s) ? Number(s) : NaN;
      if (!Number.isFinite(t)) throw E.badRequest(`${name} must be a date (YYYY-MM-DD) or unix ms`);
      return t;
    };
    const market = String(q.market || '').trim().slice(0, 80);
    const activity = q.activity == null || q.activity === '' ? null : String(q.activity);
    if (activity && activity !== 'all' && !ACTIVITY[activity]) throw E.badRequest('activity must be one of all, deposit, withdrawal, order, trade, settlement, credit');
    return { type, market, from: day(q.from, 'from', false), to: day(q.to, 'to', true), ...(activity ? { activity } : {}) };
  }

  function query(uid, f, { limit, cursor }) {
    const where = [];
    const args = { uid };
    if (f.type !== 'all') { where.push(`h.kind IN (${GROUPS[f.type].map((k) => `'${k}'`).join(',')})`); }
    if (f.activity && f.activity !== 'all') { where.push(`h.kind IN (${ACTIVITY[f.activity].map((k) => `'${k}'`).join(',')})`); }
    if (f.market) { where.push("(h.market LIKE :mk ESCAPE '\\' OR m.title LIKE :mk ESCAPE '\\')"); args.mk = `%${f.market.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; }
    if (f.from != null) { where.push('h.ts >= :from'); args.from = f.from; }
    if (f.to != null) { where.push('h.ts < :to'); args.to = f.to; }
    if (cursor) { where.push('(h.ts < :cts OR (h.ts = :cts AND (h.prio < :cp OR (h.prio = :cp AND h.id < :cid))))'); Object.assign(args, { cts: cursor.ts, cp: cursor.p, cid: cursor.id }); }
    const sql = `SELECT h.*, m.title market_title FROM (${UNION}) h LEFT JOIN markets m ON m.ticker=h.market ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY h.ts DESC, h.prio DESC, h.id DESC LIMIT :lim`;
    return db.prepare(sql).all({ ...args, lim: limit + 1 });
  }

  // Display: sells are stored as buys of the other side; show what the user asked for.
  function rowVo(r) {
    const sell = r.action === 'sell' && ['order', 'cancel', 'fill'].includes(r.kind);
    const side = r.side == null ? null : sell ? (r.side === 'yes' ? 'no' : 'yes') : r.side;
    // Market orders carry a protective 99¢ limit, not a meaningful user price.
    const price = r.price == null || (['order', 'cancel'].includes(r.kind) && r.otype === 'market') ? null : sell ? P.CC - r.price : r.price;
    const L = P.centsLabel;
    const S = side ? side.toUpperCase() : '';
    const typeName = { limit: 'Limit', market: 'Market', dollars: 'Dollars', rfq: 'RFQ' }[r.otype] || 'Limit';
    let desc;
    switch (r.kind) {
      case 'order': desc = `${typeName} ${sell ? 'sell' : 'buy'} ${S} · ${ustr(r.filled)} of ${ustr(r.qty)} filled`; break;
      case 'cancel': desc = `${typeName} ${sell ? 'sell' : 'buy'} ${S} ${r.memo === 'expired' ? 'expired' : 'canceled'} · ${ustr(r.qty)} unfilled`; break;
      case 'fill': desc = sell ? `Sold ${S} (bought ${r.side.toUpperCase()} @ ${L(r.price)}; pairs net to cash) · ${r.role}` : `Bought ${S} · ${r.role}`; break;
      case 'settlement': desc = `Market settled ${String(r.status).toUpperCase()} · cost ${C.moneyCents(r.extra)}`; break;
      case 'settlement_correction': case 'collateral_return': desc = r.memo || TYPE_LABEL[r.kind]; break;
      case 'combo': desc = 'Combo built'; break;
      case 'rfq': desc = `RFQ for ${r.qty != null ? `${ustr(r.qty)} contracts` : `${C.moneyCents(r.extra)} target`}`; break;
      case 'quote': desc = `Quoted Yes ${L(r.price)} / No ${L(r.extra)}`; break;
      case 'rfq_execution': desc = `RFQ executed as ${r.role}: bought ${S} @ ${L(price)}`; break;
      default: desc = r.memo || TYPE_LABEL[r.kind] || r.kind;
    }
    return {
      id: r.id, time: new Date(r.ts).toISOString(), type: r.kind, type_label: TYPE_LABEL[r.kind] || r.kind, group: GROUP_OF[r.kind],
      market_ticker: r.market || null, market_title: r.market_title || null, link: linkOf(r.market),
      side, action: r.kind === 'order' || r.kind === 'cancel' || r.kind === 'fill' ? (sell ? 'sell' : 'buy') : r.kind === 'rfq_execution' ? 'buy' : null,
      quantity_fp: r.kind === 'quote' ? null : r.qty == null ? null : ufp(r.qty), price_dollars: price == null || r.kind === 'quote' ? null : P.ccToDollars(price),
      amount_dollars: r.amount == null ? null : dollars(r.amount), fee_dollars: r.fee ? dollars(-r.fee) : null,
      status: r.status, role: r.role, description: desc,
    };
  }

  v1.get('/users/:uid/history', requireUser, (req, res) => {
    const f = parseFilters(req.query);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const cursor = req.query.cursor ? decCursor(req.query.cursor) : null;
    const rows = query(req.auth.user.id, f, { limit, cursor });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    res.json({ history: page.map(rowVo), cursor: rows.length > limit ? encCursor({ ts: last.ts, p: last.prio, id: last.id }) : '', filters: f });
  });

  // CSV of the filtered history (spec §9 file format; columns documented in §17.9).
  // Money columns follow the display currency (CLONE_SPEC.md §30): price_ngn / amount_ngn / fee_ngn, or the original *_dollars under USD.
  const cols = () => ['time', 'type', 'market', 'description', 'side', 'action', 'quantity', C.csvCol('price', 'price_dollars'), C.csvCol('amount', 'amount_dollars'), C.csvCol('fee', 'fee_dollars'), 'status'];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const two = (v) => C.csvDollars(v);
  v1.get('/users/:uid/history.csv', requireUser, (req, res) => {
    const f = parseFilters(req.query);
    const rows = query(req.auth.user.id, f, { limit: 10000, cursor: null }).slice(0, 10000).map(rowVo);
    const lines = [cols().join(','), ...rows.map((r) => [r.time, r.type, r.market_title || r.market_ticker || '', r.description, r.side || '', r.action || '', r.quantity_fp || '', two(r.price_dollars), two(r.amount_dollars), two(r.fee_dollars), r.status || ''].map(esc).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="parlance-history.csv"');
    res.send(lines.join('\n') + '\n');
  });

  // Used by Account › Your activity (server/account-area.js): same timeline, chip filters, same CSV columns.
  const csvOf = (rows) => [cols().join(','), ...rows.map((r) => [r.time, r.type, r.market_title || r.market_ticker || '', r.description, r.side || '', r.action || '', r.quantity_fp || '', two(r.price_dollars), two(r.amount_dollars), two(r.fee_dollars), r.status || ''].map(esc).join(','))].join('\n') + '\n';
  return { parseFilters, query, rowVo, csvOf, ACTIVITY };
}

module.exports = { mountHistory, GROUPS, ACTIVITY };
