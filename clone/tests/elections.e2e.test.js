'use strict';
// End-to-end browser tests for Phase 7B, the elections hub v2 (CLONE_SPEC.md §37), against a real server, a real SQLite
// file and Chromium:
//   • the country model as data: Nigerian zones, states + FCT, 774 LGAs, wards, offices with their seats and win rules,
//     invented multi-party parties and candidates, the general and off-cycle elections, races linked to engine markets;
//   • every hub widget on desktop and at 390 px (sidebar, tabs, search, gauges, office switch and seat bar, map with its
//     side list and legend, ratings, timeline, featured cards, Power Index, More markets, chat dock) with no overflow;
//   • the simulated feed (collation, % reported, votes equal to the DB) arriving live over WebSocket; no client write;
//   • the map tooltip on hover (desktop) and tap (390 px); admin-entered names rendered as text (XSS-safe);
//   • the results desk: a one-person call in the UI with step-up and a reason, audit, a settlement proposal approved on
//     the resolution desk by a second resolver, uncall refused once settled; the two-person presidency; the 25% rule
//     tracked per candidate, a call refused when the rule is not met, the runoff state;
//   • timeline replay (scrub, play, LIVE); the Power Index (admin formula, 24 h change from the DB, Learn more from the
//     CMS); hub chat (§20, online count); My Ballot by state → LGA → ward with only the division id stored;
//   • the second country (Harbor) through the same code; flags off hiding each widget and refusing its API; CMS edits
//     showing live; the production switch keeping election data; restart persistence.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-elections-'));
const DB_FILE = path.join(TMP, 'elections.db');
const PW = 'Harmattan-Lantern-Delta-4471';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const HUB = '/category/elections/nigeria-2027';
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const opts = (port) => ({ port, dbFile: DB_FILE, tickMs: 250, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH },
  elections: { seed: true, snapshotEveryMin: 60 }, flags: { defaults: { 'elections.simulator': true } } });
