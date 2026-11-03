'use strict';
// Perimeter security middleware (PLAN Phase 1A: P1.1 headers + CSP, P1.3 CORS, P1.10 bot management wiring, P1.11 asset
// hygiene, P1.12 static allowlist; SEC_PERIMETER_SPEC.md §21). Evidence for each control is PLAN §2 S1–S12.
//
// Request order (server/app.js):
//   early()        security headers + per-response CSP nonce, CORS, robots.txt, honeypots, CSP reports, challenge verify,
//                  client-token bootstrap  — all before body parsing and the session/CSRF middleware
//   apiGuard()     after the session is attached: tiered rate limits, client token on /v1 writes
//   mountStatic()  explicit static allowlist, hashed immutable assets (dist) or sources (dev), SPA page template with
//                  the nonce and boot proof injected, bot challenge for suspicious HTML requests
// The WebSocket upgrade is checked by checkUpgrade() from server/ws.js (origin allowlist + client token).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createBot } = require('./bot');
const { ApiError } = require('./util');

const PUBLIC = path.join(__dirname, '..', 'public');
const DIST = path.join(__dirname, '..', 'dist');
const API = /^\/(v1|trade-api)(\/|$)/;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const PERMISSIONS = 'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), browsing-topics=()';
const ALLOW_HEADERS = 'Content-Type, X-Csrf-Token, Idempotency-Key, X-Client-Token';
const EXPOSE_HEADERS = 'X-Csrf-Token, Etag';
const HOST_OK = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

