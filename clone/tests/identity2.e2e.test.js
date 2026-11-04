'use strict';
// Identity E2E, part 2 (PLAN P3.1 email/reset, P3.3 OAuth, P3.4 passkeys, A2, P3.6 geolocation, P3.7 fraud holds, P3.8
// export + closure, residual RS2/RS3/RS9/RS10; CLONE_SPEC.md §25):
// email verification and password reset through the dev mailbox (signed single-use links), OAuth sign-in against the
// built-in mock OIDC provider (new account, account linking with password, state / PKCE / binding tampering refused),
// passkeys with Chromium's CDP virtual authenticator (register, sign in, counter regression, passkey step-up, admin
// passkey requirement), proof of work instead of an account lockout (RS2), TOTP replay (RS3), no account-existence
// signal from locked accounts (RS9) and idle sessions that background polls cannot keep alive (RS10); passkeys, sign-in
// methods and API keys locked (403 permission_denied) until identity verification is approved (A2); simulated location
// blocks with the region banner; withdrawal holds from the risk score; data export and account closure (crypto-shredding).
// The browser uses http://localhost (WebAuthn needs a domain, not an IP); API clients use 127.0.0.1.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');
const { totp } = require('../server/features.js');
const { Client, UA } = require('./lib/client');
const H = require('./lib/identity-helpers');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-identity2-'));
const DB_FILE = path.join(TMP, 'identity2.db');
const PW = 'Harbor-Quill-Lantern-8812';
const ADMIN = { email: 'root.identity2@example.test', password: 'Ledger-Keeper-2026!' };
const stamp = Date.now();
const HIGH = { burst: 1e6, per_second: 1e6 };
const STEP_UP_MS = 4000;
let PORT; let WEB; let API; let srv; let browser;
const D = H.db(DB_FILE);
const email = (k) => `${k}.${stamp}@example.test`;

before(async () => {
  PORT = await H.freePort();
  WEB = `http://localhost:${PORT}`;
  API = `http://127.0.0.1:${PORT}`;
  srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 500, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 },
    security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, auth: { accountThreshold: 3, ipThreshold: 1000, stepUpMs: STEP_UP_MS },
    identity: { kycRequired: false } });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const uidByEmail = (e) => D.q('SELECT id FROM users WHERE email=?', e)[0]?.id;
async function signedUp(k, name = 'Ida Tester') {
  const page = await H.newPage(browser, WEB);
  await H.signUpUi(page, WEB, { name, email: email(k) }, PW);
  await page.waitForSelector('[data-testid=account-menu]');
  return page;
}
async function logOutUi(page) {
  await page.click('[data-testid=account-menu]');
  await page.click('#logout-btn');
  await page.waitForSelector('a:has-text("Log in")');
}

test('email verification: link from the dev mailbox verifies once; tampered or reused links fail; changing the email asks again', async () => {
  const page = await signedUp('verify');
  const m = await H.mailTo(API, email('verify'), /Confirm your email/);
  const link = m.links.find((l) => l.includes('/verify-email?token='));
  assert.ok(link && link.startsWith(WEB), link);
  const uid = uidByEmail(email('verify'));
  assert.equal(D.q('SELECT email_verified_at FROM identity_profiles WHERE user_id=?', uid)[0].email_verified_at, null);
  // Only the token's hash is stored.
  const token = new URL(link).searchParams.get('token');
  assert.ok(!H.db(DB_FILE).q('SELECT hash FROM identity_tokens').some((r) => r.hash === token));
  // Tampered payload (signature no longer matches).
  const [payload, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), e: Date.now() + 9e9 })).toString('base64url');
  await page.goto(`${WEB}/verify-email?token=${forged}.${mac}`);
  await page.waitForSelector('[data-testid=verify-email-error]');
  await page.goto(link);
  await page.waitForSelector('[data-testid=verify-email-ok]');
  assert.ok(D.q('SELECT email_verified_at FROM identity_profiles WHERE user_id=?', uid)[0].email_verified_at);
  await page.goto(link);
  await page.waitForSelector('[data-testid=verify-email-error]:has-text("already used")');
  await page.goto(WEB + '/account/privacy');
  await page.waitForSelector('[data-testid=email-verified]:has-text("Verified")');
  // A new address must be verified again (email change needs a fresh step-up).
  assert.equal((await H.call(page, 'POST', '/v1/step_up', { password: PW })).status, 200);
  const r = await H.call(page, 'PUT', `/v1/users/${uid}/email`, { email: email('verify2') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(D.q('SELECT email_verified_at FROM identity_profiles WHERE user_id=?', uid)[0].email_verified_at, null);
  await H.mailTo(API, email('verify2'), /Confirm your email/);
  await H.assertClean(assert, page);
  await page.context().close();
});

