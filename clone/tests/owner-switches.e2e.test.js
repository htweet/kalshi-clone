'use strict';
// Every owner choice is an admin switch (PLAN.md ground rule 6, CLONE_SPEC.md §38.1), real server + SQLite + Chromium.
// Each switch and setting added for the owner decisions of 2026-11-08 is changed in the admin UI (with a reason, a step-up
// where it touches money, security or personal data), its effect is seen without a restart, and it keeps its value after
// one:
//   • Admin › Owner settings: every setting with its recommended default, CMS-managed explanation, range and history;
//     every switch in the catalogue with its explanation; a CMS edit of an explanation shows; bad values refused;
//   • waitlist (7A): confirmation-link lifetime (in the email and the token), deletion of unconfirmed entries, the
//     newsletter rate, email in the consent CSV; the two call-to-action switches (play mode / real money); auto-confirm
//     of a pending entry when the account email is verified later (and the old behaviour with the switch off);
//   • elections (7B): the second resolver, pending-call expiry, rating bands and the projected threshold, the FCT clause
//     of the presidential win rule in Admin › Elections;
//   • Phase 8 switches from Admin › Feature flags: referrals, share links, copy trade, server-rendered pages, languages,
//     data saver, SMS; Phase 8 settings: the review threshold, share clicks, language coverage, the page cache, the data
//     saver default, the SMS cap;
//   • a restart keeps every value and its effect.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { REGISTRY } = require('../server/owner-settings.js');
const { Client, UA } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-owner-'));
const DB_FILE = path.join(TMP, 'owner.db');
const PW = 'Benue-Copper-Halyard-6604';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const L = '/v1/waitlists/real_money_launch';
const HUB = '/category/elections/nigeria-2027';
let OPTS; let BASE; let srv; let browser; let admin; let ap;
const allPages = [];
const email = (n) => `${n}.${stamp}@example.test`;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const q1 = (sql, ...a) => dbq(sql, ...a)[0];
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function eventually(fn, { timeout = 15000, interval = 150 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { const v = await fn(); if (v !== false && v !== undefined && v !== null) return v; } catch (e) { if (Date.now() > end) throw e; } if (Date.now() > end) throw new Error('eventually: condition not met'); await sleep(interval); }
}
async function newPage(viewport = { width: 1280, height: 900 }) {
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
const staleAdmin = () => dbrun('UPDATE sessions SET auth_at=? WHERE user_id=(SELECT id FROM users WHERE email=?)', Date.now() - 3600000, ADMIN.email);
// Submit an admin form; when the server asks for the password again, answer the step-up dialog; wait for `done`.
async function submitUntil(page, submit, done, { expectStepUp = false } = {}) {
  await page.click(submit);
  const which = await Promise.race([
    page.waitForSelector('[data-testid=step-up-password]', { timeout: 15000 }).then(() => 'step_up').catch(() => null),
    page.waitForSelector(done, { timeout: 15000 }).then(() => 'done').catch(() => null),
  ]);
  if (expectStepUp) assert.equal(which, 'step_up', `a step-up was asked for before ${done}`);
  if (which === 'step_up') {
    await page.fill('[data-testid=step-up-password]', PW);
    await page.click('[data-testid=step-up-submit]');
  }
  await page.waitForSelector(done, { timeout: 15000 });
}
// Admin › Owner settings: edit one setting in the UI.
async function setOwnerUi(key, value, { reason = `owner switches e2e: ${key}`, expectStepUp = false } = {}) {
  if (!ap.url().endsWith('/admin/owner_settings')) await ap.goto(BASE + '/admin/owner_settings');
  await ap.click(`[data-testid=owner-setting][data-key="${key}"] [data-testid=owner-edit]`);
  await ap.waitForSelector('[data-testid=owner-form]');
  if (typeof value === 'boolean') await ap.setChecked('[data-testid=owner-form] [name=value]', value);
  else await ap.fill('[data-testid=owner-form] [name=value]', String(value));
  await ap.fill('[data-testid=owner-form] [name=reason]', reason);
  await submitUntil(ap, '[data-testid=owner-form] button[type=submit]', `[data-testid=owner-setting][data-key="${key}"][data-value="${value}"]`, { expectStepUp });
}
// Admin › Feature flags: switch one flag in the UI (the edit dialog, with a reason).
async function setFlagUi(key, enabled, reason = `owner switches e2e: ${key}`) {
  if (!ap.url().endsWith('/admin/flags')) await ap.goto(BASE + '/admin/flags');
  await ap.waitForSelector(`[data-flag-key="${key}"]`);
  await ap.click(`[data-flag-key="${key}"] [data-testid=flag-edit]`);
  await ap.waitForSelector('[data-testid=flag-form]');
  await ap.setChecked('[data-testid=flag-form] [name=enabled]', enabled);
  await ap.fill('[data-testid=flag-form] [name=reason]', reason);
  await submitUntil(ap, '[data-testid=flag-form] button[type=submit]', `[data-flag-key="${key}"] [data-testid=flag-state][data-on="${enabled ? 1 : 0}"]`);
}
const ownerValue = async (key) => (await admin.call('GET', `/v1/admin/owner_settings/${key}`)).body.setting.value;
const flagOn = async (key) => (await admin.call('GET', `/v1/admin/flags/${key}`)).body.flag.effective;
const lastMail = (to, like = '%') => q1('SELECT * FROM email_outbox WHERE to_email=? AND subject LIKE ? ORDER BY created_at DESC, rowid DESC LIMIT 1', to, like);
const linkIn = (body, p) => { const m = new RegExp(`https?://[^\\s]+${p.replace(/[/?]/g, (c) => `\\${c}`)}[^\\s]*`).exec(body); assert.ok(m, `no ${p} link in: ${body}`); return m[0]; };
const tokenOf = (url) => new URL(url).searchParams.get('token');
const consentVersion = async (c) => (await c.call('GET', L)).body.consent.version;
async function guestJoin(addr) {
  const g = await new Client(BASE, 'guest').boot();
  const r = await g.call('POST', `${L}/guest_join`, { email: addr, consent: true, consent_version: await consentVersion(g) });
  assert.equal(r.status, 202, r.text);
  return g;
}
async function guestConfirmed(addr) {
  const g = await guestJoin(addr);
  const link = await eventually(() => linkIn(lastMail(addr, 'Confirm%').body, '/waitlist/confirm?token='));
  assert.equal((await g.call('POST', '/v1/waitlists/confirm', { token: tokenOf(link) })).status, 200);
}
async function verifyEmail(addr) {
  const link = await eventually(() => linkIn(lastMail(addr, 'Confirm your email%').body, '/verify-email?token='));
  const r = await (await new Client(BASE, 'verify').boot()).call('POST', '/v1/verify_email', { token: tokenOf(link) });
  assert.equal(r.status, 200, r.text);
}
async function restart() {
  await srv.close();
  srv = await start(OPTS);
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
}
const html = (p) => fetch(BASE + p, { headers: { 'user-agent': UA, accept: 'text/html' } }).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() }));
const sim = (id, body) => adminCall('PUT', `/v1/admin/elections/elections/${id}/simulator`, { reason: 'owner switches e2e', ...body });

