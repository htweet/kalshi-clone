'use strict';
// Content management: templates, media, pages and branding (CLONE_SPEC.md §32.5–§32.8). Real server + SQLite file +
// Chromium:
//   notification templates: edited in Admin › Content › Templates (preview with sample data, test send to the dev
//   mailbox), published, then used by a real deposit for the in-app row and toast, the email (dev mailbox, HTML
//   escaped) and push; the SMS template drives the phone code; undeclared variables and logic are refused; XSS in
//   templates is neutralised;
//   media: a JPEG with EXIF is re-encoded (metadata gone), a PNG's text chunk is dropped, a polyglot and an SVG are
//   refused, a slot (logo) swaps live on an open page and the app icon slot drives the manifest;
//   pages: created, scheduled, published (SEO title / description in the page and on a direct load), rolled back;
//   legal pages need a fresh step-up; page bodies and footer links are sanitised;
//   branding: a colour below 4.5:1 is refused, a valid one applies live in both themes, the app name and theme colour
//   change the manifest and the theme-color meta tags;
//   the admin pages fit a 390 px screen in light and dark themes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');
const H = require('./lib/identity-helpers');
const { encodeJpeg } = require('../server/cms/images');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-cms2-'));
const DB_FILE = path.join(TMP, 'cms2.db');
const PW = 'Quartz-Lantern-Meadow-7391';
const ADMIN = { email: 'root.cms2@example.test', password: 'Ledger-Keeper-Copper-2026!' };
const HIGH = { burst: 1e6, per_second: 1e6 };
const stamp = Date.now();
const D = H.db(DB_FILE);
let PORT; let BASE; let srv; let browser; let admin; let ada;
const ADA = { name: 'Ada Templates', email: `ada.${stamp}@example.test` };
const opts = (port) => ({ port, dbFile: DB_FILE, tickMs: 300, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, identity: { kycRequired: false }, auth: { stepUpMs: 60000 }, cms: { tickMs: 200 } });
const adminUid = () => D.q('SELECT id FROM users WHERE email=?', ADMIN.email)[0].id;
const draft = (type, key, value) => admin.call('PUT', `/v1/admin/cms/${type}/draft`, { key, value });
const publish = (type, key, extra = {}) => admin.call('POST', `/v1/admin/cms/${type}/publish`, { key, reason: 'cms content e2e', ...extra });
const b64 = (buf) => buf.toString('base64');
const upload = (buf, filename = 'x.png') => admin.call('POST', '/v1/admin/cms/media', { filename, data: b64(buf) });
// An RGB PNG (w×h) with a tEXt chunk that the re-encode must drop.
function png(w, h, rgb = [0, 135, 81]) {
  const crc = (b) => { let c = -1; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const on = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (w / 3) ** 2; raw[o] = on ? 255 : rgb[0]; raw[o + 1] = on ? 255 : rgb[1]; raw[o + 2] = on ? 255 : rgb[2]; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0PNGTEXTMARKER author=someone', 'latin1')), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A JPEG with an EXIF (APP1) segment carrying a GPS marker.
function jpegWithExif(w = 320, h = 200) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = (i % w) % 256; data[i * 4 + 1] = 120; data[i * 4 + 2] = 200; data[i * 4 + 3] = 255; }
  const jpg = encodeJpeg({ width: w, height: h, data }, 90);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('MM\0*\0\0\0\x08 GPSTESTMARKER 6.4550N 3.3941E camera-serial-TEST', 'latin1')]);
  const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, payload, jpg.subarray(2)]);
}
async function adminPage(p = '/admin/cms') {
  const page = await H.newPage(browser, BASE);
  await H.logInUi(page, BASE, ADMIN.email, ADMIN.password);
  await page.waitForSelector('[data-testid=account-menu]');
  await page.goto(BASE + p);
  return page;
}
const cssVar = (page, name, theme) => page.evaluate(([n, t]) => { document.documentElement.dataset.theme = t; return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }, [name, theme]);

