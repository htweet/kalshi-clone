'use strict';
// Category pages (owner request 2026-11-15, CLONE_SPEC.md §42), real server + SQLite file + Chromium, invented data:
//   • the sidebar counts equal the database and its links (frequency, group, series) change the list;
//   • featured carousel: "1 of N", ‹ › move, chart drawn, legend % equals the pill, multipliers = 1 / YES ask, "N more";
//   • a % pill opens the event ticket on that outcome and a member's order from it lands in the database; on Sports the
//     docked ticket (the event page's own ticket) follows the pill and places the order too;
//   • grid cards show LIVE and date subtitles; a trade moves a pill without a reload (WebSocket);
//   • the underlying-price panel with its strike line (Harbor crude) and the to-beat target (PLX 15-minute window);
//   • the Top-cities strip with Today / Tomorrow (Nigerian cities, WAT days);
//   • the banner: a visitor's dismissal stays in the browser, a member's in the database;
//   • phones (390 px) without sideways scroll, light and dark themes, axe (WCAG 2.2 AA), no page errors;
//   • Admin › Category pages: an admin pins a featured event and regroups the sidebar → the visitor sees it, audited,
//     kept after a restart; the layout switch (owner setting, per-category override) classic ↔ new, kept after a restart.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-category-'));
const DB_FILE = path.join(TMP, 'cat.db');
const PW = 'Enugu-Granite-Lantern-4417';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const MEMBER = { email: `chidi.${stamp}@example.test`, name: 'Chidi Categories' };
const HIGH = { burst: 1e6, per_second: 1e6 };
const OPTS = { port: 0, dbFile: DB_FILE, quiet: true, sports: {}, tickMs: 500, admin: ADMIN, elections: { seed: true }, categoryPages: { seed: true }, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } };
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
let srv; let BASE; let browser; let admin; let member;
const pages = [];
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const json = async (p) => (await fetch(BASE + p)).json();
const OPEN = "EXISTS (SELECT 1 FROM markets m WHERE m.event_ticker=e.ticker AND m.status='active')";
const openCount = (cat, extra = '', ...a) => dbq(`SELECT COUNT(*) n FROM events e JOIN series s ON s.ticker=e.series_ticker WHERE e.category=? AND e.series_ticker<>'PLXCOMBO' AND ${OPEN} ${extra}`, cat, ...a)[0].n;

