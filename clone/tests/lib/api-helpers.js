'use strict';
// Shared setup for the Phase 7 suites (CLONE_SPEC.md §35): a real server on an OS-assigned port with its own SQLite
// file, signed-in API clients, identity approval (the A2 lock), and API keys made through the real routes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../../server/index.js');
const { Client } = require('./client');
const { SignedClient, ed25519, rsa, pubPem } = require('./signing');

const PW = 'Harbor-Quill-Saffron-4417';
const HIGH = { burst: 1e6, per_second: 1e6 };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, { timeout = 10000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { const v = await fn(); if (v !== false) return v; } catch (e) { if (Date.now() > end) throw e; } if (Date.now() > end) throw new Error('timed out waiting for condition'); await sleep(interval); }
}

function harness(name) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `parlance-${name}-`));
  const DB_FILE = path.join(TMP, `${name}.db`);
  const stamp = Date.now();
  const h = {
    TMP, DB_FILE, stamp, PW, srv: null, BASE: null, PORT: null,
    ADMIN: { email: `root.${name}.${stamp}@example.test`, password: PW },
    email: (n) => `${n}.${name}.${stamp}@example.test`,
    // Perps open: the Phase 7 suites trade Perps through /margin as new users; the waitlist gate is on by default since
    // Phase 7A (CLONE_SPEC.md §36.1), so these servers opt out explicitly (an `extra.flags` replaces it).
    opts: (extra = {}) => ({ port: h.PORT, dbFile: DB_FILE, tickMs: 200, quiet: true, admin: h.ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, flags: { defaults: { 'perps.waitlist': false } }, ...extra }),
    async start(extra = {}) {
      if (!h.PORT) { h.PORT = await freePort(); h.BASE = `http://127.0.0.1:${h.PORT}`; }
      h.srv = await start(h.opts(extra));
      return h.srv;
    },
    async stop() { if (h.srv) await h.srv.close(); h.srv = null; },
    cleanup() { fs.rmSync(TMP, { recursive: true, force: true }); },
    q: (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } },
    q1: (sql, ...a) => h.q(sql, ...a)[0],
    run: (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } },
    approve: (uid) => h.run("UPDATE identity_profiles SET status='approved' WHERE user_id=?", uid),
    async user(n, { approved = true, dollars = 0 } = {}) {
      const c = await new Client(h.BASE, n).signUp(h.email(n), PW, `${n[0].toUpperCase()}${n.slice(1)} Tester`);
      if (approved) h.approve(c.uid);
      if (dollars) { const r = await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: dollars }); if (r.status !== 201) throw new Error(`deposit ${r.status} ${r.text}`); }
      return c;
    },
    // A key made through POST /v1/users/:uid/api_keys (with step-up if asked). kind: 'rsa' (server-generated), 'ed25519'
    // or 'rsa-pub' (pasted public keys). Returns { id, privateKey, signed: SignedClient, body }.
    async key(c, { kind = 'ed25519', scopes = ['read', 'trade', 'perps'], ip_allowlist, expires_at, label = 'Test key' } = {}) {
      let body = { label, scopes, mode: 'generate', ...(ip_allowlist ? { ip_allowlist } : {}), ...(expires_at ? { expires_at } : {}) };
      let kp = null;
      if (kind !== 'rsa') { kp = kind === 'ed25519' ? ed25519() : rsa(); body = { ...body, mode: 'public_key', public_key: pubPem(kp) }; }
      let r = await c.call('POST', `/v1/users/${c.uid}/api_keys`, body);
      if (r.code === 'step_up_required') { await c.call('POST', '/v1/step_up', { password: PW }); r = await c.call('POST', `/v1/users/${c.uid}/api_keys`, body); }
      if (r.status !== 201) throw new Error(`api key ${r.status} ${r.text}`);
      const privateKey = kp ? kp.privateKey : r.body.private_key;
      return { id: r.body.api_key.api_key_id, privateKey, signed: new SignedClient(h.BASE, r.body.api_key.api_key_id, privateKey), body: r.body };
    },
    async adminClient() { return new Client(h.BASE, 'admin').logIn(h.ADMIN.email, PW); },
    openMarket: () => h.q1("SELECT m.ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status='active' AND m.fractional_trading_enabled=1 AND e.series_ticker NOT LIKE 'PLXFLASH%' AND m.mve_collection_ticker IS NULL AND m.market_type='binary' ORDER BY m.rowid LIMIT 1").ticker,
  };
  return h;
}

// A browser page that records page errors and CSP violations.
async function newPage(browser, { viewport = { width: 1400, height: 1000 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`)); });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return page;
}
async function uiLogIn(page, base, email, password = PW) {
  await page.goto(`${base}/sign-in`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await page.click('#auth-form button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
// Answers a step-up dialog if one opens within `ms`.
async function maybeStepUp(page, ms = 2500) {
  const d = await page.waitForSelector('[data-testid=step-up-dialog]', { timeout: ms }).catch(() => null);
  if (!d) return false;
  await page.fill('[data-testid=step-up-password]', PW);
  await page.click('[data-testid=step-up-submit]');
  await page.waitForSelector('[data-testid=step-up-dialog]', { state: 'detached', timeout: 8000 });
  return true;
}
const cspOf = (page) => page.evaluate(() => window.__csp || []);

module.exports = { harness, newPage, uiLogIn, maybeStepUp, cspOf, sleep, eventually, freePort, PW };
