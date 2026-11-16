#!/usr/bin/env node
'use strict';
// Help Center screenshots (CLONE_SPEC.md §40): `npm run help:screenshots` starts Parlance on a temporary database,
// walks each guide's flow in Chromium as a new member (sign-up, deposit, a trade, a limit order, selling, settings) and
// saves the screenshots the guides show to public/help-img/<name>.jpg. Run it after a screen changes; the guides keep
// their image paths. Invented data only; nothing leaves the machine.
//   npm run help:screenshots                 all screenshots
//   npm run help:screenshots -- ticket-buy   only the named ones
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');

const OUT = path.join(__dirname, '..', 'public', 'help-img');
const EVENT = '/markets/plxstate/harbor-state-elections/plxstate-26sen';
const PW = 'Kaduna-Basalt-Ferry-2083';
const HIGH = { burst: 1e6, per_second: 1e6 };

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const want = (n) => !only.length || only.includes(n);
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-help-shots-'));
  // Seeded like `npm start` (elections hub, hubs), so the screens show what members see.
  const srv = await start({ port: 0, dbFile: path.join(tmp, 'h.db'), quiet: true, sports: false, tickMs: 1000, elections: { seed: true }, marketsContent: { seedHubs: true }, admin: { email: `root.${Date.now()}@example.test`, password: PW }, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } });
  const BASE = `http://127.0.0.1:${srv.port}`;
  const browser = await chromium.launch();
  const saved = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const settle = async () => { await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(400); };
    // Screenshot of an element (padded), or of the top of the page view when no selector is given.
    const shot = async (name, sel, { pad = 12, maxH = 760 } = {}) => {
      if (!want(name)) return;
      await settle();
      let box;
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove())); // no stray notices in the picture
      // The sticky header and category strip: keep the captured element below them.
      const top = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('header, .cat-strip, .site-banner')].map((h) => { const st = getComputedStyle(h).position; const r = h.getBoundingClientRect(); return st === 'sticky' || st === 'fixed' ? r.bottom : 0; })));
      if (sel) {
        const loc = page.locator(sel).first(); await loc.waitFor({ state: 'visible', timeout: 15000 });
        await loc.evaluate((el, off) => { const r = el.getBoundingClientRect(); if (r.top < off + 16 || r.bottom > window.innerHeight) window.scrollBy(0, r.top - off - 16); }, top); // only when not fully in view
        await page.waitForTimeout(200);
        box = await loc.boundingBox();
      } else box = await page.locator('#view').boundingBox();
      if (box.y < top + pad) { const cut = top + pad - box.y; box = { ...box, y: box.y + cut, height: box.height - cut }; }
      const vp = page.viewportSize();
      const x = Math.max(0, box.x - pad); const y = Math.max(0, box.y - pad);
      const clip = { x, y, width: Math.min(vp.width - x, box.width + pad * 2), height: Math.min(maxH, vp.height - y, box.height + pad * 2) };
      await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 78, clip });
      saved.push(name);
    };
    const go = async (p) => { await page.goto(BASE + p); await settle(); };

    await go('/sign-up');
    await page.fill('input[name=display_name]', 'Ada Okafor');
    await page.fill('input[name=email]', `ada.${Date.now()}@example.test`);
    await shot('sign-up', 'form:has(input[name=display_name])', { pad: 24 });
    await page.fill('input[name=password]', PW);
    await page.click('button[type=submit]');
    await page.waitForSelector('[data-testid=account-menu]');

    await go('/sign-up/identity');
    await shot('identity-phone', null, { maxH: 620 });

    await go('/browse');
    await page.waitForSelector('#results [data-testid=event-card]');
    await shot('browse', null, { maxH: 640 });

    // Funds: the deposit and withdraw method pickers, then demo funds for the trades below.
    await go('/funds/deposit');
    await shot('deposit', null, { maxH: 620 });
    await go('/funds/withdraw');
    await shot('withdraw', null, { maxH: 620 });
    await go('/portfolio');
    await page.fill('#f-amount', '50000');
    await page.click('[data-act=deposit]');
    await page.waitForSelector('[data-testid=header-balance]:has-text("₦50,000")');

    // The trade ticket: buy, limit order, then sell what was bought.
    // The alert card sits under the sticky ticket: a tall window shows both without scrolling.
    await page.setViewportSize({ width: 1280, height: 1600 });
    await go(EVENT);
    await shot('price-alert', '[data-testid=alert-card]');
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForSelector('#t-amount');
    await page.fill('#t-amount', '2000');
    await shot('ticket-buy', '#ticket');
    await page.click('[data-testid=submit-order]');
    await page.click('[data-testid=review-confirm]');
    await page.waitForSelector('.toast:has-text("Filled")');
    await page.click('#t-mode-btn'); await page.click('[data-otype=limit]');
    await shot('ticket-limit', '#ticket');
    await page.click('#t-mode-btn'); await page.click('[data-otype=dollars]').catch(async () => { await page.keyboard.press('Escape'); });
    // The ticket's mode menu with the 1-Click switch (guide: one-click-trading).
    await page.click('#t-mode-btn');
    await page.waitForSelector('[data-testid=one-click-toggle]', { timeout: 10000 }).catch(() => {});
    await shot('one-click-menu', '#ticket');
    await page.keyboard.press('Escape');
    await page.click('[data-testid=sell-tab]');
    await page.waitForSelector('[data-testid=held]');
    await shot('ticket-sell', '#ticket');

    await go('/portfolio');
    await shot('portfolio', null, { maxH: 560 });
    await go('/account');
    await shot('account-security', null, { maxH: 700 });
    await go('/account/limits');
    await shot('limits', null, { maxH: 640 });
    await go('/account/settings');
    await page.locator('h2:has-text("Notifications"), h3:has-text("Notifications")').first().scrollIntoViewIfNeeded();
    await shot('notification-settings', 'section:has(> h2:has-text("Notifications")), .card:has(h2:has-text("Notifications"))', { maxH: 640 });
    await go('/account/privacy');
    await shot('privacy', null, { maxH: 720 });
    await go('/account/taxes');
    await shot('documents', null, { maxH: 520 });
    await go('/rewards');
    await shot('rewards', null, { maxH: 680 });
    // New pages of 2026-11-15 (guides: browse-a-category, use-the-pro-terminal).
    await go('/category/economics');
    await shot('category-page', null, { maxH: 700 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await go('/pro');
    await page.waitForSelector('[data-testid=pro-terminal]', { timeout: 20000 }).catch(() => {});
    await shot('pro-terminal', null, { maxH: 820 });
    await page.setViewportSize({ width: 1280, height: 860 });
    await go('/category/elections/nigeria-2027');
    await page.waitForSelector('[data-testid=elections-hub], [data-testid=el-hub], .el-hub', { timeout: 20000 }).catch(() => {});
    await shot('elections', null, { maxH: 680 });
    if (errors.length) console.warn('page errors while capturing:', errors);
  } finally {
    await browser.close();
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const n of saved) console.log(`public/help-img/${n}.jpg  ${(fs.statSync(path.join(OUT, `${n}.jpg`)).size / 1024).toFixed(0)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
