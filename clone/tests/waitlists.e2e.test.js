'use strict';
// End-to-end browser tests for Phase 7A (CLONE_SPEC.md §36), against a real server, a real SQLite file and Chromium:
//   • the Perps waitlist on by default for a new database, the one-time audited migration of an existing one (never again
//     after an admin turns it off) and the Phase 6 table moved onto the waitlist module;
//   • the real-money launch waitlist: a signed-in one-click join from the play-mode banner with the survey (all four
//     question types, NGN bands), a guest double opt-in at 390 px (link from the email outbox, single use, expiry,
//     encrypted email with a keyed hash), unsubscribe (email link, RFC 8058 one-click POST, delete my data), a guest
//     linked to the account they later open, the account export and closure;
//   • the call to action on the banner, Funds and Home and the flags hiding it and blocking the API (unsubscribe keeps
//     working), the public progress bar toggled from Admin › Waitlists;
//   • Admin › Waitlists: the target (reason, audit) and the one-time target-reached alert (in-app and email) and its note
//     on Admin › Play mode, the consent CSV behind step-up, the newsletter (CMS template preview, test send, send now
//     and scheduled through the throttled outbox, resuming after a restart, unconfirmed and unsubscribed skipped);
//   • the two-person production switch keeping members, consents and survey answers, locking the survey and offering
//     (never sending) the "We're live with real money" email;
//   • the guest form: rate limit, honeypot, client token, login CSRF and no account enumeration; restart persistence.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-waitlists-'));
const DB_FILE = path.join(TMP, 'waitlists.db');
const PW = 'Kestrel-Orchard-Lumen-5182';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const ADMIN2 = { email: `second.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const L = '/v1/waitlists/real_money_launch';
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
let offset = 0; // the newsletter job clock (start option `waitlists.now`, ignored in production)
const base = (port, dbFile, extra = {}) => ({ port, dbFile, tickMs: 250, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH },
  waitlists: { now: () => Date.now() + offset, newsletterPerMinute: 60, guestJoinsPerIp: 1000, tokenAttemptsPerIp: 1000 }, ...extra });
let OPTS; let BASE;
const email = (n) => `${n}.${stamp}@example.test`;

let srv; let browser; let admin;
const allPages = [];
const dbq = (file, sql, ...a) => { const d = new DatabaseSync(file); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (file, sql, ...a) => { const d = new DatabaseSync(file); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const qa = (sql, ...a) => dbq(DB_FILE, sql, ...a);
const q1 = (sql, ...a) => qa(sql, ...a)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, { timeout = 15000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { return await fn(); } catch (e) { if (Date.now() > end) throw e; } await sleep(interval); }
}
async function newPage(viewport = { width: 1400, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  allPages.push(page);
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
const stepUp = (c) => async (method, p, body) => {
  let r = await c.call(method, p, body);
  if (r.code === 'step_up_required') { assert.equal((await c.call('POST', '/v1/step_up', { password: PW })).status, 200); r = await c.call(method, p, body); }
  return r;
};
const adminCall = (...a) => stepUp(admin)(...a);
const setFlag = async (key, enabled, reason = 'waitlists e2e') => { const r = await adminCall('PUT', `/v1/admin/flags/${key}`, { enabled, reason }); assert.equal(r.status, 200, r.text); };
const lastMail = (to, like = '%') => q1('SELECT * FROM email_outbox WHERE to_email=? AND subject LIKE ? ORDER BY created_at DESC, rowid DESC LIMIT 1', to, like);
const linkIn = (body, p) => { const m = new RegExp(`https?://[^\\s]+${p.replace(/[/?]/g, (c) => `\\${c}`)}[^\\s]*`).exec(body); assert.ok(m, `no ${p} link in: ${body}`); return m[0]; };
const tokenOf = (url) => new URL(url).searchParams.get('token');
const consentVersion = async (c) => (await c.call('GET', L)).body.consent.version;
async function guestJoin(addr, extra = {}) {
  const g = await new Client(BASE, 'guest').boot();
  const r = await g.call('POST', `${L}/guest_join`, { email: addr, consent: true, consent_version: await consentVersion(g), ...extra });
  assert.equal(r.status, 202, r.text);
  return g;
}
async function guestConfirmed(addr) {
  const g = await guestJoin(addr);
  const link = await eventually(() => linkIn(lastMail(addr, 'Confirm%').body, '/waitlist/confirm?token='));
  const r = await g.call('POST', '/v1/waitlists/confirm', { token: tokenOf(link) });
  assert.equal(r.status, 200, r.text);
  return r.body.manage_token;
}
const entryOf = (addrOrUid) => q1("SELECT * FROM waitlist_entries WHERE list_key='real_money_launch' AND (user_id=? OR user_id=(SELECT id FROM users WHERE email=?))", addrOrUid, addrOrUid);
// Verifies an account's email through the real flow: the link of the "Confirm your email" message, then POST /verify_email.
async function verifyEmail(addr) {
  const link = await eventually(() => linkIn(lastMail(addr, 'Confirm your email%').body, '/verify-email?token='));
  const r = await (await new Client(BASE, 'verify').boot()).call('POST', '/v1/verify_email', { token: tokenOf(link) });
  assert.equal(r.status, 200, r.text);
}
const confirmedCount = () => q1("SELECT COUNT(*) c FROM waitlist_entries WHERE list_key='real_money_launch' AND status='confirmed'").c;
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  OPTS = base(port, DB_FILE);
  srv = await start(OPTS);
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  // The launch waitlist gauges demand while the exchange runs on play money.
  assert.equal((await adminCall('PUT', '/v1/admin/play_mode', { on: true, reason: 'play money launch' })).status, 200);
});
after(async () => {
  // Close everything before asserting anything, so a failure can never leave a server or browser running.
  try { await browser?.close(); } catch { /* ignore */ }
  try { await srv?.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Perps waitlist: on by default for a new database; an existing database is switched on once by an audited migration (never again after an admin turns it off); the Phase 6 table moves onto the waitlist module', async () => {
  // This suite's database is new: the flag starts on, the marker records "new database", no history row.
  assert.equal(q1("SELECT enabled FROM feature_flags WHERE key='perps.waitlist'").enabled, 1);
  assert.equal(JSON.parse(q1("SELECT value FROM meta WHERE key='flag_migration:perps_waitlist_on_2026_11_08'").value).result, 'new_database');
  assert.equal(q1("SELECT COUNT(*) c FROM feature_flag_history WHERE flag_key='perps.waitlist'").c, 0);
  const nia = await new Client(BASE, 'nia').signUp(email('nia'), PW, 'Nia Perps');
  assert.equal((await nia.call('POST', `/v1/users/${nia.uid}/deposits`, { amount_dollars: 100 })).status, 201);
  const gated = await nia.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 10 });
  assert.equal(gated.status, 403); assert.equal(gated.code, 'perps_waitlist');
  assert.equal((await nia.call('POST', '/v1/perps/waitlist', {})).body.waitlist.position, 1);
  assert.equal(q1("SELECT status FROM waitlist_entries WHERE list_key='perps' AND user_id=?", nia.uid).status, 'waiting');
  assert.equal(q1('SELECT status FROM perp_waitlist WHERE user_id=?', nia.uid).status, 'waiting', 'the Phase 6 name still reads the same rows (a view)');
  assert.equal(q1("SELECT type FROM sqlite_master WHERE name='perp_waitlist'").type, 'view');

  // An existing database from before Phase 7A: the flag off, no marker, the Phase 6 perp_waitlist table with a row.
  const file = path.join(TMP, 'legacy.db');
  const port = await freePort();
  const s1 = await start(base(port, file));
  const legacy = await new Client(`http://127.0.0.1:${port}`, 'legacy').signUp(email('legacy'), PW, 'Lee Legacy');
  await s1.close();
  dbrun(file, "UPDATE feature_flags SET enabled=0 WHERE key='perps.waitlist'");
  dbrun(file, "DELETE FROM meta WHERE key LIKE 'flag_migration:%'");
  dbrun(file, 'DROP VIEW perp_waitlist');
  dbrun(file, 'CREATE TABLE perp_waitlist (user_id TEXT PRIMARY KEY, status TEXT NOT NULL, joined_ts INTEGER NOT NULL, decided_ts INTEGER, decided_by TEXT, note TEXT)');
  dbrun(file, "DELETE FROM waitlist_entries WHERE list_key='perps'");
  dbrun(file, "INSERT INTO perp_waitlist(user_id,status,joined_ts,decided_ts,note) VALUES(?, 'approved', 1700000000000, 1700000001000, 'grandfathered')", legacy.uid);
  let s2 = await start(base(port, file));
  try {
    const d = (sql, ...a) => dbq(file, sql, ...a);
    assert.equal(d("SELECT enabled FROM feature_flags WHERE key='perps.waitlist'")[0].enabled, 1, 'switched on by the migration');
    assert.deepEqual(d("SELECT action, reason, actor_id FROM feature_flag_history WHERE flag_key='perps.waitlist'").map((x) => [x.action, x.reason, x.actor_id]), [['migration', 'owner decision 2026-11-08', null]]);
    assert.equal(d("SELECT reason FROM admin_audit WHERE action='flags.migration' AND target_id='perps.waitlist'")[0].reason, 'owner decision 2026-11-08');
    assert.equal(JSON.parse(d("SELECT value FROM meta WHERE key='flag_migration:perps_waitlist_on_2026_11_08'")[0].value).result, 'applied');
    assert.deepEqual(d("SELECT status, joined_ts, note FROM waitlist_entries WHERE list_key='perps' AND user_id=?", legacy.uid).map((x) => [x.status, x.joined_ts, x.note]), [['approved', 1700000000000, 'grandfathered']]);
    assert.equal(d("SELECT type FROM sqlite_master WHERE name='perp_waitlist'")[0].type, 'view');
    // An admin turns it off; a restart never switches it on again (idempotent, one time only).
    const a2 = await new Client(`http://127.0.0.1:${port}`, 'a').logIn(ADMIN.email, PW);
    assert.equal((await stepUp(a2)('PUT', '/v1/admin/flags/perps.waitlist', { enabled: false, reason: 'open Perps to all' })).status, 200);
    await s2.close();
    s2 = await start(base(port, file));
    assert.equal(d("SELECT enabled FROM feature_flags WHERE key='perps.waitlist'")[0].enabled, 0);
    assert.equal(d("SELECT COUNT(*) c FROM feature_flag_history WHERE flag_key='perps.waitlist' AND action='migration'")[0].c, 1);
  } finally { await s2.close(); }
});

