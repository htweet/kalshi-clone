'use strict';
// Admin › Payments (CLONE_SPEC.md §26.8–§26.9): transactions, reconciliation (provider records vs the ledger, mismatches
// into a queue, resolution with a reason and step-up, audit-chained), AML cases, the double-entry ledger audit, provider
// settings and the webhook log; plus the periodic jobs (ledger audit, reconciliation, credit expiry).
// Permissions reuse the admin role model (server/admin.js): views need users.read (audit.read for the webhook log),
// money-moving or case decisions users.money, settings settings.write.
const { tx } = require('./db');
const { newId, dollars, ApiError, E } = require('./util');
const journal = require('./journal');
const auditChain = require('./audit-chain');
const { check } = require('./validate');

const MIN = 60000;
const RECON_SCHEMA = `
CREATE TABLE IF NOT EXISTS recon_runs (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, trigger TEXT NOT NULL, checked INTEGER NOT NULL, found INTEGER NOT NULL, actor_id TEXT);
CREATE TABLE IF NOT EXISTS recon_items (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, signature TEXT NOT NULL, provider TEXT NOT NULL, provider_ref TEXT, txn_id TEXT, user_id TEXT, kind TEXT NOT NULL,
  expected_cents INTEGER, actual_cents INTEGER, detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', created_ts INTEGER NOT NULL, resolved_ts INTEGER, resolved_by TEXT, resolution TEXT, reason TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_recon_items_status ON recon_items(status, created_ts);
CREATE INDEX IF NOT EXISTS idx_recon_items_sig ON recon_items(signature);
`;
// Provider record status → the transaction statuses that agree with it.
const AGREES = {
  charge: { processing: ['processing'], requires_action: ['requires_action'], succeeded: ['succeeded'], failed: ['failed'] },
  ach_debit: { pending: ['processing', 'pending'], settled: ['settled'], returned: ['returned'] },
  payout: { in_transit: ['processing'], paid: ['paid'], failed: ['failed'] },
  card_payout: { in_transit: ['processing'], paid: ['paid'], failed: ['failed'] },
  crypto_in: { confirming: ['confirming'], confirmed: ['succeeded', 'confirming'] },
  crypto_out: { broadcast: ['processing'], confirmed: ['paid'] },
};
const KIND_TEXT = { missing_in_ledger: 'Provider record with no matching transaction', missing_at_provider: 'Transaction the provider has no record of', amount_mismatch: 'Amounts differ', status_mismatch: 'Statuses disagree', ledger_mismatch: 'Ledger postings differ from the transaction' };

