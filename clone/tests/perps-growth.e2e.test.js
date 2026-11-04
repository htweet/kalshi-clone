'use strict';
// End-to-end browser tests for Perps completion, P6.3 (CLONE_SPEC.md §34.7–§34.9): APY on Perps collateral (admin-set
// rate, accrual job on a clock injected through the start options only, payouts from the promotions treasury: queued
// while it is empty, paid FIFO when funded, refused per setting; play money in play mode), Perps referrals (codes,
// fraud checks, rewards into Perps collateral, lifetime caps), the waitlist (join, position, gate enforced on the
// server, bulk invite / approve / revoke in Admin › Perps ops, CMS-managed notifications and emails, live unlock), and
// the switch to production archiving and zeroing every new balance (subaccounts, APY accruals, pending referrals).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const journal = require('../server/journal.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-perps-growth-'));
const DB_FILE = path.join(TMP, 'perps-growth.db');
const PORT = 25000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'Meadow-Signal-Tundra-3907';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const DAY = 86400000;
let clock = Date.now(); // the APY accrual clock (start option `perps.apy.now`, ignored in production)
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, perps: { apy: { now: () => clock } } };
const BTC = 'PLXBTCPERP';
const email = (n) => `${n}.p63.${stamp}@example.test`;

let srv; let browser; let admin;
const allPages = [];
const dbq = (file, sql, ...a) => { const d = new DatabaseSync(file); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const q1 = (sql, ...a) => dbq(DB_FILE, sql, ...a)[0];
const qa = (sql, ...a) => dbq(DB_FILE, sql, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, { timeout = 10000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { return await fn(); } catch (e) { if (Date.now() > end) throw e; } await sleep(interval); }
}
const ledgerOk = (s = srv) => { const a = journal.audit(s.db); assert.ok(a.ok, JSON.stringify(a.problems.slice(0, 5))); };
async function newPage(viewport = { width: 1400, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  allPages.push(page);
  return page;
}
async function uiLogIn(page, u, base = BASE) {
  await page.goto(base + '/sign-in');
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', u.password || PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
const stepUp = (c) => async (method, p, body) => {
  let r = await c.call(method, p, body);
  if (r.code === 'step_up_required') { assert.equal((await c.call('POST', '/v1/step_up', { password: PW })).status, 200); r = await c.call(method, p, body); }
  return r;
};
const adminCall = (...a) => stepUp(admin)(...a);
async function user(name, { dollars = 0, perps = 0, base = BASE } = {}) {
  const c = await new Client(base, name).signUp(email(name), PW, `${name[0].toUpperCase()}${name.slice(1)} Growth`);
  if (dollars) assert.equal((await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: dollars })).status, 201);
  if (perps) assert.equal((await c.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: perps })).status, 201);
  return c;
}
const avail = (uid, sub = 0) => (sub ? q1('SELECT available_cc c FROM perp_subaccounts WHERE user_id=? AND subaccount=?', uid, sub).c : q1('SELECT available_cc c FROM perp_accounts WHERE user_id=?', uid).c);
const apyState = () => JSON.parse(q1("SELECT value FROM admin_settings WHERE key='perps_apy_state'")?.value || '{}');

