'use strict';
// End-to-end browser tests for the features added from the 2026-11-02 capture (CLONE_SPEC §13):
// new layout + navigation, browse grid/list + subcategories, calendar, social, notifications + price alerts,
// account limits, two-factor login, mobile layout. Real server + real SQLite file + real Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { totp } = require('../server/features.js');

// RS3 (CLONE_SPEC.md §25.11): a TOTP code is accepted once — each accepted code must be for a newer 30-second step than
// the last one. freshTotp() returns the code for the next unused step inside the server's ±1-step window (waiting for the
// next step when both are used).
const usedTotpStep = new Map();
async function freshTotp(secret) {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    const step = Math.max((usedTotpStep.get(secret) ?? -Infinity) + 1, now);
    if (step <= now + 1) { usedTotpStep.set(secret, step); return totp(secret, step * 30000 + 15000); }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-feat-'));
const DB_FILE = path.join(TMP, 'feat.db');
const PORT = 4300 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const RATE_URL = '/markets/plxrate/central-bank-decision/plxrate-26dec';
const CUT = 'PLXRATE-26DEC-CUT';
const stamp = Date.now();
const carol = { email: `carol.${stamp}@example.test`, name: 'Carol Tester', nick: `carol_${stamp % 100000}` };
const dave = { email: `dave.${stamp}@example.test`, name: 'Dave Tester', nick: `dave_${stamp % 100000}` };
const erin = { email: `erin.${stamp}@example.test`, name: 'Erin Tester' };

let srv; let browser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
async function newPage(viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  return page;
}
async function signUp(page, u) {
  await page.goto(BASE + '/sign-up');
  await page.fill('input[name=display_name]', u.name);
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function logIn(page, email) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function createProfile(page, nick) {
  await page.goto(BASE + '/account/profile');
  await page.fill('[data-testid=nickname-input]', nick);
  await page.fill('textarea[name=bio]', `I am ${nick}`);
  await page.click('#profile-form button[type=submit]');
  await page.waitForSelector(`a:has-text("View profile")`);
}
async function mode(page, m) { await page.click('#t-mode-btn'); await page.click(`[data-otype=${m}]`); }
async function deposit(page, amount) {
  await page.goto(BASE + '/portfolio');
  await page.fill('#f-amount', String(amount * 100)); // naira (CLONE_SPEC.md §30)
  await page.click('[data-act=deposit]');
}
const uid = (email) => dbq('SELECT id FROM users WHERE email=?', email)[0].id;

before(async () => { srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 300 }); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('layout: header nav, 360px card grid, Yes/No buttons preselect the ticket, change chips, new tabs', async () => {
  const page = await newPage();
  await page.goto(BASE + '/browse');
  for (const label of ['Markets', 'Invest', 'Live', 'Pro']) assert.ok(await page.locator(`.primary-nav a:has-text("${label}")`).isVisible(), label);
  await page.waitForSelector('#results [data-testid=event-card]');
  // 24-per-page grid with cards at least 360px wide (observed grid rule).
  const widths = await page.$$eval('#results [data-testid=event-card]', (els) => els.map((e) => e.getBoundingClientRect().width));
  assert.ok(widths.length >= 10 && widths.every((w) => w >= 360), `card widths ${widths}`);
  const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  assert.match(font, /Inter/);
  // The odds pill on a card opens the event with that outcome and YES preselected; ?side=no preselects NO.
  const card = page.locator('#results [data-testid=event-card][data-event="PLXRATE-26DEC"]');
  await card.locator('.odds').first().click();
  await page.waitForURL(/\/markets\/plxrate\//);
  await page.waitForSelector('.side-toggle button.on-yes');
  assert.match(await page.textContent('#ticket h3'), /Cut/);
  await page.goto(BASE + RATE_URL + '?side=no&market=PLXRATE-26DEC-HOLD');
  await page.waitForSelector('.side-toggle button.on-no');
  assert.match(await page.textContent('#ticket h3'), /Hold/);
  await page.goto(BASE + RATE_URL + '?side=no&market=PLXRATE-26DEC-CUT');
  await page.waitForSelector('.side-toggle button.on-no');
  assert.match(await page.textContent('#ticket h3'), /Cut/);
  await page.waitForSelector('[data-testid=changes] span');
  assert.match(await page.textContent('[data-testid=changes]'), /1H.*1D.*1W/);
  // Activity / Ideas / Top holders tabs render.
  await page.click('[data-tab=trades]'); await page.waitForSelector('[data-testid=trades] tbody tr');
  await page.click('[data-tab=ideas]'); await page.waitForSelector('[data-testid=event-posts] [data-testid=post]');
  await page.click('[data-tab=holders]'); await page.waitForSelector('[data-testid=holders]');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('browse: grid/list layout persists in the DB, subcategory chips filter, live page', async () => {
  const page = await newPage();
  await signUp(page, erin);
  await page.goto(BASE + '/category/sports');
  await page.waitForSelector('[data-testid=subcategories] a:has-text("Basketball")');
  const before = await page.locator('[data-testid=event-card]').count();
  await page.click('[data-testid=subcategories] a:has-text("Basketball")');
  await page.waitForURL(BASE + '/category/sports/Basketball');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=event-card]').length === 1);
  assert.ok(before > 1);
  assert.match(await page.textContent('[data-testid=event-card] .mcard-title'), /Pro hoops/);
  await page.click('[data-layout=list]');
  await page.waitForSelector('#results.list');
  await page.waitForFunction(() => true);
  await page.waitForTimeout(200);
  assert.equal(JSON.parse(dbq("SELECT value FROM user_settings WHERE user_id=? AND key='browse_layout'", uid(erin.email))[0].value), 'list');
  const p2 = await newPage();
  await logIn(p2, erin.email);
  await p2.goto(BASE + '/browse');
  await p2.waitForSelector('#results.list [data-testid=event-card]');
  await p2.click('.primary-nav a:has-text("Live")');
  await p2.waitForURL(BASE + '/live');
  await p2.waitForSelector('[data-testid=event-card][data-event="PLXCUP-26FINAL"]');
  assert.equal(await p2.locator('[data-testid=event-card]').count(), 1);
  assert.deepEqual([...page.errors, ...p2.errors], []);
  await page.context().close(); await p2.context().close();
});

test('calendar: live section first, dated sections, category filter with counts', async () => {
  const page = await newPage();
  await page.goto(BASE + '/calendar');
  await page.waitForSelector('[data-testid=cal-section]');
  const sections = await page.$$eval('[data-testid=cal-section]', (els) => els.map((e) => ({ date: e.dataset.date, live: e.dataset.live })));
  assert.equal(sections[0].live, 'true');
  const dated = sections.filter((s) => s.live === 'false').map((s) => s.date);
  assert.ok(dated.length >= 5, 'several dated sections');
  assert.deepEqual(dated, [...dated].sort(), 'dated sections ascend');
  assert.match(await page.textContent('[data-testid=cal-filters] [data-cat="Sports"]'), /2 · 1 live/);
  await page.click('[data-testid=cal-filters] [data-cat="Elections"]');
  await page.waitForURL(/category=Elections/);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=event-card]')].every((c) => /PLXSTATE/.test(c.dataset.event)));
  assert.equal(await page.locator('[data-testid=event-card]').count(), 2);
  assert.match(await page.textContent('[data-testid=cal-section] .cal-date'), /Tomorrow|Today/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('social: profile, post, follow, like, reply, bookmark, feeds, delete, notifications live; all persisted', async () => {
  const pc = await newPage();
  await signUp(pc, carol);
  await pc.goto(BASE + '/social');
  await pc.waitForSelector('[data-testid=need-profile]');
  await createProfile(pc, carol.nick);
  assert.equal(dbq('SELECT nickname FROM social_profiles WHERE user_id=?', uid(carol.email))[0].nickname, carol.nick);
  await pc.goto(BASE + '/social');
  await pc.fill('[data-testid=composer-input]', 'Carol thinks the cut is priced right.');
  await pc.click('[data-testid=composer-submit]');
  await pc.waitForSelector('[data-testid=post-body]:has-text("Carol thinks the cut")');
  assert.equal(dbq('SELECT COUNT(*) c FROM posts WHERE user_id=?', uid(carol.email))[0].c, 1);
  // An event-linked idea from the event page.
  await pc.goto(BASE + RATE_URL);
  await pc.click('[data-tab=ideas]');
  await pc.fill('[data-testid=composer-input]', 'Event idea from Carol');
  await pc.click('[data-testid=composer-submit]');
  await pc.waitForSelector('[data-testid=event-posts] [data-testid=post-body]:has-text("Event idea from Carol")');
  assert.equal(dbq("SELECT event_ticker FROM posts WHERE body='Event idea from Carol'")[0].event_ticker, 'PLXRATE-26DEC');
  await pc.goto(BASE + '/social');

  const pd = await newPage();
  await signUp(pd, dave);
  await createProfile(pd, dave.nick);
  await pd.goto(BASE + `/social/profile/${carol.nick}`);
  await pd.waitForSelector('[data-testid=profile]');
  await pd.click('[data-testid=follow-btn]');
  await pd.waitForSelector('[data-testid=follow-btn]:has-text("Following")');
  assert.equal(await pd.textContent('[data-testid=followers]'), '1');
  // Carol's bell updates live over the private notifications channel.
  await pc.waitForSelector('[data-testid=unread-count]');
  // Dave likes, replies to and bookmarks Carol's post from the Following feed.
  await pd.goto(BASE + '/social');
  await pd.click('[data-feed=following]');
  await pd.waitForSelector('[data-testid=post-body]:has-text("Carol thinks the cut")');
  const post = pd.locator('[data-testid=post]:has-text("Carol thinks the cut")');
  await post.locator('[data-act=like]').click();
  await post.locator('[data-act=like][aria-pressed=true]').waitFor();
  assert.equal(await post.locator('[data-testid=like-count]').textContent(), '1');
  await post.locator('[data-act=comments]').click();
  await post.locator('[data-testid=reply-input]').fill('Agreed, Carol.');
  await post.locator('[data-reply] button[type=submit]').click(); // the reply form also has a Sticker button (Phase 2)
  await post.locator('.comment:has-text("Agreed, Carol.")').waitFor();
  assert.equal(await post.locator('[data-testid=comment-count]').textContent(), '1');
  await post.locator('[data-act=bookmark]').click();
  await post.locator('[data-act=bookmark][aria-pressed=true]').waitFor();
  await pd.click('[data-feed=bookmarks]');
  await pd.waitForSelector('[data-testid=post-body]:has-text("Carol thinks the cut")');
  // Feed choice persisted in the DB.
  assert.equal(JSON.parse(dbq("SELECT value FROM user_settings WHERE user_id=? AND key='social_feed'", uid(dave.email))[0].value), 'bookmarks');

  // Carol's notifications: follow, like, reply.
  await pc.goto(BASE + '/notifications');
  await pc.waitForSelector('[data-testid=notifications] [data-type=social_comment]');
  for (const t of ['social_follow', 'social_like', 'social_comment']) assert.ok(await pc.locator(`[data-testid=notifications] [data-type=${t}]`).count(), t);
  await pc.click('#read-all-page');
  await pc.waitForSelector('#read-all-page[disabled]');
  assert.equal(dbq('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL', uid(carol.email))[0].c, 0);

  // Leaderboard and delete.
  await pc.goto(BASE + '/social/leaderboard');
  await pc.waitForSelector(`[data-testid=leaderboard] a:has-text("@${carol.nick}")`);
  await pc.goto(BASE + `/social/profile/${carol.nick}`);
  const mine = pc.locator('[data-testid=post]:has-text("Carol thinks the cut")');
  await mine.locator('[data-act=delete]').click();
  await mine.waitFor({ state: 'detached' });
  assert.equal(dbq("SELECT COUNT(*) c FROM posts WHERE body LIKE 'Carol thinks%'")[0].c, 0);
  assert.equal(dbq('SELECT COUNT(*) c FROM follows WHERE follower_id=? AND followee_id=?', uid(dave.email), uid(carol.email))[0].c, 1);
  assert.deepEqual([...pc.errors, ...pd.errors], []);
  await pc.context().close(); await pd.context().close();
});

test('price alert + fill notifications fire live; Activity tab shows the trader nickname; top holders', async () => {
  const page = await newPage();
  await logIn(page, carol.email);
  await deposit(page, 100);
  await page.waitForSelector('[data-testid=header-balance]:has-text("₦10,000")');
  await page.goto(BASE + RATE_URL);
  await page.waitForSelector('[data-testid=alert-card]');
  await page.selectOption('#alert-form select[name=direction]', 'above');
  await page.fill('#alert-form input[name=price]', '59');
  await page.click('#alert-form button[type=submit]');
  await page.waitForSelector('[data-alert]:has-text("above ₦59")');
  assert.equal(dbq('SELECT COUNT(*) c FROM price_targets WHERE user_id=? AND triggered_at IS NULL', uid(carol.email))[0].c, 1);
  // Market buy of 3 YES at the 59¢ ask moves the last price to 59 → alert + fill notifications.
  await mode(page, 'market');
  await page.fill('#t-count', '3');
  await page.click('[data-testid=submit-order]'); await page.click('[data-testid=review-confirm]'); // order review step (Phase 5A, A7)
  await page.waitForSelector('.toast:has-text("Price alert")');
  await page.waitForSelector('[data-alert]:has-text("triggered")');
  const types = dbq('SELECT type FROM notifications WHERE user_id=? ORDER BY created_ts', uid(carol.email)).map((r) => r.type);
  assert.ok(types.includes('fill') && types.includes('price_target'), types.join(','));
  assert.ok(dbq('SELECT triggered_at FROM price_targets WHERE user_id=?', uid(carol.email))[0].triggered_at);
  await page.click('[data-tab=trades]');
  await page.waitForSelector(`[data-testid=trades] a:has-text("@${carol.nick}")`);
  await page.click('[data-tab=holders]');
  await page.waitForSelector(`[data-testid=holders] a:has-text("@${carol.nick}")`);
  // Alerts list in Account.
  await page.goto(BASE + '/account/alerts');
  await page.waitForSelector('[data-testid=alerts-panel] td:has-text("Triggered")');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('account limits: deposit and trading limits enforced; loosening waits 24h; session time limit locks the app', async () => {
  const page = await newPage();
  await logIn(page, dave.email);
  await page.goto(BASE + '/account/limits');
  await page.fill('[data-testid=limit-deposit] input[name=v]', '10000');
  await page.click('[data-testid=limit-deposit] button[type=submit]');
  await page.waitForSelector('[data-testid=limit-deposit] [data-testid=limit-value]:has-text("₦10,000 per day")');
  await deposit(page, 150);
  await page.waitForSelector('#f-error:has-text("daily deposit limit")');
  await deposit(page, 60);
  await page.waitForSelector('[data-testid=header-balance]:has-text("₦6,000")');
  // Loosening is scheduled, not immediate.
  await page.goto(BASE + '/account/limits');
  await page.fill('[data-testid=limit-deposit] input[name=v]', '50000');
  await page.click('[data-testid=limit-deposit] button[type=submit]');
  await page.waitForSelector('[data-testid=limit-deposit] [data-testid=pending]');
  assert.match(await page.textContent('[data-testid=limit-deposit] [data-testid=limit-value]'), /₦10,000/);
  assert.equal(dbq("SELECT pending_set, pending_value FROM user_limits WHERE user_id=? AND kind='deposit'", uid(dave.email))[0].pending_value, 50000);
  await deposit(page, 50);
  await page.waitForSelector('#f-error:has-text("daily deposit limit")');
  // Trading limit: $5 per day; 10 contracts at 59¢ is $5.90.
  await page.goto(BASE + '/account/limits');
  await page.fill('[data-testid=limit-trading] input[name=v]', '500');
  await page.click('[data-testid=limit-trading] button[type=submit]');
  await page.waitForSelector('[data-testid=limit-trading] [data-testid=limit-value]:has-text("₦500")');
  await page.goto(BASE + RATE_URL);
  await mode(page, 'limit');
  await page.fill('#t-price', '59');
  await page.fill('#t-count', '10');
  await page.click('[data-testid=submit-order]'); await page.click('[data-testid=review-confirm]'); // order review step (Phase 5A, A7)
  await page.waitForSelector('#t-error:has-text("daily trading limit")');
  await page.fill('#t-count', '5');
  await page.click('[data-testid=submit-order]'); await page.click('[data-testid=review-confirm]'); // order review step (Phase 5A, A7)
  await page.waitForSelector('.toast:has-text("Filled 5")');
  // Session limit: 1 minute per day, then simulate the time being used up.
  await page.goto(BASE + '/account/limits');
  await page.fill('[data-testid=limit-session] input[name=v]', '1');
  await page.click('[data-testid=limit-session] button[type=submit]');
  await page.waitForSelector('[data-testid=limit-session] [data-testid=limit-value]:has-text("1 minutes")');
  dbrun('UPDATE session_usage SET seconds=120 WHERE user_id=?', uid(dave.email));
  await page.goto(BASE + '/portfolio');
  await page.waitForSelector('[data-testid=session-limit]');
  const r = await page.evaluate(() => fetch('/v1/live_data/count').then(async (x) => ({ s: x.status, b: await x.json() })));
  assert.equal(r.s, 403); assert.equal(r.b.error.code, 'session_time_limit_reached');
  // Limits page itself stays reachable.
  await page.goto(BASE + '/account/limits');
  await page.waitForSelector('[data-testid=limit-session]');
  dbrun('UPDATE session_usage SET seconds=0 WHERE user_id=?', uid(dave.email));
  await page.context().close();
});

// Performance pass 2026-11-13 (CLONE_SPEC.md §39.18): session time used to be written to the database on every signed-in
// request (with durable commits, a disk sync per page view). It is now added up in memory and written at most every 15 s;
// the limit check above still sees it exactly (it adds the unwritten seconds).
test('session time is written at most every 15 seconds, not on every signed-in request', async () => {
  const page = await newPage();
  await logIn(page, erin.email);
  dbrun('CREATE TABLE IF NOT EXISTS zz_session_writes(n INTEGER)');
  dbrun('CREATE TRIGGER IF NOT EXISTS zz_session_upd AFTER UPDATE ON session_usage BEGIN INSERT INTO zz_session_writes VALUES (1); END');
  dbrun('CREATE TRIGGER IF NOT EXISTS zz_session_ins AFTER INSERT ON session_usage BEGIN INSERT INTO zz_session_writes VALUES (1); END');
  try {
    const codes = await page.evaluate(async () => { const out = []; for (let i = 0; i < 30; i++) out.push((await fetch('/v1/live_data/count')).status); return out; });
    assert.ok(codes.every((c) => c === 200), JSON.stringify(codes));
    const n = dbq('SELECT COUNT(*) c FROM zz_session_writes')[0].c;
    assert.ok(n <= 2, `${n} session-time writes for 30 requests (at most 2 expected)`);
  } finally {
    dbrun('DROP TRIGGER IF EXISTS zz_session_upd'); dbrun('DROP TRIGGER IF EXISTS zz_session_ins'); dbrun('DROP TABLE IF EXISTS zz_session_writes');
    await page.context().close();
  }
});

test('two-factor login: set up from Account, log in requires a valid code, turn off', async () => {
  const page = await newPage();
  await logIn(page, erin.email);
  await page.goto(BASE + '/account/security');
  await page.click('#mfa-start');
  const secret = (await page.textContent('[data-testid=mfa-secret]')).trim();
  await page.fill('[data-testid=mfa-input]', '000000' === totp(secret) ? '111111' : '000000');
  await page.click('#mfa-form button[type=submit]');
  await page.waitForSelector('#mfa-error:has-text("not valid")');
  await page.fill('[data-testid=mfa-input]', await freshTotp(secret));
  await page.click('#mfa-form button[type=submit]');
  await page.waitForSelector('[data-testid=mfa-status]:has-text("On")');
  assert.equal(dbq('SELECT enabled FROM mfa WHERE user_id=?', uid(erin.email))[0].enabled, 1);
  await page.click('[data-testid=account-menu]');
  await page.click('#logout-btn');
  await page.waitForSelector('a:has-text("Log in")');
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', erin.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=mfa-code]');
  assert.equal((await page.evaluate(() => fetch('/v1/session').then((x) => x.json()))).user, null, 'no session before the code');
  await page.fill('[data-testid=mfa-code]', '000000' === totp(secret) ? '111111' : '000000');
  await page.click('button[type=submit]');
  await page.waitForSelector('#auth-error:has-text("not valid")');
  await page.fill('[data-testid=mfa-code]', await freshTotp(secret));
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
  await page.goto(BASE + '/account/security');
  await page.fill('[data-testid=mfa-input]', await freshTotp(secret));
  await page.click('#mfa-form button[type=submit]');
  await page.waitForSelector('[data-testid=mfa-status]:has-text("Off")');
  assert.equal(dbq('SELECT COUNT(*) c FROM mfa WHERE user_id=?', uid(erin.email))[0].c, 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('persistence across restart + mobile layout has no horizontal overflow (light and dark)', async () => {
  await srv.close();
  srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 300 });
  const page = await newPage({ width: 390, height: 844 });
  await logIn(page, carol.email);
  await page.goto(BASE + `/social/profile/${carol.nick}`);
  await page.waitForSelector('[data-testid=post-body]:has-text("Event idea from Carol")');
  assert.equal(await page.textContent('[data-testid=followers]'), '1');
  await page.goto(BASE + '/notifications');
  await page.waitForSelector('[data-testid=notifications] [data-type=price_target]');
  for (const theme of ['light', 'dark']) {
    // Theme is a DB-persisted account setting.
    await page.evaluate(async (t) => {
      const csrf = JSON.parse(localStorage.getItem('csrfToken')).value;
      const s = await fetch('/v1/session').then((r) => r.json());
      await fetch(`/v1/users/${s.user.user_id}/properties`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ properties: { theme: t } }) });
    }, theme);
    for (const p of ['/', '/browse', RATE_URL, '/calendar', '/social', '/portfolio', '/account/limits']) {
      await page.goto(BASE + p);
      await page.waitForSelector('main *');
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 0, `${p} overflows by ${over}px in ${theme}`);
    }
  }
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
