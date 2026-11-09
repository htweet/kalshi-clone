// Admin › Identity reviews, Fraud & holds, Compliance settings, Promo codes (CLONE_SPEC.md §25; PLAN P3.5–P3.7, A12).
// Personal data is masked everywhere here; "Reveal" and "View document" ask for a reason, are recorded in the audit log
// and shown to the customer in their security activity. National ID numbers can never be revealed.
import { t as tx, te, ts } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.compliance-strings.js';
import { t as T } from '../../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { currency, toApiDollars, moneyStep } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, post, put, toast, dataTable, section, fmtTime, badge, confirmAction, dialog, fmtMoney } from './ui.js';

const STATUS_KIND = { approved: 'ok', review: 'warn', pending: '', documents_required: '', retry: 'warn', rejected: 'bad', in_progress: '', closed: '' };
const REASONS = [['identity_mismatch', ts('admin.compliance.reasons.identity_mismatch')], ['duplicate_account', ts('admin.compliance.reasons.duplicate_account')], ['unsupported_region', ts('admin.compliance.reasons.unsupported_region')], ['fraud_suspected', ts('admin.compliance.reasons.fraud_suspected')],
  ['age_requirement', ts('admin.compliance.reasons.under_18')], ['data_mismatch', ts('admin.compliance.reasons.details_need_correcting_retry')], ['documents_unreadable', ts('admin.compliance.reasons.id_photos_unreadable_retry')], ['other', ts('admin.compliance.reasons.other')]];

export async function render(ctx) {
  if (ctx.section === 'kyc') return kycQueue(ctx);
  if (ctx.section === 'fraud') return fraud(ctx);
  if (ctx.section === 'promos') return promos(ctx);
  return settings(ctx);
}