async function newPage({ width = 1280, theme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.addInitScript((t) => { try { localStorage.setItem('parlance-theme', t); } catch { /* storage blocked */ } }, theme);
  pages.push(page);
  return page;
}
async function uiLogIn(page, email) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
const open = async (page, p) => { await page.goto(BASE + p); await page.waitForSelector('[data-testid=category-page]'); };
const countOf = (s) => Number(/\((\d+)\)/.exec(s)[1]);

before(async () => {
  srv = await start(OPTS);
  BASE = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  member = await new Client(BASE, 'member').signUp(MEMBER.email, PW, MEMBER.name);
  assert.equal((await member.call('POST', `/v1/users/${member.user.user_id}/deposits`, { amount_dollars: 300 })).status, 201);
});
after(async () => {
  for (const p of pages) { try { await p.context().close(); } catch { /* closed */ } }
  try { await browser?.close(); } catch { /* closed */ }
  try { await srv?.close(); } catch { /* closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('sidebar counts equal the database; frequency, group and series links change the list', async () => {
  const cat = 'Climate and Weather';
  const page = await newPage();
  await open(page, '/category/climate-and-weather');
  assert.equal(countOf(await page.textContent('[data-testid=side-all]')), openCount(cat), 'All markets');
  for (const f of await page.$$eval('[data-freq]', (els) => els.map((e) => [e.dataset.freq, e.textContent]))) assert.equal(countOf(f[1]), openCount(cat, 'AND s.frequency=?', f[0]), `frequency ${f[0]}`);
  for (const [t, n] of await page.$$eval('[data-series]', (els) => els.map((e) => [e.dataset.series, Number(e.dataset.count)]))) assert.equal(n, openCount(cat, 'AND e.series_ticker=?', t), `series ${t}`);
  const groups = await page.$$eval('[data-testid=side-group]', (els) => els.map((e) => [e.textContent.trim(), Number(e.dataset.count)]));
  const temp = groups.find(([l]) => l.startsWith('Daily temperature'));
  assert.equal(temp[1], openCount(cat, "AND EXISTS (SELECT 1 FROM json_each(s.tags) j WHERE j.value='Daily temperature')"), 'tag group');
  assert.equal(temp[1], 12, 'six cities × today and tomorrow');
  // Frequency link: the list holds only daily events and says how many.
  await page.click('[data-freq=daily]');
  await page.waitForURL(/frequency=daily/);
  await page.waitForSelector('[data-freq=daily].on');
  const daily = openCount(cat, "AND s.frequency='daily'");
  assert.match(await page.textContent('[data-testid=cp-count]'), new RegExp(`^${daily} events`));
  assert.equal(await page.locator('#results [data-testid=event-card]').count(), Math.min(24, daily));
  assert.equal(await page.locator('[data-testid=cp-featured]').count(), 0, 'no carousel on a filtered list');
  // Series link: Lagos only (today and tomorrow).
  await page.click('[data-series=PLXHILOS]');
  await page.waitForURL(/series=PLXHILOS/);
  await page.waitForFunction(() => document.querySelectorAll('#results [data-testid=event-card]').length === 2);
  assert.ok((await page.$$eval('#results [data-testid=event-card]', (els) => els.map((e) => e.dataset.event))).every((t) => t.startsWith('PLXHILOS-')));
  // A tag group keeps the old /category/<slug>/<tag> address.
  await open(page, '/category/sports');
  await page.click('[data-testid=side-group]:has-text("Basketball")');
  await page.waitForURL(BASE + '/category/sports/Basketball');
  await page.waitForFunction((n) => document.querySelectorAll('#results [data-testid=event-card]').length === n, openCount('Sports', "AND EXISTS (SELECT 1 FROM json_each(s.tags) j WHERE j.value='Basketball')"));
  assert.deepEqual(page.errors, []);
});

test('featured carousel: 1 of N, ‹ › move, chart and legend, multipliers = 1 / YES ask, "N more"', async () => {
  const page = await newPage();
  await open(page, '/category/elections');
  await page.waitForSelector('[data-testid=cp-featured] [data-testid=cp-chart] svg[data-testid=chart-svg]');
  assert.equal(await page.textContent('[data-testid=cp-pager]'), '1 of 3');
  const first = await page.textContent('[data-testid=cp-feat-title]');
  const check = async () => {
    const ev = await page.getAttribute('[data-testid=cp-featured]', 'data-event');
    const rows = await page.$$eval('[data-testid=cp-table] [data-testid=cp-mult]', (els) => els.map((e) => [e.textContent, e.dataset.ask]));
    assert.ok(rows.length >= 2 && rows.length <= 4, 'up to four rows');
    for (const [txt, ask] of rows) assert.equal(txt, `${(100 / Math.round(Number(ask) * 100)).toFixed(2)}x`, `pays out = 1 / ask (${ask})`);
    const active = dbq("SELECT COUNT(*) n FROM markets WHERE event_ticker=? AND status='active'", ev)[0].n;
    const more = await page.textContent('[data-testid=cp-more]');
    assert.equal(more, active > rows.length ? `${active - rows.length} more` : 'Trade');
    // Legend % equals the pill of the same outcome.
    for (const [t, pct] of await page.$$eval('[data-legend]', (els) => els.map((e) => [e.dataset.legend, e.querySelector('b').textContent]))) assert.equal(await page.textContent(`[data-ticker-pill="${t}"]`), pct);
    return ev;
  };
  const ev1 = await check();
  await page.click('[data-feat="1"]');
  await page.waitForFunction((t) => document.querySelector('[data-testid=cp-feat-title]').textContent !== t, first);
  assert.equal(await page.textContent('[data-testid=cp-pager]'), '2 of 3');
  await page.waitForSelector('[data-testid=cp-chart] svg');
  assert.notEqual(await check(), ev1);
  await page.click('[data-feat="-1"]');
  await page.click('[data-feat="-1"]');
  assert.equal(await page.textContent('[data-testid=cp-pager]'), '3 of 3', '‹ wraps around');
  // The automatic pick is ordered by the last 24 hours of volume (server), carousel size = owner setting (3).
  const bff = await json('/v1/bff/category/elections');
  assert.equal(bff.featured.length, 3); assert.equal(bff.carousel_size, 3);
  assert.equal(bff.featured[0].event_ticker, ev1);
  assert.deepEqual(page.errors, []);
});

test('a % pill opens the ticket on that outcome; a member\'s order from it lands in the database (event page and docked ticket)', async () => {
  // Signed out: the pill opens the event ticket; submitting asks to sign up.
  const anon = await newPage();
  await open(anon, '/category/economics');
  const pill = anon.locator('[data-testid=cp-pill]').first();
  const market = new URL(await pill.getAttribute('href'), BASE).searchParams.get('market');
  await pill.click();
  await anon.waitForURL(/\/markets\//);
  await anon.waitForSelector('[data-testid=submit-order]');
  assert.match(await anon.textContent('[data-testid=submit-order]'), /Sign up to trade/);
  // A member: the pill selects that market in the ticket; a Naira order lands in the database.
  const page = await newPage();
  await uiLogIn(page, MEMBER.email);
  await open(page, '/category/economics');
  await page.click(`[data-testid=cp-pill][data-ticker-pill="${market}"]`);
  await page.waitForURL(new RegExp(`market=${market}`));
  await page.waitForSelector('#t-amount');
  await page.fill('#t-amount', '500');
  await page.click('[data-testid=submit-order]'); await page.click('[data-testid=review-confirm]');
  await page.waitForSelector('.toast:has-text("Filled")');
  const uid = member.user.user_id;
  assert.ok(dbq("SELECT COUNT(*) n FROM orders WHERE user_id=? AND market_ticker=? AND side='yes'", uid, market)[0].n >= 1, 'order stored');
  assert.ok(dbq('SELECT yes_count FROM positions WHERE user_id=? AND market_ticker=?', uid, market)[0].yes_count > 0, 'position stored');
  // Sports (wide screen): the docked ticket is the event page's own ticket and follows the pill picked in the list.
  const wide = await newPage({ width: 1440 });
  await uiLogIn(wide, MEMBER.email);
  await open(wide, '/category/sports');
  await wide.waitForSelector('[data-testid=cp-dock] [data-testid=ev-dock] [data-testid=submit-order]');
  const card = wide.locator('#results [data-testid=event-card] a.odds.pill').nth(1);
  const target = new URL(await card.getAttribute('href'), BASE).searchParams.get('market');
  const outcome = dbq('SELECT yes_sub_title y FROM markets WHERE ticker=?', target)[0].y;
  await card.click();
  await wide.waitForFunction((t) => document.querySelector('[data-testid=cp-dock]').dataset.market === t, target);
  await wide.waitForSelector(`[data-testid=cp-dock] .tkt-out:has-text("${outcome}")`);
  assert.match(wide.url(), /\/category\/sports$/, 'the page stays on the category');
  await wide.fill('[data-testid=cp-dock] #t-amount', '300');
  await wide.click('[data-testid=cp-dock] [data-testid=submit-order]'); await wide.click('[data-testid=cp-dock] [data-testid=review-confirm]');
  await wide.waitForSelector('.toast:has-text("Filled")');
  assert.ok(dbq('SELECT COUNT(*) n FROM orders WHERE user_id=? AND market_ticker=?', uid, target)[0].n >= 1, 'docked order stored');
  assert.equal(await wide.locator('[data-testid=cp-combo]').getAttribute('href'), '/combos');
  for (const p of [anon, page, wide]) assert.deepEqual(p.errors, []);
});

test('grid cards: LIVE and date subtitles; kind chips; a trade moves a pill without a reload', async () => {
  const page = await newPage({ width: 1440 });
  await open(page, '/category/sports');
  await page.waitForSelector('#results [data-testid=event-card] .live-dot');
  const subs = await page.$$eval('#results [data-testid=event-card] .mcard-sub', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(subs.some((s) => /\d{1,2} [A-Z][a-z]{2}/.test(s)), `a date subtitle: ${subs.join(' | ')}`);
  assert.ok((await page.locator('[data-testid=sports-strip] [data-testid=cp-game-card]').count()) >= 2, 'games strip');
  const kinds = await page.$$eval('[data-testid=kind-chips] a', (els) => els.map((e) => [e.dataset.kind, Number(/\((\d+)\)/.exec(e.textContent)[1])]));
  assert.equal(kinds.find(([k]) => k === 'games')[1], dbq(`SELECT COUNT(*) n FROM events e WHERE e.ticker IN (SELECT event_ticker FROM sports_event_links) AND ${OPEN}`)[0].n);
  await page.click('[data-kind=futures]');
  await page.waitForURL(/kind=futures/);
  await page.waitForFunction((n) => document.querySelectorAll('#results [data-testid=event-card]').length === n, kinds.find(([k]) => k === 'futures')[1]);
  // Live: buy the Harbor central bank "Hold" at its ask; the pill on the card follows the new last price.
  const econ = await newPage();
  await open(econ, '/category/economics');
  const t = 'PLXRATE-26DEC-HOLD';
  const before = await econ.textContent(`#results [data-event=PLXRATE-26DEC] .outcome-row[data-ticker="${t}"] .pill`);
  const ask = Number((await json('/trade-api/v2/markets/' + t)).market.yes_ask_dollars);
  const r = await member.call('POST', `/v1/users/${member.user.user_id}/orders`, { ticker: t, side: 'yes', action: 'buy', type: 'limit', count: 1, price_dollars: ask.toFixed(4) });
  assert.equal(r.status, 201);
  const want = `${Math.round(ask * 100)}%`;
  assert.notEqual(before, want);
  await econ.waitForFunction(([tk, w]) => document.querySelector(`#results [data-event=PLXRATE-26DEC] .outcome-row[data-ticker="${tk}"] .pill`).textContent === w, [t, want]);
  for (const p of [page, econ]) assert.deepEqual(p.errors, []);
});

test('underlying price: Harbor crude with its strike line; the PLX 15-minute window to beat', async () => {
  const page = await newPage();
  await open(page, '/category/financials');
  await page.waitForSelector('[data-testid=cp-underlying][data-kind=strike] [data-testid=cp-und-chart]');
  const last = dbq("SELECT price FROM underlying_prices WHERE series_ticker='PLXCRUDE' ORDER BY ts DESC LIMIT 1")[0].price;
  assert.equal(await page.textContent('[data-testid=cp-und-price]'), `₦${Math.round(last).toLocaleString('en-NG')}`);
  assert.equal(await page.locator('[data-testid=cp-strike-line]').count(), 1);
  const strike = await page.textContent('[data-testid=cp-strike-label]');
  assert.match(strike, /^₦[\d,]+ or above$/);
  assert.ok(dbq("SELECT 1 FROM markets WHERE event_ticker LIKE 'PLXCRUDE-%' AND yes_sub_title=?", strike).length, 'the strike is the leading market');
  assert.equal(await page.locator('[data-testid=cp-table] [data-testid=cp-pill]').count(), 4);
  // Crypto: the up / down window shows the target to beat and the index now; Down pays 1 / NO ask.
  await open(page, '/category/crypto');
  await page.waitForSelector('[data-testid=cp-underlying][data-kind=target]');
  const ev = await page.getAttribute('[data-testid=cp-featured]', 'data-event');
  const w = dbq('SELECT target_cents FROM flash_windows WHERE event_ticker=?', ev)[0];
  assert.equal(await page.textContent('[data-testid=cp-und-target]'), `₦${w.target_cents.toLocaleString('en-NG')}`);
  assert.deepEqual(await page.$$eval('[data-testid=cp-table] .oc-name > span:first-child', (els) => els.map((e) => e.textContent)), ['Up', 'Down']);
  const [up, down] = await page.$$eval('[data-testid=cp-pill]', (els) => els.map((e) => Number(e.textContent.replace('%', ''))));
  assert.equal(up + down, 100);
  assert.match(await page.getAttribute('[data-testid=cp-table] [data-testid=cp-pill] >> nth=1', 'href'), /side=no/);
  assert.deepEqual(page.errors, []);
});

test('Top cities: Nigerian cities for today and tomorrow (WAT), leading bracket and rain', async () => {
  const page = await newPage();
  await open(page, '/category/climate-and-weather');
  await page.waitForSelector('[data-testid=top-cities] [data-testid=city-card]');
  const today = await page.$$eval('[data-testid=city-card]', (els) => els.map((e) => [e.querySelector('.cp-city-name').textContent, e.dataset.event, e.querySelector('.cp-city-temp').textContent, e.querySelector('.odds').textContent, e.querySelector('.cp-city-sub').textContent]));
  assert.deepEqual(today.map((c) => c[0]), ['Lagos', 'Abuja', 'Kano', 'Port Harcourt', 'Ibadan', 'Enugu']);
  const watDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  const days = [watDay(Date.now()), watDay(Date.now() + 86400000)];
  for (const [, ev, bracket, pct, rain] of today) {
    assert.equal(dbq('SELECT day FROM category_city_events WHERE event_ticker=?', ev)[0].day, days[0], `${ev} is today's`);
    const lead = dbq("SELECT m.yes_sub_title y, (SELECT yes_price_cents FROM trades t WHERE t.market_ticker=m.ticker ORDER BY created_ts DESC, rowid DESC LIMIT 1) p FROM markets m WHERE m.event_ticker=? ORDER BY p DESC LIMIT 1", ev)[0];
    assert.equal(bracket, lead.y, `${ev}: leading bracket`); assert.equal(pct, `${lead.p}%`);
    assert.match(rain, /^Rain \d+%$/);
  }
  await page.click('[data-day=tomorrow]');
  await page.waitForFunction((e) => document.querySelector('[data-testid=city-card]').dataset.event !== e, today[0][1]);
  for (const ev of await page.$$eval('[data-testid=city-card]', (els) => els.map((e) => e.dataset.event))) assert.equal(dbq('SELECT day FROM category_city_events WHERE event_ticker=?', ev)[0].day, days[1]);
  assert.equal(await page.getAttribute('[data-day=tomorrow]', 'aria-pressed'), 'true');
  // The strip is a category choice: off for Economics by default.
  assert.equal((await json('/v1/bff/category/economics')).top_cities, null);
  assert.deepEqual(page.errors, []);
});

test('banner: a visitor\'s dismissal stays in the browser, a member\'s in the database', async () => {
  const page = await newPage();
  await open(page, '/category/crypto');
  await page.waitForSelector('[data-testid=cp-banner]:has-text("Understanding Invest")');
  await page.click('[data-banner-close]');
  await page.reload(); await page.waitForSelector('[data-testid=category-page]');
  assert.equal(await page.locator('[data-testid=cp-banner]').count(), 0, 'visitor: kept dismissed');
  const mp = await newPage();
  await uiLogIn(mp, MEMBER.email);
  await open(mp, '/category/crypto');
  await mp.click('[data-testid=cp-banner] [data-banner-close]');
  await mp.waitForFunction(() => !document.querySelector('[data-testid=cp-banner]'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(dbq("SELECT banner_version v FROM category_banner_dismissals WHERE user_id=? AND category='Crypto'", member.user.user_id)[0].v, 1);
  assert.equal((await member.call('GET', '/v1/bff/category/crypto')).body.banner, null, 'member: dismissed on every device');
  for (const p of [page, mp]) assert.deepEqual(p.errors, []);
});

test('390 px without sideways scroll; light and dark; axe WCAG 2.2 AA; no page errors', async () => {
  const found = [];
  for (const theme of ['dark', 'light']) {
    for (const width of [1280, 390]) {
      const page = await newPage({ width, theme });
      for (const slug of ['climate-and-weather', 'sports', 'crypto', 'elections', 'financials']) {
        await open(page, `/category/${slug}`);
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(over <= 0, `${slug} ${theme} ${width}: no sideways scroll (${over}px)`);
        if (width === 390) assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.cp-side')).flexDirection), 'row', 'the sidebar is a chip row');
        if (slug === 'climate-and-weather' || slug === 'sports' || slug === 'crypto') {
          if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(AXE);
          const r = await page.evaluate(async (tags) => (await window.axe.run(document, { runOnly: { type: 'tag', values: tags } })).violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`), TAGS);
          for (const v of r) found.push(`${theme}/${width} ${slug} ${v}`);
        }
      }
      assert.deepEqual(page.errors, [], `${theme} ${width}`);
    }
  }
  assert.deepEqual(found, []);
});

test('Admin › Category pages: pin a featured event and regroup the sidebar; the visitor sees it, audited, kept after a restart', async () => {
  const ap = await newPage({ width: 1360 });
  await uiLogIn(ap, ADMIN.email);
  await ap.goto(BASE + '/admin/category_pages/economics');
  await ap.waitForSelector('[data-testid=cp-admin-form]');
  await ap.fill('[name=pins]', 'PLXGDP-26Q4');
  await ap.selectOption('[name=grouping]', 'custom');
  await ap.fill('[name=groups]', 'Rates and growth | series:PLXRATE,PLXGDP | bank | #1c7ed6');
  await ap.fill('[name=reason]', 'Feature the growth market for the GDP release');
  await ap.click('[data-testid=cp-admin-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=cp-admin-featured] li:first-child:has-text("PLXGDP-26Q4")');
  assert.equal(dbq("SELECT COUNT(*) n FROM admin_audit WHERE action='category_pages.update' AND target_id='Economics' AND reason LIKE 'Feature the growth%'")[0].n, 1, 'audited');
  // Bad input is refused with the field named.
  const bad = await admin.call('PUT', '/v1/admin/category_pages/economics', { config: { featured: { pins: ['PLXCUP-26FINAL'] } }, reason: 'wrong category' });
  assert.equal(bad.status, 400); assert.match(bad.body.error.details, /not in this category/);
  assert.equal((await new Client(BASE, 'anon').boot().then((c) => c.call('GET', '/v1/admin/category_pages'))).status, 401);
  const visitor = async () => {
    const page = await newPage();
    await open(page, '/category/economics');
    await page.waitForSelector('[data-testid=cp-featured][data-event=PLXGDP-26Q4]');
    const g = await page.$$eval('[data-testid=side-group]', (els) => els.map((e) => [e.textContent.trim().replace(/\s+/g, ' '), Number(e.dataset.count)]));
    assert.deepEqual(g, [[`Rates and growth (${openCount('Economics', "AND e.series_ticker IN ('PLXRATE','PLXGDP')")})`, openCount('Economics', "AND e.series_ticker IN ('PLXRATE','PLXGDP')")]]);
    assert.equal(await page.locator('[data-testid=side-group] .cp-gi svg').count(), 1, 'the chosen glyph');
    assert.equal(await page.getAttribute('[data-testid=cat-hub-link]', 'href'), '/hubs/economics');
    assert.deepEqual(page.errors, []);
  };
  await visitor();
  await srv.close();
  srv = await start(OPTS);
  BASE = `http://127.0.0.1:${srv.port}`;
  admin = await new Client(BASE, 'admin2').logIn(ADMIN.email, ADMIN.password);
  member = await new Client(BASE, 'member2').logIn(MEMBER.email, PW);
  await visitor();
});

test('layout switch: owner setting classic ↔ new and a per-category override, live and kept after a restart', async () => {
  const set = async (value) => assert.equal((await admin.call('PUT', '/v1/admin/owner_settings/category.layout', { value, reason: `layout ${value} from the e2e suite` })).status, 200);
  await set('classic');
  const page = await newPage();
  await page.goto(BASE + '/category/politics');
  await page.waitForSelector('[data-testid=subcategories]');
  assert.equal(await page.locator('[data-testid=category-page]').count(), 0, 'classic layout');
  // Per category (Admin › Category pages): Politics keeps the new layout while the site default is classic.
  const ap = await newPage({ width: 1360 });
  await uiLogIn(ap, ADMIN.email);
  await ap.goto(BASE + '/admin/category_pages/politics');
  await ap.waitForSelector('[data-testid=cp-admin-form]');
  await ap.selectOption('[name=layout]', 'new');
  await ap.fill('[name=reason]', 'Politics tries the new layout first');
  await ap.click('[data-testid=cp-admin-form] button[type=submit]');
  await ap.waitForSelector('text=Showing the new layout');
  await open(page, '/category/politics');
  await page.goto(BASE + '/category/companies');
  await page.waitForSelector('[data-testid=subcategories]');
  assert.equal(await page.locator('[data-testid=category-page]').count(), 0, 'the others follow the site default');
  await srv.close();
  srv = await start(OPTS);
  BASE = `http://127.0.0.1:${srv.port}`;
  admin = await new Client(BASE, 'admin3').logIn(ADMIN.email, ADMIN.password);
  const p2 = await newPage();
  await open(p2, '/category/politics');
  await p2.goto(BASE + '/category/companies');
  await p2.waitForSelector('[data-testid=subcategories]');
  assert.equal(await p2.locator('[data-testid=category-page]').count(), 0, 'classic kept after a restart');
  await set('new');
  await open(p2, '/category/companies');
  assert.equal(dbq("SELECT COUNT(*) n FROM admin_audit WHERE action='owner_settings.update' AND target_id='category.layout'")[0].n, 2);
  for (const p of [page, ap, p2]) assert.deepEqual(p.errors, []);
});
