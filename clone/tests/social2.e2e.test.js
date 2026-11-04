'use strict';
// End-to-end browser tests for Phase 2 social and community completion (CLONE_SPEC.md §24; PLAN §3 Phase 2, §11 A6 +
// A11, gaps G3, G8, G10): post extras (position tag verified by the server, sticker, Read more, share / copy link,
// canonical page, 10-minute edit window with moderator-visible history), mutes applied to feeds / replies / chat /
// notifications, topic follows + timeline counts + nickname search + badges, Inner Circle with circle-only posts,
// the §13.16 notification matrix (pills, sub-options, quiet hours, email + push channels, browser push, leaderboard
// push, security toggle), the four social-admin PUT endpoints + profile-picture decision + promo targeting + sticker
// switch with audit rows, event-chat reactions and edits, RFQ obscure_creator_id / rest_remainder, XSS on every new
// text field, object-level IDOR with a second user, restart persistence, 390px layout, no page errors, no CSP violations.
// Real server + SQLite file + Chromium; several users in separate browser contexts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-social2-'));
const DB_FILE = path.join(TMP, 'social2.db');
// A port the OS reports free (a random pick could collide with another process on the CI machine).
const freePort = () => new Promise((res, rej) => { const s = require('node:net').createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
let PORT; let BASE;
const PW = 'Quartz-Lantern-Meadow-7391'; // secret-scan:allow (throwaway E2E account password)
const stamp = Date.now();
const HIGH = { burst: 1e6, per_second: 1e6 };
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, quiet: true, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, admin: ADMIN };
const TRAM = 'PLXCOUNCIL-27TRAM';
const TRAM_URL = '/markets/plxcouncil/harbor-city-council-vote/plxcouncil-27tram';
const RATE_EV = 'PLXRATE-26DEC';
const RATE_URL = '/markets/plxrate/central-bank-decision/plxrate-26dec';
const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script><svg onload="window.__xss=3">';
const sfx = String(stamp % 100000);
const U = {
  a: { email: `s2.a.${stamp}@example.test`, nick: `ava_${sfx}` },
  b: { email: `s2.b.${stamp}@example.test`, nick: `ben_${sfx}` },
  c: { email: `s2.c.${stamp}@example.test`, nick: `cal_${sfx}` },
};

let srv; let browser;
const api = {};
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(100); }
}
const show = (r) => `${r.status} ${r.text ? r.text.slice(0, 300) : ''}`;

async function newPage({ viewport = { width: 1366, height: 900 }, permissions = [] } = {}) {
  const ctx = await browser.newContext({ viewport, permissions });
  const page = await ctx.newPage();
  page.errors = []; page.csp = [];
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
const cspOf = (page) => page.evaluate(() => window.__cspv || []);
const postCard = (page, text) => page.locator('[data-testid=post]', { has: page.locator('[data-testid=post-body]', { hasText: text }) });
// Contracts that sweep the best level of the book and reach into the next one (so prices move and orders fill
// against several makers), for a market buy of `buySide` (YES buys consume NO bids and vice versa).
async function sweepCount(client, ticker, buySide) {
  const ob = (await client.call('GET', `/trade-api/v2/markets/${ticker}/orderbook`)).body.orderbook_fp;
  const levels = (buySide === 'yes' ? ob.no_dollars : ob.yes_dollars).map(([p, c]) => [Number(p), Number(c)]).sort((x, y) => y[0] - x[0]);
  assert.ok(levels.length >= 2, `need two price levels on ${ticker}`);
  return Math.ceil(levels[0][1]) + 1;
}
const notifs = (uid, type) => dbq('SELECT * FROM notifications WHERE user_id=? AND type=? ORDER BY created_ts', uid, type);

before(async () => {
  PORT = await freePort(); BASE = `http://127.0.0.1:${PORT}`; OPTS.port = PORT;
  srv = await start(OPTS);
  browser = await chromium.launch();
  for (const k of ['a', 'b', 'c']) {
    api[k] = await new Client(BASE, k).signUp(U[k].email, PW, `Tester ${k.toUpperCase()}`);
    assert.equal((await api[k].call('POST', `/v1/users/${api[k].uid}/social/profile`, { nickname: U[k].nick })).status, 201);
    assert.equal((await api[k].call('POST', `/v1/users/${api[k].uid}/deposits`, { amount_dollars: 500 })).status, 201);
  }
  api.admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('post extras: "+ Add a position" tag verified by the server, sticker, Read more, share / copy link, canonical page', async () => {
  const { a, b } = api;
  let r = await a.call('POST', `/v1/users/${a.uid}/orders`, { ticker: TRAM, side: 'yes', type: 'market', count: 3 });
  assert.equal(r.status, 201, show(r));
  const pa = await newPage(); await logIn(pa, U.a.email);
  await pa.goto(BASE + '/social');
  await pa.click('[data-testid=add-position]');
  await pa.locator(`[data-testid=position-opt][data-ticker="${TRAM}"][data-side=yes]`).click();
  assert.match(await pa.textContent('[data-testid=composer-position-chip]'), /^Yes · Approved · /);
  await pa.click('[data-testid=composer-sticker]');
  await pa.click('[data-testid=sticker-opt-bull]');
  await pa.waitForSelector('[data-testid=composer-sticker-chip]');
  const long = `Tram vote thesis: ${'the second reading looks solid and the budget line is funded. '.repeat(6)}END-OF-THESIS`;
  await pa.fill('[data-testid=composer-input]', long);
  await pa.click('[data-testid=composer-submit]');
  const mine = postCard(pa, 'Tram vote thesis');
  await mine.locator('[data-testid=position-tag]').waitFor();
  const pid = await mine.getAttribute('data-post');
  const ext = dbq('SELECT * FROM post_extras WHERE post_id=?', pid)[0];
  assert.deepEqual([ext.position_ticker, ext.position_side, ext.position_held, ext.sticker_id, ext.visibility], [TRAM, 'yes', 'current', 'bull', 'public']);

  // B sees the tag "Yes · outcome · market", the sticker image, a clamped body with Read more.
  const pb = await newPage({ permissions: ['clipboard-read', 'clipboard-write'] }); await logIn(pb, U.b.email);
  await pb.goto(BASE + '/social');
  const card = postCard(pb, 'Tram vote thesis');
  await card.waitFor();
  assert.match(await card.locator('[data-testid=position-tag]').textContent(), /^Yes · Approved · Will Harbor City approve the waterfront tram\?$/);
  assert.equal(await card.locator('[data-testid=sticker]').getAttribute('src'), '/v1/social/stickers/bull.svg');
  assert.equal(await card.locator('[data-testid=post-body]').evaluate((e) => e.classList.contains('clamped')), true);
  await card.locator('[data-testid=read-more]').click();
  await card.locator('[data-testid=read-more]:has-text("Show less")').waitFor();
  assert.equal(await card.locator('[data-testid=post-body]').evaluate((e) => e.classList.contains('clamped')), false);
  // ⋯ → Copy link puts the canonical URL on the clipboard; the share button falls back to copying too.
  await card.locator('[data-testid=post-menu]').click();
  await pb.click('[data-testid=post-copy-link]');
  await until(async () => (await pb.evaluate(() => navigator.clipboard.readText().catch(() => ''))) === `${BASE}/social/post/${pid}`, 5000, 'clipboard link');
  // The canonical page shows the post with its replies open.
  await pb.goto(`${BASE}/social/post/${pid}`);
  await pb.locator('[data-testid=post-page] [data-testid=position-tag]').waitFor();
  await pb.locator('[data-testid=post-page] .comments:not([hidden])').waitFor();
  // The sticker SVG is served same-origin with a locked-down CSP and no script.
  const svg = await fetch(`${BASE}/v1/social/stickers/bull.svg`);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(svg.headers.get('content-security-policy'), /script-src 'none'/);
  assert.doesNotMatch(await svg.text(), /<script|on[a-z]+=/i);

  // Server-side verification: a side never held, a market never traded, bad shapes, unknown / non-string stickers.
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: 'no tag', position: { market_ticker: TRAM, side: 'no' } });
  assert.deepEqual([r.status, r.code], [409, 'position_not_held'], show(r));
  r = await b.call('POST', `/v1/users/${b.uid}/social/posts`, { body: 'not mine', position: { market_ticker: TRAM, side: 'yes' } });
  assert.deepEqual([r.status, r.code], [409, 'position_not_held'], show(r));
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: 'shape', position: 'PLXCOUNCIL-27TRAM' });
  assert.equal(r.status, 400, show(r));
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { sticker_id: 'not-a-sticker' });
  assert.equal(r.status, 400, show(r));
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: 'x', sticker_id: { id: 'bull' } });
  assert.deepEqual([r.status, r.code], [400, 'validation_failed'], show(r));
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: `bidi ${String.fromCodePoint(0x202e)} spoof` });
  assert.equal(r.status, 400, show(r));
  // A sticker-only post is allowed.
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { sticker_id: 'rocket' });
  assert.equal(r.status, 201, show(r));
  assert.equal(r.body.post.sticker.id, 'rocket');
  assert.deepEqual([...pa.errors, ...pb.errors], []);
  assert.deepEqual([...await cspOf(pa), ...await cspOf(pb)], []);
  await pa.context().close(); await pb.context().close();
});

