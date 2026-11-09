#!/usr/bin/env node
'use strict';
// Backup sidecar (PLAN P9.1 / P9.2, deploy/docker-compose.yml service `backup`): an independent container that, every
// BACKUP_VERIFY_HOURS (default 6), restores the newest backup plus the shipped WAL from the backup store into its own
// temporary folder and runs the verifiers (integrity, ledger / journal, audit chain). It never touches the live
// database. Results are JSON log lines and Prometheus gauges on BACKUP_VERIFY_METRICS_PORT (default 9465):
//   parlance_backup_verify_ok 1|0, parlance_backup_verify_last_success_timestamp_seconds, parlance_backup_restored_age_seconds
// The app's own restore drill (Admin › System) does the same inside the app; this one proves the store alone suffices.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const storageLib = require('../server/storage');
const { restore, backupKeys } = require('../server/backups');
const { verifyDatabase } = require('../server/verify');

const hours = Number(process.env.BACKUP_VERIFY_HOURS || 6);
const state = { ok: null, last_success: 0, restored_age: null };
const log = (rec) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: rec.ok === false ? 'error' : 'info', msg: 'backup verify', ...rec })}\n`);

async function once() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-verify-'));
  try {
    const storage = storageLib.fromEnv({ spec: process.env.BACKUP_STORAGE || 'local:/data/backups', defaultDir: '/data/backups', envPrefix: 'BACKUP_' });
    const out = path.join(dir, 'restored.db');
    const r = await restore({ storage, outFile: out, keys: backupKeys({ dir }), keyDir: dir });
    const d = new DatabaseSync(out);
    let v;
    try { v = verifyDatabase(d, { keyDir: dir }); } finally { d.close(); }
    state.ok = v.ok; state.restored_age = (Date.now() - r.reached_ts) / 1000;
    if (v.ok) state.last_success = Date.now();
    log({ ok: v.ok, snapshot: r.snapshot.key, segments: r.segments, checks: Object.fromEntries(Object.entries(v.checks).map(([k, c]) => [k, c.ok])) });
  } catch (e) {
    state.ok = false;
    log({ ok: false, error: e.message });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

http.createServer((req, res) => {
  if (req.url !== '/metrics') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end([
    '# TYPE parlance_backup_verify_ok gauge', `parlance_backup_verify_ok ${state.ok ? 1 : 0}`,
    '# TYPE parlance_backup_verify_last_success_timestamp_seconds gauge', `parlance_backup_verify_last_success_timestamp_seconds ${Math.floor(state.last_success / 1000)}`,
    '# TYPE parlance_backup_restored_age_seconds gauge', `parlance_backup_restored_age_seconds ${state.restored_age == null ? -1 : Math.round(state.restored_age)}`, ''].join('\n'));
}).listen(Number(process.env.BACKUP_VERIFY_METRICS_PORT || 9465), '0.0.0.0');

(async function loop() {
  await once();
  setTimeout(loop, hours * 3600000);
})();
