'use strict';
// End-to-end tests for Phase 5D feature flags and money controls (CLONE_SPEC.md §33), against a real server, a real
// SQLite file and Chromium:
//   • enforcement: every mounted route is either switched by a flag or listed as platform core; every flag rule matches
//     a route; every mount* module of server/app.js is mapped; every [data-flag] in the SPA names a registered flag;
//   • every flag off hides its UI and blocks its API (403 feature_disabled), then on again;
//   • rollout percentage (stable bucket), allow / deny by user, role and region, schedule (live at the boundary);
//   • kill switch, reason + step-up, change history, hash-chained audit, live WebSocket update of an open page, the
//     Admin › Feature flags UI, jobs paused while off, persistence across a restart and the env override precedence;
//   • per-user deposit / withdrawal revocation from Admin › Users (every rail, live, reason shown, audited) and the
//     site-wide deposit / withdrawal switches.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');
const flagsMod = require('../server/flags.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-flags-'));
const DB_FILE = path.join(TMP, 'flags.db');
const PORT = 21000 + Math.floor(Math.random() * 30000);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'Copper-Kettle-Orbit-4821';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, quiet: true, admin: ADMIN, sports: { speed: 20 }, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } };
const EVENT_URL = '/markets/plxsnow/snow/plxsnow-26dec';
const SNOW = 'PLXSNOW-26DEC';

let srv; let browser; let admin; let A; let B;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000, what = 'condition') => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(100); } };
const email = (n) => `${n}.${stamp}@example.test`;
async function newPage(viewport = { width: 1400, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}
async function uiLogIn(page, u) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', u.password || PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
// Admin call with a fresh step-up when the 10-minute window has passed (a long suite).
async function adminCall(method, p, body) {
  let r = await admin.call(method, p, body);
  if (r.code === 'step_up_required') { assert.equal((await admin.call('POST', '/v1/step_up', { password: ADMIN.password })).status, 200); r = await admin.call(method, p, body); }
  return r;
}
async function setFlag(key, change, reason = 'e2e flag change') {
  const r = await adminCall('PUT', `/v1/admin/flags/${key}`, { ...change, reason });
  assert.equal(r.status, 200, `${key}: ${r.text}`);
  return r.body.flag;
}
const reset = (key) => setFlag(key, { enabled: true, kill: false, rollout_pct: 100, allow_users: [], deny_users: [], allow_roles: [], deny_roles: [], allow_regions: [], deny_regions: [], starts_at: null, ends_at: null }, 'e2e reset');
const disabled = (r, key) => assert.ok(r.status === 403 && r.code === 'feature_disabled' && (!key || r.body.error.feature === key), `expected 403 feature_disabled (${key}), got ${r.status} ${r.text.slice(0, 200)}`);
const enabledOk = (r, label) => assert.ok(!(r.status === 403 && r.code === 'feature_disabled'), `${label}: still disabled ${r.text.slice(0, 160)}`);
// The flag class is applied to every inserted node (public/js/flags.js).
// Waits for the element, then for the flag class (the bundle may still be loading right after a navigation).
const hiddenByFlag = async (page, sel) => {
  await page.waitForSelector(sel, { state: 'attached', timeout: 8000 });
  return page.waitForFunction((x) => { const n = document.querySelector(x); return !!n && n.classList.contains('flag-off') && getComputedStyle(n).display === 'none'; }, sel, { timeout: 4000 }).then(() => true, () => false);
};

before(async () => {
  srv = await start(OPTS);
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  A = await new Client(BASE, 'alice').signUp(email('alice'), PW, 'Alice Flag');
  B = await new Client(BASE, 'bob').signUp(email('bob'), PW, 'Bob Flag');
  for (const c of [A, B]) assert.equal((await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: 200 })).status, 201);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('enforcement: every route is flagged or core, every flag rule is live, every app.js module and [data-flag] is registered', () => {
  const app = srv.server.listeners('request')[0];
  const mounts = new Map((app.locals.routers || []).map(([prefix, router]) => [router, prefix]));
  const routes = [];
  (function walk(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) { const p = layer.route.path; for (const m of Object.keys(layer.route.methods)) routes.push({ method: m.toUpperCase(), path: p instanceof RegExp ? `RE:${p.source}` : prefix + p }); }
      else if (layer.handle && Array.isArray(layer.handle.stack) && mounts.has(layer.handle)) walk(layer.handle.stack, mounts.get(layer.handle));
    }
  })(app.router.stack, '');
  assert.ok(routes.length > 300, `route set too small (${routes.length})`);
  // Concrete sample paths for a route pattern (provider routes are tried with each provider name).
  const samples = (p) => ['x', 'google', 'apple'].map((v) => p.replace(/:uid/g, 'u_x').replace(/:provider/g, v).replace(/:([A-Za-z_]+)/g, 'x'));
  const sample = (p) => samples(p)[0];
  const hit = (x, r) => (x.method === '*' || x.method === r.method) && samples(r.path.slice(3)).some((p) => x.re.test(p));
  const flagged = (r) => r.path.startsWith('/v1/') && Object.values(flagsMod.ROUTE_RULES).some((rules) => rules.some((x) => hit(x, r)));
  const core = (r) => flagsMod.CORE_ROUTES.some((re) => re.test(sample(r.path)));
  const orphan = routes.filter((r) => !flagged(r) && !core(r)).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(orphan, [], 'routes without a feature flag and not platform core: register a flag (server/flags.js ROUTE_RULES) or list them in CORE_ROUTES');
  // Each rule matches at least one mounted route (no dead rules) and names a registered flag.
  const keys = new Set(flagsMod.REGISTRY.map((r) => r[0]));
  for (const [key, rules] of Object.entries(flagsMod.ROUTE_RULES)) {
    assert.ok(keys.has(key), `rule for unknown flag ${key}`);
    for (const x of rules) assert.ok(routes.some((r) => r.path.startsWith('/v1/') && hit(x, r)), `${key}: rule ${x.method} ${x.re} matches no route`);
  }
  for (const k of flagsMod.JOB_FLAGS) assert.ok(keys.has(k), `job flag ${k} not registered`);
  // Every mount* module wired in server/app.js has a flag (or is core).
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
  const mounted = [...new Set([...appSrc.matchAll(/(?<![.\w])(mount[A-Z]\w*)\(\{/g)].map((m) => m[1]))];
  const unmapped = mounted.filter((m) => !flagsMod.MODULE_FLAGS[m]);
  assert.deepEqual(unmapped, [], 'feature modules in server/app.js without an entry in MODULE_FLAGS');
  for (const [m, f] of Object.entries(flagsMod.MODULE_FLAGS)) assert.ok(f === 'core' || keys.has(f), `${m} maps to unknown flag ${f}`);
  // Every [data-flag] in the SPA and every admin label refer to registered flags.
  const files = [];
  (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'content') w(p); } else if (e.name.endsWith('.js')) files.push(p); } })(path.join(__dirname, '..', 'public', 'js'));
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/data-flag="([a-z0-9_. ]+)"/g)) for (const k of m[1].split(' ').filter(Boolean)) assert.ok(keys.has(k), `${path.basename(f)}: data-flag="${k}" is not a registered flag`);
  const labels = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'content', 'admin.flags-strings.js'), 'utf8');
  for (const k of keys) assert.ok(labels.includes(`"admin.flags.label.${k}"`), `no admin label for ${k}`);
});

