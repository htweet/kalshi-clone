'use strict';
// Identity onboarding E2E (PLAN P3.1, P3.1a, P3.2, P3.5; CLONE_SPEC §13.14 observed flow, §25): the full-screen flow
// phone code → legal name → birthday → address + national ID → "Verifying info…" → outcome, with the sandbox KYC
// adapter's outcomes (approved / manual review → admin decision / rejected / retry), "Not now" + resume banner, trading
// and deposit gating, validation (underage, bad phone, wrong code, resend cooldown, send limits, PO box, ID format,
// duplicate ID), personal data encrypted at rest, 390 px layout, and persistence across a restart (including a KYC job
// queued before the restart). Real server + SQLite file + Chromium; invented test data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');
const H = require('./lib/identity-helpers');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-onboarding-'));
const DB_FILE = path.join(TMP, 'onboarding.db');
const PW = 'Lantern-Quartz-Meadow-4417';
const ADMIN = { email: 'root.onboarding@example.test', password: 'Ledger-Keeper-2026!' };
const stamp = Date.now();
const HIGH = { burst: 1e6, per_second: 1e6 };
let PORT; let BASE; let OPTS; let srv; let browser;
const D = H.db(DB_FILE);
const email = (k) => `${k}.${stamp}@example.test`;

before(async () => {
  PORT = await H.freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 400, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 },
    security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH },
    identity: { kycRequired: true, kyc: { delayMs: 900, pollMs: 150 }, phone: { cooldownSec: 4 }, settings: { sms: { per_ip_hour: 1000, per_account_day: 50 } } } };
  srv = await start(OPTS);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

async function freshUser(k, viewport) {
  const page = await H.newPage(browser, BASE, { viewport });
  await H.signUpUi(page, BASE, { name: `Onb ${k}`, email: email(k) }, PW);
  await page.waitForSelector('[data-testid=onboarding]'); // identity gating on: sign-up continues into onboarding
  return page;
}

