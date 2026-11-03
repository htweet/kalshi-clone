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
      server.listen(p, '127.0.0.1');
    };
    tryPort(port);
  });
}

// Identity options (CLONE_SPEC §22): `admin: {email, password}` creates the first admin (else ADMIN_EMAIL +
// ADMIN_PASSWORD, else a one-time setup URL is printed and returned as `setupUrl`); `demoPassword` (or DEMO_PASSWORD)
// sets the seeded demo accounts' password, otherwise a random one is printed once; `auth` overrides session /
// lockout / step-up timings (server/auth.js DEFAULTS).
async function start({ port, defaultPort = DEFAULT_PORT, dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'parlance.db'), rate, tickMs = 1000, rollingWindowSec = Number(process.env.ROLLING_WINDOW_SEC || 900), perps, combos, sports,
  admin, demoPassword = process.env.DEMO_PASSWORD, auth, quiet = false, security, identity, payments, assets = process.env.ASSETS || (process.env.NODE_ENV === 'production' ? 'dist' : 'src') } = {}) {
  const explicit = port != null || !!process.env.PORT;
  if (port == null) port = process.env.PORT ? Number(process.env.PORT) : defaultPort;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT "${process.env.PORT ?? port}"`);
  // Perimeter (CLONE_SPEC §21): `assets: 'dist'` serves the hashed production bundle, built here when dist/ is
  // missing or stale (P1.11); `security` tunes CORS origins, trust proxy, bot thresholds and rate tiers (server/security.js).
  if (assets === 'dist') await require('../scripts/build').ensureBuilt();
  const db = open(dbFile);
  seed(db, { demoPassword, quiet });
  const engine = new Engine(db);
  const ta = db.prepare("SELECT value FROM meta WHERE key='trading_active'").get();
  if (ta) engine.tradingActive = ta.value === '1';
  const keyDir = dbFile === ':memory:' ? undefined : path.dirname(path.resolve(dbFile)); // secret.key lives next to the database
  let app; let boot;
  try {
    app = createApp({ db, engine, rollingWindowSec, perps, combos, sports, auth, keyDir, identity, payments: { quiet, ...(payments || {}) }, security: { ...(security || {}), assets }, rate: rate || { burst: Number(process.env.RATE_BURST || 300), perSec: Number(process.env.RATE_PER_SEC || 150) } });
    const envAdmin = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD ? { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } : null;
    boot = app.locals.auth.bootstrap({ admin: admin || envAdmin, demoPassword });
  } catch (e) { try { app?.locals.payments?.close(); app?.locals.identity?.close(); app?.locals.security?.close(); } catch { /* ignore */ } db.close(); throw e; }
  const server = http.createServer(app);
  const hub = attachWs(server, { db, engine, auth: app.locals.auth, security: app.locals.security });
  app.locals.wsHub = hub; // admin health page (server/admin.js)
  const ticker = setInterval(() => { try { engine.tick(); } catch (e) { console.error('tick', e); } }, tickMs);
  let bound;
  try {
    bound = await listen(server, port, !explicit);
  } catch (e) {
    clearInterval(ticker); hub.close(); app.locals.payments?.close(); app.locals.identity?.close(); app.locals.security.close(); db.close();
    throw e;
  }
  // Sandbox payment providers deliver their webhooks to this server over loopback HTTP (server/payment-providers.js).
  app.locals.payments?.setDeliveryBase(`http://127.0.0.1:${bound}`);
  if (port !== 0 && bound !== port) console.warn(`Port ${port} is in use; using ${bound} instead.`); // 0 = any free port
  if (!quiet) for (const n of boot.notices) console.log(n);
  const setupUrl = boot.setupPath ? `http://localhost:${bound}${boot.setupPath}` : null;
  if (setupUrl && !quiet) console.log(`No admin account can sign in yet. Create the first admin within 60 minutes (single use):\n  ${setupUrl}\nor set ADMIN_EMAIL and ADMIN_PASSWORD, or run: npm run create-admin`);
  return {
    port: bound, db, engine, server, setupUrl, setupPath: boot.setupPath,
    close: () => new Promise((r) => { clearInterval(ticker); hub.close(); app.locals.payments?.close(); app.locals.identity?.close(); app.locals.security.close(); server.close(() => { db.close(); r(); }); server.closeAllConnections?.(); }),
  };
}

module.exports = { start, DEFAULT_PORT };

if (require.main === module) {
  // npm start serves the hashed production bundle (built if missing or stale); npm run dev serves the sources.
  // Identity verification gates trading and deposits by default when run as the server (KYC_REQUIRED=0 turns it off);
  // programmatic start() leaves it off unless `identity: { kycRequired: true }`, KYC_REQUIRED=1 or NODE_ENV=production.
  start({ identity: { kycRequired: process.env.KYC_REQUIRED !== '0' }, sports: process.env.SPORTS === '0' ? false : {}, assets: process.argv.includes('--dev') ? 'src' : (process.env.ASSETS || 'dist') }).then((srv) => {
    console.log(`Parlance Exchange listening on http://localhost:${srv.port}`);
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
    console.error(`Could not start Parlance Exchange: ${msg}`);
    process.exit(1);
  });
}