before(async () => {
  srv = await start(OPTS);
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  srv.engine.perps.setIndex(BTC, 100000, { freeze: true });
  // The promotions treasury (Central Bank, CLONE_SPEC.md §33.7) starts off; production pays APY and rewards from it.
  assert.equal((await adminCall('PUT', '/v1/admin/flags/central_bank', { enabled: true, reason: 'treasury for perps rewards' })).status, 200);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

let frank;
test('APY on collateral: set in Admin › Perps ops, accrued on the injected clock, queued while the treasury is empty, paid when funded, refused per setting', async () => {
  frank = await user('frank', { dollars: 3000, perps: 1500 });
  assert.equal((await frank.call('POST', '/v1/perps/subaccounts', { name: 'Savings' })).status, 201);
  assert.equal((await frank.call('POST', '/v1/perps/subaccounts/transfers', { from_subaccount: 0, to_subaccount: 1, amount_dollars: 500 })).status, 201);
  // Admin › Perps ops › APY: 10% a year, paid every 60 minutes (of the accrual clock).
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/perps');
  await ap.waitForSelector('[data-testid=pops-apy-form]');
  await ap.check('#f-papy-enabled');
  await ap.fill('#f-papy-rate_percent', '10');
  await ap.fill('#f-papy-payout_minutes', '60');
  await ap.fill('#f-papy-reason', 'launch collateral interest');
  await ap.click('[data-testid=pops-apy-form] button[type=submit]');
  await eventually(() => assert.equal(JSON.parse(q1("SELECT value FROM admin_settings WHERE key='perps_apy'").value).rate_bps, 1000));
  assert.match(await ap.textContent('[data-testid=pops-apy-source]'), /promotions treasury/);
  await eventually(() => assert.equal(apyState().last_ts, clock)); // the job starts its clock (no backdated interest)
  // 36.5 days later (a tenth of a year): 1% of each subaccount's collateral, per subaccount; the vault is empty → queued.
  clock += 36.5 * DAY + 60000;
  await eventually(() => assert.equal(qa('SELECT * FROM perp_apy_payouts WHERE user_id=?', frank.uid).length, 2));
  const pays = qa('SELECT subaccount, amount_cents, status, source FROM perp_apy_payouts WHERE user_id=? ORDER BY subaccount', frank.uid).map((x) => Object.values(x));
  assert.deepEqual(pays, [[0, 1000, 'queued', 'treasury'], [1, 500, 'queued', 'treasury']]);
  assert.equal(avail(frank.uid), 10000000);
  assert.equal(avail(frank.uid, 1), 5000000);
  assert.equal(qa("SELECT * FROM cb_payout_queue WHERE user_id=? AND status='queued' AND dest_json LIKE '%perps%'", frank.uid).length, 2);
  // The user sees the rate and the queued payouts (Perps portfolio › Rewards).
  const page = await newPage();
  await uiLogIn(page, { email: email('frank') });
  await page.goto(BASE + '/portfolio?perpsTab=rewards');
  await page.waitForSelector('[data-testid=perps-apy] [data-testid=perp-apy-row]');
  assert.equal(await page.textContent('[data-testid=apy-rate]'), '10.00% a year');
  assert.equal(await page.locator('[data-testid=perp-apy-row][data-status=queued]').count(), 2);
  // Funding the vault pays the queue FIFO into each subaccount (journaled: bank:vault → perps:collateral → subaccount).
  assert.equal((await adminCall('POST', '/v1/admin/central_bank/fund', { amount_dollars: 100, reason: 'rewards budget' })).status, 200);
  await eventually(() => assert.equal(avail(frank.uid), 10100000));
  assert.equal(avail(frank.uid, 1), 5050000);
  assert.deepEqual(qa('SELECT status FROM perp_apy_payouts WHERE user_id=?', frank.uid).map((x) => x.status), ['paid', 'paid']);
  assert.equal(q1("SELECT COALESCE(SUM(p.amount_cents),0) c FROM journal_postings p JOIN journal_entries e ON e.id=p.entry_id WHERE e.kind='apy' AND p.account='bank:vault'").c, -1500);
  assert.equal(q1("SELECT COALESCE(SUM(amount_cc),0) c FROM perp_ledger WHERE user_id=? AND kind='apy'", frank.uid).c, 150000);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=perp-apy-row][data-status=paid]').length === 2);
  assert.equal(q1("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='perps_apy'", frank.uid).c >= 1, true);
  ledgerOk();
  // Refused per setting: an empty vault with on_empty=refuse drops the payout (no budget, no payout).
  const vault = journal.balanceOf(srv.db, 'bank:vault');
  assert.equal((await adminCall('POST', '/v1/admin/central_bank/defund', { amount_dollars: vault / 100, reason: 'empty the budget' })).status, 200);
  assert.equal((await adminCall('PUT', '/v1/admin/central_bank/settings', { treasury: { on_empty: 'refuse' }, reason: 'refuse when empty' })).status, 200);
  clock += 36.5 * DAY + 60000;
  await eventually(() => assert.equal(qa("SELECT * FROM perp_apy_payouts WHERE user_id=? AND status='refused'", frank.uid).length, 2));
  assert.equal(avail(frank.uid), 10100000, 'nothing paid');
  assert.ok(q1('SELECT COALESCE(SUM(accrued_cc),0) c FROM perp_apy_accruals WHERE user_id=?', frank.uid).c < 100, 'refused interest is dropped');
  // The flag off: the API refuses and the job pauses (no accrual while off, none backdated when it comes back).
  assert.equal((await adminCall('PUT', '/v1/admin/flags/perps.apy', { enabled: false, reason: 'pause apy' })).status, 200);
  assert.equal((await frank.call('GET', '/v1/perps/apy')).code, 'feature_disabled');
  await eventually(() => assert.equal(apyState().last_ts, null));
  const acc0 = q1('SELECT COALESCE(SUM(accrued_cc),0) c FROM perp_apy_accruals').c;
  clock += 30 * DAY;
  await sleep(800);
  assert.equal(q1('SELECT COALESCE(SUM(accrued_cc),0) c FROM perp_apy_accruals').c, acc0);
  assert.equal((await adminCall('PUT', '/v1/admin/flags/perps.apy', { enabled: true, reason: 'resume apy' })).status, 200);
  await eventually(() => assert.equal(apyState().last_ts, clock));
  assert.equal(q1('SELECT COALESCE(SUM(accrued_cc),0) c FROM perp_apy_accruals').c, acc0);
  assert.equal((await adminCall('PUT', '/v1/admin/central_bank/settings', { treasury: { on_empty: 'queue' }, reason: 'queue again' })).status, 200);
  assert.equal((await adminCall('PUT', '/v1/admin/perps_ops/apy', { enabled: false, reason: 'stop interest for the next tests' })).status, 200);
  ledgerOk();
  assert.deepEqual(page.errors, []); assert.deepEqual(ap.errors, []);
});

test('referrals: share a code, a friend adds it and trades, both are rewarded into Perps collateral; fraud checks and caps', async () => {
  assert.equal((await adminCall('POST', '/v1/admin/central_bank/fund', { amount_dollars: 200, reason: 'referral budget' })).status, 200);
  const grace = await user('grace', { dollars: 100 });
  const gp = await newPage();
  await uiLogIn(gp, { email: email('grace') });
  await gp.goto(BASE + '/portfolio?perpsTab=rewards');
  await gp.waitForSelector('[data-testid=perps-referrals] [data-testid=ref-code]');
  const code = (await gp.textContent('[data-testid=ref-code]')).trim();
  assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.equal(q1('SELECT user_id FROM referral_codes WHERE code=?', code).user_id, grace.uid);
  // Henry adds the code in the UI.
  const henry = await user('henry', { dollars: 500, perps: 300 });
  const hp = await newPage();
  await uiLogIn(hp, { email: email('henry') });
  await hp.goto(BASE + '/portfolio?perpsTab=rewards');
  await hp.waitForSelector('[data-testid=ref-input]');
  await hp.fill('[data-testid=ref-input]', code.toLowerCase());
  await hp.click('[data-testid=ref-apply]');
  await hp.waitForSelector('[data-testid=ref-referred]');
  assert.match(await hp.textContent('[data-testid=ref-referred]'), /pending/);
  // Fraud checks: own code, a second code, an unknown code, guessing (rate limit).
  assert.equal((await grace.call('POST', '/v1/perps/referrals/apply', { code })).code, 'referral_self');
  assert.equal((await henry.call('POST', '/v1/perps/referrals/apply', { code })).code, 'referral_already_used');
  const ivan = await user('ivan', { dollars: 500, perps: 300 });
  for (let i = 0; i < 5; i++) assert.equal((await ivan.call('POST', '/v1/perps/referrals/apply', { code: `ZZZZZZZZ${i}` })).code, 'referral_code_invalid');
  assert.equal((await ivan.call('POST', '/v1/perps/referrals/apply', { code })).status, 429);
  // Henry trades $110 of Perps volume (threshold $100): both rewards are paid from the treasury into Perps collateral.
  const h0 = avail(henry.uid);
  assert.equal((await henry.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 11, leverage: 5 })).status, 201);
  await eventually(() => assert.equal(q1("SELECT status FROM referrals WHERE referee_id=?", henry.uid).status, 'rewarded'));
  const rw = qa('SELECT user_id, role, amount_cents, status FROM referral_rewards ORDER BY role').map((x) => Object.values(x));
  assert.deepEqual(rw, [[henry.uid, 'referee', 500, 'paid'], [grace.uid, 'referrer', 1000, 'paid']]);
  assert.equal(avail(grace.uid), 100000);
  const fill = q1("SELECT fee_cc, count, price_cc FROM perp_fills WHERE user_id=? AND source='user'", henry.uid);
  const pos = q1('SELECT margin_cc FROM perp_positions WHERE user_id=? AND ticker=?', henry.uid, BTC);
  assert.equal(avail(henry.uid), h0 - pos.margin_cc - fill.fee_cc + 50000);
  assert.equal(q1("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='referral_reward'", grace.uid).c, 1);
  await gp.goto(BASE + '/portfolio?perpsTab=rewards');
  await gp.waitForSelector('[data-testid=perp-reward-row][data-role=referrer][data-status=paid]');
  assert.equal(await gp.textContent('[data-testid=ref-earned]'), '₦1,000');
  assert.match(await gp.textContent('[data-testid=ref-counts]'), /0 pending · 1 completed · 0 expired/);
  // Too late: a user who already traded Perps cannot add a code afterwards.
  assert.equal((await ivan.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 1, leverage: 5 })).status, 201);
  // Admin › Perps ops › Referrals: lifetime cap of one rewarded referral per referrer (reason, step-up, audit).
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/perps');
  await ap.waitForSelector('[data-testid=pops-ref-form]');
  await ap.fill('#f-pref-lifetime_cap_count', '1');
  await ap.fill('#f-pref-reason', 'one reward per referrer during the beta');
  await ap.click('[data-testid=pops-ref-form] button[type=submit]');
  await eventually(() => assert.equal(JSON.parse(q1("SELECT value FROM admin_settings WHERE key='referrals:perps'").value).lifetime_cap_count, 1));
  assert.equal(q1("SELECT reason FROM admin_audit WHERE action='perps.referrals' ORDER BY ts DESC LIMIT 1").reason, 'one reward per referrer during the beta');
  const jack = await user('jack', { dollars: 500, perps: 300 });
  assert.equal((await jack.call('POST', '/v1/perps/referrals/apply', { code })).status, 201);
  assert.equal((await jack.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 12, leverage: 5 })).status, 201);
  await eventually(() => assert.equal(q1('SELECT status FROM referrals WHERE referee_id=?', jack.uid).status, 'rewarded'));
  assert.deepEqual(qa('SELECT role, status FROM referral_rewards WHERE referral_id=(SELECT id FROM referrals WHERE referee_id=?) ORDER BY role', jack.uid).map((x) => [x.role, x.status]), [['referee', 'paid'], ['referrer', 'capped']]);
  assert.equal(avail(grace.uid), 100000, 'no second referrer reward over the cap');
  const ivanLate = await ivan.call('POST', '/v1/perps/referrals/apply', { code });
  assert.ok(['referral_too_late', 'too_many_requests'].includes(ivanLate.code), ivanLate.text);
  ledgerOk();
  for (const p of [gp, hp, ap]) assert.deepEqual(p.errors, []);
});

