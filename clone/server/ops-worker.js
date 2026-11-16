'use strict';
// Heavy operations work off the request thread (performance fix 2026-11-09, CLONE_SPEC.md §39.15). Sealing a database
// snapshot (read, AES-256-GCM, two SHA-256), a restore drill (restore + integrity, ledger, perps and audit-chain
// verification) and the live verifiers (ledger audit and audit chain over the whole database) are proportional to the
// database size: on a long-running database they took seconds of CPU on the one thread that also answers every request,
// so pages timed out while they ran. They now run in one worker thread, started on first use and unref'd so it never
// keeps the process alive. The worker opens its own connections (read-only for the live database: WAL mode gives it a
// consistent snapshot while the server keeps writing) and its own storage driver from a plain config.
// Database growth fix (2026-11-13, CLONE_SPEC.md §39.17): snapshots are sealed and uploaded as streams (memory bounded
// whatever the database size), and the ledger audit (scheduled and Admin › Payments) and the Perps ledger page run here too.
//
// Client: run(task, args, transfer?) → Promise. Every task falls back to the calling thread when no worker can be used
// (an in-memory database, an injected storage driver, or the worker failing to start), so behaviour never depends on it.
const path = require('node:path');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');

// ------------------------------------------------------------------------------------------------ the tasks
const tasks = {
  // Seals a database file into `out` as a stream (PLXB2, server/backups.js): { plain_sha256, sha256, bytes }. Memory stays
  // at about one chunk whatever the database size (CLONE_SPEC.md §39.17).
  sealFile({ file, out, keyHex, keyId }) {
    const { sealFile } = require('./backups');
    return sealFile(file, out, { active: Buffer.from(keyHex, 'hex'), activeId: keyId });
  },
  // Streams a file into the store rebuilt from its config (local: a rename; S3: a streamed PUT or a multipart upload).
  async putFile({ storageConfig, key, src, opts }) {
    const r = await require('./storage').create(storageConfig).putFile(key, src, opts);
    return { size: r.size, etag: r.etag };
  },
  // Restore the newest snapshot (+ WAL) into outFile and verify it.
  async drill({ storageConfig, outFile, keyDir, backupKeys, anchors }) {
    const { DatabaseSync } = require('node:sqlite');
    const storage = require('./storage').create(storageConfig);
    const { restore } = require('./backups');
    const { verifyDatabase } = require('./verify');
    const migrations = require('./migrations');
    const keys = { active: Buffer.from(backupKeys.activeHex, 'hex'), activeId: backupKeys.activeId, all: new Map(backupKeys.all.map(([id, hex]) => [id, Buffer.from(hex, 'hex')])) };
    const r = await restore({ storage, outFile, keyDir, force: true, keys });
    const d = new DatabaseSync(outFile);
    try {
      const head = (() => { try { return d.prepare('SELECT MAX(chain_seq) s FROM admin_audit').get().s || 0; } catch { return 0; } })();
      const anchor = anchors.filter((a) => a.chain_seq <= head).sort((a, b) => b.seq - a.seq)[0] || null;
      const v = verifyDatabase(d, { keyDir, anchor });
      const version = (() => { try { return migrations.version(d); } catch { return null; } })();
      v.checks.schema = { ok: version === migrations.LATEST, version };
      v.ok = Object.values(v.checks).every((c) => c.ok);
      return { restore: r, verify: v };
    } finally { d.close(); }
  },
  // The ledger audit (journal + the database's module checks + pending payouts) on a read-only snapshot
  // (server/ledger-audit.js, CLONE_SPEC.md §39.17).
  // Incremental (soak finding 2026-11-16, CLONE_SPEC.md §39.20 item 9): the posting sums recounted by the previous run
  // of this database are kept here and only newer postings are read, so the read snapshot no longer grows with the
  // journal (at 40 orders/s it held the WAL for 1.6 s after 30 minutes, and kept growing). `full`, the first run after
  // the worker starts and any run FULL_AUDIT_MS after the last full one recount every posting.
  ledgerAudit({ dbFile, checks, payments, full = false }) {
    const c = auditPrefix.get(dbFile);
    const prefix = !full && c && Date.now() - c.fullTs < FULL_AUDIT_MS ? c : null;
    return readSnapshot(dbFile, (d) => require('./ledger-audit').auditWith(d, { checks, payments, prefix,
      onPrefix: (p) => auditPrefix.set(dbFile, { ...p, fullTs: prefix ? c.fullTs : Date.now() }) }));
  },
  // Admin › Perps ops › Ledger.
  perpsLedger({ dbFile }) {
    return readSnapshot(dbFile, (d) => require('./ledger-audit').perpsLedger(d));
  },
  // The live verifiers on a read-only connection to the server's database file.
  verifyLive({ dbFile, keyDir }) {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(dbFile, { readOnly: true });
    try {
      d.exec('PRAGMA busy_timeout = 5000');
      d.exec('BEGIN'); // one consistent snapshot for both checks
      const c = auditPrefix.get(dbFile); // the ledger audit's recount (incremental, as in ledgerAudit)
      const prefix = c && Date.now() - c.fullTs < FULL_AUDIT_MS ? c : null;
      return liveChecks(d, { keyDir, readOnly: true, audit: { prefix, onPrefix: (p) => auditPrefix.set(dbFile, { ...p, fullTs: prefix ? c.fullTs : Date.now() }) } });
    } finally { try { d.exec('COMMIT'); } catch { /* read-only snapshot */ } d.close(); }
  },
};
// WAL checkpoints off the request thread (soak finding 2026-11-16, CLONE_SPEC.md §39.20 item 9). SQLite's automatic
// checkpoint runs inside the COMMIT of the connection that crosses the threshold — the request thread — and copies the
// WAL into the database file and fsyncs both: at 40 orders/s (~20 MB of WAL a second) that held the event loop for up to
// 2 s whenever the disk was busy, and longer after a reader had held the WAL. The server's connection now never
// checkpoints (server/backups.js switches it off unless WAL shipping owns checkpoints); this task runs PASSIVE
// checkpoints on the worker's own connection: they never take the write lock or wait for a reader, so the request thread
// is never blocked by them. A pass that raced with new commits is repeated while it still makes progress (at most
// `passes` times). SQLite starts the WAL over from its beginning only in a write transaction that began while every frame
// was already copied; with the server committing every few milliseconds that almost never happens on its own (the WAL
// grew without bound in a test). So once a pass has copied every frame and the WAL holds at least `restartFrames`, this
// connection makes that write itself at once — one meta row, in a transaction taken without waiting (busy_timeout 0: when
// the server is writing it is skipped until the next tick) — which restarts the WAL. It holds the write lock only for
// that one-row commit and the new WAL header.
const ckptConns = new Map();
const FULL_AUDIT_MS = 6 * 3600000;
const auditPrefix = new Map(); // dbFile → { upto, sums, fullTs } (the ledger audit's last recount)
function checkpointTask({ dbFile, passes = 6, restartFrames = 1000, walSizeLimitBytes = 64 * 1048576 }) {
  let d = ckptConns.get(dbFile);
  if (!d) {
    const { DatabaseSync } = require('node:sqlite');
    d = new DatabaseSync(dbFile);
    d.exec('PRAGMA busy_timeout = 0');
    d.exec('PRAGMA synchronous = NORMAL'); // the restart commit does not wait for the disk (checkpoints still sync)
    d.exec(`PRAGMA journal_size_limit = ${Number(walSizeLimitBytes)}`); // the restarting connection trims the file
    ckptConns.set(dbFile, d);
  }
  const t0 = Date.now();
  const st = d.prepare('PRAGMA wal_checkpoint(PASSIVE)');
  // A pass reports the frames that were in the WAL when it began (`log`): frames committed while it copied are left for
  // the next pass, which is short. Passes repeat until one finds no new frame (caught up) or a reader stops the copy.
  let r = st.get(); let n = 1; let caughtUp = false;
  while (r.busy === 0 && r.log === r.checkpointed && n < passes) {
    const next = st.get(); n += 1;
    if (next.log === r.log && next.checkpointed === next.log) { caughtUp = true; r = next; break; }
    r = next;
  }
  let restarted = false;
  if (caughtUp && r.log >= restartFrames) {
    try {
      d.exec('BEGIN IMMEDIATE');
      try { d.prepare("INSERT INTO meta(key,value) VALUES('wal_restart_ts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now())); d.exec('COMMIT'); } catch (e) { try { d.exec('ROLLBACK'); } catch { /* none */ } throw e; }
      const after = st.get(); // a restarted WAL holds only that commit's frames
      restarted = after.log < r.log;
    } catch (e) { if (!/locked|busy/i.test(e.message)) throw e; } // the server is writing: next tick
  }
  return { busy: r.busy, log: r.log, checkpointed: r.checkpointed, passes: n, restarted, ms: Date.now() - t0 };
}
function checkpointClose({ dbFile }) {
  auditPrefix.delete(dbFile); // the server closed this database: the next one at this path starts with a full recount
  require('./backups').walShipClose(dbFile); // the WAL shipping connections (pin, checkpoint), when shipping is on
  const d = ckptConns.get(dbFile);
  ckptConns.delete(dbFile);
  if (d) { try { d.close(); } catch { /* already closed */ } }
  return true;
}
tasks.checkpoint = checkpointTask;
// WAL shipping and its checkpoints with shipping on (CLONE_SPEC.md §39.20 item 11; server/backups.js walShipTask): read the
// committed frames, seal and upload them, and checkpoint only what was shipped, on this thread's own connections.
tasks.shipWal = (args) => require('./backups').walShipTask(args);
tasks.checkpointClose = checkpointClose;

// A read-only connection inside one read transaction: every query sees the same WAL snapshot while the server writes.
function readSnapshot(dbFile, fn) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(dbFile, { readOnly: true });
  try {
    d.exec('PRAGMA busy_timeout = 5000');
    d.exec('BEGIN');
    return fn(d);
  } finally { try { d.exec('COMMIT'); } catch { /* read-only snapshot */ } d.close(); }
}
function liveChecks(db, { keyDir, readOnly = false, audit = {} } = {}) {
  const journal = require('./journal');
  const auditChain = require('./audit-chain');
  const checks = {};
  try { const r = journal.audit(db, audit); checks.journal = { ok: r.ok, problems: r.problems.length }; } catch (e) { checks.journal = { ok: false, error: e.message }; }
  try { const r = readOnly ? auditChain.verifyReadOnly(db, { keyDir }) : auditChain.verify(db); checks.audit_chain = { ok: r.ok, checked: r.checked, problem: r.problem || null }; } catch (e) { checks.audit_chain = { ok: false, error: e.message }; }
  return checks;
}

if (!isMainThread && parentPort) {
  parentPort.on('message', async ({ id, task, args }) => {
    try {
      const out = await tasks[task](args);
      const transfer = (out && out.transfer) || [];
      if (out && out.transfer) delete out.transfer;
      parentPort.postMessage({ id, ok: true, out }, transfer);
    } catch (e) { parentPort.postMessage({ id, ok: false, error: e && e.message ? e.message : String(e) }); }
  });
}

// ------------------------------------------------------------------------------------------------ the client
let worker = null; let seq = 0; const pending = new Map(); let broken = false; let busyCount = 0;
function getWorker() {
  if (broken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(path.join(__dirname, 'ops-worker.js'), { env: process.env });
    worker.unref();
    worker.on('message', ({ id, ok, out, error }) => {
      const p = pending.get(id); if (!p) return;
      pending.delete(id); busyCount -= 1; if (!busyCount) worker.unref();
      if (ok) p.resolve(out); else p.reject(new Error(error));
    });
    const fail = (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); busyCount = 0; worker = null; };
    worker.on('error', fail);
    worker.on('exit', (code) => { if (pending.size) fail(new Error(`operations worker exited (${code})`)); worker = null; });
    return worker;
  } catch { broken = true; return null; }
}
// Runs a task in the worker (or here when `inline` or no worker): resolves with its result.
function run(task, args, { inline = false } = {}) {
  const w = inline ? null : getWorker();
  if (!w) return Promise.resolve().then(() => { const out = tasks[task](args); return Promise.resolve(out).then((o) => { if (o && o.transfer) delete o.transfer; return o; }); });
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    busyCount += 1; w.ref(); // keep the process alive while a task is in flight (shutdown waits for it)
    w.postMessage({ id, task, args });
  });
}
async function stop() { const w = worker; worker = null; if (w) await w.terminate().catch(() => {}); }
// Closes the checkpoint connection to `dbFile` wherever it is open (the worker, or this thread after a fallback), without
// starting a worker for it.
async function closeCheckpoints(dbFile) {
  checkpointClose({ dbFile });
  if (worker) await run('checkpointClose', { dbFile }).catch(() => {});
}

module.exports = { run, stop, closeCheckpoints, liveChecks, tasks };
