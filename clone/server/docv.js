'use strict';
// Document verification (PLAN A1; CLONE_SPEC §13.15; PHASE3_SPEC.md §25.4): "Let's get you verified" → "Continue on your
// phone" (QR) → the phone captures the ID front, back and a selfie → the desktop's "Stay on this page" screen follows
// the upload live → "Verifying info…" → outcome. A same-device upload is the fallback.
//
// Cross-device handoff:
//   • POST /users/:uid/docv/sessions creates a handoff: a 256-bit random token (stored as SHA-256 only) in a URL
//     `/verify/m#t=<token>`. The token sits in the fragment, so it never reaches server logs or Referer headers. It
//     is single use, expires after 10 minutes and is bound to the desktop session that created it (signing out there,
//     or starting a new handoff, kills it).
//   • The phone page claims it once (POST /docv/handoff/claim): the token is burned and the phone gets its own short
//     capture session — an HttpOnly SameSite=Strict cookie scoped to /v1/docv plus a CSRF value it sends as
//     X-Docv-Csrf. The capture session also ends when the desktop session ends.
// Uploads: JSON {kind, image: base64}; type-sniffed, metadata stripped and checked by server/images.js, then encrypted
// with the user's identity data key (AES-256-GCM, bound to the document id and user) into SQLite. There is no URL that
// serves an image: staff view one through an audited, reason-required call (support and admin roles).
// Retention: images are erased when a final decision is made (approved / rejected) or the user must start over, on
// account closure (the data key is destroyed), and by the retention job for abandoned uploads.
const crypto = require('node:crypto');
const { newId, token, ApiError, E } = require('./util');
const kc = require('./crypto');
const { check } = require('./validate');
const { sanitizeImage, ImageError } = require('./images');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docv_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, sid TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
  token_hash TEXT UNIQUE, token_expires_ts INTEGER NOT NULL, claimed_ts INTEGER, capture_hash TEXT, csrf_hash TEXT, capture_expires_ts INTEGER,
  uploads INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_docv_sessions_user ON docv_sessions(user_id, created_ts);