test('referrals: volume the friend trades against the referrer never counts towards the reward', async () => {
  const kim = await user('kim', { dollars: 500, perps: 300 });
  const lena = await user('lena', { dollars: 500, perps: 300 });
  const code = (await kim.call('GET', '/v1/perps/referrals')).body.referrals.referral_code;
  assert.equal((await lena.call('POST', '/v1/perps/referrals/apply', { code })).status, 201);
  // Kim rests an ask at the mark ($10.0000, inside the liquidity account's quotes); Lena buys exactly into it: the pair
  // trading with each other ($110 of volume, above the $100 threshold) does not qualify the referral.
  const ask = await kim.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'ask', type: 'limit', price: '10.0000', count: 11, leverage: 5 });
  assert.equal(ask.status, 201, ask.text);
  assert.equal((await lena.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 11, leverage: 5 })).status, 201);
  const fills = qa("SELECT f.user_id FROM perp_fills f WHERE f.trade_id IN (SELECT trade_id FROM perp_fills WHERE user_id=? AND source='user')", lena.uid).map((x) => x.user_id).sort();
  assert.deepEqual(fills, [kim.uid, lena.uid].sort(), 'every fill of Lena was against Kim');
  await sleep(500);
  const r0 = q1('SELECT status, progress_cents FROM referrals WHERE referee_id=?', lena.uid);
  assert.deepEqual([r0.status, r0.progress_cents], ['pending', 0]);
  assert.equal(q1('SELECT COUNT(*) c FROM referral_rewards WHERE referral_id=(SELECT id FROM referrals WHERE referee_id=?)', lena.uid).c, 0);
  const lp = await newPage();
  await uiLogIn(lp, { email: email('lena') });
  await lp.goto(BASE + '/portfolio?perpsTab=rewards');
  await lp.waitForSelector('[data-testid=ref-referred]');
  assert.match(await lp.textContent('[data-testid=ref-referred]'), /: pending, ₦0 of ₦10,000 traded/);
  // Volume against anyone else counts: the same size from the liquidity account qualifies it, and both are paid.
  assert.equal((await lena.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 11, leverage: 5 })).status, 201);
  await eventually(() => assert.equal(q1('SELECT status FROM referrals WHERE referee_id=?', lena.uid).status, 'rewarded'));
  assert.deepEqual(qa('SELECT role, status FROM referral_rewards WHERE referral_id=(SELECT id FROM referrals WHERE referee_id=?) ORDER BY role', lena.uid).map((x) => [x.role, x.status]), [['referee', 'paid'], ['referrer', 'paid']]);
  await lp.goto(BASE + '/portfolio?perpsTab=rewards');
  await lp.waitForSelector('[data-testid=ref-referred]');
  assert.match(await lp.textContent('[data-testid=ref-referred]'), /: rewarded,/);
  ledgerOk();
  assert.deepEqual(lp.errors, []);
});

