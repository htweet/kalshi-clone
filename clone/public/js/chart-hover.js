// Chart hover readout (owner request 2026-11-08, CLONE_SPEC.md §15.4): on every price chart a vertical line follows the
// pointer, with the time at the top, a dot on each series and a legend beside the line listing each series' name and
// value in its colour (ordered as the lines are, top first). It follows the pointer until it leaves the chart; on touch
// a tap or a horizontal drag shows it and a tap elsewhere hides it; with the keyboard, focus the chart and use the arrow
// keys (Home / End jump, Escape hides) — the values are also announced to screen readers.
//
// Charts opt in with hoverAttr(series, …) on their <svg>. Coordinates are in the SVG's own viewBox units and are mapped
// to the page with getScreenCTM, so it works for every aspect-ratio mode. The overlay is plain HTML positioned through
// the CSSOM (allowed by the strict style CSP; no style attributes in markup).
import { t as tx } from './i18n.js';
import './content/components-strings.js';
import { fmtDt } from './currency.js';

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r1 = (n) => Math.round(n * 10) / 10;

// series: [{ name, color, points: [{ x, y, t (ms), label }] }] — x ascending. Returns ' data-hover="…" tabindex="0"'.
export function hoverAttr(series, { x0, x1 } = {}) {
  const ss = series.filter((s) => s.points && s.points.length).map((s) => ({ n: String(s.name ?? ''), c: String(s.color ?? ''), p: s.points.map((p) => [r1(p.x), r1(p.y), Math.round(p.t), String(p.label)]) }));
  if (!ss.length) return '';
  const all = ss.flatMap((s) => s.p);
  const X0 = x0 ?? Math.min(...all.map((p) => p[0])); const X1 = x1 ?? Math.max(...all.map((p) => p[0]));
  const T0 = Math.min(...all.map((p) => p[2])); const T1 = Math.max(...all.map((p) => p[2]));
  return ` data-hover="${escAttr(JSON.stringify({ X0, X1, T0, T1, s: ss }))}" tabindex="0" focusable="true"`;
}

const cache = new WeakMap(); // svg -> parsed data
function dataOf(svg) {
  let d = cache.get(svg);
  if (!d) { try { d = JSON.parse(svg.getAttribute('data-hover')); } catch { d = null; } if (d) cache.set(svg, d); }
  return d;
}
// The last point at or before x (the value "as of" that moment); the first point before the series starts.
function idxAt(p, x) {
  let lo = 0; let hi = p.length - 1; let k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (p[m][0] <= x) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}
const asOf = (p, x) => p[Math.max(0, idxAt(p, x))];
// Where the drawn line is at x (straight segments between points), for the dot.
function lineY(p, x) {
  const k = idxAt(p, x);
  if (k < 0) return p[0][1];
  if (k >= p.length - 1) return p[p.length - 1][1];
  const a = p[k]; const b = p[k + 1];
  return b[0] > a[0] ? a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]) : a[1];
}
const timeAt = (d, x) => (d.X1 > d.X0 ? d.T0 + ((x - d.X0) / (d.X1 - d.X0)) * (d.T1 - d.T0) : d.T1);
const fmtWhen = (d, t) => (d.T1 - d.T0 <= 36 * 3600000 ? fmtDt(t, { hour: 'numeric', minute: '2-digit' }) : fmtDt(t, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }));