before(async () => {
  const port = await freePort(); // OS-assigned, kept across the restart
  BASE = `http://127.0.0.1:${port}`;
  OPTS = { port, dbFile: DB_FILE, tickMs: 250, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH },
    elections: { seed: true, snapshotEveryMin: 60 }, flags: { defaults: { 'elections.simulator': true } },
    waitlists: { guestJoinsPerIp: 1000, tokenAttemptsPerIp: 1000, purgeEveryMs: 1000 } };
  srv = await start(OPTS);
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  ap = await newPage({ width: 1400, height: 1000 });
  await uiLogIn(ap, ADMIN);
});
after(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await srv?.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Admin › Owner settings: every setting with its recommended default, CMS explanation and range; every switch explained; a CMS edit shows; bad values refused; history', async () => {
  await ap.goto(BASE + '/admin/owner_settings');
  await ap.waitForSelector('[data-testid=owner-setting]');
  const rows = await ap.$$eval('[data-testid=owner-setting]', (ns) => ns.map((n) => ({ key: n.dataset.key, value: n.dataset.value, help: n.querySelector('[data-testid=owner-help]').textContent.trim(), def: n.querySelector('[data-testid=owner-recommended]').dataset.default, rec: n.querySelector('[data-testid=owner-recommended]').textContent })));
  assert.deepEqual(rows.map((r) => r.key).sort(), REGISTRY.map((r) => r[0]).sort(), 'every registered setting is listed');
  for (const [key, , , def] of REGISTRY) {
    const r = rows.find((x) => x.key === key);
    assert.equal(r.def, String(def), `${key}: recommended default`);
    assert.equal(r.value, String(def), `${key}: starts at the recommended default`);
    assert.ok(r.help.length > 30, `${key}: an explanation next to it`);
    assert.match(r.rec, /^Recommended standard: /);
  }
  // The switch catalogue: every flag added for the owner decisions, explained, with its recommended default.
  const sw = await ap.$$eval('[data-testid=owner-switch]', (ns) => Object.fromEntries(ns.map((n) => [n.dataset.key, [...n.querySelectorAll('td')].map((td) => td.textContent.trim())])));
  const expected = { 'waitlist.launch.cta_play': 'On', 'waitlist.launch.cta_production': 'Off', 'waitlist.launch.auto_confirm_verified': 'On', 'elections.second_resolver': 'On', 'referrals.predictions': 'On', share_links: 'On', copy_trade: 'On', ssr: 'On', 'ssr.crawlers': 'On', i18n: 'On', data_saver: 'On', sms: 'Off' };
  for (const [k, rec] of Object.entries(expected)) {
    assert.ok(sw[k], `${k} is in the switch catalogue`);
    assert.ok(sw[k][1].length > 30, `${k}: explained`);
    assert.match(sw[k][2], new RegExp(rec === 'On' ? 'on|true' : 'off|false', 'i'), `${k}: recommended ${rec}`);
  }
  assert.ok(!Object.keys(sw).some((k) => k.endsWith('.map')), 'no flag key ends in .map');
  // The explanation is CMS content: edit it, publish it, and the page shows the new text.
  const key = 'server.switches.setting.ssr.cache_seconds.help';
  assert.equal((await adminCall('PUT', '/v1/admin/cms/text/draft', { key, value: 'How long a public page stays cached before it is rendered again (edited in the CMS).' })).status, 200);
  assert.equal((await adminCall('POST', '/v1/admin/cms/text/publish', { key, reason: 'clearer wording' })).status, 200);
  await ap.goto(BASE + '/admin/owner_settings');
  await ap.waitForSelector('[data-testid=owner-setting][data-key="ssr.cache_seconds"] [data-testid=owner-help]:has-text("(edited in the CMS)")');
  // Out of range and no reason: refused, nothing changes.
  await ap.click('[data-testid=owner-setting][data-key="waitlists.confirm_link_hours"] [data-testid=owner-edit]');
  await ap.fill('[data-testid=owner-form] [name=value]', '0');
  await ap.fill('[data-testid=owner-form] [name=reason]', 'too short');
  await ap.click('[data-testid=owner-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=owner-form] [data-form-error]:not(:empty)');
  assert.equal(await ownerValue('waitlists.confirm_link_hours'), 48);
  await ap.keyboard.press('Escape');
  const r = await adminCall('PUT', '/v1/admin/owner_settings/waitlists.confirm_link_hours', { value: 24 });
  assert.equal(r.status, 400, 'a reason is required');
  assert.equal((await adminCall('PUT', '/v1/admin/owner_settings/elections.rating_likely_pct', { value: 95, reason: 'likely above safe' })).status, 400, 'bands must stay ordered');
  assert.equal((await adminCall('PUT', '/v1/admin/owner_settings/nope.nothing', { value: 1, reason: 'unknown' })).status, 404);
  assert.deepEqual(ap.errors, []);
});

