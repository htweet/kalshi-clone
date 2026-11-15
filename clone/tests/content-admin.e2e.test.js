'use strict';
// Content management for every entity (owner request 2026-11-15, CLONE_SPEC.md §43), real server + SQLite file + Chromium:
//   • Admin › Content › All content lists items of every registered content type (filters by type and status);
//   • editing through the UI — a site banner and an election party with the generic form, a custom page in the CMS page
//     editor — shows up publicly; History shows the field diff; "Restore this version" brings the older content back on
//     the public site;
//   • trash from the index, from the old editor's Delete button and through the API (banner, promo card, custom page,
//     news item, help collection page): each disappears from the public site at once and is back after a restore;
//   • delete forever: an editor is refused, a publisher may; market news needs a fresh step-up;
//   • bulk trash / restore through the UI and bulk unpublish / publish through the API, with one reason;
//   • permissions: support has no access, an editor cannot restore CMS versions, a publisher cannot edit market copy,
//     promo codes are listed only for users.money;
//   • retention: an item trashed longer than the owner setting is purged at start (time travel in the database), a newer
//     one stays; revisions, the Trash and restored content survive the restart.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-content-admin-'));
const DB_FILE = path.join(TMP, 'content-admin.db');
const PW = 'Lokoja-Indigo-Ferry-4417';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const OPTS = { port: 0, dbFile: DB_FILE, quiet: true, sports: false, tickMs: 500, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH },
  elections: { seed: true } };
