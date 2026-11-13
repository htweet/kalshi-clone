#!/usr/bin/env node
'use strict';
// Compaction of an existing database (database growth fix 2026-11-13, CLONE_SPEC.md §39.17; README › Owner guide).
//
//   npm run db:compact                  remove simulated trading history older than 7 days that no member is part of
//   npm run db:compact -- --days 14     keep the last 14 days
//   npm run db:compact -- --dry-run     count what would go and print the sizes; change nothing (no backup needed)
//
// Stop the server first (the instance lock refuses a running database). The database is DB_FILE, else data/parlance.db
// (`--db <file>` overrides). Before changing anything the command takes an encrypted, checksummed backup ("pre_compaction")
// through the normal backup code into the backup store (BACKUP_STORAGE, default data/backups) and refuses to go on
// without it. Then, in one transaction, server/compact.js removes / rolls up the system accounts' history, the full
// ledger audit is compared before and after (any difference rolls everything back), the file is VACUUMed, a fresh
// snapshot of the result is taken ("post_compaction", so point-in-time restores after today start from it) and the run is
// recorded (ops_compactions, the audit chain; Admin › System shows the last one). Sizes before and after are printed.
const path = require('node:path');
const fs = require('node:fs');
const { open } = require('../server/db');
const migrations = require('../server/migrations');
const storageLib = require('../server/storage');
const { createBackups } = require('../server/backups');
const { compact } = require('../server/compact');
const { auditWith } = require('../server/ledger-audit');
const auditChain = require('../server/audit-chain');
const { newId } = require('../server/util');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}
const sizeOf = (file) => [file, `${file}-wal`].reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
// The module checks the server runs on this database (Perps and play mode are part of every server).
const fullAudit = (db) => auditWith(db, { checks: [...(hasTable(db, 'perp_journal_postings') ? ['perps'] : []), 'play_mode'], payments: true });
const fingerprint = (r) => JSON.stringify({ ok: r.ok, problems: r.problems, totals: r.totals });

