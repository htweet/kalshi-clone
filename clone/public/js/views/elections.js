// Elections hub v2 (PLAN Phase 7B, CLONE_SPEC.md §37; observed results-night structure §13.20): /category/elections/<hub>.
// Sidebar, tabs (Overview · offices · States · My Ballot) and search; multi-party control gauges; office switch and seat
// bar; a map of the country's map-level divisions drawn as simple hexagon tiles (solid = called, hatched = projected or
// leading, ticks and % labels, a side list for small divisions, tooltip on hover and tap); the ratings swingometer; a
// timeline that replays the map, seat bar, gauges and ratings from persisted snapshots; featured race cards; the Power
// Index; More markets; a floating hub chat (§20) with its online count; My Ballot by division (no address).
//
// Everything about a country comes from the API (offices, parties, divisions, rules): nothing here is Nigeria-specific.
// Admin-entered names and colours are escaped on output (esc(), textContent); colours are validated hex on the server and
// reach CSS only as custom properties (dynstyle.js). Every async draw is sequence-guarded: only the latest request draws.
import { t as tx, te, tr, hasText } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/elections-strings.js';
import { vars } from '../dynstyle.js';
import { request } from '../api.js';
import { socket } from '../ws.js';
import { session } from '../store.js';
import { flagOn } from '../flags.js';
import { esc, eventHref, toast, moneyCompact, fmtDateTime, fmtDt } from '../lib.js';
import { hoverAttr, installChartHover } from '../chart-hover.js'; // chart readout on hover / touch / keys (§15.4)
import { mountChat } from './chat.js';

const get = (u) => request('GET', u);
const pct0 = (p) => `${Math.round(Number(p || 0) * 100)}%`;
const pct1 = (p) => `${(Math.round(Number(p || 0) * 1000) / 10).toFixed(1)}%`;
const num = (n) => Number(n || 0).toLocaleString('en-NG');
const volOf = (cents) => moneyCompact(Number(cents || 0) / 100);
const bandWord = (band) => tx(`elections.band.${band}`);
const officeLabel = (o) => (hasText(`elections.office.${o.key}`) ? tx(`elections.office.${o.key}`) : o.name);
// Tiny DOM builder for the tooltip: attributes come from code, children strings become text nodes (never parsed).
function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : String(v)); }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
const avatarHtml = (c, cls = '') => (c.photo_url
  ? `<img class="el-av ${esc(cls)}" src="${esc(c.photo_url)}" alt="" width="32" height="32" loading="lazy">`
  : `<span class="el-av el-av-init ${esc(cls)}"${vars({ '--c': c.party?.color || c.color })} aria-hidden="true">${esc(c.initials || '')}</span>`);
const partyChip = (p) => (p ? `<span class="el-chip"${vars({ '--c': p.color })}><i></i>${esc(p.short_name)}</span>` : '');

// ---------------------------------------------------------------------------------------------- gauges
function gaugeHtml(g) {
  const p = Math.max(0, Math.min(1, g.p));
  const a = g.party?.color || 'var(--text-x30)'; const b = g.runner_up?.color || 'var(--fill-x50)';
  const phi = Math.PI * p; const x = 60 + 40 * Math.cos(phi); const y = 62 - 40 * Math.sin(phi);
  const word = g.runoff ? tx('elections.gauge.runoff') : g.called ? tx('elections.gauge.called') : `${bandWord(g.band)} ${g.party?.short_name || ''}`;
  const title = g.kind === 'control' ? te('elections.gauge.control_title', { office: esc(g.name) }) : te('elections.gauge.race_title', { office: esc(g.name) });
  return `<div class="card el-gauge" data-testid="el-gauge" data-office="${esc(g.office)}" data-party="${esc(g.party?.code || '')}" data-p="${esc(p)}"><div class="el-gauge-title">${title}</div>
    <svg viewBox="0 0 120 70" class="el-dial" role="img" aria-label="${esc(`${word} ${pct0(p)}`)}"><path d="M10 62 A50 50 0 0 1 60 12" fill="none" stroke="${esc(a)}" stroke-width="10"/><path d="M60 12 A50 50 0 0 1 110 62" fill="none" stroke="${esc(b)}" stroke-width="10" opacity="0.55"/>
      <line x1="60" y1="62" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--text-x10)" stroke-width="3" stroke-linecap="round"/><circle cx="60" cy="62" r="4" fill="var(--text-x10)"/></svg>
    <div class="el-gauge-big num" data-testid="el-gauge-p">${esc(pct0(p))}</div><div class="el-gauge-word" data-testid="el-gauge-word">${esc(word)}</div>
    <div class="el-gauge-ends"><span>${partyChip(g.party)}</span><span>${partyChip(g.runner_up)}</span></div>${g.candidate ? `<div class="faint el-gauge-cand">${esc(g.candidate)}</div>` : ''}</div>`;
}

// ---------------------------------------------------------------------------------------------- seat bar
function seatsHtml(s) {
  if (!s || !s.parties.length) return `<p class="faint">${te('elections.seats.none')}</p>`;
  const L = s.parties[0]; const R = s.parties[1] || null;
  const segs = s.parties.map((x) => `<span class="el-seg" data-testid="el-seat-seg" data-party="${esc(x.party?.code || '')}" data-forecast="${esc(x.forecast)}" data-current="${esc(x.current)}"${vars({ '--w': `${((x.forecast / Math.max(1, s.total)) * 100).toFixed(2)}%`, '--c': x.party?.color })} title="${esc(`${x.party?.short_name || ''} ${x.forecast}`)}"></span>`).join('');
  const end = (x, right) => (x ? `<div class="el-seat-end ${right ? 'ta-r' : ''}"><b class="num">${esc(Math.round(x.forecast))}</b> <span>${esc(x.party?.short_name || '')}</span> <span class="faint">${te('elections.seats.forecast')}</span><div class="faint">${te('elections.seats.current', { n: esc(x.current) })}</div></div>` : '<div></div>');
  return `<div class="el-seats" data-testid="el-seats" data-office="${esc(s.office)}" data-total="${esc(s.total)}">
    <div class="el-seat-head">${end(L, false)}<div class="el-live"><i class="el-live-dot"></i>${te('elections.seats.live_forecast')}</div>${end(R, true)}</div>
    <div class="el-seatbar" role="img" aria-label="${esc(s.parties.map((x) => `${x.party?.short_name} ${x.forecast}`).join(', '))}">${segs}${s.majority ? `<i class="el-maj v-left"${vars({ '--left': `${((s.majority - 0.5) / s.total) * 100}%` })} data-testid="el-majority"></i>` : ''}</div>
    <div class="el-seat-foot faint">${s.majority ? te('elections.seats.majority', { n: esc(s.majority), total: esc(s.total) }) : te('elections.seats.total', { total: esc(s.total) })}
      ${s.parties.slice(2).map((x) => `<span class="el-seat-other">${partyChip(x.party)} <span class="num">${esc(Math.round(x.forecast))}</span></span>`).join('')}</div></div>`;
}

