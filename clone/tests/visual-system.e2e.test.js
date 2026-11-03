'use strict';
// Visual system (CLONE_SPEC §27): token enforcement over every stylesheet, plus browser layout assertions at 1280 and
// 390 px in the dark and light themes — event header (title width, no overlap with the action bar), phone hero and
// header, portfolio stat cards, one page-title style, focus rings, tabular numerals, and no horizontal overflow, page
// errors or CSP violations on the audited pages. Real server + SQLite file + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');
const { freePort } = require('./lib/identity-helpers.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-visual-'));
const DB_FILE = path.join(TMP, 'visual.db');
const DEMO_PW = 'Copper-Meadow-Signal-73'; // demo accounts have no default password (start({ demoPassword }))
const DEMO = 'maple_quant@parlance.local';
const ADMIN = { email: 'ui-review@parlance.local', password: DEMO_PW };
let srv; let browser; let BASE; let EVENT_URL;

// ------------------------------------------------------------------ static token checks
// Literal values that are allowed outside the token block. Each entry needs a reason; keep this list short.
//   key: "<file> <selector> <property>"
const ALLOW = new Map([
  // (none) — every font-size, font-weight and letter-spacing in public/*.css reads a token.
]);
const SPACE_PX = new Set([0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64]);
const SPACING_PROPS = /^(margin|padding)(-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?$|^(gap|row-gap|column-gap|grid-gap)$/;

function cssRules(src) {
  const masked = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const out = []; const stack = []; let last = 0; const re = /[{}]/g; let m;
  while ((m = re.exec(masked))) {
    const seg = masked.slice(last, m.index);
    if (m[0] === '{') stack.push(seg.trim());
    else {
      const sel = stack.pop() || '';
      const decls = seg.split(/;(?![^(]*\))/).map((d) => /^\s*([a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i.exec(d)).filter(Boolean).map((x) => ({ prop: x[1].toLowerCase(), value: x[2] }));
      if (decls.length) out.push({ sel, atFontFace: /^@font-face/.test(sel), decls });
    }
    last = re.lastIndex;
  }
  return out;
}

test('tokens: every stylesheet uses the type, weight, tracking and spacing scales; the token script is a no-op', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.css'), 'utf8');
  // The scale itself: paired line heights, four weights, a 4px spacing grid with 2/6 half steps, control heights.
  const root = cssRules(app).find((r) => r.sel === ':root' && r.decls.some((d) => d.prop === '--fs-md'));
  assert.ok(root, ':root token block');
  const tok = Object.fromEntries(root.decls.map((d) => [d.prop, d.value]));
  const sizes = Object.keys(tok).filter((k) => k.startsWith('--fs-'));
  assert.ok(sizes.length >= 9 && sizes.length <= 12, `type steps: ${sizes}`);
  for (const k of sizes) assert.ok(tok[k.replace('--fs-', '--lh-')], `${k} has a paired line height`);
  assert.equal(tok['--fs-md'], '14px'); assert.equal(tok['--lh-md'], '20px');
  assert.deepEqual(Object.keys(tok).filter((k) => k.startsWith('--fw-')).map((k) => tok[k]), ['400', '500', '600', '700']);
  for (const k of Object.keys(tok).filter((k) => k.startsWith('--space-'))) {
    const px = Number(tok[k].replace('px', '')); assert.ok(px % 4 === 0 || px === 2 || px === 6, `${k}=${tok[k]} on the 4px grid`);
  }
  assert.deepEqual(['--control-sm', '--control-md', '--control-lg'].map((k) => tok[k]), ['32px', '40px', '48px']);

  const problems = [];
  for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.css'))) {
    for (const r of cssRules(fs.readFileSync(path.join(PUBLIC, file), 'utf8'))) {
      if (r.atFontFace) continue; // @font-face descriptors (font-weight: 100 900) describe the font files
      for (const { prop, value } of r.decls) {
        if (prop.startsWith('--')) continue; // token definitions
        const v = value.replace(/\s*!important$/, '');
        const where = `${file} ${r.sel} ${prop}`;
        if (ALLOW.has(where)) continue;
        const bad = (why) => problems.push(`${where}: ${value} (${why})`);
        if (prop === 'font-size' && !/^(var\(--fs-[a-z0-9]+\)|inherit)$/.test(v)) bad('font-size must be a --fs-* token');
        if (prop === 'font-weight' && !/^(var\(--fw-(regular|medium|semibold|bold)\)|inherit)$/.test(v)) bad('font-weight must be a --fw-* token');
        if (prop === 'font' && v !== 'inherit' && (/\d+(\.\d+)?(px|em|rem)/.test(v.replace(/var\([^)]*\)/g, '')) || /(^|\s)\d{3}\s/.test(v))) bad('font shorthand with literal size/weight');
        if (prop === 'letter-spacing' && !/^(var\(--ls-[a-z]+\)|inherit|normal)$/.test(v)) bad('letter-spacing must be a --ls-* token');
        if (SPACING_PROPS.test(prop)) {
          for (const lit of v.replace(/var\([^)]*\)/g, '').matchAll(/(-?\d*\.?\d+)(px|rem|em)\b/g)) {
            const n = Math.abs(Number(lit[1]));
            // ±1px is allowed on margins only: hairline border compensation (tab underline, sup nudge).
            if (lit[2] !== 'px' || !(SPACE_PX.has(n) || (n === 1 && prop.startsWith('margin')))) bad(`spacing literal ${lit[0]} is off the scale`);
          }
        }
        // The display face is for display headlines only: never on body-size text.
        if (prop === 'font-family' && /--font-display/.test(v)) {
          const fs2 = r.decls.find((d) => d.prop === 'font-size');
          if (fs2 && /--fs-(3xs|2xs|xs|sm|md)\)/.test(fs2.value)) bad('display face below 16px');
        }
      }
    }
  }
  assert.deepEqual(problems, [], `literal values outside the token scale:\n${problems.join('\n')}`);
  // Utility class names in views (mt-14, fs-17, …) and CSS literals are already on the scale: the rewrite is a no-op.
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'apply-type-tokens.js'), '--check'], { encoding: 'utf8' });
  assert.match(out, /would change 0 file/);
});