before(async () => {
  PORT = await H.freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  srv = await start(opts(PORT));
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  ada = new Client(BASE, 'ada');
  await ada.signUp(ADA.email, PW, ADA.name);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('templates: edit, preview, test send, publish; a deposit uses the in-app, email and push templates; SMS template; validation and XSS', async () => {
  const ap = await adminPage('/admin/cms/templates');
  await ap.click('[data-testid=cms-template-row][data-tpl="notify.transfer"]');
  await ap.waitForSelector('[data-testid=cms-template-editor]');
  await ap.fill('[data-testid=cms-tpl-inapp_title]', 'In-app · {{title}}');
  await ap.fill('[data-testid=cms-tpl-push_title]', 'Push · {{title}}');
  await ap.fill('[data-testid=cms-tpl-push_body]', '{{body}} (push)');
  await ap.fill('[data-testid=cms-tpl-email_subject]', 'Money moved: {{title}}');
  await ap.fill('[data-testid=cms-tpl-email_text]', 'Hello from {{app_name}}. {{body}}{{open_line}}');
  await ap.fill('[data-testid=cms-tpl-email_html]', '<p>Hello from <b>{{app_name}}</b>. {{body}}</p><p><a href="{{link}}">Open</a></p><script>alert(1)</script>');
  // Preview with the sample data.
  await ap.click('[data-testid=cms-tpl-preview]');
  await ap.waitForSelector('[data-testid=cms-tpl-preview-text]');
  assert.match(await ap.textContent('[data-testid=cms-tpl-preview-out]'), /Money moved: Order filled: 10 YES @ ₦64/);
  assert.match(await ap.textContent('[data-testid=cms-tpl-preview-inapp_title]'), /^In-app · Order filled/);
  // Test send to the dev mailbox (the admin's own address).
  await ap.click('[data-testid=cms-tpl-test-send]');
  const test1 = await H.mailTo(BASE, ADMIN.email, /^\[Test\] Money moved: /);
  assert.match(test1.body, /^Hello from Parlance\. Will the Harbor Bridge/);
  assert.ok(test1.html && !/<script/i.test(test1.html) && /<b>Parlance<\/b>/.test(test1.html), 'test email HTML sanitised');
  // Publish (the draft saved first).
  await ap.click('[data-testid=cms-publish]');
  await ap.fill('[data-testid=confirm-reason]', 'Friendlier transfer messages');
  await ap.click('[data-testid=confirm-ok]');
  await H.until(() => D.q("SELECT 1 FROM cms_entries WHERE type='template' AND key='notify.transfer' AND published_json IS NOT NULL")[0]);
  const stored = JSON.parse(D.q("SELECT published_json j FROM cms_entries WHERE key='notify.transfer'")[0].j);
  assert.ok(!/script/.test(stored.email_html), 'stored HTML sanitised');

  // A real deposit: in-app row + live toast, email in the dev mailbox, push to a registered browser.
  const page = await H.newPage(browser, BASE);
  await H.logInUi(page, BASE, ADA.email, PW);
  await page.waitForSelector('[data-testid=account-menu]');
  await ada.logIn(ADA.email, PW);
  assert.equal((await ada.call('POST', `/v1/users/${ada.uid}/notifications/push_devices`, { label: 'Test browser' })).status, 201);
  const sock = ada.socket(); await sock.opened; await sock.subscribe(['notifications']);
  const dep = await ada.call('POST', `/v1/users/${ada.uid}/deposits`, { amount_dollars: '25.00' }, { 'Idempotency-Key': `dep-${stamp}` });
  assert.equal(dep.status, 201, dep.text);
  await page.waitForSelector('.toast:has-text("In-app · Deposit of ₦2,500 completed")');
  const row = D.q("SELECT title, body FROM notifications WHERE user_id=? AND type='transfer' ORDER BY created_ts DESC LIMIT 1", ada.uid)[0];
  assert.equal(row.title, 'In-app · Deposit of ₦2,500 completed');
  const push = await sock.waitFor((m) => m.type === 'push' && /Deposit/.test(m.msg.title));
  assert.equal(push.msg.title, 'Push · Deposit of ₦2,500 completed'); assert.match(push.msg.body, /\(push\)$/);
  const mail = await H.mailTo(BASE, ADA.email, /^Money moved: Deposit of ₦2,500 completed$/);
  assert.match(mail.body, /^Hello from Parlance\. Cash balance ₦2,500\n\nOpen: \/portfolio/);
  assert.match(mail.html, /<b>Parlance<\/b>/); assert.match(mail.html, /href="[^"]*\/portfolio"/);
  await page.goto(`${BASE}/dev/mailbox`);
  await page.waitForSelector('text=Money moved: Deposit of ₦2,500 completed');
  sock.close();

  // The SMS template drives the phone verification code.
  assert.equal((await draft('template', 'sms.phone_code', { sms: '{{app_name}} code: {{code}} (valid {{minutes}} min)' })).status, 200);
  assert.equal((await publish('template', 'sms.phone_code')).status, 200);
  const phone = H.person().phone;
  assert.equal((await ada.call('POST', `/v1/users/${ada.uid}/verify_phone/send`, { country: 'US', number: phone })).status, 201);
  const sms = await H.until(async () => (await (await fetch(`${BASE}/v1/dev/sms`)).json()).messages.find((m) => /code: \d{4} \(valid \d+ min\)/.test(m.body)));
  assert.match(sms.body, /^Parlance code: \d{4} \(valid 10 min\)$/);

  // Logic-free with declared variables only; markup in plain fields refused; HTML variables escaped.
  for (const v of [{ inapp_title: '{{#if body}}x{{/if}}' }, { inapp_title: '{{{title}}}' }, { inapp_title: '{{ user.email }}' }, { push_body: 'Hi {{password}}' }, { inapp_body: '<img src=x onerror=alert(1)>' }]) {
    const r = await draft('template', 'notify.settlement', v);
    assert.equal(r.status, 400, JSON.stringify(v));
  }
  assert.equal((await draft('template', 'notify.settlement', { push_body: 'Hi {{password}}' })).code, 'undeclared_variable');
  const prev = await admin.call('POST', '/v1/admin/cms/templates/preview', { key: 'notify.transfer', vars: { body: '<img src=x onerror=alert(1)>', link: `java${''}script:alert(1)` } });
  assert.equal(prev.status, 200);
  assert.ok(!/<img/.test(prev.body.preview.email.html) && /&lt;img/.test(prev.body.preview.email.html), 'variables are HTML-escaped in email HTML');
  assert.ok(!/javascript:/.test(prev.body.preview.email.html), 'unsafe link variables become #');
  await H.assertClean(assert, ap); await H.assertClean(assert, page);
  await Promise.all([ap, page].map((p) => p.context().close()));
});

test('media: re-encoded uploads (EXIF and text chunks gone), polyglots and SVG refused, a slot swaps live, the app icon drives the manifest', async () => {
  // JPEG with EXIF: stored re-encoded without the metadata.
  const j = await upload(jpegWithExif(), 'photo.jpg');
  assert.equal(j.status, 201, j.text);
  assert.equal(j.body.asset.mime, 'image/jpeg');
  const jBytes = Buffer.from(await (await fetch(BASE + j.body.asset.url)).arrayBuffer());
  assert.equal(jBytes[0], 0xff); assert.ok(!jBytes.includes(Buffer.from('GPSTESTMARKER')), 'EXIF gone');
  assert.ok(!jBytes.includes(Buffer.from('Exif\0\0', 'latin1')), 'no APP1 Exif segment');
  // PNG: the tEXt chunk is dropped.
  const icon = await upload(png(512, 512), 'icon.png');
  assert.equal(icon.status, 201);
  const pBytes = Buffer.from(await (await fetch(BASE + icon.body.asset.url)).arrayBuffer());
  assert.ok(!pBytes.includes(Buffer.from('PNGTEXTMARKER')) && !pBytes.includes(Buffer.from('tEXt')), 'text chunk gone');
  assert.ok(icon.body.asset.variants.some((v) => v.variant === 'icon-192') && icon.body.asset.variants.some((v) => v.variant === 'icon-maskable-512'), 'icon sizes generated');
  const res = await fetch(BASE + icon.body.asset.url);
  assert.equal(res.headers.get('content-type'), 'image/png'); assert.match(res.headers.get('content-security-policy'), /sandbox/); assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  // Refused: polyglots (markup or data after the image end), SVG, other formats, oversize.
  const refuse = async (buf, re) => { const r = await upload(buf); assert.equal(r.status, 400, r.text); assert.equal(r.code, 'invalid_image'); assert.match(r.body.error.message, re); };
  await refuse(Buffer.concat([png(64, 64), Buffer.from('<script>alert(1)</script>')]), /polyglot/);
  await refuse(Buffer.concat([jpegWithExif(), Buffer.from('<html><body>hi</body></html>')]), /polyglot/);
  await refuse(Buffer.concat([jpegWithExif(), Buffer.from('TRAILINGPAYLOAD')]), /extra data after the image/);
  await refuse(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>'), /SVG/);
  await refuse(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), /GIF/);
  await refuse(png(8, 8), /at least 16/);
  // The logo slot needs no square; the app-icon slot does.
  const wide = await upload(png(320, 96, [11, 114, 133]), 'logo.png');
  assert.equal((await draft('media', 'pwa_icon', { asset_id: wide.body.asset.id })).status, 400, 'square required');

  // Admin UI: upload through the file input, then assign the logo slot and publish; an open page swaps live.
  const visitor = await H.newPage(browser, BASE);
  assert.equal(await visitor.locator('[data-testid=brand-logo-img]').count(), 0);
  const ap = await adminPage('/admin/cms/media');
  const file = path.join(TMP, 'logo-ui.png'); fs.writeFileSync(file, png(128, 128, [200, 30, 30]));
  await ap.setInputFiles('[data-testid=cms-upload-file]', file);
  await ap.waitForSelector('[data-testid=cms-assets] figcaption:has-text("logo-ui.png")');
  const assetId = await ap.getAttribute('[data-testid=cms-assets] figure:has(figcaption:has-text("logo-ui.png"))', 'data-asset');
  await ap.selectOption('tr[data-slot=logo] [data-slot-asset]', assetId);
  await ap.click('[data-testid=cms-slot-publish-logo]');
  await ap.fill('[data-testid=confirm-reason]', 'New logo');
  await ap.click('[data-testid=confirm-ok]');
  await visitor.waitForSelector(`[data-testid=brand-logo-img][src="/media/${assetId}.png"]`);
  // Swap the logo again: the open page follows; the old version stays for rollback.
  assert.equal((await draft('media', 'logo', { asset_id: wide.body.asset.id, alt: 'Parlance' })).status, 200);
  assert.equal((await publish('media', 'logo')).status, 200);
  await visitor.waitForSelector(`[data-testid=brand-logo-img][src="/media/${wide.body.asset.id}.png"]`);
  assert.equal((await admin.call('POST', '/v1/admin/cms/media/rollback', { key: 'logo', version: 1, reason: 'back to the first logo' })).status, 200);
  await visitor.waitForSelector(`[data-testid=brand-logo-img][src="/media/${assetId}.png"]`);

  // A view slot: the perps promo art on the home page swaps in live.
  await visitor.goto(BASE + '/');
  await visitor.waitForSelector('[data-testid=perps-promo] .art');
  assert.equal((await draft('media', 'promo.perps', { asset_id: wide.body.asset.id, alt: 'Perps' })).status, 200);
  assert.equal((await publish('media', 'promo.perps')).status, 200);
  await visitor.waitForSelector(`[data-testid=perps-promo] img[data-slot="promo.perps"][src="/media/${wide.body.asset.id}.png"]`);

  // The app-icon slot drives the manifest, the apple-touch icon and the favicon.
  assert.equal((await draft('media', 'pwa_icon', { asset_id: icon.body.asset.id })).status, 200);
  assert.equal((await publish('media', 'pwa_icon')).status, 200);
  const man = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  assert.ok(man.icons.every((i) => i.src.startsWith(`/media/${icon.body.asset.id}_`)), JSON.stringify(man.icons));
  assert.deepEqual(man.icons.map((i) => i.sizes), ['192x192', '512x512', '512x512']);
  const html = await (await fetch(`${BASE}/`)).text();
  assert.match(html, new RegExp(`<link rel="apple-touch-icon" href="/media/${icon.body.asset.id}_apple_touch_icon.png">`));
  assert.match(html, new RegExp(`<link rel="icon" href="/media/${icon.body.asset.id}_favicon_48.png"`));
  await H.assertClean(assert, visitor); await H.assertClean(assert, ap);
  await Promise.all([visitor, ap].map((p) => p.context().close()));
});

test('pages: create, schedule, publish with SEO fields, roll back; legal pages need step-up; bodies and footer links sanitised', async () => {
  const ap = await adminPage('/admin/cms/pages');
  // A new info page from the UI.
  await ap.click('[data-testid=cms-new-page]');
  await ap.fill('[data-testid=cms-page-slug]', 'support/contact');
  await ap.fill('[data-testid=cms-page-title]', 'Contact support');
  await ap.fill('[data-testid=cms-page-seo-title]', 'Contact Parlance support');
  await ap.fill('[data-testid=cms-page-seo-description]', 'How to reach the Parlance support team.');
  await ap.fill('[data-testid=cms-page-body]', '<h2>Write to us</h2><p>Email <a href="mailto:help@parlance.example">help@parlance.example</a>.</p><script>window.__x=1</script><p onclick="window.__x=2">Hours: <b>9-5</b></p><a href="javascript:window.__x=3">x</a><iframe src="https://evil.example"></iframe>');
  await ap.click('[data-testid=cms-save-draft]');
  await H.until(() => D.q("SELECT 1 FROM cms_entries WHERE type='page' AND key='support/contact' AND draft_json IS NOT NULL")[0]);
  // Drafts are not public; scheduled 1.5 s ahead, it goes live by itself.
  assert.equal((await fetch(`${BASE}/v1/pages/support/contact`)).status, 404);
  assert.equal((await publish('page', 'support/contact', { at: new Date(Date.now() + 1500).toISOString() })).status, 200);
  await H.until(async () => (await fetch(`${BASE}/v1/pages/support/contact`)).status === 200, 6000);
  const visitor = await H.newPage(browser, BASE, { path: '/support/contact' });
  await visitor.waitForSelector('[data-testid=cms-page] h1:has-text("Contact support")');
  assert.equal(await visitor.title(), 'Contact Parlance support');
  assert.equal(await visitor.getAttribute('meta[name=description]', 'content'), 'How to reach the Parlance support team.');
  const body = await visitor.innerHTML('[data-testid=cms-page-body]');
  assert.ok(!/<script|onclick|javascript:|<iframe/i.test(body), body);
  assert.match(body, /<a href="mailto:help@parlance.example">/); assert.match(body, /<b>9-5<\/b>/);
  assert.equal(await visitor.evaluate(() => window.__x), undefined);
  const direct = await (await fetch(`${BASE}/support/contact`)).text(); // server-rendered SEO fields on a direct load
  assert.match(direct, /<title>Contact Parlance support<\/title>/); assert.match(direct, /<meta name="description" content="How to reach the Parlance support team.">/);
  // A second version, then roll back to the first.
  assert.equal((await draft('page', 'support/contact', { title: 'Contact us', section: 'info', body: '<p>New text</p>' })).status, 200);
  assert.equal((await publish('page', 'support/contact')).status, 200);
  await visitor.reload(); await visitor.waitForSelector('[data-testid=cms-page] h1:has-text("Contact us")');
  assert.equal((await admin.call('POST', '/v1/admin/cms/page/rollback', { key: 'support/contact', version: 1, reason: 'restore the first version' })).status, 200);
  await visitor.reload(); await visitor.waitForSelector('[data-testid=cms-page] h1:has-text("Contact support")');

  // Legal page: a stale session is asked to confirm (API: 403 step_up_required; UI: the step-up dialog).
  D.run('UPDATE sessions SET auth_at=0 WHERE user_id=?', adminUid());
  assert.equal((await draft('page', 'legal/terms', { title: 'Terms of service', section: 'legal', body: '<h2>Updated terms</h2><p>Version 2.</p>' })).status, 200);
  const stale = await publish('page', 'legal/terms');
  assert.equal(stale.status, 403); assert.equal(stale.code, 'step_up_required');
  await ap.goto(`${BASE}/admin/cms/pages`);
  await ap.click('[data-testid=cms-page-row][data-page="legal/terms"]');
  await ap.waitForSelector('[data-testid=cms-page-editor]');
  await ap.click('[data-testid=cms-publish]');
  await ap.fill('[data-testid=confirm-reason]', 'Terms version 2');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-testid=step-up-dialog]');
  await ap.fill('[data-testid=step-up-password]', ADMIN.password);
  await ap.click('[data-testid=step-up-submit]');
  await H.until(async () => /Updated terms/.test(await (await fetch(`${BASE}/v1/pages/legal/terms`)).text()));
  assert.ok(D.q("SELECT 1 FROM admin_audit WHERE action='cms.publish' AND target_id='legal/terms@en-NG' AND reason='Terms version 2'")[0]);

  // Help articles (merged with the help CMS) and the incentive terms are CMS pages too.
  assert.equal((await draft('page', 'help/getting-started', { title: 'Getting started', section: 'help', body: '<p>Open an account, then <b>deposit</b>.</p>' })).status, 200);
  assert.equal((await publish('page', 'help/getting-started')).status, 200);
  assert.ok((await (await fetch(`${BASE}/v1/help`)).json()).pages.some((x) => x.slug === 'getting-started'));
  await visitor.goto(`${BASE}/help/getting-started`);
  await visitor.waitForSelector('[data-testid=help-body] b:has-text("deposit")');
  const v0 = (await (await fetch(`${BASE}/v1/incentive_programs/terms`)).json()).version;
  assert.equal((await draft('page', 'incentives/terms', { title: 'Liquidity Incentive Program terms', section: 'legal', body: '<h2>Program terms</h2><p>Rewards accrue on resting orders.</p>' })).status, 200);
  assert.equal((await publish('page', 'incentives/terms')).code, 'step_up_required', 'also a legal page');
  assert.equal((await admin.call('POST', '/v1/step_up', { password: ADMIN.password })).status, 200);
  assert.equal((await publish('page', 'incentives/terms')).status, 200);
  const terms = await (await fetch(`${BASE}/v1/incentive_programs/terms`)).json();
  assert.notEqual(terms.version, v0, 'a published terms page is a new terms version');
  await visitor.goto(`${BASE}/incentives/terms`);
  await visitor.waitForSelector('[data-testid=lip-terms-cms] h2:has-text("Program terms")');

  // Footer: links must be site paths or https; the published footer reaches open pages live.
  const badFooter = await draft('footer', 'links', { tagline: 'Hi', columns: [{ title: 'X', links: [{ label: 'Bad', href: `java${''}script:alert(1)` }] }] });
  assert.equal(badFooter.status, 400);
  assert.equal((await draft('footer', 'links', { tagline: 'Parlance · sandbox exchange', columns: [{ title: 'Legal', links: [{ label: 'Terms', href: '/legal/terms' }, { label: 'Status', href: 'https://status.parlance.example' }] }] })).status, 200);
  assert.equal((await publish('footer', 'links')).status, 200);
  await visitor.waitForSelector('[data-testid=footer-tagline]:has-text("Parlance · sandbox exchange")');
  assert.equal(await visitor.getAttribute('[data-testid=footer-cols] a:has-text("Status")', 'rel'), 'noopener noreferrer');
  await visitor.click('[data-testid=footer-cols] a:has-text("Terms")');
  await visitor.waitForSelector('[data-testid=cms-page] h2:has-text("Updated terms")');
  await H.assertClean(assert, visitor); await H.assertClean(assert, ap);
  await Promise.all([visitor, ap].map((p) => p.context().close()));
});

test('branding: low contrast refused; a valid colour applies live in both themes; app name and theme colour drive the manifest and meta tags', async () => {
  const visitor = await H.newPage(browser, BASE);
  assert.equal(await cssVar(visitor, '--brand', 'light'), '#008751');
  // Below 4.5:1 on the light surface is refused, from the UI too.
  const low = await draft('brand', 'theme', { light: { brand: '#7fd6a8', yes: '#0b7285' }, dark: { brand: '#13a866', yes: '#22c3b5' } });
  assert.equal(low.status, 400); assert.equal(low.code, 'contrast_too_low'); assert.match(low.body.error.fields['light.brand'], /below 4\.5:1/);
  const ap = await adminPage('/admin/cms/branding');
  await ap.fill('[data-testid=cms-brand-dark-yes]', '#1a1d22');
  await ap.click('[data-testid=cms-brand-save]');
  await ap.waitForSelector('[data-err-for="dark.yes"]:has-text("below 4.5:1")');
  // Valid colours and names, published from the UI.
  await ap.fill('[data-testid=cms-brand-light-brand]', '#0a6b45');
  await ap.fill('[data-testid=cms-brand-dark-brand]', '#3ddc97');
  await ap.fill('[data-testid=cms-brand-dark-yes]', '#22c3b5');
  await ap.fill('[data-testid=cms-brand-app-name]', 'Lagos Markets');
  await ap.fill('[data-testid=cms-brand-short-name]', 'LagosMkt');
  await ap.click('[data-testid=cms-brand-publish]');
  await ap.fill('[data-testid=confirm-reason]', 'Brand refresh');
  await ap.click('[data-testid=confirm-ok]');
  // Live on the open page, in both themes (CSS custom properties from /content-theme.css, no inline styles).
  await H.until(async () => (await cssVar(visitor, '--brand', 'light')) === '#0a6b45');
  assert.equal(await cssVar(visitor, '--brand', 'dark'), '#3ddc97');
  const man = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  assert.deepEqual([man.name, man.short_name, man.theme_color], ['Lagos Markets', 'LagosMkt', '#0a6b45']);
  const html = await (await fetch(`${BASE}/`)).text();
  assert.match(html, /<meta name="theme-color" content="#0a6b45" media="\(prefers-color-scheme: light\)">/);
  assert.match(html, /<meta name="theme-color" content="#3ddc97" media="\(prefers-color-scheme: dark\)">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="LagosMkt">/);
  // Survives a restart.
  await srv.close(); srv = await start(opts(PORT));
  await visitor.reload();
  assert.equal(await cssVar(visitor, '--brand', 'light'), '#0a6b45');
  await H.assertClean(assert, visitor); await H.assertClean(assert, ap);
  await Promise.all([visitor, ap].map((p) => p.context().close()));
});

test('admin content pages fit 390 px in light and dark themes', async () => {
  const page = await H.newPage(browser, BASE, { viewport: { width: 390, height: 844 } });
  await H.logInUi(page, BASE, ADMIN.email, ADMIN.password);
  await page.waitForSelector('[data-testid=account-menu]');
  for (const theme of ['light', 'dark']) {
    for (const p of ['/admin/cms', '/admin/cms/texts', '/admin/cms/templates', '/admin/cms/media', '/admin/cms/pages', '/admin/cms/branding', '/admin/cms/transfer', '/legal/terms', '/support/help-center']) {
      await page.goto(BASE + p);
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.waitForSelector(p.startsWith('/admin') ? '[data-testid^=cms-]' : '[data-testid=cms-page]');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(over <= 0, `${p} (${theme}) overflows by ${over}px`);
    }
  }
  await H.assertClean(assert, page);
  await page.context().close();
});