test('10-minute edit window with "edited" and moderator-visible history; mute hides posts, replies, chat and notifications', async () => {
  const { a, b } = api;
  let r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: 'First draft of my rate view' });
  const pid = r.body.post.id;
  assert.ok(r.body.post.editable_until);
  const pa = await newPage(); await logIn(pa, U.a.email);
  await pa.goto(`${BASE}/social/post/${pid}`);
  const card = postCard(pa, 'First draft');
  await card.locator('[data-testid=post-menu]').click();
  await pa.click('[data-testid=post-edit]');
  await pa.fill('[data-testid=post-edit-input]', 'Second draft of my rate view');
  await pa.click('[data-testid=post-edit-save]');
  await postCard(pa, 'Second draft').locator('[data-testid=post-edited]').waitFor();
  const ed = dbq('SELECT * FROM post_edits WHERE post_id=?', pid);
  assert.deepEqual([ed.length, ed[0].prev_body, ed[0].new_body, ed[0].by_moderator], [1, 'First draft of my rate view', 'Second draft of my rate view', 0]);
  const pb = await newPage(); await logIn(pb, U.b.email);
  await pb.goto(`${BASE}/social/post/${pid}`);
  await postCard(pb, 'Second draft').locator('[data-testid=post-edited]').waitFor();
  // Window closed: 409 from the API and no Edit item in the menu.
  dbrun('UPDATE posts SET created_ts=created_ts-? WHERE id=?', 11 * 60000, pid);
  r = await a.call('PUT', `/v1/users/${a.uid}/social/posts/${pid}`, { body: 'Too late' });
  assert.deepEqual([r.status, r.code], [409, 'edit_window_closed'], show(r));
  r = await b.call('PUT', `/v1/users/${b.uid}/social/posts/${pid}`, { body: 'Not mine' });
  assert.equal(r.status, 404, 'another user\'s post is not found');
  await pa.reload();
  await postCard(pa, 'Second draft').locator('[data-testid=post-menu]').click();
  await pa.locator('[data-testid=post-menu-list]').waitFor();
  assert.equal(await pa.locator('[data-testid=post-edit]').count(), 0);
  // Moderator: Admin › Community › Post lookup shows the history.
  const pm = await newPage(); await logIn(pm, ADMIN.email);
  await pm.goto(`${BASE}/admin/community/posts/${pid}`);
  await pm.locator('[data-testid=adm-edit-row]').waitFor();
  assert.match(await pm.textContent('[data-testid=adm-post-edits]'), /First draft of my rate view[\s\S]*Second draft of my rate view/);
  await pm.context().close();

  // Mute: B mutes A from the ⋯ menu; A's posts disappear for B, but not for others.
  await pb.goto(BASE + '/social');
  await postCard(pb, 'Second draft').locator('[data-testid=post-menu]').click();
  await pb.click('[data-testid=post-mute]');
  await postCard(pb, 'Second draft').waitFor({ state: 'detached' });
  assert.equal(dbq('SELECT COUNT(*) c FROM user_mutes WHERE muter_id=? AND muted_id=?', b.uid, a.uid)[0].c, 1);
  r = await b.call('GET', '/v1/social/posts');
  assert.ok(!r.body.posts.some((p) => p.author.nickname === U.a.nick), 'muted author still in B\'s feed');
  r = await api.c.call('GET', '/v1/social/posts');
  assert.ok(r.body.posts.some((p) => p.author.nickname === U.a.nick), 'mute must not affect other users');
  // Replies: A's reply on B's post is hidden for B only.
  r = await b.call('POST', `/v1/users/${b.uid}/social/posts`, { body: 'B asks: tram or no tram?' });
  const bpid = r.body.post.id;
  assert.equal((await a.call('POST', `/v1/users/${a.uid}/social/posts/${bpid}/comments`, { body: 'A answers: tram' })).status, 201);
  assert.equal((await b.call('GET', `/v1/social/posts/${bpid}/comments`)).body.comments.length, 0);
  assert.equal((await api.c.call('GET', `/v1/social/posts/${bpid}/comments`)).body.comments.length, 1);
  // Notifications caused by a muted user are dropped (reply above, like below).
  const before = dbq('SELECT COUNT(*) c FROM notifications WHERE user_id=?', b.uid)[0].c;
  assert.equal((await a.call('POST', `/v1/users/${a.uid}/social/posts/${bpid}/like`, {})).status, 200);
  await sleep(300);
  assert.equal(dbq('SELECT COUNT(*) c FROM notifications WHERE user_id=?', b.uid)[0].c, before);
  assert.equal(notifs(b.uid, 'social_comment').length, 0);
  // Event chat: history and live frames skip the muted author for B.
  assert.equal((await a.call('POST', `/v1/users/${a.uid}/chat/${TRAM}/messages`, { body: 'muted chat line from A' })).status, 201);
  r = await b.call('GET', `/v1/events/${TRAM}/chat`);
  assert.ok(!r.body.messages.some((m) => m.body === 'muted chat line from A'));
  await pb.goto(BASE + TRAM_URL);
  await pb.waitForSelector('[data-testid=chat-pill][data-status]');
  await pb.click('[data-testid=chat-pill]');
  await pb.waitForSelector('[data-testid=chat-panel]:not([hidden])');
  assert.equal((await a.call('POST', `/v1/users/${a.uid}/chat/${TRAM}/messages`, { body: 'live muted line from A' })).status, 201);
  assert.equal((await api.c.call('POST', `/v1/users/${api.c.uid}/chat/${TRAM}/messages`, { body: 'live line from C' })).status, 201);
  await pb.locator('[data-testid=chat-body]', { hasText: 'live line from C' }).waitFor();
  assert.equal(await pb.locator('[data-testid=chat-body]', { hasText: 'live muted line from A' }).count(), 0);
  // Unmute from Social settings restores A's posts.
  await pb.goto(BASE + '/social/settings');
  await pb.locator(`[data-testid=muted-row][data-nick="${U.a.nick}"] [data-testid=unmute]`).click();
  await pb.locator('[data-testid=no-mutes]').waitFor();
  r = await b.call('GET', '/v1/social/posts');
  assert.ok(r.body.posts.some((p) => p.author.nickname === U.a.nick));
  assert.deepEqual([...pa.errors, ...pb.errors], []);
  await pa.context().close(); await pb.context().close();
});

