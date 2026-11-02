'use strict';
const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const newId = (prefix = '') => prefix + crypto.randomUUID();
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// Spec §5.1: prices are 4-decimal dollar strings, quantities 2-decimal fixed-point strings.
const dollars = (cents) => (cents == null ? null : (cents / 100).toFixed(4));
const fp = (n) => (n == null ? null : Number(n).toFixed(2));
const usd = (cents) => (cents / 100).toFixed(2);
// Event-contract quantities are stored as integer hundredths of a contract ("units", spec §16): 155 units = "1.55".
const UNITS = 100;
const ufp = (units) => (units == null ? null : (Number(units) / UNITS).toFixed(2));
const ustr = (units) => (Number(units) / UNITS).toLocaleString('en-US', { maximumFractionDigits: 2 });
// Parse a contract quantity (number or fixed-point string, at most 2 decimals) into units; null when invalid.
function toUnits(v) {
  if (v == null || v === '') return null;
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s) && !/^\d*\.\d{1,2}$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w || 0) * UNITS + Number((f + '00').slice(0, 2));
}

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  toJSON() {
    const e = { code: this.code, message: this.message };
    if (this.details !== undefined) e.details = this.details;
    return { error: e };
  }
}
const E = {
  badRequest: (details) => new ApiError(400, 'bad_request', 'bad request', details),
  unauthorized: () => new ApiError(401, 'token_authentication_failure', 'token authentication failure'),
  forbidden: (details) => new ApiError(403, 'forbidden', 'forbidden', details),
  notFound: () => new ApiError(404, 'not_found', 'not found'),
  conflict: (code, message, details) => new ApiError(409, code, message, details),
  tooMany: () => new ApiError(429, 'too_many_requests', 'too many requests'),
};

// Password hashing: scrypt with per-user salt.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, s, k] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 32);
  const want = Buffer.from(k, 'base64');
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}

// Opaque cursor (spec §5.1): base64url of a JSON offset.
const encCursor = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function decCursor(c) {
  if (!c) return null;
  try { return JSON.parse(Buffer.from(String(c), 'base64url').toString()); } catch { throw E.badRequest('invalid cursor'); }
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

module.exports = { nowIso, newId, token, dollars, fp, usd, UNITS, ufp, ustr, toUnits, ApiError, E, hashPassword, verifyPassword, encCursor, decCursor, slugify };
