'use strict';
// Payments, sandbox only (PLAN Phase 4; CLONE_SPEC.md §26). Real server + real SQLite file + Chromium:
//   card approve / decline / insufficient funds / 3-D Secure-style challenge through the UI, card payouts;
//   bank link, ACH pending → settled (unsettled funds tradable, not withdrawable), a return that reverses the credit and
//   leaves a debt; crypto deposit address, confirmations, a new withdrawal address with step-up, a cooling period, the
//   AML hold on the first withdrawal and its release; withdrawal two-factor; signed webhooks (unsigned, bad signature,
//   stale and replayed events refused and logged); Idempotency-Key required; withdrawal limits and AML cases;
//   reconciliation mismatch and resolution (audit chain); non-withdrawable credits; the double-entry ledger audit;
//   a pending job resuming after a restart; and no card number in the database, logs or responses.
// Invented data only: sandbox test card numbers, sandbox banks, a sandbox chain.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');
const { totp } = require('../server/features.js');
const kc = require('../server/crypto.js');
const { Client } = require('./lib/client');
const H = require('./lib/identity-helpers');

// ---- everything the server logs, and every API response body, is kept to prove no card number leaks (PCI scope).
const LOGS = [];
for (const k of ['log', 'info', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { LOGS.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); orig(...a); };
}
const RESPONSES = [];
const origCall = Client.prototype.call;
Client.prototype.call = async function call(...a) { const r = await origCall.apply(this, a); RESPONSES.push(r.text || ''); return r; };

const CARDS = { approve: '4000991000000002', decline: '4000992000000000', insufficient: '4000993000000008', challenge: '4000994000000006', other: '4111111111111111' };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-payments-'));
const DB_FILE = path.join(TMP, 'payments.db');
const PW = 'Harbor-Ledger-Copper-4417';
const ADMIN = { email: 'root.payments@example.test', password: 'Ledger-Keeper-2026!' };
const HIGH = { burst: 1e6, per_second: 1e6 };
const stamp = Date.now();
const email = (k) => `${k}.${stamp}@example.test`;
let PORT; let BASE; let srv; let browser; let admin;
const D = H.db(DB_FILE);
const opts = (port) => ({
  port, dbFile: DB_FILE, tickMs: 300, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH },
  auth: { stepUpMs: 60000 }, identity: { kycRequired: false },
  payments: { pollMs: 100, reconGraceMs: 0, auditIntervalMs: 0, reconIntervalMs: 0, creditPollMs: 200,
    settings: { sandbox: { ach_settle_seconds: 2, payout_seconds: 1, block_seconds: 0 }, crypto: { confirmations: 3, address_cooling_hours: 24 } } },
});