test('waitlist settings (7A): link lifetime in the email and the token, deletion of unconfirmed entries, the newsletter rate, email in the consent CSV (step-up)', async () => {
  assert.equal((await adminCall('PUT', '/v1/admin/play_mode', { on: true, reason: 'play money launch' })).status, 200);
  // Confirmation link lifetime: 48 h by default, 24 h after the change, in the email and on the token.
  await setOwnerUi('waitlists.confirm_link_hours', 24);
  await guestJoin(email('gina'));
  const mail = await eventually(() => lastMail(email('gina'), 'Confirm%'));
  assert.match(mail.body, /24 hours/);
  const tok = q1("SELECT t.expires_ts - t.created_ts d FROM waitlist_tokens t JOIN waitlist_entries e ON e.id=t.entry_id WHERE t.purpose='confirm' ORDER BY t.created_ts DESC LIMIT 1");
  assert.equal(tok.d, 24 * 3600000);
  // The waitlist page tells guests how long the link lasts.
  assert.equal((await (await new Client(BASE, 'g').boot()).call('GET', L)).body.confirm_hours, 24);
  // Unconfirmed guest entries: deleted N days after their last link expired (7 by default; 1 after the change).
  await guestJoin(email('old'));
  await guestJoin(email('recent'));
  const idOf = (addr) => q1("SELECT e.id FROM waitlist_entries e WHERE e.status='pending' AND e.id IN (SELECT entry_id FROM waitlist_tokens) ORDER BY e.joined_ts DESC, e.rowid DESC LIMIT 1 OFFSET ?", addr === 'old' ? 1 : 0).id;
  const oldId = idOf('old'); const recentId = idOf('recent');
  const ago = (d) => Date.now() - d * 86400000;
  dbrun('UPDATE waitlist_tokens SET expires_ts=? WHERE entry_id=?', ago(3), oldId); dbrun('UPDATE waitlist_entries SET updated_ts=? WHERE id=?', ago(3), oldId);
  dbrun('UPDATE waitlist_tokens SET expires_ts=? WHERE entry_id=?', ago(0.5), recentId); dbrun('UPDATE waitlist_entries SET updated_ts=? WHERE id=?', ago(0.5), recentId);
  await sleep(2500);
  assert.ok(q1('SELECT id FROM waitlist_entries WHERE id=?', oldId), 'kept while the setting is 7 days');
  await setOwnerUi('waitlists.unconfirmed_delete_days', 1);
  await eventually(() => !q1('SELECT id FROM waitlist_entries WHERE id=?', oldId));
  assert.ok(q1('SELECT id FROM waitlist_entries WHERE id=?', recentId), 'expired less than a day ago: kept');
  // Newsletter rate: 6 a minute sends one every ten seconds; raised, the rest go out at once.
  for (const n of ['n1', 'n2', 'n3', 'n4']) await guestConfirmed(email(n));
  await setOwnerUi('waitlists.newsletter_per_minute', 6);
  await ap.goto(BASE + '/admin/waitlists');
  await ap.waitForSelector('[data-testid=wl-newsletter]');
  assert.match(await ap.textContent('[data-testid=wl-newsletter]'), /\b6\b/, 'Admin › Waitlists states the rate');
  const nl = await adminCall('POST', '/v1/admin/waitlists/real_money_launch/newsletters', { reason: 'rate check' });
  assert.equal(nl.status, 201, nl.text);
  const sent = () => q1("SELECT COUNT(*) c FROM waitlist_newsletter_outbox WHERE newsletter_id=? AND status='sent'", nl.body.newsletter.id).c;
  await sleep(12000);
  const early = sent();
  assert.ok(early >= 1 && early <= 2, `about one every ten seconds (${early} sent in 12 s)`);
  await setOwnerUi('waitlists.newsletter_per_minute', 6000);
  await eventually(() => q1('SELECT status FROM waitlist_newsletters WHERE id=?', nl.body.newsletter.id).status === 'sent', { timeout: 20000 });
  // Email in the consent CSV: on by default; off (with a step-up) leaves the column empty, and the export audit says so.
  const csv = async () => { const r = await adminCall('GET', '/v1/admin/waitlists/real_money_launch/export.csv'); assert.equal(r.status, 200, r.text); return r.text.trim().split(/\r?\n/); };
  const before0 = await csv();
  const emailCol = before0[0].split(',').indexOf('email');
  assert.ok(before0.slice(1).some((l) => l.split(',')[emailCol].includes('@example.test')));
  staleAdmin();
  await setOwnerUi('waitlists.export_includes_email', false, { expectStepUp: true, reason: 'data minimisation' });
  const after0 = await csv();
  assert.equal(after0[0], before0[0], 'same columns');
  assert.ok(after0.slice(1).every((l) => l.split(',')[emailCol] === ''), 'email column empty');
  const audit = q1("SELECT * FROM admin_audit WHERE action='waitlists.export' ORDER BY ts DESC LIMIT 1");
  assert.match(audit.after_json || audit.after || '', /"email":false/);
  assert.ok(q1("SELECT 1 x FROM admin_audit WHERE action='owner_settings.update' AND target_id='waitlists.export_includes_email' AND reason='data minimisation'"));
  assert.deepEqual(ap.errors, []);
});

