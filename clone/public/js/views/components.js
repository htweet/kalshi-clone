// Shared UI pieces: market card (browse grid), outcome rows, rank list, chart, post card.
import { vars } from '../dynstyle.js';
import { esc, pct, multiplier, prob, previewPct, showShares, eventHref, deltaCents, qty, cents, catColor, avatar, relTime, ICON, money0 as fmtMoney0, pxCents, fmtDay, fmtDateTime } from '../lib.js';
import { scoreCols, liveSub, cardMarkets } from './scoreboard.js'; // live sports scores on cards (CLONE_SPEC §19.6)
export { prob };

export function outcomeRows(ev, limit = 3) {
  const ms = [...ev.markets].sort((a, b) => (prob(b) ?? 0) - (prob(a) ?? 0)).slice(0, limit);
  return ms.map((m) => `
    <div class="outcome-row" data-ticker="${esc(m.ticker)}">
      <span class="outcome-dot v-bg"${vars({ '--bg': m.color_code })}></span>
      <span class="outcome-name">${esc(m.yes_sub_title)}</span>
      <span class="mult">${multiplier(m)}</span>
      <span class="pill">${prob(m) == null ? '—' : prob(m) + '%'}</span>
    </div>`).join('');
}

const STATUS_LABEL = (ev) => (ev.markets.every((m) => m.status === 'initialized') ? 'Opens soon' : ev.markets.every((m) => ['closed', 'determined', 'finalized'].includes(m.status)) ? 'Closed' : '');
const OC_COLORS = ['#3a7bff', '#ff4d5e', '#2fd18b', '#f59f00', '#be4bdb', '#15aabf'];
const shortDay = (iso) => fmtDay(iso);
export const money0 = (n) => fmtMoney0(n); // whole display units: ₦12,345 / $123 (CLONE_SPEC.md §30)

// Outcome avatar: generated monogram ring in the outcome colour (own art; no photos or logos).
export function ocAvatar(m, cls = '') {
  const c = m.color_code && m.color_code !== '#5b5bd6' ? m.color_code : OC_COLORS[0];
  return `<span class="oc-av ${esc(cls)} v-bg v-color"${vars({ '--bg': c, '--color': c })} aria-hidden="true"><span class="c-white">${esc(String(m.yes_sub_title || '?')[0].toUpperCase())}</span></span>`;
}
export function evIcon(ev, cls = '') {
  return `<span class="ev-icon ${esc(cls)} v-bg"${vars({ '--bg': ev.icon_color || catColor(ev.category) })} aria-hidden="true">${esc(String(ev.series_title || ev.title || '?')[0])}</span>`;
}
// Name with a coloured underline whose length tracks the chance (observed card pattern, spec §15.3).
const ocName = (m, label) => {
  const p = prob(m) ?? 0;
  const c = m.color_code && m.color_code !== '#5b5bd6' ? m.color_code : 'var(--brand)';
  return `<span class="oc-name"><span>${esc(label)}</span><span class="oc-bar v-w v-bg"${vars({ '--w': `${Math.max(6, p)}%`, '--bg': c })}></span></span>`;
};

