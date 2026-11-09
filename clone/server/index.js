'use strict';
// node:sqlite (the persistence layer) needs Node 22.5+; say so plainly instead of a bare "Cannot find module".
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    console.error(`Could not start Parlance Exchange: Node ${process.versions.node} is too old. Install Node 22.5 or newer (https://nodejs.org), then run npm start again.`);
    process.exit(1);
  }
}
const http = require('node:http');
const path = require('node:path');
const { open } = require('./db');
const { seed } = require('./seed');
const { Engine } = require('./engine');
const { createApp } = require('./app');
const { attachWs } = require('./ws');
const { attachTradeWs } = require('./trade-ws'); // Phase 7: public WebSocket API (CLONE_SPEC.md §35)
const { createFixGateway } = require('./fix'); // Phase 7: FIX 4.4 gateway, off by default (CLONE_SPEC.md §35.8)
const configGuard = require('./config-guard'); // Phase 9A: production configuration guard (CLONE_SPEC.md §39.10)
const storageLib = require('./storage'); // Phase 9A: object storage adapters (CLONE_SPEC.md §39.4)
const { createLogger, installConsole } = require('./logger'); // Phase 9A: structured, scrubbed logs (CLONE_SPEC.md §39.5)

const DEFAULT_PORT = 3000;
const FALLBACK_ATTEMPTS = 20;

// Bind to `port`; when `fallback` is on and the port is busy, try the next ones.
function listen(server, port, fallback) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (p) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && fallback && attempt < FALLBACK_ATTEMPTS - 1) {
          attempt += 1;
          tryPort(p + 1);
        } else if (err.code === 'EADDRINUSE') {
          const e = new Error(fallback
            ? `Ports ${port}-${p} are all in use. Set PORT to a free port, e.g. PORT=8080 npm start`
            : `Port ${p} is already in use. Pick another, e.g. PORT=${p + 1} npm start (or unset PORT to auto-select a free port)`);
          e.code = 'EADDRINUSE';
          reject(e);
        } else reject(err);
      };
      const onListening = () => { server.removeListener('error', onError); resolve(server.address().port); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, process.env.HOST || '127.0.0.1'); // HOST=0.0.0.0 inside the container (deploy/), loopback otherwise
    };
    tryPort(port);
  });
}

