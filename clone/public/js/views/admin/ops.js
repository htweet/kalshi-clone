// Market ops (exchange switch, pause/resume, series fees, liquidity bot, combo eligibility, rolling windows) and
// Perps ops (halt/resume, max leverage, run funding now).
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.ops-strings.js';
import { t as T } from '../../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { money, pxCents, priceUnit } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, post, put, toast, dataTable, formHtml, wireForm, dialog, confirmAction, section, statusBadge, badge, fmtTime, fmtQty } from './ui.js';
import { renderPerpsOps } from './perps-ops.js'; // Phase 6: tiers, risk limits, APY, waitlist, referrals (CLONE_SPEC.md §34.10)

export async function render({ el, section: sec }) {
  if (sec === 'perps') return renderPerps(el);
  el.innerHTML = section(tx('admin.ops.render.market_ops'), tx('admin.ops.render.trading_switches_fees_and_the')) +
    `<div class="card adm-card adm-switch-card" id="ops-exchange"></div>
     <h3 class="adm-h3">${te('admin.ops.render.markets')}</h3><div id="ops-markets"></div>
     <div class="adm-two"><div><h3 class="adm-h3">${te('admin.ops.render.series_fee_multipliers')}</h3><div id="ops-series"></div></div><div><h3 class="adm-h3">${te('admin.ops.render.rolling_markets')}</h3><div class="card adm-card" id="ops-rolling"></div></div></div>`;
  let data;
  const mt = dataTable(el.querySelector('#ops-markets'), { testid: 'ops-markets', rowAttrs: (r) => `data-row="${esc(r.ticker)}"`,
    cols: [
      { key: 'status', label: tx('admin.ops.render.status'), render: (r) => statusBadge(r.status) },
      { key: 'ticker', label: 'Market', render: (r) => `<div><code>${esc(r.ticker)}</code></div><div class="faint">${esc(r.outcome)}</div>` },
      { key: 'last_price_dollars', label: tx('admin.ops.render.last'), num: true, render: (r) => (r.last_price_dollars == null ? '—' : esc(pxCents(Math.round(r.last_price_dollars * 100)))) },
      { key: 'yes_bid_dollars', label: tx('admin.ops.render.bid_ask'), num: true, render: (r) => `${r.yes_bid_dollars == null ? '—' : Math.round(r.yes_bid_dollars * 100)} / ${r.yes_ask_dollars == null ? '—' : Math.round(r.yes_ask_dollars * 100)}` },
      { key: 'volume_fp', label: tx('admin.ops.render.volume'), num: true, render: (r) => fmtQty(r.volume_fp) },
      { key: 'liquidity', label: tx('admin.ops.render.liquidity_bot_2'), sort: (r) => (r.liquidity?.enabled ? 1 : 0), render: (r) => (r.liquidity ? (r.liquidity.enabled ? badge(`${r.liquidity.size_contracts} × ${r.liquidity.levels} @ ${pxCents(r.liquidity.spread_cents)}`, 'ok') : badge('off')) : `<span class="faint">${te('admin.ops.render.seed_only')}</span>`) },
      ...(data?.combos_available !== false ? [{ key: 'combo_eligible', label: 'Combos', render: (r) => `<label class="adm-toggle"><input type="checkbox" data-combo="${esc(r.ticker)}" ${r.combo_eligible ? 'checked' : ''} aria-label="${te('admin.ops.render.combo_eligible', { ticker: esc(r.ticker) })}"><span></span></label>` }] : []),
      { key: '_a', label: '', sort: false, render: (r) => `<span class="adm-actions">${r.status === 'active' ? `<button class="btn btn-sm" data-pause="${esc(r.ticker)}">${te('admin.ops.render.pause')}</button>` : r.status === 'inactive' ? `<button class="btn btn-sm btn-primary" data-resume="${esc(r.ticker)}">${te('admin.ops.render.resume')}</button>` : ''}<button class="btn btn-sm" data-liq="${esc(r.ticker)}">${te('admin.ops.render.liquidity')}</button></span>` },
    ] });
  const st = dataTable(el.querySelector('#ops-series'), { search: false, pageSize: 50, testid: 'ops-series',
    cols: [{ key: 'ticker', label: tx('admin.ops.render.series'), render: (r) => `<code>${esc(r.ticker)}</code><div class="faint">${esc(r.title)}</div>` }, { key: 'fee_type', label: tx('admin.ops.render.type') }, { key: 'fee_multiplier', label: tx('admin.ops.render.multiplier'), num: true },
      { key: '_a', label: '', sort: false, render: (r) => `<button class="btn btn-sm" data-fee="${esc(r.ticker)}">${te('admin.ops.render.edit')}</button>` }] });
  async function load() {
    data = await get('/ops');
    const ex = el.querySelector('#ops-exchange');
    ex.innerHTML = `<div><h3>${te('admin.ops.render.exchange_trading')}</h3><p class="muted">${te('admin.ops.render.when_off_no_event_contract')}</p></div>
      <div class="adm-switch-state" data-testid="exchange-state">${data.trading_active ? badge(tx('admin.ops.render.trading_on'), 'ok') : badge(tx('admin.ops.render.trading_paused'), 'bad')}</div>
      <button class="btn ${data.trading_active ? 'btn-danger-solid' : 'btn-primary'}" data-exchange="${data.trading_active ? 'off' : 'on'}" data-testid="exchange-toggle">${data.trading_active ? te('admin.ops.render.pause_all_trading') : te('admin.ops.render.resume_trading')}</button>`;
    mt.setRows(data.markets);
    st.setRows(data.series);
    const r = data.rolling;
    el.querySelector('#ops-rolling').innerHTML = r ? `<dl class="adm-dl" data-testid="rolling-view"><dt>${te('admin.ops.render.window')}</dt><dd>${esc(r.window_seconds)} s</dd><dt>${te('admin.ops.render.series')}</dt><dd><code>${esc(r.series_ticker)}</code></dd><dt>${te('admin.ops.render.windows_so_far')}</dt><dd>${esc(r.windows_total)}</dd>
      <dt>${te('admin.ops.render.current')}</dt><dd>${r.current ? te('admin.ops.render.target', { fmt_time: esc(fmtTime(r.current.start_time)), fmt_time_2: esc(fmtTime(r.current.end_time)), money: esc(money(r.current.target_dollars)) }) : '—'}</dd></dl>
      <p class="faint">${te('admin.ops.render.window_length_is_set_at', { configurable: esc(r.configurable) })}</p>
      <table class="table"><thead><tr><th>${te('admin.ops.render.ended')}</th><th class="num">${te('admin.ops.render.target_2')}</th><th class="num">${te('admin.ops.render.close')}</th><th>${te('admin.ops.render.result')}</th></tr></thead><tbody>${r.recent.map((w) => `<tr><td>${esc(fmtTime(w.end_time))}</td><td class="num">${esc(money(w.target_dollars))}</td><td class="num">${esc(money(w.close_dollars))}</td><td>${w.result === 'yes' ? te('admin.ops.render.above') : te('admin.ops.render.below')}</td></tr>`).join('') || `<tr><td colspan="4" class="faint">${te('admin.ops.render.none_yet')}</td></tr>`}</tbody></table>` : `<p class="faint">${te('admin.ops.render.rolling_markets_are_not_running')}</p>`;
  }
  await load();
  el.addEventListener('change', async (e) => {
    const t = e.target.dataset.combo;
    if (!t) return;
    try { await put(`/ops/markets/${encodeURIComponent(t)}/combo`, { eligible: e.target.checked }); toast(tx('admin.ops.render.be_a_combo_leg', { t, value: e.target.checked ? 'can' : tx('admin.ops.render.can_no_longer') })); } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message, 'error'); }
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.exchange) {
        const on = b.dataset.exchange === 'on';
        const ok = await confirmAction({ title: on ? tx('admin.ops.render.resume_trading_2') : tx('admin.ops.render.pause_all_trading_2'), body: on ? tx('admin.ops.render.order_entry_reopens_on_every') : tx('admin.ops.render.every_new_order_is_rejected'), confirm: on ? tx('admin.ops.render.resume') : tx('admin.ops.render.pause_trading'), danger: !on, reason: true });
        if (!ok) return;
        await post('/ops/exchange', { trading_active: on, reason: ok.reason }); toast(on ? tx('admin.ops.render.trading_resumed') : tx('admin.ops.render.trading_paused'));
      } else if (b.dataset.pause || b.dataset.resume) {
        const t = b.dataset.pause || b.dataset.resume; const pause = !!b.dataset.pause;
        const ok = await confirmAction({ title: `${pause ? tx('admin.ops.render.pause') : tx('admin.ops.render.resume')} ${t}?`, body: pause ? tx('admin.ops.render.new_orders_are_rejected_resting') : tx('admin.ops.render.resuming_cancels_all_resting_orders'), confirm: pause ? tx('admin.ops.render.pause_market') : tx('admin.ops.render.resume_market'), danger: pause, reason: true });
        if (!ok) return;
        await post(`/ops/markets/${encodeURIComponent(t)}/${pause ? 'pause' : 'resume'}`, { reason: ok.reason }); toast(`${t} ${pause ? 'paused' : 'resumed'}`);
      } else if (b.dataset.fee) {
        const s = data.series.find((x) => x.ticker === b.dataset.fee);
        const fields = [{ name: 'fee_multiplier', label: tx('admin.ops.render.fee_multiplier_0_10'), type: 'number', step: '0.01', required: true, value: s.fee_multiplier }, { name: 'reason', label: tx('admin.ops.render.reason'), required: true, span: true }];
        const d = dialog(`<h3>${te('admin.ops.render.fee_multiplier', { ticker: esc(s.ticker) })}</h3><p class="muted">${te('admin.ops.render.taker_fee_ceil_0_07')}</p>${formHtml(fields, { submit: 'Save', id: 'fee', extra: `<button class="btn" type="button" data-close>${te('admin.ops.render.cancel')}</button>` })}`);
        d.querySelector('[data-close]').onclick = () => d.close();
        wireForm(d.querySelector('form'), fields, async (v) => { await put(`/ops/series/${encodeURIComponent(s.ticker)}/fee`, v); d.close(); toast(tx('admin.ops.render.fee_multiplier_saved')); await load(); });
        return;
      } else if (b.dataset.liq) {
        const m = data.markets.find((x) => x.ticker === b.dataset.liq);
        const l = m.liquidity || data.publish_liquidity;
        const fields = [{ name: 'enabled', label: tx('admin.ops.render.quote_this_market'), type: 'checkbox', value: m.liquidity ? m.liquidity.enabled : true, span: true }, { name: 'spread_cents', label: T('admin.spread', { unit: priceUnit() }), type: 'number', value: l.spread_cents, required: true },
          { name: 'size_contracts', label: tx('admin.ops.render.size_per_level_contracts'), type: 'number', value: l.size_contracts, required: true }, { name: 'levels', label: tx('admin.ops.render.levels_per_side_1_5'), type: 'number', value: l.levels, required: true }];
        const d = dialog(`<h3>${te('admin.ops.render.liquidity_bot', { ticker: esc(m.ticker) })}</h3><p class="muted">${te('admin.ops.render.saving_cancels_the_liquidity_account')}</p>${formHtml(fields, { submit: tx('admin.ops.render.save_and_re_quote'), id: 'liq', extra: `<button class="btn" type="button" data-close>${te('admin.ops.render.cancel')}</button>`, testid: 'liquidity-form' })}`);
        d.querySelector('[data-close]').onclick = () => d.close();
        wireForm(d.querySelector('form'), fields, async (v) => { const r = await put(`/ops/markets/${encodeURIComponent(m.ticker)}/liquidity`, v); d.close(); toast(tx('admin.ops.render.re_quoted_placed_canceled', { placed: r.requote.placed, canceled: r.requote.canceled })); await load(); });
        return;
      } else return;
      await load();
    } catch (ex) { toast(ex.message, 'error'); }
  });
}

