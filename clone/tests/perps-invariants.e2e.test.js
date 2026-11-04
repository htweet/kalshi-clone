'use strict';
// Security gate for Perps (PLAN Phase 6, CLONE_SPEC.md §34.11): liquidation and funding invariants under property-based
// tests, with the deterministic harness of tests/lib/property.js (seeded PRNG; a failure prints the seed and the last
// actions; PROPERTY_SEED / PROPERTY_RUNS replay or widen a run).
//   1. pure arithmetic: fills conserve PnL exactly (realized + unrealized of all parties = 0, to the unit-centicent);
//      tiered maintenance margin is continuous and non-decreasing, and the liquidation price solves equity = MM;
//   2. the live engine on a real server and SQLite file, driven by random sequences of market and limit orders, cancels,
//      amends, decreases, closes, index moves with fast gaps, funding, transfers (Predictions ↔ Perps, between
//      subaccounts), trailing stops and order groups, on isolated and portfolio (cross) subaccounts. After every action:
//        • money is conserved: the ledger audit (main journal + perps journal) balances, and an independent equation
//          over the tables holds: collateral held = money bridged in + realized PnL − fees + funding + shortfalls covered;
//        • no negative collateral anywhere (free, reserved, margin), also right after liquidations;
//        • insurance and backstop accounting balances (fund + backstop = liquidation fees − shortfalls; fund ≥ 0);
//        • every funding event sums to zero across longs and shorts; open interest is symmetric;
//        • after every mark change nothing stays open under maintenance margin (isolated per position, cross per
//          subaccount).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server/index.js');
const journal = require('../server/journal.js');
const PL = require('../server/perps-ledger.js');
const R = require('../server/perps-risk.js');
const { fillMath } = require('../server/perps.js');
const { Client } = require('./lib/client');
const { runProperty } = require('./lib/property');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-perps-inv-'));
const PW = 'Gravel-Orchid-Summit-8146';
const HIGH = { burst: 1e6, per_second: 1e6 };
const LP_FLOAT = 1e12;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
before(() => {});

// ------------------------------------------------------------------------------------------------ 1. pure arithmetic
test('fills conserve PnL exactly: realized + unrealized of all parties is zero at any mark (property, 300 seeds)', async () => {
  const stats = await runProperty('fill arithmetic', { runs: 300, base: 11 }, async (g, log) => {
    const parties = Array.from({ length: g.int(2, 5) }, () => ({ q: 0, cost: 0, margin: 0, avail: 1e15, realizedUcc: 0 }));
    for (let i = 0; i < g.int(5, 60); i++) {
      const a = g.int(0, parties.length - 1); let b = g.int(0, parties.length - 2); if (b >= a) b += 1;
      const n = g.int(1, 5000); const p = g.int(5000, 200000); const side = g.chance(0.5) ? 'bid' : 'ask';
      log('trade', { a, b, n, p, side });
      for (const [k, s] of [[a, side], [b, side === 'bid' ? 'ask' : 'bid']]) {
        const f = fillMath(parties[k], { side: s, n, p, lev: g.int(1, 20), feeRate: 0, sys: false });
        parties[k] = { ...f, realizedUcc: parties[k].realizedUcc + f.realizedUcc };
        assert.equal(f.paid * 100 + f.dust, f.realizedUcc, 'paid + dust = realized');
        assert.ok(f.dust >= 0 && f.dust < 100, 'dust in [0, 100)');
        assert.ok(f.cost >= 0 && f.margin >= 0, 'cost and margin non-negative');
        if (f.q === 0) assert.equal(f.cost, 0, 'a flat position has no cost basis');
      }
      const mark = g.int(1000, 300000);
      assert.equal(parties.reduce((x, s) => x + s.q, 0), 0, 'open interest pairs');
      const total = parties.reduce((x, s) => x + s.realizedUcc + (s.q * mark - (s.q > 0 ? s.cost : -s.cost)), 0);
      assert.equal(total, 0, `PnL not conserved at mark ${mark}: ${total}`);
    }
  });
  assert.equal(stats.runs, 300);
});