test('waitlist switches (7A): the call to action in play mode and outside it; auto-confirm when the account email is verified later (and without it)', async () => {
  const page = await newPage({ width: 390, height: 844 });
  await page.goto(BASE + '/');
  // Play mode is on (previous test): the play-mode switch shows the call to action; off hides it live.
  await page.waitForSelector('[data-testid=waitlist-cta-home]');
  await setFlagUi('waitlist.launch.cta_play', false);
  await page.waitForSelector('[data-testid=waitlist-cta-home]', { state: 'hidden' });
  await setFlagUi('waitlist.launch.cta_play', true);
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=waitlist-cta-home]');
  // Outside play mode (a second server on its own database, play mode never turned on): the real-money switch is off by
  // default, so no call to action; on, it shows.
  const db2 = path.join(TMP, 'real.db');
  const srv2 = await start({ ...OPTS, port: 0, dbFile: db2 });
  try {
    const base2 = `http://127.0.0.1:${srv2.port}`;
    const a2 = await new Client(base2, 'admin2').logIn(ADMIN.email, ADMIN.password);
    const p2 = await newPage({ width: 390, height: 844 });
    await p2.goto(base2 + '/');
    await p2.waitForSelector('#hero, [data-testid=home]');
    await sleep(800);
    assert.equal(await p2.locator('[data-testid=waitlist-cta-home]').count(), 0, 'off by default outside play mode');
    const ap2 = await newPage({ width: 1400, height: 1000 });
    await ap2.goto(base2 + '/sign-in');
    await ap2.fill('input[name=email]', ADMIN.email); await ap2.fill('input[name=password]', PW); await ap2.click('button[type=submit]');
    await ap2.waitForSelector('[data-testid=account-menu]');
    await ap2.goto(base2 + '/admin/flags');
    await ap2.waitForSelector('[data-flag-key="waitlist.launch.cta_production"]');
    await ap2.click('[data-flag-key="waitlist.launch.cta_production"] [data-testid=flag-edit]');
    await ap2.setChecked('[data-testid=flag-form] [name=enabled]', true);
    await ap2.fill('[data-testid=flag-form] [name=reason]', 'gauge real-money interest');
    await submitUntil(ap2, '[data-testid=flag-form] button[type=submit]', '[data-flag-key="waitlist.launch.cta_production"] [data-testid=flag-state][data-on="1"]');
    await p2.goto(base2 + '/');
    await p2.waitForSelector('[data-testid=waitlist-cta-home]');
    assert.equal((await a2.call('GET', '/v1/admin/flags/waitlist.launch.cta_production')).body.flag.effective, true);
    await p2.context().close(); await ap2.context().close();
  } finally { await srv2.close(); }
  // Auto-confirm (on by default): an unverified account joins (pending), then verifies its email: confirmed, recorded as
  // "signed_in_verified_later".
  const una = await new Client(BASE, 'una').signUp(email('una'), PW, 'Una Okafor');
  const j = await una.call('POST', `${L}/join`, { consent: true, consent_version: await consentVersion(una), source: 'home' });
  assert.equal(j.body.status, 'check_email');
  const pendingOf = (uid) => q1("SELECT e.* FROM waitlist_entries e JOIN waitlist_tokens t ON t.entry_id=e.id WHERE t.user_id=? ORDER BY e.joined_ts DESC LIMIT 1", uid);
  assert.equal(pendingOf(una.uid).status, 'pending');
  await verifyEmail(email('una'));
  await eventually(() => pendingOf(una.uid).status === 'confirmed');
  const e1 = pendingOf(una.uid);
  assert.deepEqual([e1.consent_source, e1.user_id], ['signed_in_verified_later', una.uid]);
  const up = await newPage({ width: 390, height: 844 });
  await uiLogIn(up, { email: email('una') });
  await up.goto(BASE + '/waitlist');
  await up.waitForSelector('[data-testid=waitlist-status][data-status=confirmed]');
  // Switched off: the entry stays pending after the email is verified; the confirmation link still works.
  await setFlagUi('waitlist.launch.auto_confirm_verified', false);
  const vic = await new Client(BASE, 'vic').signUp(email('vic'), PW, 'Vic Adeyemi');
  await vic.call('POST', `${L}/join`, { consent: true, consent_version: await consentVersion(vic), source: 'home' });
  await verifyEmail(email('vic'));
  await sleep(1500);
  assert.equal(pendingOf(vic.uid).status, 'pending', 'not confirmed automatically');
  const link = await eventually(() => linkIn(lastMail(email('vic'), 'Confirm your place%').body, '/waitlist/confirm?token='));
  assert.equal((await (await new Client(BASE, 'c').boot()).call('POST', '/v1/waitlists/confirm', { token: tokenOf(link) })).status, 200);
  assert.deepEqual([pendingOf(vic.uid).status, pendingOf(vic.uid).consent_source], ['confirmed', 'signed_in_unverified']);
  await setFlagUi('waitlist.launch.auto_confirm_verified', true);
  assert.deepEqual(page.errors, []); assert.deepEqual(up.errors, []);
});

