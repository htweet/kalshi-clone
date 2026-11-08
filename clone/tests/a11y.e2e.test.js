'use strict';
// Accessibility, WCAG 2.2 AA (PLAN P8.5, CLONE_SPEC.md §38.6), real server + SQLite + Chromium:
//   • axe-core on the key pages, signed out and signed in, light and dark, at 1280 and 390 px: no violations of the
//     WCAG 2.0/2.1/2.2 A and AA rules (contrast and 24 px target size included);
//   • keyboard paths with a visible focus indicator at every stop: skip link, a demo deposit, a trade through the ticket
//     and review, a setting in Account › Settings;
//   • text alternatives: charts, the elections map (each tile named by its code and state; Enter pins it), gauges, the
//     seat bar; the ratings strip is a focusable, named region;
//   • reduced motion: no CSS animation runs and scripted scrolling is instant when the device asks for it;
//   • admin-chosen party colours keep their text readable (light and dark colours alike);
//   • the accessibility statement is a CMS page reachable from the footer.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-a11y-'));
const DB_FILE = path.join(TMP, 'a11y.db');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const PW = 'Kano-Indigo-Lattice-5820';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
let BASE; let srv; let browser; let admin; let EV; let member; let memberApi;
const allPages = [];
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage({ width = 1280, theme = 'dark', ...ctxOpts } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, bypassCSP: true, ...ctxOpts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.addInitScript((t) => { try { localStorage.setItem('parlance-theme', t); } catch { /* storage blocked */ } }, theme);
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
const stepUp = (c) => async (method, p, body) => {
  let r = await c.call(method, p, body);
  if (r.code === 'step_up_required') { assert.equal((await c.call('POST', '/v1/step_up', { password: PW })).status, 200); r = await c.call(method, p, body); }
  return r;
};
// The page has rendered its view (not the server-rendered block) and settled.
async function settled(page) {
  await page.waitForFunction(() => { const m = document.querySelector('main#view'); return m && m.children.length && !m.querySelector(':scope > .ssr') && !m.querySelector('.skeleton'); }, null, { timeout: 20000 });
  await sleep(500);
}
async function axe(page, only = null) {
  if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(AXE);
  return page.evaluate(async ([tags, rules]) => {
    const r = await window.axe.run(document, rules ? { runOnly: { type: 'rule', values: rules } } : { runOnly: { type: 'tag', values: tags } });
    return { violations: r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => `${n.target.join(' ')} :: ${(n.failureSummary || '').split('\n').slice(1, 2).join('').trim()}`) })), passes: r.passes.map((v) => v.id) };
  }, [TAGS, only]);
}
// Where keyboard focus is, and whether it is visible (an outline or a ring; a visually hidden native switch shows it on
// the styled element next to it; a bare input inside a styled <label> field shows it on the label, :focus-within).
const focusInfo = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  // Read the settled style: a focus ring that fades in (a CSS transition) is jumped to its end first.
  const vis = (n) => { for (const a of n.getAnimations()) { try { a.finish(); } catch { /* infinite */ } } const cs = getComputedStyle(n); return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1) || (cs.boxShadow && cs.boxShadow !== 'none'); };
  const r = el.getBoundingClientRect();
  const hidden = r.width < 2 || r.height < 2 || getComputedStyle(el).opacity === '0';
  const field = el.matches('input, select, textarea') && el.closest('label');
  const ok = vis(el) || (hidden && el.nextElementSibling && vis(el.nextElementSibling)) || (field && field.matches(':focus-within') && vis(field));
  return { tag: el.tagName, testid: el.dataset?.testid || el.id || '', name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), ok };
});
// Tab forward until `selector` has focus; every stop on the way must show focus.
async function tabTo(page, selector, max = 250) {
  const bad = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const f = await focusInfo(page);
    if (f && !f.ok) bad.push(`${f.tag}[${f.testid}] "${f.name}"`);
    if (await page.evaluate((s) => !!document.activeElement && document.activeElement.matches(s), selector)) {
      assert.deepEqual(bad, [], `focus is visible at every stop before ${selector}`);
      return;
    }
  }
  throw new Error(`keyboard focus never reached ${selector} in ${max} Tab presses`);
}
// Keyboard users skip the header: Tab to the skip link, Enter moves focus into <main>.
async function skipToContent(page) {
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip-link');
  assert.ok((await focusInfo(page)).ok);
  assert.ok(await page.evaluate(() => document.activeElement.getBoundingClientRect().top >= 0), 'the skip link is on screen when focused');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'view');
}

