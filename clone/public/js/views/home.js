// Home (spec §4.2): hero carousel, top markets, trending / movers / new rail.
import { api } from '../api.js';
import { queries } from '../store.js';
import { socket } from '../ws.js';
import { esc, eventHref, qty, cents } from '../lib.js';
import { eventCard, outcomeRows, rankList, lineChart } from './components.js';

export async function render({ el }) {
  document.title = 'Parlance Exchange — trade on outcomes';
  el.innerHTML = '<div class="grid-home"><div class="skeleton"></div><div class="skeleton"></div></div>';
  const { home } = await queries.fetch(['home'], api.home, { staleTime: 15000 });
  let idx = 0;
  const hl = home.highlights;

  el.innerHTML = `<div class="grid-home">
    <div>
      <section class="card hero" id="hero" aria-roledescription="carousel"></section>
      <h2 class="section-title">Top markets <a href="/browse?order_by=event-volume" data-link>See all →</a></h2>
      <div class="grid" id="top-markets">${home.top_markets.map(eventCard).join('')}</div>
    </div>
    <aside class="rail">
      <div class="card rail-box"><h3>Trending</h3>${rankList(home.trending)}</div>
      <div class="card rail-box"><h3>Top movers</h3>${rankList(home.top_movers)}</div>
      <div class="card rail-box"><h3>New</h3>${rankList(home.new)}</div>
    </aside></div>`;

  const hero = el.querySelector('#hero');
  async function drawHero() {
    if (!hl.length) { hero.innerHTML = '<p class="faint">No featured markets.</p>'; return; }
    const ev = hl[idx];
    hero.innerHTML = `<div class="hero-head"><a href="${eventHref(ev)}" data-link><h2 data-testid="hero-title" class="typ-title-x20" style="font-size:24px;line-height:30px">${esc(ev.title)}</h2></a>
        <div class="pager"><button class="icon-btn" id="hero-prev" aria-label="Previous">‹</button><span data-testid="hero-pager">${idx + 1} of ${hl.length}</span><button class="icon-btn" id="hero-next" aria-label="Next">›</button></div></div>
      <div><div class="outcome-row faint"><span style="flex:1">Outcome</span><span>Pays</span><span style="min-width:60px;text-align:right">Odds</span></div>
        ${outcomeRows(ev, 4)}
        <div class="faint" style="margin-top:6px">${qty(ev.total_volume_fp)} contracts traded</div>
        ${ev.news ? `<div class="news"><strong>Update</strong> · ${esc(ev.news)}</div>` : ''}</div>
      <div id="hero-chart"><div class="skeleton" style="min-height:200px"></div></div>`;
    hero.querySelector('#hero-prev').onclick = () => { idx = (idx - 1 + hl.length) % hl.length; drawHero(); };
    hero.querySelector('#hero-next').onclick = () => { idx = (idx + 1) % hl.length; drawHero(); };
    const lead = [...ev.markets].sort((a, b) => cents(b.last_price_dollars) - cents(a.last_price_dollars))[0];
    const now = Math.floor(Date.now() / 1000);
    try {
      const c = await queries.fetch(['candles', lead.ticker, '1w'], () => api.candles(ev.series_ticker, lead.ticker, { start_ts: now - 7 * 86400, end_ts: now, period_interval: 60 }), { staleTime: 60000 });
      const box = hero.querySelector('#hero-chart');
      if (box && hl[idx] === ev) box.innerHTML = lineChart(c.candlesticks.map((k) => ({ t: k.end_period_ts, v: cents(k.price.close_dollars) })), lead.color_code);
    } catch { /* chart optional */ }
  }
  drawHero();

  // Live probabilities on the cards via the shared ticker channel.
  const unsub = socket.subscribe({ channels: ['ticker'] }, (m) => {
    if (m.type !== 'ticker') return;
    for (const row of el.querySelectorAll(`.outcome-row[data-ticker="${CSS.escape(m.msg.market_ticker)}"] .pill`)) {
      if (m.msg.last_price_dollars != null) row.textContent = `${cents(m.msg.last_price_dollars)}%`;
    }
  });
  return () => unsub();
}