function mountPaymentsAdmin({ v1, db, engine, auth, admin, sandbox, settings, saveSettings, D, AML_ACTIONS, RULE_TEXT, txnVo, pendingPayouts, demoEnabled, sandboxOn, expireCredits, options = {} }) {
  db.exec(RECON_SCHEMA);
  const can = admin.can;
  const A = '/admin/payments';
  const audit = (req, action, targetType, targetId, before, after, reason) => auditChain.append(db, { actor_id: req ? req.auth.user.id : null, actor_email: req ? req.auth.user.email : null, action, target_type: targetType, target_id: targetId, before, after, reason });
  const reasonOf = (b) => { const r = String(b.reason || '').trim(); if (r.length < 3) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); return r; };

  // ------------------------------------------------------------------ ledger audit
  function runAudit(trigger = 'job') {
    const r = journal.audit(db, { pendingPayouts });
    const id = journal.recordAudit(db, r, trigger);
    if (!r.ok && trigger === 'job' && !options.quiet) console.error(`ledger audit: ${r.problems.length} problem(s) — see Admin › Payments › Ledger audit`);
    return { id, ...r };
  }

  // ------------------------------------------------------------------ reconciliation
  const cashAccounts = (uid) => [journal.accounts.cash(uid), journal.accounts.credits(uid)];
  // Net effect on the user's balance of every journal entry for the transaction (and its hold, and any reconciliation
  // adjustment of it).
  const ledgerNet = (t) => db.prepare(`SELECT COALESCE(SUM(p.amount_cents),0) c FROM journal_postings p JOIN journal_entries e ON e.id=p.entry_id
    WHERE (e.ref IN (?,?) OR (e.kind='adjustment' AND e.ref IN (SELECT id FROM recon_items WHERE txn_id=?))) AND p.account IN (?,?)`).get(t.id, t.hold_id || t.id, t.id, ...cashAccounts(t.user_id)).c;
  // What the transaction's status says that net effect should be.
  function expectedNet(t) {
    if (t.direction === 'deposit') return ['succeeded', 'pending', 'settled'].includes(t.status) ? t.amount_cents : 0;
    return ['held', 'processing', 'paid'].includes(t.status) ? -t.amount_cents : 0; // failed / reversed: refunded
  }
  function reconcile({ trigger = 'job', actor = null, graceMs = options.reconGraceMs ?? 60000 } = {}) {
    const runId = newId('rr_');
    let checked = 0; let found = 0;
    const now = Date.now();
    const add = (it) => {
      const signature = [it.kind, it.provider, it.provider_ref || '', it.txn_id || '', it.expected_cents ?? '', it.actual_cents ?? ''].join('|');
      if (db.prepare("SELECT 1 FROM recon_items WHERE signature=? AND (status='open' OR status='resolved')").get(signature)) return;
      db.prepare('INSERT INTO recon_items(id,run_id,signature,provider,provider_ref,txn_id,user_id,kind,expected_cents,actual_cents,detail,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(newId('rc_'), runId, signature, it.provider, it.provider_ref ?? null, it.txn_id ?? null, it.user_id ?? null, it.kind, it.expected_cents ?? null, it.actual_cents ?? null, it.detail || KIND_TEXT[it.kind], now);
      found += 1;
    };
    tx(db, () => {
      const seen = new Set();
      for (const r of db.prepare('SELECT * FROM sbx_provider_records ORDER BY created_ts').all()) {
        checked += 1;
        const t = r.merchant_ref ? db.prepare('SELECT * FROM payment_transactions WHERE id=?').get(r.merchant_ref) : db.prepare('SELECT * FROM payment_transactions WHERE provider=? AND provider_ref=?').get(r.provider, r.id);
        if (!t) {
          if (r.kind === 'crypto_in' && !db.prepare('SELECT 1 FROM crypto_accounts WHERE address=?').get(r.target)) continue; // not ours
          if (now - r.created_ts > graceMs) add({ kind: 'missing_in_ledger', provider: r.provider, provider_ref: r.id, actual_cents: r.amount_cents });
          continue;
        }
        seen.add(t.id);
        const want = ['payout', 'card_payout', 'crypto_out'].includes(r.kind) ? t.amount_cents - t.fee_cents : t.amount_cents;
        if (r.amount_cents !== want) add({ kind: 'amount_mismatch', provider: r.provider, provider_ref: r.id, txn_id: t.id, user_id: t.user_id, expected_cents: want, actual_cents: r.amount_cents, detail: `provider ${dollars(r.amount_cents)} vs ledger ${dollars(want)}` });
        const ok = (AGREES[r.kind] && AGREES[r.kind][r.status]) || [];
        if (!ok.includes(t.status) && now - r.updated_ts > graceMs) add({ kind: 'status_mismatch', provider: r.provider, provider_ref: r.id, txn_id: t.id, user_id: t.user_id, detail: `provider ${r.status} vs ledger ${t.status}` });
      }
      for (const t of db.prepare("SELECT * FROM payment_transactions WHERE rail<>'demo'").all()) {
        checked += 1;
        if (t.status !== 'held' && t.status !== 'reversed' && !(t.provider_ref && sandbox.record(t.provider_ref)) && now - t.created_ts > graceMs) add({ kind: 'missing_at_provider', provider: t.provider || t.rail, provider_ref: t.provider_ref, txn_id: t.id, user_id: t.user_id, expected_cents: t.amount_cents });
        const exp = expectedNet(t); const act = ledgerNet(t);
        if (exp !== act) add({ kind: 'ledger_mismatch', provider: t.provider || t.rail, provider_ref: t.provider_ref, txn_id: t.id, user_id: t.user_id, expected_cents: exp, actual_cents: act, detail: `status ${t.status} implies ${dollars(exp)}, postings show ${dollars(act)}` });
      }
      db.prepare('INSERT INTO recon_runs(id,ts,trigger,checked,found,actor_id) VALUES(?,?,?,?,?,?)').run(runId, now, trigger, checked, found, actor);
    });
    return { run_id: runId, checked, found };
  }
  const itemVo = (r) => ({ id: r.id, kind: r.kind, kind_label: KIND_TEXT[r.kind] || r.kind, provider: r.provider, provider_ref: r.provider_ref, txn_id: r.txn_id, user_id: r.user_id, email: r.email || null,
    expected_dollars: r.expected_cents == null ? null : dollars(r.expected_cents), actual_dollars: r.actual_cents == null ? null : dollars(r.actual_cents), detail: r.detail, status: r.status,
    created_time: new Date(r.created_ts).toISOString(), resolved_time: r.resolved_ts ? new Date(r.resolved_ts).toISOString() : null, resolution: r.resolution, reason: r.reason });

  // ------------------------------------------------------------------ routes
  v1.get(`${A}/overview`, can('users.read'), (req, res) => {
    const by = db.prepare('SELECT rail, direction, status, COUNT(*) n, COALESCE(SUM(amount_cents),0) c FROM payment_transactions GROUP BY rail, direction, status').all();
    const last = db.prepare('SELECT * FROM ledger_audits ORDER BY ts DESC LIMIT 1').get();
    res.json({
      sandbox: sandboxOn, demo_funds: demoEnabled(), transactions: by.map((r) => ({ rail: r.rail, direction: r.direction, status: r.status, count: r.n, amount_dollars: dollars(r.c) })),
      open_reconciliation_items: db.prepare("SELECT COUNT(*) c FROM recon_items WHERE status='open'").get().c, open_aml_cases: db.prepare("SELECT COUNT(*) c FROM aml_cases WHERE status IN ('open','escalated')").get().c,
      last_audit: last ? { time: new Date(last.ts).toISOString(), ok: !!last.ok, problems: JSON.parse(last.problems).length } : null,
      webhooks: Object.fromEntries(db.prepare('SELECT outcome, COUNT(*) c FROM webhook_log WHERE ts>? GROUP BY outcome').all(Date.now() - 86400000).map((r) => [r.outcome, r.c])),
      accounts: Object.fromEntries(db.prepare("SELECT account, balance_cents b FROM journal_balances WHERE account NOT LIKE 'user:%' AND account NOT LIKE 'escrow:%' ORDER BY account").all().map((r) => [r.account, dollars(r.b)])),
    });
  });
  v1.get(`${A}/transactions`, can('users.read'), (req, res) => {
    const where = []; const args = [];
    if (req.query.status) { where.push('t.status=?'); args.push(String(req.query.status)); }
    if (req.query.rail) { where.push('t.rail=?'); args.push(String(req.query.rail)); }
    if (req.query.user) { where.push('(u.id=? OR u.email=?)'); args.push(String(req.query.user), String(req.query.user).toLowerCase()); }
    const rows = db.prepare(`SELECT t.*, u.email FROM payment_transactions t JOIN users u ON u.id=t.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_ts DESC LIMIT 500`).all(...args);
    res.json({ transactions: rows.map((t) => ({ ...txnVo(t), user_id: t.user_id, email: t.email, provider: t.provider, provider_ref: t.provider_ref })) });
  });

  v1.get(`${A}/reconciliation`, can('users.read'), (req, res) => {
    const status = ['open', 'resolved', 'all'].includes(String(req.query.status)) ? String(req.query.status) : 'open';
    const items = db.prepare(`SELECT r.*, u.email FROM recon_items r LEFT JOIN users u ON u.id=r.user_id ${status === 'all' ? '' : 'WHERE r.status=?'} ORDER BY r.created_ts DESC LIMIT 500`).all(...(status === 'all' ? [] : [status]));
    const runs = db.prepare('SELECT * FROM recon_runs ORDER BY ts DESC LIMIT 20').all().map((r) => ({ id: r.id, time: new Date(r.ts).toISOString(), trigger: r.trigger, checked: r.checked, found: r.found }));
    res.json({ items: items.map(itemVo), runs });
  });
  v1.post(`${A}/reconciliation/run`, can('users.money'), (req, res) => {
    const r = reconcile({ trigger: 'manual', actor: req.auth.user.id, graceMs: options.reconGraceMs ?? 0 });
    audit(req, 'payments.recon_run', 'payments', r.run_id, null, r, 'manual reconciliation run');
    res.json(r);
  });
  v1.post(`${A}/reconciliation/:id/resolve`, can('users.money'), (req, res) => {
    const b = check(req.body, { resolution: { type: 'string', enum: ['acknowledge', 'adjust_user'], required: true }, reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
    const reason = reasonOf(b);
    const it = db.prepare('SELECT * FROM recon_items WHERE id=?').get(String(req.params.id));
    if (!it) throw E.notFound();
    if (it.status !== 'open') throw E.conflict('recon_item_closed', 'this item was already resolved');
    let adjustment = null;
    if (b.resolution === 'adjust_user') {
      // The provider is authoritative for a deposit amount: post the difference to the user's balance.
      const t = it.txn_id && db.prepare('SELECT * FROM payment_transactions WHERE id=?').get(it.txn_id);
      if (it.kind !== 'amount_mismatch' || !t || t.direction !== 'deposit' || !['succeeded', 'pending', 'settled'].includes(t.status)) throw new ApiError(409, 'adjustment_not_applicable', 'a balance adjustment only applies to an amount mismatch on a credited deposit');
      adjustment = it.actual_cents - it.expected_cents;
    }
    auth.assertFresh(req, 'payments_recon_resolve');
    tx(db, () => {
      if (db.prepare("UPDATE recon_items SET status='resolved', resolved_ts=?, resolved_by=?, resolution=?, reason=? WHERE id=? AND status='open'").run(Date.now(), req.auth.user.id, b.resolution, reason, it.id).changes !== 1) throw E.conflict('recon_item_closed', 'this item was already resolved');
      if (adjustment) {
        engine.credit(it.user_id, adjustment, 'adjustment', it.id, `Reconciliation adjustment (${it.provider_ref})`, { contra: `clearing:${it.provider.replace(/^sandbox_/, '')}` });
        db.prepare('UPDATE payment_transactions SET amount_cents=amount_cents+?, updated_ts=? WHERE id=?').run(adjustment, Date.now(), it.txn_id);
      }
      audit(req, `payments.recon_${b.resolution}`, 'recon_item', it.id, { status: 'open', kind: it.kind, expected_cents: it.expected_cents, actual_cents: it.actual_cents }, { status: 'resolved', resolution: b.resolution, adjustment_cents: adjustment }, reason);
    });
    if (adjustment) engine.emit('user_balance', it.user_id, engine.balance(it.user_id));
    res.json({ item: itemVo(db.prepare('SELECT * FROM recon_items WHERE id=?').get(it.id)) });
  });

  const caseVo = (c) => ({ id: c.id, user_id: c.user_id, email: c.email || null, rule: c.rule, rule_label: RULE_TEXT[c.rule] || c.rule, status: c.status, action: c.action, detail: JSON.parse(c.detail || '{}'), txn_id: c.txn_id, hold_id: c.hold_id,
    hold_status: c.hold_id ? db.prepare('SELECT status FROM withdrawal_holds WHERE id=?').get(c.hold_id)?.status || null : null, created_time: new Date(c.created_ts).toISOString(), updated_time: new Date(c.updated_ts).toISOString(), outcome: c.outcome, reason: c.reason });
  v1.get(`${A}/aml_cases`, can('users.read'), (req, res) => {
    const status = String(req.query.status || 'open');
    const where = status === 'all' ? '' : status === 'open' ? "WHERE c.status IN ('open','escalated')" : 'WHERE c.status=?';
    const rows = db.prepare(`SELECT c.*, u.email FROM aml_cases c JOIN users u ON u.id=c.user_id ${where} ORDER BY c.created_ts DESC LIMIT 500`).all(...(where.includes('?') ? [status] : []));
    res.json({ cases: rows.map(caseVo) });
  });
  v1.post(`${A}/aml_cases/:id/:action`, can('users.money'), (req, res) => {
    const action = String(req.params.action);
    if (!['close', 'escalate'].includes(action)) throw E.notFound();
    const b = check(req.body, { reason: { type: 'string', maxLen: 500, required: true }, outcome: { type: 'string', enum: ['no_issue', 'reported', 'account_restricted'] } }, { unknown: 'reject' });
    const reason = reasonOf(b);
    const c = db.prepare('SELECT * FROM aml_cases WHERE id=?').get(String(req.params.id));
    if (!c) throw E.notFound();
    if (c.status === 'closed') throw E.conflict('aml_case_closed', 'this case is closed');
    if (action === 'close' && c.hold_id && db.prepare("SELECT 1 FROM withdrawal_holds WHERE id=? AND status='held'").get(c.hold_id)) throw new ApiError(409, 'hold_undecided', 'release or reverse the held withdrawal first (Fraud & holds)');
    auth.assertFresh(req, 'aml_case_decision');
    const next = action === 'close' ? 'closed' : 'escalated';
    tx(db, () => {
      db.prepare('UPDATE aml_cases SET status=?, outcome=?, reason=?, decided_by=?, updated_ts=? WHERE id=?').run(next, action === 'close' ? b.outcome || 'no_issue' : c.outcome, reason, req.auth.user.id, Date.now(), c.id);
      audit(req, `aml.case_${action}`, 'aml_case', c.id, { status: c.status }, { status: next, outcome: b.outcome || null, user: c.user_id, rule: c.rule }, reason);
    });
    res.json({ case: caseVo(db.prepare('SELECT * FROM aml_cases WHERE id=?').get(c.id)) });
  });

  v1.get(`${A}/ledger_audit`, can('users.read'), (req, res) => {
    const live = journal.audit(db, { pendingPayouts });
    const history = db.prepare('SELECT * FROM ledger_audits ORDER BY ts DESC LIMIT 20').all().map((r) => ({ id: r.id, time: new Date(r.ts).toISOString(), ok: !!r.ok, entries: r.entries, problems: JSON.parse(r.problems).length, trigger: r.trigger }));
    res.json({ live: { ...live, totals: Object.fromEntries(Object.entries(live.totals).map(([k, v]) => [k, dollars(v)])) }, history });
  });
  v1.post(`${A}/ledger_audit/run`, can('users.money'), (req, res) => {
    const r = runAudit('manual');
    audit(req, 'payments.ledger_audit', 'payments', r.id, null, { ok: r.ok, entries: r.entries, problems: r.problems.length }, 'manual ledger audit');
    res.json({ id: r.id, ok: r.ok, entries: r.entries, problems: r.problems, accounts_checked: r.accounts_checked });
  });

  // Settings: rails on/off, limits, fees, confirmations, cooling, credits, sandbox timings, AML rule actions.
  const NUM = (min, max) => ({ min, max });
  const FIELDS = {
    'limits.min_cents': NUM(1, 100000), 'limits.card_deposit_max_cents': NUM(100, 100000000), 'limits.bank_deposit_max_cents': NUM(100, 100000000), 'limits.card_withdrawal_max_cents': NUM(100, 100000000),
    'limits.crypto_withdrawal_max_cents': NUM(100, 100000000), 'limits.withdrawal_day_cents': NUM(100, 1000000000), 'limits.withdrawal_month_cents': NUM(100, 10000000000),
    'fees.crypto_network_fee_cents': NUM(0, 10000), 'crypto.confirmations': NUM(1, 100), 'crypto.address_cooling_hours': NUM(0, 720), 'credits.expiry_days': NUM(1, 3650),
    'sandbox.ach_settle_seconds': NUM(0, 86400 * 5), 'sandbox.payout_seconds': NUM(0, 86400 * 5), 'sandbox.block_seconds': NUM(0, 3600),
    'aml.structuring.threshold_cents': NUM(100, 1000000000), 'aml.structuring.band_pct': NUM(1, 50), 'aml.structuring.count': NUM(2, 50), 'aml.structuring.window_hours': NUM(1, 720),
    'aml.rapid_in_out.pct': NUM(1, 100), 'aml.rapid_in_out.window_hours': NUM(1, 720),
  };
  const ACTIONS = ['aml.structuring.action', 'aml.rapid_in_out.action', 'aml.new_crypto_address.action'];
  const BOOLS = ['rails.card', 'rails.bank', 'rails.crypto'];
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const setPath = (o, p, v) => { const ks = p.split('.'); let x = o; for (const k of ks.slice(0, -1)) { x[k] = x[k] && typeof x[k] === 'object' ? { ...x[k] } : {}; x = x[k]; } x[ks[ks.length - 1]] = v; };
  v1.get(`${A}/settings`, can('settings.write'), (req, res) => res.json({ settings: settings(), defaults: D, aml_actions: AML_ACTIONS, sandbox: sandboxOn, demo_funds: demoEnabled() }));
  v1.put(`${A}/settings`, can('settings.write'), (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const reason = reasonOf(b);
    const before = settings();
    const saved = JSON.parse(db.prepare("SELECT value FROM admin_settings WHERE key='payments'").get()?.value || '{}');
    const errs = {};
    const flat = {};
    const walk = (o, pre = '') => { for (const [k, v] of Object.entries(o || {})) { const p = pre ? `${pre}.${k}` : k; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p); else flat[p] = v; } };
    walk(b.settings || {});
    for (const [p, v] of Object.entries(flat)) {
      if (FIELDS[p]) { if (!Number.isInteger(v) || v < FIELDS[p].min || v > FIELDS[p].max) errs[p] = `must be a whole number from ${FIELDS[p].min} to ${FIELDS[p].max}`; else setPath(saved, p, v); }
      else if (ACTIONS.includes(p)) { if (!AML_ACTIONS.includes(v)) errs[p] = `must be one of ${AML_ACTIONS.join(', ')}`; else setPath(saved, p, v); }
      else if (BOOLS.includes(p)) { if (typeof v !== 'boolean') errs[p] = 'must be true or false'; else setPath(saved, p, v); }
      else if (p === 'demo_funds') { if (v !== null && typeof v !== 'boolean') errs[p] = 'must be true, false or null'; else if (v && process.env.NODE_ENV === 'production') errs[p] = 'demo funds cannot be turned on in production'; else saved.demo_funds = v; }
      else errs[p] = 'is not a setting';
    }
    if (Object.keys(errs).length) throw new (require('./validate').ValidationError)(errs);
    auth.assertFresh(req, 'payments_settings');
    tx(db, () => {
      saveSettings(saved, req.auth.user.id);
      const after = settings();
      const changed = Object.keys(flat).map((p) => ({ field: p, from: getPath(before, p), to: getPath(after, p) }));
      audit(req, 'payments.settings', 'settings', 'payments', Object.fromEntries(changed.map((c) => [c.field, c.from])), Object.fromEntries(changed.map((c) => [c.field, c.to])), reason);
    });
    res.json({ settings: settings() });
  });

  v1.get(`${A}/webhooks`, can('audit.read'), (req, res) => {
    const log = db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 300').all().map((r) => ({ id: r.id, time: new Date(r.ts).toISOString(), provider: r.provider, event_id: r.event_id, type: r.type, outcome: r.outcome, reason: r.reason, ip: r.ip }));
    const outbox = sandbox.outbox(100).map((o) => ({ id: o.id, provider: o.provider, type: o.type, status: o.status, attempts: o.attempts, last_status: o.last_status, last_error: o.last_error, created_time: new Date(o.created_ts).toISOString(), delivered_time: o.delivered_ts ? new Date(o.delivered_ts).toISOString() : null }));
    res.json({ log, outbox });
  });
  // Sandbox chain: produce blocks now (confirmations for incoming transfers, withdrawals confirmed).
  v1.post(`${A}/sandbox/crypto/mine`, can('users.money'), (req, res) => {
    const b = check(req.body, { blocks: { type: 'integer', min: 1, max: 20 } }, { unknown: 'reject' });
    if (!sandboxOn) throw new ApiError(403, 'rail_disabled', 'the sandbox rails are off');
    const n = sandbox.crypto.mine(b.blocks || 1);
    audit(req, 'payments.sandbox_mine', 'payments', 'sandbox_crypto', null, { blocks: n }, 'sandbox blocks');
    sandbox.tick();
    res.json({ blocks: n });
  });

  // ------------------------------------------------------------------ jobs
  const timers = [];
  const every = (ms, fn) => { if (!(ms > 0)) return; const t = setInterval(() => { try { fn(); } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('payments job', e.message); } }, ms); t.unref?.(); timers.push(t); };
  every(options.auditIntervalMs ?? 10 * MIN, () => runAudit('job'));
  every(options.reconIntervalMs ?? 15 * MIN, () => reconcile({ trigger: 'job' }));
  every(options.creditPollMs ?? MIN, () => expireCredits());
  return { runAudit, reconcile, stop: () => { for (const t of timers) clearInterval(t); } };
}

module.exports = { mountPaymentsAdmin };