before(async () => {
  srv = await start({ port: 0, dbFile: DB_FILE, tickMs: 300, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, elections: { seed: true } });
  BASE = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  member = { email: `ada.${stamp}@example.test` };
  memberApi = await new Client(BASE, 'ada').signUp(member.email, PW, 'Ada Keyboard');
  const ev = dbq("SELECT e.ticker, e.series_ticker, s.slug FROM events e JOIN series s ON s.ticker=e.series_ticker WHERE e.series_ticker NOT IN ('PLXCOMBO') AND e.series_ticker NOT LIKE 'PLXFLASH%' AND (SELECT COUNT(*) FROM markets m WHERE m.event_ticker=e.ticker AND m.status='active')=1 ORDER BY e.rowid LIMIT 1")[0];
  EV = `/markets/${ev.series_ticker.toLowerCase()}/${ev.slug}/${ev.ticker.toLowerCase()}`;
});
after(async () => {
  for (const p of allPages) { try { await p.context().close(); } catch { /* closed */ } }
  try { await browser?.close(); } catch { /* ignore */ }
  try { await srv?.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('axe: key pages signed out and signed in, light and dark, 1280 and 390 px — no WCAG 2.2 AA violations', async () => {
  const anon = ['/', '/browse', EV, '/category/elections/nigeria-2027', '/hubs/economics', '/sign-in', '/sign-up', '/waitlist', '/support/faq', '/support/accessibility'];
  const signed = ['/portfolio', '/funds', '/funds/deposit', '/account/settings', '/account/security', '/rewards'];
  const found = [];
  const ran = new Set();
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 390]) {
      for (const who of ['anon', 'member']) {
        // A signed-in member's theme is their saved preference (it follows them across devices).
        if (who === 'member') assert.equal((await memberApi.call('PUT', `/v1/users/${memberApi.user.user_id}/properties`, { properties: { theme } })).status, 200);
        const page = await newPage({ width, theme });
        if (who === 'member') await uiLogIn(page, member);
        for (const p of who === 'member' ? signed : anon) {
          await page.goto(BASE + p);
          await settled(page);
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme, `${p}: ${theme} theme applied`);
          const r = await axe(page);
          for (const id of r.passes) ran.add(id);
          for (const v of r.violations) for (const n of v.nodes) found.push(`${theme}/${width}/${who} ${p} ${v.id}: ${n}`);
        }
        assert.deepEqual(page.errors, []);
        await page.context().close();
      }
    }
  }
  assert.deepEqual(found, []);
  // The checks that matter most here actually ran (and passed) somewhere.
  for (const id of ['color-contrast', 'target-size', 'label', 'button-name', 'link-name', 'aria-allowed-attr', 'html-has-lang', 'document-title', 'svg-img-alt']) assert.ok(ran.has(id), `axe rule ${id} was evaluated`);
});