let ada;
test('signed-in join with one click from the play-mode banner: consent recorded, welcome email with one-click unsubscribe, survey with all four question types (NGN bands), edited and persisted', async () => {
  const page = await newPage();
  await uiSignUp(page, email('ada'), 'Ada Obi');
  await verifyEmail(email('ada')); // one click needs a verified account email (an unverified one gets a confirmation link)
  ada = { uid: q1('SELECT id FROM users WHERE email=?', email('ada')).id };
  await page.waitForSelector('[data-testid=play-banner] [data-testid=waitlist-cta-banner]');
  await page.click('[data-testid=waitlist-cta-banner]');
  await page.waitForSelector('[data-testid=waitlist-join-one-click]');
  assert.match(page.url(), /\/waitlist\?src=banner$/);
  assert.match(await page.textContent('[data-testid=waitlist-consent-text]'), /one-click unsubscribe/);
  await page.click('[data-testid=waitlist-join-one-click]');
  await page.waitForSelector('[data-testid=waitlist-status][data-status=confirmed]');
  const e = entryOf(ada.uid);
  assert.equal(e.status, 'confirmed'); assert.equal(e.source, 'banner'); assert.equal(e.consent_source, 'signed_in');
  assert.match(e.consent_version, /^cms0-[0-9a-f]{12}$/); assert.match(e.consent_text_sha256, /^[0-9a-f]{64}$/); assert.match(e.consent_ip_hash, /^[0-9a-f]{32}$/);
  assert.notEqual(e.consent_ip_hash, '127.0.0.1');
  assert.ok(e.consent_ts && e.confirmed_ts && !e.email_enc, 'a member account needs no stored email copy');
  assert.equal(q1("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='waitlist_joined'", ada.uid).c, 1);
  const mail = await eventually(() => { const m = lastMail(email('ada'), "You're on the%"); assert.ok(m); return m; });
  const unsub = linkIn(mail.body, '/waitlist/unsubscribe?token=');
  assert.ok(mail.html.includes('Unsubscribe'));
  const h = JSON.parse(mail.headers);
  assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(h['List-Unsubscribe'], /^<http:\/\/127\.0\.0\.1:\d+\/v1\/waitlists\/one_click_unsubscribe\?token=wl_/);
  assert.equal(tokenOf(unsub), tokenOf(h['List-Unsubscribe'].slice(1, -1)));
  // The survey: single choice, naira band (₦ labels), payment methods, multiple choice and moderated free text.
  await page.waitForSelector('[data-testid=waitlist-survey][data-locked="0"]');
  const band = page.locator('[data-testid=survey-q][data-key="real_money_launch.first_deposit"] label').nth(1);
  assert.equal((await band.textContent()).trim(), '₦5,000 to ₦20,000');
  assert.deepEqual(await page.locator('[data-testid=survey-q][data-key="real_money_launch.payment_method"] label').allTextContents().then((x) => x.map((s) => s.trim())), ['Bank transfer', 'Debit card', 'USSD', 'Mobile wallet']);
  const q = (k) => `[data-testid=survey-q][data-key="real_money_launch.${k}"]`;
  await page.check(`${q('would_trade')} input[value=yes]`);
  await page.check(`${q('first_deposit')} input[value=b2]`);
  await page.check(`${q('payment_method')} input[value=ussd]`);
  await page.check(`${q('markets')} input[value=football]`);
  await page.check(`${q('markets')} input[value=elections]`);
  await page.fill(`${q('comment')} textarea`, 'Please add <b>Lagos</b> weather markets');
  await page.click('[data-testid=survey-save]');
  await page.waitForSelector('form[data-survey][data-saved="1"]');
  const ans = () => Object.fromEntries(qa('SELECT question_key k, value_json v FROM waitlist_survey_answers WHERE entry_id=?', e.id).map((r) => [r.k.split('.')[1], JSON.parse(r.v)]));
  const saved = ans();
  assert.deepEqual([...saved.markets].sort(), ['elections', 'football']);
  delete saved.markets;
  assert.deepEqual(saved, { would_trade: 'yes', first_deposit: 'b2', payment_method: 'ussd', comment: 'Please add Lagos weather markets' }, 'markup stripped from free text');
  assert.equal(q1("SELECT moderation FROM waitlist_survey_answers WHERE entry_id=? AND question_key='real_money_launch.comment'", e.id).moderation, 'pending');
  // Edit (allowed until the launch), reload: the page shows the saved answers.
  await page.check(`${q('would_trade')} input[value=maybe]`);
  await page.uncheck(`${q('markets')} input[value=elections]`);
  await page.evaluate(() => { delete document.querySelector('form[data-survey]').dataset.saved; });
  await page.click('[data-testid=survey-save]');
  await page.waitForSelector('form[data-survey][data-saved="1"]');
  assert.equal(ans().would_trade, 'maybe'); assert.deepEqual(ans().markets, ['football']);
  await page.reload();
  await page.waitForSelector(`${q('would_trade')} input[value=maybe]:checked`);
  assert.ok(await page.isChecked(`${q('first_deposit')} input[value=b2]`));
  assert.deepEqual(page.errors, []);
});