let srv; let BASE; let browser;
const C = {}; // API clients: admin, editor, publisher, support
const ids = {}; // invented content created below
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const pub = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => null) }; };
const ok = (r, what) => { assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`); return r.body; };
const REASON = 'content admin e2e: invented change';

async function staff(name, role) {
  const email = `${name}.${stamp}@example.test`;
  const c = await new Client(BASE, name).signUp(email, PW, `Staff ${name}`);
  dbrun('INSERT OR IGNORE INTO admin_roles(user_id,role,granted_by,granted_at) VALUES(?,?,?,?)', c.uid, role, null, new Date().toISOString());
  await c.logIn(email, PW);
  c.email = email;
  return c;
}
async function adminPage(who = ADMIN) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 } });
  const page = await ctx.newPage();
  page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', who.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
  return { ctx, page };
}
async function confirmWithReason(page, reason = REASON) {
  await page.fill('[data-testid=confirm-reason]', reason);
  await page.click('[data-testid=confirm-ok]');
  await page.waitForSelector('[data-testid=confirm-dialog]', { state: 'detached' });
}

before(async () => {
  srv = await start(OPTS);
  BASE = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
  C.admin = await new Client(BASE, 'admin').logIn(ADMIN.email, PW);
  C.editor = await staff('editor', 'editor');
  C.publisher = await staff('publisher', 'publisher');
  C.support = await staff('support', 'support');
  // One invented item of every type that has none by default.
  const post = async (p, b) => ok(await C.admin.call('POST', p, b), p);
  ids.event = dbq("SELECT ticker FROM events WHERE series_ticker NOT IN ('PLXCOMBO','PLXFLASH') ORDER BY rowid LIMIT 1")[0].ticker;
  ids.banner = (await post('/v1/admin/content/banners', { content: 'Harbour regatta markets open on Friday', link: '/browse' })).item.id;
  ids.banner2 = (await post('/v1/admin/content/banners', { content: 'Second banner for the bulk test', active: false })).item.id;
  ids.promo = (await post('/v1/admin/content/promos', { title: 'Kano kite festival', link: '/browse' })).item.id;
  ids.info = (await post('/v1/admin/content/info_cards', { title: 'Practice money only', link: '/support/faq' })).item.id;
  ids.info2 = (await post('/v1/admin/content/info_cards', { title: 'Settled by a desk', link: '/support/faq' })).item.id;
  ids.news = (await post('/v1/admin/content/news', { event_ticker: ids.event, source: 'Lagoon Ledger', published_at: new Date().toISOString(), headline: 'Ferry timetable rumours swirl', summary: 'Invented copy.' })).item.id;
  ids.help = (await post('/v1/admin/content/help', { slug: 'ci-ferry-tickets', title: 'Ferry tickets', body: 'How invented ferry tickets work.' })).item.id;
  ids.hub = (await post('/v1/admin/content/hubs', { title: 'Weather desk', category: 'Climate and Weather' })).item.id;
  ids.hub2 = (await post('/v1/admin/content/hubs', { title: 'Crypto desk', category: 'Crypto' })).item.id;
  ids.promoCode = (await post('/v1/admin/promo_codes', { code: `CI-${String(stamp).slice(-6)}`, amount_dollars: 5, description: 'Invented welcome code' })).promo_code.id;
  ok(await C.admin.call('PUT', '/v1/admin/cms/incident/draft', { key: 'ci-ferry-outage', value: { title: 'Invented API slowness', body: 'Investigating.', status: 'investigating', impact: 'degraded', components: ['api'] } }), 'incident draft');
  ok(await C.admin.call('PUT', '/v1/admin/cms/text/draft', { key: 'admin.content_index.trash.empty', value: 'Nothing in the Trash right now.' }), 'text draft');
  ok(await C.admin.call('PUT', '/v1/admin/cms/page/draft', { key: 'info/ci-ferries', value: { title: 'Ferries v1', section: 'info', body: '<p>First version.</p>' } }), 'page draft');
  ok(await C.admin.call('POST', '/v1/admin/cms/page/publish', { key: 'info/ci-ferries', reason: REASON }), 'page publish');
  ok(await C.admin.call('POST', '/v1/admin/catalog/series', { ticker: `CIDRAFT${String(stamp).slice(-4)}`, title: 'Invented draft series', category: 'Economics' }), 'draft series');
  ids.series = `CIDRAFT${String(stamp).slice(-4)}`;
});
after(async () => {
  try { await browser?.close(); } catch { /* closed */ }
  try { await srv?.close(); } catch { /* closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('All content lists items of every registered type, with type and status filters', async () => {
  const r = ok(await C.admin.call('GET', '/v1/admin/content_index?limit=500'), 'index');
  const want = ['page', 'text', 'template', 'media', 'footer', 'brand', 'incident', 'survey', 'banners', 'promos', 'info_cards', 'news', 'help', 'hubs', 'nav', 'hero', 'promo_codes',
    'catalog_series', 'catalog_events', 'catalog_markets', 'election_parties', 'election_candidates', 'election_races', 'election_elections'];
  assert.deepEqual(want.filter((t) => !r.types.some((x) => x.type === t)), [], 'every built-in type is registered');
  for (const t of r.types) {
    assert.ok(t.count > 0, `${t.type} has items`);
    const one = ok(await C.admin.call('GET', `/v1/admin/content_index?type=${t.type}&limit=5`), t.type);
    assert.ok(one.total > 0 && one.items.every((x) => x.type === t.type), `${t.type}: filtered list`);
  }
  const drafts = ok(await C.admin.call('GET', '/v1/admin/content_index?status=draft&limit=500'), 'drafts');
  assert.ok(drafts.items.some((x) => x.type === 'catalog_series' && x.key === ids.series), 'draft series listed as draft');
  assert.ok(drafts.items.some((x) => x.type === 'incident' && x.key === 'ci-ferry-outage'));
  assert.ok(drafts.items.every((x) => x.status === 'draft'));
  const hidden = ok(await C.admin.call('GET', '/v1/admin/content_index?status=hidden&type=banners'), 'hidden');
  assert.deepEqual(hidden.items.map((x) => x.key), [ids.banner2]);
  // UI: the index, the type filter and the search.
  const { ctx, page } = await adminPage();
  await page.goto(BASE + '/admin/content');
  await page.waitForSelector('[data-testid=ci-table]');
  assert.equal(await page.locator('[data-testid=ci-type] option').count(), r.types.length + 1);
  await page.selectOption('[data-testid=ci-type]', 'incident');
  await page.waitForSelector('[data-testid=ci-row][data-type=incident][data-key=ci-ferry-outage][data-status=draft]');
  await page.selectOption('[data-testid=ci-type]', '');
  await page.fill('[data-testid=ci-search]', 'kite festival');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=ci-row]').length === 1);
  await page.waitForSelector(`[data-testid=ci-row][data-type=promos][data-key="${ids.promo}"]`);
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test('edit through the UI (banner, election party, custom page) → History shows the diff → restore an older version → public site shows it', async () => {
  const { ctx, page } = await adminPage();
  // 1. Banner, with the generic form.
  await page.goto(BASE + '/admin/content/all?type=banners');
  const row = page.locator(`[data-testid=ci-row][data-type=banners][data-key="${ids.banner}"]`);
  await row.locator('[data-testid=ci-edit]').click();
  const form = page.locator('[data-testid=ci-form]');
  await form.locator('textarea[name=content]').fill('Regatta markets moved to Saturday');
  await form.locator('textarea[name=reason]').fill('date changed by the organisers');
  await form.locator('button[type=submit]').click();
  await page.waitForSelector('[data-testid=ci-dialog]', { state: 'detached' });
  let site = (await pub('/v1/site_config')).body;
  assert.equal(site.banners.find((b) => b.id === ids.banner).content, 'Regatta markets moved to Saturday');
  await page.locator(`[data-testid=ci-row][data-key="${ids.banner}"] [data-testid=ci-history-link]`).click();
  const upd = page.locator('[data-testid=ci-rev][data-action=update]').first();
  await upd.waitFor();
  assert.equal(await upd.locator('tr[data-field=content] [data-testid=ci-before]').textContent(), 'Harbour regatta markets open on Friday');
  assert.equal(await upd.locator('tr[data-field=content] [data-testid=ci-after]').textContent(), 'Regatta markets moved to Saturday');
  assert.match(await upd.textContent(), /date changed by the organisers/);
  await page.locator('[data-testid=ci-rev][data-action=create] [data-testid=ci-restore-version]').click();
  await confirmWithReason(page, 'the Friday date was right after all');
  await page.waitForSelector('[data-testid=ci-rev][data-action=restore_version]');
  site = (await pub('/v1/site_config')).body;
  assert.equal(site.banners.find((b) => b.id === ids.banner).content, 'Harbour regatta markets open on Friday');
  const revs = dbq("SELECT action, reason FROM content_revisions WHERE type='banners' AND key=? ORDER BY version", ids.banner);
  assert.deepEqual(revs.map((x) => x.action), ['create', 'update', 'restore_version']);
  assert.match(revs[2].reason, /the Friday date was right after all \(version 1\)/);
  assert.ok(dbq("SELECT 1 FROM admin_audit WHERE action='content.banners.update' AND target_id=? AND reason='date changed by the organisers'", ids.banner).length, 'audited with the reason');

  // 2. Election party name, with the generic form; the elections hub follows.
  const party = dbq("SELECT id, name FROM el_parties WHERE country='NG' ORDER BY sort, id LIMIT 1")[0];
  const slug = dbq("SELECT slug FROM el_elections WHERE country='NG' AND active=1 ORDER BY date LIMIT 1")[0].slug;
  await page.goto(BASE + `/admin/content/all?type=election_parties&q=${encodeURIComponent(party.name)}`);
  await page.locator(`[data-testid=ci-row][data-key="${party.id}"] [data-testid=ci-edit]`).click();
  await form.locator('input[name=name]').fill('Invented Unity Movement');
  await form.locator('textarea[name=reason]').fill('party renamed in the invented data');
  await form.locator('button[type=submit]').click();
  await page.waitForSelector('[data-testid=ci-dialog]', { state: 'detached' });
  assert.match(JSON.stringify((await pub(`/v1/elections/hubs/${slug}`)).body), /Invented Unity Movement/);
  await page.goto(BASE + `/admin/content/history?type=election_parties&key=${encodeURIComponent(party.id)}`);
  const pu = page.locator('[data-testid=ci-rev][data-action=update]').first();
  await pu.waitFor();
  assert.equal(await pu.locator('tr[data-field=name] [data-testid=ci-before]').textContent(), party.name);
  // The first revision of a pre-existing row records its earlier state as "before": restore it by re-applying it.
  ok(await C.admin.call('PUT', '/v1/admin/content_index/item', { type: 'election_parties', key: party.id, data: { short_name: 'IUM' }, reason: 'short name for the rename' }), 'party short name');
  await page.reload();
  await page.locator('[data-testid=ci-rev][data-action=update]').last().waitFor();
  // Restore the version right after the rename (keeps the new name, undoes the short-name change).
  const versions = await page.locator('[data-testid=ci-rev][data-action=update]').evaluateAll((els) => els.map((e) => Number(e.dataset.version)));
  const first = Math.min(...versions);
  await page.locator(`[data-testid=ci-rev][data-version="${first}"] [data-testid=ci-restore-version]`).click();
  await confirmWithReason(page, 'keep the old short name');
  await page.waitForSelector('[data-testid=ci-rev][data-action=restore_version]');
  const after = dbq('SELECT name, short_name FROM el_parties WHERE id=?', party.id)[0];
  assert.equal(after.name, 'Invented Unity Movement');
  assert.notEqual(after.short_name, 'IUM');

  // 3. Custom page in the CMS page editor (its history is the CMS store's versions, reused).
  await page.goto(BASE + '/admin/cms/pages');
  await page.click('[data-testid=cms-page-row][data-page="info/ci-ferries"]');
  await page.fill('[data-testid=cms-page-title]', 'Ferries v2');
  await page.click('[data-testid=cms-publish]');
  await confirmWithReason(page, 'second edition');
  await page.waitForSelector('[data-testid=cms-dialog]', { state: 'detached' });
  assert.equal((await pub('/v1/pages/info/ci-ferries')).body.page.title, 'Ferries v2');
  await page.goto(BASE + '/admin/content/all?type=page&q=ci-ferries');
  await page.locator('[data-testid=ci-row][data-key="info/ci-ferries"] [data-testid=ci-history-link]').click();
  const v2 = page.locator('[data-testid=ci-rev][data-version="2"]');
  await v2.waitFor();
  assert.equal(await v2.locator('tr[data-field=title] [data-testid=ci-before]').textContent(), 'Ferries v1');
  assert.equal(await v2.locator('tr[data-field=title] [data-testid=ci-after]').textContent(), 'Ferries v2');
  await page.locator('[data-testid=ci-rev][data-version="1"] [data-testid=ci-restore-version]').click();
  await confirmWithReason(page, 'back to the first edition');
  await page.waitForSelector('[data-testid=ci-rev][data-version="3"]');
  assert.equal((await pub('/v1/pages/info/ci-ferries')).body.page.title, 'Ferries v1');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test('trash (index, old editor, API) → gone from the public site at once → restore from Trash → back', async () => {
  const { ctx, page } = await adminPage();
  // Banner from the index.
  await page.goto(BASE + '/admin/content/all?type=banners');
  await page.locator(`[data-testid=ci-row][data-key="${ids.banner}"] [data-testid=ci-trash]`).click();
  await confirmWithReason(page, 'regatta postponed');
  await page.waitForSelector(`[data-testid=ci-row][data-key="${ids.banner}"][data-status=trashed]`);
  assert.ok(!(await pub('/v1/site_config')).body.banners.some((b) => b.id === ids.banner), 'banner gone at once');
  assert.equal(dbq('SELECT COUNT(*) c FROM cms_banners WHERE id=?', ids.banner)[0].c, 0);
  // Promo card from the old editor's Delete button (it now asks for a reason and moves the card to the Trash).
  assert.ok((await pub('/v1/bff/home')).body.home.promos.some((p) => p.id === ids.promo));
  await page.goto(BASE + '/admin/content/promos');
  await page.click(`[data-del="${ids.promo}"]`);
  await confirmWithReason(page, 'festival cancelled');
  await page.waitForSelector(`[data-row="${ids.promo}"]`, { state: 'detached' });
  assert.ok(!((await pub('/v1/bff/home')).body.home.promos || []).some((p) => p.id === ids.promo), 'promo gone at once');
  // Custom page, news item and help collection page through the API.
  const trash = (items, reason = REASON, who = C.admin) => who.call('POST', '/v1/admin/content_index/trash', { items, reason });
  const tr = ok(await trash([{ type: 'page', key: 'info/ci-ferries' }, { type: 'news', key: ids.news }, { type: 'help', key: ids.help }]), 'trash three');
  assert.ok(tr.results.every((x) => x.ok), JSON.stringify(tr.results));
  assert.equal((await pub('/v1/pages/info/ci-ferries')).status, 404);
  assert.ok(!((await pub(`/trade-api/v2/events/${ids.event}`)).body.event.news_items || []).some((n) => n.id === ids.news), 'news gone');
  assert.equal((await pub('/v1/help/ci-ferry-tickets')).status, 404);
  assert.ok(!(await pub('/v1/help')).body.pages.some((p) => p.slug === 'ci-ferry-tickets'));
  // Built-in content cannot go to the Trash (reset or hide instead); published market copy neither.
  const refused = ok(await trash([{ type: 'page', key: 'legal/terms' }, { type: 'catalog_events', key: ids.event }, { type: 'nav', key: 'categories' }]), 'refused');
  assert.deepEqual(refused.results.map((x) => [x.ok, x.code]), [[false, 'cannot_trash'], [false, 'cannot_trash'], [false, 'cannot_trash']]);
  // Restore: the banner from the Trash tab, the rest through the API.
  await page.goto(BASE + '/admin/content/trash');
  const trow = page.locator(`[data-testid=ci-trash-row][data-type=banners][data-key="${ids.banner}"]`);
  await trow.locator('[data-testid=ci-trash-restore]').click();
  await confirmWithReason(page, 'regatta back on');
  await trow.waitFor({ state: 'detached' });
  assert.ok((await pub('/v1/site_config')).body.banners.some((b) => b.id === ids.banner), 'banner back');
  const rows = dbq("SELECT id, type FROM content_trash WHERE type IN ('promos','page','news','help')");
  assert.equal(rows.length, 4);
  const back = ok(await C.admin.call('POST', '/v1/admin/content_index/trash/restore', { ids: rows.map((x) => x.id), reason: 'restore after review' }), 'restore');
  assert.ok(back.results.every((x) => x.ok), JSON.stringify(back.results));
  assert.ok((await pub('/v1/bff/home')).body.home.promos.some((p) => p.id === ids.promo), 'promo back');
  assert.equal((await pub('/v1/pages/info/ci-ferries')).body.page.title, 'Ferries v1', 'page back with its published version');
  assert.ok((await pub(`/trade-api/v2/events/${ids.event}`)).body.event.news_items.some((n) => n.id === ids.news), 'news back');
  assert.equal((await pub('/v1/help/ci-ferry-tickets')).status, 200);
  const actions = dbq("SELECT action FROM content_revisions WHERE type='news' AND key=? ORDER BY version", ids.news).map((x) => x.action);
  assert.deepEqual(actions.slice(-2), ['trash', 'restore']);
  assert.ok(dbq("SELECT 1 FROM admin_audit WHERE action='content_admin.trash' AND target_id=? AND reason='regatta postponed'", ids.banner).length);
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test('delete forever: editor refused, publisher allowed; market news needs a fresh step-up', async () => {
  const trash = (type, key) => C.admin.call('POST', '/v1/admin/content_index/trash', { items: [{ type, key }], reason: REASON });
  ok(await trash('banners', ids.banner2), 'trash banner2');
  ok(await trash('news', ids.news), 'trash news');
  const idOf = (type, key) => dbq('SELECT id FROM content_trash WHERE type=? AND key=?', type, key)[0].id;
  const b2 = idOf('banners', ids.banner2); const nw = idOf('news', ids.news);
  // The editor sees the Trash but cannot delete for good (content.publish).
  const et = ok(await C.editor.call('GET', '/v1/admin/content_index/trash'), 'editor trash');
  assert.equal(et.items.find((x) => x.id === b2).can_purge, false);
  const refused = await C.editor.call('POST', '/v1/admin/content_index/trash/purge', { ids: [b2], reason: 'editor tries' });
  assert.equal(refused.status, 403);
  assert.equal(dbq('SELECT COUNT(*) c FROM content_trash WHERE id=?', b2)[0].c, 1);
  // The publisher can.
  const done = ok(await C.publisher.call('POST', '/v1/admin/content_index/trash/purge', { ids: [b2], reason: 'never needed again' }), 'publisher purge');
  assert.ok(done.results[0].ok);
  assert.equal(dbq('SELECT COUNT(*) c FROM content_trash WHERE id=?', b2)[0].c, 0);
  assert.equal(dbq("SELECT action FROM content_revisions WHERE type='banners' AND key=? ORDER BY version DESC LIMIT 1", ids.banner2)[0].action, 'purge');
  assert.ok(dbq("SELECT 1 FROM admin_audit WHERE action='content_admin.purge' AND target_id=? AND reason='never needed again'", ids.banner2).length);
  // Market news: a stale session is asked to step up first, then may delete.
  assert.equal(ok(await C.publisher.call('GET', '/v1/admin/content_index/trash'), 'trash').items.find((x) => x.id === nw).step_up, true);
  dbrun('UPDATE sessions SET auth_at=? WHERE user_id=?', Date.now() - 3600000, C.publisher.uid);
  const stale = await C.publisher.call('POST', '/v1/admin/content_index/trash/purge', { ids: [nw], reason: 'duplicate story' });
  assert.equal(stale.status, 403); assert.equal(stale.code, 'step_up_required');
  assert.equal(dbq('SELECT COUNT(*) c FROM content_trash WHERE id=?', nw)[0].c, 1, 'nothing deleted without the step-up');
  ok(await C.publisher.call('POST', '/v1/step_up', { password: PW }), 'step up');
  ok(await C.publisher.call('POST', '/v1/admin/content_index/trash/purge', { ids: [nw], reason: 'duplicate story' }), 'purge after step-up');
  assert.equal(dbq('SELECT COUNT(*) c FROM cms_news WHERE id=?', ids.news)[0].c, 0);
  assert.equal(dbq('SELECT COUNT(*) c FROM content_trash WHERE id=?', nw)[0].c, 0);
});

test('bulk: trash and restore several items in the UI with one reason; unpublish and publish through the API', async () => {
  const { ctx, page } = await adminPage();
  await page.goto(BASE + '/admin/content/all?type=info_cards');
  for (const id of [ids.info, ids.info2]) await page.locator(`[data-testid=ci-row][data-key="${id}"] [data-testid=ci-select]`).check();
  await page.click('[data-testid=ci-bulk-trash]');
  await confirmWithReason(page, 'cards replaced by the new home');
  await page.waitForSelector(`[data-testid=ci-row][data-key="${ids.info}"][data-status=trashed]`);
  assert.equal(dbq('SELECT COUNT(*) c FROM cms_info_cards WHERE id IN (?,?)', ids.info, ids.info2)[0].c, 0);
  assert.equal((await pub('/v1/bff/home')).body.home.info_cards, null, 'no info cards on the home page');
  assert.equal(dbq("SELECT COUNT(*) c FROM content_trash WHERE type='info_cards' AND reason='cards replaced by the new home'")[0].c, 2);
  await page.selectOption('[data-testid=ci-status]', 'trashed');
  await page.waitForSelector(`[data-testid=ci-row][data-key="${ids.info2}"][data-status=trashed]`);
  for (const id of [ids.info, ids.info2]) await page.locator(`[data-testid=ci-row][data-key="${id}"] [data-testid=ci-select]`).check();
  await page.click('[data-testid=ci-bulk-restore]');
  await confirmWithReason(page, 'kept after all');
  await page.waitForFunction(() => !document.querySelector('[data-testid=ci-row][data-type=info_cards]'));
  assert.equal((await pub('/v1/bff/home')).body.home.info_cards.length, 2);
  assert.deepEqual(page.errors, []);
  await ctx.close();
  // Unpublish / publish (Admin › Content collections: the active switch).
  const un = ok(await C.editor.call('POST', '/v1/admin/content_index/bulk', { action: 'unpublish', items: [{ type: 'info_cards', key: ids.info }, { type: 'hubs', key: ids.hub }], reason: 'seasonal pause' }), 'unpublish');
  assert.deepEqual(un.results.map((x) => [x.ok, x.status]), [[true, 'hidden'], [true, 'hidden']]);
  assert.deepEqual((await pub('/v1/bff/home')).body.home.info_cards.map((x) => x.id), [ids.info2]);
  const re = ok(await C.editor.call('POST', '/v1/admin/content_index/bulk', { action: 'publish', items: [{ type: 'info_cards', key: ids.info }, { type: 'page', key: 'legal/terms' }], reason: 'season back' }), 'publish');
  assert.equal(re.results[0].ok, true);
  assert.equal(re.results[1].ok, false, 'an editor cannot publish CMS pages'); assert.equal(re.results[1].http, 403);
  assert.equal((await pub('/v1/bff/home')).body.home.info_cards.length, 2);
  const missingReason = await C.editor.call('POST', '/v1/admin/content_index/bulk', { action: 'trash', items: [{ type: 'hubs', key: ids.hub }] });
  assert.equal(missingReason.status, 400);
});

test('permissions: support has no access; editor cannot restore CMS versions; publisher cannot edit market copy; promo codes need users.money', async () => {
  assert.equal((await C.support.call('GET', '/v1/admin/content_index')).status, 403);
  assert.equal((await C.support.call('POST', '/v1/admin/content_index/trash', { items: [{ type: 'hubs', key: ids.hub }], reason: REASON })).status, 403);
  const { ctx, page } = await adminPage({ email: C.support.email });
  await page.goto(BASE + '/admin/content/all');
  await page.waitForSelector('[data-testid=section-forbidden]');
  await ctx.close();
  const cmsRev = dbq("SELECT id FROM cms_versions WHERE type='page' AND key='info/ci-ferries' AND version=1")[0].id;
  const er = await C.editor.call('POST', '/v1/admin/content_index/history/restore', { revision: `c:${cmsRev}`, reason: 'editor rollback' });
  assert.equal(er.status, 403);
  const editorTypes = ok(await C.editor.call('GET', '/v1/admin/content_index?type=promo_codes'), 'editor index').types.map((x) => x.type);
  assert.ok(!editorTypes.includes('promo_codes') && editorTypes.includes('catalog_series'));
  const pubTypes = ok(await C.publisher.call('GET', '/v1/admin/content_index?limit=1'), 'publisher index').types.map((x) => x.type);
  assert.ok(pubTypes.includes('catalog_markets'), 'the publisher reads market copy (catalog.read)');
  const market = dbq("SELECT ticker, title FROM markets WHERE event_ticker=? LIMIT 1", ids.event)[0];
  assert.equal((await C.publisher.call('PUT', '/v1/admin/content_index/item', { type: 'catalog_markets', key: market.ticker, data: { title: 'Nope' }, reason: 'publisher edit' })).status, 403);
  // The editor (catalog.write) edits market copy: title only, never prices or state.
  ok(await C.editor.call('PUT', '/v1/admin/content_index/item', { type: 'catalog_markets', key: market.ticker, data: { title: `${market.title} (edited)`, last_price: 99 }, reason: 'clearer title' }), 'editor market copy');
  assert.equal(dbq('SELECT title FROM markets WHERE ticker=?', market.ticker)[0].title, `${market.title} (edited)`);
  assert.equal(dbq("SELECT action FROM content_revisions WHERE type='catalog_markets' AND key=? ORDER BY version DESC LIMIT 1", market.ticker)[0].action, 'update');
  // Promo codes: the admin edits the description; a redeemed code could not be trashed, an unused one can.
  ok(await C.admin.call('PUT', '/v1/admin/content_index/item', { type: 'promo_codes', key: ids.promoCode, data: { description: 'Invented welcome code, edited' }, reason: 'wording' }), 'promo description');
  assert.equal(dbq('SELECT description FROM promo_codes WHERE id=?', ids.promoCode)[0].description, 'Invented welcome code, edited');
  assert.equal((await C.editor.call('PUT', '/v1/admin/content_index/item', { type: 'promo_codes', key: ids.promoCode, data: { description: 'x' }, reason: 'editor tries' })).status, 403);
});

test('retention: items older than the owner setting are purged at start; revisions, Trash and restored content survive a restart', async () => {
  const trash = (type, key) => C.admin.call('POST', '/v1/admin/content_index/trash', { items: [{ type, key }], reason: 'retention check' });
  ok(await trash('hubs', ids.hub), 'old hub'); ok(await trash('hubs', ids.hub2), 'new hub');
  const s = ok(await C.admin.call('GET', '/v1/admin/owner_settings/content.trash_retention_days'), 'setting');
  assert.equal(s.setting.value, 30); assert.equal(s.setting.default, 30);
  dbrun("UPDATE content_trash SET deleted_at=? WHERE type='hubs' AND key=?", Date.now() - 31 * 86400000, ids.hub); // time travel: trashed 31 days ago
  dbrun("UPDATE content_trash SET deleted_at=? WHERE type='hubs' AND key=?", Date.now() - 29 * 86400000, ids.hub2);
  const revisions = dbq('SELECT COUNT(*) c FROM content_revisions')[0].c;
  await srv.close();
  srv = await start({ ...OPTS, port: 0 });
  BASE = `http://127.0.0.1:${srv.port}`;
  assert.equal(dbq("SELECT COUNT(*) c FROM content_trash WHERE type='hubs' AND key=?", ids.hub)[0].c, 0, 'purged after 30 days');
  assert.equal(dbq("SELECT COUNT(*) c FROM content_trash WHERE type='hubs' AND key=?", ids.hub2)[0].c, 1, 'still restorable at 29 days');
  const last = dbq("SELECT action, actor_email, reason FROM content_revisions WHERE type='hubs' AND key=? ORDER BY version DESC LIMIT 1", ids.hub)[0];
  assert.equal(last.action, 'purge'); assert.equal(last.actor_email, 'system@parlance.local'); assert.match(last.reason, /30 days/);
  assert.equal(dbq('SELECT COUNT(*) c FROM content_revisions')[0].c, revisions + 1, 'revisions kept across the restart');
  // Restored content and history are still there.
  assert.equal((await pub('/v1/pages/info/ci-ferries')).body.page.title, 'Ferries v1');
  assert.ok((await pub('/v1/site_config')).body.banners.some((b) => b.id === ids.banner && b.content === 'Harbour regatta markets open on Friday'));
  const admin = await new Client(BASE, 'admin2').logIn(ADMIN.email, PW);
  const h = ok(await admin.call('GET', `/v1/admin/content_index/history?type=banners&key=${ids.banner}`), 'history');
  assert.ok(h.revisions.some((r) => r.action === 'restore_version'));
  const t = ok(await admin.call('GET', '/v1/admin/content_index/trash'), 'trash');
  assert.ok(t.items.some((x) => x.key === ids.hub2 && Date.parse(x.purge_at) > Date.now()));
  ok(await admin.call('POST', '/v1/admin/content_index/trash/restore', { ids: [t.items.find((x) => x.key === ids.hub2).id], reason: 'back for the season' }), 'restore hub2');
  assert.ok((await pub('/v1/bff/home')).body.home.hubs.some((x) => x.title === 'Crypto desk'));
});
