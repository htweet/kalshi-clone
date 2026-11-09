'use strict';
// Versioned schema migrations (PLAN P9.2, CLONE_SPEC.md §39.3).
//
// One ordered list of numbered, forward-only migrations (server/migrations/NNNN-name.js). Each module exports
// { id, name, up(db, ctx), sources? } where `sources` (a function, evaluated lazily to avoid require cycles) lists the functions and SQL texts it runs from other modules, so the
// recorded checksum covers everything the migration executes, not only its own file.
//
// Applied migrations are recorded in `schema_migrations` (id, name, checksum, applied_at, duration_ms, app_version).
// At start:
//   - assertKnown(db) runs right after the database is opened, before seeding: a database recorded at a version this
//     build does not know (a newer build wrote it) is refused, never silently downgraded (`schema_newer`);
//   - a recorded checksum that no longer matches the migration in this build is refused (`schema_checksum`): an applied
//     migration was edited after it shipped — write a new migration instead;
//   - run(db, ctx) applies the pending migrations in order, each inside one IMMEDIATE transaction, under a lock row in
//     `schema_migrations_lock` (a second runner on the same file — normally impossible because of the instance lock in
//     server/db.js — sees the lock and refuses with `migration_locked` unless the lock is older than LOCK_STALE_MS).
// Migration 0001 is the baseline: the idempotent column checks and one-time data upgrades that Phases 0-8 spread over
// fourteen modules, run once in their original order. Its modules keep a `schema(db)` export so they can still be used
// on a database that was opened without the runner (ensureSchema below), e.g. a module unit test.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOCK_STALE_MS = 10 * 60 * 1000;
const FILES = fs.readdirSync(__dirname).filter((f) => /^\d{4}-[a-z0-9-]+\.js$/.test(f)).sort();
const MIGRATIONS = FILES.map((f) => {
  const m = require(path.join(__dirname, f));
  const id = Number(f.slice(0, 4));
  if (m.id !== id) throw new Error(`migration ${f} declares id ${m.id}`);
  return { ...m, file: path.join(__dirname, f) };
});
MIGRATIONS.forEach((m, i) => { if (m.id !== i + 1) throw new Error(`migration ids must be 1..N without gaps (found ${m.id} at position ${i + 1})`); });
const LATEST = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].id : 0;
const APP_VERSION = (() => { try { return require('../../package.json').version; } catch { return '0'; } })();

class MigrationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Line endings are normalised so a Windows checkout (CRLF) computes the same checksum as Linux.
const norm = (s) => String(s).replace(/\r\n?/g, '\n');
function checksum(m) {
  const h = crypto.createHash('sha256');
  h.update(norm(fs.readFileSync(m.file, 'utf8')));
  for (const s of (typeof m.sources === 'function' ? m.sources() : m.sources || [])) h.update('\n--\n').update(norm(typeof s === 'function' ? s.toString() : s));
  return h.digest('hex');
}

function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0, app_version TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS schema_migrations_lock (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, ts INTEGER NOT NULL);`);
}
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const appliedRows = (db) => (hasTable(db, 'schema_migrations') ? db.prepare('SELECT * FROM schema_migrations ORDER BY id').all() : []);
const version = (db) => { const r = appliedRows(db); return r.length ? r[r.length - 1].id : 0; };

// Refuses a database written by a newer build, or one whose applied migrations were edited. Cheap: runs at open().
function assertKnown(db) {
  const rows = appliedRows(db);
  const newer = rows.filter((r) => r.id > LATEST);
  if (newer.length) {
    throw new MigrationError('schema_newer', `This database is at schema version ${newer[newer.length - 1].id} (${newer[newer.length - 1].name}), newer than this build knows (${LATEST}). `
      + 'It was written by a newer version of Parlance; start that version, or restore a backup taken before the upgrade. Refusing to start (no silent downgrade).');
  }
  for (const r of rows) {
    const m = MIGRATIONS[r.id - 1];
    if (m.name !== r.name) throw new MigrationError('schema_checksum', `Migration ${r.id} is recorded as "${r.name}" but this build calls it "${m.name}". Refusing to start.`);
    if (checksum(m) !== r.checksum) {
      throw new MigrationError('schema_checksum', `Migration ${String(r.id).padStart(4, '0')}-${m.name} changed after it was applied to this database (checksum mismatch). `
        + 'Applied migrations are frozen: put the change in a new migration file. Refusing to start.');
    }
  }
  return rows.length ? rows[rows.length - 1].id : 0;
}

function lock(db, holder) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = db.prepare('SELECT * FROM schema_migrations_lock WHERE id=1').get();
    if (cur && Date.now() - cur.ts < LOCK_STALE_MS) {
      throw new MigrationError('migration_locked', `Migrations are being applied by ${cur.holder} (since ${new Date(cur.ts).toISOString()}). Wait for it to finish, or remove the lock row if that process is gone.`);
    }
    db.prepare('INSERT INTO schema_migrations_lock(id,holder,ts) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET holder=excluded.holder, ts=excluded.ts').run(holder, Date.now());
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
}
const unlock = (db) => { try { db.prepare('DELETE FROM schema_migrations_lock WHERE id=1').run(); } catch { /* closed */ } };

// Applies every pending migration. ctx: { keyDir, storage, log } (what migrations may need). Returns the applied ids.
function run(db, ctx = {}) {
  ensureTables(db);
  assertKnown(db);
  const done = new Set(appliedRows(db).map((r) => r.id));
  const pending = MIGRATIONS.filter((m) => !done.has(m.id));
  db.__migrated = true;
  if (!pending.length) return [];
  const holder = `pid ${process.pid}`;
  lock(db, holder);
  const applied = [];
  try {
    for (const m of pending) {
      const t0 = Date.now();
      db.exec('BEGIN IMMEDIATE');
      db.__inTx = true; // server/db.js tx() joins this transaction
      try {
        m.up(db, ctx);
        db.prepare('INSERT INTO schema_migrations(id,name,checksum,applied_at,duration_ms,app_version) VALUES(?,?,?,?,?,?)').run(m.id, m.name, checksum(m), new Date().toISOString(), Date.now() - t0, APP_VERSION);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw new MigrationError('migration_failed', `Migration ${String(m.id).padStart(4, '0')}-${m.name} failed and was rolled back: ${e.message}`);
      } finally { db.__inTx = false; }
      applied.push(m.id);
      if (ctx.log) ctx.log({ msg: 'migration applied', id: m.id, name: m.name, ms: Date.now() - t0 });
    }
  } finally { unlock(db); }
  return applied;
}

const { ensureSchema } = require('./schema-guard');

function status(db) {
  const rows = appliedRows(db);
  return { version: rows.length ? rows[rows.length - 1].id : 0, latest: LATEST, pending: MIGRATIONS.filter((m) => !rows.some((r) => r.id === m.id)).map((m) => `${String(m.id).padStart(4, '0')}-${m.name}`),
    applied: rows.map((r) => ({ id: r.id, name: r.name, applied_at: r.applied_at, duration_ms: r.duration_ms, app_version: r.app_version })) };
}

module.exports = { MIGRATIONS, LATEST, run, assertKnown, ensureSchema, status, version, checksum, MigrationError };
