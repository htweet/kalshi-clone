// Market ops (exchange switch, pause/resume, series fees, liquidity bot, combo eligibility, rolling windows) and
// Perps ops (halt/resume, max leverage, run funding now).
import { t as T } from '../../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { money, pxCents, priceUnit } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, post, put, toast, dataTable, formHtml, wireForm, dialog, confirmAction, section, statusBadge, badge, fmtTime, fmtQty } from './ui.js';

export async function render({ el, section: sec }) {
  if (sec === 'perps') return renderPerps(el);
  el.innerHTML = section('Market ops', 'Trading switches, fees and the liquidity bot. Every change needs a reason and is audited.') +
    `<div class="card adm-card adm-switch-card" id="ops-exchange"></div>
     <h3 class="adm-h3">Markets</h3><div id="ops-markets"></div>
     <div class="adm-two"><div><h3 class="adm-h3">Series fee multipliers</h3><div id="ops-series"></div></div><div><h3 class="adm-h3">Rolling markets</h3><div class="card adm-card" id="ops-rolling"></div></div></div>`;
  let data;
  const mt = dataTable(el.querySelector('#ops-markets'), { testid: 'ops-markets', rowAttrs: (r) => `data-row="${esc(r.ticker)}"`,
    cols: [
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
      { key: 'ticker', label: 'Market', render: (r) => `<div><code>${esc(r.ticker)}</code></div><div class="faint">${esc(r.outcome)}</div>` },
      { key: 'last_price_dollars', label: 'Last', num: true, render: (r) => (r.last_price_dollars == null ? '—' : esc(pxCents(Math.round(r.last_price_dollars * 100)))) },
      { key: 'yes_bid_dollars', label: 'Bid / Ask', num: true, render: (r) => `${r.yes_bid_dollars == null ? '—' : Math.round(r.yes_bid_dollars * 100)} / ${r.yes_ask_dollars == null ? '—' : Math.round(r.yes_ask_dollars * 100)}` },
      { key: 'volume_fp', label: 'Volume', num: true, render: (r) => fmtQty(r.volume_fp) },
      { key: 'liquidity', label: 'Liquidity bot', sort: (r) => (r.liquidity?.enabled ? 1 : 0), render: (r) => (r.liquidity ? (r.liquidity.enabled ? badge(`${r.liquidity.size_contracts} × ${r.liquidity.levels} @ ${pxCents(r.liquidity.spread_cents)}`, 'ok') : badge('off')) : '<span class="faint">seed only</span>') },
      ...(data?.combos_available !== false ? [{ key: 'combo_eligible', label: 'Combos', render: (r) => `<label class="adm-toggle"><input type="checkbox" data-combo="${esc(r.ticker)}" ${r.combo_eligible ? 'checked' : ''} aria-label="Combo eligible ${esc(r.ticker)}"><span></span></label>` }] : []),
      { key: '_a', label: '', sort: false, render: (r) => `<span class="adm-actions">${r.status === 'active' ? `<button class="btn btn-sm" data-pause="${esc(r.ticker)}">Pause</button>` : r.status === 'inactive' ? `<button class="btn btn-sm btn-primary" data-resume="${esc(r.ticker)}">Resume</button>` : ''}<button class="btn btn-sm" data-liq="${esc(r.ticker)}">Liquidity…</button></span>` },
    ] });
  const st = dataTable(el.querySelector('#ops-series'), { search: false, pageSize: 50, testid: 'ops-series',
    cols: [{ key: 'ticker', label: 'Series', render: (r) => `<code>${esc(r.ticker)}</code><div class="faint">${esc(r.title)}</div>` }, { key: 'fee_type', label: 'Type' }, { key: 'fee_multiplier', label: 'Multiplier', num: true },
      { key: '_a', label: '', sort: false, render: (r) => `<button class="btn btn-sm" data-fee="${esc(r.ticker)}">Edit</button>` }] });
  async function load() {
    data = await get('/ops');
    const ex = el.querySelector('#ops-exchange');
    ex.innerHTML = `<div><h3>Exchange trading</h3><p class="muted">When off, no event-contract or perps orders can be placed anywhere.</p></div>
      <div class="adm-switch-state" data-testid="exchange-state">${data.trading_active ? badge('Trading on', 'ok') : badge('Trading paused', 'bad')}</div>
      <button class="btn ${data.trading_active ? 'btn-danger-solid' : 'btn-primary'}" data-exchange="${data.trading_active ? 'off' : 'on'}" data-testid="exchange-toggle">${data.trading_active ? 'Pause all trading' : 'Resume trading'}</button>`;
    mt.setRows(data.markets);
    st.setRows(data.series);
    const r = data.rolling;
    el.querySelector('#ops-rolling').innerHTML = r ? `<dl class="adm-dl" data-testid="rolling-view"><dt>Window</dt><dd>${esc(r.window_seconds)} s</dd><dt>Series</dt><dd><code>${esc(r.series_ticker)}</code></dd><dt>Windows so far</dt><dd>${esc(r.windows_total)}</dd>
      <dt>Current</dt><dd>${r.current ? `${esc(fmtTime(r.current.start_time))} → ${esc(fmtTime(r.current.end_time))}, target ${esc(money(r.current.target_dollars))}` : '—'}</dd></dl>
      <p class="faint">Window length is set at boot (${esc(r.configurable)}).</p>
      <table class="table"><thead><tr><th>Ended</th><th class="num">Target</th><th class="num">Close</th><th>Result</th></tr></thead><tbody>${r.recent.map((w) => `<tr><td>${esc(fmtTime(w.end_time))}</td><td class="num">${esc(money(w.target_dollars))}</td><td class="num">${esc(money(w.close_dollars))}</td><td>${w.result === 'yes' ? 'Above' : 'Below'}</td></tr>`).join('') || '<tr><td colspan="4" class="faint">None yet</td></tr>'}</tbody></table>` : '<p class="faint">Rolling markets are not running.</p>';
  }
  await load();
  el.addEventListener('change', async (e) => {
    const t = e.target.dataset.combo;
    if (!t) return;
    try { await put(`/ops/markets/${encodeURIComponent(t)}/combo`, { eligible: e.target.checked }); toast(`${t} ${e.target.checked ? 'can' : 'can no longer'} be a combo leg`); } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message, 'error'); }
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.exchange) {
        const on = b.dataset.exchange === 'on';
        const ok = await confirmAction({ title: on ? 'Resume trading?' : 'Pause all trading?', body: on ? 'Order entry reopens on every market.' : 'Every new order is rejected until trading is resumed. Resting orders stay on the book.', confirm: on ? 'Resume' : 'Pause trading', danger: !on, reason: true });
        if (!ok) return;
        await post('/ops/exchange', { trading_active: on, reason: ok.reason }); toast(on ? 'Trading resumed' : 'Trading paused');
      } else if (b.dataset.pause || b.dataset.resume) {
        const t = b.dataset.pause || b.dataset.resume; const pause = !!b.dataset.pause;
        const ok = await confirmAction({ title: `${pause ? 'Pause' : 'Resume'} ${t}?`, body: pause ? 'New orders are rejected; resting orders can still be canceled.' : 'Resuming cancels all resting orders (exchange rule); a configured liquidity bot re-quotes.', confirm: pause ? 'Pause market' : 'Resume market', danger: pause, reason: true });
        if (!ok) return;
        await post(`/ops/markets/${encodeURIComponent(t)}/${pause ? 'pause' : 'resume'}`, { reason: ok.reason }); toast(`${t} ${pause ? 'paused' : 'resumed'}`);
      } else if (b.dataset.fee) {
        const s = data.series.find((x) => x.ticker === b.dataset.fee);
        const fields = [{ name: 'fee_multiplier', label: 'Fee multiplier (0-10)', type: 'number', step: '0.01', required: true, value: s.fee_multiplier }, { name: 'reason', label: 'Reason', required: true, span: true }];
        const d = dialog(`<h3>Fee multiplier · ${esc(s.ticker)}</h3><p class="muted">Taker fee = ceil(0.07 × C × P × (1 − P) × multiplier). Applies to new fills immediately.</p>${formHtml(fields, { submit: 'Save', id: 'fee', extra: '<button class="btn" type="button" data-close>Cancel</button>' })}`);
        d.querySelector('[data-close]').onclick = () => d.close();
        wireForm(d.querySelector('form'), fields, async (v) => { await put(`/ops/series/${encodeURIComponent(s.ticker)}/fee`, v); d.close(); toast('Fee multiplier saved'); await load(); });
        return;
      } else if (b.dataset.liq) {
        const m = data.markets.find((x) => x.ticker === b.dataset.liq);
        const l = m.liquidity || data.publish_liquidity;
        const fields = [{ name: 'enabled', label: 'Quote this market', type: 'checkbox', value: m.liquidity ? m.liquidity.enabled : true, span: true }, { name: 'spread_cents', label: T('admin.spread', { unit: priceUnit() }), type: 'number', value: l.spread_cents, required: true },
          { name: 'size_contracts', label: 'Size per level (contracts)', type: 'number', value: l.size_contracts, required: true }, { name: 'levels', label: 'Levels per side (1-5)', type: 'number', value: l.levels, required: true }];
        const d = dialog(`<h3>Liquidity bot · ${esc(m.ticker)}</h3><p class="muted">Saving cancels the liquidity account's resting orders here and re-quotes around the last price.</p>${formHtml(fields, { submit: 'Save and re-quote', id: 'liq', extra: '<button class="btn" type="button" data-close>Cancel</button>', testid: 'liquidity-form' })}`);
        d.querySelector('[data-close]').onclick = () => d.close();
        wireForm(d.querySelector('form'), fields, async (v) => { const r = await put(`/ops/markets/${encodeURIComponent(m.ticker)}/liquidity`, v); d.close(); toast(`Re-quoted: ${r.requote.placed} placed, ${r.requote.canceled} canceled`); await load(); });
        return;
      } else return;
      await load();
    } catch (ex) { toast(ex.message, 'error'); }
  });
}

