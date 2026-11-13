'use strict';
// `npm run db:compact` (database growth fix, CLONE_SPEC.md §39.17), real server + SQLite file, no network:
//   • a server runs the simulated sports markets at the "normal" activity level while a member trades against the
//     liquidity accounts; the history is then dated 10 days back (as on a long-running database);
//   • --dry-run reports what would go and changes nothing; without a working backup store the command refuses and
//     changes nothing;
//   • the real run takes an encrypted backup first, removes / rolls up only system-account history, keeps the ledger audit
//     clean (balances, materialised balances, trial balance), leaves every member's orders, fills, ledger, positions,
//     balance and history, every trade and the charts identical, VACUUMs, and Admin › System shows the run and the size;
//   • the pre-compaction backup restores the database as it was.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');
const { restore } = require('../server/backups');
const storageLib = require('../server/storage');
const { auditWith } = require('../server/ledger-audit');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-compact-'));
const FILE = path.join(TMP, 'c.db');
const PW = 'Benue-Copper-Halyard-6604';
const HIGH = { burst: 1e6, per_second: 1e6 };
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = (extra = {}) => ({ port: 0, dbFile: FILE, quiet: true, tickMs: 250, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, admin: ADMIN, ...extra });
const q = (sql, ...a) => { const d = new DatabaseSync(FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const run = (sql) => { const d = new DatabaseSync(FILE); try { d.exec(sql); } finally { d.close(); } };
const hash = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const cli = (args, env = {}) => spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'scripts', 'db-compact.js'), '--db', FILE, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 600000 });
let browser = null;
after(async () => { try { await browser?.close(); } catch { /* ignore */ } fs.rmSync(TMP, { recursive: true, force: true }); });

let member;
// Everything a member owns, the trades (charts read them) and the journal's balances.
function memberState(uid) {
  return {
    orders: hash(q('SELECT * FROM orders WHERE user_id=? ORDER BY id', uid)), fills: hash(q('SELECT * FROM fills WHERE user_id=? ORDER BY id', uid)),
    ledger: hash(q('SELECT * FROM ledger WHERE user_id=? ORDER BY id', uid)), positions: hash(q('SELECT * FROM positions WHERE user_id=? ORDER BY market_ticker', uid)),
    balance: q('SELECT balance_cents b FROM users WHERE id=?', uid)[0].b, journal: hash(q("SELECT e.*, p.account, p.amount_cents FROM journal_entries e JOIN journal_postings p ON p.entry_id=e.id WHERE e.user_id=? OR p.account LIKE ? ORDER BY e.id, p.id", uid, `user:${uid}:%`)),
  };
}
const everyone = () => ({ trades: hash(q('SELECT * FROM trades ORDER BY id')), balances: hash(q('SELECT * FROM journal_balances ORDER BY account')), positions: hash(q('SELECT * FROM positions ORDER BY user_id, market_ticker')), users: hash(q('SELECT id, balance_cents FROM users ORDER BY id')) });
const audit = () => { const d = new DatabaseSync(FILE); try { return auditWith(d, { checks: ['perps', 'play_mode'], payments: true }); } finally { d.close(); } };
const counts = () => Object.fromEntries(['orders', 'journal_entries', 'journal_postings', 'ledger', 'fills', 'trades'].map((t) => [t, q(`SELECT COUNT(*) c FROM ${t}`)[0].c]));

test('setup: simulated trading at the normal level with a member trading against the liquidity accounts, dated 10 days back', async () => {
  const srv = await start(opts({ sports: { speed: 20 }, owner: { overrides: { 'simulation.activity': 'normal' } } }));
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const c = await new Client(base, 'm').signUp(`mia.${stamp}@example.test`, PW, 'Mia Member');
    assert.equal((await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: 500 }, { 'idempotency-key': crypto.randomUUID() })).status, 201);
    member = c.uid;
    await sleep(8000); // the liquidity accounts quote and print
    // The member takes liquidity on three simulated markets (trades with a member in them must survive whole).
    const UNITS = require('../server/engine').UNITS || 1;
    const quotes = q("SELECT o.market_ticker t, o.side, o.price_cc p FROM orders o JOIN sports_markets s ON s.market_ticker=o.market_ticker WHERE o.status='resting' AND o.source='liquidity' AND o.side='yes' GROUP BY o.market_ticker LIMIT 3");
    assert.ok(quotes.length >= 2, 'liquidity is quoted');
    for (const x of quotes) srv.engine.placeOrder(member, { ticker: x.t, side: 'no', price_cc: 10000 - x.p, count: 2 * UNITS });
    assert.ok(q('SELECT COUNT(*) c FROM fills WHERE user_id=?', member)[0].c >= 2, 'the member traded with the liquidity accounts');
    await sleep(12000);
  } finally { await srv.close(); }
  const c = counts();
  assert.ok(c.orders > 300 && c.journal_entries > 1000, JSON.stringify(c));
  const D = "'-10 days'";
  run(`UPDATE orders SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ${D}), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, ${D});
    UPDATE ledger SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ${D});
    UPDATE fills SET created_ts=created_ts-864000000; UPDATE trades SET created_ts=created_ts-864000000; UPDATE journal_entries SET ts=ts-864000000;`);
  assert.equal(audit().ok, true, 'the ledger audit is clean before');
});