test('every flag off hides its UI and blocks its API, then on again', async () => {
  const page = await newPage();
  await uiLogIn(page, { email: email('alice') });
  const guest = await newPage();
  const lines = dbq('SELECT market_ticker t FROM sports_lines LIMIT 1')[0]?.t;
  const ev = 'PLXSNOW-26DEC';
  const u = A.uid;
  // [flag, page probe (optional), api probe (optional)]: the page probe returns true once the UI is hidden.
  const openMore = async () => { await page.click('#more-btn'); await page.waitForSelector('.menu [data-testid=more-sports]', { state: 'attached' }); };
  const P = [
    ['perps', async () => { await page.goto(BASE + '/'); return hiddenByFlag(page, '.primary-nav [data-nav=invest]'); }, ['GET', '/v1/perps/markets']],
    ['combos', async () => { await page.goto(BASE + '/combos'); return page.isVisible('[data-testid=feature-unavailable][data-feature=combos]'); }, ['GET', '/v1/multivariate_event_collections']],
    ['combos.rfq', async () => { await page.goto(BASE + '/portfolio'); await page.waitForSelector('#pf-tabs [data-tab=rfqs]', { state: 'attached' }); return hiddenByFlag(page, '#pf-tabs [data-tab=rfqs]'); }, ['GET', '/v1/communications/rfqs']],
    ['sports', async () => { await page.goto(BASE + '/sports'); return page.isVisible('[data-testid=feature-unavailable][data-feature=sports]'); }, ['GET', '/v1/sports/leagues']],
    ['sports.lines', null, lines ? ['POST', `/v1/users/${u}/orders`, { ticker: lines, side: 'yes', type: 'limit', price: 1, count: 1 }] : null],
    ['social', async () => { await page.goto(BASE + '/'); await openMore(); return hiddenByFlag(page, '.menu [data-testid=more-social]'); }, ['GET', '/v1/social/posts']],
    ['social.group_chat', async () => { await page.goto(BASE + '/'); return hiddenByFlag(page, '[data-testid=messages-btn]'); }, ['GET', `/v1/users/${u}/groups`]],
    ['social.chat', async () => { await page.goto(BASE + EVENT_URL); await page.waitForSelector('[data-testid=chat-pill]', { state: 'attached' }); return hiddenByFlag(page, '[data-testid=chat-pill]'); }, ['GET', `/v1/events/${ev}/chat`]],
    ['watchlist', async () => { await page.goto(BASE + EVENT_URL); await page.waitForSelector('[data-testid=watch-btn]', { state: 'attached' }); return hiddenByFlag(page, '[data-testid=watch-btn]'); }, ['GET', `/v1/users/${u}/watchlist`]],
    ['price_alerts', async () => { await page.goto(BASE + EVENT_URL); await page.waitForSelector('#alerts', { state: 'attached' }); return hiddenByFlag(page, '#alerts'); }, ['GET', `/v1/users/${u}/notifications/custom_price_targets`]],
    ['interest', async () => { await page.goto(BASE + EVENT_URL); await page.waitForSelector('#interest-btn', { state: 'attached' }); return hiddenByFlag(page, '#interest-btn'); }, ['GET', `/v1/users/${u}/interest`]],
    ['trading', async () => { await page.goto(BASE + EVENT_URL); return !!(await page.waitForSelector('[data-testid=ticket-unavailable]', { timeout: 5000 }).catch(() => null)); }, ['POST', `/v1/users/${u}/orders`, { ticker: SNOW, side: 'yes', type: 'limit', price: 1, count: 1 }]],
    ['trading.market_orders', async () => { await page.goto(BASE + EVENT_URL); await page.waitForSelector('#t-mode-btn'); return (await page.locator('#t-mode-menu [data-otype=market]').count()) === 0; }, ['POST', `/v1/users/${u}/orders`, { ticker: SNOW, side: 'yes', type: 'market', count: 1 }]],
    ['trading.limit_orders', async () => { await page.goto(BASE + EVENT_URL); await page.waitForSelector('#t-mode-btn'); return (await page.locator('#t-mode-menu [data-otype=limit]').count()) === 0; }, ['POST', `/v1/users/${u}/orders`, { ticker: SNOW, side: 'yes', type: 'limit', price: 1, count: 1 }]],
    ['trading.dollars_orders', async () => { await page.goto(BASE + EVENT_URL); await page.waitForSelector('#t-mode-btn'); return (await page.locator('#t-mode-menu [data-otype=dollars]').count()) === 0; }, ['POST', `/v1/users/${u}/orders`, { ticker: SNOW, side: 'yes', type: 'dollars', amount_dollars: 1 }]],
    ['trading.order_review', async () => { await page.goto(BASE + EVENT_URL); await page.waitForSelector('[data-testid=submit-order]'); return !/Review/.test(await page.textContent('[data-testid=submit-order]')); }, null],
    ['trading.flip_sell', null, ['GET', `/v1/users/${u}/positions/${SNOW}/flip_preview?side=yes&count=1`]],
    ['trading.fractional', null, ['POST', `/v1/users/${u}/orders`, { ticker: SNOW, side: 'yes', type: 'limit', price: 1, count: 1.5 }]],
    ['trading.scalar', null, ['POST', `/v1/users/${u}/orders`, { ticker: 'PLXGDP-26Q4', side: 'yes', type: 'limit', price: 1, count: 1 }]],
    ['trading.collateral_return', null, ['GET', `/v1/users/${u}/collateral_returns`]],
    ['trading.rolling', async () => { await page.goto(BASE + '/live'); await page.waitForSelector('#flash', { state: 'attached' }); return hiddenByFlag(page, '#flash'); }, ['GET', '/v1/rolling/current']],
    // The Phase 5B elections hub is removed (owner decision 2026-11-08): the rates hub carries the hubs flags now.
    ['hubs', async () => { await page.goto(BASE + '/hubs/economics'); return page.isVisible('[data-testid=feature-unavailable][data-feature=hubs]'); }, null],
    ['hubs.widgets', async () => { await page.goto(BASE + '/hubs/economics'); await page.waitForSelector('[data-testid=fed-outlook]', { state: 'attached' }); return hiddenByFlag(page, '[data-testid=fed-outlook]'); }, ['GET', '/v1/hubs/fed_funds_outlook']],
    ['ballot', async () => { await page.goto(BASE + '/ballot'); return page.isVisible('[data-testid=feature-unavailable][data-feature=ballot]'); }, ['POST', '/v1/ballot/lookup', { query: '90142' }]],
    ['incentives', async () => { await page.goto(BASE + '/'); await openMore(); return hiddenByFlag(page, '.menu [data-testid=more-incentives]'); }, ['GET', '/v1/incentive_programs']],
    ['rewards', async () => { await page.goto(BASE + '/'); await page.click('[data-testid=account-menu]'); await page.waitForSelector('[data-testid=menu-rewards]', { state: 'attached' }); return hiddenByFlag(page, '[data-testid=menu-rewards]'); }, ['GET', '/v1/rewards/new_user_checklist']],
    ['ai_summaries', null, ['GET', `/v1/events/${ev}/ai_summary`]],
    ['payments.deposits', async () => { await page.goto(BASE + '/funds'); await page.waitForSelector('[data-testid=go-deposit]', { state: 'attached' }); return hiddenByFlag(page, '[data-testid=go-deposit]'); }, ['POST', `/v1/users/${u}/deposits`, { amount_dollars: 1 }]],
    ['payments.withdrawals', async () => { await page.goto(BASE + '/funds/withdraw'); return page.isVisible('[data-testid=feature-unavailable][data-feature="payments.withdrawals"]'); }, ['POST', `/v1/users/${u}/withdrawals`, { amount_dollars: 1 }]],
    ['payments.card', async () => { await page.goto(BASE + '/funds/deposit'); await page.waitForSelector('[data-testid=fund-method]'); return (await page.locator('[data-method=new-card]').count()) === 0; }, ['GET', `/v1/users/${u}/debit/cards`]],
    ['payments.bank', async () => { await page.goto(BASE + '/funds/deposit'); await page.waitForSelector('[data-testid=fund-method]'); return (await page.locator('[data-method=new-bank]').count()) === 0; }, ['GET', `/v1/users/${u}/banks/all_accounts`]],
    ['payments.crypto', async () => { await page.goto(BASE + '/funds/deposit'); await page.waitForSelector('[data-testid=fund-method]'); return (await page.locator('[data-method=crypto]').count()) === 0; }, ['GET', '/v1/payments/supported_networks']],
    ['identity.kyc', async () => { await page.goto(BASE + '/sign-up/identity'); return page.isVisible('[data-testid=feature-unavailable][data-feature="identity.kyc"]'); }, ['GET', `/v1/users/${u}/sign_up`]],
    ['accounts.signup', async () => { await guest.goto(BASE + '/sign-in'); await guest.waitForSelector('[data-testid=sign-up-link]', { state: 'attached' }); return hiddenByFlag(guest, '[data-testid=sign-up-link]'); }, ['POST', '/v1/users', () => ({ email: email(`nobody${Math.random().toString(36).slice(2, 8)}`), password: PW, display_name: 'No Body' }), 'anon']],
    ['signin.password', async () => { await guest.goto(BASE + '/sign-in'); await guest.waitForSelector('[data-testid=forgot-link]', { state: 'attached' }); return hiddenByFlag(guest, '.auth-forgot'); }, ['POST', '/v1/log_in', { email: email('bob'), password: PW }, 'anon']],
    ['signin.oauth', async () => { await guest.goto(BASE + '/sign-in'); await guest.waitForSelector('[data-testid=oauth-google]', { state: 'attached' }); return hiddenByFlag(guest, '[data-testid=oauth-google]'); }, ['POST', '/v1/oauth/google/start', {}, 'anon']],
    ['signin.google', async () => { await guest.goto(BASE + '/sign-in'); await guest.waitForSelector('[data-testid=oauth-google]', { state: 'attached' }); return hiddenByFlag(guest, '[data-testid=oauth-google]'); }, ['POST', '/v1/oauth/google/start', {}, 'anon']],
    ['signin.apple', async () => { await guest.goto(BASE + '/sign-in'); await guest.waitForSelector('[data-testid=oauth-apple]', { state: 'attached' }); return hiddenByFlag(guest, '[data-testid=oauth-apple]'); }, ['POST', '/v1/oauth/apple/start', {}, 'anon']],
    ['signin.passkey', null, ['POST', '/v1/passkeys/authentication/options', {}, 'anon']],
    ['pwa.push', async () => { await page.goto(BASE + '/notifications/settings'); await page.waitForSelector('[data-testid=push-browser]', { state: 'attached' }); return hiddenByFlag(page, '[data-testid=push-browser]'); }, ['GET', '/v1/push/vapid_public_key']],
    ['currency_switch', null, ['PUT', '/v1/admin/settings/currency', { display_currency: { code: 'USD' }, reason: 'flag probe' }, 'admin']],
  ];
  // Signed-out probes use a fresh visitor each time (a successful sign-up or log-in turns a client into a session).
  const run = async (who, api) => (who === 'anon' ? await new Client(BASE, 'anon').boot() : who === 'admin' ? admin : A).call(api[0], api[1], typeof api[2] === 'function' ? api[2]() : api[2]);
  const anon = await new Client(BASE, 'anon').boot();
  for (const [key, ui, api] of P) {
    // On: the UI is there and the API answers.
    if (api) enabledOk(await run(api[3], api), `${key} on`);
    await setFlag(key, { enabled: false });
    if (ui) assert.ok(await until(ui, 8000, `${key} UI hidden`), `${key}: UI still shown`);
    if (api) disabled(await run(api[3], api), key);
    await reset(key);
    if (api) enabledOk(await run(api[3], api), `${key} back on`);
  }
  // A child follows its parent: social off disables group chats too.
  await setFlag('social', { enabled: false });
  disabled(await A.call('GET', `/v1/users/${u}/groups`), 'social.group_chat');
  assert.equal((await A.call('GET', '/v1/feature_flags')).body.flags['social.group_chat'], false);
  await reset('social');
  // Pipeline flags: in-app notifications off → a transfer notice is not stored; email off → no email delivery queued.
  await setFlag('notify.inapp', { enabled: false });
  const before0 = dbq('SELECT COUNT(*) c FROM notifications WHERE user_id=?', u)[0].c;
  assert.equal((await A.call('POST', `/v1/users/${u}/deposits`, { amount_dollars: 1 })).status, 201);
  await sleep(300);
  assert.equal(dbq('SELECT COUNT(*) c FROM notifications WHERE user_id=?', u)[0].c, before0, 'no in-app row while notify.inapp is off');
  await reset('notify.inapp');
  assert.equal((await A.call('POST', `/v1/users/${u}/deposits`, { amount_dollars: 1 })).status, 201);
  await until(() => dbq('SELECT COUNT(*) c FROM notifications WHERE user_id=?', u)[0].c > before0, 5000, 'in-app notice after re-enable');
  await setFlag('notify.email', { enabled: false });
  const em0 = dbq('SELECT COUNT(*) c FROM email_outbox WHERE user_id=?', u)[0].c;
  // Transfers email is on by default (Settings › Notifications), so without the flag this deposit would queue an email.
  assert.equal((await A.call('POST', `/v1/users/${u}/deposits`, { amount_dollars: 1 })).status, 201);
  await sleep(1500);
  assert.equal(dbq('SELECT COUNT(*) c FROM email_outbox WHERE user_id=?', u)[0].c, em0, 'no email while notify.email is off');
  await reset('notify.email');
  // CMS live updates off: a publish sends no `content` message to open pages.
  const ws = anon.socket(); await ws.opened; await ws.subscribe(['content']);
  await setFlag('cms.live_updates', { enabled: false });
  const key = 'shell.html.nav_markets';
  assert.equal((await admin.call('PUT', '/v1/admin/cms/text/draft', { key, value: 'Markets now' })).status, 200);
  assert.equal((await admin.call('POST', '/v1/admin/cms/text/publish', { key, reason: 'flag test publish' })).status, 200);
  await sleep(800);
  assert.equal(ws.messages.filter((m) => m.type === 'content').length, 0, 'no live content push while cms.live_updates is off');
  await reset('cms.live_updates');
  assert.equal((await admin.call('POST', '/v1/admin/cms/text/rollback', { key, version: 0, reason: 'flag test rollback' })).status, 200);
  await ws.waitFor((m) => m.type === 'content', 5000);
  ws.close();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(guest.errors, []);
});

