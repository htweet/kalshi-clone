'use strict';
// End-to-end tests for identity, sessions and login security (CLONE_SPEC.md §22; PLAN P1.4–P1.6, P1.14,
// P1.15, G4): password policy, hashed + rotated sessions, login CSRF, uniform login errors, backoff/lockout,
// device list and sign-out (live over WS), idle timeout, step-up modal, withdrawal two-factor, encrypted TOTP
// secrets, the maker trading limit on RFQ confirm, first-admin bootstrap without a default password, and the
// hash-chained audit log. Real server + real SQLite file + real Chromium. Run: npm run test:e2e
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { totp } = require('../server/features.js');
const util = require('../server/util.js');

// RS3 (PHASE3_SPEC.md §25.11): a TOTP code is accepted once — each accepted code must be for a newer 30-second step than
// the last one. freshTotp() returns the code for the next unused step inside the server's ±1-step window (waiting for the
// next step when both are used).
// Bounded wait for an in-page promise (a rejected code would otherwise leave the step-up dialog open forever).
const within = (p, ms = 20000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms))]);
const usedTotpStep = new Map();
async function freshTotp(secret) {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    const step = Math.max((usedTotpStep.get(secret) ?? -Infinity) + 1, now);
    if (step <= now + 1) { usedTotpStep.set(secret, step); return totp(secret, step * 30000 + 15000); }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-auth-'));
const DB_FILE = path.join(TMP, 'auth.db');
const PORT = 5100 + Math.floor(Math.random() * 40);
const PORT2 = PORT + 60;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const ADMIN = { email: 'admin@parlance.local', password: 'Ledger-Keeper-2026!' };
const STEP_UP_MS = 3000;
const AUTH = { accountThreshold: 3, ipThreshold: 500, baseLockMs: 3000, maxLockMs: 12000, stepUpMs: STEP_UP_MS };
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 300, admin: ADMIN, auth: AUTH, quiet: true, security: { authRate: { burst: 2000, per_second: 200 } } };
const stamp = Date.now();
const mk = (k, name) => ({ email: `${k}.${stamp}@example.test`, name });
const U = { p: mk('pat', 'Pat Policy'), t: mk('tim', 'Tim Timing'), l: mk('lou', 'Lou Lockout'), s: mk('sam', 'Sam Sessions'), m: mk('mia', 'Mia Stepup'), w: mk('wes', 'Wes Withdraw'),
  r: mk('rex', 'Rex Requester'), k: mk('kim', 'Kim Maker'), f: mk('fay', 'Fay Forced'), x: mk('xan', 'Xan Staff'), i: mk('ivy', 'Ivy Idle'), q: mk('quin', 'Quin Persist') };

let srv; let browser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const uid = (email) => dbq('SELECT id FROM users WHERE email=?', email)[0].id;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
async function until(fn, ms = 10000, step = 150) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for condition'); await sleep(step); }
}

