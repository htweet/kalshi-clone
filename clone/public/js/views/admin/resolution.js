// Resolution desk: closed / past-close markets, resolve with a required source note (a value for scalar markets),
// reversal before settlement, settle now, early close; Phase 5A (CLONE_SPEC.md §28.7): settlement correction after
// payout (claw-back / re-pay, step-up), the optional two-person rule and its approvals queue.
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.resolution-strings.js';
import { pxc, fmtDt } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, post, put, toast, dataTable, confirmAction, section, statusBadge, badge, fmtTime, fmtQty, fmtMoney } from './ui.js';

const settlementLabel = (r) => (r.settlement === 'settled' ? badge('settled', 'ok') : r.settlement === 'pending_settlement' ? badge(`settles ${fmtDt(r.settles_at, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, 'warn') : badge('awaiting result'));

export async function render({ el, perms }) {
  const canWrite = perms.has('resolution.write');
  const canPolicy = perms.has('settings.write');
  el.innerHTML = section(tx('admin.resolution.render.resolution_desk'), tx('admin.resolution.render.markets_that_have_closed_or')) +
    `<div class="card adm-card" id="res-policy"></div><div id="res-approvals"></div><div id="res-queue"></div><h3 class="adm-h3">${te('admin.resolution.render.close_a_market_early')}</h3><div class="card adm-card" id="res-early"></div>`;
  const resultLabel = (r) => (r.market_type === 'scalar' && r.expiration_value != null ? `${esc(r.expiration_value)} · YES ${esc(pxc(Math.round(Number(r.settlement_value_dollars) * 10000)))}` : esc(String(r.result).toUpperCase()));
  let data;
  const table = dataTable(el.querySelector('#res-queue'), {
    testid: 'resolution-queue', empty: tx('admin.resolution.render.no_markets_are_waiting_for'), rowAttrs: (r) => `data-row="${esc(r.ticker)}" data-status="${esc(r.status)}"`,
    cols: [
      { key: 'status', label: tx('admin.resolution.render.status'), render: (r) => statusBadge(r.status) },
      { key: 'ticker', label: 'Market', render: (r) => `<div><code>${esc(r.ticker)}</code></div><div class="faint">${esc(r.event_title)} · ${esc(r.outcome)}</div>` },
      { key: 'close_time', label: 'Closed', render: (r) => esc(fmtTime(r.close_time)) },
      { key: 'open_interest_fp', label: tx('admin.resolution.render.open_interest'), num: true, render: (r) => fmtQty(r.open_interest_fp) },
      { key: 'result', label: tx('admin.resolution.render.result'), render: (r) => (r.result ? `<b class="res-${esc(r.result)}" data-testid="desk-result">${resultLabel(r)}</b>` : (r.market_type === 'scalar' ? `<span class="faint">${te('admin.resolution.render.scalar')}</span>` : '—')) },
      { key: 'settlement', label: 'Settlement', render: (r) => `${settlementLabel(r)}${r.payouts ? `<div class="faint">${te('admin.resolution.render.paid', { users: esc(r.payouts.users), fmt_money: fmtMoney(r.payouts.paid_dollars) })}</div>` : ''}` },
      { key: 'resolution', label: tx('admin.resolution.render.source_note'), sort: false, render: (r) => (r.resolution ? `<div class="adm-note">${esc(r.resolution.source_note)}</div><div class="faint">${esc(r.resolution.resolved_by || '')}${r.resolution.status === 'reversed' ? (' ' + te('admin.resolution.render.reversed')) : ''}</div>` : '<span class="faint">—</span>') },
      ...(canWrite ? [{ key: '_a', label: '', sort: false, render: (r) => `<span class="adm-actions">
        ${['closed', 'active', 'inactive'].includes(r.status) ? `<button class="btn btn-sm btn-primary" data-resolve="${esc(r.ticker)}">${te('admin.resolution.render.resolve')}</button>` : ''}
        ${r.status === 'determined' ? `<button class="btn btn-sm btn-ghost btn-danger" data-reverse="${esc(r.ticker)}">${te('admin.resolution.render.reverse')}</button><button class="btn btn-sm" data-finalize="${esc(r.ticker)}">${te('admin.resolution.render.settle_now')}</button>` : ''}
        ${r.status === 'finalized' ? `<button class="btn btn-sm btn-ghost btn-danger" data-correct="${esc(r.ticker)}">${te('admin.resolution.render.correct_settlement')}</button>` : ''}</span>` }] : []),
    ],
  });
  async function load() {
    const [q, ap] = await Promise.all([get('/resolution/queue'), get('/resolution/approvals').catch(() => ({ approvals: [], policy: { two_person_rule: false } }))]);
    data = q;
    table.setRows(data.queue);
    const pol = el.querySelector('#res-policy');
    pol.innerHTML = `<div class="adm-policy" data-testid="two-person-policy"><strong>${te('admin.resolution.render.two_person_rule')}</strong> ${ap.policy.two_person_rule ? badge('on', 'ok') : badge('off')}
      <span class="faint">${te('admin.resolution.render.with_it_on_a_resolution')}</span>
      ${canPolicy ? `<button class="btn btn-sm" data-policy="${ap.policy.two_person_rule ? 'off' : 'on'}" data-testid="two-person-toggle">${ap.policy.two_person_rule ? te('admin.resolution.render.turn_off') : te('admin.resolution.render.turn_on')}</button>` : ''}</div>`;
    const apBox = el.querySelector('#res-approvals');
    apBox.innerHTML = ap.approvals.length ? `<h3 class="adm-h3">${te('admin.resolution.render.waiting_for_a_second_admin')}</h3><table class="adm-table" data-testid="approvals-table"><thead><tr><th>${te('admin.resolution.render.request')}</th><th>${te('admin.resolution.render.market')}</th><th>${te('admin.resolution.render.change')}</th><th>${te('admin.resolution.render.requested_by')}</th><th>${te('admin.resolution.render.reason')}</th><th></th></tr></thead><tbody>
      ${ap.approvals.map((a) => `<tr data-approval="${esc(a.id)}"><td>${esc(a.kind === 'correct' ? tx('admin.resolution.render.settlement_correction') : tx('admin.resolution.render.resolution'))}</td><td><code>${esc(a.market_ticker)}</code></td>
        <td>${a.payload.result === 'scalar' ? `value ${esc(a.payload.expiration_value)}` : esc(String(a.payload.result).toUpperCase())}</td><td>${esc(a.requested_by)} <div class="faint">${esc(fmtTime(a.requested_time))}</div></td><td class="adm-note">${esc(a.reason)}</td>
        <td>${canWrite ? `<span class="adm-actions"><button class="btn btn-sm btn-primary" data-approve="${esc(a.id)}">${te('admin.resolution.render.approve')}</button><button class="btn btn-sm btn-ghost" data-reject="${esc(a.id)}">${te('admin.resolution.render.reject')}</button></span>` : ''}</td></tr>`).join('')}</tbody></table>` : '';
    const early = el.querySelector('#res-early');
    early.innerHTML = canWrite ? `<form class="inline-form" data-early data-testid="early-close-form"><label class="field"><span>${te('admin.resolution.render.open_market')}</span><select name="ticker">${data.open.filter((m) => m.can_close_early).map((m) => `<option value="${esc(m.ticker)}">${esc(m.ticker)} — ${esc(m.outcome)}</option>`).join('')}</select></label><button class="btn" type="submit">${te('admin.resolution.render.close_early')}</button></form>` : `<p class="faint">${te('admin.resolution.render.your_role_cannot_close_markets')}</p>`;
    early.querySelector('[data-early]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = e.target.ticker.value;
      const ok = await confirmAction({ title: tx('admin.resolution.render.close_now', { t }), body: tx('admin.resolution.render.trading_stops_immediately_and_all'), confirm: tx('admin.resolution.render.close_market'), danger: true, reason: true });
      if (!ok) return;
      try { await post(`/resolution/${encodeURIComponent(t)}/close`, { reason: ok.reason }); toast(tx('admin.resolution.render.closed', { t })); await load(); } catch (ex) { toast(ex.message, 'error'); }
    });
  }
  await load();
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.resolve) {
        const r = data.queue.find((x) => x.ticker === b.dataset.resolve);
        const scalar = r.market_type === 'scalar';
        const ok = await confirmAction({ title: tx('admin.resolution.render.resolve_2', { ticker: r.ticker }), body: `${esc(r.event_title)} · <b>${esc(r.outcome)}</b>`, confirm: tx('admin.resolution.render.resolve_market'),
          extraHtml: `${scalar ? `<label class="field"><span>${te('admin.resolution.render.reported_value_floor_cap', { floor_strike: esc(r.floor_strike), cap_strike: esc(r.cap_strike), value: esc(r.scalar_unit ? ` ${r.scalar_unit}` : '') })}</span><input type="number" step="any" name="value" data-testid="resolve-value"></label>`
    : `<fieldset class="adm-choice" data-testid="resolve-choice"><legend>${te('admin.resolution.render.result')}</legend><label><input type="radio" name="result" value="yes"> ${te('admin.resolution.render.yes_happened', { outcome: esc(r.outcome) })}</label><label><input type="radio" name="result" value="no"> ${te('admin.resolution.render.no_it_did_not')}</label></fieldset>`}
            <label class="field"><span>${te('admin.resolution.render.source_note_required_what_was')}</span><textarea name="source_note" rows="3" data-testid="resolve-note"></textarea><small class="adm-err" data-note-err role="alert"></small></label>
            <label class="field"><span>${te('admin.resolution.render.settlement_delay_seconds_before_payout')}</span><input type="number" name="delay" min="0" value="${esc(r.settlement_timer_seconds)}" data-testid="resolve-delay"><small class="faint">${te('admin.resolution.render.the_result_can_be_reversed')}</small></label>` });
        if (!ok) return;
        const f = ok.form;
        const result = scalar ? null : f.querySelector('input[name=result]:checked')?.value;
        const value = scalar ? f.value.value : null;
        const note = f.source_note.value.trim();
        if ((scalar ? value === '' : !result) || note.length < 5) { toast(scalar && value === '' ? tx('admin.resolution.render.enter_the_reported_value') : !scalar && !result ? tx('admin.resolution.render.choose_yes_or_no') : tx('admin.resolution.render.a_source_note_of_at'), 'error'); return; }
        const res = await post(`/resolution/${encodeURIComponent(r.ticker)}/resolve`, { ...(scalar ? { expiration_value: Number(value) } : { result }), source_note: note, settlement_delay_sec: f.delay.value === '' ? undefined : Number(f.delay.value) });
        toast(res.status === 'pending_approval' ? tx('admin.resolution.render.sent_for_a_second_admin') : tx('admin.resolution.render.resolved', { ticker: r.ticker, value: scalar ? tx('admin.resolution.render.at', { value }) : result.toUpperCase() }));
      } else if (b.dataset.reverse) {
        const ok = await confirmAction({ title: tx('admin.resolution.render.reverse_the_result_of', { reverse: b.dataset.reverse }), body: tx('admin.resolution.render.the_market_returns_to_closed'), confirm: tx('admin.resolution.render.reverse_result'), danger: true, reason: true, reasonLabel: tx('admin.resolution.render.why_is_the_result_wrong') });
        if (!ok) return;
        await post(`/resolution/${encodeURIComponent(b.dataset.reverse)}/reverse`, { note: ok.reason });
        toast(tx('admin.resolution.render.result_reversed'));
      } else if (b.dataset.correct) {
        const r = data.queue.find((x) => x.ticker === b.dataset.correct);
        const scalar = r.market_type === 'scalar';
        const ok = await confirmAction({ title: tx('admin.resolution.render.correct_the_settlement_of', { ticker: r.ticker }), danger: true, confirm: tx('admin.resolution.render.correct_settlement_2'), reason: true, reasonLabel: tx('admin.resolution.render.why_is_the_settled_result'),
          body: tx('admin.resolution.render.settled_and_paid_traders_correcting', { result_label: resultLabel(r), value: esc(r.payouts ? r.payouts.users : 0) }),
          extraHtml: scalar ? `<label class="field"><span>${te('admin.resolution.render.corrected_value')}</span><input type="number" step="any" name="value" data-testid="correct-value"></label>`
            : `<fieldset class="adm-choice" data-testid="correct-choice"><legend>${te('admin.resolution.render.corrected_result')}</legend><label><input type="radio" name="result" value="yes" ${r.result === 'yes' ? 'disabled' : ''}> ${te('admin.resolution.render.yes')}</label><label><input type="radio" name="result" value="no" ${r.result === 'no' ? 'disabled' : ''}> ${te('admin.resolution.render.no')}</label></fieldset>` });
        if (!ok) return;
        const result = scalar ? null : ok.form.querySelector('input[name=result]:checked')?.value;
        const value = scalar ? ok.form.value.value : null;
        if (scalar ? value === '' : !result) { toast(scalar ? tx('admin.resolution.render.enter_the_corrected_value') : tx('admin.resolution.render.choose_the_corrected_result'), 'error'); return; }
        if (ok.reason.length < 10) { toast(tx('admin.resolution.render.a_reason_of_at_least'), 'error'); return; }
        const res = await post(`/resolution/${encodeURIComponent(r.ticker)}/correct`, { ...(scalar ? { expiration_value: Number(value) } : { result }), reason: ok.reason });
        toast(res.status === 'pending_approval' ? tx('admin.resolution.render.correction_sent_for_a_second') : tx('admin.resolution.render.settlement_corrected_clawed_back_paid', { fmt_money: fmtMoney(res.correction.clawback_dollars), fmt_money_2: fmtMoney(res.correction.repaid_dollars) }));
      } else if (b.dataset.approve) {
        const ok = await confirmAction({ title: tx('admin.resolution.render.approve_this_request'), body: tx('admin.resolution.render.it_runs_immediately_as_you'), confirm: tx('admin.resolution.render.approve') });
        if (!ok) return;
        const res = await post(`/resolution/approvals/${encodeURIComponent(b.dataset.approve)}/approve`, {});
        toast(res.correction ? tx('admin.resolution.render.approved_settlement_corrected_clawed', { fmt_money: fmtMoney(res.correction.clawback_dollars) }) : tx('admin.resolution.render.approved_market_resolved'));
      } else if (b.dataset.reject) {
        const ok = await confirmAction({ title: tx('admin.resolution.render.reject_this_request'), confirm: tx('admin.resolution.render.reject'), danger: true, reason: true });
        if (!ok) return;
        await post(`/resolution/approvals/${encodeURIComponent(b.dataset.reject)}/reject`, { note: ok.reason });
        toast(tx('admin.resolution.render.request_rejected'));
      } else if (b.dataset.policy) {
        await put('/resolution/policy', { two_person_rule: b.dataset.policy === 'on' });
        toast(tx('admin.resolution.render.two_person_rule_2', { policy: b.dataset.policy }));
      } else if (b.dataset.finalize) {
        const ok = await confirmAction({ title: tx('admin.resolution.render.settle_now_2', { finalize: b.dataset.finalize }), body: tx('admin.resolution.render.payouts_are_credited_immediately_and'), confirm: tx('admin.resolution.render.settle_now'), danger: true });
        if (!ok) return;
        await post(`/resolution/${encodeURIComponent(b.dataset.finalize)}/finalize`);
        toast(tx('admin.resolution.render.settled'));
      } else return;
      await load();
    } catch (ex) { toast(ex.message, 'error'); }
  });
  const iv = setInterval(() => { if (!document.querySelector('dialog[open]')) load().catch(() => {}); }, 5000);
  return () => clearInterval(iv);
}