// Identity options (CLONE_SPEC §22): `admin: {email, password}` creates the first admin (else ADMIN_EMAIL +
// ADMIN_PASSWORD, else a one-time setup URL is printed and returned as `setupUrl`); `demoPassword` (or DEMO_PASSWORD)
// sets the seeded demo accounts' password, otherwise a random one is printed once; `auth` overrides session /
// lockout / step-up timings (server/auth.js DEFAULTS). `push` tunes Web Push (server/webpush.js, CLONE_SPEC §31):
// subject, allowedHosts, insecureEndpointHosts (tests only), retryBaseMs, maxAttempts, timeoutMs.
// Phase 5D (CLONE_SPEC §33): `flags: { overrides: { key: bool } }` (technical overrides, like FEATURE_FLAGS), `playMode`,
// `centralBank: { rng, now }` (deterministic heist codes / clock for tests; ignored when NODE_ENV=production).
// `flags: { defaults: { key: bool } }` sets the state a NEW flag row starts with (admins can still change it); test servers
// that need open Perps pass `flags: { defaults: { 'perps.waitlist': false } }` (the waitlist is on by default, §36.1).
// Phase 7A (CLONE_SPEC §36): `waitlists: { confirmTtlMs, guestJoinsPerIp, guestWindowMs, tokenAttemptsPerIp,
// newsletterPerMinute, now }` (`now`: the newsletter job clock for tests; ignored when NODE_ENV=production).
// Phase 7B (CLONE_SPEC §37): `elections: { seed, speed, snapshotEveryMin, retainSnapshots }` (`seed`: the Nigerian and Harbor
// demo elections; `speed`: simulated minutes per real minute). The results simulator also needs the `elections.simulator`
// flag, off by default: `npm start` outside production starts it on (`flags: { defaults }`), production never does.
// Phase 9A (CLONE_SPEC.md §39): `ops: { mediaStorage, backupStorage (storage drivers or {driver,…} specs; default: local
// folders next to the database, OBJECT_STORAGE / BACKUP_STORAGE), schedule (backup schedule, WAL shipping, anchors,
// alerts, drills; on for npm start), launchGate (Launch readiness gates the production switch; on in production),
// metricsPort, alertLoopback (tests: http webhook receivers on loopback), backupTickMs, anchorTickMs, alertTickMs }`;
// `logs: true` writes JSON logs to stdout (npm start does).
async function start({ port, defaultPort = DEFAULT_PORT, dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'parlance.db'), rate, tickMs = 1000, rollingWindowSec = Number(process.env.ROLLING_WINDOW_SEC || 900), perps, combos, sports,
  admin, demoPassword = process.env.DEMO_PASSWORD, auth, quiet = false, security, identity, payments, marketsContent, push, cms, flags, playMode, centralBank, api, fix, waitlists, elections, owner, growth, seo, reach, env = 'main', demo, assets = process.env.ASSETS || (process.env.NODE_ENV === 'production' ? 'dist' : 'src'), ops = {}, logs = false } = {}) {
  const explicit = port != null || !!process.env.PORT;
  if (port == null) port = process.env.PORT ? Number(process.env.PORT) : defaultPort;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT "${process.env.PORT ?? port}"`);
  // Perimeter (CLONE_SPEC §21): `assets: 'dist'` serves the hashed production bundle, built here when dist/ is
  // missing or stale (P1.11); `security` tunes CORS origins, trust proxy, bot thresholds and rate tiers (server/security.js).
  const dataDir = dbFile === ':memory:' ? null : path.dirname(path.resolve(dbFile));
  configGuard.enforce({ dataDir, options: { secureCookies: auth && auth.secureCookies } }); // NODE_ENV=production only; names each failing setting
  if (assets === 'dist') await require('../scripts/build').ensureBuilt();
  const srvRef = {};
  const logger = logs && typeof logs === 'object' ? logs : logs ? createLogger({ level: () => (srvRef.app ? srvRef.app.locals.ownerSettings.get('logs.level') : 'info') }) : null; // `logs`: true or a logger
  const db = open(dbFile);
  seed(db, { demoPassword, quiet });
  // Production (DEMO_ACCOUNTS=off, required by the config guard): the seeded demo traders keep their market history but can
  // never sign in (an unusable password marker; their sessions end).
  if (process.env.DEMO_ACCOUNTS === 'off') {
    for (const email of ['maple_quant@parlance.local', 'harborwatch@parlance.local', 'rainmaker@parlance.local']) {
      const u = db.prepare('SELECT id FROM users WHERE email=?').get(email);
      if (u) { db.prepare("UPDATE users SET password_hash='!demo_disabled' WHERE id=?").run(u.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); }
    }
  }
  // Object storage (CLONE_SPEC.md §39.4): media and identity documents, and the backup store; local folders by default.
  const mkStorage = (opt, spec, dir, envPrefix) => (opt !== undefined ? (opt ? storageLib.create(opt) : null) : dataDir ? storageLib.fromEnv({ spec, defaultDir: dir, envPrefix }) : null);
  const mediaStorage = mkStorage(ops.mediaStorage, process.env.OBJECT_STORAGE, dataDir && path.join(dataDir, 'objects'), '');
  const backupStorage = mkStorage(ops.backupStorage, process.env.BACKUP_STORAGE, dataDir && path.join(dataDir, 'backups'), 'BACKUP_');
  const engine = new Engine(db);
  const ta = db.prepare("SELECT value FROM meta WHERE key='trading_active'").get();
  if (ta) engine.tradingActive = ta.value === '1';
  const keyDir = dbFile === ':memory:' ? undefined : path.dirname(path.resolve(dbFile)); // secret.key lives next to the database
  let app; let boot;
  try {
    app = createApp({ db, engine, rollingWindowSec, perps, combos, sports, auth, keyDir, identity, marketsContent, push, cms, flags, playMode, centralBank, api, waitlists, elections, owner, growth, seo, reach, env, payments: { quiet, ...(payments || {}) }, security: { ...(security || {}), assets }, rate: rate || { burst: Number(process.env.RATE_BURST || 300), perSec: Number(process.env.RATE_PER_SEC || 150) },
      dbFile, logger, ops: { ...ops, mediaStorage, backupStorage } });
    srvRef.app = app;
    const envAdmin = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD ? { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } : null;
    boot = app.locals.auth.bootstrap({ admin: admin || envAdmin, demoPassword });
  } catch (e) { try { app?.locals.cms?.close(); app?.locals.webpush?.close(); app?.locals.payments?.close(); app?.locals.identity?.close(); app?.locals.security?.close(); } catch { /* ignore */ } db.close(); throw e; }
  const server = http.createServer(app);
  const tradeWs = attachTradeWs({ db, engine, apiKeys: app.locals.apiKeys, flags: app.locals.flags, tradeApi: app.locals.tradeApi, registry: app.locals.apiRegistry, env: app.locals.env || 'main' });
  app.locals.tradeWs = tradeWs;
  const fixGw = createFixGateway({ db, engine, apiKeys: app.locals.apiKeys, tradeApi: app.locals.tradeApi, flags: app.locals.flags, security: app.locals.security, env, options: fix || {} });
  app.locals.fix = fixGw;
  const hub = attachWs(server, { db, engine, auth: app.locals.auth, security: app.locals.security, upgrade: (req, socket, head, url) => tradeWs.handleUpgrade(req, socket, head, url.pathname) || app.locals.portal.demoUpgrade(req, socket, head, url),
    onFanout: (sec) => app.locals.obs.fanout.observe({}, sec) });
  app.locals.wsHub = hub; // admin health page (server/admin.js)
  const ticker = setInterval(() => { try { engine.tick(); } catch (e) { console.error('tick', e); } }, tickMs);
  let bound;
  // Phase 9A jobs: key ring metadata and offline-rotation re-encryption, the media move; with `schedule`, the backup
  // schedule and WAL shipping, audit anchors, alerts, drills and log retention.
  app.locals.ops.startJobs({ schedule: !!ops.schedule });
  const stopOps = async () => { try { app.locals.ops.stopJobs(); await app.locals.backups.close(); await app.locals.obs.close(); } catch { /* best effort at shutdown */ } };
  try {
    bound = await listen(server, port, !explicit);
    // Prometheus metrics on a private port (METRICS_PORT / ops.metricsPort), never on the public listener.
    const mp = ops.metricsPort ?? process.env.METRICS_PORT;
    if (mp != null && mp !== '') app.locals.obs.metricsPort = await app.locals.obs.listen({ port: mp });
  } catch (e) {
    clearInterval(ticker); hub.close(); tradeWs.close(); fixGw.close(); app.locals.apiKeys?.close(); app.locals.cms?.close(); app.locals.webpush?.close(); app.locals.payments?.close(); app.locals.identity?.close(); app.locals.security.close();
    await stopOps(); db.close();
    throw e;
  }
  // Sandbox payment providers deliver their webhooks to this server over loopback HTTP (server/payment-providers.js).
  app.locals.payments?.setDeliveryBase(`http://127.0.0.1:${bound}`);
  if (port !== 0 && bound !== port) console.warn(`Port ${port} is in use; using ${bound} instead.`); // 0 = any free port
  if (!quiet) for (const n of boot.notices) console.log(n);
  // Demo environment (CLONE_SPEC.md §35.11): a second exchange in this process, own port and SQLite file, play money,
  // its own users and keys; the main site proxies /demo-api to it. Off for programmatic starts unless `demo` is given.
  let demoSrv = null;
  if (demo && env === 'main') {
    try {
      const demoDb = demo.dbFile || process.env.DEMO_DB_FILE || (dbFile === ':memory:' ? ':memory:' : dbFile.replace(/(\.db)?$/, '.demo.db'));
      demoSrv = await start({ port: demo.port ?? (process.env.DEMO_PORT ? Number(process.env.DEMO_PORT) : 0), dbFile: demoDb, env: 'demo', quiet: true, tickMs, rate, perps, combos, sports: false, marketsContent: {}, assets: 'src',
        security: { ...(security || {}), challengeMode: 'off' }, api: demo.api || api, flags: { overrides: { 'api.fix': false, ...(demo.flagOverrides || {}) }, defaults: { 'perps.waitlist': false } } });
      app.locals.demo = { port: demoSrv.port, app: demoSrv.app, close: () => demoSrv.close() };
      if (!quiet) console.log(`Demo environment (play money) on http://localhost:${demoSrv.port}, proxied at /demo-api/trade-api/v2`);
    } catch (e) { console.error(`Demo environment did not start: ${e.message}`); }
  }
  const setupUrl = boot.setupPath ? `http://localhost:${bound}${boot.setupPath}` : null;
  if (setupUrl && !quiet) console.log(`No admin account can sign in yet. Create the first admin within 60 minutes (single use):\n  ${setupUrl}\nor set ADMIN_EMAIL and ADMIN_PASSWORD, or run: npm run create-admin`);
  return {
    port: bound, db, engine, server, app, fix: fixGw, setupUrl, setupPath: boot.setupPath,
    demo: demoSrv,
    metricsPort: app.locals.obs.metricsPort || null,
    close: () => new Promise((r) => { if (demoSrv) demoSrv.close().catch(() => {}); clearInterval(ticker); hub.close(); tradeWs.close(); fixGw.close(); app.locals.apiKeys?.close(); app.locals.cms?.close(); app.locals.webpush?.close(); app.locals.payments?.close(); app.locals.identity?.close(); app.locals.security.close(); server.close(() => { stopOps().finally(() => { db.close(); r(); }); }); server.closeAllConnections?.(); }),
  };
}