test('happy path: full-screen flow with progress bar, 4-digit code, name, birthday, address + SSN, verifying, approved; gating lifts; PII encrypted at rest', async () => {
  const me = H.person({ first: 'Quillon', last: 'Testerby', dob: [7, 19, 1987], line1: '4821 Maple Test Avenue', ssn: '934-56-7712', phone: '202 555 0177', last4: '0177' });
  const page = await freshUser('happy');
  // Frame: only the wordmark, no site navigation; three progress segments.
  assert.equal(await page.locator('.topbar').isVisible(), false, 'site navigation hidden');
  assert.equal(await page.locator('.ob-wordmark').first().textContent(), 'Parlance');
  assert.equal(await page.locator('[data-testid=ob-progress] .ob-seg').count(), 3);
  // Before verification: deposits and orders are refused with a specific error code.
  const uid = await H.uidOf(page);
  let r = await H.call(page, 'POST', `/v1/users/${uid}/deposits`, { amount_dollars: 25 });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'identity_verification_required'); assert.equal(r.body.error.identity_status, 'not_started');
  // Phone step → code step.
  await page.selectOption('[data-testid=phone-country]', 'US');
  await page.fill('[data-testid=phone-number]', me.phone);
  const t0 = Date.now() - 1000;
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=code]');
  assert.equal(await page.textContent('h1'), 'Enter your 4 digit code');
  assert.equal(await page.textContent('[data-testid=code-destination]'), '+1 202 555 0177');
  assert.match(await page.textContent('.ob-form'), /spam folder/);
  const digits = page.locator('[data-testid=code-digit]');
  assert.equal(await digits.count(), 4);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.testid), 'code-digit', 'first box focused');
  assert.equal(await page.locator('[data-testid=ob-continue]').isDisabled(), true, 'Continue disabled until 4 digits');
  assert.equal(await page.locator('[data-testid=resend-code]').isVisible(), true);
  assert.equal(await page.locator('[data-testid=learn-more]').first().isVisible(), true);
  const code = await H.smsCode(BASE, '0177', t0);
  for (let i = 0; i < 3; i++) await digits.nth(i).type(code[i]);
  assert.equal(await page.locator('[data-testid=ob-continue]').isDisabled(), true);
  await digits.nth(3).type(code[3]);
  assert.equal(await page.locator('[data-testid=ob-continue]').isDisabled(), false);
  // The code is stored only as an HMAC.
  assert.equal(D.q('SELECT COUNT(*) c FROM phone_challenges WHERE code_hash=?', code)[0].c, 0);
  await page.click('[data-testid=ob-continue]');
  // Legal name with Learn more.
  await page.waitForSelector('[data-testid=onboarding][data-step=name]');
  assert.equal(await page.textContent('h1'), 'What’s your name?');
  await page.click('[data-testid=learn-more]');
  await page.locator('[data-testid=learn-more-dialog]').waitFor();
  await page.click('[data-testid=learn-more-dialog] [data-close]');
  assert.ok(await page.locator('label:has-text("Legal first name")').isVisible());
  assert.ok(await page.locator('[data-testid=not-now]').isVisible());
  await page.fill('[data-testid=first-name]', me.first);
  await page.fill('[data-testid=last-name]', me.last);
  await page.click('[data-testid=ob-continue]');
  // Birthday: MM · DD · Year auto-advance, notices, Continue disabled until valid.
  await page.waitForSelector('[data-testid=onboarding][data-step=birthday]');
  assert.match(await page.textContent('.ob-notices'), /18 or over to use Parlance/);
  assert.match(await page.textContent('.ob-notices'), /Federal law requires submitting truthful information/);
  await page.locator('[data-testid=dob-month]').type('07');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.testid), 'dob-day', 'auto-advance to DD');
  await page.locator('[data-testid=dob-day]').type('19');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.testid), 'dob-year');
  assert.equal(await page.locator('[data-testid=ob-continue]').isDisabled(), true);
  await page.locator('[data-testid=dob-year]').type('1987');
  assert.equal(await page.locator('[data-testid=ob-continue]').isDisabled(), false);
  await page.click('[data-testid=ob-continue]');
  // Address: country select, autocomplete suggestions, region select, postal, SSN field (autocomplete=off), the ID rule.
  await page.waitForSelector('[data-testid=onboarding][data-step=address]');
  assert.match(await page.textContent('.ob-sub'), /won’t send you marketing mail/);
  assert.match(await page.textContent('[data-testid=address-rule]'), /not a business address or PO box/);
  assert.equal(await page.getAttribute('[data-testid=national-id]', 'autocomplete'), 'off');
  assert.match(await page.textContent('[data-nid-label]'), /Social Security number \(SSN\) · 9 digits/);
  await page.selectOption('[data-testid=addr-country]', 'NG');
  assert.match(await page.textContent('[data-nid-label]'), /National Identification Number \(NIN\) · 11 digits/, 'country-specific ID field (Nigeria)');
  await page.selectOption('[data-testid=addr-country]', 'US');
  await page.locator('[data-testid=addr-line1]').type('4821 Map');
  await page.locator('[data-testid=addr-suggestion]').first().waitFor();
  await page.locator('[data-testid=addr-suggestion]').first().dispatchEvent('mousedown');
  assert.equal(await page.inputValue('[data-testid=addr-line1]'), '4821 Maple Test Avenue');
  assert.equal(await page.inputValue('[data-testid=addr-city]'), 'Sampleton');
  assert.equal(await page.inputValue('[data-testid=addr-region]'), 'NY');
  assert.equal(await page.inputValue('[data-testid=addr-postal]'), '10001');
  await page.fill('[data-testid=addr-line2]', 'Apt 9');
  await page.fill('[data-testid=national-id]', me.ssn);
  await page.click('[data-testid=ob-continue]');
  // Verifying info… then the approved outcome.
  await page.waitForSelector('[data-testid=ob-verifying]');
  assert.match(await page.textContent('[data-testid=ob-verifying]'), /Verifying info…/);
  await page.waitForSelector('[data-testid=ob-outcome][data-status=approved]', { timeout: 15000 });
  assert.equal(await page.textContent('[data-testid=outcome-title]'), 'You’re verified');
  // Gating lifted: deposit through the UI.
  await page.click('[data-testid=outcome-continue]');
  await page.waitForSelector('#funds');
  await page.fill('#f-amount', '40');
  await page.click('#funds [data-act=deposit]');
  await page.waitForSelector('.toast:has-text("Deposited $40.00")');
  assert.equal(D.q('SELECT balance_cents b FROM users WHERE id=?', uid)[0].b, 4000);
  assert.equal(await page.locator('[data-testid=identity-banner]').isVisible(), false, 'no banner once verified');

  // At rest: no plaintext name, birthday, street, phone or SSN anywhere in the database; ciphertexts are present.
  const dump = D.dump();
  for (const secret of [me.first, me.last, '4821 Maple Test', '934567712', '934-56-7712', '2025550177', '555 0177', '07/19/1987', '"year":1987']) {
    assert.ok(!dump.includes(secret), `plaintext "${secret}" found in the database`);
  }
  const p = D.q('SELECT * FROM identity_profiles WHERE user_id=?', uid)[0];
  for (const c of ['phone_enc', 'name_enc', 'dob_enc', 'address_enc', 'national_id_enc']) assert.match(p[c], /^enc:v1:/, c);
  assert.equal(p.national_id_last, '7712');
  assert.match(p.national_id_hash, /^[0-9a-f]{64}$/);
  assert.equal(p.status, 'approved');
  // APIs mask: the owner's summary never contains the full SSN or the street.
  const mine = await H.call(page, 'GET', `/v1/users/${uid}/identity`);
  assert.equal(mine.body.national_id.masked, '•••-••-7712');
  assert.equal(mine.body.name_masked, 'Q*** T***');
  assert.ok(!JSON.stringify(mine.body).includes('934567712') && !JSON.stringify(mine.body).includes('4821 Maple'));
  // Audit trail of the flow (no personal data in event details).
  const types = D.q('SELECT type, detail FROM auth_events WHERE user_id=? ORDER BY ts', uid);
  for (const t of ['phone_code_sent', 'phone_verified', 'identity_step', 'identity_submitted', 'identity_approved']) assert.ok(types.some((e) => e.type === t), t);
  assert.ok(!JSON.stringify(types).includes('0177') || JSON.stringify(types).includes('••••••0177'), 'phone only masked in events');
  await H.assertClean(assert, page);
  await page.context().close();
});