CREATE TABLE IF NOT EXISTS docv_documents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL, source TEXT NOT NULL, mime TEXT NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB, created_ts INTEGER NOT NULL, deleted_ts INTEGER, delete_reason TEXT);
CREATE INDEX IF NOT EXISTS idx_docv_documents_user ON docv_documents(user_id, kind);
`;
const KINDS = ['id_front', 'id_back', 'selfie'];
const KIND_LABEL = { id_front: 'ID front', id_back: 'ID back', selfie: 'Selfie' };
const HANDOFF_MS = 10 * 60000;
const CAPTURE_MS = 15 * 60000;
const MAX_UPLOADS = 15; // per handoff / device session
const COOKIE = 'plx_docv';
const MAGIC = Buffer.from('PDV1');

function sealBuf(key, aad, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}
function openBuf(key, aad, blob) {
  const b = Buffer.from(blob);
  if (!b.subarray(0, 4).equals(MAGIC)) throw new Error('not a sealed document');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(4, 16));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(b.subarray(16, 32));
  return Buffer.concat([d.update(b.subarray(32)), d.final()]);
}

function createDocv(ctx) {
  const { db, auth, kyc, profile, statusOf, setProfile, logEvent, audit, can, requireUser, origin, vault, security } = ctx;
  db.exec(SCHEMA);
  const secure = (req) => process.env.NODE_ENV === 'production' || !!req.secure;
  const setCookie = (req, res, value, maxAgeSec) => res.append('Set-Cookie', `${COOKIE}=${value}; Path=/v1/docv; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure(req) ? '; Secure' : ''}`);
  const readCookie = (req) => { const m = /(?:^|;\s*)plx_docv=([A-Za-z0-9_-]{20,80})/.exec(String(req.headers.cookie || '')); return m ? m[1] : null; };
  const docError = (msg) => new ApiError(400, 'image_invalid', 'this photo can’t be used', msg);

  // ------------------------------------------------------------------ storage
  function store(uid, sessionId, kind, b64, source) {
    let raw;
    const s = String(b64 || '');
    const m = /^data:image\/[a-z0-9.+-]+;base64,/i.exec(s);
    const body = m ? s.slice(m[0].length) : s;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw docError('upload a photo (JPEG or PNG)');
    try { raw = Buffer.from(body, 'base64'); } catch { throw docError('upload a photo (JPEG or PNG)'); }
    let img;
    try { img = sanitizeImage(raw); } catch (e) { if (e instanceof ImageError) throw docError(e.message); throw e; }
    const id = newId('doc_');
    const key = vault.dataKey(uid, true);
    const now = Date.now();
    // A new photo of the same kind replaces the previous one (erased, not just hidden).
    db.prepare("UPDATE docv_documents SET data=NULL, deleted_ts=?, delete_reason='replaced' WHERE user_id=? AND kind=? AND data IS NOT NULL").run(now, uid, kind);
    db.prepare('INSERT INTO docv_documents(id,user_id,session_id,kind,source,mime,width,height,bytes,sha256,data,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, uid, sessionId, kind, source, img.mime, img.width, img.height, img.data.length, img.sha256, sealBuf(key, `docv:${id}:${uid}`, img.data), now);
    return { id, kind, width: img.width, height: img.height };
  }
  function readDocument(uid, id) {
    const d = db.prepare('SELECT * FROM docv_documents WHERE id=? AND user_id=?').get(id, uid);
    if (!d || !d.data) return null;
    const key = vault.dataKey(uid, false);
    if (!key) return null;
    return { mime: d.mime, data: openBuf(key, `docv:${id}:${uid}`, d.data) };
  }
  const documentsMeta = (uid) => db.prepare('SELECT id, kind, source, mime, width, height, bytes, created_ts FROM docv_documents WHERE user_id=? AND data IS NOT NULL ORDER BY created_ts').all(uid)
    .map((d) => ({ id: d.id, kind: d.kind, label: KIND_LABEL[d.kind], source: d.source, mime: d.mime, width: d.width, height: d.height, bytes: d.bytes, uploaded_time: new Date(d.created_ts).toISOString() }));
  const uploadedKinds = (uid) => [...new Set(documentsMeta(uid).map((d) => d.kind))];
  function eraseDocuments(uid, reason) {
    const now = Date.now();
    const n = db.prepare('UPDATE docv_documents SET data=NULL, deleted_ts=?, delete_reason=? WHERE user_id=? AND data IS NOT NULL').run(now, reason, uid).changes;
    db.prepare("UPDATE docv_sessions SET status='closed', capture_hash=NULL, csrf_hash=NULL, updated_ts=? WHERE user_id=? AND status IN ('created','claimed')").run(now, uid);
    if (n) logEvent(uid, 'documents_erased', null, { count: n, reason });
    return n;
  }

  // ------------------------------------------------------------------ sessions
  const sessionVo = (s) => (s ? { id: s.id, mode: s.mode, status: s.status, phone_connected: !!s.claimed_ts, expires_time: new Date(s.status === 'created' ? s.token_expires_ts : s.capture_expires_ts || s.token_expires_ts).toISOString() } : null);
  const latest = (uid) => db.prepare('SELECT * FROM docv_sessions WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 1').get(uid);
  function expireStale(s) {
    if (!s) return s;
    const now = Date.now();
    const dead = (s.status === 'created' && s.token_expires_ts < now) || (s.status === 'claimed' && (s.capture_expires_ts < now || !auth.sessionAlive(s.sid)));
    if (dead) {
      db.prepare("UPDATE docv_sessions SET status='expired', capture_hash=NULL, csrf_hash=NULL, updated_ts=? WHERE id=?").run(now, s.id);
      return { ...s, status: 'expired' };
    }
    return s;
  }
  function stateFor(uid) {
    const s = expireStale(latest(uid));
    const kinds = uploadedKinds(uid);
    return { identity_status: statusOf(uid), session: sessionVo(s), documents: KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k], uploaded: kinds.includes(k) })), complete: KINDS.every((k) => kinds.includes(k)) };
  }
  const needDocs = (uid) => {
    const st = statusOf(uid);
    if (st !== 'documents_required') throw E.conflict('documents_not_required', 'document verification isn’t open for this account', st === 'approved' ? 'your identity is already verified' : 'finish the earlier steps first');
  };
  function submit(uid, req) {
    needDocs(uid);
    const kinds = uploadedKinds(uid);
    const missing = KINDS.filter((k) => !kinds.includes(k));
    if (missing.length) throw E.conflict('documents_incomplete', 'add every photo first', `missing: ${missing.map((k) => KIND_LABEL[k]).join(', ')}`);
    db.prepare("UPDATE docv_sessions SET status='submitted', capture_hash=NULL, csrf_hash=NULL, updated_ts=? WHERE user_id=? AND status IN ('created','claimed')").run(Date.now(), uid);
    kyc.submitDocuments(uid, req);
  }

  // Capture session (phone) from the cookie + CSRF header; refuses when the desktop session has ended.
  function capture(req, { write }) {
    const raw = readCookie(req);
    const s = raw && db.prepare('SELECT * FROM docv_sessions WHERE capture_hash=?').get(kc.sha256hex(raw));
    const live = s && expireStale(s);
    if (!live || live.status !== 'claimed') throw new ApiError(401, 'handoff_expired', 'this verification link has expired', 'start again from your computer');
    if (write && !kc.safeEqual(kc.sha256hex(String(req.get('x-docv-csrf') || '')), live.csrf_hash || '')) throw E.forbidden('missing or invalid x-docv-csrf');
    return live;
  }

  function mountRoutes(v1) {
    const IMG = { kind: { type: 'string', enum: KINDS, required: true }, image: { type: 'string', maxLen: 9_000_000, required: true } };

    // ---- desktop (signed-in owner)
    v1.get('/users/:uid/docv', requireUser, (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(stateFor(req.auth.user.id)); });
    v1.post('/users/:uid/docv/sessions', requireUser, (req, res) => {
      const uid = req.auth.user.id;
      needDocs(uid);
      const now = Date.now();
      db.prepare("UPDATE docv_sessions SET status='replaced', capture_hash=NULL, csrf_hash=NULL, updated_ts=? WHERE user_id=? AND status IN ('created','claimed')").run(now, uid);
      const t = token(32);
      const id = newId('dvs_');
      db.prepare('INSERT INTO docv_sessions(id,user_id,sid,mode,status,token_hash,token_expires_ts,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, uid, req.auth.session.sid, 'phone', 'created', kc.sha256hex(t), now + HANDOFF_MS, now, now);
      setProfile(uid, { skipped_at: null });
      logEvent(uid, 'docv_handoff_created', req, { session: id });
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({ ...stateFor(uid), handoff_url: `${origin(req)}/verify/m#t=${t}`, expires_time: new Date(now + HANDOFF_MS).toISOString() });
    });
    v1.post('/users/:uid/docv/documents', requireUser, (req, res) => {
      const b = check(req.body, IMG, { unknown: 'reject' });
      const uid = req.auth.user.id;
      needDocs(uid);
      const recent = db.prepare("SELECT COUNT(*) c FROM docv_documents WHERE user_id=? AND source='device' AND created_ts>?").get(uid, Date.now() - 3600000).c;
      if (recent >= MAX_UPLOADS) throw new ApiError(429, 'too_many_uploads', 'too many photos uploaded', 'try again later');
      const d = store(uid, null, b.kind, b.image, 'device');
      logEvent(uid, 'docv_uploaded', req, { kind: b.kind, source: 'device' });
      res.status(201).json({ document: { kind: d.kind, width: d.width, height: d.height }, ...stateFor(uid) });
    });
    v1.post('/users/:uid/docv/submit', requireUser, (req, res) => {
      submit(req.auth.user.id, req);
      res.status(202).json(stateFor(req.auth.user.id));
    });
    // "Exit identity verification": progress (already uploaded photos) is kept; the open handoff link stops working.
    v1.post('/users/:uid/docv/exit', requireUser, (req, res) => {
      const uid = req.auth.user.id;
      db.prepare("UPDATE docv_sessions SET status='exited', capture_hash=NULL, csrf_hash=NULL, updated_ts=? WHERE user_id=? AND status IN ('created','claimed')").run(Date.now(), uid);
      if (statusOf(uid) === 'documents_required') setProfile(uid, { skipped_at: new Date().toISOString() });
      logEvent(uid, 'docv_exited', req, { kept: uploadedKinds(uid).length });
      res.json(stateFor(uid));
    });

    // ---- phone (no account session; the handoff token, then the capture cookie)
    v1.post('/docv/handoff/claim', (req, res) => {
      const b = check(req.body, { token: { type: 'string', maxLen: 64, required: true } }, { unknown: 'reject' });
      const s = db.prepare('SELECT * FROM docv_sessions WHERE token_hash=?').get(kc.sha256hex(b.token));
      const now = Date.now();
      const gone = (code, msg) => { if (s) logEvent(s.user_id, 'docv_handoff_refused', req, { session: s.id, reason: code }); return new ApiError(410, code, msg, 'start again from your computer'); };
      if (!s) throw new ApiError(410, 'handoff_invalid', 'this verification link isn’t valid', 'start again from your computer');
      if (s.status !== 'created' || s.claimed_ts) throw gone('handoff_used', 'this verification link was already used');
      if (s.token_expires_ts < now) throw gone('handoff_expired', 'this verification link has expired');
      if (!auth.sessionAlive(s.sid) || statusOf(s.user_id) !== 'documents_required') throw gone('handoff_invalid', 'this verification link isn’t valid any more');
      const cap = token(24); const csrf = token(24);
      // Single use: the token row is burned with a conditional update, so two phones cannot both claim it.
      if (db.prepare("UPDATE docv_sessions SET status='claimed', claimed_ts=?, capture_hash=?, csrf_hash=?, capture_expires_ts=?, updated_ts=? WHERE id=? AND status='created' AND claimed_ts IS NULL")
        .run(now, kc.sha256hex(cap), kc.sha256hex(csrf), now + CAPTURE_MS, now, s.id).changes !== 1) throw gone('handoff_used', 'this verification link was already used');
      setCookie(req, res, cap, Math.floor(CAPTURE_MS / 1000));
      logEvent(s.user_id, 'docv_handoff_claimed', req, { session: s.id });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ capture_csrf: csrf, expires_time: new Date(now + CAPTURE_MS).toISOString(), ...phoneState(s.user_id) });
    });
    const phoneState = (uid) => { const st = stateFor(uid); return { documents: st.documents, complete: st.complete, identity_status: st.identity_status === 'documents_required' ? 'documents_required' : 'submitted' }; };
    v1.get('/docv/handoff', (req, res) => {
      const s = capture(req, { write: false });
      res.setHeader('Cache-Control', 'no-store');
      res.json(phoneState(s.user_id));
    });
    v1.post('/docv/handoff/documents', (req, res) => {
      const s = capture(req, { write: true });
      const b = check(req.body, IMG, { unknown: 'reject' });
      if (statusOf(s.user_id) !== 'documents_required') throw E.conflict('documents_not_required', 'these photos were already sent');
      if (db.prepare('UPDATE docv_sessions SET uploads=uploads+1, updated_ts=? WHERE id=? AND uploads<?').run(Date.now(), s.id, MAX_UPLOADS).changes !== 1) throw new ApiError(429, 'too_many_uploads', 'too many photos uploaded', 'start again from your computer');
      const d = store(s.user_id, s.id, b.kind, b.image, 'phone');
      logEvent(s.user_id, 'docv_uploaded', req, { kind: b.kind, source: 'phone', session: s.id });
      res.status(201).json({ document: { kind: d.kind, width: d.width, height: d.height }, ...phoneState(s.user_id) });
    });
    v1.post('/docv/handoff/submit', (req, res) => {
      const s = capture(req, { write: true });
      submit(s.user_id, req);
      setCookie(req, res, '', 0);
      res.status(202).json(phoneState(s.user_id));
    });

    // ---- staff: documents of an applicant (metadata), and one audited, reason-required view
    v1.get('/admin/kyc/:userId/documents', can('users.read'), (req, res) => {
      const u = db.prepare('SELECT id FROM users WHERE id=? OR email=?').get(String(req.params.userId), String(req.params.userId).toLowerCase());
      if (!u) throw E.notFound();
      res.json({ documents: documentsMeta(u.id), erased: db.prepare('SELECT kind, deleted_ts, delete_reason FROM docv_documents WHERE user_id=? AND data IS NULL ORDER BY deleted_ts DESC LIMIT 20').all(u.id)
        .map((d) => ({ kind: d.kind, erased_time: new Date(d.deleted_ts).toISOString(), reason: d.delete_reason })) });
    });
    v1.post('/admin/kyc/:userId/documents/:docId/view', can('users.support'), (req, res) => {
      const b = check(req.body, { reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
      const reason = b.reason.trim();
      if (reason.length < 5) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: give a reason of at least 5 characters (recorded in the audit log)');
      const u = db.prepare('SELECT id FROM users WHERE id=? OR email=?').get(String(req.params.userId), String(req.params.userId).toLowerCase());
      if (!u) throw E.notFound();
      const meta = db.prepare('SELECT kind FROM docv_documents WHERE id=? AND user_id=?').get(String(req.params.docId), u.id);
      const doc = meta && readDocument(u.id, String(req.params.docId));
      if (!doc) throw E.notFound();
      audit(req, 'kyc.document_view', u.id, null, { document: String(req.params.docId), kind: meta.kind }, reason); // never the image
      logEvent(u.id, 'identity_viewed_by_staff', req, { field: `document:${meta.kind}` });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ kind: meta.kind, mime: doc.mime, data_url: `data:${doc.mime};base64,${doc.data.toString('base64')}` });
    });
  }

  // Abandoned uploads (never submitted, or the account left onboarding) are erased after `days`.
  function purge(days) {
    const cut = Date.now() - days * 86400000;
    for (const r of db.prepare("SELECT DISTINCT d.user_id FROM docv_documents d LEFT JOIN identity_profiles p ON p.user_id=d.user_id WHERE d.data IS NOT NULL AND d.created_ts<? AND COALESCE(p.status,'') NOT IN ('review','pending')").all(cut)) eraseDocuments(r.user_id, 'retention');
    db.prepare('DELETE FROM docv_sessions WHERE updated_ts<?').run(Date.now() - 30 * 86400000);
  }

  return { mountRoutes, stateFor, documentsMeta, eraseDocuments, readDocument, purge, KINDS, security };
}

module.exports = { createDocv, sealBuf, openBuf, KINDS };