test('password reset: uniform answer, emailed single-use link, policy, sessions revoked, old link and old password dead, tampering refused', async () => {
  const other = await signedUp('reset'); // a second, signed-in device that must be signed out by the reset
  const page = await H.newPage(browser, WEB, { path: '/sign-in' });
  await page.click('[data-testid=forgot-link]');
  await page.fill('[data-testid=forgot-email]', email('reset'));
  const t0 = Date.now() - 1000;
  await page.click('#forgot-form button[type=submit]');
  await page.waitForSelector('[data-testid=forgot-sent]');
  const uniform = await page.textContent('[data-testid=forgot-sent]');
  // Unknown email: identical answer, no email.
  const c = await new Client(API, 'anon').boot();
  const unknown = await c.call('POST', '/v1/passwords/reset', { email: `ghost.${stamp}@example.test` });
  assert.equal(unknown.status, 202); assert.equal(unknown.body.message, uniform);
  const known = await c.call('POST', '/v1/passwords/reset', { email: email('reset') });
  assert.deepEqual(Object.keys(known.body), Object.keys(unknown.body));
  assert.equal(D.q("SELECT COUNT(*) c FROM email_outbox WHERE to_email=?", `ghost.${stamp}@example.test`)[0].c, 0);
  const mails = await H.until(async () => { const r = await (await fetch(`${API}/v1/dev/mailbox?to=${encodeURIComponent(email('reset'))}`)).json(); const list = r.messages.filter((x) => /Reset your Parlance password/.test(x.subject) && Date.parse(x.time) >= t0); return list.length >= 2 && list; });
  const [newest, older] = mails;
  const link = newest.links.find((l) => l.includes('/reset-password?token='));
  const olderLink = older.links.find((l) => l.includes('/reset-password?token='));
  // Tampered token.
  const tok = new URL(link).searchParams.get('token');
  const bad = await c.call('PUT', `/v1/passwords/reset/${tok.slice(0, -2)}xx/confirm`, { password: 'Another-Strong-Pass-55' });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'token_invalid');
  // The page: weak password refused, then a good one.
  await page.goto(link);
  await page.waitForSelector('[data-testid=reset-form]');
  await page.fill('[data-testid=reset-password]', 'password123');
  await page.fill('[data-testid=reset-confirm]', 'password123');
  await page.click('#reset-form button[type=submit]');
  await page.waitForSelector('[data-testid=reset-error]:not(:empty)');
  const NEW = 'Brand-New-Harbor-Key-2047';
  await page.fill('[data-testid=reset-password]', NEW);
  await page.fill('[data-testid=reset-confirm]', NEW);
  await page.click('#reset-form button[type=submit]');
  await page.waitForSelector('.toast:has-text("Password changed")');
  // The other device is signed out; the old password fails; the new one works.
  assert.equal((await (await other.context().request.get(WEB + '/v1/session')).json()).user, null);
  const login = async (pw) => { const x = new Client(API, 'l'); await x.boot(); return x.call('POST', '/v1/log_in', { email: email('reset'), password: pw }); };
  assert.equal((await login(PW)).status, 401);
  assert.equal((await login(NEW)).status, 200);
  // Both links are dead now (single use; outstanding links die with the reset).
  for (const l of [link, olderLink]) {
    await page.goto(l);
    await page.waitForSelector('[data-testid=reset-invalid]');
  }
  assert.ok(D.q("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='password_reset'", uidByEmail(email('reset')))[0].c === 1);
  // Per-email request limit: the 4th request within the hour sends nothing (answer unchanged).
  const before = D.q('SELECT COUNT(*) c FROM email_outbox WHERE to_email=?', email('reset'))[0].c;
  for (let i = 0; i < 3; i++) assert.equal((await c.call('POST', '/v1/passwords/reset', { email: email('reset') })).status, 202);
  assert.equal(D.q('SELECT COUNT(*) c FROM email_outbox WHERE to_email=?', email('reset'))[0].c - before, 1, 'only one more email (3 per hour per address)');
  await H.assertClean(assert, page);
  await page.context().close(); await other.context().close();
});

// Drives the mock provider over HTTP: GET the authorize page, POST its form, return {code, state} from the redirect.
async function mockAuthorize(authorizationUrl, { email: em, name = 'Oauth Tester', verified = true }) {
  const u = new URL(authorizationUrl);
  const page = await fetch(`${API}${u.pathname}${u.search}`, { headers: { 'user-agent': UA } });
  const html = await page.text();
  const reqTok = /name="request" value="([^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
  const form = new URLSearchParams({ request: reqTok, email: em, name, action: 'approve', ...(verified ? { email_verified: '1' } : {}) });
  const r = await fetch(`${API}${u.pathname}`, { method: 'POST', body: form, redirect: 'manual', headers: { 'user-agent': UA } });
  const loc = new URL(r.headers.get('location'));
  return { code: loc.searchParams.get('code'), state: loc.searchParams.get('state'), redirect: loc };
}

