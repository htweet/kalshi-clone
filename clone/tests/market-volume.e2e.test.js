'use strict';
// Running market volume (soak finding 2026-11-13; CLONE_SPEC.md §39.20, migration 0004), real server + SQLite + Chromium:
//   • a market's volume, dollar volume and rolling 24-hour volume are kept by triggers on `trades` and always equal a full
//     recount of its trades, after inserts, price fills by the cc trigger, updates and deletes (every writer is covered);
//   • quote() no longer reads the market's whole history: with 300,000 trades in one market it stays fast (the old code
//     summed every trade on each order, so each order got slower as the market traded);
//   • the event page of that market renders in the browser without errors;
//   • the order book's price levels (migration 0005, soak finding 2026-11-15) always equal a full recount of resting
//     orders after member orders (resting, crossing, partial fills), amendments, decreases, cancels, expiry and a direct
//     delete; engine.book() stays fast with 50,000 resting orders in one market (it summed them all, twice per order);
//     the order book the browser shows matches the recount;
//   • resting orders are read in index order (migration 0014): matching, queue position and a member's reserved total
//     stay fast with 60,000 resting orders at one price (matching read and sorted all of them).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-volume-'));
const PW = 'Kaduna-Basalt-Ferry-2083';
const HIGH = { burst: 1e6, per_second: 1e6 };
let srv; let browser; let T; let BASE;

