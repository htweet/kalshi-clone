// Admin UI toolkit: API calls with field errors, dense tables (search / sort / paginate), forms with inline
// validation, confirm + reason dialogs, SVG bar charts. Styles live in /admin.css.
import { vars } from '../../dynstyle.js';
import { csrf } from '../../api.js';
import { refreshClientToken } from '../../security.js';
import { esc, toast } from '../../lib.js';
import { money, fmtDateTime } from '../../currency.js'; // display currency, locale and time zone (CLONE_SPEC.md §30)

export { esc, toast };

export class AdminError extends Error {
  constructor(status, body) {
    const e = (body && body.error) || {};
    super(e.details && !e.fields ? `${e.message}: ${e.details}` : e.fields ? 'Please fix the highlighted fields' : e.message || `HTTP ${status}`);
    this.status = status; this.code = e.code; this.fields = e.fields || null; this.details = e.details;
  }
}
export async function call(method, path, body, stepUpDone = false) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t = csrf.get(); if (t) headers['x-csrf-token'] = t;
  { const ct = await refreshClientToken(); if (ct) headers['X-Client-Token'] = ct; } // signed client token on every /v1 call (PLAN P1.10)
  const res = await fetch(`/v1/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const rotated = res.headers.get('x-csrf-token'); if (rotated) csrf.set(rotated); // own role change rotates the session (CLONE_SPEC §22.2)
  const data = await res.json().catch(() => ({}));
  // Role changes / forced resets need a recent password or code: confirm in the step-up modal, then retry once (§22.6).
  if (!res.ok && data?.error?.code === 'step_up_required' && !stepUpDone) {
    const { stepUp } = await import('../stepup.js');
    await stepUp({ methods: data.error.methods, action: data.error.action });
    return call(method, path, body, true);
  }
  if (!res.ok) throw new AdminError(res.status, data);
  return data;
}
export const get = (p) => call('GET', p);
export const post = (p, b = {}) => call('POST', p, b);
export const put = (p, b = {}) => call('PUT', p, b);
export const del = (p) => call('DELETE', p);

export const fmtTime = (iso) => (iso ? fmtDateTime(iso) : '—');
export const fmtMoney = (d) => money(d); // API dollars → ₦ / $ (CLONE_SPEC.md §30)
export const fmtQty = (fp) => Number(fp || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
// <input type=datetime-local> <-> ISO
export const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');
export const badge = (text, kind = '') => `<span class="adm-badge ${esc(kind)}">${esc(text)}</span>`;
export const STATUS_KIND = { draft: 'warn', published: 'ok', active: 'ok', initialized: '', inactive: 'warn', closed: '', determined: 'warn', finalized: 'ok', halted: 'bad', open: 'warn', actioned: 'ok', dismissed: '' };
export const statusBadge = (s) => badge(s, STATUS_KIND[s] || '');

// ---------------------------------------------------------------- table
// cols: [{key, label, num?, sort?:fn|false, render?:(row)=>html}]; returns {el, setRows}
export function dataTable(host, { cols, rows = [], search = true, pageSize = 25, empty = 'Nothing here yet.', rowAttrs = () => '', testid = '', searchText } = {}) {
  const st = { rows, q: '', sort: null, dir: 1, page: 0 };
  host.innerHTML = `<div class="adm-table" ${testid ? `data-testid="${esc(testid)}"` : ''}>
    ${search ? '<div class="adm-table-tools"><input type="search" class="adm-input" placeholder="Filter rows" aria-label="Filter rows" data-filter></div>' : ''}
    <div class="adm-scroll"><table class="table adm-grid"><thead><tr>${cols.map((c, i) => `<th class="${c.num ? 'num' : ''}">${c.sort === false ? esc(c.label) : `<button type="button" data-sort="${i}">${esc(c.label)}<span class="arrow"></span></button>`}</th>`).join('')}</tr></thead><tbody></tbody></table></div>
    <div class="adm-pager"><span class="faint" data-count></span><span class="grow"></span><button class="btn btn-sm" data-prev type="button">Prev</button><span class="faint" data-page></span><button class="btn btn-sm" data-next type="button">Next</button></div></div>`;
  const tbody = host.querySelector('tbody');
  const text = searchText || ((r) => cols.map((c) => (typeof r[c.key] === 'object' ? '' : r[c.key] ?? '')).join(' '));
  function draw() {
    let list = st.rows;
    if (st.q) list = list.filter((r) => text(r).toLowerCase().includes(st.q));
    if (st.sort != null) {
      const c = cols[st.sort];
      const key = typeof c.sort === 'function' ? c.sort : (r) => r[c.key];
      list = [...list].sort((a, b) => { const x = key(a); const y = key(b); const nx = Number(x); const ny = Number(y); const cmp = x != null && y != null && !Number.isNaN(nx) && !Number.isNaN(ny) && x !== '' && y !== '' ? nx - ny : String(x ?? '').localeCompare(String(y ?? '')); return cmp * st.dir; });
    }
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    st.page = Math.min(st.page, pages - 1);
    const slice = list.slice(st.page * pageSize, (st.page + 1) * pageSize);
    tbody.innerHTML = slice.length ? slice.map((r) => `<tr ${rowAttrs(r) /* eslint-disable-line parlance/no-unescaped-html -- rowAttrs and column render() are caller-supplied markup builders (checked where defined); plain cells are esc()'d */}>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : esc(r[c.key] ?? '')}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="faint adm-empty">${esc(empty)}</td></tr>`;
    host.querySelector('[data-count]').textContent = `${list.length} row${list.length === 1 ? '' : 's'}`;
    host.querySelector('[data-page]').textContent = `${st.page + 1} / ${pages}`;
    host.querySelector('[data-prev]').disabled = st.page === 0;
    host.querySelector('[data-next]').disabled = st.page >= pages - 1;
    for (const b of host.querySelectorAll('[data-sort]')) { const on = Number(b.dataset.sort) === st.sort; b.classList.toggle('on', on); b.querySelector('.arrow').textContent = on ? (st.dir > 0 ? ' ▲' : ' ▼') : ''; }
  }
  host.querySelector('[data-filter]')?.addEventListener('input', (e) => { st.q = e.target.value.trim().toLowerCase(); st.page = 0; draw(); });
  host.querySelector('[data-prev]').onclick = () => { st.page -= 1; draw(); };
  host.querySelector('[data-next]').onclick = () => { st.page += 1; draw(); };
  for (const b of host.querySelectorAll('[data-sort]')) b.onclick = () => { const i = Number(b.dataset.sort); if (st.sort === i) st.dir = -st.dir; else { st.sort = i; st.dir = 1; } draw(); };
  draw();
  return { setRows: (r) => { st.rows = r; draw(); } };
}

// ---------------------------------------------------------------- forms
// fields: [{name, label, type:'text'|'textarea'|'number'|'select'|'checkbox'|'datetime'|'color'|'date', options?, value?, hint?, required?, placeholder?, span?, step?}]
export function formHtml(fields, { submit = 'Save', id = '', extra = '', testid = '' } = {}) {
  const f = (x) => {
    const v = x.value ?? '';
    const req = x.required ? 'required' : '';
    const common = `name="${esc(x.name)}" id="f-${esc(id)}-${esc(x.name)}" ${req} ${x.placeholder ? `placeholder="${esc(x.placeholder)}"` : ''} aria-describedby="e-${esc(id)}-${esc(x.name)}"`;
    let input;
    if (x.type === 'textarea') input = `<textarea ${common} rows="${esc(x.rows || 3)}" maxlength="${esc(x.max || 20000)}">${esc(v)}</textarea>`;
    else if (x.type === 'select') input = `<select ${common}>${x.options.map((o) => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`; }).join('')}</select>`;
    else if (x.type === 'checkbox') return `<label class="adm-check ${x.span ? 'span2' : ''}"><input type="checkbox" ${common} ${v ? 'checked' : ''}> <span>${esc(x.label)}</span></label>`;
    else if (x.type === 'datetime') input = `<input type="datetime-local" ${common} value="${esc(toLocalInput(v))}">`;
    else if (x.type === 'color') input = `<span class="adm-color"><input type="color" value="${esc(v || '#008751')}" data-color-for="${esc(x.name)}" aria-label="${esc(x.label)} picker"><input type="text" ${common} value="${esc(v)}" maxlength="7"></span>`;
    else input = `<input type="${x.type === 'number' ? 'number' : x.type === 'date' ? 'date' : 'text'}" ${x.step ? `step="${esc(x.step)}"` : ''} ${common} value="${esc(v)}">`;
    return `<label class="field ${x.span ? 'span2' : ''}" for="f-${esc(id)}-${esc(x.name)}"><span>${esc(x.label)}${x.required ? ' *' : ''}</span>${input}${x.hint ? `<small class="faint">${esc(x.hint)}</small>` : ''}<small class="adm-err" id="e-${esc(id)}-${esc(x.name)}" role="alert"></small></label>`;
  };
  return `<form class="adm-form" data-form="${esc(id)}" ${testid ? `data-testid="${esc(testid)}"` : ''} novalidate><div class="adm-form-grid">${fields.map(f).join('')}</div>
    <div class="adm-form-actions"><button class="btn btn-primary" type="submit">${esc(submit)}</button>${extra /* eslint-disable-line parlance/no-unescaped-html -- extra buttons markup passed by admin views */}<small class="adm-err" data-form-error role="alert"></small></div></form>`;
}
// Read values (datetime → ISO, checkbox → bool) and attach submit with client + server field validation.
export function wireForm(form, fields, onSubmit) {
  for (const c of form.querySelectorAll('[data-color-for]')) {
    const t = form.elements[c.dataset.colorFor];
    c.oninput = () => { t.value = c.value; };
    t.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(t.value)) c.value = t.value; });
  }
  const values = () => Object.fromEntries(fields.map((x) => {
    const el = form.elements[x.name];
    if (!el) return [x.name, undefined];
    if (x.type === 'checkbox') return [x.name, el.checked];
    if (x.type === 'datetime') return [x.name, fromLocalInput(el.value)];
    if (x.type === 'number') return [x.name, el.value === '' ? '' : Number(el.value)];
    return [x.name, el.value];
  }));
  const showErrors = (errs) => {
    for (const x of fields) {
      const box = form.querySelector(`#e-${CSS.escape(form.dataset.form)}-${CSS.escape(x.name)}`);
      const el = form.elements[x.name];
      const m = errs[x.name] || '';
      if (box) box.textContent = m;
      if (el && el.setAttribute) { if (m) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
    }
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = values();
    const errs = {};
    for (const x of fields) if (x.required && (v[x.name] === '' || v[x.name] == null)) errs[x.name] = 'is required';
    showErrors(errs);
    const fe = form.querySelector('[data-form-error]');
    fe.textContent = '';
    if (Object.keys(errs).length) { fe.textContent = 'Please fix the highlighted fields'; return; }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try { await onSubmit(v); }
    catch (ex) {
      if (ex.fields) { showErrors(ex.fields); const other = Object.entries(ex.fields).filter(([k]) => !fields.some((x) => x.name === k)); fe.textContent = other.length ? other.map(([k, m]) => `${k} ${m}`).join('; ') : 'Please fix the highlighted fields'; }
      else fe.textContent = ex.message;
    } finally { btn.disabled = false; }
  });
  return { values, showErrors };
}

