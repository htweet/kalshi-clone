'use strict';
// Running market volume (soak finding 2026-11-13; CLONE_SPEC.md §39.20, migration 0004), real server + SQLite + Chromium:
//   • a market's volume, dollar volume and rolling 24-hour volume are kept by triggers on `trades` and always equal a full
//     recount of its trades, after inserts, price fills by the cc trigger, updates and deletes (every writer is covered);
//   • quote() no longer reads the market's whole history: with 300,000 trades in one market it stays fast (the old code
//     summed every trade on each order, so each order got slower as the market traded);
//   • the event page of that market renders in the browser without errors.
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
