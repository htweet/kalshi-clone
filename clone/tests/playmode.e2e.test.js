'use strict';
// End-to-end tests for Phase 5D play mode, the Central Bank and the Vault Heist (CLONE_SPEC.md §33), against a real
// server, a real SQLite file and Chromium:
//   • the reverse guard (no play mode while real customer money exists) and the master switch in Admin › Play mode;
//   • the signup bonus on every new account (journaled, mode-marked), free play deposits with a daily cap, withdrawals
//     refused on every path, the "Play money" banner and labels, real rails unreachable;
//   • the Central Bank vault funded / defunded with reason and step-up (live on the heist page), the heist won and lost
//     through the UI with a test-only RNG (option, never a request field), the code hidden until the end, replays,
//     invalid guesses, timeout, jail, the daily attempt limit, the live feed and Most Wanted;
//   • two crews cracking at once never overdraw the vault (the journal still balances);
//   • persistence across a restart in play mode;
//   • the switch to production: preview, two-person rule, typed RESET, backup snapshot, every balance and position
//     archived and set to zero, customer orders canceled, archive rows, idempotent, banner gone live, the reverse guard;
//   • the promotions treasury in production: bonus credits from the budget, queued when empty and paid FIFO once funded,
//     refused per setting.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-playmode-'));
const DB_FILE = path.join(TMP, 'playmode.db');
const PORT = 22000 + Math.floor(Math.random() * 30000);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'Lantern-Harbor-Quill-6390';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const ADMIN2 = { email: `second.${stamp}@example.test`, password: PW, name: 'Second Admin' };
const HIGH = { burst: 1e6, per_second: 1e6 };
// Test-only RNG (start option): every draw takes the first remaining digit, so a 4-digit code is 0123, 5 digits 01234.
// Perps open: the waitlist gate is on by default since Phase 7A (CLONE_SPEC.md §36.1); the switch test moves play money to Perps.
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, centralBank: { rng: () => 0 }, flags: { defaults: { 'perps.waitlist': false } } };
const SNOW = 'PLXSNOW-26DEC';
const codeOf = (digits) => '0123456789'.slice(0, digits);

