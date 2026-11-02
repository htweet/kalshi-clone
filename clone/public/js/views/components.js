import { esc, pct, multiplier, prob, eventHref, deltaCents, qty } from '../lib.js';

export function outcomeRows(ev, limit = 3) {
  const ms = [...ev.markets].sort((a, b) => (prob(b) ?? 0) - (prob(a) ?? 0)).slice(0, limit);
  return ms.map((m) => `
    <div class="outcome-row" data-ticker="${esc(m.ticker)}">
      <span class="outcome-dot" style="background:${esc(m.color_code)}"></span>
      <span class="outcome-name">${esc(m.yes_sub_title)}</span>
      <span class="mult">${multiplier(m)}</span>
      <span class="pill">${prob(m) == null ? '—' : prob(m) + '%'}</span>
    </div>`).join('');
}

export function eventCard(ev) {
  const vol = ev.total_volume_fp ?? ev.markets.reduce((a, m) => a + Number(m.volume_fp), 0);
  const status = ev.markets.every((m) => m.status === 'initialized') ? 'Opens soon' : ev.markets.every((m) => ['closed', 'determined', 'finalized'].includes(m.status)) ? 'Closed' : '';
  return `<a class="card ev-card" href="${eventHref(ev)}" data-link data-testid="event-card" data-event="${esc(ev.event_ticker)}">
    ${ev.is_live ? `<span class="live-tag">Live · ${esc(ev.live_label)}</span>` : ''}
    <h3>${esc(ev.title)}</h3>
    ${outcomeRows(ev, 3)}
    <div class="ev-meta"><span>${qty(vol)} contracts traded</span><span>${esc(status || ev.category)}</span></div>
  </a>`;
}

export function rankList(items) {
  if (!items.length) return '<p class="faint">Nothing here yet.</p>';
  return items.map((r, i) => {
    const d = r.delta_cents ?? 0;
    return `<a class="rank-row" href="${eventHref(r)}" data-link>
      <span class="faint">${i + 1}</span>
      <span><div>${esc(r.title)}</div><div class="faint">${esc(r.sub_title)}</div></span>
      <span class="num" style="text-align:right">${pct(r.price_dollars)}<div class="${d >= 0 ? 'delta-up' : 'delta-down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d)}</div></span>
    </a>`;
  }).join('');
}

// SVG line chart of close prices (own rendering).
export function lineChart(points, color = 'var(--brand)') {
  if (!points.length) return '<p class="faint">No trades yet.</p>';
  const W = 600; const Hh = 200; const pad = 8;
  const xs = points.map((p) => p.t);
  const minX = Math.min(...xs); const maxX = Math.max(...xs) || minX + 1;
  const sx = (t) => pad + ((t - minX) / Math.max(1, maxX - minX)) * (W - pad * 2);
  const sy = (v) => pad + (1 - v / 100) * (Hh - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
  const grid = [25, 50, 75].map((g) => `<line x1="0" x2="${W}" y1="${sy(g)}" y2="${sy(g)}" stroke="var(--line)" stroke-dasharray="3 4"/><text x="${W - 2}" y="${sy(g) - 3}" text-anchor="end" font-size="10" fill="var(--ink-3)">${g}%</text>`).join('');
  const last = points[points.length - 1];
  return `<svg class="chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="Price history, last ${last.v}%">${grid}
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <circle cx="${sx(last.t)}" cy="${sy(last.v)}" r="3.5" fill="${color}"/></svg>`;
}

export { deltaCents };