// ------------------------------------------------------------------ browser checks
before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  srv = await start({ port, dbFile: DB_FILE, tickMs: 500, quiet: true, demoPassword: DEMO_PW, admin: ADMIN, sports: {} });
  browser = await chromium.launch();
  const p = await page0({ width: 1280, height: 900 });
  await p.goto(BASE + '/');
  await p.waitForSelector('[data-testid=hero-title]');
  EVENT_URL = await p.locator('#hero a[href^="/markets/"]').first().getAttribute('href');
  await p.context().close();
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const VIEWPORTS = { desk: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
async function page0(viewport, theme = 'dark') {
  const ctx = await browser.newContext({ viewport, colorScheme: theme });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.theme = theme;
  return page;
}
async function session(viewport, theme, email) {
  const page = await page0(viewport, theme);
  if (email) {
    await page.goto(BASE + '/sign-in');
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', DEMO_PW);
    await page.click('button[type=submit]');
    await page.waitForSelector('[data-testid=account-menu]');
  }
  return page;
}
async function go(page, url, ready) {
  await page.goto(BASE + url);
  if (ready) await page.waitForSelector(ready);
  await page.waitForLoadState('networkidle').catch(() => {});
  // The theme preference is applied by the app after boot; force the theme under test and let transitions settle.
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, page.theme);
  await page.waitForTimeout(250);
}
const box = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
const overlap = (a, b) => a && b && a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5;
async function clean(page, label) {
  assert.deepEqual(page.errors, [], `${label}: no page errors`);
  assert.deepEqual(await page.evaluate(() => window.__csp || []), [], `${label}: no CSP violations`);
}