test('OAuth (mock OIDC): new account through the UI, same identity signs back in, PKCE / state / nonce binding enforced', async () => {
  const page = await H.newPage(browser, WEB, { path: '/sign-in' });
  await page.click('[data-testid=oauth-google]');
  await page.waitForSelector('[data-testid=mock-oidc-form]');
  assert.match(page.url(), /\/mock-oidc\/google\/authorize\?/);
  const q = new URL(page.url()).searchParams;
  assert.equal(q.get('code_challenge_method'), 'S256'); assert.ok(q.get('state') && q.get('nonce') && q.get('code_challenge'));
  await page.fill('[data-testid=mock-oidc-email]', email('goog'));
  await page.fill('[data-testid=mock-oidc-name]', 'Gia Oauth');
  await page.click('[data-testid=mock-oidc-approve]');
  await page.waitForSelector('[data-testid=account-menu]');
  assert.match(page.url(), new RegExp(`^${WEB}/$`));
  const uid = uidByEmail(email('goog'));
  assert.ok(uid);
  assert.match(D.q('SELECT password_hash FROM users WHERE id=?', uid)[0].password_hash, /^!/, 'no usable password');
  const link = D.q('SELECT * FROM oauth_links WHERE user_id=?', uid)[0];
  assert.equal(link.provider, 'google'); assert.match(link.subject_hash, /^[0-9a-f]{64}$/);
  assert.ok(D.q('SELECT email_verified_at FROM identity_profiles WHERE user_id=?', uid)[0].email_verified_at, 'provider-verified email');
  // Sign out and back in with the same provider identity: same account.
  await logOutUi(page);
  // The first sign-in config request fails (a transient 503): the page retries and still offers the provider buttons.
  let failedOnce = false;
  await page.route('**/v1/identity/config', (route) => { if (failedOnce) return route.continue(); failedOnce = true; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"unavailable","message":"try again"}}' }); });
  await page.goto(WEB + '/sign-in');
  await page.waitForSelector('[data-testid=oauth-google]', { state: 'visible', timeout: 15000 }).catch(async (e) => {
    const alt = await page.evaluate(() => ({ alt: document.querySelector('[data-auth-alt]')?.outerHTML || '(no provider area)', url: location.href }));
    throw new Error(`${e.message}\nprovider area on ${alt.url}: ${alt.alt}\npage errors: ${JSON.stringify(page.errors || [])}`);
  });
  assert.equal(failedOnce, true, 'the first config request was failed on purpose');
  await page.unroute('**/v1/identity/config');
  await page.click('[data-testid=oauth-google]');
  await page.fill('[data-testid=mock-oidc-email]', email('goog'));
  await page.click('[data-testid=mock-oidc-approve]');
  await page.waitForSelector('[data-testid=account-menu]');
  assert.equal(await H.uidOf(page), uid);
  assert.equal(D.q('SELECT COUNT(*) c FROM users WHERE email=?', email('goog'))[0].c, 1);
  await H.assertClean(assert, page);
  await page.context().close();

  // ---- tampering, through the API like an attacker would
  const a = await new Client(API, 'oa').boot();
  const startFlow = async (cl) => (await cl.call('POST', '/v1/oauth/google/start', {})).body.authorization_url;
  // 1. Altered state.
  let f = await mockAuthorize(await startFlow(a), { email: email('tamper') });
  let r = await a.call('POST', '/v1/oauth/google/callback?four_digit_code=true', { code: f.code, state: `${f.state}x` });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'oauth_failed');
  // 2. Valid state presented from another browser (no matching login-CSRF cookie) → refused (binding).
  const b = await new Client(API, 'ob').boot();
  f = await mockAuthorize(await startFlow(a), { email: email('tamper') });
  r = await b.call('POST', '/v1/oauth/google/callback', { code: f.code, state: f.state });
  assert.equal(r.body.error.code, 'oauth_failed');
  // 3. Code injection: a code issued for flow B (its own PKCE challenge) with flow A's state → PKCE verification fails.
  const urlA = await startFlow(a); const urlB = await startFlow(a);
  const fa = await mockAuthorize(urlA, { email: email('tamper') });
  const fb = await mockAuthorize(urlB, { email: email('tamper') });
  r = await a.call('POST', '/v1/oauth/google/callback', { code: fb.code, state: fa.state });
  assert.equal(r.body.error.code, 'oauth_failed');
  assert.ok(D.q("SELECT detail FROM auth_events WHERE type='oauth_fail'").some((e) => /exchange/.test(e.detail)), 'logged as a failed exchange');
  // 4. The state of a flow is single use.
  r = await a.call('POST', '/v1/oauth/google/callback', { code: fa.code, state: fa.state });
  assert.equal(r.body.error.code, 'oauth_failed', 'state A was consumed by the failed attempt');
  // 5. The token endpoint itself enforces PKCE (wrong verifier → invalid_grant, and the code is burned).
  const fc = await mockAuthorize(await startFlow(a), { email: email('tamper') });
  const cid = new URL(urlA).searchParams.get('client_id');
  const tokenRes = await fetch(`${API}/mock-oidc/google/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: fc.code, redirect_uri: fc.redirect.origin + fc.redirect.pathname, client_id: cid, code_verifier: 'x'.repeat(50) }) });
  assert.equal(tokenRes.status, 400); assert.equal((await tokenRes.json()).error, 'invalid_grant');
  // 6. A clean flow from the right browser works (the API path signs in).
  const ok = await mockAuthorize(await startFlow(a), { email: email('tamper') });
  r = await a.call('POST', '/v1/oauth/google/callback', { code: ok.code, state: ok.state });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.user.email, email('tamper'));
});

test('OAuth account linking: a verified matching email needs the account password; an unverified one is refused', async () => {
  const owner = new Client(API, 'owner');
  await owner.signUp(email('linkme'), PW, 'Lin Owner');
  const page = await H.newPage(browser, WEB, { path: '/sign-in' });
  await page.click('[data-testid=oauth-google]');
  await page.fill('[data-testid=mock-oidc-email]', email('linkme'));
  await page.click('[data-testid=mock-oidc-approve]');
  await page.waitForSelector('[data-testid=oauth-link-form]');
  assert.match(await page.textContent('[data-testid=oauth-link-form]'), /l\*\*\*@example\.test/);
  assert.equal(D.q('SELECT COUNT(*) c FROM oauth_links WHERE user_id=?', owner.uid)[0].c, 0, 'not linked before the password');
  await page.fill('[data-testid=oauth-link-password]', 'Wrong-Password-1234');
  await page.click('#oa-link button[type=submit]');
  await page.waitForSelector('[data-testid=oauth-link-error]:has-text("not correct")');
  await page.fill('[data-testid=oauth-link-password]', PW);
  await page.click('#oa-link button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
  assert.equal(await H.uidOf(page), owner.uid);
  assert.equal(D.q("SELECT COUNT(*) c FROM oauth_links WHERE user_id=? AND provider='google'", owner.uid)[0].c, 1);
  assert.ok(D.q("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='oauth_linked'", owner.uid)[0].c === 1);
  await H.assertClean(assert, page);
  await page.context().close();
  // Unverified email at the provider + an existing account: refused, nothing linked or created.
  const other = new Client(API, 'other');
  await other.signUp(email('nolink'), PW, 'Nol Owner');
  const p2 = await H.newPage(browser, WEB, { path: '/sign-in' });
  await p2.click('[data-testid=oauth-apple]');
  await p2.fill('[data-testid=mock-oidc-email]', email('nolink'));
  await p2.uncheck('[data-testid=mock-oidc-verified]');
  await p2.click('[data-testid=mock-oidc-approve]');
  await p2.waitForSelector('[data-testid=oauth-error]:has-text("already exists")');
  assert.equal(D.q('SELECT COUNT(*) c FROM oauth_links WHERE user_id=?', other.uid)[0].c, 0);
  assert.equal((await (await p2.context().request.get(WEB + '/v1/session')).json()).user, null);
  await p2.context().close();
});

async function virtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { cdp, authenticatorId };
}

const PERMISSION_DENIED = { code: 'permission_denied', message: 'You do not have permission to perform this action', details: 'Please make sure you are logged in with the correct account. Contact support if you believe this is an error.', support_action: 'support_chat' };

test('A2 + passkeys: locked (403 permission_denied) until verified; then register with step-up, sign in without a password, counter regression refused, passkey step-up', async () => {
  const page = await signedUp('passkey', 'Pax Keyholder');
  const va = await virtualAuthenticator(page);
  const uid = await H.uidOf(page);
  // A2: passkeys, sign-in methods and API keys answer the observed 403 envelope until identity verification is approved.
  for (const p of ['passkeys', 'sign_in_methods', 'api_keys']) {
    const r = await H.call(page, 'GET', `/v1/users/${uid}/${p}`);
    assert.equal(r.status, 403, p); assert.deepEqual(r.body, { error: PERMISSION_DENIED }, p);
  }
  const reg = await H.call(page, 'POST', `/v1/users/${uid}/passkeys/registration/options`, {});
  assert.equal(reg.status, 403); assert.equal(reg.body.error.code, 'permission_denied');
  await page.goto(WEB + '/account/privacy');
  await page.waitForSelector('[data-testid=passkeys-panel] [data-testid=a2-locked]');
  assert.equal(await page.locator('[data-testid=signin-methods] [data-testid=a2-locked]').count(), 1);
  // Verify the identity (sandbox, API), then the settings unlock.
  const api = await new Client(API, 'pk-owner').logIn(email('passkey'), PW);
  assert.equal((await H.apiOnboard(API, api, H.person({ first: 'Pax', last: 'Keyholder' }))).status, 'approved');
  assert.equal((await H.call(page, 'GET', `/v1/users/${uid}/api_keys`)).status, 200);
  await page.reload();
  await H.sleep(STEP_UP_MS + 300); // the sign-in check is no longer recent: adding a passkey asks to confirm it's you
  await page.click('[data-testid=passkey-add]');
  await page.locator('[data-testid=step-up-dialog]').waitFor();
  await page.fill('[data-testid=step-up-password]', PW);
  await page.click('[data-testid=step-up-submit]');
  await page.waitForSelector('[data-testid=passkey-row]');
  const pk = D.q('SELECT * FROM passkeys WHERE user_id=?', uid)[0];
  assert.equal(pk.alg, -7); assert.ok(pk.public_key.length > 50);
  assert.equal((await va.cdp.send('WebAuthn.getCredentials', { authenticatorId: va.authenticatorId })).credentials.length, 1);
  // Sign out; sign in with the passkey (no password, no TOTP prompt).
  await logOutUi(page);
  await page.goto(WEB + '/sign-in');
  await page.click('[data-testid=passkey-login]');
  await page.waitForSelector('[data-testid=account-menu]');
  assert.equal(await H.uidOf(page), uid);
  const after1 = D.q('SELECT sign_count, last_used_at FROM passkeys WHERE id=?', pk.id)[0];
  assert.ok(after1.last_used_at);
  assert.ok(D.q("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='login_ok' AND detail LIKE '%passkey%'", uid)[0].c >= 1);
  // Step-up with the passkey (the window is 4 s here): data export opens the modal; "Use a passkey" confirms.
  await H.sleep(STEP_UP_MS + 300);
  const exp = page.evaluate(async (id) => { const { idApi } = await import('/js/identity-api.js'); const r = await idApi.dataExport(id); return r.account.user_id; }, uid);
  await page.locator('[data-testid=step-up-dialog]').waitFor();
  await page.click('[data-testid=step-up-passkey]');
  assert.equal(await Promise.race([exp, H.sleep(20000).then(() => 'timed out waiting for the passkey step-up')]), uid);
  assert.ok(D.q("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='step_up' AND detail LIKE '%passkey%'", uid)[0].c >= 1);
  // Counter regression: the stored counter is ahead of the authenticator → refused as a possible clone.
  await logOutUi(page);
  D.run('UPDATE passkeys SET sign_count=100000 WHERE id=?', pk.id);
  await page.goto(WEB + '/sign-in');
  await page.click('[data-testid=passkey-login]');
  await page.waitForSelector('#auth-error:has-text("could not be verified")');
  assert.equal(D.q("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='passkey_counter_regression'", uid)[0].c, 1);
  assert.equal((await (await page.context().request.get(WEB + '/v1/session')).json()).user, null);
  // Forged assertion data never signs in (signature check): reuse a challenge with a garbage signature.
  const c = await new Client(API, 'pk').boot();
  const opts = (await c.call('POST', '/v1/passkeys/authentication/options', {})).body.publicKey;
  const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin: API })).toString('base64url');
  const ad = Buffer.concat([crypto.createHash('sha256').update('127.0.0.1').digest(), Buffer.from([0x05]), Buffer.from([0, 0, 0, 0x7f])]); // right rpIdHash, UP+UV, counter
  const forged = await c.call('POST', '/v1/passkeys/authentication', { credential: { id: pk.credential_id, rawId: pk.credential_id, type: 'public-key', response: { clientDataJSON: cd, authenticatorData: ad.toString('base64url'), signature: Buffer.alloc(70, 1).toString('base64url'), userHandle: null } } });
  assert.equal(forged.status, 400); assert.equal(forged.body.error.code, 'passkey_invalid');
  assert.ok(D.q("SELECT detail FROM auth_events WHERE type='passkey_fail' ORDER BY ts DESC LIMIT 1")[0].detail.includes('signature'), 'refused by the signature check');
  await H.assertClean(assert, page);
  await page.context().close();
});

test('admin passkey requirement: staff with a password session are stopped at the admin API until they confirm with a passkey', async () => {
  const page = await H.newPage(browser, WEB, { path: '/sign-in' });
  await H.logInUi(page, WEB, ADMIN.email, ADMIN.password);
  await page.waitForSelector('[data-testid=account-menu]');
  await virtualAuthenticator(page);
  await page.goto(WEB + '/account/privacy');
  await page.click('[data-testid=passkey-add]'); // staff are exempt from the A2 lock; the fresh sign-in counts as step-up
  await page.waitForSelector('[data-testid=passkey-row]');
  // A support-role user with a password session.
  const sup = new Client(API, 'support');
  await sup.signUp(email('support'), PW, 'Sue Support');
  D.run("INSERT INTO admin_roles(user_id,role,granted_by,granted_at) VALUES(?, 'support', NULL, ?)", sup.uid, new Date().toISOString());
  await sup.logIn(email('support'), PW);
  assert.equal((await sup.call('GET', '/v1/admin/me')).status, 200);
  // Turn the rule on (Admin › Compliance settings form).
  await page.goto(WEB + '/admin/compliance');
  await page.check('[data-testid=cs-admin-passkey]');
  await page.click('[data-testid=cs-save]');
  await page.waitForSelector('.toast:has-text("Compliance settings saved")');
  const denied = await sup.call('GET', '/v1/admin/me');
  assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'passkey_required'); assert.equal(denied.body.error.has_passkey, false);
  // The admin's own password session is stopped too, until the passkey confirms it.
  await page.goto(WEB + '/admin/kyc');
  await page.waitForSelector('[data-testid=admin-passkey-required]');
  await page.click('[data-testid=admin-passkey-confirm]');
  await page.waitForSelector('[data-testid=admin]');
  assert.equal((await H.call(page, 'GET', '/v1/admin/me')).status, 200);
  // Off again.
  assert.equal((await H.call(page, 'PUT', '/v1/admin/compliance/settings', { admin_passkey_required: false, reason: 'test done' })).status, 200);
  assert.equal((await sup.call('GET', '/v1/admin/me')).status, 200);
  await H.assertClean(assert, page);
  await page.context().close();
});

const solve = (ch) => { for (let n = 0; ; n++) { const h = crypto.createHash('sha256').update(`${ch.id}:${n}`).digest(); let z = 0; for (const b of h) { if (b === 0) { z += 8; continue; } z += Math.clz32(b) - 24; break; } if (z >= ch.bits) return { token: ch.token, nonce: String(n) }; } };

test('RS2: repeated failures ask for a proof of work instead of locking the account; the browser solves it; unknown emails look the same', async () => {
  const victim = new Client(API, 'victim');
  await victim.signUp(email('pow'), PW, 'Pow Victim');
  const att = await new Client(API, 'attacker').boot();
  const tryLogin = (pw, extra = {}) => att.call('POST', '/v1/log_in', { email: email('pow'), password: pw, ...extra });
  for (let i = 0; i < 3; i++) assert.equal((await tryLogin('Wrong-Guess-0000')).status, 401);
  // Without a proof: 429 too_many_attempts + challenge (no Retry wait). With a solved proof, a guess is evaluated again.
  const need = await tryLogin('Wrong-Guess-0001');
  assert.equal(need.status, 429); assert.equal(need.body.error.code, 'too_many_attempts'); assert.equal(need.body.error.retry_after_sec, 0);
  const ch = need.body.error.pow;
  assert.equal(ch.bits, 12);
  const sol = solve(ch);
  assert.equal((await tryLogin('Wrong-Guess-0002', { pow: sol })).status, 401, 'a solved proof lets the attempt through');
  assert.equal((await tryLogin('Wrong-Guess-0003', { pow: sol })).status, 429, 'a proof is single use');
  const harder = (await tryLogin('x')).body.error.pow;
  assert.equal(harder.bits, 13, 'one more bit per further failure');
  // Unknown email: identical shape.
  const ghost = await new Client(API, 'ghost').boot();
  for (let i = 0; i < 3; i++) await ghost.call('POST', '/v1/log_in', { email: `ghost.${stamp}@example.test`, password: 'Wrong-Guess-0000' });
  const g = await ghost.call('POST', '/v1/log_in', { email: `ghost.${stamp}@example.test`, password: 'Wrong-Guess-0000' });
  assert.equal(g.status, 429); assert.deepEqual(Object.keys(g.body.error), Object.keys(need.body.error)); assert.deepEqual(Object.keys(g.body.error.pow), Object.keys(ch));
  // The owner is never locked out: the login form solves the check and signs in.
  const page = await H.newPage(browser, WEB, { path: '/sign-in' });
  await page.fill('input[name=email]', email('pow'));
  await page.fill('input[name=password]', PW);
  await page.click('#auth-form button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
  assert.equal(await H.uidOf(page), victim.uid);
  assert.ok(D.q("SELECT detail FROM auth_events WHERE user_id=? AND type='lockout'", victim.uid).some((e) => /proof_of_work/.test(e.detail)));
  assert.equal(D.q("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND title='Repeated failed sign-ins'", victim.uid)[0].c, 1);
  // The browser's solve was a real proof (single-use row recorded); per-IP limits stay a hard backoff.
  assert.ok(D.q('SELECT COUNT(*) c FROM login_pow_used')[0].c >= 2);
  await H.assertClean(assert, page);
  await page.context().close();
});

test('RS3: a TOTP code is accepted once — never again for login, step-up or disabling', async () => {
  const c = new Client(API, 'totp');
  await c.signUp(email('totp'), PW, 'Tot Replay');
  const setup = await c.call('POST', `/v1/users/${c.uid}/mfa/setup`, {});
  const secret = setup.body.secret;
  const now = totp(secret);
  assert.equal((await c.call('POST', `/v1/users/${c.uid}/mfa/enable`, { code: now })).status, 200);
  const step = Math.floor(Date.now() / 30000);
  assert.ok(D.q('SELECT last_step FROM mfa WHERE user_id=?', c.uid)[0].last_step >= step - 1);
  // Log in: password, then the same code again → refused (replay); the next step's code → accepted.
  const l = new Client(API, 'totp2');
  await l.boot();
  const first = await l.call('POST', '/v1/log_in', { email: email('totp'), password: PW });
  assert.equal(first.body.mfa_required, true);
  const replay = await l.call('POST', '/v1/log_in_mfa', { mfa_token: first.body.mfa_token, code: now });
  assert.equal(replay.status, 400); assert.equal(replay.body.error.code, 'invalid_mfa_code');
  const nextCode = totp(secret, Date.now() + 30000);
  const ok = await l.call('POST', '/v1/log_in_mfa', { mfa_token: first.body.mfa_token, code: nextCode });
  assert.equal(ok.status, 200, ok.text);
  // The same next-step code cannot confirm a step-up either.
  const su = await l.call('POST', '/v1/step_up', { code: nextCode });
  assert.equal(su.status, 400); assert.equal(su.body.error.code, 'invalid_mfa_code');
});

test('RS9: a locked account answers a wrong password exactly like any other account; only the right password reveals the lock', async () => {
  const locked = new Client(API, 'locked');
  await locked.signUp(email('locked'), PW, 'Loc Ked');
  const normal = new Client(API, 'normal');
  await normal.signUp(email('normal'), PW, 'Nor Mal');
  const admin = new Client(API, 'adm');
  await admin.logIn(ADMIN.email, ADMIN.password);
  assert.equal((await admin.call('POST', `/v1/admin/users/${locked.uid}/lock`, { reason: 'RS9 test lock' })).status, 200);
  const probe = await new Client(API, 'probe').boot();
  const attempt = (e, pw) => probe.call('POST', '/v1/log_in', { email: e, password: pw });
  const a = await attempt(email('locked'), 'Wrong-Guess-1234');
  const b = await attempt(email('normal'), 'Wrong-Guess-1234');
  const g = await attempt(`ghost9.${stamp}@example.test`, 'Wrong-Guess-1234');
  assert.equal(a.status, 401); assert.equal(a.text, b.text); assert.equal(a.text, g.text);
  const right = await attempt(email('locked'), PW);
  assert.equal(right.status, 403); assert.equal(right.body.error.code, 'account_locked');
});

test('RS10: background requests do not keep an idle session alive; user interaction does', async () => {
  const P2 = await H.freePort();
  const file = path.join(TMP, 'idle.db');
  const s2 = await start({ port: P2, dbFile: file, tickMs: 60000, quiet: true, security: { challengeMode: 'off', authRate: HIGH }, auth: { idleMs: 3000 } });
  try {
    const W2 = `http://localhost:${P2}`;
    const poll = (page) => page.evaluate(async () => { const { api } = await import('/js/api.js'); const { session } = await import('/js/store.js'); try { await api.balance(session.uid); return true; } catch { return false; } });
    const mk = async (k) => { const p = await H.newPage(browser, W2); await H.signUpUi(p, W2, { name: 'Idle Tester', email: email(k) }, PW); await p.waitForSelector('[data-testid=account-menu]'); return p; };
    const idle = await mk('idle-a');
    const busy = await mk('idle-b');
    for (let i = 0; i < 9; i++) {
      await busy.keyboard.press('Shift'); // a real user interaction just before each request
      await Promise.all([poll(idle), poll(busy)]);
      await H.sleep(500);
    }
    const who = async (p) => (await (await p.context().request.get(W2 + '/v1/session')).json()).user;
    assert.equal(await who(idle), null, 'polling alone let the session idle out');
    assert.ok(await who(busy), 'the interacting user is still signed in');
    const ev = H.db(file).q("SELECT detail FROM auth_events WHERE type='session_expired'");
    assert.ok(ev.some((e) => /idle/.test(e.detail)));
    await idle.context().close(); await busy.context().close();
  } finally { await s2.close(); }
});

