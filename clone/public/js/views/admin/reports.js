// Reports dashboard: totals + per-day series (volume, fees, deposits/withdrawals, active users, sign-ups), top markets,
// open-interest exposure (incl. the liquidity account), date range and CSV export. Own SVG charts, single series each.
import { t as tc } from '../../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { sym, moneyCompact } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, toast, dataTable, section, fmtMoney, fmtQty, barChart, wireCharts } from './ui.js';

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

export async function render({ el, query }) {
  const from = query.get('from') || ymd(Date.now() - 29 * 86400000);
  const to = query.get('to') || ymd(Date.now());
  el.innerHTML = section('Reports', 'Exchange activity for a date range (UTC days). Open interest and exposure are current figures.') +
    `<form class="adm-toolbar adm-range" data-range data-testid="report-range"><label class="field"><span>From</span><input type="date" name="from" value="${esc(from)}"></label><label class="field"><span>To</span><input type="date" name="to" value="${esc(to)}"></label>
      <div class="seg" role="group" aria-label="Quick ranges"><button type="button" data-days="7">7d</button><button type="button" data-days="30">30d</button><button type="button" data-days="90">90d</button></div>
      <button class="btn" type="submit">Apply</button><a class="btn" data-csv data-testid="report-csv" href="#" download>Export CSV</a></form><div id="rep"></div>`;
  const form = el.querySelector('[data-range]');
  const host = el.querySelector('#rep');
  async function load() {
    const qs = `?from=${encodeURIComponent(form.from.value)}&to=${encodeURIComponent(form.to.value)}`;
    el.querySelector('[data-csv]').href = `/v1/admin/reports.csv${qs}`;
    history.replaceState({}, '', `/admin/reports${qs}`);
    let r;
    try { r = await get(`/reports${qs}`); } catch (ex) { host.innerHTML = `<p class="adm-err" role="alert">${esc(ex.message)}${ex.fields ? ': ' + esc(Object.values(ex.fields).join('; ')) : ''}</p>`; return; }
    const T = r.totals;
    const tile = (k, label, val) => `<div class="adm-tile" data-metric="${esc(k)}"><span>${esc(label)}</span><b data-testid="metric-${esc(k)}">${esc(val)}</b></div>`;
    const pts = (key, fmt) => r.daily.map((d) => ({ label: d.day, value: Number(d[key]), display: fmt(d[key]) }));
    const money = (v) => fmtMoney(v); const n = (v) => Number(v).toLocaleString('en-US');
    const compactMoney = (v, axis) => (axis ? moneyCompact(v) : fmtMoney(v));
    const compactN = (v, axis) => (axis ? Number(v).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }) : n(v));
    const chart = (title, key, fmt, axisFmt) => `<div class="card adm-card"><h3>${esc(title)}</h3>${barChart(pts(key, fmt), { format: axisFmt, label: title })}</div>`;
    host.innerHTML = `<div class="adm-tiles" data-testid="report-totals">
        ${tile('volume_fp', 'Volume (contracts)', fmtQty(T.volume_fp))}${tile('volume_dollars', tc('admin.volume', { symbol: sym() }), fmtMoney(T.volume_dollars))}${tile('trades', 'Trades', n(T.trades))}
        ${tile('fees_dollars', 'Fees collected', fmtMoney(T.fees_dollars))}${tile('deposits_dollars', 'Deposits', fmtMoney(T.deposits_dollars))}${tile('withdrawals_dollars', 'Withdrawals', fmtMoney(T.withdrawals_dollars))}
        ${tile('active_users', 'Active traders', n(T.active_users))}${tile('signups', 'New sign-ups', n(T.signups))}${tile('open_interest_fp', 'Open interest (now)', fmtQty(T.open_interest_fp))}</div>
      <div class="adm-charts">${chart(tc('admin.volume_per_day', { symbol: sym() }), 'volume_dollars', money, compactMoney)}${chart('Volume (contracts) per day', 'volume_fp', fmtQty, compactN)}${chart('Fees per day', 'fees_dollars', money, compactMoney)}
        ${chart('Deposits per day', 'deposits_dollars', money, compactMoney)}${chart('Withdrawals per day', 'withdrawals_dollars', money, compactMoney)}${chart('Active traders per day', 'active_users', n, compactN)}${chart('Sign-ups per day', 'signups', n, compactN)}</div>
      <h3 class="adm-h3">Top markets by volume</h3><div id="rep-top"></div><h3 class="adm-h3">Exposure (open interest and liquidity-account position)</h3><div id="rep-exp"></div><h3 class="adm-h3">Daily table</h3><div id="rep-daily"></div>`;
    wireCharts(host);
    dataTable(host.querySelector('#rep-top'), { search: false, rows: r.top_markets, testid: 'report-top', empty: 'No trades in range.',
      cols: [{ key: 'ticker', label: 'Market', render: (m) => `<code>${esc(m.ticker)}</code><div class="faint">${esc(m.outcome)}</div>` }, { key: 'trades', label: 'Trades', num: true }, { key: 'volume_fp', label: 'Contracts', num: true, render: (m) => fmtQty(m.volume_fp) }, { key: 'volume_dollars', label: 'Dollars', num: true, render: (m) => fmtMoney(m.volume_dollars) }] });
    dataTable(host.querySelector('#rep-exp'), { search: false, rows: r.exposure, testid: 'report-exposure', empty: 'No open interest.',
      cols: [{ key: 'ticker', label: 'Market', render: (m) => `<code>${esc(m.ticker)}</code><div class="faint">${esc(m.outcome)}</div>` }, { key: 'status', label: 'Status' }, { key: 'open_interest_fp', label: 'Open interest', num: true, render: (m) => fmtQty(m.open_interest_fp) },
        { key: 'notional_dollars', label: 'Max payout', num: true, render: (m) => fmtMoney(m.notional_dollars) }, { key: 'house_position_fp', label: 'Liquidity acct', num: true, render: (m) => (Number(m.house_position_fp) ? `${fmtQty(m.house_position_fp)} ${String(m.house_side || '').toUpperCase()}` : '—') },
        { key: 'house_value_dollars', label: 'Acct value', num: true, render: (m) => fmtMoney(m.house_value_dollars) }] });
    dataTable(host.querySelector('#rep-daily'), { search: false, rows: [...r.daily].reverse(), testid: 'report-daily', pageSize: 31,
      cols: [{ key: 'day', label: 'Day' }, { key: 'trades', label: 'Trades', num: true }, { key: 'volume_fp', label: 'Contracts', num: true, render: (d) => fmtQty(d.volume_fp) }, { key: 'volume_dollars', label: 'Volume', num: true, render: (d) => fmtMoney(d.volume_dollars) },
        { key: 'fees_dollars', label: 'Fees', num: true, render: (d) => fmtMoney(d.fees_dollars) }, { key: 'deposits_dollars', label: 'Deposits', num: true, render: (d) => fmtMoney(d.deposits_dollars) }, { key: 'withdrawals_dollars', label: 'Withdrawals', num: true, render: (d) => fmtMoney(d.withdrawals_dollars) },
        { key: 'active_users', label: 'Active', num: true }, { key: 'signups', label: 'Sign-ups', num: true }] });
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); load().catch((ex) => toast(ex.message, 'error')); });
  form.querySelector('.seg').addEventListener('click', (e) => { const b = e.target.closest('[data-days]'); if (!b) return; form.to.value = ymd(Date.now()); form.from.value = ymd(Date.now() - (Number(b.dataset.days) - 1) * 86400000); load(); });
  await load();
}