test('"Not now" leaves the flow, a banner invites the user back, progress persists across reloads, resume continues at the next step', async () => {
  const me = H.person();
  const page = await freshUser('notnow');
  await page.selectOption('[data-testid=phone-country]', 'US');
  await page.fill('[data-testid=phone-number]', me.phone);
  const t0 = Date.now() - 1000;
  await page.click('[data-testid=ob-continue]');
  const code = await H.smsCode(BASE, me.last4, t0);
  for (let i = 0; i < 4; i++) await page.locator('[data-testid=code-digit]').nth(i).type(code[i]);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=name]');
  await page.click('[data-testid=not-now]');
  await page.waitForSelector('[data-testid=identity-banner]:not([hidden])');
  assert.match(await page.textContent('[data-testid=identity-banner]'), /Verify your identity to start trading/);
  assert.equal(await page.locator('.topbar').isVisible(), true, 'back on the regular site');
  // Persisted: reload keeps the banner; the state API reports the skip and the next step.
  await page.reload();
  await page.waitForSelector('[data-testid=identity-banner]:not([hidden])');
  const uid = await H.uidOf(page);
  const st = await H.call(page, 'GET', `/v1/users/${uid}/sign_up`);
  assert.equal(st.body.skipped, true); assert.equal(st.body.next_step, 'name'); assert.equal(st.body.steps.phone, true);
  // Trading is refused with the explanation dialog.
  const mk = D.q("SELECT ticker FROM markets WHERE status='active' ORDER BY rowid LIMIT 1")[0].ticker;
  await page.evaluate(async ([u, t]) => { const { api } = await import('/js/api.js'); try { await api.submitOrder(u, { ticker: t, side: 'yes', type: 'limit', price: 5, count: 1 }); } catch { /* expected */ } }, [uid, mk]);
  await page.locator('[data-testid=compliance-dialog][data-code=identity_verification_required]').waitFor();
  await page.click('[data-testid=compliance-verify]');
  // Resume (POST /resume_sign_up) lands on the name step, phone already done.
  await page.waitForSelector('[data-testid=onboarding][data-step=name]');
  assert.equal(D.q('SELECT skipped_at FROM identity_profiles WHERE user_id=?', uid)[0].skipped_at, null);
  await H.assertClean(assert, page);
  await page.context().close();
});