test('waitlist: the gate is enforced on the server; join and see your position; bulk invite unlocks a page live; CMS email; revoke', async () => {
  assert.equal((await adminCall('PUT', '/v1/admin/flags/perps.waitlist', { enabled: true, reason: 'perps by invitation' })).status, 200);
  // Grandfathered: Frank already traded Perps.
  assert.equal((await frank.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 1, leverage: 5 })).status, 201);
  const kate = await user('kate', { dollars: 200 });
  const kp = await newPage();
  await uiLogIn(kp, { email: email('kate') });
  await kp.goto(BASE + `/perps/${BTC}`);
  await kp.waitForSelector('[data-testid=perps-waitlist][data-status=not_joined]');
  await kp.click('[data-testid=waitlist-join]');
  await kp.waitForSelector('[data-testid=perps-waitlist][data-status=waiting]');
  assert.equal(await kp.textContent('[data-testid=waitlist-position]'), "You're number 1 of 1 in line.");
  assert.equal(q1('SELECT status FROM perp_waitlist WHERE user_id=?', kate.uid).status, 'waiting');
  assert.equal(q1("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='perps_waitlist_joined'", kate.uid).c, 1);
  await eventually(() => assert.ok(q1("SELECT 1 FROM email_outbox WHERE user_id=? AND subject='You joined the Perps waitlist' AND body LIKE '%number 1 in line%'", kate.uid)));
  // Enforced on the server: no money in, no orders; market data stays public; moving money out is always possible.
  let r = await kate.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 50 });
  assert.equal(r.status, 403); assert.equal(r.code, 'perps_waitlist'); assert.equal(r.body.error.waitlist.position, 1);
  assert.equal((await kate.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 1 })).code, 'perps_waitlist');
  assert.equal((await kate.call('POST', '/v1/perps/subaccounts', { name: 'x' })).code, 'perps_waitlist');
  assert.equal((await kate.call('GET', '/v1/perps/markets')).status, 200);
  assert.equal((await kate.call('POST', '/v1/perps/transfers', { direction: 'to_predictions', amount_dollars: 1 })).code, 'insufficient_margin', 'not refused by the gate');
  const liam = await user('liam', { dollars: 200 });
  assert.equal((await liam.call('POST', '/v1/perps/waitlist', {})).body.waitlist.position, 2);
  // The approval email is CMS-managed (Admin › Content › Templates): publish a new subject for email.perps_waitlist_approved.
  const tpl = { email_subject: 'Welcome aboard, {{name}}', email_text: 'Hi {{name}}, your Perps access is open: {{link}}', email_html: '<p>Hi {{name}}, your Perps access is open.</p><p><a href="{{link}}">Open Perps</a></p>' };
  assert.equal((await adminCall('PUT', '/v1/admin/cms/template/draft', { key: 'email.perps_waitlist_approved', value: tpl })).status, 200);
  assert.equal((await adminCall('POST', '/v1/admin/cms/template/publish', { key: 'email.perps_waitlist_approved', reason: 'waitlist welcome email' })).status, 200);
  // Admin › Perps ops › Waitlist: invite the next 1 in line (Kate); her open page unlocks live.
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/perps');
  await ap.waitForSelector(`[data-testid=pops-waitlist-row][data-user="${kate.uid}"][data-status=waiting]`);
  await ap.fill('[data-testid=pops-invite-count]', '1');
  await ap.click('[data-testid=pops-invite]');
  await ap.fill('[data-testid=confirm-reason]', 'first wave');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector(`[data-testid=pops-waitlist-row][data-user="${kate.uid}"][data-status=approved]`);
  await kp.waitForSelector('[data-testid=perp-ticket] [data-testid=perp-submit]'); // no reload
  assert.equal(await kp.locator('[data-testid=perps-waitlist]').count(), 0);
  await eventually(() => assert.ok(q1("SELECT 1 FROM email_outbox WHERE user_id=? AND subject='Welcome aboard, Kate Growth' AND body LIKE '%/perps%'", kate.uid)));
  assert.equal(q1("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='perps_waitlist_approved'", kate.uid).c, 1);
  assert.equal(q1("SELECT reason FROM admin_audit WHERE action='perps.waitlist.invite' ORDER BY ts DESC LIMIT 1").reason, 'first wave');
  assert.equal((await kate.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 50 })).status, 201);
  assert.equal((await kate.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 1, leverage: 5 })).status, 201);
  assert.equal((await liam.call('GET', '/v1/perps/waitlist')).body.waitlist.position, 1);
  // Approve Liam and revoke Kate with the row checkboxes.
  await ap.reload();
  await ap.waitForSelector(`[data-pick="${liam.uid}"]`);
  await ap.check(`[data-pick="${liam.uid}"]`);
  await ap.click('[data-testid=pops-approve]');
  await ap.fill('[data-testid=confirm-reason]', 'second wave');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector(`[data-testid=pops-waitlist-row][data-user="${liam.uid}"][data-status=approved]`);
  await ap.check(`[data-pick="${kate.uid}"]`);
  await ap.click('[data-testid=pops-revoke]');
  await ap.fill('[data-testid=confirm-reason]', 'access paused for review');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector(`[data-testid=pops-waitlist-row][data-user="${kate.uid}"][data-status=revoked]`);
  await kp.waitForSelector('[data-testid=perps-waitlist][data-status=revoked]');
  assert.equal((await kate.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 1, leverage: 5 })).code, 'perps_waitlist');
  // A revoked user can still close and move money back to Predictions.
  assert.equal((await kate.call('POST', `/v1/perps/positions/${BTC}/close`, {})).status, 200);
  assert.equal((await kate.call('POST', '/v1/perps/transfers', { direction: 'to_predictions', amount_dollars: 10 })).status, 201);
  assert.equal((await liam.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 20 })).status, 201);
  // Persistence across a restart: statuses and the gate.
  await srv.close();
  srv = await start(OPTS);
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  assert.deepEqual(qa('SELECT user_id, status FROM perp_waitlist WHERE user_id IN (?,?) ORDER BY status', kate.uid, liam.uid).map((x) => x.status), ['approved', 'revoked']);
  const k2 = await new Client(BASE, 'kate2').logIn(email('kate'), PW);
  assert.equal((await k2.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 1, leverage: 5 })).code, 'perps_waitlist');
  // The gate off: everyone trades again.
  assert.equal((await adminCall('PUT', '/v1/admin/flags/perps.waitlist', { enabled: false, reason: 'open to all' })).status, 200);
  assert.equal((await k2.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 1, leverage: 5 })).status, 201);
  assert.equal((await k2.call('GET', '/v1/perps/waitlist')).code, 'feature_disabled');
  ledgerOk();
  for (const p of [kp, ap]) assert.deepEqual(p.errors, []);
});