let g1Token;
test('guest double opt-in at 390 px: the confirmation link from the outbox, single use, expiry; email encrypted at rest with a keyed hash; survey by token', async () => {
  const page = await newPage({ width: 390, height: 844 });
  await page.goto(BASE + '/waitlist?src=home&utm_source=whatsapp&utm_campaign=launch&ref=ab12cd');
  await page.waitForSelector('[data-testid=waitlist-email]');
  assert.ok(await noHorizontalScroll(page), 'no horizontal scroll at 390 px');
  await page.fill('[data-testid=waitlist-email]', email('g1'));
  await page.click('[data-testid=waitlist-guest-submit]');
  assert.equal(await page.textContent('[data-testid=waitlist-join-error]'), 'Tick the box to agree before joining.');
  await page.check('[data-testid=waitlist-agree]');
  await page.click('[data-testid=waitlist-guest-submit]');
  await page.waitForSelector('[data-testid=waitlist-check-email]');
  assert.match(await page.textContent('[data-testid=waitlist-check-email]'), /within 48 hours/);
  // At rest: AES-GCM ciphertext and an HMAC; never the address in clear (anywhere in the row).
  const e = q1("SELECT * FROM waitlist_entries WHERE list_key='real_money_launch' AND user_id IS NULL AND source='home'");
  assert.equal(e.status, 'pending');
  assert.match(e.email_enc, /^enc:v1:/); assert.match(e.email_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(e).includes(email('g1')), 'no clear-text email in the entry');
  assert.deepEqual([e.utm_source, e.utm_campaign, e.ref_code, e.consent_source], ['whatsapp', 'launch', 'AB12CD', 'guest_form']);
  const tok = q1('SELECT * FROM waitlist_tokens WHERE entry_id=?', e.id);
  const mail = await eventually(() => { const m = lastMail(email('g1'), 'Confirm%'); assert.ok(m); return m; });
  const link = linkIn(mail.body, '/waitlist/confirm?token=');
  assert.notEqual(tok.hash, tokenOf(link), 'only the hash of the link token is stored');
  assert.equal(tok.hash.length, 64);
  assert.ok(Math.abs(tok.expires_ts - tok.created_ts - 48 * 3600000) < 1000);
  // Open the link at 390 px and confirm with one click; the survey appears with naira bands.
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('[data-testid=waitlist-confirm-btn]');
  await page.waitForSelector('[data-testid=waitlist-confirmed]');
  assert.ok(await noHorizontalScroll(page));
  assert.equal(q1('SELECT status FROM waitlist_entries WHERE id=?', e.id).status, 'confirmed');
  await page.check('[data-testid=survey-q][data-key="real_money_launch.would_trade"] input[value=no]');
  await page.check('[data-testid=survey-q][data-key="real_money_launch.first_deposit"] input[value=b5]');
  await page.fill('[data-testid=survey-q][data-key="real_money_launch.comment"] textarea', 'Visit www.example.test for cheap loans');
  await page.click('[data-testid=survey-save]');
  await page.waitForSelector('form[data-survey][data-saved="1"]');
  assert.equal(JSON.parse(q1("SELECT value_json v FROM waitlist_survey_answers WHERE entry_id=? AND question_key='real_money_launch.first_deposit'", e.id).v), 'b5');
  assert.equal(q1("SELECT flag_reason f FROM waitlist_survey_answers WHERE entry_id=? AND question_key='real_money_launch.comment'", e.id).f, 'contains a link');
  const welcome = await eventually(() => { const m = lastMail(email('g1'), "You're on the%"); assert.ok(m); return m; });
  g1Token = tokenOf(linkIn(welcome.body, '/waitlist/unsubscribe?token='));
  // The welcome email's "take the survey" link opens the member's page; it reads, it never unsubscribes.
  const manage = linkIn(welcome.body, '/waitlist/manage?token=');
  assert.equal(tokenOf(manage), g1Token);
  await page.goto(manage.replace(/^https?:\/\/[^/]+/, BASE));
  await page.waitForSelector('[data-testid=waitlist-manage][data-status=confirmed]');
  await page.waitForSelector('[data-testid=survey-q][data-key="real_money_launch.first_deposit"] input[value=b5]:checked');
  assert.match(await page.textContent('[data-testid=waitlist-manage]'), /g\*\*\*@example\.test is on the real-money waitlist/);
  assert.equal(q1('SELECT status FROM waitlist_entries WHERE id=?', e.id).status, 'confirmed', 'opening the survey link does not unsubscribe');
  assert.ok(await noHorizontalScroll(page));
  // The same link again: single use.
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('[data-testid=waitlist-confirm-btn]');
  await page.waitForSelector('[data-testid=waitlist-confirm-error][data-code=waitlist_link_used]');
  assert.match(await page.textContent('[data-testid=waitlist-confirm-error]'), /already been used/);
  // An expired link (the second guest stays pending: an unconfirmed member).
  await guestJoin(email('g2'));
  const link2 = await eventually(() => linkIn(lastMail(email('g2'), 'Confirm%').body, '/waitlist/confirm?token='));
  const e2 = q1("SELECT * FROM waitlist_entries WHERE status='pending' AND id<>? ORDER BY joined_ts DESC LIMIT 1", e.id);
  dbrun(DB_FILE, 'UPDATE waitlist_tokens SET expires_ts=? WHERE entry_id=?', Date.now() - 1000, e2.id);
  await page.goto(link2.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('[data-testid=waitlist-confirm-btn]');
  await page.waitForSelector('[data-testid=waitlist-confirm-error][data-code=waitlist_link_expired]');
  assert.equal(q1('SELECT status FROM waitlist_entries WHERE id=?', e2.id).status, 'pending');
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});

test('unsubscribe: the link in every email (one click), the RFC 8058 POST, delete my data; a guest who signs up later is linked to the account; export and closure include it', async () => {
  // Bola joins with one click (API), then unsubscribes from the welcome email's link.
  const bola = await new Client(BASE, 'bola').signUp(email('bola'), PW, 'Bola Ade');
  await verifyEmail(email('bola'));
  assert.equal((await bola.call('POST', `${L}/join`, { consent: true, consent_version: await consentVersion(bola), source: 'funds' })).status, 201);
  const mail = await eventually(() => { const m = lastMail(email('bola'), "You're on the%"); assert.ok(m); return m; });
  const page = await newPage({ width: 390, height: 844 });
  await page.goto(linkIn(mail.body, '/waitlist/unsubscribe?token=').replace(/^https?:\/\/[^/]+/, BASE));
  await page.waitForSelector('[data-testid=waitlist-unsubscribed][data-status=unsubscribed]');
  assert.match(await page.textContent('[data-testid=waitlist-unsubscribed]'), /b\*\*\*@example\.test/);
  assert.equal(entryOf(bola.uid).status, 'unsubscribed');
  assert.ok(entryOf(bola.uid).unsubscribed_ts && entryOf(bola.uid).consent_ts, 'the consent record and its withdrawal are both kept');
  // RFC 8058: the mail provider POSTs "List-Unsubscribe=One-Click" with no cookie or token header.
  const cyn = await guestConfirmed(email('cyn'));
  const oneClick = await eventually(() => JSON.parse(lastMail(email('cyn'), "You're on the%").headers)['List-Unsubscribe'].slice(1, -1));
  const r = await fetch(oneClick.replace(/^https?:\/\/[^/]+/, BASE), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(r.status, 200);
  assert.equal(q1("SELECT status FROM waitlist_entries WHERE id=?", cyn.split('.')[0]).status, 'unsubscribed');
  // Delete my data (from the unsubscribe page): the entry, its consent record and answers are gone.
  const del = await guestConfirmed(email('dee'));
  const deeId = del.split('.')[0];
  const dc = await new Client(BASE, 'dee').boot();
  assert.equal((await dc.call('PUT', `${L}/survey`, { token: del, answers: { 'real_money_launch.would_trade': 'yes' } })).status, 200);
  await page.goto(`${BASE}/waitlist/unsubscribe?token=${encodeURIComponent(del)}`);
  await page.waitForSelector('[data-testid=waitlist-unsub-delete]');
  await page.click('[data-testid=waitlist-unsub-delete]');
  await page.waitForSelector('[data-testid=waitlist-deleted]');
  assert.equal(q1('SELECT COUNT(*) c FROM waitlist_entries WHERE id=?', deeId).c, 0);
  assert.equal(q1('SELECT COUNT(*) c FROM waitlist_survey_answers WHERE entry_id=?', deeId).c, 0);
  assert.equal((await dc.call('POST', '/v1/waitlists/manage', { token: del })).status, 404, 'the token died with the entry');
  // A confirmed guest later opens an account with the same email: the entry links to it once the account's email is
  // verified (the encrypted copy is then dropped); an unverified sign-up takes nothing over.
  const eve = await guestConfirmed(email('eve'));
  const eveId = eve.split('.')[0];
  assert.ok(q1('SELECT email_enc FROM waitlist_entries WHERE id=?', eveId).email_enc);
  const eveUser = await new Client(BASE, 'eve').signUp(email('eve'), PW, 'Eve Nwosu');
  assert.equal(q1('SELECT user_id FROM waitlist_entries WHERE id=?', eveId).user_id, null, 'not linked before the email is verified');
  assert.equal((await eveUser.call('GET', L)).body.me, null);
  await verifyEmail(email('eve'));
  const linked = q1('SELECT user_id, email_enc, status FROM waitlist_entries WHERE id=?', eveId);
  assert.deepEqual([linked.user_id, linked.email_enc, linked.status], [eveUser.uid, null, 'confirmed']);
  const me = (await eveUser.call('GET', L)).body.me;
  assert.equal(me.entry_status, 'confirmed'); assert.equal(me.linked, true);
  // The account data export includes the entry with its consent record and answers; closing the account deletes it.
  assert.equal((await eveUser.call('PUT', `${L}/survey`, { answers: { 'real_money_launch.payment_method': 'bank_transfer' } })).status, 200);
  const ex = await stepUp(eveUser)('POST', `/v1/users/${eveUser.uid}/data_export`, {});
  assert.equal(ex.status, 200, ex.text);
  const w = ex.body.waitlists.find((x) => x.list === 'real_money_launch');
  assert.equal(w.status, 'confirmed'); assert.equal(w.consent.source, 'guest_form'); assert.match(w.consent.version, /^cms0-/);
  assert.deepEqual(w.survey_answers.map((a) => [a.question, a.answer]), [['real_money_launch.payment_method', 'bank_transfer']]);
  const closed = await stepUp(eveUser)('POST', `/v1/users/${eveUser.uid}/close_account`, { confirm: 'CLOSE' });
  assert.equal(closed.status, 200, closed.text);
  assert.equal(q1('SELECT COUNT(*) c FROM waitlist_entries WHERE user_id=? OR id=?', eveUser.uid, eveId).c, 0);
  assert.equal(q1('SELECT COUNT(*) c FROM waitlist_survey_answers WHERE entry_id=?', eveId).c, 0);
  assert.deepEqual(page.errors, []);
});

test('an unverified account email cannot join with one click: a confirmation link instead, pending (not counted, no newsletter), no takeover of a guest entry, linked only when confirmed', async () => {
  // A victim confirmed as a guest and answered the survey.
  const vic = await guestConfirmed(email('vic'));
  const vicId = vic.split('.')[0];
  const vg = await new Client(BASE, 'vic').boot();
  assert.equal((await vg.call('PUT', `${L}/survey`, { token: vic, answers: { 'real_money_launch.comment': 'victim private note' } })).status, 200);
  // An impostor signs up with the victim's address (never verified) and clicks one-click join in the browser.
  const page = await newPage({ width: 390, height: 844 });
  await uiSignUp(page, email('vic'), 'Not Victor');
  const impostor = q1('SELECT id FROM users WHERE email=?', email('vic')).id;
  await page.goto(BASE + '/waitlist');
  await page.click('[data-testid=waitlist-join-one-click]');
  await page.waitForSelector('[data-testid=waitlist-check-email]');
  const v = q1('SELECT * FROM waitlist_entries WHERE id=?', vicId);
  assert.deepEqual([v.user_id, v.status, v.consent_source], [null, 'confirmed', 'guest_form'], 'the guest entry is not taken over');
  assert.ok(v.email_enc);
  assert.equal(q1('SELECT COUNT(*) c FROM waitlist_entries WHERE user_id=?', impostor).c, 0);
  const ic = await new Client(BASE, 'imp').logIn(email('vic'), PW);
  const iv = (await ic.call('GET', L)).body;
  assert.equal(iv.me, null); assert.deepEqual(iv.survey.answers, {});
  assert.equal((await ic.call('PUT', `${L}/survey`, { answers: { 'real_money_launch.comment': 'overwrite' } })).status, 404);
  assert.match(lastMail(email('vic')).subject, /already on/, 'the inbox owner is told, the impostor learns nothing');
  assert.equal(JSON.parse(q1("SELECT value_json v FROM waitlist_survey_answers WHERE entry_id=? AND question_key='real_money_launch.comment'", vicId).v), 'victim private note');
  // The same reply whatever exists for the address (no enumeration): an unverified account with its own address.
  const una = await new Client(BASE, 'una').signUp(email('una'), PW, 'Una Okafor');
  const r = await una.call('POST', `${L}/join`, { consent: true, consent_version: await consentVersion(una), source: 'home' });
  assert.equal(r.status, 202); assert.equal(r.body.status, 'check_email'); assert.equal(r.body.me, null);
  const ri = await ic.call('POST', `${L}/join`, { consent: true, consent_version: await consentVersion(ic) });
  assert.deepEqual([ri.status, ri.body.status, ri.body.me], [202, 'check_email', null]);
  const ue = q1("SELECT * FROM waitlist_entries WHERE list_key='real_money_launch' AND email_hash=(SELECT email_hash FROM waitlist_entries WHERE consent_source='signed_in_unverified' AND source='home')");
  assert.deepEqual([ue.status, ue.user_id, ue.consent_source], ['pending', null, 'signed_in_unverified']);
  assert.match(ue.email_enc, /^enc:v1:/);
  assert.equal(q1('SELECT user_id FROM waitlist_tokens WHERE entry_id=? AND used_ts IS NULL', ue.id).user_id, una.uid);
  // Pending: not counted, and a newsletter skips it.
  const n0 = confirmedCount();
  const nl = await adminCall('POST', '/v1/admin/waitlists/real_money_launch/newsletters', { reason: 'pending members are skipped' });
  assert.equal(nl.status, 201, nl.text);
  await eventually(() => assert.equal(q1('SELECT status FROM waitlist_newsletters WHERE id=?', nl.body.newsletter.id).status, 'sent'), { timeout: 30000 });
  assert.equal(q1('SELECT status FROM waitlist_newsletter_outbox WHERE newsletter_id=? AND entry_id=?', nl.body.newsletter.id, ue.id).status, 'skipped_unconfirmed');
  assert.equal(q1('SELECT COUNT(*) c FROM email_outbox WHERE to_email=? AND subject=?', email('una'), nl.body.newsletter.subject).c, 0);
  assert.equal(q1('SELECT COUNT(*) c FROM waitlist_newsletter_outbox WHERE newsletter_id=? AND status=?', nl.body.newsletter.id, 'sent').c, n0);
  // Una confirms from her inbox: confirmed, counted and linked to her account (the account that asked for the link).
  const link = await eventually(() => linkIn(lastMail(email('una'), 'Confirm your place%').body, '/waitlist/confirm?token='));
  const cr = await (await new Client(BASE, 'c').boot()).call('POST', '/v1/waitlists/confirm', { token: tokenOf(link) });
  assert.equal(cr.status, 200, cr.text);
  const done = q1('SELECT status, user_id, email_enc FROM waitlist_entries WHERE id=?', ue.id);
  assert.deepEqual([done.status, done.user_id, done.email_enc], ['confirmed', una.uid, null]);
  assert.equal(confirmedCount(), n0 + 1);
  assert.equal((await una.call('GET', L)).body.me.entry_status, 'confirmed');
  assert.equal(q1('SELECT user_id FROM waitlist_entries WHERE id=?', vicId).user_id, null, 'the victim entry is still unlinked');
  assert.deepEqual(page.errors, []);
});

test('call to action on the play-mode banner, Funds and Home at 390 px; the flags hide it live and block the API, while unsubscribe keeps working', async () => {
  const page = await newPage({ width: 390, height: 844 });
  await uiLogIn(page, { email: email('ada') });
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=waitlist-cta-home]');
  assert.ok(await page.isVisible('[data-testid=waitlist-cta-banner]'));
  assert.ok(await noHorizontalScroll(page));
  await page.goto(BASE + '/funds');
  await page.waitForSelector('[data-testid=waitlist-cta-funds]');
  assert.equal(await page.getAttribute('[data-testid=waitlist-cta-funds]', 'href'), '/waitlist?src=funds');
  assert.ok(await noHorizontalScroll(page));
  // waitlist.launch off: hidden live on the open page, the API answers feature_disabled, /waitlist shows the CMS state.
  await setFlag('waitlist.launch', false);
  await page.waitForSelector('[data-testid=waitlist-cta-funds]', { state: 'hidden' });
  await page.waitForSelector('[data-testid=waitlist-cta-banner]', { state: 'hidden' });
  const anon = await new Client(BASE, 'anon').boot();
  assert.equal((await anon.call('GET', L)).code, 'feature_disabled');
  assert.equal((await anon.call('POST', `${L}/guest_join`, { email: email('zed'), consent: true, consent_version: 'x' })).code, 'feature_disabled');
  await page.goto(BASE + '/waitlist');
  await page.waitForSelector('[data-testid=feature-unavailable][data-feature="waitlist.launch"]');
  await page.goto(BASE + '/');
  await page.waitForSelector('#hero');
  assert.equal(await page.isVisible('[data-testid=waitlist-cta-home]'), false);
  // Leaving always works: the unsubscribe link still answers with the flag off (privacy before features).
  assert.equal((await anon.call('POST', '/v1/waitlists/manage', { token: g1Token })).status, 200);
  await setFlag('waitlist.launch', true);
  await page.goto(BASE + '/funds');
  await page.waitForSelector('[data-testid=waitlist-cta-funds]');
  // The survey flag: the API refuses answers and the page hides the survey.
  await setFlag('waitlist.launch.survey', false);
  const ac = await new Client(BASE, 'ada').logIn(email('ada'), PW);
  assert.equal((await ac.call('PUT', `${L}/survey`, { answers: { 'real_money_launch.would_trade': 'no' } })).code, 'feature_disabled');
  await page.goto(BASE + '/waitlist');
  await page.waitForSelector('[data-testid=waitlist-status]');
  assert.equal(await page.locator('[data-testid=waitlist-survey]').count(), 0);
  await setFlag('waitlist.launch.survey', true);
  await page.reload();
  await page.waitForSelector('[data-testid=waitlist-survey]');
  // Out of play mode the call to action is not shown (checked again after the production switch below).
  assert.deepEqual(page.errors, []);
});

test('Admin › Waitlists: target with a reason (audited); reaching it alerts the admins once (in-app and email) and shows on Admin › Play mode; nothing switches', async () => {
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/waitlists');
  await ap.waitForSelector('[data-testid=wl-target-form]');
  const n0 = confirmedCount();
  assert.equal(await ap.getAttribute('[data-testid=wl-stat-confirmed]', 'data-value'), String(n0));
  assert.ok(Number(await ap.getAttribute('[data-testid=wl-stat-pending]', 'data-value')) >= 1);
  // Daily growth and sources.
  assert.ok(await ap.isVisible('[data-testid=wl-growth] svg'));
  assert.ok(await ap.locator('[data-testid=wl-sources-source] tr[data-key=banner]').count());
  assert.ok(await ap.locator('[data-testid=wl-sources-ref_code] tr[data-key=AB12CD]').count());
  // Survey aggregates (no identities) and the moderated free-text list.
  assert.equal(await ap.getAttribute('[data-testid=wl-survey-q][data-key="real_money_launch.first_deposit"] [data-option=b2]', 'data-count'), '1');
  await ap.waitForSelector('[data-testid=wl-comment][data-status=pending]');
  const flagged = ap.locator('[data-testid=wl-comment]', { hasText: 'cheap loans' });
  assert.match(await flagged.textContent(), /Flagged: contains a link/);
  await flagged.locator('[data-testid=wl-comment-hide]').click();
  await ap.waitForSelector('[data-testid=wl-comment][data-status=hidden]');
  assert.equal(q1("SELECT moderation FROM waitlist_survey_answers WHERE value_json LIKE '%cheap loans%'").moderation, 'hidden');
  // Target = one more than today.
  await ap.fill('#f-wlt-target', String(n0 + 1));
  await ap.fill('#f-wlt-reason', 'launch when we have enough demand');
  await ap.click('[data-testid=wl-target-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=wl-target-progress]');
  assert.equal(JSON.parse(q1("SELECT value FROM admin_settings WHERE key='waitlist:real_money_launch'").value).target, n0 + 1);
  assert.equal(q1("SELECT reason FROM admin_audit WHERE action='waitlists.target' ORDER BY ts DESC LIMIT 1").reason, 'launch when we have enough demand');
  const alerts = () => q1("SELECT COUNT(*) c FROM notifications WHERE user_id=(SELECT id FROM users WHERE email=?) AND type='waitlist_target'", ADMIN.email).c;
  assert.equal(alerts(), 0);
  // One more confirmed member reaches it: one in-app alert and one email to each admin.
  const fay = await new Client(BASE, 'fay').signUp(email('fay'), PW, 'Fay Bello');
  await verifyEmail(email('fay'));
  assert.equal((await fay.call('POST', `${L}/join`, { consent: true, consent_version: await consentVersion(fay) })).status, 201);
  await eventually(() => assert.equal(alerts(), 1));
  const adminMail = await eventually(() => { const m = lastMail(ADMIN.email, '%reached its target%'); assert.ok(m); return m; });
  assert.match(adminMail.body, new RegExp(`${n0 + 1} confirmed members`));
  assert.match(adminMail.body, /Nothing switches automatically/);
  // Once only: another member does not alert again.
  const gus = await new Client(BASE, 'gus').signUp(email('gus'), PW, 'Gus Eze');
  await verifyEmail(email('gus'));
  assert.equal((await gus.call('POST', `${L}/join`, { consent: true, consent_version: await consentVersion(gus) })).status, 201);
  await sleep(500);
  assert.equal(alerts(), 1);
  assert.equal(q1("SELECT COUNT(*) c FROM email_outbox WHERE to_email=? AND subject LIKE '%reached its target%'", ADMIN.email).c, 1);
  await ap.reload();
  await ap.waitForSelector('[data-testid=wl-target-alerted]');
  // Admin › Play mode shows "launch target reached"; play mode is still on and no switch was requested.
  await ap.goto(BASE + '/admin/play_mode');
  await ap.waitForSelector('[data-testid=launch-target-reached]');
  assert.match(await ap.textContent('[data-testid=launch-target-reached]'), new RegExp(`${n0 + 2} of ${n0 + 1} confirmed`));
  assert.equal(await ap.getAttribute('[data-testid=play-status]', 'data-on'), '1');
  assert.equal(q1('SELECT COUNT(*) c FROM pm_approvals').c, 0, 'nothing switches automatically');
  assert.deepEqual(ap.errors, []);
});

test('public progress bar: hidden until an admin shows it from Admin › Waitlists (reason, flag history); "N of TARGET joined", live', async () => {
  const anonPage = await newPage({ width: 390, height: 844 });
  await anonPage.goto(BASE + '/waitlist');
  await anonPage.waitForSelector('[data-testid=waitlist-pitch]');
  assert.equal(await anonPage.locator('[data-testid=waitlist-progress]').count(), 0);
  assert.equal((await (await new Client(BASE, 'x').boot()).call('GET', `${L}/progress`)).code, 'feature_disabled');
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/waitlists');
  await ap.waitForSelector('[data-testid=wl-public-state][data-on="0"]');
  await ap.click('[data-testid=wl-public-toggle]');
  await ap.fill('[data-testid=confirm-reason]', 'show the momentum');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-testid=wl-public-state][data-on="1"]');
  assert.equal(q1("SELECT reason FROM feature_flag_history WHERE flag_key='waitlist.launch.public_count' ORDER BY ts DESC LIMIT 1").reason, 'show the momentum');
  // The open guest page updates live (flag nudge) and shows confirmed members against the target.
  await anonPage.waitForSelector('[data-testid=waitlist-progress]');
  const target = JSON.parse(q1("SELECT value FROM admin_settings WHERE key='waitlist:real_money_launch'").value).target;
  assert.equal(await anonPage.getAttribute('[data-testid=waitlist-progress]', 'data-count'), String(confirmedCount()));
  assert.equal(await anonPage.textContent('.wl-progress-label'), `${confirmedCount()} of ${target} joined`);
  assert.ok(await noHorizontalScroll(anonPage));
  assert.deepEqual([...anonPage.errors, ...ap.errors], []);
});

