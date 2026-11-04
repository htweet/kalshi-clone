// Admin › Payments (CLONE_SPEC.md §26.9): transactions, reconciliation queue (resolve with a reason, step-up, audit chain),
// AML cases (close / escalate; held withdrawals released or reversed through Fraud & holds), the double-entry ledger audit,
// provider settings and the webhook log. Sandbox rails only.
import { t as tx, te, ts } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.payments-strings.js';
import { money } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, post, put, toast, dataTable, section, subTabs, fmtTime, fmtMoney, badge, confirmAction } from './ui.js';

const TABS = [['transactions', ts('admin.payments.tabs.transactions')], ['reconciliation', ts('admin.payments.tabs.reconciliation')], ['aml', ts('admin.payments.tabs.aml_cases')], ['ledger', ts('admin.payments.tabs.ledger_audit')], ['settings', ts('admin.payments.tabs.provider_settings')], ['webhooks', ts('admin.payments.tabs.webhook_log')]];
const KIND = { succeeded: 'ok', settled: 'ok', paid: 'ok', pending: '', processing: '', confirming: '', requires_action: 'warn', held: 'warn', failed: 'bad', returned: 'bad', reversed: 'bad', open: 'warn', escalated: 'bad', closed: 'ok', resolved: 'ok', accepted: 'ok', rejected: 'bad', error: 'bad' };
const b = (s) => badge(s, KIND[s] || '');

export async function render(ctx) {
  const tab = TABS.some(([k]) => k === ctx.parts[0]) ? ctx.parts[0] : 'transactions';
  const visible = TABS.filter(([k]) => (k === 'settings' ? ctx.perms.has('settings.write') : k === 'webhooks' ? ctx.perms.has('audit.read') : true));
  ctx.el.innerHTML = `${section(tx('admin.payments.render.payments'), tx('admin.payments.render.sandbox_rails_test_cards_test'))}${subTabs(visible, tab, '/admin/payments')}<div id="pay-tab" data-testid="admin-payments" data-tab="${esc(tab)}"></div>`;
  const host = ctx.el.querySelector('#pay-tab');
  const fns = { transactions, reconciliation, aml, ledger, settings, webhooks };
  return fns[tab](host, ctx);
}

