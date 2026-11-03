'use strict';
// End-to-end browser tests for Group chats (PLAN §11 A11; PHASE2_SPEC.md §24.7): groups started from mutual follows
// and the Inner Circle, live delivery over the private `groups` channel to three browsers, unread counts, coalesced
// notifications, replies, stickers, members (add / owner-only remove / rename / leave with owner hand-over), the same
// safety model as event chat (report → admin queue → live delete, moderator lock, mute, posting ban, rate limits,
// validation, plain-text rendering), audited moderator views, restart persistence and the 390px layout.
// Real server + SQLite file + Chromium; four users in separate browser contexts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-groups-'));
const DB_FILE = path.join(TMP, 'groups.db');
const PORT = 20000 + Math.floor(Math.random() * 40000);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'Quartz-Lantern-Meadow-7391'; // secret-scan:allow (throwaway E2E account password)
const stamp = Date.now();
const HIGH = { burst: 1e6, per_second: 1e6 };
const ADMIN = { email: `groot.${stamp}@example.test`, password: PW };
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, quiet: true, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, admin: ADMIN };
const sfx = String(stamp % 100000);
const U = Object.fromEntries(['amy', 'bo', 'cy', 'di'].map((n) => [n[0], { email: `g.${n}.${stamp}@example.test`, nick: `${n}_${sfx}` }]));
const XSS = '<img src=x onerror="window.__xss=1"><b>bold</b>';

let srv; let browser; let gid;
const api = {};
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(100); }
}
const show = (r) => `${r.status} ${r.text ? r.text.slice(0, 300) : ''}`;
async function newPage(viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => { (window.__cspv ||= []).push(`${e.violatedDirective} ${e.blockedURI}`); }));
  return page;
}
async function logIn(page, email) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
const msg = (page, text) => page.locator('[data-testid=group-msg]', { has: page.locator('[data-testid=group-body]', { hasText: text }) });
async function send(page, text) { await page.fill('[data-testid=group-input]', text); await page.press('[data-testid=group-input]', 'Enter'); }
const P = {};

