'use strict';
// Social and community completion (PLAN Phase 2: P2.1–P2.4, gaps G3, G8, G10; PHASE2_SPEC.md §24). Real server + SQLite
// file + Chromium, two (or three) users in separate browser contexts, DB assertions, restart persistence, 390px layout,
// no page errors and no CSP violations. Security gate (PLAN §6): IDOR with a second user, XSS on every new text field,
// rate limits on new writes, CSRF, audit rows for moderator actions.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');
const { hostAllowed, ratingAllowed, createGifProvider } = require('../server/gif-provider');
const { OBSCURED_CREATOR_ID } = require('../server/combos');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-social2-'));
const DB_FILE = path.join(TMP, 'social2.db');
const PORT = 20000 + Math.floor(Math.random() * 40000); // random high port: parallel runs must not collide
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'Quartz-Lantern-Meadow-7391';
const stamp = Date.now();
const ADMIN = { email: `root.s2.${stamp}@example.test`, password: PW };
const mk = (n) => ({ email: `${n}.s2.${stamp}@example.test`, password: PW, name: `Tester ${n}`, nick: `${n}_${String(stamp).slice(-5)}` });
const A = mk('alice'); const B = mk('bob'); const C = mk('carol'); const M = mk('mod');
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 300, quiet: true, admin: ADMIN, security: { challengeMode: 'off' }, combos: { executionTimerMs: 2500, confirmWindowMs: 60000, quoteTtlMs: 60000 } };
// Markets used below (seeded, active, with simulated liquidity on both sides).
const EV = 'PLXCOUNCIL-27TRAM'; // single-market event: posts, chat
const EV_URL = '/markets/plxcouncil/harbor-city-council-vote/plxcouncil-27tram';
const SEN_URL = '/markets/plxstate/harbor-state-elections/plxstate-26sen';

let srv; let browser;
const api = {};
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 150) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const ok = (r, s = 200) => assert.equal(r.status, s, `${r.status} ${r.text && r.text.slice(0, 300)}`);

