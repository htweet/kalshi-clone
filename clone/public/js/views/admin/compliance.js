// Admin › Identity reviews, Fraud & holds, Compliance settings (CLONE_SPEC §25; PLAN P3.5–P3.7).
// Personal data is masked everywhere here; "Reveal" asks for a reason, is recorded in the audit log and shown to the
// customer in their security activity. National ID numbers can never be revealed.
import { esc, get, post, put, toast, dataTable, section, fmtTime, badge, confirmAction, dialog, fmtMoney } from './ui.js';

const STATUS_KIND = { approved: 'ok', review: 'warn', pending: '', retry: 'warn', rejected: 'bad', in_progress: '', closed: '' };
const REASONS = [['identity_mismatch', 'Identity mismatch'], ['duplicate_account', 'Duplicate account'], ['unsupported_region', 'Unsupported region'], ['fraud_suspected', 'Fraud suspected'],
  ['age_requirement', 'Under 18'], ['data_mismatch', 'Details need correcting (retry)'], ['other', 'Other']];

export async function render(ctx) {
  if (ctx.section === 'kyc') return kycQueue(ctx);
  if (ctx.section === 'fraud') return fraud(ctx);
  return settings(ctx);
}

// ------------------------------------------------------------------ identity review queue + lookup
async function kycQueue({ el, perms }) {
  el.innerHTML = section('Identity reviews', 'Applications the sandbox provider sent to manual review, and every other verification state. Personal data is masked.') +
    `<form class="adm-toolbar adm-filters" data-f data-testid="kyc-filters"><label class="field"><span>Status</span><select name="status">${['review', 'pending', 'retry', 'rejected', 'approved', 'all'].map((s) => `<option value="${s}">${s}</option>`).join('')}</select></label><button class="btn" type="submit">Show</button>
      <label class="field"><span>Look up account (email or id)</span><input name="who" class="adm-input" data-testid="kyc-lookup"></label><button class="btn" type="button" data-lookup>Open</button></form>
     <div class="adm-tiles" data-counts></div><div id="kq"></div>`;
  const t = dataTable(el.querySelector('#kq'), { testid: 'kyc-queue', pageSize: 25, rowAttrs: (r) => `data-user="${esc(r.user_id)}" data-status="${esc(r.status)}"`,
    searchText: (r) => [r.email, r.display_name, r.status, r.reason_category, r.country].join(' '),
    cols: [{ key: 'email', label: 'Account', render: (r) => `${esc(r.email)}<div class="faint">${esc(r.display_name)}</div>` }, { key: 'legal_name', label: 'Legal name' },
      { key: 'national_id', label: 'ID', render: (r) => `${esc(r.national_id || '—')}${r.duplicate_national_id ? ` ${badge('duplicate', 'bad')}` : ''}` }, { key: 'country', label: 'Country' },
      { key: 'status', label: 'Status', render: (r) => badge(r.status, STATUS_KIND[r.status] || '') }, { key: 'reason_category', label: 'Reason', render: (r) => esc(r.reason_category || '—') },
      { key: 'risk_score', label: 'Risk', num: true, render: (r) => esc(r.risk_score ?? '—') }, { key: 'submitted_time', label: 'Submitted', render: (r) => esc(fmtTime(r.submitted_time)) },
      { key: '_a', label: '', sort: false, render: (r) => `<button class="btn btn-sm" data-open="${esc(r.user_id)}" data-testid="kyc-open">Open</button>` }] });
  const form = el.querySelector('[data-f]');
  const load = async () => {
    const r = await get(`/kyc/queue?status=${encodeURIComponent(form.status.value)}`);
    el.querySelector('[data-counts]').innerHTML = Object.entries(r.counts).map(([k, v]) => `<div class="adm-tile"><span>${esc(k.replace(/_/g, ' '))}</span><b data-testid="kyc-count-${esc(k)}">${esc(v)}</b></div>`).join('');
    t.setRows(r.items);
  };
  form.onsubmit = (e) => { e.preventDefault(); load().catch((ex) => toast(ex.message, 'error')); };
  el.querySelector('#kq').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openUser(b.dataset.open, perms, load); });
  el.querySelector('[data-lookup]').onclick = () => { const w = form.who.value.trim(); if (w) openUser(w, perms, load); };
  await load();
}