test('tiered maintenance margin is continuous and non-decreasing; the liquidation price solves equity = MM (property)', async () => {
  await runProperty('tiers and liquidation price', { runs: 300, base: 23 }, async (g, log) => {
    const k = g.int(1, 5); let cap = 0; let im = 0;
    const tiers = [];
    for (let i = 0; i < k; i++) { cap += g.int(1, 400000) * 10000; im = Math.min(1, im + g.float(0.01, 0.3)); tiers.push({ tier: i + 1, max_notional_cc: cap, initial_rate: im, maintenance_rate: im / g.float(1.2, 3) }); }
    for (let i = 1; i < tiers.length; i++) tiers[i].maintenance_rate = Math.max(tiers[i].maintenance_rate, tiers[i - 1].maintenance_rate);
    log('tiers', tiers.map((t) => [t.max_notional_cc, t.maintenance_rate.toFixed(4)]));
    let prev = -1;
    for (let N = 0; N <= cap * 1.2; N += cap / 97) { const v = R.mm(tiers, N); assert.ok(v >= prev - 1e-6, 'non-decreasing'); prev = v; }
    for (const t of tiers) { const e = 1e-3; assert.ok(Math.abs(R.mm(tiers, t.max_notional_cc + e) - R.mm(tiers, t.max_notional_cc - e)) < 1e-2, 'continuous at a tier edge'); }
    const q = g.chance(0.5) ? g.int(100, 100000) : -g.int(100, 100000);
    const entry = g.int(1000, 200000);
    const margin = Math.round((Math.abs(q) * entry) / 100 / g.float(1, 25));
    const A = margin - (q * entry) / 100;
    const liq = R.liqPrice(tiers, q, A, 0);
    log('position', { q, entry, margin, liq });
    if (liq == null) return; // no positive solution (e.g. a 1x long)
    const eq = (m) => A + (q * m) / 100;
    const mmAt = (m) => R.mm(tiers, (Math.abs(q) * m) / 100);
    assert.ok(Math.abs(eq(liq) - mmAt(liq)) <= Math.abs(q) / 100 + 1, `equity ${eq(liq)} vs MM ${mmAt(liq)} at ${liq}`);
    const away = q > 0 ? liq * 1.01 + 1 : liq * 0.99 - 1; const through = q > 0 ? liq * 0.99 - 1 : liq * 1.01 + 1;
    if (away > 0) assert.ok(eq(away) >= mmAt(away), 'safe on the profitable side of the liquidation price');
    if (through > 0) assert.ok(eq(through) < mmAt(through), 'liquidatable beyond it');
  });
});