test('elections switches (7B): second resolver off settles a call at once; pending-call expiry; rating bands and the projected threshold; the FCT clause in Admin › Elections', async () => {
  // The projected threshold (90% by default) on a partly counted election: a lower bar projects more states.
  await sim('NG27', { action: 'advance', minutes: 300 });
  const page = await newPage();
  const projected = async () => { await page.goto(BASE + HUB); await page.waitForSelector('[data-testid=el-map-state]'); return page.locator('[data-testid=el-map-state][data-kind=projected]').count(); };
  const view = async () => (await (await new Client(BASE, 'r').boot()).call('GET', '/v1/elections/hubs/nigeria-2027/view')).body;
  await setOwnerUi('elections.projected_pct', 51);
  const low = await projected();
  await setOwnerUi('elections.projected_pct', 99);
  const high = await projected();
  assert.ok(low > high, `projected states: ${low} at 51%, ${high} at 99%`);
  assert.equal((await view()).ratings.bands.projected, 99);
  await sim('NG27', { action: 'advance', minutes: 1200 }); // every polling unit reported
  const race = async (id) => (await (await new Client(BASE, 'x').boot()).call('GET', `/v1/elections/races/${id}`)).body.race;
  // Second resolver on (default): a call proposes settlements that wait for another admin.
  const kn = await race('NG27-GOV-KN');
  assert.equal((await adminCall('POST', '/v1/admin/elections/races/NG27-GOV-KN/call', { outcome: 'winner', candidate_id: kn.candidates[0].id, reason: 'Kano collation complete' })).status, 200);
  assert.equal(q1("SELECT COUNT(*) c FROM res_approvals WHERE market_ticker LIKE 'PLXNG27-GOVKN-%' AND status='pending'").c, 3);
  // Pending-call expiry: 24 h by default; 2 h after the change (the resolution desk shows it); older proposals expire.
  const desk = async () => (await adminCall('GET', '/v1/admin/resolution/approvals')).body;
  const expiryOf = (b) => { const a = (b.approvals || b.requests || []).find((x) => /^PLXNG27-GOVKN-/.test(x.market_ticker)); return Date.parse(a.expires_time) - Date.parse(a.requested_time); };
  assert.equal(expiryOf(await desk()), 24 * 3600000);
  await setOwnerUi('elections.pending_expiry_hours', 2);
  assert.equal(expiryOf(await desk()), 2 * 3600000);
  dbrun("UPDATE res_approvals SET requested_ts=? WHERE market_ticker LIKE 'PLXNG27-GOVKN-%' AND status='pending'", Date.now() - 3 * 3600000);
  await desk();
  assert.equal(q1("SELECT COUNT(*) c FROM res_approvals WHERE market_ticker LIKE 'PLXNG27-GOVKN-%' AND status='expired'").c, 3, 'older than 2 h: expired');
  // Second resolver off: the next call settles its markets at once (no proposal waits).
  await setFlagUi('elections.second_resolver', false);
  const la = await race('NG27-GOV-LA');
  const c2 = await adminCall('POST', '/v1/admin/elections/races/NG27-GOV-LA/call', { outcome: 'winner', candidate_id: la.candidates[0].id, reason: 'Lagos collation complete' });
  assert.equal(c2.status, 200, c2.text);
  await eventually(() => dbq("SELECT status FROM markets WHERE ticker LIKE 'PLXNG27-GOVLA-%'").every((m) => ['determined', 'finalized', 'settled'].includes(m.status)));
  assert.equal(q1("SELECT COUNT(*) c FROM res_approvals WHERE market_ticker LIKE 'PLXNG27-GOVLA-%' AND status='pending'").c, 0);
  const winnerMkt = q1("SELECT m.ticker, e.ticker ev, e.series_ticker st, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.ticker LIKE 'PLXNG27-GOVLA-%' LIMIT 1");
  await page.goto(`${BASE}/markets/${winnerMkt.st.toLowerCase()}/${winnerMkt.slug}/${winnerMkt.ev.toLowerCase()}`);
  await page.waitForSelector('[data-testid=ticket-closed]');
  await setFlagUi('elections.second_resolver', true);
  // Rating bands (90 / 75 / 60 by default) drive the band edges on the hub; the projected threshold drives the map.
  await page.goto(BASE + HUB);
  await page.waitForSelector('[data-testid=el-band-edge]');
  const edges = () => page.$$eval('[data-testid=el-band-edge]', (ns) => ns.map((n) => n.textContent.trim()));
  assert.ok((await edges()).includes('90%+') && (await edges()).includes('75%+') && (await edges()).includes('60%+'), (await edges()).join(' '));
  await setOwnerUi('elections.rating_safe_pct', 95);
  await setOwnerUi('elections.rating_lean_pct', 55);
  await page.goto(BASE + HUB);
  await page.waitForSelector('[data-testid=el-band-edge]');
  assert.ok((await edges()).includes('95%+') && (await edges()).includes('55%+') && !(await edges()).includes('90%+'), (await edges()).join(' '));
  assert.deepEqual((await view()).ratings.bands, { safe: 95, likely: 75, lean: 55, projected: 99 });
  // The FCT clause of the presidential rule: visible in Admin › Elections › Data › Offices, switched off and on there.
  const pres = q1("SELECT id FROM el_offices WHERE country='NG' AND key='president'").id;
  await ap.goto(BASE + '/admin/elections/data?kind=offices&country=NG');
  await ap.waitForSelector(`[data-testid=adm-el-row][data-id="${pres}"] [data-testid=adm-el-rule][data-territory="1"]`);
  assert.match(await ap.textContent(`[data-testid=adm-el-row][data-id="${pres}"] [data-testid=adm-el-rule]`), /25%.*(FCT|Federal Capital Territory)/i);
  await ap.click(`[data-testid=adm-el-row][data-id="${pres}"] [data-testid=adm-el-edit]`);
  await ap.waitForSelector('[data-testid=adm-el-form] [name=territory_required]');
  assert.ok((await ap.textContent('[data-testid=adm-el-form]')).length > 40, 'the clause is explained next to the checkbox');
  await ap.setChecked('[data-testid=adm-el-form] [name=territory_required]', false);
  await ap.fill('[data-testid=adm-el-form] [name=reason]', 'owner review of the territory clause');
  await submitUntil(ap, '[data-testid=adm-el-form] button[type=submit]', `[data-testid=adm-el-row][data-id="${pres}"] [data-testid=adm-el-rule][data-territory="0"]`);
  assert.equal(JSON.parse(q1('SELECT rule_json r FROM el_offices WHERE id=?', pres).r).territory_required, false);
  const pr = (await race('NG27-PRES')).rule;
  assert.equal(pr.territory_required, false, 'the race uses the edited rule');
  assert.ok(pr.candidates.every((c) => c.territory_ok), 'without the clause no candidate needs the territory');
  await ap.click(`[data-testid=adm-el-row][data-id="${pres}"] [data-testid=adm-el-edit]`);
  await ap.setChecked('[data-testid=adm-el-form] [name=territory_required]', true);
  await ap.fill('[data-testid=adm-el-form] [name=reason]', 'restore the constitutional clause');
  await submitUntil(ap, '[data-testid=adm-el-form] button[type=submit]', `[data-testid=adm-el-row][data-id="${pres}"] [data-testid=adm-el-rule][data-territory="1"]`);
  assert.ok(q1("SELECT 1 x FROM admin_audit WHERE reason='owner review of the territory clause'"));
  assert.deepEqual(page.errors, []); assert.deepEqual(ap.errors, []);
});