// ---------------------------------------------------------------------------------------------- map
const HEX = 26; const HW = Math.sqrt(3) * HEX;
const hexPts = (cx, cy) => [0, 1, 2, 3, 4, 5].map((i) => { const a = (Math.PI / 180) * (60 * i - 30); return `${(cx + HEX * Math.cos(a)).toFixed(1)},${(cy + HEX * Math.sin(a)).toFixed(1)}`; }).join(' ');
function mapHtml(m, parties) {
  if (!m) return '';
  const pad = 8;
  const W = pad * 2 + m.cols * HW + HW / 2; const H = pad * 2 + (m.rows - 1) * HEX * 1.5 + HEX * 2;
  const pIdx = new Map(parties.map((p, i) => [p.id, i]));
  const defs = parties.map((p, i) => `<pattern id="el-h${i}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--surface-x10)"/><rect width="3" height="6" fill="${esc(p.color)}"/></pattern>`).join('');
  const tiles = m.states.map((s) => {
    const cx = pad + s.col * HW + (s.row % 2 ? HW : HW / 2); const cy = pad + HEX + s.row * HEX * 1.5;
    const i = pIdx.get(s.party_id);
    const fill = s.kind === 'called' && s.color ? s.color : (s.kind === 'projected' || s.kind === 'leading') && i != null ? `url(#el-h${i})` : 'var(--fill-x40)';
    const mark = s.kind === 'called' ? '✓' : s.label || '';
    return `<g class="el-tile k-${esc(s.kind)}" data-testid="el-map-state" data-code="${esc(s.code)}" data-id="${esc(s.id)}" data-kind="${esc(s.kind)}" data-party="${esc(s.party_id || '')}" tabindex="0" role="button" aria-label="${esc(`${s.name} ${tx(`elections.map.kind_${s.kind}`)}${s.label ? ` ${s.label}` : ''}`)}">
      <polygon points="${hexPts(cx, cy)}" fill="${esc(fill)}"/><text x="${cx.toFixed(1)}" y="${(cy - 2).toFixed(1)}" text-anchor="middle" class="el-tile-code">${esc(s.code)}</text>${mark ? `<text x="${cx.toFixed(1)}" y="${(cy + 11).toFixed(1)}" text-anchor="middle" class="el-tile-mark" data-testid="el-tile-mark">${esc(mark)}</text>` : ''}</g>`;
  }).join('');
  const side = m.states.filter((s) => s.small).map((s) => `<button type="button" class="el-side-item k-${esc(s.kind)}" data-testid="el-map-side-item" data-id="${esc(s.id)}" data-code="${esc(s.code)}"><span class="el-sw"${vars({ '--c': s.kind === 'pending' || s.kind === 'none' ? '' : s.color })}></span><b>${esc(s.code)}</b><span class="faint">${s.kind === 'called' ? '✓' : esc(s.label || '')}</span></button>`).join('');
  const legend = ['called', 'projected', 'leading', 'pending', 'none'].map((k) => `<span class="el-leg k-${esc(k)}"><i></i>${te(`elections.map.kind_${k}`)}</span>`).join('');
  return `<div class="el-map-wrap" data-testid="el-map-wrap"><svg class="el-map" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" role="group" aria-label="${te('elections.map.aria')}"><defs>${defs}</defs>${tiles}<text x="${(W - 6).toFixed(0)}" y="${(H - 6).toFixed(0)}" text-anchor="end" class="el-watermark">${te('elections.map.watermark')}</text></svg>
    <div class="el-map-side" data-testid="el-map-side"><div class="overline">${te('elections.map.side_title')}</div>${side}</div>
    <div class="el-tip card" data-testid="el-tip" role="tooltip" hidden></div></div><div class="el-legend">${legend}</div>`;
}
function tipNode(s) {
  const t = s.tooltip || {};
  const box = h('div', { class: 'el-tip-in' },
    h('div', { class: 'el-tip-head' }, h('span', { class: 'el-tip-badge' }, s.code), h('b', {}, tx('elections.tip.winner_q', { race: t.title || s.name }))),
    h('div', { class: 'faint', 'data-testid': 'el-tip-pct' }, tx('elections.tip.counted', { pct: pct1(t.pct_reported) })));
  if (s.kind === 'none') box.append(h('div', { class: 'faint' }, tx('elections.tip.no_race')));
  for (const r of t.rows || []) {
    box.append(h('div', { class: 'el-tip-row', 'data-testid': 'el-tip-row' },
      h('span', { class: 'el-av el-av-init el-av-sm', 'data-c': r.color }, r.initials || ''),
      h('span', { class: 'el-tip-name' }, r.name, h('small', { class: 'faint' }, ` ${r.party}`)),
      h('span', { class: 'num' }, pct1(r.share)), h('span', { class: 'num faint' }, num(r.votes)),
      r.result ? h('span', { class: `el-res ${r.result}`, 'data-testid': 'el-tip-result' }, tx(`elections.tip.${r.result}`)) : h('span', {})));
  }
  for (const r of t.seats || []) box.append(h('div', { class: 'el-tip-row', 'data-testid': 'el-tip-seat' }, h('span', { class: 'el-tip-name' }, r.name), h('span', {}, r.party || '—'), h('span', { class: 'num' }, r.called ? '✓' : pct0(r.pct))));
  if (t.chance && t.chance.p) box.append(h('div', { class: 'faint' }, tx('elections.tip.chance', { pct: pct0(t.chance.p) })));
  if (t.volume_cents) box.append(h('div', { class: 'faint', 'data-testid': 'el-tip-vol' }, tx('elections.tip.volume', { vol: volOf(t.volume_cents) })));
  for (const n of box.querySelectorAll('[data-c]')) n.style.setProperty('--c', n.getAttribute('data-c'));
  return box;
}
function wireMap(root, map, onPick) {
  const wrap = root.querySelector('[data-testid=el-map-wrap]');
  if (!wrap || !map) return;
  const tip = wrap.querySelector('[data-testid=el-tip]');
  const byId = new Map(map.states.map((s) => [s.id, s]));
  let pinned = null;
  const show = (id, anchor) => {
    const s = byId.get(id); if (!s) return;
    tip.replaceChildren(tipNode(s)); tip.hidden = false; tip.dataset.code = s.code;
    const b = wrap.getBoundingClientRect(); const a = anchor.getBoundingClientRect();
    const left = Math.max(0, Math.min(b.width - tip.offsetWidth, a.left - b.left + a.width / 2 - tip.offsetWidth / 2));
    const top = a.bottom - b.top + 6 + tip.offsetHeight > b.height + 120 ? Math.max(0, a.top - b.top - tip.offsetHeight - 6) : a.bottom - b.top + 6;
    tip.style.left = `${left}px`; tip.style.top = `${top}px`;
  };
  const hide = () => { tip.hidden = true; pinned = null; };
  wrap.hideTip = hide; // a tap or click outside the map hides a pinned tooltip (render's document listener)
  wrap.addEventListener('pointerover', (e) => { if (e.pointerType !== 'mouse') return; const g = e.target.closest('[data-id]'); if (g && !pinned) show(g.dataset.id, g); });
  wrap.addEventListener('pointerout', (e) => { if (e.pointerType !== 'mouse' || pinned) return; const g = e.target.closest('[data-id]'); if (g && !g.contains(e.relatedTarget)) tip.hidden = true; });
  wrap.addEventListener('click', (e) => {
    const g = e.target.closest('[data-id]');
    if (!g) { if (!e.target.closest('[data-testid=el-tip]')) hide(); return; }
    if (pinned === g.dataset.id) { hide(); return; }
    pinned = g.dataset.id; show(g.dataset.id, g);
    if (onPick) onPick(g.dataset.id);
  });
  wrap.addEventListener('focusin', (e) => { const g = e.target.closest('[data-id]'); if (g) show(g.dataset.id, g); });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

// ---------------------------------------------------------------------------------------------- ratings swingometer
function ratingsHtml(r) {
  if (!r) return '';
  const head = (c) => `<div class="el-rcol-h"><b class="num">${esc(c.items.length)}</b> ${te(`elections.band.${c.band}`)}</div>`;
  const bubble = (it) => `<span class="el-bub" data-testid="el-bubble" data-code="${esc(it.code)}" data-party="${esc(it.party_id || '')}"${vars({ '--c': (it.party || {}).color })} title="${esc(`${it.code} ${pct0(it.p)}`)}">${esc(it.code)}</span>`;
  const colour = (c) => `<div class="el-rcol b-${esc(c.band)}" data-testid="el-rcol" data-band="${esc(c.band)}" data-party="${esc(c.party?.code || '')}" data-count="${esc(c.items.length)}"${vars({ '--c': c.party?.color })}>${head(c)}<div class="el-rcol-b">${c.items.map((it) => bubble({ ...it, party: c.party })).join('')}</div></div>`;
  const end = (p, n, right) => `<div class="el-rend ${right ? 'r' : ''}" data-testid="el-settled" data-party="${esc(p?.code || '')}" data-count="${esc(n)}">${partyChip(p)}<b class="num">${esc(n)}</b><span class="faint">${te('elections.ratings.settled')}</span></div>`;
  const bands = ['100%', '90%+', '75%+', '60%+', '50%', '60%+', '75%+', '90%+', '100%'].map((b) => `<span>${esc(b)}</span>`).join('');
  return `<div class="el-ratings" data-testid="el-ratings"><div class="el-rgrid">${end(r.left, r.settled_left, false)}${r.columns.map(colour).join('')}${end(r.right, r.settled_right, true)}</div><div class="el-rbands faint">${bands}</div>
    ${r.others.length ? `<div class="el-rothers" data-testid="el-ratings-others"><span class="faint">${te('elections.ratings.others')}</span>${r.others.map((o) => bubble(o)).join('')}</div>` : ''}</div>`;
}

// ---------------------------------------------------------------------------------------------- featured cards
function cardHtml(r) {
  const top = r.candidates.slice(0, 2);
  const tot = top.reduce((a, c) => a + (c.votes || 0), 0);
  const marginTxt = r.margin != null && r.leader_party ? `${r.leader_party.short_name} +${(r.margin * 100).toFixed(1)}` : null;
  const status = r.status === 'called' ? te('elections.card.called') : r.status === 'runoff' ? te('elections.card.runoff') : te('elections.card.counted', { pct: esc(pct1(r.pct_reported)) });
  const side = (c, right) => `<div class="el-fc-c ${right ? 'r' : ''}" data-testid="el-card-cand" data-candidate="${esc(c.id)}">${avatarHtml(c)}<div class="minw-0"><div class="el-fc-name">${esc(c.name)}</div><div class="faint">${partyChip(c.party)} <span class="num">${c.votes != null ? te('elections.card.votes', { n: esc(num(c.votes)) }) : ''}</span></div></div><b class="num el-fc-p" data-testid="el-card-chance">${esc(pct0(c.chance))}</b></div>`;
  const link = r.event ? eventHref(r.event) : null;
  return `<article class="card el-fc" data-testid="el-card" data-race="${esc(r.id)}"><header class="el-fc-h"><b>${te('elections.card.winner_q', { race: esc(r.name) })}</b><span class="faint">${status}${marginTxt ? ` · <u class="el-margin" title="${te('elections.card.margin_tip')}" data-testid="el-card-margin">${esc(marginTxt)}</u>` : ''}</span></header>
    ${top.map((c, i) => side(c, i === 1)).join('')}
    ${tot ? `<div class="el-fc-bar" aria-hidden="true">${top.map((c) => `<span class="v-w"${vars({ '--w': `${((c.votes / tot) * 100).toFixed(1)}%`, '--c': c.party?.color })}></span>`).join('')}</div>` : ''}
    <div class="el-fc-f">${link ? `<a href="${esc(link)}" data-link class="el-fc-trade">${te('elections.card.trade')}</a>` : ''}<button type="button" class="btn btn-sm btn-ghost" data-race-open="${esc(r.id)}">${te('elections.card.results')}</button></div></article>`;
}

// ---------------------------------------------------------------------------------------------- Power Index
function powerHtml(pi) {
  if (!pi || pi.value == null) return `<p class="faint">${te('elections.power.none')}</p>`;
  const lean = pi.value > 0 ? pi.label_pos : pi.value < 0 ? pi.label_neg : '';
  const head = Math.abs(pi.value) < 0.05 ? te('elections.power.tie') : te('elections.power.leaning', { side: esc(lean), value: esc(Math.abs(pi.value).toFixed(1)) });
  const ch = pi.change_24h;
  const change = ch == null ? '' : Math.abs(ch) < 0.05 ? te('elections.power.flat') : te('elections.power.change', { value: esc(`${ch > 0 ? '+' : '−'}${Math.abs(ch).toFixed(1)}`) });
  const pts = pi.history || [];
  let chart = '';
  if (pts.length > 1) {
    installChartHover();
    const W = 640; const H = 200; const padR = 64; const padT = 10; const padB = 24;
    const S = Math.max(pi.scale || 10, ...pts.map((p) => Math.abs(p.v))) * 1.1;
    const t0 = pts[0].ts; const t1 = pts[pts.length - 1].ts;
    const sx = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (W - padR - 8);
    const sy = (v) => padT + (1 - (v + S) / (2 * S)) * (H - padT - padB);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.ts).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    const lbl = (v, txt) => `<text x="${W - 4}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end" class="el-ax">${esc(txt)}</text>`;
    const hover = hoverAttr([{ name: tx('elections.power.title'), color: 'var(--brand)', points: pts.map((p) => ({ x: sx(p.ts), y: sy(p.v), t: p.ts * 1000, label: `${p.v > 0 ? '+' : ''}${p.v.toFixed(1)}` })) }], { x0: 0, x1: W - padR - 8 });
    chart = `<svg class="chart v-h el-pi-chart" viewBox="0 0 ${W} ${H}"${vars({ '--h': `${H}px` })} role="img" aria-label="${te('elections.power.chart')}"${hover}>
      <line x1="0" x2="${W - padR}" y1="${sy(0).toFixed(1)}" y2="${sy(0).toFixed(1)}" stroke="var(--text-x30)" stroke-dasharray="4 4"/>${lbl(S * 0.85, `+${Math.round(S * 0.85)} ${pi.label_pos}`.slice(0, 18))}${lbl(0, tx('elections.power.tie_axis'))}${lbl(-S * 0.85, `+${Math.round(S * 0.85)} ${pi.label_neg}`.slice(0, 18))}
      <path d="${d}" fill="none" stroke="var(--brand)" stroke-width="2.2" stroke-linejoin="round"/><circle cx="${sx(last.ts).toFixed(1)}" cy="${sy(last.v).toFixed(1)}" r="4.5" fill="var(--brand)"/></svg>`;
  }
  return `<div class="el-pi" data-testid="el-power-body" data-value="${esc(pi.value)}"><div class="el-pi-head"><b class="el-pi-v" data-testid="el-power-headline">${head}</b><span class="faint" data-testid="el-power-change">${change}</span></div>
    <p class="faint el-pi-blurb">${te('elections.power.blurb')} <button type="button" class="link-btn" data-testid="el-power-more" aria-expanded="false">${te('elections.power.learn_more')}</button></p>
    <div class="el-pi-learn" data-testid="el-power-learn" hidden>${tr('elections.power.learn_more_body')}</div>${chart}</div>`;
}