// ------------------------------------------------------------------------------------------------ 2. the live engine
const MARKETS = [['PLXBTCPERP', 100000, 0.0001], ['PLXETHPERP', 3500, 0.001]];
function invariants(srv, { afterMarkMove = false } = {}) {
  const db = srv.db;
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  // (a) the ledger audit: main journal + perps journal (balanced entries, tables = postings, bridge, PnL conservation).
  const a = journal.audit(db);
  assert.ok(a.ok, `ledger audit: ${JSON.stringify(a.problems.slice(0, 4))}`);
  // (b) an independent conservation equation over the tables.
  const holdings = q('SELECT COALESCE(SUM(available_cc),0) c FROM perp_accounts').c + q('SELECT COALESCE(SUM(available_cc),0) c FROM perp_subaccounts').c
    + q('SELECT COALESCE(SUM(reserved_cc),0) c FROM perp_orders').c + q('SELECT COALESCE(SUM(margin_cc),0) c FROM perp_positions').c;
  const bridged = 100 * journal.balanceOf(db, 'perps:collateral') + LP_FLOAT;
  const flows = q('SELECT COALESCE(SUM(realized_cc),0) c FROM perp_fills').c - q('SELECT COALESCE(SUM(fee_cc),0) c FROM perp_fills').c
    + q('SELECT COALESCE(SUM(amount_cc),0) c FROM perp_funding_payments').c + Number(q("SELECT value FROM perp_meta WHERE key='insurance_shortfall_cc'")?.value || 0);
  assert.equal(holdings, bridged + flows, 'collateral held = bridged in + realized − fees + funding + shortfalls covered');
  // (c) no negative collateral.
  for (const [t, col] of [['perp_accounts', 'available_cc'], ['perp_subaccounts', 'available_cc'], ['perp_orders', 'reserved_cc'], ['perp_positions', 'margin_cc'], ['perp_positions', 'cost_ucc']]) assert.equal(q(`SELECT COUNT(*) c FROM ${t} WHERE ${col}<0`).c, 0, `negative ${t}.${col}`);
  // (d) insurance / backstop.
  const ins = PL.balanceOf(db, PL.H.insurance); const back = PL.balanceOf(db, PL.H.backstop);
  assert.ok(ins >= 0, 'insurance fund never below zero');
  assert.ok(back <= 0, 'the backstop only pays');
  assert.equal(ins + back, q('SELECT COALESCE(SUM(fee_cc),0) c FROM perp_liquidations').c - Number(q("SELECT value FROM perp_meta WHERE key='insurance_shortfall_cc'")?.value || 0), 'insurance + backstop = liquidation fees − shortfalls');
  // (e) funding is zero-sum per event; open interest is symmetric.
  const bad = q('SELECT ticker, funding_ts, SUM(amount_cc) s FROM perp_funding_payments GROUP BY ticker, funding_ts HAVING s<>0 LIMIT 1');
  assert.equal(bad, undefined, `funding event not zero-sum: ${JSON.stringify(bad)}`);
  assert.equal(PL.balanceOf(db, PL.H.funding), 0);
  for (const r of db.prepare('SELECT ticker, SUM(qty) s FROM perp_positions GROUP BY ticker').all()) assert.equal(r.s, 0, `open interest of ${r.ticker}`);
  // (f) after a mark change nothing stays open under maintenance margin.
  if (afterMarkMove) {
    const markOf = (t) => { const m = q('SELECT index_price, contract_size FROM perp_markets WHERE ticker=?', t); return Math.max(1, Math.round(m.index_price * m.contract_size * 10000)); };
    const tiers = (t) => db.prepare('SELECT * FROM perp_margin_tiers WHERE ticker=? ORDER BY tier').all(t);
    const lp = q("SELECT id FROM users WHERE email='liquidity@parlance.local'").id;
    const mode = (u, s) => q('SELECT margin_mode FROM perp_subaccounts WHERE user_id=? AND subaccount=?', u, s)?.margin_mode || 'isolated';
    const subs = new Map();
    for (const p of db.prepare('SELECT * FROM perp_positions WHERE qty<>0 AND user_id<>?').all(lp)) {
      const mk = markOf(p.ticker);
      const eq = p.margin_cc + (p.qty * mk - (p.qty > 0 ? p.cost_ucc : -p.cost_ucc)) / 100;
      const mm = R.mm(tiers(p.ticker), (Math.abs(p.qty) * mk) / 100);
      if (mode(p.user_id, p.subaccount) === 'isolated') assert.ok(eq >= mm - 1e-6, `isolated position under maintenance: ${p.ticker} eq ${eq} mm ${mm}`);
      else { const k = `${p.user_id}:${p.subaccount}`; const x = subs.get(k) || { eq: 0, mm: 0, uid: p.user_id, sub: p.subaccount }; x.eq += eq; x.mm += mm; subs.set(k, x); }
    }
    for (const x of subs.values()) {
      const free = (x.sub ? q('SELECT available_cc c FROM perp_subaccounts WHERE user_id=? AND subaccount=?', x.uid, x.sub).c : q('SELECT available_cc c FROM perp_accounts WHERE user_id=?', x.uid).c)
        + q("SELECT COALESCE(SUM(reserved_cc),0) c FROM perp_orders WHERE user_id=? AND subaccount=? AND status='resting'", x.uid, x.sub).c;
      assert.ok(free + x.eq >= x.mm - 1e-6, `portfolio subaccount under maintenance: equity ${free + x.eq} mm ${x.mm}`);
    }
  }
}

