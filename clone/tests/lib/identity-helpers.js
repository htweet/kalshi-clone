'use strict';
// Shared helpers for the Phase 3 identity suites (onboarding, identity2, compliance). All personal data used with them
// is invented: "9xx" sandbox SSNs, 555-01xx phone numbers, "Sample"/"Test" names and Maple Test Avenue addresses.
const net = require('node:net');
const zlib = require('node:zlib');
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
  if (expectStatus === 'documents') { await page.waitForSelector('[data-testid=docv-intro]', { timeout: 20000 }); return; }
  if (expectStatus) {
    await page.waitForSelector('[data-testid=docv-intro], [data-testid=ob-outcome]', { timeout: 20000 });
    if (await page.locator('[data-testid=docv-intro]').count()) await completeDocumentsOnDevice(page);
    await page.waitForSelector(`[data-testid=ob-outcome][data-status=${expectStatus}]`, { timeout: 20000 });
  }
}

// ---------------------------------------------------------------------------------------- invented ID photos
// A real PNG (grey gradient + a seed-dependent band) built with zlib, so Node-side API tests can upload valid images.
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ -1) >>> 0; }
function pngImage(w = 320, h = 220, seed = 1) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit greyscale
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = (x + y * seed) % 256 ^ (Math.abs(y - h / 2) < 12 ? 0xff : 0); }
  const text = chunk('tEXt', Buffer.from('Comment\0invented test document PNGTEXTMARKER', 'latin1')); // metadata the server must drop
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), text, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A JPEG drawn by the browser, with an EXIF (APP1) segment carrying a fake GPS marker inserted after SOI, and trailing
// bytes after EOI — both must be gone from what the server stores.
async function jpegWithExif(page, w = 640, h = 400, label = 'SAMPLE ID') {
  const b64 = await page.evaluate(([W, H, L]) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.fillStyle = '#dfe7f0'; g.fillRect(0, 0, W, H); g.fillStyle = '#123'; g.font = '40px sans-serif'; g.fillText(L, 40, 120); g.fillRect(40, 180, 160, 160); return c.toDataURL('image/jpeg', 0.9).split(',')[1]; }, [w, h, label]);
  const jpg = Buffer.from(b64, 'base64');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('MM\0*\0\0\0\x08 GPSTESTMARKER 51.5007N 0.1246W camera-serial-TEST-0001', 'latin1')]);
  const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, payload, jpg.subarray(2), Buffer.from('TRAILINGPAYLOAD', 'latin1')]);
}

// Same-device fallback from the "Let's get you verified" intro: three photos, then submit.
async function completeDocumentsOnDevice(page, image) {
  await page.click('[data-testid=docv-same-device]');
  await page.waitForSelector('[data-testid=docv-device]');
  const img = image || pngImage(360, 240, 3);
  for (const k of ['id_front', 'id_back', 'selfie']) {
    await page.setInputFiles(`[data-testid=device-capture-${k}]`, { name: `${k}.png`, mimeType: 'image/png', buffer: img });
    await page.waitForSelector(`[data-state="${k}"]:has-text("Added")`, { timeout: 15000 });
  }
  await page.click('[data-testid=docv-device-submit]');
}

// API-only onboarding for a Node client (tests/lib/client.js): phone → details → data check → documents → decision.
async function apiOnboard(base, c, p, { docs = true, wait = 'approved' } = {}) {
  const u = (x) => `/v1/users/${c.uid}${x}`;
  const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };
  const t0 = Date.now() - 1000;
  ok(await c.call('POST', u('/verify_phone/send'), { country: p.country || 'US', number: p.phone }), 'send code');
  ok(await c.call('POST', u('/verify_phone'), { code: await smsCode(base, p.last4, t0) }), 'verify code');
  ok(await c.call('PUT', u('/sign_up/name'), { first_name: p.first, last_name: p.last }), 'name');
  ok(await c.call('PUT', u('/sign_up/birthday'), { month: p.dob[0], day: p.dob[1], year: p.dob[2] }), 'birthday');
  ok(await c.call('PUT', u('/sign_up/address'), { country: p.country || 'US', line1: p.line1, city: p.city, region: p.region, postal_code: p.postal, national_id: p.ssn }), 'address');
  ok(await c.call('POST', u('/sign_up/submit'), {}), 'submit');
  const st = await until(async () => { const r = await c.call('GET', u('/sign_up')); return r.body && r.body.status !== 'pending' ? r.body : null; }, 15000);
  if (!docs || st.status !== 'documents_required') return st;
  const img = pngImage(320, 220, 7).toString('base64');
  for (const kind of ['id_front', 'id_back', 'selfie']) ok(await c.call('POST', u('/docv/documents'), { kind, image: img }), `upload ${kind}`);
  ok(await c.call('POST', u('/docv/submit'), {}), 'docs submit');
  return until(async () => { const r = await c.call('GET', u('/sign_up')); return r.body && r.body.status !== 'pending' && (!wait || r.body.status === wait || r.body.status !== 'pending') ? r.body : null; }, 15000);
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

module.exports = { freePort, sleep, until, db, newPage, cspViolations, assertClean, signUpUi, logInUi, call, uidOf, smsCode, mailTo, completeOnboarding, completeDocumentsOnDevice, person, pngImage, jpegWithExif, apiOnboard };