let srv; let browser; let admin; let admin2;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000, what = 'condition') => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(100); } };
const email = (n) => `${n}.${stamp}@example.test`;
const uidOf = (e) => dbq('SELECT id FROM users WHERE email=?', e)[0].id;
const bal = (e) => dbq('SELECT balance_cents b FROM users WHERE email=?', e)[0].b;
const acct = (a) => dbq('SELECT COALESCE(SUM(amount_cents),0) s FROM journal_postings WHERE account=?', a)[0].s;
const vault = () => acct('bank:vault');
const ngn = (cents) => `₦${cents.toLocaleString('en-NG')}`;
async function newPage(viewport = { width: 1400, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}
async function uiLogIn(page, u) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', u.password || PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function uiSignUp(page, e, name) {
  await page.goto(BASE + '/sign-up');
  await page.fill('input[name=display_name]', name);
  await page.fill('input[name=email]', e);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function call(c, method, p, body, headers) {
  let r = await c.call(method, p, body, headers);
  if (r.code === 'step_up_required') { assert.equal((await c.call('POST', '/v1/step_up', { password: PW })).status, 200); r = await c.call(method, p, body, headers); }
  return r;
}
const setFlag = async (key, change) => { const r = await call(admin, 'PUT', `/v1/admin/flags/${key}`, { ...change, reason: 'play-mode e2e' }); assert.equal(r.status, 200, r.text); };
const audit = () => journal.audit(srv.db);
// Submits a guess through the heist page.
async function uiGuess(page, guess) {
  const inputs = page.locator('[data-testid=heist-digit]');
  await inputs.first().waitFor();
  for (let i = 0; i < guess.length; i++) await inputs.nth(i).fill(guess[i]);
  await page.click('[data-testid=heist-try-btn]');
}

before(async () => {
  srv = await start(OPTS);
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  const c2 = await new Client(BASE, 'admin2').signUp(ADMIN2.email, PW, ADMIN2.name);
  srv.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(c2.uid);
  admin2 = await new Client(BASE, 'admin2').logIn(ADMIN2.email, PW);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('reverse guard: play mode cannot start while real customer money exists; then the master switch turns it on', async () => {
  const real = await new Client(BASE, 'real').signUp(email('real'), PW, 'Real Money');
  assert.equal((await real.call('POST', `/v1/users/${real.uid}/deposits`, { amount_dollars: 25 })).status, 201);
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/play_mode');
  await ap.waitForSelector('[data-testid=play-status][data-on="0"]');
  assert.match(await ap.textContent('[data-testid=real-money]'), /1 balances/);
  await ap.click('[data-testid=play-on]');
  await ap.fill('[data-testid=confirm-reason]', 'launch the fun ride');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-testid=play-on-error]:has-text("real customer money")');
  const r = await call(admin, 'PUT', '/v1/admin/play_mode', { on: true, reason: 'api attempt' });
  assert.equal(r.code, 'real_money_exists');
  assert.equal(r.body.error.real_money.balances, 1);
  // The customer withdraws everything (real money leaves); now play mode may start.
  assert.equal((await real.call('POST', `/v1/users/${real.uid}/withdrawals`, { amount_dollars: 25 })).status, 201);
  const user = await newPage();
  await uiLogIn(user, { email: email('real') });
  await user.goto(BASE + '/portfolio');
  assert.equal(await user.locator('[data-testid=play-banner]').count(), 0);
  await ap.goto(BASE + '/admin/play_mode');
  await ap.click('[data-testid=play-on]');
  await ap.fill('[data-testid=confirm-reason]', 'launch the fun ride');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-testid=play-status][data-on="1"]');
  // Live: the open user page gets the banner and the play labels without a reload.
  await user.waitForSelector('[data-testid=play-banner]', { timeout: 8000 });
  await user.waitForSelector('[data-testid=header-balance-label]:has-text("Play cash")');
  assert.equal(dbq("SELECT value FROM meta WHERE key='money_mode'")[0].value, 'play');
  assert.ok(dbq("SELECT 1 FROM admin_audit WHERE action='play_mode.on'").length);
  assert.equal((await new Client(BASE).boot().then((c) => c.call('GET', '/v1/play_mode'))).body.play_mode.on, true);
  assert.deepEqual(ap.errors, []); assert.deepEqual(user.errors, []);
});

test('signup bonus on every new account, free play deposits with a daily cap, withdrawals refused everywhere', async () => {
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/play_mode');
  const f = ap.locator('[data-testid=play-settings]');
  await f.locator('[name=bonus_enabled]').check();
  await f.locator('[name=bonus_amount]').fill('5000');
  await f.locator('[name=bonus_source]').selectOption('mint');
  await f.locator('[name=cap]').fill('10000');
  await f.locator('[name=reason]').fill('welcome everyone');
  await f.locator('button[type=submit]').click();
  await until(() => JSON.parse(dbq("SELECT value FROM admin_settings WHERE key='play_mode'")[0].value).bonus.amount_cents === 5000, 5000, 'settings saved');
  // A new account gets ₦5,000 of play money at once (minted, journaled, mode-marked) and a notice (CMS template).
  const p = await newPage();
  await uiSignUp(p, email('p1'), 'Pia Player');
  await p.waitForSelector(`[data-testid=header-balance]:has-text("${ngn(5000)}")`, { timeout: 8000 });
  await p.waitForSelector('[data-testid=play-banner]');
  const uid = uidOf(email('p1'));
  const led = dbq("SELECT kind, amount_cents, money_mode FROM ledger WHERE user_id=? AND kind='bonus'", uid)[0];
  assert.deepEqual([led.amount_cents, led.money_mode], [5000, 'play']); // 1 internal cent = ₦1 (CLONE_SPEC.md §30)
  assert.equal(acct('play:mint'), -5000);
  assert.ok(dbq("SELECT 1 FROM notifications WHERE user_id=? AND type='bonus_credited' AND title LIKE ?", uid, '%₦5,000%').length);
  // Free deposits: the play form, no payment rail.
  await p.goto(BASE + '/funds/deposit');
  await p.waitForSelector('[data-testid=play-deposit]');
  assert.equal(await p.locator('[data-testid=fund-method]').count(), 0, 'no payment methods in play mode');
  // The page says play money (not "sandbox test cards"), and the chip + heading row never overlaps the intro text.
  await p.waitForSelector('[data-testid=sandbox-note]:has-text("Play mode")');
  assert.doesNotMatch(await p.textContent('[data-testid=sandbox-note]'), /test cards/);
  const gap = await p.evaluate(() => {
    const head = document.querySelector('[data-testid=play-deposit-head]').getBoundingClientRect();
    const intro = document.querySelector('[data-testid=play-deposit-head] + p').getBoundingClientRect();
    return intro.top - head.bottom;
  });
  assert.ok(gap >= 0, `the intro starts below the heading row (gap ${gap}px)`);
  assert.match(await p.textContent('[data-testid=play-cap]'), /₦10,000/);
  await p.fill('[data-testid=play-amount]', '6000');
  await p.click('[data-testid=play-submit]');
  await p.waitForSelector('[data-testid=play-cap]:has-text("₦4,000 left")');
  await p.waitForSelector(`[data-testid=header-balance]:has-text("${ngn(11000)}")`);
  await p.fill('[data-testid=play-amount]', '5000');
  await p.click('[data-testid=play-submit]');
  await p.waitForSelector('[data-testid=play-error]:has-text("₦4,000 left")');
  const pc = await new Client(BASE, 'p1').logIn(email('p1'), PW);
  assert.equal((await pc.call('POST', `/v1/users/${uid}/deposits`, { amount_dollars: 50 })).code, 'play_deposit_cap');
  assert.equal(dbq("SELECT COUNT(*) c FROM payment_transactions WHERE user_id=? AND rail='play' AND status='succeeded'", uid)[0].c, 1);
  // Real rails are unreachable, with or without a method.
  const k = { 'Idempotency-Key': `pm-${Date.now()}` };
  assert.equal((await pc.call('POST', `/v1/users/${uid}/deposits`, { amount_dollars: 5, method_id: 'pm_x' }, k)).code, 'play_mode_rails_off');
  assert.equal((await pc.call('POST', `/v1/users/${uid}/debit/payment_session`, {})).code, 'play_mode_rails_off');
  assert.equal((await pc.call('POST', `/v1/users/${uid}/bank_link/accounts`, { institution_id: 'x' })).code, 'play_mode_rails_off');
  assert.equal((await pc.call('PUT', `/v1/users/${uid}/crypto/account`, { accept_terms: true })).code, 'play_mode_rails_off');
  // Withdrawals: refused on every path and absent from the UI.
  for (const [m, pth, b] of [['POST', `/v1/users/${uid}/withdrawals`, { amount_dollars: 1 }], ['POST', `/v1/users/${uid}/debit/withdrawal`, { card_id: 'x', amount_dollars: 1 }],
    ['POST', `/v1/users/${uid}/bank_link/withdrawal`, { bank_id: 'x', amount_dollars: 1 }], ['POST', `/v1/users/${uid}/crypto/withdrawal`, { wallet_id: 'x', amount_dollars: 1 }]]) {
    assert.equal((await call(pc, m, pth, b, k)).code, 'withdrawals_play_mode', `${m} ${pth}`);
  }
  await p.goto(BASE + '/funds/withdraw');
  await p.waitForSelector('[data-testid=money-blocked][data-code=withdrawals_play_mode]');
  await p.goto(BASE + '/funds');
  await p.waitForSelector('[data-testid=balances]');
  assert.equal(await p.locator('[data-testid=go-withdraw]').count(), 0);
  await p.goto(BASE + '/portfolio');
  await p.waitForSelector('[data-testid=play-label]');
  assert.equal(await p.locator('[data-act=withdraw]').count(), 0);
  assert.equal(bal(email('p1')), 11000);
  assert.ok(audit().ok, JSON.stringify(audit().problems));
  assert.deepEqual(p.errors, []); assert.deepEqual(ap.errors, []);
});

test('Central Bank: switched on and funded in Admin with reason and step-up; the vault is live on the heist page', async () => {
  const hp = await newPage();
  await uiLogIn(hp, { email: email('p1') });
  await hp.goto(BASE + '/heist');
  await hp.waitForSelector('[data-testid=feature-unavailable][data-feature=heist]');
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/central_bank');
  await ap.click('[data-testid=cb-toggle-bank]');
  await ap.fill('[data-testid=confirm-reason]', 'open the vault');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-testid=cb-switches]:has-text("Central Bank is ON")');
  // Funding needs a reason (and a fresh step-up, satisfied by the recent sign-in).
  await ap.fill('[data-testid=cb-fund-form] [name=amount]', '1000000');
  await ap.fill('[data-testid=cb-fund-form] [name=reason]', 'prize pot for launch week');
  await ap.click('[data-testid=cb-fund-form] button[type=submit]');
  await ap.waitForSelector(`[data-testid=cb-vault]:has-text("${ngn(1000000)}")`);
  assert.equal(vault(), 1000000);
  assert.equal(acct('bank:funding'), -1000000);
  await hp.goto(BASE + '/heist');
  await hp.waitForSelector(`[data-testid=heist-vault]:has-text("${ngn(1000000)}")`);
  // Defund ₦100,000: the open heist page follows live.
  await ap.fill('[data-testid=cb-fund-form] [name=amount]', '100000');
  await ap.fill('[data-testid=cb-fund-form] [name=reason]', 'too generous');
  await ap.click('[data-testid=cb-defund]');
  await hp.waitForSelector(`[data-testid=heist-vault]:has-text("${ngn(900000)}")`, { timeout: 8000 });
  const ops = dbq("SELECT action, reason FROM admin_audit WHERE action LIKE 'central_bank.%fund' ORDER BY ts").map((a) => [a.action, a.reason]);
  assert.deepEqual(ops, [['central_bank.fund', 'prize pot for launch week'], ['central_bank.defund', 'too generous']]);
  assert.equal((await call(admin, 'POST', '/v1/admin/central_bank/defund', { amount_dollars: 99999999, reason: 'overdraw attempt' })).code, 'insufficient_vault');
  assert.equal((await admin.call('POST', '/v1/admin/central_bank/fund', { amount_dollars: 10 })).status, 400, 'reason required');
  const stale = await new Client(BASE, 'stale').logIn(ADMIN.email, PW);
  srv.db.prepare('UPDATE sessions SET auth_at=? WHERE user_id=?').run(Date.now() - 3600000, stale.user.user_id);
  assert.equal((await stale.call('POST', '/v1/admin/central_bank/fund', { amount_dollars: 10, reason: 'no step-up' })).code, 'step_up_required');
  assert.ok(audit().ok);
  assert.deepEqual(hp.errors, []); assert.deepEqual(ap.errors, []);
});