test('survey questions are CMS entries: edited and added in Admin › Waitlists (published with a reason, versioned), live for members', async () => {
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/waitlists');
  await ap.click('[data-testid=wl-survey-q][data-key="real_money_launch.would_trade"] [data-edit-q]');
  await ap.waitForSelector('[data-testid=wl-question-form]');
  assert.equal(await ap.inputValue('#f-wlq-options'), 'yes: Yes, as soon as it launches\nmaybe: Maybe, I want to see it first\nno: No, play money is enough for me');
  await ap.fill('#f-wlq-prompt', 'Would you deposit naira and trade for real?');
  await ap.fill('#f-wlq-reason', 'clearer wording');
  await ap.click('[data-testid=wl-question-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=wl-survey-q][data-key="real_money_launch.would_trade"] h4:has-text("Would you deposit naira and trade for real?")');
  assert.deepEqual(qa("SELECT version, action, reason FROM cms_versions WHERE type='survey' AND key='real_money_launch.would_trade'").map((v) => [v.version, v.action, v.reason]), [[1, 'publish', 'clearer wording']]);
  // A new naira-band question; markup in a prompt is refused by the CMS validator.
  await ap.click('[data-testid=wl-survey-add]');
  await ap.fill('#f-wlq-key', 'real_money_launch.monthly');
  await ap.selectOption('#f-wlq-kind', 'naira_band');
  await ap.fill('#f-wlq-prompt', '<b>How much</b> a month?');
  await ap.fill('#f-wlq-options', 'low: 0-10000\nhigh: 10000-');
  await ap.fill('#f-wlq-sort', '60');
  await ap.fill('#f-wlq-reason', 'add a monthly budget question');
  await ap.click('[data-testid=wl-question-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=wl-question-form] [data-form-error]:not(:empty)');
  await ap.fill('#f-wlq-prompt', 'How much would you trade in a month?');
  await ap.click('[data-testid=wl-question-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=wl-survey-q][data-key="real_money_launch.monthly"]');
  const q = (await (await new Client(BASE, 'ada').logIn(email('ada'), PW)).call('GET', L)).body.survey.questions;
  assert.equal(q.find((x) => x.key === 'real_money_launch.would_trade').prompt, 'Would you deposit naira and trade for real?');
  assert.deepEqual(q.find((x) => x.key === 'real_money_launch.monthly').bands.map((b) => b.label), ['₦0 to ₦10,000', '₦10,000 or more']);
  assert.deepEqual(ap.errors, []);
});