async function renderPerps(el) {
  el.innerHTML = section(tx('admin.ops.render_perps.perps_ops'), tx('admin.ops.render_perps.halt_or_resume_perpetual_markets')) + '<div id="pp"></div><div id="pp-extra"></div>';
  let rows = [];
  const t = dataTable(el.querySelector('#pp'), { search: false, testid: 'perps-ops', rowAttrs: (r) => `data-row="${esc(r.ticker)}"`,
    cols: [{ key: 'status', label: tx('admin.ops.render_perps.status'), render: (r) => statusBadge(r.status) }, { key: 'ticker', label: 'Market', render: (r) => `<code>${esc(r.ticker)}</code><div class="faint">${esc(r.title)} · ${esc(r.asset_class)}</div>` },
      { key: 'index_price', label: tx('admin.ops.render_perps.index'), num: true }, { key: 'max_leverage', label: tx('admin.ops.render_perps.max_leverage_2'), num: true, render: (r) => `${r.max_leverage}×` },
      { key: 'next_funding_time', label: tx('admin.ops.render_perps.next_funding'), render: (r) => esc(fmtTime(r.next_funding_time)) },
      { key: '_a', label: '', sort: false, render: (r) => `<span class="adm-actions">${r.status === 'active' ? `<button class="btn btn-sm" data-halt="${esc(r.ticker)}">${te('admin.ops.render_perps.halt')}</button>` : `<button class="btn btn-sm btn-primary" data-resume="${esc(r.ticker)}">${te('admin.ops.render_perps.resume')}</button>`}<button class="btn btn-sm" data-lev="${esc(r.ticker)}">${te('admin.ops.render_perps.leverage')}</button><button class="btn btn-sm" data-fund="${esc(r.ticker)}">${te('admin.ops.render_perps.run_funding')}</button></span>` }] });
  const load = async () => { const r = await get('/perps'); rows = r.markets; t.setRows(rows); if (!r.available) el.querySelector('#pp').insertAdjacentHTML('beforeend', `<p class="faint">${te('admin.ops.render_perps.perps_are_not_installed')}</p>`); };
  // The buttons work as soon as they are drawn: the handler is attached before anything is awaited (the extra panels below
  // load slowly on a large database, and a click that came in before them used to do nothing).
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.halt) { const ok = await confirmAction({ title: tx('admin.ops.render_perps.halt_2', { halt: b.dataset.halt }), body: tx('admin.ops.render_perps.order_entry_stops_and_the'), confirm: tx('admin.ops.render_perps.halt'), danger: true, reason: true }); if (!ok) return; await post(`/perps/${b.dataset.halt}/halt`, { reason: ok.reason }); toast(tx('admin.ops.render_perps.halted')); }
      else if (b.dataset.resume) { await post(`/perps/${b.dataset.resume}/resume`, {}); toast(tx('admin.ops.render_perps.resumed')); }
      else if (b.dataset.fund) { const ok = await confirmAction({ title: tx('admin.ops.render_perps.run_funding_on_now', { fund: b.dataset.fund }), body: tx('admin.ops.render_perps.longs_and_shorts_exchange_the'), confirm: tx('admin.ops.render_perps.run_funding') }); if (!ok) return; await post(`/perps/${b.dataset.fund}/funding`, {}); toast(tx('admin.ops.render_perps.funding_run_complete')); }
      else if (b.dataset.lev) {
        const m = rows.find((x) => x.ticker === b.dataset.lev);
        const fields = [{ name: 'max_leverage', label: tx('admin.ops.render_perps.max_leverage_1_100'), type: 'number', step: '0.5', required: true, value: m.max_leverage }, { name: 'reason', label: tx('admin.ops.render_perps.reason'), required: true }];
        const d = dialog(`<h3>${te('admin.ops.render_perps.max_leverage', { ticker: esc(m.ticker) })}</h3>${formHtml(fields, { submit: 'Save', id: 'lev', extra: `<button class="btn" type="button" data-close>${te('admin.ops.render_perps.cancel')}</button>` })}`);
        d.querySelector('[data-close]').onclick = () => d.close();
        wireForm(d.querySelector('form'), fields, async (v) => { await put(`/perps/${m.ticker}/leverage`, v); d.close(); toast(tx('admin.ops.render_perps.leverage_saved')); await load(); });
        return;
      } else return;
      await load();
    } catch (ex) { toast(ex.message, 'error'); }
  });
  await load();
  await renderPerpsOps(el.querySelector('#pp-extra'));
}