test('Vault Heist: cracked through the UI (code hidden until the end), lost with jail, replays, timeout and the daily limit', async () => {
  const hp = await newPage();
  await uiLogIn(hp, { email: email('p1') });
  await hp.goto(BASE + '/heist');
  await hp.waitForSelector('[data-testid=heist-start]');
  const v0 = vault(); const b0 = bal(email('p1'));
  await hp.click('[data-testid=heist-start]');
  await hp.waitForSelector('[data-testid=heist-timer]');
  assert.equal(bal(email('p1')), b0 - 500, 'crew fee ₦500 paid');
  assert.equal(vault(), v0 + 500, 'the fee goes into the vault');
  const pc = await new Client(BASE, 'p1').logIn(email('p1'), PW);
  const mine = (await pc.call('GET', `/v1/users/${pc.uid}/heists`)).body;
  assert.equal(mine.active.code, null, 'the code never leaves the server while the heist runs');
  assert.ok(!JSON.stringify(mine).includes('enc:v1'), 'nor its ciphertext');
  const h = mine.active;
  assert.equal(h.digits, 4);
  // A miss, then a near miss, then the code.
  await uiGuess(hp, '4567');
  await hp.waitForSelector('[data-testid=heist-try][data-exact="0"][data-near="0"]');
  await uiGuess(hp, '1032');
  await hp.waitForSelector('[data-testid=heist-try][data-exact="0"][data-near="4"]');
  assert.equal(Number(await hp.getAttribute('[data-testid=heist-alarm]', 'data-alarm')), 20);
  await uiGuess(hp, '1123');
  await hp.waitForSelector('[data-testid=heist-error]:has-text("4 different digits")');
  await uiGuess(hp, codeOf(4));
  await hp.waitForSelector('[data-testid=heist-result][data-status=cracked]');
  assert.equal(await hp.textContent('[data-testid=heist-code]'), '0123');
  const done = dbq('SELECT * FROM cb_heists WHERE id=?', h.id)[0];
  assert.ok(done.loot_cents > 0 && done.loot_cents <= Math.min(Math.floor((v0 + 500) * 0.1), 50000), `loot within the 10% share and the ₦50,000 cap (${done.loot_cents})`);
  assert.equal(vault(), v0 + 500 - done.loot_cents);
  assert.equal(bal(email('p1')), b0 - 500 + done.loot_cents);
  assert.equal(await hp.textContent('[data-testid=heist-loot]'), ngn(done.loot_cents));
  await hp.waitForSelector('[data-testid=heist-feed-row][data-status=cracked]');
  await hp.waitForSelector('[data-testid=most-wanted-row]:has-text("Pia Player")');
  assert.equal(dbq("SELECT money_mode FROM ledger WHERE ref=? AND kind='heist_loot'", h.id)[0].money_mode, 'play');
  assert.ok(dbq("SELECT 1 FROM notifications WHERE user_id=? AND type='heist_result'", pc.uid).length);
  // Replays: the same guess number answers from the record; a finished heist takes no more guesses.
  const rp = await pc.call('POST', `/v1/users/${pc.uid}/heists/${h.id}/guesses`, { guess: '4567', n: 1 });
  assert.equal(rp.body.replayed, true); assert.equal(rp.body.result.guess, '4567');
  assert.equal((await pc.call('POST', `/v1/users/${pc.uid}/heists/${h.id}/guesses`, { guess: '9876' })).code, 'heist_over');
  assert.equal((await new Client(BASE, 'other').signUp(email('other'), PW, 'Other Crew').then((o) => o.call('POST', `/v1/users/${o.uid}/heists/${h.id}/guesses`, { guess: '0123' }))).status, 404, 'not your heist');
  // Security rose a level: fewer tries.
  const bank = (await pc.call('GET', '/v1/central_bank')).body.central_bank;
  assert.equal(bank.security_level, 1); assert.equal(bank.heist.guesses, 9);

  // A loss: run out of tries → caught, the fee stays in the vault, jail.
  await call(admin, 'PUT', '/v1/admin/central_bank/settings', { heist: { base_guesses: 4 }, reason: 'harder vault' });
  const lp = await newPage();
  await uiSignUp(lp, email('p2'), 'Lou Loser');
  await lp.goto(BASE + '/heist');
  await lp.click('[data-testid=heist-start]');
  await lp.waitForSelector('[data-testid=heist-tries-left]:has-text("3 tries left")');
  const vBefore = vault();
  for (const g of ['4567', '5678', '6789']) { await uiGuess(lp, g); await sleep(150); }
  await lp.waitForSelector('[data-testid=heist-result][data-status=caught]');
  assert.equal(await lp.textContent('[data-testid=heist-code]'), '0123');
  await lp.waitForSelector('[data-testid=heist-jailed]');
  assert.equal(vault(), vBefore, 'nothing left the vault');
  const lc = await new Client(BASE, 'p2').logIn(email('p2'), PW);
  assert.equal((await lc.call('POST', `/v1/users/${lc.uid}/heists`, {})).code, 'heist_jailed');
  await hp.waitForSelector('[data-testid=heist-feed-row][data-status=caught]', { timeout: 8000 }); // live feed on another page

  // Idempotent start: the same client id never charges twice.
  const tc = await new Client(BASE, 'p3').signUp(email('p3'), PW, 'Tia Timer');
  await call(admin, 'PUT', '/v1/admin/central_bank/settings', { heist: { timer_seconds: 10, attempts_per_day: 2 }, reason: 'speed run' });
  const s1 = await tc.call('POST', `/v1/users/${tc.uid}/heists`, { client_id: 'abc123' });
  assert.equal(s1.status, 201);
  const s2 = await tc.call('POST', `/v1/users/${tc.uid}/heists`, { client_id: 'abc123' });
  assert.equal(s2.body.replayed, true); assert.equal(s2.body.heist.id, s1.body.heist.id);
  assert.equal(dbq("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='heist_fee'", tc.uid)[0].c, 1);
  assert.equal((await tc.call('POST', `/v1/users/${tc.uid}/heists`, {})).code, 'heist_active');
  assert.equal((await tc.call('POST', `/v1/users/${tc.uid}/heists/${s1.body.heist.id}/guesses`, { guess: '0123', n: 3 })).code, 'guess_out_of_order');
  assert.equal((await tc.call('POST', `/v1/users/${tc.uid}/heists/${s1.body.heist.id}/guesses`, { guess: '01a3' })).code, 'guess_invalid');
  assert.equal((await tc.call('POST', `/v1/users/${tc.uid}/heists`, { client_id: 'x'.repeat(80) })).status, 400);
  // Timeout: the job ends it and jails the crew.
  await until(() => dbq('SELECT status FROM cb_heists WHERE id=?', s1.body.heist.id)[0].status === 'timeout', 15000, 'heist timeout');
  const after = (await tc.call('GET', `/v1/users/${tc.uid}/heists`)).body;
  assert.ok(after.jail_until && after.history[0].code === '0123');
  // Daily limit: two attempts today (the jail is lifted to show the limit applies on its own).
  await call(admin, 'PUT', '/v1/admin/central_bank/settings', { heist: { jail_minutes: 0, timer_seconds: 60 }, reason: 'no jail for the limit check' });
  const s3 = await tc.call('POST', `/v1/users/${tc.uid}/heists`, {});
  assert.equal(s3.status, 201);
  assert.equal((await tc.call('POST', `/v1/users/${tc.uid}/heists/${s3.body.heist.id}/guesses`, { guess: codeOf(s3.body.heist.digits) })).body.heist.status, 'cracked');
  assert.equal((await tc.call('POST', `/v1/users/${tc.uid}/heists`, {})).code, 'heist_daily_limit');
  await call(admin, 'PUT', '/v1/admin/central_bank/settings', { heist: { jail_minutes: 10, attempts_per_day: 5, base_guesses: 10 }, reason: 'back to normal' });
  assert.ok(audit().ok, JSON.stringify(audit().problems));
  assert.deepEqual(hp.errors, []); assert.deepEqual(lp.errors, []);
});