// ---------------------------------------------------------------- dialogs
export function dialog(html, { onOpen, wide = false, testid = 'adm-dialog' } = {}) {
  const d = document.createElement('dialog');
  d.className = `adm-dialog ${wide ? 'wide' : ''}`;
  d.dataset.testid = testid;
  // eslint-disable-next-line parlance/no-unescaped-html -- dialog(html) takes markup; every caller builds it from templates this rule checks
  d.innerHTML = html;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.showModal();
  onOpen?.(d);
  return d;
}
// Resolves to the entered reason (or true when no reason is asked), or null when canceled.
export function confirmAction({ title, body = '', confirm = 'Confirm', danger = false, reason = false, reasonLabel = 'Reason (required, recorded in the audit log)', extraHtml = '' }) {
  return new Promise((resolve) => {
    let done = false;
    const d = dialog(`<form method="dialog" class="adm-confirm" data-testid="confirm-dialog"><h3>${esc(title)}</h3>${body ? `<p class="muted">${body /* eslint-disable-line parlance/no-unescaped-html -- body/extraHtml are markup from admin views, built with esc() */}</p>` : ''}${extraHtml}
      ${reason ? `<label class="field"><span>${esc(reasonLabel)}</span><textarea name="reason" rows="2" data-testid="confirm-reason"></textarea><small class="adm-err" role="alert" data-reason-err></small></label>` : ''}
      <div class="adm-form-actions"><button class="btn" value="cancel" type="button" data-cancel>Cancel</button><button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" type="submit" data-testid="confirm-ok">${esc(confirm)}</button></div></form>`);
    const f = d.querySelector('form');
    d.querySelector('[data-cancel]').onclick = () => d.close();
    d.addEventListener('close', () => { if (!done) resolve(null); });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (reason) {
        const r = f.reason.value.trim();
        if (r.length < 3) { f.querySelector('[data-reason-err]').textContent = 'A reason of at least 3 characters is required'; return; }
        done = true; resolve({ reason: r, form: f }); d.close(); return;
      }
      done = true; resolve({ form: f }); d.close();
    });
  });
}