test('sandbox outcomes: "Review" → manual review → admin approves (masked queue, audited); "Reject" → rejected with reason; "Retry" → fix details → approved', async () => {
  // Manual review.
  const pr = await freshUser('review');
  await H.completeOnboarding(pr, BASE, H.person({ last: 'Review' }), { expectStatus: 'review' });
  assert.equal(await pr.textContent('[data-testid=outcome-title]'), 'We’re reviewing your info');
  const rid = await H.uidOf(pr);
  // Admin queue: masked values only.
  const admin = await H.newPage(browser, BASE);
  await H.logInUi(admin, BASE, ADMIN.email, ADMIN.password);
  await admin.waitForSelector('[data-testid=account-menu]');
  await admin.goto(BASE + '/admin/kyc');
  const row = admin.locator(`[data-testid=kyc-queue] tr[data-user="${rid}"]`);
  await row.waitFor();
  assert.match(await row.textContent(), /T\*\*\* R\*\*\*/);
  assert.match(await row.textContent(), /•••-••-\d{4}/);
  assert.ok(!(await row.textContent()).includes('Testa'), 'no unmasked name in the queue');
  await row.locator('[data-testid=kyc-open]').click();
  await admin.locator('[data-testid=identity-dialog]').waitFor();
  await admin.selectOption('[data-testid=kyc-decision]', 'approve');
  await admin.fill('[data-testid=kyc-note]', 'Matched the sandbox record manually');
  await admin.click('[data-testid=kyc-submit]');
  await admin.waitForSelector('.toast:has-text("Decision recorded: approved")');
  assert.equal(D.q('SELECT status, decided_by FROM identity_profiles WHERE user_id=?', rid)[0].status, 'approved');
  const audit = D.q("SELECT action, reason, before_json, after_json FROM admin_audit WHERE action='kyc.approve' AND target_id=?", rid);
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).includes('Testa') && !JSON.stringify(audit).includes('Review"'), 'no personal data in the audit row');
  // The user is notified and the outcome screen shows approved.
  await H.until(() => D.q("SELECT 1 FROM notifications WHERE user_id=? AND type='identity' AND title='You’re verified'", rid)[0]);
  await pr.goto(BASE + '/sign-up/identity');
  await pr.waitForSelector('[data-testid=ob-outcome][data-status=approved]');
  await pr.context().close();

  // Rejected.
  const pj = await freshUser('reject');
  await H.completeOnboarding(pj, BASE, H.person({ last: 'Reject' }), { expectStatus: 'rejected' });
  assert.equal(await pj.getAttribute('[data-testid=ob-outcome]', 'data-reason'), 'identity_mismatch');
  assert.match(await pj.textContent('[data-testid=outcome-message]'), /didn’t match official records/);
  const jid = await H.uidOf(pj);
  assert.equal((await H.call(pj, 'POST', `/v1/users/${jid}/deposits`, { amount_dollars: 5 })).body.error.code, 'identity_verification_required');
  await pj.goto(BASE + '/');
  await pj.waitForSelector('[data-testid=identity-banner]:not([hidden])');
  assert.match(await pj.textContent('[data-testid=identity-banner]'), /couldn’t verify your identity/);
  await pj.context().close();

  // Retry: fix the details (prefilled), submit again, approved.
  const pt = await freshUser('retry');
  const retryPerson = H.person({ last: 'Retry' });
  await H.completeOnboarding(pt, BASE, retryPerson, { expectStatus: 'retry' });
  assert.match(await pt.textContent('[data-testid=outcome-message]'), /couldn’t match some of your details/);
  await pt.click('[data-testid=outcome-retry]');
  await pt.waitForSelector('[data-testid=onboarding][data-step=name]');
  assert.ok(await pt.locator('[data-testid=retry-note]').isVisible());
  assert.equal(await pt.inputValue('[data-testid=first-name]'), 'Testa', 'prefilled for the owner');
  await pt.fill('[data-testid=last-name]', 'Corrected');
  await pt.click('[data-testid=ob-continue]');
  await pt.waitForSelector('[data-testid=onboarding][data-step=birthday]');
  assert.equal(await pt.locator('[data-testid=ob-continue]').isDisabled(), false, 'birthday prefilled');
  await pt.click('[data-testid=ob-continue]');
  await pt.waitForSelector('[data-testid=onboarding][data-step=address]');
  assert.equal(await pt.inputValue('[data-testid=national-id]'), '', 'national ID is never sent back, even to the owner');
  assert.match(await pt.textContent('[data-nid-hint]'), /On file: •••-••-\d{4}/);
  await pt.fill('[data-testid=national-id]', retryPerson.ssn);
  await pt.click('[data-testid=ob-continue]');
  await pt.waitForSelector('[data-testid=ob-outcome][data-status=approved]', { timeout: 15000 });
  assert.equal(D.q('SELECT kyc_attempts FROM identity_profiles WHERE user_id=?', await H.uidOf(pt))[0].kyc_attempts, 2);
  await H.assertClean(assert, pt);
  await H.assertClean(assert, admin);
  await pt.context().close(); await admin.context().close();
});

