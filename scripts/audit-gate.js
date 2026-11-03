#!/usr/bin/env node
'use strict';
// `npm audit` gate for the pre-commit hook: blocks on high/critical advisories in clone/, but only warns when the
// registry cannot be reached (offline commits stay possible; CI runs `npm audit --audit-level=high` strictly).
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cwd = path.resolve(__dirname, '..', 'clone');
const r = spawnSync('npm', ['audit', '--json', '--audit-level=high'], { cwd, encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000 });
let report = null;
try { report = JSON.parse(r.stdout || ''); } catch { /* not JSON: npm itself failed */ }
if (!report || report.error) {
  const why = report?.error?.summary || (r.error && r.error.message) || (r.stderr || '').trim().split('\n').pop() || 'unknown error';
  console.warn(`npm audit: could not check advisories (${why}); not blocking. CI will run it.`);
  process.exit(0);
}
const v = report.metadata?.vulnerabilities || {};
const bad = (v.high || 0) + (v.critical || 0);
if (bad > 0) {
  console.error(`npm audit: ${v.critical || 0} critical, ${v.high || 0} high advisories in clone/. Run \`cd clone && npm audit\` for details.`);
  process.exit(1);
}
console.log(`npm audit: clean at high/critical (${v.moderate || 0} moderate, ${v.low || 0} low)`);