before(async () => {
  srv = await start({ port: 0, dbFile: path.join(TMP, 'v.db'), quiet: true, sports: false, tickMs: 500, admin: { email: `root.${Date.now()}@example.test`, password: PW }, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } });
  BASE = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
  T = srv.db.prepare("SELECT m.ticker, e.ticker ev, e.series_ticker st, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.status='active' AND e.series_ticker NOT LIKE 'PLXFLASH%' AND e.series_ticker<>'PLXCOMBO' ORDER BY m.rowid LIMIT 1").get();
});
after(async () => {
  try { await browser?.close(); } catch { /* closed */ }
  try { await srv?.close(); } catch { /* closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const recount = (t) => {
  const d = srv.db; const dayAgo = Date.now() - 86400000;
  return {
    vol: d.prepare('SELECT COALESCE(SUM(count),0) v FROM trades WHERE market_ticker=?').get(t).v,
    dvol: d.prepare('SELECT COALESCE(SUM(count*yes_price_cc),0) v FROM trades WHERE market_ticker=?').get(t).v,
    vol24: d.prepare('SELECT COALESCE(SUM(count),0) v FROM trades WHERE market_ticker=? AND created_ts>?').get(t, dayAgo).v,
  };
};

test('running totals equal a full recount after inserts (incl. the cc price trigger), updates and deletes, across the 24-hour edge', () => {
  const d = srv.db; const now = Date.now(); const H = 3600000;
  const ins = d.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,count,taker_side,created_ts) VALUES(?,?,?,?,?,?)');
  d.exec('BEGIN');
  // Around the 24-hour edge (inside and outside the partial hour), older history and recent trades; yes_price_cc filled by the trigger.
  for (let i = 0; i < 400; i++) ins.run(`vt_${i}`, T.ticker, 10 + (i % 80), 100 + (i % 7) * 100, i % 2 ? 'yes' : 'no', now - 86400000 + (i - 200) * 30000);
  for (let i = 0; i < 200; i++) ins.run(`vh_${i}`, T.ticker, 40, 300, 'yes', now - 3 * 86400000 - i * H);
  for (let i = 0; i < 200; i++) ins.run(`vn_${i}`, T.ticker, 55, 200, 'no', now - i * 60000);
  d.exec('COMMIT');
  const q = srv.engine.quote(T.ticker); const r = recount(T.ticker);
  assert.equal(q.volume, r.vol, 'volume'); assert.equal(q.volume_24h, r.vol24, '24-hour volume');
  const tot = d.prepare('SELECT * FROM market_volume WHERE market_ticker=?').get(T.ticker);
  assert.equal(tot.dollar_volume_cc, r.dvol, 'dollar volume (count × YES price in cc)');
  // An update (count and price) and a delete keep them equal.
  d.prepare("UPDATE trades SET count=count*2, yes_price_cc=yes_price_cc+100 WHERE id IN ('vt_10','vn_3')").run();
  d.prepare("DELETE FROM trades WHERE id IN ('vt_250','vh_7')").run();
  const q2 = srv.engine.quote(T.ticker); const r2 = recount(T.ticker);
  assert.equal(q2.volume, r2.vol); assert.equal(q2.volume_24h, r2.vol24);
  assert.equal(d.prepare('SELECT dollar_volume_cc v FROM market_volume WHERE market_ticker=?').get(T.ticker).v, r2.dvol);
  const hourly = d.prepare('SELECT COALESCE(SUM(volume_units),0) v FROM market_volume_hourly WHERE market_ticker=?').get(T.ticker).v;
  assert.equal(hourly, r2.vol, 'the hourly buckets add up to the total');
});

test('quote() stays fast with 300,000 trades in one market (it no longer reads the whole history); the event page renders', async () => {
  const d = srv.db; const now = Date.now();
  const ins = d.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,yes_price_cc,count,taker_side,created_ts) VALUES(?,?,?,?,?,?,?)');
  d.exec('BEGIN');
  for (let i = 0; i < 300000; i++) ins.run(`big_${i}`, T.ticker, 50, 5000, 100, 'yes', now - (i % 72) * 1200000 - (i % 997));
  d.exec('COMMIT');
  srv.engine.quote(T.ticker); // warm the statements
  const times = [];
  for (let i = 0; i < 15; i++) { const s = process.hrtime.bigint(); srv.engine.quote(T.ticker); times.push(Number(process.hrtime.bigint() - s) / 1e6); }
  times.sort((a, b) => a - b);
  const median = times[7];
  const r = recount(T.ticker); const q = srv.engine.quote(T.ticker);
  assert.equal(q.volume, r.vol); assert.equal(q.volume_24h, r.vol24);
  assert.ok(median < 25, `quote() took ${median.toFixed(1)} ms (median of 15) with 300,000 trades in the market`);
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/markets/${T.st.toLowerCase()}/${T.slug}/${T.ev.toLowerCase()}`);
  await page.waitForSelector('[data-testid=event-title]');
  const api = await (await fetch(`${BASE}/trade-api/v2/markets/${T.ticker}`)).json();
  assert.ok(Number(api.market.volume_fp) > 0, JSON.stringify(api.market).slice(0, 200));
  assert.deepEqual(errors, []);
  await page.close();
});

const bookRecount = (t) => {
  const b = { yes: {}, no: {} };
  for (const r of srv.db.prepare("SELECT side, price_cc p, SUM(remaining_count) c FROM orders WHERE market_ticker=? AND status='resting' GROUP BY side, price_cc HAVING c<>0").all(t)) b[r.side][r.p] = r.c;
  return b;
};
const bookNow = (t) => { const b = srv.engine.book(t); return { yes: Object.fromEntries(b.yes), no: Object.fromEntries(b.no) }; };

test('order-book levels equal a full recount after orders, fills, amendments, decreases, cancels, expiry and deletes; book() stays fast with 50,000 resting orders', async () => {
  const d = srv.db; const e = srv.engine;
  const M = d.prepare("SELECT m.ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status='active' AND m.ticker<>? AND e.series_ticker NOT LIKE 'PLXFLASH%' AND e.series_ticker<>'PLXCOMBO' ORDER BY m.rowid LIMIT 1").get(T.ticker).ticker;
  const users = [];
  for (let i = 0; i < 4; i++) {
    const id = `u_book_${i}`;
    d.prepare('INSERT INTO users(id,email,password_hash,display_name,created_at) VALUES(?,?,?,?,?)').run(id, `book${i}.${Date.now()}@example.test`, 'x', `Book ${i}`, new Date().toISOString());
    e.credit(id, 50_000_000, 'deposit', null, 'book test');
    users.push(id);
  }
  const placed = [];
  for (let i = 0; i < 120; i++) {
    const u = users[i % users.length]; const side = i % 2 ? 'yes' : 'no';
    const r = e.placeOrder(u, { ticker: M, side, price: 30 + ((i * 7) % 40), count: (1 + (i % 5)) * 100, expiration_ts: i % 17 === 0 ? Date.now() + 50 : null });
    if (r && r.status === 'resting') placed.push([u, r.id]);
  }
  assert.ok(placed.length > 10, `resting orders: ${placed.length}`);
  assert.deepEqual(bookNow(M), bookRecount(M), 'after placing and crossing');
  for (const [u, id] of placed.slice(0, 5)) { try { e.amendOrder(u, id, { price: 25 }); } catch { /* filled meanwhile */ } }
  for (const [u, id] of placed.slice(5, 10)) { try { e.decreaseOrder(u, id, 100); } catch { /* filled meanwhile */ } }
  for (const [u, id] of placed.slice(10, 15)) { try { e.cancelOrder(u, id); } catch { /* filled meanwhile */ } }
  assert.deepEqual(bookNow(M), bookRecount(M), 'after amendments, decreases and cancels');
  await new Promise((r) => setTimeout(r, 120));
  e.expireOrders();
  d.prepare("DELETE FROM orders WHERE id=(SELECT id FROM orders WHERE market_ticker=? AND status='resting' LIMIT 1)").run(M);
  assert.deepEqual(bookNow(M), bookRecount(M), 'after expiry and a direct delete');
  assert.equal(d.prepare('SELECT COUNT(*) c FROM book_levels WHERE units=0').get().c, 0, 'empty levels are removed');
  // 50,000 resting orders in one market (inserted directly: a large, long-lived book).
  const ins = d.prepare("INSERT INTO orders(id,seq,user_id,market_ticker,side,price_cents,price_cc,initial_count,remaining_count,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'resting',?,?)");
  d.exec('BEGIN');
  for (let i = 0; i < 50000; i++) { const p = 2 + (i % 20); ins.run(`bk_${i}`, 10_000_000 + i, users[i % 4], M, i % 2 ? 'yes' : 'no', p, p * 100, 100, 100, new Date().toISOString(), new Date().toISOString()); }
  d.exec('COMMIT');
  assert.deepEqual(bookNow(M), bookRecount(M), 'with 50,000 resting orders');
  e.book(M);
  const times = [];
  for (let i = 0; i < 15; i++) { const s = process.hrtime.bigint(); e.book(M); e.quote(M); times.push(Number(process.hrtime.bigint() - s) / 1e6); }
  times.sort((a, b) => a - b);
  assert.ok(times[7] < 10, `book() + quote() took ${times[7].toFixed(1)} ms (median) with 50,000 resting orders`);
  // The order book in the browser matches the recount.
  const ev = d.prepare('SELECT e.ticker ev, e.series_ticker st, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.ticker=?').get(M);
  const api = await (await fetch(`${BASE}/trade-api/v2/markets/${M}/orderbook`)).json();
  const rc = bookRecount(M);
  const apiYes = Object.fromEntries((api.orderbook_fp?.yes_dollars || api.orderbook?.yes_dollars || []).map(([p, c]) => [Math.round(Number(p) * 10000), Math.round(Number(c) * 100)]));
  for (const [p, c] of Object.entries(rc.yes)) if (apiYes[p] != null) assert.equal(apiYes[p], c, `yes level ${p}`);
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', (er) => errors.push(er.message));
  await page.goto(`${BASE}/markets/${ev.st.toLowerCase()}/${ev.slug}/${ev.ev.toLowerCase()}`);
  await page.waitForSelector('[data-testid=event-title]');
  assert.deepEqual(errors, []);
  await page.close();
});