test('rollout percentage, allow / deny by user, role and region', async () => {
  const users = [];
  for (let i = 0; i < 12; i++) users.push(await new Client(BASE, `r${i}`).signUp(email(`roll${i}`), PW, `Roll User${i}`));
  await setFlag('ballot', { rollout_pct: 50 });
  const inside = users.filter((c) => flagsMod.bucket('ballot', c.uid) < 50);
  const outside = users.filter((c) => flagsMod.bucket('ballot', c.uid) >= 50);
  assert.ok(inside.length && outside.length, 'the sample spans both sides of the rollout');
  for (const c of inside) enabledOk(await c.call('POST', '/v1/ballot/lookup', { query: '90142' }), 'inside rollout');
  for (const c of outside) disabled(await c.call('POST', '/v1/ballot/lookup', { query: '90142' }), 'ballot');
  // Stable: the same users get the same answer again; anonymous visitors are outside a partial rollout.
  for (const c of inside) assert.equal((await c.call('GET', '/v1/feature_flags')).body.flags.ballot, true);
  for (const c of outside) assert.equal((await c.call('GET', '/v1/feature_flags')).body.flags.ballot, false);
  disabled(await new Client(BASE).boot().then((x) => x.call('POST', '/v1/ballot/lookup', { query: '90142' })), 'ballot');
  // UI: an outside user sees the managed "not available" page, an inside user the lookup.
  const pIn = await newPage(); await uiLogIn(pIn, { email: email(`roll${users.indexOf(inside[0])}`) });
  await pIn.goto(BASE + '/ballot'); await pIn.waitForSelector('[data-testid=ballot]');
  const pOut = await newPage(); await uiLogIn(pOut, { email: email(`roll${users.indexOf(outside[0])}`) });
  await pOut.goto(BASE + '/ballot'); await pOut.waitForSelector('[data-testid=feature-unavailable][data-feature=ballot]');
  // Allow user (skips the rollout) and deny user (wins over everything but the env override).
  await setFlag('ballot', { rollout_pct: 0, allow_users: [email(`roll${users.indexOf(outside[0])}`)], deny_users: [inside[0].uid] });
  enabledOk(await outside[0].call('POST', '/v1/ballot/lookup', { query: '90142' }), 'allowed user');
  disabled(await inside[0].call('POST', '/v1/ballot/lookup', { query: '90142' }), 'ballot');
  disabled(await inside[1].call('POST', '/v1/ballot/lookup', { query: '90142' }), 'ballot');
  const f = (await admin.call('GET', '/v1/admin/flags/ballot')).body.flag;
  assert.equal(f.allow_users[0].email, email(`roll${users.indexOf(outside[0])}`), 'emails resolved to ids and shown back');
  // Roles: rollout 0 but staff allowed; deny the "user" role (every signed-in account) while guests keep it.
  await setFlag('ballot', { allow_users: [], deny_users: [], allow_roles: ['admin'] });
  enabledOk(await admin.call('POST', '/v1/ballot/lookup', { query: '90142' }), 'admin role allowed');
  disabled(await B.call('POST', '/v1/ballot/lookup', { query: '90142' }), 'ballot');
  await setFlag('ballot', { rollout_pct: 100, allow_roles: [], deny_roles: ['user'] });
  disabled(await B.call('POST', '/v1/ballot/lookup', { query: '90142' }), 'ballot');
  enabledOk(await new Client(BASE).boot().then((x) => x.call('POST', '/v1/ballot/lookup', { query: '90142' })), 'guest keeps it');
  assert.equal((await admin.call('PUT', '/v1/admin/flags/ballot', { deny_roles: ['wizard'], reason: 'bad role' })).status, 400);
  // Regions: this test client is 127.0.0.1 → NG through the simulated IP table override.
  assert.equal((await adminCall('PUT', '/v1/admin/compliance/settings', { ip_overrides: [{ cidr: '127.0.0.1/32', country: 'NG' }], reason: 'flags region test' })).status, 200);
  await setFlag('ballot', { deny_roles: [], allow_regions: ['GH'] });
  disabled(await B.call('POST', '/v1/ballot/lookup', { query: '90142' }), 'ballot');
  await setFlag('ballot', { allow_regions: ['NG', 'GH'] });
  enabledOk(await B.call('POST', '/v1/ballot/lookup', { query: '90142' }), 'region allowed');
  await setFlag('ballot', { allow_regions: [], deny_regions: ['NG'] });
  disabled(await B.call('POST', '/v1/ballot/lookup', { query: '90142' }), 'ballot');
  assert.equal((await adminCall('PUT', '/v1/admin/compliance/settings', { ip_overrides: [], reason: 'flags region test done' })).status, 200);
  await reset('ballot');
  assert.deepEqual(pIn.errors, []); assert.deepEqual(pOut.errors, []);
});

