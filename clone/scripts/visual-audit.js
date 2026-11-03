// Visual audit: screenshots of the main pages (desktop + phone, dark + light) on a throwaway database.
const path = require('node:path');
const fs = require('node:fs');
// PWD keeps a symlinked checkout path (run with --preserve-symlinks when the real path has a dot-directory).
const ROOT = process.env.PWD && require('node:fs').existsSync(path.join(process.env.PWD, 'server')) ? process.env.PWD : process.cwd();
const { chromium } = require(require.resolve('playwright', { paths: [ROOT] }));
const { start } = require(path.join(ROOT, 'server', 'index.js'));
const OUT = process.argv[2]; const TAG = process.argv[3] || 'before';
const PW = 'Tidal-Lantern-Quartz-58'; // secret-scan:allow throwaway local audit password
(async () => {
  const dbFile = path.join(OUT, `audit-${TAG}-${Date.now()}.db`);
  const srv = await start({ port: 0, dbFile, quiet: true, demoPassword: PW, admin: { email: 'review-admin@parlance.local', password: PW }, sports: {} });
  const base = `http://127.0.0.1:${srv.port}`;
  const b = await chromium.launch();
  async function session(email, viewport, theme) {
    const ctx = await b.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme });
    const p = await ctx.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message));
    if (email) {
      await p.goto(base + '/sign-in'); await p.fill('input[name=email]', email); await p.fill('input[name=password]', PW);
      await p.click('button[type=submit]'); await p.waitForURL((u) => !/sign-in/.test(u.pathname), { timeout: 15000 }).catch(() => {});
    }
    if (theme === 'light') await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    return { ctx, p };
  }
  await (await b.newContext()).newPage(); // warm
  const probe = await session(null, { width: 1280, height: 900 }, 'dark');
  await probe.p.goto(base + '/'); await probe.p.waitForSelector('[data-testid=hero-title]');
  const eventHref = await probe.p.locator('#view a[href^="/markets/"]').first().getAttribute('href');
  await probe.ctx.close();
  const pages = [
    ['home', '/', null], ['browse', '/browse', null], ['event', eventHref, 'maple_quant@parlance.local'], ['live', '/live', null], ['calendar', '/calendar', null],
    ['perps', '/perps', 'maple_quant@parlance.local'], ['combos', '/combos', 'maple_quant@parlance.local'], ['sports', '/sports', null], ['social', '/social', 'maple_quant@parlance.local'],
    ['leaderboard', '/social/leaderboard', null], ['portfolio', '/portfolio', 'maple_quant@parlance.local'], ['account', '/account', 'maple_quant@parlance.local'],
    ['settings', '/account/settings', 'maple_quant@parlance.local'], ['admin', '/admin', 'review-admin@parlance.local'], ['signin', '/sign-in', null], ['signup', '/sign-up', null],
  ];
  const combos = [['desk', { width: 1280, height: 900 }, 'dark'], ['phone', { width: 390, height: 844 }, 'dark'], ['light', { width: 1280, height: 900 }, 'light']];
  const report = [];
  for (const [vname, vp, theme] of combos) {
    const sessions = {};
    for (const [name, url, who] of pages) {
      if (vname === 'light' && !['home', 'event', 'portfolio', 'browse'].includes(name)) continue;
      const key = who || 'anon';
      if (!sessions[key]) sessions[key] = await session(who, vp, theme);
      const { p } = sessions[key];
      await p.goto(base + url); await p.waitForLoadState('networkidle').catch(() => {}); await p.waitForTimeout(900);
      if (theme === 'light') { await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await p.waitForTimeout(300); }
      const file = path.join(OUT, `${TAG}-${vname}-${name}.png`);
      await p.screenshot({ path: file, fullPage: false });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      report.push(`${vname}-${name}: overflow ${overflow}px errors ${p.errs.length}`);
    }
    for (const s of Object.values(sessions)) await s.ctx.close();
  }
  fs.writeFileSync(path.join(OUT, `${TAG}-report.txt`), report.join('\n'));
  console.log(report.join('\n'));
  await b.close(); await srv.close();
  for (const f of fs.readdirSync(OUT)) if (/^audit-.*\.db/.test(f)) fs.rmSync(path.join(OUT, f), { force: true });
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