test('two crews cracking at once never overdraw the vault', async () => {
  const crews = [];
  for (const n of ['c1', 'c2', 'c3']) crews.push(await new Client(BASE, n).signUp(email(n), PW, `Crew ${n}`));
  // Leave ₦2,000 in the vault and let one heist take all of it.
  const left = vault() - 2000;
  assert.equal((await call(admin, 'POST', '/v1/admin/central_bank/defund', { amount_dollars: left / 100, reason: 'small vault' })).status, 200);
  await call(admin, 'PUT', '/v1/admin/central_bank/settings', { heist: { max_share_pct: 100, max_loot_cents: 100000000, max_loot_user_day_cents: 100000000 }, reason: 'winner takes all' });
  const hs = [];
  for (const c of crews) hs.push((await c.call('POST', `/v1/users/${c.uid}/heists`, {})).body.heist);
  const pot = vault();
  assert.equal(pot, 2000 + 3 * 500);
  const res = await Promise.all(crews.map((c, i) => c.call('POST', `/v1/users/${c.uid}/heists/${hs[i].id}/guesses`, { guess: codeOf(hs[i].digits), n: 1 })));
  assert.ok(res.every((r) => r.body.heist.status === 'cracked'));
  const loot = res.map((r) => Math.round(Number(r.body.heist.loot_dollars) * 100));
  assert.ok(loot.reduce((a, b) => a + b, 0) <= pot, `total loot ${loot} within the pot ${pot}`);
  assert.equal(vault(), pot - loot.reduce((a, b) => a + b, 0));
  assert.ok(vault() >= 0);
  const a = audit();
  assert.ok(a.ok, JSON.stringify(a.problems));
  await call(admin, 'PUT', '/v1/admin/central_bank/settings', { heist: { max_share_pct: 10, max_loot_cents: 50000, max_loot_user_day_cents: 100000 }, reason: 'defaults' });
  assert.equal((await call(admin, 'POST', '/v1/admin/central_bank/fund', { amount_dollars: 1000, reason: 'refill' })).status, 200);
});