test('topics: follow an event and a keyword, Topics feed, topic notifications, "N new posts", nickname search, badges', async () => {
  const { a, b } = api;
  const pb = await newPage(); await logIn(pb, U.b.email);
  await pb.goto(BASE + RATE_URL);
  await pb.click('[data-testid=follow-event]');
  await pb.locator('[data-testid=follow-event][aria-pressed=true]').waitFor();
  assert.equal(dbq("SELECT COUNT(*) c FROM topic_follows WHERE user_id=? AND kind='event' AND value=?", b.uid, RATE_EV)[0].c, 1);
  await pb.goto(BASE + '/social/settings');
  await pb.fill('[data-testid=topic-keyword]', 'Ferry');
  await pb.click('[data-testid=topic-add] button[type=submit]');
  await pb.locator('[data-testid=topic-row][data-kind=keyword]').waitFor();
  assert.equal(dbq("SELECT value FROM topic_follows WHERE user_id=? AND kind='keyword'", b.uid)[0].value, 'ferry');
  // B waits on the feed; A posts on the event → the "new posts" pill appears without a reload.
  await pb.goto(BASE + '/social');
  await pb.waitForSelector('[data-testid=post]');
  let r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: 'Rate cut looks priced in', event_ticker: RATE_EV });
  assert.equal(r.status, 201, show(r));
  await pb.locator('[data-testid=new-posts]:not([hidden])').waitFor({ timeout: 15000 });
  assert.match(await pb.textContent('[data-testid=new-posts]'), /^1 new post/);
  await pb.click('[data-testid=new-posts]');
  await postCard(pb, 'Rate cut looks priced in').waitFor();
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: 'The new ferry route will win the vote' });
  await until(() => notifs(b.uid, 'social_topic').length === 2, 5000, 'topic notifications');
  const topicN = notifs(b.uid, 'social_topic');
  assert.match(topicN[0].title, new RegExp(`@${U.a.nick} posted about`));
  assert.match(topicN[0].link, /^\/social\/post\/p_/);
  // Topics feed lists both.
  await pb.click('[data-feed=topics]');
  await postCard(pb, 'ferry route').waitFor();
  await postCard(pb, 'Rate cut looks priced in').waitFor();
  r = await b.call('GET', `/v1/social/timeline_count?feed=topics&since=${Date.now() - 600000}`);
  assert.ok(r.body.count >= 2, show(r));
  // Nickname-prefix search only (never email), rate-limited.
  await pb.fill('[data-testid=profile-search-input]', U.a.nick.slice(0, 4));
  await pb.locator(`[data-testid=profile-result]:has-text("@${U.a.nick}")`).waitFor();
  r = await b.call('GET', `/v1/search/social_profiles?query=${encodeURIComponent('s2.a')}`);
  assert.equal(r.status, 400);
  r = await b.call('GET', `/v1/search/social_profiles?query=${encodeURIComponent(U.a.email.split('@')[0].replace(/\./g, '_'))}`);
  assert.deepEqual(r.body.profiles, []);
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) { const x = await b.call('GET', '/v1/search/social_profiles?query=a'); if (x.status === 429) limited = x; }
  assert.ok(limited, 'search is rate-limited');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1 && limited.body.error.retry_after_sec >= 1);
  // Earned badges (first trade, from persisted fills) on the profile page.
  await pb.goto(`${BASE}/social/profile/${U.a.nick}`);
  await pb.locator('[data-testid=profile-badges] [data-badge=first_trade]').waitFor();
  r = await b.call('GET', `/v1/social/badges?nickname=${U.a.nick}`);
  assert.equal(r.body.badges.find((x) => x.id === 'first_trade').earned, true);
  assert.equal(r.body.badges.find((x) => x.id === 'ten_trades').earned, false);
  assert.equal(dbq("SELECT COUNT(*) c FROM social_badges WHERE user_id=? AND badge='first_trade'", a.uid)[0].c, 1);
  assert.deepEqual(pb.errors, []);
  assert.deepEqual(await cspOf(pb), []);
  await pb.context().close();
});

test('Inner Circle: request → live notification → accept; circle-only posts visible to the circle only; remove', async () => {
  const { a, b, c } = api;
  const pa = await newPage(); await logIn(pa, U.a.email);
  const pc = await newPage(); await logIn(pc, U.c.email);
  await pc.goto(BASE + '/social');
  await pa.goto(`${BASE}/social/profile/${U.c.nick}`);
  await pa.click('[data-testid=circle-btn]');
  await pa.locator('[data-testid=circle-btn]:has-text("Circle request sent")').waitFor();
  await pc.locator('[data-testid=unread-count]').waitFor(); // live over the private notifications channel
  await until(() => notifs(c.uid, 'circle_request').length === 1, 5000, 'circle request notification');
  await pc.goto(BASE + '/social/circle');
  await pc.locator(`[data-testid=circle-incoming-row][data-nick="${U.a.nick}"] [data-testid=circle-accept]`).click();
  await pc.locator(`[data-testid=circle-member][data-nick="${U.a.nick}"]`).waitFor();
  await until(() => notifs(a.uid, 'circle_accepted').length === 1, 5000, 'circle accepted notification');
  assert.equal(dbq('SELECT COUNT(*) c FROM circle_members WHERE (owner_id=? AND member_id=?) OR (owner_id=? AND member_id=?)', a.uid, c.uid, c.uid, a.uid)[0].c, 2);
  // B follows A (so the follower notification path is exercised), then A posts circle-only from the composer.
  assert.equal((await b.call('POST', `/v1/users/${b.uid}/social/follow`, { nickname: U.a.nick })).status, 200);
  await pa.goto(BASE + '/social');
  await pa.fill('[data-testid=composer-input]', 'Circle only: my real tram position');
  await pa.selectOption('[data-testid=composer-visibility]', 'circle');
  await pa.click('[data-testid=composer-submit]');
  await postCard(pa, 'Circle only').locator('[data-testid=circle-badge]').waitFor();
  const pid = await postCard(pa, 'Circle only').getAttribute('data-post');
  assert.equal(dbq('SELECT visibility FROM post_extras WHERE post_id=?', pid)[0].visibility, 'circle');
  // C (circle) sees it in the Inner Circle feed; B (follower, not in the circle) and anonymous visitors do not.
  await pc.goto(BASE + '/social');
  await pc.click('[data-feed=circle]');
  await postCard(pc, 'Circle only').locator('[data-testid=circle-badge]').waitFor();
  assert.equal((await b.call('GET', `/v1/social/posts/${pid}`)).status, 404);
  assert.equal((await b.call('GET', `/v1/social/posts/${pid}/comments`)).status, 404);
  assert.equal((await b.call('POST', `/v1/users/${b.uid}/social/posts/${pid}/like`, {})).status, 404);
  assert.ok(!(await b.call('GET', '/v1/social/posts')).body.posts.some((p) => p.id === pid));
  assert.ok(!(await b.call('GET', `/v1/social/posts?nickname=${U.a.nick}`)).body.posts.some((p) => p.id === pid));
  const anon = await new Client(BASE, 'anon').boot();
  assert.equal((await anon.call('GET', `/v1/social/posts/${pid}`)).status, 404);
  assert.ok(!(await anon.call('GET', '/v1/social/posts')).body.posts.some((p) => p.id === pid));
  assert.equal(dbq('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND link=?', b.uid, `/social/post/${pid}`)[0].c, 0, 'a follower outside the circle got a notification');
  const pb = await newPage(); await logIn(pb, U.b.email);
  await pb.goto(`${BASE}/social/post/${pid}`);
  await pb.locator('[data-testid=post-missing]').waitFor();
  // C removes A: the relationship ends on both sides and the post is gone for C.
  await pc.goto(BASE + '/social/circle');
  await pc.locator(`[data-testid=circle-member][data-nick="${U.a.nick}"] [data-testid=circle-remove]`).click();
  await pc.locator(`[data-testid=circle-member][data-nick="${U.a.nick}"]`).waitFor({ state: 'detached' });
  assert.equal(dbq('SELECT COUNT(*) c FROM circle_members WHERE owner_id IN (?,?) AND member_id IN (?,?)', a.uid, c.uid, a.uid, c.uid)[0].c, 0);
  assert.equal((await c.call('GET', `/v1/social/posts/${pid}`)).status, 404);
  // Validation and limits: self, unknown, duplicates.
  let r = await a.call('POST', `/v1/users/${a.uid}/social/circle/requests`, { nickname: U.a.nick });
  assert.equal(r.status, 400);
  r = await a.call('POST', `/v1/users/${a.uid}/social/circle/requests`, { nickname: 'nobody_here_x' });
  assert.equal(r.status, 404);
  r = await a.call('POST', `/v1/users/${a.uid}/social/circle/requests`, { nickname: U.b.nick, extra: 1 });
  assert.deepEqual([r.status, r.code], [400, 'validation_failed']);
  assert.deepEqual([...pa.errors, ...pb.errors, ...pc.errors], []);
  await pa.context().close(); await pb.context().close(); await pc.context().close();
});

