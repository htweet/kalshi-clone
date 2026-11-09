#!/usr/bin/env node
'use strict';
// Container smoke test (PLAN P9.1; CI job "image"): runs the built image the way production does — NODE_ENV=production,
// read-only root file system, /data volume, non-root — and checks:
//   1. the production config guard refuses a configuration without ADMIN_ORIGIN and names the setting;
//   2. with a full configuration the container becomes healthy: /healthz, /readyz, a page, a sign-in;
//   3. the metrics endpoint is not on the public listener, but answers on the private port inside the container;
//   4. the process runs as a non-root user and the image holds no data, keys or .env files.
//   node scripts/container-smoke.js [image]     (default parlance:local)
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Client, UA } = require('../tests/lib/client');

const image = process.argv[2] || 'parlance:local';
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = `Benue-${crypto.randomBytes(4).toString('hex')}-Halyard`;
const env = {
  ALLOWED_ORIGINS: 'https://parlance.example', PUBLIC_ORIGIN: 'https://parlance.example', ADMIN_ORIGIN: 'https://admin.parlance.example', SCRYPT_LOG_N: '17',
  SECRET_KEY: crypto.randomBytes(32).toString('hex'), BACKUP_KEY: crypto.randomBytes(32).toString('hex'), DEMO_ACCOUNTS: 'off', DEMO_API: '0', SPORTS: '0', TRUST_PROXY: 'loopback',
  ADMIN_EMAIL: 'root.smoke@example.test', ADMIN_PASSWORD: PW, KYC_REQUIRED: '0',
};
// A browser navigation as Chromium sends it (the production bot check expects navigation metadata, CLONE_SPEC.md §21).
const NAV = { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-NG,en;q=0.9', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none', 'sec-ch-ua': '"Chromium";v="130"',
  'user-agent': UA };
const call0 = Client.prototype.call;
Client.prototype.call = function call(method, p, body, headers = {}) { return call0.call(this, method, p, body, method === 'GET' && p === '/' ? { ...NAV, ...headers } : headers); };
const envArgs = (e) => Object.entries(e).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
const common = ['--read-only', '--tmpfs', '/tmp:rw,size=256m', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL'];

async function main() {
  // 1. Config guard.
  const bad = { ...env }; delete bad.ADMIN_ORIGIN;
  const r = spawnSync('docker', ['run', '--rm', ...common, ...envArgs(bad), image], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 78, `the guard exits 78 (EX_CONFIG), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr + r.stdout, /ADMIN_ORIGIN/, 'the refusal names ADMIN_ORIGIN');
  console.log('config guard: refused without ADMIN_ORIGIN, setting named');

  // 2. Healthy container.
  const vol = `parlance-smoke-${process.pid}`;
  const id = docker('run', '-d', ...common, '-v', `${vol}:/data`, '-p', '127.0.0.1::3000', ...envArgs(env), image);
  try {
    const port = docker('port', id, '3000/tcp').split('\n')[0].split(':').pop();
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(`${base}/healthz`)).ok; } catch { /* starting */ } if (!up) await sleep(1000); }
    if (!up) throw new Error(`container did not become healthy:\n${docker('logs', id)}`);
    assert.equal((await fetch(`${base}/readyz`)).status, 200, '/readyz');
    const page = await fetch(`${base}/`, { headers: NAV });
    assert.equal(page.status, 200, 'the home page');
    assert.match(page.headers.get('strict-transport-security') || '', /max-age=/, 'HSTS in production');
    const c = await new Client(base, 'smoke').logIn(env.ADMIN_EMAIL, PW);
    assert.ok(c.uid, 'signed in');
    assert.equal((await c.call('GET', '/v1/session')).status, 200);
    console.log('container: healthy, ready, page served, sign-in works');
    // 3. Metrics only on the private port.
    { const pm = await fetch(`${base}/metrics`); const body = await pm.text(); assert.ok(pm.status !== 200 && !body.includes('parlance_up'), `no metrics on the public listener (got ${pm.status})`); }
    const m = docker('exec', id, 'node', '-e', "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(t=>console.log(t.includes('parlance_up 1')?'ok':'missing'))");
    assert.equal(m, 'ok', 'metrics on the private port');
    console.log('metrics: private port only');
    // 4. Non-root, no secrets in the image.
    assert.notEqual(docker('exec', id, 'id', '-u'), '0', 'runs as non-root');
    const found = docker('exec', id, 'sh', '-c', "find /app -path /app/node_modules -prune -o \\( -name '.env' -o -name '*.key' -o -name '*.pem' -o -name '*.db' \\) -print | head -5");
    assert.equal(found, '', `no secrets or databases in the image: ${found}`);
    console.log('image: non-root, no data or keys');
  } finally {
    try { docker('rm', '-f', id); } catch { /* gone */ }
    try { docker('volume', 'rm', '-f', vol); } catch { /* gone */ }
  }
}

main().then(() => console.log('container smoke: ok'), (e) => { console.error(`container smoke failed: ${e.message}`); process.exit(1); });