module.exports = { start, DEFAULT_PORT };

if (require.main === module) {
  // npm start serves the hashed production bundle (built if missing or stale); npm run dev serves the sources.
  // Identity verification gates trading and deposits by default when run as the server (KYC_REQUIRED=0 turns it off);
  // programmatic start() leaves it off unless `identity: { kycRequired: true }`, KYC_REQUIRED=1 or NODE_ENV=production.
  // Production logs are JSON lines (scrubbed); LOG_FORMAT=pretty for a terminal. Every console line goes through them.
  if (process.env.NODE_ENV === 'production' || process.env.LOG_FORMAT) installConsole(createLogger({ level: process.env.LOG_LEVEL || 'info' }));
  start({ identity: { kycRequired: process.env.KYC_REQUIRED !== '0' }, sports: process.env.SPORTS === '0' ? false : {}, marketsContent: { seedHubs: true }, elections: { seed: true },
    flags: process.env.NODE_ENV === 'production' ? undefined : { defaults: { 'elections.simulator': true } }, demo: process.env.DEMO_API === '0' ? null : {}, assets: process.argv.includes('--dev') ? 'src' : (process.env.ASSETS || 'dist'),
    ops: { schedule: process.env.BACKUPS !== 'off' }, logs: process.env.NODE_ENV === 'production' || !!process.env.LOG_FORMAT }).then((srv) => {
    console.log(`Parlance Exchange listening on http://localhost:${srv.port}${srv.metricsPort ? ` (metrics on ${process.env.METRICS_HOST || '127.0.0.1'}:${srv.metricsPort})` : ''}`);
    // Ctrl+C / termination: close the HTTP server and database cleanly so the DB lock is released.
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      console.log('Stopping Parlance Exchange…');
      const force = setTimeout(() => process.exit(0), 3000);
      srv.close().then(() => { clearTimeout(force); process.exit(0); }, () => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }, (e) => {
    const msg = /database is locked/i.test(e.message) ? 'the database is busy — another Parlance server is probably still running on it. Stop the other server (Ctrl+C in its terminal) and try again.' : e.message;
    if (e.code === 'CONFIG_GUARD' || e.code === 'schema_newer' || e.code === 'schema_checksum') { console.error(`Could not start Parlance Exchange: ${msg}`); process.exit(78); } // EX_CONFIG
    console.error(`Could not start Parlance Exchange: ${msg}`);
    process.exit(1);
  });
}