test('keyboard: skip link; a demo deposit, a trade through the ticket and review, and a setting — focus visible throughout', async () => {
  const page = await newPage({ width: 1280, theme: 'light' });
  await uiLogIn(page, member);
  const uid = dbq('SELECT id FROM users WHERE email=?', member.email)[0].id;
  // Funds: deposit demo money with the keyboard only.
  await page.goto(BASE + '/funds/deposit');
  await settled(page);
  await skipToContent(page);
  await tabTo(page, '[data-method=demo]');
  await page.keyboard.press('Enter');
  await tabTo(page, '[data-testid=fund-amount]');
  await page.keyboard.type('5000');
  await page.keyboard.press('Enter'); // submits the amount form
  await page.waitForSelector('[data-testid=fund-review]');
  await tabTo(page, '[data-testid=fund-confirm]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid=header-balance]:has-text("₦5,000")');
  assert.equal(dbq('SELECT balance_cents b FROM users WHERE id=?', uid)[0].b, 5000); // 1 internal cent = ₦1 (CLONE_SPEC.md §30)
  // Trading: the ticket and the review step, keyboard only.
  await page.goto(BASE + EV);
  await page.waitForSelector('[data-testid=submit-order]');
  await settled(page);
  await skipToContent(page);
  await tabTo(page, '#t-amount, #t-count');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(await page.evaluate(() => (document.activeElement.id === 't-count' ? '3' : '300')));
  await tabTo(page, '[data-testid=submit-order]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid=review-confirm]');
  if (!(await page.evaluate(() => document.activeElement?.dataset?.testid === 'review-confirm'))) await tabTo(page, '[data-testid=review-confirm]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast:has-text("Filled")', { timeout: 15000 });
  assert.ok(dbq('SELECT COUNT(*) c FROM positions WHERE user_id=? AND (yes_count + no_count) > 0', uid)[0].c >= 1, 'the trade filled');
  // Account settings: a switch toggled with Space.
  await page.goto(BASE + '/account/settings');
  await settled(page);
  await skipToContent(page);
  await tabTo(page, '[data-testid=toggle-data_saver]');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.documentElement.dataset.saver === '1', null, { timeout: 5000 });
  const reach = await page.evaluate(async (u) => (await fetch(`/v1/users/${u}/reach`, { credentials: 'same-origin' })).json(), uid);
  assert.equal(reach.reach.data_saver, true, 'the setting saved');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

// Regression (lead review; CI and a local full run): "Skip to content" is a #view link, and the router redrew the page on
// every history step, fragment-only ones included. A keyboard user who had started a deposit (or set a History filter)
// before the redraw landed lost it: the method picker came back. The skip link must move focus and keep the page as is.
test('skip to content keeps the page as it is: a half-filled deposit and its amount survive, focus lands in the main area', async () => {
  const page = await newPage({ width: 1280, theme: 'light' });
  await uiLogIn(page, member);
  await page.goto(BASE + '/funds/deposit');
  await settled(page);
  await page.click('[data-method=demo]');
  await page.fill('[data-testid=fund-amount]', '700');
  await page.evaluate(() => { window.__drawn = document.querySelector('[data-testid=fund-amount-form]'); });
  await page.focus('.skip-link');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'view');
  assert.ok(page.url().endsWith('/funds/deposit#view'));
  await sleep(1500); // a redraw, when it happened, landed well within this
  assert.equal(await page.evaluate(() => window.__drawn === document.querySelector('[data-testid=fund-amount-form]') && window.__drawn.isConnected), true, 'the amount step was not redrawn');
  assert.equal(await page.inputValue('[data-testid=fund-amount]'), '700');
  // Back and forward across real pages still re-render: the fragment step back is a no-op, the next one leaves.
  await page.goto(BASE + '/portfolio');
  await page.waitForSelector('[data-testid=portfolio], #panel');
  await page.goBack();
  await page.waitForSelector('[data-testid=funds][data-mode=deposit]');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('text alternatives: charts, the elections map (named tiles, Enter pins), gauges, the seat bar; the ratings strip is a focusable region', async () => {
  const page = await newPage({ width: 1280, theme: 'dark' });
  await page.goto(BASE + EV);
  await page.waitForSelector('[data-testid=chart-svg], svg.chart');
  const chart = await page.getAttribute('svg.chart[role=img]', 'aria-label');
  assert.match(chart, /\d/, `the chart is summarised in words and numbers: ${chart}`);
  await page.goto(BASE + '/category/elections/nigeria-2027');
  await page.waitForSelector('[data-testid=el-map-state]');
  const tiles = await page.$$eval('[data-testid=el-map-state]', (ns) => ns.map((n) => ({ code: n.dataset.code, label: n.getAttribute('aria-label'), role: n.getAttribute('role'), tab: n.getAttribute('tabindex') })));
  assert.ok(tiles.length >= 30);
  for (const t of tiles) {
    assert.equal(t.role, 'button'); assert.equal(t.tab, '0');
    assert.ok(t.label.startsWith(t.code), `the tile's name starts with its visible code: ${t.label}`);
    assert.match(t.label, /: .+, /, `name, then state: ${t.label}`);
  }
  // Keyboard: focus a tile and press Enter: its details are pinned (the tooltip stays after focus moves on).
  await page.focus('[data-testid=el-map-state]');
  const code = await page.evaluate(() => document.activeElement.dataset.code);
  await page.keyboard.press('Enter');
  await page.waitForSelector(`[data-testid=el-tip][data-code="${code}"]:not([hidden])`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=el-tip][hidden]', { state: 'attached' });
  await page.focus('[data-testid=el-map-state]');
  await page.keyboard.press(' ');
  await page.waitForSelector(`[data-testid=el-tip][data-code="${code}"]:not([hidden])`);
  // Gauges and the seat bar.
  const dials = await page.$$eval('[data-testid=el-gauge] svg[role=img]', (ns) => ns.map((n) => n.getAttribute('aria-label')));
  assert.ok(dials.length >= 1);
  for (const d of dials) assert.match(d, /\d+%/, `gauge text: ${d}`);
  const bars = await page.$$eval('.el-seatbar[role=img]', (ns) => ns.map((n) => n.getAttribute('aria-label')));
  for (const b of bars) assert.match(b, /[A-Z]{2,} \d/, `seat bar text: ${b}`);
  // The ratings strip scrolls sideways on a phone: it is a named region keyboard users can focus and scroll.
  const ratings = await page.$('[data-testid=el-ratings]');
  if (ratings) {
    assert.equal(await ratings.getAttribute('tabindex'), '0');
    assert.equal(await ratings.getAttribute('role'), 'region');
    assert.ok((await ratings.getAttribute('aria-label')).length > 3);
  }
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('reduced motion: no CSS animation runs and scripted scrolling is instant; without the preference both animate', async () => {
  const run = async (reducedMotion) => {
    const page = await newPage({ width: 1280, theme: 'dark', reducedMotion });
    await page.goto(BASE + '/');
    await page.waitForSelector('#up-next');
    await settled(page);
    const r = await page.evaluate(() => {
      const strip = document.getElementById('upcoming');
      const before = strip.scrollLeft;
      document.getElementById('up-next').click();
      const after = strip.scrollLeft; // read at once: an instant scroll has already moved, a smooth one has not
      // Elements (and their ::before / ::after boxes) with a CSS animation: the page fade, live pulses, shimmer.
      const animated = [];
      for (const el of document.querySelectorAll('*')) {
        for (const pseudo of [null, '::before', '::after']) {
          const name = getComputedStyle(el, pseudo).animationName;
          if (name && name !== 'none') animated.push(`${el.tagName.toLowerCase()}${pseudo || ''}:${name}`);
        }
      }
      const running = document.getAnimations().filter((a) => a.playState === 'running' && a.constructor.name === 'CSSAnimation').length;
      return { moved: after - before, animated, running, overflow: strip.scrollWidth > strip.clientWidth };
    });
    await page.context().close();
    return r;
  };
  const reduced = await run('reduce');
  const normal = await run('no-preference');
  assert.ok(reduced.overflow, 'the upcoming strip scrolls at 1280 px (the check is not vacuous)');
  assert.ok(reduced.moved > 0, `reduced motion: the strip jumped at once (${reduced.moved}px)`);
  assert.equal(normal.moved, 0, 'without the preference the strip scrolls smoothly (has not moved yet)');
  assert.deepEqual(reduced.animated, [], 'reduced motion: no element or pseudo-element has a CSS animation');
  assert.equal(reduced.running, 0, 'reduced motion: no CSS animation running');
  assert.ok(normal.animated.includes('main:fade-in'), `without the preference the page fades in (${normal.animated.join(',')})`);
});

test('admin-chosen party colours: text on a pale, a mid-tone and a dark colour stays readable (axe contrast, light and dark)', async () => {
  const parties = dbq("SELECT id FROM el_parties WHERE country='NG' AND active=1 ORDER BY sort, id LIMIT 3").map((r) => r.id);
  assert.equal(parties.length, 3);
  const colours = ['#ffe066', '#1c7ed6', '#2b2d42'];
  for (let i = 0; i < 3; i++) {
    const r = await stepUp(admin)('PUT', `/v1/admin/elections/parties/${parties[i]}`, { color: colours[i], reason: 'a11y contrast check' });
    assert.equal(r.status, 200, r.text);
  }
  for (const theme of ['light', 'dark']) {
    const page = await newPage({ width: 1280, theme });
    await page.goto(BASE + '/category/elections/nigeria-2027');
    await page.waitForSelector('[data-testid=el-map-state]');
    await settled(page);
    const r = await axe(page, ['color-contrast']);
    assert.deepEqual(r.violations, [], `${theme}: ${JSON.stringify(r.violations)}`);
    // The pale colour carries dark text, the others white.
    const chips = await page.$$eval('[data-party] .el-av-init, .el-av-init', (ns) => ns.map((n) => [getComputedStyle(n).backgroundColor, getComputedStyle(n).color]));
    assert.ok(chips.some(([bg, fg]) => bg === 'rgb(255, 224, 102)' && fg === 'rgb(13, 14, 17)') || !chips.some(([bg]) => bg === 'rgb(255, 224, 102)'), JSON.stringify(chips.slice(0, 6)));
    await page.context().close();
  }
});

// Regression (CI, lead review): the watch star on the home cards took its width from the star glyph, which differs by
// system font; on the CI runner it drew 22.3 px wide, under the 24 px minimum target of WCAG 2.2 (2.5.8). A narrow glyph
// is simulated here by drawing the star small; the button must still be at least 24 × 24 px.
test('watch stars on the home cards keep a 24 px target whatever font draws the star (narrow glyph simulated)', async () => {
  for (const width of [1280, 390]) {
    const page = await newPage({ width, theme: 'light' });
    await page.goto(BASE + '/');
    await page.waitForSelector('button[data-star]');
    await settled(page);
    const n = await page.$$eval('button.star-btn', (els) => { for (const el of els) el.style.setProperty('font-size', '10px'); return els.length; });
    assert.ok(n > 0, 'stars on the home page');
    const small = await page.$$eval('button.star-btn', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.star, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; }).filter(([, w, h]) => w < 24 || h < 24));
    assert.deepEqual(small, [], `${width}: every star at least 24 × 24 px`);
    const r = await axe(page, ['target-size']);
    assert.deepEqual(r.violations, [], `${width}: ${JSON.stringify(r.violations)}`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});

test('the accessibility statement is a CMS page linked from the footer', async () => {
  const page = await newPage({ width: 390, theme: 'light' });
  await page.goto(BASE + '/');
  await settled(page);
  await page.click('footer a[href="/support/accessibility"]');
  await page.waitForSelector('[data-testid=cms-page] h2:has-text("Our commitment")');
  assert.match(await page.textContent('[data-testid=cms-page]'), /WCAG\) 2\.2 at level AA/);
  assert.match(await page.textContent('[data-testid=cms-page]'), /Report a barrier/);
  assert.match(await page.title(), /Accessibility/);
  // An admin edit shows up for visitors (it is CMS content, not code).
  const draft = await stepUp(admin)('PUT', '/v1/admin/cms/page/draft', { key: 'support/accessibility', value: { title: 'Accessibility statement', section: 'info', body: '<h2>Our commitment</h2><p>Reviewed November 2026.</p>' } });
  assert.equal(draft.status, 200, draft.text);
  const pub = await stepUp(admin)('POST', '/v1/admin/cms/page/publish', { key: 'support/accessibility', reason: 'a11y statement review' });
  assert.equal(pub.status, 200, pub.text);
  await page.goto(BASE + '/support/accessibility');
  await page.waitForSelector('[data-testid=cms-page] p:has-text("Reviewed November 2026.")');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
