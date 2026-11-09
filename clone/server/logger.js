'use strict';
// Structured logs (PLAN P9.4, CLONE_SPEC.md §39.5). One JSON object per line on stdout (errors on stderr):
//   {"ts":"…","level":"info","msg":"request","request_id":"…","method":"GET","route":"orders","status":200,"ms":3.1}
// The request id comes from the proxy's X-Request-Id when the proxy is trusted (else it is generated), is echoed in the
// response, and follows the request into everything it triggers (AsyncLocalStorage), the WebSocket connection and jobs.
//
// Scrubbing (S11, PLAN §2): every line passes through scrub() before it is written — keys that name secrets (password,
// token, secret, cookie, authorization, api key, private key, card, cvv, …) are replaced whole, and in every string value
// email addresses, phone numbers, bearer tokens, JWTs, PEM keys, long hex / base64 secrets, card numbers (Luhn-checked)
// and 11-digit national ids are masked; query strings are dropped from URLs. The level is the owner setting `logs.level`
// (live); LOG_FORMAT=pretty prints the same records for a terminal.
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const als = new AsyncLocalStorage();

const SECRET_KEY_RE = /pass(word|wd|phrase)?|secret|token|cookie|authori[sz]ation|api[_-]?key|private[_-]?key|signature|^sig$|card(_?number)?$|^pan$|cvv|cvc|otp|totp|mfa_code|^code$|session|csrf|credential|bvn|^nin$|national_id/i;
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[key]'],
  [/\b(Bearer|Basic|AWS4-HMAC-SHA256)\s+[A-Za-z0-9._~+/=,:-]{8,}/gi, '$1 [token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b(?:enc:v\d+:|PARLANCE-[A-Z]+-)\S+/g, '[secret]'],
  // Card numbers: 13-19 digits, optionally grouped by spaces or dashes, replaced only when the Luhn check passes.
  [/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/[ -]/g, '')) ? '[card]' : m)],
  // Phone numbers: +<country><number>, or a Nigerian 0 + 10 digits; 11-digit NIN / BVN.
  [/\+\d[\d ()-]{7,16}\d/g, '[phone]'],
  [/\b0[789][01]\d{8}\b/g, '[phone]'],
  [/\b\d{11}\b/g, '[id]'],
  // Long opaque secrets: 32+ hex characters or 32+ base64url characters with mixed classes.
  [/\b[0-9a-fA-F]{32,}\b/g, '[hex]'],
  [/\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, '[token]'],
  // Query strings carry tokens (unsubscribe links, share links, signed URLs): keep only the path.
  [/(https?:\/\/[^\s?#"']+|\/[A-Za-z0-9._~/%-]+)\?[^\s"'#]*/g, '$1?[query]'],
];
const SAFE_IDS = new Set(['request_id', 'trace_id', 'span_id', 'parent_span_id', 'ts', 'level']);
function luhn(d) {
  if (!/^\d{13,19}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < d.length; i++) { let n = Number(d[d.length - 1 - i]); if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; }
  return s % 10 === 0;
}
function scrubString(s) {
  let out = String(s);
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out.length > 4000 ? `${out.slice(0, 4000)}…` : out;
}
// Deep copy with secrets removed. Depth- and size-limited so a huge or cyclic object cannot stall logging.
function scrub(v, depth = 0, seen = new WeakSet()) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return scrubString(v);
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (v instanceof Error) return { name: v.name, message: scrubString(v.message), code: v.code, stack: v.stack ? scrubString(v.stack.split('\n').slice(0, 8).join('\n')) : undefined };
  if (Buffer.isBuffer(v)) return `[${v.length} bytes]`;
  if (depth > 6) return '[depth]';
  if (typeof v === 'object') {
    if (seen.has(v)) return '[cycle]';
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1, seen));
    const out = {};
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      if (++n > 60) { out['…'] = 'truncated'; break; }
      if (SAFE_IDS.has(k) && typeof x === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(x)) { out[k] = x; continue; } // correlation ids stay usable
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : scrub(x, depth + 1, seen);
    }
    return out;
  }
  return String(v);
}

function createLogger({ level = () => 'info', format = process.env.LOG_FORMAT || 'json', out = process.stdout, err = process.stderr, base = {} } = {}) {
  const lvl = typeof level === 'function' ? level : () => level;
  const sinks = []; // extra observers (tests, the span exporter)
  function write(levelName, msg, fields) {
    if ((LEVELS[levelName] || 20) < (LEVELS[lvl()] || 20)) return;
    const ctx = als.getStore();
    const rec = scrub({ ts: new Date().toISOString(), level: levelName, msg, ...base, ...(ctx ? ctx.fields : {}), ...(fields || {}) });
    for (const s of sinks) { try { s(rec); } catch { /* observer errors never break logging */ } }
    const line = format === 'pretty' ? `${rec.ts} ${levelName.toUpperCase().padEnd(5)} ${rec.msg}${Object.keys(rec).length > 3 ? ` ${JSON.stringify(Object.fromEntries(Object.entries(rec).filter(([k]) => !['ts', 'level', 'msg'].includes(k))))}` : ''}` : JSON.stringify(rec);
    (LEVELS[levelName] >= LEVELS.warn ? err : out).write(`${line}\n`);
  }
  const L = {
    debug: (msg, f) => write('debug', msg, f), info: (msg, f) => write('info', msg, f), warn: (msg, f) => write('warn', msg, f), error: (msg, f) => write('error', msg, f),
    log: (rec) => { const { level: l = 'info', msg = '', ...f } = rec || {}; write(LEVELS[l] ? l : 'info', msg, f); },
    sinks, level: lvl,
  };
  return L;
}

// Routes console.* through the logger (CLI start in production): legacy console lines become scrubbed JSON records.
function installConsole(logger) {
  const fmt = (args) => args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message}` : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
  const errOf = (args) => args.find((a) => a instanceof Error);
  console.log = (...a) => logger.info(fmt(a));
  console.info = (...a) => logger.info(fmt(a));
  console.warn = (...a) => logger.warn(fmt(a));
  console.error = (...a) => { const e = errOf(a); logger.error(fmt(a), e ? { error: e } : undefined); };
}

// Request ids: the proxy's id when the proxy is trusted and the id looks like one, else a new one.
const ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const newRequestId = () => crypto.randomBytes(12).toString('hex');
function requestIdOf(req, trusted) {
  const h = trusted ? req.headers['x-request-id'] : null;
  return typeof h === 'string' && ID_RE.test(h) ? h : newRequestId();
}
const run = (fields, fn) => als.run({ fields }, fn);
const context = () => als.getStore()?.fields || {};

module.exports = { createLogger, installConsole, scrub, scrubString, luhn, requestIdOf, newRequestId, run, context, als, LEVELS };