async function newPage(base = BASE) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(base + '/');
  return page;
}
async function signUp(page, u, pw = PW) {
  await page.goto(BASE + '/sign-up');
  await page.fill('input[name=display_name]', u.name);
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', pw);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function logIn(page, email, pw = PW) {
  await page.goto(page.url().replace(/^(https?:\/\/[^/]+).*$/, '$1') + '/sign-in');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
// In-page API call with the stored CSRF token (the page holds the client-token cookie).
const call = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const c = JSON.parse(localStorage.getItem('csrfToken') || 'null');
  const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', ...(c ? { 'x-csrf-token': c.value } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
// Raw in-page POST with an explicit x-csrf-token (or none).
const rawPost = (page, url, body, token) => page.evaluate(async ([u, b, t]) => {
  const t0 = performance.now();
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', ...(t ? { 'x-csrf-token': t } : {}) }, body: JSON.stringify(b) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })(), ms: performance.now() - t0, setCookie: r.headers.get('set-cookie') };
}, [url, body, token]);
const preToken = (page) => page.evaluate(() => fetch('/v1/auth/csrf').then((r) => r.json()).then((j) => j.csrf_token));
async function apiLogin(page, email, pw) { return rawPost(page, '/v1/log_in', { email, password: pw }, await preToken(page)); }
async function apiSignup(page, u, pw = PW) {
  const r = await rawPost(page, '/v1/users', { email: u.email, password: pw, display_name: u.name }, await preToken(page));
  assert.equal(r.status, 201, r.text);
  await page.evaluate((t) => localStorage.setItem('csrfToken', JSON.stringify({ value: t, expiry: Date.now() + 3600000 })), r.body.csrf_token);
  return r.body.user.user_id;
}
const sessionCookie = async (page) => (await page.context().cookies()).find((c) => c.name === 'plx_session' || c.name === '__Host-plx_session');
const whoami = (page) => page.evaluate(() => fetch('/v1/session').then((r) => r.json()).then((j) => j.user && j.user.email));
const dialog = (page) => page.locator('[data-testid=step-up-dialog]');

before(async () => { srv = await start(OPTS); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('password policy: short, single-class, name/email and breached passwords are refused with clear messages', async () => {
  const page = await newPage();
  await page.goto(BASE + '/sign-up');
  await page.locator('[data-testid=password-rules]').waitFor();
  const attempt = async (pw, name = U.p.name) => {
    await page.fill('input[name=display_name]', name);
    await page.fill('input[name=email]', U.p.email);
    await page.fill('input[name=password]', pw);
    await page.click('button[type=submit]');
    await page.waitForFunction(() => (document.querySelector('#auth-error')?.textContent || '').length > 0);
    const t = await page.textContent('#auth-error');
    await page.evaluate(() => { document.querySelector('#auth-error').textContent = ''; });
    return t;
  };
  assert.match(await attempt('short-1'), /Password must be at least 12 characters/);
  assert.match(await attempt('abcdefghijklmnop'), /mix at least two of/);
  assert.match(await attempt('Policy-Pat-Rocks-77'), /must not contain your email address or name/);
  assert.match(await attempt('Password123!'), /breached passwords/);
  assert.match(await attempt('qwertyuiop123'), /breached passwords/);
  assert.match(await attempt('Summer2025!!!'), /breached passwords/);
  assert.equal(dbq('SELECT COUNT(*) c FROM users WHERE email=?', U.p.email)[0].c, 0);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
  // New hashes carry their scrypt cost parameters.
  assert.match(dbq('SELECT password_hash h FROM users WHERE email=?', U.p.email)[0].h, /^scrypt2\$\d+\$8\$\d\$/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('sessions are stored hashed; login rotates the session; login CSRF is required on pre-session endpoints', async () => {
  const page = await newPage();
  await logIn(page, U.p.email);
  const c1 = await sessionCookie(page);
  assert.equal(c1.name, 'plx_session'); // plain-http localhost: __Host- needs Secure (CLONE_SPEC §22.2)
  assert.ok(c1.httpOnly); assert.equal(c1.sameSite, 'Lax');
  const rows = dbq('SELECT token, sid, device, ip_prefix FROM sessions WHERE user_id=?', uid(U.p.email));
  assert.ok(rows.length >= 1);
  assert.ok(!rows.some((r) => r.token === c1.value), 'no plaintext token in the DB');
  assert.ok(rows.some((r) => r.token === sha256(c1.value)), 'SHA-256 of the cookie is stored');
  const mine = rows.find((r) => r.token === sha256(c1.value));
  assert.match(mine.device, /Chrome/); assert.equal(mine.ip_prefix, '127.0.0.x');

  // Logging in again from the same browser replaces (rotates) the session.
  const r = await apiLogin(page, U.p.email, PW);
  assert.equal(r.status, 200);
  const c2 = await sessionCookie(page);
  assert.notEqual(c2.value, c1.value);
  assert.equal(dbq('SELECT COUNT(*) c FROM sessions WHERE token=?', sha256(c1.value))[0].c, 0, 'old session deleted');
  assert.equal(dbq('SELECT COUNT(*) c FROM sessions WHERE token=?', sha256(c2.value))[0].c, 1);

  // Login CSRF: no token, a bogus token, or another browser's token are all refused.
  const other = await newPage();
  const foreign = await preToken(other);
  await preToken(page);
  for (const [url, body] of [['/v1/log_in', { email: U.p.email, password: PW }], ['/v1/users', { email: `csrf.${stamp}@example.test`, password: PW, display_name: 'Csrf Probe' }], ['/v1/log_in_mfa', { mfa_token: 'x', code: '123456' }]]) {
    for (const tok of [undefined, 'bogus-token', foreign]) {
      const x = await rawPost(page, url, body, tok);
      assert.equal(x.status, 403, `${url} with ${tok ? 'bad' : 'no'} token`);
      assert.equal(x.body.error.details, 'missing or invalid login csrf token');
    }
  }
  assert.equal(dbq('SELECT COUNT(*) c FROM users WHERE email=?', `csrf.${stamp}@example.test`)[0].c, 0);
  await other.context().close(); await page.context().close();
});

test('unknown email and wrong password get identical responses with similar timing', async () => {
  const page = await newPage();
  await apiSignup(page, U.t);
  await call(page, 'POST', '/v1/log_out', {});
  const wrong = []; const unknown = [];
  for (let i = 0; i < 2; i++) {
    wrong.push(await apiLogin(page, U.t.email, `Wrong-Password-${i}x`));
    unknown.push(await apiLogin(page, `ghost${i}.${stamp}@example.test`, `Wrong-Password-${i}x`));
  }
  for (const x of [...wrong, ...unknown]) {
    assert.equal(x.status, 401);
    assert.equal(x.text, wrong[0].text);
    assert.equal(x.setCookie, null);
  }
  assert.deepEqual(wrong[0].body, { error: { code: 'invalid_credentials', message: 'incorrect email or password' } });
  const avg = (a) => a.reduce((s, x) => s + x.ms, 0) / a.length;
  const ratio = avg(wrong) / avg(unknown);
  assert.ok(ratio > 0.4 && ratio < 2.5, `timing ratio ${ratio.toFixed(2)} (wrong ${avg(wrong).toFixed(0)} ms, unknown ${avg(unknown).toFixed(0)} ms)`);
  assert.ok(avg(unknown) > 20, 'unknown emails still pay for a password hash');
  // Both are logged; the unknown address only in masked form.
  const ev = dbq("SELECT user_id, detail FROM auth_events WHERE type='login_fail' ORDER BY ts DESC LIMIT 4");
  assert.equal(ev.filter((e) => e.user_id === uid(U.t.email)).length, 2);
  assert.ok(ev.some((e) => !e.user_id && JSON.parse(e.detail).email === `g***@example.test`));
  assert.ok(!JSON.stringify(dbq('SELECT detail FROM auth_events')).includes(`ghost0.${stamp}`), 'no full unknown email stored');
  await page.context().close();
});

// RS2 (PHASE3_SPEC.md §25.11): repeated failures no longer lock the account for a time; each further attempt must carry a
// proof of work (the browser solves it), so a stranger who knows an email cannot keep its owner out.
const solvePow = (ch) => { for (let n = 0; ; n++) { const h = crypto.createHash('sha256').update(`${ch.id}:${n}`).digest(); let z = 0; for (const b of h) { if (b === 0) { z += 8; continue; } z += Math.clz32(b) - 24; break; } if (z >= ch.bits) return { token: ch.token, nonce: String(n) }; } };
test('backoff: failures require a proof of work (same for unknown emails), the owner is alerted, difficulty grows, the browser still signs in', async () => {
  const page = await newPage();
  await apiSignup(page, U.l);
  await call(page, 'POST', '/v1/log_out', {});
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await apiLogin(page, U.l.email, 'Not-The-Password-1')).status);
  assert.deepEqual(statuses, [401, 401, 401]);
  const gated = await apiLogin(page, U.l.email, PW); // even the right password needs the check now
  assert.equal(gated.status, 429);
  assert.equal(gated.body.error.code, 'too_many_attempts');
  assert.equal(gated.body.error.retry_after_sec, 0);
  assert.ok(gated.body.error.pow && gated.body.error.pow.bits >= 12 && gated.body.error.pow.token);
  // An unknown email behaves exactly the same.
  const ghost = `nobody.${stamp}@example.test`;
  for (let i = 0; i < 3; i++) assert.equal((await apiLogin(page, ghost, 'Not-The-Password-1')).status, 401);
  const g = await apiLogin(page, ghost, 'Not-The-Password-1');
  assert.equal(g.status, 429); assert.deepEqual(Object.keys(g.body.error), Object.keys(gated.body.error));
  // Notification + email + security event for the account owner.
  const lid = uid(U.l.email);
  assert.equal(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='security' AND title='Repeated failed sign-ins'", lid)[0].c, 1);
  assert.equal(dbq("SELECT COUNT(*) c FROM email_outbox WHERE to_email=? AND subject LIKE '%Repeated failed sign-ins%'", U.l.email)[0].c, 1);
  assert.ok(dbq("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='lockout'", lid)[0].c >= 1);
  // A solved proof lets one more guess through (single use); each further failure adds a bit of difficulty.
  const pre = await preToken(page);
  const tryWith = (pw, pow) => rawPost(page, '/v1/log_in', { email: U.l.email, password: pw, pow }, pre);
  const sol = solvePow(gated.body.error.pow);
  assert.equal((await tryWith('Not-The-Password-2', sol)).status, 401);
  const again = await tryWith('Not-The-Password-2', sol);
  assert.equal(again.status, 429, 'a proof is single use');
  assert.equal(again.body.error.pow.bits, gated.body.error.pow.bits + 1, 'difficulty grows with every failure');
  // The UI: the owner types the right password and is signed in (the browser solves the check transparently).
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', U.l.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
  assert.equal(await whoami(page), U.l.email);
  assert.equal(dbq('SELECT COUNT(*) c FROM auth_throttle WHERE key=?', `acct:${sha256(U.l.email)}`)[0].c, 0, 'a success clears the account counter');
  assert.ok(dbq("SELECT COUNT(*) c FROM auth_throttle WHERE key LIKE 'ip:%'")[0].c >= 1, 'per-IP counter persisted');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('device list: sign out one device (the other browser loses access live), then sign out everywhere', async () => {
  const a = await newPage();
  await signUp(a, U.s);
  const b = await newPage();
  await logIn(b, U.s.email);
  await b.goto(BASE + '/portfolio');
  await a.goto(BASE + '/account/security');
  await a.locator('[data-testid=sessions-panel] [data-testid=session-row]').nth(1).waitFor();
  assert.equal(await a.locator('[data-testid=session-row]').count(), 2);
  assert.equal(await a.locator('[data-testid=session-row][data-current="1"] [data-testid=this-device]').count(), 1);
  const otherSid = await a.locator('[data-testid=session-row]:not([data-current])').getAttribute('data-sid');
  await a.click(`[data-testid=session-row][data-sid="${otherSid}"] [data-testid=session-signout]`);
  // B is signed out live (WebSocket 4401 → client re-checks the session).
  await b.waitForSelector('#account-area a:has-text("Log in")', { timeout: 10000 });
  assert.equal(await whoami(b), null);
  assert.equal(await whoami(a), U.s.email);
  assert.equal(dbq('SELECT COUNT(*) c FROM sessions WHERE user_id=?', uid(U.s.email))[0].c, 1);
  await a.locator('[data-testid=session-row]').first().waitFor();
  await until(async () => (await a.locator('[data-testid=session-row]').count()) === 1);

  await logIn(b, U.s.email);
  await b.goto(BASE + '/portfolio');
  await a.goto(BASE + '/account/security');
  await until(async () => (await a.locator('[data-testid=session-row]').count()) === 2);
  await a.click('[data-testid=signout-everywhere]'); // confirm() accepted by the page dialog handler
  await a.waitForURL(/\/sign-in$/);
  await b.waitForSelector('#account-area a:has-text("Log in")', { timeout: 10000 });
  assert.equal(await whoami(a), null); assert.equal(await whoami(b), null);
  assert.equal(dbq('SELECT COUNT(*) c FROM sessions WHERE user_id=?', uid(U.s.email))[0].c, 0);
  const types = dbq('SELECT type FROM auth_events WHERE user_id=?', uid(U.s.email)).map((e) => e.type);
  for (const t of ['signup', 'login_ok', 'session_revoke', 'sessions_revoke_all']) assert.ok(types.includes(t), t);
  // Own security activity is listed in Account › Security.
  await logIn(a, U.s.email);
  await a.goto(BASE + '/account/security');
  await a.locator('[data-testid=security-activity] tr[data-event=sessions_revoke_all]').waitFor();
  assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
  await a.context().close(); await b.context().close();
});

let miaSecret; let wesSecret;
async function enableMfa(page) {
  await page.goto(BASE + '/account/security');
  await page.click('#mfa-start');
  const secret = (await page.textContent('[data-testid=mfa-secret]')).trim();
  await page.fill('[data-testid=mfa-input]', await freshTotp(secret));
  await page.click('#mfa-form button[type=submit]');
  await page.waitForSelector('[data-testid=mfa-status]:has-text("On")');
  return secret;
}

test('step-up: password change and turning off two-factor ask to confirm in a modal, then complete', async () => {
  const page = await newPage();
  await signUp(page, U.m);
  // Turning two-factor on rotates the session (new cookie + CSRF token, same device entry).
  const before = await sessionCookie(page);
  const csrfBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('csrfToken')).value);
  const sidBefore = dbq('SELECT sid FROM sessions WHERE token=?', sha256(before.value))[0].sid;
  miaSecret = await enableMfa(page);
  const afterC = await sessionCookie(page);
  assert.notEqual(afterC.value, before.value);
  assert.notEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('csrfToken')).value), csrfBefore);
  assert.equal(dbq('SELECT sid FROM sessions WHERE token=?', sha256(afterC.value))[0].sid, sidBefore);
  assert.equal(await whoami(page), U.m.email);

  await sleep(STEP_UP_MS + 300); // the sign-in no longer counts as a recent check
  await page.fill('[data-testid=pw-current]', PW);
  await page.fill('[data-testid=pw-new]', 'Harbor-Lights-4417');
  await page.fill('[data-testid=pw-confirm]', 'Harbor-Lights-4417');
  await page.click('[data-testid=pw-submit]');
  await dialog(page).waitFor();
  assert.equal(await dialog(page).locator('[data-testid=step-up-switch]').count(), 1, 'two-factor users may use either');
  await page.fill('[data-testid=step-up-password]', 'Not-My-Password-1');
  await page.click('[data-testid=step-up-submit]');
  await page.waitForSelector('[data-testid=step-up-error]:has-text("not correct")');
  await page.fill('[data-testid=step-up-password]', PW);
  await page.click('[data-testid=step-up-submit]');
  await dialog(page).waitFor({ state: 'detached' });
  await page.waitForSelector('.toast:has-text("Password changed")');
  const mid = uid(U.m.email);
  assert.ok(dbq("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='step_up'", mid)[0].c >= 1);
  assert.ok(dbq("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='password_change'", mid)[0].c === 1);
  const probe = await newPage();
  assert.equal((await apiLogin(probe, U.m.email, PW)).status, 401, 'old password no longer works');
  const ok = await apiLogin(probe, U.m.email, 'Harbor-Lights-4417');
  assert.equal(ok.status, 200); assert.equal(ok.body.mfa_required, true);
  await probe.context().close();

  // Turning two-factor off: the code in the form is not enough on its own after the step-up window.
  await sleep(STEP_UP_MS + 300);
  await page.goto(BASE + '/account/security');
  // The step-up code is accepted first, then the retried request's code: the form's code must be for a newer step (RS3).
  const stepUpCode = await freshTotp(miaSecret); const disableCode = await freshTotp(miaSecret);
  await page.fill('[data-testid=mfa-input]', disableCode);
  await page.click('#mfa-form button[type=submit]');
  await dialog(page).waitFor();
  await page.click('[data-testid=step-up-switch]');
  await page.fill('[data-testid=step-up-code]', stepUpCode);
  await page.click('[data-testid=step-up-submit]');
  await page.waitForSelector('[data-testid=mfa-status]:has-text("Off")');
  assert.equal(dbq('SELECT COUNT(*) c FROM mfa WHERE user_id=?', mid)[0].c, 0);
  assert.deepEqual(dbq("SELECT type FROM auth_events WHERE user_id=? AND type IN ('mfa_on','mfa_off') ORDER BY ts", mid).map((e) => e.type), ['mfa_on', 'mfa_off']);
  // Cancelling the modal leaves the action undone.
  await sleep(STEP_UP_MS + 300);
  await page.fill('[data-testid=email-input]', `mia.new.${stamp}@example.test`);
  await page.click('#email-form button[type=submit]');
  await dialog(page).waitFor();
  await page.click('[data-testid=step-up-cancel]');
  await dialog(page).waitFor({ state: 'detached' });
  assert.equal(dbq('SELECT email FROM users WHERE id=?', mid)[0].email, U.m.email);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('withdrawal two-factor: when on, every withdrawal needs a fresh code (password is not accepted)', async () => {
  const page = await newPage();
  await signUp(page, U.w);
  const wid = uid(U.w.email);
  assert.equal((await call(page, 'POST', `/v1/users/${wid}/deposits`, { amount_dollars: 50 })).status, 201);
  wesSecret = await enableMfa(page);
  await sleep(STEP_UP_MS + 300);
  await page.check('[data-testid=withdrawal-mfa-toggle]');
  await dialog(page).waitFor();
  await page.fill('[data-testid=step-up-password]', PW);
  await page.click('[data-testid=step-up-submit]');
  await page.waitForSelector('.toast:has-text("Withdrawals now need a two-factor code")');
  assert.equal(dbq('SELECT withdrawal_mfa w FROM auth_user_security WHERE user_id=?', wid)[0].w, 1);

  const withdraw = () => page.evaluate(async (id) => {
    const { api } = await import('/js/api.js');
    try { return { ok: true, r: await api.withdraw(id, 5) }; } catch (e) { return { ok: false, code: e.code }; }
  }, wid);
  let p = withdraw();
  await dialog(page).waitFor();
  assert.equal(await dialog(page).locator('[data-testid=step-up-password]').count(), 0);
  assert.equal(await dialog(page).locator('[data-testid=step-up-switch]').count(), 0);
  await page.fill('[data-testid=step-up-code]', totp(wesSecret) === '000000' ? '111111' : '000000');
  await page.click('[data-testid=step-up-submit]');
  await page.waitForSelector('[data-testid=step-up-error]:has-text("not valid")');
  await page.fill('[data-testid=step-up-code]', await freshTotp(wesSecret));
  await page.click('[data-testid=step-up-submit]');
  assert.deepEqual(await within(p), { ok: true, r: { balance_dollars: '45.0000' } });
  // The next withdrawal asks again, even seconds later; cancelling withdraws nothing.
  p = withdraw();
  await dialog(page).waitFor();
  await page.click('[data-testid=step-up-cancel]');
  assert.deepEqual(await within(p), { ok: false, code: 'step_up_cancelled' });
  assert.equal(dbq('SELECT balance_cents b FROM users WHERE id=?', wid)[0].b, 4500);
  // API level: the error names the only accepted method.
  const raw = await call(page, 'POST', `/v1/users/${wid}/withdrawals`, { amount_dollars: 1 });
  assert.equal(raw.status, 403);
  assert.deepEqual([raw.body.error.code, raw.body.error.methods], ['step_up_required', ['totp']]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('TOTP secrets are encrypted at rest (AES-256-GCM, bound to the user)', async () => {
  const row = dbq('SELECT user_id, secret FROM mfa WHERE user_id=?', uid(U.w.email))[0];
  assert.match(row.secret, /^enc:v1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!row.secret.includes(wesSecret));
  assert.ok(!JSON.stringify(dbq('SELECT * FROM mfa')).includes(wesSecret));
  assert.ok(fs.existsSync(path.join(TMP, 'secret.key')), 'key file created next to the database');
  assert.equal((fs.statSync(path.join(TMP, 'secret.key')).mode & 0o077), 0, 'key file is private (0600)');
});

test('G4: the maker’s daily trading limit is enforced when confirming an accepted RFQ quote', async () => {
  const rp = await newPage(); const kp = await newPage();
  const rid = await apiSignup(rp, U.r); const kid = await apiSignup(kp, U.k);
  assert.equal((await call(rp, 'POST', `/v1/users/${rid}/deposits`, { amount_dollars: 100 })).status, 201);
  assert.equal((await call(kp, 'POST', `/v1/users/${kid}/deposits`, { amount_dollars: 100 })).status, 201);
  for (const [p, id] of [[rp, rid], [kp, kid]]) assert.equal((await call(p, 'PUT', `/v1/users/${id}/properties`, { properties: { rfq_enabled: true } })).status, 200);
  assert.equal((await call(kp, 'PUT', `/v1/users/${kid}/trading_limits`, { limit_dollars: 1 })).status, 200);
  const rfq = await call(rp, 'POST', '/v1/communications/rfqs', { market_ticker: 'PLXRATE-26DEC-CUT', contracts_fp: '5' });
  assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
  const rfqId = rfq.body.id;
  const q = await call(kp, 'POST', '/v1/communications/quotes', { rfq_id: rfqId, yes_bid: '0.50', no_bid: '0.40' });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  const qid = q.body.id;
  assert.equal((await call(rp, 'PUT', `/v1/communications/rfqs/${rfqId}/quotes/${qid}/accept`, { accepted_side: 'no' })).status, 200);
  const c = await call(kp, 'PUT', `/v1/communications/quotes/${qid}/confirm`, {});
  assert.equal(c.status, 409);
  assert.equal(c.body.error.code, 'trading_limit_exceeded');
  assert.equal(dbq('SELECT status FROM rfq_quotes WHERE id=?', qid)[0].status, 'accepted', 'nothing executed');
  assert.equal(dbq("SELECT COUNT(*) c FROM orders WHERE user_id=? AND source='rfq'", kid)[0].c, 0);
  await rp.context().close(); await kp.context().close();
});

test('privilege change revokes the target’s sessions; an admin role change itself needs step-up', async () => {
  const xp = await newPage();
  const xid = await apiSignup(xp, U.x);
  await xp.goto(BASE + '/portfolio');
  await xp.waitForSelector('[data-testid=account-menu]');
  const ap = await newPage();
  await logIn(ap, ADMIN.email, ADMIN.password);
  assert.equal((await sessionCookie(ap)).sameSite, 'Strict', 'admin sessions use SameSite=Strict');
  assert.equal(dbq('SELECT idle_ms FROM sessions WHERE token=?', sha256((await sessionCookie(ap)).value))[0].idle_ms, 30 * 60000);
  await sleep(STEP_UP_MS + 300);
  let r = await call(ap, 'PUT', `/v1/admin/roles/${xid}`, { roles: ['support'] });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'step_up_required');
  assert.equal((await call(ap, 'POST', '/v1/step_up', { password: ADMIN.password })).status, 200);
  r = await call(ap, 'PUT', `/v1/admin/roles/${xid}`, { roles: ['support'] });
  assert.equal(r.status, 200);
  await xp.waitForSelector('#account-area a:has-text("Log in")', { timeout: 10000 });
  assert.equal(dbq('SELECT COUNT(*) c FROM sessions WHERE user_id=?', xid)[0].c, 0);
  await logIn(xp, U.x.email);
  const row = dbq('SELECT privileged, idle_ms FROM sessions WHERE user_id=?', xid)[0];
  assert.deepEqual([row.privileged, row.idle_ms], [1, 30 * 60000]);
  await xp.context().close(); await ap.context().close();
});

test('admin: forced password reset (step-up modal) → user must choose a new one; audit chain verifies and detects tampering', async () => {
  const fp = await newPage();
  await signUp(fp, U.f);
  const ap = await newPage();
  await logIn(ap, ADMIN.email, ADMIN.password);
  await ap.goto(BASE + '/admin/identity');
  await ap.click('[data-testid=audit-verify]');
  await ap.waitForSelector('[data-testid=audit-verify-result][data-ok="1"]:has-text("Chain intact")');
  await ap.fill('form[data-f] input[name=type]', 'lockout');
  await ap.click('form[data-f] button[type=submit]');
  await ap.locator('[data-testid=identity-events] tr[data-type=lockout]').first().waitFor();

  await sleep(STEP_UP_MS + 300);
  await ap.fill('[data-testid=force-reset-form] input[name=email]', U.f.email);
  await ap.click('[data-testid=force-reset-form] button[type=submit]');
  await ap.fill('[data-testid=confirm-reason]', 'Password seen in a phishing kit');
  await ap.click('[data-testid=confirm-ok]');
  await dialog(ap).waitFor();
  await ap.fill('[data-testid=step-up-password]', ADMIN.password);
  await ap.click('[data-testid=step-up-submit]');
  await ap.waitForSelector('.toast:has-text("Password reset required")');
  await fp.waitForSelector('#account-area a:has-text("Log in")', { timeout: 10000 });
  const fid = uid(U.f.email);
  assert.equal(dbq('SELECT must_change_password m FROM auth_user_security WHERE user_id=?', fid)[0].m, 1);
  await fp.goto(BASE + '/sign-in');
  await fp.fill('input[name=email]', U.f.email);
  await fp.fill('input[name=password]', PW);
  await fp.click('button[type=submit]');
  await fp.waitForSelector('[data-testid=new-password]');
  assert.equal(await whoami(fp), null, 'no session before the new password is set');
  await fp.fill('[data-testid=new-password]', 'password1234');
  await fp.fill('[data-testid=confirm-password]', 'password1234');
  await fp.click('button[type=submit]');
  await fp.waitForSelector('#auth-error:has-text("breached")');
  await fp.fill('[data-testid=new-password]', 'Orchard-Road-5521');
  await fp.fill('[data-testid=confirm-password]', 'Orchard-Road-5521');
  await fp.click('button[type=submit]');
  await fp.waitForSelector('[data-testid=account-menu]');
  assert.equal(await whoami(fp), U.f.email);
  assert.equal(dbq('SELECT must_change_password m FROM auth_user_security WHERE user_id=?', fid)[0].m, 0);
  assert.equal(dbq("SELECT COUNT(*) c FROM admin_audit WHERE action='users.force_password_reset' AND target_id=?", fid)[0].c, 1);

  // Hash chain: intact → edit a row in the DB → detected at that row → restore → intact; deleting the newest row is detected too.
  await ap.click('[data-testid=audit-verify]');
  await ap.waitForSelector('[data-testid=audit-verify-result][data-ok="1"]');
  const first = dbq('SELECT * FROM admin_audit WHERE chain_seq=1')[0];
  assert.match(first.hash, /^[0-9a-f]{64}$/); assert.equal(first.prev_hash, '0'.repeat(64));
  const second = dbq('SELECT prev_hash FROM admin_audit WHERE chain_seq=2')[0];
  assert.equal(second.prev_hash, first.hash);
  dbrun('UPDATE admin_audit SET reason=? WHERE chain_seq=1', 'nothing to see here');
  await ap.click('[data-testid=audit-verify]');
  await ap.waitForSelector('[data-testid=audit-verify-result][data-ok="0"]:has-text("Tampering detected")');
  assert.match(await ap.textContent('[data-testid=audit-verify-result]'), /#1: row contents do not match its hash/);
  dbrun('UPDATE admin_audit SET reason=? WHERE chain_seq=1', first.reason);
  let v = await call(ap, 'GET', '/v1/admin/audit/verify');
  assert.equal(v.body.ok, true);
  const last = dbq('SELECT * FROM admin_audit ORDER BY chain_seq DESC LIMIT 1')[0];
  dbrun('DELETE FROM admin_audit WHERE id=?', last.id);
  v = await call(ap, 'GET', '/v1/admin/audit/verify');
  assert.equal(v.body.ok, false); assert.match(v.body.problem.reason, /deleted/);
  const cols = Object.keys(last);
  dbrun(`INSERT INTO admin_audit(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map((k) => last[k]));
  assert.equal((await call(ap, 'GET', '/v1/admin/audit/verify')).body.ok, true);
  // Non-admins cannot verify or read the sign-in log.
  assert.equal((await call(fp, 'GET', '/v1/admin/audit/verify')).status, 403);
  assert.equal((await call(fp, 'GET', '/v1/admin/identity/events')).status, 403);
  assert.deepEqual(ap.errors, []); assert.deepEqual(fp.errors, []);
  await fp.context().close(); await ap.context().close();
});

test('first admin: no default password; one-time setup URL (single use) or ADMIN_EMAIL/ADMIN_PASSWORD; legacy default removed', async () => {
  const file = path.join(TMP, 'boot.db');
  // A database seeded by an earlier build, with the old default admin password.
  let s2 = await start({ port: PORT2, dbFile: file, tickMs: 60000, quiet: true });
  assert.ok(s2.setupUrl, 'no admin → setup URL');
  await s2.close();
  const d = new DatabaseSync(file);
  d.prepare("INSERT INTO users(id,email,display_name,password_hash,is_admin,balance_cents,created_at) VALUES('u_legacy','admin@parlance.local','Exchange Admin',?,1,0,?)").run(util.hashPassword('parlance-admin'), new Date().toISOString());
  d.close();
  s2 = await start({ port: PORT2, dbFile: file, tickMs: 60000, quiet: true });
  try {
    const B2 = `http://127.0.0.1:${PORT2}`;
    assert.ok(s2.setupUrl, 'the legacy default does not count as a usable admin');
    const page = await newPage(B2);
    const tried = await apiLogin(page, 'admin@parlance.local', 'parlance-admin');
    assert.equal(tried.status, 401, 'parlance-admin is rejected');
    assert.match(new DatabaseSync(file).prepare("SELECT password_hash h FROM users WHERE email='admin@parlance.local'").get().h, /^!/);
    // Setup page from the printed URL.
    const url = B2 + s2.setupPath;
    await page.goto(url);
    await page.locator('[data-testid=setup-form]').waitFor();
    await page.fill('input[name=display_name]', 'Night Operator');
    await page.fill('input[name=email]', 'admin@parlance.local');
    await page.fill('input[name=password]', 'short');
    await page.click('button[type=submit]');
    await page.waitForSelector('#auth-error:has-text("at least 12")');
    await page.fill('input[name=password]', 'Lantern-Quay-8812');
    await page.click('button[type=submit]');
    await page.waitForURL(/\/admin\//);
    await page.locator('[data-testid=admin]').waitFor();
    const dbb = new DatabaseSync(file);
    try {
      assert.equal(dbb.prepare("SELECT is_admin FROM users WHERE email='admin@parlance.local'").get().is_admin, 1);
      assert.equal(dbb.prepare("SELECT COUNT(*) c FROM auth_events WHERE type='admin_bootstrap'").get().c, 1);
      assert.equal(dbb.prepare("SELECT COUNT(*) c FROM admin_audit WHERE action='admin.bootstrap'").get().c, 1);
      assert.equal(dbb.prepare("SELECT COUNT(*) c FROM auth_tokens WHERE purpose='admin_setup' AND used_at IS NULL").get().c, 0);
    } finally { dbb.close(); }
    // Single use.
    const again = await newPage(B2);
    await again.goto(url);
    await again.locator('[data-testid=setup-invalid]').waitFor();
    const reuse = await rawPost(again, '/v1/auth/setup_admin', { token: new URL(url).searchParams.get('token'), email: 'evil@example.test', display_name: 'Evil Admin', password: 'Another-Strong-991' }, await preToken(again));
    assert.equal(reuse.status, 410);
    await again.context().close(); await page.context().close();
  } finally { await s2.close(); }
  s2 = await start({ port: PORT2, dbFile: file, tickMs: 60000, quiet: true });
  assert.equal(s2.setupUrl, null, 'an admin exists: no setup link');
  await s2.close();

  // Environment bootstrap on a fresh database; a weak ADMIN_PASSWORD refuses to start.
  process.env.ADMIN_EMAIL = 'ops@example.test'; process.env.ADMIN_PASSWORD = 'password';
  try {
    await assert.rejects(start({ port: PORT2, dbFile: path.join(TMP, 'env-weak.db'), tickMs: 60000, quiet: true }), /ADMIN_PASSWORD does not meet the password policy/);
    process.env.ADMIN_PASSWORD = 'Granite-Ferry-3307';
    s2 = await start({ port: PORT2, dbFile: path.join(TMP, 'env.db'), tickMs: 60000, quiet: true });
  } finally { delete process.env.ADMIN_EMAIL; delete process.env.ADMIN_PASSWORD; }
  try {
    assert.equal(s2.setupUrl, null);
    const page = await newPage(`http://127.0.0.1:${PORT2}`);
    const r = await apiLogin(page, 'ops@example.test', 'Granite-Ferry-3307');
    assert.equal(r.status, 200); assert.deepEqual(r.body.user.admin_roles, ['admin']);
    assert.equal((await apiLogin(page, 'admin@parlance.local', 'parlance-admin')).status, 401);
    await page.context().close();
  } finally { await s2.close(); }
});

test('restart: hashed sessions, counters, events and encrypted TOTP persist; plaintext secrets migrate; idle timeout; per-IP lock', async () => {
  // Before: an admin session, two failures for one account, and a plaintext TOTP row written by an "old build".
  const ap = await newPage();
  await logIn(ap, ADMIN.email, ADMIN.password);
  const qp = await newPage();
  await apiSignup(qp, U.q);
  await call(qp, 'POST', '/v1/log_out', {});
  for (let i = 0; i < 2; i++) assert.equal((await apiLogin(qp, U.q.email, 'Not-The-Password-3')).status, 401);
  await srv.close();
  dbrun("DELETE FROM auth_throttle WHERE key LIKE 'ip:%'"); // isolate the account counter from earlier tests' per-IP failures
  const legacySecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  dbrun("INSERT INTO mfa(user_id,secret,enabled,created_at) VALUES(?,?,1,?)", uid(U.p.email), legacySecret, new Date().toISOString());
  const eventsBefore = dbq('SELECT COUNT(*) c FROM auth_events')[0].c;
  srv = await start({ ...OPTS, auth: { ...AUTH, idleMs: 2500, ipThreshold: 4 } });

  // Plaintext secret migrated to ciphertext; two-factor still works for it and for the user enrolled before restart.
  assert.match(dbq('SELECT secret FROM mfa WHERE user_id=?', uid(U.p.email))[0].secret, /^enc:v1:/);
  for (const [u, secret, pw] of [[U.p, legacySecret, PW], [U.w, wesSecret, PW]]) {
    const page = await newPage();
    await page.goto(BASE + '/sign-in');
    await page.fill('input[name=email]', u.email);
    await page.fill('input[name=password]', pw);
    await page.click('button[type=submit]');
    await page.fill('[data-testid=mfa-code]', await freshTotp(secret));
    await page.click('button[type=submit]');
    await page.waitForSelector('[data-testid=account-menu]');
    await page.context().close();
  }
  // The admin session survived (only its hash is stored) and the audit chain still verifies.
  assert.equal(await whoami(ap), ADMIN.email);
  assert.equal((await call(ap, 'GET', '/v1/admin/audit/verify')).body.ok, true);
  assert.ok(dbq('SELECT COUNT(*) c FROM auth_events')[0].c > eventsBefore);
  // Failure counters persisted: the third failure after restart locks the account.
  assert.equal((await apiLogin(qp, U.q.email, 'Not-The-Password-3')).status, 401);
  assert.equal((await apiLogin(qp, U.q.email, PW)).status, 429);
  assert.equal(dbq('SELECT failures FROM auth_throttle WHERE key=?', `acct:${sha256(U.q.email)}`)[0].failures, 3);
  dbrun('DELETE FROM auth_throttle');

  // Idle timeout (2.5 s here): an idle session is gone, and recorded as expired.
  const ip = await newPage();
  await apiSignup(ip, U.i);
  await ip.goto('about:blank'); // no page left to poll in the background; the context keeps its cookies
  const sessionOf = async () => (await (await ip.context().request.get(BASE + '/v1/session')).json()).user?.email ?? null;
  assert.equal(await sessionOf(), U.i.email);
  await sleep(3600);
  assert.equal(await sessionOf(), null);
  assert.equal(dbq('SELECT COUNT(*) c FROM sessions WHERE user_id=?', uid(U.i.email))[0].c, 0);
  assert.equal(dbq("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='session_expired'", uid(U.i.email))[0].c, 1);
  await ip.context().close();

  // Per-IP: failures across different emails from one address lock that address.
  const probe = await newPage();
  for (let i = 0; i < 4; i++) assert.equal((await apiLogin(probe, `spray${i}.${stamp}@example.test`, 'Spray-Password-1')).status, 401);
  const blocked = await apiLogin(probe, `fresh.${stamp}@example.test`, 'Spray-Password-1');
  assert.equal(blocked.status, 429);
  assert.equal(dbq("SELECT COUNT(*) c FROM auth_throttle WHERE key='ip:127.0.0.1' AND locked_until>?", Date.now())[0].c, 1);
  dbrun('DELETE FROM auth_throttle');
  await probe.context().close(); await qp.context().close(); await ap.context().close();
});
