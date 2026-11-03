// Admin › Payments (CLONE_SPEC.md §26.9): transactions, reconciliation queue (resolve with a reason, step-up, audit chain),
// AML cases (close / escalate; held withdrawals released or reversed through Fraud & holds), the double-entry ledger audit,
// provider settings and the webhook log. Sandbox rails only.
import { esc, get, post, put, toast, dataTable, section, subTabs, fmtTime, fmtMoney, badge, confirmAction } from './ui.js';

const TABS = [['transactions', 'Transactions'], ['reconciliation', 'Reconciliation'], ['aml', 'AML cases'], ['ledger', 'Ledger audit'], ['settings', 'Provider settings'], ['webhooks', 'Webhook log']];
const KIND = { succeeded: 'ok', settled: 'ok', paid: 'ok', pending: '', processing: '', confirming: '', requires_action: 'warn', held: 'warn', failed: 'bad', returned: 'bad', reversed: 'bad', open: 'warn', escalated: 'bad', closed: 'ok', resolved: 'ok', accepted: 'ok', rejected: 'bad', error: 'bad' };
const b = (s) => badge(s, KIND[s] || '');

export async function render(ctx) {
  const tab = TABS.some(([k]) => k === ctx.parts[0]) ? ctx.parts[0] : 'transactions';
  const visible = TABS.filter(([k]) => (k === 'settings' ? ctx.perms.has('settings.write') : k === 'webhooks' ? ctx.perms.has('audit.read') : true));
  ctx.el.innerHTML = `${section('Payments', 'Sandbox rails: test cards, test banks and a test chain. No real money moves.')}${subTabs(visible, tab, '/admin/payments')}<div id="pay-tab" data-testid="admin-payments" data-tab="${esc(tab)}"></div>`;
  const host = ctx.el.querySelector('#pay-tab');
  const fns = { transactions, reconciliation, aml, ledger, settings, webhooks };
  return fns[tab](host, ctx);
}