test('schedule: a flag turns on at its start and off at its end, live on an open page', async () => {
  const page = await newPage();
  await uiLogIn(page, { email: email('alice') });
  await page.goto(BASE + '/incentives');
  await page.waitForSelector('[data-testid=incentives-page]');
  const startAt = Date.now() + 3000;
  await setFlag('incentives', { starts_at: new Date(startAt).toISOString(), ends_at: new Date(startAt + 3000).toISOString() });
  disabled(await A.call('GET', '/v1/incentive_programs'), 'incentives');
  // The admin change reaches the open page live: the route re-renders as "not available".
  await page.waitForSelector('[data-testid=feature-unavailable][data-feature=incentives]', { timeout: 5000 });
  assert.equal((await A.call('GET', '/v1/feature_flags')).body.next_change_time, new Date(startAt).toISOString());
  // At the start the server nudges every page (no admin action): the page comes back without a reload.
  await page.waitForSelector('[data-testid=feature-unavailable]', { state: 'detached', timeout: 6000 });
  enabledOk(await A.call('GET', '/v1/incentive_programs'), 'inside the window');
  await page.waitForSelector('[data-testid=feature-unavailable][data-feature=incentives]', { timeout: 6000 });
  disabled(await A.call('GET', '/v1/incentive_programs'), 'incentives');
  assert.equal((await admin.call('PUT', '/v1/admin/flags/incentives', { starts_at: new Date(Date.now() + 5000).toISOString(), ends_at: new Date(Date.now() + 1000).toISOString(), reason: 'bad window' })).status, 400);
  await reset('incentives');
  assert.deepEqual(page.errors, []);
});