test('validation: bad phone, wrong code (attempts left), resend cooldown with timer, underage, PO box, ID format without echo, duplicate national ID', async () => {
  const page = await freshUser('valid');
  const uid = await H.uidOf(page);
  // Bad phone.
  await page.fill('[data-testid=phone-number]', '123');
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=ob-error]:has-text("Enter a valid United States phone number")');
  // Premium-rate numbers are refused (SMS-pumping protection).
  assert.equal((await H.call(page, 'POST', `/v1/users/${uid}/verify_phone/send`, { country: 'US', number: '900 555 0100' })).body.error.fields.number, 'premium-rate numbers cannot receive verification codes');
  const me = H.person();
  await page.fill('[data-testid=phone-number]', me.phone);
  const t0 = Date.now() - 1000;
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=code]');
  const code = await H.smsCode(BASE, me.last4, t0);
  // Resend cooldown: the button shows a countdown and is disabled.
  const resend = page.locator('[data-testid=resend-code]');
  assert.equal(await resend.isDisabled(), true);
  assert.match(await resend.textContent(), /Resend code in 0:0\d/);
  // Wrong code.
  const wrong = code === '0000' ? '1111' : '0000';
  for (let i = 0; i < 4; i++) await page.locator('[data-testid=code-digit]').nth(i).type(wrong[i]);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=ob-error]:has-text("4 attempts left")');
  // After the cooldown the code can be resent; the old code stops working.
  await H.until(async () => !(await resend.isDisabled()), 8000);
  assert.equal(await resend.textContent(), 'Resend code');
  const t1 = Date.now() - 500;
  await resend.click();
  await page.waitForSelector('.toast:has-text("We sent you a new code")');
  const code2 = await H.smsCode(BASE, me.last4, t1);
  if (code2 !== code) assert.equal((await H.call(page, 'POST', `/v1/users/${uid}/verify_phone`, { code })).body.error.code, 'invalid_code', 'the superseded code is dead');
  // Cooldown is enforced by the server too.
  const cool = await H.call(page, 'POST', `/v1/users/${uid}/verify_phone/send`, { country: 'US', number: me.phone });
  assert.equal(cool.status, 429); assert.equal(cool.body.error.code, 'sms_cooldown'); assert.ok(cool.body.error.retry_after_sec >= 1);
  for (let i = 0; i < 4; i++) await page.locator('[data-testid=code-digit]').nth(i).fill(code2[i]);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=name]');
  await page.fill('[data-testid=first-name]', 'Testa');
  await page.fill('[data-testid=last-name]', 'Sample');
  await page.click('[data-testid=ob-continue]');
  // Underage: refused server-side (the UI only checks the date is valid).
  await page.waitForSelector('[data-testid=onboarding][data-step=birthday]');
  const y = new Date().getUTCFullYear() - 16;
  await page.fill('[data-testid=dob-month]', '03'); await page.fill('[data-testid=dob-day]', '04'); await page.fill('[data-testid=dob-year]', String(y));
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=ob-error]:has-text("You must be 18 or over to use Parlance")');
  const under = await H.call(page, 'PUT', `/v1/users/${uid}/sign_up/birthday`, { month: 3, day: 4, year: y });
  assert.equal(under.status, 400); assert.equal(under.body.error.code, 'age_requirement');
  assert.equal(D.q('SELECT dob_enc FROM identity_profiles WHERE user_id=?', uid)[0].dob_enc, null, 'an underage date is not stored');
  await page.fill('[data-testid=dob-year]', '1991');
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=address]');
  // PO box and an invalid SSN: field errors that never echo the value.
  await page.fill('[data-testid=addr-line1]', 'PO Box 1234');
  await page.fill('[data-testid=addr-city]', 'Sampleton');
  await page.selectOption('[data-testid=addr-region]', 'NY');
  await page.fill('[data-testid=addr-postal]', '10001');
  await page.fill('[data-testid=national-id]', '000-12-3456');
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=ob-error]:has-text("not a PO box")');
  const err = await page.textContent('[data-testid=ob-error]');
  assert.match(err, /not a valid SSN/);
  assert.ok(!err.includes('000') && !err.includes('3456'), 'the ID is not echoed');
  // Postal code format per country.
  const bad = await H.call(page, 'PUT', `/v1/users/${uid}/sign_up/address`, { country: 'US', line1: '1 Maple Test Avenue', line2: '', city: 'Sampleton', region: 'NY', postal_code: 'ABC', national_id: me.ssn });
  assert.equal(bad.body.error.code, 'validation_failed'); assert.match(bad.body.error.fields.postal_code, /zip code/i);
  // Unknown fields and wrong types are refused by the central validator.
  assert.equal((await H.call(page, 'PUT', `/v1/users/${uid}/sign_up/name`, { first_name: 'A', last_name: 'B', admin: true })).body.error.fields.admin, 'is not an accepted field');
  assert.equal((await H.call(page, 'PUT', `/v1/users/${uid}/sign_up/name`, { first_name: { $gt: '' }, last_name: 'B' })).body.error.fields.first_name, 'must be string');
  // Duplicate national ID: a second account with an already verified SSN is rejected (duplicate_account).
  const used = D.q("SELECT user_id FROM identity_profiles WHERE status='approved' LIMIT 1")[0];
  assert.ok(used, 'an approved profile exists from the earlier tests');
  await page.fill('[data-testid=addr-line1]', '77 Maple Test Avenue');
  await page.fill('[data-testid=national-id]', '934-56-7712'); // the happy-path user's (invented) SSN
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=ob-outcome][data-status=rejected]', { timeout: 15000 });
  assert.equal(await page.getAttribute('[data-testid=ob-outcome]', 'data-reason'), 'duplicate_account');
  await H.assertClean(assert, page);
  await page.context().close();
});