async function transactions(host) {
  const o = await get('/payments/overview');
  host.innerHTML = `<div class="adm-tiles"><div class="adm-tile"><span>Open reconciliation items</span><b data-testid="tile-recon">${esc(o.open_reconciliation_items)}</b></div><div class="adm-tile"><span>Open AML cases</span><b data-testid="tile-aml">${esc(o.open_aml_cases)}</b></div>
    <div class="adm-tile"><span>Last ledger audit</span><b data-testid="tile-audit">${o.last_audit ? (o.last_audit.ok ? 'balanced' : `${esc(o.last_audit.problems)} problem(s)`) : 'not run yet'}</b></div></div>
    <h3>House and provider accounts</h3><table class="table"><tbody>${Object.entries(o.accounts).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${esc(fmtMoney(v))}</td></tr>`).join('')}</tbody></table><div id="ptx"></div>`;
  const r = await get('/payments/transactions');
  dataTable(host.querySelector('#ptx'), { testid: 'admin-transactions', rows: r.transactions, rowAttrs: (t) => `data-id="${esc(t.id)}" data-status="${esc(t.status)}"`,
    cols: [{ key: 'created_time', label: 'Created', render: (t) => esc(fmtTime(t.created_time)) }, { key: 'email', label: 'Account' }, { key: 'direction', label: 'Type' }, { key: 'rail', label: 'Rail' },
      { key: 'label', label: 'Method' }, { key: 'amount_dollars', label: 'Amount', num: true, render: (t) => esc(fmtMoney(t.amount_dollars)) }, { key: 'status', label: 'Status', render: (t) => b(t.status) }, { key: 'provider_ref', label: 'Provider ref', render: (t) => `<code>${esc(t.provider_ref || '—')}</code>` }] });
}

async function reconciliation(host, { perms }) {
  const draw = async () => {
    const r = await get('/payments/reconciliation?status=all');
    host.innerHTML = `<div class="adm-toolbar">${perms.has('users.money') ? '<button class="btn btn-primary" data-run data-testid="recon-run">Run reconciliation now</button>' : ''}<span class="faint">${r.runs[0] ? `Last run ${esc(fmtTime(r.runs[0].time))}: ${esc(r.runs[0].checked)} records checked, ${esc(r.runs[0].found)} new item(s)` : 'Not run yet'}</span></div><div id="ri"></div>`;
    dataTable(host.querySelector('#ri'), { testid: 'recon-items', rows: r.items, empty: 'Provider records and the ledger agree.', rowAttrs: (x) => `data-id="${esc(x.id)}" data-kind="${esc(x.kind)}" data-status="${esc(x.status)}"`,
      cols: [{ key: 'created_time', label: 'Found', render: (x) => esc(fmtTime(x.created_time)) }, { key: 'kind_label', label: 'Mismatch' }, { key: 'provider', label: 'Provider' }, { key: 'email', label: 'Account', render: (x) => esc(x.email || '—') },
        { key: 'expected_dollars', label: 'Ledger', num: true, render: (x) => esc(x.expected_dollars == null ? '—' : fmtMoney(x.expected_dollars)) }, { key: 'actual_dollars', label: 'Provider', num: true, render: (x) => esc(x.actual_dollars == null ? '—' : fmtMoney(x.actual_dollars)) },
        { key: 'detail', label: 'Detail' }, { key: 'status', label: 'Status', render: (x) => `${b(x.status)}${x.resolution ? `<div class="faint">${esc(x.resolution)}: ${esc(x.reason)}</div>` : ''}` },
        { key: '_a', label: '', sort: false, render: (x) => (x.status === 'open' && perms.has('users.money') ? `<button class="btn btn-sm" data-resolve="${esc(x.id)}" data-kind="${esc(x.kind)}" data-testid="recon-resolve">Resolve</button>` : '') }] });
    host.querySelector('[data-run]')?.addEventListener('click', async () => { try { const x = await post('/payments/reconciliation/run'); toast(`${x.found} new item(s)`); await draw(); } catch (ex) { toast(ex.message, 'error'); } });
    host.querySelector('#ri').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-resolve]');
      if (!btn) return;
      const ok = await confirmAction({ title: 'Resolve this mismatch', body: 'Recorded in the tamper-evident audit log with your reason.', confirm: 'Resolve', reason: true,
        extraHtml: `<label class="field"><span>Resolution</span><select name="resolution" data-testid="recon-resolution"><option value="acknowledge">Acknowledge (no balance change; follow up with the provider)</option>${btn.dataset.kind === 'amount_mismatch' ? '<option value="adjust_user">Adjust the customer balance to the provider amount</option>' : ''}</select></label>` });
      if (!ok) return;
      try { await post(`/payments/reconciliation/${encodeURIComponent(btn.dataset.resolve)}/resolve`, { resolution: ok.form.resolution.value, reason: ok.reason }); toast('Resolved'); await draw(); } catch (ex) { toast(ex.message, 'error'); }
    });
  };
  await draw();
}

async function aml(host, { perms }) {
  const draw = async () => {
    const r = await get('/payments/aml_cases?status=all');
    host.innerHTML = '<p class="muted">Rule hooks: deposits just under the reporting threshold (structuring), withdrawing most of a recent deposit without trading, the first withdrawal to a new crypto address. A rule set to “hold” sends the withdrawal to Fraud &amp; holds.</p><div id="ac"></div>';
    dataTable(host.querySelector('#ac'), { testid: 'aml-cases', rows: r.cases, empty: 'No AML cases.', rowAttrs: (c) => `data-id="${esc(c.id)}" data-rule="${esc(c.rule)}" data-status="${esc(c.status)}"`,
      cols: [{ key: 'created_time', label: 'Opened', render: (c) => esc(fmtTime(c.created_time)) }, { key: 'email', label: 'Account' }, { key: 'rule_label', label: 'Rule' }, { key: 'action', label: 'Action' },
        { key: 'detail', label: 'Detail', sort: false, render: (c) => esc(Object.entries(c.detail).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')) },
        { key: 'hold_status', label: 'Hold', render: (c) => (c.hold_id ? b(c.hold_status || 'held') : '—') }, { key: 'status', label: 'Status', render: (c) => `${b(c.status)}${c.reason ? `<div class="faint">${esc(c.reason)}</div>` : ''}` },
        { key: '_a', label: '', sort: false, render: (c) => (c.status !== 'closed' && perms.has('users.money') ? `${c.hold_id && c.hold_status === 'held' ? `<button class="btn btn-sm" data-hold="${esc(c.hold_id)}" data-act="release" data-testid="aml-release">Release</button> <button class="btn btn-sm" data-hold="${esc(c.hold_id)}" data-act="reverse" data-testid="aml-reverse">Reverse</button> ` : ''}<button class="btn btn-sm" data-case="${esc(c.id)}" data-act="close" data-testid="aml-close">Close</button> ${c.status === 'open' ? `<button class="btn btn-sm btn-ghost" data-case="${esc(c.id)}" data-act="escalate">Escalate</button>` : ''}` : '') }] });
    host.querySelector('#ac').addEventListener('click', async (e) => {
      const h = e.target.closest('[data-hold]'); const c = e.target.closest('[data-case]');
      if (!h && !c) return;
      const act = (h || c).dataset.act;
      const ok = await confirmAction({ title: h ? `${act === 'release' ? 'Release' : 'Reverse'} the held withdrawal` : `${act === 'close' ? 'Close' : 'Escalate'} this case`, confirm: act[0].toUpperCase() + act.slice(1), reason: true,
        extraHtml: c && act === 'close' ? '<label class="field"><span>Outcome</span><select name="outcome"><option value="no_issue">No issue found</option><option value="reported">Reported</option><option value="account_restricted">Account restricted</option></select></label>' : '' });
      if (!ok) return;
      try {
        if (h) await post(`/fraud/holds/${encodeURIComponent(h.dataset.hold)}/${act}`, { reason: ok.reason });
        else await post(`/payments/aml_cases/${encodeURIComponent(c.dataset.case)}/${act}`, { reason: ok.reason, ...(act === 'close' ? { outcome: ok.form.outcome.value } : {}) });
        toast('Done'); await draw();
      } catch (ex) { toast(ex.message, 'error'); }
    });
  };
  await draw();
}

async function ledger(host, { perms }) {
  const draw = async () => {
    const r = await get('/payments/ledger_audit');
    const l = r.live;
    host.innerHTML = `<div class="adm-toolbar">${perms.has('users.money') ? '<button class="btn btn-primary" data-run data-testid="audit-run">Run and record the audit</button>' : ''}</div>
      <p data-testid="audit-result" data-ok="${l.ok ? '1' : '0'}">${l.ok ? badge('balanced', 'ok') : badge(`${l.problems.length} problem(s)`, 'bad')} ${esc(l.entries)} journal entries, ${esc(l.accounts_checked)} accounts checked: every entry sums to zero; cash + credits equal each balance; reservations, holds, market escrow and pending payouts equal their tables.</p>
      ${l.problems.length ? `<table class="table" data-testid="audit-problems"><thead><tr><th>Check</th><th>Account</th><th class="num">Expected</th><th class="num">Actual</th><th>Detail</th></tr></thead><tbody>${l.problems.map((p) => `<tr><td>${esc(p.check)}</td><td><code>${esc(p.account || p.entry_id || '')}</code></td><td class="num">${esc((p.expected_cents / 100).toFixed(2))}</td><td class="num">${esc((p.actual_cents / 100).toFixed(2))}</td><td>${esc(p.detail)}</td></tr>`).join('')}</tbody></table>` : ''}
      <h3>Totals by account</h3><table class="table"><tbody>${Object.entries(l.totals).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${esc(fmtMoney(v))}</td></tr>`).join('')}</tbody></table>
      <h3>Recorded runs</h3><table class="table"><tbody>${r.history.map((h) => `<tr><td>${esc(fmtTime(h.time))}</td><td>${esc(h.trigger)}</td><td>${h.ok ? badge('balanced', 'ok') : badge(`${h.problems} problem(s)`, 'bad')}</td><td class="num">${esc(h.entries)} entries</td></tr>`).join('') || '<tr><td class="faint">No recorded runs yet (the job runs every 10 minutes).</td></tr>'}</tbody></table>`;
    host.querySelector('[data-run]')?.addEventListener('click', async () => { try { const x = await post('/payments/ledger_audit/run'); toast(x.ok ? 'Ledger balanced' : `${x.problems.length} problem(s)`); await draw(); } catch (ex) { toast(ex.message, 'error'); } });
  };
  await draw();
}