test('play mode: APY and referral rewards are play money; the switch to production archives and zeroes subaccounts, accruals and pending referrals', async () => {
  // A separate play-mode exchange (the reverse guard needs a database without real money).
  const file = path.join(TMP, 'perps-play.db');
  const port = PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  let clk = Date.now();
  const A2 = { email: `second.${stamp}@example.test`, password: PW };
  const s2 = await start({ ...OPTS, port, dbFile: file, perps: { apy: { now: () => clk } } });
  try {
    const a1 = await new Client(base, 'a1').logIn(ADMIN.email, PW);
    const c2 = await new Client(base, 'a2').signUp(A2.email, PW, 'Second Admin');
    s2.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(c2.uid);
    const a2 = await new Client(base, 'a2').logIn(A2.email, PW);
    const call1 = stepUp(a1); const call2 = stepUp(a2);
    assert.equal((await call1('PUT', '/v1/admin/play_mode', { on: true, reason: 'play money launch' })).status, 200);
    const nora = await user('nora', { base });
    const mia = await user('mia', { dollars: 1000, perps: 600, base }); // a play deposit
    assert.equal((await mia.call('POST', '/v1/perps/subaccounts', { name: 'Side' })).status, 201);
    assert.equal((await mia.call('POST', '/v1/perps/subaccounts/transfers', { from_subaccount: 0, to_subaccount: 1, amount_dollars: 200 })).status, 201);
    assert.equal((await mia.call('POST', '/v1/perps/order_groups', { kind: 'oco' })).status, 201);
    const noraCode = (await nora.call('GET', '/v1/perps/referrals')).body.referrals.referral_code;
    assert.equal((await mia.call('POST', '/v1/perps/referrals/apply', { code: noraCode })).status, 201);
    // A referral that qualifies in play mode pays both sides in play money (minted, never from the treasury).
    s2.engine.perps.setIndex(BTC, 100000, { freeze: true });
    const olga = await user('olga', { dollars: 500, perps: 300, base });
    assert.equal((await olga.call('POST', '/v1/perps/referrals/apply', { code: noraCode })).status, 201);
    assert.equal((await olga.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 11, leverage: 5 })).status, 201);
    await eventually(() => assert.equal(dbq(file, "SELECT COUNT(*) c FROM referral_rewards WHERE status='paid'")[0].c, 2));
    const refMint = dbq(file, "SELECT e.money_mode m, SUM(p.amount_cents) c FROM journal_postings p JOIN journal_entries e ON e.id=p.entry_id WHERE e.kind='referral' AND p.account='play:mint' GROUP BY e.money_mode");
    assert.deepEqual(refMint.map((x) => [x.m, x.c]), [['play', -1500]]);
    assert.equal(dbq(file, "SELECT available_cc c FROM perp_accounts WHERE user_id=?", nora.uid)[0].c, 100000);
    // APY in play mode: minted play money (play:mint → perps:collateral), stamped with the play epoch.
    assert.equal((await call1('PUT', '/v1/admin/perps_ops/apy', { enabled: true, rate_percent: 10, payout_interval_ms: 31 * DAY, reason: 'play interest' })).status, 200);
    await eventually(() => assert.equal(JSON.parse(dbq(file, "SELECT value FROM admin_settings WHERE key='perps_apy_state'")[0].value).last_ts, clk));
    clk += 31 * DAY + 60000;
    await eventually(() => assert.equal(dbq(file, "SELECT COUNT(*) c FROM perp_apy_payouts WHERE status='paid' AND source='play' AND user_id=?", mia.uid)[0].c, 2)); // both subaccounts
    const minted = dbq(file, "SELECT e.money_mode m, SUM(p.amount_cents) c FROM journal_postings p JOIN journal_entries e ON e.id=p.entry_id WHERE e.kind='apy' AND p.account='play:mint' GROUP BY e.money_mode");
    assert.equal(minted.length, 1); assert.equal(minted[0].m, 'play'); assert.ok(minted[0].c < 0);
    assert.equal(dbq(file, "SELECT COUNT(*) c FROM perp_journal_entries WHERE kind='apy' AND money_mode<>'play'")[0].c, 0);
    clk += 10 * DAY; // accrued, not yet paid
    await eventually(() => assert.ok(dbq(file, 'SELECT COALESCE(SUM(accrued_cc),0) c FROM perp_apy_accruals')[0].c > 0));
    // The preview counts the new balances.
    const pv = (await call1('GET', '/v1/admin/play_mode/preview')).body.preview;
    assert.ok(pv.counts.perps_subaccounts >= 1 && pv.counts.perps_apy_accruals >= 1 && pv.counts.referrals_pending >= 1 && pv.counts.perps_order_groups >= 1, JSON.stringify(pv.counts));
    assert.ok(Number(pv.totals.perps_apy_accrued_dollars) > 0);
    // Two-person switch to production.
    const req = await call1('POST', '/v1/admin/play_mode/production_switch', { reason: 'go live', confirm: 'RESET' });
    assert.equal(req.status, 202, req.text);
    const done = await call2('POST', `/v1/admin/play_mode/approvals/${req.body.approval.id}/approve`, { confirm: 'RESET' });
    assert.equal(done.status, 200, done.text);
    const batch = done.body.result.batch_id;
    const d = (sql, ...a) => dbq(file, sql, ...a);
    assert.equal(d('SELECT COALESCE(SUM(available_cc),0) c FROM perp_subaccounts')[0].c, 0);
    assert.equal(d('SELECT COALESCE(SUM(available_cc),0) c FROM perp_accounts WHERE user_id IN (SELECT id FROM users WHERE is_system=0)')[0].c, 0);
    const arch = d('SELECT subaccount, available_cc, apy_accrued_cc FROM pm_archive_perps_balances WHERE batch_id=? AND user_id=?', batch, mia.uid);
    assert.ok(arch.some((x) => x.subaccount === 1 && x.available_cc >= 2000000 && x.apy_accrued_cc > 0), JSON.stringify(arch));
    assert.equal(d('SELECT COUNT(*) c FROM perp_apy_accruals')[0].c, 0);
    assert.equal(d("SELECT status FROM referrals WHERE referee_id=?", mia.uid)[0].status, 'void');
    assert.equal(d("SELECT COUNT(*) c FROM perp_order_groups WHERE status='active'")[0].c, 0);
    // Every perps journal account of the play epoch is closed; only the liquidity float is open, in the real epoch.
    const open = d("SELECT account, balance_cc b FROM perp_journal_balances WHERE balance_cc<>0 AND account NOT LIKE 'perps:reset:%'");
    assert.deepEqual(open.map((x) => x.account).sort(), ['perps:lp_capital', `psub:${d("SELECT id FROM users WHERE email='liquidity@parlance.local'")[0].id}:0:avail`].sort());
    assert.equal(d("SELECT money_mode FROM perp_journal_entries WHERE kind='lp_float' ORDER BY ts DESC LIMIT 1")[0].money_mode, 'real');
    ledgerOk(s2);
    // Idempotent: the approval is closed.
    assert.equal((await call2('POST', `/v1/admin/play_mode/approvals/${req.body.approval.id}/approve`, { confirm: 'RESET' })).status, 409);
  } finally { await s2.close(); }
});

test('no page errors anywhere', () => {
  assert.deepEqual(allPages.flatMap((p) => p.errors), []);
});