test('notification settings: the §13.16 matrix, pills persist, sub-options, email + push channels, quiet hours, browser push, leaderboard push', async () => {
  const { a, b } = api;
  const pb = await newPage({ permissions: ['notifications'] });
  await pb.addInitScript(() => {
    window.__pushes = [];
    window.Notification = class { constructor(t, o) { window.__pushes.push({ title: t, body: o && o.body }); } static get permission() { return 'granted'; } static requestPermission() { return Promise.resolve('granted'); } };
  });
  await logIn(pb, U.b.email);
  await pb.goto(BASE + '/notifications/settings');
  await pb.waitForSelector('[data-testid=notification-settings] [data-testid=group-general]');
  // Exact groups, types and offered channels (observed matrix).
  const matrix = await pb.$$eval('[data-testid=notification-settings] .nt-group', (gs) => gs.map((g) => [g.dataset.group, [...g.querySelectorAll('.nt-row')].map((r) => [r.querySelector('.nt-label').textContent, [...r.querySelectorAll('.ch-pill')].map((p) => p.textContent).join('·')])]));
  const want = [
    ['general', [['Transfers', 'Email·Push'], ['Referral rewards', 'In-app·Email·Push'], ['Referral activity', 'In-app·Email·Push'], ['Market rewards', 'In-app·Email·Push']]],
    ['predictions', [['Price movement', 'In-app·Email·Push'], ['Market settlement', 'Email·Push'], ['Order auto-cancellation', 'In-app·Email·Push'], ['Taker-side trade confirmation', 'In-app·Email·Push'], ['Maker-side trade confirmation', 'In-app·Email·Push']]],
    ['sports', [['Major events', 'In-app·Push']]],
    ['social', [['Post alerts', 'In-app·Push'], ['Trade alerts', 'In-app·Push'], ['Position alerts', 'In-app·Push'], ['Likes, comments & follows', 'In-app·Push'], ['Inner Circle requests', 'In-app·Push'], ['Inner Circle accepted', 'In-app·Push'], ['Group chats', 'In-app·Push'], ['Leaderboard', 'Push']]],
    ['promotional', [['Breaking events', 'In-app·Email·Push'], ['New markets', 'In-app·Email·Push'], ['Politics', 'In-app·Email·Push'], ['Crypto', 'In-app·Push'], ['Commodities', 'In-app·Push']]],
  ];
  assert.deepEqual(matrix, want);
  // ⌄ sub-options exist on the observed rows.
  for (const t of ['price_movement', 'order_auto_cancel', 'taker_trade', 'maker_trade', 'major_events']) assert.equal(await pb.locator(`[data-testid=more-${t}]`).count(), 1, t);
  // Groups are collapsible (General and Predictions open by default); open Social and toggle a pill: it persists in
  // the DB and across a reload, and the group stays open while saving.
  assert.equal(await pb.locator('[data-testid=group-social][open]').count(), 0);
  await pb.click('[data-testid=group-social] summary');
  await pb.click('[data-testid=pill-social_engagement-push]');
  await pb.locator('[data-testid=pill-social_engagement-push][aria-pressed=false]').waitFor();
  assert.equal(JSON.parse(dbq('SELECT types FROM notif_prefs WHERE user_id=?', b.uid)[0].types).social_engagement.push, false);
  assert.equal(await pb.locator('[data-testid=group-social][open]').count(), 1);
  await pb.reload();
  await pb.click('[data-testid=group-social] summary');
  await pb.locator('[data-testid=pill-social_engagement-push][aria-pressed=false]').waitFor();
  // API guards: a channel the type does not offer, unknown types, bad sub-options, unknown fields.
  let r = await b.call('PUT', `/v1/users/${b.uid}/notifications/settings/transfers`, { in_app: false });
  assert.deepEqual([r.status, r.code], [400, 'channel_not_offered']);
  r = await b.call('PUT', `/v1/users/${b.uid}/notifications/settings/no_such_type`, { push: true });
  assert.equal(r.status, 404);
  r = await b.call('PUT', `/v1/users/${b.uid}/notifications/settings/price_movement`, { options: { threshold_cents: 500 } });
  assert.equal(r.status, 400);
  r = await b.call('PUT', `/v1/users/${b.uid}/notifications/preferences`, { types: {}, admin: true });
  assert.deepEqual([r.status, r.code], [400, 'validation_failed']);

  // Email channel + price-movement subscription from the event page (⌄ threshold / window in the dialog).
  await pb.click('[data-testid=pill-price_movement-email]');
  await pb.locator('[data-testid=pill-price_movement-email][aria-pressed=true]').waitFor();
  await pb.goto(BASE + TRAM_URL);
  await pb.click('[data-testid=move-alert-btn]');
  await pb.fill('[data-testid=move-threshold]', '1');
  await pb.selectOption('[data-testid=move-window]', '5');
  await pb.click('[data-testid=move-save]');
  await pb.locator('[data-testid=move-sub]').waitFor();
  assert.equal(dbq('SELECT threshold_cents, window_minutes FROM price_move_subs WHERE user_id=?', b.uid).map((x) => `${x.threshold_cents}/${x.window_minutes}`).join(), '1/5');
  await pb.keyboard.press('Escape');
  const lastBefore = dbq('SELECT yes_price_cents p FROM trades WHERE market_ticker=? ORDER BY created_ts DESC LIMIT 1', TRAM)[0]?.p;
  r = await a.call('POST', `/v1/users/${a.uid}/orders`, { ticker: TRAM, side: 'yes', type: 'market', count: await sweepCount(a, TRAM, 'yes') });
  assert.equal(r.status, 201, show(r));
  await until(() => notifs(b.uid, 'price_movement').length >= 1, 8000, 'price movement notification');
  assert.match(notifs(b.uid, 'price_movement')[0].title, /moved [▲▼] ₦\d+ in 5 min/, `last before ${lastBefore}`);
  await until(() => dbq("SELECT COUNT(*) c FROM notif_deliveries WHERE user_id=? AND pref='price_movement' AND channel='email' AND status='sent'", b.uid)[0].c >= 1, 5000, 'email delivery');
  assert.ok(dbq("SELECT COUNT(*) c FROM email_outbox WHERE user_id=? AND subject LIKE 'Parlance: %moved%'", b.uid)[0].c >= 1);

  // Browser push: register this browser; a push-channel notification is shown with the Notification API.
  await pb.goto(BASE + '/notifications/settings');
  await pb.click('[data-testid=push-enable]');
  await pb.locator('[data-testid=push-on]').waitFor();
  assert.equal(dbq('SELECT COUNT(*) c FROM push_devices WHERE user_id=?', b.uid)[0].c, 1);
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: 'Push me: post alert for followers' }); // B follows A → Post alerts (In-app + Push)
  await until(() => pb.evaluate(() => window.__pushes.some((p) => /posted/.test(p.title))), 6000, 'browser push');
  assert.equal(dbq("SELECT status FROM notif_deliveries WHERE user_id=? AND pref='post_alerts' AND channel='push' ORDER BY created_ts DESC LIMIT 1", b.uid)[0].status, 'sent');
  // Sub-option: taker confirmations only when the order completes → one summary for an order filled across levels.
  r = await b.call('PUT', `/v1/users/${b.uid}/notifications/settings/taker_trade`, { options: { fills: 'complete' } });
  assert.equal(r.status, 200, show(r));
  r = await b.call('POST', `/v1/users/${b.uid}/orders`, { ticker: TRAM, side: 'no', type: 'market', count: await sweepCount(b, TRAM, 'no') });
  assert.equal(r.status, 201, show(r));
  const oid = r.body.order.order_id;
  assert.ok(dbq('SELECT COUNT(*) c FROM fills WHERE order_id=?', oid)[0].c >= 2, 'the order should fill across several makers');
  await until(() => dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='fill' AND title LIKE 'Order % avg %'", b.uid)[0].c === 1, 5000, 'one completed-order notification');
  await sleep(400);
  assert.equal(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='fill' AND created_ts>=?", b.uid, Date.now() - 5000)[0].c, 1);

  // Quiet hours covering now: in-app kept without a toast, push deferred; turning quiet hours off releases it.
  const hh = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  await pb.fill('[data-testid=quiet-start]', hh(new Date(Date.now() - 3600000)));
  await pb.fill('[data-testid=quiet-end]', hh(new Date(Date.now() + 3600000)));
  await pb.fill('[data-testid=quiet-tz]', 'UTC');
  await pb.check('[data-testid=quiet-enabled]');
  await pb.click('[data-testid=quiet-save]');
  await pb.locator('[data-testid=quiet-now]').waitFor();
  await until(async () => (await pb.locator('.toast').count()) === 0, 6000, 'earlier toasts to clear');
  const pushesBefore = await pb.evaluate(() => window.__pushes.length);
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: 'Quiet hours post' });
  await until(() => dbq("SELECT COUNT(*) c FROM notif_deliveries WHERE user_id=? AND pref='post_alerts' AND status='deferred'", b.uid)[0].c === 1, 5000, 'deferred push');
  assert.equal(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND title LIKE '%posted' AND body='Quiet hours post'", b.uid)[0].c, 1, 'in-app row kept');
  await sleep(600);
  assert.equal(await pb.locator('.toast', { hasText: 'posted' }).count(), 0, 'no toast during quiet hours');
  assert.equal(await pb.evaluate(() => window.__pushes.length), pushesBefore);
  await pb.uncheck('[data-testid=quiet-enabled]');
  await pb.click('[data-testid=quiet-save]');
  await until(() => dbq("SELECT COUNT(*) c FROM notif_deliveries WHERE user_id=? AND pref='post_alerts' AND status='deferred'", b.uid)[0].c === 0, 5000, 'deferred push released');
  await until(() => pb.evaluate((n) => window.__pushes.length > n, pushesBefore), 5000, 'released push shown');

  // Leaderboard (Push only): climbing into the top 10 records a push delivery and no inbox row.
  dbrun("UPDATE positions SET realized_pnl_cents=realized_pnl_cents+987654 WHERE user_id=? AND market_ticker=?", b.uid, TRAM);
  await until(() => dbq("SELECT COUNT(*) c FROM notif_deliveries WHERE user_id=? AND pref='leaderboard' AND channel='push'", b.uid)[0].c >= 1, 9000, 'leaderboard push');
  assert.equal(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='leaderboard'", b.uid)[0].c, 0);
  // Security notifications toggle (separate module) persists.
  await pb.locator('[data-testid=security-notifications] input:not([disabled])').uncheck();
  await until(() => dbq('SELECT security FROM notif_prefs WHERE user_id=?', b.uid)[0].security === 0, 4000, 'security toggle');
  // Transfers: Email + Push channels; the inbox keeps them (fixed in-app).
  r = await b.call('POST', `/v1/users/${b.uid}/deposits`, { amount_dollars: 7 });
  await until(() => dbq("SELECT COUNT(*) c FROM notif_deliveries WHERE user_id=? AND pref='transfers' AND channel='email'", b.uid)[0].c >= 1, 4000, 'transfer email');
  assert.ok(notifs(b.uid, 'transfer').some((n) => /Deposit of ₦700/.test(n.title)));
  await pb.goto(BASE + '/notifications/settings');
  await pb.locator('[data-testid=deliveries] tr[data-channel=email]').first().waitFor();
  assert.deepEqual(pb.errors, []);
  assert.deepEqual(await cspOf(pb), []);
  await pb.context().close();
});

