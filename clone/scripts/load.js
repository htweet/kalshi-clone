#!/usr/bin/env node
'use strict';
// Load and capacity scripts (PLAN P9.5, CLONE_SPEC.md §39.9). Node only (no extra binary).
//
//   npm run load -- --profile smoke                 in-process server on a temporary database, ~15 s (CI on every merge)
//   npm run load -- --profile full --report r.json  2 minutes at the target order rate with 2,000 WebSocket clients
//   npm run load -- --profile soak --duration 3600  one hour; memory sampled every 10 s (growth is reported)
//   npm run load -- --base https://staging.example.ng --traders 40 ...   against a running server (see below)
//
// Scenarios, all at once: (1) order placement and cancels by N traders on K markets, crossing so trades happen
// (order-to-ack latency = request to response, client side); (2) WebSocket fan-out to M clients subscribed to the ticker
// and trade channels of those markets (fan-out lag = receive time − the server's publish timestamp, same clock in
// self mode); (3) live ticks: sports scoreboards (`live_data`) counted per second; (4) public pages (/, an event page,
// the home data) p95; (5) the Trade API with signed requests (Ed25519 key) — balance reads and orders.
// Targets (agreed, PLAN P9.5): 200 orders/s sustained, order p99 < 50 ms, WebSocket fan-out p99 < 250 ms (20,000 clients
// at full scale), public pages p95 < 300 ms. The report says which were met and on what machine.
//
// Against a running server (--base): it must allow sign-ups, the traders' deposits (play mode or the demo method) and
// should have the bot challenge relaxed for the load host. Identity approval and API keys need --admin-db (a path to the
// database on the same machine, for approving the test traders) or the Trade API scenario is skipped.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { Client } = require('../tests/lib/client');
const { SignedClient, ed25519, pubPem } = require('../tests/lib/signing');

