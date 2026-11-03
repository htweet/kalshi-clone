'use strict';
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

async function start({ port, defaultPort = DEFAULT_PORT, dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'parlance.db'), rate, tickMs = 1000, rollingWindowSec = Number(process.env.ROLLING_WINDOW_SEC || 900), perps, combos, sports } = {}) {
  const explicit = port != null || !!process.env.PORT;
  if (port == null) port = process.env.PORT ? Number(process.env.PORT) : defaultPort;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT "${process.env.PORT ?? port}"`);
  const db = open(dbFile);
  seed(db);
  const engine = new Engine(db);
  const ta = db.prepare("SELECT value FROM meta WHERE key='trading_active'").get();
  if (ta) engine.tradingActive = ta.value === '1';
  const app = createApp({ db, engine, rollingWindowSec, perps, combos, sports, rate: rate || { burst: Number(process.env.RATE_BURST || 300), perSec: Number(process.env.RATE_PER_SEC || 150) } });
  const server = http.createServer(app);
  const hub = attachWs(server, { db, engine });
  app.locals.wsHub = hub; // admin health page (server/admin.js)
  const ticker = setInterval(() => { try { engine.tick(); } catch (e) { console.error('tick', e); } }, tickMs);
  let bound;
  try {
    bound = await listen(server, port, !explicit);
  } catch (e) {
    clearInterval(ticker); hub.close(); db.close();
    throw e;
  }
  if (bound !== port) console.warn(`Port ${port} is in use; using ${bound} instead.`);
  return {
    port: bound, db, engine, server,
    close: () => new Promise((r) => { clearInterval(ticker); hub.close(); server.close(() => { db.close(); r(); }); server.closeAllConnections?.(); }),
  };
}

module.exports = { start, DEFAULT_PORT };

if (require.main === module) {
  start({ sports: process.env.SPORTS === '0' ? false : {} }).then((srv) => {
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
