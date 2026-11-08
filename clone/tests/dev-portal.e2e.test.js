'use strict';
// Phase 7 P7.3 / A16 (CLONE_SPEC.md §35.9–§35.11): the developer portal in the browser — tabs, CMS-seeded prose, the
// generated reference (OpenAPI, AsyncAPI, FIX tables), search with Ctrl K, the theme toggle, the Developer Agreement and
// changelog; Try it signing in the browser with WebCrypto against the demo environment (a real signed call; private key
// never sent, cookies never sent, demo and production keys kept apart); CMS edits of portal prose showing live; the
// status page with an incident posted and resolved in Admin › Status incidents; the JavaScript and Python quick-start
// samples run against the server; and the developer_portal / status_page / api.demo flags.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
// The server runs in this process: children are awaited asynchronously so it keeps answering them.
const run = (cmd, args, opts) => new Promise((resolve) => execFile(cmd, args, { encoding: 'utf8', timeout: 30000, ...opts }, (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { harness, newPage, uiLogIn, eventually, cspOf, PW } = require('./lib/api-helpers');
const { SignedClient, ed25519, rsa } = require('./lib/signing');

const H = harness('portal');
let browser; let admin; let dana; let page;
const demoQ = (sql, ...a) => { const d = new DatabaseSync(H.DB_FILE.replace(/\.db$/, '.demo.db')); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const stepped = async (c, m, p, b) => { let r = await c.call(m, p, b); if (r.code === 'step_up_required') { await c.call('POST', '/v1/step_up', { password: PW }); r = await c.call(m, p, b); } return r; };

before(async () => {
  await H.start({ demo: {} });
  browser = await chromium.launch();
  admin = await H.adminClient();
  dana = await H.user('dana', { dollars: 100 });
});
after(async () => { await browser?.close(); await H.stop(); H.cleanup(); });

test('portal: tabs, CMS-seeded prose, generated reference, FIX tables, search (Ctrl K), theme, agreement, changelog', async () => {
  // Seeded through the CMS: every docs page is published version 1 with a reason.
  const seeded = H.q("SELECT key, published_version FROM cms_entries WHERE type='page' AND key LIKE 'docs/%'");
  assert.equal(seeded.length, 10); assert.ok(seeded.every((x) => x.published_version === 1));
  assert.ok(H.q("SELECT * FROM cms_versions WHERE key='docs/agreement' AND reason LIKE 'seed:%'").length === 1);
  page = await newPage(browser);
  await uiLogIn(page, H.BASE, H.email('dana'));
  await page.click('[data-testid=account-menu]');
  await page.click('[data-testid=menu-api-docs]');
  await page.waitForSelector('[data-testid=docs-portal][data-page=welcome]');
  assert.deepEqual((await page.locator('[data-testid=docs-tabs] a').allTextContents()).map((x) => x.trim()), ['Welcome', 'Quick Start', 'Concepts', 'Predictions APIs', 'Perps APIs', 'FIX', 'Changelog']);
  assert.match(await page.textContent('[data-testid=docs-prose]'), /Welcome to the Parlance API/);
  assert.equal(await page.locator('[data-testid=api-card]').count(), 2);
  for (const [tab, check] of [['quick-start', '[data-testid=docs-prose]:has-text("PARLANCE-ACCESS-SIGNATURE")'], ['concepts', '[data-testid=docs-prose]:has-text("cursor")'],
    ['predictions', '[data-testid=docs-reference][data-product=predictions] [data-op=batch_create_orders]'], ['perps', '[data-testid=docs-reference][data-product=perps] [data-op=create_margin_order]'],
    ['fix', '[data-testid=fix-msg][data-type=D]'], ['changelog', '[data-testid=docs-prose]:has-text("Deprecation policy")']]) {
    await page.click(`[data-testid=docs-tabs] [data-tab=${tab}]`);
    await page.waitForSelector(`[data-testid=docs-portal][data-page=${tab}] ${check}`);
  }
  await page.click('[data-testid=docs-tabs] [data-tab=predictions]');
  await page.waitForSelector('[data-testid=ws-channels] [data-channel=orderbook_delta]');
  await page.click('[data-side=agreement]');
  await page.waitForSelector('[data-testid=docs-prose][data-slug="docs/agreement"]:has-text("Fair use")');
  await page.click('[data-side=rate-limits]');
  await page.waitForSelector('[data-testid=tiers-table] [data-tier=premier]');
  // Search: Ctrl K focuses it; results cover guides and endpoints; Enter opens the first.
  await page.keyboard.press('Control+k');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.testid), 'docs-search');
  await page.keyboard.type('batched');
  await page.waitForSelector('[data-testid=docs-result]');
  assert.match(await page.textContent('[data-testid=docs-results]'), /\/portfolio\/orders\/batched/);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid=ref-page][data-op^=batch_]');
  await page.fill('[data-testid=docs-search]', 'deprecation');
  await page.waitForSelector('[data-testid=docs-result]:has-text("Changelog")');
  // Theme toggle.
  const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('[data-testid=docs-theme]');
  assert.notEqual(await page.evaluate(() => document.documentElement.dataset.theme), t0);
  // The generated documents.
  const oa = await (await fetch(`${H.BASE}/docs/openapi.json`)).json();
  assert.equal(oa.openapi, '3.1.0');
  const ids = Object.values(oa.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
  assert.ok(oa.servers.some((s) => s.url.endsWith('/demo-api/trade-api/v2')));
  assert.equal(oa.components.securitySchemes.ParlanceAccessSignature.name, 'PARLANCE-ACCESS-SIGNATURE');
  const aa = await (await fetch(`${H.BASE}/docs/asyncapi.json`)).json();
  assert.equal(aa.asyncapi, '2.6.0'); assert.ok(Object.keys(aa.channels).some((k) => k.startsWith('/trade-api/ws/v2/margin#')));
  assert.deepEqual(await cspOf(page), [], 'the portal runs under the strict CSP');
});

test('Try it: WebCrypto demo key in the browser, a real signed call to the demo environment; environments kept apart', async () => {
  const sent = [];
  page.on('request', (r) => { if (r.url().includes('/demo-api/')) sent.push(r); });
  await page.goto(`${H.BASE}/docs/reference/get_balance`);
  await page.waitForSelector('[data-testid=try-it] [data-testid=try-create-key]');
  await page.click('[data-testid=try-create-key]');
  await page.waitForSelector('[data-testid=try-key-id]');
  const keyId = await page.getAttribute('[data-testid=try-key-id]', 'data-key-id');
  assert.match(keyId, /^plxdemo_/);
  await page.click('[data-testid=try-send]');
  await page.waitForSelector('[data-testid=try-status][data-status="200"]');
  const body = JSON.parse(await page.textContent('[data-testid=try-response]'));
  assert.equal(body.balance_dollars, '8000.0000', 'demo play money: $10,000 less $2,000 moved to Perps');
  // The private key never left the browser: the demo DB has only the public key, the main DB has no demo key.
  const dk = demoQ('SELECT * FROM api_keys WHERE id=?', keyId)[0];
  assert.match(dk.public_key_pem, /PUBLIC KEY/); assert.equal(dk.origin, 'uploaded'); assert.equal(dk.env, 'demo');
  assert.equal(H.q1("SELECT COUNT(*) c FROM api_keys WHERE id LIKE 'plxdemo_%'").c, 0);
  const signedReq = sent.find((r) => r.url().includes('/portfolio/balance'));
  const hdrs = await signedReq.allHeaders();
  assert.equal(hdrs['parlance-access-key'], keyId); assert.ok(!hdrs.cookie, 'no cookies on Try it requests');
  // A write: create an order on the demo exchange from its reference page (example body prefilled).
  await page.goto(`${H.BASE}/docs/reference/create_order`);
  await page.waitForSelector('[data-testid=try-key-id]');
  assert.match(await page.inputValue('[data-testid=try-body]'), /"ticker"/);
  await page.click('[data-testid=try-send]');
  await page.waitForSelector('[data-testid=try-status][data-status="201"]');
  const order = JSON.parse(await page.textContent('[data-testid=try-response]')).order;
  assert.equal(demoQ('SELECT source FROM orders WHERE id=?', order.order_id)[0].source, 'api');
  assert.equal(H.q1('SELECT COUNT(*) c FROM orders WHERE id=?', order.order_id).c, 0, 'the order exists only in the demo database');
  // Production keys do not work on the demo, and the reverse.
  const mk = await H.key(dana);
  const onDemo = await new SignedClient(H.BASE, mk.id, mk.privateKey, { prefix: '/demo-api' }).call('GET', '/trade-api/v2/portfolio/balance');
  assert.equal(onDemo.status, 401); assert.equal(onDemo.reason, 'wrong_environment');
  // The demo WebSocket behind the proxy, with the same signed headers.
  const kp = rsa();
  const cred = await dana.call('POST', '/v1/developer/demo_credentials', { public_key: kp.publicKey.export({ type: 'spki', format: 'pem' }) });
  assert.equal(cred.status, 201, cred.text);
  const dws = new SignedClient(H.BASE, cred.body.api_key.api_key_id, kp.privateKey, { prefix: '/demo-api' }).socket('/trade-api/ws/v2');
  await dws.opened;
  assert.equal((await dws.subscribe(['user_orders']))[0].type, 'subscribed');
  dws.close();
  assert.deepEqual(page.errors, []);
});

test('CMS edits of portal prose show live on an open page; the code samples run against the server', async () => {
  await page.goto(`${H.BASE}/docs`);
  await page.waitForSelector('[data-testid=docs-prose][data-slug="docs/welcome"]');
  const cur = (await admin.call('GET', '/v1/admin/cms/page/entry?key=docs%2Fwelcome')).body.entry.published;
  assert.equal((await admin.call('PUT', '/v1/admin/cms/page/draft', { key: 'docs/welcome', value: { ...cur, body: `<p>Fresh from the CMS: market makers welcome.</p>${cur.body}` } })).status, 200);
  assert.equal((await admin.call('POST', '/v1/admin/cms/page/publish', { key: 'docs/welcome', reason: 'portal copy update' })).status, 200);
  await page.waitForSelector('[data-testid=docs-prose]:has-text("Fresh from the CMS")', { timeout: 10000 });
  // The JavaScript sample from the Quick Start page, run with Node against this server.
  const portal = (await dana.call('GET', '/v1/developer/portal')).body;
  const qs = portal.pages.find((p) => p.id === 'quick-start').body;
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const sample = (heading) => decode(new RegExp(`<h3>${heading}[^<]*</h3><pre><code>([\\s\\S]*?)</code></pre>`).exec(qs)[1]);
  const kp = ed25519();
  const keyFile = path.join(H.TMP, 'sample-key.pem');
  fs.writeFileSync(keyFile, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pub = kp.publicKey.export({ type: 'spki', format: 'pem' });
  let r = await stepped(dana, 'POST', `/v1/users/${dana.uid}/api_keys`, { label: 'samples', scopes: ['read'], mode: 'public_key', public_key: pub });
  const env = { ...process.env, PARLANCE_API_BASE: H.BASE, PARLANCE_KEY_ID: r.body.api_key.api_key_id, PARLANCE_PRIVATE_KEY_PATH: keyFile };
  const jsFile = path.join(H.TMP, 'balance.js');
  fs.writeFileSync(jsFile, sample('JavaScript'));
  const js = await run(process.execPath, [jsFile], { env });
  assert.equal(js.status, 0, js.stderr);
  const jsOut = JSON.parse(js.stdout.trim());
  assert.equal(jsOut.status, 200); assert.equal(jsOut.body.balance, 10000);
  // The Python sample, when python3 with the cryptography package is available; otherwise its signing recipe is
  // re-checked in Node (same message, RSA-PSS salt 32) so the documented scheme is still verified.
  const pyFile = path.join(H.TMP, 'balance.py');
  fs.writeFileSync(pyFile, sample('Python'));
  const hasPy = (await run('python3', ['-I', '-c', 'import cryptography'])).status === 0;
  if (hasPy) {
    const py = await run('python3', ['-I', pyFile], { env });
    assert.equal(py.status, 0, py.stderr);
    const out = JSON.parse(py.stdout.trim());
    assert.equal(out.status, 200); assert.equal(out.body.balance, 10000);
  } else {
    assert.match(sample('Python'), /salt_length=32/);
    const rk = rsa();
    r = await stepped(dana, 'POST', `/v1/users/${dana.uid}/api_keys`, { label: 'pss check', scopes: ['read'], mode: 'public_key', public_key: rk.publicKey.export({ type: 'spki', format: 'pem' }) });
    assert.equal((await new SignedClient(H.BASE, r.body.api_key.api_key_id, rk.privateKey).call('GET', '/trade-api/v2/portfolio/balance')).status, 200);
  }
  assert.deepEqual(page.errors, []);
});

test('status page: live components, an incident posted and resolved in Admin › Status incidents; announcements', async () => {
  const sp = await newPage(browser);
  await sp.goto(`${H.BASE}/status`);
  await sp.waitForSelector('[data-testid=status-overall][data-status=operational]');
  assert.equal(await sp.getAttribute('[data-testid=status-component][data-component=fix]', 'data-status'), 'disabled');
  assert.equal(await sp.getAttribute('[data-testid=status-component][data-component=demo]', 'data-status'), 'operational');
  const ap = await newPage(browser);
  await uiLogIn(ap, H.BASE, H.ADMIN.email);
  await ap.goto(`${H.BASE}/admin/status`);
  await ap.waitForSelector('[data-testid=adm-incident-form]');
  await ap.fill('#f-inc-title', 'Elevated order latency');
  await ap.fill('#f-inc-body', 'Order acknowledgements are slower than usual.');
  await ap.selectOption('#f-inc-impact', 'degraded');
  await ap.check('#f-inc-c_api');
  await ap.check('#f-inc-c_websocket');
  await ap.fill('#f-inc-reason', 'on-call report');
  await ap.click('[data-testid=adm-incident-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=adm-incident-row][data-status=investigating]');
  const inc = H.q1("SELECT key, published_version FROM cms_entries WHERE type='incident'");
  assert.equal(inc.published_version, 1);
  await sp.reload();
  await sp.waitForSelector('[data-testid=status-incident]:has-text("Elevated order latency")');
  assert.equal(await sp.getAttribute('[data-testid=status-overall]', 'data-status'), 'degraded');
  assert.equal(await sp.getAttribute('[data-testid=status-component][data-component=api]', 'data-status'), 'degraded');
  const ann = await (await fetch(`${H.BASE}/trade-api/v2/exchange/announcements`)).json();
  assert.equal(ann.announcements[0].message, 'Elevated order latency');
  await ap.click(`[data-testid=adm-incident-row][data-incident="${inc.key}"] [data-testid=adm-incident-resolve]`);
  await ap.fill('[data-testid=confirm-reason]', 'latency back to normal');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector(`[data-testid=adm-incident-row][data-incident="${inc.key}"][data-status=resolved]`);
  await sp.reload();
  await sp.waitForSelector('[data-testid=status-overall][data-status=operational]');
  await sp.waitForSelector('[data-testid=status-incident][data-status=resolved]');
  assert.equal(H.q1("SELECT published_version FROM cms_entries WHERE type='incident'").published_version, 2, 'every change is a CMS version');
  for (const p of [sp, ap]) { assert.deepEqual(p.errors, []); assert.deepEqual(await cspOf(p), []); await p.context().close(); }
});

test('flags: developer_portal, status_page and api.demo switch the portal, the status page and the demo proxy off', async () => {
  const set = async (k, enabled) => assert.equal((await stepped(admin, 'PUT', `/v1/admin/flags/${k}`, { enabled, reason: `e2e ${k}` })).status, 200);
  await set('developer_portal', false);
  await page.goto(`${H.BASE}/docs`);
  await page.waitForSelector('[data-testid=feature-unavailable][data-feature=developer_portal]');
  assert.equal((await fetch(`${H.BASE}/docs/openapi.json`)).status, 403);
  await set('developer_portal', true);
  await set('status_page', false);
  assert.equal((await (await fetch(`${H.BASE}/v1/status`)).json()).error.code, 'feature_disabled');
  await page.goto(`${H.BASE}/status`);
  await page.waitForSelector('[data-testid=feature-unavailable][data-feature=status_page]');
  await set('status_page', true);
  await set('api.demo', false);
  assert.equal((await fetch(`${H.BASE}/demo-api/trade-api/v2/markets?limit=1`)).status, 403);
  assert.equal((await dana.call('POST', '/v1/developer/demo_credentials', { public_key: 'x' })).code, 'feature_disabled');
  await set('api.demo', true);
  await eventually(async () => assert.equal((await fetch(`${H.BASE}/demo-api/trade-api/v2/markets?limit=1`)).status, 200));
  assert.deepEqual(page.errors, []);
});