test('event header: title takes the main column, the action bar has its own row; 1280 and 390, dark and light', async () => {
  for (const theme of ['dark', 'light']) {
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      const page = await session(size, theme, DEMO);
      await go(page, EVENT_URL, '[data-testid=event-title]');
      await page.waitForSelector('.ev-actions [data-testid=follow-event]');
      const title = await box(page, '[data-testid=event-title]');
      const main = await box(page, '.ev-layout > .minw-0');
      const crumbs = await box(page, '.ev-header .crumbs');
      const actions = await box(page, '.ev-actions');
      if (vp === 'desk') assert.ok(title.w >= main.w * 0.5, `${theme} ${vp}: title ${title.w}px of a ${main.w}px column`);
      assert.ok(!overlap(crumbs, actions), `${theme} ${vp}: series label and action bar do not overlap`);
      assert.ok(!overlap(title, actions), `${theme} ${vp}: title and action bar do not overlap`);
      assert.ok(actions.y >= title.b - 1, `${theme} ${vp}: action bar sits below the title`);
      // Every action button lies inside the bar and no two overlap; on phones the bar is two tidy rows at most.
      const btns = await page.$$eval('.ev-actions > *', (els) => els.filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }));
      for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) assert.ok(!overlap(btns[i], btns[j]), `${theme} ${vp}: action buttons ${i} and ${j} overlap`);
      const rows = new Set(btns.map((b) => Math.round(b.y)));
      assert.ok(rows.size <= (vp === 'desk' ? 1 : 2), `${theme} ${vp}: ${rows.size} action rows ${JSON.stringify(btns)}`);
      if (vp === 'phone' && rows.size === 2) {
        const last = btns.filter((b) => Math.round(b.y) === Math.max(...rows));
        const span = Math.max(...last.map((b) => b.r)) - Math.min(...last.map((b) => b.x));
        assert.ok(span >= actions.w - 2, `${theme} ${vp}: the second action row is filled edge to edge (${span} of ${actions.w})`);
      }
      await clean(page, `event ${theme} ${vp}`);
      await page.context().close();
    }
  }
});

test('home + header: phone hero stacks with non-overlapping table headers, phone brand and search stay usable', async () => {
  for (const theme of ['dark', 'light']) {
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      const page = await session(size, theme, vp === 'phone' && theme === 'light' ? DEMO : null);
      await go(page, '/', '[data-testid=hero-title]');
      const hero = await box(page, '#hero');
      const title = await box(page, '[data-testid=hero-title]');
      const heads = await page.$$eval('.hero-table .h', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }));
      assert.equal(heads.length, 3);
      for (let i = 0; i < heads.length; i++) for (let j = i + 1; j < heads.length; j++) assert.ok(!overlap(heads[i], heads[j]), `${theme} ${vp}: hero headers ${i}/${j} overlap`);
      assert.ok(heads[0].r <= heads[1].x && heads[1].r <= heads[2].x, `${theme} ${vp}: Market · Pays out · Odds in order`);
      const brand = await box(page, '.topbar .brand');
      assert.ok(await page.locator('.topbar .brand').isVisible() && brand.w >= 60 && brand.x >= 0 && brand.r <= size.width, `${theme} ${vp}: brand visible (${JSON.stringify(brand)})`);
      if (vp === 'phone') {
        assert.ok(title.w >= hero.w * 0.8, `${theme}: phone hero is one column (${title.w} of ${hero.w})`);
        const chart = await box(page, '#hero-chart');
        assert.ok(chart.y >= title.b, `${theme}: chart stacks below the title`);
        // Search collapses to an icon button and expands over the header row when focused.
        const s0 = await box(page, '#search-input');
        assert.ok(s0.w >= 32 && s0.w <= 48, `${theme}: search icon button ${s0.w}px`);
        await page.click('#search-input');
        await page.waitForTimeout(100);
        const s1 = await box(page, '#search-input');
        assert.ok(s1.w >= size.width - 40, `${theme}: focused search spans the row (${s1.w}px)`);
        await page.fill('#search-input', 'harbor');
        await page.press('#search-input', 'Enter');
        await page.waitForURL(/\/search\?q=harbor/);
      } else {
        assert.ok(title.w < hero.w * 0.6, 'desktop hero keeps the chart beside the title');
      }
      await clean(page, `home ${theme} ${vp}`);
      await page.context().close();
    }
  }
});

