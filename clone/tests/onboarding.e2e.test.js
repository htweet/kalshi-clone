'use strict';
// Identity onboarding E2E (PLAN P3.1, P3.1a, P3.2, P3.5; CLONE_SPEC §13.14 observed flow; CLONE_SPEC.md §25): the
// full-screen flow phone code → legal name → birthday → address + national ID → "Verifying info…" → document verification
// → outcome, with the sandbox KYC adapter's outcomes (approved / manual review → admin decision / rejected / retry),
// "Not now" + resume banner, trading and deposit gating, validation (underage, bad phone, wrong code, resend cooldown,
// send limits, PO box, ID format, duplicate ID), personal data encrypted at rest, 390 px layout, and persistence across a
// restart (a KYC job queued before the restart finishes after it). Real server + SQLite + Chromium; invented data only.
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
    identity: { kycRequired: true, kyc: { delayMs: 700, pollMs: 150 }, phone: { cooldownSec: 4 }, settings: { sms: { per_ip_hour: 1000, per_account_day: 50, per_number_hour: 50 } } } };
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

test('happy path: phone code → name → birthday → address + SSN → verifying → QR handoff to a phone → approved; gating lifts; PII never in plaintext', async () => {
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
  const mk = D.q("SELECT ticker FROM markets WHERE status='active' AND mve_collection_ticker IS NULL LIMIT 1")[0].ticker;
  r = await H.call(page, 'POST', `/v1/users/${uid}/orders`, { ticker: mk, side: 'yes', type: 'limit', price: 5, count: 1 });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'identity_verification_required');

  // Phone → code: four boxes, first focused, Continue disabled until 4 digits, Resend with a visible timer.
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
  assert.equal(await page.locator('[data-testid=ob-continue]').isDisabled(), true);
  assert.match(await page.textContent('[data-testid=resend-code]'), /Resend code in 0:0\d/, 'resend cooldown timer is visible');
  const code = await H.smsCode(BASE, '0177', t0);
  for (let i = 0; i < 3; i++) await digits.nth(i).type(code[i]);
  assert.equal(await page.locator('[data-testid=ob-continue]').isDisabled(), true);
  await digits.nth(3).type(code[3]);
  assert.equal(await page.locator('[data-testid=ob-continue]').isDisabled(), false);
  assert.equal(D.q('SELECT COUNT(*) c FROM phone_challenges WHERE code_hash=?', code)[0].c, 0, 'the code is stored only as an HMAC');
  await page.click('[data-testid=ob-continue]');

  // Legal name, birthday (auto-advance), address with a country-specific ID field.
  await page.waitForSelector('[data-testid=onboarding][data-step=name]');
  assert.equal(await page.textContent('h1'), 'What’s your name?');
  assert.ok(await page.locator('[data-testid=not-now]').isVisible());
  await page.fill('[data-testid=first-name]', me.first);
  await page.fill('[data-testid=last-name]', me.last);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=birthday]');
  assert.match(await page.textContent('.ob-notices'), /18 or over to use Parlance/);
  await page.locator('[data-testid=dob-month]').type('07');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.testid), 'dob-day', 'auto-advance to DD');
  await page.locator('[data-testid=dob-day]').type('19');
  await page.locator('[data-testid=dob-year]').type('1987');
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=address]');
  assert.match(await page.textContent('.ob-sub'), /won’t send you marketing mail/);
  assert.equal(await page.getAttribute('[data-testid=national-id]', 'autocomplete'), 'off');
  assert.match(await page.textContent('[data-nid-label]'), /Social Security number \(SSN\) · 9 digits/);
  await page.selectOption('[data-testid=addr-country]', 'NG');
  assert.match(await page.textContent('[data-nid-label]'), /National Identification Number \(NIN\) · 11 digits/, 'country-specific ID field');
  await page.selectOption('[data-testid=addr-country]', 'US');
  await page.fill('[data-testid=addr-line1]', me.line1);
  await page.fill('[data-testid=addr-line2]', 'Apt 9');
  await page.fill('[data-testid=addr-city]', 'Sampleton');
  await page.selectOption('[data-testid=addr-region]', 'NY');
  await page.fill('[data-testid=addr-postal]', '10001');
  await page.fill('[data-testid=national-id]', me.ssn);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=ob-verifying]');
  assert.match(await page.textContent('[data-testid=ob-verifying]'), /Verifying info…/);

  // Document verification intro (§13.15): "Let's get you verified", ID + smartphone, Get started, vendor footer, ✕.
  await page.waitForSelector('[data-testid=docv-intro]', { timeout: 15000 });
  assert.equal(await page.textContent('[data-testid=docv-intro] h1'), 'Let’s get you verified');
  assert.match(await page.textContent('[data-testid=docv-intro]'), /It will only take 2 minutes[\s\S]*What you will need:[\s\S]*Government Issued ID[\s\S]*Smartphone/);
  assert.match(await page.textContent('[data-testid=docv-vendor]'), /powered by Parlance Verify \(sandbox\)/);
  assert.ok(await page.locator('[data-testid=docv-close]').isVisible());
  const started = page.waitForResponse((x) => x.url().endsWith('/docv/sessions') && x.request().method() === 'POST');
  await page.click('[data-testid=docv-start]');
  const handoff = (await (await started).json()).handoff_url;
  await page.waitForSelector('[data-testid=docv-qr] svg');
  assert.equal(await page.textContent('[data-testid=docv-qr-step] h1'), 'Continue on your phone');
  assert.match(await page.textContent('[data-testid=docv-qr-step]'), /Scan the QR code below with your phone’s camera/);
  // The QR is generated locally and encodes exactly the single-use handoff URL (token in the fragment, not the query).
  assert.match(handoff, new RegExp(`^${BASE.replace(/[.]/g, '\\.')}/verify/m#t=[A-Za-z0-9_-]{43}$`));
  const same = await page.evaluate(async (url) => {
    const { qrMatrix } = await import('/js/qr.js');
    const m = qrMatrix(url);
    const svg = document.querySelector('[data-testid=docv-qr] svg');
    const d = svg.querySelector('path').getAttribute('d');
    const dark = new Set([...d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((x) => `${Number(x[1]) - 4},${Number(x[2]) - 4}`));
    let diff = 0;
    for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.modules[y][x] !== dark.has(`${x},${y}`)) diff++;
    return { diff, size: m.size, svgSize: Number(svg.dataset.qrSize) };
  }, handoff);
  assert.equal(same.diff, 0, 'QR modules match the handoff URL'); assert.equal(same.size, same.svgSize);
  assert.equal(D.q("SELECT COUNT(*) c FROM docv_sessions WHERE token_hash IS NOT NULL AND status='created' AND user_id=?", uid)[0].c, 1, 'only the token hash is stored');

  // The phone (a second browser context, no account session) opens the link and captures three photos.
  const phone = await H.newPage(browser, BASE, { viewport: { width: 390, height: 844 }, path: '/' });
  await phone.goto(handoff);
  await phone.waitForSelector('[data-testid=phone-capture]');
  assert.equal(new URL(phone.url()).hash, '', 'token removed from the address bar');
  for (const k of ['id_front', 'id_back', 'selfie']) assert.match(await phone.getAttribute(`[data-testid=capture-${k}]`, 'capture'), /environment|user/);
  // Desktop follows live: "Stay on this page", "Uploading your documents…", Exit pill.
  await page.waitForSelector('[data-testid=docv-wait]', { timeout: 10000 });
  assert.equal(await page.textContent('[data-testid=docv-wait] h1'), 'Stay on this page');
  assert.match(await page.textContent('[data-testid=docv-wait]'), /Check back here to complete verification/);
  assert.equal(await page.textContent('[data-testid=docv-status]'), 'Uploading your documents…');
  assert.ok(await page.locator('[data-testid=docv-exit]').isVisible());
  const front = await H.jpegWithExif(phone, 640, 400, 'FRONT');
  await phone.setInputFiles('[data-testid=capture-id_front]', { name: 'front.jpg', mimeType: 'image/jpeg', buffer: front });
  await phone.waitForSelector('[data-testid=state-id_front]:has-text("Added")');
  await page.waitForSelector('[data-testid=docv-doclist] li[data-kind=id_front][data-uploaded="1"]', { timeout: 10000 }); // live on the desktop
  await phone.setInputFiles('[data-testid=capture-id_back]', { name: 'back.png', mimeType: 'image/png', buffer: H.pngImage(400, 260, 5) });
  await phone.waitForSelector('[data-testid=state-id_back]:has-text("Added")');
  await phone.setInputFiles('[data-testid=capture-selfie]', { name: 'selfie.jpg', mimeType: 'image/jpeg', buffer: await H.jpegWithExif(phone, 480, 640, 'SELFIE') });
  await phone.waitForSelector('[data-testid=state-selfie]:has-text("Added")');
  await page.waitForSelector('[data-testid=docv-doclist] li[data-kind=selfie][data-uploaded="1"]', { timeout: 10000 });
  // Stored images: encrypted (no JPEG/PNG bytes at rest) and stripped of metadata and trailing bytes once decrypted.
  const docs = D.q('SELECT id, kind, mime, data FROM docv_documents WHERE user_id=? AND data IS NOT NULL', uid);
  assert.equal(docs.length, 3);
  const identity = srv.server.listeners('request')[0].locals.identity;
  for (const d of docs) {
    const blob = Buffer.from(d.data);
    assert.ok(!blob.includes(Buffer.from([0xff, 0xd8, 0xff])) && !blob.includes(Buffer.from('JFIF')) && !blob.includes(Buffer.from('IHDR')), `${d.kind} not stored in the clear`);
    const plain = identity.docv.readDocument(uid, d.id).data;
    assert.equal(plain.subarray(0, 2).toString('hex'), 'ffd8', 'the browser re-encoded every capture to JPEG');
    for (const marker of ['GPSTESTMARKER', 'Exif', 'TRAILINGPAYLOAD', 'camera-serial']) assert.ok(!plain.includes(Buffer.from(marker)), `${d.kind}: ${marker} stripped`);
  }
  await phone.click('[data-testid=phone-submit]');
  await phone.waitForSelector('[data-testid=phone-done]');
  // Desktop: "Verifying info…" then approved.
  await page.waitForSelector('[data-testid=ob-outcome][data-status=approved]', { timeout: 20000 });
  assert.equal(await page.textContent('[data-testid=outcome-title]'), 'You’re verified');
  // Retention: images erased at the decision (rows keep only metadata).
  assert.equal(D.q('SELECT COUNT(*) c FROM docv_documents WHERE user_id=? AND data IS NOT NULL', uid)[0].c, 0);
  assert.equal(D.q("SELECT COUNT(*) c FROM docv_documents WHERE user_id=? AND delete_reason='decision:approved'", uid)[0].c, 3);
  // Gating lifted.
  r = await H.call(page, 'POST', `/v1/users/${uid}/deposits`, { amount_dollars: 25 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // Personal data: never plaintext anywhere in the database; APIs return masked values only.
  const dump = D.dump();
  for (const v of ['Quillon', 'Testerby', '4821 Maple Test Avenue', '934567712', '934-56-7712', '2025550177', '+12025550177', '1987-07-19', '"year":1987']) assert.ok(!dump.includes(v), `plaintext "${v}" found at rest`);
  const idv = await H.call(page, 'GET', `/v1/users/${uid}/identity`);
  assert.equal(idv.body.national_id.masked, '•••-••-7712');
  assert.ok(!JSON.stringify(idv.body).includes('934567712') && !JSON.stringify(idv.body).includes('Testerby'));
  await H.assertClean(assert, page); await H.assertClean(assert, phone);
  await phone.context().close(); await page.context().close();
});

