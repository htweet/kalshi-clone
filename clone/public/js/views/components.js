// Shared UI pieces: market card (browse grid), outcome rows, rank list, chart, post card.
import { esc, pct, multiplier, prob, eventHref, deltaCents, qty, cents, catColor, compact, avatar, relTime, ICON } from '../lib.js';
import { scoreCols, liveSub, cardMarkets } from './scoreboard.js'; // live sports scores on cards (SPORTS_SPEC §19.6)
export { prob };

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

const STATUS_LABEL = (ev) => (ev.markets.every((m) => m.status === 'initialized') ? 'Opens soon' : ev.markets.every((m) => ['closed', 'determined', 'finalized'].includes(m.status)) ? 'Closed' : '');
const OC_COLORS = ['#3a7bff', '#ff4d5e', '#2fd18b', '#f59f00', '#be4bdb', '#15aabf'];
const shortDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const money0 = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');

// Outcome avatar: generated monogram ring in the outcome colour (own art; no photos or logos).
export function ocAvatar(m, cls = '') {
  const c = m.color_code && m.color_code !== '#5b5bd6' ? m.color_code : OC_COLORS[0];
  return `<span class="oc-av ${cls}" style="background:${esc(c)};color:${esc(c)}" aria-hidden="true"><span style="color:#fff">${esc(String(m.yes_sub_title || '?')[0].toUpperCase())}</span></span>`;
}
export function evIcon(ev, cls = '') {
  return `<span class="ev-icon ${cls}" style="background:${esc(ev.icon_color || catColor(ev.category))}" aria-hidden="true">${esc(String(ev.series_title || ev.title || '?')[0])}</span>`;
}
// Name with a coloured underline whose length tracks the chance (observed card pattern, spec §15.3).
const ocName = (m, label) => {
  const p = prob(m) ?? 0;
  const c = m.color_code && m.color_code !== '#5b5bd6' ? m.color_code : 'var(--brand)';
  return `<span class="oc-name"><span>${esc(label)}</span><span class="oc-bar" style="width:${Math.max(6, p)}%;background:${esc(c)}"></span></span>`;
};

// Market card used by Browse, category pages and home sections.
export function eventCard(ev) {
  const href = eventHref(ev);
  const binary = ev.markets.length === 1;
  const ms = ev.live_data ? cardMarkets(ev) : [...ev.markets].sort((a, b) => (prob(b) ?? 0) - (prob(a) ?? 0)).slice(0, 2);
  const status = STATUS_LABEL(ev);
  const rows = ms.map((m) => {
    const p = prob(m);
    const label = binary ? m.yes_sub_title : m.yes_sub_title;
    return `<div class="mrow outcome-row" data-ticker="${esc(m.ticker)}">
      ${ocAvatar(m, 'sm')}${ocName(m, label)}
      <span class="mult">${multiplier(m)}</span>${scoreCols(ev, m)}
      <a class="odds pill" href="${href}?side=yes&amp;market=${esc(m.ticker)}" data-link aria-label="${esc(label)} ${p == null ? 'no price' : p + ' percent'}">${p == null ? '—' : p + '%'}</a>
    </div>`;
  }).join('');
  const sub = ev.live_data ? liveSub(ev) : ev.is_live ? `<span class="live-dot">Live</span><span>${esc(ev.live_label || '')}</span>` : esc(status || (ev.close_time ? shortDay(ev.close_time) : ''));
  return `<article class="card mcard ${ev.is_live ? 'live' : ''}${ev.live_data ? ` sb-card ${ev.live_data.status}` : ''}" data-testid="event-card" data-event="${esc(ev.event_ticker)}"${ev.live_data ? ` data-milestone="${esc(ev.live_data.milestone_id)}" data-status="${ev.live_data.status}"` : ''}>
    <div class="mcard-head">${evIcon(ev, 'sm')}<div style="min-width:0"><a class="mcard-title" href="${href}" data-link>${esc(ev.title)}</a><div class="mcard-sub">${sub}</div></div></div>
    <div class="mcard-rows">${rows}</div>
    <div class="mcard-foot"><span class="num">${money0(ev.dollar_volume ?? 0)} vol</span>${ev.markets.length > 2 ? `<span>· ${ev.markets.length} outcomes</span>` : ''}<span class="grow"></span><span class="ev-meta"><span>${esc(status || ev.category)}</span></span></div>
  </article>`;
}