before(async () => {
  PORT = await H.freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  srv = await start(opts(PORT));
  browser = await chromium.launch();
  admin = withStepUp(await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password), ADMIN.password);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

// The staff client confirms with its password when a sensitive admin action asks for step-up (the window is 60 s here).
function withStepUp(c, pw) {
  const call = c.call.bind(c);
  c.call = async (...a) => {
    let r = await call(...a);
    if (r.status === 403 && r.code === 'step_up_required') { await call('POST', '/v1/step_up', { password: pw }); r = await call(...a); }
    return r;
  };
  return c;
}
const K = () => ({ 'idempotency-key': `pay-${Math.random().toString(36).slice(2)}-${Date.now()}` });
const show = (r) => `${r.status} ${r.text ? r.text.slice(0, 300) : ''}`;
const dollars = (s) => Math.round(Number(s) * 100);
async function user(k, { page = false, viewport } = {}) {
  let p = null;
  if (page) {
    p = await H.newPage(browser, BASE, { viewport });
    p.apiBodies = [];
    // Every API body the browser sees, except the sandbox hint route, which by design lists the published test numbers.
    p.on('response', async (r) => { if (/\/v1\//.test(r.url()) && !/\/payments\/sandbox\/test_cards$/.test(r.url())) { try { p.apiBodies.push(await r.text()); } catch { /* body gone */ } } });
    await H.signUpUi(p, BASE, { name: `Pay ${k}`, email: email(k) }, PW);
    await p.waitForSelector('[data-testid=account-menu]');
  }
  const api = page ? await new Client(BASE, k).logIn(email(k), PW) : await new Client(BASE, k).signUp(email(k), PW, `Pay ${k}`);
  return { page: p, api, uid: api.uid, u: (x) => `/v1/users/${api.uid}${x}` };
}
async function waitTx(c, id, pred, ms = 15000) {
  return H.until(async () => {
    const [d, w] = await Promise.all([c.api.call('GET', c.u('/deposits')), c.api.call('GET', c.u('/withdrawals'))]);
    const t = [...d.body.deposits, ...w.body.withdrawals].find((x) => x.id === id);
    return t && pred(t) ? t : null;
  }, ms);
}
const meta = async (c) => (await c.api.call('GET', c.u('/payments/metadata'))).body;
async function tokenize(c, number) {
  const s = await c.api.call('POST', c.u('/debit/payment_session'), {});
  assert.equal(s.status, 201, show(s));
  return c.api.call('POST', '/v1/payments/tokenize/card', { session_id: s.body.session_id, number, exp_month: 12, exp_year: new Date().getUTCFullYear() + 2, cvc: '123' });
}
async function ledgerOk() {
  const r = await admin.call('GET', '/v1/admin/payments/ledger_audit');
  assert.equal(r.status, 200, show(r));
  assert.ok(r.body.live.ok, `ledger audit problems: ${JSON.stringify(r.body.live.problems.slice(0, 5))}`);
  return r.body.live;
}
const mine = (n) => admin.call('POST', '/v1/admin/payments/sandbox/crypto/mine', { blocks: n });
const activeMarket = () => D.q("SELECT m.ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status='active' AND m.mve_collection_ticker IS NULL AND e.series_ticker NOT LIKE 'PLXFLASH%' AND m.fractional_trading_enabled=1 ORDER BY m.rowid LIMIT 1")[0].ticker;
const usedTotp = new Map();
async function freshTotp(secret) {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    const step = Math.max((usedTotp.get(secret) ?? -Infinity) + 1, now);
    if (step <= now + 1) { usedTotp.set(secret, step); return totp(secret, step * 30000 + 15000); }
    await H.sleep(500);
  }
}

test('card deposits in the browser: approve (live balance, Transfers notification), decline, 3-D Secure-style challenge; insufficient funds, non-test numbers refused, card payout', async () => {
  const c = await user('card', { page: true });
  const { page } = c;
  await page.click('[data-testid=account-menu]');
  await page.click('[data-testid=menu-transfers]');
  await page.waitForSelector('[data-testid=funds][data-mode=overview] [data-testid=balances]');
  await page.click('[data-testid=go-deposit]');
  const cardDeposit = async (number, amount) => {
    await page.waitForSelector('[data-testid=funds][data-mode=deposit] [data-method=new-card]');
    await page.click('[data-method=new-card]');
    await page.fill('[data-testid=card-number]', number.replace(/(\d{4})(?=\d)/g, '$1 '));
    await page.fill('[data-testid=card-exp-month]', '12');
    await page.fill('[data-testid=card-exp-year]', String(new Date().getUTCFullYear() + 2));
    await page.fill('[data-testid=card-cvc]', '123');
    await page.click('[data-testid=card-submit]');
    await page.waitForSelector('[data-testid=fund-amount]');
    assert.equal(await page.inputValue('[data-testid=card-number]').catch(() => ''), '', 'the card number is not kept in the form');
    await page.fill('[data-testid=fund-amount]', String(amount * 100)); // naira (CLONE_SPEC.md §30)
    await page.click('[data-testid=fund-continue]');
    await page.waitForSelector('[data-testid=fund-review]');
    await page.click('[data-testid=fund-confirm]');
  };
  // Approve: processing → succeeded via the signed webhook; the header balance updates live over WS.
  await cardDeposit(CARDS.approve, 40);
  await page.waitForSelector('[data-testid=fund-status][data-status=succeeded]', { timeout: 15000 });
  await page.waitForSelector('[data-testid=header-balance]:has-text("₦4,000")');
  await H.until(() => D.q("SELECT 1 FROM notifications WHERE user_id=? AND type='transfer' AND title LIKE 'Deposit of ₦4,000 completed%'", c.uid)[0]);
  const card = D.q("SELECT * FROM payment_methods WHERE user_id=? AND type='card'", c.uid)[0];
  assert.equal(card.last4, '0002'); assert.equal(card.brand, 'visa'); assert.match(card.token, /^tok_/);
  // Decline: no money moves.
  await page.click('[data-testid=nav-deposit]');
  await cardDeposit(CARDS.decline, 25);
  await page.waitForSelector('[data-testid=fund-status][data-status=failed]', { timeout: 15000 });
  assert.match(await page.textContent('[data-testid=fund-status-text]'), /declined/i);
  // Challenge: requires_action → the sandbox issuer's Approve → succeeded.
  await page.click('[data-testid=nav-deposit]');
  await cardDeposit(CARDS.challenge, 10);
  await page.waitForSelector('[data-testid=fund-status][data-status=requires_action] [data-testid=challenge-approve]', { timeout: 15000 });
  await page.click('[data-testid=challenge-approve]');
  await page.waitForSelector('[data-testid=fund-status][data-status=succeeded]', { timeout: 15000 });
  await page.waitForSelector('[data-testid=header-balance]:has-text("₦5,000")');
  // The Transfers list and Your activity show the deposits.
  await page.click('[data-testid=fund-done]');
  await page.waitForSelector('[data-testid=transfers] [data-status=failed]');
  assert.equal(await page.locator('[data-testid=transfers] [data-direction=deposit][data-status=succeeded]').count(), 2);
  const act = await c.api.call('GET', c.u('/activity?type=deposit'));
  assert.equal(act.body.activity.filter((a) => a.type === 'deposit').length, 2, show(act));
  // API: insufficient funds; a failed challenge; a non-test (possibly real) number refused and not kept; no session.
  let t = await tokenize(c, CARDS.insufficient);
  let r = await c.api.call('POST', c.u('/debit/payment'), { token: t.body.token, amount_dollars: 15 }, K());
  assert.equal(r.status, 201, show(r));
  const failed = await waitTx(c, r.body.payment_id, (x) => x.final);
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure_code, 'insufficient_funds');
  t = await tokenize(c, CARDS.challenge);
  r = await c.api.call('POST', c.u('/debit/payment'), { token: t.body.token, amount_dollars: 5 }, K());
  await waitTx(c, r.body.payment_id, (x) => x.status === 'requires_action');
  assert.equal((await c.api.call('POST', c.u(`/debit/payment/${r.body.payment_id}/challenge`), { result: 'fail' })).status, 200);
  assert.equal((await waitTx(c, r.body.payment_id, (x) => x.final)).failure_code, 'authentication_failed');
  t = await tokenize(c, CARDS.other);
  assert.equal(t.status, 400); assert.equal(t.body.error.code, 'card_not_sandbox');
  t = await c.api.call('POST', '/v1/payments/tokenize/card', { session_id: 'cps_nope', number: CARDS.approve, exp_month: 12, exp_year: 2031, cvc: '123' });
  assert.equal(t.body.error.code, 'payment_session_invalid');
  assert.equal(D.q('SELECT COUNT(*) n FROM sbx_card_vault WHERE user_id=?', c.uid)[0].n, 5, 'only test cards were tokenized');
  // Card payout to the card that paid in (closed loop), and not to a card that never did.
  const declined = D.q("SELECT id FROM payment_methods WHERE user_id=? AND type='card' AND last4='0000'", c.uid)[0].id;
  assert.equal((await c.api.call('POST', '/v1/step_up', { password: PW })).status, 200); // withdrawals need a recent check
  r = await c.api.call('POST', c.u('/debit/withdrawal'), { card_id: declined, amount_dollars: 5 }, K());
  assert.equal(r.body.error.code, 'card_payout_not_eligible');
  r = await c.api.call('POST', c.u('/debit/withdrawal'), { card_id: card.id, amount_dollars: 12 }, K());
  assert.equal(r.status, 201, show(r));
  assert.equal((await waitTx(c, r.body.payment_id, (x) => x.final)).status, 'paid');
  assert.equal(Number((await meta(c)).balances.balance_dollars), 38);
  await ledgerOk();
  // 390 px: the transfer pages and Payment methods without horizontal scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ['/funds', '/funds/deposit', '/funds/withdraw', '/account/payments']) {
    await page.goto(BASE + p);
    await page.waitForSelector('[data-testid=funds] [data-body] > *, [data-testid=payment-methods]');
    await page.waitForLoadState('networkidle');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${p}: no horizontal scroll at 390 px`);
  }
  for (const b of page.apiBodies) for (const n of Object.values(CARDS)) assert.ok(!b.includes(n), 'a card number appeared in an API response');
  await H.assertClean(assert, page);
  await page.context().close();
});

test('bank: link in the browser, ACH deposit pending → settled (tradable, not withdrawable until settled), payout; a return reverses the credit and leaves a debt', async () => {
  const c = await user('bank', { page: true });
  const { page } = c;
  await page.goto(BASE + '/funds/deposit');
  await page.click('[data-method=new-bank]');
  await page.selectOption('[data-testid=bank-institution]', 'ins_harbor');
  await page.fill('[data-testid=bank-username]', 'sandbox');
  await page.fill('[data-testid=bank-password]', 'wrong-pass');
  await page.click('[data-testid=bank-login]');
  await page.waitForSelector('[data-testid=bank-error]:has-text("did not accept")');
  await page.fill('[data-testid=bank-password]', 'sandbox-pass');
  await page.click('[data-testid=bank-login]');
  await page.click('[data-testid=bank-account][data-mask="0001"]');
  await page.click('[data-testid=bank-link]');
  await page.waitForSelector('[data-testid=fund-amount]');
  await page.fill('[data-testid=fund-amount]', '10000');
  await page.click('[data-testid=fund-continue]');
  await page.click('[data-testid=fund-confirm]');
  await page.waitForSelector('[data-testid=fund-status][data-status=pending]', { timeout: 15000 });
  await page.waitForSelector('[data-testid=header-balance]:has-text("₦10,000")');
  const bank = D.q("SELECT * FROM payment_methods WHERE user_id=? AND type='bank'", c.uid)[0];
  assert.equal(bank.mask, '0001'); assert.match(bank.token, /^bacct_/);
  const dep = D.q("SELECT * FROM payment_transactions WHERE user_id=? AND rail='bank'", c.uid)[0];
  // Unsettled: tradable at once, not withdrawable.
  let m = await meta(c);
  assert.equal(Number(m.balances.unsettled_dollars), 100); assert.equal(Number(m.balances.withdrawable_dollars), 0);
  let r = await c.api.call('POST', c.u('/bank_link/withdrawal'), { bank_id: bank.id, amount_dollars: 20 }, K());
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'funds_unsettled', show(r));
  r = await c.api.call('POST', c.u('/orders'), { ticker: activeMarket(), side: 'yes', type: 'market', count: 2 });
  assert.equal(r.status, 201, show(r));
  // Settles after the sandbox delay (signed webhook), then it can be withdrawn.
  await page.waitForSelector('[data-testid=fund-status][data-status=settled]', { timeout: 15000 });
  m = await meta(c);
  assert.equal(Number(m.balances.unsettled_dollars), 0); assert.ok(Number(m.balances.withdrawable_dollars) > 90);
  r = await c.api.call('POST', c.u('/bank_link/withdrawal'), { bank_id: bank.id, amount_dollars: 20 }, K());
  assert.equal(r.status, 201, show(r));
  assert.equal((await waitTx(c, r.body.payment_id, (x) => x.final)).status, 'paid');
  assert.ok(D.q("SELECT 1 FROM notifications WHERE user_id=? AND type='transfer' AND title LIKE 'Deposit of ₦10,000 settled%'", c.uid)[0]);
  // withdrawal_times mirrors the observed endpoint.
  const wt = await c.api.call('GET', c.u('/withdrawal_times'));
  assert.ok(wt.body.withdrawal_times.some((x) => x.method === 'bank' && /business days/.test(x.estimate)));
  // Return: the "Returns Checking" account; the money is spent first, so the reversal leaves a debt.
  const link = await c.api.call('POST', c.u('/bank_link/accounts'), { institution_id: 'ins_maple', username: 'sandbox', password: 'sandbox-pass' });
  const ret = await c.api.call('POST', c.u('/banks/linked_accounts'), { link_id: link.body.link_id, account_id: link.body.accounts.find((a) => a.mask === '0002').account_id });
  assert.equal(ret.status, 201, show(ret));
  await admin.call('PUT', '/v1/admin/payments/settings', { settings: { sandbox: { ach_settle_seconds: 4 } }, reason: 'slower ACH for the return test' });
  r = await c.api.call('POST', c.u('/bank_link/deposit'), { bank_id: ret.body.account.id, amount_dollars: 500 }, K());
  const retId = r.body.payment_id;
  await waitTx(c, retId, (x) => x.status === 'pending');
  const bal = dollars((await meta(c)).balances.balance_dollars);
  r = await c.api.call('POST', c.u('/orders'), { ticker: activeMarket(), side: 'yes', type: 'limit', price: 1, count: Math.floor((bal - 100) / 2) });
  assert.equal(r.status, 201, show(r)); // most of the cash now sits in a resting order
  const t = await waitTx(c, retId, (x) => x.final);
  assert.equal(t.status, 'returned'); assert.equal(t.failure_code, 'R01_insufficient_funds');
  m = await meta(c);
  assert.ok(Number(m.balances.owed_dollars) > 0, `owed: ${JSON.stringify(m.balances)}`);
  assert.ok(D.q("SELECT 1 FROM ledger WHERE user_id=? AND kind='deposit_return' AND amount_cents=-50000", c.uid)[0]);
  r = await c.api.call('POST', c.u('/bank_link/withdrawal'), { bank_id: bank.id, amount_dollars: 5 }, K());
  assert.equal(r.body.error.code, 'negative_balance');
  await page.goto(BASE + '/funds');
  await page.waitForSelector('[data-testid=bal-owed]');
  await admin.call('PUT', '/v1/admin/payments/settings', { settings: { sandbox: { ach_settle_seconds: 2 } }, reason: 'restore' });
  // A demo deposit repays the debt first.
  assert.equal((await c.api.call('POST', c.u('/deposits'), { amount_dollars: 1000 })).status, 201);
  assert.equal(Number((await meta(c)).balances.owed_dollars), 0);
  assert.equal(D.q('SELECT status FROM payment_transactions WHERE id=?', dep.id)[0].status, 'settled');
  await ledgerOk();
  await H.assertClean(assert, page);
  await page.context().close();
});

test('crypto: deposit address, N confirmations, new address with step-up and cooling, AML hold on the first withdrawal released in Admin, network fee; withdrawal two-factor', async () => {
  const c = await user('crypto', { page: true });
  const { page } = c;
  await page.goto(BASE + '/funds/deposit');
  await page.click('[data-method=crypto]');
  await page.click('[data-testid=crypto-open]');
  await page.waitForSelector('[data-testid=crypto-deposit] .form-error:has-text("Accept")');
  await page.check('[data-testid=crypto-terms]');
  await page.click('[data-testid=crypto-open]');
  const address = (await page.textContent('[data-testid=crypto-address]')).trim();
  assert.match(address, /^tpx1[a-z2-7]{34}$/);
  await page.fill('[data-testid=crypto-sim-amount]', '8000');
  await page.click('[data-testid=crypto-sim]');
  await page.waitForSelector('[data-testid=crypto-deposit] [data-testid=transfer-row][data-status=confirming]');
  assert.equal(Number((await meta(c)).balances.balance_dollars), 0);
  await mine(1);
  await page.waitForSelector('[data-testid=confirmations]:has-text("1 of 3")');
  assert.equal(Number((await meta(c)).balances.balance_dollars), 0, 'not credited before 3 confirmations');
  await mine(2);
  await page.waitForSelector('[data-testid=crypto-deposit] [data-testid=transfer-row][data-status=succeeded]');
  await page.waitForSelector('[data-testid=header-balance]:has-text("₦8,000")');
  // A new withdrawal address is a payout destination: step-up (session older than the window), then a cooling period.
  const nets = (await c.api.call('GET', '/v1/payments/supported_networks')).body.networks;
  await page.goto(BASE + '/account/payments');
  await page.click('[data-testid=add-wallet]');
  await page.fill('[data-testid=wallet-address]', 'tpx1notavalidaddress');
  await page.click('[data-testid=wallet-add]');
  await page.waitForSelector('[data-testid=wallet-error]:has-text("not a valid")');
  D.run('UPDATE sessions SET auth_at=0 WHERE user_id=?', c.uid);
  await page.fill('[data-testid=wallet-address]', nets[0].example);
  await page.click('[data-testid=wallet-add]');
  await page.waitForSelector('[data-testid=step-up-dialog]');
  await page.fill('[data-testid=step-up-password]', PW);
  await page.click('[data-testid=step-up-submit]');
  await page.waitForSelector('[data-testid=saved-method][data-type=crypto_address] [data-testid=cooling]');
  assert.equal((await c.api.call('POST', '/v1/step_up', { password: PW })).status, 200); // the API session aged too
  const w = D.q("SELECT * FROM payment_methods WHERE user_id=? AND type='crypto_address'", c.uid)[0];
  assert.ok(w.cooling_until > Date.now() + 23 * 3600000);
  let r = await c.api.call('POST', c.u('/crypto/withdrawal'), { wallet_id: w.id, amount_dollars: 30 }, K());
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'destination_cooling');
  D.run('UPDATE payment_methods SET cooling_until=? WHERE id=?', Date.now() - 1000, w.id);
  // First withdrawal to the new address: held (AML rule), an AML case opens, and an admin releases it in the UI.
  r = await c.api.call('POST', c.u('/crypto/withdrawal'), { wallet_id: w.id, amount_dollars: 30 }, K());
  assert.equal(r.status, 202, show(r)); assert.equal(r.body.transaction.status, 'held');
  const held = r.body.transaction;
  assert.equal(Number((await meta(c)).balances.held_dollars), 30);
  const ap = await H.newPage(browser, BASE);
  await H.logInUi(ap, BASE, ADMIN.email, ADMIN.password);
  await ap.waitForSelector('[data-testid=account-menu]');
  await ap.goto(BASE + '/admin/payments/aml');
  const row = ap.locator(`[data-testid=aml-cases] tr[data-rule=new_crypto_address]:has-text("${email('crypto')}")`);
  await row.waitFor();
  await row.locator('[data-testid=aml-release]').click();
  await ap.fill('[data-testid=confirm-reason]', 'verified the destination with the customer');
  await ap.click('[data-testid=confirm-ok]');
  await H.until(() => D.q('SELECT status FROM withdrawal_holds WHERE id=?', held.hold_id)[0].status === 'released');
  await waitTx(c, held.id, (x) => x.status === 'processing');
  await mine(1);
  const paid = await waitTx(c, held.id, (x) => x.final);
  assert.equal(paid.status, 'paid'); assert.equal(Number(paid.fee_dollars), 1); assert.equal(Number(paid.net_dollars), 29);
  assert.equal(D.q("SELECT amount_cents FROM sbx_provider_records WHERE merchant_ref=? AND kind='crypto_out'", held.id)[0].amount_cents, 2900);
  // Close the case with a reason (audit-chained).
  await ap.reload();
  await row.waitFor();
  await row.locator('[data-testid=aml-close]').click();
  await ap.fill('[data-testid=confirm-reason]', 'destination verified; first withdrawal released');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector(`[data-testid=aml-cases] tr[data-rule=new_crypto_address][data-status=closed]:has-text("${email('crypto')}")`);
  assert.ok(D.q("SELECT 1 FROM admin_audit WHERE action='aml.case_close'")[0]);
  // A second withdrawal to the now-used address is not held.
  r = await c.api.call('POST', c.u('/crypto/withdrawal'), { wallet_id: w.id, amount_dollars: 10 }, K());
  assert.equal(r.status, 201, show(r));
  // Withdrawal two-factor: with it on, every withdrawal needs a fresh authenticator code.
  const setup = await c.api.call('POST', c.u('/mfa/setup'), {});
  assert.equal((await c.api.call('POST', c.u('/mfa/enable'), { code: await freshTotp(setup.body.secret) })).status, 200);
  assert.equal((await c.api.call('PUT', c.u('/withdrawal_mfa'), { enabled: true })).status, 200);
  // The code entered to turn two-factor on counts for one withdrawal; after that each needs its own code.
  r = await c.api.call('POST', c.u('/crypto/withdrawal'), { wallet_id: w.id, amount_dollars: 5 }, K());
  if (r.status === 201) r = await c.api.call('POST', c.u('/crypto/withdrawal'), { wallet_id: w.id, amount_dollars: 5 }, K());
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'step_up_required'); assert.deepEqual(r.body.error.methods, ['totp']);
  assert.equal((await c.api.call('POST', '/v1/step_up', { code: await freshTotp(setup.body.secret) })).status, 200);
  r = await c.api.call('POST', c.u('/crypto/withdrawal'), { wallet_id: w.id, amount_dollars: 5 }, K());
  assert.equal(r.status, 201, show(r));
  r = await c.api.call('POST', c.u('/crypto/withdrawal'), { wallet_id: w.id, amount_dollars: 5 }, K());
  assert.equal(r.body.error.code, 'step_up_required', 'the code covers one withdrawal');
  await ledgerOk();
  await H.assertClean(assert, page);
  await page.context().close(); await ap.context().close();
});

test('webhooks: unsigned, bad signature, stale and replayed events are refused and logged; a signed new event is applied once', async () => {
  const key = kc.deriveKey('payments-webhook:sandbox_card:v1', { dir: TMP });
  const post = (body, header) => fetch(`${BASE}/v1/payments/webhooks/sandbox_card`, { method: 'POST', headers: { 'content-type': 'application/json', ...(header ? { 'parlance-signature': header } : {}) }, body });
  const sign = (body, ts = Math.floor(Date.now() / 1000)) => `t=${ts},v1=${kc.hmacHex(key, `${ts}.${body}`)}`;
  const c = await user('hook');
  const t = await tokenize(c, CARDS.challenge);
  const p = await c.api.call('POST', c.u('/debit/payment'), { token: t.body.token, amount_dollars: 20 }, K());
  await waitTx(c, p.body.payment_id, (x) => x.status === 'requires_action');
  const rec = D.q('SELECT * FROM sbx_provider_records WHERE merchant_ref=?', p.body.payment_id)[0];
  const forged = JSON.stringify({ id: `evt_forged_${stamp}`, type: 'charge.succeeded', created: Math.floor(Date.now() / 1000), data: { object: { id: rec.id, merchant_ref: p.body.payment_id, amount_cents: 2000, status: 'succeeded' } } });
  let r = await post(forged);
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'webhook_signature_missing');
  r = await post(forged, `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`);
  assert.equal((await r.json()).error.code, 'webhook_signature_invalid');
  r = await post(forged, sign(forged.replace('2000', '200000'))); // signature over other bytes
  assert.equal((await r.json()).error.code, 'webhook_signature_invalid');
  r = await post(forged, sign(forged, Math.floor(Date.now() / 1000) - 600));
  assert.equal((await r.json()).error.code, 'webhook_timestamp_stale');
  assert.equal((await waitTx(c, p.body.payment_id, () => true)).status, 'requires_action', 'nothing was applied');
  // A delivered event replayed with a fresh, valid signature: refused as a replay; nothing changes.
  const delivered = D.q("SELECT payload FROM sbx_webhook_outbox WHERE provider='sandbox_card' AND status='delivered' AND type='charge.requires_action' AND payload LIKE ?", `%${p.body.payment_id}%`)[0].payload;
  r = await post(delivered, sign(delivered));
  assert.equal(r.status, 409); assert.equal((await r.json()).error.code, 'webhook_replayed');
  // The genuine provider path: the challenge completes, the event is applied once, the replay of that one is refused too.
  await c.api.call('POST', c.u(`/debit/payment/${p.body.payment_id}/challenge`), { result: 'approve' });
  await waitTx(c, p.body.payment_id, (x) => x.status === 'succeeded');
  const ok = await H.until(() => D.q("SELECT payload FROM sbx_webhook_outbox WHERE status='delivered' AND type='charge.succeeded' AND payload LIKE ?", `%${p.body.payment_id}%`)[0]);
  r = await post(ok.payload, sign(ok.payload));
  assert.equal(r.status, 409);
  assert.equal(D.q("SELECT COUNT(*) n FROM ledger WHERE ref=? AND kind='deposit'", p.body.payment_id)[0].n, 1, 'credited exactly once');
  // Logged: security log and the webhook log (Admin › Payments › Webhook log); deliveries came over loopback HTTP.
  const sec = D.q("SELECT detail FROM security_events WHERE kind='webhook_rejected'").map((x) => JSON.parse(x.detail).code);
  for (const code of ['webhook_signature_missing', 'webhook_signature_invalid', 'webhook_timestamp_stale', 'webhook_replayed']) assert.ok(sec.includes(code), `security log has ${code}`);
  const wl = await admin.call('GET', '/v1/admin/payments/webhooks');
  assert.ok(wl.body.log.filter((x) => x.outcome === 'rejected').length >= 5);
  assert.ok(wl.body.log.some((x) => x.outcome === 'accepted' && x.ip === '127.0.0.1'));
  assert.equal((await post(forged, sign(forged)).then((x) => x.status)), 200, 'a correctly signed new event is accepted (it is a no-op: already succeeded)');
  await ledgerOk();
});

test('Idempotency-Key: required on rail deposits and withdrawals; a retry executes once; a different body with the same key conflicts', async () => {
  const c = await user('idem');
  const link = await c.api.call('POST', c.u('/bank_link/accounts'), { institution_id: 'ins_cedar', username: 'sandbox', password: 'sandbox-pass' });
  const bank = (await c.api.call('POST', c.u('/banks/linked_accounts'), { link_id: link.body.link_id, account_id: link.body.accounts[0].account_id })).body.account;
  let r = await c.api.call('POST', c.u('/bank_link/deposit'), { bank_id: bank.id, amount_dollars: 60 });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'idempotency_key_required');
  r = await c.api.call('POST', c.u('/deposits'), { method_id: bank.id, amount_dollars: 60 });
  assert.equal(r.body.error.code, 'idempotency_key_required', 'the generic route with a method_id too');
  const k = K();
  const a = await c.api.call('POST', c.u('/bank_link/deposit'), { bank_id: bank.id, amount_dollars: 60 }, k);
  const b = await c.api.call('POST', c.u('/bank_link/deposit'), { bank_id: bank.id, amount_dollars: 60 }, k);
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  assert.equal(a.body.payment_id, b.body.payment_id);
  assert.equal(D.q("SELECT COUNT(*) n FROM payment_transactions WHERE user_id=? AND rail='bank'", c.uid)[0].n, 1);
  r = await c.api.call('POST', c.u('/bank_link/deposit'), { bank_id: bank.id, amount_dollars: 61 }, k);
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'idempotency_key_conflict');
  r = await c.api.call('POST', c.u('/bank_link/withdrawal'), { bank_id: bank.id, amount_dollars: 1 });
  assert.equal(r.body.error.code, 'idempotency_key_required');
  // The demo-funds method keeps working without a key (existing clients).
  assert.equal((await c.api.call('POST', c.u('/deposits'), { amount_dollars: 5 })).status, 201);
});

test('limits and AML: daily withdrawal limit, structuring and rapid deposit-then-withdraw cases with audit; non-withdrawable credits', async () => {
  const set = (s, reason) => admin.call('PUT', '/v1/admin/payments/settings', { settings: s, reason });
  let r = await set({ limits: { withdrawal_day_cents: 5000 }, aml: { structuring: { threshold_cents: 100000, count: 3 } } }, 'tighter limits for the test');
  assert.equal(r.status, 200, show(r));
  r = await set({ limits: { withdrawal_day_cents: -1 } }, 'bad value');
  assert.equal(r.status, 400); assert.ok(r.body.error.fields['limits.withdrawal_day_cents']);
  const c = await user('aml');
  for (let i = 0; i < 3; i++) assert.equal((await c.api.call('POST', c.u('/deposits'), { amount_dollars: 950 })).status, 201);
  const cases = await admin.call('GET', '/v1/admin/payments/aml_cases?status=all');
  const st = cases.body.cases.find((x) => x.user_id === c.uid && x.rule === 'structuring');
  assert.ok(st, 'structuring case opened'); assert.equal(st.status, 'open');
  assert.ok(D.q("SELECT 1 FROM admin_audit WHERE action='aml.case_opened' AND target_id=?", c.uid)[0], 'case opening is audit-chained');
  // Withdrawal limit per day ($50): $40 passes, the next $20 does not.
  assert.equal((await c.api.call('POST', c.u('/withdrawals'), { amount_dollars: 40 })).status, 201);
  r = await c.api.call('POST', c.u('/withdrawals'), { amount_dollars: 20 });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'withdrawal_limit_exceeded'); assert.match(r.body.error.details, /₦1,000 left today/);
  // Rapid deposit-then-withdraw without trading opens a case.
  const d = await user('rapid');
  await d.api.call('POST', d.u('/deposits'), { amount_dollars: 45 });
  assert.equal((await d.api.call('POST', d.u('/withdrawals'), { amount_dollars: 40 })).status, 201);
  assert.ok((await admin.call('GET', '/v1/admin/payments/aml_cases')).body.cases.some((x) => x.user_id === d.uid && x.rule === 'rapid_in_out'));
  r = await admin.call('POST', `/v1/admin/payments/aml_cases/${st.id}/close`, { reason: 'x' });
  assert.equal(r.status, 400);
  r = await admin.call('POST', `/v1/admin/payments/aml_cases/${st.id}/close`, { reason: 'reviewed: payroll deposits', outcome: 'no_issue' });
  assert.equal(r.status, 200, show(r)); assert.equal(r.body.case.status, 'closed');
  await set({ limits: { withdrawal_day_cents: 2500000 }, aml: { structuring: { threshold_cents: 1000000 } } }, 'restore');
  // Credits (observed nonwithdrawable_credits): a promo credit is tradable, not withdrawable, and expires.
  assert.equal((await admin.call('POST', '/v1/admin/promo_codes', { code: `PAY-${String(stamp).slice(-6)}`, amount_dollars: 25, reason: 'payments test' })).status, 201);
  const e = await user('credit');
  assert.equal((await e.api.call('POST', e.u('/promo_codes'), { code: `PAY-${String(stamp).slice(-6)}` })).status, 201);
  await e.api.call('POST', e.u('/deposits'), { amount_dollars: 10 });
  let m = await meta(e);
  assert.equal(Number(m.balances.balance_dollars), 35); assert.equal(Number(m.balances.withdrawable_dollars), 10); assert.equal(Number(m.balances.nonwithdrawable_credits_dollars), 25);
  assert.equal(m.nonwithdrawable_credits.predictions.amount_cents, 2500); assert.equal(m.nonwithdrawable_credits.predictions.credits.length, 1);
  r = await e.api.call('POST', e.u('/withdrawals'), { amount_dollars: 20 });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'credits_not_withdrawable', show(r));
  r = await e.api.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 20 });
  assert.equal(r.body.error.code, 'credits_not_transferable');
  // Orders spend credits first; a canceled order gives the credit back.
  r = await e.api.call('POST', e.u('/orders'), { ticker: activeMarket(), side: 'yes', type: 'limit', price: 1, count: 500 }); // reserves $10 (1¢ + 1¢ fee cap each)
  assert.equal(r.status, 201, show(r));
  m = await meta(e);
  assert.equal(Number(m.balances.nonwithdrawable_credits_dollars), 15); assert.equal(Number(m.balances.withdrawable_dollars), 10);
  await e.api.call('DELETE', e.u(`/orders/${r.body.order.order_id}`));
  assert.equal(Number((await meta(e)).balances.nonwithdrawable_credits_dollars), 25);
  // Expiry: what is left is removed by the job.
  D.run('UPDATE credit_grants SET expires_ts=? WHERE user_id=?', Date.now() - 1000, e.uid);
  await H.until(async () => Number((await meta(e)).balances.nonwithdrawable_credits_dollars) === 0, 10000);
  assert.equal(Number((await meta(e)).balances.balance_dollars), 10);
  const ch = await e.api.call('GET', e.u('/credit_history'));
  assert.equal(ch.body.credits[0].status, 'expired'); assert.equal(Number(ch.body.credits[0].expired_dollars), 25);
  await ledgerOk();
});

test('reconciliation: a provider/ledger amount mismatch is queued, resolved in Admin with a reason and step-up, audit-chained; the ledger audit balances and catches tampering', async () => {
  const c = await user('recon');
  const t = await tokenize(c, CARDS.approve);
  const p = await c.api.call('POST', c.u('/debit/payment'), { token: t.body.token, amount_dollars: 70 }, K());
  await waitTx(c, p.body.payment_id, (x) => x.status === 'succeeded');
  let r = await admin.call('POST', '/v1/admin/payments/reconciliation/run', {});
  assert.equal(r.status, 200);
  const before = (await admin.call('GET', '/v1/admin/payments/reconciliation')).body.items.filter((x) => x.txn_id === p.body.payment_id);
  assert.deepEqual(before, [], 'provider and ledger agree');
  // The provider's record says $75.00: an amount mismatch.
  D.run('UPDATE sbx_provider_records SET amount_cents=7500 WHERE merchant_ref=?', p.body.payment_id);
  const ap = await H.newPage(browser, BASE);
  await H.logInUi(ap, BASE, ADMIN.email, ADMIN.password);
  await ap.waitForSelector('[data-testid=account-menu]');
  await ap.goto(BASE + '/admin/payments/reconciliation');
  await ap.click('[data-testid=recon-run]');
  const row = ap.locator(`[data-testid=recon-items] tr[data-kind=amount_mismatch][data-status=open]:has-text("${email('recon')}")`);
  await row.waitFor();
  await row.locator('[data-testid=recon-resolve]').click();
  await ap.selectOption('[data-testid=recon-resolution]', 'adjust_user');
  await ap.fill('[data-testid=confirm-reason]', 'provider settlement report confirms $75.00');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector(`[data-testid=recon-items] tr[data-kind=amount_mismatch][data-status=resolved]:has-text("${email('recon')}")`);
  assert.equal(Number((await meta(c)).balances.balance_dollars), 75);
  const au = D.q("SELECT * FROM admin_audit WHERE action='payments.recon_adjust_user' ORDER BY ts DESC LIMIT 1")[0];
  assert.ok(au); assert.match(au.reason, /settlement report/); assert.ok(au.hash);
  const v = await admin.call('GET', '/v1/admin/audit/verify');
  assert.equal(v.body.ok, true, JSON.stringify(v.body));
  r = await admin.call('POST', '/v1/admin/payments/reconciliation/run', {});
  assert.equal((await admin.call('GET', '/v1/admin/payments/reconciliation')).body.items.filter((x) => x.txn_id === p.body.payment_id && x.status === 'open').length, 0, 'resolved: not raised again');
  // A missing-at-provider record (deleted provider row) is raised too; acknowledging needs a reason.
  D.run("DELETE FROM sbx_provider_records WHERE merchant_ref=? AND kind='charge'", p.body.payment_id);
  await admin.call('POST', '/v1/admin/payments/reconciliation/run', {});
  const miss = (await admin.call('GET', '/v1/admin/payments/reconciliation')).body.items.find((x) => x.txn_id === p.body.payment_id && x.kind === 'missing_at_provider');
  assert.ok(miss);
  assert.equal((await admin.call('POST', `/v1/admin/payments/reconciliation/${miss.id}/resolve`, { resolution: 'acknowledge', reason: '' })).status, 400);
  assert.equal((await admin.call('POST', `/v1/admin/payments/reconciliation/${miss.id}/resolve`, { resolution: 'acknowledge', reason: 'provider confirmed a reporting gap' })).status, 200);
  // Ledger audit: balanced in the admin UI; a direct balance edit is caught, then undone.
  await ap.goto(BASE + '/admin/payments/ledger');
  await ap.waitForSelector('[data-testid=audit-result][data-ok="1"]');
  await ap.click('[data-testid=audit-run]');
  await H.until(() => D.q('SELECT COUNT(*) n FROM ledger_audits WHERE ok=1')[0].n >= 1);
  D.run('UPDATE users SET balance_cents=balance_cents+1 WHERE id=?', c.uid);
  const bad = (await admin.call('GET', '/v1/admin/payments/ledger_audit')).body.live;
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((x) => x.check === 'user_balance' && x.account === `user:${c.uid}:cash`));
  D.run('UPDATE users SET balance_cents=balance_cents-1 WHERE id=?', c.uid);
  const live = await ledgerOk();
  assert.ok(live.entries > 20, `journal entries: ${live.entries}`);
  await H.assertClean(assert, ap);
  await ap.context().close();
});

test('persistence: a pending ACH settlement and a pending payout resume after a restart; state survives', async () => {
  const c = await user('restart');
  await admin.call('PUT', '/v1/admin/payments/settings', { settings: { sandbox: { ach_settle_seconds: 6, payout_seconds: 6 } }, reason: 'restart test' });
  const link = await c.api.call('POST', c.u('/bank_link/accounts'), { institution_id: 'ins_maple', username: 'sandbox', password: 'sandbox-pass' });
  const bank = (await c.api.call('POST', c.u('/banks/linked_accounts'), { link_id: link.body.link_id, account_id: link.body.accounts[0].account_id })).body.account;
  await c.api.call('POST', c.u('/deposits'), { amount_dollars: 50 });
  const dep = await c.api.call('POST', c.u('/bank_link/deposit'), { bank_id: bank.id, amount_dollars: 120 }, K());
  await waitTx(c, dep.body.payment_id, (x) => x.status === 'pending');
  const wd = await c.api.call('POST', c.u('/bank_link/withdrawal'), { bank_id: bank.id, amount_dollars: 30 }, K());
  assert.equal(wd.status, 201, show(wd));
  await srv.close();
  assert.equal(D.q("SELECT COUNT(*) n FROM sbx_provider_jobs WHERE status='queued'")[0].n, 2, 'jobs persisted while the server is down');
  PORT = await H.freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  srv = await start(opts(PORT));
  admin = withStepUp(await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password), ADMIN.password);
  const c2 = { ...c, api: await new Client(BASE, 'restart').logIn(email('restart'), PW) };
  assert.equal((await waitTx(c2, dep.body.payment_id, (x) => x.final, 20000)).status, 'settled');
  assert.equal((await waitTx(c2, wd.body.payment_id, (x) => x.final, 20000)).status, 'paid');
  const m = await meta(c2);
  assert.equal(Number(m.balances.balance_dollars), 140); assert.equal(Number(m.balances.withdrawable_dollars), 140);
  assert.equal((await c2.api.call('GET', c2.u('/banks/all_accounts'))).body.accounts.length, 1);
  await admin.call('PUT', '/v1/admin/payments/settings', { settings: { sandbox: { ach_settle_seconds: 2, payout_seconds: 1 } }, reason: 'restore' });
  await ledgerOk();
});

test('sandbox test-card hints come from the server (signed in, sandbox only); no card-shaped number ships in public assets', async () => {
  // Browser: the card form fills its hint list from the API.
  const c = await user('hints', { page: true });
  await c.page.goto(BASE + '/funds/deposit');
  await c.page.waitForSelector('[data-testid=funds][data-mode=deposit] [data-method=new-card]');
  await c.page.click('[data-method=new-card]');
  await c.page.waitForSelector('[data-testid=test-card-hints]:not([hidden]) li', { state: 'attached' }); // inside a collapsed <details>
  const hints = await c.page.locator('[data-testid=test-card-hints] li').allTextContents();
  assert.ok(hints.some((h) => h.includes('4000 9910 0000 0002') && /approves/.test(h)), JSON.stringify(hints));
  assert.equal(await c.page.getAttribute('[data-testid=card-number]', 'placeholder'), '0000 0000 0000 0000');
  assert.deepEqual(c.page.errors || [], []);
  await c.page.context().close();
  // Anonymous callers (and crawlers) never get the list.
  const anon = await fetch(`${BASE}/v1/users/${c.uid}/payments/sandbox/test_cards`);
  assert.ok([401, 403].includes(anon.status), `anonymous status ${anon.status}`);
  // Static scan: no Luhn-valid card-shaped number in anything served to browsers (source and built bundle).
  const luhn = (d) => { let s = 0; for (let i = 0; i < d.length; i++) { let x = Number(d[d.length - 1 - i]); if (i % 2) { x *= 2; if (x > 9) x -= 9; } s += x; } return s % 10 === 0; };
  const roots = [path.join(__dirname, '..', 'public'), path.join(__dirname, '..', 'dist')].filter((r) => fs.existsSync(r));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const hits = [];
  for (const f of roots.flatMap(walk).filter((x) => /\.(js|mjs|html|css|json|webmanifest|txt)$/.test(x))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?<![\d.])(?:\d[ -]?){12,18}\d(?![\d.])/g)) {
      const d = m[0].replace(/\D/g, '');
      if (d.length >= 13 && d.length <= 19 && /^[2-6]/.test(d) && !/^(\d)\1+$/.test(d) && luhn(d)) hits.push(`${path.relative(path.join(__dirname, '..'), f)}: ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], 'card-shaped numbers in public assets');
});

