'use strict';
// End-to-end tests for Phase 8 growth (CLONE_SPEC.md §38.2–§38.3, PLAN P8.1–P8.2), real server + SQLite + Chromium:
//   • Predictions referrals: the owner's default offer (₦1,000 / ₦500 after ₦10,000), a referral link attributing a sign-up,
//     volume against the referrer never counting, both rewards paid in play money (journal from play:mint) with
//     notifications and the Rewards page, the production path (no treasury → refused; the Central Bank funded → paid as
//     credit), lifetime caps, the waitlist `ref` carried over at email verification;
//   • fraud review: a shared device and many sign-ups from one network hold a referral in Admin › Growth; approve (step-up)
//     pays both sides, reject pays nothing; audited;
//   • share links: WhatsApp first, then X, Facebook, Telegram and copy-link; a signed link per share with opens and
//     sign-ups; copy-trade pre-fills only what the sharer showed and never trades; revocation; forged tokens; flags;
//   • persistence across a restart.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client, UA } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-growth-'));
const DB_FILE = path.join(TMP, 'growth.db');
const PW = 'Baobab-Lantern-Harmattan-8264';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const opts = (port) => ({ port, dbFile: DB_FILE, tickMs: 250, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } });
let BASE; let PORT; let srv; let browser; let admin;
const allPages = [];
const email = (n) => `${n}.${stamp}@example.test`;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const q1 = (sql, ...a) => dbq(sql, ...a)[0];
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, { timeout = 15000, interval = 150 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { const v = await fn(); if (v !== false && v !== undefined && v !== null) return v; } catch (e) { if (Date.now() > end) throw e; } if (Date.now() > end) throw new Error('eventually: condition not met'); await sleep(interval); }
}
async function newPage(viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  // Share targets are external sites: never load them (the tests read the links only).
  await ctx.route(/^https:\/\/(wa\.me|twitter\.com|x\.com|www\.facebook\.com|t\.me)\//, (r) => r.abort());
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
const setFlag = async (key, enabled) => { const r = await adminCall('PUT', `/v1/admin/flags/${key}`, { enabled, reason: 'growth e2e' }); assert.equal(r.status, 200, r.text); };
const setRef = async (body) => { const r = await adminCall('PUT', '/v1/admin/referrals/settings', { ...body, reason: 'growth e2e settings' }); assert.equal(r.status, 200, r.text); return r.body; };
const setOwner = async (key, value) => { const r = await adminCall('PUT', `/v1/admin/owner_settings/${key}`, { value, reason: 'growth e2e owner setting' }); assert.equal(r.status, 200, r.text); };
// A client with a fixed browser device id (X-Device-Id, the P3.7 fraud signal), for every call it makes.
function withDevice(c, device) { const call = c.call.bind(c); c.call = (m, p, b, h = {}) => call(m, p, b, { 'x-device-id': device, ...h }); return c; }
async function signUp(name, { device = null, cookie = null } = {}) {
  const c = new Client(BASE, name);
  if (device) withDevice(c, device);
  await c.boot();
  if (cookie) for (const [k, v] of Object.entries(cookie)) c.jar.set(k, v);
  const r = await c.call('POST', '/v1/users', { email: email(name), password: PW, display_name: `Member ${name.replace(/[^a-z]/gi, '')}` });
  assert.equal(r.status, 201, r.text);
  c.user = r.body.user;
  return c;
}
const balance = (uid) => q1('SELECT balance_cents c FROM users WHERE id=?', uid).c;
// A market with the system liquidity on both sides, and a fair price in the middle.
let MKT;
async function quote(t) { const r = await admin.call('GET', `/trade-api/v2/markets/${t}`); assert.equal(r.status, 200, r.text); return r.body.market; }
const ccOf = (d) => Math.round(Number(d) * 100);
// The friend buys `count` YES at market from the system liquidity (never the referrer).
async function buyFromLiquidity(c, count) { const r = await c.call('POST', `/v1/users/${c.uid}/orders`, { ticker: MKT.ticker, side: 'yes', type: 'market', count }); assert.equal(r.status, 201, r.text); return r.body; }
async function deposit(c, dollars) { const r = await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: dollars }); assert.equal(r.status, 201, r.text); }

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  srv = await start(opts(PORT));
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  const m = q1("SELECT m.ticker, m.event_ticker FROM markets m WHERE m.status='active' AND m.fractional_trading_enabled=1 AND m.price_level_structure='linear_cent' AND m.ticker NOT LIKE 'PLXCOMBO%' AND m.ticker NOT LIKE 'PLXFLASH%' AND (SELECT COUNT(*) FROM orders o WHERE o.market_ticker=m.ticker AND o.status='resting')>=8 ORDER BY m.rowid LIMIT 1");
  MKT = { ...m, ...(await quote(m.ticker)) };
});
after(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await srv?.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('referrals, production path: the owner default offer; without a treasury rewards are refused; the funded Central Bank pays them as credit', async () => {
  // Owner decision 2026-11-08: ₦1,000 to the referrer, ₦500 to the friend after ₦10,000 of volume (1 internal cent = ₦1).
  const offer = (await new Client(BASE, 'anon').boot().then((c) => c.call('GET', '/v1/referrals/offer'))).body.offer;
  assert.deepEqual([offer.referrer_reward_cents, offer.referee_reward_cents, offer.threshold_cents], [1000, 500, 10000]);
  assert.deepEqual([offer.referrer_reward, offer.referee_reward, offer.threshold], ['₦1,000', '₦500', '₦10,000']);
  await setRef({ threshold_cents: 2000 }); // ₦2,000 keeps the trades of this suite small
  // The main server runs in play mode (turned on before any real money exists: the reverse guard refuses it later).
  assert.equal((await adminCall('PUT', '/v1/admin/play_mode', { on: true, reason: 'play money for the growth suite' })).status, 200);
  // Production (play mode off) on a second server of its own: no treasury → both rewards refused, nothing credited.
  const port2 = await freePort(); const db2 = path.join(TMP, 'production.db');
  const srv2 = await start({ ...opts(port2), dbFile: db2 });
  const base0 = BASE; BASE = `http://127.0.0.1:${port2}`;
  const q2 = (sql, ...a) => { const d = new DatabaseSync(db2); try { return d.prepare(sql).all(...a)[0]; } finally { d.close(); } };
  const bal2 = (uid) => q2('SELECT balance_cents c FROM users WHERE id=?', uid).c;
  const admin0 = admin;
  try {
  admin = await new Client(BASE, 'admin-prod').logIn(ADMIN.email, ADMIN.password);
  await setRef({ threshold_cents: 2000 });
  const r0 = await signUp('prodref');
  const code0 = (await r0.call('GET', '/v1/referrals')).body.referrals.referral_code;
  const f0 = await signUp('prodfriend');
  assert.equal((await f0.call('POST', '/v1/referrals/apply', { code: code0 })).status, 201);
  await deposit(r0, 200); await deposit(f0, 200); // the demo-funds method (not play money)
  const b0 = [bal2(r0.uid), bal2(f0.uid)];
  await buyFromLiquidity(f0, 60);
  await eventually(() => q2("SELECT status FROM referrals WHERE referee_id=?", f0.uid).status === 'rewarded');
  { const d = new DatabaseSync(db2); try { assert.deepEqual(d.prepare("SELECT role, status, detail FROM referral_rewards WHERE referral_id=(SELECT id FROM referrals WHERE referee_id=?) ORDER BY role").all(f0.uid).map((x) => [x.role, x.status, x.detail]), [['referee', 'refused', 'treasury_off'], ['referrer', 'refused', 'treasury_off']]); } finally { d.close(); } }
  assert.equal(bal2(r0.uid), b0[0]);
  // The Central Bank on and funded: the next referral is paid from the vault as non-withdrawable credit.
  await setFlag('central_bank', true);
  assert.equal((await adminCall('POST', '/v1/admin/central_bank/fund', { amount_dollars: 1000, reason: 'referral budget' })).status, 200);
  const f1 = await signUp('prodfriend2');
  assert.equal((await f1.call('POST', '/v1/referrals/apply', { code: code0 })).status, 201);
  await deposit(f1, 200);
  const before1 = bal2(r0.uid);
  await buyFromLiquidity(f1, 60);
  await eventually(() => q2("SELECT COUNT(*) c FROM referral_rewards WHERE referral_id=(SELECT id FROM referrals WHERE referee_id=?) AND status='paid'", f1.uid).c === 2);
  assert.equal(bal2(r0.uid) - before1, 1000);
  const credit = q2("SELECT kind, amount_cents FROM ledger WHERE user_id=? AND ref=(SELECT id FROM referrals WHERE referee_id=?) ORDER BY rowid DESC LIMIT 1", r0.uid, f1.uid);
  assert.deepEqual([credit.kind, credit.amount_cents], ['credit', 1000]);
  assert.equal((await adminCall('POST', '/v1/admin/payments/ledger_audit/run', {})).body.ok, true, 'the vault → user journal balances');
  } finally {
    await srv2.close();
    BASE = base0; admin = admin0;
  }
});

test('referrals in play mode: a referral link attributes the sign-up; trades with the referrer never count; both sides rewarded in play money, notified and shown on Rewards; lifetime cap', async () => {
  const ref = await signUp('referrer');
  await deposit(ref, 200);
  const r = (await ref.call('GET', '/v1/referrals')).body.referrals;
  assert.match(r.referral_code, /^[A-Z2-9]{10}$/);
  assert.equal(r.link_path, `/?ref=${r.referral_code}`);
  // The friend opens the referral link in a browser (at 390 px) and signs up there: attributed by the first-party cookie.
  const page = await newPage({ width: 390, height: 844 });
  await page.goto(`${BASE}${r.link_path}`);
  await page.waitForSelector('#view > *');
  assert.ok((await page.context().cookies()).some((c) => c.name === 'plx_ref' && c.value === r.referral_code));
  await uiSignUp(page, email('friend'), 'Femi Friend');
  const friendId = q1('SELECT id FROM users WHERE email=?', email('friend')).id;
  const row = q1('SELECT * FROM referrals WHERE referee_id=?', friendId);
  assert.deepEqual([row.referrer_id, row.status, row.source, row.threshold_cents], [ref.uid, 'pending', 'link', 2000]);
  const friend = await new Client(BASE, 'friend').logIn(email('friend'), PW);
  await deposit(friend, 200);
  // The pair trading with each other: the referrer rests a YES offer just inside the liquidity, the friend takes it.
  const fairAsk = ccOf(MKT.yes_ask_dollars); const fairBid = ccOf(MKT.yes_bid_dollars);
  const px = fairAsk - 1;
  assert.ok(px > fairBid, `room inside the spread ${fairBid}-${fairAsk}`);
  assert.equal((await ref.call('POST', `/v1/users/${ref.uid}/orders`, { ticker: MKT.ticker, side: 'no', type: 'limit', price: 100 - px, count: 50 })).status, 201);
  const pair = await friend.call('POST', `/v1/users/${friend.uid}/orders`, { ticker: MKT.ticker, side: 'yes', type: 'limit', price: px, count: 50 });
  assert.equal(pair.status, 201, pair.text);
  assert.equal(q1('SELECT COUNT(*) c FROM fills f JOIN fills g ON g.trade_id=f.trade_id AND g.user_id=? WHERE f.user_id=?', ref.uid, friend.uid).c, 1, 'the friend traded against the referrer');
  await sleep(300);
  assert.equal(q1('SELECT progress_cents p FROM referrals WHERE id=?', row.id).p, 0, 'volume against the referrer never counts');
  // The friend's Rewards page shows the goal and progress.
  await page.goto(BASE + '/rewards');
  await page.waitForSelector('[data-testid=referral-progress][data-status=pending]');
  assert.match(await page.textContent('[data-testid=referral-offer]'), /₦1,000.*₦500/);
  // Volume from the liquidity counts: past the goal both are rewarded in play money (minted), notified.
  const b = [balance(ref.uid), balance(friendId)];
  await buyFromLiquidity(friend, 60);
  await eventually(() => q1('SELECT status FROM referrals WHERE id=?', row.id).status === 'rewarded');
  assert.equal(balance(ref.uid) - b[0], 1000);
  assert.ok(balance(friendId) - b[1] < 0, 'the friend spent on the trade');
  assert.deepEqual(dbq("SELECT user_id, role, amount_cents, status FROM referral_rewards WHERE referral_id=? ORDER BY role", row.id).map((x) => [x.user_id, x.role, x.amount_cents, x.status]), [[friendId, 'referee', 500, 'paid'], [ref.uid, 'referrer', 1000, 'paid']]);
  assert.equal(q1("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='bonus' AND ref=? AND amount_cents=500", friendId, row.id).c, 1);
  assert.equal(q1("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='referral_reward'", ref.uid).c, 1);
  assert.equal((await adminCall('POST', '/v1/admin/payments/ledger_audit/run', {})).body.ok, true, 'the journal stays balanced (play:mint contra)');
  await page.reload();
  await page.waitForSelector('[data-testid=referral-progress][data-status=rewarded]');
  // The referrer's page: 1 friend rewarded (plural rules of the page language), ₦1,000 earned; invite opens the share sheet.
  const rp = await newPage();
  await uiLogIn(rp, { email: email('referrer') });
  await rp.goto(BASE + '/rewards');
  await rp.waitForSelector('[data-testid=referral-code]');
  assert.equal(await rp.textContent('[data-testid=referral-code]'), r.referral_code);
  assert.match(await rp.textContent('[data-testid=referral-counts]'), /^1 friend rewarded/);
  assert.match(await rp.textContent('[data-testid=referral-earned]'), /₦1,000/);
  await rp.click('[data-testid=referral-invite]');
  await rp.waitForSelector('[data-testid=share-dialog] [data-testid=share-whatsapp]');
  assert.match(decodeURIComponent(await rp.getAttribute('[data-testid=share-whatsapp]', 'href')), new RegExp(`\\?ref=${r.referral_code}`));
  // Lifetime cap: with a cap of 1 reward, the next friend's referral rewards the friend but caps the referrer.
  await setRef({ lifetime_cap_count: 1 });
  const g = await signUp('friend2', { cookie: { plx_ref: r.referral_code } });
  assert.equal(q1('SELECT source FROM referrals WHERE referee_id=?', g.uid).source, 'link');
  await deposit(g, 200);
  await buyFromLiquidity(g, 60);
  await eventually(() => q1("SELECT COUNT(*) c FROM referral_rewards WHERE referral_id=(SELECT id FROM referrals WHERE referee_id=?)", g.uid).c === 2);
  assert.deepEqual(dbq("SELECT role, status FROM referral_rewards WHERE referral_id=(SELECT id FROM referrals WHERE referee_id=?) ORDER BY role", g.uid).map((x) => [x.role, x.status]), [['referee', 'paid'], ['referrer', 'capped']]);
  await setRef({ lifetime_cap_count: 20 });
  // Codes: own code, a second code, a wrong code and a late code are refused with clear errors.
  assert.equal((await ref.call('POST', '/v1/referrals/apply', { code: r.referral_code })).code, 'referral_self');
  assert.equal((await friend.call('POST', '/v1/referrals/apply', { code: r.referral_code })).code, 'referral_already_used');
  const late = await signUp('late');
  dbrun("UPDATE users SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?", late.uid);
  assert.equal((await late.call('POST', '/v1/referrals/apply', { code: r.referral_code })).code, 'referral_too_late');
  assert.equal((await late.call('POST', '/v1/referrals/apply', { code: 'NOPE1234' })).code, 'referral_code_invalid');
  assert.deepEqual([...page.errors, ...rp.errors], []);
});

test('fraud review: a shared device holds the referral in Admin › Growth; approve (step-up) pays both, reject pays nothing; many sign-ups from one network are held too', async () => {
  const dev = `dev-shared-${stamp}`.slice(0, 40).padEnd(20, 'x');
  const r2 = withDevice(await signUp('sharer', { device: dev }), dev);
  await deposit(r2, 200);
  const code = (await r2.call('GET', '/v1/referrals')).body.referrals.referral_code;
  const f2 = await signUp('sockpuppet', { device: dev });
  assert.equal((await f2.call('POST', '/v1/referrals/apply', { code })).status, 201);
  await deposit(f2, 200);
  const before2 = balance(r2.uid);
  await buyFromLiquidity(f2, 60);
  const ref2 = await eventually(() => { const x = q1('SELECT * FROM referrals WHERE referee_id=?', f2.uid); return x.status === 'review' ? x : null; });
  assert.equal(q1('SELECT COUNT(*) c FROM referral_rewards WHERE referral_id=?', ref2.id).c, 0, 'nothing paid while held');
  const rv = q1("SELECT * FROM referral_reviews WHERE referral_id=?", ref2.id);
  assert.ok(JSON.parse(rv.signals_json).some((s) => s.signal === 'shared_device'));
  assert.ok(q1("SELECT COUNT(*) c FROM notifications WHERE user_id=(SELECT id FROM users WHERE email=?) AND type='admin_approval'", ADMIN.email).c >= 1, 'admins are told');
  // Admin › Growth: the queue, approve with a reason and a fresh step-up.
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  dbrun('UPDATE sessions SET auth_at=0 WHERE user_id=(SELECT id FROM users WHERE email=?)', ADMIN.email);
  await ap.goto(BASE + '/admin/growth');
  await ap.waitForSelector(`[data-testid=adm-ref-review][data-id="${rv.id}"] [data-signal=shared_device]`);
  await ap.click(`[data-testid=adm-ref-review][data-id="${rv.id}"] [data-testid=adm-ref-approve]`);
  await ap.fill('[data-testid=confirm-reason]', 'devices checked: a shared family tablet');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-testid=step-up-password]');
  await ap.fill('[data-testid=step-up-password]', PW);
  await ap.click('[data-testid=step-up-submit]');
  await eventually(() => q1('SELECT status FROM referral_reviews WHERE id=?', rv.id).status === 'approved');
  assert.equal(q1('SELECT status FROM referrals WHERE id=?', ref2.id).status, 'rewarded');
  assert.equal(balance(r2.uid) - before2, 1000);
  const audit = q1("SELECT * FROM admin_audit WHERE action='referrals.review.approve' ORDER BY ts DESC LIMIT 1");
  assert.equal(audit.reason, 'devices checked: a shared family tablet');
  // A second one on the same device: rejected, nothing paid, both told.
  const f3 = await signUp('sockpuppet2', { device: dev });
  assert.equal((await f3.call('POST', '/v1/referrals/apply', { code })).status, 201);
  await deposit(f3, 200);
  await buyFromLiquidity(f3, 60);
  const rv3 = await eventually(() => q1("SELECT v.* FROM referral_reviews v JOIN referrals r ON r.id=v.referral_id WHERE r.referee_id=? AND v.status='pending'", f3.uid));
  await ap.goto(BASE + '/admin/growth');
  await ap.click(`[data-testid=adm-ref-review][data-id="${rv3.id}"] [data-testid=adm-ref-reject]`);
  await ap.fill('[data-testid=confirm-reason]', 'same device as the referrer, no explanation');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-testid=adm-ref-reviews-empty]');
  assert.equal(q1('SELECT status FROM referrals WHERE id=?', rv3.referral_id).status, 'rejected');
  assert.equal(q1('SELECT COUNT(*) c FROM referral_rewards WHERE referral_id=?', rv3.referral_id).c, 0);
  assert.equal(q1("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND title LIKE 'Referral not rewarded%'", f3.uid).c, 1);
  // IP velocity: every client of this suite comes from 127.0.0.1; at 2 referred sign-ups a day from one network, the
  // second referral of a fresh referrer (different devices) is held with the ip_velocity signal. Owner setting, live.
  await setOwner('referrals.review_ip_signups_per_day', 2);
  const r4 = await signUp('netref', { device: `dev-a-${stamp}`.padEnd(20, 'a') });
  const code4 = (await r4.call('GET', '/v1/referrals')).body.referrals.referral_code;
  const g1 = await signUp('net1', { device: `dev-b-${stamp}`.padEnd(20, 'b') });
  const g2 = await signUp('net2', { device: `dev-c-${stamp}`.padEnd(20, 'c') });
  for (const g of [g1, g2]) { assert.equal((await g.call('POST', '/v1/referrals/apply', { code: code4 })).status, 201); await deposit(g, 200); }
  await buyFromLiquidity(g1, 60); await buyFromLiquidity(g2, 60);
  const held = await eventually(() => { const v = q1("SELECT v.* FROM referral_reviews v JOIN referrals r ON r.id=v.referral_id WHERE r.referee_id IN (?,?) ORDER BY v.created_ts DESC LIMIT 1", g1.uid, g2.uid); return v || null; });
  assert.ok(JSON.parse(held.signals_json).some((s) => s.signal === 'ip_velocity'), held.signals_json);
  await setOwner('referrals.review_ip_signups_per_day', 5);
  assert.deepEqual(ap.errors, []);
});

