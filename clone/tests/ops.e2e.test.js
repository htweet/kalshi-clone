'use strict';
// Phase 9A operations in the browser (PLAN P9.1, P9.4, P9.6-P9.8; CLONE_SPEC.md §39). Real server + SQLite + Chromium,
// set up the way production runs: a TLS-terminating proxy in front (tests/lib/tls-proxy.js, Caddy's role), the trusted
// proxy limited to loopback, the public site and the admin panel on separate https origins, scrypt 2^17, the master and
// backup keys from the environment, demo accounts and simulators off — so the production config guard checks pass for
// real, not by a test switch. Scenarios:
//   • admin origin separation: the admin panel and /v1/admin/* only on the admin origin, its own cookie, a stricter CSP,
//     member and admin sessions never valid on the other origin, the IP allowlist (with lock-out protection);
//   • maintenance mode across the site and the API (banner live, writes 503 + Retry-After, reads work, staff keep access),
//     scheduled start and end;
//   • the exchange-wide trading halt (banner, orders refused on every path, cancels allowed, status page notice) and its
//     two-person resume; read-only mode;
//   • Admin › System: backup now, restore drill, key ages, audit anchor, migration version, alert contact test send
//     (signed webhook to a local receiver, code entered back in the UI);
//   • Launch readiness checks turning green and red live, owner items ticked in the UI, scan and load-test results;
//     the production switch refused with the open items named, then allowed once everything is green (two admins);
//   • a restart keeps the switches, items, contacts and evidence.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

// Production-like environment for this process, before any server module is loaded (the scrypt cost is read at load).
process.env.SCRYPT_LOG_N = '17';
process.env.SECRET_KEY = crypto.randomBytes(32).toString('hex');
process.env.BACKUP_KEY = crypto.randomBytes(32).toString('hex');
process.env.DEMO_ACCOUNTS = 'off'; process.env.DEMO_API = '0'; process.env.SPORTS = '0';
process.env.TRUST_PROXY = 'loopback';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the proxy's self-signed certificate, for this test process only

