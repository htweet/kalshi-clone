'use strict';
// End-to-end browser tests for event live chat (CHAT_SPEC.md §20): two users in two browser contexts on the same
// event (live delivery without reload, presence), replies, own-message delete, history across reload + restart,
// signed-out and no-nickname prompts, XSS payloads rendered inert, validation, CSRF, per-user / per-IP rate limits,
// slow mode (429 + countdown), moderator delete / mute / pin / lock (live for others), report → admin queue,
// closed-event read-only, admin Chat section, WebSocket filter + frame cap, 390px layout. Real server + SQLite + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const WebSocket = require('ws');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-chat-'));
const DB_FILE = path.join(TMP, 'chat.db');
const PORT = 4480 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const EV = 'PLXCOUNCIL-27TRAM';
const EV_URL = '/markets/plxcouncil/harbor-city-council-vote/plxcouncil-27tram';
const SEN_URL = '/markets/plxstate/harbor-state-elections/plxstate-26sen';
const CLOSED_EV = 'PLXCOIN-26DEC';
const CLOSED_URL = '/markets/plxcoin/token-price-levels/plxcoin-26dec';
const ADMIN = { email: 'admin@parlance.local', password: 'parlance-admin' };
const stamp = Date.now();
const A = { email: `chat.a.${stamp}@example.test`, password: PW, name: 'Alice Chat', nick: `alice_${stamp % 100000}` };
const B = { email: `chat.b.${stamp}@example.test`, password: PW, name: 'Bob Chat', nick: `bob_${stamp % 100000}` };
const C = { email: `chat.c.${stamp}@example.test`, password: PW, name: 'Carol Chat', nick: `carol_${stamp % 100000}` };
const D = { email: `chat.d.${stamp}@example.test`, password: PW, name: 'Dan Chat', nick: `dan_${stamp % 100000}` };

let srv; let browser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const uidOf = (email) => dbq('SELECT id FROM users WHERE email=?', email)[0].id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cookie + CSRF HTTP client for setup and API-level assertions.
function client() {
  let cookie = ''; let csrf = '';
  const call = async (method, p, body, { noCsrf = false } = {}) => {
    const headers = { 'content-type': 'application/json', cookie };
    if (!noCsrf) headers['x-csrf-token'] = csrf;
    const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    if (json && json.csrf_token) csrf = json.csrf_token;
    return { status: r.status, body: json, headers: r.headers };
  };
  const c = { call, uid: null };
  c.signup = async (u) => { const r = await call('POST', '/v1/users', { email: u.email, password: u.password, display_name: u.name }); c.uid = r.body.user.user_id; return r; };
  c.login = async (u) => { const r = await call('POST', '/v1/log_in', { email: u.email, password: u.password }); c.uid = r.body.user.user_id; return r; };
  c.post = (ticker, body, extra = {}) => call('POST', `/v1/users/${c.uid}/chat/${ticker}/messages`, { body, ...extra });
  return c;
}

