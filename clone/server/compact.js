'use strict';
// Compaction of simulated trading history (`npm run db:compact`, scripts/db-compact.js; database growth fix 2026-11-13,
// CLONE_SPEC.md §39.17). The built-in liquidity accounts (users.is_system = 1) quote and print on the simulated markets;
// before the `simulation.activity` owner setting existed they wrote millions of rows a day. This removes the part of that
// history no person is part of, older than `olderThanDays`, and keeps every number the ledger audit checks unchanged:
//   • orders of system accounts placed by the liquidity jobs (source 'liquidity'), no longer resting, last changed before
//     the cut-off, that never filled — deleted with their order_reserve / refund journal entries and ledger rows;
//   • bot-vs-bot trades (every fill of the trade belongs to such an order) — their trade / fee journal entries, and the
//     order_reserve / refund entries of the orders that filled in them, are rolled up into ONE balancing entry per system
//     account, UTC day and money epoch ("compaction_rollup", postings = the net of the removed entries per journal account),
//     their ledger rows into one "compaction" ledger row per account and day. Orders that filled, fills and trades stay:
//     trades are the price history the charts, candlesticks, volume and the trade tape read.
//   • never anything that involves a member (a non-system user): a trade with a member fill keeps every journal entry and
//     ledger row of every order in it, and member rows are never selected at all.
// Journal balances, materialised balances (journal_balances is not touched), the trial balance, positions and every
// member's orders / fills / ledger / balances are therefore unchanged; the caller compares the full ledger audit before
// and after and rolls back on any difference. All of it runs in one transaction.
const { newId } = require('./util');

const DAY = 86400000;
const hasCol = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);