let active = null; // { svg, host, ov, x }
let lastPointer = null; // { x, y } in client px while a pointer is over a chart
let lastDown = null; // { svg, t } of the last pointerdown (a click or tap also focuses the chart)
// A live redraw replaces the chart's svg (and the overlay) under a still pointer: show the readout again on the new one.
const watched = new WeakSet();
function watchHost(host) {
  if (watched.has(host) || typeof MutationObserver === 'undefined') return;
  watched.add(host);
  new MutationObserver(() => {
    if (!active || active.host !== host || active.svg.isConnected || !lastPointer) return;
    const svg = host.querySelector('svg[data-hover]');
    active = null;
    if (svg) showAt(svg, viewX(svg, lastPointer.x, lastPointer.y));
  }).observe(host, { childList: true });
}
function overlay(svg) {
  const host = svg.parentElement;
  host.classList.add('ch-host');
  watchHost(host);
  let ov = host.querySelector(':scope > .ch-hover');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'ch-hover';
    ov.setAttribute('data-testid', 'chart-hover');
    ov.innerHTML = '<div class="ch-line"></div><div class="ch-time" data-testid="chart-hover-time"></div><div class="ch-dots"></div><div class="ch-legend" data-testid="chart-hover-legend"></div><div class="sr-only" aria-live="polite"></div>';
    host.appendChild(ov);
  }
  return { host, ov };
}
function hide() {
  lastPointer = null;
  if (!active) return;
  active.ov.hidden = true;
  active.svg.classList.remove('ch-on');
  active = null;
}
// Show the readout at viewBox x on svg.
function showAt(svg, xv, { announce = false } = {}) {
  const d = dataOf(svg);
  if (!d) return;
  if (active && active.svg !== svg) hide();
  const { host, ov } = overlay(svg);
  const x = Math.min(d.X1, Math.max(d.X0, xv));
  const m = svg.getScreenCTM();
  if (!m) return;
  const hr = host.getBoundingClientRect();
  const toHost = (vx, vy) => { const p = new DOMPoint(vx, vy).matrixTransform(m); return [p.x - hr.left, p.y - hr.top]; };
  const vb = svg.viewBox.baseVal;
  const [px, top] = toHost(x, vb ? vb.y : 0);
  const [, bottom] = toHost(x, vb ? vb.y + vb.height : svg.clientHeight);
  const rows = d.s.map((s) => { const p = asOf(s.p, x); const [dx, dy] = toHost(Math.max(x, s.p[0][0]), lineY(s.p, x)); return { s, p, dx, dy }; }).sort((a, b) => a.dy - b.dy);
  ov.hidden = false;
  svg.classList.add('ch-on');
  const line = ov.querySelector('.ch-line');
  line.style.setProperty('left', `${px}px`); line.style.setProperty('top', `${top}px`); line.style.setProperty('height', `${Math.max(0, bottom - top)}px`);
  const when = fmtWhen(d, timeAt(d, x));
  const time = ov.querySelector('.ch-time');
  time.textContent = when;
  time.style.setProperty('left', `${px}px`); time.style.setProperty('top', `${Math.max(0, top - 22)}px`);
  const dots = ov.querySelector('.ch-dots');
  if (dots.childElementCount !== rows.length) dots.innerHTML = rows.map(() => '<span class="ch-dot"></span>').join('');
  rows.forEach((r, i) => { const el = dots.children[i]; el.style.setProperty('left', `${r.dx}px`); el.style.setProperty('top', `${r.dy}px`); el.style.setProperty('--c', r.s.c); });
  const leg = ov.querySelector('.ch-legend');
  leg.replaceChildren(...rows.map((r) => {
    const row = document.createElement('div');
    row.className = 'ch-row'; row.setAttribute('data-testid', 'chart-hover-row'); row.style.setProperty('--c', r.s.c);
    const n = document.createElement('span'); n.className = 'ch-name'; n.textContent = r.s.n;
    const v = document.createElement('span'); v.className = 'ch-val'; v.textContent = r.p[3];
    row.append(n, v);
    return row;
  }));
  // Beside the line: to the right, or to the left when it would not fit; vertically next to the top series.
  const lw = leg.offsetWidth; const lh = leg.offsetHeight;
  const right = px + 12 + lw <= hr.width - 4;
  leg.style.setProperty('left', `${right ? px + 12 : Math.max(0, px - 12 - lw)}px`);
  const want = rows.length ? rows[0].dy - 16 : top;
  leg.style.setProperty('top', `${Math.max(top, Math.min(want, bottom - lh))}px`);
  leg.classList.toggle('left', !right);
  if (announce) ov.querySelector('[aria-live]').textContent = tx('components.chart_hover.announce', { time: when, values: rows.map((r) => `${r.s.n} ${r.p[3]}`).join(', ') });
  active = { svg, host, ov, x, kbd: !!announce };
}
const svgOf = (target) => (target && target.closest ? target.closest('svg[data-hover]') : null);
const viewX = (svg, clientX, clientY) => { const m = svg.getScreenCTM(); return m ? new DOMPoint(clientX, clientY).matrixTransform(m.inverse()).x : 0; };

let installed = false;
export function installChartHover() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointermove', (e) => {
    const svg = svgOf(e.target);
    if (svg) { showAt(svg, viewX(svg, e.clientX, e.clientY)); lastPointer = { x: e.clientX, y: e.clientY }; } else if (active && e.pointerType === 'mouse') hide();
  }, { passive: true });
  document.addEventListener('pointerdown', (e) => {
    const svg = svgOf(e.target);
    lastDown = { svg, t: Date.now() };
    if (svg) { showAt(svg, viewX(svg, e.clientX, e.clientY)); lastPointer = { x: e.clientX, y: e.clientY }; } else hide();
  }, { passive: true });
  // Leaving the chart (mouse out of the svg, or out of the window) hides it.
  document.addEventListener('pointerout', (e) => {
    if (!active || e.pointerType !== 'mouse') return;
    const from = svgOf(e.target);
    if (from && from === active.svg && !(e.relatedTarget && active.svg.contains(e.relatedTarget))) hide();
  });
  window.addEventListener('blur', hide);
  window.addEventListener('scroll', () => { if (active && document.activeElement !== active.svg) hide(); }, { passive: true });
  // Keyboard: arrows step through the points of the first series; Home / End; Escape hides.
  document.addEventListener('keydown', (e) => {
    const svg = svgOf(e.target);
    if (!svg) return;
    const d = dataOf(svg);
    if (!d) return;
    const xs = [...new Set(d.s.flatMap((s) => s.p.map((p) => p[0])))].sort((a, b) => a - b);
    const cur = active && active.svg === svg ? active.x : d.X1;
    let i = 0; while (i < xs.length - 1 && xs[i + 1] <= cur + 1e-6) i += 1; // the point at or before the readout
    let next = null;
    if (e.key === 'ArrowLeft') next = xs[Math.max(0, xs[i] < cur - 1e-6 ? i : i - 1)];
    else if (e.key === 'ArrowRight') next = xs[Math.min(xs.length - 1, i + 1)];
    else if (e.key === 'Home') next = xs[0];
    else if (e.key === 'End') next = xs[xs.length - 1];
    else if (e.key === 'Escape') { hide(); return; }
    else return;
    e.preventDefault();
    showAt(svg, next, { announce: true });
  });
  // Keyboard focus shows the latest values; focus that comes from a click or tap keeps the pointer's moment.
  document.addEventListener('focusin', (e) => {
    const svg = svgOf(e.target);
    if (!svg || e.target !== svg) return;
    if (lastDown && lastDown.svg === svg && Date.now() - lastDown.t < 1000) return;
    showAt(svg, dataOf(svg)?.X1 ?? 0, { announce: true });
  });
  // Losing focus closes a readout the keyboard opened (a pointer-driven one follows the pointer instead).
  document.addEventListener('focusout', (e) => { if (active && active.kbd && e.target === active.svg) hide(); });
}