const PROFILES = {
  smoke: { duration: 12, traders: 8, markets: 4, ws: 50, rate: 60, pageConcurrency: 4 },
  full: { duration: 120, traders: 40, markets: 8, ws: 2000, rate: 200, pageConcurrency: 16 },
  soak: { duration: 3600, traders: 20, markets: 6, ws: 500, rate: 100, pageConcurrency: 4 },
};
const TARGETS = { orders_per_sec: 200, order_p99_ms: 50, ws_fanout_p99_ms: 250, page_p95_ms: 300 };

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); o[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  return o;
}
// Latency samples go into a fixed-size histogram (0.1 ms buckets below 100 ms, 1 ms below 10 s, 100 ms above), so memory
// stays flat however long a run is: a one-hour soak with 500 WebSocket clients records hundreds of millions of samples.
class Hist {
  constructor() { this.counts = new Map(); this.n = 0; }
  key(v) { return v < 100 ? Math.round(v * 10) / 10 : v < 10000 ? Math.round(v) : Math.round(v / 100) * 100; }
  push(v) { if (!Number.isFinite(v)) return; const k = this.key(v); this.counts.set(k, (this.counts.get(k) || 0) + 1); this.n += 1; }
  get length() { return this.n; }
  quantile(q) {
    if (!this.n) return null;
    const keys = [...this.counts.keys()].sort((a, b) => a - b);
    const want = Math.min(this.n - 1, Math.floor(q * this.n)); let seen = 0;
    for (const k of keys) { seen += this.counts.get(k); if (seen > want) return k; }
    return keys[keys.length - 1];
  }
}
const pct = (h, q) => { const v = h.quantile(q); return v == null ? null : Math.round(v * 10) / 10; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null; // the self-mode server process, stopped on any exit
process.on('exit', () => { if (child && child.exitCode == null) child.kill('SIGTERM'); });
const PW = `Benue-Harbor-${crypto.randomBytes(4).toString("hex")}-Quill`;

async function main() {
  const a = parse(process.argv.slice(2));
  const prof = { ...PROFILES[a.profile || 'smoke'] };
  for (const k of ['duration', 'traders', 'markets', 'ws', 'rate']) if (a[k]) prof[k] = Number(a[k]);
  let base = a.base; let srv = null; let tmp = null; let dbFile = a['admin-db'] || null;
  if (!base) {
    // Self mode: the server runs in its own process (as in production), the load generator in this one.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-load-'));
    dbFile = path.join(tmp, 'load.db');
    srv = child = spawn(process.execPath, ['--no-warnings', __filename, '--serve', dbFile, '--assets', String(a.assets || 'dist'), '--sports', String(a.sports || '1')], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      srv.stdout.on('data', (d) => { buf += d; const m = /PORT (\d+)/.exec(buf); if (m) resolve(Number(m[1])); });
      srv.once('exit', (code) => reject(new Error(`load server exited (${code})`)));
    });
    base = `http://127.0.0.1:${port}`;
  }
  const q = (sql, ...x) => { const d = new DatabaseSync(dbFile); d.exec('PRAGMA busy_timeout = 10000'); try { return d.prepare(sql).all(...x); } finally { d.close(); } };
  const run = (sql, ...x) => { const d = new DatabaseSync(dbFile); d.exec('PRAGMA busy_timeout = 10000'); try { return d.prepare(sql).run(...x); } finally { d.close(); } };
  const stamp = Date.now();
  const log = (...m) => { if (!a.quiet) console.error('[load]', ...m); };
  log(`profile ${a.profile || 'smoke'} against ${base}: ${prof.traders} traders, ${prof.markets} markets, ${prof.ws} WebSocket clients, ${prof.rate} orders/s for ${prof.duration} s`);

  // ---- setup: traders with money, markets to trade
  const traders = [];
  for (let i = 0; i < prof.traders; i++) {
    const c = await new Client(base, `t${i}`).signUp(`trader${i}.${stamp}@example.test`, PW, `Load Trader ${i}`);
    if (dbFile) run("UPDATE identity_profiles SET status='approved' WHERE user_id=?", c.uid);
    const r = await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: 100000 }, { 'idempotency-key': crypto.randomUUID() });
    if (r.status !== 201) throw new Error(`deposit failed: ${r.status} ${r.text}`);
    traders.push(c);
  }
  const markets = dbFile ? q("SELECT m.ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status='active' AND m.mve_collection_ticker IS NULL AND m.market_type='binary' AND m.price_level_structure='linear_cent' AND e.series_ticker NOT LIKE 'PLXFLASH%' ORDER BY m.ticker LIMIT ?", prof.markets).map((r) => r.ticker)
    : (await traders[0].call('GET', `/trade-api/v2/markets?status=open&limit=${prof.markets}`)).body.markets.map((m) => m.ticker);
  if (!markets.length) throw new Error('no open markets to trade');

  // ---- WebSocket clients (fan-out)
  const fanout = new Hist(); let wsMessages = 0; let liveTicks = 0;
  const sockets = [];
  const viewer = await new Client(base, 'viewer').boot();
  for (let i = 0; i < prof.ws; i++) {
    const s = viewer.socket();
    try { await s.opened; } catch (e) { log(`WebSocket ${i} refused: ${e.message}`); break; }
    s.ws.on('message', (raw) => {
      wsMessages += 1;
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'live_data') liveTicks += 1;
      const ts = m.msg && (m.msg.ts || m.msg.created_time && Date.parse(m.msg.created_time));
      if ((m.type === 'ticker' || m.type === 'trade') && Number.isFinite(ts) && ts > 1e12) fanout.push(Date.now() - ts);
    });
    await s.subscribe(['ticker', 'trade', ...(i === 0 ? ['live_data'] : [])], { market_tickers: markets });
    sockets.push(s);
  }
  log(`${sockets.length} WebSocket clients subscribed`);

  // ---- Trade API key (signed requests) for one trader
  let api = null;
  if (dbFile) {
    const kp = ed25519();
    const c = traders[0];
    let r = await c.call('POST', `/v1/users/${c.uid}/api_keys`, { label: 'load', scopes: ['read', 'trade'], mode: 'public_key', public_key: pubPem(kp) });
    if (r.code === 'step_up_required') { await c.call('POST', '/v1/step_up', { password: PW }); r = await c.call('POST', `/v1/users/${c.uid}/api_keys`, { label: 'load', scopes: ['read', 'trade'], mode: 'public_key', public_key: pubPem(kp) }); }
    if (r.status === 201) api = new SignedClient(base, r.body.api_key.api_key_id, kp.privateKey); else log(`Trade API scenario skipped: ${r.status} ${r.code}`);
  }

  // ---- run
  const orderLat = new Hist(); const pageLat = new Hist(); const apiLat = new Hist(); const errors = {};
  let orders = 0; let cancels = 0; let fills = 0;
  const mem = [process.memoryUsage().rss];
  // The server's memory too (its own process): the soak's question is whether it grows over the hour.
  const serverRss = () => { try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${srv.pid}/status`, 'utf8'))[1]) / 1024); } catch { return null; } };
  const srvMem = [];
  const memTimer = setInterval(() => { mem.push(process.memoryUsage().rss); if (srv) { const r = serverRss(); if (r != null) srvMem.push(r); } }, 10000);
  const t0 = Date.now(); const end = t0 + prof.duration * 1000;
  const err = (k) => { errors[k] = (errors[k] || 0) + 1; };
  // Order generator: a token bucket at the target rate spread over the traders; every other order crosses the last one.
  const interval = 1000 / prof.rate;
  let seq = 0;
  async function placeOne() {
    const i = seq++;
    const c = traders[i % traders.length];
    const ticker = markets[i % markets.length];
    const yes = (i >> 1) % 2 === 0;
    const price = 30 + ((i * 7) % 40);
    const body = { ticker, side: yes ? 'yes' : 'no', action: 'buy', type: 'limit', price: yes ? price : 100 - price, count: 1 + (i % 5) };
    const s = process.hrtime.bigint();
    const r = await c.call('POST', `/v1/users/${c.uid}/orders`, body, { 'idempotency-key': crypto.randomUUID() }).catch((e) => ({ status: 0, code: e.message }));
    orderLat.push(Number(process.hrtime.bigint() - s) / 1e6);
    if (r.status === 201 || r.status === 200) {
      orders += 1;
      const o = r.body && r.body.order;
      if (o && Number(o.fill_count_fp || o.filled_count || 0) > 0) fills += 1;
      if (o && o.status === 'resting' && i % 3 === 0) { const d = await c.call('DELETE', `/v1/users/${c.uid}/orders/${o.order_id}`).catch(() => ({ status: 0 })); if (d.status < 300) cancels += 1; else err(`cancel_${d.status}`); }
    } else err(`order_${r.status}_${r.code}`);
  }
  const inflight = new Set();
  const orderLoop = (async () => {
    let next = Date.now();
    while (Date.now() < end) {
      const p = placeOne().finally(() => inflight.delete(p));
      inflight.add(p);
      if (inflight.size > 256) await Promise.race(inflight);
      next += interval;
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
    }
    await Promise.all(inflight);
  })();
  const pages = ['/', `/markets/${markets[0]}`, '/v1/bff/home', '/v1/site_config'];
  const pageLoop = Promise.all(Array.from({ length: prof.pageConcurrency }, async (_, w) => {
    const c = new Client(base, `page${w}`);
    let j = w;
    while (Date.now() < end) {
      const p = pages[j++ % pages.length];
      const s = process.hrtime.bigint();
      const r = await c.call('GET', p, undefined, { accept: p.startsWith('/v1') ? 'application/json' : 'text/html' }).catch(() => ({ status: 0 }));
      pageLat.push(Number(process.hrtime.bigint() - s) / 1e6);
      if (r.status >= 400 || r.status === 0) err(`page_${r.status}`);
      await sleep(20);
    }
  }));
  const apiLoop = api ? (async () => {
    let k = 0;
    while (Date.now() < end) {
      const s = process.hrtime.bigint();
      const r = k++ % 2 ? await api.call('GET', '/trade-api/v2/portfolio/balance').catch(() => ({ status: 0 }))
        : await api.call('POST', '/trade-api/v2/portfolio/orders', { ticker: markets[k % markets.length], side: 'yes', action: 'buy', type: 'limit', yes_price: 5, count: 1, client_order_id: crypto.randomUUID() }).catch(() => ({ status: 0 }));
      apiLat.push(Number(process.hrtime.bigint() - s) / 1e6);
      if (r.status >= 300 || r.status === 0) err(`api_${r.status}`);
      await sleep(50);
    }
  })() : Promise.resolve();
  await Promise.all([orderLoop, pageLoop, apiLoop]);
  const elapsed = (Date.now() - t0) / 1000;
  await sleep(500); // let the last WebSocket messages arrive
  clearInterval(memTimer);
  mem.push(process.memoryUsage().rss);
  for (const s of sockets) s.close();
  const results = {
    orders_per_sec: Math.round((orders / elapsed) * 10) / 10, orders, cancels, orders_with_fills: fills, order_p50_ms: pct(orderLat, 0.5), order_p99_ms: pct(orderLat, 0.99),
    ws_clients: sockets.length, ws_messages: wsMessages, ws_fanout_p50_ms: pct(fanout, 0.5), ws_fanout_p99_ms: pct(fanout, 0.99), live_ticks_per_sec: Math.round((liveTicks / elapsed) * 10) / 10,
    page_p50_ms: pct(pageLat, 0.5), page_p95_ms: pct(pageLat, 0.95), pages: pageLat.length, api_p50_ms: pct(apiLat, 0.5), api_p99_ms: pct(apiLat, 0.99), api_requests: apiLat.length,
    errors, client_rss_mb: mem.map((x) => Math.round(x / 1048576)), server_rss_mb: srvMem,
  };
  if (srv) {
    try { results.server_rss_mb_end = Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${srv.pid}/status`, 'utf8'))[1]) / 1024); } catch { /* not Linux */ }
  }
  const within = { orders_per_sec: results.orders_per_sec >= TARGETS.orders_per_sec, order_p99_ms: results.order_p99_ms != null && results.order_p99_ms <= TARGETS.order_p99_ms,
    ws_fanout_p99_ms: results.ws_fanout_p99_ms != null && results.ws_fanout_p99_ms <= TARGETS.ws_fanout_p99_ms, page_p95_ms: results.page_p95_ms != null && results.page_p95_ms <= TARGETS.page_p95_ms };
  const report = { profile: a.profile || 'smoke', time: new Date().toISOString(), base: srv ? 'in-process' : base, duration_s: Math.round(elapsed), config: prof,
    machine: `${os.cpus().length} × ${os.cpus()[0] && os.cpus()[0].model} · ${Math.round(os.totalmem() / 1073741824)} GB · Node ${process.version} · ${os.platform()} ${os.release()}${srv ? ' · server and load generator on the same machine (two processes)' : ''}`,
    results, targets: TARGETS, within_targets: within };
  if (a.report) fs.writeFileSync(path.resolve(String(a.report)), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (srv) { srv.kill('SIGTERM'); await new Promise((r) => { srv.once('exit', r); setTimeout(r, 5000); }); }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  // Smoke (CI): fail on errors that mean something broke, not on the machine's speed.
  if (a.profile === 'smoke' || !a.profile) {
    const bad = Object.entries(errors).filter(([k]) => !/^order_409_/.test(k)).reduce((s, [, n]) => s + n, 0);
    if (!orders || bad > Math.max(5, orders * 0.02) || !sockets.length) { console.error(`load smoke failed: ${orders} orders, errors ${JSON.stringify(errors)}`); process.exit(1); }
  }
}

// --serve <db>: the server process of self mode (rate limits and the bot challenge relaxed for the load host).
async function serve(dbFile, assets, sportsSpeed) {
  const { start } = require('../server/index.js');
  const HIGH = { burst: 1e9, per_second: 1e9 };
  const s = await start({ port: 0, dbFile, quiet: true, tickMs: 500, sports: sportsSpeed === 'off' ? false : { speed: Number(sportsSpeed) || 1 }, rate: { burst: 1e9, perSec: 1e9 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH, anonRate: HIGH, readRate: HIGH },
    admin: { email: 'root.ops@example.test', password: PW }, flags: { defaults: { 'perps.waitlist': false } }, assets });
  process.stdout.write(`PORT ${s.port}\n`);
  const stop = () => s.close().then(() => process.exit(0), () => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

const argv = process.argv.slice(2);
if (argv[0] === '--serve') serve(argv[1], argv[3] || 'dist', argv[5] || '1').catch((e) => { console.error(e); process.exit(1); });
else main().catch((e) => { console.error(`load failed: ${e.stack || e.message}`); if (child) child.kill('SIGTERM'); process.exit(1); });
