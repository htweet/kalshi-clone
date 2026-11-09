'use strict';
// Developer portal, status page and demo environment (PLAN P7.3, A16; CLONE_SPEC.md §35.9–§35.11).
//
// Portal. /docs is an SPA page (public/js/views/docs.js) under the site's strict CSP. Its prose (Welcome, Quick Start,
// Concepts, Predictions, Perps, FIX, Rate limits, Demo, Changelog, Developer Agreement) is CMS pages docs/*, seeded into
// the CMS store as published version 1 on first start, so editors change and publish it in Admin › Content › Pages.
// The reference is generated: GET /docs/openapi.json and /docs/asyncapi.json from the route registry
// (server/api-registry.js) and /docs/fix.json from the FIX message declaration (server/fix.js). Flag developer_portal.
//
// Status. GET /v1/status (flag status_page): components (REST API, WebSocket, FIX, demo, website) from live state, and
// the incidents staff publish as CMS entries of type `incident` (Admin › API keys › Status incidents; draft, publish,
// version history and audit come from the CMS store).
//
// Demo environment. A second, separate exchange started by server/index.js on its own port and SQLite file (env
// 'demo': key ids plxdemo_, play money, its own users and keys). The main site proxies /demo-api/trade-api/* over
// loopback HTTP (and the WebSocket upgrade), passing only the API headers — never cookies — so the portal's Try-it
// stays same-origin under the strict CSP. POST /v1/developer/demo_credentials (signed in, flag api.demo) registers a
// public key the browser generated with WebCrypto on a demo account linked to the caller; the private key never leaves
// the browser. Demo keys do not exist in the main database and main keys do not exist in the demo one.
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { ApiError, E, newId, nowIso, dollars } = require('./util');
const { plainProblem } = require('./cms/sanitize');
const { FIX_SPEC } = require('./fix');
const { DOCS_PAGES } = require('./content/developer-docs');
const { s } = require('./content/api');
const pw = require('./passwords');

const COMPONENTS = ['api', 'websocket', 'fix', 'demo', 'web'];
const INCIDENT_STATUS = ['investigating', 'identified', 'monitoring', 'resolved'];
const IMPACT = ['maintenance', 'degraded', 'outage'];
const PROXY_HEADERS = ['accept', 'content-type', 'content-length', 'idempotency-key', 'parlance-access-key', 'parlance-access-timestamp', 'parlance-access-signature', 'user-agent'];
const DEMO_FUNDS_CENTS = 1000000; // $10,000 of play money for a new demo account
const DEMO_PERPS_DOLLARS = 2000;