// Multi-series chart with right-side % axis, date axis and end labels (spec §15.4).
export function multiChart(series, { height = 260, endLabels = false, width = 700 } = {}) {
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return '<p class="faint">No trades yet.</p>';
  const W = width; const H = height; const padR = 46; const padB = 26; const padT = 10;
  const minX = Math.min(...pts.map((p) => p.t)); const maxX = Math.max(...pts.map((p) => p.t));
  const vals = pts.map((p) => p.v);
  let lo = Math.max(0, Math.floor((Math.min(...vals) - 8) / 10) * 10); let hi = Math.min(100, Math.ceil((Math.max(...vals) + 8) / 10) * 10);
  if (hi - lo < 20) { lo = Math.max(0, lo - 10); hi = Math.min(100, hi + 10); }
  const sx = (t) => ((t - minX) / Math.max(1, maxX - minX)) * (W - padR - 8);
  const sy = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const ticks = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4);
  const grid = ticks.map((g) => `<line x1="0" x2="${W - padR}" y1="${sy(g)}" y2="${sy(g)}" stroke="var(--fill-x50)" stroke-dasharray="1 5"/><text x="${W - 4}" y="${sy(g) + 4}" text-anchor="end" font-size="12" fill="var(--text-x20)">${Math.round(g)}%</text>`).join('');
  const days = [0, 1, 2, 3, 4].map((i) => minX + ((maxX - minX) * i) / 4).map((t, i) => `<text x="${Math.min(W - padR - 30, sx(t) + (i === 0 ? 2 : 0))}" y="${H - 6}" font-size="12" fill="var(--text-x20)" text-anchor="${i === 0 ? 'start' : 'middle'}">${new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</text>`).join('');
  // End labels: name + big percentage, nudged apart vertically so they never overlap.
  const labels = endLabels ? series.filter((s) => s.points.length).map((s) => { const l = s.points[s.points.length - 1]; return { s, x: sx(l.t), y: sy(l.v), v: l.v }; }).sort((a, b) => a.y - b.y) : [];
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 52) labels[i].y = labels[i - 1].y + 52;
  const labelSvg = labels.map((l) => `<text x="${Math.min(l.x - 8, W - padR - 150)}" y="${Math.max(padT + 18, l.y - 22)}" font-size="15" fill="${l.s.color}">${esc(l.s.name)}</text><text x="${Math.min(l.x - 8, W - padR - 150)}" y="${Math.max(padT + 44, l.y + 4)}" font-size="26" font-weight="700" font-family="Barlow Condensed, sans-serif" fill="${l.s.color}">${l.v}%</text>`).join('');
  const lines = series.map((s) => {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
    const last = s.points[s.points.length - 1];
    if (!last) return '';
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round"/><circle cx="${sx(last.t)}" cy="${sy(last.v)}" r="5" fill="${s.color}"/>`;
  }).join('') + labelSvg;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${height}px" role="img" aria-label="Price history">${grid}${days}${lines}</svg>`;
}
export const seriesColor = (m, i) => (m.color_code && m.color_code !== '#5b5bd6' ? m.color_code : OC_COLORS[i % OC_COLORS.length]);

export function rankList(items) {
  if (!items.length) return '<p class="faint">Nothing here yet.</p>';
  return items.map((r) => {
    const d = r.delta_cents ?? 0;
    return `<a class="rank-row" href="${eventHref(r)}" data-link>
      <span><div class="t">${esc(r.title)}</div><div class="faint">${esc(r.sub_title)}</div></span>
      <span class="num" style="text-align:right">${pct(r.price_dollars)}<div class="${d >= 0 ? 'delta-up' : 'delta-down'}">${d === 0 ? '––' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}`}</div></span>
    </a>`;
  }).join('');
}

// SVG line chart of close prices (own rendering).
export function lineChart(points, color = 'var(--brand)') {
  if (!points.length) return '<p class="faint">No trades yet.</p>';
  const W = 600; const Hh = 220; const pad = 10;
  const xs = points.map((p) => p.t);
  const minX = Math.min(...xs); const maxX = Math.max(...xs) || minX + 1;
  const sx = (t) => pad + ((t - minX) / Math.max(1, maxX - minX)) * (W - pad * 2 - 30);
  const sy = (v) => pad + (1 - v / 100) * (Hh - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
  const grid = [0, 25, 50, 75, 100].map((g) => `<line x1="0" x2="${W - 30}" y1="${sy(g)}" y2="${sy(g)}" stroke="var(--line)" stroke-dasharray="2 4"/><text x="${W - 2}" y="${sy(g) + 4}" text-anchor="end" font-size="11" fill="var(--text-x30)">${g}%</text>`).join('');
  const last = points[points.length - 1];
  return `<svg class="chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="Price history, last ${last.v}%">${grid}
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <circle cx="${sx(last.t)}" cy="${sy(last.v)}" r="4" fill="${color}"/></svg>`;
}

// Social post (spec §13.6).
export function postCard(p, { showEvent = true } = {}) {
  return `<article class="post" data-post="${esc(p.id)}" data-testid="post">
    ${avatar(p.author.nickname)}
    <div>
      <div class="post-head"><a href="/social/profile/${encodeURIComponent(p.author.nickname)}" data-link>@${esc(p.author.nickname)}</a>${p.author.verified ? '<span class="verified-badge" title="Verified profile" aria-label="Verified" data-testid="verified-badge">✓</span>' : ''}<span class="faint">${relTime(p.created_time)}</span>
        ${p.is_mine ? '<button class="btn btn-sm btn-ghost btn-danger" data-act="delete" style="margin-left:auto">Delete</button>' : `<button class="post-more" data-post-menu="${esc(p.id)}" aria-label="More actions" data-testid="post-menu">⋯</button>`}</div>
      <div class="post-body" data-testid="post-body">${esc(p.body)}</div>
      ${showEvent && p.event ? `<a class="post-event" href="${esc(p.event.link)}" data-link>${esc(p.event.title)}</a><br>` : ''}
      <div class="post-actions">
        <button data-act="like" class="${p.liked ? 'on' : ''}" aria-pressed="${p.liked}" aria-label="Like">${ICON.heart}<span data-testid="like-count">${p.like_count}</span></button>
        <button data-act="comments" aria-label="Replies">${ICON.reply}<span data-testid="comment-count">${p.comment_count}</span></button>
        <button data-act="bookmark" class="bm ${p.bookmarked ? 'on' : ''}" aria-pressed="${p.bookmarked}" aria-label="Bookmark">${ICON.bookmark}</button>
      </div>
      <div class="comments" hidden></div>
    </div>
  </article>`;
}

export { deltaCents, cents, qty };
