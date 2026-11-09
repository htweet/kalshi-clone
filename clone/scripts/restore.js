#!/usr/bin/env node
'use strict';
// One-command restore (PLAN P9.2, CLONE_SPEC.md §39.3; runbook docs/runbooks/restore.md).
//
//   npm run restore -- --list                                  list snapshots and WAL generations in the backup store
//   npm run restore -- --to 2026-11-09T14:05:00Z --out data/restored.db [--verify] [--force]
//   npm run restore -- --to now --out data/parlance.db --force  restore everything shipped so far over the database
//
// The store is BACKUP_STORAGE (local | local:<folder> | s3 with BACKUP_S3_*), or --from local:<folder>. The backup key is
// BACKUP_KEY / BACKUP_KEY_FILE (BACKUP_KEY_PREVIOUS opens older objects). --verify opens the result and runs the
// integrity, ledger / journal and audit-chain verifiers (the master key must be the deployment's: SECRET_KEY /
// SECRET_KEYRING / the key file next to --out). Stop the server first when the output is the live database file; the
// instance lock (server/db.js) refuses to start a server on it while a restore runs, and this command refuses to write
// over a database a running server holds.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const storageLib = require('../server/storage');
const { restore, backupKeys } = require('../server/backups');
const { verifyDatabase } = require('../server/verify');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[k] = v;
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  const dataDir = path.resolve(a['data-dir'] || path.join(__dirname, '..', 'data'));
  const spec = a.from || process.env.BACKUP_STORAGE || 'local';
  const storage = storageLib.fromEnv({ spec, defaultDir: path.join(dataDir, 'backups'), envPrefix: 'BACKUP_' });
  const keys = backupKeys({ dir: dataDir });
  if (a.list) {
    const objs = (await storage.list('')).filter((o) => o.key.endsWith('.json') && (o.key.startsWith('snapshots/') || o.key.startsWith('wal/')));
    for (const o of objs) {
      const m = JSON.parse((await storage.get(o.key)).toString('utf8'));
      console.log(m.type === 'snapshot' ? `snapshot  ${new Date(m.ts).toISOString()}  ${m.kind.padEnd(14)} ${String(m.bytes).padStart(12)} B  generation ${m.wal_generation ?? '-'}  ${o.key.slice(0, -5)}`
        : `wal       ${new Date(m.ts).toISOString()}  generation ${m.generation} frames ${m.first_frame}+${m.frames}`);
    }
    return;
  }
  if (!a.out) throw new Error('--out <file> is required (and --to <ISO time | now>)');
  const out = path.resolve(String(a.out));
  const to = a.to && a.to !== 'now' && a.to !== true ? Date.parse(String(a.to)) : Date.now();
  if (!Number.isFinite(to)) throw new Error(`--to: not a time: ${a.to}`);
  if (fs.existsSync(`${out}.instance`)) {
    // A running server holds an exclusive lock on <db>.instance (server/db.js); probe it.
    const probe = new DatabaseSync(`${out}.instance`);
    try { probe.exec('PRAGMA locking_mode = EXCLUSIVE'); probe.exec('BEGIN EXCLUSIVE'); probe.exec('ROLLBACK'); } catch { throw new Error(`a Parlance server is running on ${out}: stop it (or switch on read-only mode and stop it) before restoring over it`); } finally { probe.close(); }
  }
  const r = await restore({ storage, outFile: out, targetTs: to, keyDir: path.dirname(out), force: !!a.force, keys, log: (x) => console.error(JSON.stringify(x)) });
  console.log(`Restored ${out}\n  snapshot ${r.snapshot.key} (${r.snapshot.time})\n  WAL: ${r.segments} segment(s) in ${r.generations} generation(s); reached ${new Date(r.reached_ts).toISOString()} (asked ${new Date(r.target_ts).toISOString()})`);
  if (a.verify) {
    const d = new DatabaseSync(out);
    try {
      const v = verifyDatabase(d, { keyDir: path.dirname(out) });
      for (const [k, c] of Object.entries(v.checks)) console.log(`  verify ${k}: ${c.ok ? 'ok' : `FAILED ${JSON.stringify(c).slice(0, 300)}`}`);
      if (!v.ok) process.exitCode = 2;
    } finally { d.close(); }
  }
}

main().catch((e) => { console.error(`restore failed: ${e.message}`); process.exit(1); });