test('PCI scope: no card number in the database file, the WAL, the server logs or any API response', async () => {
  await srv.close();
  srv = null;
  const files = fs.readdirSync(TMP).filter((f) => f.startsWith('payments.db')).map((f) => path.join(TMP, f));
  assert.ok(files.length >= 1);
  const bytes = Buffer.concat(files.map((f) => fs.readFileSync(f)));
  for (const n of Object.values(CARDS)) {
    for (const form of [n, n.replace(/(\d{4})(?=\d)/g, '$1 ')]) {
      assert.equal(bytes.indexOf(Buffer.from(form, 'latin1')), -1, `card number found in ${files.map((f) => path.basename(f)).join(', ')}`);
      assert.equal(bytes.indexOf(Buffer.from(form, 'utf16le')), -1);
      assert.ok(!LOGS.some((l) => l.includes(form)), 'card number in the server logs');
      assert.ok(!RESPONSES.some((x) => x.includes(form)), 'card number in an API response');
    }
  }
  assert.ok(RESPONSES.length > 100, 'responses were captured');
  // Only token, brand, last 4 and expiry are stored for a card.
  assert.deepEqual(Object.keys(D.q('SELECT * FROM sbx_card_vault LIMIT 1')[0]).sort(), ['behavior', 'brand', 'created_ts', 'exp_month', 'exp_year', 'last4', 'token', 'user_id']);
  srv = await start(opts(PORT)); // for the after() hook
});
