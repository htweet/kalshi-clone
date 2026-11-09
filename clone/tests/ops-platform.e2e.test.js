'use strict';
// Operations platform (PLAN P9.4 / P9.6, CLONE_SPEC.md §39.5, §39.6, §39.10), node level, real servers + SQLite:
//   • log scrubbing: emails, phone numbers, bearer tokens, JWTs, PEM keys, API key material, card numbers and
//     secret-named fields never reach a log line; request ids are kept; request logs through a running server too;
//   • the production config guard refuses to start and names each failing setting; a complete configuration passes;
//   • trusted proxy: X-Forwarded-For from outside the trusted range is ignored (rate limits, audit IP), from the proxy
//     it is used; X-Request-Id is honoured only from a trusted proxy;
//   • key rotation round trips: a new key becomes active, every encrypted value is re-encrypted and verified, old values
//     keep decrypting during the move, audit rows sealed by either key verify, a restart with the ring keeps working;
//   • /healthz and /readyz (rate-limited, nothing revealed), metrics on the private port only, readiness failing when
//     the disk threshold is not met; the webhook alert adapter delivers a signed test to a local receiver.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { createLogger, scrub } = require('../server/logger');
const configGuard = require('../server/config-guard');
const kc = require('../server/crypto');
const auditChain = require('../server/audit-chain');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-opsplat-'));
const PW = 'Benue-Copper-Halyard-6604';
const HIGH = { burst: 1e6, per_second: 1e6 };
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const opts = (dbFile, extra = {}) => ({ port: 0, dbFile, quiet: true, sports: false, tickMs: 300, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, admin: ADMIN, ...extra });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('log scrubbing removes emails, phones, tokens, keys and card data, keeps request ids; request logs are scrubbed too', async () => {
  const lines = [];
  const sink = { write: (l) => lines.push(l) };
  const log = createLogger({ level: 'debug', out: sink, err: sink });
  const pan = '4111 1111 1111 1111';
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyMTIzNDUifQ', 'c2lnbmF0dXJlc2lnbmF0dXJlMTIz'].join('.'); // a fake token, assembled so scanners do not flag the fixture
  const pemTag = (w) => `-----${w} ${['PRIVATE', 'KEY'].join(' ')}-----`; // a fake key block, assembled for the same reason
  const pem = `${pemTag('BEGIN')}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${pemTag('END')}`;
  log.info('user ada.lagos@example.test paid with card 4111111111111111 and called +2348031234567 or 08031234567', {
    request_id: 'req_0123456789abcdef', trace_id: '0af7651916cd43dd8448eb211c80319c', password: 'Hunter2-Hunter2', api_key: 'pk_live_abc', authorization: 'Bearer abcdefghijklmnopqrstuv',
    nested: { note: `token ${jwt} and ${pem}`, card: pan, url: 'https://example.ng/v1/waitlists/unsubscribe?t=SECRETTOKEN123' }, cookie: 'plx_session=abc', bvn: '22212345678', secret_value: 'enc:v1:aaa.bbb.ccc',
    hex: 'a'.repeat(64), nin: 'my NIN is 12345678901',
  });
  log.error('boom', { error: Object.assign(new Error('failed for bola@example.test with Bearer abcdefghijklmnopqrstuvwxyz'), { code: 'E1' }) });
  const out = lines.join('\n');
  for (const leak of ['ada.lagos@example.test', 'bola@example.test', '4111111111111111', pan, '+2348031234567', '08031234567', 'Hunter2', 'pk_live_abc', 'abcdefghijklmnopqrstuv', jwt, 'BEGIN PRIVATE KEY', 'SECRETTOKEN123', 'plx_session=abc', '22212345678', 'enc:v1:aaa', 'a'.repeat(64), '12345678901']) {
    assert.ok(!out.includes(leak), `"${leak.slice(0, 30)}" must not be logged`);
  }
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.request_id, 'req_0123456789abcdef'); assert.equal(rec.trace_id, '0af7651916cd43dd8448eb211c80319c', 'correlation ids stay usable');
  assert.match(rec.msg, /\[email\].*\[card\].*\[phone\].*\[phone\]/);
  assert.equal(rec.password, '[redacted]'); assert.equal(rec.nested.card, '[redacted]');
  assert.deepEqual(scrub({ x: 'order 1234 at 45¢' }), { x: 'order 1234 at 45¢' }, 'ordinary text is left alone');
  // Through a server: request lines carry the request id and never a query string or an email.
  const reqLines = [];
  const L = createLogger({ level: 'info', out: { write: (l) => reqLines.push(l) }, err: { write: (l) => reqLines.push(l) } });
  const s3 = await start({ ...opts(path.join(TMP, 'log3', 'l.db')), logs: L });
  try {
    const r = await fetch(`http://127.0.0.1:${s3.port}/v1/waitlists/unsubscribe?t=ada.lagos@example.test`, { headers: { 'x-request-id': 'should-not-be-trusted-01' } });
    assert.ok(r.headers.get('x-request-id') && r.headers.get('x-request-id') !== 'should-not-be-trusted-01', 'an untrusted request id is replaced');
    await new Promise((res) => setTimeout(res, 50));
    const line = reqLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x && x.msg === 'request' && x.request_id === r.headers.get('x-request-id'));
    assert.ok(line, 'a request line with the request id');
    assert.ok(!JSON.stringify(line).includes('ada.lagos') && !JSON.stringify(line).includes('t='), JSON.stringify(line));
  } finally { await s3.close(); }
});