test('consent CSV export: behind step-up, audited, consent fields only', async () => {
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/waitlists');
  await ap.waitForSelector('[data-testid=wl-export-csv]');
  // An older sign-in: the export asks for the password again.
  dbrun(DB_FILE, 'UPDATE sessions SET auth_at=? WHERE user_id=(SELECT id FROM users WHERE email=?)', Date.now() - 3600000, ADMIN.email);
  const audits0 = q1("SELECT COUNT(*) c FROM admin_audit WHERE action='waitlists.export'").c;
  await ap.click('[data-testid=wl-export-csv]');
  await ap.waitForSelector('[data-testid=step-up-password]');
  assert.equal(q1("SELECT COUNT(*) c FROM admin_audit WHERE action='waitlists.export'").c, audits0, 'nothing exported before the step-up');
  const dl = ap.waitForEvent('download');
  await ap.fill('[data-testid=step-up-password]', PW);
  await ap.click('[data-testid=step-up-submit]');
  const file = path.join(TMP, 'export.csv');
  await (await dl).saveAs(file);
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines[0], 'entry_id,list,status,email,joined_time,confirmed_time,unsubscribed_time,consent_time,consent_version,consent_text_sha256,consent_source,consent_ip_hash,source,utm_source,utm_medium,utm_campaign,ref_code');
  assert.equal(lines.length - 1, q1("SELECT COUNT(*) c FROM waitlist_entries WHERE list_key='real_money_launch'").c);
  const g1 = lines.find((l) => l.includes(email('g1')));
  assert.ok(g1 && g1.includes(',confirmed,') && g1.includes(',guest_form,') && g1.includes(',AB12CD'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('Lagos weather') && !/would_trade|first_deposit/.test(fs.readFileSync(file, 'utf8')), 'no survey answers');
  assert.equal(q1("SELECT COUNT(*) c FROM admin_audit WHERE action='waitlists.export'").c, audits0 + 1);
  // Without the permission: a moderator is refused; and the raw API without a fresh step-up answers step_up_required.
  dbrun(DB_FILE, 'UPDATE sessions SET auth_at=? WHERE user_id=(SELECT id FROM users WHERE email=?)', Date.now() - 3600000, ADMIN.email);
  assert.equal((await admin.call('GET', `/v1/admin/waitlists/real_money_launch/export.csv`)).code, 'step_up_required');
  assert.deepEqual(ap.errors, []);
});