async function newPage(viewport = { width: 1440, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sample || ''}`));
  });
  const page = await ctx.newPage();
  page.errors = []; page.dialogs = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => { page.dialogs.push(d.message()); d.accept().catch(() => {}); });
  return page;
}
async function logIn(page, u) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', u.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function clean(page) {
  assert.deepEqual(page.errors, [], 'page errors');
  assert.deepEqual(await page.evaluate(() => window.__csp), [], 'CSP violations');
}
const post = (page, text) => page.locator('[data-testid=post]', { has: page.locator('[data-testid=post-body]', { hasText: text }) });
const chatMsg = (page, text) => page.locator('[data-testid=chat-msg]', { has: page.locator('[data-testid=chat-body]', { hasText: text }) });
async function openChat(page, url = EV_URL) {
  await page.goto(BASE + url);
  await page.waitForSelector('[data-testid=chat-pill][data-status]');
  await page.click('[data-testid=chat-pill]');
  await page.waitForSelector('[data-testid=chat-panel]:not([hidden])');
}
const quote = (t) => srv.engine.quote(t);

before(async () => {
  srv = await start(OPTS);
  browser = await chromium.launch();
  for (const [k, u] of [['a', A], ['b', B], ['c', C], ['m', M]]) {
    api[k] = await new Client(BASE, k).signUp(u.email, u.password, u.name);
    ok(await api[k].call('POST', `/v1/users/${api[k].uid}/social/profile`, { nickname: u.nick }), 201);
    ok(await api[k].call('POST', `/v1/users/${api[k].uid}/deposits`, { amount_dollars: 2000 }), 201);
  }
  dbrun('INSERT INTO admin_roles(user_id,role,granted_by,granted_at) VALUES(?,?,?,?)', api.m.uid, 'moderator', null, new Date().toISOString());
  api.m = await new Client(BASE, 'm').logIn(M.email, M.password); // a fresh session that carries the role
  api.admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

// ------------------------------------------------------------------------------------------------ P2.1 + P2.2
test('post extras: verified position tag, sticker, Read more, share / copy link, canonical post page (two browsers)', async () => {
  ok(await api.a.call('POST', `/v1/users/${api.a.uid}/orders`, { ticker: EV, side: 'yes', type: 'market', count: 3 }), 201);
  const pa = await newPage(); const pb = await newPage();
  await pa.addInitScript(() => { navigator.share = async (d) => { window.__shared = d; }; }); // Web Share API stub
  await logIn(pa, A); await logIn(pb, B);
  await pa.goto(BASE + EV_URL);
  await pa.click('[data-tab=ideas]');
  await pa.waitForSelector('#composer [data-testid=add-position]');
  // "+ Add a position" lists the positions the author holds; only those can be tagged.
  await pa.click('[data-testid=add-position]');
  await pa.waitForSelector('[data-testid=position-picker]');
  assert.equal(await pa.locator('[data-testid=position-opt][data-ticker="PLXCOUNCIL-27TRAM"][data-side=no]').count(), 0, 'no NO position to offer');
  await pa.click('[data-testid=position-opt][data-ticker="PLXCOUNCIL-27TRAM"][data-side=yes]');
  await pa.waitForSelector('[data-testid=composer-position-chip]');
  await pa.click('[data-testid=composer-sticker]');
  await pa.click('[data-testid=sticker-opt-rocket]');
  await pa.waitForSelector('[data-testid=composer-sticker-chip]');
  const long = `Tram approval looks likely. ${'The council has the votes and the budget line is already in the draft plan. '.repeat(6)}END-OF-LONG-POST`;
  await pa.fill('[data-testid=composer-input]', long);
  await pa.click('[data-testid=composer-submit]');
  const mine = post(pa, 'Tram approval looks likely');
  await mine.waitFor();
  const tag = mine.locator('[data-testid=position-tag]');
  assert.match(await tag.textContent(), /^Yes · Approved · Will Harbor City approve the waterfront tram\?$/);
  assert.match(await tag.getAttribute('href'), /\/markets\/plxcouncil\/.+\?market=PLXCOUNCIL-27TRAM&side=yes$/);
  const img = mine.locator('[data-testid=sticker]');
  assert.equal(await img.getAttribute('src'), '/v1/social/stickers/rocket.svg');
  await pa.waitForFunction(() => document.querySelector('[data-testid=post] [data-testid=sticker]')?.naturalWidth > 0);
  // DB: snapshot of the verified position + sticker id (never a URL).
  const pid = await mine.getAttribute('data-post');
  const x = dbq('SELECT * FROM post_extras WHERE post_id=?', pid)[0];
  assert.deepEqual([x.sticker_id, x.position_ticker, x.position_side, x.position_held, x.position_units], ['rocket', EV, 'yes', 'current', 300]);
  // B sees it on the feed: long body is clamped with "Read more", which expands it.
  await pb.goto(BASE + '/social');
  const bp = post(pb, 'Tram approval looks likely');
  await bp.waitFor();
  assert.equal(await bp.locator('[data-testid=post-body].clamp').count(), 1);
  await bp.locator('[data-testid=read-more]').click();
  assert.equal(await bp.locator('[data-testid=post-body].clamp').count(), 0);
  assert.equal(await bp.locator('[data-testid=read-more]').textContent(), 'Show less');
  // Copy link (clipboard) from the ⋯ menu, then Web Share from the share action.
  await pb.bringToFront(); // the Clipboard API needs a focused document
  await bp.locator('[data-testid=post-menu]').click();
  await pb.click('[data-testid=post-copy-link]');
  assert.equal(await pb.evaluate(() => navigator.clipboard.readText()), `${BASE}/social/post/${pid}`);
  await mine.locator('[data-testid=post-share]').click();
  await pa.waitForFunction(() => !!window.__shared);
  assert.equal(await pa.evaluate(() => window.__shared.url), `${BASE}/social/post/${pid}`);
  // Canonical page: the post with its replies open; a reply with a sticker from the reply composer.
  await pb.goto(`${BASE}/social/post/${pid}`);
  await pb.waitForSelector('[data-testid=post-page] [data-testid=post]');
  await pb.waitForSelector('[data-testid=reply-input]');
  await pb.click('[data-testid=reply-sticker]');
  await pb.click('[data-testid=sticker-opt-popcorn]');
  await pb.waitForSelector('.comment [data-sticker=popcorn]');
  assert.equal(dbq('SELECT ce.sticker_id FROM comments c JOIN comment_extras ce ON ce.comment_id=c.id WHERE c.post_id=?', pid)[0].sticker_id, 'popcorn');
  assert.equal(await pb.locator('[data-testid=post-page] [data-testid=read-more]').count(), 0, 'canonical page shows the full text');
  // API rules: an un-held side, unknown stickers, URLs as stickers, empty post without sticker.
  let r = await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts`, { body: 'not held', position: { market_ticker: EV, side: 'no' } });
  assert.equal(r.status, 409); assert.equal(r.code, 'position_not_held');
  r = await api.c.call('POST', `/v1/users/${api.c.uid}/social/posts`, { body: 'never traded', position: { market_ticker: EV, side: 'yes' } });
  assert.equal(r.code, 'position_not_held');
  for (const s of ['https://evil.example/x.gif', '../../etc/passwd', 'nope-sticker', { id: 'rocket' }]) {
    r = await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts`, { body: 'sticker check', sticker_id: s });
    assert.equal(r.status, 400, JSON.stringify(s));
  }
  ok(await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts`, { body: '', sticker_id: 'bull' }), 201); // a sticker alone is a post
  assert.equal((await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts`, { body: '   ' })).status, 400);
  assert.equal((await api.a.call('GET', '/v1/social/stickers/..%2f..%2fserver.svg')).status, 404);
  const svg = await api.b.call('GET', '/v1/social/stickers/rocket.svg');
  assert.match(svg.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(svg.headers.get('content-security-policy'), /sandbox/);
  assert.ok(!/<script|on\w+=|href=/i.test(svg.text), 'sticker SVG carries no script, handlers or links');
  await clean(pa); await clean(pb);
  await pa.context().close(); await pb.context().close();
});

test('edit window: author edits within 10 minutes, "edited" marker, history for moderators; IDOR and window close refused', async () => {
  let r = await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts`, { body: 'Original thought about the tram', event_ticker: EV });
  ok(r, 201);
  const pid = r.body.post.id;
  assert.ok(r.body.post.editable_until);
  const pa = await newPage(); const pb = await newPage();
  await logIn(pa, A); await logIn(pb, B);
  await pa.goto(`${BASE}/social/post/${pid}`);
  const card = post(pa, 'Original thought');
  await card.locator('[data-testid=post-menu]').click();
  await pa.click('[data-testid=post-edit]');
  await pa.fill('[data-testid=post-edit-input]', 'Revised thought <img src=x onerror="window.__xss=1">');
  await pa.click('[data-testid=post-edit-save]');
  const ed = post(pa, 'Revised thought');
  await ed.locator('[data-testid=post-edited]').waitFor();
  assert.equal(await ed.locator('[data-testid=post-body]').textContent(), 'Revised thought <img src=x onerror="window.__xss=1">');
  assert.equal(await pa.locator('[data-testid=post-body] img').count(), 0);
  await pb.goto(`${BASE}/social/post/${pid}`);
  await post(pb, 'Revised thought').locator('[data-testid=post-edited]').waitFor();
  assert.equal(await pb.evaluate(() => window.__xss), undefined);
  // B sees no Edit in the ⋯ menu, and cannot edit through either path.
  await post(pb, 'Revised thought').locator('[data-testid=post-menu]').click();
  assert.equal(await pb.locator('[data-testid=post-edit]').count(), 0);
  assert.equal((await api.b.call('PUT', `/v1/users/${api.b.uid}/social/posts/${pid}`, { body: 'hijack' })).status, 404);
  assert.equal((await api.b.call('PUT', `/v1/users/${api.a.uid}/social/posts/${pid}`, { body: 'hijack' })).status, 403);
  assert.equal((await api.a.call('PUT', `/v1/users/${api.a.uid}/social/posts/${pid}`, { body: 'x', extra: 1 })).code, 'validation_failed');
  assert.equal((await api.a.call('PUT', `/v1/users/${api.a.uid}/social/posts/${pid}`, { body: 'x', }, { 'x-csrf-token': 'wrong' })).status, 403, 'CSRF');
  const hist = dbq('SELECT * FROM post_edits WHERE post_id=?', pid);
  assert.equal(hist.length, 1);
  assert.deepEqual([hist[0].prev_body, hist[0].by_moderator, hist[0].editor_id], ['Original thought about the tram', 0, api.a.uid]);
  // Older than 10 minutes: refused, and the menu no longer offers Edit.
  dbrun('UPDATE posts SET created_ts=created_ts-? WHERE id=?', 11 * 60000, pid);
  r = await api.a.call('PUT', `/v1/users/${api.a.uid}/social/posts/${pid}`, { body: 'too late' });
  assert.equal(r.status, 409); assert.equal(r.code, 'edit_window_closed');
  await pa.reload();
  await post(pa, 'Revised thought').locator('[data-testid=post-menu]').click();
  assert.equal(await pa.locator('[data-testid=post-edit]').count(), 0);
  // Moderator: Admin › Moderation › Post tools shows the edit history.
  const pm = await newPage(); await logIn(pm, M);
  await pm.goto(`${BASE}/admin/moderation/posts/${pid}`);
  await pm.waitForSelector('[data-testid=post-edit-history] li');
  assert.match(await pm.textContent('[data-testid=post-edit-history]'), /Original thought about the tram/);
  ok(await api.b.call('GET', `/v1/social/posts/${pid}`));
  assert.equal((await api.b.call('GET', `/v1/admin/moderation/posts/${pid}`)).status, 403);
  // Delete own post from the ⋯ menu (confirm dialog accepted); the edit history goes with it.
  await pa.keyboard.press('Escape');
  await pa.waitForSelector('[data-testid=post-menu-list]', { state: 'detached' });
  await post(pa, 'Revised thought').locator('[data-testid=post-menu]').click();
  await pa.click('[data-testid=post-delete]');
  await post(pa, 'Revised thought').waitFor({ state: 'detached' });
  assert.equal(dbq('SELECT COUNT(*) c FROM posts WHERE id=?', pid)[0].c, 0);
  assert.equal(dbq('SELECT COUNT(*) c FROM post_edits WHERE post_id=?', pid)[0].c, 0);
  for (const p of [pa, pb, pm]) { await clean(p); await p.context().close(); }
});