test('QR handoff security: single use, 10-minute expiry, bound to the desktop session; bad uploads refused; exit keeps progress; same-device fallback', async () => {
  const c = await new Client(BASE, 'handoff').signUp(email('handoff'), PW, 'Hand Off');
  const st = await H.apiOnboard(BASE, c, H.person(), { docs: false });
  assert.equal(st.status, 'documents_required');
  const start1 = await c.call('POST', `/v1/users/${c.uid}/docv/sessions`, {});
  assert.equal(start1.status, 201);
  const token = new URL(start1.body.handoff_url).hash.slice(3);
  // Phone A claims it; phone B with the same link is refused (single use), and so is a replay from phone A.
  const phoneA = await H.newPage(browser, BASE, { viewport: { width: 390, height: 844 } });
  await phoneA.goto(start1.body.handoff_url);
  await phoneA.waitForSelector('[data-testid=phone-capture]');
  const phoneB = await H.newPage(browser, BASE, { viewport: { width: 390, height: 844 } });
  await phoneB.goto(start1.body.handoff_url);
  await phoneB.waitForSelector('[data-testid=handoff-error][data-code=handoff_used]');
  const replay = await H.call(phoneA, 'POST', '/v1/docv/handoff/claim', { token });
  assert.equal(replay.status, 410); assert.equal(replay.body.error.code, 'handoff_used');
  // Wrong file type and a missing CSRF value are refused; a text file renamed .jpg never reaches storage.
  const notImage = await H.call(phoneA, 'POST', '/v1/docv/handoff/documents', { kind: 'id_front', image: Buffer.from('<?php echo 1; ?> not an image').toString('base64') });
  assert.equal(notImage.status, 403, 'no X-Docv-Csrf → refused');
  await phoneA.setInputFiles('[data-testid=capture-id_front]', { name: 'front.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('this is a text file, not a photo') });
  await phoneA.waitForSelector('[data-testid=phone-error]:has-text("photo")');
  assert.equal(D.q('SELECT COUNT(*) c FROM docv_documents WHERE user_id=?', c.uid)[0].c, 0);
  await phoneA.setInputFiles('[data-testid=capture-id_front]', { name: 'front.png', mimeType: 'image/png', buffer: H.pngImage(320, 220, 9) });
  await phoneA.waitForSelector('[data-testid=state-id_front]:has-text("Added")');
  // Session-bound: signing the desktop out ends the phone's capture session too.
  await c.call('POST', '/v1/log_out', {});
  await phoneA.setInputFiles('[data-testid=capture-id_back]', { name: 'back.png', mimeType: 'image/png', buffer: H.pngImage(320, 220, 11) });
  await phoneA.waitForSelector('[data-testid=phone-error]:has-text("session ended")');
  // Expiry: an unclaimed link older than 10 minutes is refused.
  await c.logIn(email('handoff'), PW);
  const start2 = await c.call('POST', `/v1/users/${c.uid}/docv/sessions`, {});
  D.run("UPDATE docv_sessions SET token_expires_ts=? WHERE user_id=? AND status='created'", Date.now() - 1000, c.uid);
  const late = await H.newPage(browser, BASE);
  await late.goto(start2.body.handoff_url);
  await late.waitForSelector('[data-testid=handoff-error][data-code=handoff_expired]');
  // Exit identity verification keeps progress (the front photo) and kills the open link; the same-device fallback finishes.
  const page = await H.newPage(browser, BASE);
  await H.logInUi(page, BASE, email('handoff'), PW);
  await page.waitForSelector('[data-testid=docv-intro]');
  await page.click('[data-testid=docv-start]');
  await page.waitForSelector('[data-testid=docv-qr] svg');
  await page.click('[data-testid=docv-close]');
  await page.waitForSelector('[data-testid=identity-banner]:not([hidden])');
  assert.equal(D.q("SELECT COUNT(*) c FROM docv_sessions WHERE user_id=? AND status='exited'", c.uid)[0].c, 1);
  assert.deepEqual(D.q('SELECT kind FROM docv_documents WHERE user_id=? AND data IS NOT NULL', c.uid).map((x) => x.kind), ['id_front'], 'progress kept');
  await page.click('[data-testid=identity-banner-cta]');
  await page.waitForSelector('[data-testid=docv-intro]');
  await page.click('[data-testid=docv-same-device]');
  await page.waitForSelector('[data-testid=docv-device] [data-state=id_front]:has-text("Added")');
  for (const k of ['id_back', 'selfie']) {
    await page.setInputFiles(`[data-testid=device-capture-${k}]`, { name: `${k}.png`, mimeType: 'image/png', buffer: H.pngImage(360, 240, 13) });
    await page.waitForSelector(`[data-state="${k}"]:has-text("Added")`);
  }
  await page.click('[data-testid=docv-device-submit]');
  await page.waitForSelector('[data-testid=ob-outcome][data-status=approved]', { timeout: 20000 });
  await H.assertClean(assert, page);
  for (const p of [phoneA, phoneB, late, page]) await p.context().close();
});

test('sandbox outcomes: "Review" → admin queue (masked, audited reveal and document view) → approved; "Reject" → rejected; "Retry" → fix details → approved', async () => {
  // Review: manual review after the documents; an admin sees masked data, reveals with a reason (audited), views a document.
  const rv = await freshUser('review');
  await H.completeOnboarding(rv, BASE, H.person({ first: 'Ravel', last: 'Review' }), { expectStatus: 'review' });
  assert.match(await rv.textContent('[data-testid=outcome-title]'), /reviewing/);
  const ruid = await H.uidOf(rv);
  assert.equal(D.q('SELECT COUNT(*) c FROM docv_documents WHERE user_id=? AND data IS NOT NULL', ruid)[0].c, 3, 'documents kept while a human reviews');
  const admin = await H.newPage(browser, BASE);
  await H.logInUi(admin, BASE, ADMIN.email, ADMIN.password);
  await admin.waitForSelector('[data-testid=account-menu]');
  await admin.goto(`${BASE}/admin/kyc`);
  await admin.waitForSelector(`[data-testid=kyc-queue] tr[data-user="${ruid}"]`);
  const row = await admin.textContent(`[data-testid=kyc-queue] tr[data-user="${ruid}"]`);
  assert.match(row, /R\*\*\* R\*\*\*/, 'masked legal name'); assert.ok(!row.includes('Ravel'));
  await admin.click(`[data-testid=kyc-queue] tr[data-user="${ruid}"] [data-testid=kyc-open]`);
  await admin.waitForSelector('[data-testid=identity-detail]');
  await admin.click('[data-testid=reveal-legal_name]');
  await admin.fill('[data-testid=confirm-reason]', 'Customer called support to confirm spelling');
  await admin.click('[data-testid=confirm-ok]');
  await admin.waitForSelector('[data-testid=identity-legal_name]:has-text("Ravel Review")');
  await admin.click('[data-testid=view-document] >> nth=0');
  await admin.fill('[data-testid=confirm-reason]', 'Checking the ID photo during manual review');
  await admin.click('[data-testid=confirm-ok]');
  await admin.waitForSelector('[data-testid=document-image]');
  assert.match(await admin.getAttribute('[data-testid=document-image]', 'src'), /^data:image\/jpeg;base64,/);
  const audits = D.q("SELECT action, reason, before_json, after_json FROM admin_audit WHERE target_id=? AND action IN ('identity.unmask','kyc.document_view') ORDER BY chain_seq", ruid);
  assert.deepEqual(audits.map((a) => a.action), ['identity.unmask', 'kyc.document_view']);
  assert.ok(audits.every((a) => a.reason.length > 5 && !JSON.stringify(a).includes('Ravel')), 'audited with a reason, never the value');
  await admin.selectOption('[data-testid=kyc-decision]', 'approve');
  await admin.fill('[data-testid=kyc-note]', 'Documents match');
  await admin.click('[data-testid=kyc-submit]');
  const step = admin.locator('[data-testid=step-up-dialog]');
  if (await step.isVisible().catch(() => false)) { await admin.fill('[data-testid=step-up-password]', ADMIN.password); await admin.click('[data-testid=step-up-submit]'); }
  await H.until(() => D.q('SELECT status FROM identity_profiles WHERE user_id=?', ruid)[0].status === 'approved');
  assert.equal(D.q('SELECT COUNT(*) c FROM docv_documents WHERE user_id=? AND data IS NOT NULL', ruid)[0].c, 0, 'erased after the decision');
  // Reject.
  const rj = await freshUser('reject');
  await H.completeOnboarding(rj, BASE, H.person({ last: 'Reject' }), { expectStatus: 'rejected' });
  assert.match(await rj.textContent('[data-testid=outcome-message]'), /didn’t match official records/);
  // Retry at the data check: the user fixes the details and passes.
  const rt = await freshUser('retry');
  await H.completeOnboarding(rt, BASE, H.person({ last: 'Retry' }), { expectStatus: 'retry' });
  await rt.click('[data-testid=outcome-retry]');
  await rt.waitForSelector('[data-testid=onboarding][data-step=name]');
  assert.equal(await rt.inputValue('[data-testid=last-name]'), 'Retry', 'details prefilled for the retry');
  await rt.fill('[data-testid=last-name]', 'Sampleworth');
  await rt.click('[data-testid=ob-continue]');
  await rt.waitForSelector('[data-testid=onboarding][data-step=birthday]');
  await rt.click('[data-testid=ob-continue]');
  await rt.waitForSelector('[data-testid=onboarding][data-step=address]');
  await rt.fill('[data-testid=national-id]', `9${String(stamp).slice(-2)}-77-${String(stamp).slice(-4)}`);
  await rt.click('[data-testid=ob-continue]');
  await rt.waitForSelector('[data-testid=docv-intro]', { timeout: 20000 });
  await H.completeDocumentsOnDevice(rt);
  await rt.waitForSelector('[data-testid=ob-outcome][data-status=approved]', { timeout: 20000 });
  for (const p of [rv, admin, rj, rt]) { await H.assertClean(assert, p); await p.context().close(); }
});

test('"Not now" + resume banner; per-step persistence across reloads; validation: phone, wrong code, cooldown, underage, PO box, ID format, duplicate ID', async () => {
  const page = await freshUser('later');
  const me = H.person();
  await page.fill('[data-testid=phone-number]', '12');
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=ob-error]:has-text("valid")');
  await page.fill('[data-testid=phone-number]', me.phone);
  const t0 = Date.now() - 1000;
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=code]');
  const code = await H.smsCode(BASE, me.last4, t0);
  const wrong = String((Number(code) + 1) % 10000).padStart(4, '0');
  for (let i = 0; i < 4; i++) await page.locator('[data-testid=code-digit]').nth(i).type(wrong[i]);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=ob-error]:has-text("4 attempts left")');
  // Resend cooldown: refused before the timer runs out (429 sms_cooldown with retry_after).
  const uid = await H.uidOf(page);
  const early = await H.call(page, 'POST', `/v1/users/${uid}/verify_phone/send`, { country: 'US', number: me.phone });
  assert.equal(early.status, 429); assert.equal(early.body.error.code, 'sms_cooldown'); assert.ok(early.body.error.retry_after_sec >= 1);
  for (let i = 0; i < 4; i++) await page.locator('[data-testid=code-digit]').nth(i).type(code[i]);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=name]');
  await page.fill('[data-testid=first-name]', 'Laterine');
  await page.fill('[data-testid=last-name]', 'Sample');
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=birthday]');
  // Underage: refused by the server (not only the page).
  const kid = new Date(); const under = await H.call(page, 'PUT', `/v1/users/${uid}/sign_up/birthday`, { month: kid.getUTCMonth() + 1, day: kid.getUTCDate(), year: kid.getUTCFullYear() - 17 });
  assert.equal(under.status, 400); assert.equal(under.body.error.code, 'age_requirement');
  // "Not now": leave, banner on every page, reload keeps the progress, resume continues at the birthday step.
  await page.click('[data-testid=not-now]');
  await page.waitForSelector('[data-testid=identity-banner]:not([hidden])');
  await page.goto(BASE + '/browse');
  await page.waitForSelector('[data-testid=identity-banner]:not([hidden])');
  await page.reload();
  await page.click('[data-testid=identity-banner-cta]');
  await page.waitForSelector('[data-testid=onboarding][data-step=birthday]');
  for (const [s, v] of [['month', '04'], ['day', '12'], ['year', '1990']]) await page.fill(`[data-testid=dob-${s}]`, v);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=address]');
  await page.reload();
  await page.waitForSelector('[data-testid=onboarding][data-step=address]');
  // PO box and a bad ID format are refused; the ID value is never echoed back.
  await page.fill('[data-testid=addr-line1]', 'PO Box 4417');
  await page.fill('[data-testid=addr-city]', 'Sampleton');
  await page.selectOption('[data-testid=addr-region]', 'NY');
  await page.fill('[data-testid=addr-postal]', '10001');
  await page.fill('[data-testid=national-id]', '000-12-3456');
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=ob-error]:has-text("PO box")');
  assert.match(await page.textContent('[data-testid=ob-error]'), /not a valid SSN/);
  assert.ok(!(await page.textContent('[data-testid=ob-error]')).includes('000-12-3456'));
  // Duplicate national ID (same SSN as an approved account) → rejected as duplicate_account.
  const first = await new Client(BASE, 'dup1').signUp(email('dup1'), PW, 'Dup One');
  const dupPerson = H.person();
  assert.equal((await H.apiOnboard(BASE, first, dupPerson)).status, 'approved');
  await page.fill('[data-testid=addr-line1]', '12 Maple Test Avenue');
  await page.fill('[data-testid=national-id]', dupPerson.ssn);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=ob-outcome][data-status=rejected][data-reason=duplicate_account]', { timeout: 20000 });
  await H.assertClean(assert, page);
  await page.context().close();
});