test('newsletter: CMS template preview and test send; send now through the throttled outbox, resuming after a restart, unconfirmed and unsubscribed skipped; a scheduled send fires after a restart', async () => {
  // The newsletter is the CMS template email.waitlist_newsletter: publish this issue's wording.
  const tpl = { email_subject: 'Waitlist news: {{count}} joined', email_text: 'Hi {{name}}, {{count}} people are waiting with you. {{link}}\n\nUnsubscribe: {{unsubscribe_link}}', email_html: '<p>Hi {{name}}, {{count}} people are waiting with you.</p><p><a href="{{unsubscribe_link}}">Unsubscribe</a></p>' };
  assert.equal((await adminCall('PUT', '/v1/admin/cms/template/draft', { key: 'email.waitlist_newsletter', value: tpl })).status, 200);
  assert.equal((await adminCall('POST', '/v1/admin/cms/template/publish', { key: 'email.waitlist_newsletter', reason: 'November issue' })).status, 200);
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/waitlists');
  await ap.waitForSelector('[data-testid=wl-nl-form]');
  await ap.click('[data-testid=wl-nl-preview]');
  await ap.waitForSelector('[data-testid=wl-nl-preview-subject]');
  assert.equal(await ap.textContent('[data-testid=wl-nl-preview-subject]'), 'Waitlist news: 1,250 joined');
  await ap.click('[data-testid=wl-nl-test]');
  const test1 = await eventually(() => { const m = lastMail(ADMIN.email, '[Test] Waitlist news%'); assert.ok(m); return m; });
  assert.match(test1.body, /Unsubscribe: http/);
  // Who gets it: confirmed members only (Bola and Cyn unsubscribed, the second guest never confirmed).
  const confirmed = qa("SELECT id FROM waitlist_entries WHERE list_key='real_money_launch' AND status='confirmed'").map((r) => r.id);
  const unsub = q1("SELECT COUNT(*) c FROM waitlist_entries WHERE list_key='real_money_launch' AND status='unsubscribed'").c;
  const pending = q1("SELECT COUNT(*) c FROM waitlist_entries WHERE list_key='real_money_launch' AND status='pending'").c;
  assert.ok(confirmed.length >= 4 && unsub >= 2 && pending >= 1, `${confirmed.length} ${unsub} ${pending}`);
  await ap.fill('#f-wln-reason', 'November newsletter');
  await ap.click('[data-testid=wl-nl-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=wl-nl-row]');
  const nl = q1("SELECT * FROM waitlist_newsletters WHERE kind='newsletter' ORDER BY created_ts DESC LIMIT 1");
  assert.equal(nl.subject, `Waitlist news: ${confirmed.length} joined`);
  assert.equal(q1("SELECT reason FROM admin_audit WHERE action='waitlists.newsletter.send' ORDER BY ts DESC LIMIT 1").reason, 'November newsletter');
  // Throttled (60 a minute): the first ones go out one by one; restart in the middle.
  const sent = () => q1("SELECT COUNT(*) c FROM waitlist_newsletter_outbox WHERE newsletter_id=? AND status='sent'", nl.id).c;
  await eventually(() => assert.ok(sent() >= 1));
  assert.ok(sent() < confirmed.length, 'not all at once');
  await srv.close();
  const atRestart = sent();
  assert.ok(atRestart < confirmed.length);
  srv = await start(OPTS);
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, PW);
  await eventually(() => assert.equal(q1('SELECT status FROM waitlist_newsletters WHERE id=?', nl.id).status, 'sent'), { timeout: 30000 });
  const st = Object.fromEntries(qa('SELECT status, COUNT(*) n FROM waitlist_newsletter_outbox WHERE newsletter_id=? GROUP BY status', nl.id).map((r) => [r.status, r.n]));
  assert.equal(st.sent, confirmed.length); assert.equal(st.skipped_unsubscribed, unsub); assert.equal(st.skipped_unconfirmed, pending);
  // Exactly one copy per confirmed member; none to the unsubscribed or unconfirmed.
  const got = qa('SELECT to_email, COUNT(*) n FROM email_outbox WHERE subject=? GROUP BY to_email', nl.subject);
  assert.equal(got.length, confirmed.length); assert.ok(got.every((x) => x.n === 1));
  for (const who of ['bola', 'cyn', 'g2']) assert.ok(!got.some((x) => x.to_email === email(who)), `${who} skipped`);
  const issue = q1('SELECT body, headers FROM email_outbox WHERE subject=? AND to_email=?', nl.subject, email('g1'));
  assert.match(issue.body, /Hi there, \d+ people are waiting with you/); assert.ok(JSON.parse(issue.headers)['List-Unsubscribe']);
  // The admin page shows the per-send stats.
  await ap.reload();
  await ap.waitForSelector(`[data-testid=wl-nl-row][data-id="${nl.id}"][data-status=sent]`);
  assert.equal(await ap.getAttribute(`[data-testid=wl-nl-row][data-id="${nl.id}"]`, 'data-sent'), String(confirmed.length));
  assert.equal(await ap.getAttribute(`[data-testid=wl-nl-row][data-id="${nl.id}"]`, 'data-skipped-unsubscribed'), String(unsub));
  // Scheduled: a few minutes ahead (minute precision in the form), persisted across a restart, fired by the job clock.
  const at = await ap.evaluate(() => { const d = new Date(Date.now() + 3 * 60000); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; });
  await ap.fill('#f-wln-send_at', at);
  await ap.fill('#f-wln-reason', 'December issue, scheduled');
  await ap.click('[data-testid=wl-nl-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=wl-nl-row][data-status=scheduled]');
  const sch = q1("SELECT * FROM waitlist_newsletters WHERE status='scheduled'");
  assert.ok(sch.scheduled_ts > Date.now() + 60000);
  await srv.close();
  srv = await start(OPTS);
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, PW);
  await sleep(600);
  assert.equal(q1('SELECT status FROM waitlist_newsletters WHERE id=?', sch.id).status, 'scheduled', 'not before its time');
  offset = sch.scheduled_ts - Date.now() + 1000; // the job clock passes the scheduled time
  await eventually(() => assert.equal(q1('SELECT status FROM waitlist_newsletters WHERE id=?', sch.id).status, 'sent'), { timeout: 30000 });
  offset = 0;
  assert.equal(q1("SELECT COUNT(*) c FROM waitlist_newsletter_outbox WHERE newsletter_id=? AND status='sent'", sch.id).c, confirmed.length);
  assert.equal(q1("SELECT reason FROM admin_audit WHERE action='waitlists.newsletter.schedule' ORDER BY ts DESC LIMIT 1").reason, 'December issue, scheduled');
  // The newsletter flag off: the routes answer feature_disabled and the job pauses.
  await setFlag('newsletter', false);
  assert.equal((await adminCall('POST', '/v1/admin/waitlists/real_money_launch/newsletters', { reason: 'while off' })).code, 'feature_disabled');
  await setFlag('newsletter', true);
  assert.deepEqual(ap.errors, []);
});

