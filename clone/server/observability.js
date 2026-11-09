'use strict';
// Observability (PLAN P9.4, CLONE_SPEC.md §39.5): request ids and request logs, health endpoints, Prometheus metrics on a
// private port, and optional traces.
//
//   /healthz   process up (200 {"status":"ok"}); /readyz 200 {"status":"ready"} or 503 {"status":"not_ready"} — the
//              database is writable, migrations are done, the engine ticker and the background jobs are alive and the
//              disk has more than `ops.readyz_disk_free_mb` free. Public, unauthenticated, rate-limited per IP and
//              revealing nothing else (the reasons are on the metrics port and in Admin › System).
//   metrics    Prometheus text format on METRICS_PORT (bound to METRICS_HOST, 127.0.0.1 unless the private network needs
//              another interface), never on the public listener: request rate / errors / latency per route group,
//              order-to-ack latency and matching time, WebSocket connections and fan-out time, job lag per job, outbox
//              depths, backup age, verifier status, disk and database size. Optional bearer token METRICS_TOKEN.
//   traces     off by default (flag ops.traces); when on, `traces.sample_pct` of requests produce an OpenTelemetry-style
//              span (W3C traceparent in and out) written to the logs, and sent as OTLP/HTTP JSON when
//              OTEL_EXPORTER_OTLP_ENDPOINT is set.
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { requestIdOf, run: runCtx } = require('./logger');

// ------------------------------------------------------------------------------------------------ metrics registry
function createRegistry() {
  const metrics = new Map();
  const labelKey = (labels) => JSON.stringify(Object.entries(labels || {}).sort());
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const fmtLabels = (labels, extra = {}) => { const all = { ...labels, ...extra }; const e = Object.entries(all); return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : ''; };
  function counter(name, help) {
    const m = metrics.get(name) || { type: 'counter', help, values: new Map() };
    metrics.set(name, m);
    return { inc: (labels = {}, n = 1) => { const k = labelKey(labels); const v = m.values.get(k) || { labels, value: 0 }; v.value += n; m.values.set(k, v); } };
  }
  function gauge(name, help, collect) {
    const m = metrics.get(name) || { type: 'gauge', help, values: new Map(), collect };
    metrics.set(name, m);
    return { set: (labels = {}, value = 0) => m.values.set(labelKey(labels), { labels, value }) };
  }
  const BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  function histogram(name, help, buckets = BUCKETS) {
    const m = metrics.get(name) || { type: 'histogram', help, buckets, values: new Map() };
    metrics.set(name, m);
    return {
      observe: (labels = {}, sec) => {
        const k = labelKey(labels);
        const v = m.values.get(k) || { labels, counts: buckets.map(() => 0), sum: 0, count: 0, recent: [] };
        buckets.forEach((b, i) => { if (sec <= b) v.counts[i] += 1; });
        v.sum += sec; v.count += 1;
        v.recent.push(sec); if (v.recent.length > 2000) v.recent.splice(0, v.recent.length - 2000);
        m.values.set(k, v);
      },
      quantile: (labels, q) => { const v = m.values.get(labelKey(labels)); if (!v || !v.recent.length) return null; const s = [...v.recent].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; },
    };
  }
  async function render() {
    const out = [];
    for (const [name, m] of metrics) {
      if (m.collect) { try { await m.collect((labels, value) => m.values.set(labelKey(labels), { labels, value })); } catch { /* a failed collector leaves the last values */ } }
      out.push(`# HELP ${name} ${m.help}`, `# TYPE ${name} ${m.type}`);
      for (const v of m.values.values()) {
        if (m.type === 'histogram') {
          m.buckets.forEach((b, i) => out.push(`${name}_bucket${fmtLabels(v.labels, { le: b })} ${v.counts[i]}`));
          out.push(`${name}_bucket${fmtLabels(v.labels, { le: '+Inf' })} ${v.count}`, `${name}_sum${fmtLabels(v.labels)} ${v.sum}`, `${name}_count${fmtLabels(v.labels)} ${v.count}`);
        } else out.push(`${name}${fmtLabels(v.labels)} ${Number.isFinite(v.value) ? v.value : 0}`);
      }
    }
    return `${out.join('\n')}\n`;
  }
  return { counter, gauge, histogram, render, metrics };
}