test('play mode survives a restart: switch, vault, jail, history and mode markers persist', async () => {
  const v = vault(); const lvl = (await admin.call('GET', '/v1/central_bank')).body.central_bank.security_level;
  await srv.close();
  srv = await start(OPTS);
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  admin2 = await new Client(BASE, 'admin2').logIn(ADMIN2.email, PW);
  assert.equal((await admin.call('GET', '/v1/play_mode')).body.play_mode.on, true);
  assert.equal(vault(), v);
  const bank = (await admin.call('GET', '/v1/central_bank')).body.central_bank;
  assert.equal(bank.security_level, lvl);
  const lc = await new Client(BASE, 'p2').logIn(email('p2'), PW);
  assert.equal((await lc.call('POST', `/v1/users/${lc.uid}/heists`, {})).code, 'heist_jailed', 'still in jail after the restart');
  const p = await newPage();
  await uiLogIn(p, { email: email('p1') });
  await p.goto(BASE + '/heist');
  await p.waitForSelector('[data-testid=heist-feed-row]');
  await p.waitForSelector('[data-testid=play-banner]');
  assert.deepEqual(p.errors, []);
});

test('switch to production: preview, two admins, typed RESET, backup, everything archived and reset to zero', async () => {
  // Play-mode state worth resetting: a resting order, a position, perps collateral.
  const pc = await new Client(BASE, 'p1').logIn(email('p1'), PW);
  const uid = pc.uid;
  let r = await pc.call('POST', `/v1/users/${uid}/orders`, { ticker: SNOW, side: 'yes', type: 'limit', price: 2, count: 5 });
  assert.equal(r.status, 201, r.text);
  const resting = r.body.order.order_id;
  r = await pc.call('POST', `/v1/users/${uid}/orders`, { ticker: SNOW, side: 'yes', type: 'market', count: 3 });
  assert.equal(r.status, 201, r.text);
  assert.equal((await pc.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 10 })).status, 201);
  const user = await newPage();
  await uiLogIn(user, { email: email('p1') });
  await user.goto(BASE + '/portfolio');
  await user.waitForSelector('[data-testid=play-banner]');
  // Preview in the UI with exact counts.
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/play_mode');
  await ap.click('[data-testid=preview-reset]');
  await ap.waitForSelector('[data-testid=reset-preview]');
  const pv = (await admin.call('GET', '/v1/admin/play_mode/preview')).body.preview;
  assert.equal(await ap.textContent('[data-preview="count:open_orders"]'), String(pv.counts.open_orders));
  assert.ok(pv.counts.open_orders >= 1 && pv.counts.positions >= 2 && pv.counts.accounts_with_balance >= 5 && pv.counts.perps_accounts >= 1);
  // Typed RESET is required; then the request waits for a second admin.
  const sf = ap.locator('[data-testid=switch-form]');
  await sf.locator('[name=reason]').fill('launch real money');
  await sf.locator('[name=confirm]').fill('reset');
  await sf.locator('button[type=submit]').click();
  await ap.waitForSelector('[data-testid=switch-form] [role=alert]:has-text("RESET")');
  assert.equal((await call(admin, 'POST', '/v1/admin/play_mode/production_switch', { reason: 'x', confirm: 'reset' })).code, 'confirm_reset_required');
  await sf.locator('[name=confirm]').fill('RESET');
  await sf.locator('button[type=submit]').click();
  await ap.waitForSelector('[data-testid=pm-approvals] [data-status=pending]');
  const ap0 = dbq("SELECT * FROM pm_approvals WHERE status='pending'")[0];
  assert.equal((await call(admin, 'POST', `/v1/admin/play_mode/approvals/${ap0.id}/approve`, { confirm: 'RESET' })).code, 'same_admin');
  assert.equal((await call(admin, 'POST', '/v1/admin/play_mode/production_switch', { reason: 'again', confirm: 'RESET' })).code, 'approval_pending');
  assert.equal((await new Client(BASE, 'p1b').logIn(email('p1'), PW).then((c) => c.call('POST', `/v1/admin/play_mode/approvals/${ap0.id}/approve`, { confirm: 'RESET' }))).status, 403);
  // Nothing changed yet.
  assert.ok(bal(email('p1')) > 0);
  // The second admin approves in the UI, typing RESET.
  const a2 = await newPage();
  await uiLogIn(a2, ADMIN2);
  await a2.goto(BASE + '/admin/play_mode');
  await a2.click('[data-testid=approve-switch]');
  await a2.waitForSelector('[data-testid=approve-dialog] [data-testid=reset-preview]');
  await a2.fill('[data-testid=approve-form] [name=confirm]', 'RESET');
  await a2.click('[data-testid=approve-form] button[type=submit]');
  await a2.waitForSelector('[data-testid=play-status][data-on="0"]', { timeout: 15000 });
  const batch = dbq('SELECT * FROM pm_reset_batches')[0];
  assert.ok(batch && batch.approval_id === ap0.id);
  // Backup snapshot taken before the reset. Phase 9A (CLONE_SPEC.md §39.3, closing the §33.13 residual): an encrypted,
  // checksummed object in the backup store (here the default local folder next to the database), no longer a plain
  // SQLite copy; it opens with the backup key and holds the play balances.
  const backup = path.join(TMP, 'backups', ...batch.backup_file.split('/'));
  assert.ok(fs.existsSync(backup) && fs.statSync(backup).size > 0, 'backup written');
  const sealed = fs.readFileSync(backup);
  assert.ok(!sealed.includes(Buffer.from('SQLite format 3')), 'the backup is encrypted at rest');
  const plainFile = path.join(TMP, 'pre-production-check.db');
  fs.writeFileSync(plainFile, require('../server/backups').open(sealed, require('../server/backups').backupKeys({ dir: TMP })));
  const snap = new DatabaseSync(plainFile);
  assert.ok(snap.prepare('SELECT balance_cents FROM users WHERE id=?').get(uid).balance_cents > 0, 'the snapshot holds the play balances');
  snap.close();
  // Every customer balance is zero, positions and perps closed, customer orders canceled, archives written.
  assert.deepEqual(dbq('SELECT COUNT(*) c FROM users WHERE is_system=0 AND balance_cents<>0')[0].c, 0);
  assert.equal(dbq('SELECT COUNT(*) c FROM positions')[0].c, 0);
  assert.deepEqual({ ...dbq('SELECT status, cancel_reason FROM orders WHERE id=?', resting)[0] }, { status: 'canceled', cancel_reason: 'production_reset' });
  assert.equal(dbq("SELECT COUNT(*) c FROM orders o JOIN users u ON u.id=o.user_id WHERE o.status='resting' AND u.is_system=0")[0].c, 0);
  assert.equal(dbq('SELECT available_cc FROM perp_accounts WHERE user_id=?', uid)[0].available_cc, 0);
  assert.ok(dbq('SELECT COUNT(*) c FROM pm_archive_balances WHERE batch_id=?', batch.id)[0].c >= pv.counts.accounts_with_balance, 'every balance archived');
  assert.ok(dbq('SELECT 1 FROM pm_archive_balances WHERE batch_id=? AND user_id=? AND balance_cents>0 AND perps_cc>0', batch.id, uid).length);
  assert.ok(dbq('SELECT COUNT(*) c FROM pm_archive_positions WHERE batch_id=?', batch.id)[0].c >= 2);
  assert.ok(dbq('SELECT 1 FROM pm_archive_orders WHERE batch_id=? AND order_id=?', batch.id, resting).length);
  assert.ok(dbq("SELECT 1 FROM pm_archive_accounts WHERE batch_id=? AND account='bank:vault' AND balance_cents>0", batch.id).length);
  assert.equal(vault(), 0);
  // Accounts, markets and content are kept; play mode, bonus and heist are off; the real-money epoch started.
  assert.ok(dbq('SELECT 1 FROM users WHERE id=?', uid).length);
  assert.equal(dbq("SELECT value FROM meta WHERE key='money_mode'")[0].value, 'real');
  assert.equal(dbq("SELECT value FROM meta WHERE key='money_epoch'")[0].value, batch.id);
  const st = JSON.parse(dbq("SELECT value FROM admin_settings WHERE key='play_mode'")[0].value);
  assert.deepEqual([st.on, st.bonus.enabled], [false, false]);
  assert.equal(dbq("SELECT enabled FROM feature_flags WHERE key='heist'")[0].enabled, 0);
  assert.equal(dbq("SELECT money_mode FROM ledger WHERE user_id=? AND kind='play_reset'", uid)[0].money_mode, 'play', 'the reset belongs to the play epoch');
  const a = audit();
  assert.ok(a.ok, JSON.stringify(a.problems));
  assert.ok(dbq("SELECT 1 FROM admin_audit WHERE action='play_mode.production_switch'").length);
  assert.equal((await admin.call('GET', '/v1/admin/audit/verify')).body.ok, true);
  assert.ok(dbq("SELECT 1 FROM notifications WHERE user_id=? AND type='production_reset'", uid).length);
  // Live: the user's open page loses the banner and shows ₦0.
  await user.waitForSelector('[data-testid=play-banner]', { state: 'detached', timeout: 8000 });
  await user.waitForSelector(`[data-testid=header-balance]:has-text("${ngn(0)}")`, { timeout: 8000 });
  // Idempotent: the approval executes once.
  assert.equal((await call(admin2, 'POST', `/v1/admin/play_mode/approvals/${ap0.id}/approve`, { confirm: 'RESET' })).code, 'approval_closed');
  assert.equal((await call(admin, 'POST', '/v1/admin/play_mode/production_switch', { reason: 'twice', confirm: 'RESET' })).code, 'play_mode_off');
  // Real money now: deposits are real again, withdrawals work, and play mode cannot come back while it exists.
  assert.equal((await pc.call('POST', `/v1/users/${uid}/deposits`, { amount_dollars: 20 })).status, 201);
  assert.equal(dbq("SELECT money_mode FROM ledger WHERE user_id=? AND kind='deposit' ORDER BY created_at DESC LIMIT 1", uid)[0].money_mode, 'real');
  assert.equal((await call(admin, 'PUT', '/v1/admin/play_mode', { on: true, reason: 'back to play' })).code, 'real_money_exists');
  assert.equal((await pc.call('POST', `/v1/users/${uid}/heists`, {})).code, 'feature_disabled');
  await ap.goto(BASE + '/admin/play_mode');
  await ap.waitForSelector('[data-testid=reset-batch]');
  assert.deepEqual(user.errors, []); assert.deepEqual(ap.errors, []); assert.deepEqual(a2.errors, []);
});

