'use strict';
// Content management, core and text catalog (CLONE_SPEC.md §32.2–§32.4, §32.9–§32.10). Real server + SQLite file +
// Chromium:
//   a UI string edited in Admin › Content › Texts: the draft stays invisible to users (page, public bundle, the preview
//   route refused) and shows in the staff preview; an editor cannot publish, a publisher can; the published text
//   reaches an already open page live over WebSocket, writes a hash-chained audit row and survives a restart;
//   scheduled publishing fires on time and resumes after a restart; rollback restores (UI and API);
//   an undeclared variable is refused; XSS attempts in plain and rich text are neutralised (markup refused, text
//   escaped, rich text reduced to the allowlist, script links dropped);
//   JSON export → import with a dry-run diff, then applied from the UI;
//   enforcement: no view holds hard-coded user-facing text, and a newly added literal sentence is caught.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');
const H = require('./lib/identity-helpers');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-cms-'));
const DB_FILE = path.join(TMP, 'cms.db');
const PW = 'Quartz-Lantern-Meadow-7391';
const ADMIN = { email: 'root.cms@example.test', password: 'Ledger-Keeper-Copper-2026!' };
const HIGH = { burst: 1e6, per_second: 1e6 };
const stamp = Date.now();
const D = H.db(DB_FILE);
let PORT; let BASE; let srv; let browser; let admin; let editor; let publisher; let user;
const EDITOR = { name: 'Edna Editor', email: `edna.${stamp}@example.test` };
const PUBLISHER = { name: 'Paul Publisher', email: `paul.${stamp}@example.test` };
const opts = (port) => ({ port, dbFile: DB_FILE, tickMs: 300, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, identity: { kycRequired: false }, auth: { stepUpMs: 60000 }, cms: { tickMs: 200 } });
const restart = async () => { await srv.close(); srv = await start(opts(PORT)); };
const bundle = async () => (await (await fetch(`${BASE}/v1/content/bundle`)).json());
const draft = (c, type, key, value) => c.call('PUT', `/v1/admin/cms/${type}/draft`, { key, value });
const publish = (c, type, key, extra = {}) => c.call('POST', `/v1/admin/cms/${type}/publish`, { key, reason: 'cms e2e', ...extra });
const heading = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll('.sec-head h2')].some((h) => new RegExp(src).test(h.textContent)), re.source);

async function staff(u, role) {
  const c = new Client(BASE, role);
  await c.signUp(u.email, PW, u.name);
  D.run('INSERT INTO admin_roles(user_id,role,granted_by,granted_at) VALUES(?,?,?,?)', c.uid, role, null, new Date().toISOString());
  await c.logIn(u.email, PW);
  return c;
}
async function uiLogin(u) {
  const page = await H.newPage(browser, BASE);
  await H.logInUi(page, BASE, u.email, PW);
  await page.waitForSelector('[data-testid=account-menu]');
  return page;
}
async function openTextEditor(page, key, q) {
  await page.goto(`${BASE}/admin/cms/texts?q=${encodeURIComponent(q)}`);
  await page.click(`[data-testid=cms-text-row][data-key="${key}"]`);
  await page.waitForSelector('[data-testid=cms-text-editor]');
}

