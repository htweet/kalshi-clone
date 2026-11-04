// Resolution desk: closed / past-close markets, resolve with a required source note (a value for scalar markets),
// reversal before settlement, settle now, early close; Phase 5A (CLONE_SPEC.md §28.7): settlement correction after
// payout (claw-back / re-pay, step-up), the optional two-person rule and its approvals queue.
import { pxc, fmtDt } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, post, put, toast, dataTable, confirmAction, section, statusBadge, badge, fmtTime, fmtQty, fmtMoney } from './ui.js';

const settlementLabel = (r) => (r.settlement === 'settled' ? badge('settled', 'ok') : r.settlement === 'pending_settlement' ? badge(`settles ${fmtDt(r.settles_at, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, 'warn') : badge('awaiting result'));

export async function render({ el, perms }) {
  const canWrite = perms.has('resolution.write');
  const canPolicy = perms.has('settings.write');
  el.innerHTML = section('Resolution desk', 'Markets that have closed (or passed their close time) wait here for a result. Every resolution needs a source note; a result can be reversed until the settlement timer runs out. After payout, a settlement can be corrected: the difference is clawed back or paid through the ledger, and every affected trader is notified.') +
    '<div class="card adm-card" id="res-policy"></div><div id="res-approvals"></div><div id="res-queue"></div><h3 class="adm-h3">Close a market early</h3><div class="card adm-card" id="res-early"></div>';
  const resultLabel = (r) => (r.market_type === 'scalar' && r.expiration_value != null ? `${esc(r.expiration_value)} · YES ${esc(pxc(Math.round(Number(r.settlement_value_dollars) * 10000)))}` : esc(String(r.result).toUpperCase()));
  let data;
  const table = dataTable(el.querySelector('#res-queue'), {
    testid: 'resolution-queue', empty: 'No markets are waiting for a result.', rowAttrs: (r) => `data-row="${esc(r.ticker)}" data-status="${esc(r.status)}"`,
    cols: [
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
      { key: 'ticker', label: 'Market', render: (r) => `<div><code>${esc(r.ticker)}</code></div><div class="faint">${esc(r.event_title)} · ${esc(r.outcome)}</div>` },
      { key: 'close_time', label: 'Closed', render: (r) => esc(fmtTime(r.close_time)) },
      { key: 'open_interest_fp', label: 'Open interest', num: true, render: (r) => fmtQty(r.open_interest_fp) },
      { key: 'result', label: 'Result', render: (r) => (r.result ? `<b class="res-${esc(r.result)}" data-testid="desk-result">${resultLabel(r)}</b>` : (r.market_type === 'scalar' ? '<span class="faint">scalar</span>' : '—')) },
      { key: 'settlement', label: 'Settlement', render: (r) => `${settlementLabel(r)}${r.payouts ? `<div class="faint">${esc(r.payouts.users)} paid · ${fmtMoney(r.payouts.paid_dollars)}</div>` : ''}` },
      { key: 'resolution', label: 'Source note', sort: false, render: (r) => (r.resolution ? `<div class="adm-note">${esc(r.resolution.source_note)}</div><div class="faint">${esc(r.resolution.resolved_by || '')}${r.resolution.status === 'reversed' ? ' · reversed' : ''}</div>` : '<span class="faint">—</span>') },
      ...(canWrite ? [{ key: '_a', label: '', sort: false, render: (r) => `<span class="adm-actions">
        ${['closed', 'active', 'inactive'].includes(r.status) ? `<button class="btn btn-sm btn-primary" data-resolve="${esc(r.ticker)}">Resolve</button>` : ''}
        ${r.status === 'determined' ? `<button class="btn btn-sm btn-ghost btn-danger" data-reverse="${esc(r.ticker)}">Reverse</button><button class="btn btn-sm" data-finalize="${esc(r.ticker)}">Settle now</button>` : ''}
        ${r.status === 'finalized' ? `<button class="btn btn-sm btn-ghost btn-danger" data-correct="${esc(r.ticker)}">Correct settlement…</button>` : ''}</span>` }] : []),
    ],
  });
  async function load() {
    const [q, ap] = await Promise.all([get('/resolution/queue'), get('/resolution/approvals').catch(() => ({ approvals: [], policy: { two_person_rule: false } }))]);
    data = q;
    table.setRows(data.queue);
    const pol = el.querySelector('#res-policy');
    pol.innerHTML = `<div class="adm-policy" data-testid="two-person-policy"><strong>Two-person rule</strong> ${ap.policy.two_person_rule ? badge('on', 'ok') : badge('off')}
      <span class="faint">With it on, a resolution or a settlement correction waits until a second admin approves it.</span>
      ${canPolicy ? `<button class="btn btn-sm" data-policy="${ap.policy.two_person_rule ? 'off' : 'on'}" data-testid="two-person-toggle">${ap.policy.two_person_rule ? 'Turn off' : 'Turn on'}</button>` : ''}</div>`;
    const apBox = el.querySelector('#res-approvals');
    apBox.innerHTML = ap.approvals.length ? `<h3 class="adm-h3">Waiting for a second admin</h3><table class="adm-table" data-testid="approvals-table"><thead><tr><th>Request</th><th>Market</th><th>Change</th><th>Requested by</th><th>Reason</th><th></th></tr></thead><tbody>
      ${ap.approvals.map((a) => `<tr data-approval="${esc(a.id)}"><td>${esc(a.kind === 'correct' ? 'Settlement correction' : 'Resolution')}</td><td><code>${esc(a.market_ticker)}</code></td>
        <td>${a.payload.result === 'scalar' ? `value ${esc(a.payload.expiration_value)}` : esc(String(a.payload.result).toUpperCase())}</td><td>${esc(a.requested_by)} <div class="faint">${esc(fmtTime(a.requested_time))}</div></td><td class="adm-note">${esc(a.reason)}</td>
        <td>${canWrite ? `<span class="adm-actions"><button class="btn btn-sm btn-primary" data-approve="${esc(a.id)}">Approve</button><button class="btn btn-sm btn-ghost" data-reject="${esc(a.id)}">Reject</button></span>` : ''}</td></tr>`).join('')}</tbody></table>` : '';
    const early = el.querySelector('#res-early');
    early.innerHTML = canWrite ? `<form class="inline-form" data-early data-testid="early-close-form"><label class="field"><span>Open market</span><select name="ticker">${data.open.filter((m) => m.can_close_early).map((m) => `<option value="${esc(m.ticker)}">${esc(m.ticker)} — ${esc(m.outcome)}</option>`).join('')}</select></label><button class="btn" type="submit">Close early…</button></form>` : '<p class="faint">Your role cannot close markets.</p>';
    early.querySelector('[data-early]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = e.target.ticker.value;
      const ok = await confirmAction({ title: `Close ${t} now?`, body: 'Trading stops immediately and all resting orders are canceled. The market then appears in the queue for resolution.', confirm: 'Close market', danger: true, reason: true });
      if (!ok) return;
      try { await post(`/resolution/${encodeURIComponent(t)}/close`, { reason: ok.reason }); toast(`${t} closed`); await load(); } catch (ex) { toast(ex.message, 'error'); }
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
        const ok = await confirmAction({ title: `Resolve ${r.ticker}`, body: `${esc(r.event_title)} · <b>${esc(r.outcome)}</b>`, confirm: 'Resolve market',
          extraHtml: `${scalar ? `<label class="field"><span>Reported value (floor ${esc(r.floor_strike)}, cap ${esc(r.cap_strike)}${esc(r.scalar_unit ? ` ${r.scalar_unit}` : '')})</span><input type="number" step="any" name="value" data-testid="resolve-value"></label>`
    : `<fieldset class="adm-choice" data-testid="resolve-choice"><legend>Result</legend><label><input type="radio" name="result" value="yes"> YES — ${esc(r.outcome)} happened</label><label><input type="radio" name="result" value="no"> NO — it did not</label></fieldset>`}
            <label class="field"><span>Source note (required): what was checked, where, when</span><textarea name="source_note" rows="3" data-testid="resolve-note"></textarea><small class="adm-err" data-note-err role="alert"></small></label>
            <label class="field"><span>Settlement delay (seconds before payout)</span><input type="number" name="delay" min="0" value="${esc(r.settlement_timer_seconds)}" data-testid="resolve-delay"><small class="faint">The result can be reversed during this window.</small></label>` });
        if (!ok) return;
        const f = ok.form;
        const result = scalar ? null : f.querySelector('input[name=result]:checked')?.value;
        const value = scalar ? f.value.value : null;
        const note = f.source_note.value.trim();
        if ((scalar ? value === '' : !result) || note.length < 5) { toast(scalar && value === '' ? 'Enter the reported value' : !scalar && !result ? 'Choose YES or NO' : 'A source note of at least 5 characters is required', 'error'); return; }
        const res = await post(`/resolution/${encodeURIComponent(r.ticker)}/resolve`, { ...(scalar ? { expiration_value: Number(value) } : { result }), source_note: note, settlement_delay_sec: f.delay.value === '' ? undefined : Number(f.delay.value) });
        toast(res.status === 'pending_approval' ? 'Sent for a second admin to approve' : `${r.ticker} resolved ${scalar ? `at ${value}` : result.toUpperCase()}`);
      } else if (b.dataset.reverse) {
        const ok = await confirmAction({ title: `Reverse the result of ${b.dataset.reverse}?`, body: 'The market returns to Closed with no result. No money has moved yet, so nothing needs to be clawed back.', confirm: 'Reverse result', danger: true, reason: true, reasonLabel: 'Why is the result wrong? (required)' });
        if (!ok) return;
        await post(`/resolution/${encodeURIComponent(b.dataset.reverse)}/reverse`, { note: ok.reason });
        toast('Result reversed');
      } else if (b.dataset.correct) {
        const r = data.queue.find((x) => x.ticker === b.dataset.correct);
        const scalar = r.market_type === 'scalar';
        const ok = await confirmAction({ title: `Correct the settlement of ${r.ticker}?`, danger: true, confirm: 'Correct settlement', reason: true, reasonLabel: 'Why is the settled result wrong? (required, 10+ characters; sent to affected traders)',
          body: `Settled ${resultLabel(r)} and paid ${esc(r.payouts ? r.payouts.users : 0)} traders. Correcting it claws back overpayments and pays the shortfall through the ledger; a trader's cash may go negative (they owe it, withdrawals pause until repaid).`,
          extraHtml: scalar ? '<label class="field"><span>Corrected value</span><input type="number" step="any" name="value" data-testid="correct-value"></label>'
            : `<fieldset class="adm-choice" data-testid="correct-choice"><legend>Corrected result</legend><label><input type="radio" name="result" value="yes" ${r.result === 'yes' ? 'disabled' : ''}> YES</label><label><input type="radio" name="result" value="no" ${r.result === 'no' ? 'disabled' : ''}> NO</label></fieldset>` });
        if (!ok) return;
        const result = scalar ? null : ok.form.querySelector('input[name=result]:checked')?.value;
        const value = scalar ? ok.form.value.value : null;
        if (scalar ? value === '' : !result) { toast(scalar ? 'Enter the corrected value' : 'Choose the corrected result', 'error'); return; }
        if (ok.reason.length < 10) { toast('A reason of at least 10 characters is required', 'error'); return; }
        const res = await post(`/resolution/${encodeURIComponent(r.ticker)}/correct`, { ...(scalar ? { expiration_value: Number(value) } : { result }), reason: ok.reason });
        toast(res.status === 'pending_approval' ? 'Correction sent for a second admin to approve' : `Settlement corrected · clawed back ${fmtMoney(res.correction.clawback_dollars)}, paid ${fmtMoney(res.correction.repaid_dollars)}`);
      } else if (b.dataset.approve) {
        const ok = await confirmAction({ title: 'Approve this request?', body: 'It runs immediately, as you. You cannot approve your own request.', confirm: 'Approve' });
        if (!ok) return;
        const res = await post(`/resolution/approvals/${encodeURIComponent(b.dataset.approve)}/approve`, {});
        toast(res.correction ? `Approved · settlement corrected (clawed back ${fmtMoney(res.correction.clawback_dollars)})` : 'Approved · market resolved');
      } else if (b.dataset.reject) {
        const ok = await confirmAction({ title: 'Reject this request?', confirm: 'Reject', danger: true, reason: true });
        if (!ok) return;
        await post(`/resolution/approvals/${encodeURIComponent(b.dataset.reject)}/reject`, { note: ok.reason });
        toast('Request rejected');
      } else if (b.dataset.policy) {
        await put('/resolution/policy', { two_person_rule: b.dataset.policy === 'on' });
        toast(`Two-person rule ${b.dataset.policy}`);
      } else if (b.dataset.finalize) {
        const ok = await confirmAction({ title: `Settle ${b.dataset.finalize} now?`, body: 'Payouts are credited immediately and the result becomes final.', confirm: 'Settle now', danger: true });
        if (!ok) return;
        await post(`/resolution/${encodeURIComponent(b.dataset.finalize)}/finalize`);
        toast('Settled');
      } else return;
      await load();
    } catch (ex) { toast(ex.message, 'error'); }
  });
  const iv = setInterval(() => { if (!document.querySelector('dialog[open]')) load().catch(() => {}); }, 5000);
  return () => clearInterval(iv);
}