test('G8 social-admin endpoints from Admin › Community, profile-picture decision, sticker switch, promo targeting; audited', async () => {
  const { a, b } = api;
  // A picks a profile picture from the sticker set.
  const pa = await newPage(); await logIn(pa, U.a.email);
  await pa.goto(BASE + '/social/settings');
  await pa.click('[data-testid=avatar-opt-crystal-ball]');
  await pa.locator('[data-testid=avatar-opt-crystal-ball].on').waitFor();
  let r = await a.call('POST', `/v1/users/${a.uid}/orders`, { ticker: TRAM, side: 'yes', type: 'market', count: 1 });
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: 'Moderate me please', event_ticker: RATE_EV, position: { market_ticker: TRAM, side: 'yes' } });
  const pid = r.body.post.id;
  assert.equal(r.body.post.author.avatar.sticker_id, 'crystal-ball');
  // Non-moderators and moderators on another uid are refused.
  r = await b.call('PUT', `/v1/users/${b.uid}/social/social-admin/posts/${pid}/post_subtype`, { post_subtype: 'news' });
  assert.equal(r.status, 403);
  r = await api.admin.call('PUT', `/v1/users/${b.uid}/social/social-admin/posts/${pid}/post_subtype`, { post_subtype: 'news' });
  assert.equal(r.status, 403);
  // Moderator UI: subtype, edit with reason (author told), detach event / position, decline the profile picture.
  const pm = await newPage(); await logIn(pm, ADMIN.email);
  await pm.goto(`${BASE}/admin/community/posts/${pid}`);
  await pm.locator('[data-testid=adm-post]').waitFor();
  await pm.selectOption('[data-testid=adm-post-subtype]', 'analysis');
  await pm.click('[data-testid=adm-post-subtype-save]');
  await until(() => dbq('SELECT subtype FROM post_extras WHERE post_id=?', pid)[0]?.subtype === 'analysis', 4000, 'subtype');
  await pm.locator('[data-testid=adm-post]').waitFor();
  await pm.click('[data-testid=adm-post-edit]');
  await pm.fill('[data-testid=adm-edit-body]', 'Moderated text');
  await pm.fill('[data-testid=confirm-reason]', 'removed a misleading claim');
  await pm.click('[data-testid=confirm-ok]');
  await until(() => dbq('SELECT body FROM posts WHERE id=?', pid)[0].body === 'Moderated text', 4000, 'moderator edit');
  await pm.locator('[data-testid=adm-edit-row]').waitFor();
  assert.equal(dbq('SELECT by_moderator, reason FROM post_edits WHERE post_id=?', pid).map((x) => `${x.by_moderator}:${x.reason}`).join(), '1:removed a misleading claim');
  await until(() => dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND title='A moderator edited your post'", a.uid)[0].c === 1, 4000, 'author told');
  await pm.click('[data-testid=adm-post-unlink]');
  await pm.fill('[data-testid=confirm-reason]', 'wrong market');
  await pm.click('[data-testid=confirm-ok]');
  await until(() => dbq('SELECT event_ticker FROM posts WHERE id=?', pid)[0].event_ticker === null && dbq('SELECT position_ticker FROM post_extras WHERE post_id=?', pid)[0].position_ticker === null, 4000, 'detached');
  await pm.locator('[data-testid=adm-post]').waitFor();
  await pm.click('[data-testid=adm-post-avatar]');
  await pm.fill('[data-testid=confirm-reason]', 'not suitable');
  await pm.click('[data-testid=confirm-ok]');
  await until(() => dbq('SELECT status FROM profile_avatars WHERE user_id=?', a.uid)[0].status === 'rejected', 4000, 'avatar rejected');
  r = await b.call('GET', `/v1/social/posts/${pid}`);
  assert.deepEqual([r.body.post.subtype, r.body.post.edited_by_moderator, r.body.post.position, r.body.post.event, r.body.post.author.avatar], ['analysis', true, null, null, null]);
  await pa.goto(BASE + '/social/settings');
  await pa.locator('[data-testid=avatar-rejected]').waitFor();
  // Sticker switch: disabled stickers vanish from the picker and from posts, and cannot be posted.
  await pm.goto(BASE + '/admin/community/stickers');
  await pm.locator('[data-sticker=bull] [data-testid=sticker-toggle]').click();
  await pm.fill('[data-testid=confirm-reason]', 'retiring it');
  await pm.click('[data-testid=confirm-ok]');
  await until(() => dbq("SELECT enabled FROM social_stickers WHERE id='bull'")[0].enabled === 0, 4000, 'sticker disabled');
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { sticker_id: 'bull' });
  assert.deepEqual([r.status, r.code], [400, 'sticker_disabled']);
  assert.ok(!(await b.call('GET', '/v1/social/stickers')).body.stickers.some((s) => s.id === 'bull'));
  assert.equal((await fetch(`${BASE}/v1/social/stickers/bull.svg`)).status, 404);
  await pa.goto(BASE + '/social');
  await pa.click('[data-testid=composer-sticker]');
  await pa.locator('[data-testid=sticker-picker]').waitFor();
  assert.equal(await pa.locator('[data-testid=sticker-opt-bull]').count(), 0);
  assert.equal((await api.admin.call('PUT', '/v1/admin/stickers/bull', { enabled: true })).status, 200);
  // Promo targeting: a series-targeted card shows on that series' event pages, a category card on its category page,
  // neither on home; hide_logged_out hides it from signed-out visitors.
  r = await api.admin.call('POST', '/v1/admin/content/promos', { title: 'Rate desk briefing', link: '/category/economics', series_tickers: 'PLXRATE', categories: 'Economics', hide_logged_out: true });
  assert.equal(r.status, 201, show(r));
  r = await api.admin.call('POST', '/v1/admin/content/promos', { title: 'Bad target', link: '/', series_tickers: 'NOPE-SERIES' });
  assert.equal(r.status, 400);
  await pa.goto(BASE + RATE_URL);
  await pa.locator('[data-testid=event-promos] [data-testid=targeted-promo]:has-text("Rate desk briefing")').waitFor();
  await pa.goto(BASE + '/category/economics');
  await pa.locator('[data-testid=category-promos] [data-testid=targeted-promo]:has-text("Rate desk briefing")').waitFor();
  const home = await b.call('GET', '/v1/bff/home');
  assert.ok(!(home.body.home.promos || []).some((p) => p.title === 'Rate desk briefing'));
  const anon = await new Client(BASE, 'anon2').boot();
  assert.deepEqual((await anon.call('GET', '/v1/promos?series_ticker=PLXRATE')).body.promos, []);
  // Every moderator action is in the hash-chained audit log.
  const actions = dbq('SELECT action FROM admin_audit').map((x) => x.action);
  for (const x of ['social.post_subtype', 'social.post_update', 'social.post_market_status', 'social.profile_image', 'social.sticker.disable']) assert.ok(actions.includes(x), x);
  assert.equal((await api.admin.call('GET', '/v1/admin/audit/verify')).body.ok, true);
  assert.deepEqual([...pa.errors, ...pm.errors], []);
  await pa.context().close(); await pm.context().close();
});

