'use strict';
// Layout variants (owner requests 2026-11-15, CLONE_SPEC.md §41), real server + SQLite file + Chromium:
//   • visitors get the landing page by default: hero carousel (arrows, pager, auto-advance, pause, Read more, swipe),
//     the Weekly forecasts ticker (scrolls, pause stops it, reduced motion keeps it still), Markets to watch with charts
//     and volume, the promo rail and the Monthly forecast, category lists; light and dark; 390 px without horizontal scroll;
//   • a live price change reaches the hero legend and a ticker chip without a reload;
//   • Admin › Content › Landing page: pin a hero event, its context text and image, a pinned chip → visitors see them;
//   • the variant switches (visitors / members) work live, are audited and persist after a restart; members keep the
//     classic home by default;
//   • the new member home: the onboarding card follows the member's real state and can be dismissed, 15 Min Markets
//     with a countdown and four underlyings, Customize your view persisted (Settings shows it; Trader mode lands on Pro).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-landing-'));
const DB_FILE = path.join(TMP, 'landing.db');
const PW = 'Ogun-Lantern-Harbour-4471';
const stamp = Date.now();
const ADMIN = { email: `lp.root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const OPTS = { port: 0, dbFile: DB_FILE, tickMs: 300, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, identity: { kycRequired: false } };
let srv; let BASE; let browser; let admin;
const allPages = [];
const email = (n) => `${n}.${stamp}@example.test`;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const q1 = (sql, ...a) => dbq(sql, ...a)[0];
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, { timeout = 15000, interval = 150, msg = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { const v = await fn(); if (v) return v; } catch (e) { if (Date.now() > end) throw e; } if (Date.now() > end) throw new Error(`eventually: ${msg} not met`); await sleep(interval); }
}
async function newPage({ width = 1440, height = 1000, theme = 'dark', reducedMotion = 'no-preference', hasTouch = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion, hasTouch });
  await ctx.addInitScript((t) => { try { localStorage.setItem('parlance-theme', t); } catch { /* storage blocked */ } }, theme);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  allPages.push(page);
  return page;
}
async function uiLogIn(page, u) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
const setOwner = async (key, value) => {
  const r = await admin.call('PUT', `/v1/admin/owner_settings/${key}`, { value, reason: 'landing e2e' });
  assert.equal(r.status, 200, r.text);
};
const pager = (p) => p.textContent('[data-testid=hero-pager]');
const trackX = (p) => p.$eval('[data-testid=ticker-track]', (t) => t.getBoundingClientRect().x);
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 0);
function png(w, h, rgb) {
  const crc = (b) => { let c = -1; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = (rgb[1] + y) % 256; raw[o + 2] = rgb[2]; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

before(async () => {
  srv = await start(OPTS);
  BASE = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  for (const p of allPages) { try { await p.context().close(); } catch { /* closed */ } }
  try { await browser?.close(); } catch { /* ignore */ }
  try { await srv?.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('visitors get the landing page: carousel, Weekly forecasts ticker, Markets to watch, promo rail, Monthly forecast, categories (dark and light)', async () => {
  // Auto-advance off for this test: the arrows and the pager are checked without the carousel moving on by itself.
  await setOwner('layout.hero_autoadvance', false);
  for (const theme of ['dark', 'light']) {
    const page = await newPage({ theme });
    await page.goto(BASE + '/');
    await page.waitForSelector('[data-testid=landing] [data-testid=hero-title]');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
    assert.equal(await page.locator('.hero-table').count(), 0, 'not the classic home');
    // Carousel: the centre slide, its neighbours peeking in; arrows step, the pager follows, the context sits beside.
    assert.match(await pager(page), /^1 of (\d+)$/);
    const n = Number((await pager(page)).split(' of ')[1]);
    assert.ok(n >= 3, `slides: ${n}`);
    const first = await page.textContent('[data-testid=hero-title]');
    const peek = await page.$$eval('.lp-slide', (ss) => ss.filter((s) => !s.classList.contains('cur') && !s.classList.contains('far')).map((s) => { const r = s.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth; }));
    assert.ok(peek.filter(Boolean).length >= 1, 'a neighbouring slide peeks in');
    await page.click('#hero-next');
    await page.waitForFunction((t) => document.querySelector('[data-testid=hero-title]').textContent !== t, first);
    assert.match(await pager(page), /^2 of /);
    await page.click('#hero-prev');
    await page.waitForFunction((t) => document.querySelector('[data-testid=hero-title]').textContent === t, first);
    // Keyboard: arrow keys inside the carousel.
    await page.focus('#hero-next');
    await page.keyboard.press('ArrowRight');
    assert.match(await pager(page), /^2 of /);
    assert.equal(await page.locator('[data-testid=hero-title]').count(), 1, 'one current title');
    assert.equal(await page.getAttribute('#lp-track', 'aria-live'), 'polite', 'a visitor\'s own step is announced');
    assert.ok(await page.locator('.lp-slide.cur .lp-chart svg[role=img]').count() === 1, 'chart with a text alternative');
    assert.match(await page.textContent('.lp-slide.cur .lp-vol'), /^₦[\d,]+ volume$/);
    assert.match(await page.textContent('.lp-slide.cur .lp-legend'), /\d+%/);
    // Ticker: chips with a value and a 1-day change; it scrolls, pause stops it.
    const chips = page.locator('[data-testid=lp-ticker] .lp-tk-list:first-child li:not([aria-hidden]) .lp-chip');
    assert.ok(await chips.count() >= 1);
    assert.match(await chips.first().textContent(), /\(.*1D\)/);
    const x0 = await trackX(page); await sleep(700);
    assert.notEqual(await trackX(page), x0, 'the ticker scrolls');
    await page.click('[data-testid=ticker-pause]');
    assert.equal(await page.getAttribute('[data-testid=ticker-pause]', 'aria-pressed'), 'true');
    await page.mouse.move(5, 5); // away from the band (hovering pauses it too)
    const x1 = await trackX(page); await sleep(700);
    assert.equal(await trackX(page), x1, 'paused: the ticker stands still');
    // Markets to watch: three cards with an image or artwork, two outcomes, a chart (0 / 50 / 100) and the volume.
    const cards = page.locator('#top-markets [data-testid=event-card]');
    assert.equal(await cards.count(), 3);
    for (let i = 0; i < 3; i++) {
      const c = cards.nth(i);
      assert.ok(await c.locator('.lp-card-pic').count() === 1);
      assert.ok(await c.locator('svg[data-testid=lp-chart]').count() === 1);
      assert.match(await c.locator('svg[data-testid=lp-chart]').innerHTML(), /100%.*50%|50%.*100%/s);
      assert.match(await c.textContent(), /₦[\d,]+ volume/);
    }
    // Rail: the Invest promo cards, the hub card, the Monthly forecast and the note.
    for (const id of ['perps-promo', 'apy-promo', 'landing-hub', 'monthly-forecast', 'lp-note']) assert.ok(await page.isVisible(`[data-testid=${id}]`), id);
    assert.match(await page.textContent('[data-testid=apy-promo]'), /APY/);
    assert.match(await page.textContent('[data-testid=monthly-forecast]'), /forecasted|chance/);
    assert.match(await page.textContent('[data-testid=landing-hub]'), /₦[\d,]+ volume/);
    // Category lists: heading links and two-column rows.
    const cats = page.locator('[data-testid=lp-category]');
    assert.ok(await cats.count() >= 2);
    assert.ok(await cats.first().locator('.lp-li').count() >= 1);
    assert.match(await cats.first().locator('h2 a').getAttribute('href'), /^\/category\//);
    assert.ok(await noOverflow(page), `${theme}: no horizontal scroll`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});

test('carousel auto-advance (owner settings), pause; reduced motion keeps the carousel and the ticker still', async () => {
  await setOwner('layout.hero_autoadvance', true);
  await setOwner('layout.hero_interval_seconds', 4);
  const page = await newPage();
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=hero-title]');
  await page.mouse.move(5, 5);
  assert.equal(await page.getAttribute('#hero-play', 'aria-pressed'), 'false', 'playing');
  assert.equal(await page.getAttribute('#lp-track', 'aria-live'), 'off', 'automatic steps are not announced');
  await page.waitForFunction(() => /^2 of /.test(document.querySelector('[data-testid=hero-pager]').textContent), null, { timeout: 7000 });
  await page.click('#hero-play'); // pause
  assert.equal(await page.getAttribute('#hero-play', 'aria-pressed'), 'true');
  await page.mouse.move(5, 5);
  const p1 = await pager(page); await sleep(5000);
  assert.equal(await pager(page), p1, 'paused: no step');
  assert.deepEqual(page.errors, []);
  await page.context().close();

  const still = await newPage({ reducedMotion: 'reduce' });
  await still.goto(BASE + '/');
  await still.waitForSelector('[data-testid=ticker-track]');
  await still.mouse.move(5, 5);
  assert.equal(await still.locator('[data-testid=ticker-track].run').count(), 0, 'reduced motion: no scrolling ticker');
  assert.equal(await still.isVisible('[data-testid=ticker-pause]'), false);
  const x = await trackX(still); await sleep(4500);
  assert.equal(await trackX(still), x);
  assert.match(await pager(still), /^1 of /, 'reduced motion: no auto-advance');
  await still.context().close();
  await setOwner('layout.hero_autoadvance', false);
});

test('a live price change reaches the hero legend and a Weekly forecasts chip without a reload', async () => {
  const L = (await (await fetch(`${BASE}/v1/bff/landing`)).json()).landing;
  const chip = L.chips.find((c) => L.hero.some((h) => h.markets.some((m) => m.ticker === c.market.ticker))) || L.chips[0];
  const T = chip.market.ticker;
  const page = await newPage();
  await page.goto(BASE + '/');
  await page.waitForSelector(`[data-chip="${T}"]`);
  await sleep(800); // subscribed
  const before0 = await page.textContent(`[data-chip="${T}"] [data-chip-value]`);
  // A member buys YES through the order book: the trade moves the last price.
  const m = await new Client(BASE, 'trader').signUp(email('trader'), PW, 'Tola Trader');
  assert.equal((await m.call('POST', `/v1/users/${m.user.user_id}/deposits`, { amount_dollars: 100 })).status, 201);
  const ask = Number((await m.call('GET', `/trade-api/v2/markets/${T}`)).body.market.yes_ask_dollars);
  const r = await m.call('POST', `/v1/users/${m.user.user_id}/orders`, { ticker: T, side: 'yes', type: 'limit', price: Math.min(99, Math.round(ask * 100) + 3), count: 20 });
  assert.equal(r.status, 201, r.text);
  const last = Number((await m.call('GET', `/trade-api/v2/markets/${T}`)).body.market.last_price_dollars);
  const want = `${Math.round(last * 100)}%`;
  await page.waitForFunction(([t, w]) => document.querySelector(`[data-chip="${t}"] [data-chip-value]`).textContent.endsWith(w), [T, want], { timeout: 10000 });
  assert.notEqual(await page.textContent(`[data-chip="${T}"] [data-chip-value]`), before0);
  if (L.hero.some((h) => h.markets.some((x) => x.ticker === T))) await page.waitForFunction(([t, w]) => [...document.querySelectorAll(`.lp-legend [data-lp-price="${t}"]`)].every((b) => b.textContent === w), [T, want]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Admin › Content › Landing page: pin a hero event, its context text and image, a pinned chip → visitors see them; audited', async () => {
  const img = await admin.call('POST', '/v1/admin/cms/media', { filename: 'harbor-tram.png', data: png(480, 300, [20, 90, 160]).toString('base64') });
  assert.equal(img.status, 201, img.text);
  const ap = await newPage({ width: 1440, height: 1100 });
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/content/landing');
  await ap.waitForSelector('[data-testid=landing-editor]');
  const T = 'PLXCOUNCIL-27TRAM';
  const row = ap.locator(`[data-testid=landing-events] tr[data-event="${T}"]`);
  await row.locator('[data-testid=landing-pin]').click();
  await eventually(() => q1('SELECT 1 x FROM cms_hero WHERE event_ticker=?', T), { msg: 'pinned' });
  await ap.waitForSelector(`[data-testid=landing-events] tr[data-event="${T}"] .adm-badge`);
  await ap.locator(`[data-testid=landing-events] tr[data-event="${T}"] [data-testid=landing-edit]`).click();
  const ctx = 'The council meets on Thursday to vote on the waterfront tram. Supporters point to shorter commutes along the harbour; opponents question the cost of the depot and the two years of works on the seafront road. A second reading is expected before the vote.';
  await ap.fill('[data-testid=landing-content-form] [name=context]', ctx);
  await ap.selectOption('[data-testid=landing-content-form] [name=image_asset_id]', img.body.asset.id);
  await ap.fill('[data-testid=landing-content-form] [name=image_alt]', 'Illustration of a tram by the harbour');
  await ap.click('[data-testid=landing-content-form] button[type=submit]');
  await eventually(() => q1("SELECT context FROM landing_content WHERE kind='event' AND ref=?", T)?.context === ctx, { msg: 'context saved' });
  // A pinned chip with a short label.
  const chipT = 'PLXRATE-26DEC-CUT';
  await ap.waitForSelector('[data-testid=chip-market]');
  await ap.selectOption('[data-testid=chip-market]', chipT);
  await ap.fill('[data-testid=chip-label]', 'Rate cut');
  await ap.click('[data-testid=chip-add]');
  await ap.waitForSelector('[data-testid=chip-pins] li:has-text("Rate cut")');
  assert.ok(q1("SELECT 1 x FROM admin_audit WHERE action='landing.content' AND target_id=?", T));
  assert.ok(q1("SELECT 1 x FROM admin_audit WHERE action='landing.config'"));
  assert.ok(q1("SELECT 1 x FROM admin_audit WHERE action='content.hero.set'"));
  assert.deepEqual(ap.errors, []);

  const v = await newPage();
  await v.goto(BASE + '/');
  await v.waitForSelector('[data-testid=hero-title]');
  assert.equal(await pager(v), '1 of 1', 'pinned slides only (the default: no automatic fill)');
  assert.equal(await v.textContent('[data-testid=hero-title]'), 'Will Harbor City approve the waterfront tram?');
  assert.equal(await v.textContent('.lp-slide.cur [data-testid=hero-context]'), ctx);
  assert.equal(await v.getAttribute('.lp-slide.cur [data-testid=lp-image]', 'src'), `/media/${img.body.asset.id}.png`);
  assert.equal(await v.getAttribute('.lp-slide.cur [data-testid=lp-image]', 'alt'), 'Illustration of a tram by the harbour');
  assert.equal(await v.getAttribute('.lp-slide.cur [data-testid=lp-image]', 'loading'), 'lazy');
  // Read more: the paragraph is cut at three lines; the button expands it.
  const more = v.locator('.lp-slide.cur [data-testid=read-more]');
  assert.ok(await more.isVisible());
  const h0 = await v.$eval('.lp-slide.cur [data-testid=hero-context]', (p) => p.clientHeight);
  await more.click();
  assert.equal(await more.getAttribute('aria-expanded'), 'true');
  assert.ok(await v.$eval('.lp-slide.cur [data-testid=hero-context]', (p) => p.clientHeight) > h0, 'expanded');
  // The pinned chip comes first, with its label.
  assert.match(await v.textContent('[data-testid=lp-ticker] .lp-chip >> nth=0'), /^Rate cut/);
  assert.deepEqual(v.errors, []);
  // Fill with automatic slides after the pin (admin switch).
  assert.equal((await admin.call('PUT', '/v1/admin/landing/config', { hero_fill_auto: true })).status, 200);
  await v.reload();
  await v.waitForSelector('[data-testid=hero-title]');
  assert.match(await pager(v), /^1 of ([2-9]|1\d)$/);
  assert.equal(await v.textContent('[data-testid=hero-title]'), 'Will Harbor City approve the waterfront tram?', 'the pinned slide stays first');
  // Validation: unknown market, markup in the context text.
  assert.equal((await admin.call('PUT', '/v1/admin/landing/config', { chip_pins: [{ market_ticker: 'NOPE-NOPE' }] })).status, 400);
  assert.equal((await admin.call('PUT', `/v1/admin/landing/content/event/${T}`, { context: '<script>x</script>' })).status, 400);
  await Promise.all([v, ap].map((p) => p.context().close()));
});

test('390 px: one slide with swipe, the rail under the cards, no horizontal scroll (dark and light)', async () => {
  for (const theme of ['dark', 'light']) {
    const page = await newPage({ width: 390, height: 844, theme, hasTouch: true });
    await page.goto(BASE + '/');
    await page.waitForSelector('[data-testid=hero-title]');
    assert.ok(await noOverflow(page), `${theme}: no horizontal scroll`);
    const vis = await page.$$eval('.lp-slide:not(.cur)', (ss) => ss.filter((s) => { const r = s.getBoundingClientRect(); return r.right > 1 && r.left < innerWidth - 1 && getComputedStyle(s).visibility !== 'hidden'; }).length);
    assert.equal(vis, 0, 'one slide in view');
    const p0 = await pager(page);
    await page.$eval('#hero', (h) => {
      const r = h.getBoundingClientRect(); const y = r.top + 100;
      h.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: 320, clientY: y, bubbles: true }));
      h.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', clientX: 80, clientY: y + 5, bubbles: true }));
    });
    await page.waitForFunction((p) => document.querySelector('[data-testid=hero-pager]').textContent !== p, p0);
    const cards = await page.$eval('#top-markets', (e) => e.getBoundingClientRect().bottom);
    const rail = await page.$eval('[data-testid=lp-rail]', (e) => e.getBoundingClientRect().top);
    assert.ok(rail >= cards, 'the rail stacks under the cards');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});

test('layout variants: members keep the classic home; switches for visitors and members work live, are audited and persist after a restart', async () => {
  const member = { email: email('ada') };
  await new Client(BASE, 'ada').signUp(member.email, PW, 'Ada Member');
  const mp = await newPage();
  await uiLogIn(mp, member);
  await mp.goto(BASE + '/');
  await mp.waitForSelector('#hero .hero-table');
  assert.equal(await mp.locator('[data-testid=landing], [data-testid=home-new]').count(), 0, 'classic member home by default');
  // Admin › Content › Landing page: members → new (owner setting, live on the open page).
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/content/landing');
  await ap.waitForSelector('[data-testid=variant-members]');
  await ap.selectOption('[data-testid=variant-members]', 'new');
  await eventually(() => q1("SELECT value FROM admin_settings WHERE key='owner:layout.home_members'")?.value === '"new"', { msg: 'stored' });
  await mp.waitForSelector('[data-testid=home-new]', { timeout: 15000 });
  assert.ok(q1("SELECT 1 x FROM admin_audit WHERE action='owner_settings.update' AND target_id='layout.home_members'"));
  // Visitors → classic (API), live on an open visitor page.
  const vp = await newPage();
  await vp.goto(BASE + '/');
  await vp.waitForSelector('[data-testid=landing]');
  await setOwner('layout.home_visitors', 'classic');
  await vp.waitForSelector('#hero .hero-table', { timeout: 15000 });
  assert.equal(await vp.locator('[data-testid=landing]').count(), 0);
  for (const p of [mp, ap, vp]) assert.deepEqual(p.errors, []);
  await Promise.all([mp, ap, vp].map((p) => p.context().close()));
  // Restart on the same database: both choices persist.
  await srv.close();
  srv = await start({ ...OPTS, port: srv.port });
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  const v2 = await newPage();
  await v2.goto(BASE + '/');
  await v2.waitForSelector('#hero .hero-table');
  const m2 = await newPage();
  await uiLogIn(m2, member);
  await m2.goto(BASE + '/');
  await m2.waitForSelector('[data-testid=home-new]');
  await Promise.all([v2, m2].map((p) => p.context().close()));
  await setOwner('layout.home_visitors', 'new');
});

test('new member home: onboarding card follows the member\'s steps and can be dismissed; 15 Min Markets; Customize your view (persisted, in Settings; Trader lands on Pro)', async () => {
  await setOwner('layout.home_members', 'new');
  const u = { email: email('bola') };
  const c = await new Client(BASE, 'bola').signUp(u.email, PW, 'Bola New');
  const uid = c.user.user_id;
  for (const theme of ['dark', 'light']) {
    const page = await newPage({ theme });
    await uiLogIn(page, u);
    await page.goto(BASE + '/');
    await page.waitForSelector('[data-testid=home-new] [data-testid=hero-title]');
    assert.ok(await noOverflow(page));
    await page.context().close();
  }
  const page = await newPage();
  await uiLogIn(page, u);
  await page.goto(BASE + '/');
  // Step 1: the email is not confirmed yet.
  await page.waitForSelector('[data-testid=onboarding-card][data-step=email]');
  assert.equal(await page.textContent('[data-testid=onboarding-step]'), 'Step 1 of 4');
  assert.equal(await page.getAttribute('[data-testid=onboarding-next]', 'href'), '/verify-email');
  // Email confirmed → step 2, verify identity.
  assert.equal(dbrun('UPDATE identity_profiles SET email_verified_at=? WHERE user_id=?', new Date().toISOString(), uid).changes, 1);
  await page.reload();
  await page.waitForSelector('[data-testid=onboarding-card][data-step=identity]');
  assert.equal(await page.textContent('[data-testid=onboarding-step]'), 'Step 2 of 4');
  assert.match(await page.textContent('[data-testid=onboarding-card]'), /Verify your identity/);
  // 15 Min Markets: the countdown ticks, four underlyings, Above + Below = 100.
  await page.waitForSelector('[data-testid=fifteen-countdown]:not([hidden])');
  const t0 = await page.textContent('[data-testid=fifteen-countdown]');
  assert.match(t0, /^● \d\d:\d\d$/);
  await page.waitForFunction((t) => document.querySelector('[data-testid=fifteen-countdown]').textContent !== t, t0, { timeout: 3000 });
  const cards = page.locator('[data-testid=fifteen-card]');
  assert.equal(await cards.count(), 4);
  assert.deepEqual((await cards.evaluateAll((cs) => cs.map((x) => x.dataset.underlying))).sort(), ['H100', 'KOLA', 'ORB', 'PLX']);
  for (let i = 0; i < 4; i++) {
    const t = await cards.nth(i).textContent();
    assert.match(t, /Target ₦[\d,.]+/);
    const up = Number(/Above · (\d+)%/.exec(t)[1]); const down = Number(/Below · (\d+)%/.exec(t)[1]);
    assert.equal(up + down, 100);
  }
  // Dismiss the onboarding card: stored, still gone after a reload.
  await page.click('[data-testid=onboarding-dismiss]');
  await page.waitForSelector('[data-testid=onboarding-card]', { state: 'detached' });
  await eventually(() => q1("SELECT value FROM user_settings WHERE user_id=? AND key='home_onboarding_dismissed'", uid)?.value === 'true', { msg: 'dismissal stored' });
  // Customize your view: Trader is stored, Settings shows it, the home address opens Pro, the ticket starts on limit.
  await page.click('[data-testid=view-trader]');
  await page.waitForSelector('[data-testid=view-trader][aria-checked=true]');
  await eventually(() => q1("SELECT value FROM user_settings WHERE user_id=? AND key='view_mode'", uid)?.value === '"trader"', { msg: 'view mode stored' });
  await page.goto(BASE + '/account/settings');
  await page.waitForSelector('[data-testid=view_mode-trader]');
  assert.ok(await page.isChecked('[data-testid=view_mode-trader]'));
  await page.goto(BASE + '/');
  await page.waitForURL(BASE + '/pro');
  await page.goto(BASE + '/markets/plxrate/central-bank-decision/plxrate-26dec');
  await page.waitForSelector('#t-mode-btn');
  assert.match(await page.textContent('#t-mode-btn'), /Limit/i, 'Trader mode: the ticket starts on limit orders');
  // Back to Prediction in Settings: the home again; dismiss the Customize card (stored).
  await page.goto(BASE + '/account/settings');
  await page.check('[data-testid=view_mode-prediction]');
  await eventually(() => q1("SELECT value FROM user_settings WHERE user_id=? AND key='view_mode'", uid)?.value === '"prediction"', { msg: 'prediction stored' });
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=customize-card] [data-testid=view-prediction][aria-checked=true]');
  assert.equal(await page.locator('[data-testid=onboarding-card]').count(), 0, 'the dismissal holds');
  await page.click('[data-testid=customize-dismiss]');
  await page.waitForSelector('[data-testid=customize-card]', { state: 'detached' });
  await page.reload();
  await page.waitForSelector('[data-testid=fifteen-card]');
  assert.equal(await page.locator('[data-testid=customize-card]').count(), 0);
  // Owner switches for the member home cards (live).
  await setOwner('layout.member_fifteen_min', false);
  await page.waitForSelector('[data-testid=fifteen-min]', { state: 'detached', timeout: 15000 });
  await setOwner('layout.member_fifteen_min', true);
  assert.deepEqual(page.errors, []);
  // 390 px.
  const phone = await newPage({ width: 390, height: 844 });
  await uiLogIn(phone, u);
  await phone.goto(BASE + '/');
  await phone.waitForSelector('[data-testid=fifteen-card]');
  assert.ok(await noOverflow(phone), 'member home at 390 px: no horizontal scroll');
  assert.deepEqual(phone.errors, []);
  await Promise.all([page, phone].map((p) => p.context().close()));
  await setOwner('layout.home_members', 'classic');
});