test('portfolio stat cards hug their content; one page-title style across Browse, Portfolio, Perps, Settings, Leaderboard, Social', async () => {
  for (const theme of ['dark', 'light']) {
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      const page = await session(size, theme, DEMO);
      await go(page, '/portfolio', '[data-testid=cash]');
      const cards = await page.$$eval('.stat-row > .stat', (els) => els.map((e) => {
        const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
        const kids = [...e.children].filter((k) => k.offsetParent || getComputedStyle(k).display !== 'none').map((k) => k.getBoundingClientRect()).filter((k) => k.height > 0);
        const content = Math.max(...kids.map((k) => k.bottom)) - Math.min(...kids.map((k) => k.top));
        return { h: r.height, natural: content + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) };
      }));
      assert.equal(cards.length, 4);
      for (const c of cards) assert.ok(c.h <= c.natural + 2, `${theme} ${vp}: stat card ${c.h}px for ${c.natural}px of content`);
      // Tab bar: trailing actions share the tab row and sit inside it.
      const tabs = await box(page, '#pf-tabs');
      const csv = await box(page, '[data-testid=csv-link]');
      const tab = await box(page, '#pf-tabs button');
      if (vp === 'desk') assert.ok(Math.abs((csv.y + csv.h / 2) - (tab.y + tab.h / 2)) <= 2 && csv.b <= tabs.b, `${theme}: Export CSV on the tab row`);
      // The Sort control is a styled select, not the native widget.
      await page.waitForSelector('[data-testid=pos-sort]');
      const sel = await page.$eval('[data-testid=pos-sort]', (e) => { const cs = getComputedStyle(e); return { app: cs.appearance, h: e.getBoundingClientRect().height, img: cs.backgroundImage }; });
      assert.equal(sel.app, 'none'); assert.equal(sel.h, 32); assert.match(sel.img, /gradient/);

      const styles = {};
      for (const [name, url, sel2] of [['browse', '/browse', 'h1.page-title'], ['portfolio', '/portfolio', '.page-head h1'], ['perps', '/perps', '.perps-hero h1'],
        ['settings', '/account/settings', '[data-testid=account-title]'], ['leaderboard', '/social/leaderboard', '.page-head h1'], ['social', '/social', '.page-head h1']]) {
        await go(page, url, sel2);
        styles[name] = await page.$eval(sel2, (e) => { const cs = getComputedStyle(e); return `${cs.fontFamily} | ${cs.fontSize} | ${cs.fontWeight} | ${cs.lineHeight}`; });
      }
      const distinct = new Set(Object.values(styles));
      assert.equal(distinct.size, 1, `${theme} ${vp}: page titles differ: ${JSON.stringify(styles, null, 1)}`);
      assert.match([...distinct][0], /Barlow Condensed/);
      await clean(page, `portfolio/titles ${theme} ${vp}`);
      await page.context().close();
    }
  }
});

test('controls: visible focus rings, tabular numerals on prices and money, buttons on the control heights', async () => {
  const page = await session(VIEWPORTS.desk, 'dark', DEMO);
  await go(page, '/browse', '#results [data-testid=event-card] .odds');
  const nums = await page.$$eval('#results .odds, #results .mult, [data-testid=header-balance]', (els) => els.map((e) => getComputedStyle(e).fontVariantNumeric));
  assert.ok(nums.length > 5 && nums.every((v) => /tabular-nums/.test(v)), `tabular numerals: ${[...new Set(nums)]}`);
  await go(page, EVENT_URL, '[data-testid=submit-order]');
  for (const sel of ['[data-testid=chart-prob]', '.mkt-table .prob', '.payout', '.yes-btn']) {
    assert.match(await page.$eval(sel, (e) => getComputedStyle(e).fontVariantNumeric), /tabular-nums/, sel);
  }
  // Keyboard focus shows a ring (outline) on buttons, links and the trade input.
  await page.focus('[data-testid=watch-btn]');
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, style: cs.outlineStyle, w: cs.outlineWidth }; });
  assert.equal(ring.style, 'solid', `focus ring on ${ring.tag}`);
  assert.equal(ring.w, '2px');
  const heights = await page.$$eval('.btn:not(.btn-sm):not(.btn-lg)', (els) => [...new Set(els.filter((e) => e.offsetParent && !e.closest('.ev-actions, form.stat')).map((e) => Math.round(e.getBoundingClientRect().height)))]);
  assert.ok(heights.every((h) => [32, 40, 48].includes(h)), `button heights ${heights}`);
  await clean(page, 'controls');
  await page.context().close();
});