test('event chat G10: reactions live, 5-minute edit with "(edited)" live, sticker messages, edit history for moderators', async () => {
  const { a, b } = api;
  const pa = await newPage(); const pb = await newPage();
  await logIn(pa, U.a.email); await logIn(pb, U.c.email);
  for (const p of [pa, pb]) {
    await p.goto(BASE + RATE_URL);
    await p.waitForSelector('[data-testid=chat-pill][data-status]');
    await p.click('[data-testid=chat-pill]');
    await p.waitForSelector('[data-testid=chat-panel]:not([hidden])');
  }
  await pa.fill('[data-testid=chat-input]', 'React to this, please');
  await pa.press('[data-testid=chat-input]', 'Enter');
  const msgB = pb.locator('[data-testid=chat-msg]', { has: pb.locator('[data-testid=chat-body]', { hasText: 'React to this' }) });
  await msgB.waitFor();
  await msgB.hover();
  await msgB.locator('[data-testid=chat-react-add]').click();
  await pb.click('[data-testid=chat-react-pick-fire]');
  const msgA = pa.locator('[data-testid=chat-msg]', { has: pa.locator('[data-testid=chat-body]', { hasText: 'React to this' }) });
  await msgA.locator('[data-testid=chat-react-fire] [data-testid=chat-react-count]:has-text("1")').waitFor(); // live
  const mid = await msgA.getAttribute('data-id');
  assert.equal(dbq("SELECT COUNT(*) c FROM chat_reactions WHERE message_id=? AND reaction='fire'", mid)[0].c, 1);
  await msgB.locator('[data-testid=chat-react-fire][aria-pressed=true]').click(); // toggle off
  await msgA.locator('[data-testid=chat-react-fire]').waitFor({ state: 'detached' });
  // Edit within the window: "(edited)" live for the other reader; history for moderators.
  await msgA.hover();
  await msgA.locator('[data-testid=chat-edit]').click();
  await pa.fill('[data-testid=chat-edit-input]', `Edited line ${XSS}`);
  await pa.click('[data-testid=chat-edit-save]');
  const editedB = pb.locator('[data-testid=chat-msg]', { has: pb.locator('[data-testid=chat-body]', { hasText: 'Edited line' }) });
  await editedB.locator('[data-testid=chat-edited]').waitFor();
  assert.ok((await editedB.locator('[data-testid=chat-body]').textContent()).includes('<img src=x onerror='));
  assert.equal(await pb.locator('[data-testid=chat-body] img, [data-testid=chat-body] svg, [data-testid=chat-body] script').count(), 0);
  let r = await api.admin.call('GET', `/v1/admin/chat/messages/${mid}/edits`);
  assert.deepEqual(r.body.edits.map((e) => e.previous_body), ['React to this, please']);
  dbrun('UPDATE chat_messages SET created_ts=created_ts-? WHERE id=?', 6 * 60000, mid);
  r = await a.call('PUT', `/v1/users/${a.uid}/chat/${RATE_EV}/messages/${mid}`, { body: 'late edit' });
  assert.deepEqual([r.status, r.code], [409, 'edit_window_closed']);
  r = await b.call('PUT', `/v1/users/${b.uid}/chat/${RATE_EV}/messages/${mid}`, { body: 'not mine' });
  assert.equal(r.status, 404);
  r = await b.call('PUT', `/v1/users/${b.uid}/chat/${RATE_EV}/messages/${mid}/reactions/skull`, {});
  assert.equal(r.status, 400);
  // Sticker message.
  await pa.click('[data-testid=chat-sticker-btn]');
  await pa.click('[data-testid=sticker-opt-popcorn]');
  await pb.locator('[data-testid=chat-sticker][src="/v1/social/stickers/popcorn.svg"]').waitFor();
  assert.equal(dbq("SELECT COUNT(*) c FROM chat_message_extras WHERE sticker_id='popcorn'")[0].c, 1);
  assert.equal(await pb.evaluate(() => window.__xss), undefined);
  assert.deepEqual([...pa.errors, ...pb.errors], []);
  await pa.context().close(); await pb.context().close();
});

test('XSS: every new text field renders as text (posts, replies, edits, group names, messages, notifications, admin)', async () => {
  const { a, b } = api;
  let r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: `Post ${XSS}` });
  const pid = r.body.post.id;
  assert.equal((await b.call('POST', `/v1/users/${b.uid}/social/posts/${pid}/comments`, { body: `Reply ${XSS}` })).status, 201);
  assert.equal((await a.call('PUT', `/v1/users/${a.uid}/social/posts/${pid}`, { body: `Edited ${XSS}` })).status, 200);
  // Group named with markup (A and B follow each other).
  await a.call('POST', `/v1/users/${a.uid}/social/follow`, { nickname: U.b.nick });
  await b.call('POST', `/v1/users/${b.uid}/social/follow`, { nickname: U.a.nick });
  r = await a.call('POST', `/v1/users/${a.uid}/groups`, { name: `G ${XSS}`.slice(0, 50), members: [U.b.nick] });
  assert.equal(r.status, 201, show(r));
  const gid = r.body.group.id;
  assert.equal((await b.call('POST', `/v1/users/${b.uid}/groups/${gid}/messages`, { body: `Msg ${XSS}` })).status, 201);
  // Keywords cannot carry markup; topic values are validated.
  assert.equal((await b.call('POST', `/v1/users/${b.uid}/social/topics`, { kind: 'keyword', value: '<b>x</b>' })).status, 400);
  // Report reason with markup reaches the admin queue as text.
  assert.equal((await b.call('POST', `/v1/users/${b.uid}/groups/${gid}/messages/${(await a.call('POST', `/v1/users/${a.uid}/groups/${gid}/messages`, { body: 'report me' })).body.message.id}/report`, { reason: `Spam ${XSS}`.slice(0, 120) })).status, 201);
  const pb = await newPage(); await logIn(pb, U.b.email);
  const pages = [`/social/post/${pid}`, `/messages/${gid}`, '/notifications', '/social'];
  for (const u of pages) {
    await pb.goto(BASE + u);
    await pb.waitForTimeout(700);
    if (u.startsWith('/social/post/')) {
      await pb.locator('[data-testid=post-body]', { hasText: 'Edited <img' }).waitFor();
      await pb.locator('[data-testid=comment-body]', { hasText: 'Reply <img' }).waitFor();
    }
    if (u.startsWith('/messages/')) {
      await pb.locator('[data-testid=group-body]', { hasText: 'Msg <img' }).waitFor();
      assert.ok((await pb.textContent('[data-testid=group-title]')).includes('<img'));
    }
    assert.equal(await pb.evaluate(() => window.__xss), undefined, u);
    assert.equal(await pb.locator('main img[src="x"], main svg[onload], main script').count(), 0, u);
  }
  const pm = await newPage(); await logIn(pm, ADMIN.email);
  for (const u of [`/admin/community/posts/${pid}`, `/admin/community/groups/${gid}`, '/admin/moderation']) {
    await pm.goto(BASE + u);
    await pm.waitForTimeout(800);
    assert.equal(await pm.evaluate(() => window.__xss), undefined, u);
    assert.equal(await pm.locator('img[src="x"], svg[onload]').count(), 0, u);
  }
  assert.deepEqual([...pb.errors, ...pm.errors], []);
  await pb.context().close(); await pm.context().close();
});

