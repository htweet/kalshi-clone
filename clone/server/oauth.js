'use strict';
// OAuth / OpenID Connect sign-in (PLAN P3.3; CLONE_SPEC §4.7 `POST /oauth/{provider}/callback?four_digit_code=true`,
// client route `/oauth-web/google/callback`; spec §25).
//
// Relying party (always): authorization-code flow with PKCE (S256), `state` (single use, 10 minutes, bound to the
// browser's login-CSRF cookie — or to the session when linking) and `nonce` (checked in the ID token), exact redirect
// URI, ID-token signature (RS256 / ES256 via the provider's JWKS), issuer, audience and expiry checks.
// Account linking: an existing link signs in (two-factor still applies); a provider-verified email that matches an
// existing account needs that account's password before it is linked; an unverified matching email is refused; no
// match creates a new account (no password; email marked verified when the provider says so). Signed-in users link
// from Account (step-up); unlinking needs step-up and is refused when it would leave no way to sign in.
// Providers: Google and Apple endpoints when `identity.oauth.<provider>.clientId/clientSecret` are configured; otherwise,
// outside production only, a built-in mock OIDC provider at /mock-oidc/<provider>/… (its own route namespace, test
// identities only).
const crypto = require('node:crypto');
const express = require('express');
const { nowIso, newId, token, ApiError, E } = require('./util');
const kc = require('./crypto');
const pw = require('./passwords');
const { check } = require('./validate');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_requests (state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, nonce TEXT NOT NULL, verifier_enc TEXT NOT NULL, redirect_uri TEXT NOT NULL, binding TEXT NOT NULL,
  mode TEXT NOT NULL, user_id TEXT, created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL, used_ts INTEGER);
CREATE TABLE IF NOT EXISTS oauth_links (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, subject_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_used_at TEXT, UNIQUE(provider, subject_hash));
CREATE INDEX IF NOT EXISTS idx_oauth_links_user ON oauth_links(user_id);
CREATE TABLE IF NOT EXISTS oauth_link_tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, subject_hash TEXT NOT NULL, email_verified INTEGER NOT NULL, expires_ts INTEGER NOT NULL, used_ts INTEGER);
CREATE TABLE IF NOT EXISTS mock_oidc_codes (hash TEXT PRIMARY KEY, provider TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, nonce TEXT NOT NULL,
  sub TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, email_verified INTEGER NOT NULL, expires_ts INTEGER NOT NULL, used_ts INTEGER);