test('engine: random trading, gaps, funding, liquidations, transfers and triggers keep every money invariant (property, live server)', async () => {
  let n = 0;
  const coverage = [];
  const stats = await runProperty('perps engine invariants', { runs: 5, base: 0xbeef }, async (g, log) => {
    n += 1;
    const dbFile = path.join(TMP, `inv-${n}.db`);
    const srv = await start({ port: 0, dbFile, tickMs: 3600000, quiet: true, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const P = srv.engine.perps;
      for (const [t, lvl] of MARKETS) P.setIndex(t, lvl, { freeze: true });
      const users = [];
      for (let i = 0; i < 4; i++) {
        const c = await new Client(base, `u${i}`).signUp(`inv${n}.u${i}.${Date.now()}@example.test`, PW, `Invariant User ${i}`);
        assert.equal((await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: 3000 })).status, 201);
        assert.equal((await c.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: g.int(200, 1500) })).status, 201);
        // Subaccount 1: portfolio margin for half the users, isolated for the rest, funded from the primary.
        assert.equal((await c.call('POST', '/v1/perps/subaccounts', { name: `Book ${i}`, margin_mode: i % 2 ? 'cross' : 'isolated' })).status, 201);
        assert.equal((await c.call('POST', '/v1/perps/subaccounts/transfers', { from_subaccount: 0, to_subaccount: 1, amount_dollars: 100 })).status, 201);
        users.push(c);
      }
      invariants(srv);
      const levels = new Map(MARKETS.map(([t, l]) => [t, l]));
      const markDollars = (t) => Number(P.market(t).index_price) * MARKETS.find((m) => m[0] === t)[2];
      const expected = (e) => e && (e.status >= 400 && e.status < 500); // business refusals are fine; anything else fails
      const tryIt = async (what, fn) => { try { await fn(); } catch (e) { if (!expected(e)) throw new Error(`${what}: ${e.stack || e.message}`); log('refused', e.code); } };
      for (let step = 0; step < 110; step++) {
        const u = g.pick(users); const sub = g.int(0, 1); const [t] = g.pick(MARKETS);
        const action = g.weighted([[30, 'market'], [15, 'limit'], [7, 'cancel'], [6, 'amend'], [4, 'decrease'], [6, 'close'], [14, 'move'], [5, 'funding'], [4, 'in'], [3, 'out'], [3, 'subx'], [3, 'trail'], [2, 'group']]);
        let moved = false;
        if (action === 'market' || action === 'limit') {
          // Subaccount 1 trades bigger and with more leverage, so portfolio (cross) liquidations are reached too.
          const body = { ticker: t, side: g.chance(0.5) ? 'bid' : 'ask', type: action, count: g.int(1, sub ? 1500 : 400) / 100, leverage: sub ? g.int(5, 15) : g.int(1, 12), subaccount: sub };
          if (action === 'limit') body.price = (markDollars(t) * (1 + g.float(-0.006, 0.006))).toFixed(4);
          log(action, body);
          await tryIt(action, () => P.placeOrder(u.uid, body, { source: 'user' }));
        } else if (action === 'cancel' || action === 'amend' || action === 'decrease') {
          const o = srv.db.prepare("SELECT * FROM perp_orders WHERE user_id=? AND status='resting' ORDER BY rowid").all(u.uid);
          if (!o.length) continue;
          const x = g.pick(o);
          log(action, { id: x.id.slice(-6), remaining: x.remaining_count });
          if (action === 'cancel') await tryIt('cancel', () => P.cancelOrder(u.uid, x.id));
          else if (action === 'amend') await tryIt('amend', () => P.amendOrder(u.uid, x.id, { price: ((x.price_cc / 10000) * (1 + g.float(-0.003, 0.003))).toFixed(4), count: (g.int(1, 400) / 100).toFixed(2) }));
          else await tryIt('decrease', () => P.decreaseOrder(u.uid, x.id, { reduce_to: (Math.floor((x.remaining_count * g.float(0, 1)) / 1) / 100).toFixed(2) }));
        } else if (action === 'close') {
          const p = srv.db.prepare('SELECT * FROM perp_positions WHERE user_id=? AND qty<>0').all(u.uid);
          if (!p.length) continue;
          const x = g.pick(p);
          log('close', { ticker: x.ticker, sub: x.subaccount });
          await tryIt('close', async () => { const r = await u.call('POST', `/v1/perps/positions/${x.ticker}/close`, { percent: g.pick([25, 50, 100]), subaccount: x.subaccount }); if (r.status >= 500) throw new Error(r.text); });
        } else if (action === 'move') {
          const f = g.weighted([[6, g.float(-0.006, 0.006)], [3, g.float(-0.04, 0.04)], [2, g.float(-0.15, 0.15)], [1, g.float(-0.25, 0.25)]]);
          const lvl = Math.max(1, levels.get(t) * (1 + f));
          levels.set(t, lvl);
          log('move', { t, f: f.toFixed(4) });
          P.setIndex(t, lvl, { freeze: true });
          moved = true;
        } else if (action === 'funding') {
          log('funding', t);
          P.runFunding(t);
          P.tick(); // the scheduler's liquidation check after funding
          moved = true;
        } else if (action === 'in' || action === 'out') {
          const amt = g.int(1, 200);
          log(action, { amt, sub });
          const r = await u.call('POST', '/v1/perps/transfers', { direction: action === 'in' ? 'to_perps' : 'to_predictions', amount_dollars: amt, subaccount: sub });
          assert.ok(r.status === 201 || (r.status === 409 && /insufficient/.test(r.code)), r.text);
        } else if (action === 'subx') {
          const amt = g.int(1, 150);
          log('subx', { amt, from: sub });
          const r = await u.call('POST', '/v1/perps/subaccounts/transfers', { from_subaccount: sub, to_subaccount: 1 - sub, amount_dollars: amt });
          assert.ok(r.status === 201 || (r.status === 409 && r.code === 'insufficient_margin'), r.text);
        } else if (action === 'trail') {
          const p = srv.db.prepare('SELECT * FROM perp_positions WHERE user_id=? AND qty<>0').all(u.uid);
          if (!p.length) continue;
          const x = g.pick(p);
          log('trail', { ticker: x.ticker, sub: x.subaccount });
          const r = await u.call('PUT', `/v1/perps/positions/${x.ticker}/exit_trigger`, { kind: 'trailing', trail_percent: g.pick([0.5, 1, 2, 5]), subaccount: x.subaccount });
          assert.equal(r.status, 200, r.text);
        } else if (action === 'group') {
          log('group', { sub });
          const r = await u.call('POST', '/v1/perps/order_groups', { kind: g.pick(['oco', 'limit']), contracts_limit: 1, subaccount: sub });
          if (r.status !== 201) continue;
          for (let k = 0; k < 2; k++) await tryIt('group order', () => P.placeOrder(u.uid, { ticker: t, side: k ? 'ask' : 'bid', type: 'limit', price: (markDollars(t) * (k ? 1.004 : 0.996)).toFixed(4), count: 1, leverage: 3, subaccount: sub, order_group_id: r.body.order_group_id }, { source: 'user' }));
        }
        invariants(srv, { afterMarkMove: moved });
      }
      const cov = { liquidations: srv.db.prepare('SELECT COUNT(*) c FROM perp_liquidations').get().c, cross_liquidations: srv.db.prepare("SELECT COUNT(*) c FROM perp_liquidations WHERE margin_mode='cross'").get().c,
        fills: srv.db.prepare('SELECT COUNT(*) c FROM perp_fills').get().c, funding: srv.db.prepare('SELECT COUNT(*) c FROM perp_funding_payments').get().c,
        trailing_fired: srv.db.prepare("SELECT COUNT(*) c FROM perp_exit_triggers WHERE kind='trailing' AND status='filled'").get().c, shortfalls: Number(srv.db.prepare("SELECT value FROM perp_meta WHERE key='insurance_shortfall_cc'").get()?.value || 0) };
      log('done', cov);
      coverage.push(cov);
      if (process.env.PROPERTY_VERBOSE) console.log(JSON.stringify({ seed: g.seed, ...cov }));
    } finally { await srv.close(); }
  });
  assert.ok(stats.runs >= 1);
  // The runs really exercised the risky paths (not only refusals).
  const sum = (k) => coverage.reduce((a, c) => a + c[k], 0);
  assert.ok(sum('fills') > 100 && sum('liquidations') > 0 && sum('funding') > 0 && sum('trailing_fired') > 0, JSON.stringify(coverage)); // cross liquidations: the targeted case below
});