test('mute: posts, replies, chat and notifications from a muted trader are hidden for the muter only', async () => {
  let r = await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts`, { body: 'Alice mute-check post', event_ticker: EV });
  const pidA = r.body.post.id;
  r = await api.b.call('POST', `/v1/users/${api.b.uid}/social/posts`, { body: 'Bob mute-check post' });
  const pidB = r.body.post.id;
  ok(await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts/${pidB}/comments`, { body: 'Alice reply under Bob' }), 201);
  const pb = await newPage(); const pc = await newPage();
  await logIn(pb, B); await logIn(pc, C);
  await pb.goto(BASE + '/social');
  await post(pb, 'Alice mute-check post').locator('[data-testid=post-menu]').click();
  await pb.click('[data-testid=post-mute]');
  await post(pb, 'Alice mute-check post').waitFor({ state: 'detached' });
  assert.equal(dbq('SELECT COUNT(*) c FROM user_mutes WHERE muter_id=? AND muted_id=?', api.b.uid, api.a.uid)[0].c, 1);
  await pb.reload();
  await post(pb, 'Bob mute-check post').waitFor();
  assert.equal(await post(pb, 'Alice mute-check post').count(), 0);
  // Replies by A are hidden under B's own post.
  await post(pb, 'Bob mute-check post').locator('[data-act=comments]').click();
  await pb.waitForSelector('[data-testid=reply-input]');
  assert.equal(await pb.locator('.comment', { hasText: 'Alice reply under Bob' }).count(), 0);
  // C (not muting) still sees both.
  await pc.goto(BASE + '/social');
  await post(pc, 'Alice mute-check post').waitFor();
  // API: the feed / comments / timeline count respect the mute; the profile feed still lists them on request.
  assert.ok(!(await api.b.call('GET', '/v1/social/posts')).body.posts.some((p) => p.id === pidA));
  assert.ok((await api.c.call('GET', '/v1/social/posts')).body.posts.some((p) => p.id === pidA));
  assert.ok(!(await api.b.call('GET', `/v1/social/posts/${pidB}/comments`)).body.comments.some((c) => c.body === 'Alice reply under Bob'));
  assert.equal((await api.b.call('GET', `/v1/social/posts/${pidA}`)).body.post.author_muted, true);
  // Notifications from the muted trader are dropped (a like and a follow).
  const before = dbq('SELECT COUNT(*) c FROM notifications WHERE user_id=?', api.b.uid)[0].c;
  ok(await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts/${pidB}/like`, {}));
  ok(await api.a.call('POST', `/v1/users/${api.a.uid}/social/follow`, { nickname: B.nick }));
  await sleep(300);
  assert.equal(dbq('SELECT COUNT(*) c FROM notifications WHERE user_id=?', api.b.uid)[0].c, before);
  // Chat: A's live message reaches C but not B.
  await openChat(pb); await openChat(pc);
  ok(await api.a.call('POST', `/v1/users/${api.a.uid}/chat/${EV}/messages`, { body: 'alice chat while muted' }), 201);
  await chatMsg(pc, 'alice chat while muted').waitFor();
  await sleep(500);
  assert.equal(await chatMsg(pb, 'alice chat while muted').count(), 0);
  assert.ok(!(await api.b.call('GET', `/v1/events/${EV}/chat`)).body.messages.some((m) => m.body === 'alice chat while muted'));
  // Validation, self-mute, IDOR, rate limit on mute writes.
  assert.equal((await api.b.call('POST', `/v1/users/${api.b.uid}/social/mutes`, { nickname: B.nick })).status, 400);
  assert.equal((await api.b.call('POST', `/v1/users/${api.b.uid}/social/mutes`, { nickname: '<script>' })).status, 400);
  assert.equal((await api.b.call('GET', `/v1/users/${api.a.uid}/social/mutes`)).status, 403);
  // Unmute from Social settings restores the posts.
  await pb.goto(BASE + '/social/settings');
  await pb.click(`[data-mute-row="${A.nick}"] [data-unmute]`);
  await pb.waitForSelector('[data-testid=no-mutes]');
  await pb.goto(BASE + '/social');
  await post(pb, 'Alice mute-check post').waitFor();
  for (const p of [pb, pc]) { await clean(p); await p.context().close(); }
});

// ------------------------------------------------------------------------------------------------ P2.3
test('topic follows (event, market, keyword): Topics feed, notifications, timeline-count badge, profile search', async () => {
  const pb = await newPage(); await logIn(pb, B);
  await pb.goto(BASE + SEN_URL);
  await pb.click('[data-testid=follow-event]');
  await pb.waitForSelector('[data-testid=follow-event][aria-pressed=true]');
  await pb.waitForSelector('[data-testid=follow-market]');
  await pb.click('[data-testid=follow-market]');
  await pb.waitForSelector('[data-testid=follow-market][aria-pressed=true]');
  await pb.goto(BASE + '/social/settings');
  await pb.fill('[data-testid=keyword-input]', 'Gondola');
  await pb.click('[data-testid=keyword-add]');
  await pb.waitForSelector('[data-topic="keyword:gondola"]');
  const topics = dbq('SELECT kind, value FROM topic_follows WHERE user_id=? ORDER BY kind', api.b.uid).map((t) => `${t.kind}:${t.value}`);
  assert.ok(topics.includes('event:PLXSTATE-26SEN') && topics.includes('keyword:gondola') && topics.some((t) => t.startsWith('market:PLXSTATE-26SEN')), topics.join());
  // XSS / validation on the keyword field.
  for (const v of ['<script>alert(1)</script>', 'a', 'x'.repeat(40), '"><img src=x>']) assert.equal((await api.b.call('POST', `/v1/users/${api.b.uid}/social/topics`, { kind: 'keyword', value: v })).status, 400, v);
  assert.equal((await api.b.call('POST', `/v1/users/${api.b.uid}/social/topics`, { kind: 'event', value: 'NOPE-EVENT' })).status, 404);
  // Rate limit on topic writes (per user, per write group).
  const tw = []; for (let i = 0; i < 26; i++) tw.push((await api.c.call('POST', `/v1/users/${api.c.uid}/social/topics`, { kind: 'keyword', value: `burst${i}` })).status);
  assert.ok(tw.includes(429), `topic writes are rate limited: ${tw.join(',')}`);
  dbrun("DELETE FROM topic_follows WHERE user_id=? AND value LIKE 'burst%'", api.c.uid);
  // New-posts badge on B's feed while A posts about a followed keyword.
  await pb.goto(BASE + '/social');
  await pb.click('[data-testid=feed-topics]');
  await pb.waitForSelector('[data-testid=empty-feed]');
  let r = await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts`, { body: 'The gondola link would beat the tram on cost' });
  ok(r, 201);
  const kwPost = r.body.post.id;
  r = await api.c.call('POST', `/v1/users/${api.c.uid}/social/posts`, { body: 'Senate race is tightening', event_ticker: 'PLXSTATE-26SEN' });
  const evPost = r.body.post.id;
  await pb.waitForSelector('[data-testid=new-posts]:not([hidden])', { timeout: 12000 });
  assert.match(await pb.textContent('[data-testid=new-posts]'), /^2 new posts$/);
  await pb.click('[data-testid=new-posts]');
  await post(pb, 'gondola link').waitFor();
  await post(pb, 'Senate race is tightening').waitFor();
  assert.equal(await pb.locator('[data-testid=new-posts]').isHidden(), true);
  // Notifications (social_topic) for both matches, linking to the canonical post page.
  const notes = await until(() => { const n = dbq("SELECT link FROM notifications WHERE user_id=? AND type='social_topic'", api.b.uid); return n.length >= 2 ? n : null; });
  assert.ok(notes && notes.some((n) => n.link === `/social/post/${kwPost}`) && notes.some((n) => n.link === `/social/post/${evPost}`));
  // timeline_count API: since, feed, own posts excluded, anonymous only for "all".
  const since = new Date(Date.now() - 60000).toISOString();
  r = await api.b.call('GET', `/v1/social/timeline_count?feed=topics&since=${encodeURIComponent(since)}`);
  assert.equal(r.body.count, 2);
  assert.equal((await new Client(BASE).call('GET', `/v1/social/timeline_count?feed=following&since=${Date.now()}`)).status, 401);
  assert.equal((await api.b.call('GET', '/v1/social/timeline_count?since=yesterday')).status, 400);
  // Profile search: nickname prefix only, never email; rate limited.
  await pb.fill('[data-testid=profile-search-input]', A.nick.slice(0, 4));
  await pb.waitForSelector(`[data-testid=profile-hit][href="/social/profile/${A.nick}"]`);
  r = await api.b.call('GET', `/v1/search/social_profiles?query=${encodeURIComponent(A.nick.slice(0, 3))}`);
  assert.ok(r.body.profiles.some((p) => p.nickname === A.nick));
  assert.ok(r.body.profiles.every((p) => !('email' in p) && !('user_id' in p)));
  assert.equal((await api.b.call('GET', '/v1/search/social_profiles?query=s2.')).status, 400, 'email-like input refused');
  assert.equal((await api.b.call('GET', `/v1/search/social_profiles?query=${encodeURIComponent(`alice.s2.${stamp}`)}`)).status, 400);
  assert.deepEqual((await api.b.call('GET', '/v1/search/social_profiles?query=example')).body.profiles, [], 'the email domain matches nobody');
  assert.equal((await api.b.call('GET', '/v1/search/social_profiles?query=%25')).status, 400);
  const st = []; for (let i = 0; i < 30; i++) st.push((await api.c.call('GET', '/v1/search/social_profiles?query=a')).status);
  assert.ok(st.includes(429), 'search is rate limited');
  await clean(pb); await pb.context().close();
});