const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { open: openBackup, backupKeys } = require('../server/backups');
const { Client } = require('./lib/client');
const { createTlsProxy, selfSigned } = require('./lib/tls-proxy');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-ops-'));
const DATA = path.join(TMP, 'data');
const OFFSITE = path.join(TMP, 'offsite-backups'); // another folder than the data one (the "off the server" check)
const DB_FILE = path.join(DATA, 'ops.db');
const PW = 'Benue-Copper-Halyard-6604';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const ADMIN2 = { email: `second.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
let SITE; let ADM; let OPTS; let srv; let browser; let siteProxy; let adminProxy; let receiver; let hookUrl;
const hooks = [];
const allPages = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const q1 = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
async function eventually(fn, { timeout = 15000, interval = 200 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { const v = await fn(); if (v !== false && v !== undefined && v !== null) return v; } catch (e) { if (Date.now() > end) throw e; } if (Date.now() > end) throw new Error('eventually: condition not met'); await sleep(interval); }
}
async function newPage(viewport = { width: 1400, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  allPages.push(page);
  return page;
}
async function uiLogIn(page, base, u, done = '[data-testid=account-menu]') {
  await page.goto(`${base}/sign-in`);
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', u.password);
  await page.click('button[type=submit]');
  await page.waitForSelector(done, { timeout: 20000 });
}
async function answerStepUp(page) {
  const d = await page.waitForSelector('[data-testid=step-up-password]', { timeout: 2500 }).catch(() => null);
  if (!d) return false;
  await page.fill('[data-testid=step-up-password]', PW);
  await page.click('[data-testid=step-up-submit]');
  return true;
}
const stepped = (c) => async (method, p, body) => {
  let r = await c.call(method, p, body);
  if (r.code === 'step_up_required') { assert.equal((await c.call('POST', '/v1/step_up', { password: PW })).status, 200); r = await c.call(method, p, body); }
  return r;
};
let admin; let admin2; let member;
const order = (c, extra = {}) => c.call('POST', `/v1/users/${c.uid}/orders`, { ticker: q1("SELECT ticker FROM markets WHERE status='active' AND mve_collection_ticker IS NULL AND market_type='binary' AND price_level_structure='linear_cent' ORDER BY ticker LIMIT 1").ticker, side: 'yes', action: 'buy', type: 'limit', price: 5, count: 1, ...extra }, { 'idempotency-key': crypto.randomUUID() });

before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const tls = selfSigned(TMP);
  const appPort = await freePort();
  siteProxy = createTlsProxy({ target: appPort, tls }); adminProxy = createTlsProxy({ target: appPort, tls });
  SITE = `https://127.0.0.1:${await siteProxy.listen()}`; ADM = `https://127.0.0.1:${await adminProxy.listen()}`;
  process.env.PUBLIC_ORIGIN = SITE; process.env.ADMIN_ORIGIN = ADM; process.env.ALLOWED_ORIGINS = `${SITE},${ADM}`;
  receiver = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { hooks.push({ headers: req.headers, body: JSON.parse(b) }); } catch { /* ignore */ } res.writeHead(204).end(); }); });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${receiver.address().port}/phone`;
  OPTS = { port: appPort, dbFile: DB_FILE, tickMs: 250, quiet: true, sports: false, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH },
    ops: { launchGate: true, alertLoopback: true, backupStorage: { driver: 'local', dir: OFFSITE } } };
  srv = await start(OPTS);
  browser = await chromium.launch();
  admin = await new Client(ADM, 'admin').logIn(ADMIN.email, PW);
  // Play money until launch (the production switch at the end needs it on, and it can only start before real money exists).
  assert.equal((await stepped(admin)('PUT', '/v1/admin/play_mode', { on: true, reason: 'play money until launch' })).status, 200);
  // A second admin (the two-person rules) and a member with money.
  const m2 = await new Client(SITE, 'admin2').signUp(ADMIN2.email, PW, 'Second Admin');
  dbrun('UPDATE users SET is_admin=1 WHERE id=?', m2.uid);
  admin2 = await new Client(ADM, 'admin2').logIn(ADMIN2.email, PW);
  member = await new Client(SITE, 'member').signUp(`ada.${stamp}@example.test`, PW, 'Ada Member');
  assert.equal((await member.call('POST', `/v1/users/${member.uid}/deposits`, { amount_dollars: 500 }, { 'idempotency-key': crypto.randomUUID() })).status, 201);
});
after(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await srv?.close(); } catch { /* ignore */ }
  for (const p of [siteProxy, adminProxy]) { try { await p?.close(); } catch { /* ignore */ } }
  try { receiver?.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
  for (const p of allPages) assert.deepEqual(p.errors.filter((e) => !/ResizeObserver/.test(e)), [], 'no page errors');
});

test('admin origin separation: panel and API only on the admin origin, separate cookies, stricter CSP, IP allowlist', async () => {
  // The site never serves the admin panel or its API.
  const sitePage = await newPage();
  const r = await sitePage.goto(`${SITE}/admin`);
  assert.equal(r.status(), 404, 'no admin panel on the public origin');
  const memberCookie = member.jar.get('__Host-plx_session');
  assert.ok(memberCookie, 'members get the __Host- session cookie over https');
  assert.equal((await member.call('GET', '/v1/admin/me')).status, 404, '/v1/admin answers 404 on the site');
  // The admin panel on the admin origin, with the stricter policy.
  const ap = await newPage();
  await uiLogIn(ap, ADM, ADMIN);
  const resp = await ap.goto(`${ADM}/admin/system`);
  assert.equal(resp.status(), 200);
  const csp = resp.headers()['content-security-policy'];
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /upgrade-insecure-requests/);
  assert.equal(resp.headers()['x-frame-options'], 'DENY');
  assert.match(resp.headers()['strict-transport-security'] || '', /max-age=31536000/);
  await ap.waitForSelector('[data-testid=sys-page]');
  const cookies = await ap.context().cookies(ADM);
  assert.ok(cookies.some((c) => c.name === '__Host-plx_admin' && c.secure && c.httpOnly), 'the admin origin has its own Secure cookie');
  assert.ok(!cookies.some((c) => c.name === '__Host-plx_session'), 'no member cookie from signing in on the admin origin');
  // A member session presented on the admin origin, under either cookie name, is not a session there.
  const probe = new Client(ADM, 'probe');
  for (const name of ['__Host-plx_session', '__Host-plx_admin']) {
    probe.jar.clear(); probe.jar.set(name, memberCookie);
    assert.equal((await probe.call('GET', '/v1/session')).body.user, null, `member cookie as ${name} on the admin origin`);
  }
  // An admin-origin session presented on the site is not a session there either.
  const adminCookie = admin.jar.get('__Host-plx_admin');
  const probe2 = new Client(SITE, 'probe2');
  probe2.jar.set('__Host-plx_session', adminCookie);
  assert.equal((await probe2.call('GET', '/v1/session')).body.user, null, 'admin cookie on the site');
  // The account menu on the site sends staff to the admin origin.
  const staffSite = await newPage();
  await uiLogIn(staffSite, SITE, ADMIN);
  await staffSite.click('[data-testid=account-menu]');
  assert.equal(await staffSite.getAttribute('[data-testid=admin-link]', 'href'), `${ADM}/admin`);
  // IP allowlist (owner setting, step-up): a list without the caller's own address is refused (lock-out protection).
  const set = stepped(admin);
  const lock = await set('PUT', '/v1/admin/owner_settings/admin.ip_allowlist', { value: '198.51.100.0/24', reason: 'office only' });
  assert.equal(lock.status, 400); assert.match(lock.body.error.fields.value, /lock you out/);
  assert.equal((await set('PUT', '/v1/admin/owner_settings/admin.ip_allowlist', { value: '127.0.0.1/32, 198.51.100.7', reason: 'office and this host' })).status, 200);
  const from = (base, ip, p) => fetch(`${base}${p}`, { headers: { 'x-test-client-ip': ip } });
  assert.equal((await from(ADM, '203.0.113.5', '/admin')).status, 403, 'an address off the list is refused on the admin origin');
  assert.equal((await from(ADM, '198.51.100.7', '/admin')).status, 200, 'a listed address gets in');
  assert.equal((await from(SITE, '203.0.113.5', '/')).status, 200, 'the public site is not affected');
  assert.ok(q1("SELECT 1 FROM security_events WHERE kind='admin_ip_refused' AND ip='203.0.113.5'"), 'the refusal is logged with the real client address');
  assert.equal((await set('PUT', '/v1/admin/owner_settings/admin.ip_allowlist', { value: '', reason: 'open again for the suite' })).status, 200);
});

test('maintenance mode across the site and the API, with a scheduled window', async () => {
  const mp = await newPage();
  await uiLogIn(mp, SITE, { email: `ada.${stamp}@example.test`, password: PW });
  const ap = await newPage();
  await uiLogIn(ap, ADM, ADMIN);
  await ap.goto(`${ADM}/admin/system`);
  await ap.click('[data-testid=sys-switch][data-key="ops.maintenance"] [data-testid=sys-switch-toggle]');
  await ap.fill('[data-testid=sys-switch-form] [name=reason]', 'database maintenance');
  await ap.click('[data-testid=sys-switch-form] button[type=submit]');
  await answerStepUp(ap);
  await ap.waitForSelector('[data-testid=sys-switch][data-key="ops.maintenance"][data-on="1"]');
  // The member's open page shows the CMS message live; writes are refused with Retry-After; reads work.
  await mp.waitForSelector('[data-testid=ops-banner-maintenance]', { timeout: 15000 });
  const w = await order(member);
  assert.equal(w.status, 503); assert.equal(w.code, 'maintenance');
  assert.ok(Number(w.headers.get('retry-after')) > 0, 'Retry-After');
  assert.equal((await member.call('GET', `/v1/users/${member.uid}/balance`)).status, 200, 'reads still work');
  // Signing in still works (so staff can fix things), and staff keep write access.
  assert.equal((await new Client(SITE, 'x').logIn(`ada.${stamp}@example.test`, PW)).user.user_id, member.uid);
  assert.equal((await admin.call('POST', '/v1/admin/system/anchor', { reason: 'during maintenance' })).status, 201, 'staff writes work');
  // The status page says so.
  await mp.goto(`${SITE}/status`);
  await mp.waitForSelector('[data-testid=status-notice][data-kind=maintenance]');
  // Off again in the UI.
  await ap.click('[data-testid=sys-switch][data-key="ops.maintenance"] [data-testid=sys-switch-toggle]');
  await ap.fill('[data-testid=sys-switch-form] [name=reason]', 'done');
  await ap.click('[data-testid=sys-switch-form] button[type=submit]');
  await answerStepUp(ap);
  await ap.waitForSelector('[data-testid=sys-switch][data-key="ops.maintenance"][data-on="0"]');
  await mp.goto(`${SITE}/`);
  await mp.waitForSelector('[data-testid=account-menu]');
  assert.equal(await mp.$('[data-testid=ops-banner-maintenance]'), null);
  assert.equal((await order(member)).status, 201);
  // A scheduled window: off before it starts, on inside it (with Retry-After until its end), off after it.
  const s0 = Date.now();
  const sched = await stepped(admin)('PUT', '/v1/admin/flags/ops.maintenance', { enabled: true, starts_at: new Date(s0 + 2500).toISOString(), ends_at: new Date(s0 + 9000).toISOString(), reason: 'scheduled window' });
  assert.equal(sched.status, 200, sched.text);
  assert.equal((await order(member)).status, 201, 'before the window');
  await mp.waitForSelector('[data-testid=ops-banner-maintenance]', { timeout: 10000 });
  const inside = await order(member);
  assert.equal(inside.status, 503);
  assert.ok(Number(inside.headers.get('retry-after')) <= 9, 'Retry-After counts down to the scheduled end');
  await mp.waitForSelector('[data-testid=ops-banner-maintenance]', { state: 'detached', timeout: 15000 });
  assert.equal((await order(member)).status, 201, 'after the window');
  await stepped(admin)('PUT', '/v1/admin/flags/ops.maintenance', { enabled: false, starts_at: null, ends_at: null, reason: 'clear the schedule' });
});

test('trading halt: orders refused on every path, cancels allowed, banner and status page; resuming needs a second admin', async () => {
  const resting = await order(member, { price: 3 });
  assert.equal(resting.status, 201);
  const mp = await newPage();
  await uiLogIn(mp, SITE, { email: `ada.${stamp}@example.test`, password: PW });
  const ap = await newPage();
  await uiLogIn(ap, ADM, ADMIN);
  await ap.goto(`${ADM}/admin/system`);
  await ap.click('[data-testid=sys-switch][data-key="ops.trading_halt"] [data-testid=sys-switch-toggle]');
  await ap.fill('[data-testid=sys-switch-form] [name=reason]', 'incident: matching paused');
  await ap.click('[data-testid=sys-switch-form] button[type=submit]');
  await answerStepUp(ap);
  await ap.waitForSelector('[data-testid=sys-switch][data-key="ops.trading_halt"][data-on="1"]');
  await mp.waitForSelector('[data-testid=ops-banner-halt]', { timeout: 15000 });
  const o = await order(member);
  assert.equal(o.status, 409); assert.equal(o.code, 'trading_halted');
  assert.equal((await member.call('DELETE', `/v1/users/${member.uid}/orders/${resting.body.order.order_id}`)).status, 200, 'cancels still work');
  assert.equal((await member.call('GET', '/trade-api/v2/exchange/status')).body.trading_active, false, 'the exchange status says so');
  assert.equal(srv.engine.tradingActive, false, 'the engine refuses orders on every path (FIX, internal jobs)');
  await mp.goto(`${SITE}/status`);
  await mp.waitForSelector('[data-testid=status-notice][data-kind=trading_halt]');
  // The same admin cannot end it: the request waits for a second admin.
  await ap.click('[data-testid=sys-switch][data-key="ops.trading_halt"] [data-testid=sys-switch-toggle]');
  await ap.fill('[data-testid=sys-switch-form] [name=reason]', 'incident over');
  await ap.click('[data-testid=sys-switch-form] button[type=submit]');
  await answerStepUp(ap);
  await ap.waitForSelector('[data-testid=sys-approval]');
  assert.equal((await order(member)).code, 'trading_halted', 'still halted');
  const pending = (await admin.call('GET', '/v1/admin/ops/approvals')).body.approvals.find((a) => a.status === 'pending');
  assert.equal((await admin.call('POST', `/v1/admin/ops/approvals/${pending.id}/approve`, {})).code, 'same_admin');
  // The second admin approves in the UI.
  const ap2 = await newPage();
  await uiLogIn(ap2, ADM, ADMIN2);
  await ap2.goto(`${ADM}/admin/system`);
  await ap2.click(`[data-testid=sys-approval][data-id="${pending.id}"] [data-testid=sys-approve]`);
  await ap2.click('[data-testid=confirm-ok]');
  await answerStepUp(ap2);
  await ap2.waitForSelector('[data-testid=sys-switch][data-key="ops.trading_halt"][data-on="0"]', { timeout: 15000 });
  await mp.goto(`${SITE}/`);
  await mp.waitForSelector('[data-testid=account-menu]');
  assert.equal(await mp.$('[data-testid=ops-banner-halt]'), null);
  assert.equal((await order(member)).status, 201, 'trading resumed');
  assert.ok(q1("SELECT 1 FROM admin_audit WHERE action='ops.trading_resume'"), 'audited');
});

test('read-only mode: reads work, every write is refused, only the switch itself can be changed', async () => {
  assert.equal((await stepped(admin)('PUT', '/v1/admin/flags/ops.read_only', { enabled: true, reason: 'restore in progress' })).status, 200);
  const mp = await newPage();
  await mp.goto(`${SITE}/`);
  await mp.waitForSelector('[data-testid=ops-banner-read-only]');
  const w = await order(member);
  assert.equal(w.status, 503); assert.equal(w.code, 'read_only'); assert.ok(w.headers.get('retry-after'));
  assert.equal((await admin.call('POST', '/v1/admin/system/anchor', { reason: 'not now' })).code, 'read_only', 'staff writes are refused too');
  assert.equal((await member.call('GET', '/v1/site_config')).status, 200);
  assert.equal((await stepped(admin)('PUT', '/v1/admin/flags/ops.read_only', { enabled: false, reason: 'restore finished' })).status, 200);
  assert.equal((await order(member)).status, 201);
});

test('Admin › System: backup now, restore drill, key ages, audit anchor, migration version, alert contact test send', async () => {
  const ap = await newPage();
  await uiLogIn(ap, ADM, ADMIN);
  await ap.goto(`${ADM}/admin/system`);
  await ap.waitForSelector('[data-testid=sys-page]');
  assert.equal(await ap.getAttribute('[data-testid=sys-migrations]', 'data-version'), String(require('../server/migrations').LATEST));
  assert.equal(await ap.getAttribute('[data-testid=sys-health]', 'data-ready'), '1');
  assert.match(await ap.textContent('[data-testid=sys-key-row][data-kid=k1] [data-testid=sys-key-age]'), /0 day/);
  // Backup now.
  await ap.click('[data-testid=sys-backup-now]');
  await ap.fill('[data-testid=confirm-reason]', 'before the drill');
  await ap.click('[data-testid=confirm-ok]');
  await answerStepUp(ap);
  await ap.waitForSelector('[data-testid=sys-backups][data-has-backup="1"]', { timeout: 15000 });
  await ap.waitForSelector('[data-testid=sys-backup-row][data-kind=manual][data-status=ok]');
  // Restore drill.
  await ap.click('[data-testid=sys-drill-run]');
  await ap.fill('[data-testid=confirm-reason]', 'monthly drill');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-testid=sys-drill][data-has-drill="1"]', { timeout: 30000 });
  for (const k of ['integrity', 'journal', 'audit_chain', 'schema']) await ap.waitForSelector(`[data-testid=sys-drill-check][data-name=${k}]`);
  // Anchor now.
  await ap.click('[data-testid=sys-anchor-now]');
  await ap.fill('[data-testid=confirm-reason]', 'anchor before launch');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-testid=sys-anchor][data-ok="1"]');
  assert.match(await ap.textContent('[data-testid=sys-anchor-last]'), /Anchor #\d+/);
  const anchorFiles = fs.readdirSync(OFFSITE, { recursive: true }).filter((f) => String(f).startsWith('anchors'));
  assert.ok(anchorFiles.some((f) => String(f).endsWith('.json')), 'the anchor is shipped to the backup store');
  // Alert contact: add a webhook (the owner's phone relay), send a test, type the code back.
  await ap.click('[data-testid=sys-contact-add]');
  await ap.selectOption('[data-testid=sys-contact-form] [name=kind]', 'webhook');
  await ap.fill('[data-testid=sys-contact-form] [name=label]', 'Owner phone');
  await ap.fill('[data-testid=sys-contact-form] [name=target]', hookUrl);
  await ap.fill('[data-testid=sys-contact-form] [name=reason]', 'phone alerts');
  await ap.click('[data-testid=sys-contact-form] button[type=submit]');
  await answerStepUp(ap);
  await ap.waitForSelector('[data-testid=sys-contact][data-confirmed="0"]');
  await ap.click('[data-testid=sys-contact] [data-testid=sys-contact-test]');
  const msg = await eventually(() => hooks.find((h) => h.body.type === 'test'));
  assert.match(msg.body.code, /^\d{6}$/);
  assert.match(msg.headers['x-parlance-signature'], /^t=\d+,v1=[0-9a-f]{64}$/);
  await ap.waitForSelector('[data-testid=sys-contact-code]');
  await ap.fill('[data-testid=sys-contact-code]', msg.body.code);
  await ap.click('[data-testid=sys-contact-confirm]');
  await ap.waitForSelector('[data-testid=sys-contact][data-confirmed="1"]');
});

test('Launch readiness: checks turn green and red live; the production switch is refused with reasons, then allowed when green', async () => {
  const set = stepped(admin);
  // A request through the proxy over HTTPS has been seen (TLS check); keys, anchor, drill and contact are in place.
  const ap = await newPage();
  await uiLogIn(ap, ADM, ADMIN);
  await ap.goto(`${ADM}/admin/launch`);
  await ap.waitForSelector('[data-testid=launch-page]');
  for (const k of ['config_guard', 'tls_hsts', 'admin_origin', 'backups_fresh', 'backups_offsite', 'restore_drill', 'alerts_contact', 'key_ages', 'audit_anchor', 'flags_launch']) {
    await ap.waitForSelector(`[data-testid=launch-check][data-key=${k}][data-ok="1"]`, { timeout: 15000 });
  }
  for (const k of ['dependency_scan', 'image_scan', 'load_test', 'db_durability']) await ap.waitForSelector(`[data-testid=launch-check][data-key=${k}][data-ok="0"]`);
  // Commit durability (owner setting db.max_durability, off by default): SQLite runs synchronous NORMAL (1) until it is on.
  assert.equal(srv.db.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.equal(await ap.getAttribute('[data-testid=launch-gate]', 'data-enforced'), '1');
  // The waitlist target and count are shown.
  assert.equal((await set('PUT', '/v1/admin/waitlists/real_money_launch/target', { target: 500, reason: 'launch target' })).status, 200);
  await ap.waitForSelector('[data-testid=launch-waitlist][data-target="500"]', { timeout: 10000 });
  // The production switch refuses and names what is open.
  const pp = await newPage();
  await uiLogIn(pp, ADM, ADMIN);
  await pp.goto(`${ADM}/admin/play_mode`);
  await pp.fill('[data-testid=switch-form] [name=reason]', 'launch day');
  await pp.fill('[data-testid=switch-form] [name=confirm]', 'RESET');
  await pp.click('[data-testid=switch-form] button[type=submit]');
  await answerStepUp(pp);
  const err = await pp.waitForSelector('[data-testid=switch-form] [data-form-error]:not(:empty)');
  const text = await err.textContent();
  for (const label of ['Dependency scan clean', 'Container image scan clean', 'Load test within targets', 'Maximum durability on', 'External penetration test']) assert.ok(text.includes(label), `the refusal names "${label}": ${text}`);
  const api = await set('POST', '/v1/admin/play_mode/production_switch', { reason: 'launch day', confirm: 'RESET' });
  assert.equal(api.code, 'launch_not_ready'); assert.ok(api.body.error.blocking.length >= 8);
  // A check turns red live: maintenance on → "Switches in their launch state" red; off → green.
  assert.equal((await set('PUT', '/v1/admin/flags/ops.maintenance', { enabled: true, reason: 'red check' })).status, 200);
  await ap.waitForSelector('[data-testid=launch-check][data-key=flags_launch][data-ok="0"]', { timeout: 10000 });
  assert.equal((await set('PUT', '/v1/admin/flags/ops.maintenance', { enabled: false, reason: 'green again' })).status, 200);
  await ap.waitForSelector('[data-testid=launch-check][data-key=flags_launch][data-ok="1"]', { timeout: 10000 });
  // Evidence: a dependency scan recorded in the UI turns its check green live; the image scan and load test by API
  // (a load report outside the targets stays red until a passing one is recorded).
  await ap.click('[data-testid=launch-evidence]');
  await ap.selectOption('[data-testid=launch-evidence-form] [name=kind]', 'dependency_scan');
  await ap.fill('[data-testid=launch-evidence-form] [name=report]', JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }));
  await ap.fill('[data-testid=launch-evidence-form] [name=reason]', 'npm audit from CI');
  await ap.click('[data-testid=launch-evidence-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=launch-check][data-key=dependency_scan][data-ok="1"]', { timeout: 10000 });
  assert.equal((await admin.call('POST', '/v1/admin/launch_readiness/evidence', { kind: 'image_scan', report: { tool: 'trivy', critical: 0, high: 0, medium: 3, low: 9 }, reason: 'trivy from CI' })).status, 201);
  assert.equal((await admin.call('POST', '/v1/admin/launch_readiness/evidence', { kind: 'load_test', report: { results: { orders_per_sec: 60, order_p99_ms: 900, ws_fanout_p99_ms: 4, page_p95_ms: 300 } }, reason: 'too slow' })).status, 201);
  await ap.waitForSelector('[data-testid=launch-check][data-key=load_test][data-ok="0"]', { timeout: 10000 });
  assert.equal((await admin.call('POST', '/v1/admin/launch_readiness/evidence', { kind: 'load_test', report: { machine: 'staging 4 vCPU', results: { orders_per_sec: 210, order_p99_ms: 40, ws_fanout_p99_ms: 120, page_p95_ms: 180 } }, reason: 'staging run' })).status, 201);
  await ap.waitForSelector('[data-testid=launch-check][data-key=load_test][data-ok="1"]', { timeout: 10000 });
  // Maximum durability on (step-up, reason): every commit waits for the disk (synchronous FULL = 2), the check turns green.
  assert.equal((await set('PUT', '/v1/admin/owner_settings/db.max_durability', { value: true, reason: 'durable commits before real money' })).status, 200);
  assert.equal(srv.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  await ap.waitForSelector('[data-testid=launch-check][data-key=db_durability][data-ok="1"]', { timeout: 10000 });
  // Owner items: one ticked in the UI (note + date, step-up), the rest by API.
  await ap.click('[data-testid=launch-item][data-key=pen_test] [data-testid=launch-item-edit]');
  await ap.setChecked('[data-testid=launch-item-form] [name=done]', true);
  await ap.fill('[data-testid=launch-item-form] [name=note]', 'Vendor X, report PX-2026-11, all findings closed');
  await ap.fill('[data-testid=launch-item-form] [name=reason]', 'pen test closed');
  await ap.click('[data-testid=launch-item-form] button[type=submit]');
  await answerStepUp(ap);
  await ap.waitForSelector('[data-testid=launch-item][data-key=pen_test][data-done="1"]', { timeout: 10000 });
  for (const k of ['terms_privacy', 'ndpa', 'support', 'incident_contacts']) {
    assert.equal((await set('PUT', `/v1/admin/launch_readiness/items/${k}`, { done: true, done_date: '2026-11-09', note: 'done', reason: 'launch checklist' })).status, 200);
  }
  await ap.waitForSelector('[data-testid=launch-page][data-ready="1"]', { timeout: 15000 });
  // Now the switch is allowed: request (admin 1), approve (admin 2); the encrypted pre-production backup is written first.
  const req = await set('POST', '/v1/admin/play_mode/production_switch', { reason: 'launch day', confirm: 'RESET' });
  assert.equal(req.status, 202, req.text);
  const ok = await stepped(admin2)('POST', `/v1/admin/play_mode/approvals/${req.body.approval.id}/approve`, { confirm: 'RESET' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.play_mode.on, false);
  const key = ok.body.result.backup_file;
  assert.match(key, /^snapshots\/.*pre_production/);
  const sealed = fs.readFileSync(path.join(OFFSITE, ...key.split('/')));
  assert.ok(!sealed.includes(Buffer.from('SQLite format 3')), 'the pre-production backup is encrypted');
  const plain = openBackup(sealed, backupKeys({ dir: DATA }));
  assert.ok(plain.subarray(0, 15).equals(Buffer.from('SQLite format 3')), 'and opens with the backup key');
});

test('a restart keeps the switches, owner items, contacts and evidence', async () => {
  await srv.close();
  srv = await start(OPTS);
  const a = await new Client(ADM, 'admin-r').logIn(ADMIN.email, PW);
  const r = (await a.call('GET', '/v1/admin/launch_readiness')).body;
  assert.ok(r.items.every((i) => i.done), 'owner items kept');
  assert.ok(r.checks.find((c) => c.key === 'dependency_scan').ok && r.checks.find((c) => c.key === 'load_test').ok, 'evidence kept');
  // Maximum durability stays on and is applied at start (synchronous FULL = 2).
  assert.ok(r.checks.find((c) => c.key === 'db_durability').ok, 'durability setting kept');
  assert.equal(srv.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  const s = (await a.call('GET', '/v1/admin/system')).body;
  assert.ok(s.alerts.contacts.some((c) => c.confirmed && c.kind === 'webhook'), 'confirmed contact kept');
  assert.ok(s.switches.every((x) => !['ops.maintenance', 'ops.trading_halt', 'ops.read_only'].includes(x.key) || !x.on));
  assert.equal((await a.call('GET', '/v1/admin/owner_settings/admin.ip_allowlist')).body.setting.value, '');
  assert.ok(s.restore_drill.last_ok && s.backups.last_backup && s.anchor.anchor);
});