test('SMS send limits: per number, per country and per IP; limits are audited; admin settings change them live', async () => {
  const c = new Client(BASE, 'limits');
  await c.signUp(email('limits'), PW, 'Limit Tester');
  const send = (number, country = 'US') => c.call('POST', `/v1/users/${c.uid}/verify_phone/send`, { country, number });
  // Cooldown 4 s between sends from one account; per-number limit 5 / hour (default).
  const statuses = [];
  for (let i = 0; i < 6; i++) { statuses.push((await send('202 555 0199')).status); await H.sleep(4100); }
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
  const lim = await send('202 555 0199');
  assert.ok([429].includes(lim.status));
  const limited = D.q("SELECT outcome FROM sms_send_log WHERE user_id=? AND outcome LIKE 'limited:%'", c.uid).map((r) => r.outcome);
  assert.ok(limited.includes('limited:number'), JSON.stringify(limited));
  assert.ok(D.q("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='phone_code_limited'", c.uid)[0].c >= 1);
  // The number is stored only as an HMAC in the send log.
  assert.ok(!JSON.stringify(D.q('SELECT * FROM sms_send_log')).includes('2025550199'));
  // Per destination country: an admin lowers Nigeria to 1 code per hour.
  const a = new Client(BASE, 'admin');
  await a.logIn(ADMIN.email, ADMIN.password);
  const put = await a.call('PUT', '/v1/admin/compliance/settings', { sms: { country_limits: { NG: 1 } }, reason: 'SMS pumping spike to NG' });
  assert.equal(put.status, 200, put.text);
  assert.equal(D.q("SELECT COUNT(*) c FROM admin_audit WHERE action='compliance.settings'")[0].c >= 1, true);
  const c2 = new Client(BASE, 'ng');
  await c2.signUp(email('ng1'), PW, 'Ng Tester');
  assert.equal((await c2.call('POST', `/v1/users/${c2.uid}/verify_phone/send`, { country: 'NG', number: '0803 555 0101' })).status, 201);
  const c3 = new Client(BASE, 'ng2');
  await c3.signUp(email('ng2'), PW, 'Ng Second');
  const ng = await c3.call('POST', `/v1/users/${c3.uid}/verify_phone/send`, { country: 'NG', number: '0803 555 0102' });
  assert.equal(ng.status, 429); assert.equal(ng.body.error.scope, 'country');
  // Per IP: lowered to the current count → the next request from this IP is refused.
  assert.equal((await a.call('PUT', '/v1/admin/compliance/settings', { sms: { per_ip_hour: 2, country_limits: {} }, reason: 'test' })).status, 200);
  const ip = await c3.call('POST', `/v1/users/${c3.uid}/verify_phone/send`, { country: 'US', number: '202 555 0188' });
  assert.equal(ip.status, 429); assert.equal(ip.body.error.scope, 'ip');
  assert.equal((await a.call('PUT', '/v1/admin/compliance/settings', { sms: { per_ip_hour: 1000 }, reason: 'restore' })).status, 200);
  // Invalid settings are refused per field.
  const badSet = await a.call('PUT', '/v1/admin/compliance/settings', { sms: { per_number_hour: -1 }, fraud: { hold_threshold: 5 } });
  assert.equal(badSet.body.error.code, 'validation_failed');
  assert.ok(badSet.body.error.fields['sms.per_number_hour'] && badSet.body.error.fields['fraud.hold_threshold']);
});