// Market card used by Browse, category pages and home sections.
export function eventCard(ev) {
  const href = eventHref(ev);
  const binary = ev.markets.length === 1;
  const ms = ev.live_data ? cardMarkets(ev) : [...ev.markets].sort((a, b) => (prob(b) ?? 0) - (prob(a) ?? 0)).slice(0, 2);
  const status = STATUS_LABEL(ev);
  // Settings › "Browse and manage markets by" (CLONE_SPEC §13.16): payout multiplier + % pill, or Yes/No share prices.
  const shares = showShares();
  const rows = ms.map((m) => {
    const p = previewPct(m);
    const label = binary ? m.yes_sub_title : m.yes_sub_title;
    const ya = cents(m.yes_ask_dollars); const na = cents(m.no_ask_dollars);
    const right = shares
      ? `<span class="share-prices" data-testid="share-prices"><a class="share-btn yes" href="${href}?side=yes&amp;market=${esc(m.ticker)}" data-link>Yes ${ya == null ? '—' : esc(pxCents(ya))}</a><a class="share-btn no" href="${href}?side=no&amp;market=${esc(m.ticker)}" data-link>No ${na == null ? '—' : esc(pxCents(na))}</a></span>`
      : `<span class="mult">${multiplier(m)}</span>${scoreCols(ev, m)}
      <a class="odds pill" href="${href}?side=yes&amp;market=${esc(m.ticker)}" data-link aria-label="${esc(label)} ${p == null ? 'no price' : p + ' percent'}">${p == null ? '—' : p + '%'}</a>`;
    return `<div class="mrow outcome-row" data-ticker="${esc(m.ticker)}">
      ${ocAvatar(m, 'sm')}${ocName(m, label)}
      ${right}
    </div>`;
  }).join('');
  const sub = ev.live_data ? liveSub(ev) : ev.is_live ? `<span class="live-dot">Live</span><span>${esc(ev.live_label || '')}</span>` : esc(status || (ev.close_time ? shortDay(ev.close_time) : ''));
  return `<article class="card mcard ${ev.is_live ? 'live' : ''}${ev.live_data ? ` sb-card ${esc(ev.live_data.status)}` : ''}" data-testid="event-card" data-event="${esc(ev.event_ticker)}"${ev.live_data ? ` data-milestone="${esc(ev.live_data.milestone_id)}" data-status="${esc(ev.live_data.status)}"` : ''}>
    <div class="mcard-head">${evIcon(ev, 'sm')}<div class="minw-0"><a class="mcard-title" href="${href}" data-link>${esc(ev.title)}</a><div class="mcard-sub">${sub}</div></div></div>
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
  const days = [0, 1, 2, 3, 4].map((i) => minX + ((maxX - minX) * i) / 4).map((t, i) => `<text x="${Math.min(W - padR - 30, sx(t) + (i === 0 ? 2 : 0))}" y="${H - 6}" font-size="12" fill="var(--text-x20)" text-anchor="${i === 0 ? 'start' : 'middle'}">${esc(fmtDay(t * 1000))}</text>`).join('');
  // End labels: name + big percentage, nudged apart vertically so they never overlap.
  const labels = endLabels ? series.filter((s) => s.points.length).map((s) => { const l = s.points[s.points.length - 1]; return { s, x: sx(l.t), y: sy(l.v), v: l.v }; }).sort((a, b) => a.y - b.y) : [];
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 52) labels[i].y = labels[i - 1].y + 52;
  const labelSvg = labels.map((l) => `<text x="${Math.min(l.x - 8, W - padR - 150)}" y="${Math.max(padT + 18, l.y - 22)}" font-size="15" fill="${esc(l.s.color)}">${esc(l.s.name)}</text><text x="${Math.min(l.x - 8, W - padR - 150)}" y="${Math.max(padT + 44, l.y + 4)}" font-size="26" font-weight="700" font-family="Barlow Condensed, sans-serif" fill="${esc(l.s.color)}">${esc(l.v)}%</text>`).join('');
  const lines = series.map((s) => {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
    const last = s.points[s.points.length - 1];
    if (!last) return '';
    return `<path d="${d}" fill="none" stroke="${esc(s.color)}" stroke-width="2.2" stroke-linejoin="round"/><circle cx="${sx(last.t)}" cy="${sy(last.v)}" r="5" fill="${esc(s.color)}"/>`;
  }).join('') + labelSvg;
  return `<svg class="chart v-h" viewBox="0 0 ${esc(W)} ${esc(H)}"${vars({ '--h': `${height}px` })} role="img" aria-label="Price history">${grid}${days}${lines}</svg>`;
}
export const seriesColor = (m, i) => (m.color_code && m.color_code !== '#5b5bd6' ? m.color_code : OC_COLORS[i % OC_COLORS.length]);

export function rankList(items) {
  if (!items.length) return '<p class="faint">Nothing here yet.</p>';
  return items.map((r) => {
    const d = r.delta_cents ?? 0;
    return `<a class="rank-row" href="${eventHref(r)}" data-link>
      <span><div class="t">${esc(r.title)}</div><div class="faint">${esc(r.sub_title)}</div></span>
      <span class="num ta-r">${pct(r.price_dollars)}<div class="${d >= 0 ? 'delta-up' : 'delta-down'}">${d === 0 ? '––' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}`}</div></span>
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
  return `<svg class="chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="Price history, last ${esc(last.v)}%">${grid}
    <path d="${d}" fill="none" stroke="${esc(color)}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <circle cx="${sx(last.t)}" cy="${sy(last.v)}" r="4" fill="${esc(color)}"/></svg>`;
}