test('--dry-run reports and changes nothing; without a working backup store the command refuses', () => {
  const before = { c: counts(), m: memberState(member), all: everyone() };
  const r = cli(['--dry-run']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Would remove/);
  const n = Number(/orders that never filled: (\d+)/.exec(r.stdout)[1]);
  assert.ok(n > 50, r.stdout);
  assert.deepEqual(counts(), before.c, 'nothing changed');
  // A backup store that cannot be written (a file where the folder should be): refused, nothing changed, recorded.
  const notADir = path.join(TMP, 'not-a-folder'); fs.writeFileSync(notADir, 'x');
  const bad = cli([], { BACKUP_STORAGE: `local:${notADir}` });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /refusing to compact: the backup could not be taken/);
  assert.deepEqual(counts(), before.c, 'nothing changed');
  assert.deepEqual(memberState(member), before.m);
  assert.deepEqual(everyone(), before.all);
  assert.equal(q("SELECT COUNT(*) c FROM ops_compactions WHERE status='refused'")[0].c, 1);
});

test('the real run: backup first, only system history goes, the audit stays clean, members and charts identical; Admin › System shows it; the backup restores the old state', async () => {
  // The member's history page and a chart, from a running server, before.
  let srv = await start(opts());
  const base = () => `http://127.0.0.1:${srv.port}`;
  const ticker = q('SELECT market_ticker t FROM fills WHERE user_id=? LIMIT 1', member)[0].t;
  const series = q('SELECT e.series_ticker s FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.ticker=?', ticker)[0].s;
  const now = Math.floor(Date.now() / 1000);
  const chart = async () => (await (await fetch(`${base()}/trade-api/v2/series/${series}/markets/${ticker}/candlesticks?start_ts=${now - 30 * 86400}&end_ts=${now}&period_interval=60`)).json()).candlesticks;
  const memberClient = async () => new Client(base(), 'm').logIn(`mia.${stamp}@example.test`, PW);
  let mc = await memberClient();
  const histBefore = (await mc.call('GET', `/v1/users/${member}/history?limit=200`)).body.history;
  const chartBefore = await chart();
  assert.ok(histBefore.length > 0 && chartBefore.length > 0);
  await srv.close();
  const before = { c: counts(), m: memberState(member), all: everyone(), audit: audit(), bytes: fs.statSync(FILE).size, members: q('SELECT COUNT(*) c FROM orders o JOIN users u ON u.id=o.user_id WHERE u.is_system=0')[0].c };
  const r = cli(['--days', '7']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Taking an encrypted backup first/);
  assert.match(r.stdout, /ledger audit: clean/);
  const c = counts();
  assert.ok(c.orders < before.c.orders && c.journal_entries < before.c.journal_entries && c.ledger < before.c.ledger, `${JSON.stringify(before.c)} → ${JSON.stringify(c)}`);
  assert.equal(c.trades, before.c.trades, 'every trade stays (price history)');
  assert.equal(c.fills, before.c.fills, 'fills stay');
  assert.deepEqual(memberState(member), before.m, "the member's orders, fills, ledger, positions, balance and journal are identical");
  assert.deepEqual(everyone(), before.all, 'trades, journal balances, positions and every balance are identical');
  const a = audit();
  assert.equal(a.ok, true, JSON.stringify(a.problems.slice(0, 5)));
  assert.deepEqual(a.totals, before.audit.totals, 'the audit totals are unchanged');
  assert.ok(fs.statSync(FILE).size <= before.bytes, 'VACUUM did not grow the file');
  assert.equal(q('SELECT COUNT(*) c FROM orders o JOIN users u ON u.id=o.user_id WHERE u.is_system=0')[0].c, before.members, 'no member order is touched');
  assert.ok(q("SELECT COUNT(*) c FROM journal_entries WHERE kind='compaction_rollup'")[0].c > 0, 'bot-vs-bot trades rolled up into balancing entries');
  const row = q("SELECT * FROM ops_compactions WHERE status='ok' AND dry_run=0")[0];
  assert.ok(row && row.backup_id && row.bytes_after <= row.bytes_before);
  assert.ok(q("SELECT 1 FROM admin_audit WHERE action='ops.db_compact'").length, 'audited');
  // The server starts on the result: the member's history page and the chart are identical; Admin › System shows the run.
  srv = await start(opts());
  try {
    mc = await memberClient();
    assert.deepEqual((await mc.call('GET', `/v1/users/${member}/history?limit=200`)).body.history, histBefore, "the member's history is identical");
    assert.deepEqual(await chart(), chartBefore, 'the chart is identical');
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    await page.goto(`${base()}/sign-in`);
    await page.fill('input[name=email]', ADMIN.email);
    await page.fill('input[name=password]', PW);
    await page.click('button[type=submit]');
    await page.waitForSelector('[data-testid=account-menu]');
    await page.goto(`${base()}/admin/system`);
    await page.waitForSelector(`[data-testid=sys-compaction][data-id="${row.id}"]`);
    const bytes = Number(await page.getAttribute('[data-testid=sys-database]', 'data-bytes'));
    assert.ok(bytes > 0, 'the database size is shown');
    assert.match(await page.textContent('[data-testid=sys-database]'), /Last compaction/);
  } finally { await srv.close(); }
  // The pre-compaction backup brings back the database as it was.
  const out = path.join(TMP, 'restored.db');
  const pre = q("SELECT created_ts t FROM ops_backups WHERE kind='pre_compaction' AND status='ok'")[0].t;
  await restore({ storage: storageLib.localDriver({ dir: path.join(TMP, 'backups') }), outFile: out, targetTs: pre, keyDir: TMP });
  const d = new DatabaseSync(out);
  try { assert.equal(d.prepare('SELECT COUNT(*) c FROM orders').get().c, before.c.orders, 'the backup holds the uncompacted history'); } finally { d.close(); }
});