before(async () => {
  srv = await start(OPTS);
  browser = await chromium.launch();
  for (const k of ['a', 'b', 'c', 'd']) {
    api[k] = await new Client(BASE, k).signUp(U[k].email, PW, `Group ${k.toUpperCase()}${k}`);
    assert.equal((await api[k].call('POST', `/v1/users/${api[k].uid}/social/profile`, { nickname: U[k].nick })).status, 201);
  }
  api.admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  // A ↔ B mutual follow; A — C Inner Circle; D follows A one way only.
  const { a, b, c, d } = api;
  for (const [x, y] of [[a, U.b], [b, U.a], [d, U.a]]) assert.equal((await x.call('POST', `/v1/users/${x.uid}/social/follow`, { nickname: y.nick })).status, 200);
  const rq = await a.call('POST', `/v1/users/${a.uid}/social/circle/requests`, { nickname: U.c.nick });
  assert.equal((await c.call('POST', `/v1/users/${c.uid}/social/circle/requests/${rq.body.request.id}/accept`, {})).status, 200);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('create from mutual follows and the Inner Circle; live delivery to three browsers, unread counts, replies, stickers', async () => {
  const { a, c, d } = api;
  P.a = await newPage(); P.b = await newPage(); P.c = await newPage();
  await logIn(P.a, U.a.email); await logIn(P.b, U.b.email); await logIn(P.c, U.c.email);
  await P.a.goto(BASE + '/messages');
  await P.a.locator('[data-testid=no-groups]').waitFor();
  await P.a.click('[data-testid=new-group]');
  await P.a.locator('[data-testid=new-group-candidate]').first().waitFor();
  const cands = await P.a.$$eval('[data-testid=new-group-candidate] input', (xs) => xs.map((x) => x.value).sort());
  assert.deepEqual(cands, [U.b.nick, U.c.nick].sort(), 'only mutual follows and Inner Circle members are offered');
  for (const n of [U.b.nick, U.c.nick]) await P.a.check(`[data-testid=new-group-candidate] input[value="${n}"]`);
  await P.a.fill('[data-testid=new-group-name]', 'Rate desk');
  await P.a.click('[data-testid=new-group-create]');
  await P.a.waitForURL(/\/messages\/grp_/);
  gid = P.a.url().split('/').pop();
  await P.a.locator('[data-testid=group-system]', { hasText: 'created the group' }).waitFor();
  assert.deepEqual(dbq('SELECT role FROM chat_group_members WHERE group_id=? ORDER BY role', gid).map((r) => r.role), ['member', 'member', 'owner']);
  // B opens the conversation, C stays on the list.
  await P.b.goto(`${BASE}/messages/${gid}`);
  await P.b.locator('[data-testid=group-title]:has-text("Rate desk")').waitFor();
  await P.c.goto(BASE + '/messages');
  await P.c.locator(`[data-testid=group-item][data-group="${gid}"]`).waitFor();
  await send(P.a, 'hello team');
  await msg(P.b, 'hello team').waitFor(); // live, no reload
  await P.c.locator(`[data-testid=group-item][data-group="${gid}"] [data-testid=group-unread]:has-text("1")`).waitFor();
  await send(P.a, 'second line');
  await P.c.locator(`[data-testid=group-item][data-group="${gid}"] [data-testid=group-unread]:has-text("2")`).waitFor();
  // Notifications: "added you" + one per unread burst (the second message does not notify again).
  const cn = () => dbq("SELECT title FROM notifications WHERE user_id=? AND type='group_chat' ORDER BY created_ts", c.uid).map((r) => r.title);
  await until(() => cn().length === 2, 5000, 'C group notifications');
  assert.match(cn()[0], /added you to Rate desk/);
  assert.match(cn()[1], new RegExp(`@${U.a.nick} in Rate desk`));
  // Reading resets the burst: C opens the chat, A writes again → one more notification.
  await P.c.click(`[data-testid=group-item][data-group="${gid}"]`);
  await msg(P.c, 'second line').waitFor();
  await until(() => dbq('SELECT last_read_seq s FROM chat_group_members WHERE group_id=? AND user_id=?', gid, c.uid)[0].s >= dbq('SELECT MAX(seq) s FROM chat_group_messages WHERE group_id=?', gid)[0].s, 4000, 'C read');
  await P.c.goto(BASE + '/messages'); // back to the list
  await P.c.locator(`[data-testid=group-item][data-group="${gid}"]`).waitFor();
  await send(P.a, 'third line');
  await until(() => cn().length === 3, 5000, 'C notified again after reading');
  // B replies to A's message with a quote; B sends a sticker.
  await msg(P.b, 'hello team').hover();
  await msg(P.b, 'hello team').locator('[data-testid=group-reply]').click();
  await send(P.b, 'replying to hello');
  await msg(P.a, 'replying to hello').locator('[data-testid=group-quote]').waitFor();
  assert.match(await msg(P.a, 'replying to hello').locator('[data-testid=group-quote]').textContent(), /hello team/);
  await P.b.click('[data-testid=group-sticker-btn]');
  await P.b.click('[data-testid=sticker-opt-rocket]');
  await P.a.locator('[data-testid=group-sticker][src="/v1/social/stickers/rocket.svg"]').waitFor();
  // Refusals: not connected (D only follows A), unknown nickname, empty member list.
  let r = await a.call('POST', `/v1/users/${a.uid}/groups/${gid}/members`, { nicknames: [U.d.nick] });
  assert.deepEqual([r.status, r.code], [409, 'cannot_add_member']);
  r = await a.call('POST', `/v1/users/${a.uid}/groups/${gid}/members`, { nicknames: ['nobody_at_all_x'] });
  assert.deepEqual([r.status, r.code], [409, 'cannot_add_member'], 'unknown and unconnected look the same');
  r = await a.call('POST', `/v1/users/${a.uid}/groups`, { name: 'Empty', members: [] });
  assert.equal(r.status, 400);
  r = await d.call('POST', `/v1/users/${d.uid}/groups`, { name: 'Pushy', members: [U.a.nick] });
  assert.deepEqual([r.status, r.code], [409, 'cannot_add_member']);
  assert.deepEqual([...P.a.errors, ...P.b.errors, ...P.c.errors], []);
});

test('members: add when connected, owner-only remove (live "removed"), rename live, leave hands ownership over', async () => {
  const { a, b, d } = api;
  // A follows D back → mutual → A adds D from the members dialog.
  assert.equal((await a.call('POST', `/v1/users/${a.uid}/social/follow`, { nickname: U.d.nick })).status, 200);
  P.d = await newPage(); await logIn(P.d, U.d.email);
  await P.d.goto(BASE + '/messages');
  await P.d.locator('[data-testid=no-groups]').waitFor();
  await P.a.click('[data-testid=group-members-btn]');
  await P.a.locator(`[data-testid=group-candidate] input[value="${U.d.nick}"]`).check();
  await P.a.click('[data-testid=group-add-submit]');
  await P.d.locator(`[data-testid=group-item][data-group="${gid}"]`).waitFor(); // live list refresh
  await P.d.click(`[data-testid=group-item][data-group="${gid}"]`);
  await msg(P.d, 'hello team').waitFor(); // history is visible to new members
  // B (not owner) cannot remove; A removes D → D's open conversation says so, live; D gets 404 afterwards.
  let r = await b.call('DELETE', `/v1/users/${b.uid}/groups/${gid}/members/${U.d.nick}`);
  assert.deepEqual([r.status, r.code], [403, 'not_group_owner']);
  await P.a.locator('[data-testid=group-members-btn]:has-text("4 members")').waitFor();
  await P.a.click('[data-testid=group-members-btn]');
  await P.a.locator(`[data-testid=group-member][data-nick="${U.d.nick}"] [data-testid=group-remove]`).click();
  await P.d.locator('[data-testid=group-removed]').waitFor();
  assert.equal((await d.call('GET', `/v1/users/${d.uid}/groups/${gid}`)).status, 404);
  const ds = d.socket(); await ds.opened; await ds.subscribe(['groups']);
  await send(P.a, 'after D left');
  await msg(P.b, 'after D left').waitFor();
  await sleep(300);
  assert.equal(ds.messages.filter((m) => m.type === 'group_message').length, 0, 'removed members receive nothing');
  ds.close();
  // Rename (owner) → live title for B.
  await P.a.click('[data-testid=group-members-btn]');
  await P.a.fill('[data-testid=group-rename-input]', 'Rate desk 2');
  await P.a.click('[data-testid=group-rename]');
  await P.b.locator('[data-testid=group-title]:has-text("Rate desk 2")').waitFor();
  // A leaves → the longest-standing member (B) becomes owner; A gets 404.
  await P.a.click('[data-testid=group-members-btn]');
  await P.a.click('[data-testid=group-leave]');
  await P.a.waitForURL(/\/messages$/);
  await until(() => dbq("SELECT u.email FROM chat_group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND m.role='owner'", gid)[0]?.email === U.b.email, 4000, 'owner hand-over');
  assert.equal((await a.call('GET', `/v1/users/${a.uid}/groups/${gid}`)).status, 404);
  await P.b.locator('[data-testid=group-system]', { hasText: 'left the group' }).waitFor();
  assert.deepEqual([...P.a.errors, ...P.b.errors, ...P.d.errors], []);
  await P.d.context().close();
});

test('safety: report → admin queue → live delete; moderator lock (audited view); mute; posting ban; rate limit; validation; text-only rendering', async () => {
  const { b, c } = api;
  await P.c.goto(`${BASE}/messages/${gid}`);
  await P.c.locator('[data-testid=group-title]').waitFor();
  // B posts a message with markup; C sees it as text.
  let r = await b.call('POST', `/v1/users/${b.uid}/groups/${gid}/messages`, { body: `Shady link ${XSS}` });
  assert.equal(r.status, 201, show(r));
  const bad = r.body.message.id;
  await msg(P.c, 'Shady link').waitFor();
  assert.ok((await msg(P.c, 'Shady link').locator('[data-testid=group-body]').textContent()).includes('<img src=x'));
  assert.equal(await P.c.locator('[data-testid=group-messages] img[src="x"], [data-testid=group-body] b').count(), 0);
  assert.equal(await P.c.evaluate(() => window.__xss), undefined);
  // C reports it from the ⋯ menu.
  await msg(P.c, 'Shady link').hover();
  await msg(P.c, 'Shady link').locator('[data-testid=group-more]').click();
  await P.c.click('[data-testid=group-report-0]');
  await until(() => dbq("SELECT COUNT(*) c FROM mod_reports WHERE kind='group' AND content_id=? AND status='open'", bad)[0].c === 1, 4000, 'group report');
  const rid = dbq("SELECT id FROM mod_reports WHERE kind='group' AND content_id=?", bad)[0].id;
  r = await api.admin.call('GET', '/v1/admin/moderation/reports');
  const row = r.body.reports.find((x) => x.id === rid);
  assert.deepEqual([row.kind, row.content_exists, row.group_id], ['group', true, gid]);
  r = await api.admin.call('POST', `/v1/admin/moderation/reports/${rid}/delete`, { reason: 'phishing' });
  assert.equal(r.status, 200, show(r));
  await msg(P.c, 'Shady link').waitFor({ state: 'detached' }); // live removal
  assert.equal(dbq('SELECT mod_state FROM chat_group_messages WHERE id=?', bad)[0].mod_state, 'moderator_removed');
  assert.equal(dbq('SELECT status FROM mod_reports WHERE id=?', rid)[0].status, 'actioned');
  // Moderator opens the group in Admin › Community (audited), locks it → composer disabled live; API refuses sends.
  const pm = await newPage(); await logIn(pm, ADMIN.email);
  await pm.goto(`${BASE}/admin/community/groups/${gid}`);
  await pm.locator('[data-testid=adm-group-name]:has-text("Rate desk 2")').waitFor();
  assert.ok(await pm.locator('[data-testid=adm-group-messages] [data-id] >> text=moderator removed').count() >= 1);
  await pm.click('[data-testid=adm-group-lock]');
  await pm.fill('[data-testid=confirm-reason]', 'cooling off');
  await pm.click('[data-testid=confirm-ok]');
  await P.c.locator('[data-testid=group-locked]').waitFor();
  assert.equal(await P.c.locator('[data-testid=group-input]').isDisabled(), true);
  r = await c.call('POST', `/v1/users/${c.uid}/groups/${gid}/messages`, { body: 'during lock' });
  assert.deepEqual([r.status, r.code], [403, 'group_locked']);
  assert.equal((await api.admin.call('POST', `/v1/admin/groups/${gid}/unlock`, { reason: 'ok again' })).status, 200);
  await P.c.locator('[data-testid=group-locked]').waitFor({ state: 'detached' });
  const actions = dbq("SELECT action FROM admin_audit WHERE target_type='group' AND target_id=?", gid).map((x) => x.action);
  for (const x of ['group.view', 'group.delete', 'group.lock', 'group.unlock']) assert.ok(actions.includes(x), x);
  // Non-moderators get 403 on the admin routes.
  assert.equal((await b.call('GET', `/v1/admin/groups/${gid}`)).status, 403);
  // Mute: C mutes B; B's messages disappear for C, new ones do not arrive and are not counted.
  await msg(P.c, 'replying to hello').hover();
  await msg(P.c, 'replying to hello').locator('[data-testid=group-more]').click();
  await P.c.click('[data-testid=group-mute]');
  await msg(P.c, 'replying to hello').waitFor({ state: 'detached' });
  assert.equal((await b.call('POST', `/v1/users/${b.uid}/groups/${gid}/messages`, { body: 'muted words' })).status, 201);
  await sleep(600);
  assert.equal(await msg(P.c, 'muted words').count(), 0);
  assert.ok(!(await c.call('GET', `/v1/users/${c.uid}/groups/${gid}`)).body.messages.some((m) => m.body === 'muted words'));
  assert.equal((await c.call('DELETE', `/v1/users/${c.uid}/social/mutes?nickname=${U.b.nick}`)).status, 200);
  // Validation: length, control characters, foreign reply_to, unknown fields, bad name.
  for (const body of ['x'.repeat(501), 'line\nbreak', `rtl ${String.fromCodePoint(0x202e)}`, '   ']) {
    r = await c.call('POST', `/v1/users/${c.uid}/groups/${gid}/messages`, { body });
    assert.equal(r.status, 400, `${JSON.stringify(body.slice(0, 20))}: ${show(r)}`);
  }
  r = await c.call('POST', `/v1/users/${c.uid}/groups/${gid}/messages`, { body: 'ok', reply_to: 'gm_not-in-this-group' });
  assert.equal(r.status, 400);
  r = await c.call('POST', `/v1/users/${c.uid}/groups/${gid}/messages`, { body: 'ok', user_id: b.uid });
  assert.deepEqual([r.status, r.code], [400, 'validation_failed']);
  r = await b.call('PUT', `/v1/users/${b.uid}/groups/${gid}`, { name: 'n'.repeat(51) });
  assert.equal(r.status, 400);
  // Rate limit (per user): a burst is refused with 429 + retry_after_sec + Retry-After.
  let limited = null;
  for (let i = 0; i < 15 && !limited; i++) { const x = await c.call('POST', `/v1/users/${c.uid}/groups/${gid}/messages`, { body: `burst ${i}` }); if (x.status === 429) limited = x; }
  assert.ok(limited, 'burst must be rate-limited');
  assert.ok(limited.body.error.retry_after_sec >= 1 && Number(limited.headers.get('retry-after')) >= 1);
  // Posting ban (same ban as posts and event chat).
  assert.equal((await api.admin.call('POST', `/v1/admin/moderation/users/${b.uid}/ban`, { reason: 'spam in groups' })).status, 200);
  r = await b.call('POST', `/v1/users/${b.uid}/groups/${gid}/messages`, { body: 'banned now' });
  assert.deepEqual([r.status, r.code], [403, 'posting_banned']);
  assert.equal((await api.admin.call('POST', `/v1/admin/moderation/users/${b.uid}/unban`, { reason: 'appeal ok' })).status, 200);
  assert.deepEqual([...P.c.errors, ...pm.errors], []);
  await pm.context().close();
});

test('restart keeps groups, members, messages and read state; 390px list and conversation without overflow or CSP violations', async () => {
  const { b } = api;
  const before = dbq('SELECT (SELECT COUNT(*) FROM chat_groups) g, (SELECT COUNT(*) FROM chat_group_members) m, (SELECT COUNT(*) FROM chat_group_messages) x')[0];
  for (const k of Object.keys(P)) { try { await P[k].context().close(); } catch { /* closed */ } }
  await srv.close();
  srv = await start(OPTS);
  assert.deepEqual(dbq('SELECT (SELECT COUNT(*) FROM chat_groups) g, (SELECT COUNT(*) FROM chat_group_members) m, (SELECT COUNT(*) FROM chat_group_messages) x')[0], before);
  await b.logIn(U.b.email, PW);
  const r = await b.call('GET', `/v1/users/${b.uid}/groups/${gid}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.group.role, 'owner');
  assert.ok(r.body.messages.some((m) => m.body === 'hello team'));
  for (const theme of ['dark', 'light']) {
    const p = await newPage({ width: 390, height: 844 });
    await logIn(p, U.b.email);
    for (const u of ['/messages', `/messages/${gid}`]) {
      await p.goto(BASE + u);
      await p.waitForSelector(u === '/messages' ? '[data-testid=group-item]' : '[data-testid=group-title]');
      if (theme === 'light') await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${u} (${theme}) overflows by ${overflow}px`);
    }
    // Phone: the conversation replaces the list, with a back link.
    assert.equal(await p.locator('.group-side').isVisible(), false);
    assert.equal(await p.locator('.group-back').isVisible(), true);
    await p.click('[data-testid=group-members-btn]');
    await p.locator('[data-testid=group-members-dialog]').waitFor();
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(ov <= 1, `members dialog overflows by ${ov}px`);
    assert.deepEqual(p.errors, []);
    assert.deepEqual(await p.evaluate(() => window.__cspv || []), []);
    await p.context().close();
  }
});