async function settings(host) {
  const draw = async () => {
    const { settings: s, aml_actions: acts } = await get('/payments/settings');
    const num = (p, label, v, hint = '') => `<label class="field"><span>${esc(label)}</span><input type="number" name="${esc(p)}" value="${esc(v)}" step="1" data-num>${hint ? `<small class="faint">${esc(hint)}</small>` : ''}</label>`;
    const sel = (p, label, v) => `<label class="field"><span>${esc(label)}</span><select name="${esc(p)}">${acts.map((a) => `<option ${a === v ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>`;
    const chk = (p, label, v) => `<label class="adm-check"><input type="checkbox" name="${esc(p)}" ${v ? 'checked' : ''} data-bool> <span>${esc(label)}</span></label>`;
    host.innerHTML = `<form class="adm-form" data-testid="payments-settings" novalidate><div class="adm-form-grid">
      ${chk('rails.card', 'Card rail on', s.rails.card)}${chk('rails.bank', 'Bank rail on', s.rails.bank)}${chk('rails.crypto', 'Crypto rail on', s.rails.crypto)}
      ${num('limits.withdrawal_day_cents', 'Withdrawal limit per day (cents)', s.limits.withdrawal_day_cents)}${num('limits.withdrawal_month_cents', 'Withdrawal limit per month (cents)', s.limits.withdrawal_month_cents)}
      ${num('limits.card_deposit_max_cents', 'Card deposit maximum (cents)', s.limits.card_deposit_max_cents)}${num('limits.bank_deposit_max_cents', 'Bank deposit maximum (cents)', s.limits.bank_deposit_max_cents)}
      ${num('limits.crypto_withdrawal_max_cents', 'Crypto withdrawal maximum (cents)', s.limits.crypto_withdrawal_max_cents)}${num('fees.crypto_network_fee_cents', 'Crypto network fee (cents)', s.fees.crypto_network_fee_cents)}
      ${num('crypto.confirmations', 'Crypto deposit confirmations', s.crypto.confirmations)}${num('crypto.address_cooling_hours', 'New address cooling period (hours)', s.crypto.address_cooling_hours)}
      ${num('credits.expiry_days', 'Promotional credit lifetime (days)', s.credits.expiry_days)}
      ${num('sandbox.ach_settle_seconds', 'Sandbox ACH settlement delay (s)', s.sandbox.ach_settle_seconds)}${num('sandbox.payout_seconds', 'Sandbox payout delay (s)', s.sandbox.payout_seconds)}${num('sandbox.block_seconds', 'Sandbox block time (s, 0 = manual)', s.sandbox.block_seconds)}
      ${num('aml.structuring.threshold_cents', 'Structuring threshold (cents)', s.aml.structuring.threshold_cents)}${num('aml.structuring.count', 'Structuring: deposits in window', s.aml.structuring.count)}
      ${sel('aml.structuring.action', 'Structuring rule', s.aml.structuring.action)}${sel('aml.rapid_in_out.action', 'Rapid deposit-then-withdraw rule', s.aml.rapid_in_out.action)}${sel('aml.new_crypto_address.action', 'First withdrawal to a new crypto address', s.aml.new_crypto_address.action)}
      <label class="field span2"><span>Reason (audit log) *</span><input name="reason" maxlength="500" data-testid="settings-reason"></label></div>
      <div class="adm-form-actions"><button class="btn btn-primary" type="submit" data-testid="settings-save">Save settings</button><small class="adm-err" role="alert" data-err></small></div></form>`;
    const f = host.querySelector('form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const out = {};
      const setPath = (p, v) => { const ks = p.split('.'); let x = out; for (const k of ks.slice(0, -1)) { x[k] = x[k] || {}; x = x[k]; } x[ks[ks.length - 1]] = v; };
      for (const el of f.querySelectorAll('[name]')) {
        if (el.name === 'reason') continue;
        setPath(el.name, el.dataset.num !== undefined ? Number(el.value) : el.dataset.bool !== undefined ? el.checked : el.value);
      }
      try { await put('/payments/settings', { settings: out, reason: f.reason.value }); toast('Payment settings saved'); await draw(); } catch (ex) { f.querySelector('[data-err]').textContent = ex.fields ? Object.entries(ex.fields).map(([k, v]) => `${k} ${v}`).join('; ') : ex.message; }
    };
  };
  await draw();
}

async function webhooks(host) {
  const r = await get('/payments/webhooks');
  host.innerHTML = '<p class="muted">Every webhook the provider endpoints received (signature, 5-minute timestamp window and event-id replay checks), and the sandbox providers\' delivery queue.</p><div id="wl"></div><h3>Sandbox delivery queue</h3><div id="wo"></div>';
  dataTable(host.querySelector('#wl'), { testid: 'webhook-log', rows: r.log, rowAttrs: (x) => `data-outcome="${esc(x.outcome)}"`,
    cols: [{ key: 'time', label: 'Received', render: (x) => esc(fmtTime(x.time)) }, { key: 'provider', label: 'Provider' }, { key: 'type', label: 'Event', render: (x) => esc(x.type || '—') }, { key: 'event_id', label: 'Event id', render: (x) => `<code>${esc(x.event_id || '—')}</code>` },
      { key: 'outcome', label: 'Outcome', render: (x) => b(x.outcome) }, { key: 'reason', label: 'Reason' }, { key: 'ip', label: 'From' }] });
  dataTable(host.querySelector('#wo'), { testid: 'webhook-outbox', rows: r.outbox, search: false, cols: [{ key: 'created_time', label: 'Queued', render: (x) => esc(fmtTime(x.created_time)) }, { key: 'provider', label: 'Provider' }, { key: 'type', label: 'Event' }, { key: 'status', label: 'Status' }, { key: 'attempts', label: 'Attempts', num: true }, { key: 'last_status', label: 'Last HTTP', num: true }] });
}