async function transactions(host) {
  const o = await get('/payments/overview');
  host.innerHTML = `<div class="adm-tiles"><div class="adm-tile"><span>${te('admin.payments.transactions.open_reconciliation_items')}</span><b data-testid="tile-recon">${esc(o.open_reconciliation_items)}</b></div><div class="adm-tile"><span>${te('admin.payments.transactions.open_aml_cases')}</span><b data-testid="tile-aml">${esc(o.open_aml_cases)}</b></div>
    <div class="adm-tile"><span>${te('admin.payments.transactions.last_ledger_audit')}</span><b data-testid="tile-audit">${o.last_audit ? (o.last_audit.ok ? te('admin.payments.transactions.balanced') : te('admin.payments.transactions.problem_s', { problems: esc(o.last_audit.problems) })) : te('admin.payments.transactions.not_run_yet')}</b></div></div>
    <h3>${te('admin.payments.transactions.house_and_provider_accounts')}</h3><table class="table"><tbody>${Object.entries(o.accounts).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${esc(fmtMoney(v))}</td></tr>`).join('')}</tbody></table><div id="ptx"></div>`;
  const r = await get('/payments/transactions');
  dataTable(host.querySelector('#ptx'), { testid: 'admin-transactions', rows: r.transactions, rowAttrs: (t) => `data-id="${esc(t.id)}" data-status="${esc(t.status)}"`,
    cols: [{ key: 'created_time', label: 'Created', render: (t) => esc(fmtTime(t.created_time)) }, { key: 'email', label: 'Account' }, { key: 'direction', label: tx('admin.payments.transactions.type') }, { key: 'rail', label: tx('admin.payments.transactions.rail') },
      { key: 'label', label: tx('admin.payments.transactions.method') }, { key: 'amount_dollars', label: tx('admin.payments.transactions.amount'), num: true, render: (t) => esc(fmtMoney(t.amount_dollars)) }, { key: 'status', label: tx('admin.payments.transactions.status'), render: (t) => b(t.status) }, { key: 'provider_ref', label: tx('admin.payments.transactions.provider_ref'), render: (t) => `<code>${esc(t.provider_ref || '—')}</code>` }] });
}

async function reconciliation(host, { perms }) {
  const draw = async () => {
    const r = await get('/payments/reconciliation?status=all');
    host.innerHTML = `<div class="adm-toolbar">${perms.has('users.money') ? `<button class="btn btn-primary" data-run data-testid="recon-run">${te('admin.payments.reconciliation.run_reconciliation_now')}</button>` : ''}<span class="faint">${r.runs[0] ? te('admin.payments.reconciliation.last_run_records_checked_new', { fmt_time: esc(fmtTime(r.runs[0].time)), checked: esc(r.runs[0].checked), found: esc(r.runs[0].found) }) : te('admin.payments.reconciliation.not_run_yet')}</span></div><div id="ri"></div>`;
    dataTable(host.querySelector('#ri'), { testid: 'recon-items', rows: r.items, empty: tx('admin.payments.reconciliation.provider_records_and_the_ledger'), rowAttrs: (x) => `data-id="${esc(x.id)}" data-kind="${esc(x.kind)}" data-status="${esc(x.status)}"`,
      cols: [{ key: 'created_time', label: tx('admin.payments.reconciliation.found'), render: (x) => esc(fmtTime(x.created_time)) }, { key: 'kind_label', label: tx('admin.payments.reconciliation.mismatch') }, { key: 'provider', label: tx('admin.payments.reconciliation.provider') }, { key: 'email', label: 'Account', render: (x) => esc(x.email || '—') },
        { key: 'expected_dollars', label: tx('admin.payments.reconciliation.ledger'), num: true, render: (x) => esc(x.expected_dollars == null ? '—' : fmtMoney(x.expected_dollars)) }, { key: 'actual_dollars', label: tx('admin.payments.reconciliation.provider'), num: true, render: (x) => esc(x.actual_dollars == null ? '—' : fmtMoney(x.actual_dollars)) },
        { key: 'detail', label: tx('admin.payments.reconciliation.detail') }, { key: 'status', label: tx('admin.payments.reconciliation.status'), render: (x) => `${b(x.status)}${x.resolution ? `<div class="faint">${esc(x.resolution)}: ${esc(x.reason)}</div>` : ''}` },
        { key: '_a', label: '', sort: false, render: (x) => (x.status === 'open' && perms.has('users.money') ? `<button class="btn btn-sm" data-resolve="${esc(x.id)}" data-kind="${esc(x.kind)}" data-testid="recon-resolve">${te('admin.payments.reconciliation.resolve')}</button>` : '') }] });
    host.querySelector('[data-run]')?.addEventListener('click', async () => { try { const x = await post('/payments/reconciliation/run'); toast(tx('admin.payments.reconciliation.new_item_s', { found: x.found })); await draw(); } catch (ex) { toast(ex.message, 'error'); } });
    host.querySelector('#ri').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-resolve]');
      if (!btn) return;
      const ok = await confirmAction({ title: tx('admin.payments.reconciliation.resolve_this_mismatch'), body: tx('admin.payments.reconciliation.recorded_in_the_tamper_evident'), confirm: tx('admin.payments.reconciliation.resolve'), reason: true,
        extraHtml: `<label class="field"><span>${te('admin.payments.reconciliation.resolution')}</span><select name="resolution" data-testid="recon-resolution"><option value="acknowledge">${te('admin.payments.reconciliation.acknowledge_no_balance_change_follow')}</option>${btn.dataset.kind === 'amount_mismatch' ? `<option value="adjust_user">${te('admin.payments.reconciliation.adjust_the_customer_balance_to')}</option>` : ''}</select></label>` });
      if (!ok) return;
      try { await post(`/payments/reconciliation/${encodeURIComponent(btn.dataset.resolve)}/resolve`, { resolution: ok.form.resolution.value, reason: ok.reason }); toast(tx('admin.payments.reconciliation.resolved')); await draw(); } catch (ex) { toast(ex.message, 'error'); }
    });
  };
  await draw();
}

async function aml(host, { perms }) {
  const draw = async () => {
    const r = await get('/payments/aml_cases?status=all');
    host.innerHTML = `<p class="muted">${te('admin.payments.aml.rule_hooks_deposits_just_under')}</p><div id="ac"></div>`;
    dataTable(host.querySelector('#ac'), { testid: 'aml-cases', rows: r.cases, empty: tx('admin.payments.aml.no_aml_cases'), rowAttrs: (c) => `data-id="${esc(c.id)}" data-rule="${esc(c.rule)}" data-status="${esc(c.status)}"`,
      cols: [{ key: 'created_time', label: tx('admin.payments.aml.opened'), render: (c) => esc(fmtTime(c.created_time)) }, { key: 'email', label: 'Account' }, { key: 'rule_label', label: tx('admin.payments.aml.rule') }, { key: 'action', label: tx('admin.payments.aml.action') },
        { key: 'detail', label: tx('admin.payments.aml.detail'), sort: false, render: (c) => esc(Object.entries(c.detail).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')) },
        { key: 'hold_status', label: 'Hold', render: (c) => (c.hold_id ? b(c.hold_status || 'held') : '—') }, { key: 'status', label: tx('admin.payments.aml.status'), render: (c) => `${b(c.status)}${c.reason ? `<div class="faint">${esc(c.reason)}</div>` : ''}` },
        { key: '_a', label: '', sort: false, render: (c) => (c.status !== 'closed' && perms.has('users.money') ? `${c.hold_id && c.hold_status === 'held' ? `<button class="btn btn-sm" data-hold="${esc(c.hold_id)}" data-act="release" data-testid="aml-release">${te('admin.payments.aml.release')}</button> <button class="btn btn-sm" data-hold="${esc(c.hold_id)}" data-act="reverse" data-testid="aml-reverse">${te('admin.payments.aml.reverse')}</button> ` : ''}<button class="btn btn-sm" data-case="${esc(c.id)}" data-act="close" data-testid="aml-close">${te('admin.payments.aml.close')}</button> ${c.status === 'open' ? `<button class="btn btn-sm btn-ghost" data-case="${esc(c.id)}" data-act="escalate">${te('admin.payments.aml.escalate')}</button>` : ''}` : '') }] });
    host.querySelector('#ac').addEventListener('click', async (e) => {
      const h = e.target.closest('[data-hold]'); const c = e.target.closest('[data-case]');
      if (!h && !c) return;
      const act = (h || c).dataset.act;
      const ok = await confirmAction({ title: h ? tx('admin.payments.aml.the_held_withdrawal', { value: act === 'release' ? tx('admin.payments.aml.release') : tx('admin.payments.aml.reverse') }) : tx('admin.payments.aml.this_case', { value: act === 'close' ? tx('admin.payments.aml.close') : tx('admin.payments.aml.escalate') }), confirm: act[0].toUpperCase() + act.slice(1), reason: true,
        extraHtml: c && act === 'close' ? `<label class="field"><span>${te('admin.payments.aml.outcome')}</span><select name="outcome"><option value="no_issue">${te('admin.payments.aml.no_issue_found')}</option><option value="reported">${te('admin.payments.aml.reported')}</option><option value="account_restricted">${te('admin.payments.aml.account_restricted')}</option></select></label>` : '' });
      if (!ok) return;
      try {
        if (h) await post(`/fraud/holds/${encodeURIComponent(h.dataset.hold)}/${act}`, { reason: ok.reason });
        else await post(`/payments/aml_cases/${encodeURIComponent(c.dataset.case)}/${act}`, { reason: ok.reason, ...(act === 'close' ? { outcome: ok.form.outcome.value } : {}) });
        toast(tx('admin.payments.aml.done')); await draw();
      } catch (ex) { toast(ex.message, 'error'); }
    });
  };
  await draw();
}

async function ledger(host, { perms }) {
  const draw = async () => {
    const r = await get('/payments/ledger_audit');
    const l = r.live;
    host.innerHTML = `<div class="adm-toolbar">${perms.has('users.money') ? `<button class="btn btn-primary" data-run data-testid="audit-run">${te('admin.payments.ledger.run_and_record_the_audit')}</button>` : ''}</div>
      <p data-testid="audit-result" data-ok="${l.ok ? '1' : '0'}">${te('admin.payments.ledger.journal_entries_accounts_checked_every', { value: l.ok ? badge('balanced', 'ok') : badge(`${l.problems.length} problem(s)`, 'bad'), entries: esc(l.entries), accounts_checked: esc(l.accounts_checked) })}</p>
      ${l.problems.length ? `<table class="table" data-testid="audit-problems"><thead><tr><th>${te('admin.payments.ledger.check')}</th><th>${te('admin.payments.ledger.account')}</th><th class="num">${te('admin.payments.ledger.expected')}</th><th class="num">${te('admin.payments.ledger.actual')}</th><th>${te('admin.payments.ledger.detail')}</th></tr></thead><tbody>${l.problems.map((p) => `<tr><td>${esc(p.check)}</td><td><code>${esc(p.account || p.entry_id || '')}</code></td><td class="num">${esc(money(p.expected_cents / 100))}</td><td class="num">${esc(money(p.actual_cents / 100))}</td><td>${esc(p.detail)}</td></tr>`).join('')}</tbody></table>` : ''}
      <h3>${te('admin.payments.ledger.totals_by_account')}</h3><table class="table"><tbody>${Object.entries(l.totals).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${esc(fmtMoney(v))}</td></tr>`).join('')}</tbody></table>
      <h3>${te('admin.payments.ledger.recorded_runs')}</h3><table class="table"><tbody>${r.history.map((h) => `<tr><td>${esc(fmtTime(h.time))}</td><td>${esc(h.trigger)}</td><td>${h.ok ? badge('balanced', 'ok') : badge(`${h.problems} problem(s)`, 'bad')}</td><td class="num">${te('admin.payments.ledger.entries', { entries: esc(h.entries) })}</td></tr>`).join('') || `<tr><td class="faint">${te('admin.payments.ledger.no_recorded_runs_yet_the')}</td></tr>`}</tbody></table>`;
    host.querySelector('[data-run]')?.addEventListener('click', async () => { try { const x = await post('/payments/ledger_audit/run'); toast(x.ok ? tx('admin.payments.ledger.ledger_balanced') : tx('admin.payments.ledger.problem_s', { value: x.problems.length })); await draw(); } catch (ex) { toast(ex.message, 'error'); } });
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
      ${chk('rails.card', tx('admin.payments.settings.card_rail_on'), s.rails.card)}${chk('rails.bank', tx('admin.payments.settings.bank_rail_on'), s.rails.bank)}${chk('rails.crypto', tx('admin.payments.settings.crypto_rail_on'), s.rails.crypto)}
      ${num('limits.withdrawal_day_cents', tx('admin.payments.settings.withdrawal_limit_per_day_cents'), s.limits.withdrawal_day_cents)}${num('limits.withdrawal_month_cents', tx('admin.payments.settings.withdrawal_limit_per_month_cents'), s.limits.withdrawal_month_cents)}
      ${num('limits.card_deposit_max_cents', tx('admin.payments.settings.card_deposit_maximum_cents'), s.limits.card_deposit_max_cents)}${num('limits.bank_deposit_max_cents', tx('admin.payments.settings.bank_deposit_maximum_cents'), s.limits.bank_deposit_max_cents)}
      ${num('limits.crypto_withdrawal_max_cents', tx('admin.payments.settings.crypto_withdrawal_maximum_cents'), s.limits.crypto_withdrawal_max_cents)}${num('fees.crypto_network_fee_cents', tx('admin.payments.settings.crypto_network_fee_cents'), s.fees.crypto_network_fee_cents)}
      ${num('crypto.confirmations', tx('admin.payments.settings.crypto_deposit_confirmations'), s.crypto.confirmations)}${num('crypto.address_cooling_hours', tx('admin.payments.settings.new_address_cooling_period_hours'), s.crypto.address_cooling_hours)}
      ${num('credits.expiry_days', tx('admin.payments.settings.promotional_credit_lifetime_days'), s.credits.expiry_days)}
      ${num('sandbox.ach_settle_seconds', tx('admin.payments.settings.sandbox_ach_settlement_delay_s'), s.sandbox.ach_settle_seconds)}${num('sandbox.payout_seconds', tx('admin.payments.settings.sandbox_payout_delay_s'), s.sandbox.payout_seconds)}${num('sandbox.block_seconds', tx('admin.payments.settings.sandbox_block_time_s_0'), s.sandbox.block_seconds)}
      ${num('aml.structuring.threshold_cents', tx('admin.payments.settings.structuring_threshold_cents'), s.aml.structuring.threshold_cents)}${num('aml.structuring.count', tx('admin.payments.settings.structuring_deposits_in_window'), s.aml.structuring.count)}
      ${sel('aml.structuring.action', tx('admin.payments.settings.structuring_rule'), s.aml.structuring.action)}${sel('aml.rapid_in_out.action', tx('admin.payments.settings.rapid_deposit_then_withdraw_rule'), s.aml.rapid_in_out.action)}${sel('aml.new_crypto_address.action', tx('admin.payments.settings.first_withdrawal_to_a_new'), s.aml.new_crypto_address.action)}
      <label class="field span2"><span>${te('admin.payments.settings.reason_audit_log')}</span><input name="reason" maxlength="500" data-testid="settings-reason"></label></div>
      <div class="adm-form-actions"><button class="btn btn-primary" type="submit" data-testid="settings-save">${te('admin.payments.settings.save_settings')}</button><small class="adm-err" role="alert" data-err></small></div></form>`;
    const f = host.querySelector('form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const out = {};
      const setPath = (p, v) => { const ks = p.split('.'); let x = out; for (const k of ks.slice(0, -1)) { x[k] = x[k] || {}; x = x[k]; } x[ks[ks.length - 1]] = v; };
      for (const el of f.querySelectorAll('[name]')) {
        if (el.name === 'reason') continue;
        setPath(el.name, el.dataset.num !== undefined ? Number(el.value) : el.dataset.bool !== undefined ? el.checked : el.value);
      }
      try { await put('/payments/settings', { settings: out, reason: f.reason.value }); toast(tx('admin.payments.settings.payment_settings_saved')); await draw(); } catch (ex) { f.querySelector('[data-err]').textContent = ex.fields ? Object.entries(ex.fields).map(([k, v]) => `${k} ${v}`).join('; ') : ex.message; }
    };
  };
  await draw();
}

async function webhooks(host) {
  const r = await get('/payments/webhooks');
  host.innerHTML = `<p class="muted">${te('admin.payments.webhooks.every_webhook_the_provider_endpoints')}</p><div id="wl"></div><h3>${te('admin.payments.webhooks.sandbox_delivery_queue')}</h3><div id="wo"></div>`;
  dataTable(host.querySelector('#wl'), { testid: 'webhook-log', rows: r.log, rowAttrs: (x) => `data-outcome="${esc(x.outcome)}"`,
    cols: [{ key: 'time', label: tx('admin.payments.webhooks.received'), render: (x) => esc(fmtTime(x.time)) }, { key: 'provider', label: tx('admin.payments.webhooks.provider') }, { key: 'type', label: tx('admin.payments.webhooks.event'), render: (x) => esc(x.type || '—') }, { key: 'event_id', label: tx('admin.payments.webhooks.event_id'), render: (x) => `<code>${esc(x.event_id || '—')}</code>` },
      { key: 'outcome', label: tx('admin.payments.webhooks.outcome'), render: (x) => b(x.outcome) }, { key: 'reason', label: tx('admin.payments.webhooks.reason') }, { key: 'ip', label: tx('admin.payments.webhooks.from') }] });
  dataTable(host.querySelector('#wo'), { testid: 'webhook-outbox', rows: r.outbox, search: false, cols: [{ key: 'created_time', label: tx('admin.payments.webhooks.queued'), render: (x) => esc(fmtTime(x.created_time)) }, { key: 'provider', label: tx('admin.payments.webhooks.provider') }, { key: 'type', label: tx('admin.payments.webhooks.event') }, { key: 'status', label: tx('admin.payments.webhooks.status') }, { key: 'attempts', label: tx('admin.payments.webhooks.attempts'), num: true }, { key: 'last_status', label: tx('admin.payments.webhooks.last_http'), num: true }] });
}