async function renderPerps(el) {
  el.innerHTML = section('Perps ops', 'Halt or resume perpetual markets, cap leverage and trigger a funding run.') + '<div id="pp"></div>';
  let rows = [];
  const t = dataTable(el.querySelector('#pp'), { search: false, testid: 'perps-ops', rowAttrs: (r) => `data-row="${esc(r.ticker)}"`,
    cols: [{ key: 'status', label: 'Status', render: (r) => statusBadge(r.status) }, { key: 'ticker', label: 'Market', render: (r) => `<code>${esc(r.ticker)}</code><div class="faint">${esc(r.title)} · ${esc(r.asset_class)}</div>` },
      { key: 'index_price', label: 'Index', num: true }, { key: 'max_leverage', label: 'Max leverage', num: true, render: (r) => `${r.max_leverage}×` },
      { key: 'next_funding_time', label: 'Next funding', render: (r) => esc(fmtTime(r.next_funding_time)) },
      { key: '_a', label: '', sort: false, render: (r) => `<span class="adm-actions">${r.status === 'active' ? `<button class="btn btn-sm" data-halt="${esc(r.ticker)}">Halt</button>` : `<button class="btn btn-sm btn-primary" data-resume="${esc(r.ticker)}">Resume</button>`}<button class="btn btn-sm" data-lev="${esc(r.ticker)}">Leverage…</button><button class="btn btn-sm" data-fund="${esc(r.ticker)}">Run funding</button></span>` }] });
  const load = async () => { const r = await get('/perps'); rows = r.markets; t.setRows(rows); if (!r.available) el.querySelector('#pp').insertAdjacentHTML('beforeend', '<p class="faint">Perps are not installed.</p>'); };
  await load();
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.halt) { const ok = await confirmAction({ title: `Halt ${b.dataset.halt}?`, body: 'Order entry stops and the simulated index freezes until resumed.', confirm: 'Halt', danger: true, reason: true }); if (!ok) return; await post(`/perps/${b.dataset.halt}/halt`, { reason: ok.reason }); toast('Halted'); }
      else if (b.dataset.resume) { await post(`/perps/${b.dataset.resume}/resume`, {}); toast('Resumed'); }
      else if (b.dataset.fund) { const ok = await confirmAction({ title: `Run funding on ${b.dataset.fund} now?`, body: 'Longs and shorts exchange the current funding payment immediately.', confirm: 'Run funding' }); if (!ok) return; await post(`/perps/${b.dataset.fund}/funding`, {}); toast('Funding run complete'); }
      else if (b.dataset.lev) {
        const m = rows.find((x) => x.ticker === b.dataset.lev);
        const fields = [{ name: 'max_leverage', label: 'Max leverage (1-100)', type: 'number', step: '0.5', required: true, value: m.max_leverage }, { name: 'reason', label: 'Reason', required: true }];
        const d = dialog(`<h3>Max leverage · ${esc(m.ticker)}</h3>${formHtml(fields, { submit: 'Save', id: 'lev', extra: '<button class="btn" type="button" data-close>Cancel</button>' })}`);
        d.querySelector('[data-close]').onclick = () => d.close();
        wireForm(d.querySelector('form'), fields, async (v) => { await put(`/perps/${m.ticker}/leverage`, v); d.close(); toast('Leverage saved'); await load(); });
        return;
      } else return;
      await load();
    } catch (ex) { toast(ex.message, 'error'); }
  });
}
