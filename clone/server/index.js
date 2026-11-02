'use strict';
const http = require('node:http');
const path = require('node:path');
const { open } = require('./db');
const { seed } = require('./seed');
const { Engine } = require('./engine');
const { createApp } = require('./app');
const { attachWs } = require('./ws');

function start({ port = Number(process.env.PORT || 3000), dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'parlance.db'), rate, tickMs = 1000 } = {}) {
  const db = open(dbFile);
  seed(db);
  const engine = new Engine(db);
  const ta = db.prepare("SELECT value FROM meta WHERE key='trading_active'").get();
  if (ta) engine.tradingActive = ta.value === '1';
  const app = createApp({ db, engine, rate: rate || { burst: Number(process.env.RATE_BURST || 300), perSec: Number(process.env.RATE_PER_SEC || 150) } });
  const server = http.createServer(app);
  const hub = attachWs(server, { db, engine });
  const ticker = setInterval(() => { try { engine.tick(); } catch (e) { console.error('tick', e); } }, tickMs);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: addr.port, db, engine, server,
        close: () => new Promise((r) => { clearInterval(ticker); hub.close(); server.close(() => { db.close(); r(); }); server.closeAllConnections?.(); }),
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port }) => console.log(`Parlance Exchange listening on http://127.0.0.1:${port}`));
}