test('P3.6 location: simulated IP country and browser geolocation block money and orders (403 geo_restricted), with the region banner and dialog', async () => {
  const page = await signedUp('geo', 'Geo Tester');
  const uid = await H.uidOf(page);
  const admin = await new Client(API, 'geo-admin').logIn(ADMIN.email, ADMIN.password);
  // Loopback is "unknown" (ZZ) and allowed by default; an admin maps it to a blocked country in the simulated IP table.
  assert.equal((await H.call(page, 'GET', `/v1/users/${uid}/geolocation`)).body.allowed, true);
  let r = await admin.call('PUT', '/v1/admin/compliance/settings', { ip_overrides: [{ cidr: '127.0.0.1/32', country: 'CU' }], reason: 'geo test' });
  assert.equal(r.status, 200, r.text);
  r = await H.call(page, 'POST', `/v1/users/${uid}/deposits`, { amount_dollars: 10 });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'geo_restricted'); assert.equal(r.body.error.country, 'CU');
  const mk = D.q("SELECT ticker FROM markets WHERE status='active' AND mve_collection_ticker IS NULL LIMIT 1")[0].ticker;
  r = await H.call(page, 'POST', `/v1/users/${uid}/orders`, { ticker: mk, side: 'yes', type: 'limit', price: 5, count: 1 });
  assert.equal(r.body.error.code, 'geo_restricted', 're-checked on orders');
  await page.reload();
  await page.waitForSelector('[data-testid=region-banner]:has-text("Cuba")');
  await page.goto(WEB + '/portfolio');
  await page.waitForSelector('#f-amount');
  await page.fill('#f-amount', '1000');
  await page.click('[data-act=deposit]');
  await page.waitForSelector('[data-testid=compliance-dialog][data-code=geo_restricted]');
  assert.match(await page.textContent('[data-testid=geo-message]'), /Cuba/);
  await page.click('[data-testid=compliance-close]');
  // Back to allowed; then the browser reports coordinates inside a blocked country (only the derived country is kept).
  r = await admin.call('PUT', '/v1/admin/compliance/settings', { ip_overrides: [], reason: 'geo test done' });
  assert.equal(r.status, 200);
  const geoCtx = await browser.newContext({ geolocation: { latitude: 22.1, longitude: -79.9 }, permissions: ['geolocation'] });
  const gp = await geoCtx.newPage();
  gp.errors = []; gp.on('pageerror', (e) => gp.errors.push(e.message));
  await H.logInUi(gp, WEB, email('geo'), PW);
  await gp.waitForSelector('[data-testid=account-menu]');
  await gp.goto(WEB + '/account/privacy');
  await gp.click('[data-testid=share-location]');
  await gp.waitForSelector('[data-testid=geo-blocked]');
  const fix = D.q('SELECT * FROM geo_checks WHERE user_id=? ORDER BY created_ts DESC LIMIT 1', uid)[0];
  assert.equal(fix.country, 'CU'); assert.ok(!JSON.stringify(fix).includes('22.1') && !JSON.stringify(fix).includes('79.9'), 'coordinates are not stored');
  r = await H.call(gp, 'POST', `/v1/users/${uid}/withdrawals`, { amount_dollars: 1 });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'geo_restricted'); assert.equal(r.body.error.source, 'browser');
  assert.ok(D.q("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='geo_blocked'", uid)[0].c >= 3);
  assert.deepEqual(gp.errors, []);
  await geoCtx.close(); await page.context().close();
});