// ------------------------------------------------------------------ identity review queue + lookup
async function kycQueue({ el, perms }) {
  el.innerHTML = section(tx('admin.compliance.kyc_queue.identity_reviews'), tx('admin.compliance.kyc_queue.applications_the_sandbox_provider_sent')) +
    `<form class="adm-toolbar adm-filters" data-f data-testid="kyc-filters"><label class="field"><span>${te('admin.compliance.kyc_queue.status')}</span><select name="status">${['review', 'pending', 'documents_required', 'retry', 'rejected', 'approved', 'all'].map((s) => `<option value="${s}">${s}</option>`).join('')}</select></label><button class="btn" type="submit">${te('admin.compliance.kyc_queue.show')}</button>
      <label class="field"><span>${te('admin.compliance.kyc_queue.look_up_account_email_or')}</span><input name="who" class="adm-input" data-testid="kyc-lookup"></label><button class="btn" type="button" data-lookup>${te('admin.compliance.kyc_queue.open')}</button></form>
     <div class="adm-tiles" data-counts></div><div id="kq"></div>`;
  const t = dataTable(el.querySelector('#kq'), { testid: 'kyc-queue', pageSize: 25, rowAttrs: (r) => `data-user="${esc(r.user_id)}" data-status="${esc(r.status)}"`,
    searchText: (r) => [r.email, r.display_name, r.status, r.reason_category, r.country].join(' '),
    cols: [{ key: 'email', label: 'Account', render: (r) => `${esc(r.email)}<div class="faint">${esc(r.display_name)}</div>` }, { key: 'legal_name', label: tx('admin.compliance.kyc_queue.legal_name') },
      { key: 'national_id', label: 'ID', render: (r) => `${esc(r.national_id || '—')}${r.duplicate_national_id ? ` ${badge('duplicate', 'bad')}` : ''}` }, { key: 'country', label: tx('admin.compliance.kyc_queue.country') },
      { key: 'status', label: tx('admin.compliance.kyc_queue.status'), render: (r) => badge(r.status, STATUS_KIND[r.status] || '') }, { key: 'reason_category', label: tx('admin.compliance.kyc_queue.reason'), render: (r) => esc(r.reason_category || '—') },
      { key: 'risk_score', label: tx('admin.compliance.kyc_queue.risk'), num: true, render: (r) => esc(r.risk_score ?? '—') }, { key: 'submitted_time', label: tx('admin.compliance.kyc_queue.submitted'), render: (r) => esc(fmtTime(r.submitted_time)) },
      { key: '_a', label: '', sort: false, render: (r) => `<button class="btn btn-sm" data-open="${esc(r.user_id)}" data-testid="kyc-open">${te('admin.compliance.kyc_queue.open')}</button>` }] });
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
  const row = (label, field, value) => `<dt>${esc(label)}</dt><dd><span data-value="${esc(field)}" data-testid="identity-${esc(field)}">${esc(value ?? '—')}</span>${revealable && value && field !== 'national_id' ? ` <button class="btn btn-sm btn-ghost" data-reveal="${esc(field)}" data-testid="reveal-${esc(field)}">${te('admin.compliance.open_user.reveal')}</button>` : ''}</dd>`;
  const d = dialog(`<div class="adm-confirm" data-testid="identity-detail" data-user="${esc(r.user_id)}"><h3>${esc(r.email)} ${badge(r.status, STATUS_KIND[r.status] || '')}</h3>
    <dl class="id-facts">${row(tx('admin.compliance.open_user.legal_name'), 'legal_name', r.legal_name)}${row(tx('admin.compliance.open_user.date_of_birth'), 'date_of_birth', r.date_of_birth)}${row(tx('admin.compliance.open_user.address'), 'address', r.address)}${row(tx('admin.compliance.open_user.phone'), 'phone', r.phone?.masked)}
      ${row(tx('admin.compliance.open_user.national_id'), 'national_id', r.national_id)}<dt>${te('admin.compliance.open_user.email_verified')}</dt><dd>${r.email_verified ? 'yes' : 'no'}</dd><dt>${te('admin.compliance.open_user.duplicate_id')}</dt><dd>${r.duplicate_national_id ? badge('matches another account', 'bad') : 'no'}</dd>
      <dt>${te('admin.compliance.open_user.risk')}</dt><dd>${esc(r.risk.latest_score ?? '—')} ${r.risk.latest_signals.map((s) => badge(s.label || s.code, 'warn')).join(' ')}</dd><dt>${te('admin.compliance.open_user.attempts')}</dt><dd>${esc(r.verification.attempts)}</dd></dl>
    <p class="faint">${te('admin.compliance.open_user.national_id_numbers_are_never')}</p>
    <h4>${te('admin.compliance.open_user.id_documents')}</h4><ul class="adm-list" data-testid="identity-documents">${(r.documents || []).map((x) => `<li data-doc="${esc(x.id)}">${esc(x.label)} · ${esc(x.width)}×${esc(x.height)} · ${esc(fmtTime(x.uploaded_time))}${revealable ? ` <button class="btn btn-sm btn-ghost" data-view-doc="${esc(x.id)}" data-testid="view-document">${te('admin.compliance.open_user.view')}</button>` : ''}<div data-doc-img></div></li>`).join('') || `<li class="faint">${te('admin.compliance.open_user.no_documents_on_file_erased')}</li>`}</ul>
    <h4>${te('admin.compliance.open_user.history')}</h4><ul class="adm-list">${r.kyc_history.map((h) => `<li>${esc(fmtTime(h.time))} · ${esc(h.source)} · ${esc(h.decision)}${h.reason_category ? ` (${esc(h.reason_category)})` : ''}${h.actor ? ` · ${esc(h.actor)}` : ''}${h.note ? ` — ${esc(h.note)}` : ''}</li>`).join('') || `<li class="faint">${te('admin.compliance.open_user.no_decisions_yet')}</li>`}</ul>
    ${canDecide ? `<form class="adm-form" data-decide data-testid="kyc-decision-form"><div class="adm-form-grid"><label class="field"><span>${te('admin.compliance.open_user.decision')}</span><select name="decision" data-testid="kyc-decision"><option value="approve">${te('admin.compliance.open_user.approve')}</option><option value="reject">${te('admin.compliance.open_user.reject')}</option><option value="retry">${te('admin.compliance.open_user.ask_the_customer_to_retry')}</option></select></label>
      <label class="field"><span>${te('admin.compliance.open_user.reason_category')}</span><select name="reason_category" data-testid="kyc-reason"><option value="">—</option>${REASONS.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>
      <label class="field span2"><span>${te('admin.compliance.open_user.note_audit_log')}</span><textarea name="note" rows="2" maxlength="500" data-testid="kyc-note"></textarea></label></div>
      <div class="adm-form-actions"><button class="btn btn-primary" type="submit" data-testid="kyc-submit">${te('admin.compliance.open_user.record_decision')}</button><small class="adm-err" data-err role="alert"></small></div></form>` : ''}
    <div class="adm-form-actions"><button class="btn" data-close>${te('admin.compliance.open_user.close')}</button></div></div>`, { wide: true, testid: 'identity-dialog' });
  d.querySelector('[data-close]').onclick = () => d.close();
  for (const b of d.querySelectorAll('[data-reveal]')) {
    b.onclick = async () => {
      const ok = await confirmAction({ title: tx('admin.compliance.open_user.reveal_2', { replace: b.dataset.reveal.replace(/_/g, ' ') }), body: tx('admin.compliance.open_user.this_is_recorded_in_the'), confirm: tx('admin.compliance.open_user.reveal'), reason: true, reasonLabel: tx('admin.compliance.open_user.why_do_you_need_to') });
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
  for (const b of d.querySelectorAll('[data-view-doc]')) {
    b.onclick = async () => {
      const ok = await confirmAction({ title: tx('admin.compliance.open_user.view_this_id_document'), body: tx('admin.compliance.open_user.this_is_recorded_in_the'), confirm: tx('admin.compliance.open_user.view'), reason: true, reasonLabel: tx('admin.compliance.open_user.why_do_you_need_to') });
      if (!ok) return;
      try {
        const v = await post(`/kyc/${encodeURIComponent(r.user_id)}/documents/${encodeURIComponent(b.dataset.viewDoc)}/view`, { reason: ok.reason });
        const img = document.createElement('img');
        img.className = 'adm-doc-img';
        img.alt = tx('admin.compliance.open_user.shown_to_staff_audited', { kind: v.kind });
        img.dataset.testid = 'document-image';
        img.src = v.url; // a signed URL valid for one minute and only for this staff session (CLONE_SPEC.md §39.4)
        b.closest('li').querySelector('[data-doc-img]').replaceChildren(img);
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
      toast(tx('admin.compliance.open_user.decision_recorded', { status: out.status }));
      d.close();
      await reload();
    } catch (ex) { err.textContent = ex.message; }
  };
}

// ------------------------------------------------------------------ fraud: holds, risky activity, shared devices
async function fraud({ el, perms }) {
  el.innerHTML = section(tx('admin.compliance.fraud.fraud_holds'), tx('admin.compliance.fraud.withdrawals_held_by_the_risk')) +
    `<div class="adm-tiles" data-tiles></div><h3>${te('admin.compliance.fraud.withdrawal_holds')}</h3><div id="fh"></div><h3 class="mt-16">${te('admin.compliance.fraud.risk_assessments_7_days')}</h3><div id="fr"></div><h3 class="mt-16">${te('admin.compliance.fraud.shared_devices_30_days')}</h3><div id="fd"></div>`;
  const holds = dataTable(el.querySelector('#fh'), { testid: 'fraud-holds', pageSize: 20, rowAttrs: (r) => `data-hold="${esc(r.id)}" data-status="${esc(r.status)}"`,
    cols: [{ key: 'created_time', label: tx('admin.compliance.fraud.requested'), render: (r) => esc(fmtTime(r.created_time)) }, { key: 'email', label: 'Account' }, { key: 'amount_dollars', label: tx('admin.compliance.fraud.amount'), num: true, render: (r) => esc(fmtMoney(r.amount_dollars)) },
      { key: 'score', label: tx('admin.compliance.fraud.score'), num: true }, { key: 'signals', label: tx('admin.compliance.fraud.signals'), sort: false, render: (r) => r.signals.map((s) => badge(`${s.label || s.code} +${s.points}`, 'warn')).join(' ') },
      { key: 'status', label: tx('admin.compliance.fraud.status'), render: (r) => badge(r.status, r.status === 'held' ? 'warn' : r.status === 'released' ? 'ok' : '') },
      { key: '_a', label: '', sort: false, render: (r) => (r.status === 'held' && perms.has('users.money') ? `<button class="btn btn-sm" data-act="release" data-id="${esc(r.id)}" data-testid="hold-release">${te('admin.compliance.fraud.release')}</button> <button class="btn btn-sm" data-act="reverse" data-id="${esc(r.id)}" data-testid="hold-reverse">${te('admin.compliance.fraud.reverse')}</button>` : '') }] });
  const risky = dataTable(el.querySelector('#fr'), { testid: 'fraud-assessments', pageSize: 20,
    cols: [{ key: 'time', label: tx('admin.compliance.fraud.time'), render: (r) => esc(fmtTime(r.time)) }, { key: 'email', label: 'Account' }, { key: 'kind', label: tx('admin.compliance.fraud.kind') }, { key: 'amount_dollars', label: tx('admin.compliance.fraud.amount'), num: true, render: (r) => esc(r.amount_dollars == null ? '—' : fmtMoney(r.amount_dollars)) },
      { key: 'score', label: tx('admin.compliance.fraud.score'), num: true }, { key: 'action', label: tx('admin.compliance.fraud.action'), render: (r) => badge(r.action, r.action === 'hold' ? 'bad' : r.action === 'flag' ? 'warn' : '') }] });
  const shared = dataTable(el.querySelector('#fd'), { testid: 'fraud-devices', pageSize: 20, search: false, cols: [{ key: 'device', label: tx('admin.compliance.fraud.device_hash_prefix') }, { key: 'accounts', label: tx('admin.compliance.fraud.accounts'), num: true }, { key: 'last_seen_time', label: tx('admin.compliance.fraud.last_seen'), render: (r) => esc(fmtTime(r.last_seen_time)) }] });
  const load = async () => {
    const r = await get('/fraud/overview');
    el.querySelector('[data-tiles]').innerHTML = `<div class="adm-tile"><span>${te('admin.compliance.fraud.hold_threshold')}</span><b>${esc(r.threshold)}</b></div><div class="adm-tile"><span>${te('admin.compliance.fraud.holds_enabled')}</span><b data-testid="holds-enabled">${r.holds_enabled ? 'yes' : 'no'}</b></div>
      <div class="adm-tile"><span>${te('admin.compliance.fraud.open_holds')}</span><b data-testid="open-holds">${esc(r.holds.filter((h) => h.status === 'held').length)}</b></div><div class="adm-tile"><span>${te('admin.compliance.fraud.location_blocks_24_h')}</span><b>${esc(r.geo_blocked_24h)}</b></div>`;
    holds.setRows(r.holds); risky.setRows(r.assessments); shared.setRows(r.shared_devices);
  };
  el.querySelector('#fh').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const ok = await confirmAction({ title: b.dataset.act === 'release' ? tx('admin.compliance.fraud.release_this_withdrawal') : tx('admin.compliance.fraud.reverse_this_withdrawal'), body: b.dataset.act === 'release' ? tx('admin.compliance.fraud.the_funds_are_sent_to') : tx('admin.compliance.fraud.the_funds_go_back_to'), confirm: b.dataset.act === 'release' ? tx('admin.compliance.fraud.release') : tx('admin.compliance.fraud.reverse'), reason: true });
    if (!ok) return;
    try { await post(`/fraud/holds/${encodeURIComponent(b.dataset.id)}/${b.dataset.act}`, { reason: ok.reason }); toast(tx('admin.compliance.fraud.hold_decided')); await load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  await load();
}

// ------------------------------------------------------------------ compliance settings
async function settings({ el }) {
  const r = await get('/compliance/settings');
  const s = r.settings;
  const opts = r.countries.map((c) => `<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.name)}</option>`).join('');
  el.innerHTML = section(tx('admin.compliance.settings.compliance_settings'), tx('admin.compliance.settings.identity_verification_gating_blocked')) +
    `<form class="adm-form" data-testid="compliance-form" novalidate><div class="adm-form-grid">
      <label class="field"><span>${te('admin.compliance.settings.identity_verification_required_to_trade')}</span><select name="enforce" data-testid="cs-enforce"><option value="">${te('admin.compliance.settings.default', { value: s.default_enforce ? 'on' : te('admin.compliance.settings.off') })}</option><option value="true">${te('admin.compliance.settings.on')}</option><option value="false">${te('admin.compliance.settings.off_2')}</option></select><small class="faint">${te('admin.compliance.settings.effective_now', { value: s.enforce_effective ? 'on' : te('admin.compliance.settings.off') })}</small></label>
      <label class="field"><span>${te('admin.compliance.settings.unknown_local_ip_addresses')}</span><select name="unknown_ip"><option value="allow">${te('admin.compliance.settings.allow')}</option><option value="block">${te('admin.compliance.settings.block_unless_the_browser_location')}</option></select></label>
      <label class="field span2"><span>${te('admin.compliance.settings.blocked_countries_comma_separated_iso')}</span><input name="blocked" class="adm-input" data-testid="cs-blocked" value="${esc(s.blocked_countries.join(', '))}"><small class="faint">${te('admin.compliance.settings.known_codes', { value: esc(r.countries.map((c) => c.code).join(' ')) })}</small></label>
      <label class="field span2"><span>${te('admin.compliance.settings.simulated_ip_table_overrides_one')}</span><textarea name="ip_overrides" rows="3" data-testid="cs-ip-overrides">${esc(s.ip_overrides.map((o) => `${o.cidr} ${o.country}`).join('\n'))}</textarea></label>
      <label class="field"><span>${te('admin.compliance.settings.hold_withdrawals_at_risk_score')}</span><input name="hold_threshold" type="number" min="10" max="200" value="${esc(s.fraud.hold_threshold)}" data-testid="cs-threshold"></label>
      <label class="field"><span>${te('admin.compliance.settings.withdrawal_holds')}</span><select name="hold_withdrawals"><option value="">${te('admin.compliance.settings.follow_identity_gating')}</option><option value="true">${te('admin.compliance.settings.always_on')}</option><option value="false">${te('admin.compliance.settings.off_2')}</option></select></label>
      <label class="adm-check span2"><input type="checkbox" name="admin_passkey_required" data-testid="cs-admin-passkey" ${s.admin_passkey_required ? 'checked' : ''}> <span>${te('admin.compliance.settings.staff_must_sign_in_or')}</span></label>
      <label class="field"><span>${te('admin.compliance.settings.sms_codes_per_number_hour')}</span><input name="per_number_hour" type="number" min="0" value="${esc(s.sms.per_number_hour)}"></label>
      <label class="field"><span>${te('admin.compliance.settings.sms_codes_per_ip_hour')}</span><input name="per_ip_hour" type="number" min="0" value="${esc(s.sms.per_ip_hour)}"></label>
      <label class="field"><span>${te('admin.compliance.settings.sms_codes_per_account_day')}</span><input name="per_account_day" type="number" min="0" value="${esc(s.sms.per_account_day)}"></label>
      <label class="field"><span>${te('admin.compliance.settings.sms_codes_per_destination_country')}</span><input name="per_country_hour" type="number" min="0" value="${esc(s.sms.per_country_hour)}" data-testid="cs-country-hour"></label>
      <label class="field"><span>${te('admin.compliance.settings.identity_record_retention_after_closure')}</span><input name="kyc_days" type="number" min="365" max="3650" value="${esc(s.retention.kyc_days)}"></label>
      <label class="field span2"><span>${te('admin.compliance.settings.reason_for_this_change_audit')}</span><input name="reason" class="adm-input" maxlength="500"></label></div>
      <div class="adm-form-actions"><button class="btn btn-primary" type="submit" data-testid="cs-save">${te('admin.compliance.settings.save_settings')}</button><small class="adm-err" data-err role="alert" data-testid="cs-error"></small></div></form>
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
    try { await put('/compliance/settings', body); toast(tx('admin.compliance.settings.compliance_settings_saved')); await settings({ el }); } catch (ex) { err.textContent = ex.fields ? Object.entries(ex.fields).map(([k, m]) => `${k}: ${m}`).join('; ') : ex.message; }
  };
}

// ------------------------------------------------------------------ promo codes (A12): created here, redeemed by users once each
async function promos({ el }) {
  el.innerHTML = section(tx('admin.compliance.promos.promo_codes'), tx('admin.compliance.promos.codes_customers_enter_from_the')) +
    `<form class="adm-form" data-new data-testid="promo-form" novalidate><div class="adm-form-grid">
      <label class="field"><span>${te('admin.compliance.promos.code')}</span><input name="code" class="adm-input" maxlength="32" required data-testid="promo-code"></label>
      <label class="field"><span>${esc(T('admin.promo_credit', { code: currency.code }))}</span><input name="amount" type="number" min="${esc(moneyStep())}" max="${esc(currency.code === 'USD' ? 1000 : 100000)}" step="${esc(moneyStep())}" required data-testid="promo-amount"></label>
      <label class="field"><span>${te('admin.compliance.promos.max_redemptions_blank_unlimited')}</span><input name="max" type="number" min="1" data-testid="promo-max"></label>
      <label class="field"><span>${te('admin.compliance.promos.description')}</span><input name="description" class="adm-input" maxlength="140"></label>
      <label class="field"><span>${te('admin.compliance.promos.starts_optional')}</span><input name="starts" type="datetime-local"></label><label class="field"><span>${te('admin.compliance.promos.ends_optional')}</span><input name="ends" type="datetime-local"></label>
      <label class="field span2"><span>${te('admin.compliance.promos.reason_audit_log')}</span><input name="reason" class="adm-input" maxlength="500"></label></div>
      <div class="adm-form-actions"><button class="btn btn-primary" type="submit" data-testid="promo-create">${te('admin.compliance.promos.create_code')}</button><small class="adm-err" data-err role="alert" data-testid="promo-error"></small></div></form><div id="pl"></div>`;
  const t = dataTable(el.querySelector('#pl'), { testid: 'promo-list', pageSize: 25, rowAttrs: (r) => `data-promo="${esc(r.code)}"`,
    cols: [{ key: 'code', label: tx('admin.compliance.promos.code') }, { key: 'amount_dollars', label: 'Credit', num: true, render: (r) => esc(fmtMoney(r.amount_dollars)) }, { key: 'redeemed_count', label: tx('admin.compliance.promos.used'), num: true, render: (r) => `${esc(r.redeemed_count)}${r.max_redemptions ? ` / ${esc(r.max_redemptions)}` : ''}` },
      { key: 'ends_time', label: tx('admin.compliance.promos.ends'), render: (r) => esc(fmtTime(r.ends_time)) }, { key: 'active', label: tx('admin.compliance.promos.status'), render: (r) => badge(r.active ? 'active' : 'off', r.active ? 'ok' : '') },
      { key: '_a', label: '', sort: false, render: (r) => `<button class="btn btn-sm" data-toggle="${esc(r.id)}" data-active="${r.active ? '1' : ''}">${r.active ? te('admin.compliance.promos.turn_off') : te('admin.compliance.promos.turn_on')}</button>` }] });
  const load = async () => t.setRows((await get('/promo_codes')).promo_codes);
  const f = el.querySelector('[data-new]');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('[data-err]');
    err.textContent = '';
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    try {
      await post('/promo_codes', { code: f.code.value.trim(), amount_dollars: toApiDollars(f.amount.value), max_redemptions: f.max.value ? Number(f.max.value) : null, description: f.description.value, starts_time: iso(f.starts.value), ends_time: iso(f.ends.value), reason: f.reason.value });
      toast(tx('admin.compliance.promos.promo_code_created')); f.reset(); await load();
    } catch (ex) { err.textContent = ex.message; }
  };
  el.querySelector('#pl').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-toggle]');
    if (!b) return;
    try { await put(`/promo_codes/${encodeURIComponent(b.dataset.toggle)}`, { active: !b.dataset.active }); await load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  await load();
}