// ---------------------------------------------------------------------------------------------- race detail
function raceHtml(r) {
  const status = r.status === 'called' ? `<span class="el-badge ok" data-testid="el-race-status" data-status="called">${te('elections.race.called')}</span>`
    : r.status === 'runoff' ? `<span class="el-badge warn" data-testid="el-race-status" data-status="runoff">${te('elections.race.runoff')}</span>`
      : `<span class="el-badge" data-testid="el-race-status" data-status="${esc(r.state)}">${te('elections.race.counted', { pct: esc(pct1(r.pct_reported)) })}</span>`;
  const rule = r.rule || {};
  const spread = rule.type === 'spread' ? `<div class="el-spread" data-testid="el-spread"><h3>${te('elections.race.spread_title', { share: esc(Math.round(rule.share * 100)) })}</h3>
    <p class="faint">${te('elections.race.spread_rule', { needed: esc(rule.needed), units: esc(rule.units), share: esc(Math.round(rule.share * 100)), territories: esc((rule.territories || []).join(', ') || '—') })}</p>
    ${rule.candidates.map((c) => { const cand = r.candidates.find((x) => x.id === c.candidate_id) || {}; return `<div class="el-spread-row" data-testid="el-spread-row" data-candidate="${esc(c.candidate_id)}" data-count="${esc(c.count)}" data-meets="${c.meets ? '1' : '0'}">
      <span class="minw-0">${esc(cand.name || '')} ${partyChip(cand.party)}</span><div class="el-spread-bar"><span class="v-w"${vars({ '--w': `${Math.min(100, (c.count / Math.max(1, rule.units)) * 100).toFixed(1)}%`, '--c': cand.party?.color })}></span><i class="v-left"${vars({ '--left': `${((rule.needed / Math.max(1, rule.units)) * 100).toFixed(1)}%` })}></i></div>
      <b class="num">${esc(c.count)}/${esc(rule.needed)}</b>${(rule.territories || []).length ? `<span class="faint">${c.territory_ok ? '✓' : '✗'} ${esc(rule.territories.join(', '))}</span>` : '<span></span>'}${c.meets ? `<span class="el-badge ok">${te('elections.race.meets')}</span>` : '<span></span>'}</div>`; }).join('')}
    ${r.pct_reported >= 1 && !rule.candidates.some((c) => c.meets) && rule.on_fail === 'runoff' ? `<p class="el-runoff-note" data-testid="el-runoff-due">${te('elections.race.runoff_due')}</p>` : ''}</div>` : '';
  const rows = r.candidates.map((c) => `<tr data-testid="el-race-cand" data-candidate="${esc(c.id)}"><td><div class="el-rc">${avatarHtml(c)}<span class="minw-0"><b>${esc(c.name)}</b>${c.running_mate ? `<span class="faint"> · ${esc(c.running_mate)}</span>` : ''}</span></div></td><td>${partyChip(c.party)}</td>
    <td class="num">${c.votes != null ? esc(num(c.votes)) : '—'}</td><td class="num">${c.share != null ? esc(pct1(c.share)) : '—'}</td><td class="num">${esc(pct0(c.chance))}</td><td>${r.status === 'called' ? (r.winner_candidate_id === c.id ? `<span class="el-res yes">${te('elections.tip.yes')}</span>` : `<span class="el-res no">${te('elections.tip.no')}</span>`) : ''}</td></tr>`).join('');
  const units = (r.units || []).map((u) => { const best = Object.entries(u.shares).sort((a, b) => b[1] - a[1])[0]; const c = best && r.candidates.find((x) => x.id === best[0]); return `<tr data-testid="el-race-unit" data-code="${esc(u.code)}"><td>${esc(u.name)}</td><td class="num">${esc(pct0(u.pct_reported))}</td><td>${u.total && c ? `${partyChip(c.party)} <span class="num">${esc(pct1(best[1]))}</span>` : '—'}</td></tr>`; }).join('');
  return `<section class="card el-race" data-testid="el-race" data-race="${esc(r.id)}" data-status="${esc(r.status)}"><header class="el-race-h"><h2>${esc(r.name)}</h2>${status}</header>
    <p class="faint">${te('elections.race.reported', { pu: esc(num(r.pu_reported)), total: esc(num(r.pu_total)), votes: esc(num(r.total_votes)) })}</p>
    <div class="table-wrap"><table class="table el-table"><thead><tr><th>${te('elections.race.candidate')}</th><th>${te('elections.race.party')}</th><th class="num">${te('elections.race.votes')}</th><th class="num">${te('elections.race.share')}</th><th class="num">${te('elections.race.chance')}</th><th>${te('elections.race.result')}</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${spread}${units ? `<details class="el-units"><summary>${te('elections.race.by_unit', { level: esc(r.unit_level) })}</summary><div class="table-wrap"><table class="table el-table"><tbody>${units}</tbody></table></div></details>` : ''}
    ${r.event ? `<a class="btn btn-sm" href="${esc(eventHref(r.event))}" data-link data-testid="el-race-trade">${te('elections.race.trade')}</a>` : ''}</section>`;
}
function raceListHtml(races) {
  if (!races.length) return `<p class="faint">${te('elections.list.empty')}</p>`;
  return `<div class="table-wrap"><table class="table el-table" data-testid="el-race-list"><thead><tr><th>${te('elections.list.race')}</th><th>${te('elections.list.status')}</th><th>${te('elections.list.leader')}</th><th class="num">${te('elections.list.margin')}</th></tr></thead><tbody>${races.map((r) => `<tr data-testid="el-race-row" data-race="${esc(r.id)}">
    <td><button type="button" class="link-btn" data-race-open="${esc(r.id)}">${esc(r.name)}</button></td><td>${r.status === 'called' ? `<span class="el-badge ok">${te('elections.race.called')}</span>` : r.status === 'runoff' ? `<span class="el-badge warn">${te('elections.race.runoff')}</span>` : r.pct_reported ? esc(pct0(r.pct_reported)) : `<span class="faint">${te('elections.list.not_started')}</span>`}</td>
    <td>${partyChip(r.leader_party || r.candidates[0]?.party)}</td><td class="num">${r.margin != null ? esc(`+${(r.margin * 100).toFixed(1)}`) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------------------------- page
export async function render(ctx) {
  const { el, params, query, navigate } = ctx;
  const slug = String(params.hub || '');
  let hub;
  try { hub = await get(`/v1/elections/hubs/${encodeURIComponent(slug)}`); } catch (e) {
    // Not a hub: /category/elections/<tag> stays the category browse page.
    if (e.status === 404 && ctx.fallback) return ctx.fallback.render({ ...ctx, params: { category: 'elections', tag: slug } });
    throw e;
  }
  const S = { hub, tab: String(query.get('tab') || 'overview'), office: String(query.get('office') || ''), replay: null, timeline: [], playing: null, seq: { view: 0, tab: 0, race: 0, tl: 0, hub: 0 } };
  const offices = hub.offices;
  const tabs = [['overview', tx('elections.tab.overview')], ...offices.map((o) => [o.key, hasText(`elections.tab.${o.key}`) ? tx(`elections.tab.${o.key}`) : o.name]), ['states', tx('elections.tab.states')], ['ballot', tx('elections.tab.ballot')]];
  if (!tabs.some((x) => x[0] === S.tab)) S.tab = 'overview';
  document.title = tx('elections.page.doc_title', { title: hub.hub.title });
  const sameCountry = hub.hubs.filter((x) => x.country === hub.country.code);
  const sidebar = [`<a href="/browse" data-link>${te('elections.side.all_markets')}</a>`, `<a href="/category/elections" data-link>${te('elections.side.elections')}</a>`,
    ...sameCountry.filter((x) => x.kind !== 'off_cycle').map((x) => `<a href="/category/elections/${esc(x.slug)}" data-link class="${x.slug === slug ? 'on' : ''}" data-testid="el-side-hub" data-hub="${esc(x.slug)}">${esc(x.title)}</a>`),
    ...offices.map((o) => `<a href="?tab=${esc(o.key)}" data-tab-link="${esc(o.key)}" class="sub">${esc(hasText(`elections.side.${o.key}`) ? tx(`elections.side.${o.key}`) : officeLabel(o))}</a>`),
    ...sameCountry.filter((x) => x.kind === 'off_cycle').map((x) => `<a href="/category/elections/${esc(x.slug)}" data-link class="${x.slug === slug ? 'on' : ''}" data-testid="el-side-hub" data-hub="${esc(x.slug)}">${te('elections.side.off_cycle')}</a>`),
    `<span class="el-side-sep"></span>`, ...hub.hubs.filter((x) => x.country !== hub.country.code).map((x) => `<a href="/category/elections/${esc(x.slug)}" data-link data-testid="el-side-hub" data-hub="${esc(x.slug)}">${te('elections.side.international', { title: esc(x.title) })}</a>`),
    `<a href="/category/elections" data-link>${te('elections.side.referendums')}</a>`].join('');
  el.innerHTML = `<div class="el-page" data-testid="el-hub" data-hub="${esc(slug)}" data-country="${esc(hub.country.code)}" data-flag="elections.hub">
    <div class="el-layout"><nav class="el-side" data-testid="el-sidebar" aria-label="${te('elections.side.aria')}">${sidebar}</nav>
      <div class="el-main minw-0"><div class="overline">${te('elections.page.overline', { country: esc(hub.country.name) })}</div><h1 class="page-title" data-testid="el-title">${te('elections.page.title', { title: esc(hub.hub.title) })}</h1>
        <div class="el-tabsbar"><nav class="el-tabs" role="tablist" data-testid="el-tabs">${tabs.map(([k, l]) => `<button type="button" role="tab" data-tab="${esc(k)}" aria-selected="${k === S.tab ? 'true' : 'false'}" class="${k === S.tab ? 'on' : ''}">${esc(l)}</button>`).join('')}</nav>
          <div class="el-search"><input type="search" data-testid="el-search" placeholder="${te('elections.search.placeholder')}" aria-label="${te('elections.search.placeholder')}" maxlength="60" autocomplete="off"><div class="el-search-res card" data-testid="el-search-results" hidden></div></div></div>
        <div data-testid="el-tab-body" data-tab-body></div></div></div>
    <div class="el-chat-dock ev-actions" data-testid="el-chat-dock" data-flag="elections.chat"></div></div>`;
  const body = el.querySelector('[data-tab-body]');
  const cleanups = [];

  // ---------------- view data (live, or a timeline snapshot)
  async function loadView(office, at) {
    return get(`/v1/elections/hubs/${encodeURIComponent(slug)}/view?office=${encodeURIComponent(office || '')}${at ? `&at=${encodeURIComponent(at)}` : ''}`);
  }
  const drawViewParts = (root, v) => {
    const g = root.querySelector('[data-part=gauges]'); if (g) g.innerHTML = v.gauges.length ? v.gauges.map(gaugeHtml).join('') : `<p class="faint">${te('elections.gauge.none')}</p>`;
    const s = root.querySelector('[data-part=seats]'); if (s) s.innerHTML = v.seats ? seatsHtml(v.seats) : `<p class="faint">${te('elections.seats.not_a_chamber')}</p>`;
    const m = root.querySelector('[data-part=map]'); if (m) { m.innerHTML = mapHtml(v.map, S.hub.parties); wireMap(m, v.map, (id) => { if (S.tab === 'states') openState(id); }); }
    const r = root.querySelector('[data-part=ratings]'); if (r) r.innerHTML = ratingsHtml(v.ratings);
    for (const b of root.querySelectorAll('[data-office-pill]')) { const on = b.dataset.officePill === v.office; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    root.dataset.office = v.office || '';
    root.dataset.live = v.live ? '1' : '0';
  };
  async function refreshView(root, office) {
    const my = ++S.seq.view;
    const v = await loadView(office, S.replay ? S.replay.id : null);
    if (my !== S.seq.view || !root.isConnected) return;
    S.office = v.office;
    drawViewParts(root, v);
  }
  const pills = (keys) => `<div class="el-pills" role="group" aria-label="${te('elections.overview.office_switch')}">${offices.filter((o) => !keys || keys.includes(o.key)).map((o) => `<button type="button" class="el-pill" data-office-pill="${esc(o.key)}" data-testid="el-office-pill" aria-pressed="false">${esc(officeLabel(o))}</button>`).join('')}</div>`;

  // ---------------- tabs
  async function drawTab() {
    const my = ++S.seq.tab;
    for (const b of el.querySelectorAll('[data-tab]')) { const on = b.dataset.tab === S.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    stopPlay(); S.replay = null;
    if (S.tab === 'overview') return drawOverview(my);
    if (S.tab === 'states') return drawStates(my);
    if (S.tab === 'ballot') return drawBallot(my);
    return drawOffice(my, S.tab);
  }
  function drawOverview(my) {
    const first = offices.find((o) => o.chamber) || offices[0];
    body.innerHTML = `<div class="el-grid" data-testid="el-overview" data-view>
      <section class="el-gauges" data-testid="el-gauges" data-part="gauges"></section>
      <section class="card el-card" data-testid="el-seat-card"><div class="el-card-h"><h2>${te('elections.overview.seats_title')}</h2>${pills()}</div><div data-part="seats"></div></section>
      <section class="card el-card" data-testid="el-map" data-flag="elections.results_map"><div class="el-card-h"><h2>${te('elections.overview.map_title')}</h2><span class="faint" data-replay-note></span></div><div data-part="map"></div></section>
      <section class="card el-card" data-testid="el-ratings-card"><div class="el-card-h"><h2>${te('elections.overview.ratings_title')}</h2></div><div data-part="ratings"></div></section>
      <section class="card el-card" data-testid="el-timeline" data-flag="elections.timeline"><div class="el-card-h"><h2>${te('elections.timeline.title')}</h2></div><div data-part="timeline"></div></section>
      <section class="el-card-plain" data-testid="el-featured" data-flag="elections.results"><div class="el-card-h"><h2>${te('elections.overview.featured_title')}</h2></div><div class="el-fgrid" data-part="featured"></div></section>
      <section class="card el-card" data-testid="el-power" data-flag="elections.power_index"><div class="el-card-h"><h2><span class="el-live-dot"></span>${te('elections.power.title')}</h2></div><div data-part="power"></div></section>
      <section class="card el-card" data-testid="el-more"><div class="el-card-h"><h2>${te('elections.more.title')}</h2><span class="faint" data-testid="el-more-count">${te('elections.more.count', { n: esc(S.hub.more_markets.length) })}</span></div><div data-part="more"></div></section>
      <div data-part="race"></div></div>`;
    const root = body.querySelector('[data-view]');
    drawHubParts(root);
    wireTimeline(root);
    return refreshView(root, S.office || first?.key).then(() => { if (my === S.seq.tab) loadTimeline(root); });
  }
  function drawHubParts(root) {
    const f = root.querySelector('[data-part=featured]'); if (f) f.innerHTML = S.hub.featured.length ? S.hub.featured.map(cardHtml).join('') : `<p class="faint">${te('elections.overview.no_featured')}</p>`;
    const p = root.querySelector('[data-part=power]'); if (p) p.innerHTML = powerHtml(S.hub.power_index);
    const m = root.querySelector('[data-part=more]');
    if (m) m.innerHTML = `<div class="table-wrap"><table class="table el-table" data-testid="el-more-table"><thead><tr><th>${te('elections.more.market')}</th><th>${te('elections.more.leader')}</th><th class="num">${te('elections.more.volume')}</th></tr></thead><tbody>${S.hub.more_markets.map((x) => `<tr data-testid="el-more-row" data-event="${esc(x.event_ticker)}"><td><a href="${esc(eventHref(x))}" data-link>${esc(x.title)}</a></td><td>${x.leader ? `${esc(x.leader.outcome)} <b class="num">${esc(Math.round(x.leader.price))}%</b>` : '—'}</td><td class="num">${esc(volOf(x.volume_cents))}</td></tr>`).join('')}</tbody></table></div>`;
    const c = root.querySelector('[data-testid=el-more-count]'); if (c) c.innerHTML = te('elections.more.count', { n: esc(S.hub.more_markets.length) });
  }
  async function drawOffice(my, key) {
    const o = offices.find((x) => x.key === key);
    body.innerHTML = `<div class="el-grid" data-testid="el-office-tab" data-office="${esc(key)}" data-view>
      <section class="el-gauges" data-part="gauges"></section>
      ${o && (o.chamber || o.races > 1) ? `<section class="card el-card" data-testid="el-seat-card"><div class="el-card-h"><h2>${te('elections.overview.seats_title')}</h2></div><div data-part="seats"></div></section>` : ''}
      <section class="card el-card" data-testid="el-map" data-flag="elections.results_map"><div class="el-card-h"><h2>${te('elections.overview.map_title')}</h2></div><div data-part="map"></div></section>
      <section class="card el-card" data-testid="el-ratings-card"><div class="el-card-h"><h2>${te('elections.overview.ratings_title')}</h2></div><div data-part="ratings"></div></section>
      <section data-part="race" data-flag="elections.results"></section>
      <section class="card el-card" data-testid="el-office-races"><div class="el-card-h"><h2>${te('elections.list.title')}</h2></div><div data-part="list"></div></section></div>`;
    const root = body.querySelector('[data-view]');
    const viewP = refreshView(root, key);
    const listP = get(`/v1/elections/hubs/${encodeURIComponent(slug)}/races?office=${encodeURIComponent(key)}`).then((r) => {
      if (my !== S.seq.tab) return;
      root.querySelector('[data-part=list]').innerHTML = raceListHtml(r.races);
      if (o && o.races === 1 && r.races[0] && flagOn('elections.results')) openRace(r.races[0].id);
    });
    await Promise.all([viewP, listP]);
  }
  async function drawStates(my) {
    body.innerHTML = `<div class="el-grid" data-testid="el-states-tab" data-view><section class="card el-card" data-testid="el-map" data-flag="elections.results_map"><div class="el-card-h"><h2>${te('elections.states.map_title')}</h2>${pills()}</div><div data-part="map"></div></section>
      <section class="card el-card"><div class="el-card-h"><h2>${te('elections.states.title')}</h2></div><div class="el-state-grid" data-part="statelist"></div></section><div data-part="state"></div><div data-part="race"></div></div>`;
    const root = body.querySelector('[data-view]');
    await refreshView(root, S.office || offices[0]?.key);
    if (my !== S.seq.tab) return;
    const v = await loadView(S.office, null);
    if (my !== S.seq.tab || !v.map) return;
    root.querySelector('[data-part=statelist]').innerHTML = [...v.map.states].sort((a, b) => a.name.localeCompare(b.name)).map((s) => `<button type="button" class="el-state-btn" data-state-open="${esc(s.id)}" data-testid="el-state-btn">${esc(s.name)}</button>`).join('');
  }
  async function openState(id) {
    const root = body.querySelector('[data-view]'); if (!root) return;
    const box = root.querySelector('[data-part=state]'); if (!box) return;
    const my = ++S.seq.race;
    const r = await get(`/v1/elections/hubs/${encodeURIComponent(slug)}/races?division=${encodeURIComponent(id)}`);
    if (my !== S.seq.race) return;
    box.innerHTML = `<section class="card el-card" data-testid="el-state-panel" data-id="${esc(id)}"><div class="el-card-h"><h2>${te('elections.states.races_in')}</h2></div>${raceListHtml(r.races)}</section>`;
  }
  async function openRace(id) {
    const root = body.querySelector('[data-view]'); if (!root) return;
    const box = root.querySelector('[data-part=race]'); if (!box) return;
    const my = ++S.seq.race;
    try {
      const r = await get(`/v1/elections/races/${encodeURIComponent(id)}`);
      if (my !== S.seq.race || !box.isConnected) return;
      box.innerHTML = raceHtml(r.race);
      box.dataset.race = id;
    } catch (e) { if (my === S.seq.race) box.innerHTML = `<p class="faint">${esc(e.message)}</p>`; }
  }

  // ---------------- timeline (play / scrub / LIVE)
  function wireTimeline(root) {
    const box = root.querySelector('[data-part=timeline]'); if (!box) return;
    box.innerHTML = `<div class="el-tl" data-testid="el-tl"><button type="button" class="btn btn-sm el-tl-play" data-testid="el-tl-play" aria-label="${te('elections.timeline.play')}">▶</button>
      <div class="el-tl-track"><input type="range" min="0" max="0" value="0" step="1" data-testid="el-tl-range" aria-label="${te('elections.timeline.scrub')}"><div class="el-tl-marks" data-marks></div></div>
      <button type="button" class="btn btn-sm el-tl-live on" data-testid="el-tl-live"><i class="el-live-dot"></i>${te('elections.timeline.live')}</button></div><div class="faint el-tl-status" data-testid="el-tl-status">${te('elections.timeline.live_now')}</div>`;
    const range = box.querySelector('input[type=range]');
    range.addEventListener('input', () => { stopPlay(); seek(root, Number(range.value)); });
    box.querySelector('[data-testid=el-tl-live]').onclick = () => { stopPlay(); goLive(root); };
    box.querySelector('[data-testid=el-tl-play]').onclick = () => (S.playing ? stopPlay() : play(root));
  }
  async function loadTimeline(root) {
    if (!flagOn('elections.timeline')) return;
    const box = root.querySelector('[data-part=timeline]'); if (!box) return;
    const my = ++S.seq.tl;
    let r; try { r = await get(`/v1/elections/hubs/${encodeURIComponent(slug)}/timeline`); } catch { return; }
    if (my !== S.seq.tl || !box.isConnected) return;
    S.timeline = r.points;
    const range = box.querySelector('input[type=range]');
    range.max = String(Math.max(0, r.points.length - 1));
    if (!S.replay) range.value = range.max;
    box.querySelector('[data-marks]').innerHTML = r.points.map((p, i) => (p.kind === 'call' || p.kind === 'uncall' || p.kind === 'start' ? `<i class="el-tl-mark k-${esc(p.kind)} v-left"${vars({ '--left': `${(i / Math.max(1, r.points.length - 1)) * 100}%` })} title="${esc(p.label || '')}"></i>` : '')).join('');
    box.dataset.points = String(r.points.length);
  }
  async function seek(root, i) {
    const p = S.timeline[i]; if (!p) return;
    S.replay = { id: p.id };
    const live = root.querySelector('[data-testid=el-tl-live]'); live.classList.remove('on');
    root.querySelector('[data-testid=el-tl-status]').textContent = tx('elections.timeline.replaying', { time: fmtDateTime(p.ts), label: p.label || '' });
    root.querySelector('input[type=range]').value = String(i);
    await refreshView(root, S.office);
  }
  function goLive(root) {
    S.replay = null;
    const live = root.querySelector('[data-testid=el-tl-live]'); if (live) live.classList.add('on');
    const st = root.querySelector('[data-testid=el-tl-status]'); if (st) st.textContent = tx('elections.timeline.live_now');
    const range = root.querySelector('input[type=range]'); if (range) range.value = range.max;
    return refreshView(root, S.office);
  }
  function play(root) {
    if (!S.timeline.length) return;
    const btn = root.querySelector('[data-testid=el-tl-play]'); btn.textContent = '❚❚'; btn.dataset.playing = '1';
    let i = S.replay ? Math.max(0, S.timeline.findIndex((p) => p.id === S.replay.id)) : 0;
    if (i >= S.timeline.length - 1) i = 0;
    const step = async () => {
      if (!S.playing) return;
      await seek(root, i);
      i += 1;
      if (i >= S.timeline.length) { stopPlay(); goLive(root); return; }
      S.playing = setTimeout(step, 700);
    };
    S.playing = setTimeout(step, 0);
  }
  function stopPlay() {
    if (S.playing) clearTimeout(S.playing);
    S.playing = null;
    const btn = el.querySelector('[data-testid=el-tl-play]'); if (btn) { btn.textContent = '▶'; btn.dataset.playing = '0'; }
  }

  // ---------------- My Ballot (state → LGA → ward; nothing about the visitor is stored unless they save the division id)
  async function drawBallot(my) {
    const levels = S.hub.country.ballot_levels || [];
    body.innerHTML = `<section class="card el-card el-ballot" data-testid="el-ballot"><h2>${te('elections.ballot.title')}</h2><p class="faint" data-testid="el-ballot-privacy">${te('elections.ballot.privacy')}</p>
      <div class="el-ballot-pick">${levels.map((lv, i) => `<label class="field"><span>${esc(hasText(`elections.level.${lv}`) ? tx(`elections.level.${lv}`) : lv)}</span><select data-level="${esc(i)}" data-testid="el-ballot-select" ${i ? 'disabled' : ''}><option value="">${te('elections.ballot.choose')}</option></select></label>`).join('')}</div>
      <div class="d-flex gap-8"><button type="button" class="btn btn-primary" data-testid="el-ballot-show" disabled>${te('elections.ballot.show')}</button></div>
      <div data-testid="el-ballot-saved" class="el-ballot-saved"></div><div data-testid="el-ballot-results"></div></section>`;
    const sels = [...body.querySelectorAll('select[data-level]')];
    const showBtn = body.querySelector('[data-testid=el-ballot-show]');
    const results = body.querySelector('[data-testid=el-ballot-results]'); const saved = body.querySelector('[data-testid=el-ballot-saved]');
    const fill = async (i, parent) => {
      const r = await get(`/v1/elections/countries/${encodeURIComponent(S.hub.country.code)}/divisions${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`);
      if (my !== S.seq.tab) return;
      sels[i].innerHTML = `<option value="">${te('elections.ballot.choose')}</option>${r.divisions.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}`;
      sels[i].disabled = false;
    };
    const chosen = () => { for (let i = sels.length - 1; i >= 0; i--) if (sels[i].value) return sels[i].value; return ''; };
    sels.forEach((s, i) => s.addEventListener('change', async () => {
      for (let j = i + 1; j < sels.length; j++) { sels[j].innerHTML = `<option value="">${te('elections.ballot.choose')}</option>`; sels[j].disabled = true; }
      showBtn.disabled = !chosen();
      if (s.value && sels[i + 1]) await fill(i + 1, s.value);
    }));
    const drawSaved = (sv) => { saved.innerHTML = sv ? `<span>${te('elections.ballot.saved_area')} <b data-testid="el-ballot-saved-name">${esc(sv)}</b></span> <button type="button" class="btn btn-sm btn-ghost" data-testid="el-ballot-forget">${te('elections.ballot.forget')}</button>` : ''; };
    const showResult = (r, savable) => {
      const chain = r.division.chain.map((c) => esc(c.name)).join(' › ');
      results.innerHTML = `<div class="el-ballot-where" data-testid="el-ballot-where" data-division="${esc(r.division.id)}">${chain}</div>${r.contests.length ? r.contests.map((c) => `<div class="el-ballot-c" data-testid="el-ballot-contest" data-race="${esc(c.race_id)}" data-office="${esc(c.office)}"><span class="overline">${esc(c.office_name)} · ${esc(c.election.title)}</span><b>${esc(c.name)}</b>
        <span>${c.leader ? `${esc(c.leader.name)} ${partyChip(c.leader.party)} <b class="num">${esc(pct0(c.leader.chance))}</b>` : ''} ${c.status === 'called' ? `<span class="el-badge ok">${te('elections.race.called')}</span>` : ''}</span>${c.event ? `<a href="${esc(eventHref(c.event))}" data-link>${te('elections.ballot.trade')}</a>` : ''}</div>`).join('') : `<p class="faint">${te('elections.ballot.none')}</p>`}
        ${savable && session.user ? `<button type="button" class="btn btn-sm" data-testid="el-ballot-save">${te('elections.ballot.save')}</button>` : ''}`;
      results.dataset.division = r.division.id;
    };
    showBtn.onclick = async () => { const id = chosen(); if (!id) return; try { showResult(await get(`/v1/elections/ballot/${encodeURIComponent(id)}`), true); } catch (e) { toast(e.message, 'error'); } };
    body.querySelector('[data-testid=el-ballot]').addEventListener('click', async (e) => {
      if (e.target.closest('[data-testid=el-ballot-save]')) {
        try { const r = await request('PUT', `/v1/users/${encodeURIComponent(session.uid)}/election_ballot`, { division_id: results.dataset.division }); drawSaved(r.division.name); e.target.closest('[data-testid=el-ballot-save]').remove(); toast(tx('elections.ballot.saved_toast')); } catch (ex) { toast(ex.message, 'error'); }
      }
      if (e.target.closest('[data-testid=el-ballot-forget]')) {
        try { await request('DELETE', `/v1/users/${encodeURIComponent(session.uid)}/election_ballot`); drawSaved(null); toast(tx('elections.ballot.forgot_toast')); } catch (ex) { toast(ex.message, 'error'); }
      }
    });
    await fill(0, null);
    if (session.user) {
      const r = await get(`/v1/users/${encodeURIComponent(session.uid)}/election_ballot`).catch(() => null);
      if (my === S.seq.tab && r && r.saved) { drawSaved(r.division.name); showResult(r, false); }
    }
  }

  // ---------------- events
  body.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-office-pill]');
    if (pill) { const root = body.querySelector('[data-view]'); if (root) refreshView(root, pill.dataset.officePill); return; }
    const ro = e.target.closest('[data-race-open]');
    if (ro) { openRace(ro.dataset.raceOpen); return; }
    const so = e.target.closest('[data-state-open]');
    if (so) { openState(so.dataset.stateOpen); return; }
    const more = e.target.closest('[data-testid=el-power-more]');
    if (more) { const box = body.querySelector('[data-testid=el-power-learn]'); box.hidden = !box.hidden; more.setAttribute('aria-expanded', String(!box.hidden)); }
  });
  const setTab = (k) => { S.tab = k; const u = new URL(location.href); if (k === 'overview') u.searchParams.delete('tab'); else u.searchParams.set('tab', k); history.replaceState(history.state, '', u.pathname + u.search); drawTab().catch((x) => toast(x.message, 'error')); };
  el.querySelector('[data-testid=el-tabs]').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  el.querySelector('[data-testid=el-sidebar]').addEventListener('click', (e) => { const a = e.target.closest('[data-tab-link]'); if (a) { e.preventDefault(); setTab(a.dataset.tabLink); } });
  // Search states and candidates.
  const sInput = el.querySelector('[data-testid=el-search]'); const sRes = el.querySelector('[data-testid=el-search-results]');
  let sTimer = null; let sSeq = 0;
  sInput.addEventListener('input', () => {
    clearTimeout(sTimer);
    sTimer = setTimeout(async () => {
      const q = sInput.value.trim(); const my = ++sSeq;
      if (q.length < 2) { sRes.hidden = true; return; }
      const r = await get(`/v1/elections/hubs/${encodeURIComponent(slug)}/search?q=${encodeURIComponent(q)}`).catch(() => ({ states: [], races: [] }));
      if (my !== sSeq) return;
      sRes.innerHTML = [...r.states.map((s) => `<button type="button" data-testid="el-search-state" data-state-pick="${esc(s.id)}">${esc(s.name)} <span class="faint">${esc(s.code)}</span></button>`),
        ...r.races.map((x) => `<button type="button" data-testid="el-search-race" data-race-pick="${esc(x.id)}" data-office="${esc(x.office)}">${esc(x.name)}${x.candidates.length ? ` <span class="faint">· ${esc(x.candidates.map((c) => c.name).join(', '))}</span>` : ''}</button>`)].join('') || `<p class="faint">${te('elections.search.none')}</p>`;
      sRes.hidden = false;
    }, 250);
  });
  sRes.addEventListener('click', async (e) => {
    const st = e.target.closest('[data-state-pick]'); const rc = e.target.closest('[data-race-pick]');
    sRes.hidden = true;
    if (st) { setTab('states'); await new Promise((r) => setTimeout(r, 0)); const wait = () => (body.querySelector('[data-part=state]') ? openState(st.dataset.statePick) : setTimeout(wait, 100)); wait(); }
    if (rc) { setTab(rc.dataset.office); const id = rc.dataset.racePick; const wait = () => (body.querySelector('[data-part=race]') ? openRace(id) : setTimeout(wait, 100)); setTimeout(wait, 50); }
  });
  // Live: results, calls, prices and admin edits nudge the page; it refetches (debounced) what is on screen.
  let liveT = null;
  const refreshAll = async () => {
    const my = ++S.seq.hub;
    try { const nh = await get(`/v1/elections/hubs/${encodeURIComponent(slug)}`); if (my !== S.seq.hub) return; S.hub = nh; } catch { return; }
    const root = body.querySelector('[data-view]');
    if (!root) return;
    drawHubParts(root);
    if (!S.replay) refreshView(root, S.office).catch(() => {});
    loadTimeline(root);
    const rb = root.querySelector('[data-part=race]'); if (rb && rb.dataset.race) openRace(rb.dataset.race);
  };
  cleanups.push(socket.subscribe({ channels: ['elections'], hubs: [slug] }, (m) => { if (m.type !== 'elections') return; clearTimeout(liveT); liveT = setTimeout(refreshAll, 600); }));
  cleanups.push(() => { clearTimeout(liveT); clearTimeout(sTimer); stopPlay(); });
  const onDoc = (e) => { for (const w of el.querySelectorAll('[data-testid=el-map-wrap]')) if (!w.contains(e.target) && w.hideTip) w.hideTip(); };
  document.addEventListener('click', onDoc);
  cleanups.push(() => document.removeEventListener('click', onDoc));
  // Hub chat (§20): a room of its own, a floating pill with the online count.
  if (flagOn('elections.chat') && flagOn('social.chat')) cleanups.push(mountChat({ el: el.querySelector('.el-page'), ev: { event_ticker: hub.hub.chat_room }, label: tx('elections.chat.label', { title: hub.hub.title }), pillOnline: true }));
  await drawTab();
  void navigate; void fmtDt;
  return () => { for (const c of cleanups) { try { c(); } catch { /* ignore */ } } };
}