test('SMS limits per number and per country; 390 px layout of every onboarding and phone step; restart keeps progress and finishes a queued job', async () => {
  // Per-number limit (admin setting, live): the 3rd code to one number within an hour is refused.
  const admin = await new Client(BASE, 'adm').logIn(ADMIN.email, ADMIN.password);
  let r = await admin.call('PUT', '/v1/admin/compliance/settings', { sms: { per_number_hour: 2 }, reason: 'test limits' });
  assert.equal(r.status, 200, r.text);
  const c = await new Client(BASE, 'limits').signUp(email('limits'), PW, 'Lim Its');
  const p = H.person();
  for (let i = 0; i < 2; i++) {
    r = await c.call('POST', `/v1/users/${c.uid}/verify_phone/send`, { country: 'US', number: p.phone });
    assert.equal(r.status, 201, r.text);
    D.run("UPDATE sms_send_log SET ts=ts-5000 WHERE user_id=? AND outcome='sent'", c.uid); // skip the 4 s cooldown
  }
  r = await c.call('POST', `/v1/users/${c.uid}/verify_phone/send`, { country: 'US', number: p.phone });
  assert.equal(r.status, 429); assert.equal(r.body.error.code, 'sms_rate_limited'); assert.equal(r.body.error.scope, 'number');
  // Per-country cap.
  r = await admin.call('PUT', '/v1/admin/compliance/settings', { sms: { per_number_hour: 50, country_limits: { GB: 0 } }, reason: 'test limits' });
  assert.equal(r.status, 200, r.text);
  r = await c.call('POST', `/v1/users/${c.uid}/verify_phone/send`, { country: 'GB', number: '07700 900123' });
  assert.equal(r.status, 429); assert.equal(r.body.error.scope, 'country');
  await admin.call('PUT', '/v1/admin/compliance/settings', { sms: { country_limits: {} }, reason: 'reset' });

  // 390 px: no horizontal scrolling on any step.
  const page = await freshUser('narrow', { width: 390, height: 844 });
  const noScroll = async (label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: no horizontal scroll`);
  await noScroll('phone');
  const q = H.person({ last: 'Review' });
  await page.fill('[data-testid=phone-number]', q.phone);
  const t0 = Date.now() - 1000;
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=code]');
  await noScroll('code');
  const code = await H.smsCode(BASE, q.last4, t0);
  for (let i = 0; i < 4; i++) await page.locator('[data-testid=code-digit]').nth(i).type(code[i]);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=name]');
  await noScroll('name');
  await page.fill('[data-testid=first-name]', q.first); await page.fill('[data-testid=last-name]', q.last);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=birthday]');
  await noScroll('birthday');
  for (const [s, v] of [['month', '04'], ['day', '12'], ['year', '1990']]) await page.fill(`[data-testid=dob-${s}]`, v);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=address]');
  await noScroll('address');
  await page.fill('[data-testid=addr-line1]', q.line1); await page.fill('[data-testid=addr-city]', q.city);
  await page.selectOption('[data-testid=addr-region]', q.region); await page.fill('[data-testid=addr-postal]', q.postal); await page.fill('[data-testid=national-id]', q.ssn);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=docv-intro]', { timeout: 20000 });
  await noScroll('documents intro');
  await page.click('[data-testid=docv-start]');
  await page.waitForSelector('[data-testid=docv-qr] svg');
  await noScroll('QR');
  await page.click('[data-testid=docv-same-device]');
  await page.waitForSelector('[data-testid=docv-device]');
  await noScroll('same device');
  for (const k of ['id_front', 'id_back', 'selfie']) {
    await page.setInputFiles(`[data-testid=device-capture-${k}]`, { name: `${k}.png`, mimeType: 'image/png', buffer: H.pngImage(300, 300, 17) });
    await page.waitForSelector(`[data-state="${k}"]:has-text("Added")`);
  }
  const uid = await H.uidOf(page);
  // Restart with the documents job queued: the worker finishes it after the restart.
  await srv.close();
  srv = await start({ ...OPTS, identity: { ...OPTS.identity, kyc: { delayMs: 60000, pollMs: 150 } } });
  await page.click('[data-testid=docv-device-submit]');
  await page.waitForSelector('[data-testid=ob-verifying]');
  assert.equal(D.q("SELECT COUNT(*) c FROM kyc_jobs WHERE user_id=? AND status='queued' AND stage='documents'", uid)[0].c, 1);
  await srv.close();
  D.run("UPDATE kyc_jobs SET run_after=? WHERE user_id=? AND status='queued'", Date.now(), uid);
  srv = await start(OPTS);
  await page.waitForSelector('[data-testid=ob-outcome][data-status=review]', { timeout: 20000 });
  await noScroll('outcome');
  assert.ok(D.q('SELECT name_enc FROM identity_profiles WHERE user_id=?', uid)[0].name_enc.startsWith('enc:v1:'));
  await H.assertClean(assert, page);
  await page.context().close();
});