test('the two-person production switch keeps waitlist members, consents and survey answers, locks the survey, and offers (never sends) the "We\'re live with real money" email', async () => {
  const c2 = await new Client(BASE, 'a2').signUp(ADMIN2.email, PW, 'Second Admin');
  dbrun(DB_FILE, 'UPDATE users SET is_admin=1 WHERE id=?', c2.uid);
  const admin2 = await new Client(BASE, 'a2').logIn(ADMIN2.email, PW);
  const kept = () => ({ members: q1('SELECT COUNT(*) c FROM waitlist_entries').c, consents: q1('SELECT COUNT(*) c FROM waitlist_entries WHERE consent_ts IS NOT NULL').c, answers: q1('SELECT COUNT(*) c FROM waitlist_survey_answers').c });
  const k0 = kept();
  assert.ok(k0.members >= 8 && k0.answers >= 5, JSON.stringify(k0));
  const pv = (await adminCall('GET', '/v1/admin/play_mode/preview')).body.preview;
  assert.deepEqual([pv.counts.kept_waitlist_members, pv.counts.kept_waitlist_consents, pv.counts.kept_survey_answers], [k0.members, k0.consents, k0.answers]);
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/play_mode');
  await ap.click('[data-testid=preview-reset]');
  await ap.waitForSelector('[data-testid=preview-kept-waitlists]');
  assert.match(await ap.textContent('[data-testid=preview-kept-waitlists]'), new RegExp(`${k0.members} waitlist members, ${k0.consents} consent records, ${k0.answers} survey answers`));
  const req = await adminCall('POST', '/v1/admin/play_mode/production_switch', { reason: 'demand target reached', confirm: 'RESET' });
  assert.equal(req.status, 202, req.text);
  const launchMails = () => q1("SELECT COUNT(*) c FROM email_outbox WHERE subject LIKE 'We''re live with real money%'").c;
  const done = await stepUp(admin2)('POST', `/v1/admin/play_mode/approvals/${req.body.approval.id}/approve`, { confirm: 'RESET' });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.body.result.launch_email && [done.body.result.launch_email.offered, done.body.result.launch_email.available], [true, true]);
  // Kept, the survey locked, and the launch email offered but not sent.
  assert.deepEqual(kept(), k0);
  await sleep(800);
  assert.equal(launchMails(), 0, 'never sent automatically');
  assert.ok(q1("SELECT COUNT(*) c FROM notifications WHERE user_id=(SELECT id FROM users WHERE email=?) AND type='waitlist_launch_offer'", ADMIN.email).c >= 1);
  const adaC = await new Client(BASE, 'ada').logIn(email('ada'), PW);
  const locked = await adaC.call('PUT', `${L}/survey`, { answers: { 'real_money_launch.would_trade': 'no' } });
  assert.equal(locked.status, 409); assert.equal(locked.code, 'survey_closed');
  // The admin sends it from Admin › Play mode (reason, password check) through the outbox to confirmed members.
  await ap.reload();
  await ap.waitForSelector('[data-testid=launch-email-offer][data-available="1"]');
  await ap.click('[data-testid=launch-email-send]');
  await ap.fill('[data-testid=confirm-reason]', 'tell the waitlist we are live');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-testid=launch-email-offer][data-available="0"]');
  const confirmed = q1("SELECT COUNT(*) c FROM waitlist_entries WHERE list_key='real_money_launch' AND status='confirmed'").c;
  await eventually(() => assert.equal(launchMails(), confirmed), { timeout: 30000 });
  assert.match(lastMail(email('ada'), "We're live%").body, /\/funds/);
  assert.equal(q1("SELECT reason FROM admin_audit WHERE action='waitlists.launch_email'").reason, 'tell the waitlist we are live');
  assert.equal((await adminCall('POST', '/v1/admin/waitlists/real_money_launch/launch_email', { reason: 'again' })).code, 'launch_email_sent');
  // Real money now: no call to action; the member's page shows the locked survey.
  const up = await newPage();
  await uiLogIn(up, { email: email('ada') });
  await up.goto(BASE + '/funds');
  await up.waitForSelector('[data-testid=balances]');
  assert.equal(await up.locator('[data-testid=waitlist-cta-funds]').count(), 0);
  assert.equal(await up.locator('[data-testid=play-banner]').count(), 0);
  await up.goto(BASE + '/waitlist');
  await up.waitForSelector('[data-testid=waitlist-survey][data-locked="1"]');
  assert.deepEqual([...ap.errors, ...up.errors], []);
});

