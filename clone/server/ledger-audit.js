'use strict';
// The full ledger audit off the request thread (database growth fix 2026-11-13, CLONE_SPEC.md §39.17).
//
// journal.audit (server/journal.js) groups every journal posting by entry and by account, and the module checks it runs
// (the Perps sub-journal, play-mode isolation) read their own whole tables. On a long-running database (millions of
// postings) that took seconds of CPU; the 10-minute audit job, Admin › Payments › Ledger audit and Admin › Perps ops ›
// Ledger ran it on the thread that answers every request, so the site froze while it ran. Here the same audit runs in
// the operations worker (server/ops-worker.js) on a read-only connection inside one read transaction (a consistent WAL
// snapshot); the caller records the result on the request thread. The module checks are plain functions of the database
// so the worker runs exactly what the server's in-process hooks run: a database names the checks it has
// (journal.enableCheck, set when Perps / play mode are mounted on it) and the worker applies the same list.
// An in-memory database (tests) or an unavailable worker falls back to the request thread with identical results.
const path = require('node:path');
const journal = require('./journal');
const PL = require('./perps-ledger');

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const MINT = 'play:mint';

// Expected balance of payouts:<rail>: accepted withdrawals not yet paid out by the provider, net of their fees.
function pendingPayouts(db, rail) {
  return db.prepare("SELECT COALESCE(SUM(amount_cents-fee_cents),0) c FROM payment_transactions WHERE rail=? AND direction='withdrawal' AND status='processing'").get(rail).c;
}

// ---- the module checks (pure functions of the database and the main journal's posting sums `got`)
// Perps (CLONE_SPEC.md §34.6): the sub-journal audit, its problems shown in cents.
function perpsChecks(db, got) {
  const r = PL.audit(db, { mainGot: got });
  return r.problems.map((p) => ({ ...p, expected_cents: p.expected_cc != null ? p.expected_cc / 100 : p.expected_ucc != null ? p.expected_ucc / 10000 : 0, actual_cents: p.actual_cc != null ? p.actual_cc / 100 : p.actual_ucc != null ? p.actual_ucc / 10000 : 0 }));
}
// Play mode (CLONE_SPEC.md §33): every entry of the current epoch carries the current money mode; a real-money epoch
// holds no play-money postings; the Central Bank vault is never overdrawn.
function playModeChecks(db, got) {
  const metaGet = (k) => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value;
  const md = metaGet('money_mode') || 'real'; const ep = metaGet('money_epoch') || 'genesis';
  const problems = [];
  const mixed = db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE money_epoch=? AND money_mode<>?').get(ep, md).c
    + (hasTable(db, 'perp_journal_entries') ? db.prepare('SELECT COUNT(*) c FROM perp_journal_entries WHERE money_epoch=? AND money_mode<>?').get(ep, md).c : 0);
  if (mixed) problems.push({ check: 'money_mode_mixed', expected_cents: 0, actual_cents: mixed, detail: `entries of epoch ${ep} written in another money mode` });
  if (md === 'real') { const minted = db.prepare('SELECT COALESCE(SUM(p.amount_cents),0) c FROM journal_postings p JOIN journal_entries e ON e.id=p.entry_id WHERE e.money_epoch=? AND p.account=?').get(ep, MINT).c; if (minted) problems.push({ check: 'play_money_in_real_epoch', account: MINT, expected_cents: 0, actual_cents: minted, detail: 'play money minted during a real-money epoch' }); }
  if (got('bank:vault') < 0) problems.push({ check: 'vault_non_negative', account: 'bank:vault', expected_cents: 0, actual_cents: got('bank:vault'), detail: 'the Central Bank vault is overdrawn' });
  return problems;
}
const CHECKS = { perps: perpsChecks, play_mode: playModeChecks };

// The audit with an explicit list of module checks (the worker's path; also usable on any database).
function auditWith(db, { checks = [], payments = true } = {}) {
  const extraChecks = checks.map((n) => CHECKS[n]).filter(Boolean);
  const pp = payments && hasTable(db, 'payment_transactions') ? (rail) => pendingPayouts(db, rail) : null;
  return journal.audit(db, { pendingPayouts: pp, hooks: false, extraChecks });
}
// Admin › Perps ops › Ledger: the Perps audit (with the bridge to the main journal) and the house balances.
function perpsLedger(db) {
  const a = PL.audit(db, { mainGot: (x) => journal.postingSum(db, x) });
  return { audit: a, insurance_cc: PL.balanceOf(db, PL.H.insurance), backstop_cc: PL.balanceOf(db, PL.H.backstop), fees_cc: PL.balanceOf(db, PL.H.fees) };
}

// ---- the request-thread side: run in the worker when the database is a file, else here.
const fileOf = (db) => (db && db.__file ? db.__file : null);
let opsWorker = null;
const worker = () => (opsWorker = opsWorker || require('./ops-worker'));
// `payments`: whether the payouts check applies (the payments module is mounted). Resolves to journal.audit's result.
async function runAudit(db, { payments = true, inline = false } = {}) {
  const file = fileOf(db);
  if (file && !inline) {
    try { return await worker().run('ledgerAudit', { dbFile: path.resolve(file), checks: journal.enabledChecks(db), payments }); } catch (e) { if (!/worker/i.test(e.message)) throw e; }
  }
  return journal.audit(db, { pendingPayouts: payments && hasTable(db, 'payment_transactions') ? (rail) => pendingPayouts(db, rail) : null });
}
async function runPerpsLedger(db, { inline = false } = {}) {
  const file = fileOf(db);
  if (file && !inline) {
    try { return await worker().run('perpsLedger', { dbFile: path.resolve(file) }); } catch (e) { if (!/worker/i.test(e.message)) throw e; }
  }
  return perpsLedger(db);
}

module.exports = { pendingPayouts, perpsChecks, playModeChecks, CHECKS, auditWith, perpsLedger, runAudit, runPerpsLedger, MINT };