test('P3.7 fraud: device ID + velocity risk score holds a withdrawal for review; admin releases or reverses it (audited)', async () => {
  const c = await new Client(API, 'fraud').signUp(email('fraud'), PW, 'Fra Udster');
  const admin = await new Client(API, 'fraud-admin').logIn(ADMIN.email, ADMIN.password);
  let r = await admin.call('PUT', '/v1/admin/compliance/settings', { fraud: { hold_threshold: 25, hold_withdrawals: true }, reason: 'fraud test' });
  assert.equal(r.status, 200, r.text);
  const dev = { 'x-device-id': 'test-device-AAAAAAAAAAAAAAAAAAAA' };
  assert.equal((await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: 200 }, dev)).status, 201);
  // New account + new device + withdrawing most of a fresh deposit without trading → held (202), money leaves the balance.
  await c.call('POST', '/v1/step_up', { password: PW });
  r = await c.call('POST', `/v1/users/${c.uid}/withdrawals`, { amount_dollars: 190 }, dev);
  assert.equal(r.status, 202, r.text); assert.equal(r.body.status, 'held');
  const hold = r.body.hold_id;
  assert.equal(r.body.balance_dollars, '10.0000');
  const ra = D.q('SELECT * FROM risk_assessments WHERE user_id=? ORDER BY ts DESC LIMIT 1', c.uid)[0];
  assert.equal(ra.action, 'hold'); assert.ok(ra.score >= 25);
  assert.ok(JSON.parse(ra.signals).some((x) => x.code === 'deposit_and_withdraw'));
  assert.ok(!JSON.stringify(D.q('SELECT * FROM device_sightings')).includes('test-device-AAAA'), 'device IDs stored only as HMACs');
  // Admin › Fraud & holds lists it; reverse needs a reason and refunds the balance; audit row written.
  const page = await H.newPage(browser, WEB);
  await H.logInUi(page, WEB, ADMIN.email, ADMIN.password);
  await page.waitForSelector('[data-testid=account-menu]');
  await page.goto(WEB + '/admin/fraud');
  await page.waitForSelector(`[data-testid=fraud-holds] tr[data-hold="${hold}"][data-status=held]`);
  await page.click(`[data-testid=fraud-holds] tr[data-hold="${hold}"] [data-testid=hold-reverse]`);
  await page.fill('[data-testid=confirm-reason]', 'Customer confirmed this was not them');
  await page.click('[data-testid=confirm-ok]');
  await page.waitForSelector(`[data-testid=fraud-holds] tr[data-hold="${hold}"][data-status=reversed]`);
  assert.equal(D.q('SELECT balance_cents FROM users WHERE id=?', c.uid)[0].balance_cents, 20000);
  assert.equal(D.q("SELECT COUNT(*) c FROM admin_audit WHERE action='fraud.hold_reverse' AND target_id=?", c.uid)[0].c, 1);
  await admin.call('PUT', '/v1/admin/compliance/settings', { fraud: { hold_threshold: 60, hold_withdrawals: null }, reason: 'fraud test done' });
  await H.assertClean(assert, page);
  await page.context().close();
});