test('object-level IDOR with a second user on every new object; WebSocket groups channel isolation', async () => {
  const { a, b, c } = api;
  // A's objects.
  let r = await a.call('POST', `/v1/users/${a.uid}/groups`, { name: 'A private desk', members: [U.b.nick] });
  const gid = r.body.group.id;
  const gm = (await a.call('POST', `/v1/users/${a.uid}/groups/${gid}/messages`, { body: 'secret desk message' })).body.message.id;
  const apost = (await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: 'A editable post' })).body.post.id;
  const sub = (await a.call('POST', `/v1/users/${a.uid}/notifications/price_movement_subscriptions`, { market_ticker: TRAM, threshold_cents: 3, window_minutes: 60 })).body.subscription.id;
  const dev = (await a.call('POST', `/v1/users/${a.uid}/notifications/push_devices`, { label: 'A laptop' })).body.device.id;
  const creq = (await a.call('POST', `/v1/users/${a.uid}/social/circle/requests`, { nickname: U.b.nick })).body.request.id;
  const cm = (await a.call('POST', `/v1/users/${a.uid}/chat/${TRAM}/messages`, { body: 'A chat line' })).body.message.id;
  const refused = (res, label) => assert.ok([403, 404].includes(res.status), `${label}: expected 403/404, got ${show(res)}`);
  // C (not in the group, not the owner) attacks through C's own paths with A's ids.
  for (const [m, p, body] of [
    ['GET', `/v1/users/${c.uid}/groups/${gid}`], ['POST', `/v1/users/${c.uid}/groups/${gid}/messages`, { body: 'intrude' }],
    ['PUT', `/v1/users/${c.uid}/groups/${gid}`, { name: 'pwned' }], ['POST', `/v1/users/${c.uid}/groups/${gid}/members`, { nicknames: [U.c.nick] }],
    ['DELETE', `/v1/users/${c.uid}/groups/${gid}/messages/${gm}`], ['POST', `/v1/users/${c.uid}/groups/${gid}/messages/${gm}/report`, { reason: 'nosy' }],
    ['PUT', `/v1/users/${c.uid}/groups/${gid}/read`, {}], ['POST', `/v1/users/${c.uid}/groups/${gid}/leave`, {}],
    ['DELETE', `/v1/users/${c.uid}/groups/${gid}/members/${U.b.nick}`],
    ['PUT', `/v1/users/${c.uid}/social/posts/${apost}`, { body: 'hijack' }],
    ['DELETE', `/v1/users/${c.uid}/notifications/price_movement_subscriptions?id=${sub}`],
    ['DELETE', `/v1/users/${c.uid}/notifications/push_devices/${dev}`],
    ['POST', `/v1/users/${c.uid}/social/circle/requests/${creq}/accept`, {}], ['DELETE', `/v1/users/${c.uid}/social/circle/requests/${creq}`],
    ['PUT', `/v1/users/${c.uid}/chat/${TRAM}/messages/${cm}`, { body: 'hijack' }],
  ]) refused(await c.call(m, p, body), `C ${m} ${p}`);
  // B (a member, not the owner) cannot rename or remove; B cannot accept on A's behalf or delete A's message.
  refused(await b.call('PUT', `/v1/users/${b.uid}/groups/${gid}`, { name: 'renamed by B' }), 'B rename');
  refused(await b.call('DELETE', `/v1/users/${b.uid}/groups/${gid}/messages/${gm}`), 'B delete A message');
  refused(await b.call('DELETE', `/v1/users/${b.uid}/social/circle/requests/${creq}`), 'B cancel A request');
  // Unchanged.
  assert.equal(dbq('SELECT name FROM chat_groups WHERE id=?', gid)[0].name, 'A private desk');
  assert.equal(dbq('SELECT deleted FROM chat_group_messages WHERE id=?', gm)[0].deleted, 0);
  assert.equal(dbq('SELECT body FROM posts WHERE id=?', apost)[0].body, 'A editable post');
  assert.equal(dbq('SELECT COUNT(*) c FROM price_move_subs WHERE id=?', sub)[0].c, 1);
  assert.equal(dbq('SELECT COUNT(*) c FROM push_devices WHERE id=?', dev)[0].c, 1);
  assert.equal(dbq('SELECT status FROM circle_requests WHERE id=?', creq)[0].status, 'pending');
  assert.equal(dbq('SELECT COUNT(*) c FROM chat_group_members WHERE group_id=?', gid)[0].c, 2);
  // WebSocket: C subscribed to the private groups channel receives nothing from A's group; B (a member) does.
  const sc = c.socket(); const sb = b.socket();
  await Promise.all([sc.opened, sb.opened]);
  assert.equal((await sc.subscribe(['groups']))[0].type, 'subscribed');
  assert.equal((await sb.subscribe(['groups']))[0].type, 'subscribed');
  assert.equal((await a.call('POST', `/v1/users/${a.uid}/groups/${gid}/messages`, { body: 'only members hear this' })).status, 201);
  await sb.waitFor((m) => m.type === 'group_message' && m.msg.body === 'only members hear this');
  await sleep(400);
  assert.equal(sc.messages.filter((m) => m.type && m.type.startsWith('group_')).length, 0);
  for (const m of sb.messages) assert.ok(!JSON.stringify(m).includes(a.uid) && !JSON.stringify(m).includes(U.a.email), 'group frames carry no user ids or emails');
  const anonWs = (await new Client(BASE, 'anon3').boot()).socket();
  await anonWs.opened;
  const [rep] = await anonWs.subscribe(['groups']);
  assert.deepEqual([rep.type, rep.msg.code], ['error', 9]);
  sc.close(); sb.close(); anonWs.close();
});

test('RFQ G3: obscure_creator_id shows the placeholder to others until execution; rest_remainder rests the unfilled part', async () => {
  const { a, b } = api;
  for (const x of [a, b]) assert.equal((await x.call('PUT', `/v1/users/${x.uid}/properties`, { properties: { rfq_enabled: true } })).status, 200);
  const PLACEHOLDER = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  let r = await a.call('POST', '/v1/communications/rfqs', { market_ticker: RATE_EV + '-CUT', contracts_fp: '10', obscure_creator_id: true, rest_remainder: true });
  if (r.status === 404) r = await a.call('POST', '/v1/communications/rfqs', { market_ticker: dbq("SELECT ticker FROM markets WHERE event_ticker=? AND status='active' LIMIT 1", RATE_EV)[0].ticker, contracts_fp: '10', obscure_creator_id: true, rest_remainder: true });
  assert.equal(r.status, 201, show(r));
  const rfq = r.body.rfq;
  const mine = (await a.call('GET', '/v1/communications/id')).body.communications_id;
  assert.equal(rfq.creator_id, mine);
  const others = await b.call('GET', '/v1/communications/rfqs?scope=others');
  assert.equal(others.body.rfqs.find((x) => x.id === rfq.id).creator_id, PLACEHOLDER);
  // B quotes part of the size (6 of 10); A accepts; B confirms → 6 execute, 4 rest as A's GTC limit order.
  r = await b.call('POST', '/v1/communications/quotes', { rfq_id: rfq.id, yes_bid: '0.30', no_bid: '0.40', contracts_fp: '6' });
  assert.equal(r.status, 201, show(r));
  const q = r.body.quote;
  assert.equal(q.rfq_creator_id, PLACEHOLDER);
  r = await b.call('POST', '/v1/communications/quotes', { rfq_id: rfq.id, yes_bid: '0.30', no_bid: '0.40', contracts_fp: '11' });
  assert.equal(r.status, 400);
  r = await a.call('PUT', `/v1/communications/rfqs/${rfq.id}/quotes/${q.id}/accept`, { accepted_side: 'no' });
  assert.equal(r.status, 200, show(r));
  r = await b.call('PUT', `/v1/communications/quotes/${q.id}/confirm`, {});
  assert.equal(r.status, 200, show(r));
  assert.equal(r.body.quote.executed_contracts_fp, '6.00');
  assert.equal(r.body.quote.rfq_creator_id, mine, 'the counterparty sees the real id after execution');
  const rr = dbq('SELECT * FROM rfqs WHERE id=?', rfq.id)[0];
  assert.ok(rr.remainder_order_id);
  const ro = dbq('SELECT * FROM orders WHERE id=?', rr.remainder_order_id)[0];
  assert.deepEqual([ro.user_id, ro.side, ro.price_cents, ro.initial_count, ro.source], [a.uid, 'yes', 60, 400, 'rfq_remainder']);
  const after = await b.call('GET', '/v1/communications/rfqs?scope=others');
  assert.ok(!after.body.rfqs.some((x) => x.id === rfq.id)); // executed RFQs leave the open list
  assert.equal((await a.call('GET', `/v1/communications/rfqs/${rfq.id}`)).body.rfq.remainder_order_id, rr.remainder_order_id);
});