before(async () => {
  PORT = await H.freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  srv = await start(opts(PORT));
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  editor = await staff(EDITOR, 'editor');
  publisher = await staff(PUBLISHER, 'publisher');
  user = new Client(BASE, 'user');
  await user.signUp(`ursula.${stamp}@example.test`, PW, 'Ursula User');
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('a UI string: draft private to staff, preview shows it, editor cannot publish, publisher can; live; audited; survives a restart', async () => {
  const visitor = await H.newPage(browser, BASE);
  await heading(visitor, /^Popular$/);

  // Editor saves a draft in Admin › Content › Texts (search, open, edit, save); no publish button for the role.
  const ed = await uiLogin(EDITOR);
  await openTextEditor(ed, 'home.render.popular', 'Popular');
  assert.match(await ed.textContent('[data-testid=cms-text-editor]'), /home · section render/);
  assert.equal(await ed.locator('[data-testid=cms-text-editor] [data-testid=cms-publish]').count(), 0, 'editors have no Publish button');
  await ed.fill('[data-testid=cms-text-value]', 'Most traded');
  await ed.click('[data-testid=cms-save-draft]');
  await H.until(() => D.q("SELECT 1 FROM cms_entries WHERE type='text' AND key='home.render.popular' AND draft_json IS NOT NULL")[0]);

  // Not visible to users: the open page, a fresh load, the public bundle; the preview route refuses non-staff.
  await H.sleep(600);
  assert.ok(await visitor.locator('.sec-head h2', { hasText: /^Popular$/ }).count(), 'open page unchanged');
  assert.ok(!JSON.stringify(await bundle()).includes('Most traded'), 'public bundle has no draft');
  assert.equal((await fetch(`${BASE}/v1/admin/cms/preview_bundle`)).status, 401, 'anonymous preview refused');
  assert.equal((await user.call('GET', '/v1/admin/cms/preview_bundle')).status, 403, 'non-staff preview refused');
  const userPage = await H.newPage(browser, BASE, { path: '/?cms_preview=1' }); // a signed-out visitor asking for preview gets the published page
  await heading(userPage, /^Popular$/);
  assert.equal(await userPage.locator('[data-testid=cms-preview-banner]').count(), 0);

  // Staff preview shows the draft in context.
  await ed.goto(`${BASE}/?cms_preview=1`);
  await ed.waitForSelector('[data-testid=cms-preview-banner]');
  await heading(ed, /^Most traded$/);

  // The editor's API publish is refused; the publisher publishes from the UI with a reason.
  const refused = await publish(editor, 'text', 'home.render.popular');
  assert.equal(refused.status, 403); assert.equal(refused.code, 'forbidden');
  const pub = await uiLogin(PUBLISHER);
  await openTextEditor(pub, 'home.render.popular', 'home.render.popular');
  assert.equal(await pub.inputValue('[data-testid=cms-text-value]'), 'Most traded', 'the editor sees the pending draft');
  await pub.click('[data-testid=cms-publish]');
  await pub.fill('[data-testid=confirm-reason]', 'Clearer heading for the home page');
  await pub.click('[data-testid=confirm-ok]');

  // Live: the visitor's open page re-renders over the `content` channel, without a reload.
  await heading(visitor, /^Most traded$/);
  const b = await bundle();
  assert.equal(b.texts['home.render.popular'], 'Most traded');
  const au = D.q("SELECT * FROM admin_audit WHERE action='cms.publish' AND target_id='home.render.popular@en-NG'")[0];
  assert.ok(au, 'audit row'); assert.equal(au.reason, 'Clearer heading for the home page'); assert.ok(au.hash && au.prev_hash);
  assert.equal(au.actor_email, PUBLISHER.email);
  assert.equal((await admin.call('GET', '/v1/admin/audit/verify')).body.ok, true, 'the audit chain verifies');
  assert.equal(D.q("SELECT COUNT(*) n FROM cms_versions WHERE key='home.render.popular' AND action='publish'")[0].n, 1);

  // Survives a restart.
  await restart();
  await visitor.reload();
  await heading(visitor, /^Most traded$/);
  for (const p of [visitor, ed, pub, userPage]) await H.assertClean(assert, p);
  await Promise.all([visitor, ed, pub, userPage].map((p) => p.context().close()));
});

test('scheduled publishing fires on time and resumes after a restart; rollback restores (API and UI)', async () => {
  const visitor = await H.newPage(browser, BASE);
  await heading(visitor, /^Most traded$/);
  // Scheduled 1.5 s ahead: not live before, live after, without a reload.
  assert.equal((await draft(publisher, 'text', 'home.render.upcoming', 'Coming up next')).status, 200);
  const at = new Date(Date.now() + 1500).toISOString();
  const s = await publish(publisher, 'text', 'home.render.upcoming', { at });
  assert.equal(s.status, 200); assert.equal(s.body.entry.scheduled.at, at);
  assert.equal((await bundle()).texts['home.render.upcoming'], undefined, 'not yet');
  await heading(visitor, /^Coming up next$/);
  assert.ok(D.q("SELECT 1 FROM cms_versions WHERE key='home.render.upcoming' AND action='scheduled_publish'")[0]);
  assert.ok(D.q("SELECT 1 FROM admin_audit WHERE action='cms.schedule' AND target_id='home.render.upcoming@en-NG'")[0]);
  // A schedule that falls due while the server is down is published when it comes back.
  await draft(publisher, 'text', 'home.render.trending', 'Hot right now');
  await publish(publisher, 'text', 'home.render.trending', { at: new Date(Date.now() + 2500).toISOString() });
  await srv.close();
  await H.sleep(2800);
  srv = await start(opts(PORT));
  await H.until(async () => (await bundle()).texts['home.render.trending'] === 'Hot right now', 5000);
  // A schedule in the past is refused.
  await draft(publisher, 'text', 'home.render.new', 'Fresh');
  assert.equal((await publish(publisher, 'text', 'home.render.new', { at: new Date(Date.now() - 60000).toISOString() })).status, 400);
  await publisher.call('DELETE', '/v1/admin/cms/text/draft?key=home.render.new');

  // Rollback (API): back to the code default (version 0), audited, live.
  await visitor.reload();
  await heading(visitor, /^Coming up next$/);
  const rb = await publisher.call('POST', '/v1/admin/cms/text/rollback', { key: 'home.render.upcoming', version: 0, reason: 'back to the default' });
  assert.equal(rb.status, 200); assert.equal(rb.body.entry.published, null);
  await heading(visitor, /^Upcoming$/);
  assert.ok(D.q("SELECT 1 FROM admin_audit WHERE action='cms.rollback' AND target_id='home.render.upcoming@en-NG'")[0]);
  // Rollback (UI): restore version 1 of the popular heading after a second publish.
  await draft(publisher, 'text', 'home.render.popular', 'Most popular');
  await publish(publisher, 'text', 'home.render.popular');
  await heading(visitor, /^Most popular$/);
  const pub = await uiLogin(PUBLISHER);
  await openTextEditor(pub, 'home.render.popular', 'home.render.popular');
  assert.ok(await pub.locator('[data-testid=cms-history] tr').count() >= 3, 'history lists both versions and the default');
  await pub.click('[data-testid=cms-rollback-1]');
  await pub.fill('[data-testid=confirm-reason]', 'The first wording tested better');
  await pub.click('[data-testid=confirm-ok]');
  await heading(visitor, /^Most traded$/);
  assert.equal(D.q("SELECT published_json FROM cms_entries WHERE key='home.render.popular'")[0].published_json, '"Most traded"');
  await H.assertClean(assert, visitor); await H.assertClean(assert, pub);
  await Promise.all([visitor, pub].map((p) => p.context().close()));
});

test('validation: undeclared variables refused; XSS in plain and rich text neutralised', async () => {
  // Declared variables only ({money0} and {events} for this key).
  const bad = await draft(publisher, 'text', 'home.render.volume_events', '{money0} traded by {secret}');
  assert.equal(bad.status, 400); assert.equal(bad.code, 'undeclared_variable');
  assert.match(bad.body.error.fields.value, /\{secret\}/);
  assert.equal((await draft(publisher, 'text', 'home.render.volume_events', '{money0} traded · {events} events')).status, 200);
  await publisher.call('DELETE', '/v1/admin/cms/text/draft?key=home.render.volume_events');
  assert.equal((await draft(publisher, 'text', 'no.such.key', 'x')).status, 400, 'unknown keys are refused');
  // The UI shows the error next to the field.
  const pub = await uiLogin(PUBLISHER);
  await openTextEditor(pub, 'home.render.volume_events', 'home.render.volume_events');
  await pub.fill('[data-testid=cms-text-value]', 'Total {nope}');
  await pub.click('[data-testid=cms-save-draft]');
  await pub.waitForSelector('[data-err-for=value]:has-text("undeclared variable")');

  // Plain text: markup and script URLs are refused; ordinary punctuation is kept and shown as text.
  for (const v of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', `java${''}script:alert(1)`, 'a <svg/onload=alert(1)>']) {
    const r = await draft(publisher, 'text', 'home.render.top_movers', v);
    assert.equal(r.status, 400, v);
  }
  const plain = `Tom & "Jerry" <3 'movers'`;
  assert.equal((await draft(publisher, 'text', 'home.render.top_movers', plain)).status, 200);
  assert.equal((await publish(publisher, 'text', 'home.render.top_movers')).status, 200);
  // Rich text: reduced to the allowlist (bold, italic, lists, links to https: or site paths).
  const rich = '<b>Bold</b> <script>window.__x=1</script><img src=x onerror="window.__x=2"><a href="javascript:window.__x=3">bad</a> <a href="https://example.com/terms" onclick="window.__x=4">ok</a> <i onmouseover="window.__x=5">it</i> <a href="/support/fees">fees</a>';
  assert.equal((await draft(publisher, 'text', 'home.rail.note', rich)).status, 200);
  const stored = JSON.parse(D.q("SELECT draft_json FROM cms_entries WHERE key='home.rail.note'")[0].draft_json);
  assert.ok(!/script|onerror|onclick|onmouseover|javascript:|<img/i.test(stored), `sanitised: ${stored}`);
  assert.equal((await publish(publisher, 'text', 'home.rail.note')).status, 200);

  const visitor = await H.newPage(browser, BASE);
  await visitor.waitForSelector('[data-testid=home-rich-note] b');
  await visitor.waitForFunction((t) => [...document.querySelectorAll('.rail-box h3')].some((h) => h.textContent.trim().startsWith(t)), plain);
  const box = await visitor.$eval('.rail-box h3 >> nth=2', (h) => ({ text: h.childNodes[0].textContent, kids: h.children.length }));
  assert.equal(box.text.trim(), plain, 'shown literally'); assert.equal(box.kids, 1, 'only the original arrow link inside');
  const note = await visitor.$eval('[data-testid=home-rich-note]', (n) => ({ html: n.innerHTML, links: [...n.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.getAttribute('rel'), a.getAttribute('onclick')]) }));
  assert.ok(!/<script|<img|onerror|onclick|onmouseover|javascript:/i.test(note.html), note.html);
  assert.deepEqual(note.links, [[null, null, null], ['https://example.com/terms', 'noopener noreferrer', null], ['/support/fees', null, null]]);
  assert.equal(await visitor.evaluate(() => window.__x), undefined, 'no injected code ran');
  await H.assertClean(assert, visitor); await H.assertClean(assert, pub);
  // Reset for the next test.
  for (const k of ['home.render.top_movers', 'home.rail.note']) await publish(publisher, 'text', k, { reset: true });
  await Promise.all([visitor, pub].map((p) => p.context().close()));
});

test('export → import round trip with a dry-run diff (API and UI); the import is validated', async () => {
  const exp = await admin.call('GET', '/v1/admin/cms/export');
  assert.equal(exp.status, 200); assert.equal(exp.body.format, 'parlance-cms');
  assert.ok(exp.body.entries.some((e) => e.key === 'home.render.popular' && e.published === 'Most traded'));
  // Change two entries, then import the export: the dry run lists exactly what it would restore (entries not in the file
  // are left alone).
  await draft(publisher, 'text', 'home.render.popular', 'Popular now'); await publish(publisher, 'text', 'home.render.popular');
  await draft(publisher, 'text', 'home.render.see_all_markets', 'Every market'); await publish(publisher, 'text', 'home.render.see_all_markets');
  const dry = await publisher.call('POST', '/v1/admin/cms/import', { data: exp.body, dry_run: true });
  assert.equal(dry.status, 200); assert.equal(dry.body.dry_run, true);
  const byKey = Object.fromEntries(dry.body.diff.map((d) => [d.key, d]));
  assert.deepEqual([byKey['home.render.popular'].change, byKey['home.render.popular'].after], ['update', 'Most traded']);
  assert.equal(byKey['home.render.see_all_markets'], undefined, 'entries absent from the file are left as they are');
  assert.equal((await bundle()).texts['home.render.popular'], 'Popular now', 'a dry run changes nothing');
  // Invalid entries fail the whole import with per-entry errors.
  const badData = { ...exp.body, entries: [...exp.body.entries, { type: 'text', key: 'home.render.popular', locale: 'en-NG', published: '<script>x</script>' }, { type: 'text', key: 'home.render.news', locale: 'en-NG', published: 'News {nope}' }] };
  const bad = await publisher.call('POST', '/v1/admin/cms/import', { data: badData, dry_run: true });
  assert.equal(bad.status, 400); assert.equal(bad.body.errors.length, 2);
  assert.equal((await editor.call('POST', '/v1/admin/cms/import', { data: exp.body, dry_run: false, reason: 'restore' })).status, 403, 'editors cannot apply');

  // UI: upload the export file, see the diff, apply with a reason.
  const file = path.join(TMP, 'export.json');
  fs.writeFileSync(file, JSON.stringify(exp.body));
  const pub = await uiLogin(PUBLISHER);
  await pub.goto(`${BASE}/admin/cms/transfer`);
  await pub.setInputFiles('[data-testid=cms-import-file]', file);
  await pub.waitForSelector('[data-testid=cms-import-summary]');
  assert.ok(await pub.locator('[data-testid=cms-import-row]', { hasText: 'home.render.popular' }).count());
  await pub.click('[data-testid=cms-import-apply]');
  await pub.fill('[data-testid=confirm-reason]', 'Restore the backup');
  await pub.click('[data-testid=confirm-ok]');
  await H.until(async () => (await bundle()).texts['home.render.popular'] === 'Most traded');
  assert.equal((await bundle()).texts['home.render.see_all_markets'], 'Every market');
  await publish(publisher, 'text', 'home.render.see_all_markets', { reset: true });
  assert.ok(D.q("SELECT COUNT(*) n FROM cms_versions WHERE action='import'")[0].n >= 1);
  assert.ok(D.q("SELECT 1 FROM admin_audit WHERE action='cms.import' AND reason='Restore the backup'")[0]);
  await H.assertClean(assert, pub);
  await pub.context().close();
});

test('enforcement: no hard-coded user-facing text in SPA modules; a new literal sentence is caught', () => {
  const { checkAll, lintText } = require('../scripts/check-text');
  const found = checkAll();
  assert.deepEqual(found.map((f) => `${f.file}:${f.line} ${f.message}`), [], 'every user-facing string comes from the catalog');
  const snippet = "import { t } from './i18n.js';\nexport function v(el) {\n  el.innerHTML = `<p class=\"muted\">Welcome back to trading</p>`;\n  toast('Your order was placed.');\n  el.title = t('home.render.popular');\n  el.querySelector('.btn-primary').classList.add('on');\n}\n";
  const msgs = lintText(snippet).map((m) => m.message);
  assert.equal(msgs.length, 2, msgs.join('\n'));
  assert.match(msgs[0], /Welcome back to trading/); assert.match(msgs[1], /Your order was placed/);
  assert.deepEqual(lintText("export const f = (el, t) => { el.textContent = t('x.y'); el.dataset.testid = 'cms-row'; return `<span>${'›'}</span>`; };"), []);
});