test('P3.8 data export (owner, step-up) and account closure (step-up, open positions handled, PII crypto-shredded, PII-free audit kept)', async () => {
  const page = await signedUp('closer', 'Clo Sure');
  const uid = await H.uidOf(page);
  const api = await new Client(API, 'closer').logIn(email('closer'), PW);
  const who = H.person({ first: 'Closia', last: 'Shredwell' });
  assert.equal((await H.apiOnboard(API, api, who)).status, 'approved');
  assert.equal((await api.call('POST', `/v1/users/${uid}/deposits`, { amount_dollars: 50 })).status, 201);
  // Another user cannot export this account (IDOR) and an export needs a fresh step-up.
  const other = await new Client(API, 'other-x').signUp(email('otherx'), PW, 'Oth Er');
  assert.equal((await other.call('POST', `/v1/users/${uid}/data_export`, {})).status, 403);
  await H.sleep(STEP_UP_MS + 300);
  const dl = page.waitForEvent('download');
  await page.goto(WEB + '/account/privacy');
  await page.click('[data-testid=data-export]');
  await page.locator('[data-testid=step-up-dialog]').waitFor();
  await page.fill('[data-testid=step-up-password]', PW);
  await page.click('[data-testid=step-up-submit]');
  const file = await (await dl).path();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.account.user_id, uid);
  assert.equal(data.identity.legal_name.first, 'Closia', 'the owner gets their own details');
  assert.match(data.identity.national_id.masked, /\d{4}$/); assert.ok(!JSON.stringify(data).includes(who.ssn.replace(/-/g, '')), 'national ID never in full');
  assert.ok(Array.isArray(data.ledger) && data.account_area && data.account_area.preferences);
  // Closure is refused while a position is open; it cancels resting orders and pays out cash.
  const mk = D.q("SELECT ticker FROM markets WHERE status='active' AND mve_collection_ticker IS NULL AND fractional_trading_enabled=0 LIMIT 1")[0].ticker;
  assert.equal((await api.call('POST', `/v1/users/${uid}/orders`, { ticker: mk, side: 'yes', type: 'market', count: 1 })).status, 201);
  assert.equal((await api.call('POST', `/v1/users/${uid}/orders`, { ticker: mk, side: 'no', type: 'limit', price: 1, count: 1 })).status, 201);
  await page.click('[data-testid=close-account]');
  await page.fill('[data-testid=close-confirm]', 'CLOSE');
  await page.click('[data-testid=close-submit]');
  await page.waitForSelector('[data-testid=close-error]:has-text("open position")');
  const pos = D.q('SELECT yes_count FROM positions WHERE user_id=? AND market_ticker=?', uid, mk)[0];
  if (pos && pos.yes_count) assert.equal((await api.call('POST', `/v1/users/${uid}/orders`, { ticker: mk, side: 'yes', action: 'sell', type: 'market', count: pos.yes_count / 100 })).status, 201);
  await H.until(() => !D.q('SELECT 1 FROM positions WHERE user_id=? AND (yes_count>0 OR no_count>0)', uid).length);
  await page.click('[data-testid=close-submit]');
  await page.waitForURL(WEB + '/');
  // Crypto-shredding: the data key is gone, the ciphertexts cleared; login no longer works; the audit keeps no PII.
  assert.equal(D.q('SELECT COUNT(*) c FROM identity_keys WHERE user_id=?', uid)[0].c, 0);
  const prof = D.q('SELECT * FROM identity_profiles WHERE user_id=?', uid)[0];
  assert.equal(prof.status, 'closed'); assert.equal(prof.name_enc, null); assert.equal(prof.national_id_enc, null); assert.equal(prof.address_enc, null);
  assert.ok(prof.national_id_hash, 'the keyed hash stays for duplicate detection (retention)');
  assert.equal(D.q("SELECT COUNT(*) c FROM orders WHERE user_id=? AND status='resting'", uid)[0].c, 0);
  assert.equal(D.q('SELECT balance_cents FROM users WHERE id=?', uid)[0].balance_cents, 0);
  const audit = D.q("SELECT * FROM admin_audit WHERE action='privacy.account_closed' AND target_id=?", uid)[0];
  assert.ok(audit); assert.ok(!JSON.stringify(audit).includes('Closia') && !JSON.stringify(audit).includes(email('closer')));
  assert.equal((await new Client(API, 'x').boot().then((x) => x.call('POST', '/v1/log_in', { email: email('closer'), password: PW }))).status, 401);
  assert.equal((await (await page.context().request.get(WEB + '/v1/session')).json()).user, null);
  await page.context().close();
});