test('390 px phone layout: every onboarding step fits without horizontal scrolling', async () => {
  const page = await freshUser('phone390', { width: 390, height: 844 });
  const noOverflow = async (step) => {
    await page.waitForSelector(`[data-testid=onboarding][data-step=${step}]`);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(w <= 390, `${step}: page is ${w}px wide`);
  };
  await noOverflow('phone');
  const me = H.person();
  await page.fill('[data-testid=phone-number]', me.phone);
  const t0 = Date.now() - 1000;
  await page.click('[data-testid=ob-continue]');
  await noOverflow('code');
  const code = await H.smsCode(BASE, me.last4, t0);
  for (let i = 0; i < 4; i++) await page.locator('[data-testid=code-digit]').nth(i).type(code[i]);
  await page.click('[data-testid=ob-continue]');
  await noOverflow('name');
  await page.fill('[data-testid=first-name]', 'Testa'); await page.fill('[data-testid=last-name]', 'Sample');
  await page.click('[data-testid=ob-continue]');
  await noOverflow('birthday');
  await page.fill('[data-testid=dob-month]', '01'); await page.fill('[data-testid=dob-day]', '02'); await page.fill('[data-testid=dob-year]', '1980');
  await page.click('[data-testid=ob-continue]');
  await noOverflow('address');
  await page.goto(BASE + '/account/privacy');
  await page.waitForSelector('[data-testid=identity-panel]');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390);
  await H.assertClean(assert, page);
  await page.context().close();
});