async function newPage(viewport = { width: 1440, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = []; page.dialogs = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => { page.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  return page;
}
async function logIn(page, u) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', u.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function openChat(page, url = EV_URL) {
  await page.goto(BASE + url);
  await page.waitForSelector('[data-testid=chat-pill][data-status]');
  await page.click('[data-testid=chat-pill]');
  await page.waitForSelector('[data-testid=chat-panel]:not([hidden])');
}
async function send(page, text) {
  await page.fill('[data-testid=chat-input]', text);
  await page.press('[data-testid=chat-input]', 'Enter');
}
const msg = (page, text) => page.locator('[data-testid=chat-msg]', { has: page.locator('[data-testid=chat-body]', { hasText: text }) });

const api = { a: client(), b: client(), c: client(), d: client(), admin: client() };
let pageA; let pageB; let pageAdmin;

before(async () => {
  srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 300 });
  browser = await chromium.launch();
  for (const [k, u] of [['a', A], ['b', B], ['c', C], ['d', D]]) await api[k].signup(u);
  for (const [k, u] of [['a', A], ['b', B], ['d', D]]) assert.equal((await api[k].call('POST', `/v1/users/${api[k].uid}/social/profile`, { nickname: u.nick })).status, 201);
  await api.admin.login(ADMIN);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('two users: A posts and B sees it live, presence, reply, delete own, history across reload', async () => {
  pageA = await newPage(); pageB = await newPage();
  await logIn(pageA, A); await logIn(pageB, B);
  await openChat(pageA); await openChat(pageB);
  // The pill shows an active room (red dot) on an event with an open market.
  assert.equal(await pageA.getAttribute('[data-testid=chat-pill]', 'data-status'), 'open');
  assert.match(await pageA.textContent('[data-testid=chat-pill]'), /Live chat/);
  await send(pageA, 'Hello from Alice');
  await msg(pageA, 'Hello from Alice').waitFor();
  await msg(pageB, 'Hello from Alice').waitFor(); // live, no reload
  assert.equal(await msg(pageB, 'Hello from Alice').locator('[data-testid=chat-nick]').textContent(), `@${A.nick}`);
  // Approximate presence from WS subscriptions (both pages are subscribed).
  await pageB.waitForFunction(() => /^[2-9]\d* online$/.test(document.querySelector('[data-testid=chat-online]').textContent));
  // B replies to A; the quote travels with the message.
  await msg(pageB, 'Hello from Alice').locator('[data-testid=chat-reply]').click();
  assert.match(await pageB.textContent('[data-testid=chat-replying]'), new RegExp(`@${A.nick}`));
  await send(pageB, 'Hi Alice, B here');
  const reply = msg(pageA, 'Hi Alice, B here');
  await reply.waitFor();
  assert.match(await reply.locator('[data-testid=chat-quote]').textContent(), /Hello from Alice/);
  // A deletes an own message; it disappears for B live and stays in the DB as author_deleted.
  await send(pageA, 'oops typo message');
  await msg(pageB, 'oops typo message').waitFor();
  assert.equal(await msg(pageB, 'Hello from Alice').locator('[data-testid=chat-del]').count(), 0, 'no delete on others\' messages');
  await msg(pageA, 'oops typo message').locator('[data-testid=chat-del]').click();
  await msg(pageB, 'oops typo message').waitFor({ state: 'detached' });
  await msg(pageA, 'oops typo message').waitFor({ state: 'detached' });
  const row = dbq('SELECT deleted, mod_state, user_id, nickname FROM chat_messages WHERE body=?', 'oops typo message')[0];
  assert.deepEqual([row.deleted, row.mod_state, row.user_id, row.nickname], [1, 'author_deleted', uidOf(A.email), A.nick]);
  assert.match(dbq('SELECT id FROM chat_messages WHERE body=?', 'Hello from Alice')[0].id, /^cm_[0-9a-f-]{36}$/);
  // History persists across reload (newest last) and the deleted message stays gone.
  await openChat(pageB);
  await msg(pageB, 'Hi Alice, B here').waitFor();
  const bodies = await pageB.$$eval('[data-testid=chat-body]', (els) => els.map((e) => e.textContent));
  assert.ok(bodies.indexOf('Hello from Alice') < bodies.indexOf('Hi Alice, B here'));
  assert.ok(!bodies.includes('oops typo message'));
  assert.deepEqual(pageA.errors, []); assert.deepEqual(pageB.errors, []);
});

test('XSS payloads render as inert text; links are http(s) only with safe rel', async () => {
  const payloads = ['<img src=x onerror="window.__xss=1;alert(1)">', '<script>window.__xss=2;alert(2)</script>', 'see https://example.com/path?q=1 and javascript:alert(3)', '"><svg onload=alert(4)>'];
  for (const p of payloads) { const r = await api.b.post(EV, p); assert.equal(r.status, 201, JSON.stringify(r.body)); }
  for (const p of payloads) await msg(pageA, p.slice(0, 20)).first().waitFor();
  const list = pageA.locator('[data-testid=chat-list]');
  for (const p of payloads) assert.ok((await list.locator('[data-testid=chat-body]').allTextContents()).includes(p), `rendered verbatim: ${p}`);
  assert.equal(await list.locator('img, script, svg[onload], [onerror]').count(), 0);
  assert.equal(await pageA.evaluate(() => window.__xss), undefined);
  const links = await list.locator('a.chat-link').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href'), rel: a.getAttribute('rel'), target: a.getAttribute('target') })));
  assert.deepEqual(links, [{ href: 'https://example.com/path?q=1', rel: 'noopener noreferrer nofollow ugc', target: '_blank' }]);
  // Reload: history renders the same payloads inertly.
  await openChat(pageA);
  await msg(pageA, '<script>').first().waitFor();
  assert.equal(await pageA.locator('[data-testid=chat-list] img, [data-testid=chat-list] script').count(), 0);
  assert.equal(await pageA.evaluate(() => window.__xss), undefined);
  assert.deepEqual(pageA.dialogs, []); assert.deepEqual(pageA.errors, []);
});

test('validation, CSRF, privacy of history, per-user rate limit and the character counter', async () => {
  const bad = async (body, extra) => { const r = await api.a.post(EV, body, extra); return [r.status, r.body.error?.details || r.body.error?.code]; };
  await sleep(2500); // let A's bucket refill a little
  assert.deepEqual(await bad(''), [400, 'message cannot be empty']);
  assert.deepEqual(await bad('    '), [400, 'message cannot be empty']);
  assert.deepEqual(await bad('x'.repeat(281)), [400, 'message must be at most 280 characters']);
  assert.equal((await bad('bell\u0007here'))[0], 400);
  assert.equal((await bad('two\nlines'))[0], 400);
  assert.equal((await bad({ html: '<b>' }))[0], 400);
  await sleep(4000);
  // reply_to must be a message in the same room
  const other = await api.b.post('PLXCOUNCIL-27MAYOR', 'mayor room message');
  assert.equal(other.status, 201);
  assert.deepEqual(await bad('cross-room reply', { reply_to: other.body.message.id }), [400, 'reply_to must be a message in this room']);
  assert.equal((await api.a.post(EV, 'x'.repeat(280))).status, 201, 'exactly 280 is allowed');
  // CSRF header missing → 403 even with a valid session cookie.
  const noCsrf = await api.a.call('POST', `/v1/users/${api.a.uid}/chat/${EV}/messages`, { body: 'no csrf' }, { noCsrf: true });
  assert.equal(noCsrf.status, 403);
  assert.match(noCsrf.body.error.details, /csrf/);
  // Signed out → 401; another user's path → 403; unknown event → 404.
  const anon = client();
  assert.equal((await anon.call('POST', `/v1/users/${api.a.uid}/chat/${EV}/messages`, { body: 'anon' })).status, 401);
  assert.equal((await api.b.call('POST', `/v1/users/${api.a.uid}/chat/${EV}/messages`, { body: 'as someone else' })).status, 403);
  assert.equal((await api.a.post('NOPE-123', 'hello')).status, 404);
  // History is public but never leaks emails or user ids.
  const h = await anon.call('GET', `/v1/events/${EV}/chat?limit=100`);
  assert.equal(h.status, 200);
  const raw = JSON.stringify(h.body);
  for (const u of [A, B, D]) { assert.ok(!raw.includes(u.email), 'no emails'); assert.ok(!raw.includes(uidOf(u.email)), 'no user ids'); }
  assert.ok(h.body.messages.every((m) => Object.keys(m.author).sort().join() === 'nickname,verified'));
  assert.equal((await anon.call('GET', `/v1/events/${EV}/chat?before=cm_00000000-0000-0000-0000-000000000000`)).status, 400);
  assert.equal((await anon.call('GET', `/v1/events/${EV}/chat?limit=1000`)).status, 400);
  // Per-user token bucket (stricter than the global limiter): a burst from D gets 429 too_many_requests.
  const codes = [];
  let limited = null;
  for (let i = 0; i < 12; i++) { const r = await api.d.post(EV, `burst ${i}`); codes.push(r.status); if (r.status === 429) limited = r; }
  assert.ok(codes.includes(201) && codes.includes(429), codes.join(','));
  assert.equal(limited.body.error.code, 'too_many_requests');
  assert.ok(limited.body.error.retry_after_sec >= 1);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  // Character counter in the composer.
  await pageA.fill('[data-testid=chat-input]', 'y'.repeat(281));
  assert.equal(await pageA.textContent('[data-testid=chat-count]'), '281/280');
  assert.ok(await pageA.locator('[data-testid=chat-count].over').count());
  assert.ok(await pageA.isDisabled('[data-testid=chat-send]'));
  await pageA.fill('[data-testid=chat-input]', '   ');
  assert.ok(await pageA.isDisabled('[data-testid=chat-send]'));
  await pageA.fill('[data-testid=chat-input]', '');
});

test('signed-out readers see history and a sign-in prompt; a member without a nickname is asked to pick one', async () => {
  const anon = await newPage();
  await openChat(anon);
  await msg(anon, 'Hello from Alice').waitFor();
  assert.ok(await anon.isVisible('[data-testid=chat-signin]'));
  assert.equal(await anon.locator('[data-testid=chat-input]').count(), 0);
  assert.equal(await anon.locator('[data-testid=chat-reply], [data-testid=chat-del]').count(), 0);
  await anon.click('[data-testid=chat-signin] a');
  await anon.waitForURL(/\/sign-in\?next=/);
  await anon.context().close();

  const pc = await newPage();
  await logIn(pc, C);
  await openChat(pc);
  await pc.waitForSelector('[data-testid=chat-nick-form]');
  assert.equal(await pc.locator('[data-testid=chat-input]').count(), 0);
  assert.equal((await api.c.post(EV, 'no nickname yet')).status, 409);
  await pc.fill('[data-testid=chat-nick-input]', C.nick);
  await pc.click('[data-testid=chat-nick-form] button[type=submit]');
  await pc.waitForSelector('[data-testid=chat-input]');
  await send(pc, 'Carol checking in');
  await msg(pageA, 'Carol checking in').waitFor();
  assert.equal(dbq('SELECT nickname FROM social_profiles WHERE user_id=?', uidOf(C.email))[0].nickname, C.nick);
  assert.deepEqual(pc.errors, []);
  await pc.context().close();
});

test('moderator: slow mode (429 + countdown), pin, delete, mute and lock, all live and audited', async () => {
  pageAdmin = await newPage();
  await logIn(pageAdmin, ADMIN);
  await openChat(pageAdmin);
  await pageAdmin.click('[data-testid=chat-mod-toggle]');
  // Non-moderators are refused server-side.
  assert.equal((await api.a.call('POST', `/v1/admin/chat/rooms/${EV}/lock`, {})).status, 403);
  assert.equal((await api.a.call('GET', '/v1/admin/chat/rooms')).status, 403);

  // Slow mode 10 s: B sees the banner live; a send right after an API post gets 429 and the UI counts down.
  await pageAdmin.selectOption('[data-testid=chat-slow]', '10');
  await pageB.waitForSelector('[data-testid=chat-slow-banner]');
  await sleep(2000);
  assert.equal((await api.b.post(EV, 'slow one')).status, 201);
  const second = await api.b.post(EV, 'slow two');
  assert.equal(second.status, 429);
  assert.match(second.body.error.details, /slow mode/);
  await send(pageB, 'too soon in the browser');
  await pageB.waitForSelector('[data-testid=chat-cooldown]:not([hidden])');
  assert.match(await pageB.textContent('[data-testid=chat-cooldown]'), /wait \d+s/);
  assert.match(await pageB.textContent('[data-testid=chat-error]'), /slow mode/);
  assert.ok(await pageB.isDisabled('[data-testid=chat-send]'));
  await pageAdmin.selectOption('[data-testid=chat-slow]', '0');
  await pageB.waitForSelector('[data-testid=chat-slow-banner]', { state: 'detached' });

  // Pin B's message → pinned bar appears for A live.
  await msg(pageAdmin, 'Hi Alice, B here').locator('[data-testid=chat-more]').click();
  await pageAdmin.click('[data-testid=chat-pin]');
  await pageA.waitForSelector('[data-testid=chat-pinned]:not([hidden])');
  assert.match(await pageA.textContent('[data-testid=chat-pinned]'), /Hi Alice, B here/);

  // Delete A's message → disappears for B live; stored as moderator_removed.
  await msg(pageAdmin, 'Hello from Alice').locator('[data-testid=chat-del]').click();
  await msg(pageB, 'Hello from Alice').waitFor({ state: 'detached' });
  assert.equal(dbq('SELECT mod_state FROM chat_messages WHERE body=?', 'Hello from Alice')[0].mod_state, 'moderator_removed');
  // The quote on B's reply now says the original was deleted.
  assert.match(await msg(pageA, 'Hi Alice, B here').locator('[data-testid=chat-quote]').textContent(), /deleted/);

  // Mute B for 10 minutes → B's next send is refused with a clear message.
  await msg(pageAdmin, 'Hi Alice, B here').locator('[data-testid=chat-more]').click();
  await pageAdmin.click('[data-testid=chat-mute-10]');
  await sleep(300);
  assert.equal(dbq('SELECT COUNT(*) c FROM chat_mutes WHERE room=? AND user_id=? AND until_ts>?', EV, uidOf(B.email), Date.now())[0].c, 1);
  await sleep(2500);
  await send(pageB, 'can I still talk?');
  await pageB.waitForSelector('[data-testid=chat-blocked][data-block=muted]');
  assert.match(await pageB.textContent('[data-testid=chat-blocked]'), /muted in this chat until/);
  assert.match(await pageB.textContent('[data-testid=chat-error]'), /muted/);
  const muted = await api.b.post(EV, 'api while muted');
  assert.equal(muted.status, 403); assert.equal(muted.body.error.code, 'chat_muted'); assert.ok(muted.body.error.muted_until);

  // Lock → A's composer is replaced live; posting is refused; unlock restores it.
  await pageAdmin.click('[data-testid=chat-lock]');
  await pageA.waitForSelector('[data-testid=chat-blocked][data-block=locked]');
  assert.equal(await pageA.locator('[data-testid=chat-input]').count(), 0);
  assert.ok(await pageA.isVisible('[data-testid=chat-locked]'));
  assert.equal((await api.a.post(EV, 'while locked')).body.error.code, 'chat_locked');
  await pageAdmin.click('[data-testid=chat-lock]');
  await pageA.waitForSelector('[data-testid=chat-input]');

  const actions = dbq("SELECT action FROM admin_audit WHERE action LIKE 'chat.%' AND actor_id=?", uidOf(ADMIN.email)).map((r) => r.action);
  for (const a of ['chat.slow_mode', 'chat.pin', 'chat.delete', 'chat.mute', 'chat.lock', 'chat.unlock']) assert.ok(actions.includes(a), `audit ${a}`);
  for (const p of [pageA, pageB, pageAdmin]) assert.deepEqual(p.errors, []);
});

test('report a message → admin reports queue; delete from the queue removes it live; admin Chat section', async () => {
  await msg(pageA, 'Carol checking in').locator('[data-testid=chat-more]').click();
  await pageA.click('[data-testid=chat-report-spam]');
  await pageA.waitForSelector('.toast:has-text("moderator will review")');
  const rep = dbq("SELECT * FROM mod_reports WHERE kind='chat' AND reporter_id=?", uidOf(A.email))[0];
  assert.equal(rep.excerpt, 'Carol checking in'); assert.equal(rep.post_id, EV); assert.equal(rep.status, 'open');
  // Own messages cannot be reported.
  const own = dbq('SELECT id FROM chat_messages WHERE body=?', 'x'.repeat(280))[0].id;
  assert.equal((await api.a.call('POST', `/v1/users/${api.a.uid}/chat/${EV}/messages/${own}/report`, { reason: 'spam' })).status, 400);

  await pageAdmin.goto(BASE + '/admin/moderation');
  const r = pageAdmin.locator(`[data-testid=mod-reports] tr[data-row="${rep.id}"]`);
  await r.waitFor();
  assert.match(await r.textContent(), /chat/);
  assert.match(await r.textContent(), /Carol checking in/);
  await r.locator('button[data-act=delete]').click();
  await pageAdmin.locator('[data-testid=confirm-ok]').click();
  await msg(pageA, 'Carol checking in').waitFor({ state: 'detached' });
  assert.equal(dbq('SELECT status FROM mod_reports WHERE id=?', rep.id)[0].status, 'actioned');
  assert.equal(dbq('SELECT mod_state FROM chat_messages WHERE id=?', rep.content_id)[0].mod_state, 'moderator_removed');

  // Admin Chat section: rooms list with activity → room page with the full message log (incl. removed).
  await pageAdmin.goto(BASE + '/admin/chat');
  const room = pageAdmin.locator(`[data-testid=chat-rooms] tr[data-room="${EV}"]`);
  await room.waitFor();
  await room.locator('[data-testid=chat-room-open]').click();
  await pageAdmin.waitForSelector('[data-testid=chat-messages]');
  assert.ok(await pageAdmin.locator(`[data-testid=chat-messages] tr[data-msg="${rep.content_id}"]:has-text("removed")`).count());
  assert.match(await pageAdmin.textContent('[data-testid=chat-mutes]'), new RegExp(`@${B.nick}`));
  // Unmute from the admin room page.
  await pageAdmin.click(`[data-unmute="${B.nick}"]`);
  await pageAdmin.waitForSelector('text=Nobody is muted.');
  assert.equal((await api.b.post(EV, 'back after unmute')).status, 201);
  assert.deepEqual(pageAdmin.errors, []);
});

test('closed event: the room turns read-only live and refuses posts', async () => {
  const pa = await newPage();
  await logIn(pa, A);
  await openChat(pa, CLOSED_URL);
  await sleep(1500);
  await send(pa, 'before the close');
  await msg(pa, 'before the close').waitFor();
  const r = await api.admin.call('POST', `/v1/admin/markets/${CLOSED_EV}-T5/close`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await pa.waitForSelector('[data-testid=chat-blocked][data-block=closed]');
  assert.ok(await pa.isVisible('[data-testid=chat-readonly-banner]'));
  assert.equal(await pa.getAttribute('[data-testid=chat-pill]', 'data-status'), 'read_only');
  assert.equal(await pa.locator('[data-testid=chat-pill].on').count(), 0, 'no red dot when inactive');
  const refused = await api.a.post(CLOSED_EV, 'after the close');
  assert.equal(refused.status, 403); assert.equal(refused.body.error.code, 'chat_closed');
  // History is still readable.
  await openChat(pa, CLOSED_URL);
  await msg(pa, 'before the close').waitFor();
  assert.deepEqual(pa.errors, []);
  await pa.context().close();
});

test('WebSocket: chat requires an event filter, delivers only to subscribers, caps frame size', async () => {
  const open = () => new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/v1/ws`); const q = []; w.on('message', (d) => q.push(JSON.parse(String(d)))); w.on('open', () => res({ w, q })); w.on('error', rej); });
  const { w, q } = await open();
  w.send(JSON.stringify({ id: 1, cmd: 'subscribe', params: { channels: ['chat'] } }));
  w.send(JSON.stringify({ id: 2, cmd: 'subscribe', params: { channels: ['chat'], event_tickers: ['PLXCOUNCIL-27MAYOR'] } }));
  await sleep(300);
  assert.equal(q.find((m) => m.id === 1).type, 'error');
  assert.equal(q.find((m) => m.id === 2).type, 'subscribed');
  await sleep(2500); // user bucket refill
  assert.equal((await api.d.post(EV, 'not for the mayor room')).status, 201);
  assert.equal((await api.d.post('PLXCOUNCIL-27MAYOR', 'for the mayor room')).status, 201);
  await sleep(400);
  const got = q.filter((m) => m.type === 'chat_message').map((m) => m.msg.body);
  assert.deepEqual(got, ['for the mayor room']);
  // An oversized inbound frame closes the socket (1009 message too big).
  const code = await new Promise((res) => { w.on('close', (c) => res(c)); w.send('x'.repeat(70 * 1024)); });
  assert.equal(code, 1009);
});

test('restart keeps history, pins and rooms; per-IP limit; 390px drawer without overflow in dark and light', async () => {
  await srv.close();
  process.env.CHAT_IP_BURST = '3'; process.env.CHAT_IP_PER_SEC = '0.05';
  srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 300 });
  try {
    for (const k of ['a', 'b', 'c', 'd']) await api[k].login({ a: A, b: B, c: C, d: D }[k]);
    // Per-IP bucket across different users from one address.
    const st = [];
    for (const k of ['a', 'b', 'c', 'd']) st.push((await api[k].post('PLXCOUNCIL-27MAYOR', `ip check ${k}`)).status);
    assert.deepEqual(st, [201, 201, 201, 429]);
  } finally { delete process.env.CHAT_IP_BURST; delete process.env.CHAT_IP_PER_SEC; }
  const page = await newPage({ width: 390, height: 844 });
  await openChat(page);
  await msg(page, 'Hi Alice, B here').waitFor();
  await msg(page, '<script>').first().waitFor();
  assert.match(await page.textContent('[data-testid=chat-pinned]'), /Hi Alice, B here/);
  const box = await page.locator('[data-testid=chat-panel]').boundingBox();
  assert.ok(box.width <= 390 && box.y > 0, 'bottom drawer');
  // Overflow is measured on the event page the redesign suite already checks at 390px (the single-market outcome
  // table on EV is wider than 390px independently of chat), with the chat pill in the header and the drawer open.
  await logIn(page, A);
  await openChat(page, SEN_URL);
  await page.waitForSelector('[data-testid=chat-input]');
  await page.fill('[data-testid=chat-input]', 'w'.repeat(280)); // long unbroken text must wrap, not widen the page
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(150);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${theme}: overflows by ${over}px`);
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=chat-panel]')).backgroundColor);
    assert.equal(bg, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(19, 21, 25)');
  }
  await page.click('[data-testid=chat-close]');
  await page.waitForSelector('[data-testid=chat-panel]', { state: 'hidden' });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 0, `closed: overflows by ${over}px`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
  for (const p of [pageA, pageB, pageAdmin]) await p?.context().close();
});