function mountDeveloperPortal({ app, v1, db, engine, flags, admin, auth, apiKeys, registry, getDemo, getFix, getTradeWs, env = 'main' }) {
  const cms = app.locals.cms;
  const store = cms.store;
  const flagError = (k) => flags.disabledError(k);

  // ---------------------------------------------------------------- CMS: incidents + seeded docs pages
  const isoOrNull = (v, f, errs) => { if (v == null || v === '') return null; const t = Date.parse(String(v)); if (!Number.isFinite(t)) { errs[f] = 'must be a date and time'; return null; } return new Date(t).toISOString(); };
  store.register('incident', {
    validate: (key, v) => {
      if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(key)) throw { key: 'an incident id is 3-64 lowercase letters, digits and dashes' };
      if (!v || typeof v !== 'object') throw { value: 'must be an incident object' };
      const errs = {}; const out = {};
      const title = String(v.title ?? '').trim(); if (!title || title.length > 140 || plainProblem(title)) errs.title = 'plain text, 1-140 characters'; else out.title = title;
      const body = String(v.body ?? '').trim(); if (body.length > 4000 || (body && plainProblem(body))) errs.body = 'plain text, at most 4000 characters'; else out.body = body;
      out.status = INCIDENT_STATUS.includes(v.status) ? v.status : (errs.status = `one of ${INCIDENT_STATUS.join(', ')}`, null);
      out.impact = IMPACT.includes(v.impact) ? v.impact : (errs.impact = `one of ${IMPACT.join(', ')}`, null);
      const comps = Array.isArray(v.components) ? v.components : [];
      if (!comps.length || comps.some((c) => !COMPONENTS.includes(c))) errs.components = `one or more of ${COMPONENTS.join(', ')}`; else out.components = [...new Set(comps)];
      out.started_at = isoOrNull(v.started_at, 'started_at', errs) || nowIso();
      out.resolved_at = out.status === 'resolved' ? (isoOrNull(v.resolved_at, 'resolved_at', errs) || nowIso()) : null;
      if (Object.keys(errs).length) throw errs;
      return out;
    },
    changed: () => engine.emit('status_page', { changed: true }),
  });
  // Seed: each docs page not yet in the store is published as version 1 (author "system", reason "seed").
  const seedReq = { auth: { user: { id: null, email: 'system@parlance.local' }, session: { auth_at: Date.now() } } };
  for (const [slug, page] of Object.entries(DOCS_PAGES)) {
    try {
      const cur = store.get('page', slug);
      if (cur.published_version === 0 && cur.published == null) { seedReq.auth.session.auth_at = Date.now(); store.publish(seedReq, 'page', slug, { value: page, reason: 'seed: developer portal (Phase 7)' }); }
    } catch (e) { console.error('docs seed', slug, e.message); }
  }

  const incidents = (preview = false) => [...(preview ? store.withDrafts('incident') : store.published('incident')).entries()]
    .filter(([, v]) => v && typeof v === 'object')
    .map(([id, v]) => ({ id, title: v.title, body: v.body, status: v.status, impact: v.impact, components: v.components, started_time: v.started_at, resolved_time: v.resolved_at }))
    .sort((a, b) => Date.parse(b.started_time) - Date.parse(a.started_time));
  app.locals.statusIncidents = () => incidents(false);

  // ---------------------------------------------------------------- status
  const WORST = { operational: 0, maintenance: 1, degraded: 2, outage: 3 };
  function componentStatus() {
    const demo = getDemo ? getDemo() : null; const fix = getFix ? getFix() : null;
    const base = {
      api: flags.jobOn('api.keys') ? 'operational' : 'disabled',
      websocket: flags.jobOn('api.ws') ? 'operational' : 'disabled',
      fix: !flags.jobOn('api.fix') ? 'disabled' : fix && fix.listening() ? 'operational' : 'outage',
      demo: !flags.jobOn('api.demo') ? 'disabled' : demo && demo.port ? 'operational' : 'outage',
      web: 'operational',
    };
    const open = incidents().filter((i) => i.status !== 'resolved');
    for (const i of open) for (const c of i.components) if (base[c] !== 'disabled' && (WORST[i.impact] || 0) > (WORST[base[c]] || 0)) base[c] = i.impact;
    // Phase 9A operating switches (CLONE_SPEC.md §39.7): maintenance / read-only put every live component in maintenance;
    // a trading halt degrades the trading interfaces.
    const ops = app.locals.opsStatus ? app.locals.opsStatus() : {};
    const worsen = (c, st) => { if (base[c] !== 'disabled' && (WORST[st] || 0) > (WORST[base[c]] || 0)) base[c] = st; };
    if (ops.maintenance || ops.read_only) for (const c of COMPONENTS) worsen(c, 'maintenance');
    if (ops.trading_halted) for (const c of ['api', 'websocket', 'fix', 'web']) worsen(c, 'degraded');
    return COMPONENTS.map((id) => ({ id, name: s(`status.component.${id}`), status: base[id], ...(id === 'fix' && fix && fix.listening() ? { port: fix.port() } : {}) }));
  }
  v1.get('/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const comps = componentStatus();
    const live = comps.filter((c) => c.status !== 'disabled');
    const worst = live.reduce((a, c) => (WORST[c.status] > WORST[a] ? c.status : a), 'operational');
    const cutoff = Date.now() - 90 * 86400000;
    const ops = app.locals.opsStatus ? app.locals.opsStatus() : {};
    const OPS = require('./content/ops').s;
    const notices = [...(ops.maintenance ? [{ kind: 'maintenance', message: OPS('error.maintenance') }] : []), ...(ops.read_only ? [{ kind: 'read_only', message: OPS('error.read_only') }] : []), ...(ops.trading_halted ? [{ kind: 'trading_halt', message: OPS('error.trading_halted') }] : [])];
    res.json({ status: worst, components: comps, notices, incidents: incidents().filter((i) => i.status !== 'resolved' || Date.parse(i.resolved_time || i.started_time) >= cutoff).slice(0, 50), updated_time: nowIso() });
  });

  // ---------------------------------------------------------------- portal data
  const NAV = [['welcome', 'docs/welcome'], ['quick-start', 'docs/quick-start'], ['concepts', 'docs/concepts'], ['predictions', 'docs/predictions'], ['perps', 'docs/perps'], ['fix', 'docs/fix'], ['changelog', 'docs/changelog'], ['rate-limits', 'docs/rate-limits'], ['demo', 'docs/demo'], ['agreement', 'docs/agreement']];
  v1.get('/developer/portal', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const preview = req.query.preview === '1' && req.auth && admin.rolesOf(req.auth.user).some((r) => ['admin', 'editor', 'publisher'].includes(r));
    const pages = NAV.map(([id, slug]) => { const p = cms.pageOf(slug, preview); return p ? { id, slug, title: p.title, body: require('./cms/sanitize').sanitize(p.body, 'page') } : null; }).filter(Boolean);
    const st = apiKeys.settings();
    res.json({
      pages, preview: !!preview,
      tiers: Object.entries(st.tiers).map(([id, t]) => ({ id, label: t.label, read_per_sec: t.read_per_sec, write_per_sec: t.write_per_sec, ws_connections: t.ws_connections, fix_sessions: t.fix_sessions })),
      auth: { window_past_ms: st.window_past_ms, window_future_ms: st.window_future_ms, headers: ['PARLANCE-ACCESS-KEY', 'PARLANCE-ACCESS-TIMESTAMP', 'PARLANCE-ACCESS-SIGNATURE'] },
      demo: { enabled: flags.on('api.demo', { req }) && !!(getDemo && getDemo()), rest_base: '/demo-api/trade-api/v2', ws_base: '/demo-api/trade-api/ws/v2' },
      environments: { production: { rest_base: '/trade-api/v2', ws_base: '/trade-api/ws/v2' } },
    });
  });
  // The generated documents (outside /v1: static JSON, cacheable for a minute).
  const docsJson = (fn) => (req, res) => {
    if (!flags.on('developer_portal', { req })) return res.status(403).json(flagError('developer_portal').toJSON());
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json(fn(req));
  };
  const origin = (req) => (app.locals.security?.selfOrigin(req) || '');
  app.get('/docs/openapi.json', docsJson((req) => registry.openapi({ servers: [{ url: `${origin(req)}/trade-api/v2`, description: 'Production' }, { url: `${origin(req)}/demo-api/trade-api/v2`, description: 'Demo (play money)' }] })));
  app.get('/docs/asyncapi.json', docsJson((req) => { const o = origin(req).replace(/^http/, 'ws'); return registry.asyncapi({ servers: { production: { url: `${o}/trade-api/ws/v2`, protocol: 'ws' }, demo: { url: `${o}/demo-api/trade-api/ws/v2`, protocol: 'ws' } } }); }));
  app.get('/docs/fix.json', docsJson(() => FIX_SPEC));

  // ---------------------------------------------------------------- demo credentials (main → demo, in process)
  const requireUser = (req, res, next) => (req.auth ? next() : next(E.unauthorized()));
  v1.get('/developer/demo_credentials', requireUser, (req, res) => {
    const d = getDemo && getDemo();
    if (!d) throw new ApiError(503, 'demo_unavailable', 'the demo environment is not running');
    res.json({ credentials: d.app.locals.demoKeysFor(req.auth.user.id), rest_base: '/demo-api/trade-api/v2', ws_base: '/demo-api/trade-api/ws/v2' });
  });
  v1.post('/developer/demo_credentials', requireUser, (req, res) => {
    const d = getDemo && getDemo();
    if (!d) throw new ApiError(503, 'demo_unavailable', 'the demo environment is not running');
    const b = req.body || {};
    const out = d.app.locals.provisionDemo({ mainUserId: req.auth.user.id, displayName: req.auth.user.display_name, publicKeyPem: b.public_key, label: b.label });
    auth.logEvent(req.auth.user.id, 'demo_key_created', req, { key: out.api_key.api_key_id });
    res.status(201).json({ ...out, rest_base: '/demo-api/trade-api/v2', ws_base: '/demo-api/trade-api/ws/v2' });
  });

  // ---------------------------------------------------------------- demo side: provisioning (env 'demo' only)
  if (env === 'demo') {
    const demoEmail = (mainUserId) => `demo-${crypto.createHash('sha256').update(String(mainUserId)).digest('hex').slice(0, 20)}@demo.example.test`;
    app.locals.demoKeysFor = (mainUserId) => {
      const u = db.prepare('SELECT id FROM users WHERE email=?').get(demoEmail(mainUserId));
      return u ? db.prepare("SELECT * FROM api_keys WHERE user_id=? ORDER BY created_ts DESC").all(u.id).map(apiKeys.keyVo) : [];
    };
    app.locals.provisionDemo = ({ mainUserId, displayName, publicKeyPem, label }) => {
      const email = demoEmail(mainUserId);
      let u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      if (!u) {
        const id = newId('u_');
        db.prepare('INSERT INTO users(id,email,display_name,password_hash,balance_cents,created_at) VALUES(?,?,?,?,0,?)').run(id, email, String(displayName || 'Demo trader').slice(0, 40), pw.UNUSABLE('demo'), nowIso());
        engine.credit(id, DEMO_FUNDS_CENTS, 'deposit', `demo:${id}`, 'Demo play money');
        u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
        // Perps collateral, through the same pipeline as a user transfer (flags, limits).
        app.locals.tradeApi.dispatch({ user: u, key: null }, 'POST', '/perps/transfers', { direction: 'to_perps', amount_dollars: DEMO_PERPS_DOLLARS }, { channel: 'api' }).catch(() => {});
      }
      const active = db.prepare("SELECT id, status, expires_ts FROM api_keys WHERE user_id=? AND status='active'").all(u.id).filter((k) => apiKeys.effectiveStatus(k) === 'active');
      if (active.length >= 5) { const oldest = db.prepare("SELECT id FROM api_keys WHERE user_id=? AND status='active' ORDER BY created_ts LIMIT 1").get(u.id); apiKeys.revoke(oldest.id, { actor: u, ownerId: u.id, by: 'user', reason: 'replaced by a new demo key' }); }
      const { row } = apiKeys.create(u, { label: String(label || 'Try it (browser)').slice(0, 60), scopes: ['read', 'trade', 'perps'], mode: 'public_key', public_key: publicKeyPem });
      return { api_key: apiKeys.keyVo(row), balance_dollars: dollars(engine.balance(u.id)) };
    };
  }

  // ---------------------------------------------------------------- the /demo-api proxy (main side)
  // Mounted before the body parser (server/app.js): the request body is streamed to the demo server unparsed, capped at
  // 64 KiB. Only API headers cross; cookies never do, and Set-Cookie never comes back.
  function demoProxy(req, res, next) {
    if (!/^\/trade-api\/v2(\/|\?|$)/.test(req.url)) return next(E.notFound());
    if (!flags.jobOn('api.demo')) return next(flagError('api.demo'));
    const d = getDemo && getDemo();
    if (!d) return next(new ApiError(503, 'demo_unavailable', 'the demo environment is not running'));
    const headers = {};
    for (const h of PROXY_HEADERS) if (req.headers[h] != null) headers[h] = req.headers[h];
    headers['x-forwarded-for'] = String(req.socket.remoteAddress || '');
    const preq = http.request({ host: '127.0.0.1', port: d.port, method: req.method, path: req.url, headers }, (pr) => {
      res.status(pr.statusCode);
      for (const [k, v] of Object.entries(pr.headers)) if (!['set-cookie', 'connection', 'transfer-encoding', 'keep-alive', 'content-security-policy'].includes(k)) res.setHeader(k, v);
      res.setHeader('Cache-Control', 'no-store');
      pr.pipe(res);
    });
    preq.on('error', () => { if (!res.headersSent) next(new ApiError(502, 'demo_unavailable', 'the demo environment did not answer')); else res.end(); });
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 65536) { preq.destroy(); if (!res.headersSent) res.status(413).json(new ApiError(413, 'payload_too_large', 'request body too large').toJSON()); } });
    req.pipe(preq);
    return undefined;
  }
  // WebSocket upgrade for /demo-api/trade-api/ws/v2(/margin): a raw TCP pipe to the demo server with the path rewritten.
  function demoUpgrade(req, socket, head, url) {
    if (!/^\/demo-api\/trade-api\/ws\/v2(\/margin)?$/.test(url.pathname)) return false;
    const d = getDemo && getDemo();
    if (!d || !flags.jobOn('api.demo')) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true; }
    const keep = ['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'parlance-access-key', 'parlance-access-timestamp', 'parlance-access-signature', 'user-agent'];
    const lines = [`GET ${url.pathname.replace(/^\/demo-api/, '')}${url.search} HTTP/1.1`];
    for (const k of keep) if (req.headers[k] != null) lines.push(`${k}: ${req.headers[k]}`);
    const up = net.connect(d.port, '127.0.0.1', () => { up.write(`${lines.join('\r\n')}\r\n\r\n`); if (head && head.length) up.write(head); up.pipe(socket); socket.pipe(up); });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    return true;
  }
  void getTradeWs;
  return { demoProxy, demoUpgrade, componentStatus, incidents };
}

module.exports = { mountDeveloperPortal, COMPONENTS, INCIDENT_STATUS, IMPACT };