test('A11 alerts: position alerts honour the share setting, trade-alert bell, sports major events, auto-cancel reasons, promotional topics; outbox', async () => {
  const { a, b, c } = api;
  const MKT = 'PLXCOUNCIL-27MAYOR-OKAFOR';
  const pos = () => dbq("SELECT title FROM notifications WHERE user_id=? AND type='position_alert' ORDER BY created_ts", b.uid).map((x) => x.title);
  const n0 = pos().length;
  // B follows A (earlier test). A opens a position → "opened"; A sells it all → "closed".
  let r = await a.call('POST', `/v1/users/${a.uid}/orders`, { ticker: MKT, side: 'yes', type: 'market', count: 2 });
  assert.equal(r.status, 201, show(r));
  await until(() => pos().length === n0 + 1, 5000, 'opened alert');
  assert.equal(pos()[n0], `@${U.a.nick} opened a YES position`);
  r = await a.call('POST', `/v1/users/${a.uid}/orders`, { ticker: MKT, side: 'yes', action: 'sell', type: 'market', count: 2 });
  assert.equal(r.status, 201, show(r));
  await until(() => pos().length === n0 + 2, 5000, 'closed alert');
  assert.equal(pos()[n0 + 1], `@${U.a.nick} closed a YES position`);
  // A stops sharing trades → no alerts.
  assert.equal((await a.call('POST', `/v1/users/${a.uid}/social/profile`, { share_trades: false })).status, 200);
  r = await a.call('POST', `/v1/users/${a.uid}/orders`, { ticker: MKT, side: 'yes', type: 'market', count: 1 });
  await sleep(700);
  assert.equal(pos().length, n0 + 2, 'no alert while A keeps trades private');
  assert.equal((await a.call('POST', `/v1/users/${a.uid}/social/profile`, { share_trades: true })).status, 200);
  // Trade alerts are opt-in per trader: B turns the bell on from A's profile.
  const pb = await newPage(); await logIn(pb, U.b.email);
  await pb.goto(`${BASE}/social/profile/${U.a.nick}`);
  await pb.click('[data-testid=trade-alerts-btn]');
  await pb.locator('[data-testid=trade-alerts-btn]:has-text("Trade alerts on")').waitFor();
  r = await a.call('POST', `/v1/users/${a.uid}/orders`, { ticker: MKT, side: 'yes', type: 'market', count: 1 });
  await until(() => notifs(b.uid, 'trade_alert').length === 1, 5000, 'trade alert');
  assert.match(notifs(b.uid, 'trade_alert')[0].title, new RegExp(`^@${U.a.nick} bought 1 YES · Dana Okafor @ ₦\\d+$`));
  // Unfollowing ends the trade-alert subscription.
  assert.equal((await b.call('DELETE', `/v1/users/${b.uid}/social/follow?nickname=${U.a.nick}`)).status, 200);
  assert.equal(dbq('SELECT COUNT(*) c FROM social_account_subs WHERE user_id=?', b.uid)[0].c, 0);
  assert.equal((await b.call('POST', `/v1/users/${b.uid}/social/follow`, { nickname: U.a.nick })).status, 200);
  // Sports major events: a game linked to an event A holds goes live, then final (live_data transitions).
  const ev = 'PLXCOUNCIL-27MAYOR';
  srv.engine.emit('live_data', 'm_e2e_1', { milestone_id: 'm_e2e_1', event_ticker: ev, status: 'scheduled', title: 'Debate night' });
  srv.engine.emit('live_data', 'm_e2e_1', { milestone_id: 'm_e2e_1', event_ticker: ev, status: 'live', title: 'Debate night' });
  srv.engine.emit('live_data', 'm_e2e_1', { milestone_id: 'm_e2e_1', event_ticker: ev, status: 'final', title: 'Debate night', details: { home_score: 2, away_score: 1 } });
  await until(() => notifs(a.uid, 'sports_major').length === 2, 4000, 'sports alerts');
  assert.deepEqual(notifs(a.uid, 'sports_major').map((x) => x.title), ['Game started: Debate night', 'Final 2-1: Debate night']);
  assert.equal(notifs(b.uid, 'sports_major').length, 0, 'no position, not watching → no alert');
  // Order auto-cancellation ⌄ reasons: a market closing cancels resting orders → notified; switched off → not.
  const auto = () => notifs(b.uid, 'order_canceled_market').length;
  assert.equal((await b.call('POST', `/v1/users/${b.uid}/orders`, { ticker: 'PLXCOUNCIL-27MAYOR-MBEKI', side: 'yes', type: 'limit', price: 1, count: 1 })).status, 201);
  assert.equal((await api.admin.call('POST', '/v1/admin/markets/PLXCOUNCIL-27MAYOR-MBEKI/close', {})).status, 200);
  await until(() => auto() === 1, 4000, 'auto-cancel notification');
  assert.equal((await b.call('PUT', `/v1/users/${b.uid}/notifications/settings/order_auto_cancel`, { options: { market_closed: false } })).status, 200);
  assert.equal((await b.call('POST', `/v1/users/${b.uid}/orders`, { ticker: 'PLXCOUNCIL-27MAYOR-LINDQVIST', side: 'yes', type: 'limit', price: 1, count: 1 })).status, 201);
  assert.equal((await api.admin.call('POST', '/v1/admin/markets/PLXCOUNCIL-27MAYOR-LINDQVIST/close', {})).status, 200);
  await sleep(600);
  assert.equal(auto(), 1);
  // Promotional topics: an announcement tagged Crypto respects each recipient's channel choice.
  assert.equal((await b.call('PUT', `/v1/users/${b.uid}/notifications/settings/crypto`, { in_app: false })).status, 200);
  r = await api.admin.call('POST', '/v1/admin/announcements', { title: 'New token ladder markets', body: 'Fresh crypto levels', link: '/category/crypto', segment: 'all', topic: 'crypto' });
  assert.equal(r.status, 201, show(r));
  await until(() => notifs(c.uid, 'promo_crypto').length === 1, 4000, 'promo for C');
  assert.equal(notifs(b.uid, 'promo_crypto').length, 0);
  // Admin › Notification outbox lists email and push deliveries.
  const pm = await newPage(); await logIn(pm, ADMIN.email);
  await pm.goto(BASE + '/admin/outbox');
  await pm.locator('[data-testid=adm-outbox] tbody tr', { hasText: 'Deposit of' }).first().waitFor();
  assert.deepEqual([...pb.errors, ...pm.errors], []);
  await pb.context().close(); await pm.context().close();
});

test('restart keeps everything; 390px layout of every new page with no overflow, page errors or CSP violations', async () => {
  const { a, b } = api;
  const counts = () => ['post_extras', 'post_edits', 'user_mutes', 'topic_follows', 'circle_requests', 'circle_members', 'notif_prefs', 'push_devices', 'price_move_subs', 'chat_reactions', 'chat_message_edits', 'chat_message_extras', 'chat_groups', 'chat_group_members', 'chat_group_messages', 'profile_avatars', 'social_stickers']
    .map((t) => `${t}:${dbq(`SELECT COUNT(*) c FROM ${t}`)[0].c}`).join(' ');
  const before = counts();
  const prefs = (await b.call('GET', `/v1/users/${b.uid}/notifications/preferences`)).body;
  await srv.close();
  srv = await start(OPTS);
  assert.equal(counts(), before);
  await b.logIn(U.b.email, PW); await a.logIn(U.a.email, PW);
  assert.deepEqual((await b.call('GET', `/v1/users/${b.uid}/notifications/preferences`)).body.groups, prefs.groups);
  assert.ok((await b.call('GET', `/v1/users/${b.uid}/groups`)).body.groups.length >= 1);
  assert.ok((await b.call('GET', `/v1/users/${b.uid}/social/topics`)).body.topics.length >= 2);
  const gid = (await b.call('GET', `/v1/users/${b.uid}/groups`)).body.groups[0].id;
  const pid = dbq("SELECT post_id FROM post_extras WHERE position_ticker IS NOT NULL LIMIT 1")[0]?.post_id || dbq('SELECT id FROM posts LIMIT 1')[0].id;
  for (const theme of ['dark', 'light']) {
    const p = await newPage({ viewport: { width: 390, height: 844 } });
    await logIn(p, U.b.email);
    if (theme === 'light') await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    for (const u of ['/social', `/social/post/${pid}`, '/social/circle', '/social/settings', '/notifications/settings', '/messages', `/messages/${gid}`, RATE_URL, `/social/profile/${U.a.nick}`]) {
      await p.goto(BASE + u);
      await p.waitForSelector('#view > *');
      await p.waitForTimeout(500);
      if (theme === 'light') await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${u} (${theme}) overflows by ${overflow}px`);
    }
    await p.goto(BASE + '/social');
    await p.click('[data-testid=composer-sticker]');
    await p.locator('[data-testid=sticker-picker]').waitFor();
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(ov <= 1, `sticker picker overflows by ${ov}px`);
    assert.deepEqual(p.errors, []);
    assert.deepEqual(await cspOf(p), []);
    await p.context().close();
  }
});