test('no horizontal overflow, page errors or CSP violations on the audited pages at 1280 and 390, dark and light', async () => {
  const pages = [['/', null, '[data-testid=hero-title]'], ['/browse', null, '#results'], [EVENT_URL, DEMO, '[data-testid=event-title]'], ['/live', null, '[data-testid=live-title]'],
    ['/calendar', null, '[data-testid=live-title]'], ['/perps', DEMO, '.perps-hero'], ['/combos', DEMO, '[data-testid=combos-title]'], ['/sports', null, '[data-testid=hub-title]'],
    ['/social', DEMO, '.page-head h1'], ['/social/leaderboard', null, '[data-testid=leaderboard]'], ['/portfolio', DEMO, '[data-testid=cash]'], ['/account', DEMO, '[data-testid=account-title]'],
    ['/account/settings', DEMO, '[data-testid=settings]'], ['/admin', ADMIN.email, '.adm'], ['/sign-in', null, 'form'], ['/sign-up', null, 'form']];
  for (const theme of ['dark', 'light']) {
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      const sessions = {};
      for (const [url, who, ready] of pages) {
        const key = who || 'anon';
        if (!sessions[key]) sessions[key] = await (who === ADMIN.email ? adminSession(size, theme) : session(size, theme, who));
        const page = sessions[key];
        await go(page, url, ready);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(over <= 0, `${theme} ${vp} ${url}: overflows by ${over}px`);
        await clean(page, `${theme} ${vp} ${url}`);
      }
      for (const p of Object.values(sessions)) await p.context().close();
    }
  }
});

async function adminSession(viewport, theme) {
  const page = await page0(viewport, theme);
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', ADMIN.email);
  await page.fill('input[name=password]', ADMIN.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
  return page;
}

test('brand colour: Nigerian green in both themes (wordmark, primary button, outline button, favicon); no purple brand left', async () => {
  const want = { dark: 'rgb(19, 168, 102)', light: 'rgb(0, 135, 81)' }; // #13a866 (dark, contrast-lifted) · #008751 (flag green)
  for (const theme of ['dark', 'light']) {
    const page = await page0(VIEWPORTS.desk, theme);
    await go(page, '/', '[data-testid=hero-title]');
    const c = await page.evaluate(() => {
      const css = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
      return {
        token: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
        wordmark: css('.brand-name', 'color'),
        primary: css('#account-area .btn-primary', 'backgroundColor'),
        outline: css('#account-area .btn-outline-brand', 'color'),
        favicon: decodeURIComponent(document.querySelector('link[rel=icon]').getAttribute('href')),
      };
    });
    assert.equal(c.token, theme === 'dark' ? '#13a866' : '#008751', `${theme}: --brand token`);
    assert.equal(c.wordmark, want[theme], `${theme}: wordmark`);
    assert.equal(c.primary, want[theme], `${theme}: primary button`);
    assert.equal(c.outline, want[theme], `${theme}: outline button text`);
    assert.match(c.favicon, /fill='#008751'/, 'favicon uses the brand green');
    await clean(page, `brand ${theme}`);
    await page.context().close();
  }
  // The old purple brand values are gone from every stylesheet and the page shell.
  for (const f of [...fs.readdirSync(PUBLIC).filter((x) => x.endsWith('.css')), 'index.html']) {
    assert.doesNotMatch(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), /#8f7fff|#5a48f0|#4b3fe0|#221d4a|#ecebfd/i, `${f}: no purple brand values`);
  }
});