test('kill switch, reason, step-up, history, audit chain, Admin › Feature flags UI and live update', async () => {
  // Reason and step-up are required.
  assert.equal((await admin.call('PUT', '/v1/admin/flags/perps', { enabled: false })).status, 400);
  const stale = await new Client(BASE, 'stale').logIn(ADMIN.email, ADMIN.password);
  srv.db.prepare('UPDATE sessions SET auth_at=? WHERE user_id=?').run(Date.now() - 3600000, stale.user.user_id);
  const su = await stale.call('POST', '/v1/admin/flags/perps/kill', { reason: 'needs step-up' });
  assert.equal(su.code, 'step_up_required');
  assert.equal((await B.call('PUT', '/v1/admin/flags/perps', { enabled: false, reason: 'not staff' })).status, 403);
  // The UI: an open user page hides Perps live when an admin kills it from Admin › Feature flags.
  const user = await newPage();
  await uiLogIn(user, { email: email('bob') });
  await user.goto(BASE + '/perps');
  await user.waitForSelector('[data-testid=perps-list], [data-testid=perps], .perps', { timeout: 8000 }).catch(() => {});
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/flags');
  await ap.waitForSelector('[data-testid=flags-table] [data-flag-key=perps]');
  await ap.click('[data-flag-key=perps] [data-testid=flag-kill]');
  await ap.fill('[data-testid=confirm-reason]', 'incident: perps price feed');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-flag-key=perps] [data-testid=flag-unkill]');
  await user.waitForSelector('[data-testid=feature-unavailable][data-feature=perps]', { timeout: 8000 });
  assert.ok(await hiddenByFlag(user, '.primary-nav [data-nav=invest]'));
  disabled(await B.call('GET', '/v1/perps/markets'), 'perps');
  // Kill wins over enabled; the env/start override wins over the kill (checked after the restart below).
  assert.equal((await admin.call('GET', '/v1/admin/flags/perps')).body.flag.effective_reason, 'kill_switch');
  // Edit dialog: rollout, reason, history.
  await ap.click('[data-flag-key=perps] [data-testid=flag-edit]');
  await ap.waitForSelector('[data-testid=flag-form]');
  assert.ok(await ap.locator('[data-testid=flag-history-row]').count() >= 1);
  await ap.uncheck('[data-testid=flag-form] [name=kill]');
  await ap.fill('[data-testid=flag-form] [name=rollout_pct]', '100');
  await ap.fill('[data-testid=flag-form] [name=reason]', 'feed restored');
  await ap.click('[data-testid=flag-form] button[type=submit]');
  await ap.waitForSelector('[data-flag-key=perps] [data-testid=flag-kill]');
  await user.waitForSelector('[data-testid=feature-unavailable]', { state: 'detached', timeout: 8000 });
  enabledOk(await B.call('GET', '/v1/perps/markets'), 'perps revived');
  const hist = dbq("SELECT action, reason FROM feature_flag_history WHERE flag_key='perps' ORDER BY ts");
  assert.deepEqual(hist.slice(-2).map((h) => [h.action, h.reason]), [['kill', 'incident: perps price feed'], ['unkill', 'feed restored']]);
  const audits = dbq("SELECT action, reason FROM admin_audit WHERE target_id='perps' AND action LIKE 'flags.%' ORDER BY ts");
  assert.deepEqual(audits.slice(-2).map((a) => a.action), ['flags.kill', 'flags.unkill']);
  assert.equal((await admin.call('GET', '/v1/admin/audit/verify')).body.ok, true, 'hash chain intact');
  assert.deepEqual(user.errors, []); assert.deepEqual(ap.errors, []);
});

