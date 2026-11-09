'use strict';
// Migration 0002 — operations (PLAN Phase 9A, CLONE_SPEC.md §39.3): the tables behind backups and WAL shipping, restore
// drills, audit-chain anchors, alerts and their contacts, operating-switch approvals, Launch readiness items and
// evidence, the key ring's metadata and rotations; columns for the separate admin origin (sessions), key ids on the audit
// chain, and object-storage keys for CMS media and identity documents.
const SQL = `
CREATE TABLE IF NOT EXISTS ops_backups (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, created_ts INTEGER NOT NULL, finished_ts INTEGER,
  object_key TEXT, bytes INTEGER, sha256 TEXT, plain_sha256 TEXT, key_id TEXT, schema_version INTEGER, wal_generation INTEGER, error TEXT, deleted_ts INTEGER, note TEXT);
CREATE INDEX IF NOT EXISTS idx_ops_backups_ts ON ops_backups(created_ts);
CREATE TABLE IF NOT EXISTS ops_wal_segments (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, first_frame INTEGER NOT NULL, frames INTEGER NOT NULL, last_commit_ts INTEGER NOT NULL,
  object_key TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_ts INTEGER NOT NULL, deleted_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_ops_wal_gen ON ops_wal_segments(generation, first_frame);
CREATE TABLE IF NOT EXISTS ops_restore_drills (id TEXT PRIMARY KEY, started_ts INTEGER NOT NULL, finished_ts INTEGER, status TEXT NOT NULL, backup_id TEXT, target_ts INTEGER,
  segments INTEGER NOT NULL DEFAULT 0, checks_json TEXT, error TEXT, trigger TEXT NOT NULL DEFAULT 'manual', actor_id TEXT);
CREATE TABLE IF NOT EXISTS ops_anchors (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, chain_seq INTEGER NOT NULL, chain_hash TEXT NOT NULL, key_id TEXT NOT NULL, signature TEXT NOT NULL,
  object_key TEXT, shipped_ts INTEGER);
CREATE TABLE IF NOT EXISTS ops_alerts (id TEXT PRIMARY KEY, rule TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, started_ts INTEGER NOT NULL, resolved_ts INTEGER,
  last_sent_ts INTEGER, sends INTEGER NOT NULL DEFAULT 0, detail_json TEXT, test INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_rule ON ops_alerts(rule, status);
CREATE TABLE IF NOT EXISTS ops_alert_contacts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, target_enc TEXT NOT NULL, target_masked TEXT NOT NULL,
  confirmed_ts INTEGER, code_hash TEXT, code_expires_ts INTEGER, last_test_ts INTEGER, last_result TEXT, created_by TEXT, created_ts INTEGER NOT NULL, deleted_ts INTEGER);
CREATE TABLE IF NOT EXISTS ops_approvals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, requested_by TEXT NOT NULL, requested_ts INTEGER NOT NULL,
  decided_by TEXT, decided_ts INTEGER, decision_note TEXT);
CREATE TABLE IF NOT EXISTS ops_launch_items (key TEXT PRIMARY KEY, done INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', done_date TEXT, updated_by TEXT, updated_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ops_evidence (kind TEXT PRIMARY KEY, ts INTEGER NOT NULL, ok INTEGER NOT NULL, summary_json TEXT NOT NULL, recorded_by TEXT);
CREATE TABLE IF NOT EXISTS crypto_keys (kid TEXT PRIMARY KEY, purpose TEXT NOT NULL DEFAULT 'master', status TEXT NOT NULL, fingerprint TEXT NOT NULL, created_ts INTEGER NOT NULL,
  activated_ts INTEGER, retired_ts INTEGER);
CREATE TABLE IF NOT EXISTS crypto_rotations (id TEXT PRIMARY KEY, from_kid TEXT, to_kid TEXT NOT NULL, status TEXT NOT NULL, started_ts INTEGER NOT NULL, finished_ts INTEGER,
  counts_json TEXT, verified_ts INTEGER, error TEXT, actor_id TEXT);
`;
const COLUMNS = [
  ['sessions', 'origin_kind', "TEXT NOT NULL DEFAULT 'site'"], // separate admin origin: 'site' or 'admin' (CLONE_SPEC.md §39.6)
  ['admin_audit', 'key_id', 'TEXT'], // key ring id of the HMAC that sealed the row (NULL = the first key)
  ['cms_media', 'storage_key', 'TEXT'], // object-storage key once the bytes left SQLite (migration 0003)
  ['docv_documents', 'storage_key', 'TEXT'],
];
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

module.exports = {
  id: 2,
  name: 'operations',
  up(db) {
    db.exec(SQL);
    for (const [t, c, def] of COLUMNS) {
      if (!hasTable(db, t)) continue; // created later by its module with the column (cms_media, docv_documents)
      if (!db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
    }
  },
  COLUMNS,
};