let BASE; let srv; let browser; let admin; let resolver; let PORT;
const allPages = [];
const email = (n) => `${n}.${stamp}@example.test`;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const q1 = (sql, ...a) => dbq(sql, ...a)[0];
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, { timeout = 15000, interval = 150 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { const v = await fn(); if (v !== false) return v; } catch (e) { if (Date.now() > end) throw e; } if (Date.now() > end) throw new Error('eventually: condition not met'); await sleep(interval); }
}
async function newPage(viewport = { width: 1400, height: 1000 }, touch = false) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  allPages.push(page);
  return page;
}
async function uiLogIn(page, u) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', u.password || PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
const stepUp = (c) => async (method, p, body) => {
  let r = await c.call(method, p, body);
  if (r.code === 'step_up_required') { assert.equal((await c.call('POST', '/v1/step_up', { password: PW })).status, 200); r = await c.call(method, p, body); }
  return r;
};
const adminCall = (...a) => stepUp(admin)(...a);
const resolverCall = (...a) => stepUp(resolver)(...a);
const setFlag = async (key, enabled) => { const r = await adminCall('PUT', `/v1/admin/flags/${key}`, { enabled, reason: 'elections e2e' }); assert.equal(r.status, 200, r.text); };
const api = (p) => admin.call('GET', p).then((r) => { assert.equal(r.status, 200, `${p}: ${r.text}`); return r.body; });
const sim = (id, body) => adminCall('PUT', `/v1/admin/elections/elections/${id}/simulator`, { reason: 'elections e2e', ...body });
// Overflow against the emulated device width (a mobile page that overflows is laid out wider, so innerWidth would grow too).
const elOverflow = (page) => page.evaluate((w) => Math.max(document.documentElement.scrollWidth, window.innerWidth) - w, page.viewportSize().width);

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  srv = await start(opts(PORT));
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  // A second results-desk member: the resolver role (resolution.write) for two-person calls and settlement approvals.
  const r = await new Client(BASE, 'res').signUp(email('resolver'), PW, 'Second Resolver');
  dbrun('INSERT INTO admin_roles(user_id,role,granted_by,granted_at) VALUES(?,?,?,?)', r.uid, 'resolver', null, new Date().toISOString());
  resolver = await new Client(BASE, 'res').logIn(email('resolver'), PW);
});
after(async () => {
  // Close everything before asserting anything, so a failure can never leave a server or browser running.
  try { await browser?.close(); } catch { /* ignore */ }
  try { await srv?.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('country model as data: Nigerian geography, offices and win rules, multi-party invented parties, elections and races linked to engine markets; Harbor as a second country', async () => {
  const lv = Object.fromEntries(dbq("SELECT level, COUNT(*) c FROM el_divisions WHERE country='NG' GROUP BY level").map((r) => [r.level, r.c]));
  assert.equal(lv.zone, 6); assert.equal(lv.state, 37); assert.equal(lv.lga, 774); assert.ok(lv.ward > 7000, `wards ${lv.ward}`);
  assert.equal(q1("SELECT json_extract(data_json,'$.territory') t FROM el_divisions WHERE id='NG-FC'").t, 1);
  assert.equal(q1("SELECT SUM(json_extract(data_json,'$.lga_count')) n FROM el_divisions WHERE country='NG' AND level='state'").n, 774);
  const off = Object.fromEntries(dbq("SELECT key, seats, two_person, rule_json FROM el_offices WHERE country='NG'").map((o) => [o.key, o]));
  assert.deepEqual([off.president.seats, off.senate.seats, off.house.seats, off.governor.seats, off.assembly.seats], [1, 109, 360, 36, 990]);
  assert.equal(off.president.two_person, 1);
  assert.deepEqual(JSON.parse(off.president.rule_json), { type: 'spread', share: 0.25, fraction: [2, 3], unit: 'state', territory_required: true, on_fail: 'runoff' });
  assert.equal(JSON.parse(off.governor.rule_json).unit, 'lga');
  assert.equal(JSON.parse(off.senate.rule_json).type, 'plurality');
  // Races: 109 Senate seats (3 per state, 1 FCT), 360 House constituencies, 28 + 8 off-cycle governorships, one presidency.
  const races = (el, key) => q1('SELECT COUNT(*) c FROM el_races r JOIN el_offices o ON o.id=r.office_id WHERE r.election_id=? AND o.key=?', el, key).c;
  assert.deepEqual([races('NG27', 'president'), races('NG27', 'senate'), races('NG27', 'house'), races('NG27', 'governor'), races('NGOC', 'governor')], [1, 109, 360, 28, 8]);
  assert.deepEqual(dbq("SELECT r.division_id d FROM el_races r WHERE r.election_id='NGOC' ORDER BY d").map((x) => x.d.slice(3)), ['AN', 'BY', 'ED', 'EK', 'IM', 'KO', 'ON', 'OS']);
  // Multi-party: five invented parties (two in a coalition); the presidency has four candidates, a governorship three.
  assert.equal(q1("SELECT COUNT(*) c FROM el_parties WHERE country='NG'").c, 5);
  assert.equal(q1("SELECT COUNT(*) c FROM el_parties WHERE country='NG' AND coalition IS NOT NULL").c, 2);
  assert.equal(q1("SELECT COUNT(*) c FROM el_candidates WHERE race_id='NG27-PRES'").c, 4);
  // Every candidate race links to engine markets that exist and trade; chamber control markets per chamber.
  const links = dbq("SELECT rm.market_ticker t, m.status FROM el_race_markets rm JOIN markets m ON m.ticker=rm.market_ticker WHERE rm.race_id IN ('NG27-PRES','NG27-GOV-LA','XH26-GOV-HS')");
  assert.ok(links.length >= 4 + 1 + 3 + 3, JSON.stringify(links));
  assert.ok(links.every((l) => l.status === 'active'));
  assert.equal(q1("SELECT COUNT(*) c FROM el_office_markets WHERE election_id='NG27'").c, 10);
  assert.ok(q1("SELECT COUNT(*) c FROM orders WHERE market_ticker LIKE 'PLXNG27-%' AND status='resting'").c > 100, 'liquidity through the engine');
  // Harbor: the invented Phase 5B states, a Senate with holdovers, a governorship.
  assert.equal(q1("SELECT COUNT(*) c FROM el_divisions WHERE country='XH' AND level='state'").c, 12);
  const hubs = (await api('/v1/elections/hubs')).hubs.map((h) => h.slug);
  assert.deepEqual(hubs.sort(), ['harbor-2026', 'nigeria-2027', 'nigeria-offcycle']);
  // Admin edits are validated and audited with a reason; markup in a name is refused.
  let r = await adminCall('PUT', '/v1/admin/elections/parties/NG-SRP', { name: 'Savannah <b>Renewal</b>', reason: 'rename' });
  assert.equal(r.status, 400, r.text);
  r = await adminCall('PUT', '/v1/admin/elections/parties/NG-SRP', { color: 'red', reason: 'colour' });
  assert.equal(r.status, 400);
  r = await adminCall('PUT', '/v1/admin/elections/parties/NG-SRP', { coalition: 'Renewal Accord', reason: '' });
  assert.equal(r.status, 400, 'a reason is required');
  r = await adminCall('PUT', '/v1/admin/elections/offices/NG-senate', { rule: { type: 'spread', share: 2, fraction: [2, 3], unit: 'lga' }, reason: 'bad rule' });
  assert.equal(r.status, 400);
  r = await adminCall('PUT', '/v1/admin/elections/parties/NG-SRP', { short_name: 'SRP', color: '#f08c01', reason: 'brand refresh' });
  assert.equal(r.status, 200, r.text);
  const audit = q1("SELECT * FROM admin_audit WHERE action='elections.parties.update' ORDER BY rowid DESC LIMIT 1");
  assert.equal(audit.reason, 'brand refresh'); assert.match(audit.after_json, /#f08c01/);
  assert.equal((await resolver.call('PUT', '/v1/admin/elections/parties/NG-SRP', { color: '#000000', reason: 'x y z' })).status, 403, 'resolver role cannot edit the country model');
  // Every flag can be edited at /v1/admin/flags/<key>: no key may look like a file the perimeter honeypot refuses (a key
  // ending in ".map" did: the map flag is elections.results_map).
  const { REGISTRY } = require('../server/flags');
  const { isHoneypot } = require('../server/bot');
  assert.deepEqual(REGISTRY.map((f) => f[0]).filter((k) => isHoneypot(`/v1/admin/flags/${k}`)), []);
  assert.equal((await adminCall('PUT', '/v1/admin/flags/elections.results_map', { enabled: true, reason: 'reachable' })).status, 200);
});

test('hub page: sidebar, tabs, search, gauges, seat bar, map with side list, ratings, timeline, featured, Power Index and More markets on desktop and at 390 px', async () => {
  const hub = await api('/v1/elections/hubs/nigeria-2027');
  for (const [vp, touch] of [[{ width: 1400, height: 1000 }, false], [{ width: 390, height: 844 }, true]]) {
    const page = await newPage(vp, touch);
    await page.goto(BASE + HUB);
    await page.waitForSelector('[data-testid=el-map-state]');
    assert.match(await page.textContent('[data-testid=el-title]'), /Nigeria 2027 general election predictions/);
    assert.deepEqual(await page.$$eval('[data-testid=el-tabs] [data-tab]', (b) => b.map((x) => x.dataset.tab)), ['overview', 'president', 'senate', 'house', 'governor', 'states', 'ballot']);
    assert.ok(await page.isVisible('[data-testid=el-sidebar] [data-hub=harbor-2026]'), 'international elections in the sidebar');
    assert.equal(await page.locator('[data-testid=el-gauge]').count(), 3);
    assert.equal(await page.getAttribute('[data-testid=el-gauge][data-office=president]', 'data-party'), 'LUP');
    assert.equal(await page.locator('[data-testid=el-map-state]').count(), 37);
    assert.ok(await page.locator('[data-testid=el-map-side-item]').count() >= 5, 'small states and the FCT beside the map');
    assert.equal(await page.locator('[data-testid=el-map-side-item][data-code=FC]').count(), 1);
    assert.equal(await page.locator('[data-testid=el-rcol]').count(), 7);
    assert.equal(await page.locator('[data-testid=el-settled]').count(), 2);
    assert.ok(await page.isVisible('[data-testid=el-tl-play]'));
    assert.equal(await page.locator('[data-testid=el-card]').count(), hub.featured.length);
    assert.equal(await page.locator('[data-testid=el-more-row]').count(), hub.more_markets.length);
    assert.match(await page.textContent('[data-testid=el-more-count]'), new RegExp(`${hub.more_markets.length} events`));
    assert.match(await page.textContent('[data-testid=el-power-headline]'), /Leaning (LUP \(ruling party\)|Opposition) \+\d/);
    await page.waitForSelector('[data-testid=chat-pill]');
    // The seat bar: office switch to the Senate, 109 seats with a majority mark at 55.
    await page.click('[data-testid=el-office-pill][data-office-pill=senate]');
    await page.waitForSelector('[data-testid=el-seats][data-office=senate]');
    assert.equal(await page.getAttribute('[data-testid=el-seats]', 'data-total'), '109');
    assert.match(await page.textContent('[data-testid=el-seat-card]'), /55 seats for a majority of 109/);
    const forecast = await page.$$eval('[data-testid=el-seat-seg]', (s) => s.reduce((a, x) => a + Number(x.dataset.forecast), 0));
    assert.ok(Math.abs(forecast - 109) < 1, `forecast seats add up to the chamber: ${forecast}`);
    // Search states and candidates.
    await page.fill('[data-testid=el-search]', 'Danjuma');
    await page.waitForSelector('[data-testid=el-search-race]');
    await page.click('[data-testid=el-search-race]');
    await page.waitForSelector('[data-testid=el-race][data-race=NG27-PRES]');
    assert.ok(await page.isVisible('[data-testid=el-spread]'), 'the presidency shows the 25% tracker');
    assert.ok(await elOverflow(page) <= 1, `no horizontal overflow at ${vp.width}`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});

test('simulated feed: collation by LGA, % reported and votes equal to the database, live over WebSocket without a reload; the feed has no client write path', async () => {
  const page = await newPage();
  await page.goto(BASE + HUB);
  await page.waitForSelector('[data-testid=el-map-state][data-code=LA][data-kind=pending]');
  await page.evaluate(() => { window.__noReload = 1; });
  const ws = admin.socket(); await ws.opened; await ws.subscribe(['elections'], { hubs: ['nigeria-2027'] });
  assert.equal((await sim('NG27', { action: 'start' })).status, 200);
  assert.equal((await sim('NG27', { action: 'pause' })).status, 200);
  const adv = await sim('NG27', { action: 'advance', minutes: 300 });
  assert.equal(adv.status, 200, adv.text);
  await ws.waitFor((m) => m.type === 'elections' && m.msg.hub === 'nigeria-2027', 8000);
  ws.close();
  // The open page redraws live: states now hatched with a % label.
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=el-map-state][data-kind=leading], [data-testid=el-map-state][data-kind=projected]').length > 5, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__noReload), 1, 'no page reload');
  const label = await page.textContent('[data-testid=el-map-state][data-code=KN] [data-testid=el-tile-mark]').catch(() => '');
  assert.match(label || '', /^\d+%$|^✓$/);
  // API totals equal the stored tallies; state collation equals the sum of its LGAs.
  const race = (await api('/v1/elections/races/NG27-PRES')).race;
  const db = q1("SELECT SUM(votes) v FROM el_tallies WHERE race_id='NG27-PRES'").v;
  assert.equal(race.total_votes, db);
  const rep = q1("SELECT SUM(pu_total) t, SUM(pu_reported) r FROM el_reporting WHERE race_id='NG27-PRES'");
  assert.equal(race.pu_reported, rep.r); assert.equal(race.pu_total, rep.t);
  assert.ok(rep.r > 0 && rep.r < rep.t, 'part of the count is in');
  const la = race.units.find((u) => u.code === 'LA');
  const laDb = q1("SELECT SUM(pu_reported)*1.0/SUM(pu_total) f FROM el_reporting WHERE race_id='NG27-PRES' AND unit_id LIKE 'NG-LA-%'").f;
  assert.ok(Math.abs(la.pct_reported - laDb) < 1e-9);
  assert.equal(q1("SELECT COUNT(*) c FROM el_reporting WHERE race_id='NG27-PRES'").c, 774, 'counted by LGA');
  // Snapshots persisted for the timeline (start + advance).
  assert.ok(q1("SELECT COUNT(*) c FROM el_snapshots WHERE election_id='NG27'").c >= 2);
  // No client can write results: no such routes, and a regular user cannot drive the simulator.
  const u = await new Client(BASE, 'u').signUp(email('voter'), PW, 'Voter One');
  assert.equal((await u.call('POST', '/v1/elections/races/NG27-PRES/results', { votes: 1 })).status, 404);
  assert.equal((await u.call('PUT', '/v1/admin/elections/elections/NG27/simulator', { action: 'advance', minutes: 10, reason: 'nope' })).status, 403);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('map tooltip on hover (desktop) and tap (390 px); admin-entered names are rendered as text', async () => {
  // A hostile name stored in the data (e.g. an import) is shown as text: no element is created, no script runs.
  dbrun("UPDATE el_candidates SET name=? WHERE id='NG27-PRES-CTM'", '<img src=x onerror="window.__xss=1">Chidi');
  srv.app.locals.elections.invalidate();
  const desk = await newPage();
  await desk.goto(BASE + HUB + '?office=president');
  await desk.waitForSelector('[data-testid=el-map-state][data-code=LA]');
  await desk.hover('[data-testid=el-map-state][data-code=LA]');
  await desk.waitForSelector('[data-testid=el-tip]:not([hidden])');
  assert.equal(await desk.getAttribute('[data-testid=el-tip]', 'data-code'), 'LA');
  const tip = await desk.textContent('[data-testid=el-tip]');
  assert.match(tip, /of vote counted/);
  assert.equal(await desk.locator('[data-testid=el-tip-row]').count(), 4, 'one row per presidential candidate');
  assert.match(tip, /<img src=x onerror/, 'the hostile name is literal text');
  assert.equal(await desk.locator('[data-testid=el-tip] img').count(), 0);
  assert.equal(await desk.evaluate(() => window.__xss), undefined);
  await desk.mouse.move(5, 5);
  await desk.waitForSelector('[data-testid=el-tip]', { state: 'hidden' });
  // 390 px: a tap shows it, a tap elsewhere hides it.
  const phone = await newPage({ width: 390, height: 844 }, true);
  await phone.goto(BASE + HUB + '?office=president');
  await phone.waitForSelector('[data-testid=el-map-state][data-code=KN]');
  await phone.tap('[data-testid=el-map-state][data-code=KN]');
  await phone.waitForSelector('[data-testid=el-tip]:not([hidden])');
  assert.equal(await phone.getAttribute('[data-testid=el-tip]', 'data-code'), 'KN');
  const box = await phone.locator('[data-testid=el-tip]').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390 + 1, `tooltip inside the screen: ${JSON.stringify(box)}`);
  await phone.tap('[data-testid=el-title]');
  await phone.waitForSelector('[data-testid=el-tip]', { state: 'hidden' });
  assert.deepEqual([desk.errors, phone.errors], [[], []]);
  dbrun("UPDATE el_candidates SET name='Chidi Abubakar-Cole' WHERE id='NG27-PRES-CTM'");
  srv.app.locals.elections.invalidate();
  await desk.context().close(); await phone.context().close();
});

test('results desk: a governorship called in the UI with step-up and a reason, audited, proposing settlements that a second resolver approves on the resolution desk; uncall refused once settled', async () => {
  await sim('NG27', { action: 'advance', minutes: 1500 }); // every polling unit reported
  const race = (await api('/v1/elections/races/NG27-GOV-KN')).race;
  assert.equal(race.pct_reported, 1);
  const winner = race.candidates[0];
  assert.ok(race.rule.candidates.find((c) => c.candidate_id === winner.id).meets, 'the leader meets the governorship rule');
  // A stale session: the call asks for the password first (step-up), then goes through.
  const page = await newPage();
  await uiLogIn(page, ADMIN);
  dbrun('UPDATE sessions SET auth_at=0 WHERE user_id=(SELECT id FROM users WHERE email=?)', ADMIN.email);
  await page.goto(BASE + '/admin/elections/desk?election=NG27&office=governor');
  await page.waitForSelector('[data-testid=adm-el-race][data-race=NG27-GOV-KN]');
  await page.click('[data-testid=adm-el-race][data-race=NG27-GOV-KN] [data-testid=adm-el-call-btn]');
  await page.selectOption('[data-testid=adm-el-call-candidate]', winner.id);
  await page.fill('[data-testid=confirm-reason]', 'Kano collation complete, leader meets 25% in two-thirds of LGAs');
  await page.click('[data-testid=confirm-ok]');
  await page.waitForSelector('[data-testid=step-up-password]');
  await page.fill('[data-testid=step-up-password]', PW);
  await page.click('[data-testid=step-up-submit]');
  await page.waitForSelector('[data-testid=adm-el-race][data-race=NG27-GOV-KN][data-status=called]');
  const row = q1("SELECT status, winner_candidate_id, called_by FROM el_races WHERE id='NG27-GOV-KN'");
  assert.equal(row.status, 'called'); assert.equal(row.winner_candidate_id, winner.id);
  const audit = q1("SELECT * FROM admin_audit WHERE action='elections.call' AND target_id='NG27-GOV-KN'");
  assert.match(audit.reason, /Kano collation complete/);
  // Settlement proposals on the resolution desk: YES for the winner's market, NO for the others; nothing resolved yet.
  const props = dbq("SELECT * FROM res_approvals WHERE market_ticker LIKE 'PLXNG27-GOVKN-%' AND status='pending' ORDER BY market_ticker");
  assert.equal(props.length, 3);
  for (const p of props) assert.equal(JSON.parse(p.payload).result, p.market_ticker.endsWith(winner.party.code) ? 'yes' : 'no');
  assert.ok(dbq("SELECT status FROM markets WHERE ticker LIKE 'PLXNG27-GOVKN-%'").every((m) => m.status === 'active'));
  // The caller cannot approve its own proposal; the second resolver can.
  const own = await adminCall('POST', `/v1/admin/resolution/approvals/${props[0].id}/approve`, {});
  assert.equal(own.status, 409); assert.equal(own.code, 'same_admin');
  for (const p of props) { const x = await resolverCall('POST', `/v1/admin/resolution/approvals/${p.id}/approve`, { note: 'results desk call checked' }); assert.equal(x.status, 200, x.text); }
  assert.ok(dbq("SELECT status FROM markets WHERE ticker LIKE 'PLXNG27-GOVKN-%'").every((m) => ['determined', 'finalized'].includes(m.status)));
  // Once a market has been resolved from the call, uncalling is refused (reverse it on the resolution desk first).
  const un = await adminCall('POST', '/v1/admin/elections/races/NG27-GOV-KN/uncall', { reason: 'wrong call' });
  assert.equal(un.status, 409); assert.equal(un.code, 'settlement_executed');
  // A call before approval can be uncalled: its pending proposals are withdrawn.
  const lag = (await api('/v1/elections/races/NG27-GOV-LA')).race;
  const c2 = await adminCall('POST', '/v1/admin/elections/races/NG27-GOV-LA/call', { outcome: 'winner', candidate_id: lag.candidates[0].id, reason: 'Lagos collation complete' });
  assert.equal(c2.status, 200, c2.text);
  assert.equal(q1("SELECT COUNT(*) c FROM res_approvals WHERE market_ticker LIKE 'PLXNG27-GOVLA-%' AND status='pending'").c, 3);
  const u2 = await adminCall('POST', '/v1/admin/elections/races/NG27-GOV-LA/uncall', { reason: 'collation error found' });
  assert.equal(u2.status, 200, u2.text);
  assert.equal(q1("SELECT COUNT(*) c FROM res_approvals WHERE market_ticker LIKE 'PLXNG27-GOVLA-%' AND status='pending'").c, 0);
  assert.equal(q1("SELECT status FROM el_races WHERE id='NG27-GOV-LA'").status, 'open');
  assert.ok(q1("SELECT 1 x FROM admin_audit WHERE action='elections.uncall' AND target_id='NG27-GOV-LA' AND reason='collation error found'"));
  // A call needs the role: a user without resolution.write is refused; a call for a candidate who is not leading is refused.
  const u = await new Client(BASE, 'u2').signUp(email('nobody'), PW, 'No Role');
  assert.equal((await u.call('POST', '/v1/admin/elections/races/NG27-GOV-LA/call', { outcome: 'winner', candidate_id: lag.candidates[0].id, reason: 'try' })).status, 403);
  const bad = await adminCall('POST', '/v1/admin/elections/races/NG27-GOV-LA/call', { outcome: 'winner', candidate_id: lag.candidates[2].id, reason: 'not the leader' });
  assert.equal(bad.status, 409); assert.equal(bad.code, 'rule_not_met');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('presidency: the 25% spread tracker, the two-person rule, a winner call refused when the rule is not met, and the runoff state', async () => {
  const pres = (await api('/v1/elections/races/NG27-PRES')).race;
  assert.equal(pres.rule.needed, 24); assert.equal(pres.rule.units, 36); assert.deepEqual(pres.rule.territories, ['FC']);
  // The tracker equals a count over the stored tallies: states (not the FCT) where the candidate has 25% or more.
  const byState = dbq("SELECT substr(unit_id,1,5) s, candidate_id c, SUM(votes) v FROM el_tallies WHERE race_id='NG27-PRES' GROUP BY s, c");
  const tot = {}; for (const r of byState) tot[r.s] = (tot[r.s] || 0) + r.v;
  for (const c of pres.rule.candidates) {
    const n = byState.filter((r) => r.c === c.candidate_id && r.s !== 'NG-FC' && r.v / tot[r.s] >= 0.25).length;
    assert.equal(c.count, n, `tracker for ${c.candidate_id}`);
  }
  const lead = pres.rule.candidates.find((c) => c.meets);
  assert.ok(lead, 'the leader meets the rule on the seeded results');
  // Two-person: the request waits; the requester cannot approve it; the second resolver does (step-up), then it runs.
  const req = await adminCall('POST', '/v1/admin/elections/races/NG27-PRES/call', { outcome: 'winner', candidate_id: lead.candidate_id, reason: 'national collation complete' });
  assert.equal(req.status, 202, req.text); assert.equal(req.body.status, 'pending_approval');
  assert.equal(q1("SELECT status FROM el_races WHERE id='NG27-PRES'").status, 'open');
  const again = await adminCall('POST', '/v1/admin/elections/races/NG27-PRES/call', { outcome: 'winner', candidate_id: lead.candidate_id, reason: 'again' });
  assert.equal(again.code, 'call_pending');
  const self = await adminCall('POST', `/v1/admin/elections/calls/${req.body.call.id}/approve`, {});
  assert.equal(self.status, 409); assert.equal(self.code, 'same_person');
  // The second person approves in Admin › Elections › Results desk.
  const page = await newPage();
  await uiLogIn(page, { email: email('resolver') });
  await page.goto(BASE + '/admin/elections/desk?election=NG27&office=president');
  await page.waitForSelector(`[data-testid=adm-el-call][data-id="${req.body.call.id}"]`);
  await page.click(`[data-testid=adm-el-call][data-id="${req.body.call.id}"] [data-testid=adm-el-approve]`);
  await page.click('[data-testid=confirm-ok]');
  await page.waitForSelector('[data-testid=adm-el-race][data-race=NG27-PRES][data-status=called]');
  const call = q1('SELECT * FROM el_calls WHERE id=?', req.body.call.id);
  assert.equal(call.status, 'done'); assert.equal(call.decided_by, q1('SELECT id FROM users WHERE email=?', email('resolver')).id);
  // Proposals: YES for the winner, NO for the other three, and NO for "runoff?".
  const props = dbq("SELECT market_ticker t, payload FROM res_approvals WHERE (market_ticker LIKE 'PLXNG27-PRES-%' OR market_ticker='PLXNG27-RUNOFF') AND status='pending'");
  assert.equal(props.length, 5);
  assert.equal(JSON.parse(props.find((p) => p.t === 'PLXNG27-RUNOFF').payload).result, 'no');
  assert.equal(props.filter((p) => JSON.parse(p.payload).result === 'yes').length, 1);
  assert.ok(q1("SELECT 1 x FROM admin_audit WHERE action='elections.call.requested' AND target_id='NG27-PRES'"));
  // The hub shows it called: the gauge says Called, the card and race show Yes / No.
  const hp = await newPage();
  await hp.goto(BASE + HUB + '?tab=president');
  await hp.waitForSelector('[data-testid=el-race][data-status=called]');
  assert.equal(await hp.textContent('[data-testid=el-gauge][data-office=president] [data-testid=el-gauge-word]'), 'Called');
  // Uncall (two people again), then make the rule stricter (configuration, audited): nobody meets it any more.
  const un = await adminCall('POST', '/v1/admin/elections/races/NG27-PRES/uncall', { reason: 'rule review' });
  assert.equal(un.status, 202);
  assert.equal((await resolverCall('POST', `/v1/admin/elections/calls/${un.body.call.id}/approve`, {})).status, 200);
  assert.equal(q1("SELECT COUNT(*) c FROM res_approvals WHERE (market_ticker LIKE 'PLXNG27-PRES-%' OR market_ticker='PLXNG27-RUNOFF') AND status='pending'").c, 0, 'proposals withdrawn');
  const rule = { type: 'spread', share: 0.45, fraction: [2, 3], unit: 'state', territory_required: true, on_fail: 'runoff' };
  assert.equal((await adminCall('PUT', '/v1/admin/elections/offices/NG-president', { rule, reason: 'demo: a stricter spread rule' })).status, 200);
  const strict = (await api('/v1/elections/races/NG27-PRES')).race;
  assert.ok(strict.rule.candidates.every((c) => !c.meets));
  const refused = await adminCall('POST', '/v1/admin/elections/races/NG27-PRES/call', { outcome: 'winner', candidate_id: lead.candidate_id, reason: 'try anyway' });
  assert.equal(refused.status, 409); assert.equal(refused.code, 'rule_not_met');
  await hp.reload();
  await hp.waitForSelector('[data-testid=el-runoff-due]');
  // The runoff call (two people) puts the race in the runoff state and proposes "runoff?" YES only.
  const ro = await adminCall('POST', '/v1/admin/elections/races/NG27-PRES/call', { outcome: 'runoff', reason: 'no candidate met the rule' });
  assert.equal(ro.status, 202, ro.text);
  assert.equal((await resolverCall('POST', `/v1/admin/elections/calls/${ro.body.call.id}/approve`, {})).status, 200);
  assert.equal(q1("SELECT status FROM el_races WHERE id='NG27-PRES'").status, 'runoff');
  const rp = dbq("SELECT market_ticker t, payload FROM res_approvals WHERE (market_ticker LIKE 'PLXNG27-PRES-%' OR market_ticker='PLXNG27-RUNOFF') AND status='pending'");
  assert.deepEqual(rp.map((p) => [p.t, JSON.parse(p.payload).result]), [['PLXNG27-RUNOFF', 'yes']]);
  await hp.waitForSelector('[data-testid=el-race][data-status=runoff]', { timeout: 15000 });
  assert.equal(await hp.textContent('[data-testid=el-gauge][data-office=president] [data-testid=el-gauge-word]'), 'Runoff');
  assert.deepEqual([page.errors, hp.errors], [[], []]);
  await page.context().close(); await hp.context().close();
});

test('timeline: scrub replays the map, seat bar, gauges and ratings from persisted snapshots; play runs to LIVE', async () => {
  const tl = await api('/v1/elections/hubs/nigeria-2027/timeline');
  assert.ok(tl.points.length >= 4, `points ${tl.points.length}`);
  assert.ok(tl.points.some((p) => p.kind === 'call') && tl.points.some((p) => p.kind === 'start'));
  const first = tl.points[0];
  const snap = await api(`/v1/elections/hubs/nigeria-2027/view?office=president&at=${first.id}`);
  assert.equal(snap.live, false);
  assert.ok(snap.map.states.every((s) => s.kind === 'pending'), 'the start snapshot predates any result');
  const page = await newPage();
  await page.goto(BASE + HUB);
  await page.waitForSelector('[data-testid=el-tl]');
  await page.waitForFunction((n) => document.querySelector('[data-part=timeline]')?.dataset.points === String(n), tl.points.length);
  await page.click('[data-testid=el-office-pill][data-office-pill=president]');
  await page.waitForSelector('[data-view][data-office=president][data-live="1"]');
  assert.ok(await page.locator('[data-testid=el-map-state][data-kind=called]').count() > 30, 'live: states fully counted');
  await page.$eval('[data-testid=el-tl-range]', (r) => { r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForSelector('[data-view][data-live="0"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=el-map-state][data-kind=pending]').length === 37);
  assert.match(await page.textContent('[data-testid=el-tl-status]'), /Replaying/);
  // A call snapshot: the presidency's gauge at that moment.
  const ci = tl.points.findIndex((p) => p.kind === 'call' && /Nigeria President/.test(p.label || ''));
  await page.$eval('[data-testid=el-tl-range]', (r, i) => { r.value = String(i); r.dispatchEvent(new Event('input', { bubbles: true })); }, ci);
  await page.waitForFunction(() => document.querySelector('[data-testid=el-gauge][data-office=president] [data-testid=el-gauge-word]')?.textContent === 'Called');
  // LIVE returns to now (the race is in the runoff state now).
  await page.click('[data-testid=el-tl-live]');
  await page.waitForSelector('[data-view][data-live="1"]');
  await page.waitForFunction(() => document.querySelector('[data-testid=el-gauge][data-office=president] [data-testid=el-gauge-word]')?.textContent === 'Runoff');
  // Play steps through every point and ends on LIVE.
  await page.click('[data-testid=el-tl-play]');
  await page.waitForSelector('[data-testid=el-tl-play][data-playing="1"]');
  await page.waitForSelector('[data-view][data-live="0"]');
  await page.waitForSelector('[data-testid=el-tl-play][data-playing="0"]', { timeout: 20000 + tl.points.length * 1200 });
  await page.waitForSelector('[data-view][data-live="1"]');
  assert.match(await page.textContent('[data-testid=el-tl-status]'), /Live now/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Power Index: admin formula, 24 h change equal to the database, Learn more from the CMS; CMS edits show live', async () => {
  const pi = (await api('/v1/elections/power_index/NG')).power_index;
  // Recompute from the database: offset + Σ weight × last price (0-100), now and 24 h ago.
  const f = (await api('/v1/admin/elections/power_index/NG')).formula;
  const at = (t, ts) => { const r = q1('SELECT yes_price_cc p FROM trades WHERE market_ticker=? AND created_ts<=? ORDER BY created_ts DESC, rowid DESC LIMIT 1', t, ts); return r.p / 100; };
  const val = (ts) => Math.round((f.offset + f.terms.reduce((a, x) => a + x.weight * at(x.ticker, ts), 0)) * 10) / 10;
  assert.equal(pi.value, val(Date.now()));
  assert.ok(Math.abs(pi.change_24h - Math.round((val(Date.now()) - val(Date.now() - 86400000)) * 10) / 10) <= 0.11, `${pi.change_24h}`);
  assert.ok(pi.history.length > 24);
  const page = await newPage();
  await page.goto(BASE + HUB);
  await page.waitForSelector('[data-testid=el-power-headline]');
  await page.click('[data-testid=el-power-more]');
  assert.match(await page.textContent('[data-testid=el-power-learn]'), /The Power Index adds up market prices/);
  // The chart has the hover readout (§15.4).
  assert.ok(await page.locator('[data-testid=el-power] svg[data-hover]').count() === 1);
  // An admin formula change: only the presidency term, the other way round → the headline changes live.
  const r = await adminCall('PUT', '/v1/admin/elections/power_index/NG', { terms: [{ ticker: 'PLXNG27-PRES-LUP', weight: -1 }], offset: 0, label_neg: 'Ruling party falls', reason: 'demo formula' });
  assert.equal(r.status, 200, r.text);
  await page.waitForFunction(() => /Ruling party falls/.test(document.querySelector('[data-testid=el-power-headline]')?.textContent || ''), null, { timeout: 15000 });
  assert.ok(q1("SELECT 1 x FROM admin_audit WHERE action='elections.power_index' AND reason='demo formula'"));
  const bad = await adminCall('PUT', '/v1/admin/elections/power_index/NG', { terms: [{ ticker: 'NOPE-1', weight: 1 }], reason: 'bad ticker' });
  assert.equal(bad.status, 400);
  // CMS: publish new wording for the blurb and the Learn more text; the open page shows it without a reload.
  for (const [key, value] of [['elections.power.blurb', 'Our single number for who holds power.'], ['elections.power.learn_more_body', '<p>Weights are set by the <b>results team</b>.</p>']]) {
    assert.equal((await admin.call('PUT', '/v1/admin/cms/text/draft', { key, value })).status, 200);
    assert.equal((await admin.call('POST', '/v1/admin/cms/text/publish', { key, reason: 'elections copy' })).status, 200);
  }
  await page.waitForFunction(() => /Our single number for who holds power/.test(document.querySelector('[data-testid=el-power]')?.textContent || ''), null, { timeout: 15000 });
  await page.click('[data-testid=el-power-more]');
  assert.equal(await page.textContent('[data-testid=el-power-learn] b'), 'results team');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('hub chat: a §20 chat room of the hub with the online count on the floating pill; messages live between two visitors', async () => {
  const a = await newPage(); const b = await newPage({ width: 390, height: 844 }, true);
  for (const [p, n] of [[a, 'ada'], [b, 'bayo']]) {
    const c = await new Client(BASE, n).signUp(email(n), PW, `Chat ${n}`);
    assert.equal((await c.call('POST', `/v1/users/${c.uid}/social/profile`, { nickname: `${n}${String(stamp).slice(-5)}` })).status, 201);
    await uiLogIn(p, { email: email(n) });
    await p.goto(BASE + HUB);
    await p.waitForSelector('[data-testid=el-chat-dock] [data-testid=chat-pill]');
  }
  await a.waitForFunction(() => /[2-9] online/.test(document.querySelector('[data-testid=chat-pill-online]')?.textContent || ''), null, { timeout: 15000 });
  await a.click('[data-testid=chat-pill]');
  await a.waitForSelector('[data-testid=chat-panel]:not([hidden]) [data-input]');
  await a.fill('[data-testid=chat-panel] [data-input]', 'Kano numbers look final');
  await a.keyboard.press('Enter');
  await b.tap('[data-testid=chat-pill]');
  await b.waitForFunction(() => [...document.querySelectorAll('[data-testid=chat-body]')].some((x) => x.textContent.includes('Kano numbers look final')), null, { timeout: 10000 });
  const row = q1('SELECT room, body FROM chat_messages WHERE body=?', 'Kano numbers look final');
  assert.equal(row.room, 'HUB-NIGERIA-2027');
  // Moderation and limits are §20's: the room appears in Admin › Chat and slow mode applies.
  const rooms = (await api('/v1/admin/chat/rooms')).rooms;
  assert.ok(rooms.some((r) => r.event_ticker === 'HUB-NIGERIA-2027' && r.title === 'Nigeria 2027 general election'));
  assert.equal((await adminCall('POST', '/v1/admin/chat/rooms/HUB-NIGERIA-2027/slow_mode', { seconds: 60, reason: 'busy results night' })).status, 200);
  const c = await new Client(BASE, 'ch').logIn(email('ada'), PW);
  const second = await c.call('POST', `/v1/users/${c.uid}/chat/HUB-NIGERIA-2027/messages`, { body: 'and another one' });
  assert.equal(second.status, 429, second.text);
  assert.equal((await c.call('POST', `/v1/users/${c.uid}/chat/HUB-UNKNOWN-HUB/messages`, { body: 'x' })).status, 404, 'only hub rooms that exist');
  assert.deepEqual([a.errors, b.errors], [[], []]);
  await a.context().close(); await b.context().close();
});

test('My Ballot: state → LGA → ward at 390 px lists the contests of that ward; only the division id is saved; forget', async () => {
  const page = await newPage({ width: 390, height: 844 }, true);
  await uiLogIn(page, ADMIN);
  await page.goto(BASE + HUB + '?tab=ballot');
  await page.waitForSelector('[data-testid=el-ballot-privacy]');
  const sels = page.locator('[data-testid=el-ballot-select]');
  assert.equal(await sels.count(), 3);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=el-ballot-select]')[0]?.options.length === 38);
  await sels.nth(0).selectOption('NG-LA');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=el-ballot-select]')[1]?.options.length === 21);
  await sels.nth(1).selectOption('NG-LA-03');
  await page.waitForFunction(() => (document.querySelectorAll('[data-testid=el-ballot-select]')[2]?.options.length || 0) > 8);
  await sels.nth(2).selectOption('NG-LA-03-02');
  await page.click('[data-testid=el-ballot-show]');
  await page.waitForSelector('[data-testid=el-ballot-where][data-division=NG-LA-03-02]');
  const offices = await page.$$eval('[data-testid=el-ballot-contest]', (x) => x.map((e) => e.dataset.office));
  assert.deepEqual([...new Set(offices)].sort(), ['governor', 'house', 'president', 'senate']);
  assert.equal(offices.filter((o) => o === 'senate').length, 1, 'one senatorial district');
  assert.equal(offices.filter((o) => o === 'house').length, 1, 'one federal constituency');
  // The constituency matches the stored area of the race.
  const houseRace = await page.getAttribute('[data-testid=el-ballot-contest][data-office=house]', 'data-race');
  assert.ok(JSON.parse(q1('SELECT area_json a FROM el_races WHERE id=?', houseRace).a).includes('NG-LA-03-02'));
  await page.click('[data-testid=el-ballot-save]');
  await page.waitForSelector('[data-testid=el-ballot-saved-name]');
  const saved = dbq('SELECT * FROM el_ballot_saved WHERE user_id=(SELECT id FROM users WHERE email=?)', ADMIN.email);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['division_id', 'saved_ts', 'user_id']);
  assert.equal(saved[0].division_id, 'NG-LA-03-02');
  assert.ok(await elOverflow(page) <= 1);
  // Comes back on the next visit; forget removes it.
  await page.reload();
  await page.waitForSelector('[data-testid=el-ballot-where][data-division=NG-LA-03-02]');
  await page.click('[data-testid=el-ballot-forget]');
  await eventually(() => q1('SELECT COUNT(*) c FROM el_ballot_saved WHERE user_id=(SELECT id FROM users WHERE email=?)', ADMIN.email).c === 0);
  // Signed out: the picker works, nothing is stored and there is no save button.
  const guest = await newPage();
  await guest.goto(BASE + HUB + '?tab=ballot');
  await guest.waitForFunction(() => document.querySelectorAll('[data-testid=el-ballot-select]')[0]?.options.length === 38);
  await guest.locator('[data-testid=el-ballot-select]').nth(0).selectOption('NG-FC');
  await guest.click('[data-testid=el-ballot-show]');
  await guest.waitForSelector('[data-testid=el-ballot-where][data-division=NG-FC]');
  assert.equal(await guest.locator('[data-testid=el-ballot-save]').count(), 0);
  assert.deepEqual([page.errors, guest.errors], [[], []]);
  await page.context().close(); await guest.context().close();
});

test('second country (Harbor): the same code draws its map, Senate with holdovers and governorship; its feed, call and settlement proposal work', async () => {
  const v = await api('/v1/elections/hubs/harbor-2026/view?office=senate');
  assert.equal(v.map.states.length, 12);
  assert.equal(v.seats.total, 24); assert.equal(v.seats.majority, 13);
  assert.equal(v.seats.parties.reduce((a, p) => a + p.current, 0), 16, 'holdovers count as current seats');
  assert.equal(v.map.states.filter((s) => s.kind === 'none').length, 4, 'four states without a race this cycle');
  const page = await newPage({ width: 390, height: 844 }, true);
  await page.goto(BASE + '/category/elections/harbor-2026');
  await page.waitForSelector('[data-testid=el-hub][data-country=XH]');
  assert.deepEqual(await page.$$eval('[data-testid=el-tabs] [data-tab]', (b) => b.map((x) => x.dataset.tab)), ['overview', 'senate', 'governor', 'states', 'ballot']);
  assert.equal(await page.locator('[data-testid=el-map-state]').count(), 12);
  assert.ok(await elOverflow(page) <= 1);
  assert.equal((await sim('XH26', { action: 'advance', minutes: 1500 })).status, 200);
  const gov = (await api('/v1/elections/races/XH26-GOV-HS')).race;
  assert.equal(gov.pct_reported, 1);
  const c = await adminCall('POST', '/v1/admin/elections/races/XH26-GOV-HS/call', { outcome: 'winner', candidate_id: gov.candidates[0].id, reason: 'Harbor State count complete' });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.proposals.length, 3);
  // Ballot levels come from the country's data: state → district → precinct.
  await page.click('[data-tab=ballot]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=el-ballot-select]').length === 3 && document.querySelectorAll('[data-testid=el-ballot-select]')[0]?.options.length === 13);
  assert.deepEqual(await page.$$eval('.el-ballot-pick .field span', (s) => s.map((x) => x.textContent)), ['State', 'District', 'Precinct']);
  // A brand-new country is data only: created through the admin API, it is listed and its divisions are served.
  assert.equal((await adminCall('POST', '/v1/admin/elections/countries', { code: 'XQ', name: 'Quartz Isles', currency: 'NGN', time_zone: 'Africa/Lagos', locale: 'en-NG', config: { levels: [{ key: 'state' }], map_level: 'state', ballot_levels: ['state'], map_cols: 2, map_rows: 1 }, reason: 'demo country' })).status, 201);
  assert.equal((await adminCall('POST', '/v1/admin/elections/divisions', { country: 'XQ', level: 'state', code: 'N', name: 'North Isle', data: { row: 0, col: 0 }, reason: 'demo' })).status, 201);
  assert.deepEqual((await api('/v1/elections/countries/XQ/divisions')).divisions.map((d) => d.name), ['North Isle']);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('flags off hide each widget and refuse its API; the hub flag shows the managed "not available" page; the simulator flag stops the feed', async () => {
  const page = await newPage();
  await page.goto(BASE + HUB);
  await page.waitForSelector('[data-testid=el-map-state]');
  const hidden = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !e || e.classList.contains('flag-off') || !!e.closest('.flag-off'); }, sel);
  const anon = await new Client(BASE, 'anon').boot();
  for (const [key, sel, probe] of [['elections.results_map', '[data-testid=el-map]', null], ['elections.timeline', '[data-testid=el-timeline]', '/v1/elections/hubs/nigeria-2027/timeline'],
    ['elections.power_index', '[data-testid=el-power]', '/v1/elections/power_index/NG'], ['elections.results', '[data-testid=el-featured]', '/v1/elections/races/NG27-PRES'], ['elections.chat', '[data-testid=el-chat-dock]', '/v1/events/HUB-NIGERIA-2027/chat']]) {
    await setFlag(key, false);
    await eventually(() => hidden(sel), { timeout: 10000 });
    if (probe) { const r = await anon.call('GET', probe); assert.equal(r.status, 403, `${key}: ${r.text}`); assert.equal(r.code, 'feature_disabled'); }
    await setFlag(key, true);
    await eventually(async () => !(await hidden(sel)), { timeout: 10000 });
    if (probe) assert.equal((await anon.call('GET', probe)).status, 200);
  }
  // The map's data leaves the view answer while its flag is off; an event's own chat keeps working.
  await setFlag('elections.results_map', false);
  assert.equal((await anon.call('GET', '/v1/elections/hubs/nigeria-2027/view?office=senate')).body.map, null);
  await setFlag('elections.results_map', true);
  await setFlag('elections.chat', false);
  assert.equal((await anon.call('GET', '/v1/events/PLXNG27-PRES/chat')).status, 200, 'event chat is not the hub chat');
  await setFlag('elections.chat', true);
  // The hub flag: the page is the managed "not available" state and the API refuses.
  await setFlag('elections.hub', false);
  await page.goto(BASE + HUB);
  await page.waitForSelector('[data-testid=feature-unavailable][data-feature="elections.hub"]');
  assert.equal((await anon.call('GET', '/v1/elections/hubs/nigeria-2027')).status, 403);
  await setFlag('elections.hub', true);
  // Simulator off: the admin control refuses and a running clock stops.
  assert.equal((await sim('NGOC', { action: 'start' })).status, 200);
  await eventually(() => JSON.parse(q1("SELECT sim_json s FROM el_elections WHERE id='NGOC'").s).minutes > 0);
  await setFlag('elections.simulator', false);
  const m0 = JSON.parse(q1("SELECT sim_json s FROM el_elections WHERE id='NGOC'").s).minutes;
  await sleep(1200);
  assert.equal(JSON.parse(q1("SELECT sim_json s FROM el_elections WHERE id='NGOC'").s).minutes, m0, 'the feed is paused while the flag is off');
  const r = await sim('NGOC', { action: 'advance', minutes: 10 });
  assert.equal(r.status, 403); assert.equal(r.code, 'feature_disabled');
  await setFlag('elections.simulator', true);
  assert.equal((await sim('NGOC', { action: 'pause' })).status, 200);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('restart keeps every election row (calls, results, snapshots, formula, simulated clock); the production switch keeps election data and turns the simulator off', async () => {
  const before = { calls: q1('SELECT COUNT(*) c FROM el_calls').c, tallies: q1('SELECT COUNT(*) c, SUM(votes) v FROM el_tallies'), snaps: q1('SELECT COUNT(*) c FROM el_snapshots').c, races: dbq('SELECT id, status, winner_candidate_id FROM el_races WHERE status<>\'open\' ORDER BY id'),
    sim: JSON.parse(q1("SELECT sim_json s FROM el_elections WHERE id='NG27'").s), pi: (await api('/v1/admin/elections/power_index/NG')).formula };
  const pres = (await api('/v1/elections/races/NG27-PRES')).race;
  await srv.close();
  srv = await start(opts(PORT));
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  resolver = await new Client(BASE, 'res').logIn(email('resolver'), PW);
  assert.equal(q1('SELECT COUNT(*) c FROM el_calls').c, before.calls);
  assert.deepEqual(q1('SELECT COUNT(*) c, SUM(votes) v FROM el_tallies'), before.tallies);
  assert.equal(q1('SELECT COUNT(*) c FROM el_snapshots').c, before.snaps);
  assert.deepEqual(dbq("SELECT id, status, winner_candidate_id FROM el_races WHERE status<>'open' ORDER BY id"), before.races);
  assert.equal(JSON.parse(q1("SELECT sim_json s FROM el_elections WHERE id='NG27'").s).minutes, before.sim.minutes);
  assert.deepEqual((await api('/v1/admin/elections/power_index/NG')).formula, before.pi);
  assert.equal(q1("SELECT COUNT(*) c FROM el_races").c, 515, 'seeded once: no duplicate races after a restart');
  const again = (await api('/v1/elections/races/NG27-PRES')).race;
  assert.deepEqual([again.status, again.total_votes, again.rule.candidates], [pres.status, pres.total_votes, pres.rule.candidates]);
  const page = await newPage();
  await page.goto(BASE + HUB + '?tab=president');
  await page.waitForSelector('[data-testid=el-race][data-status=runoff]');
  // The production switch (two people) resets play money only: election data stays; the simulator flag goes off.
  assert.equal((await adminCall('PUT', '/v1/admin/play_mode', { on: true, reason: 'play money' })).status, 200);
  const pv = (await adminCall('GET', '/v1/admin/play_mode/preview')).body.preview;
  assert.equal(pv.counts.kept_election_races, 515);
  assert.equal(pv.counts.kept_election_results, before.tallies.c);
  const a2 = await new Client(BASE, 'a2').signUp(email('admin2'), PW, 'Second Admin');
  dbrun('UPDATE users SET is_admin=1 WHERE id=?', a2.uid);
  const admin2 = await new Client(BASE, 'a2').logIn(email('admin2'), PW);
  const req = await adminCall('POST', '/v1/admin/play_mode/production_switch', { reason: 'go live', confirm: 'RESET' });
  assert.equal(req.status, 202, req.text);
  const done = await stepUp(admin2)('POST', `/v1/admin/play_mode/approvals/${req.body.approval.id}/approve`, { confirm: 'RESET' });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(q1('SELECT COUNT(*) c, SUM(votes) v FROM el_tallies'), before.tallies);
  assert.equal(q1('SELECT COUNT(*) c FROM el_calls').c, before.calls);
  assert.equal(q1("SELECT enabled FROM feature_flags WHERE key='elections.simulator'").enabled, 0);
  assert.ok(q1("SELECT 1 x FROM feature_flag_history WHERE flag_key='elections.simulator' AND reason LIKE 'production switch%'"));
  await page.reload();
  await page.waitForSelector('[data-testid=el-race][data-status=runoff]');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