// Social post (spec §13.6, §15.4): author (sticker avatar or monogram), badges, age, "edited", circle badge, position tag
// "Yes · outcome · market", body with "Read more", sticker, actions like / reply / bookmark / share / ⋯ (CLONE_SPEC §24.2).
const BADGE_LABEL = { first_trade: 'First trade', ten_trades: '10 trades', profitable_month: 'Profitable month', top_10: 'Top 10', verified: 'Verified' };
export const badgeChips = (ids = []) => ids.filter((b) => b !== 'verified' && BADGE_LABEL[b]).map((b) => `<span class="badge-chip" data-badge="${esc(b)}" title="${esc(BADGE_LABEL[b])}">${esc(BADGE_LABEL[b])}</span>`).join('');
export const authorAvatar = (a, cls = '') => (a && a.avatar ? `<img class="avatar sticker-avatar ${esc(cls)}" src="${esc(a.avatar.url)}" alt="" width="36" height="36" data-testid="sticker-avatar">` : avatar(a ? a.nickname : '?', cls));
export const stickerImg = (s, cls = 'post-sticker') => (s ? `<img class="${esc(cls)}" src="${esc(s.url)}" alt="${esc(s.label)}" title="${esc(s.label)}" width="96" height="96" data-testid="sticker" data-sticker="${esc(s.id)}">` : '');
const READ_MORE = 280;
export function postCard(p, { showEvent = true, expanded = false } = {}) {
  const long = !expanded && (p.body.length > READ_MORE || p.body.split('\n').length > 6);
  return `<article class="post${p.author_muted ? ' muted-author' : ''}" data-post="${esc(p.id)}" data-testid="post" data-nick="${esc(p.author.nickname)}" data-mine="${p.is_mine ? '1' : '0'}" data-share="${esc(p.share_path || `/social/post/${encodeURIComponent(p.id)}`)}" data-editable-until="${esc(p.editable_until || '')}" data-visibility="${esc(p.visibility || 'public')}">
    ${authorAvatar(p.author)}
    <div class="minw-0">
      <div class="post-head"><a href="/social/profile/${encodeURIComponent(p.author.nickname)}" data-link>@${esc(p.author.nickname)}</a>${p.author.verified ? '<span class="verified-badge" title="Verified profile" aria-label="Verified" data-testid="verified-badge">✓</span>' : ''}${badgeChips(p.author.badges)}<span class="faint">${relTime(p.created_time)}</span>${p.edited ? `<span class="faint post-edited" data-testid="post-edited" title="Edited ${esc(fmtDateTime(p.edited_time))}">· edited${p.edited_by_moderator ? ' by a moderator' : ''}</span>` : ''}${p.visibility === 'circle' ? '<span class="circle-badge" data-testid="circle-badge" title="Only your Inner Circle can see this">Inner Circle</span>' : ''}
        ${p.is_mine ? '<button class="btn btn-sm btn-ghost btn-danger ml-auto" data-act="delete">Delete</button>' : ''}<button class="post-more${p.is_mine ? '' : ' ml-auto'}" data-post-more="${esc(p.id)}" aria-label="More actions" aria-haspopup="menu" data-testid="post-menu">⋯</button></div>
      ${p.position ? `<a class="pos-tag pos-${esc(p.position.side)}" href="${esc(p.position.link)}" data-link data-testid="position-tag" title="${p.position.held === 'current' ? 'Holds this position' : 'Held this position'}">${esc(p.position.label)}</a>` : ''}
      ${p.body ? `<div class="post-body${long ? ' clamped' : ''}" data-testid="post-body">${esc(p.body)}</div>${long ? '<button class="read-more" type="button" data-act="read-more" data-testid="read-more" aria-expanded="false">Read more</button>' : ''}` : ''}
      ${stickerImg(p.sticker)}
      ${showEvent && p.event ? `<a class="post-event" href="${esc(p.event.link)}" data-link>${esc(p.event.title)}</a><br>` : ''}
      <div class="post-actions">
        <button data-act="like" class="${p.liked ? 'on' : ''}" aria-pressed="${esc(p.liked)}" aria-label="Like">${ICON.heart}<span data-testid="like-count">${esc(p.like_count)}</span></button>
        <button data-act="comments" aria-label="Replies">${ICON.reply}<span data-testid="comment-count">${esc(p.comment_count)}</span></button>
        <button data-act="bookmark" class="bm ${p.bookmarked ? 'on' : ''}" aria-pressed="${esc(p.bookmarked)}" aria-label="Bookmark">${ICON.bookmark}</button>
        <button data-act="share" aria-label="Share" data-testid="post-share">${ICON.share}</button>
      </div>
      <div class="comments" hidden></div>
    </div>
  </article>`;
}

export { deltaCents, cents, qty };
