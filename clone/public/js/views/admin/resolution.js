// Resolution desk: closed / past-close markets, resolve with a required source note, reversal before settlement,
// settle now, early close.
import { esc, get, post, toast, dataTable, confirmAction, section, statusBadge, badge, fmtTime, fmtQty, fmtMoney } from './ui.js';

const settlementLabel = (r) => (r.settlement === 'settled' ? badge('settled', 'ok') : r.settlement === 'pending_settlement' ? badge(`settles ${new Date(r.settles_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, 'warn') : badge('awaiting result'));

export async function render({ el, perms }) {
  const canWrite = perms.has('resolution.write');
  el.innerHTML = section('Resolution desk', 'Markets that have closed (or passed their close time) wait here for a result. Every resolution needs a source note; a result can be reversed until the settlement timer runs out — after payout it is final.') +
    '<div id="res-queue"></div><h3 class="adm-h3">Close a market early</h3><div class="card adm-card" id="res-early"></div>';
  let data;
  const table = dataTable(el.querySelector('#res-queue'), {
    testid: 'resolution-queue', empty: 'No markets are waiting for a result.', rowAttrs: (r) => `data-row="${esc(r.ticker)}" data-status="${esc(r.status)}"`,
    cols: [
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
      { key: 'ticker', label: 'Market', render: (r) => `<div><code>${esc(r.ticker)}</code></div><div class="faint">${esc(r.event_title)} · ${esc(r.outcome)}</div>` },
      { key: 'close_time', label: 'Closed', render: (r) => esc(fmtTime(r.close_time)) },
      { key: 'open_interest_fp', label: 'Open interest', num: true, render: (r) => fmtQty(r.open_interest_fp) },
      { key: 'result', label: 'Result', render: (r) => (r.result ? `<b class="res-${r.result}">${r.result.toUpperCase()}</b>` : '—') },
      { key: 'settlement', label: 'Settlement', render: (r) => `${settlementLabel(r)}${r.payouts ? `<div class="faint">${r.payouts.users} paid · ${fmtMoney(r.payouts.paid_dollars)}</div>` : ''}` },
      { key: 'resolution', label: 'Source note', sort: false, render: (r) => (r.resolution ? `<div class="adm-note">${esc(r.resolution.source_note)}</div><div class="faint">${esc(r.resolution.resolved_by || '')}${r.resolution.status === 'reversed' ? ' · reversed' : ''}</div>` : '<span class="faint">—</span>') },
      ...(canWrite ? [{ key: '_a', label: '', sort: false, render: (r) => `<span class="adm-actions">
        ${['closed', 'active', 'inactive'].includes(r.status) ? `<button class="btn btn-sm btn-primary" data-resolve="${esc(r.ticker)}">Resolve</button>` : ''}
        ${r.status === 'determined' ? `<button class="btn btn-sm btn-ghost btn-danger" data-reverse="${esc(r.ticker)}">Reverse</button><button class="btn btn-sm" data-finalize="${esc(r.ticker)}">Settle now</button>` : ''}</span>` }] : []),
    ],
  });
  async function load() {
    data = await get('/resolution/queue');
    table.setRows(data.queue);
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
        const ok = await confirmAction({ title: `Resolve ${r.ticker}`, body: `${esc(r.event_title)} · <b>${esc(r.outcome)}</b>`, confirm: 'Resolve market',
          extraHtml: `<fieldset class="adm-choice" data-testid="resolve-choice"><legend>Result</legend><label><input type="radio" name="result" value="yes"> YES — ${esc(r.outcome)} happened</label><label><input type="radio" name="result" value="no"> NO — it did not</label></fieldset>
            <label class="field"><span>Source note (required): what was checked, where, when</span><textarea name="source_note" rows="3" data-testid="resolve-note"></textarea><small class="adm-err" data-note-err role="alert"></small></label>
            <label class="field"><span>Settlement delay (seconds before payout)</span><input type="number" name="delay" min="0" value="${r.settlement_timer_seconds}" data-testid="resolve-delay"><small class="faint">The result can be reversed during this window.</small></label>` });
        if (!ok) return;
        const f = ok.form;
        const result = f.querySelector('input[name=result]:checked')?.value;
        const note = f.source_note.value.trim();
        if (!result || note.length < 5) { toast(!result ? 'Choose YES or NO' : 'A source note of at least 5 characters is required', 'error'); return; }
        await post(`/resolution/${encodeURIComponent(r.ticker)}/resolve`, { result, source_note: note, settlement_delay_sec: f.delay.value === '' ? undefined : Number(f.delay.value) });
        toast(`${r.ticker} resolved ${result.toUpperCase()}`);
      } else if (b.dataset.reverse) {
        const ok = await confirmAction({ title: `Reverse the result of ${b.dataset.reverse}?`, body: 'The market returns to Closed with no result. No money has moved yet, so nothing needs to be clawed back.', confirm: 'Reverse result', danger: true, reason: true, reasonLabel: 'Why is the result wrong? (required)' });
        if (!ok) return;
        await post(`/resolution/${encodeURIComponent(b.dataset.reverse)}/reverse`, { note: ok.reason });
        toast('Result reversed');
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
