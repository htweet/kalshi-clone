'use strict';
// Database verifiers (PLAN P9.2 restore drill, §8 item 6; CLONE_SPEC.md §39.3). Run against the live database (Admin ›
// System, the readiness checks) and against restored copies (restore drill, the restore command, the migration fixtures):
//   integrity    PRAGMA integrity_check + foreign_key_check
//   journal      the double-entry ledger audit (server/journal.js: balanced entries, materialised balances, users,
//                reservations, holds, escrow, fees, trial balance)
//   perps        the Perps journal audit (server/perps-ledger.js), when Perps tables exist
//   audit_chain  the hash-chained admin audit log (server/audit-chain.js) — needs the deployment's master key
//   anchor       the chain against the latest signed anchor (RS5, server/anchors.js): a database rewritten after the
//                anchor (rows removed or re-chained) no longer contains the anchored row with the anchored hash
const journal = require('./journal');
const PL = require('./perps-ledger');
const auditChain = require('./audit-chain');

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

function verifyDatabase(db, { keyDir, anchor = null, skip = [] } = {}) {
  const checks = {};
  const run = (name, fn) => {
    if (skip.includes(name)) return;
    try { checks[name] = fn(); } catch (e) { checks[name] = { ok: false, error: e.message }; }
  };
  run('integrity', () => {
    const ic = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    return { ok: ic.length === 1 && ic[0] === 'ok' && fk.length === 0, integrity: ic.slice(0, 5), foreign_key_violations: fk.length };
  });
  run('journal', () => { const r = journal.audit(db); return { ok: r.ok, entries: r.entries, problems: r.problems.slice(0, 10) }; });
  if (hasTable(db, 'perp_journal_postings')) run('perps', () => { const r = PL.audit(db); return { ok: r.ok, problems: (r.problems || []).slice(0, 10) }; });
  if (hasTable(db, 'admin_audit')) {
    run('audit_chain', () => {
      // A copy restored elsewhere gets its own key cache entry; the key comes from SECRET_KEY / the key file of keyDir.
      auditChain.init(db, { keyDir });
      const r = auditChain.verify(db);
      return { ok: r.ok, checked: r.checked, problem: r.problem || null };
    });
    if (anchor) {
      run('anchor', () => {
        const row = db.prepare('SELECT chain_seq, hash FROM admin_audit WHERE chain_seq=?').get(anchor.chain_seq);
        const ok = !!row && row.hash === anchor.chain_hash;
        return { ok, anchor_seq: anchor.chain_seq, detail: ok ? 'chain contains the anchored row' : row ? 'anchored row has a different hash (rewritten)' : 'anchored row is missing (rows deleted)' };
      });
    }
  }
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}

module.exports = { verifyDatabase };