test('promotions treasury in production: bonus credits from the budget, queued when empty and paid once funded, refused per setting', async () => {
  assert.equal(vault(), 0);
  await call(admin, 'PUT', '/v1/admin/play_mode/settings', { bonus: { enabled: true, amount_dollars: 30 }, reason: 'production welcome credit' });
  await call(admin, 'PUT', '/v1/admin/central_bank/settings', { treasury: { on_empty: 'queue' }, reason: 'queue when empty' });
  assert.equal((await call(admin, 'POST', '/v1/admin/central_bank/fund', { amount_dollars: 50, reason: 'promotions budget' })).status, 200);
  const t1 = await new Client(BASE, 't1').signUp(email('t1'), PW, 'Tom Treasury');
  assert.equal(bal(email('t1')), 3000);
  const led = { ...dbq('SELECT kind, money_mode FROM ledger WHERE user_id=?', t1.uid)[0] };
  assert.deepEqual(led, { kind: 'credit', money_mode: 'real' });
  assert.equal(journal.balanceOf(srv.db, `user:${t1.uid}:credits`), 3000, 'a non-withdrawable credit');
  assert.equal(vault(), 2000);
  assert.equal((await t1.call('POST', `/v1/users/${t1.uid}/withdrawals`, { amount_dollars: 10 })).code, 'credits_not_withdrawable');
  // Budget exhausted: the next bonus is queued (and the user told so).
  const t2 = await new Client(BASE, 't2').signUp(email('t2'), PW, 'Tara Queue');
  assert.equal(bal(email('t2')), 0);
  assert.equal(dbq("SELECT status FROM cb_payout_queue WHERE user_id=?", t2.uid)[0].status, 'queued');
  assert.ok(dbq("SELECT 1 FROM notifications WHERE user_id=? AND type='bonus_credited' AND body LIKE '%queued%'", t2.uid).length);
  // Admin › Central Bank shows the queue; funding pays it FIFO.
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/central_bank');
  await ap.waitForSelector('[data-testid=cb-queue] [data-status=queued]');
  await ap.fill('[data-testid=cb-fund-form] [name=amount]', '10000');
  await ap.fill('[data-testid=cb-fund-form] [name=reason]', 'top up the budget');
  await ap.click('[data-testid=cb-fund-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=cb-queue] [data-status=paid]');
  assert.equal(bal(email('t2')), 3000);
  assert.equal(vault(), 2000 + 10000 - 3000);
  // Refuse instead of queue: nothing is paid or queued while the budget is short.
  await call(admin, 'PUT', '/v1/admin/central_bank/settings', { treasury: { on_empty: 'refuse' }, reason: 'refuse when empty' });
  assert.equal((await call(admin, 'POST', '/v1/admin/central_bank/defund', { amount_dollars: (vault() - 1000) / 100, reason: 'shrink budget' })).status, 200);
  const t3 = await new Client(BASE, 't3').signUp(email('t3'), PW, 'Tess Refused');
  assert.equal(bal(email('t3')), 0);
  assert.equal(dbq('SELECT COUNT(*) c FROM cb_payout_queue WHERE user_id=?', t3.uid)[0].c, 0);
  // With the Central Bank off there is no production bonus at all.
  await setFlag('central_bank', { enabled: false });
  const t4 = await new Client(BASE, 't4').signUp(email('t4'), PW, 'Tad Nobonus');
  assert.equal(bal(email('t4')), 0);
  const a = audit();
  assert.ok(a.ok, JSON.stringify(a.problems));
  assert.deepEqual(ap.errors, []);
});
