'use strict';
// Passkeys / WebAuthn (PLAN P3.4; PLAN §2 S9: `/passkeys/registration`, `/passkeys/authentication`; spec §25).
// Implemented here without a library: a small CBOR decoder, authenticator-data parsing, COSE → JWK conversion and
// signature checks with node:crypto.
//
// Registration (signed-in, step-up): attestation format must be "none" (no attestation statement is trusted or
// needed), clientData.type "webauthn.create", challenge (single use, 5 minutes, bound to the session), origin, rpIdHash,
// user-present flag, credential id = rawId. Algorithms: ES256 (-7), EdDSA (-8), RS256 (-257).
// Authentication (sign-in from the login page, or step-up): discoverable credentials, user verification required,
// challenge bound to the browser's login-CSRF cookie (sign-in) or the session (step-up), origin, rpIdHash, flags,
// signature over authenticatorData ‖ SHA-256(clientDataJSON), and the signature counter: when either counter is non-zero
// the new value must be greater than the stored one, otherwise the credential is treated as cloned and refused.
// A user-verified passkey counts as two factors, so it skips the TOTP step. Admins can be required (setting) to have
// signed in, or confirmed, with a passkey before any /v1/admin route answers.
const crypto = require('node:crypto');
const { nowIso, newId, ApiError, E } = require('./util');
const kc = require('./crypto');
const pw = require('./passwords');
const { check } = require('./validate');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credential_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]', aaguid TEXT NOT NULL DEFAULT '', backup_eligible INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);
CREATE TABLE IF NOT EXISTS webauthn_users (user_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS webauthn_challenges (hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id TEXT, binding TEXT NOT NULL, expires_ts INTEGER NOT NULL, used_ts INTEGER);
CREATE TABLE IF NOT EXISTS session_amr (sid TEXT PRIMARY KEY, method TEXT NOT NULL, ts INTEGER NOT NULL);
`;
const CHALLENGE_TTL = 5 * 60000;
const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 };
const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => { if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s) || s.length > 16384) throw new Error('bad base64url'); return Buffer.from(s, 'base64url'); };

// ------------------------------------------------------------------------------------------------ CBOR (RFC 8949 subset)
function cborDecode(buf, start = 0, depth = 0) {
  if (depth > 16) throw new Error('cbor too deep');
  let pos = start;
  const need = (n) => { if (pos + n > buf.length) throw new Error('cbor truncated'); };
  need(1);
  const ib = buf[pos++];
  const major = ib >> 5; const info = ib & 31;
  const readLen = () => {
    if (info < 24) return info;
    if (info === 24) { need(1); return buf[pos++]; }
    if (info === 25) { need(2); const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { need(4); const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (info === 27) { need(8); const v = buf.readBigUInt64BE(pos); pos += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor int too large'); return Number(v); }
    throw new Error('cbor indefinite length not supported');
  };
  switch (major) {
    case 0: return { value: readLen(), pos };
    case 1: return { value: -1 - readLen(), pos };
    case 2: { const n = readLen(); need(n); const v = buf.subarray(pos, pos + n); pos += n; return { value: Buffer.from(v), pos }; }
    case 3: { const n = readLen(); need(n); const v = buf.toString('utf8', pos, pos + n); pos += n; return { value: v, pos }; }
    case 4: { const n = readLen(); if (n > 1000) throw new Error('cbor array too long'); const out = []; for (let i = 0; i < n; i++) { const r = cborDecode(buf, pos, depth + 1); out.push(r.value); pos = r.pos; } return { value: out, pos }; }
    case 5: {
      const n = readLen(); if (n > 1000) throw new Error('cbor map too long');
      const out = Object.create(null);
      for (let i = 0; i < n; i++) { const k = cborDecode(buf, pos, depth + 1); const v = cborDecode(buf, k.pos, depth + 1); out[String(k.value)] = v.value; pos = v.pos; }
      return { value: out, pos };
    }
    case 6: { readLen(); return cborDecode(buf, pos, depth + 1); } // tag: ignore, decode the tagged item
    default: {
      if (info === 20) return { value: false, pos }; if (info === 21) return { value: true, pos }; if (info === 22) return { value: null, pos }; if (info === 23) return { value: undefined, pos };
      if (info === 26) { need(4); const v = buf.readFloatBE(pos); return { value: v, pos: pos + 4 }; }
      if (info === 27) { need(8); const v = buf.readDoubleBE(pos); return { value: v, pos: pos + 8 }; }
      throw new Error('cbor simple value not supported');
    }
  }
}

function parseAuthData(ad) {
  if (ad.length < 37) throw new Error('authenticator data too short');
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33) };
  if (out.flags & FLAG.AT) {
    if (ad.length < 55) throw new Error('attested credential data truncated');
    out.aaguid = ad.subarray(37, 53).toString('hex');
    const len = ad.readUInt16BE(53);
    if (len > 1023 || ad.length < 55 + len) throw new Error('bad credential id length');
    out.credentialId = ad.subarray(55, 55 + len);
    const k = cborDecode(ad, 55 + len);
    out.cose = k.value;
    out.coseEnd = k.pos;
  }
  return out;
}

// COSE_Key → node KeyObject (EC2 P-256, OKP Ed25519, RSA).
function coseToKey(m) {
  const kty = m['1']; const alg = m['3'];
  if (kty === 2 && alg === -7 && m['-1'] === 1) return { alg, key: crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(m['-2']), y: b64u(m['-3']) } }) };
  if (kty === 1 && alg === -8 && m['-1'] === 6) return { alg, key: crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: b64u(m['-2']) } }) };
  if (kty === 3 && alg === -257) return { alg, key: crypto.createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: b64u(m['-1']), e: b64u(m['-2']) } }) };
  throw new Error('unsupported credential public key');
}
function verifySig(alg, key, data, sig) {
  if (alg === -7) return crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, sig);
  if (alg === -8) return crypto.verify(null, data, key, sig);
  if (alg === -257) return crypto.verify('sha256', data, key, sig);
  return false;
}

function mountWebAuthn(ctx) {
  const { v1, app, db, auth, logEvent, getUser, origin, options, requireUser, settings, admin } = ctx;
  db.exec(SCHEMA);
  const wo = options.webauthn || {};
  const rpName = 'Parlance';
  const expectedOrigin = (req) => wo.origin || origin(req);
  const rpIdOf = (req) => wo.rpId || new URL(expectedOrigin(req)).hostname;
  const preCookie = (req) => { const c = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('plx_pre=') || s.startsWith('__Host-plx_pre=')); return c ? decodeURIComponent(c.slice(c.indexOf('=') + 1)) : ''; };
  const bindingOf = (req, purpose) => kc.sha256hex(purpose === 'login' ? `pre:${preCookie(req)}` : `sid:${req.auth.session.sid}`);
  auth.hooks.preSession.push(['POST', /^\/v1\/passkeys\/authentication(\/options)?$/]);
  const countFor = (uid) => db.prepare('SELECT COUNT(*) c FROM passkeys WHERE user_id=?').get(uid).c;
  auth.hooks.stepUpExtras = (uid) => (countFor(uid) ? ['passkey'] : []);
  const isStaff = (u) => !!u.is_admin || admin.rolesOf(u).length > 0;

  function handleOf(uid) {
    let r = db.prepare('SELECT handle FROM webauthn_users WHERE user_id=?').get(uid);
    if (!r) { db.prepare('INSERT INTO webauthn_users(user_id,handle) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING').run(uid, b64u(crypto.randomBytes(16))); r = db.prepare('SELECT handle FROM webauthn_users WHERE user_id=?').get(uid); }
    return r.handle;
  }
  function newChallenge(req, purpose, uid) {
    const c = b64u(crypto.randomBytes(32));
    db.prepare('DELETE FROM webauthn_challenges WHERE expires_ts<?').run(Date.now() - 3600000);
    db.prepare('INSERT INTO webauthn_challenges(hash,purpose,user_id,binding,expires_ts) VALUES(?,?,?,?,?)').run(kc.sha256hex(c), purpose, uid || null, bindingOf(req, purpose), Date.now() + CHALLENGE_TTL);
    return c;
  }
  // Single use: the row is consumed whatever the outcome of the rest of the verification.
  function takeChallenge(req, purpose, challenge, uid) {
    const h = kc.sha256hex(String(challenge || ''));
    const r = db.prepare('SELECT * FROM webauthn_challenges WHERE hash=? AND purpose=?').get(h, purpose);
    if (!r || r.used_ts || r.expires_ts < Date.now() || r.binding !== bindingOf(req, purpose) || (uid && r.user_id !== uid)) return false;
    return db.prepare('UPDATE webauthn_challenges SET used_ts=? WHERE hash=? AND used_ts IS NULL').run(Date.now(), h).changes === 1;
  }
  const bad = (req, uid, reason, msg = 'this passkey could not be verified') => { logEvent(uid, 'passkey_fail', req, { reason }); return new ApiError(400, 'passkey_invalid', msg, 'try again, or use another sign-in method'); };
  const CRED = { id: { type: 'string', maxLen: 1400, required: true }, rawId: { type: 'string', maxLen: 1400 }, type: { type: 'string', enum: ['public-key'], required: true },
    response: { type: 'object', required: true }, authenticatorAttachment: { type: 'string', maxLen: 32, nullable: true }, clientExtensionResults: { type: 'object' } };
  function clientDataOf(req, uid, resp, type, purpose) {
    let cd;
    try { cd = JSON.parse(fromB64u(resp.clientDataJSON).toString('utf8')); } catch { throw bad(req, uid, 'client_data'); }
    if (cd.type !== type) throw bad(req, uid, 'client_data_type');
    if (cd.origin !== expectedOrigin(req)) throw bad(req, uid, 'origin');
    if (cd.crossOrigin === true) throw bad(req, uid, 'cross_origin');
    if (!takeChallenge(req, purpose, cd.challenge, uid)) throw bad(req, uid, 'challenge', 'this passkey request expired; try again');
    return cd;
  }

  // ------------------------------------------------------------------ registration
  v1.post('/users/:uid/passkeys/registration/options', requireUser, (req, res) => {
    auth.assertFresh(req, 'passkey_add');
    const u = req.auth.user;
    const existing = db.prepare('SELECT credential_id, transports FROM passkeys WHERE user_id=?').all(u.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ publicKey: {
      challenge: newChallenge(req, 'register', u.id), rp: { id: rpIdOf(req), name: rpName }, user: { id: handleOf(u.id), name: u.email, displayName: u.display_name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }], timeout: CHALLENGE_TTL, attestation: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.credential_id, transports: JSON.parse(c.transports) })),
    } });
  });
  v1.post('/users/:uid/passkeys/registration', requireUser, (req, res) => {
    const b = check(req.body, { credential: { type: 'object', required: true }, name: { type: 'string', maxLen: 60 } }, { unknown: 'reject' });
    const cred = check(b.credential, CRED, { unknown: 'reject' });
    const resp = check(cred.response, { clientDataJSON: { type: 'string', maxLen: 4096, required: true }, attestationObject: { type: 'string', maxLen: 16384, required: true }, transports: { type: 'array', maxItems: 8, items: { type: 'string', maxLen: 16 } },
      publicKey: { type: 'string', maxLen: 4096 }, publicKeyAlgorithm: { type: 'integer' }, authenticatorData: { type: 'string', maxLen: 8192 } }, { unknown: 'ignore' });
    const u = req.auth.user;
    auth.assertFresh(req, 'passkey_add');
    clientDataOf(req, u.id, resp, 'webauthn.create', 'register');
    let att; let ad;
    try {
      att = cborDecode(fromB64u(resp.attestationObject)).value;
      if (att.fmt !== 'none' || !att.attStmt || Object.keys(att.attStmt).length) throw new Error('fmt');
      ad = parseAuthData(att.authData);
    } catch (e) { throw bad(req, u.id, e.message === 'fmt' ? 'attestation_format' : 'attestation'); }
    if (!ad.rpIdHash.equals(crypto.createHash('sha256').update(rpIdOf(req)).digest())) throw bad(req, u.id, 'rp_id');
    if (!(ad.flags & FLAG.UP) || !(ad.flags & FLAG.UV)) throw bad(req, u.id, 'flags');
    if (!ad.credentialId || b64u(ad.credentialId) !== cred.id || (cred.rawId && cred.rawId !== cred.id)) throw bad(req, u.id, 'credential_id');
    let key;
    try { key = coseToKey(ad.cose); } catch { throw bad(req, u.id, 'algorithm', 'this passkey type is not supported'); }
    if (db.prepare('SELECT 1 FROM passkeys WHERE credential_id=?').get(cred.id)) throw E.conflict('passkey_exists', 'this passkey is already registered');
    const id = newId('pk_');
    const name = String(b.name || '').trim().slice(0, 60) || `Passkey ${countFor(u.id) + 1}`;
    db.prepare('INSERT INTO passkeys(id,user_id,credential_id,public_key,alg,sign_count,transports,aaguid,backup_eligible,name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, u.id, cred.id, key.key.export({ format: 'der', type: 'spki' }).toString('base64'), key.alg, ad.signCount, JSON.stringify(resp.transports || []), ad.aaguid || '', ad.flags & FLAG.BE ? 1 : 0, name, nowIso());
    logEvent(u.id, 'passkey_added', req, { passkey: id });
    auth.alertUser(u, 'Passkey added', `A passkey ("${name}") was added to your account.`);
    res.status(201).json({ passkey: vo(db.prepare('SELECT * FROM passkeys WHERE id=?').get(id)) });
  });
  const vo = (p) => ({ id: p.id, name: p.name, created_time: p.created_at, last_used_time: p.last_used_at, backup_eligible: !!p.backup_eligible, transports: JSON.parse(p.transports) });
  v1.get('/users/:uid/passkeys', requireUser, (req, res) => res.json({ passkeys: db.prepare('SELECT * FROM passkeys WHERE user_id=? ORDER BY created_at').all(req.auth.user.id).map(vo) }));
  v1.delete('/users/:uid/passkeys/:id', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const p = db.prepare('SELECT * FROM passkeys WHERE id=? AND user_id=?').get(String(req.params.id), uid);
    if (!p) throw E.notFound();
    auth.assertFresh(req, 'passkey_remove');
    const others = countFor(uid) - 1 + db.prepare('SELECT COUNT(*) c FROM oauth_links WHERE user_id=?').get(uid).c;
    if (!pw.isUsable(getUser(uid).password_hash) && others <= 0) throw E.conflict('last_sign_in_method', 'this is your only way to sign in', 'set a password (Forgot password) or add another passkey first');
    db.prepare('DELETE FROM passkeys WHERE id=?').run(p.id);
    logEvent(uid, 'passkey_removed', req, { passkey: p.id });
    auth.alertUser(req.auth.user, 'Passkey removed', `The passkey "${p.name}" was removed from your account.`);
    res.json({ removed: true });
  });

  // ------------------------------------------------------------------ authentication (sign-in and step-up)
  function verifyAssertion(req, cred, purpose, uid = null) {
    const c = check(cred, CRED, { unknown: 'reject' });
    const resp = check(c.response, { clientDataJSON: { type: 'string', maxLen: 4096, required: true }, authenticatorData: { type: 'string', maxLen: 4096, required: true },
      signature: { type: 'string', maxLen: 1400, required: true }, userHandle: { type: 'string', maxLen: 256, nullable: true } }, { unknown: 'reject' });
    const pk = db.prepare('SELECT * FROM passkeys WHERE credential_id=?').get(c.id);
    // Unknown credential: still consume the challenge so it cannot be retried with another credential.
    if (!pk || (uid && pk.user_id !== uid)) { try { clientDataOf(req, uid, resp, 'webauthn.get', purpose); } catch { /* ignore */ } throw bad(req, uid, 'unknown_credential'); }
    const raw = fromB64u(resp.clientDataJSON);
    clientDataOf(req, pk.user_id, resp, 'webauthn.get', purpose);
    let ad; let adBuf; let sig;
    try { adBuf = fromB64u(resp.authenticatorData); ad = parseAuthData(adBuf); sig = fromB64u(resp.signature); } catch { throw bad(req, pk.user_id, 'authenticator_data'); }
    if (!ad.rpIdHash.equals(crypto.createHash('sha256').update(rpIdOf(req)).digest())) throw bad(req, pk.user_id, 'rp_id');
    if (!(ad.flags & FLAG.UP) || !(ad.flags & FLAG.UV)) throw bad(req, pk.user_id, 'flags');
    if (resp.userHandle && resp.userHandle !== handleOf(pk.user_id)) throw bad(req, pk.user_id, 'user_handle');
    const key = crypto.createPublicKey({ key: Buffer.from(pk.public_key, 'base64'), format: 'der', type: 'spki' });
    const data = Buffer.concat([adBuf, crypto.createHash('sha256').update(raw).digest()]);
    if (!verifySig(pk.alg, key, data, sig)) throw bad(req, pk.user_id, 'signature');
    if ((ad.signCount > 0 || pk.sign_count > 0) && ad.signCount <= pk.sign_count) {
      logEvent(pk.user_id, 'passkey_counter_regression', req, { passkey: pk.id, stored: pk.sign_count, presented: ad.signCount });
      throw new ApiError(400, 'passkey_invalid', 'this passkey could not be verified', 'its signature counter went backwards, which can mean it was copied; use another sign-in method and contact support');
    }
    db.prepare('UPDATE passkeys SET sign_count=?, last_used_at=? WHERE id=?').run(ad.signCount, nowIso(), pk.id);
    return pk;
  }
  const assertionOptions = (req, purpose, uid) => ({ publicKey: { challenge: newChallenge(req, purpose, uid), rpId: rpIdOf(req), timeout: CHALLENGE_TTL, userVerification: 'required',
    allowCredentials: uid ? db.prepare('SELECT credential_id, transports FROM passkeys WHERE user_id=?').all(uid).map((x) => ({ type: 'public-key', id: x.credential_id, transports: JSON.parse(x.transports) })) : [] } });
  v1.post('/passkeys/authentication/options', (req, res) => {
    if (!preCookie(req)) throw E.forbidden('missing or invalid login csrf token');
    res.setHeader('Cache-Control', 'no-store');
    res.json(assertionOptions(req, 'login', null));
  });
  v1.post('/passkeys/authentication', (req, res) => {
    const b = check(req.body, { credential: { type: 'object', required: true } }, { unknown: 'reject' });
    const pk = verifyAssertion(req, b.credential, 'login');
    const u = getUser(pk.user_id);
    if (!u || ctx.statusOf(u.id) === 'closed') throw bad(req, null, 'account_unavailable');
    logEvent(u.id, 'passkey_used', req, { passkey: pk.id, at: 'login' });
    return auth.beginLogin(req, res, u, { method: 'passkey', mfaSatisfied: true });
  });
  v1.post('/passkeys/step_up/options', requireUser, (req, res) => {
    if (!countFor(req.auth.user.id)) throw E.conflict('no_passkeys', 'you have no passkeys');
    res.setHeader('Cache-Control', 'no-store');
    res.json(assertionOptions(req, 'step_up', req.auth.user.id));
  });
  v1.post('/passkeys/step_up', requireUser, (req, res) => {
    const b = check(req.body, { credential: { type: 'object', required: true } }, { unknown: 'reject' });
    const pk = verifyAssertion(req, b.credential, 'step_up', req.auth.user.id);
    auth.markStepUp(req.auth.session.sid);
    db.prepare('INSERT INTO session_amr(sid,method,ts) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET method=excluded.method, ts=excluded.ts').run(req.auth.session.sid, 'passkey', Date.now());
    logEvent(req.auth.user.id, 'step_up', req, { method: 'passkey', passkey: pk.id, session: req.auth.session.sid });
    res.json({ ok: true, method: 'passkey' });
  });

  // ------------------------------------------------------------------ admin passkey policy
  auth.events.on('login', ({ sid, method }) => {
    try { db.prepare('INSERT INTO session_amr(sid,method,ts) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET method=excluded.method, ts=excluded.ts').run(sid, method, Date.now()); } catch { /* best effort */ }
  });
  // Registered on the app before the /v1 router, so it runs ahead of every admin route.
  app.use('/v1/admin', (req, res, next) => {
    if (!req.auth || !settings().admin_passkey_required || !isStaff(req.auth.user)) return next();
    const amr = db.prepare('SELECT method FROM session_amr WHERE sid=?').get(req.auth.session.sid);
    if (amr && amr.method === 'passkey') return next();
    const e = new ApiError(403, 'passkey_required', 'staff must use a passkey for the admin panel', countFor(req.auth.user.id) ? 'confirm with your passkey, or sign in with it' : 'add a passkey in Account › Identity & privacy, then confirm with it');
    e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, has_passkey: countFor(req.auth.user.id) > 0 } });
    next(e);
  });

  return { countFor, close: () => {} };
}

module.exports = { mountWebAuthn, cborDecode, parseAuthData, coseToKey };
