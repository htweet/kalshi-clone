'use strict';
// Heavy operations work off the request thread (performance fix 2026-11-09, CLONE_SPEC.md §39.15). Sealing a database
// snapshot (read, AES-256-GCM, two SHA-256), a restore drill (restore + integrity, ledger, perps and audit-chain
// verification) and the live verifiers (ledger audit and audit chain over the whole database) are proportional to the
// database size: on a long-running database they took seconds of CPU on the one thread that also answers every request,
// so pages timed out while they ran. They now run in one worker thread, started on first use and unref'd so it never
// keeps the process alive. The worker opens its own connections (read-only for the live database: WAL mode gives it a
// consistent snapshot while the server keeps writing) and its own storage driver from a plain config.
//
// Client: run(task, args, transfer?) → Promise. Every task falls back to the calling thread when no worker can be used
// (an in-memory database, an injected storage driver, or the worker failing to start), so behaviour never depends on it.
const path = require('node:path');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');

// ------------------------------------------------------------------------------------------------ the tasks
const tasks = {
  // Reads a snapshot copy and seals it: { body (ArrayBuffer, transferred), plain_sha256, sha256 }.
  sealFile({ file, keyHex, keyId }) {
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const { seal } = require('./backups');
    const plain = fs.readFileSync(file);
    const keys = { active: Buffer.from(keyHex, 'hex'), activeId: keyId };
    const body = seal(plain, keys);
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const out = { plain_sha256: sha(plain), sha256: sha(body), bytes: body.length };
    const ab = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength ? body.buffer : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    return { ...out, body: ab, transfer: [ab] };
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
  // The live verifiers on a read-only connection to the server's database file.
  verifyLive({ dbFile, keyDir }) {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(dbFile, { readOnly: true });
    try {
      d.exec('PRAGMA busy_timeout = 5000');
      d.exec('BEGIN'); // one consistent snapshot for both checks
      return liveChecks(d, { keyDir, readOnly: true });
    } finally { try { d.exec('COMMIT'); } catch { /* read-only snapshot */ } d.close(); }
  },
};
function liveChecks(db, { keyDir, readOnly = false } = {}) {
  const journal = require('./journal');
  const auditChain = require('./audit-chain');
  const checks = {};
  try { const r = journal.audit(db); checks.journal = { ok: r.ok, problems: r.problems.length }; } catch (e) { checks.journal = { ok: false, error: e.message }; }
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

module.exports = { run, stop, liveChecks, tasks };