async function openUser(who, perms, reload) {
  let r;
  try { r = (await get(`/identity/users/${encodeURIComponent(who)}`)).identity; } catch (ex) { toast(ex.message, 'error'); return; }
  const canDecide = perms.has('users.support') && ['review', 'pending', 'retry', 'rejected', 'approved'].includes(r.status);
  const revealable = perms.has('users.support');
  const row = (label, field, value) => `<dt>${esc(label)}</dt><dd><span data-value="${esc(field)}" data-testid="identity-${esc(field)}">${esc(value ?? '—')}</span>${revealable && value && field !== 'national_id' ? ` <button class="btn btn-sm btn-ghost" data-reveal="${esc(field)}" data-testid="reveal-${esc(field)}">Reveal</button>` : ''}</dd>`;
  const d = dialog(`<div class="adm-confirm" data-testid="identity-detail" data-user="${esc(r.user_id)}"><h3>${esc(r.email)} ${badge(r.status, STATUS_KIND[r.status] || '')}</h3>
    <dl class="id-facts">${row('Legal name', 'legal_name', r.legal_name)}${row('Date of birth', 'date_of_birth', r.date_of_birth)}${row('Address', 'address', r.address)}${row('Phone', 'phone', r.phone?.masked)}
      ${row('National ID', 'national_id', r.national_id)}<dt>Email verified</dt><dd>${r.email_verified ? 'yes' : 'no'}</dd><dt>Duplicate ID</dt><dd>${r.duplicate_national_id ? badge('matches another account', 'bad') : 'no'}</dd>
      <dt>Risk</dt><dd>${esc(r.risk.latest_score ?? '—')} ${r.risk.latest_signals.map((s) => badge(s.label || s.code, 'warn')).join(' ')}</dd><dt>Attempts</dt><dd>${esc(r.verification.attempts)}</dd></dl>
    <p class="faint">National ID numbers are never revealed. Every reveal is audited with your reason and shown to the customer.</p>
    <h4>History</h4><ul class="adm-list">${r.kyc_history.map((h) => `<li>${esc(fmtTime(h.time))} · ${esc(h.source)} · ${esc(h.decision)}${h.reason_category ? ` (${esc(h.reason_category)})` : ''}${h.actor ? ` · ${esc(h.actor)}` : ''}${h.note ? ` — ${esc(h.note)}` : ''}</li>`).join('') || '<li class="faint">No decisions yet.</li>'}</ul>
    ${canDecide ? `<form class="adm-form" data-decide data-testid="kyc-decision-form"><div class="adm-form-grid"><label class="field"><span>Decision</span><select name="decision" data-testid="kyc-decision"><option value="approve">Approve</option><option value="reject">Reject</option><option value="retry">Ask the customer to retry</option></select></label>
      <label class="field"><span>Reason category</span><select name="reason_category" data-testid="kyc-reason"><option value="">—</option>${REASONS.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>
      <label class="field span2"><span>Note (audit log)</span><textarea name="note" rows="2" maxlength="500" data-testid="kyc-note"></textarea></label></div>
      <div class="adm-form-actions"><button class="btn btn-primary" type="submit" data-testid="kyc-submit">Record decision</button><small class="adm-err" data-err role="alert"></small></div></form>` : ''}
    <div class="adm-form-actions"><button class="btn" data-close>Close</button></div></div>`, { wide: true, testid: 'identity-dialog' });
  d.querySelector('[data-close]').onclick = () => d.close();
  for (const b of d.querySelectorAll('[data-reveal]')) {
    b.onclick = async () => {
      const ok = await confirmAction({ title: `Reveal ${b.dataset.reveal.replace(/_/g, ' ')}?`, body: 'This is recorded in the audit log with your reason and shown to the customer.', confirm: 'Reveal', reason: true, reasonLabel: 'Why do you need to see it? (audited)' });
      if (!ok) return;
      try {
        const v = await post(`/identity/users/${encodeURIComponent(r.user_id)}/unmask`, { field: b.dataset.reveal, reason: ok.reason });
        const val = v.value;
        d.querySelector(`[data-value="${CSS.escape(b.dataset.reveal)}"]`).textContent = typeof val === 'string' ? val
          : val.first ? `${val.first} ${val.last}` : val.year ? `${String(val.month).padStart(2, '0')}/${String(val.day).padStart(2, '0')}/${val.year}` : [val.line1, val.line2, val.city, val.region, val.postal_code, val.country].filter(Boolean).join(', ');
        b.remove();
      } catch (ex) { toast(ex.message, 'error'); }
    };
  }
  const f = d.querySelector('[data-decide]');
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('[data-err]');
    err.textContent = '';
    try {
      const out = await post(`/kyc/${encodeURIComponent(r.user_id)}/decision`, { decision: f.decision.value, reason_category: f.reason_category.value || null, note: f.note.value });
      toast(`Decision recorded: ${out.status}`);
      d.close();
      await reload();
    } catch (ex) { err.textContent = ex.message; }
  };
}

