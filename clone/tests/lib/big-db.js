'use strict';
// Large-database builder for the regression tests (CLONE_SPEC.md §39.17): adds invented, system-account history to a
// database a server has created (seeded, closed), in the shape a long `npm start` leaves behind — millions of orders,
// fills, trades, journal entries / postings and ledger rows written by the built-in liquidity accounts — plus optional
// history for one member. Everything is generated in SQL (recursive CTEs), with fresh ids (`*big_<n>`), spread over
// `spanDays` before `now`. The journal stays balanced and audit-clean: entries come in pairs whose postings cancel per
// account (reserve / refund, trade / reversal), so balances, materialised balances and the trial balance do not move;
// orders are never resting and reserve nothing; positions are untouched.
const { DatabaseSync } = require('node:sqlite');

const DAY = 86400000;

function amplify(file, { orders = 1_000_000, entries = 2_600_000, fills = 520_000, trades = 260_000, ledger = 1_000_000, member = null, memberRows = 0, spanDays = 10, now = Date.now(), padMb = 0 } = {}) {
  const d = new DatabaseSync(file);
  const t0 = Date.now();
  try {
    d.exec('PRAGMA foreign_keys = OFF; PRAGMA synchronous = OFF; PRAGMA busy_timeout = 5000;');
    const sys = d.prepare('SELECT id FROM users WHERE is_system=1 ORDER BY id').all().map((r) => r.id);
    if (!sys.length) throw new Error('big-db: no system account (start and close a server on the file first)');
    const tickers = d.prepare("SELECT ticker FROM markets WHERE status IN ('active','closed','finalized') ORDER BY ticker LIMIT 300").all().map((r) => r.ticker);
    if (!tickers.length) throw new Error('big-db: no markets');
    const mode = d.prepare("SELECT value FROM meta WHERE key='money_mode'").get()?.value || 'real';
    const epoch = d.prepare("SELECT value FROM meta WHERE key='money_epoch'").get()?.value || 'genesis';
    const cols = (t) => new Set(d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    const marks = cols('journal_entries').has('money_mode');
    const ledgerMarks = cols('ledger').has('money_mode');
    const span = spanDays * DAY; const end = now - 60000; const start = end - span;
    d.exec('DROP TABLE IF EXISTS temp._bu; DROP TABLE IF EXISTS temp._bm; CREATE TEMP TABLE _bu(i INTEGER PRIMARY KEY, id TEXT); CREATE TEMP TABLE _bm(i INTEGER PRIMARY KEY, t TEXT);');
    sys.forEach((id, i) => d.prepare('INSERT INTO _bu(i,id) VALUES(?,?)').run(i, id));
    tickers.forEach((t, i) => d.prepare('INSERT INTO _bm(i,t) VALUES(?,?)').run(i, t));
    const U = sys.length; const M = tickers.length;
    const N = (n) => `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${n - 1})`;
    const ts = (i, n) => `(${start} + (${i} * ${span}) / ${Math.max(1, n)})`;
    const iso = (e) => `strftime('%Y-%m-%dT%H:%M:%fZ', (${e}) / 1000.0, 'unixepoch')`;
    const step = (label, sql) => { const s = Date.now(); d.exec(sql); return { label, ms: Date.now() - s }; };
    const log = [];
    d.exec('BEGIN');
    log.push(step('trades', `${N(trades)} INSERT INTO trades(id,market_ticker,yes_price_cents,yes_price_cc,count,taker_side,created_ts)
      SELECT 'tbig_'||i, (SELECT t FROM _bm WHERE _bm.i = n.i % ${M}), 20 + (i * 7) % 60, (20 + (i * 7) % 60) * 100, 100 * (1 + i % 5), CASE i % 2 WHEN 0 THEN 'yes' ELSE 'no' END, ${ts('i', trades)} FROM n`));
    log.push(step('orders', `${N(orders)} INSERT INTO orders(id,seq,user_id,market_ticker,side,price_cents,price_cc,initial_count,remaining_count,filled_count,reserved_cents,fees_cents,status,time_in_force,created_at,updated_at,source)
      SELECT 'obig_'||i, -1 - i, (SELECT id FROM _bu WHERE _bu.i = n.i % ${U}), (SELECT t FROM _bm WHERE _bm.i = n.i % ${M}), CASE i % 2 WHEN 0 THEN 'yes' ELSE 'no' END, 20 + i % 60, (20 + i % 60) * 100,
        15000, CASE i % 3 WHEN 0 THEN 0 ELSE 15000 END, CASE i % 3 WHEN 0 THEN 15000 ELSE 0 END, 0, 0, CASE i % 3 WHEN 0 THEN 'executed' ELSE 'canceled' END, 'gtc', ${iso(ts('i', orders))}, ${iso(ts('i', orders))}, 'liquidity' FROM n`));
    log.push(step('fills', `${N(fills)} INSERT INTO fills(id,trade_id,order_id,user_id,market_ticker,side,price_cents,price_cc,count,is_taker,fee_cents,created_ts)
      SELECT 'fbig_'||i, 'tbig_'||(i % ${trades}), 'obig_'||((i * 3) % ${orders}), (SELECT id FROM _bu WHERE _bu.i = ((i * 3) % ${orders}) % ${U}), (SELECT t FROM _bm WHERE _bm.i = ((i * 3) % ${orders}) % ${M}),
        CASE i % 2 WHEN 0 THEN 'yes' ELSE 'no' END, 20 + i % 60, (20 + i % 60) * 100, 100, i % 2, 0, ${ts('i', fills)} FROM n`));
    // Journal entries in cancelling pairs (2k, 2k+1): reserve / refund on an order, or a trade and its reversal.
    const pairs = Math.floor(entries / 2);
    log.push(step('journal_entries', `${N(entries)} INSERT INTO journal_entries(id,ts,kind,ref,user_id,memo${marks ? ',money_mode,money_epoch' : ''})
      SELECT 'jbig_'||i, ${ts('i / 2', pairs)}, CASE WHEN (i / 2) % 4 = 3 THEN 'trade' WHEN i % 2 = 0 THEN 'order_reserve' ELSE 'refund' END,
        CASE WHEN (i / 2) % 4 = 3 THEN 'tbig_'||((i / 2) % ${trades}) ELSE 'obig_'||((i / 2) % ${orders}) END, (SELECT id FROM _bu WHERE _bu.i = (i / 2) % ${U}), 'invented history'${marks ? `, '${mode}', '${epoch}'` : ''} FROM n`));
    const amt = '(1 + ((i / 2) * 13) % 900)';
    const sign = 'CASE i % 2 WHEN 0 THEN 1 ELSE -1 END';
    log.push(step('journal_postings', `${N(entries)} INSERT INTO journal_postings(entry_id,account,amount_cents)
      SELECT 'jbig_'||i, CASE WHEN (i / 2) % 4 = 3 THEN 'user:'||(SELECT id FROM _bu WHERE _bu.i = (i / 2) % ${U})||':reserved' ELSE 'user:'||(SELECT id FROM _bu WHERE _bu.i = (i / 2) % ${U})||':cash' END, -${amt} * ${sign} FROM n
      UNION ALL SELECT 'jbig_'||i, CASE WHEN (i / 2) % 4 = 3 THEN 'escrow:'||(SELECT t FROM _bm WHERE _bm.i = (i / 2) % ${M}) ELSE 'user:'||(SELECT id FROM _bu WHERE _bu.i = (i / 2) % ${U})||':reserved' END, ${amt} * ${sign} FROM n`));
    log.push(step('ledger', `${N(ledger)} INSERT INTO ledger(id,user_id,kind,amount_cents,ref,memo,created_at${ledgerMarks ? ',money_mode,money_epoch' : ''})
      SELECT 'lbig_'||i, (SELECT id FROM _bu WHERE _bu.i = (i / 2) % ${U}), CASE i % 2 WHEN 0 THEN 'trade' ELSE 'refund' END, (1 + ((i / 2) * 13) % 900) * ${sign}, 'obig_'||((i / 2) % ${orders}), 'invented history', ${iso(ts('i', ledger))}${ledgerMarks ? `, '${mode}', '${epoch}'` : ''} FROM n`));
    if (member && memberRows > 0) {
      // A member with a long history: orders (never resting), fills on the invented trades, ledger rows in pairs.
      log.push(step('member', `${N(memberRows)} INSERT INTO orders(id,seq,user_id,market_ticker,side,price_cents,price_cc,initial_count,remaining_count,filled_count,reserved_cents,fees_cents,status,time_in_force,created_at,updated_at,source)
        SELECT 'ombig_'||i, -10000000 - i, '${member}', (SELECT t FROM _bm WHERE _bm.i = n.i % ${M}), 'yes', 40, 4000, 100, 100, 0, 0, 0, 'canceled', 'gtc', ${iso(ts('i', memberRows))}, ${iso(ts('i', memberRows))}, 'user' FROM n;
        ${N(memberRows)} INSERT INTO fills(id,trade_id,order_id,user_id,market_ticker,side,price_cents,price_cc,count,is_taker,fee_cents,created_ts)
        SELECT 'fmbig_'||i, 'tbig_'||((i * 7) % ${trades}), 'ombig_'||i, '${member}', (SELECT t FROM _bm WHERE _bm.i = n.i % ${M}), 'yes', 40, 4000, 100, 1, 0, ${ts('i', memberRows)} FROM n;
        ${N(memberRows)} INSERT INTO ledger(id,user_id,kind,amount_cents,ref,memo,created_at${ledgerMarks ? ',money_mode,money_epoch' : ''})
        SELECT 'lmbig_'||i, '${member}', CASE i % 2 WHEN 0 THEN 'trade' ELSE 'refund' END, 40 * ${sign}, 'ombig_'||(i / 2), 'invented history', ${iso(ts('i', memberRows))}${ledgerMarks ? `, '${mode}', '${epoch}'` : ''} FROM n;`));
    }
    if (padMb > 0) {
      d.exec('CREATE TABLE IF NOT EXISTS zz_pad(id INTEGER PRIMARY KEY, b BLOB)');
      log.push(step('pad', `${N(padMb)} INSERT INTO zz_pad(b) SELECT randomblob(1048576) FROM n`));
    }
    d.exec('COMMIT');
    d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { ms: Date.now() - t0, steps: log };
  } finally { d.close(); }
}

module.exports = { amplify };