test('the waitlist ref carries over: a guest who joined with a referral code signs up, verifies the email and is attributed (source waitlist)', async () => {
  const ref = await signUp('wlref');
  const code = (await ref.call('GET', '/v1/referrals')).body.referrals.referral_code;
  const g = await new Client(BASE, 'wlguest').boot();
  const consent = (await g.call('GET', '/v1/waitlists/real_money_launch')).body.consent.version;
  assert.equal((await g.call('POST', '/v1/waitlists/real_money_launch/guest_join', { email: email('wlguest'), consent: true, consent_version: consent, ref: code })).status, 202);
  const conf = q1("SELECT body FROM email_outbox WHERE to_email=? ORDER BY rowid DESC LIMIT 1", email('wlguest')).body;
  const token = new URL(/https?:\/\/\S+\/waitlist\/confirm\?token=\S+/.exec(conf)[0]).searchParams.get('token');
  assert.equal((await g.call('POST', '/v1/waitlists/confirm', { token })).status, 200);
  const u = await signUp('wlguest');
  assert.equal(q1('SELECT COUNT(*) c FROM referrals WHERE referee_id=?', u.uid).c, 0, 'not before the email is verified');
  const mail = await eventually(() => q1("SELECT body FROM email_outbox WHERE to_email=? AND subject LIKE 'Confirm your email%' ORDER BY rowid DESC LIMIT 1", email('wlguest')));
  const vt = new URL(/https?:\/\/\S+\/verify-email\?token=\S+/.exec(mail.body)[0]).searchParams.get('token');
  assert.equal((await (await new Client(BASE, 'v').boot()).call('POST', '/v1/verify_email', { token: vt })).status, 200);
  const row = q1('SELECT * FROM referrals WHERE referee_id=?', u.uid);
  assert.deepEqual([row.referrer_id, row.source, row.status], [ref.uid, 'waitlist', 'pending']);
});