test('Phase 8 switches from Admin › Feature flags, each seen live: referrals, share links, copy trade, server-rendered pages, languages, data saver, SMS', async () => {
  const ada = await new Client(BASE, 'ada').signUp(email('ada'), PW, 'Ada Lawal');
  assert.equal((await ada.call('POST', `/v1/users/${ada.uid}/deposits`, { amount_dollars: 50 })).status, 201);
  const mk = q1("SELECT m.ticker, e.ticker ev, e.series_ticker st, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.status='active' AND e.series_ticker NOT IN ('PLXCOMBO') AND e.series_ticker NOT LIKE 'PLXFLASH%' AND e.series_ticker NOT LIKE 'PLXNG27%' AND (SELECT COUNT(*) FROM markets x WHERE x.event_ticker=e.ticker)=1 ORDER BY e.rowid LIMIT 1");
  const evUrl = `/markets/${mk.st.toLowerCase()}/${mk.slug}/${mk.ev.toLowerCase()}`;
  assert.equal((await ada.call('POST', `/v1/users/${ada.uid}/orders`, { ticker: mk.ticker, side: 'yes', type: 'market', count: 2 })).status, 201);
  const page = await newPage();
  await uiLogIn(page, { email: email('ada') });
  // Referrals for Predictions: the Refer a friend panel disappears live and the API is refused.
  await page.goto(BASE + '/rewards');
  await page.waitForSelector('[data-testid=referrals]');
  await setFlagUi('referrals.predictions', false);
  await page.waitForSelector('[data-testid=referrals]', { state: 'hidden' });
  assert.equal((await ada.call('GET', '/v1/referrals')).code, 'feature_disabled');
  await setFlagUi('referrals.predictions', true);
  await page.waitForSelector('[data-testid=referrals]', { state: 'visible' });
  // Share links: on, the share dialog makes a signed /s/ link; off, it offers the plain page address.
  await page.goto(BASE + evUrl);
  await page.waitForSelector('#share-btn');
  await page.click('#share-btn');
  await page.waitForSelector('[data-testid=share-ready] [data-testid=share-url]');
  assert.match(await page.inputValue('[data-testid=share-ready] [data-testid=share-url]'), /\/s\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
  await page.keyboard.press('Escape');
  await setFlagUi('share_links', false);
  await page.click('#share-btn');
  await page.waitForSelector('[data-testid=share-url]');
  assert.ok(!(await page.inputValue('[data-testid=share-url]')).includes('/s/'), 'the plain address');
  await page.keyboard.press('Escape');
  await setFlagUi('share_links', true);
  // Copy trade: a shared position prefills the ticket for a visitor while on; off, the link opens the page without it.
  const link = await ada.call('POST', `/v1/users/${ada.uid}/share_links`, { kind: 'position', ticker: mk.ticker, show_price: true, show_size: false });
  assert.equal(link.status, 201, link.text);
  const visitor = await newPage({ width: 390, height: 844 });
  await visitor.goto(BASE + link.body.share_link.url_path);
  await visitor.waitForSelector('[data-testid=copy-trade-note]');
  await setFlagUi('copy_trade', false);
  await visitor.goto(BASE + link.body.share_link.url_path);
  await visitor.waitForSelector('[data-testid=submit-order]');
  await sleep(600);
  assert.equal(await visitor.locator('[data-testid=copy-trade-note]').count(), 0);
  await setFlagUi('copy_trade', true);
  // Server-rendered pages: off, the page carries no server-rendered content; on again, it does.
  assert.match((await html('/')).text, /data-ssr="1"/);
  await setFlagUi('ssr', false);
  assert.doesNotMatch((await html('/')).text, /data-ssr="1"/);
  await setFlagUi('ssr', true);
  assert.match((await html('/')).text, /data-ssr="1"/);
  // Languages: off, choosing a language is refused (English for everyone).
  await setFlagUi('i18n', false);
  assert.equal((await ada.call('PUT', `/v1/users/${ada.uid}/locale`, { locale: 'en-NG' })).code, 'feature_disabled');
  await setFlagUi('i18n', true);
  assert.equal((await ada.call('PUT', `/v1/users/${ada.uid}/locale`, { locale: 'en-NG' })).status, 200);
  // Data saver: the footer and Settings switches disappear live; the API refuses.
  await page.goto(BASE + '/account/settings');
  await page.waitForSelector('[data-testid=toggle-data_saver]');
  await page.waitForSelector('footer [data-testid=saver-toggle]');
  await setFlagUi('data_saver', false);
  await page.waitForSelector('[data-testid=toggle-data_saver]', { state: 'hidden' });
  await page.waitForSelector('footer [data-testid=saver-toggle]', { state: 'hidden' });
  assert.equal((await ada.call('PUT', `/v1/users/${ada.uid}/data_saver`, { enabled: true })).code, 'feature_disabled');
  await setFlagUi('data_saver', true);
  await page.waitForSelector('[data-testid=toggle-data_saver]', { state: 'visible' });
  // SMS (off by default): no SMS section; on, Settings offers it (with the daily cap).
  await page.goto(BASE + '/account/settings');
  await page.waitForSelector('[data-testid=toggle-data_saver]');
  assert.equal(await page.locator('[data-testid=sms-settings]').count(), 0);
  await setFlagUi('sms', true);
  await page.goto(BASE + '/account/settings');
  await page.waitForSelector('[data-testid=sms-settings]');
  assert.deepEqual(page.errors, []); assert.deepEqual(visitor.errors, []); assert.deepEqual(ap.errors, []);
});

test('Phase 8 settings from Admin › Owner settings, each seen: review threshold, share clicks, language coverage, page cache, data saver default, SMS cap (step-up)', async () => {
  // Referral review threshold: shown on Admin › Growth.
  staleAdmin();
  await setOwnerUi('referrals.review_ip_signups_per_day', 3, { expectStepUp: true });
  await ap.goto(BASE + '/admin/growth');
  await ap.waitForSelector('[data-testid=adm-ref-reviews]:has-text("3")');
  // Share clicks per IP per minute: 1 counts only the first open from this address within the minute.
  const ada = await new Client(BASE, 'ada').logIn(email('ada'), PW);
  const l = await ada.call('POST', `/v1/users/${ada.uid}/share_links`, { kind: 'market', ticker: q1("SELECT market_ticker t FROM share_links WHERE kind='position' LIMIT 1").t });
  assert.equal(l.status, 201, l.text);
  await setOwnerUi('share.clicks_per_ip_per_minute', 1);
  dbrun('UPDATE share_clicks SET ts=ts-120000'); // earlier opens from this address (the visitor above) fall out of the minute
  for (let i = 0; i < 3; i++) await fetch(BASE + l.body.share_link.url_path, { redirect: 'manual', headers: { 'user-agent': UA } });
  assert.equal(q1('SELECT clicks FROM share_links WHERE id=?', l.body.share_link.id).clicks, 1);
  // Language coverage: the Languages page states the minimum.
  await setOwnerUi('i18n.min_coverage_pct', 80);
  await ap.goto(BASE + '/admin/cms/languages');
  await ap.waitForSelector('text=80%');
  assert.equal((await admin.call('GET', '/v1/admin/i18n/locales')).body.min_coverage_pct, 80);
  // Page cache: 60 s by default (the second request is served from the cache); 0 renders every request.
  await html('/');
  assert.equal((await html('/')).headers.get('x-parlance-ssr'), 'cached');
  await setOwnerUi('ssr.cache_seconds', 0);
  await html('/');
  assert.equal((await html('/')).headers.get('x-parlance-ssr'), 'rendered');
  // Data saver default: a guest without a choice gets the lighter pages.
  const guest = await newPage({ width: 390, height: 844 });
  await guest.goto(BASE + '/');
  await guest.waitForSelector('main#view');
  assert.notEqual(await guest.evaluate(() => document.documentElement.dataset.saver), '1', 'off by default');
  await setOwnerUi('data_saver.default_on', true);
  await guest.goto(BASE + '/');
  await guest.waitForFunction(() => document.documentElement.dataset.saver === '1');
  // SMS cap: Settings states the daily limit (step-up: it bounds messages sent on the member's behalf).
  staleAdmin();
  await setOwnerUi('sms.per_user_per_day', 4, { expectStepUp: true });
  const page = await newPage();
  await uiLogIn(page, { email: email('ada') });
  await page.goto(BASE + '/account/settings');
  await page.waitForSelector('[data-testid=sms-settings]');
  assert.match(await page.textContent('[data-testid=sms-settings]'), /\b4\b/);
  assert.equal((await ada.call('GET', `/v1/users/${ada.uid}/reach`)).body.reach.sms.per_day, 4);
  // Every change is audited with its reason and shows in the setting's history.
  for (const k of ['referrals.review_ip_signups_per_day', 'share.clicks_per_ip_per_minute', 'i18n.min_coverage_pct', 'ssr.cache_seconds', 'data_saver.default_on', 'sms.per_user_per_day']) {
    assert.ok(q1("SELECT 1 x FROM admin_audit WHERE action='owner_settings.update' AND target_id=? AND reason LIKE 'owner switches e2e%'", k), `${k} audited`);
  }
  await ap.goto(BASE + '/admin/owner_settings');
  await ap.click('[data-testid=owner-setting][data-key="sms.per_user_per_day"] [data-testid=owner-edit]');
  await ap.waitForSelector('[data-testid=owner-history-row]');
  assert.match(await ap.textContent('[data-testid=owner-history-row]'), /10.*4/);
  await ap.keyboard.press('Escape');
  assert.deepEqual(guest.errors, []); assert.deepEqual(page.errors, []); assert.deepEqual(ap.errors, []);
});

test('a restart keeps every switch and setting changed above, and their effects', async () => {
  const want = { 'waitlists.confirm_link_hours': 24, 'waitlists.unconfirmed_delete_days': 1, 'waitlists.newsletter_per_minute': 6000, 'waitlists.export_includes_email': false, 'elections.pending_expiry_hours': 2, 'elections.projected_pct': 99, 'elections.rating_safe_pct': 95, 'elections.rating_lean_pct': 55, 'referrals.review_ip_signups_per_day': 3, 'share.clicks_per_ip_per_minute': 1, 'i18n.min_coverage_pct': 80, 'ssr.cache_seconds': 0, 'data_saver.default_on': true, 'sms.per_user_per_day': 4 };
  const flagsWant = { sms: true, 'waitlist.launch.cta_play': true, 'waitlist.launch.auto_confirm_verified': true, 'elections.second_resolver': true, 'referrals.predictions': true, share_links: true, copy_trade: true, ssr: true, i18n: true, data_saver: true };
  await restart();
  for (const [k, v] of Object.entries(want)) assert.equal(await ownerValue(k), v, `${k} after the restart`);
  for (const [k, v] of Object.entries(flagsWant)) assert.equal(await flagOn(k), v, `${k} after the restart`);
  // The UI shows the values, marked as changed from the recommended default.
  await ap.goto(BASE + '/admin/owner_settings');
  await ap.waitForSelector('[data-testid=owner-setting][data-key="ssr.cache_seconds"][data-value="0"]');
  assert.match(await ap.textContent('[data-testid=owner-setting][data-key="ssr.cache_seconds"]'), /Changed/i);
  // Effects: the email lifetime, the page cache off, the data saver default, the band edges.
  await guestJoin(email('late'));
  assert.match((await eventually(() => lastMail(email('late'), 'Confirm%'))).body, /24 hours/);
  await html('/');
  assert.equal((await html('/')).headers.get('x-parlance-ssr'), 'rendered');
  const g = await newPage({ width: 390, height: 844 });
  await g.goto(BASE + HUB);
  await g.waitForFunction(() => document.documentElement.dataset.saver === '1');
  await g.waitForSelector('[data-testid=el-band-edge]');
  assert.ok((await g.$$eval('[data-testid=el-band-edge]', (ns) => ns.map((n) => n.textContent.trim()))).includes('95%+'));
  assert.deepEqual(g.errors, []);
});

test('no page errors anywhere', () => {
  for (const p of allPages) assert.deepEqual(p.errors, [], p.url());
});