test('sign-out: a failed log-out request is retried, and the tab only shows "signed out" once the server has ended the session', async () => {
  // One transient failure: the retry ends the session; a reload stays signed out.
  const page = await signedUp('logout1', 'Lou Gout');
  let fails = 1;
  await page.route('**/v1/log_out', (route) => (fails-- > 0 ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"unavailable","message":"try again"}}' }) : route.continue()));
  await logOutUi(page);
  await page.reload();
  await page.waitForSelector('a:has-text("Log in")');
  assert.equal((await (await page.context().request.get(WEB + '/v1/session')).json()).user, null, 'the server session is gone');
  await page.unroute('**/v1/log_out');
  await page.context().close();

  // Every attempt fails: the user is told, stays signed in (truthfully), and the session still works.
  const p2 = await signedUp('logout2', 'Lou Twice');
  let calls = 0;
  await p2.route('**/v1/log_out', (route) => { calls += 1; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"unavailable","message":"try again"}}' }); });
  await p2.click('[data-testid=account-menu]');
  await p2.click('#logout-btn');
  await p2.waitForSelector('.toast:has-text("couldn\'t sign you out")');
  assert.equal(calls, 3, 'three attempts');
  assert.equal(await p2.locator('[data-testid=account-menu]').count(), 1, 'still shown as signed in');
  assert.notEqual((await (await p2.context().request.get(WEB + '/v1/session')).json()).user, null, 'and the server agrees');
  await p2.unroute('**/v1/log_out');
  await p2.context().close();
});