test('share and copy-trade: WhatsApp first; a signed link per share with opens and sign-ups; copy-trade pre-fills only what was shown and never trades; revoke; forged tokens; flags', async () => {
  // The sharer holds a position and shares it from the event page, showing price and size.
  const sharer = await signUp('sharer2');
  await deposit(sharer, 200);
  await buyFromLiquidity(sharer, 20);
  const page = await newPage();
  await uiLogIn(page, { email: email('sharer2') });
  const ev = q1('SELECT e.ticker, e.series_ticker, s.slug FROM events e JOIN series s ON s.ticker=e.series_ticker WHERE e.ticker=?', MKT.event_ticker);
  const evUrl = `/markets/${ev.series_ticker.toLowerCase()}/${ev.slug}/${ev.ticker.toLowerCase()}`;
  await page.goto(BASE + evUrl);
  await page.waitForSelector('[data-testid=share-position]');
  await page.click('[data-testid=share-position]');
  await page.waitForSelector('[data-testid=share-opts]');
  await page.check('[data-testid=share-show-size]');
  await page.click('[data-testid=share-create]');
  await page.waitForSelector('[data-testid=share-ready]');
  // Channel order is the product decision: WhatsApp first (primary), then X, Facebook, Telegram, copy-link.
  const channels = await page.$$eval('[data-testid=share-channels] .share-ch', (els) => els.map((e) => e.dataset.channel || 'copy'));
  assert.deepEqual(channels, ['whatsapp', 'x', 'facebook', 'telegram', 'copy']);
  assert.ok(await page.$eval('[data-testid=share-whatsapp]', (a) => a.classList.contains('btn-primary')));
  const url = await page.inputValue('[data-testid=share-url]');
  assert.match(url, new RegExp(`^${BASE}/s/[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{22}$`));
  const hrefs = Object.fromEntries(await page.$$eval('[data-testid=share-channels] a', (els) => els.map((a) => [a.dataset.channel, a.getAttribute('href')])));
  assert.ok(hrefs.whatsapp.startsWith('https://wa.me/?text=') && decodeURIComponent(hrefs.whatsapp).endsWith(url));
  assert.ok(hrefs.x.startsWith('https://twitter.com/intent/tweet?') && hrefs.x.includes(encodeURIComponent(url)));
  assert.equal(hrefs.facebook, `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`);
  assert.ok(hrefs.telegram.startsWith(`https://t.me/share/url?url=${encodeURIComponent(url)}`));
  for (const a of await page.$$('[data-testid=share-channels] a')) assert.equal(await a.getAttribute('rel'), 'noopener noreferrer');
  const token = url.split('/s/')[1];
  const link = q1('SELECT * FROM share_links WHERE id=?', token.split('.')[0]);
  assert.deepEqual([link.kind, link.side, link.show_price, link.show_size, link.clicks], ['position', 'yes', 1, 1, 0]);
  // A member opens the link: lands on the market with the ticket pre-filled (limit, the sharer's price and size), a note
  // says so, and no order is ever placed by itself.
  const visitor = await signUp('copier');
  const vp = await newPage({ width: 390, height: 844 });
  await uiLogIn(vp, { email: email('copier') });
  await vp.goto(url);
  await vp.waitForSelector('[data-testid=copy-trade-note]');
  assert.match(new URL(vp.url()).pathname, new RegExp(`^${evUrl}$`));
  assert.equal(new URL(vp.url()).searchParams.get('market'), MKT.ticker);
  assert.equal(await vp.inputValue('[data-testid=t-price]'), String(link.price_cc / 100));
  assert.equal(await vp.inputValue('[data-testid=t-count]'), String(link.count_units / 100));
  assert.match(await vp.textContent('[data-testid=copy-trade-note]'), /nothing is traded for you/);
  await sleep(1500);
  assert.equal(q1('SELECT COUNT(*) c FROM orders WHERE user_id=?', visitor.uid).c, 0, 'copy-trade never places an order');
  assert.equal(q1('SELECT clicks FROM share_links WHERE id=?', link.id).clicks, 1);
  // Only what the sharer showed: without size, the public copy has none.
  const noSize = await sharer.call('POST', `/v1/users/${sharer.uid}/share_links`, { kind: 'position', ticker: MKT.ticker, show_price: false });
  const c2 = (await visitor.call('GET', `/v1/share/${encodeURIComponent(noSize.body.share_link.token)}/copy`)).body.copy;
  assert.deepEqual([c2.side, c2.price_cc, c2.count_fp, c2.auto_trade], ['yes', null, null, false]);
  // Opens per IP are limited by the owner setting (default 60 a minute): at 1, a second open still redirects, uncounted.
  await setOwner('share.clicks_per_ip_per_minute', 1);
  const again = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA } });
  assert.equal(again.status, 302);
  assert.equal(q1('SELECT clicks FROM share_links WHERE id=?', link.id).clicks, 1);
  await setOwner('share.clicks_per_ip_per_minute', 60);
  // A new visitor arrives through the link and signs up: the sign-up is attributed to the link, and the sharer's
  // referral code came with it.
  const np = await newPage();
  await np.goto(url);
  await np.waitForSelector('[data-testid=copy-trade-note]');
  await uiSignUp(np, email('arrival'), 'Ada Arrival');
  const arrival = q1('SELECT id FROM users WHERE email=?', email('arrival')).id;
  assert.equal(q1('SELECT signups FROM share_links WHERE id=?', link.id).signups, 1);
  assert.equal(q1('SELECT referrer_id FROM referrals WHERE referee_id=?', arrival).referrer_id, sharer.uid);
  // The share card image is a real PNG.
  const png = await fetch(`${BASE}/og/share/${token}.png`);
  assert.equal(png.status, 200); assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual([...Buffer.from(await png.arrayBuffer()).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  // Rewards › Your share links: opens and sign-ups; revoke; the link then lands on the home page.
  await page.goto(BASE + '/rewards');
  const row = `[data-testid=share-link-row][data-id="${link.id}"]`;
  await page.waitForSelector(row);
  assert.equal(await page.textContent(`${row} [data-testid=share-clicks]`), '2');
  assert.equal(await page.textContent(`${row} [data-testid=share-signups]`), '1');
  await page.click(`${row} [data-testid=share-revoke]`);
  await page.waitForSelector(`${row}[data-status=revoked]`);
  const gone = await fetch(url, { redirect: 'manual' });
  assert.equal(gone.status, 302); assert.equal(gone.headers.get('location'), '/');
  assert.equal((await visitor.call('GET', `/v1/share/${encodeURIComponent(token)}`)).status, 404);
  // Forged: a valid id with a wrong signature, or a made-up id, never resolves.
  assert.equal((await visitor.call('GET', `/v1/share/${link.id}.${'Q'.repeat(22)}`)).status, 404);
  // Flags: copy_trade off → the link still opens the market, without a pre-filled ticket; share_links off → home.
  const t3 = (await sharer.call('POST', `/v1/users/${sharer.uid}/share_links`, { kind: 'position', ticker: MKT.ticker })).body.share_link.token;
  await setFlag('copy_trade', false);
  await vp.goto(`${BASE}/s/${t3}`);
  await vp.waitForSelector('[data-testid=submit-order]');
  assert.equal(await vp.locator('[data-testid=copy-trade-note]').count(), 0);
  assert.equal((await visitor.call('GET', `/v1/share/${encodeURIComponent(t3)}/copy`)).code, 'feature_disabled');
  await setFlag('copy_trade', true);
  await setFlag('share_links', false);
  const off = await fetch(`${BASE}/s/${t3}`, { redirect: 'manual' });
  assert.equal(off.headers.get('location'), '/');
  assert.equal((await sharer.call('POST', `/v1/users/${sharer.uid}/share_links`, { kind: 'event', ticker: MKT.event_ticker })).code, 'feature_disabled');
  // With share links off the share button still shares the plain page address (no signed link).
  await page.goto(BASE + evUrl);
  await page.waitForSelector('#share-btn');
  await page.click('#share-btn');
  await page.waitForSelector('[data-testid=share-url]');
  assert.equal(await page.inputValue('[data-testid=share-url]'), `${BASE}${evUrl}${q1('SELECT COUNT(*) c FROM markets WHERE event_ticker=?', MKT.event_ticker).c > 1 ? `?market=${MKT.ticker}` : ''}`);
  await setFlag('share_links', true);
  assert.deepEqual([...page.errors, ...vp.errors, ...np.errors], []);
});

test('persistence across a restart: referrals, rewards, reviews, share links and their counts, settings', async () => {
  const counts = () => ({ refs: q1('SELECT COUNT(*) c FROM referrals').c, rewards: q1('SELECT COUNT(*) c FROM referral_rewards').c, reviews: q1('SELECT COUNT(*) c FROM referral_reviews').c, links: q1('SELECT COUNT(*) c FROM share_links').c, clicks: q1('SELECT SUM(clicks) c FROM share_links').c, threshold: JSON.parse(q1("SELECT value FROM admin_settings WHERE key='referrals:predictions'").value).threshold_cents });
  const c0 = counts();
  await srv.close();
  srv = await start(opts(PORT));
  admin = await new Client(BASE, 'admin2').logIn(ADMIN.email, ADMIN.password);
  assert.deepEqual(counts(), c0);
  assert.equal((await admin.call('GET', '/v1/admin/referrals')).body.settings.threshold_cents, 2000);
  const p = await newPage();
  await uiLogIn(p, { email: email('referrer') });
  await p.goto(BASE + '/rewards');
  await p.waitForSelector('[data-testid=referral-earned]');
  assert.match(await p.textContent('[data-testid=referral-earned]'), /₦1,000/);
  assert.deepEqual(p.errors, []);
});
