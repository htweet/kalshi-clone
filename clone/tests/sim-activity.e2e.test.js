'use strict';
// Simulated trading activity (owner setting `simulation.activity`, database growth fix, CLONE_SPEC.md §39.17), real
// server with the simulated sports markets, Chromium for Admin › Owner settings, no network:
//   • the recommended default is "low", with its CMS explanation in Admin › Owner settings;
//   • switching to "normal" in the UI raises the liquidity accounts' write rate at once, back to "low" cuts it by at least
//     10× while prices still move (reference trades keep printing), "off" stops it; every change has a reason and is audited;
//   • the choice survives a restart.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-activity-'));
const DB_FILE = path.join(TMP, 'a.db');
const PW = 'Benue-Copper-Halyard-6604';
const HIGH = { burst: 1e6, per_second: 1e6 };
const ADMIN = { email: `root.${Date.now()}@example.test`, password: PW };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const q1 = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
let srv; let browser; let page; let BASE; let OPTS;

// Rows the system accounts write in `ms` on the simulated markets: orders, reference trades, journal entries.
async function rate(ms) {
  // The simulated sports markets (the re-quoting liquidity accounts' markets).
  const sim = '(SELECT market_ticker FROM sports_markets UNION SELECT market_ticker FROM sports_lines)';
  const sysOrders = `SELECT COUNT(*) c FROM orders WHERE user_id IN (SELECT id FROM users WHERE is_system=1) AND market_ticker IN ${sim}`;
  const sysEntries = "SELECT COUNT(*) c FROM journal_entries WHERE user_id IN (SELECT id FROM users WHERE is_system=1) AND kind<>'opening_balance'";
  const trades = `SELECT COUNT(*) c FROM trades WHERE created_ts>? AND market_ticker IN ${sim}`;
  const t0 = Date.now(); const o0 = q1(sysOrders).c; const e0 = q1(sysEntries).c;
  await sleep(ms);
  return { orders: q1(sysOrders).c - o0, entries: q1(sysEntries).c - e0, trades: q1(trades, t0).c };
}
async function setActivity(value) {
  await page.goto(`${BASE}/admin/owner_settings`);
  await page.click('[data-testid=owner-setting][data-key="simulation.activity"] [data-testid=owner-edit]');
  await page.waitForSelector('[data-testid=owner-form]');
  await page.selectOption('[data-testid=owner-form] [name=value]', value);
  await page.fill('[data-testid=owner-form] [name=reason]', `activity ${value} for the e2e`);
  await page.click('[data-testid=owner-form] button[type=submit]');
  await page.waitForSelector(`[data-testid=owner-setting][data-key="simulation.activity"][data-value="${value}"]`);
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  OPTS = { port, dbFile: DB_FILE, quiet: true, tickMs: 250, sports: { speed: 20 }, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } };
  srv = await start(OPTS);
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/sign-in`);
  await page.fill('input[name=email]', ADMIN.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
});
after(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await srv?.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Admin › Owner settings: low by default; normal, low and off change the write rate live; the choice survives a restart', async () => {
  await page.goto(`${BASE}/admin/owner_settings`);
  const row = '[data-testid=owner-setting][data-key="simulation.activity"]';
  await page.waitForSelector(row);
  assert.equal(await page.getAttribute(row, 'data-value'), 'low', 'low is the default');
  assert.match(await page.textContent(`${row} [data-testid=owner-help]`), /reference trade/);
  assert.equal(await page.getAttribute(`${row} [data-testid=owner-recommended]`, 'data-default'), 'low');
  await sleep(3000); // the simulation starts its games
  await setActivity('normal');
  await sleep(1000);
  const normal = await rate(20000);
  assert.ok(normal.orders > 100 && normal.trades > 20, `normal writes a lot: ${JSON.stringify(normal)}`);
  await setActivity('low');
  await sleep(1000);
  const low = await rate(20000);
  assert.ok(low.orders * 10 <= normal.orders && low.entries * 10 <= normal.entries, `low cuts the writes at least 10×: normal ${JSON.stringify(normal)}, low ${JSON.stringify(low)}`);
  assert.ok(low.trades > 0, `prices still move at low (reference trades): ${JSON.stringify(low)}`);
  await setActivity('off');
  await sleep(1000);
  const off = await rate(10000);
  assert.equal(off.orders, 0, `off: no simulated orders (${JSON.stringify(off)})`);
  assert.equal(q1("SELECT COUNT(*) c FROM admin_audit WHERE action='owner_settings.update' AND target_id='simulation.activity'").c, 3, 'every change audited');
  // Restart: still off.
  await srv.close();
  srv = await start(OPTS);
  await sleep(3000);
  const again = await rate(8000);
  assert.equal(again.orders, 0, `still off after a restart (${JSON.stringify(again)})`);
  await page.goto(`${BASE}/admin/owner_settings`);
  await page.waitForSelector(`${row}[data-value="off"]`);
  assert.deepEqual(page.errors, []);
});