// Runs inside the caller's transaction. Returns the counts; `dryRun` only changes nothing when the caller rolls back.
function compact(db, { olderThanDays = 7, now = Date.now() } = {}) {
  const cutoff = now - olderThanDays * DAY;
  const cutoffIso = new Date(cutoff).toISOString();
  const marks = hasCol(db, 'journal_entries', 'money_mode');
  const ledgerMarks = hasCol(db, 'ledger', 'money_mode');
  const q1 = (sql, ...a) => db.prepare(sql).get(...a);
  db.exec(`DROP TABLE IF EXISTS temp._cp_sys; DROP TABLE IF EXISTS temp._cp_mtrades; DROP TABLE IF EXISTS temp._cp_keep; DROP TABLE IF EXISTS temp._cp_orders;
    DROP TABLE IF EXISTS temp._cp_trades; DROP TABLE IF EXISTS temp._cp_entries; DROP TABLE IF EXISTS temp._cp_ledger;
    CREATE TEMP TABLE _cp_sys(id TEXT PRIMARY KEY); CREATE TEMP TABLE _cp_mtrades(id TEXT PRIMARY KEY); CREATE TEMP TABLE _cp_keep(id TEXT PRIMARY KEY);
    CREATE TEMP TABLE _cp_orders(id TEXT PRIMARY KEY, filled INTEGER NOT NULL); CREATE TEMP TABLE _cp_trades(id TEXT PRIMARY KEY);
    CREATE TEMP TABLE _cp_entries(id TEXT PRIMARY KEY); CREATE TEMP TABLE _cp_ledger(id TEXT PRIMARY KEY);`);
  db.exec('INSERT INTO _cp_sys(id) SELECT id FROM users WHERE is_system=1');
  const counts = { cutoff: cutoffIso, older_than_days: olderThanDays, system_accounts: q1('SELECT COUNT(*) c FROM _cp_sys').c };
  // Trades a member is part of, and every order (of anyone) that filled in them: never touched.
  db.exec('INSERT OR IGNORE INTO _cp_mtrades(id) SELECT DISTINCT trade_id FROM fills WHERE user_id NOT IN (SELECT id FROM _cp_sys)');
  db.exec('INSERT OR IGNORE INTO _cp_keep(id) SELECT DISTINCT f.order_id FROM fills f JOIN _cp_mtrades m ON m.id=f.trade_id');
  // Candidate orders: system accounts, liquidity jobs, finished, last changed before the cut-off, no member trade.
  db.prepare(`INSERT INTO _cp_orders(id, filled) SELECT o.id, o.filled_count FROM orders o
    WHERE o.user_id IN (SELECT id FROM _cp_sys) AND o.source='liquidity' AND o.status IN ('executed','canceled') AND o.updated_at < ? AND o.created_at < ?
      AND o.id NOT IN (SELECT id FROM _cp_keep)`).run(cutoffIso, cutoffIso);
  // An order counts as unfilled only when no fill refers to it (filled_count can lag behind fills of an amended order).
  db.exec('UPDATE _cp_orders SET filled=1 WHERE filled=0 AND id IN (SELECT order_id FROM fills)');
  // Bot-vs-bot trades: before the cut-off, every fill from a candidate order.
  db.prepare(`INSERT INTO _cp_trades(id) SELECT f.trade_id FROM fills f WHERE f.created_ts < ? GROUP BY f.trade_id
    HAVING SUM(CASE WHEN f.order_id IN (SELECT id FROM _cp_orders) THEN 0 ELSE 1 END) = 0`).run(cutoff);
  // A filled candidate order is rolled up only when every one of its fills is in a bot-vs-bot trade before the cut-off.
  db.prepare('DELETE FROM _cp_orders WHERE filled<>0 AND id IN (SELECT order_id FROM fills WHERE trade_id NOT IN (SELECT id FROM _cp_trades) OR created_ts >= ?)').run(cutoff);
  // Journal entries: reserve / refund of the candidate orders, trade / fee of the bot-vs-bot trades, system accounts only.
  db.prepare(`INSERT OR IGNORE INTO _cp_entries(id) SELECT e.id FROM journal_entries e WHERE e.ts < ? AND e.user_id IN (SELECT id FROM _cp_sys) AND (
      (e.kind IN ('order_reserve','refund') AND e.ref IN (SELECT id FROM _cp_orders)) OR (e.kind IN ('trade','fee') AND e.ref IN (SELECT id FROM _cp_trades)))`).run(cutoff);
  db.prepare(`INSERT OR IGNORE INTO _cp_ledger(id) SELECT l.id FROM ledger l WHERE l.created_at < ? AND l.user_id IN (SELECT id FROM _cp_sys) AND (
      (l.kind='refund' AND l.ref IN (SELECT id FROM _cp_orders)) OR (l.kind IN ('trade','fee') AND l.ref IN (SELECT id FROM _cp_trades)))`).run(cutoffIso);
  counts.orders_removed = q1('SELECT COUNT(*) c FROM _cp_orders WHERE filled=0').c;
  counts.orders_rolled_up = q1('SELECT COUNT(*) c FROM _cp_orders WHERE filled<>0').c;
  counts.bot_trades = q1('SELECT COUNT(*) c FROM _cp_trades').c;
  counts.journal_entries_removed = q1('SELECT COUNT(*) c FROM _cp_entries').c;
  counts.journal_postings_removed = q1('SELECT COUNT(*) c FROM journal_postings WHERE entry_id IN (SELECT id FROM _cp_entries)').c;
  counts.ledger_rows_removed = q1('SELECT COUNT(*) c FROM _cp_ledger').c;

  // The roll-up: per account, UTC day and money epoch / mode, the net of the removed postings of each journal account.
  const dayOf = "strftime('%Y-%m-%d', e.ts / 1000, 'unixepoch')";
  const groups = db.prepare(`SELECT e.user_id uid, ${dayOf} day, ${marks ? 'e.money_mode mm, e.money_epoch me' : "NULL mm, NULL me"}, p.account, SUM(p.amount_cents) s, MAX(e.ts) ts, COUNT(DISTINCT e.id) n
    FROM journal_postings p JOIN journal_entries e ON e.id=p.entry_id WHERE e.id IN (SELECT id FROM _cp_entries)
    GROUP BY e.user_id, day, mm, me, p.account ORDER BY e.user_id, day, mm, me, p.account`).all();
  const byKey = new Map();
  for (const g of groups) {
    const k = `${g.uid}|${g.day}|${g.mm}|${g.me}`;
    if (!byKey.has(k)) byKey.set(k, { uid: g.uid, day: g.day, mm: g.mm, me: g.me, ts: g.ts, n: 0, postings: [] });
    const x = byKey.get(k); x.ts = Math.max(x.ts, g.ts); x.n = Math.max(x.n, g.n);
    if (g.s !== 0) x.postings.push([g.account, g.s]);
  }
  const insE = db.prepare(`INSERT INTO journal_entries(id,ts,kind,ref,user_id,memo,ledger_id${marks ? ',money_mode,money_epoch' : ''}) VALUES(?,?,?,?,?,?,NULL${marks ? ',?,?' : ''})`);
  const insP = db.prepare('INSERT INTO journal_postings(entry_id,account,amount_cents) VALUES(?,?,?)');
  let rollups = 0;
  for (const g of byKey.values()) {
    const sum = g.postings.reduce((a, [, c]) => a + c, 0);
    if (sum !== 0) throw new Error(`compaction: the removed entries of ${g.uid} on ${g.day} do not balance (${sum})`);
    if (!g.postings.length) continue; // everything of that day nets to zero per account (reserve / refund pairs)
    const id = newId('je_');
    insE.run(id, g.ts, 'compaction_rollup', g.day, g.uid, `simulated trading of ${g.day} compacted`, ...(marks ? [g.mm, g.me] : []));
    for (const [a, c] of g.postings) insP.run(id, a, c);
    rollups += 1;
  }
  counts.rollup_entries = rollups;
  db.exec('DELETE FROM journal_postings WHERE entry_id IN (SELECT id FROM _cp_entries)');
  db.exec('DELETE FROM journal_entries WHERE id IN (SELECT id FROM _cp_entries)');
  try { db.exec('DELETE FROM journal_order_credits WHERE order_id IN (SELECT id FROM _cp_orders WHERE filled=0)'); } catch { /* table missing */ }

  // Ledger: one row per account, UTC day and money epoch with the net of the removed rows (informational: the
  // statement of a system account; members are never touched).
  const lday = 'substr(l.created_at, 1, 10)';
  const lg = db.prepare(`SELECT l.user_id uid, ${lday} day, ${ledgerMarks ? 'l.money_mode mm, l.money_epoch me' : 'NULL mm, NULL me'}, SUM(l.amount_cents) s, MAX(l.created_at) at, COUNT(*) n
    FROM ledger l WHERE l.id IN (SELECT id FROM _cp_ledger) GROUP BY l.user_id, day, mm, me`).all();
  const insL = db.prepare(`INSERT INTO ledger(id,user_id,kind,amount_cents,ref,memo,created_at${ledgerMarks ? ',money_mode,money_epoch' : ''}) VALUES(?,?,?,?,?,?,?${ledgerMarks ? ',?,?' : ''})`);
  for (const g of lg) insL.run(newId('l_'), g.uid, 'compaction', g.s, g.day, `${g.n} simulated trading rows of ${g.day} compacted`, g.at, ...(ledgerMarks ? [g.mm, g.me] : []));
  counts.ledger_rollups = lg.length;
  db.exec('DELETE FROM ledger WHERE id IN (SELECT id FROM _cp_ledger)');
  db.exec('DELETE FROM orders WHERE id IN (SELECT id FROM _cp_orders WHERE filled=0)');
  db.exec('DROP TABLE temp._cp_sys; DROP TABLE temp._cp_mtrades; DROP TABLE temp._cp_keep; DROP TABLE temp._cp_orders; DROP TABLE temp._cp_trades; DROP TABLE temp._cp_entries; DROP TABLE temp._cp_ledger;');
  return counts;
}

module.exports = { compact };
