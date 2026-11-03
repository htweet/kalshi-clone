'use strict';
// Shared helpers for the Phase 2 community modules (PHASE2_SPEC.md §24): token-bucket rate limits with a 429 envelope,
// text cleaning for posts / replies / chat lines, a per-route body-schema guard built on server/validate.js, the
// moderator check and the hash-chained audit append. Nothing here touches the database schema.
const { ApiError, E } = require('./util');
const { check } = require('./validate');
const { ROLE_PERMS } = require('./admin');
const auditChain = require('./audit-chain');

// Token bucket keyed by user id or IP; take() → 0 when allowed, else whole seconds until the next token.
function bucket(burst, perSec) {
  const m = new Map();
  return {
    take(key) {
      const now = Date.now();
      const b = m.get(key) || { tokens: burst, ts: now };
      b.tokens = Math.min(burst, b.tokens + ((now - b.ts) / 1000) * perSec);
      b.ts = now;
      m.set(key, b);
      if (b.tokens < 1) return Math.max(1, Math.ceil((1 - b.tokens) / perSec));
      b.tokens -= 1;
      return 0;
    },
    prune() { const now = Date.now(); for (const [k, b] of m) if (b.tokens + ((now - b.ts) / 1000) * perSec >= burst) m.delete(k); },
  };
}

// 429 too_many_requests with retry_after_sec in the standard envelope (the route sets Retry-After).
class LimitError extends ApiError {
  constructor(sec, why) { super(429, 'too_many_requests', 'too many requests', why || `slow down, try again in ${sec}s`); this.sec = sec; }
  toJSON() { const j = super.toJSON(); j.error.retry_after_sec = this.sec; return j; }
}
// Throws a LimitError (and sets Retry-After) when any of the buckets is empty for its key.
function limit(res, pairs, why) {
  let wait = 0;
  for (const [b, key] of pairs) wait = Math.max(wait, b.take(key));
  if (wait) { res.setHeader('Retry-After', String(wait)); throw new LimitError(wait, why); }
}

// C0 controls except tab / LF / CR (multi-line posts); bidi overrides, isolates and invisible direction marks.
const CONTROL_ML = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;
const CONTROL_LINE = new RegExp('[\\x00-\\x1F\\x7F-\\x9F' + String.fromCodePoint(0x2028, 0x2029) + ']');
const BIDI = new RegExp(`[${String.fromCodePoint(0x061c, 0x200e, 0x200f)}${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}]`);
const ZALGO = /\p{M}{6,}/u;

// Post / reply text: string, well-formed UTF-16, NFC, trimmed, at most `max` UTF-16 units (the existing client counter),
// line breaks allowed, other control and direction-override characters refused. Empty allowed only with a sticker.
function cleanText(raw, max, { allowEmpty = false, field = 'body', multiline = true } = {}) {
  if (raw == null || raw === '') { if (allowEmpty) return ''; throw E.badRequest(`${field} is required`); }
  if (typeof raw !== 'string') throw E.badRequest(`${field} must be a string`);
  if (raw.length > max * 4) throw E.badRequest(`${field} must be at most ${max} characters`);
  if (typeof raw.isWellFormed === 'function' && !raw.isWellFormed()) throw E.badRequest(`${field} contains invalid characters`);
  const s = raw.normalize('NFC').trim();
  if (!s) { if (allowEmpty) return ''; throw E.badRequest(`${field} is required`); }
  if ((multiline ? CONTROL_ML : CONTROL_LINE).test(s)) throw E.badRequest(`${field} cannot contain control characters${multiline ? '' : ' such as line breaks or tabs'}`);
  if (BIDI.test(s)) throw E.badRequest(`${field} cannot contain text-direction override characters`);
  if (ZALGO.test(s)) throw E.badRequest(`${field} contains too many combining marks`);
  if ((multiline ? s.length : [...s].length) > max) throw E.badRequest(`${field} must be at most ${max} characters`);
  return s;
}
const cleanReason = (raw, min = 3, max = 300) => {
  const r = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (r.length < min || r.length > max || CONTROL_LINE.test(r) || BIDI.test(r)) throw E.badRequest(`a reason of ${min}-${max} characters is required`);
  return r;
};

// Body schemas for the new write routes, same semantics as validateRoutes() in server/validate.js: requests that the
// route's own authorization will refuse (anonymous, another user's uid, non-staff on admin routes) skip validation so
// authorization errors keep precedence. table: [method, regexp on the /v1-relative path, schema, options, who].
function schemaGuard(table, { rolesOf }) {
  return (req, res, next) => {
    for (const [method, re, schema, opts, who] of table) {
      if (req.method !== method) continue;
      const m = re.exec(req.path);
      if (!m) continue;
      if (!req.auth) return next();
      if (who === 'owner' && m[1] && m[1] !== req.auth.user.id) return next();
      if (who === 'staff' && !rolesOf(req.auth.user).length) return next();
      try { check(req.body, schema, opts || {}); } catch (e) { return next(e); }
      return next();
    }
    next();
  };
}

const isModerator = (rolesOf, u) => !!u && rolesOf(u).some((r) => (ROLE_PERMS[r] || []).includes('social.moderate'));
const audit = (db, req, action, targetType, targetId, before, after, reason = '') =>
  auditChain.append(db, { actor_id: req.auth?.user.id || null, actor_email: req.auth?.user.email || null, action, target_type: targetType, target_id: targetId, before, after, reason });
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const NICK = /^[A-Za-z0-9_]{1,20}$/;
const TICKER = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

module.exports = { bucket, LimitError, limit, cleanText, cleanReason, schemaGuard, isModerator, audit, iso, NICK, TICKER, ID, BIDI, CONTROL_LINE };