test('restart: onboarding progress, encrypted fields and a KYC job queued before the restart all survive', async () => {
  const c = new Client(BASE, 'restart');
  await c.signUp(email('restart'), PW, 'Restart Tester');
  const me = H.person({ phone: '202 555 0166', last4: '0166' });
  const t0 = Date.now() - 1000;
  assert.equal((await c.call('POST', `/v1/users/${c.uid}/verify_phone/send`, { country: 'US', number: me.phone })).status, 201);
  const code = await H.smsCode(BASE, '0166', t0);
  assert.equal((await c.call('POST', `/v1/users/${c.uid}/verify_phone`, { code })).status, 200);
  assert.equal((await c.call('PUT', `/v1/users/${c.uid}/sign_up/name`, { first_name: 'Restarta', last_name: 'Sample' })).status, 200);
  assert.equal((await c.call('PUT', `/v1/users/${c.uid}/sign_up/birthday`, { month: 2, day: 3, year: 1979 })).status, 200);
  assert.equal((await c.call('PUT', `/v1/users/${c.uid}/sign_up/address`, { country: 'US', line1: '5 Maple Test Avenue', line2: '', city: 'Sampleton', region: 'NY', postal_code: '10001', national_id: me.ssn })).status, 200);
  // Submit and stop the server before the (900 ms) sandbox delay elapses.
  assert.equal((await c.call('POST', `/v1/users/${c.uid}/sign_up/submit`, {})).status, 202);
  await srv.close();
  assert.equal(D.q("SELECT status FROM kyc_jobs WHERE user_id=? ORDER BY created_ts DESC LIMIT 1", c.uid)[0].status, 'queued');
  srv = await start(OPTS);
  await H.until(() => D.q('SELECT status FROM identity_profiles WHERE user_id=?', c.uid)[0].status === 'approved', 15000);
  // The session survived; the owner's state is intact and decryptable after the restart.
  const st = await c.call('GET', `/v1/users/${c.uid}/sign_up?include=details`);
  assert.equal(st.status, 200);
  assert.equal(st.body.details.first_name, 'Restarta');
  assert.deepEqual(st.body.details.dob, { month: 2, day: 3, year: 1979 });
  assert.equal(st.body.phone.masked, '+1 ••••••0166');
  assert.equal(st.body.status, 'approved');
  assert.equal((await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: 12 })).status, 201);
});
