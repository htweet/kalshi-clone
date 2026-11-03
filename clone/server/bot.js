'use strict';
// Bot management (PLAN P1.10; CLONE_SPEC.md §21). Mirrors what the live site does at its edge (PLAN §2):
//   S1  a proof-of-work JS challenge (HTTP 429 + no-store) for suspicious HTML requests, passed with a short-lived signed
//       cookie bound to the client's IP + User-Agent hash;
//   S2  a signed client token (`X-Client-Token`, HMAC with the server secret, short TTL) issued to pages after load and
//       required on /v1 writes, on /v1/users/* reads and on the WebSocket upgrade (`ct` query parameter);
//   honeypot paths that answer 404 and raise a security event; tiered, persisted rate limits; a security event log.
// Everything stateful is in SQLite: settings (admin_settings), security_events, used challenge ids, rate buckets.
// The server secret comes from SECRET_KEY or a generated, gitignored data/secret.key (0600); it is never logged.
const crypto = require('node:crypto');
const { ApiError, E } = require('./util');

// The master secret (SECRET_KEY, or the generated 0600 data/secret.key) is shared with server/crypto.js, which derives a
// separate HKDF sub-key per purpose; this module only ever sees its own sub-key.
const keychain = require('./crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// Purpose-separated HMAC signer: tokens of one kind can never be replayed as another.
function signer(secret) {
  const keys = new Map();
  const key = (purpose) => { if (!keys.has(purpose)) keys.set(purpose, crypto.createHmac('sha256', secret).update(`purpose:${purpose}`).digest()); return keys.get(purpose); };
  const mac = (purpose, data) => crypto.createHmac('sha256', key(purpose)).update(data).digest('base64url');
  return {
    sign(purpose, obj) { const p = b64u(JSON.stringify(obj)); return `${p}.${mac(purpose, p)}`; },
    verify(purpose, tok) {
      if (typeof tok !== 'string' || tok.length > 2048) return null;
      const i = tok.indexOf('.');
      if (i < 1) return null;
      const p = tok.slice(0, i); const s = Buffer.from(tok.slice(i + 1)); const want = Buffer.from(mac(purpose, p));
      if (s.length !== want.length || !crypto.timingSafeEqual(s, want)) return null;
      try { const o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return o && typeof o === 'object' ? o : null; } catch { return null; }
    },
    digest(purpose, data) { return mac(purpose, data).slice(0, 22); },
  };
}

// ------------------------------------------------------------------------------------------------ heuristics
// Known automation / crawler user agents. HeadlessChrome is deliberately absent: a JS-capable headless browser solves
// the proof-of-work anyway, so challenging it only adds latency (residual risk documented in §21).
const AUTOMATION_UA = /(^node$|^node\.js|^deno\/|^bun\/|curl|wget|httpie|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|apache-httpclient|libwww|lwp::|node-fetch|undici|axios|got \(|scrapy|phantomjs|selenium|puppeteer|nutch|heritrix|masscan|zgrab|nikto|sqlmap|nuclei|gobuster|dirbuster|ffuf|feroxbuster|wpscan|gptbot|chatgpt-user|oai-searchbot|claudebot|claude-web|anthropic-ai|ccbot|perplexitybot|bytespider|amazonbot|applebot-extended|google-extended|meta-externalagent|cohere-ai|diffbot|imagesiftbot|omgili|timpibot|youbot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|\bbot\b|crawler|spider)/i;
const AI_CRAWLERS = ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-Web', 'anthropic-ai', 'CCBot', 'Google-Extended', 'PerplexityBot', 'Bytespider', 'Amazonbot', 'Applebot-Extended', 'meta-externalagent', 'FacebookBot', 'cohere-ai', 'Diffbot', 'ImagesiftBot', 'Omgilibot', 'Timpibot', 'YouBot'];

// Honeypot paths (PLAN P1.10 / P1.12): probes for secrets and server files. Answer 404 — never the SPA page — and log.
const HONEYPOT = [
  /(^|\/)\.(?!well-known(\/|$))[^/]*/, // any dot-file / dot-directory segment: /.env, /.git/config, /.DS_Store, /.npmrc …
  /^\/(wp-admin|wp-login|wp-content|wp-includes|xmlrpc|phpmyadmin|pma|cgi-bin|actuator|server-status|admin\.php|vendor\/phpunit)(\/|\.|$)/i,
  /^\/(server|data|node_modules|scripts|tests|dist|evidence|preview)(\/|$)/i,
  /^\/(package(-lock)?\.json|secret\.key|config\.(json|js|ya?ml)|docker-compose\.ya?ml|dockerfile)$/i,
  /\.(map|sqlite3?|db|db-wal|db-shm|sql|bak|old|orig|swp|env|key|pem|p12|pfx|log|ini|conf|cfg|php|aspx?|jsp|cgi|tar|tgz|gz|zip|7z|rar)$/i,
  /~$/,
];

function isHoneypot(p) {
  let d = p;
  try { d = decodeURIComponent(p); } catch { /* keep raw */ }
  d = d.replace(/\\/g, '/');
  return HONEYPOT.some((re) => re.test(d));
}

// ------------------------------------------------------------------------------------------------ challenge page
// Compact SHA-256 for the challenge page (no crypto.subtle: it is unavailable on plain-http non-localhost origins).
const POW_SOLVER = `function sha256(bytes){var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],n=bytes.length,l=((n+9+63)>>6)<<6,m=new Uint8Array(l),W=new Uint32Array(64),i,j;m.set(bytes);m[n]=0x80;var bits=n*8;m[l-4]=bits>>>24;m[l-3]=bits>>>16;m[l-2]=bits>>>8;m[l-1]=bits;
for(i=0;i<l;i+=64){for(j=0;j<16;j++)W[j]=(m[i+4*j]<<24)|(m[i+4*j+1]<<16)|(m[i+4*j+2]<<8)|m[i+4*j+3];for(j=16;j<64;j++){var a=W[j-15],b=W[j-2];W[j]=(((a>>>7)|(a<<25))^((a>>>18)|(a<<14))^(a>>>3))+W[j-7]+(((b>>>17)|(b<<15))^((b>>>19)|(b<<13))^(b>>>10))+W[j-16]|0;}
var A=H[0],B=H[1],C=H[2],D=H[3],E=H[4],F=H[5],G=H[6],Q=H[7];for(j=0;j<64;j++){var t1=Q+(((E>>>6)|(E<<26))^((E>>>11)|(E<<21))^((E>>>25)|(E<<7)))+((E&F)^(~E&G))+K[j]+W[j]|0,t2=(((A>>>2)|(A<<30))^((A>>>13)|(A<<19))^((A>>>22)|(A<<10)))+((A&B)^(A&C)^(B&C))|0;Q=G;G=F;F=E;E=D+t1|0;D=C;C=B;B=A;A=t1+t2|0;}
H[0]=H[0]+A|0;H[1]=H[1]+B|0;H[2]=H[2]+C|0;H[3]=H[3]+D|0;H[4]=H[4]+E|0;H[5]=H[5]+F|0;H[6]=H[6]+G|0;H[7]=H[7]+Q|0;}return H;}
function lz(h){var z=0;for(var i=0;i<8;i++){var w=h[i]>>>0;if(w===0){z+=32;continue;}return z+Math.clz32(w);}return z;}
function enc(s){var o=new Uint8Array(s.length);for(var i=0;i<s.length;i++)o[i]=s.charCodeAt(i)&255;return o;}
function solve(id,d){for(var n=0;n<1e9;n++){if(lz(sha256(enc(id+':'+n)))>=d)return String(n);}return null;}`;

function challengePage({ nonce, token, id, difficulty, verifyPath }) {
  const cfg = JSON.stringify({ t: token, id, d: difficulty, v: verifyPath }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Checking your browser · Parlance</title>
<style nonce="${nonce}">html,body{margin:0;height:100%;background:#0d0e11;color:#f4f5f7;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{min-height:100%;display:grid;place-content:center;gap:10px;text-align:center;padding:16px}b{font-size:22px}.s{color:#a8aeb8}.e{color:#ff5a6a}</style></head>
<body><main data-plx-challenge><b>Parlance</b><div>Checking your browser before opening the exchange…</div><div class="s" id="st">This takes a moment and happens once per session.</div>
<noscript><div class="e">JavaScript is required to continue.</div></noscript></main>
<script type="application/json" id="plx-challenge">${cfg}</script>
<script nonce="${nonce}">(function(){${POW_SOLVER}
var c=JSON.parse(document.getElementById('plx-challenge').textContent),st=document.getElementById('st');
setTimeout(function(){var nonce=solve(c.id,c.d);fetch(c.v,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:c.t,nonce:nonce})}).then(function(r){if(r.ok){location.reload();}else{st.className='e';st.textContent='Verification failed. Reload the page to try again.';}},function(){st.className='e';st.textContent='Network error. Reload the page to try again.';});},0);})();</script>
</body></html>`;
}

// ------------------------------------------------------------------------------------------------ factory
const DEFAULT_BOT = { challenge_mode: 'suspicious', pow_difficulty: 14, challenge_pass_ttl_seconds: 1800, client_token_ttl_seconds: 900, html_per_minute: 300 };
const BOT_LIMITS = { challenge_mode: ['off', 'suspicious', 'all'], pow_difficulty: [4, 24], challenge_pass_ttl_seconds: [60, 86400], client_token_ttl_seconds: [30, 86400], html_per_minute: [10, 100000] };
const TIERS = ['anonymous', 'user', 'admin', 'auth', 'write'];
const BOOT_TTL_MS = 10 * 60 * 1000;          // boot proof embedded in HTML
const CHALLENGE_TTL_MS = 2 * 60 * 1000;      // a served challenge must be solved within 2 minutes
const REFRESH_GRACE_MS = 12 * 3600 * 1000;   // an expired client token may still be traded for a fresh one for 12 h
// Credential endpoints (CLONE_SPEC §22.11): sign-up, sign-in, MFA sign-in, step-up, every /v1/auth/* route (login
// CSRF, first-admin setup, forced password change) and password changes. They share the stricter per-IP auth bucket.
// Phase 3 credential routes join the auth tier: password reset (+ confirm), email verification, passkey sign-in / step-up,
// OAuth start / callback / link, phone-code send and verify (CLONE_SPEC §25).
const AUTH_PATHS = /^\/v1\/(auth\/[^?]+|step_up|log_in[a-z_]*|users|users\/[^/]+\/password|password[a-z_/]*|passwords\/reset\/[^/]+\/confirm|verify_email|passkeys\/(authentication|step_up)(\/options)?|oauth\/[a-z]+\/(start|callback)|oauth\/link|users\/[^/]+\/verify_phone(\/send)?)$/;

function createBot({ db, dataDir, rate = {}, options = {}, clientIp, isSecure }) {
  const secret = keychain.deriveKey('bot-management:v1', { dir: dataDir });
  const sig = signer(secret);
  db.exec(`
CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, ip TEXT, ua TEXT, method TEXT, path TEXT, user_id TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS idx_security_events_ts ON security_events(ts);
CREATE INDEX IF NOT EXISTS idx_security_events_kind ON security_events(kind, ts);
CREATE TABLE IF NOT EXISTS security_challenges_used (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rate_buckets (key TEXT PRIMARY KEY, tokens REAL NOT NULL, ts INTEGER NOT NULL);`);

  // ---------------------------------------------------------------- settings (runtime-editable, persisted, G7)
  const anon = { burst: Number(rate.burst ?? 300), per_second: Number(rate.perSec ?? 150) };
  const tierDefaults = () => ({
    anonymous: { ...anon },
    user: { burst: anon.burst * 2, per_second: anon.per_second * 2 },
    admin: { burst: anon.burst * 5, per_second: anon.per_second * 5 },
    auth: { burst: 60, per_second: 1, ...(options.authRate || {}) },
    write: { burst: 300, per_second: 30, ...(options.writeRate || {}) },
  });
  const readSetting = (key) => { const r = db.prepare('SELECT value FROM admin_settings WHERE key=?').get(key); try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
  let settings;
  function reload() {
    const t = tierDefaults(); const savedT = readSetting('security.rate_limits') || {};
    for (const k of TIERS) if (savedT[k]) t[k] = { ...t[k], ...savedT[k] };
    settings = { rate_limits: t, bot: { ...DEFAULT_BOT, ...(options.challengeMode ? { challenge_mode: options.challengeMode } : {}), ...(options.bot || {}), ...(readSetting('security.bot') || {}) } };
    return settings;
  }
  reload();

  // Validates a partial update; throws {field: message} on error. Returns the merged values to persist.
  function validate(patch) {
    const errs = {}; const out = {};
    if (patch.rate_limits !== undefined) {
      const rl = {};
      if (!patch.rate_limits || typeof patch.rate_limits !== 'object') errs.rate_limits = 'must be an object';
      else for (const [tier, v] of Object.entries(patch.rate_limits)) {
        if (!TIERS.includes(tier)) { errs[`rate_limits.${tier}`] = 'unknown tier'; continue; }
        const cur = { ...settings.rate_limits[tier] };
        if (v.burst !== undefined) { const n = Number(v.burst); if (!Number.isInteger(n) || n < 1 || n > 1000000) errs[`rate_limits.${tier}.burst`] = 'must be a whole number from 1 to 1,000,000'; else cur.burst = n; }
        if (v.per_second !== undefined) { const n = Number(v.per_second); if (!Number.isFinite(n) || n <= 0 || n > 100000) errs[`rate_limits.${tier}.per_second`] = 'must be above 0 and at most 100,000'; else cur.per_second = n; }
        rl[tier] = cur;
      }
      out.rate_limits = rl;
    }
    if (patch.bot !== undefined) {
      const b = {};
      if (!patch.bot || typeof patch.bot !== 'object') errs.bot = 'must be an object';
      else for (const [k, v] of Object.entries(patch.bot)) {
        const lim = BOT_LIMITS[k];
        if (!lim) { errs[`bot.${k}`] = 'unknown setting'; continue; }
        if (typeof lim[0] === 'string') { if (!lim.includes(v)) errs[`bot.${k}`] = `must be one of ${lim.join(', ')}`; else b[k] = v; continue; }
        const n = Number(v);
        if (!Number.isInteger(n) || n < lim[0] || n > lim[1]) errs[`bot.${k}`] = `must be a whole number from ${lim[0]} to ${lim[1]}`; else b[k] = n;
      }
      out.bot = b;
    }
    return { errs, out };
  }
  function save(out, by, nowIso) {
    const put = db.prepare('INSERT INTO admin_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by');
    if (out.rate_limits) put.run('security.rate_limits', JSON.stringify({ ...(readSetting('security.rate_limits') || {}), ...out.rate_limits }), nowIso, by || null);
    if (out.bot) put.run('security.bot', JSON.stringify({ ...(readSetting('security.bot') || {}), ...out.bot }), nowIso, by || null);
    reload();
  }

  // ---------------------------------------------------------------- security event log
  const insertEvent = db.prepare('INSERT INTO security_events(ts,kind,ip,ua,method,path,user_id,detail) VALUES(?,?,?,?,?,?,?,?)');
  const logBuckets = new Map(); // per kind+ip throttle so a flood cannot flood the table
  let inserts = 0;
  function record(kind, req, detail) {
    const ip = req ? clientIp(req) : null;
    const k = `${kind}|${ip}`; const now = Date.now();
    const b = logBuckets.get(k) || { tokens: 20, ts: now };
    b.tokens = Math.min(20, b.tokens + ((now - b.ts) / 1000) / 3); b.ts = now; logBuckets.set(k, b);
    if (b.tokens < 1) return;
    b.tokens -= 1;
    if (logBuckets.size > 20000) logBuckets.clear();
    const ua = req ? String(req.headers['user-agent'] || '').slice(0, 300) : null;
    const p = req ? String(req.originalUrl || req.url || '').split('?')[0].slice(0, 300) : null;
    let d = detail == null ? null : JSON.stringify(detail);
    if (d && d.length > 4000) d = JSON.stringify({ truncated: d.slice(0, 3900) });
    try {
      insertEvent.run(now, kind, ip, ua, req ? req.method : null, p, req?.auth?.user?.id || null, d);
      if (++inserts % 500 === 0) { // retention: 30 days, at most 200k rows
        db.prepare('DELETE FROM security_events WHERE ts<?').run(now - 30 * 86400000);
        db.prepare('DELETE FROM security_events WHERE id <= (SELECT MAX(id) FROM security_events) - 200000').run();
        db.prepare('DELETE FROM security_challenges_used WHERE expires_at<?').run(now);
      }
    } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('security event', e.message); }
  }

  // ---------------------------------------------------------------- binding + tokens
  const bindOf = (req) => sig.digest('bind', `${clientIp(req)}\n${String(req.headers['user-agent'] || '')}`);
  const cookieName = (base, req) => (isSecure(req) ? `__Host-${base}` : base);
  const readCookie = (req, base, parseCookies) => {
    let c; try { c = parseCookies(req.headers.cookie); } catch { return null; } // malformed percent-encoding
    return c[`__Host-${base}`] || c[base] || null;
  };
  const setCookie = (res, req, base, value, maxAgeSec, sameSite) => {
    const attrs = [`${cookieName(base, req)}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`, `Max-Age=${maxAgeSec}`];
    if (isSecure(req)) attrs.push('Secure');
    res.append('Set-Cookie', attrs.join('; '));
  };

  const bootProof = (req) => sig.sign('boot', { t: Date.now(), b: bindOf(req) });
  function checkBoot(req, tok) {
    const o = sig.verify('boot', tok);
    return !!(o && o.b === bindOf(req) && Date.now() - o.t < BOOT_TTL_MS && o.t <= Date.now() + 60000);
  }
  function issueClientToken(req, res) {
    const ttl = settings.bot.client_token_ttl_seconds;
    const now = Date.now();
    const tok = sig.sign('ct', { t: now, e: now + ttl * 1000, b: bindOf(req) });
    setCookie(res, req, 'plx_ct', tok, ttl, 'Strict');
    return { token: tok, expires_in: ttl };
  }
  // -> { ok } | { ok:false, code, reason }
  function checkClientToken(req, tok, { grace = 0 } = {}) {
    if (!tok) return { ok: false, code: 'client_token_required', reason: 'missing' };
    const o = sig.verify('ct', tok);
    if (!o) return { ok: false, code: 'client_token_invalid', reason: 'bad signature' };
    if (o.b !== bindOf(req)) return { ok: false, code: 'client_token_invalid', reason: 'bound to another client' };
    if (!(o.e + grace > Date.now())) return { ok: false, code: 'client_token_invalid', reason: 'expired' };
    return { ok: true };
  }
  const passCookie = (req, parseCookies) => {
    const o = sig.verify('pass', readCookie(req, 'plx_chk', parseCookies));
    return !!(o && o.b === bindOf(req) && o.e > Date.now());
  };

  // ---------------------------------------------------------------- rate limits (tiered, persisted)
  const buckets = new Map(); // key -> {tokens, ts, dirty}
  for (const r of db.prepare('SELECT key, tokens, ts FROM rate_buckets WHERE ts>?').all(Date.now() - 3600000)) buckets.set(r.key, { tokens: r.tokens, ts: r.ts, dirty: false });
  function take(tier, id, cost = 1) {
    const cfg = settings.rate_limits[tier];
    const key = `${tier}:${id}`; const now = Date.now();
    const b = buckets.get(key) || { tokens: cfg.burst, ts: now };
    b.tokens = Math.min(cfg.burst, b.tokens + ((now - b.ts) / 1000) * cfg.per_second);
    b.ts = now; b.dirty = true;
    buckets.set(key, b);
    if (b.tokens < cost) return Math.max(1, Math.ceil((cost - b.tokens) / cfg.per_second));
    b.tokens -= cost;
    return 0;
  }
  const upsertBucket = db.prepare('INSERT INTO rate_buckets(key,tokens,ts) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET tokens=excluded.tokens, ts=excluded.ts');
  const deleteBucket = db.prepare('DELETE FROM rate_buckets WHERE key=?');
  function flush() {
    const now = Date.now();
    if (!db.isOpen || db.isTransaction || db.__inTx) return; // never interleave with another transaction; next tick retries
    let began = false;
    try {
      db.exec('BEGIN');
      began = true;
      for (const [key, b] of buckets) {
        const tier = key.slice(0, key.indexOf(':'));
        const cfg = settings.rate_limits[tier];
        const full = !cfg || b.tokens + ((now - b.ts) / 1000) * cfg.per_second >= cfg.burst;
        if (full) { buckets.delete(key); deleteBucket.run(key); continue; } // a full bucket is the default: no row needed
        if (b.dirty) { upsertBucket.run(key, b.tokens, b.ts); b.dirty = false; }
      }
      db.exec('COMMIT');
    } catch (e) { if (began) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } } if (!/not open|closed/i.test(e.message)) console.error('rate flush', e.message); }
  }
  const flushTimer = setInterval(flush, 2000);
  flushTimer.unref?.();

  let adminRoleStmt = null;
  const isStaff = (u) => {
    if (u.is_admin) return true;
    try { adminRoleStmt = adminRoleStmt || db.prepare('SELECT 1 FROM admin_roles WHERE user_id=? LIMIT 1'); return !!adminRoleStmt.get(u.id); } catch { return false; }
  };
  const tooMany = (req, res, next, tier, retry) => {
    res.setHeader('Retry-After', String(retry));
    record('rate_limited', req, { tier });
    next(E.tooMany());
  };
  // Mounted on /v1 and /trade-api after the session is attached (req.auth). One tier bucket per request, plus the
  // stricter auth bucket on credential endpoints and the write bucket on mutations.
  function limiter(req, res, next) {
    const ip = clientIp(req);
    const u = req.auth && req.auth.user;
    const tier = !u ? 'anonymous' : isStaff(u) ? 'admin' : 'user';
    let retry = take(tier, u ? u.id : ip);
    if (retry) return tooMany(req, res, next, tier, retry);
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (req.method !== 'OPTIONS' && AUTH_PATHS.test(req.originalUrl.split('?')[0])) { retry = take('auth', ip); if (retry) return tooMany(req, res, next, 'auth', retry); }
    if (write) { retry = take('write', u ? u.id : ip); if (retry) return tooMany(req, res, next, 'write', retry); }
    next();
  }
  // Pre-session endpoints handled before the session middleware: the challenge verify uses the auth bucket, the
  // client-token bootstrap (once per page load) the anonymous per-IP bucket.
  const preSessionLimit = (tier) => (req, res, next) => {
    const retry = take(tier, clientIp(req));
    if (retry) return tooMany(req, res, next, tier, retry);
    next();
  };

  // ---------------------------------------------------------------- HTML suspicion + challenge
  const htmlHits = new Map(); // ip -> {n, start}
  function htmlRate(ip) {
    const now = Date.now();
    let h = htmlHits.get(ip);
    if (!h || now - h.start > 60000) { h = { n: 0, start: now }; htmlHits.set(ip, h); if (htmlHits.size > 50000) htmlHits.clear(); }
    h.n += 1;
    return h.n;
  }
  // Score >= 3 means "suspicious". Real browsers send a browser UA, Accept: text/html and (on trustworthy origins)
  // Sec-Fetch-* navigation metadata; plain HTTP clients do not.
  function assess(req, trustworthy) {
    const h = req.headers; const reasons = [];
    let score = 0;
    const ua = String(h['user-agent'] || '');
    if (!ua) { score += 3; reasons.push('no user-agent'); } else if (AUTOMATION_UA.test(ua)) { score += 3; reasons.push('automation user-agent'); }
    if (!/text\/html/.test(String(h.accept || ''))) { score += 1; reasons.push('accept lacks text/html'); }
    const al = String(h['accept-language'] || '').trim();
    if (!al || al === '*') { score += 1; reasons.push('no accept-language'); }
    // Browsers mark top-level page loads as navigations (Sec-Fetch-Mode: navigate / Sec-Fetch-Dest: document).
    if (trustworthy && h['sec-fetch-mode'] !== 'navigate' && !['document', 'iframe', 'frame'].includes(h['sec-fetch-dest'])) { score += 2; reasons.push('not a browser navigation'); }
    if (/Chrome\//.test(ua) && trustworthy && !h['sec-ch-ua']) { score += 1; reasons.push('chrome UA without client hints'); }
    const n = htmlRate(clientIp(req));
    if (n > settings.bot.html_per_minute) { score += 3; reasons.push(`rate ${n}/min`); }
    return { score, reasons };
  }
  // -> null (serve the page) or {reasons} (serve the challenge)
  function shouldChallenge(req, trustworthy, parseCookies) {
    const mode = settings.bot.challenge_mode;
    if (mode === 'off') return null;
    if (passCookie(req, parseCookies)) return null;
    const a = assess(req, trustworthy);
    if (mode === 'all') return { reasons: ['challenge mode: all', ...a.reasons] };
    return a.score >= 3 ? a : null;
  }
  function challenge(req, res, nonce, reasons) {
    const id = b64u(crypto.randomBytes(12));
    const difficulty = settings.bot.pow_difficulty;
    const token = sig.sign('chal', { id, t: Date.now(), d: difficulty, b: bindOf(req) });
    record('challenge_served', req, { reasons });
    res.status(429);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Plx-Mitigated', 'challenge');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.method === 'HEAD' ? undefined : challengePage({ nonce, token, id, difficulty, verifyPath: '/v1/bot/challenge' }));
  }
  const powOk = (id, nonce, d) => {
    const h = crypto.createHash('sha256').update(`${id}:${nonce}`).digest();
    let z = 0;
    for (const byte of h) { if (byte === 0) { z += 8; continue; } z += Math.clz32(byte) - 24; break; }
    return z >= d;
  };
  const markUsed = db.prepare('INSERT INTO security_challenges_used(id,expires_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING');
  // POST /v1/bot/challenge {token, nonce}
  function verifyChallenge(req, res) {
    const body = req.body || {};
    const fail = (reason) => { record('challenge_failed', req, { reason }); res.status(403).json(new ApiError(403, 'challenge_failed', 'challenge verification failed', reason).toJSON()); };
    const o = sig.verify('chal', body.token);
    if (!o) return fail('bad signature');
    if (o.b !== bindOf(req)) return fail('bound to another client');
    if (Date.now() - o.t > CHALLENGE_TTL_MS) return fail('expired');
    if (typeof body.nonce !== 'string' || !/^\d{1,12}$/.test(body.nonce) || !powOk(o.id, body.nonce, o.d)) return fail('wrong proof of work');
    if (markUsed.run(o.id, Date.now() + CHALLENGE_TTL_MS).changes !== 1) return fail('replayed');
    const ttl = settings.bot.challenge_pass_ttl_seconds;
    setCookie(res, req, 'plx_chk', sig.sign('pass', { e: Date.now() + ttl * 1000, b: bindOf(req) }), ttl, 'Lax');
    record('challenge_passed', req, { difficulty: o.d, solve_ms: Date.now() - o.t });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, expires_in: ttl });
  }

  // POST /v1/client_token {boot} (+ optional current X-Client-Token / cookie, or a challenge pass cookie)
  function bootstrapClientToken(req, res, parseCookies) {
    const body = req.body || {};
    const current = req.get('x-client-token') || readCookie(req, 'plx_ct', parseCookies);
    const viaBoot = typeof body.boot === 'string' && checkBoot(req, body.boot);
    const viaToken = !viaBoot && current && checkClientToken(req, current, { grace: REFRESH_GRACE_MS }).ok;
    const viaPass = !viaBoot && !viaToken && passCookie(req, parseCookies);
    res.setHeader('Cache-Control', 'no-store');
    if (!viaBoot && !viaToken && !viaPass) {
      record('client_token_rejected', req, { stage: 'bootstrap' });
      return res.status(403).json(new ApiError(403, 'client_token_bootstrap_failed', 'could not issue a client token', 'reload the page').toJSON());
    }
    res.json(issueClientToken(req, res));
  }

  function close() { clearInterval(flushTimer); flush(); }

  return {
    settings: () => settings, reload, validate, save, record, isHoneypot, assess, shouldChallenge, challenge, verifyChallenge, bootstrapClientToken,
    bootProof, checkClientToken, readCookie, limiter, preSessionLimit, take, flush, close, AI_CRAWLERS,
  };
}

module.exports = { createBot, isHoneypot, AUTOMATION_UA, AI_CRAWLERS, DEFAULT_BOT };