test('resting orders are read in index order: matching, queue position and the reserved total stay fast with 60,000 resting orders at one price', () => {
  // Migration 0014 (one-hour soak 2026-11-16): matching read and sorted every crossing resting order before using the
  // first; the queue position and a member's reserved total looked up every resting row in the table.
  const d = srv.db; const e = srv.engine;
  const M = d.prepare("SELECT m.ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status='active' AND e.series_ticker NOT LIKE 'PLXFLASH%' AND e.series_ticker<>'PLXCOMBO' ORDER BY m.rowid DESC LIMIT 1").get().ticker;
  const users = [];
  for (let i = 0; i < 4; i++) {
    const id = `u_idx_${i}`;
    d.prepare('INSERT INTO users(id,email,password_hash,display_name,created_at) VALUES(?,?,?,?,?)').run(id, `idx${i}.${Date.now()}@example.test`, 'x', `Idx ${i}`, new Date().toISOString());
    e.credit(id, 50_000_000, 'deposit', null, 'index test');
    users.push(id);
  }
  const ins = d.prepare("INSERT INTO orders(id,seq,user_id,market_ticker,side,price_cents,price_cc,initial_count,remaining_count,reserved_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'resting',?,?)");
  d.exec('BEGIN');
  for (let i = 0; i < 60000; i++) ins.run(`ix_${i}`, 20_000_000 + i, users[1 + (i % 3)], M, 'no', 40, 4000, 100, 100, 1, new Date().toISOString(), new Date().toISOString());
  d.exec('COMMIT');
  const med = (fn) => { const t = []; for (let i = 0; i < 7; i++) { const s = process.hrtime.bigint(); fn(i); t.push(Number(process.hrtime.bigint() - s) / 1e6); } return t.sort((a, b) => a - b)[3]; };
  const fill = med(() => { const r = e.placeOrder(users[0], { ticker: M, side: 'yes', price: 61, count: 100 }); assert.equal(r.status, 'executed'); });
  assert.ok(fill < 25, `a one-contract order crossing 60,000 resting orders took ${fill.toFixed(1)} ms (median)`);
  const last = d.prepare("SELECT * FROM orders WHERE id='ix_59999'").get();
  const qp = med(() => e.queuePosition(last));
  assert.equal(e.queuePosition(last), d.prepare("SELECT SUM(remaining_count) n FROM orders WHERE market_ticker=? AND status='resting' AND side='no' AND price_cc=4000 AND seq<?").get(M, last.seq).n);
  const res = med(() => d.prepare("SELECT COALESCE(SUM(reserved_cents),0) c FROM orders WHERE user_id=? AND status='resting'").get(users[1]).c);
  assert.ok(qp < 12, `queue position behind 60,000 orders took ${qp.toFixed(1)} ms (median)`);
  assert.ok(res < 6, `a member's reserved total over 20,000 resting orders took ${res.toFixed(1)} ms (median)`);
  d.exec("DELETE FROM orders WHERE id LIKE 'ix_%'");
});