// ------------------------------------------------------------------ fraud: holds, risky activity, shared devices
async function fraud({ el, perms }) {
  el.innerHTML = section('Fraud & holds', 'Withdrawals held by the risk score, the riskiest money movements of the last 7 days, and devices shared between accounts.') +
    '<div class="adm-tiles" data-tiles></div><h3>Withdrawal holds</h3><div id="fh"></div><h3 class="mt-16">Risk assessments (7 days)</h3><div id="fr"></div><h3 class="mt-16">Shared devices (30 days)</h3><div id="fd"></div>';
  const holds = dataTable(el.querySelector('#fh'), { testid: 'fraud-holds', pageSize: 20, rowAttrs: (r) => `data-hold="${esc(r.id)}" data-status="${esc(r.status)}"`,
    cols: [{ key: 'created_time', label: 'Requested', render: (r) => esc(fmtTime(r.created_time)) }, { key: 'email', label: 'Account' }, { key: 'amount_dollars', label: 'Amount', num: true, render: (r) => esc(fmtMoney(r.amount_dollars)) },
      { key: 'score', label: 'Score', num: true }, { key: 'signals', label: 'Signals', sort: false, render: (r) => r.signals.map((s) => badge(`${s.label || s.code} +${s.points}`, 'warn')).join(' ') },
      { key: 'status', label: 'Status', render: (r) => badge(r.status, r.status === 'held' ? 'warn' : r.status === 'released' ? 'ok' : '') },
      { key: '_a', label: '', sort: false, render: (r) => (r.status === 'held' && perms.has('users.money') ? `<button class="btn btn-sm" data-act="release" data-id="${esc(r.id)}" data-testid="hold-release">Release</button> <button class="btn btn-sm" data-act="reverse" data-id="${esc(r.id)}" data-testid="hold-reverse">Reverse</button>` : '') }] });
  const risky = dataTable(el.querySelector('#fr'), { testid: 'fraud-assessments', pageSize: 20,
    cols: [{ key: 'time', label: 'Time', render: (r) => esc(fmtTime(r.time)) }, { key: 'email', label: 'Account' }, { key: 'kind', label: 'Kind' }, { key: 'amount_dollars', label: 'Amount', num: true, render: (r) => esc(r.amount_dollars == null ? '—' : fmtMoney(r.amount_dollars)) },
      { key: 'score', label: 'Score', num: true }, { key: 'action', label: 'Action', render: (r) => badge(r.action, r.action === 'hold' ? 'bad' : r.action === 'flag' ? 'warn' : '') }] });
  const shared = dataTable(el.querySelector('#fd'), { testid: 'fraud-devices', pageSize: 20, search: false, cols: [{ key: 'device', label: 'Device (hash prefix)' }, { key: 'accounts', label: 'Accounts', num: true }, { key: 'last_seen_time', label: 'Last seen', render: (r) => esc(fmtTime(r.last_seen_time)) }] });
  const load = async () => {
    const r = await get('/fraud/overview');
    el.querySelector('[data-tiles]').innerHTML = `<div class="adm-tile"><span>Hold threshold</span><b>${esc(r.threshold)}</b></div><div class="adm-tile"><span>Holds enabled</span><b data-testid="holds-enabled">${r.holds_enabled ? 'yes' : 'no'}</b></div>
      <div class="adm-tile"><span>Open holds</span><b data-testid="open-holds">${esc(r.holds.filter((h) => h.status === 'held').length)}</b></div><div class="adm-tile"><span>Location blocks · 24 h</span><b>${esc(r.geo_blocked_24h)}</b></div>`;
    holds.setRows(r.holds); risky.setRows(r.assessments); shared.setRows(r.shared_devices);
  };
  el.querySelector('#fh').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const ok = await confirmAction({ title: b.dataset.act === 'release' ? 'Release this withdrawal?' : 'Reverse this withdrawal?', body: b.dataset.act === 'release' ? 'The funds are sent to the customer.' : 'The funds go back to the customer’s balance.', confirm: b.dataset.act === 'release' ? 'Release' : 'Reverse', reason: true });
    if (!ok) return;
    try { await post(`/fraud/holds/${encodeURIComponent(b.dataset.id)}/${b.dataset.act}`, { reason: ok.reason }); toast('Hold decided'); await load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  await load();
}

// ------------------------------------------------------------------ compliance settings
async function settings({ el }) {
  const r = await get('/compliance/settings');
  const s = r.settings;
  const opts = r.countries.map((c) => `<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.name)}</option>`).join('');
  el.innerHTML = section('Compliance settings', 'Identity-verification gating, blocked regions, the simulated IP table, fraud holds, the admin passkey rule, SMS send limits and retention. Every save is audited.') +
    `<form class="adm-form" data-testid="compliance-form" novalidate><div class="adm-form-grid">
      <label class="field"><span>Identity verification required to trade / deposit</span><select name="enforce" data-testid="cs-enforce"><option value="">Default (${s.default_enforce ? 'on' : 'off'})</option><option value="true">On</option><option value="false">Off</option></select><small class="faint">Effective now: ${s.enforce_effective ? 'on' : 'off'}</small></label>
      <label class="field"><span>Unknown / local IP addresses</span><select name="unknown_ip"><option value="allow">Allow</option><option value="block">Block unless the browser location is known</option></select></label>
      <label class="field span2"><span>Blocked countries (comma-separated ISO codes)</span><input name="blocked" class="adm-input" data-testid="cs-blocked" value="${esc(s.blocked_countries.join(', '))}"><small class="faint">Known codes: ${esc(r.countries.map((c) => c.code).join(' '))}</small></label>
      <label class="field span2"><span>Simulated IP table overrides (one "CIDR COUNTRY" per line)</span><textarea name="ip_overrides" rows="3" data-testid="cs-ip-overrides">${esc(s.ip_overrides.map((o) => `${o.cidr} ${o.country}`).join('\n'))}</textarea></label>
      <label class="field"><span>Hold withdrawals at risk score ≥</span><input name="hold_threshold" type="number" min="10" max="200" value="${esc(s.fraud.hold_threshold)}" data-testid="cs-threshold"></label>
      <label class="field"><span>Withdrawal holds</span><select name="hold_withdrawals"><option value="">Follow identity gating</option><option value="true">Always on</option><option value="false">Off</option></select></label>
      <label class="adm-check span2"><input type="checkbox" name="admin_passkey_required" data-testid="cs-admin-passkey" ${s.admin_passkey_required ? 'checked' : ''}> <span>Staff must sign in or confirm with a passkey to use the admin panel</span></label>
      <label class="field"><span>SMS codes per number / hour</span><input name="per_number_hour" type="number" min="0" value="${esc(s.sms.per_number_hour)}"></label>
      <label class="field"><span>SMS codes per IP / hour</span><input name="per_ip_hour" type="number" min="0" value="${esc(s.sms.per_ip_hour)}"></label>
      <label class="field"><span>SMS codes per account / day</span><input name="per_account_day" type="number" min="0" value="${esc(s.sms.per_account_day)}"></label>
      <label class="field"><span>SMS codes per destination country / hour</span><input name="per_country_hour" type="number" min="0" value="${esc(s.sms.per_country_hour)}" data-testid="cs-country-hour"></label>
      <label class="field"><span>Identity record retention after closure (days)</span><input name="kyc_days" type="number" min="365" max="3650" value="${esc(s.retention.kyc_days)}"></label>
      <label class="field span2"><span>Reason for this change (audit log)</span><input name="reason" class="adm-input" maxlength="500"></label></div>
      <div class="adm-form-actions"><button class="btn btn-primary" type="submit" data-testid="cs-save">Save settings</button><small class="adm-err" data-err role="alert" data-testid="cs-error"></small></div></form>
      <datalist id="cs-countries">${opts}</datalist>`;
  const f = el.querySelector('form');
  f.enforce.value = s.enforce == null ? '' : String(s.enforce);
  f.unknown_ip.value = s.unknown_ip;
  f.hold_withdrawals.value = s.fraud.hold_withdrawals == null ? '' : String(s.fraud.hold_withdrawals);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('[data-err]');
    err.textContent = '';
    const num = (n) => (f[n].value === '' ? undefined : Number(f[n].value));
    const body = {
      enforce: f.enforce.value === '' ? null : f.enforce.value === 'true', unknown_ip: f.unknown_ip.value,
      blocked_countries: f.blocked.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
      ip_overrides: f.ip_overrides.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [cidr, country] = l.split(/\s+/); return { cidr, country }; }),
      fraud: { hold_threshold: num('hold_threshold'), hold_withdrawals: f.hold_withdrawals.value === '' ? null : f.hold_withdrawals.value === 'true' },
      admin_passkey_required: f.admin_passkey_required.checked,
      sms: { per_number_hour: num('per_number_hour'), per_ip_hour: num('per_ip_hour'), per_account_day: num('per_account_day'), per_country_hour: num('per_country_hour') },
      retention: { kyc_days: num('kyc_days') }, reason: f.reason.value,
    };
    try { await put('/compliance/settings', body); toast('Compliance settings saved'); await settings({ el }); } catch (ex) { err.textContent = ex.fields ? Object.entries(ex.fields).map(([k, m]) => `${k}: ${m}`).join('; ') : ex.message; }
  };
}