test('badges: first trade, 10 trades, profitable month, top 10, verified — computed, persisted, shown on posts and profiles', async () => {
  const T = 'PLXHOOPS-27CHAMP-OWLS';
  for (let i = 0; i < 10; i++) ok(await api.c.call('POST', `/v1/users/${api.c.uid}/orders`, { ticker: T, side: 'yes', type: 'market', count: 30 }), 201);
  assert.ok(dbq('SELECT COUNT(*) c FROM fills WHERE user_id=?', api.c.uid)[0].c >= 10);
  // Resolve the market YES (resolution desk, settle now): C profits this month.
  ok(await api.admin.call('POST', `/v1/admin/markets/${T}/close`, {}));
  ok(await api.admin.call('POST', `/v1/admin/resolution/${T}/resolve`, { result: 'yes', source_note: 'Final standings published', settlement_delay_sec: 0 }));
  ok(await api.m.call('POST', `/v1/admin/moderation/users/${api.c.uid}/verify`, {}));
  const want = ['first_trade', 'ten_trades', 'profitable_month', 'top_10', 'verified'];
  const got = await until(() => { const b = dbq('SELECT badge FROM social_badges WHERE user_id=?', api.c.uid).map((x) => x.badge); return want.every((w) => b.includes(w)) ? b : null; }, 12000);
  assert.ok(got, `badges: ${dbq('SELECT badge FROM social_badges WHERE user_id=?', api.c.uid).map((x) => x.badge)}`);
  assert.equal(dbq("SELECT detail FROM social_badges WHERE user_id=? AND badge='profitable_month'", api.c.uid)[0].detail, new Date().toISOString().slice(0, 7));
  assert.ok((await api.c.call('GET', '/v1/social/leaderboard')).body.leaders.findIndex((l) => l.nickname === C.nick) < 10);
  assert.ok(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='social_badge'", api.c.uid)[0].c >= 5);
  const r = await api.b.call('GET', `/v1/social/badges?nickname=${C.nick}`);
  assert.deepEqual(r.body.badges.filter((b) => b.earned).map((b) => b.id).sort(), [...want].sort());
  ok(await api.c.call('POST', `/v1/users/${api.c.uid}/social/posts`, { body: 'Called the Owls title' }), 201);
  const pb = await newPage(); await logIn(pb, B);
  await pb.goto(BASE + '/social');
  await pb.click('[data-testid=feed-all]');
  const cp = post(pb, 'Called the Owls');
  for (const b of ['first_trade', 'ten_trades', 'profitable_month', 'top_10']) await cp.locator(`.badge-chip[data-badge=${b}]`).waitFor();
  await cp.locator('[data-testid=verified-badge]').waitFor();
  await pb.goto(`${BASE}/social/profile/${C.nick}`);
  await pb.waitForSelector('[data-testid=profile-badges] .badge-chip[data-badge=top_10]');
  // Verified follows the moderator decision.
  ok(await api.m.call('POST', `/v1/admin/moderation/users/${api.c.uid}/unverify`, {}));
  assert.ok(await until(() => !dbq("SELECT 1 FROM social_badges WHERE user_id=? AND badge='verified'", api.c.uid).length, 10000));
  await clean(pb); await pb.context().close();
});

// ------------------------------------------------------------------------------------------------ P2.4
test('notification preferences per type × channel, quiet hours (no live push, email deferred), email stub, locked types', async () => {
  const pb = await newPage(); await logIn(pb, B);
  await pb.goto(BASE + '/notifications');
  await pb.click('[data-testid=notif-settings-link]');
  await pb.waitForSelector('[data-testid=prefs-panel]');
  await pb.uncheck('[data-testid=pref-social_like-in_app]');
  await pb.check('[data-testid=pref-social_follow-email]');
  assert.equal(await pb.isDisabled('[data-testid=pref-account-in_app]'), true);
  await until(() => { const r = dbq('SELECT types FROM notif_prefs WHERE user_id=?', api.b.uid)[0]; return r && JSON.parse(r.types).social_follow?.email === true; });
  const prefs = JSON.parse(dbq('SELECT types FROM notif_prefs WHERE user_id=?', api.b.uid)[0].types);
  assert.equal(prefs.social_like.in_app, false);
  // In-app off: a like produces no notification row; email on: a follow produces an outbox row ("sent" by the stub).
  const pid = (await api.b.call('POST', `/v1/users/${api.b.uid}/social/posts`, { body: 'Prefs check post' })).body.post.id;
  ok(await api.c.call('POST', `/v1/users/${api.c.uid}/social/posts/${pid}/like`, {}));
  await sleep(200);
  assert.equal(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='social_like' AND body='Prefs check post'", api.b.uid)[0].c, 0);
  ok(await api.c.call('DELETE', `/v1/users/${api.c.uid}/social/follow?nickname=${B.nick}`));
  ok(await api.c.call('POST', `/v1/users/${api.c.uid}/social/follow`, { nickname: B.nick }));
  assert.ok(await until(() => dbq("SELECT 1 FROM notif_email_outbox WHERE user_id=? AND type='social_follow' AND status='sent'", api.b.uid).length));
  // Quiet hours now (UTC window around the current time): stored, not pushed live; email deferred to the window end.
  await pb.goto(BASE + '/notifications/settings');
  const hm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  await pb.check('[data-testid=quiet-enabled]');
  await pb.fill('[data-testid=quiet-start]', hm(new Date(Date.now() - 3600000)));
  await pb.fill('[data-testid=quiet-end]', hm(new Date(Date.now() + 3600000)));
  await pb.selectOption('[data-testid=quiet-tz]', 'UTC');
  await pb.click('[data-testid=quiet-save]');
  await pb.waitForSelector('[data-testid=quiet-now]');
  await pb.goto(BASE + '/notifications');
  await pb.waitForSelector('[data-testid=notifications]');
  const bell = async () => Number((await pb.locator('[data-testid=unread-count]').textContent().catch(() => '0')) || 0);
  const b0 = await bell();
  ok(await api.c.call('DELETE', `/v1/users/${api.c.uid}/social/follow?nickname=${B.nick}`));
  ok(await api.c.call('POST', `/v1/users/${api.c.uid}/social/follow`, { nickname: B.nick }));
  const deferred = await until(() => dbq("SELECT * FROM notif_email_outbox WHERE user_id=? AND type='social_follow' AND status='deferred'", api.b.uid)[0]);
  assert.ok(deferred && deferred.send_after_ts > Date.now() + 30 * 60000, 'email waits for the end of quiet hours');
  assert.equal(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='social_follow'", api.b.uid)[0].c >= 2, true, 'still stored in the inbox');
  await sleep(1200);
  assert.equal(await bell(), b0, 'no live push during quiet hours');
  // Quiet hours off: the next one pushes live (bell count increases without reload).
  ok(await api.b.call('PUT', `/v1/users/${api.b.uid}/notifications/preferences`, { quiet_hours: { enabled: false } }));
  ok(await api.c.call('DELETE', `/v1/users/${api.c.uid}/social/follow?nickname=${B.nick}`));
  ok(await api.c.call('POST', `/v1/users/${api.c.uid}/social/follow`, { nickname: B.nick }));
  await pb.waitForFunction((n) => Number(document.querySelector('[data-testid=unread-count]')?.textContent || 0) > n, b0);
  // Validation: locked types, unknown types / channels, bad times and zones; per-type settings path; IDOR.
  let r = await api.b.call('PUT', `/v1/users/${api.b.uid}/notifications/preferences`, { types: { account: { in_app: false } } });
  assert.equal(r.code, 'preference_locked');
  assert.equal((await api.b.call('PUT', `/v1/users/${api.b.uid}/notifications/preferences`, { types: { nope: { in_app: false } } })).status, 400);
  assert.equal((await api.b.call('PUT', `/v1/users/${api.b.uid}/notifications/preferences`, { types: { fill: { sms: true } } })).status, 400);
  assert.equal((await api.b.call('PUT', `/v1/users/${api.b.uid}/notifications/preferences`, { quiet_hours: { start: '25:00' } })).status, 400);
  assert.equal((await api.b.call('PUT', `/v1/users/${api.b.uid}/notifications/preferences`, { quiet_hours: { timezone: 'Mars/Olympus' } })).status, 400);
  r = await api.b.call('PUT', `/v1/users/${api.b.uid}/notifications/settings/fill`, { email: false });
  ok(r); assert.equal(r.body.types.find((t) => t.type === 'fill').email, false);
  assert.equal((await api.a.call('PUT', `/v1/users/${api.b.uid}/notifications/settings/fill`, { email: true })).status, 403);
  assert.equal((await api.a.call('GET', `/v1/users/${api.b.uid}/notifications/preferences`)).status, 403);
  await clean(pb); await pb.context().close();
});

test('price-movement subscription: added on the market page, honoured by the notifier, once per window', async () => {
  const T = 'PLXCUP-26FINAL-COM';
  const ref = dbq('SELECT yes_price_cents p FROM trades WHERE market_ticker=? AND created_ts<=? ORDER BY created_ts DESC, rowid DESC LIMIT 1', T, Date.now() - 5 * 60000)[0].p;
  const ask = quote(T).yes_ask;
  const move = Math.abs(ask - ref);
  assert.ok(move >= 1, `the next buy moves the price (${ref} → ${ask})`);
  const pb = await newPage(); await logIn(pb, B);
  await pb.goto(BASE + '/markets/plxcup/northern-cup-final/plxcup-26final?market=' + T);
  await pb.waitForSelector('[data-testid=move-threshold]');
  await pb.fill('[data-testid=move-threshold]', String(move));
  await pb.selectOption('[data-testid=move-window]', '5');
  await pb.click('[data-testid=move-add]');
  await pb.waitForSelector('[data-testid=follow-card] [data-sub]');
  ok(await api.b.call('POST', `/v1/users/${api.b.uid}/notifications/price_movement_subscriptions`, { market_ticker: T, threshold_cents: Math.min(99, move + 1), window_minutes: 5 }), 201); // must not fire
  const subs = dbq('SELECT * FROM price_move_subs WHERE user_id=? AND market_ticker=? ORDER BY threshold_cents', api.b.uid, T);
  assert.deepEqual(subs.map((s) => [s.threshold_cents, s.window_minutes, s.direction]), [[move, 5, 'any'], [Math.min(99, move + 1), 5, 'any']]);
  ok(await api.c.call('POST', `/v1/users/${api.c.uid}/orders`, { ticker: T, side: 'yes', type: 'market', count: 1 }), 201);
  const n = await until(() => dbq("SELECT * FROM notifications WHERE user_id=? AND type='price_movement'", api.b.uid)[0]);
  assert.ok(n, 'price_movement notification');
  assert.match(n.title, new RegExp(`moved [▲▼] ${move}¢ in 5 min`));
  await pb.waitForFunction(() => document.querySelector('[data-testid=unread-count]'));
  const fired = dbq('SELECT * FROM price_move_subs WHERE user_id=? AND market_ticker=? ORDER BY threshold_cents', api.b.uid, T);
  assert.ok(fired[0].last_notified_ts && fired[0].last_move_cents !== null);
  assert.equal(fired[1].last_notified_ts, null, 'a higher threshold does not fire');
  // Once per window: another trade does not notify again.
  ok(await api.c.call('POST', `/v1/users/${api.c.uid}/orders`, { ticker: T, side: 'yes', type: 'market', count: 1 }), 201);
  await sleep(500);
  assert.equal(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='price_movement'", api.b.uid)[0].c, 1);
  // Validation + IDOR on delete.
  for (const b of [{ market_ticker: T, threshold_cents: 0, window_minutes: 5 }, { market_ticker: T, threshold_cents: 5, window_minutes: 7 }, { market_ticker: T, threshold_cents: 5, window_minutes: 5, direction: 'sideways' }, { market_ticker: '<x>', threshold_cents: 5, window_minutes: 5 }]) {
    assert.equal((await api.b.call('POST', `/v1/users/${api.b.uid}/notifications/price_movement_subscriptions`, b)).status, 400, JSON.stringify(b));
  }
  assert.equal((await api.a.call('DELETE', `/v1/users/${api.a.uid}/notifications/price_movement_subscriptions?id=${fired[0].id}`)).status, 404);
  assert.equal(dbq('SELECT COUNT(*) c FROM price_move_subs WHERE id=?', fired[0].id)[0].c, 1);
  await pb.goto(BASE + '/notifications/settings');
  await pb.waitForSelector(`[data-sub="${fired[0].id}"]`);
  await clean(pb); await pb.context().close();
});

// ------------------------------------------------------------------------------------------------ G10
test('chat reactions (toggle, live counts) and message editing (5-minute window, edited marker, moderator history), stickers', async () => {
  const pa = await newPage(); const pb = await newPage();
  await logIn(pa, A); await logIn(pb, B);
  await openChat(pa); await openChat(pb);
  await pa.fill('[data-testid=chat-input]', 'Reaction target from Alice');
  await pa.press('[data-testid=chat-input]', 'Enter');
  const mb = chatMsg(pb, 'Reaction target from Alice');
  await mb.waitFor();
  await mb.locator('[data-testid=chat-react]').click();
  await pb.click('[data-testid=chat-react-pick-fire]');
  await mb.locator('[data-testid=chat-reaction-fire][aria-pressed=true]').waitFor();
  const ma = chatMsg(pa, 'Reaction target from Alice');
  await ma.locator('[data-testid=chat-reaction-fire][data-count="1"]').waitFor(); // live for A
  const mid = await ma.getAttribute('data-id');
  assert.equal(dbq('SELECT COUNT(*) c FROM chat_reactions WHERE message_id=? AND reaction=?', mid, 'fire')[0].c, 1);
  await mb.locator('[data-testid=chat-reaction-fire]').click(); // toggle off
  await ma.locator('[data-testid=chat-reaction-fire]').waitFor({ state: 'detached' });
  assert.equal(dbq('SELECT COUNT(*) c FROM chat_reactions WHERE message_id=?', mid)[0].c, 0);
  // Edit own message: live for B with "(edited)"; XSS stays text.
  await ma.locator('[data-testid=chat-edit]').click();
  await pa.fill('[data-testid=chat-edit-input]', 'Edited <b onmouseover=alert(1)>bold</b>');
  await pa.click('[data-testid=chat-edit-save]');
  const eb = chatMsg(pb, 'Edited <b onmouseover');
  await eb.waitFor();
  await eb.locator('[data-testid=chat-edited]:not([hidden])').waitFor();
  assert.equal(await pb.locator('[data-testid=chat-body] b').count(), 0);
  const row = dbq('SELECT body, edited_ts FROM chat_messages WHERE id=?', mid)[0];
  assert.ok(row.edited_ts && row.body.startsWith('Edited'));
  assert.equal(dbq('SELECT prev_body FROM chat_message_edits WHERE message_id=?', mid)[0].prev_body, 'Reaction target from Alice');
  assert.equal(await mb.count() + await eb.locator('[data-testid=chat-edit]').count(), 0, 'B gets no Edit on A\'s message');
  // Sticker message from the chat composer, live for A.
  await pb.click('[data-testid=chat-sticker-btn]');
  await pb.click('[data-testid=sticker-opt-bull]');
  await pa.waitForSelector('[data-testid=chat-msg] [data-testid=chat-sticker][data-sticker=bull]');
  // API rules: other user's message, unknown reaction, window closed, IDOR, CSRF, reaction rate limit.
  assert.equal((await api.b.call('PUT', `/v1/users/${api.b.uid}/chat/${EV}/messages/${mid}`, { body: 'hijack' })).status, 404);
  assert.equal((await api.b.call('PUT', `/v1/users/${api.a.uid}/chat/${EV}/messages/${mid}`, { body: 'hijack' })).status, 403);
  assert.equal((await api.b.call('PUT', `/v1/users/${api.b.uid}/chat/${EV}/messages/${mid}/reactions/poop`, {})).status, 400);
  assert.equal((await api.b.call('PUT', `/v1/users/${api.b.uid}/chat/${EV}/messages/${mid}/reactions/up`, {}, { 'x-csrf-token': 'nope' })).status, 403);
  const rs = []; for (let i = 0; i < 30; i++) rs.push((await api.c.call(i % 2 ? 'DELETE' : 'PUT', `/v1/users/${api.c.uid}/chat/${EV}/messages/${mid}/reactions/up`, i % 2 ? undefined : {})).status);
  assert.ok(rs.includes(429), 'reactions are rate limited');
  dbrun('UPDATE chat_messages SET created_ts=created_ts-? WHERE id=?', 6 * 60000, mid);
  const late = await api.a.call('PUT', `/v1/users/${api.a.uid}/chat/${EV}/messages/${mid}`, { body: 'too late' });
  assert.equal(late.code, 'edit_window_closed');
  // Moderator: edit history in Admin › Chat.
  const pm = await newPage(); await logIn(pm, M);
  await pm.goto(`${BASE}/admin/chat/${EV}`);
  await pm.locator(`[data-msg="${mid}"] [data-testid=chat-history]`).click();
  await pm.waitForSelector('[data-testid=chat-edit-history] li');
  assert.match(await pm.textContent('[data-testid=chat-edit-history]'), /Reaction target from Alice/);
  assert.equal((await api.b.call('GET', `/v1/admin/chat/messages/${mid}/edits`)).status, 403);
  for (const p of [pa, pb, pm]) { await clean(p); await p.context().close(); }
});

// ------------------------------------------------------------------------------------------------ G8
test('social-admin PUT endpoints (market status, subtype, moderator update, profile image) with audit; sticker moderation', async () => {
  ok(await api.a.call('PUT', `/v1/users/${api.a.uid}/social/profile/avatar`, { sticker_id: 'crystal-ball' }));
  let r = await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts`, { body: 'Moderation target with my phone 555-0100', event_ticker: EV, position: { market_ticker: EV, side: 'yes' } });
  const pid = r.body.post.id;
  const pm = await newPage(); await logIn(pm, M);
  await pm.goto(`${BASE}/admin/moderation/posts/${pid}`);
  await pm.waitForSelector('[data-testid=post-tools]');
  await pm.selectOption('[data-testid=post-subtype-select]', 'analysis');
  await until(() => dbq('SELECT subtype FROM post_extras WHERE post_id=?', pid)[0]?.subtype === 'analysis');
  await pm.waitForSelector('[data-testid=post-tools]');
  await pm.click('[data-testid=post-mod-edit]');
  await pm.fill('[data-testid=mod-edit-body]', 'Moderation target with my phone [removed]');
  await pm.fill('[data-testid=confirm-reason]', 'personal information');
  await pm.click('[data-testid=confirm-ok]');
  await until(() => dbq('SELECT body FROM posts WHERE id=?', pid)[0].body.endsWith('[removed]'));
  await pm.waitForSelector('[data-testid=post-tools-body]');
  await pm.click('[data-testid=post-market-status]');
  await pm.check('[data-testid=market-status-remove-tag]');
  await pm.fill('[data-testid=confirm-reason]', 'misleading position');
  await pm.click('[data-testid=confirm-ok]');
  await until(() => dbq('SELECT position_ticker FROM post_extras WHERE post_id=?', pid)[0].position_ticker === null);
  // Profile picture decision (by nickname) → A falls back to the monogram and is told.
  await pm.fill('[data-testid=avatar-review-nick]', A.nick);
  await pm.selectOption('[data-testid=avatar-review-decision]', 'reject');
  await pm.click('[data-testid=avatar-review-submit]');
  await pm.fill('[data-testid=confirm-reason]', 'not suitable');
  await pm.click('[data-testid=confirm-ok]');
  await until(() => dbq('SELECT status FROM profile_avatars WHERE user_id=?', api.a.uid)[0].status === 'rejected');
  // The public post shows the result.
  const pb = await newPage(); await logIn(pb, B);
  await pb.goto(`${BASE}/social/post/${pid}`);
  const card = post(pb, 'Moderation target');
  await card.locator('[data-testid=post-edited]', { hasText: 'edited by a moderator' }).waitFor();
  assert.equal(await card.locator('[data-testid=post-subtype]').textContent(), 'analysis');
  assert.equal(await card.locator('[data-testid=position-tag]').count(), 0);
  assert.equal(await card.locator('img.sticker-av').count(), 0, 'rejected picture falls back to the monogram');
  assert.ok(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='account' AND title LIKE 'A moderator%'", api.a.uid)[0].c >= 2);
  assert.equal((await api.a.call('PUT', `/v1/users/${api.a.uid}/social/profile/avatar`, { sticker_id: 'crystal-ball' })).code, 'avatar_rejected');
  // Audit rows for every moderator action.
  const acts = dbq('SELECT action FROM admin_audit WHERE actor_id=?', api.m.uid).map((x) => x.action);
  for (const a of ['social.post_subtype', 'social.post_update', 'social.post_market_status', 'social.profile_image']) assert.ok(acts.includes(a), a);
  // Authorization: a non-moderator on its own uid, a moderator on someone else's uid, bad bodies.
  assert.equal((await api.b.call('PUT', `/v1/users/${api.b.uid}/social/social-admin/posts/${pid}/post_subtype`, { post_subtype: 'news' })).status, 403);
  assert.equal((await api.m.call('PUT', `/v1/users/${api.a.uid}/social/social-admin/posts/${pid}/post_subtype`, { post_subtype: 'news' })).status, 403);
  assert.equal((await api.m.call('PUT', `/v1/users/${api.m.uid}/social/social-admin/posts/${pid}/post_subtype`, { post_subtype: '<script>' })).status, 400);
  assert.equal((await api.m.call('PUT', `/v1/users/${api.m.uid}/social/social-admin/posts/${pid}/update`, { body: 'no reason' })).status, 400);
  r = await api.m.call('PUT', `/v1/users/${api.m.uid}/social/social-admin/posts/${pid}/update`, { body: '<svg onload=alert(1)>', reason: 'xss check' });
  ok(r); assert.equal(r.body.post.body, '<svg onload=alert(1)>');
  await pb.reload();
  await post(pb, '<svg onload').waitFor();
  assert.equal(await pb.locator('[data-testid=post-body] svg').count(), 0);
  // Stickers: disable one in Admin › Moderation › Stickers → gone from the picker and from posts; audited.
  await pm.goto(`${BASE}/admin/moderation/stickers`);
  await pm.click('[data-testid=sticker-toggle-rocket]');
  await pm.waitForSelector('[data-sticker-row=rocket] [data-testid=sticker-toggle-rocket]:has-text("Enable")');
  assert.equal(dbq("SELECT enabled FROM social_stickers WHERE id='rocket'")[0].enabled, 0);
  assert.ok(!(await api.b.call('GET', '/v1/social/stickers')).body.stickers.some((s) => s.id === 'rocket'));
  assert.equal((await api.b.call('GET', '/v1/social/stickers/rocket.svg')).status, 404);
  assert.equal((await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts`, { body: 'x', sticker_id: 'rocket' })).code, 'sticker_disabled');
  assert.ok(dbq("SELECT 1 FROM admin_audit WHERE action='social.sticker.disable' AND target_id='rocket'").length);
  assert.equal((await api.b.call('PUT', '/v1/admin/stickers/bull', { enabled: false })).status, 403);
  // GIF provider adapter: off without a key; host allowlist and rating filter.
  r = await api.b.call('GET', '/v1/social/gifs/search?q=cat');
  assert.deepEqual([r.status, r.code], [403, 'feature_disabled']);
  assert.equal((await new Client(BASE).call('GET', '/v1/social/gifs/search?q=cat')).status, 401);
  assert.equal(createGifProvider({}).enabled, false);
  assert.equal(hostAllowed('https://media.example.test/a.gif', 'media.example.test'), true);
  for (const u of ['http://media.example.test/a.gif', 'https://media.example.test.evil.example/a.gif', 'https://user@media.example.test/a.gif', 'https://media.example.test:8443/a.gif', ['javascript', 'alert(1)'].join(':')]) assert.equal(hostAllowed(u, 'media.example.test'), false, u);
  assert.deepEqual(['g', 'pg', 'pg-13', 'r', 'x'].map((x) => ratingAllowed(x, 'pg')), [true, true, false, false, false]);
  for (const p of [pm, pb]) { await clean(p); await p.context().close(); }
});

test('promo-card targeting: series → event pages, category → category pages, hidden from signed-out visitors', async () => {
  const pm = await newPage(); await logIn(pm, { email: ADMIN.email, password: ADMIN.password });
  await pm.goto(BASE + '/admin/content/promos');
  await pm.click('[data-new]');
  await pm.fill('#f-promos-title', 'Council season spotlight');
  await pm.fill('#f-promos-link', '/category/politics');
  await pm.fill('#f-promos-series_tickers', 'plxcouncil');
  await pm.click('[data-testid=promos-form] button[type=submit]');
  await until(() => dbq("SELECT 1 FROM cms_promos WHERE title='Council season spotlight'").length);
  assert.equal(dbq("SELECT series_tickers FROM cms_promos WHERE title='Council season spotlight'")[0].series_tickers, '["PLXCOUNCIL"]');
  ok(await api.admin.call('POST', '/v1/admin/content/promos', { title: 'Politics desk', link: '/category/politics', categories: 'Politics', hide_logged_out: true }), 201);
  ok(await api.admin.call('POST', '/v1/admin/content/promos', { title: 'Home only card', link: '/browse' }), 201);
  assert.equal((await api.admin.call('POST', '/v1/admin/content/promos', { title: 'bad', link: '/x', series_tickers: 'NOPE-SERIES' })).code, 'validation_failed');
  assert.equal((await api.admin.call('POST', '/v1/admin/content/promos', { title: 'bad', link: '/x', categories: 'Gardening' })).code, 'validation_failed');
  // Home: only the untargeted card.
  const home = (await api.b.call('GET', '/v1/bff/home')).body.home.promos.map((p) => p.title);
  assert.ok(home.includes('Home only card') && !home.includes('Council season spotlight') && !home.includes('Politics desk'), home.join());
  // Event page of the series and the category page; signed-out visitors miss the hidden one.
  const pb = await newPage(); await logIn(pb, B);
  await pb.goto(BASE + EV_URL);
  await pb.waitForSelector('[data-testid=targeted-promo]:has-text("Council season spotlight")');
  await pb.goto(BASE + '/category/politics');
  await pb.waitForSelector('[data-testid=targeted-promo]:has-text("Politics desk")');
  const anon = await newPage();
  await anon.goto(BASE + '/category/politics');
  await anon.waitForSelector('[data-testid=event-card]');
  await sleep(300);
  assert.equal(await anon.locator('[data-testid=targeted-promo]').count(), 0);
  assert.deepEqual((await new Client(BASE).call('GET', '/v1/promos?category=Politics')).body.promos, []);
  for (const p of [pm, pb, anon]) { await clean(p); await p.context().close(); }
});

// ------------------------------------------------------------------------------------------------ G3
test('RFQ obscure_creator_id (placeholder until execution) and rest_remainder (unfilled remainder rests at the quoted price)', async () => {
  const T = 'PLXCOUNCIL-27MAYOR-OKAFOR';
  for (const c of [api.a, api.b, api.c]) ok(await c.call('PUT', `/v1/users/${c.uid}/properties`, { properties: { rfq_enabled: true } }));
  const realA = (await api.a.call('GET', '/v1/communications/id')).body.communications_id;
  // Obscured RFQ: B (and the WS broadcast) see the shared placeholder; A sees its own id.
  const sb = api.b.socket(); await sb.opened; await sb.subscribe(['communications']);
  let r = await api.a.call('POST', '/v1/communications/rfqs', { market_ticker: T, contracts_fp: '10', obscure_creator_id: true, rest_remainder: true });
  ok(r, 201);
  const rfq = r.body.id;
  assert.equal(r.body.rfq.creator_id, realA);
  const ws = await sb.waitFor((m) => m.type === 'rfq_created' && m.msg.id === rfq);
  assert.equal(ws.msg.creator_id, OBSCURED_CREATOR_ID);
  const others = (await api.b.call('GET', '/v1/communications/rfqs?scope=others')).body.rfqs.find((x) => x.id === rfq);
  assert.equal(others.creator_id, OBSCURED_CREATOR_ID);
  assert.equal((await api.a.call('POST', '/v1/communications/rfqs', { market_ticker: T, contracts_fp: '1', obscure_creator_id: 'yes', replace_existing: true })).status, 400);
  // B quotes a YES bid one cent above the best resting YES bid (so B's maker order becomes the best bid).
  const q0 = quote(T);
  const yesBid = q0.yes_bid + 1;
  assert.ok(yesBid < q0.yes_ask, 'room inside the spread');
  r = await api.b.call('POST', '/v1/communications/quotes', { rfq_id: rfq, yes_bid: (yesBid / 100).toFixed(2), no_bid: '0.01' });
  ok(r, 201);
  const qid = r.body.id;
  assert.equal(r.body.quote.rfq_creator_id, OBSCURED_CREATOR_ID);
  ok(await api.a.call('PUT', `/v1/communications/rfqs/${rfq}/quotes/${qid}/accept`, { accepted_side: 'yes' }, { 'Idempotency-Key': `acc-${stamp}` }));
  r = await api.b.call('PUT', `/v1/communications/quotes/${qid}/confirm`, {}, { 'Idempotency-Key': `conf-${stamp}` });
  ok(r);
  assert.equal(r.body.quote.status, 'confirmed');
  const makerOrder = dbq('SELECT maker_order_id FROM rfq_quotes WHERE id=?', qid)[0].maker_order_id;
  // Once confirmed the maker cannot withdraw during the execution timer.
  assert.equal((await api.b.call('DELETE', `/v1/users/${api.b.uid}/orders/${makerOrder}`)).code, 'rfq_execution_pending');
  // Meanwhile C sells YES into B's resting bid (buys NO at 100 − bid): 4 of the 10 contracts go to C.
  ok(await api.c.call('POST', `/v1/users/${api.c.uid}/orders`, { ticker: T, side: 'no', type: 'limit', price: 100 - yesBid, count: 4 }), 201);
  assert.equal(dbq('SELECT remaining_count FROM orders WHERE id=?', makerOrder)[0].remaining_count, 600);
  const done = await until(() => dbq("SELECT * FROM rfq_quotes WHERE id=? AND status='executed'", qid)[0], 10000);
  assert.ok(done, 'executed after the timer');
  assert.deepEqual([done.executed_units, done.rested_units], [600, 400]);
  const rest = dbq('SELECT * FROM orders WHERE id=?', done.rest_order_id)[0];
  assert.deepEqual([rest.user_id, rest.side, rest.price_cents, rest.status, rest.remaining_count], [api.a.uid, 'no', 100 - yesBid, 'resting', 400]);
  // After execution everyone sees the real creator id.
  assert.equal((await api.b.call('GET', `/v1/communications/quotes/${qid}`)).body.quote.rfq_creator_id, realA);
  assert.equal((await api.b.call('GET', `/v1/communications/rfqs/${rfq}`)).body.rfq.creator_id, realA);
  ok(await api.a.call('DELETE', `/v1/users/${api.a.uid}/orders/${rest.id}`)); // clean up the resting remainder
  // Without rest_remainder the unfilled part is cancelled (IOC).
  r = await api.a.call('POST', '/v1/communications/rfqs', { market_ticker: T, contracts_fp: '10' });
  const rfq2 = r.body.id;
  const yb2 = quote(T).yes_bid + 1;
  const qid2 = (await api.b.call('POST', '/v1/communications/quotes', { rfq_id: rfq2, yes_bid: (yb2 / 100).toFixed(2), no_bid: '0.01' })).body.id;
  ok(await api.a.call('PUT', `/v1/communications/rfqs/${rfq2}/quotes/${qid2}/accept`, { accepted_side: 'yes' }, { 'Idempotency-Key': `acc2-${stamp}` }));
  ok(await api.b.call('PUT', `/v1/communications/quotes/${qid2}/confirm`, {}, { 'Idempotency-Key': `conf2-${stamp}` }));
  ok(await api.c.call('POST', `/v1/users/${api.c.uid}/orders`, { ticker: T, side: 'no', type: 'limit', price: 100 - yb2, count: 3 }), 201);
  const done2 = await until(() => dbq("SELECT * FROM rfq_quotes WHERE id=? AND status='executed'", qid2)[0], 10000);
  assert.deepEqual([done2.executed_units, done2.rested_units, done2.rest_order_id], [700, 0, null]);
  assert.equal(dbq("SELECT COUNT(*) c FROM orders WHERE user_id=? AND market_ticker=? AND status='resting'", api.a.uid, T)[0].c, 0);
  sb.close();
});

// ------------------------------------------------------------------------------------------------ persistence + layout
test('restart keeps mutes, topics, preferences, subscriptions, badges, edits, reactions, stickers and avatars; 390px layout', async () => {
  const snap = () => ({
    mutes: dbq('SELECT COUNT(*) c FROM user_mutes')[0].c, topics: dbq('SELECT COUNT(*) c FROM topic_follows')[0].c, prefs: dbq('SELECT types, quiet FROM notif_prefs ORDER BY user_id'),
    subs: dbq('SELECT COUNT(*) c FROM price_move_subs')[0].c, badges: dbq('SELECT COUNT(*) c FROM social_badges')[0].c, edits: dbq('SELECT COUNT(*) c FROM post_edits')[0].c,
    chatEdits: dbq('SELECT COUNT(*) c FROM chat_message_edits')[0].c, stickers: dbq('SELECT id, enabled FROM social_stickers ORDER BY id'), avatars: dbq('SELECT user_id, status FROM profile_avatars ORDER BY user_id'),
  });
  ok(await api.b.call('POST', `/v1/users/${api.b.uid}/social/mutes`, { nickname: C.nick }), 201);
  const before = snap();
  await srv.close();
  srv = await start(OPTS);
  assert.deepEqual(snap(), before);
  for (const [k, u] of [['a', A], ['b', B], ['c', C], ['m', M]]) api[k] = await new Client(BASE, k).logIn(u.email, u.password);
  assert.ok((await api.b.call('GET', `/v1/users/${api.b.uid}/social/mutes`)).body.mutes.some((m) => m.nickname === C.nick));
  assert.ok((await api.b.call('GET', `/v1/users/${api.b.uid}/social/topics`)).body.topics.some((t) => t.value === 'gondola'));
  assert.equal((await api.b.call('GET', `/v1/users/${api.b.uid}/notifications/preferences`)).body.types.find((t) => t.type === 'social_like').in_app, false);
  assert.ok((await api.b.call('GET', `/v1/social/badges?nickname=${C.nick}`)).body.badges.find((b) => b.id === 'top_10').earned);
  assert.ok(!(await api.b.call('GET', '/v1/social/stickers')).body.stickers.some((s) => s.id === 'rocket'));
  ok(await api.m.call('PUT', '/v1/admin/stickers/rocket', { enabled: true, reason: 'restore after test' }));
  // 390px: social pages, settings, a post page and the event page with the composer extras open — no overflow.
  const pid = (await api.a.call('POST', `/v1/users/${api.a.uid}/social/posts`, { body: `${'w'.repeat(300)} long unbroken body`, sticker_id: 'rocket' })).body.post.id;
  const page = await newPage({ width: 390, height: 844 });
  await logIn(page, A);
  for (const url of ['/social', `/social/post/${pid}`, '/social/settings', '/notifications/settings', `/social/profile/${A.nick}`, '/social/leaderboard', SEN_URL]) {
    await page.goto(BASE + url);
    await page.waitForLoadState('networkidle');
    if (url === '/social') { await page.click('[data-testid=add-position]'); await page.waitForSelector('[data-testid=position-picker]'); await page.click('[data-testid=composer-sticker]'); await page.waitForSelector('[data-testid=sticker-picker]'); }
    if (url === SEN_URL) { await page.waitForSelector('[data-testid=follow-card]'); }
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.waitForTimeout(100);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 0, `${url} (${theme}) overflows by ${over}px`);
    }
  }
  await openChat(page, SEN_URL);
  await page.click('[data-testid=chat-sticker-btn]');
  await page.waitForSelector('[data-testid=sticker-picker]');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 0, `chat drawer with sticker picker overflows by ${over}px`);
  await clean(page); await page.context().close();
});
