'use strict';
// Shared helpers for the Phase 3 identity suites (onboarding, identity2, compliance). All personal data used with them
// is invented: "9xx" sandbox SSNs, 555-01xx phone numbers, "Sample"/"Test" names and Maple Test Avenue addresses.
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, step = 120) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for condition'); await sleep(step); }
}
const db = (file) => ({
  q: (sql, ...a) => { const d = new DatabaseSync(file); try { return d.prepare(sql).all(...a); } finally { d.close(); } },
  run: (sql, ...a) => { const d = new DatabaseSync(file); try { return d.prepare(sql).run(...a); } finally { d.close(); } },
  // Every text value in every table, for "no plaintext personal data at rest" assertions.
  dump: () => {
    const d = new DatabaseSync(file);
    try {
      const out = [];
      for (const { name } of d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        for (const row of d.prepare(`SELECT * FROM "${name}"`).all()) out.push(`${name}:${JSON.stringify(row)}`);
      }
      return out.join('\n');
    } finally { d.close(); }
  },
});

// A browser page that records page errors and CSP violations.
async function newPage(browser, base, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, ...(opts.context || {}) });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(base + (opts.path || '/'));
  return page;
}
const cspViolations = (page) => page.evaluate(() => window.__csp || []);
async function assertClean(assert, page) {
  assert.deepEqual(page.errors, [], 'no page errors');
  assert.deepEqual(await cspViolations(page), [], 'no CSP violations');
}

async function signUpUi(page, base, u, pw) {
  await page.goto(base + '/sign-up');
  await page.fill('input[name=display_name]', u.name);
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', pw);
  await page.click('button[type=submit]');
}
async function logInUi(page, base, email, pw) {
  await page.goto(base + '/sign-in');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw);
  await page.click('#auth-form button[type=submit]');
}
// In-page API call with the stored CSRF token, the device ID and the client-token cookie (like the SPA).
const call = (page, method, url, body, headers = {}) => page.evaluate(async ([m, u, b, h]) => {
  const c = JSON.parse(localStorage.getItem('csrfToken') || 'null');
  const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-device-id': localStorage.getItem('plx-device-id') || 'test-device-0000000000', ...(c ? { 'x-csrf-token': c.value } : {}), ...h }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null), headers: Object.fromEntries(r.headers.entries()) };
}, [method, url, body, headers]);
const uidOf = (page) => page.evaluate(() => fetch('/v1/session').then((r) => r.json()).then((j) => j.user && j.user.user_id));

// Latest dev-outbox SMS code for a masked destination ending (e.g. "0142").
async function smsCode(base, ending, after = 0) {
  return until(async () => {
    const r = await (await fetch(`${base}/v1/dev/sms`)).json();
    const m = r.messages.find((x) => x.to.endsWith(ending) && Date.parse(x.time) >= after);
    return m && /code is (\d{4})/.exec(m.body)[1];
  });
}
async function mailTo(base, to, subjectRe, after = 0) {
  return until(async () => {
    const r = await (await fetch(`${base}/v1/dev/mailbox?to=${encodeURIComponent(to)}`)).json();
    return r.messages.find((x) => subjectRe.test(x.subject) && Date.parse(x.time) >= after);
  });
}

// Drives the onboarding UI from the phone step to submission. `person` = {phone, last4, first, last, dob:[m,d,y], ssn, line1, city, region, postal}.
async function completeOnboarding(page, base, person, { expectStatus = 'approved' } = {}) {
  await page.waitForSelector('[data-testid=onboarding][data-step=phone]');
  await page.selectOption('[data-testid=phone-country]', person.country || 'US');
  await page.fill('[data-testid=phone-number]', person.phone);
  const t0 = Date.now() - 1000;
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=code]');
  const code = await smsCode(base, person.last4, t0);
  const digits = page.locator('[data-testid=code-digit]');
  for (let i = 0; i < 4; i++) await digits.nth(i).type(code[i]);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=name]');
  await page.fill('[data-testid=first-name]', person.first);
  await page.fill('[data-testid=last-name]', person.last);
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=birthday]');
  await page.fill('[data-testid=dob-month]', String(person.dob[0]).padStart(2, '0'));
  await page.fill('[data-testid=dob-day]', String(person.dob[1]).padStart(2, '0'));
  await page.fill('[data-testid=dob-year]', String(person.dob[2]));
  await page.click('[data-testid=ob-continue]');
  await page.waitForSelector('[data-testid=onboarding][data-step=address]');
  if (person.country && person.country !== 'US') await page.selectOption('[data-testid=addr-country]', person.country);
  await page.fill('[data-testid=addr-line1]', person.line1);
  await page.fill('[data-testid=addr-city]', person.city);
  if (await page.locator('select[data-testid=addr-region]').count()) await page.selectOption('[data-testid=addr-region]', person.region);
  else await page.fill('[data-testid=addr-region]', person.region);
  await page.fill('[data-testid=addr-postal]', person.postal);
  await page.fill('[data-testid=national-id]', person.ssn);
  await page.click('[data-testid=ob-continue]');
  if (expectStatus) await page.waitForSelector(`[data-testid=ob-outcome][data-status=${expectStatus}]`, { timeout: 15000 });
}

let n = 0;
const BASE_I = Date.now() % 40;
// An invented person; `i` makes phone and SSN unique per test user (duplicates are rejected by design).
function person(overrides = {}) {
  n += 1;
  const i = BASE_I + n;
  const k = String(i % 100).padStart(2, '0');
  return { phone: `202 555 01${k}`, last4: `01${k}`, first: 'Testa', last: 'Sample', dob: [4, 12, 1990], ssn: `9${k}-12-${String(1000 + i).slice(-4)}`,
    line1: `${10 + i} Maple Test Avenue`, city: 'Sampleton', region: 'NY', postal: '10001', ...overrides };
}

module.exports = { freePort, sleep, until, db, newPage, cspViolations, assertClean, signUpUi, logInUi, call, uidOf, smsCode, mailTo, completeOnboarding, person };