test('guest form: per-IP rate limit, honeypot, the client token and login CSRF, and no account enumeration', async () => {
  const file = path.join(TMP, 'limits.db');
  const port = await freePort();
  const base2 = `http://127.0.0.1:${port}`;
  const s = await start(base(port, file, { waitlists: { guestJoinsPerIp: 8, newsletterPerMinute: 600, tokenAttemptsPerIp: 1000 } }));
  try {
    const d1 = (sql, ...a) => dbq(file, sql, ...a)[0];
    const join = async (addr, extra = {}) => { const g = await new Client(base2, 'g').boot(); const v = (await g.call('GET', L)).body.consent.version; return g.call('POST', `${L}/guest_join`, { email: addr, consent: true, consent_version: v, ...extra }); };
    // Fixtures: a confirmed guest, a pending guest, an account (2 joins so far).
    assert.equal((await join(email('conf'))).status, 202);
    const tok = /token=([A-Za-z0-9_-]+)/.exec(d1("SELECT body FROM email_outbox WHERE to_email=? ORDER BY rowid DESC LIMIT 1", email('conf')).body)[1];
    assert.equal((await (await new Client(base2, 'c').boot()).call('POST', '/v1/waitlists/confirm', { token: tok })).status, 200);
    assert.equal((await join(email('pend'))).status, 202);
    await new Client(base2, 'acct').signUp(email('acct'), PW, 'Acct Holder');
    // The same answer whatever the email's state (new, confirmed, pending, an account's email): no enumeration.
    const answers = [];
    for (const who of ['new1', 'conf', 'pend', 'acct']) { const r = await join(email(who)); answers.push([r.status, r.text]); }
    assert.deepEqual(answers.map((x) => x[0]), [202, 202, 202, 202]);
    assert.equal(new Set(answers.map((x) => x[1])).size, 1, `identical bodies: ${JSON.stringify(answers)}`);
    // What each inbox gets differs (the owner learns, the requester does not): a confirm link, or "already on it".
    assert.match(d1('SELECT subject FROM email_outbox WHERE to_email=? ORDER BY rowid DESC LIMIT 1', email('conf')).subject, /already on/);
    assert.equal(d1("SELECT COUNT(*) c FROM waitlist_entries WHERE status='confirmed'").c, 1);
    // Honeypot: a bot filling the hidden field gets the same reply; nothing is stored or sent (7 joins so far).
    const hp = await join(email('bot'), { website: 'https://spam.example.test' });
    assert.equal(hp.status, 202); assert.equal(hp.text, answers[0][1]);
    assert.equal(d1('SELECT COUNT(*) c FROM email_outbox WHERE to_email=?', email('bot')).c, 0);
    assert.equal(d1("SELECT COUNT(*) c FROM security_events WHERE kind='waitlist_honeypot'").c, 1);
    // The bot challenge: no signed client token, refused; no login CSRF token, refused.
    const bare = new Client(base2, 'bare');
    await bare.call('GET', '/v1/auth/csrf');
    const v = (await bare.call('GET', L)).body.consent.version;
    const noCt = await bare.call('POST', `${L}/guest_join`, { email: email('noct'), consent: true, consent_version: v });
    assert.equal(noCt.status, 403); assert.match(noCt.code, /^client_token_/);
    const noCsrf = await new Client(base2, 'nc').boot();
    noCsrf.csrf = '';
    assert.equal((await noCsrf.call('POST', `${L}/guest_join`, { email: email('nocsrf'), consent: true, consent_version: v })).code, 'forbidden');
    // The per-IP limit (8 an hour in this server): the 8th join is accepted, the 9th refused with 429.
    assert.equal((await join(email('eighth'))).status, 202);
    const ninth = await join(email('ninth'));
    assert.equal(ninth.status, 429); assert.equal(ninth.code, 'too_many_requests');
    assert.equal(d1('SELECT COUNT(*) c FROM email_outbox WHERE to_email=?', email('ninth')).c, 0);
    // Consent is required and must match the wording shown.
    const g = await new Client(base2, 'g2').boot();
    assert.equal((await g.call('POST', `${L}/guest_join`, { email: email('x'), consent: false, consent_version: v })).code, 'consent_required');
    assert.equal((await g.call('POST', `${L}/guest_join`, { email: email('x'), consent: true, consent_version: 'cms9-000000000000' })).code, 'consent_changed');
  } finally { await s.close(); }
});

test('persistence across a restart: members, consents, answers, moderation, target alert, newsletters and the locked survey', async () => {
  const snap = () => ({
    entries: qa('SELECT id, status, consent_version, consent_ip_hash, email_hash FROM waitlist_entries ORDER BY id'),
    answers: qa('SELECT id, value_json, moderation FROM waitlist_survey_answers ORDER BY id'),
    settings: q1("SELECT value FROM admin_settings WHERE key='waitlist:real_money_launch'").value,
    newsletters: qa('SELECT id, status, subject FROM waitlist_newsletters ORDER BY id'),
  });
  const before0 = snap();
  await srv.close();
  srv = await start(OPTS);
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, PW);
  assert.deepEqual(snap(), before0);
  const v = (await adminCall('GET', '/v1/admin/waitlists/real_money_launch')).body.waitlist;
  assert.equal(v.counts.confirmed, confirmedCount());
  assert.ok(v.target_alert && v.survey_locked_time);
  const adaC = await new Client(BASE, 'ada').logIn(email('ada'), PW);
  const me = (await adaC.call('GET', L)).body;
  assert.equal(me.me.entry_status, 'confirmed'); assert.equal(me.survey.locked, true); assert.equal(me.survey.answers['real_money_launch.first_deposit'], 'b2');
  // The guest's token still works after the restart (derived from the server key, not stored).
  assert.equal((await (await new Client(BASE, 'g').boot()).call('POST', '/v1/waitlists/manage', { token: g1Token })).body.me.entry_status, 'confirmed');
});

test('no page errors anywhere', () => {
  assert.deepEqual(allPages.flatMap((p) => p.errors), []);
});