// ---------------------------------------------------------------- charts (single-series bars, own SVG)
// points: [{label, value, display}]; one series → no legend (the card title names it); hover shows a tooltip.
export function barChart(points, { height = 180, format = (v) => String(v), color = 'var(--brand)', label = 'Chart' } = {}) {
  if (!points.length) return '<p class="faint">No data in this range.</p>';
  const W = 640; const H = height; const padL = 8; const padR = 56; const padT = 10; const padB = 24;
  const max = Math.max(...points.map((p) => p.value), 0);
  const top = max > 0 ? niceMax(max) : 1;
  const slot = (W - padL - padR) / points.length;
  const bw = Math.max(2, slot - 2); // 2px surface gap between bars
  const sy = (v) => padT + (1 - v / top) * (H - padT - padB);
  const ticks = [0, 0.5, 1].map((f) => top * f);
  const grid = ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${sy(t)}" y2="${sy(t)}" stroke="var(--line)" ${t ? 'stroke-dasharray="2 4"' : ''}/><text x="${W - 4}" y="${sy(t) + 4}" text-anchor="end" font-size="11" fill="var(--text-x30)">${esc(format(t, true))}</text>`).join('');
  const step = Math.max(1, Math.ceil(points.length / 6));
  const xl = points.map((p, i) => (i % step === 0 ? `<text x="${padL + i * slot + slot / 2}" y="${H - 6}" font-size="11" text-anchor="middle" fill="var(--text-x30)">${esc(p.label.slice(5))}</text>` : '')).join('');
  const r = Math.min(4, bw / 2);
  const bars = points.map((p, i) => {
    const x = padL + i * slot + 1; const y = sy(p.value); const h = Math.max(0, H - padB - y);
    const shape = h > r ? `<path d="M${x},${H - padB} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H - padB} Z" fill="${esc(color)}"/>` : h > 0 ? `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${esc(color)}"/>` : '';
    return `<g data-tip="${esc(`${p.label}: ${p.display ?? format(p.value)}`)}">${shape}<rect x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent"/></g>`;
  }).join('');
  return `<div class="adm-chart"><svg viewBox="0 0 ${esc(W)} ${esc(H)}" role="img" aria-label="${esc(label)}" preserveAspectRatio="none" class="v-h"${vars({ '--h': `${H}px` })}>${grid}${xl}${bars}</svg><div class="adm-tip" hidden></div></div>`;
}
function niceMax(v) { const e = 10 ** Math.floor(Math.log10(v)); const m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e; }
export function wireCharts(root) {
  for (const c of root.querySelectorAll('.adm-chart')) {
    const tip = c.querySelector('.adm-tip');
    c.addEventListener('mousemove', (e) => {
      const g = e.target.closest('[data-tip]');
      if (!g) { tip.hidden = true; return; }
      tip.hidden = false; tip.textContent = g.dataset.tip;
      const b = c.getBoundingClientRect();
      tip.style.left = `${Math.min(b.width - 160, Math.max(0, e.clientX - b.left + 10))}px`; tip.style.top = `${Math.max(0, e.clientY - b.top - 34)}px`;
    });
    c.addEventListener('mouseleave', () => { tip.hidden = true; });
  }
}

export function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const csvLine = (arr) => arr.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))).join(',');

export function section(title, sub = '', actions = '') {
  return `<div class="adm-head"><div><h2>${esc(title)}</h2>${sub ? `<p class="muted">${sub}</p>` : ''}</div><div class="adm-head-actions">${actions}</div></div>`; // eslint-disable-line parlance/no-unescaped-html -- sub/actions are markup from admin views (escaped parts, static buttons)
}
export function subTabs(tabs, current, base) {
  return `<nav class="adm-subtabs" aria-label="Sections">${tabs.map(([k, l]) => `<a href="${esc(base)}/${esc(k)}" data-link class="${k === current ? 'on' : ''}" data-subtab="${esc(k)}">${esc(l)}</a>`).join('')}</nav>`;
}