test('jobs pause while their flag is off (sports simulation)', async () => {
  const last = () => dbq("SELECT MAX(updated_ts) t FROM sports_milestones WHERE status='live'")[0].t || 0;
  await until(() => dbq("SELECT COUNT(*) c FROM sports_milestones WHERE status='live'")[0].c > 0, 20000, 'a live game');
  await setFlag('sports', { enabled: false });
  await sleep(500);
  const t0 = last();
  await sleep(2000);
  assert.equal(last(), t0, 'no game advanced while sports is off');
  await reset('sports');
  await until(() => last() > t0, 8000, 'the simulation resumed');
});

test('money controls: per-user revocation from Admin › Users on every rail, live with the reason; site-wide switches', async () => {
  const user = await newPage();
  await uiLogIn(user, { email: email('alice') });
  await user.goto(BASE + '/funds/deposit');
  await user.waitForSelector('[data-testid=fund-method]');
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + `/admin/users/${A.uid}`);
  await ap.click('[data-testid=user-money-controls-btn]');
  await ap.check('[data-testid=money-controls-form] [name=deposits_revoked]');
  await ap.check('[data-testid=money-controls-form] [name=withdrawals_revoked]');
  await ap.fill('[data-testid=money-controls-form] [name=reason]', 'Account review in progress');
  await ap.click('[data-testid=money-controls-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=user-money-controls] .adm-badge.bad');
  // Live: the open deposit page switches to the blocked state with the reason, without a reload.
  await user.waitForSelector('[data-testid=money-blocked][data-code=deposits_revoked]', { timeout: 8000 });
  assert.match(await user.textContent('[data-testid=money-blocked-reason]'), /Account review in progress/);
  // Every rail and the demo method refuse, with the reason in the error.
  const u = A.uid; const key = { 'Idempotency-Key': `k-${Date.now()}` };
  for (const [m, p, b] of [['POST', `/v1/users/${u}/deposits`, { amount_dollars: 5 }], ['POST', `/v1/users/${u}/debit/payment`, { token: 'x', amount_dollars: 5 }], ['POST', `/v1/users/${u}/bank_link/deposit`, { bank_id: 'x', amount_dollars: 5 }],
    ['POST', `/v1/users/${u}/crypto/simulate_deposit`, { amount_dollars: 5 }], ['PUT', `/v1/users/${u}/crypto/account`, { accept_terms: true }]]) {
    const r = await A.call(m, p, b, key);
    assert.equal(r.code, 'deposits_revoked', `${m} ${p}: ${r.text}`);
    assert.equal(r.body.error.reason, 'Account review in progress');
  }
  for (const [m, p, b] of [['POST', `/v1/users/${u}/withdrawals`, { amount_dollars: 5 }], ['POST', `/v1/users/${u}/debit/withdrawal`, { card_id: 'x', amount_dollars: 5 }], ['POST', `/v1/users/${u}/bank_link/withdrawal`, { bank_id: 'x', amount_dollars: 5 }], ['POST', `/v1/users/${u}/crypto/withdrawal`, { wallet_id: 'x', amount_dollars: 5 }]]) {
    const r = await A.call(m, p, b, key);
    assert.equal(r.code, 'withdrawals_revoked', `${m} ${p}: ${r.text}`);
  }
  // Another user is unaffected; the user got a notice (CMS template money_controls); audited.
  assert.equal((await B.call('POST', `/v1/users/${B.uid}/deposits`, { amount_dollars: 2 })).status, 201);
  assert.ok(dbq("SELECT 1 FROM notifications WHERE user_id=? AND type='money_controls'", u).length);
  assert.ok(dbq("SELECT 1 FROM admin_audit WHERE action='users.money_controls' AND target_id=?", u).length);
  assert.equal((await A.call('GET', `/v1/users/${u}/money_controls`)).body.money_controls.deposits_revoked, true);
  assert.equal((await B.call('GET', `/v1/users/${u}/money_controls`)).status, 403);
  // Restore deposits only.
  assert.equal((await adminCall('PUT', `/v1/admin/users/${u}/money_controls`, { deposits_revoked: false, withdrawals_revoked: true, reason: 'Review cleared for deposits' })).status, 200);
  await user.goto(BASE + '/funds/deposit');
  await user.waitForSelector('[data-testid=fund-method]');
  assert.equal((await A.call('POST', `/v1/users/${u}/deposits`, { amount_dollars: 3 })).status, 201);
  assert.equal((await A.call('POST', `/v1/users/${u}/withdrawals`, { amount_dollars: 1 })).code, 'withdrawals_revoked');
  await user.goto(BASE + '/funds/withdraw');
  await user.waitForSelector('[data-testid=money-blocked][data-code=withdrawals_revoked]');
  assert.equal((await adminCall('PUT', `/v1/admin/users/${u}/money_controls`, { deposits_revoked: false, withdrawals_revoked: false, reason: 'Review closed' })).status, 200);
  // Site-wide switches: the payments.deposits / payments.withdrawals flags.
  await setFlag('payments.withdrawals', { enabled: false });
  disabled(await B.call('POST', `/v1/users/${B.uid}/withdrawals`, { amount_dollars: 1 }), 'payments.withdrawals');
  await user.goto(BASE + '/funds/withdraw');
  await user.waitForSelector('[data-testid=feature-unavailable][data-feature="payments.withdrawals"]');
  await reset('payments.withdrawals');
  assert.equal((await B.call('POST', `/v1/users/${B.uid}/withdrawals`, { amount_dollars: 1 })).status, 201);
  assert.deepEqual(user.errors, []); assert.deepEqual(ap.errors, []);
});

test('persistence across a restart; the start/env override wins over the database', async () => {
  await setFlag('ballot', { rollout_pct: 30, deny_regions: ['GH'] });
  await setFlag('perps', { kill: true });
  await srv.close();
  srv = await start({ ...OPTS, flags: { overrides: { perps: true } } });
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  const b = (await admin.call('GET', '/v1/admin/flags/ballot')).body.flag;
  assert.equal(b.rollout_pct, 30); assert.deepEqual(b.deny_regions, ['GH']);
  const p = (await admin.call('GET', '/v1/admin/flags/perps')).body.flag;
  assert.equal(p.kill, true); assert.equal(p.effective, true); assert.equal(p.effective_reason, 'env_override'); assert.equal(p.env_override, true);
  const c = await new Client(BASE, 'c').logIn(email('bob'), PW);
  enabledOk(await c.call('GET', '/v1/perps/markets'), 'override on');
  assert.deepEqual(flagsMod.parseEnvOverrides('perps=off, sports=on,bogus=on,ballot=maybe'), { perps: false, sports: true });
  await reset('ballot');
});