async function main(argv = process.argv.slice(2), { out = console.log } = {}) {
  const a = args(argv);
  const days = a.days === undefined ? 7 : Number(a.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('--days must be a whole number of days from 1 to 3650');
  const dryRun = !!a['dry-run'];
  const file = path.resolve(String(a.db || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'parlance.db')));
  if (!fs.existsSync(file)) throw new Error(`no database at ${file}`);
  const dataDir = path.dirname(file);
  let db;
  try { db = open(file); } catch (e) { if (e.code === 'DB_IN_USE') throw new Error(`${e.message}\nStop the server first, then run npm run db:compact again.`); throw e; }
  const opsWorker = require('../server/ops-worker');
  try {
    auditChain.init(db, { keyDir: dataDir }); // the deployment's master key (SECRET_KEY / the key file next to the database)
    if (migrations.version(db) !== migrations.LATEST) throw new Error('this database has not been upgraded by this version yet: start the server once (npm start), stop it, then run npm run db:compact');
    const before = sizeOf(file);
    out(`Database ${file}: ${mb(before)}${dryRun ? ' (dry run: nothing is changed)' : ''}`);
    const t0 = Date.now();
    const runId = newId('cpt_');
    const record = (fields) => {
      const cols = Object.keys(fields);
      db.prepare(`INSERT INTO ops_compactions(id,${cols.join(',')}) VALUES(?,${cols.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${cols.map((c) => `${c}=excluded.${c}`).join(',')}`).run(runId, ...cols.map((c) => fields[c]));
    };
    let backupId = null;
    const storage = () => storageLib.fromEnv({ spec: process.env.BACKUP_STORAGE || 'local', defaultDir: path.join(dataDir, 'backups'), envPrefix: 'BACKUP_' });
    const backupsOf = () => createBackups({ db, dbFile: file, storage: storage(), keyDir: dataDir, audit: (x) => auditChain.append(db, { action: x.action, target_type: 'operations', target_id: String(x.target_id || ''), after: x.after, reason: x.reason || '' }), options: { walShipping: true } });
    if (!dryRun) {
      // The backup first: no backup, no compaction.
      out('Taking an encrypted backup first …');
      let b;
      try { const B = backupsOf(); b = await B.snapshot('pre_compaction', { note: `before npm run db:compact --days ${days}` }); await B.flush(); } catch (e) {
        record({ ts: t0, status: 'refused', dry_run: 0, older_than_days: days, cutoff_ts: t0 - days * 86400000, bytes_before: before, error: `backup failed: ${e.message}`.slice(0, 500) });
        throw new Error(`refusing to compact: the backup could not be taken (${e.message}). Fix the backup store (BACKUP_STORAGE, BACKUP_KEY) and try again.`);
      }
      backupId = b.id;
      out(`  backup ${b.object_key} (${mb(b.bytes)}, sha256 ${b.sha256.slice(0, 16)}…)`);
    }
    out('Checking the ledger …');
    const auditBefore = fullAudit(db);
    let counts;
    db.exec('BEGIN IMMEDIATE');
    try {
      counts = compact(db, { olderThanDays: days, now: t0 });
      const auditAfter = fullAudit(db);
      if (fingerprint(auditAfter) !== fingerprint(auditBefore)) throw new Error(`the ledger audit changed (before: ${auditBefore.problems.length} problem(s), after: ${auditAfter.problems.length}); nothing was changed`);
      counts.ledger_audit_ok = auditAfter.ok;
      if (dryRun) db.exec('ROLLBACK'); else db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already */ } throw e; }
    out(`${dryRun ? 'Would remove' : 'Removed'} (older than ${days} days, before ${counts.cutoff}):`);
    out(`  orders that never filled: ${counts.orders_removed}; filled bot-vs-bot orders rolled up: ${counts.orders_rolled_up} (in ${counts.bot_trades} trades, which stay for the charts)`);
    out(`  journal entries: ${counts.journal_entries_removed} (${counts.journal_postings_removed} postings) → ${counts.rollup_entries} balancing entries`);
    out(`  ledger rows: ${counts.ledger_rows_removed} → ${counts.ledger_rollups} daily rows`);
    out(`  ledger audit: ${counts.ledger_audit_ok ? 'clean' : 'unchanged (it had problems before)'}`);
    let after = before;
    if (!dryRun) {
      out('Reclaiming the space (VACUUM) …');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      // These writes were never shipped as WAL: the next generation belongs to the compacted file, and a fresh snapshot of
      // it is its base (restore stops at a missing generation, server/backups.js).
      const st = (() => { try { return JSON.parse(db.prepare("SELECT value FROM meta WHERE key='wal_ship_state'").get()?.value || 'null'); } catch { return null; } })() || { generation: 0 };
      db.prepare("INSERT INTO meta(key,value) VALUES('wal_ship_state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ generation: (st.generation || 0) + 1, salt: '__compacted__', frames: 0 }));
      after = sizeOf(file);
      try { const B = backupsOf(); const p = await B.snapshot('post_compaction', { note: 'after npm run db:compact' }); await B.flush(); out(`  fresh backup of the result: ${p.object_key} (${mb(p.bytes)})`); } catch (e) { out(`  warning: the backup of the result failed (${e.message}); the server takes one 2 minutes after it starts`); }
      after = sizeOf(file);
      auditChain.append(db, { action: 'ops.db_compact', target_type: 'operations', target_id: runId, after: { ...counts, bytes_before: before, bytes_after: after, backup_id: backupId }, reason: `npm run db:compact --days ${days}` });
    }
    record({ ts: t0, finished_ts: Date.now(), status: 'ok', dry_run: dryRun ? 1 : 0, older_than_days: days, cutoff_ts: t0 - days * 86400000, bytes_before: before, bytes_after: after, counts_json: JSON.stringify(counts), backup_id: backupId });
    out(`Size: ${mb(before)} → ${mb(after)}${dryRun ? ' (unchanged: dry run; VACUUM reclaims the space on a real run)' : ''} in ${Math.round((Date.now() - t0) / 1000)} s`);
    return { counts, before, after, backupId, runId };
  } finally {
    db.close();
    await opsWorker.stop();
  }
}

module.exports = { main };
if (require.main === module) main().catch((e) => { console.error(`db:compact: ${e.message}`); process.exit(1); });
