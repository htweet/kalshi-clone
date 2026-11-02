// Shared UI pieces: market card (browse grid), outcome rows, rank list, chart, post card.
import { esc, pct, multiplier, prob, eventHref, deltaCents, qty, cents, catColor, compact, avatar, relTime, ICON } from '../lib.js';

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

// Market card: icon + title, top outcomes with chance and Yes/No buttons, volume footer (spec §13.2 browse grid).
export function eventCard(ev) {
  const vol = ev.total_volume_fp ?? ev.markets.reduce((a, m) => a + Number(m.volume_fp), 0);
  const href = eventHref(ev);
  const binary = ev.markets.length === 1;
  const ms = [...ev.markets].sort((a, b) => (prob(b) ?? 0) - (prob(a) ?? 0)).slice(0, binary ? 1 : 2);
  const status = STATUS_LABEL(ev);
  const rows = ms.map((m) => {
    const p = prob(m);
    const open = m.status === 'active';
    const d = deltaCents(m);
    return `<div class="mrow outcome-row" data-ticker="${esc(m.ticker)}">
      <span class="mrow-name">${esc(binary ? (p == null ? '' : 'Chance') : m.yes_sub_title)}${binary && d ? ` <span class="${d > 0 ? 'delta-up' : 'delta-down'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>` : ''}</span>
      <span class="mrow-pct pill">${p == null ? '—' : p + '%'}</span>
      <span class="mrow-btns"><a class="yn yes" href="${href}?side=yes&amp;market=${esc(m.ticker)}" data-link role="button" ${open ? '' : 'aria-disabled="true"'} style="display:inline-grid;place-items:center">Yes</a><a class="yn no" href="${href}?side=no&amp;market=${esc(m.ticker)}" data-link role="button" ${open ? '' : 'aria-disabled="true"'} style="display:inline-grid;place-items:center">No</a></span>
    </div>`;
  }).join('');
  return `<article class="card mcard" data-testid="event-card" data-event="${esc(ev.event_ticker)}">
    <div class="mcard-head"><span class="mcard-icon" style="background:${catColor(ev.category)}" aria-hidden="true">${esc((ev.series_title || ev.title)[0])}</span>
      <a class="mcard-title" href="${href}" data-link>${esc(ev.title)}</a></div>
    <div class="mcard-rows">${rows}</div>
    <div class="mcard-foot">${ev.is_live ? `<span class="live-dot">Live${ev.live_label ? ' · ' + esc(ev.live_label) : ''}</span>` : ''}<span class="num">${compact(vol)} vol</span>${ev.markets.length > 2 ? `<span>· ${ev.markets.length} outcomes</span>` : ''}<span class="grow"></span><span class="ev-meta"><span>${esc(status || ev.category)}</span></span></div>
  </article>`;
}

export function rankList(items) {
  if (!items.length) return '<p class="faint">Nothing here yet.</p>';
  return items.map((r, i) => {
    const d = r.delta_cents ?? 0;
    return `<a class="rank-row" href="${eventHref(r)}" data-link>
      <span class="faint">${i + 1}</span>
      <span><div class="t">${esc(r.title)}</div><div class="faint">${esc(r.sub_title)}</div></span>
      <span class="num" style="text-align:right;font-weight:650">${pct(r.price_dollars)}<div class="${d >= 0 ? 'delta-up' : 'delta-down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d)}</div></span>
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
      <div class="post-head"><a href="/social/profile/${encodeURIComponent(p.author.nickname)}" data-link>@${esc(p.author.nickname)}</a><span class="faint">${relTime(p.created_time)}</span>
        ${p.is_mine ? '<button class="btn btn-sm btn-ghost btn-danger" data-act="delete" style="margin-left:auto">Delete</button>' : ''}</div>
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
