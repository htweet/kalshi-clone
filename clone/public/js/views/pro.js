// Pro (spec §15.7): dense market grid for active traders — every open market with bid / ask / last / 24h change /
// volume, sortable, live-updating over the ticker channel, one click to the order ticket.
import { api } from '../api.js';
import { socket } from '../ws.js';
import { esc, cents, prob, eventHref, qty, catLabel } from '../lib.js';

const COLS = [['title', 'Market'], ['bid', 'Bid'], ['ask', 'Ask'], ['last', 'Last'], ['chg', '24h'], ['vol', 'Volume']];

export async function render({ el }) {
  document.title = 'Pro · Parlance';
  const r = await api.search({ status: 'open', page_size: 100, order_by: 'event-volume' });
  const rows = [];
  for (const ev of r.current_page) for (const m of ev.markets.filter((x) => x.status === 'active')) rows.push({ ev, m });
  let sort = ['vol', -1];
  const val = ({ ev, m }, k) => ({ title: `${ev.title} ${m.yes_sub_title}`, bid: cents(m.yes_bid_dollars) ?? -1, ask: cents(m.yes_ask_dollars) ?? 999, last: prob(m) ?? -1, chg: (prob(m) ?? 0) - (cents(m.previous_price_dollars) ?? prob(m) ?? 0), vol: Number(m.volume_fp) }[k]);
  el.innerHTML = `<div class="page-head" style="padding-top:0"><h1 class="page-title">Pro</h1><span class="faint">${rows.length} open markets · live</span></div>
    <div class="card" style="padding:4px 16px"><table class="table pro-table" data-testid="pro-table"><thead><tr>${COLS.map(([k, l]) => `<th class="${k === 'title' ? '' : 'num'}"><button class="btn btn-ghost btn-sm" data-sort="${k}">${l}</button></th>`).join('')}<th></th></tr></thead><tbody id="pro-rows"></tbody></table></div>`;
  const draw = () => {
    const [k, dir] = sort;
    const list = [...rows].sort((a, b) => { const x = val(a, k); const y = val(b, k); return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir; });
    el.querySelector('#pro-rows').innerHTML = list.map(({ ev, m }) => {
      const chg = val({ ev, m }, 'chg');
      return `<tr data-ticker="${esc(m.ticker)}"><td><a href="${eventHref(ev)}?market=${esc(m.ticker)}" data-link><strong>${esc(m.yes_sub_title)}</strong> <span class="faint">${esc(ev.title)} · ${esc(catLabel(ev.category))}</span></a></td>
        <td class="num" style="color:var(--yes)">${cents(m.yes_bid_dollars) ?? '—'}¢</td><td class="num" style="color:var(--no)">${cents(m.yes_ask_dollars) ?? '—'}¢</td><td class="num"><strong>${prob(m) ?? '—'}%</strong></td>
        <td class="num ${chg >= 0 ? 'delta-up' : 'delta-down'}">${chg ? (chg > 0 ? '+' : '') + chg : '0'}</td><td class="num">${qty(m.volume_fp)}</td>
        <td><a class="btn btn-sm" href="${eventHref(ev)}?side=yes&amp;market=${esc(m.ticker)}" data-link>Trade</a></td></tr>`;
    }).join('');
  };
  for (const b of el.querySelectorAll('[data-sort]')) b.onclick = () => { sort = [b.dataset.sort, sort[0] === b.dataset.sort ? -sort[1] : -1]; draw(); };
  draw();
  let t = null;
  const unsub = socket.subscribe({ channels: ['ticker'] }, (msg) => {
    const row = rows.find((x) => x.m.ticker === msg.msg.market_ticker);
    if (!row) return;
    Object.assign(row.m, { yes_bid_dollars: msg.msg.yes_bid_dollars, yes_ask_dollars: msg.msg.yes_ask_dollars, last_price_dollars: msg.msg.last_price_dollars, volume_fp: msg.msg.volume_fp });
    clearTimeout(t); t = setTimeout(draw, 150);
  });
  return () => { unsub(); clearTimeout(t); };
}