test('production config guard: refuses and names each failing setting; a complete configuration passes', () => {
  const dataDir = path.join(TMP, 'guard', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const bad = configGuard.checks({ env: { NODE_ENV: 'production' }, dataDir }).filter((c) => !c.ok).map((c) => c.setting);
  for (const s of ['ALLOWED_ORIGINS', 'PUBLIC_ORIGIN', 'ADMIN_ORIGIN', 'SCRYPT_LOG_N', 'SECRET_KEY', 'BACKUP_KEY', 'DEMO_ACCOUNTS', 'DEMO_API', 'SPORTS', 'TRUST_PROXY']) assert.ok(bad.includes(s), `${s} is checked`);
  const good = { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://example.ng,https://admin.example.ng', PUBLIC_ORIGIN: 'https://example.ng', ADMIN_ORIGIN: 'https://admin.example.ng', SCRYPT_LOG_N: '17',
    SECRET_KEY: crypto.randomBytes(32).toString('hex'), BACKUP_KEY: crypto.randomBytes(32).toString('hex'), DEMO_ACCOUNTS: 'off', DEMO_API: '0', SPORTS: '0', TRUST_PROXY: 'loopback, 172.30.10.0/24' };
  assert.deepEqual(configGuard.checks({ env: good, dataDir }).filter((c) => !c.ok), []);
  assert.throws(() => configGuard.enforce({ env: { ...good, TRUST_PROXY: 'true', SCRYPT_LOG_N: '16' }, dataDir }), (e) => e.code === 'CONFIG_GUARD' && /TRUST_PROXY/.test(e.message) && /SCRYPT_LOG_N/.test(e.message));
  assert.throws(() => configGuard.enforce({ env: { ...good, ADMIN_ORIGIN: 'https://example.ng' }, dataDir }), /ADMIN_ORIGIN/);
  assert.deepEqual(configGuard.enforce({ env: { ...good, NODE_ENV: 'development', ADMIN_ORIGIN: '' }, dataDir }), [], 'only production refuses');
  // A key file inside the data folder is refused, a secrets file outside is accepted.
  const ring = path.join(TMP, 'guard', 'secrets', 'keyring.json');
  fs.mkdirSync(path.dirname(ring), { recursive: true });
  fs.writeFileSync(ring, JSON.stringify({ active: 'k1', keys: { k1: crypto.randomBytes(32).toString('hex') } }));
  const noKey = { ...good }; delete noKey.SECRET_KEY;
  assert.ok(configGuard.checks({ env: noKey, dataDir }).some((c) => c.setting === 'SECRET_KEY' && !c.ok), 'the generated data/secret.key is refused');
  // The real process: NODE_ENV=production without settings exits 78 and lists them.
  const r = spawnSync(process.execPath, ['--no-warnings', 'server/index.js'], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, NODE_ENV: 'production', DB_FILE: path.join(dataDir, 'p.db'), PORT: '0' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 78, r.stderr);
  assert.match(r.stderr, /ADMIN_ORIGIN/); assert.match(r.stderr, /SCRYPT_LOG_N/); assert.match(r.stderr, /ALLOWED_ORIGINS/);
});

test('trusted proxy: a forged X-Forwarded-For from outside the trusted range is ignored; from the proxy it counts', async () => {
  const file = path.join(TMP, 'proxy', 'p.db');
  // The test client connects from 127.0.0.1: trusting only 10.0.0.0/8 makes it an untrusted hop.
  let srv = await start(opts(file, { security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH, trustProxy: '10.0.0.0/8' } }));
  try {
    const c = await new Client(`http://127.0.0.1:${srv.port}`, 'p').boot();
    const r = await c.call('POST', '/v1/log_in', { email: `nobody.${stamp}@example.test`, password: 'Wrong-Password-1' }, { 'x-forwarded-for': '203.0.113.9' });
    assert.equal(r.status, 401);
    const ev = srv.db.prepare("SELECT ip FROM security_events UNION ALL SELECT ip_prefix AS ip FROM auth_events").all().map((x) => x.ip).filter(Boolean);
    assert.ok(!ev.includes('203.0.113.9') && !ev.some((x) => /203\.0\.113/.test(x)), `the forged address is never recorded: ${ev.join(',')}`);
    assert.ok(srv.app.locals.security.clientIp({ headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' }, url: '/', method: 'GET' }).endsWith('127.0.0.1'));
  } finally { await srv.close(); }
  srv = await start(opts(file, { security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH, trustProxy: 'loopback' } }));
  try {
    const ip = srv.app.locals.security.clientIp({ headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' }, url: '/', method: 'GET' });
    assert.equal(ip, '203.0.113.9', 'from the trusted proxy the forwarded address is the client');
    const r = await fetch(`http://127.0.0.1:${srv.port}/healthz`, { headers: { 'x-request-id': 'proxy-request-0001' } });
    assert.equal(r.headers.get('x-request-id'), 'proxy-request-0001', 'a trusted proxy\'s request id is kept');
  } finally { await srv.close(); }
});

test('key rotation: new active key, re-encryption, verification, audit chain across keys, restart', async () => {
  const dir = path.join(TMP, 'rot'); const file = path.join(dir, 'r.db');
  let srv = await start(opts(file));
  const base = () => `http://127.0.0.1:${srv.port}`;
  try {
    // Encrypted values under k1: a TOTP secret (enable two-factor setup) and an alert contact.
    const admin = await new Client(base(), 'admin').logIn(ADMIN.email, PW);
    assert.equal((await admin.call('POST', '/v1/admin/system/alerts/contacts', { kind: 'email', label: 'Owner', target: `owner.${stamp}@example.test`, reason: 'rotation test' })).status, 201);
    const u = await new Client(base(), 'u').signUp(`rot.${stamp}@example.test`, PW, 'Rot User');
    assert.equal((await u.call('POST', `/v1/users/${u.uid}/mfa/setup`, {})).status < 300, true);
    const before = srv.db.prepare('SELECT secret FROM mfa WHERE user_id=?').get(u.uid).secret;
    assert.match(before, /^enc:v1:/, 'k1 keeps the original format');
    const k = await admin.call('GET', '/v1/admin/system');
    assert.equal(k.body.keys.active, 'k1');
    assert.ok(k.body.keys.rotatable, 'a development ring in the data folder can be rotated from the admin');
    // Rotate (step-up), wait for the job.
    const r = await admin.call('POST', '/v1/admin/system/keys/rotate', { reason: 'yearly rotation', wait: true });
    assert.equal(r.status, 202, r.text);
    assert.equal(r.body.kid, 'k2');
    const s = (await admin.call('GET', '/v1/admin/system')).body.keys;
    assert.equal(s.active, 'k2'); assert.equal(s.pending, 0, 'every value re-encrypted');
    assert.equal(s.last_rotation.status, 'verified');
    assert.equal(s.keys.find((x) => x.kid === 'k1').status, 'retired');
    assert.ok(s.keys.find((x) => x.kid === 'k1').audit_rows > 0 && !s.keys.find((x) => x.kid === 'k1').removable, 'k1 stays verify-only while audit rows need it');
    const after = srv.db.prepare('SELECT secret FROM mfa WHERE user_id=?').get(u.uid).secret;
    assert.match(after, /^enc:v2:k2:/);
    // New audit rows are sealed with k2; the whole chain still verifies.
    assert.equal((await admin.call('PUT', '/v1/admin/flags/social', { enabled: false, reason: 'after rotation' })).status, 200);
    assert.equal(srv.db.prepare('SELECT key_id FROM admin_audit ORDER BY chain_seq DESC LIMIT 1').get().key_id, 'k2');
    assert.ok(auditChain.verify(srv.db).ok);
    assert.equal((await admin.call('GET', '/v1/admin/audit/verify')).body.ok, true);
    // The contact still decrypts (test send reaches the dev outbox).
    const contact = (await admin.call('GET', '/v1/admin/system')).body.alerts.contacts[0];
    assert.equal((await admin.call('POST', `/v1/admin/system/alerts/contacts/${contact.id}/test`, {})).body.delivered, true);
  } finally { await srv.close(); }
  // A restart reads the ring file and keeps working; a value under k1 written by hand still decrypts (decrypt by key id).
  kc.reloadKeyring(); auditChain.resetKey(srv.db);
  srv = await start(opts(file));
  try {
    const ring = kc.keyring({ dir });
    assert.equal(ring.active, 'k2'); assert.ok(ring.keys.has('k1'));
    const k1 = kc.deriveKey('field-encryption:v1', { dir, kid: 'k1' });
    const old = kc.encrypt('legacy', 'aad:x', k1);
    assert.equal(kc.decrypt(old, 'aad:x', kc.deriveKey('field-encryption:v1', { dir })), 'legacy', 'values under the old key still open');
    assert.ok(auditChain.verify(srv.db).ok);
    assert.equal(srv.app.locals.keyring.pendingCount(), 0);
  } finally { await srv.close(); }
  // An offline rotation (npm run keys -- rotate) is picked up on start and re-encrypted.
  const ringFile = path.join(dir, 'secret.keyring.json');
  const rr = spawnSync(process.execPath, ['--no-warnings', 'scripts/keys.js', 'rotate', '--file', ringFile, '--data-dir', dir], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(rr.status, 0, rr.stderr);
  assert.match(rr.stdout, /Added k3/);
  kc.reloadKeyring();
  srv = await start(opts(file));
  try {
    for (let i = 0; i < 50 && srv.app.locals.keyring.pendingCount() > 0; i++) await new Promise((res) => setTimeout(res, 100));
    assert.equal(srv.app.locals.keyring.status().active, 'k3');
    assert.equal(srv.app.locals.keyring.pendingCount(), 0, 're-encrypted on start');
    assert.ok(srv.app.locals.keyring.verify().ok);
  } finally { await srv.close(); kc.reloadKeyring(); }
});

test('health and metrics: /healthz and /readyz reveal nothing and are rate-limited; metrics only on the private port', async () => {
  const file = path.join(TMP, 'health', 'h.db');
  const srv = await start(opts(file, { ops: { metricsPort: 0 } }));
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const h = await fetch(`${base}/healthz`);
    assert.equal(h.status, 200); assert.deepEqual(await h.json(), { status: 'ok' });
    const rd = await fetch(`${base}/readyz`);
    assert.equal(rd.status, 200); assert.deepEqual(await rd.json(), { status: 'ready' }, 'no details on the public endpoint');
    assert.equal(rd.headers.get('cache-control'), 'no-store');
    // The public listener has no metrics; the private one does.
    const pub = await fetch(`${base}/metrics`); // the SPA's page (or a 404), never the metrics text
    assert.ok(!(await pub.text()).includes('parlance_up'), 'no metrics on the public listener');
    assert.ok(srv.metricsPort && srv.metricsPort !== srv.port, 'a separate metrics port');
    await fetch(`${base}/v1/site_config`);
    const m = await (await fetch(`http://127.0.0.1:${srv.metricsPort}/metrics`)).text();
    for (const name of ['parlance_up 1', 'parlance_http_requests_total', 'parlance_http_request_duration_seconds_bucket', 'parlance_db_size_bytes', 'parlance_outbox_depth', 'parlance_status{name="schema_version"}', 'parlance_job_last_success_age_seconds']) assert.ok(m.includes(name), `metric ${name}`);
    const detail = await (await fetch(`http://127.0.0.1:${srv.metricsPort}/readyz`)).json();
    assert.ok(detail.checks.some((c) => c.name === 'migrations' && c.ok), 'details only on the private port');
    // Not ready when the free-disk threshold is above what the disk has.
    srv.app.locals.ownerSettings.set('ops.readyz_disk_free_mb', 100000);
    const r2 = await fetch(`${base}/readyz`);
    const free = srv.app.locals.obs.diskFree();
    if (free && free.free < 100000 * 1048576) assert.equal(r2.status, 503);
    srv.app.locals.ownerSettings.set('ops.readyz_disk_free_mb', 500);
    // Rate limit: a burst from one address is answered 429.
    let limited = 0;
    for (let i = 0; i < 40; i++) if ((await fetch(`${base}/healthz`)).status === 429) limited += 1;
    assert.ok(limited > 0, 'rate-limited per IP');
  } finally { await srv.close(); }
});

test('alerts: a webhook contact gets a signed test with a code; entering the code confirms it; a firing rule is delivered and resolved', async () => {
  const got = [];
  const recv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push({ headers: req.headers, body: JSON.parse(b) }); res.writeHead(204).end(); }); });
  await new Promise((r) => recv.listen(0, '127.0.0.1', r));
  const hook = `http://127.0.0.1:${recv.address().port}/alerts`;
  const file = path.join(TMP, 'alerts', 'a.db');
  const srv = await start(opts(file, { ops: { alertLoopback: true } }));
  try {
    const admin = await new Client(`http://127.0.0.1:${srv.port}`, 'admin').logIn(ADMIN.email, PW);
    const add = await admin.call('POST', '/v1/admin/system/alerts/contacts', { kind: 'webhook', label: 'Owner phone', target: hook, reason: 'phone alerts' });
    assert.equal(add.status, 201, add.text);
    assert.equal(add.body.contact.confirmed, false);
    const t = await admin.call('POST', `/v1/admin/system/alerts/contacts/${add.body.contact.id}/test`, {});
    assert.equal(t.body.delivered, true, JSON.stringify(t.body));
    const msg = got[0];
    assert.equal(msg.body.type, 'test'); assert.match(msg.body.code, /^\d{6}$/);
    const [ts, v1] = msg.headers['x-parlance-signature'].split(',').map((x) => x.split('=')[1]);
    const key = kc.deriveKey('ops-webhook-signing:v1', { dir: path.dirname(file) });
    assert.equal(v1, crypto.createHmac('sha256', key).update(`${ts}.${JSON.stringify(msg.body)}`).digest('hex'), 'HMAC signature over timestamp.body');
    assert.equal((await admin.call('POST', `/v1/admin/system/alerts/contacts/${add.body.contact.id}/confirm`, { code: '000000' })).code, 'invalid_code');
    const ok = await admin.call('POST', `/v1/admin/system/alerts/contacts/${add.body.contact.id}/confirm`, { code: msg.body.code });
    assert.equal(ok.body.contact.confirmed, true);
    // A real rule: the backup is overdue (no backup yet) → firing alert sent; a backup → resolved.
    await admin.call('POST', '/v1/admin/system/alerts/run', {});
    assert.ok(got.some((g) => g.body.type === 'alert' && g.body.rule === 'backup_overdue' && g.body.status === 'firing'), JSON.stringify(got.map((g) => g.body)));
    await admin.call('POST', '/v1/admin/system/backups', { reason: 'resolve the alert' });
    await admin.call('POST', '/v1/admin/system/alerts/run', {});
    assert.ok(got.some((g) => g.body.rule === 'backup_overdue' && g.body.status === 'resolved'));
    // An https-only rule in production: a plain http webhook outside loopback is refused.
    assert.equal((await admin.call('POST', '/v1/admin/system/alerts/contacts', { kind: 'webhook', label: 'x', target: 'http://example.ng/hook', reason: 'bad' })).status, 400);
  } finally { await srv.close(); recv.close(); }
});