const parseTrust = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' || v === '' || v == null ? false : /^\d+$/.test(String(v)) ? Number(v) : String(v));
const normOrigin = (o) => { try { const u = new URL(o); return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.host}`.toLowerCase() : null; } catch { return null; } };

function robotsTxt(aiCrawlers) {
  return [
    '# Parlance Exchange crawler policy.',
    '# Advisory only: robots.txt asks well-behaved crawlers to stay away; it is not access control. Enforcement is the',
    '# bot challenge, client tokens and rate limits (see SEC_PERIMETER_SPEC.md section 21).',
    '',
    '# AI training / answer-engine crawlers: no access.',
    ...aiCrawlers.map((n) => `User-agent: ${n}`),
    'Disallow: /',
    '',
    'User-agent: *',
    'Disallow: /v1/',
    'Disallow: /trade-api/',
    'Disallow: /admin',
    'Disallow: /account',
    'Disallow: /portfolio',
    'Disallow: /notifications',
    'Allow: /',
    '',
  ].join('\n');
}

function createSecurity({ app, db, rate, parseCookies, options = {} }) {
  const production = process.env.NODE_ENV === 'production';
  const trust = parseTrust(options.trustProxy ?? process.env.TRUST_PROXY);
  if (trust !== false) app.set('trust proxy', trust);
  const configured = (options.allowedOrigins || String(process.env.ALLOWED_ORIGINS || '').split(',')).map((s) => normOrigin(String(s).trim())).filter(Boolean);
  const allowed = new Set(configured);
  const assets = options.assets === 'dist' ? 'dist' : 'src';
  const dataDir = options.dataDir || (() => {
    try { const f = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main')?.file; if (f) return path.dirname(f); } catch { /* fall through */ }
    return path.join(__dirname, '..', 'data');
  })();

  // Express request semantics (req.ip / req.secure / req.protocol honour `trust proxy`) for raw upgrade requests too.
  const asExpress = (req) => {
    if (req.app) return req;
    const r = Object.create(app.request);
    Object.assign(r, { app, headers: req.headers, socket: req.socket, connection: req.socket, url: req.url, originalUrl: req.url, method: req.method });
    return r;
  };
  const clientIp = (req) => asExpress(req).ip || req.socket?.remoteAddress || 'unknown';
  const isSecure = (req) => production || !!asExpress(req).secure;
  const selfOrigin = (req) => { const r = asExpress(req); const host = r.headers.host; return host && HOST_OK.test(host) ? `${r.protocol}://${host}`.toLowerCase() : null; };
  const originAllowed = (req, origin) => { const o = normOrigin(origin); return !!o && (allowed.has(o) || o === selfOrigin(req)); };
  // Sec-Fetch-* metadata is only sent to potentially trustworthy origins (https, localhost).
  const trustworthy = (req) => isSecure(req) || /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(String(req.headers.host || ''));

  const bot = createBot({ db, dataDir, rate, options, clientIp, isSecure });

  // ---------------------------------------------------------------- headers + nonce (P1.1; S5, S6, S12)
  function siteCsp(req, nonce) {
    const so = selfOrigin(req);
    const host = so ? so.replace(/^https?:\/\//, '') : null;
    return [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self'${host ? ` ws://${host} wss://${host}` : ''}`,
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
      "manifest-src 'self'",
      "worker-src 'self'",
      'report-uri /v1/csp-report',
      'report-to csp',
    ].join('; ');
  }
  const setSiteCsp = (req, res, nonce) => {
    res.setHeader('Content-Security-Policy', siteCsp(req, nonce));
    const so = selfOrigin(req);
    if (so) res.setHeader('Reporting-Endpoints', `csp="${so}/v1/csp-report"`);
  };

  function headers(req, res, next) {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', API_CSP); // replaced by the site policy on HTML responses
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', PERMISSIONS);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (production || (trust !== false && req.secure)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // Authenticated and user-scoped responses are never cached (S5). req.auth is attached later, so decide at write time.
    const writeHead = res.writeHead;
    res.writeHead = function patched(...args) {
      if (req.auth || /^\/v1\/users(\/|$)/.test(req.path)) this.setHeader('Cache-Control', 'no-store');
      return writeHead.apply(this, args);
    };
    next();
  }

  // ---------------------------------------------------------------- CORS (P1.3; S4)
  function cors(req, res, next) {
    const origin = req.headers.origin;
    if (!origin) return next();
    res.vary('Origin');
    const ok = originAllowed(req, origin);
    const deny = () => {
      bot.record('cors_rejected', req, { origin: String(origin).slice(0, 200) });
      res.status(403).json(new ApiError(403, 'origin_not_allowed', 'origin not allowed').toJSON());
    };
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      if (!ok) return deny();
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    if (ok) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS);
    } else if (!SAFE.has(req.method)) return deny(); // cross-site form posts and other foreign writes stop here
    next();
  }

  // ---------------------------------------------------------------- CSP violation reports
  const reportBody = express.text({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' });
  const reportBuckets = new Map();
  const reportAllowed = (ip) => {
    const now = Date.now(); const b = reportBuckets.get(ip) || { t: 20, ts: now };
    b.t = Math.min(20, b.t + (now - b.ts) / 5000); b.ts = now; reportBuckets.set(ip, b);
    if (reportBuckets.size > 20000) reportBuckets.clear();
    if (b.t < 1) return false;
    b.t -= 1; return true;
  };
  const clip = (v, n) => (v == null ? undefined : String(v).slice(0, n));
  const noQuery = (v) => (v == null ? undefined : clip(String(v).split(/[?#]/)[0], 300));
  function cspReport(req, res) {
    if (!/^application\/(csp-report|reports\+json|json)\b/i.test(String(req.headers['content-type'] || ''))) return res.status(415).end();
    reportBody(req, res, (err) => {
      if (err) return res.status(err.status === 413 ? 413 : 400).end();
      if (!reportAllowed(clientIp(req))) return res.status(204).end();
      let j; try { j = JSON.parse(String(req.body || '')); } catch { return res.status(400).end(); }
      const list = Array.isArray(j) ? j.filter((r) => r && r.type === 'csp-violation').map((r) => r.body || {}) : j && j['csp-report'] ? [j['csp-report']] : [];
      for (const r of list.slice(0, 10)) {
        bot.record('csp_report', req, {
          document: noQuery(r.documentURL ?? r['document-uri']), blocked: noQuery(r.blockedURL ?? r['blocked-uri']),
          directive: clip(r.effectiveDirective ?? r['effective-directive'] ?? r['violated-directive'], 80), disposition: clip(r.disposition, 20),
          source: noQuery(r.sourceFile ?? r['source-file']), line: Number(r.lineNumber ?? r['line-number']) || undefined, sample: clip(r.sample ?? r['script-sample'], 80),
        });
      }
      res.status(204).end();
    });
  }

  const smallJson = express.json({ limit: '4kb' });
  const notFound = (res) => { res.status(404).setHeader('Cache-Control', 'no-store'); res.type('text/plain').send('Not found'); };
  const ROBOTS = robotsTxt(bot.AI_CRAWLERS);
  const run = (fns, req, res, last) => { let i = 0; const step = (err) => { if (err) return last(err); const f = fns[i++]; if (!f) return last(); f(req, res, step); }; step(); };

  function early(req, res, next) {
    headers(req, res, () => cors(req, res, () => {
      if (res.headersSent) return;
      const p = req.path;
      if (p === '/robots.txt' && SAFE.has(req.method)) { res.setHeader('Cache-Control', 'public, max-age=3600'); return res.type('text/plain').send(ROBOTS); }
      if (bot.isHoneypot(p)) { bot.record('honeypot', req); return notFound(res); }
      if (req.method === 'POST' && p === '/v1/csp-report') return cspReport(req, res);
      if (req.method === 'POST' && p === '/v1/bot/challenge') return run([bot.preSessionLimit('auth'), smallJson], req, res, (err) => (err ? next(err) : bot.verifyChallenge(req, res)));
      if (req.method === 'POST' && p === '/v1/client_token') return run([bot.preSessionLimit('anonymous'), smallJson], req, res, (err) => (err ? next(err) : bot.bootstrapClientToken(req, res, parseCookies)));
      next();
    }));
  }

  // ---------------------------------------------------------------- API guard (after the session is attached)
  // Client token enforcement (HAR4: the SPA sends the token on every API call): every /v1 write, and every request under
  // /v1/users/* (authenticated reads included). Public unauthenticated reads (/v1 market/social/live data, /trade-api/v2)
  // stay open, as on the observed site.
  const needsToken = (req) => /^\/v1\//.test(req.originalUrl) && (!SAFE.has(req.method) || /^\/v1\/users(\/|$|\?)/.test(req.originalUrl));
  function apiGuard(req, res, next) {
    bot.limiter(req, res, (err) => {
      if (err) return next(err);
      if (req.method !== 'OPTIONS' && needsToken(req)) {
        const tok = req.get('x-client-token') || bot.readCookie(req, 'plx_ct', parseCookies);
        const c = bot.checkClientToken(req, tok);
        if (!c.ok) {
          bot.record('client_token_rejected', req, { reason: c.reason });
          return next(new ApiError(403, c.code, c.code === 'client_token_required' ? 'client token required' : 'client token invalid or expired', 'reload the page and try again'));
        }
      }
      next();
    });
  }

  // ---------------------------------------------------------------- WebSocket upgrade (S2 AwsWafTokenForWebSocket)
  function checkUpgrade(rawReq) {
    const req = asExpress(rawReq);
    if (req.headers.origin && !originAllowed(req, req.headers.origin)) { bot.record('ws_rejected', req, { reason: 'origin', origin: String(req.headers.origin).slice(0, 200) }); return { ok: false, status: 403 }; }
    let ct = null;
    try { ct = new URL(req.url, 'http://x').searchParams.get('ct'); } catch { /* ignore */ }
    const c = bot.checkClientToken(req, ct || bot.readCookie(req, 'plx_ct', parseCookies));
    if (!c.ok) { bot.record('ws_rejected', req, { reason: c.reason }); return { ok: false, status: 403 }; }
    return { ok: true };
  }

  // ---------------------------------------------------------------- static allowlist + SPA template (P1.11, P1.12; S3)
  const onlyExt = (exts) => (req, res, next) => (exts.includes(path.extname(req.path).toLowerCase()) ? next() : notFound(res));
  const staticOpts = (cache) => ({ index: false, dotfiles: 'deny', redirect: false, fallthrough: true, setHeaders: (res) => res.setHeader('Cache-Control', cache) });
  let template = null; let templateMtime = 0;
  const templateFile = assets === 'dist' ? path.join(DIST, 'index.html') : path.join(PUBLIC, 'index.html');
  function page() {
    const st = fs.statSync(templateFile);
    if (!template || st.mtimeMs !== templateMtime) { template = fs.readFileSync(templateFile, 'utf8'); templateMtime = st.mtimeMs; }
    return template;
  }

  function spa(req, res) {
    if (!SAFE.has(req.method) || req.method === 'OPTIONS') return notFound(res);
    const p = req.path;
    const segs = p.split('/');
    // Only extension-less app routes reach the SPA; anything that looks like a file is a plain 404.
    if (API.test(p) || p.length > 512 || segs.some((s) => s.startsWith('.')) || /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(segs[segs.length - 1])) return notFound(res);
    const nonce = res.locals.cspNonce;
    setSiteCsp(req, res, nonce);
    const ch = bot.shouldChallenge(req, trustworthy(req), parseCookies);
    if (ch) return bot.challenge(req, res, nonce, ch.reasons);
    const html = page().replace(/__CSP_NONCE__/g, nonce).replace(/__PLX_BOOT__/g, bot.bootProof(req));
    res.setHeader('Cache-Control', 'no-store');
    res.type('html');
    res.send(html);
  }

  function mountStatic(target) {
    if (assets === 'dist') {
      // Content-hashed, minified bundles: cache forever (S3). Source files under /js and the per-file CSS are not served.
      target.use('/assets', onlyExt(['.js', '.css', '.woff2']), express.static(path.join(DIST, 'assets'), { ...staticOpts('public, max-age=31536000, immutable') }));
    } else {
      const cssFiles = new Set(fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.css')));
      target.use('/js', onlyExt(['.js']), express.static(path.join(PUBLIC, 'js'), staticOpts('no-cache')));
      target.get(/^\/[A-Za-z0-9_-]+\.css$/, (req, res, next) => (cssFiles.has(req.path.slice(1)) ? res.setHeader('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, req.path.slice(1))) : next()));
      target.use('/fonts', onlyExt(['.woff2', '.txt']), express.static(path.join(PUBLIC, 'fonts'), staticOpts('public, max-age=86400')));
    }
    target.use('/fonts', onlyExt(['.txt']), express.static(path.join(PUBLIC, 'fonts'), staticOpts('public, max-age=86400'))); // OFL licences
    target.use(spa);
  }

  // ---------------------------------------------------------------- admin: security event log
  function mountAdminRoutes({ v1, can }) {
    v1.get('/admin/security/events', can('audit.read'), (req, res) => {
      const where = []; const args = [];
      if (req.query.kind) { where.push('kind=?'); args.push(String(req.query.kind)); }
      if (req.query.ip) { where.push('ip=?'); args.push(String(req.query.ip)); }
      if (req.query.since) { const t = Date.parse(String(req.query.since)); if (Number.isFinite(t)) { where.push('ts>=?'); args.push(t); } }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
      const total = db.prepare(`SELECT COUNT(*) c FROM security_events ${w}`).get(...args).c;
      const rows = db.prepare(`SELECT * FROM security_events ${w} ORDER BY id DESC LIMIT ?`).all(...args, limit);
      const counts = {};
      for (const r of db.prepare('SELECT kind, COUNT(*) c FROM security_events WHERE ts>=? GROUP BY kind').all(Date.now() - 86400000)) counts[r.kind] = r.c;
      res.json({ total, counts_24h: counts, events: rows.map((r) => ({ id: r.id, time: new Date(r.ts).toISOString(), kind: r.kind, ip: r.ip, ua: r.ua, method: r.method, path: r.path, user_id: r.user_id, detail: r.detail ? JSON.parse(r.detail) : null })) });
    });
  }

  return {
    early, apiGuard, mountStatic, mountAdminRoutes, checkUpgrade, bot, assets,
    settings: () => bot.settings(), validate: (patch) => bot.validate(patch), save: (out, by, at) => bot.save(out, by, at),
    close: () => bot.close(),
  };
}

module.exports = { createSecurity, robotsTxt, API_CSP };