// Route groups keep label cardinality bounded: ids and tickers never become label values.
function routeGroup(p) {
  if (/^\/v1\/users\/[^/]+\/orders/.test(p)) return 'orders';
  if (/^\/v1\/users\/[^/]+\/(positions|portfolio|fills|balance)/.test(p)) return 'portfolio';
  if (/^\/v1\/users\//.test(p)) return 'account';
  if (/^\/v1\/admin\//.test(p)) return 'admin';
  if (/^\/v1\/perps\//.test(p)) return 'perps';
  if (/^\/v1\/(events|markets|series|bff|search|categories|calendar|live_data|milestones|sports)/.test(p)) return 'market_data';
  if (/^\/v1\/(log_in|log_out|users$|session|auth|step_up|client_token|bot)/.test(p)) return 'auth';
  if (/^\/trade-api\/v2\/portfolio\/orders/.test(p)) return 'api_orders';
  if (/^\/trade-api\//.test(p)) return 'api';
  if (/^\/v1\//.test(p)) return 'v1_other';
  if (/^\/(assets|js|fonts|media|icons)\//.test(p) || /\.(css|js|png|jpg|woff2|webmanifest)$/.test(p)) return 'static';
  if (/^\/(healthz|readyz)$/.test(p)) return 'health';
  return 'pages';
}

// ------------------------------------------------------------------------------------------------ wiring
function createObservability({ db, engine, logger, trustProxy, settings, flagsOn = () => false, options = {} }) {
  const reg = createRegistry();
  const httpRequests = reg.counter('parlance_http_requests_total', 'HTTP requests by route group, method and status class');
  const httpDuration = reg.histogram('parlance_http_request_duration_seconds', 'HTTP request duration by route group');
  const orderAck = reg.histogram('parlance_order_ack_seconds', 'Order placement: request received to response sent');
  const matching = reg.histogram('parlance_matching_seconds', 'Matching engine time per order');
  const fanout = reg.histogram('parlance_ws_fanout_seconds', 'Time to fan one engine event out to WebSocket clients');
  const jobs = new Map(); // name -> { last_ok_ts, last_error_ts, last_error, runs }
  const job = (name, ok = true, error = null) => { const j = jobs.get(name) || { runs: 0 }; j.runs += 1; if (ok) j.last_ok_ts = Date.now(); else { j.last_error_ts = Date.now(); j.last_error = String(error || '').slice(0, 200); } jobs.set(name, j); };
  const S = (k, d) => { try { const v = settings ? settings(k) : undefined; return v == null ? d : v; } catch { return d; } };
  const extra = []; // more gauges registered by other modules: fn(set) per scrape
  // Per-minute request and 5xx counts for the error-rate alert (last 15 minutes).
  const minutes = new Map();
  const countMinute = (status) => { const m = Math.floor(Date.now() / 60000); const b = minutes.get(m) || { total: 0, errors: 0 }; b.total += 1; if (status >= 500) b.errors += 1; minutes.set(m, b); if (minutes.size > 20) for (const k of [...minutes.keys()].sort().slice(0, minutes.size - 15)) minutes.delete(k); };
  const window = (n = 5) => { const m = Math.floor(Date.now() / 60000); let total = 0; let errors = 0; for (let i = 0; i < n; i++) { const b = minutes.get(m - i); if (b) { total += b.total; errors += b.errors; } } return { total, errors }; };
  reg.gauge('parlance_job_last_success_age_seconds', 'Seconds since each background job last succeeded', (set) => { for (const [n, j] of jobs) set({ job: n }, j.last_ok_ts ? (Date.now() - j.last_ok_ts) / 1000 : -1); });
  reg.gauge('parlance_process_resident_memory_bytes', 'Resident memory', (set) => set({}, process.memoryUsage().rss));
  reg.gauge('parlance_process_uptime_seconds', 'Process uptime', (set) => set({}, process.uptime()));
  reg.gauge('parlance_db_size_bytes', 'SQLite database and WAL size', (set) => {
    const f = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main')?.file;
    if (!f) return;
    for (const [part, p] of [['db', f], ['wal', `${f}-wal`]]) { try { set({ file: part }, fs.statSync(p).size); } catch { set({ file: part }, 0); } }
  });
  reg.gauge('parlance_disk_free_bytes', 'Free bytes on the data volume', (set) => { const d = diskFree(); if (d) set({}, d.free); });
  reg.gauge('parlance_disk_total_bytes', 'Size of the data volume', (set) => { const d = diskFree(); if (d) set({}, d.total); });
  reg.gauge('parlance_outbox_depth', 'Undelivered messages per outbox', (set) => {
    const q = (sql) => { try { return db.prepare(sql).get().c; } catch { return 0; } };
    set({ outbox: 'notifications' }, q("SELECT COUNT(*) c FROM notif_deliveries WHERE status IN ('pending','deferred')"));
    set({ outbox: 'push' }, q("SELECT COUNT(*) c FROM push_outbox WHERE status IN ('pending','retry')"));
    set({ outbox: 'newsletter' }, q("SELECT COUNT(*) c FROM waitlist_newsletter_outbox WHERE status IN ('pending','retry')"));
    set({ outbox: 'webhooks' }, q("SELECT COUNT(*) c FROM sbx_webhook_outbox WHERE status IN ('pending','retry')"));
  });
  reg.gauge('parlance_up', 'Always 1 while the process answers', (set) => set({}, 1));
  const custom = reg.gauge('parlance_status', 'Operational status values registered by modules (backup age, verifiers, switches)', async (set) => { for (const fn of extra) await fn(set); });
  void custom;

  function diskFree() {
    const f = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main')?.file;
    if (!f || !fs.statfsSync) return null;
    try { const st = fs.statfsSync(require('node:path').dirname(f)); return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }; } catch { return null; }
  }

  // Engine timing: matching time per order (synchronous section of placeOrder).
  if (engine && typeof engine.placeOrder === 'function' && !engine.__timed) {
    const orig = engine.placeOrder.bind(engine);
    engine.placeOrder = (...a) => { const t0 = process.hrtime.bigint(); try { return orig(...a); } finally { matching.observe({}, Number(process.hrtime.bigint() - t0) / 1e9); } };
    engine.__timed = true;
  }

  // ---- traces
  const otlp = options.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
  const spanQueue = [];
  function traceOf(req) {
    if (!flagsOn('ops.traces')) return null;
    const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(String(req.headers.traceparent || ''));
    const pct = Number(S('traces.sample_pct', 10));
    if (!m && Math.random() * 100 >= pct) return null;
    return { trace_id: m ? m[1] : crypto.randomBytes(16).toString('hex'), parent_span_id: m ? m[2] : null, span_id: crypto.randomBytes(8).toString('hex') };
  }
  function endSpan(t, req, res, startNs, group) {
    const span = { msg: 'span', trace_id: t.trace_id, span_id: t.span_id, parent_span_id: t.parent_span_id, name: `${req.method} ${group}`, kind: 'server',
      start: new Date(Number(startNs / 1000000n)).toISOString(), duration_ms: Number(process.hrtime.bigint() - startNs) / 1e6, status: res.statusCode >= 500 ? 'error' : 'ok', 'http.status_code': res.statusCode };
    logger.info('span', span);
    if (otlp) { spanQueue.push(span); if (spanQueue.length > 500) spanQueue.splice(0, spanQueue.length - 500); }
  }
  let otlpTimer = null;
  if (otlp) {
    otlpTimer = setInterval(() => {
      if (!spanQueue.length) return;
      const batch = spanQueue.splice(0, 200);
      const body = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'parlance' } }] }, scopeSpans: [{ scope: { name: 'parlance' }, spans: batch.map((s) => ({ traceId: s.trace_id, spanId: s.span_id, parentSpanId: s.parent_span_id || undefined, name: s.name, kind: 2, startTimeUnixNano: String(Date.parse(s.start) * 1e6), endTimeUnixNano: String(Math.round((Date.parse(s.start) + s.duration_ms) * 1e6)), status: { code: s.status === 'error' ? 2 : 1 } })) }] }] };
      fetch(`${otlp.replace(/\/+$/, '')}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    }, 5000);
    otlpTimer.unref();
  }

  // ---- request middleware: request id, context, metrics, request log, span
  const logRequests = options.logRequests ?? true;
  function middleware(req, res, next) {
    const id = requestIdOf(req, !!trustProxy);
    req.id = id;
    res.setHeader('X-Request-Id', id);
    const t0 = process.hrtime.bigint();
    const group = routeGroup(req.path);
    const t = traceOf(req);
    if (t) res.setHeader('traceparent', `00-${t.trace_id}-${t.span_id}-01`);
    res.on('finish', () => {
      const sec = Number(process.hrtime.bigint() - t0) / 1e9;
      httpRequests.inc({ group, method: req.method, code: `${Math.floor(res.statusCode / 100)}xx` });
      if (group !== 'static' && group !== 'health') countMinute(res.statusCode);
      httpDuration.observe({ group }, sec);
      if (req.method === 'POST' && (group === 'orders' || group === 'api_orders') && res.statusCode < 300) orderAck.observe({}, sec);
      if (logRequests && group !== 'health' && group !== 'static') logger.info('request', { request_id: id, method: req.method, route: group, path: req.path.replace(/\/(usr|u|ses|ord|au|wl|bk)_[A-Za-z0-9-]+/g, '/:id').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id').slice(0, 120), status: res.statusCode, ms: Math.round(sec * 10000) / 10 });
      if (t) endSpan(t, req, res, t0, group);
    });
    runCtx({ request_id: id, ...(t ? { trace_id: t.trace_id } : {}) }, next);
  }

  // ---- health
  const buckets = new Map();
  const limited = (ip) => { const now = Date.now(); const b = buckets.get(ip) || { t: 30, ts: now }; b.t = Math.min(30, b.t + (now - b.ts) / 1000); b.ts = now; buckets.set(ip, b); if (buckets.size > 10000) buckets.clear(); if (b.t < 1) return true; b.t -= 1; return false; };
  let lastTick = Date.now();
  if (engine) engine.on('tick', () => { lastTick = Date.now(); });
  const readyChecks = []; // fn() → {name, ok, detail}
  function readiness() {
    const out = [];
    try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); out.push({ name: 'db_writable', ok: true }); } catch (e) { out.push({ name: 'db_writable', ok: false, detail: e.message }); }
    try { const m = require('./migrations'); out.push({ name: 'migrations', ok: m.version(db) === m.LATEST, detail: `${m.version(db)}/${m.LATEST}` }); } catch (e) { out.push({ name: 'migrations', ok: false, detail: e.message }); }
    out.push({ name: 'engine_ticker', ok: Date.now() - lastTick < Number(options.tickStaleMs || 15000), detail: `${Math.round((Date.now() - lastTick) / 1000)} s since the last tick` });
    const d = diskFree();
    const min = Number(S('ops.readyz_disk_free_mb', 500)) * 1048576;
    out.push({ name: 'disk_free', ok: !d || d.free >= min, detail: d ? `${Math.round(d.free / 1048576)} MB free` : 'unknown' });
    for (const fn of readyChecks) { try { out.push(fn()); } catch (e) { out.push({ name: 'check', ok: false, detail: e.message }); } }
    return { ok: out.every((c) => c.ok), checks: out };
  }
  function mountHealth(app, clientIp) {
    const guard = (req, res) => { res.setHeader('Cache-Control', 'no-store'); if (limited(clientIp(req))) { res.status(429).json({ status: 'rate_limited' }); return false; } return true; };
    app.get('/healthz', (req, res) => { if (guard(req, res)) res.json({ status: 'ok' }); });
    app.get('/readyz', (req, res) => { if (!guard(req, res)) return; const r = readiness(); res.status(r.ok ? 200 : 503).json({ status: r.ok ? 'ready' : 'not_ready' }); });
  }

  // ---- private metrics listener
  let server = null;
  function listen({ port = process.env.METRICS_PORT, host = process.env.METRICS_HOST || '127.0.0.1', token = process.env.METRICS_TOKEN } = {}) {
    if (port == null || port === '' || port === 'off') return Promise.resolve(null);
    server = http.createServer(async (req, res) => {
      if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      const u = new URL(req.url, 'http://x');
      try {
        if (u.pathname === '/metrics') { const body = await reg.render(); res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(body); return; }
        if (u.pathname === '/readyz') { const r = readiness(); res.writeHead(r.ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(r)); return; }
        if (u.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}'); return; }
        res.writeHead(404).end();
      } catch (e) { res.writeHead(500).end(String(e.message)); }
    });
    return new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), host, () => resolve(server.address().port)); });
  }
  const close = () => new Promise((r) => { if (otlpTimer) clearInterval(otlpTimer); if (!server) return r(); server.close(() => r()); server.closeAllConnections?.(); });

  return { window, registry: reg, middleware, mountHealth, readiness, readyChecks, listen, close, job, jobs, extra, fanout, orderAck, matching, httpDuration, diskFree, routeGroup };
}

module.exports = { createObservability, createRegistry, routeGroup };