CREATE TABLE IF NOT EXISTS mock_oidc_keys (provider TEXT PRIMARY KEY, kid TEXT NOT NULL, private_enc TEXT NOT NULL, public_jwk TEXT NOT NULL, created_at TEXT NOT NULL);
`;
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const LABEL = { google: 'Google', apple: 'Apple' };
const REAL = {
  google: { issuer: 'https://accounts.google.com', authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs' },
  apple: { issuer: 'https://appleid.apple.com', authorize: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', jwks: 'https://appleid.apple.com/auth/keys' },
};
const REQ_TTL = 10 * 60000;
const CODE_TTL = 60000;

function verifyJwt(jwt, keyFor) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const key = keyFor(header.kid, header.alg);
  if (!key) throw new Error('unknown signing key');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  let ok = false;
  if (header.alg === 'RS256') ok = crypto.verify('sha256', data, key, sig);
  else if (header.alg === 'ES256') ok = crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  else throw new Error('unsupported algorithm');
  if (!ok) throw new Error('bad signature');
  return claims;
}

function mountOAuth(ctx) {
  const { v1, app, db, auth, security, logEvent, getUser, production, origin, options, ensureProfile, setProfile, keyDir, requireUser } = ctx;
  db.exec(SCHEMA);
  const oo = options.oauth || {};
  const keys = { subject: kc.deriveKey('oauth-subject:v1', { dir: keyDir }), enc: kc.deriveKey('field-encryption:v1', { dir: keyDir }), mock: kc.deriveKey('mock-oidc:v1', { dir: keyDir }) };
  const mockEnabled = !production && oo.mock !== false;
  // Real provider credentials come only from the start option `identity.oauth.<provider>.{clientId, clientSecret}`
  // (wire them from your secret store); without them the provider is the built-in mock outside production, or absent.
  const env = (p, k) => (oo[p] && oo[p][k]) || '';
  const realConfigured = (p) => !!(env(p, 'clientId') && env(p, 'clientSecret'));
  const kindOf = (p) => (!REAL[p] ? null : realConfigured(p) ? 'real' : mockEnabled ? 'mock' : null);
  const providers = () => Object.keys(REAL).filter(kindOf).map((p) => ({ id: p, label: LABEL[p], mock: kindOf(p) === 'mock' }));
  const redirectUri = (req, p) => `${origin(req)}/oauth-web/${p}/callback`;
  const subjectHash = (p, sub) => kc.hmacHex(keys.subject, `${p}:${sub}`);
  const preCookie = (req) => { const c = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('plx_pre=') || s.startsWith('__Host-plx_pre=')); return c ? decodeURIComponent(c.slice(c.indexOf('=') + 1)) : ''; };
  const bindingOf = (req, mode) => kc.sha256hex(mode === 'link' ? `sid:${req.auth.session.sid}` : `pre:${preCookie(req)}`);
  auth.hooks.preSession.push(['POST', /^\/v1\/oauth\/[a-z]+\/(start|callback)$/], ['POST', /^\/v1\/oauth\/link$/]);
  const providerOf = (req) => { const p = String(req.params.provider || ''); if (!kindOf(p)) throw E.notFound(); return p; };
  const fail = (req, p, reason, uid = null) => { logEvent(uid, 'oauth_fail', req, { provider: p, reason }); return new ApiError(400, 'oauth_failed', 'sign-in with this provider failed', 'start again from the sign-in page'); };

  // ------------------------------------------------------------------ mock OIDC provider (dev / tests only)
  const mockClient = (p) => ({ id: `parlance-dev-${p}`, secret: kc.hmacHex(keys.mock, `client-secret:${p}`).slice(0, 32) });
  const mockIssuer = (req, p) => `${origin(req)}/mock-oidc/${p}`;
  function mockKey(p) {
    let r = db.prepare('SELECT * FROM mock_oidc_keys WHERE provider=?').get(p);
    if (!r) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const kid = `mock-${p}-${token(6)}`;
      const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
      db.prepare('INSERT INTO mock_oidc_keys(provider,kid,private_enc,public_jwk,created_at) VALUES(?,?,?,?,?) ON CONFLICT(provider) DO NOTHING')
        .run(p, kid, kc.encrypt(privateKey.export({ format: 'pem', type: 'pkcs8' }), `mock_oidc.key:${p}`, keys.enc), JSON.stringify(jwk), nowIso());
      r = db.prepare('SELECT * FROM mock_oidc_keys WHERE provider=?').get(p);
    }
    return { kid: r.kid, jwk: JSON.parse(r.public_jwk), privateKey: crypto.createPrivateKey(kc.decrypt(r.private_enc, `mock_oidc.key:${p}`, keys.enc)) };
  }
  function signJwt(p, claims) {
    const k = mockKey(p);
    const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: k.kid }));
    const body = b64u(JSON.stringify(claims));
    return `${h}.${body}.${b64u(crypto.sign('sha256', Buffer.from(`${h}.${body}`), k.privateKey))}`;
  }
  // Token endpoint logic, shared by the HTTP endpoint and the in-process client.
  function mockExchange(req, p, { grant_type: grantType, code, redirect_uri: ru, client_id: cid, client_secret: secret, code_verifier: verifier }) {
    const bad = (e) => Object.assign(new Error(e), { oauth: e });
    if (grantType !== 'authorization_code') throw bad('unsupported_grant_type');
    const c = mockClient(p);
    if (cid !== c.id || (secret != null && !kc.safeEqual(String(secret), c.secret))) throw bad('invalid_client');
    const row = db.prepare('SELECT * FROM mock_oidc_codes WHERE hash=? AND provider=?').get(kc.sha256hex(String(code || '')), p);
    if (!row || row.used_ts || row.expires_ts < Date.now() || row.client_id !== cid) throw bad('invalid_grant');
    // Single use even when the rest fails: a code presented with the wrong verifier is burned.
    db.prepare('UPDATE mock_oidc_codes SET used_ts=? WHERE hash=?').run(Date.now(), row.hash);
    if (row.redirect_uri !== ru) throw bad('invalid_grant');
    if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64u(sha256(verifier)) !== row.challenge) throw bad('invalid_grant'); // PKCE S256
    const now = Math.floor(Date.now() / 1000);
    const idToken = signJwt(p, { iss: mockIssuer(req, p), aud: cid, sub: row.sub, email: row.email, email_verified: !!row.email_verified, name: row.name, nonce: row.nonce, iat: now, exp: now + 300 });
    return { access_token: token(24), token_type: 'Bearer', expires_in: 300, id_token: idToken };
  }

  if (mockEnabled) {
    const form = express.urlencoded({ extended: false, limit: '4kb' });
    const json = express.json({ limit: '4kb' });
    const page = (res, nonce, title, body, status = 200) => {
      res.status(status);
      res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style nonce="${nonce}">body{font:15px/1.45 system-ui,sans-serif;background:#f4f4f6;color:#16161d;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:#fff;border-radius:14px;padding:24px;max-width:380px;width:100%;box-shadow:0 2px 16px rgba(0,0,0,.08)}h1{font-size:19px;margin:0 0 4px}p{color:#555;margin:0 0 14px}
label{display:block;font-size:13px;color:#444;margin:10px 0 4px}input[type=email],input[type=text]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font:inherit}
.row{display:flex;gap:8px;margin-top:16px}button{flex:1;padding:11px;border-radius:8px;border:1px solid #bbb;background:#fff;font:inherit;cursor:pointer}button.go{background:#2d3fe0;color:#fff;border-color:#2d3fe0}
.tag{display:inline-block;font-size:11px;background:#fff3cd;color:#7a5b00;border-radius:6px;padding:2px 6px;margin-bottom:10px}.chk{display:flex;gap:8px;align-items:center;margin-top:12px}</style></head><body><main>${body}</main></body></html>`);
    };
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const signReq = (o) => { const s = b64u(JSON.stringify(o)); return `${s}.${kc.hmacHex(keys.mock, `authz:${s}`).slice(0, 43)}`; };
    const openReq = (t) => { const [s, m] = String(t || '').split('.'); if (!s || !m || !kc.safeEqual(m, kc.hmacHex(keys.mock, `authz:${s}`).slice(0, 43))) return null; try { const o = JSON.parse(Buffer.from(s, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; } };
    const known = (req, res) => { const p = String(req.params.provider); if (!REAL[p] || kindOf(p) !== 'mock') { res.status(404).type('text/plain').send('Not found'); return null; } return p; };

    app.get('/mock-oidc/:provider/authorize', (req, res) => {
      const p = known(req, res); if (!p) return;
      const q = req.query; const nonce = res.locals.cspNonce || token(12);
      const err = (m) => page(res, nonce, 'Sign-in error', `<h1>Request rejected</h1><p>${esc(m)}</p>`, 400);
      if (q.response_type !== 'code') return err('response_type must be code');
      if (q.client_id !== mockClient(p).id) return err('unknown client_id');
      if (q.redirect_uri !== redirectUri(req, p)) return err('redirect_uri is not registered for this client');
      if (!String(q.scope || '').split(' ').includes('openid')) return err('scope must include openid');
      if (!q.state || !q.nonce || String(q.state).length > 200 || String(q.nonce).length > 200) return err('state and nonce are required');
      if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(String(q.code_challenge || ''))) return err('PKCE with S256 is required');
      const r = signReq({ p, cid: q.client_id, ru: q.redirect_uri, st: q.state, n: q.nonce, cc: q.code_challenge, exp: Date.now() + REQ_TTL });
      page(res, nonce, `Test sign-in · ${LABEL[p]}`, `<span class="tag">Parlance test identity provider</span><h1>Continue with ${esc(LABEL[p])} (simulated)</h1>
<p>Development only. Enter any invented test identity; nothing is sent to ${esc(LABEL[p])}.</p>
<form method="post" action="/mock-oidc/${esc(p)}/authorize" data-testid="mock-oidc-form"><input type="hidden" name="request" value="${esc(r)}">
<label for="em">Test email</label><input id="em" name="email" type="email" required autocomplete="off" data-testid="mock-oidc-email">
<label for="nm">Name</label><input id="nm" name="name" type="text" maxlength="60" autocomplete="off" data-testid="mock-oidc-name">
<div class="chk"><input id="ev" name="email_verified" type="checkbox" value="1" checked data-testid="mock-oidc-verified"><label for="ev">Email verified by ${esc(LABEL[p])}</label></div>
<div class="row"><button type="submit" name="action" value="deny" data-testid="mock-oidc-deny">Cancel</button><button class="go" type="submit" name="action" value="approve" data-testid="mock-oidc-approve">Continue</button></div></form>`);
    });
    app.post('/mock-oidc/:provider/authorize', form, (req, res) => {
      const p = known(req, res); if (!p) return;
      const r = openReq(req.body && req.body.request);
      if (!r || r.p !== p) return res.status(400).type('text/plain').send('invalid or expired authorization request');
      const back = (params) => res.redirect(303, `${r.ru}?${new URLSearchParams({ ...params, state: r.st })}`);
      if (req.body.action !== 'approve') return back({ error: 'access_denied' });
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return res.status(400).type('text/plain').send('enter a valid email');
      const code = token(24);
      db.prepare('INSERT INTO mock_oidc_codes(hash,provider,client_id,redirect_uri,challenge,nonce,sub,email,name,email_verified,expires_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(kc.sha256hex(code), p, r.cid, r.ru, r.cc, r.n, kc.hmacHex(keys.mock, `sub:${p}:${email}`).slice(0, 24), email, String(req.body.name || '').trim().slice(0, 60), req.body.email_verified === '1' ? 1 : 0, Date.now() + CODE_TTL);
      back({ code });
    });
    app.post('/mock-oidc/:provider/token', form, json, (req, res) => {
      const p = known(req, res); if (!p) return;
      res.setHeader('Cache-Control', 'no-store');
      try { res.json(mockExchange(req, p, req.body || {})); } catch (e) { res.status(400).json({ error: e.oauth || 'invalid_request' }); }
    });
    app.get('/mock-oidc/:provider/jwks', (req, res) => { const p = known(req, res); if (!p) return; res.json({ keys: [mockKey(p).jwk] }); });
  }

  // ------------------------------------------------------------------ provider clients
  const jwksCache = new Map();
  async function realJwks(p) {
    const c = jwksCache.get(p);
    if (c && c.at > Date.now() - 3600000) return c.keys;
    const r = await fetch(REAL[p].jwks, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('jwks fetch failed');
    const keys = (await r.json()).keys || [];
    jwksCache.set(p, { at: Date.now(), keys });
    return keys;
  }
  async function exchange(req, p, code, verifier, ru) {
    if (kindOf(p) === 'mock') {
      const c = mockClient(p);
      const t = mockExchange(req, p, { grant_type: 'authorization_code', code, redirect_uri: ru, client_id: c.id, client_secret: c.secret, code_verifier: verifier });
      const jwk = mockKey(p).jwk;
      return { claims: verifyJwt(t.id_token, (kid) => (kid === jwk.kid ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null)), issuer: mockIssuer(req, p), clientId: c.id };
    }
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: ru, client_id: env(p, 'clientId'), client_secret: env(p, 'clientSecret'), code_verifier: verifier });
    const r = await fetch(REAL[p].token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id_token) throw new Error('token exchange failed');
    const keys = await realJwks(p);
    return { claims: verifyJwt(j.id_token, (kid) => { const k = keys.find((x) => x.kid === kid); return k ? crypto.createPublicKey({ key: k, format: 'jwk' }) : null; }), issuer: REAL[p].issuer, clientId: env(p, 'clientId') };
  }
  function authorizeUrl(req, p, { state, nonce, challenge }) {
    const ru = redirectUri(req, p);
    const params = { response_type: 'code', client_id: kindOf(p) === 'mock' ? mockClient(p).id : env(p, 'clientId'), redirect_uri: ru, scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' };
    const base = kindOf(p) === 'mock' ? `${mockIssuer(req, p)}/authorize` : REAL[p].authorize;
    return `${base}?${new URLSearchParams(params)}`;
  }

  function startFlow(req, p, mode) {
    const state = token(24); const nonce = token(16); const verifier = token(48);
    const ru = redirectUri(req, p);
    if (mode === 'login' && !preCookie(req)) throw E.forbidden('missing or invalid login csrf token');
    db.prepare('DELETE FROM oauth_requests WHERE expires_ts<?').run(Date.now() - 86400000);
    db.prepare('INSERT INTO oauth_requests(state_hash,provider,nonce,verifier_enc,redirect_uri,binding,mode,user_id,created_ts,expires_ts) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(kc.sha256hex(state), p, nonce, kc.encrypt(verifier, `oauth.verifier:${kc.sha256hex(state)}`, keys.enc), ru, bindingOf(req, mode), mode, mode === 'link' ? req.auth.user.id : null, Date.now(), Date.now() + REQ_TTL);
    return { authorization_url: authorizeUrl(req, p, { state, nonce, challenge: b64u(sha256(verifier)) }), expires_in: REQ_TTL / 1000 };
  }

  // ------------------------------------------------------------------ routes
  v1.post('/oauth/:provider/start', (req, res) => {
    const p = providerOf(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(startFlow(req, p, 'login'));
  });
  v1.post('/users/:uid/oauth/:provider/link', requireUser, (req, res) => {
    const p = providerOf(req);
    auth.assertFresh(req, 'oauth_link');
    if (db.prepare('SELECT 1 FROM oauth_links WHERE user_id=? AND provider=?').get(req.auth.user.id, p)) throw E.conflict('oauth_already_linked', `${LABEL[p]} is already linked to your account`);
    res.setHeader('Cache-Control', 'no-store');
    res.json(startFlow(req, p, 'link'));
  });

  // `four_digit_code=true` (spec §4.7) is accepted and ignored: two-factor in the clone is the 6-digit TOTP step.
  v1.post('/oauth/:provider/callback', async (req, res) => {
    const p = providerOf(req);
    const b = check(req.body, { code: { type: 'string', maxLen: 512, required: true }, state: { type: 'string', maxLen: 200, required: true } }, { unknown: 'reject' });
    const r = db.prepare('SELECT * FROM oauth_requests WHERE state_hash=?').get(kc.sha256hex(b.state));
    // State: must exist, be unused, unexpired, for this provider and this browser (or this session when linking).
    if (!r || r.provider !== p || r.used_ts || r.expires_ts < Date.now()) throw fail(req, p, 'state_invalid');
    if (r.mode === 'link' ? !(req.auth && req.auth.user.id === r.user_id && bindingOf(req, 'link') === r.binding) : bindingOf(req, 'login') !== r.binding) throw fail(req, p, 'state_binding');
    if (db.prepare('UPDATE oauth_requests SET used_ts=? WHERE state_hash=? AND used_ts IS NULL').run(Date.now(), r.state_hash).changes !== 1) throw fail(req, p, 'state_replay');
    const verifier = kc.decrypt(r.verifier_enc, `oauth.verifier:${r.state_hash}`, keys.enc);
    let claims;
    try {
      const x = await exchange(req, p, b.code, verifier, r.redirect_uri);
      claims = x.claims;
      const now = Math.floor(Date.now() / 1000);
      if (claims.iss !== x.issuer) throw new Error('issuer');
      if (!(claims.aud === x.clientId || (Array.isArray(claims.aud) && claims.aud.includes(x.clientId)))) throw new Error('audience');
      if (!(claims.exp > now - 30) || !(claims.iat <= now + 60)) throw new Error('expired');
      if (!claims.nonce || !kc.safeEqual(String(claims.nonce), r.nonce)) throw new Error('nonce');
      if (!claims.sub) throw new Error('subject');
    } catch (e) { throw fail(req, p, `exchange: ${String(e.message).slice(0, 40)}`); }
    const subj = subjectHash(p, String(claims.sub));
    const email = String(claims.email || '').trim().toLowerCase();
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    const link = db.prepare('SELECT * FROM oauth_links WHERE provider=? AND subject_hash=?').get(p, subj);

    if (r.mode === 'link') {
      if (link && link.user_id !== r.user_id) throw E.conflict('oauth_already_linked', `this ${LABEL[p]} account is linked to a different Parlance account`);
      if (!link) db.prepare('INSERT INTO oauth_links(id,user_id,provider,subject_hash,email_verified,created_at) VALUES(?,?,?,?,?,?)').run(newId('ol_'), r.user_id, p, subj, verified ? 1 : 0, nowIso());
      logEvent(r.user_id, 'oauth_linked', req, { provider: p });
      auth.alertUser(getUser(r.user_id), `${LABEL[p]} sign-in linked`, `You can now sign in to Parlance with ${LABEL[p]}.`);
      return res.json({ linked: true, provider: p });
    }
    if (link) {
      const u = getUser(link.user_id);
      if (!u || ctx.statusOf(u.id) === 'closed') throw fail(req, p, 'account_unavailable');
      db.prepare('UPDATE oauth_links SET last_used_at=? WHERE id=?').run(nowIso(), link.id);
      return auth.beginLogin(req, res, u, { method: `oauth:${p}` });
    }
    const existing = email ? db.prepare('SELECT * FROM users WHERE email=? AND is_system=0').get(email) : null;
    if (existing) {
      // Linking rule: a provider-verified email that matches needs the account's password first (no silent takeover
      // through a provider account created with someone else's address); an unverified match is refused outright.
      if (!verified) { logEvent(existing.id, 'oauth_fail', req, { provider: p, reason: 'email_unverified' }); throw E.conflict('oauth_email_unverified', 'an account with this email already exists', `log in with your password, then link ${LABEL[p]} from Account › Identity & privacy`); }
      if (!pw.isUsable(existing.password_hash)) throw fail(req, p, 'link_no_password', existing.id);
      const lt = token(24);
      db.prepare('INSERT INTO oauth_link_tokens(hash,user_id,provider,subject_hash,email_verified,expires_ts) VALUES(?,?,?,?,?,?)').run(kc.sha256hex(lt), existing.id, p, subj, 1, Date.now() + REQ_TTL);
      logEvent(existing.id, 'oauth_link_required', req, { provider: p });
      return res.json({ link_required: true, link_token: lt, provider: p, email_masked: `${email[0]}***@${email.split('@')[1]}` });
    }
    if (!email) throw fail(req, p, 'no_email');
    // New account: no password (sign-in through the provider, a passkey, or a password set later via reset).
    const id = newId('u_');
    const name = (String(claims.name || '').replace(/[^\p{L}\p{M}\p{N} .'-]/gu, '').trim().slice(0, 40)) || 'Parlance trader';
    db.prepare('INSERT INTO users(id,email,display_name,password_hash,balance_cents,created_at) VALUES(?,?,?,?,0,?)').run(id, email, name.length >= 2 ? name : 'Parlance trader', pw.UNUSABLE(`oauth-${p}`), nowIso());
    db.prepare('INSERT INTO oauth_links(id,user_id,provider,subject_hash,email_verified,created_at,last_used_at) VALUES(?,?,?,?,?,?,?)').run(newId('ol_'), id, p, subj, verified ? 1 : 0, nowIso(), nowIso());
    ensureProfile(id);
    if (verified) setProfile(id, { email_verified_at: nowIso() });
    logEvent(id, 'signup', req, { method: `oauth:${p}` });
    ctx.compliance.recordDevice(id, req);
    return auth.beginLogin(req, res, getUser(id), { method: `oauth:${p}` });
  });

  v1.post('/oauth/link', async (req, res) => {
    const b = check(req.body, { link_token: { type: 'string', maxLen: 64, required: true }, password: { type: 'string', maxLen: 256, required: true } }, { unknown: 'reject' });
    const t = db.prepare('SELECT * FROM oauth_link_tokens WHERE hash=?').get(kc.sha256hex(b.link_token));
    if (!t || t.used_ts || t.expires_ts < Date.now()) throw new ApiError(400, 'oauth_failed', 'this link request expired', 'start again from the sign-in page');
    const u = getUser(t.user_id);
    if (!u) throw new ApiError(400, 'oauth_failed', 'this link request expired');
    await auth.checkPassword(req, u, b.password, 'oauth_link'); // throttled like step-up; failures are logged
    if (db.prepare('UPDATE oauth_link_tokens SET used_ts=? WHERE hash=? AND used_ts IS NULL').run(Date.now(), t.hash).changes !== 1) throw new ApiError(400, 'oauth_failed', 'this link request was already used');
    if (!db.prepare('SELECT 1 FROM oauth_links WHERE provider=? AND subject_hash=?').get(t.provider, t.subject_hash)) {
      db.prepare('INSERT INTO oauth_links(id,user_id,provider,subject_hash,email_verified,created_at,last_used_at) VALUES(?,?,?,?,?,?,?)').run(newId('ol_'), u.id, t.provider, t.subject_hash, t.email_verified, nowIso(), nowIso());
    }
    logEvent(u.id, 'oauth_linked', req, { provider: t.provider, via: 'password' });
    auth.alertUser(u, `${LABEL[t.provider]} sign-in linked`, `${LABEL[t.provider]} was linked to your account after your password was confirmed.`);
    return auth.beginLogin(req, res, u, { method: `oauth:${t.provider}+password` });
  });

  v1.get('/users/:uid/oauth', requireUser, (req, res) => {
    const links = db.prepare('SELECT provider, email_verified, created_at, last_used_at FROM oauth_links WHERE user_id=? ORDER BY created_at').all(req.auth.user.id);
    res.json({ providers: providers(), linked: links.map((l) => ({ provider: l.provider, label: LABEL[l.provider] || l.provider, linked_time: l.created_at, last_used_time: l.last_used_at })) });
  });
  v1.delete('/users/:uid/oauth/:provider', requireUser, (req, res) => {
    const p = String(req.params.provider);
    const uid = req.auth.user.id;
    if (!db.prepare('SELECT 1 FROM oauth_links WHERE user_id=? AND provider=?').get(uid, p)) throw E.notFound();
    auth.assertFresh(req, 'oauth_unlink');
    const others = db.prepare('SELECT COUNT(*) c FROM oauth_links WHERE user_id=? AND provider<>?').get(uid, p).c + (ctx.webauthn ? ctx.webauthn.countFor(uid) : 0);
    if (!pw.isUsable(getUser(uid).password_hash) && !others) throw E.conflict('last_sign_in_method', 'this is your only way to sign in', 'set a password (Forgot password) or add a passkey first');
    db.prepare('DELETE FROM oauth_links WHERE user_id=? AND provider=?').run(uid, p);
    logEvent(uid, 'oauth_unlinked', req, { provider: p });
    res.json({ unlinked: true });
  });

  return { providers, close: () => {} };
}

module.exports = { mountOAuth, verifyJwt };