test('engine: targeted gaps: an isolated shortfall never touches other collateral; a portfolio subaccount liquidates on its MM', async () => {
  // A targeted case next to the random runs: an isolated position gapped far through its bankruptcy price.
  const srv = await start({ port: 0, dbFile: path.join(TMP, 'gap.db'), tickMs: 3600000, quiet: true, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const P = srv.engine.perps;
    P.setIndex('PLXBTCPERP', 100000, { freeze: true });
    const c = await new Client(base, 'gap').signUp(`gap.${Date.now()}@example.test`, PW, 'Gap Trader');
    assert.equal((await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: 2000 })).status, 201);
    assert.equal((await c.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 1000 })).status, 201);
    assert.equal((await c.call('POST', '/v1/perps/orders', { ticker: 'PLXBTCPERP', side: 'bid', type: 'market', count: 100, leverage: 20 })).status, 201);
    const free = srv.db.prepare('SELECT available_cc c FROM perp_accounts WHERE user_id=?').get(c.uid).c;
    P.setIndex('PLXBTCPERP', 80000, { freeze: true }); // -20%: margin of 5% is gone four times over
    const l = srv.db.prepare('SELECT * FROM perp_liquidations WHERE user_id=?').get(c.uid);
    assert.ok(l && l.shortfall_cc > 0, 'a shortfall was covered');
    assert.equal(l.returned_cc, 0);
    assert.equal(srv.db.prepare('SELECT available_cc c FROM perp_accounts WHERE user_id=?').get(c.uid).c, free, 'free collateral untouched by an isolated loss');
    assert.ok(PL.balanceOf(srv.db, PL.H.backstop) < 0, 'the empty insurance fund passed the loss to the backstop');
    invariants(srv, { afterMarkMove: true });
    // Portfolio (cross) subaccount gapped through: its free collateral and the other position's margin absorb the loss
    // before the fund does; afterwards the subaccount is above maintenance or flat, never negative.
    P.setIndex('PLXBTCPERP', 100000, { freeze: true }); P.setIndex('PLXETHPERP', 3500, { freeze: true });
    assert.equal((await c.call('POST', '/v1/perps/subaccounts', { name: 'Cross', margin_mode: 'cross' })).status, 201);
    assert.equal((await c.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 300, subaccount: 1 })).status, 201);
    assert.equal((await c.call('POST', '/v1/perps/orders', { ticker: 'PLXBTCPERP', side: 'bid', type: 'market', count: 150, leverage: 10, subaccount: 1 })).status, 201);
    assert.equal((await c.call('POST', '/v1/perps/orders', { ticker: 'PLXETHPERP', side: 'ask', type: 'market', count: 100, leverage: 5, subaccount: 1 })).status, 201);
    for (const lvl of [90000, 84000, 82000]) { P.setIndex('PLXBTCPERP', lvl, { freeze: true }); invariants(srv, { afterMarkMove: true }); }
    const cl = srv.db.prepare("SELECT * FROM perp_liquidations WHERE user_id=? AND margin_mode='cross'").all(c.uid);
    assert.ok(cl.length >= 1 && cl[0].ticker === 'PLXBTCPERP', JSON.stringify(cl));
    assert.ok(srv.db.prepare('SELECT available_cc c FROM perp_subaccounts WHERE user_id=? AND subaccount=1').get(c.uid).c >= 0);
  } finally { await srv.close(); }
});
