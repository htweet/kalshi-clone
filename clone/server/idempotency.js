'use strict';
// Idempotency keys (PLAN P1.9; Kalshi's CORS allowlist accepts `Idempotency-Key`, PLAN §2 S4).
//
// A client sends `Idempotency-Key: <1-255 chars of [A-Za-z0-9_.:-]>` on a money-moving request. The first request with
// a key runs normally and its response (status + JSON body) is stored with the key, the user, the route and a SHA-256
// hash of the request (method, path, canonical JSON body). For 24 hours:
//   - the same key with the same request replays the stored response (header `Idempotent-Replayed: true`) without
//     running the handler again: no second order, deposit, withdrawal or transfer;
//   - the same key with a different request (other body or other route) → 409 `idempotency_key_conflict`;
//   - a request arriving while the first is still running → 409 `idempotency_key_in_progress` (retry later).
// Responses with status >= 500, 401/403 (e.g. step-up required), 408, 425 and 429 are not stored: the operation did
// not happen (or may not have), and the client retries with the same key.
// Keys are per user, persisted in SQLite (survive restarts) and purged after the TTL.
const crypto = require('node:crypto');
const { ApiError } = require('./util');

const TTL_MS = 24 * 3600 * 1000;
const IN_PROGRESS_STALE_MS = 60 * 1000; // a placeholder older than this belongs to a crashed request
const KEY_RE = /^[A-Za-z0-9_.:-]{1,255}$/;
// Outcomes that mean "nothing happened, try again with the same key" are not stored: server errors, and refusals before
// the operation ran (401/403 incl. step-up required and client-token errors, 408, 425, 429 rate limits).
const NOT_STORED = new Set([401, 403, 408, 425, 429]);
const storable = (status) => status < 500 && !NOT_STORED.has(status);

// Routes (relative to /v1) that honour the header. Path groups name the uid segment when there is one.
const ROUTES = [
  ['POST', /^\/users\/([^/]+)\/orders$/],
  ['POST', /^\/users\/([^/]+)\/deposits$/],
  ['POST', /^\/users\/([^/]+)\/withdrawals$/],
  ['POST', /^\/perps\/orders$/],
  ['POST', /^\/perps\/transfers$/],
  ['POST', /^\/perps\/positions\/[^/]+\/close$/],
  ['PUT', /^\/communications\/(?:rfqs\/[^/]+\/)?quotes\/[^/]+\/(?:accept|confirm)$/],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  response TEXT,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_ts);
`;

// Canonical JSON: object keys sorted, so {"a":1,"b":2} and {"b":2,"a":1} hash the same.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const requestHash = (req) => crypto.createHash('sha256').update(`${req.method} ${req.originalUrl}\n${canonical(req.body ?? {})}`).digest('hex');

function idempotency({ db, ttlMs = TTL_MS } = {}) {
  db.exec(SCHEMA);
  const get = db.prepare('SELECT * FROM idempotency_keys WHERE user_id=? AND idem_key=?');
  const insert = db.prepare('INSERT INTO idempotency_keys(user_id,idem_key,route,request_hash,status,response,created_ts) VALUES(?,?,?,?,NULL,NULL,?)');
  const finish = db.prepare('UPDATE idempotency_keys SET status=?, response=? WHERE user_id=? AND idem_key=?');
  const remove = db.prepare('DELETE FROM idempotency_keys WHERE user_id=? AND idem_key=?');
  const purge = db.prepare('DELETE FROM idempotency_keys WHERE created_ts < ?');
  let lastPurge = 0;

  const middleware = (req, res, next) => {
    const raw = req.get('idempotency-key');
    if (raw === undefined) return next();
    const route = ROUTES.find(([m, re]) => m === req.method && re.test(req.path));
    if (!route) return next(); // the header is ignored elsewhere (reads are naturally idempotent)
    // Requests the route itself will reject (anonymous, another user's uid) are left to it: authz errors come first.
    if (!req.auth) return next();
    const uidSeg = route[1].exec(req.path)[1];
    if (uidSeg && uidSeg !== req.auth.user.id) return next();
    const key = String(raw).trim();
    if (!KEY_RE.test(key)) return next(new ApiError(400, 'invalid_idempotency_key', 'invalid Idempotency-Key', 'use 1-255 characters: letters, digits, _ . : -'));

    const now = Date.now();
    if (now - lastPurge > 60000) { purge.run(now - ttlMs); lastPurge = now; }
    const uid = req.auth.user.id;
    const hash = requestHash(req);
    const row = get.get(uid, key);
    if (row && row.created_ts >= now - ttlMs) {
      if (row.request_hash !== hash) return next(new ApiError(409, 'idempotency_key_conflict', 'this Idempotency-Key was already used with a different request', 'use a new key for a new request'));
      if (row.status == null) {
        if (now - row.created_ts < IN_PROGRESS_STALE_MS) return next(new ApiError(409, 'idempotency_key_in_progress', 'a request with this Idempotency-Key is still being processed', 'retry shortly'));
        remove.run(uid, key); // stale placeholder from a request that never finished
      } else {
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(row.status);
        res.type('application/json');
        return res.send(row.response);
      }
    } else if (row) {
      remove.run(uid, key); // expired: the key may be reused
    }

    insert.run(uid, key, `${req.method} ${req.path}`, hash, now);
    let stored = false;
    const json = res.json.bind(res);
    res.json = (body) => {
      if (!stored) {
        stored = true;
        if (storable(res.statusCode)) finish.run(res.statusCode, JSON.stringify(body), uid, key);
        else remove.run(uid, key);
      }
      return json(body);
    };
    // Responses that never went through res.json (aborted connection, non-JSON error): drop the placeholder.
    res.on('close', () => { if (!stored) { stored = true; try { remove.run(uid, key); } catch { /* db closed during shutdown */ } } });
    next();
  };
  return { middleware, ROUTES, ttlMs };
}

module.exports = { idempotency, requestHash, canonical, IDEMPOTENT_ROUTES: ROUTES, TTL_MS };
