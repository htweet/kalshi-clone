// Admin › Elections (CLONE_SPEC.md §37): the elections and their results simulator (start, pause, advance, speed, reset;
// flag elections.simulator), the results desk (call a winner or a runoff, uncall; a role, a reason and step-up; the
// two-person rule for offices that need it, approved or rejected here; a call proposes settlements on the resolution
// desk), the country model (countries, divisions, offices and their win rules, parties with CMS-media logos, candidates
// with photos or initials, elections, races) and the Power Index formula. Every change asks for a reason and is audited.
// Admin-entered names are escaped wherever they are shown.
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.elections-strings.js';
import { vars } from '../../dynstyle.js';
import { esc, get, put, post, toast, dialog, formHtml, wireForm, confirmAction, section, badge, fmtTime, subTabs } from './ui.js';

const TABS = ['overview', 'desk', 'data', 'power'];
const KINDS = ['countries', 'divisions', 'offices', 'parties', 'candidates', 'elections', 'races'];
let seq = 0; // only the latest load draws
const pct = (p) => `${Math.round(Number(p || 0) * 1000) / 10}%`;

export async function render(ctx) {
  const tab = TABS.includes(ctx.parts[0]) ? ctx.parts[0] : 'overview';
  const my = ++seq;
  const { el } = ctx;
  el.innerHTML = `${section(tx('admin.el.page.title'), te('admin.el.page.intro'))}${subTabs(TABS.map((k) => [k, tx(`admin.el.tab.${k}`)]), tab, '/admin/elections')}<div id="el-body" data-testid="adm-el-${esc(tab)}"></div>`;
  const body = el.querySelector('#el-body');
  const ov = await get('/elections');
  if (my !== seq) return;
  const reload = () => render(ctx);
  if (tab === 'overview') return overview(body, ov, ctx, reload);
  if (tab === 'desk') return desk(body, ov, ctx, my);
  if (tab === 'data') return data(body, ov, ctx, my);
  return power(body, ov, ctx, my);
}

// ---------------------------------------------------------------------------------------------- overview + simulator
function overview(el, ov, ctx, reload) {
  const canSim = ctx.perms.has('markets.ops');
  el.innerHTML = `${ov.simulator_flag ? '' : `<p class="adm-wl-note" data-testid="adm-el-sim-off">${te('admin.el.sim.flag_off')}</p>`}
    ${ov.pending_calls ? `<p data-testid="adm-el-pending-note">${badge(tx('admin.el.desk.pending_count', { n: ov.pending_calls }), 'warn')} <a href="/admin/elections/desk" data-link>${te('admin.el.desk.open')}</a></p>` : ''}
    <div class="table-wrap"><table class="table" data-testid="adm-el-elections"><thead><tr><th>${te('admin.el.ov.election')}</th><th>${te('admin.el.ov.country')}</th><th>${te('admin.el.ov.date')}</th><th class="num">${te('admin.el.ov.races')}</th><th class="num">${te('admin.el.ov.called')}</th><th>${te('admin.el.ov.sim')}</th><th class="num">${te('admin.el.ov.snapshots')}</th><th></th></tr></thead>
    <tbody>${ov.elections.map((e) => `<tr data-testid="adm-el-election" data-id="${esc(e.id)}" data-sim="${esc(e.sim.status)}"><td><a href="/category/elections/${esc(e.slug)}" data-link>${esc(e.title)}</a></td><td>${esc(e.country)}</td><td>${esc(e.date)}</td><td class="num">${esc(e.races)}</td><td class="num">${esc(e.called)}</td>
      <td>${badge(e.sim.status, e.sim.status === 'running' ? 'ok' : '')} <span class="faint">${te('admin.el.sim.minutes', { m: esc(Math.round(e.sim.minutes)), speed: esc(e.sim.speed) })}</span></td><td class="num">${esc(e.snapshots)}</td>
      <td>${canSim ? ['start', 'pause', 'advance', 'speed', 'reset'].map((a) => `<button type="button" class="btn btn-sm ${a === 'reset' ? 'btn-ghost' : ''}" data-sim="${esc(a)}" data-id="${esc(e.id)}" data-testid="adm-el-sim-${esc(a)}">${te(`admin.el.sim.${a}`)}</button>`).join(' ') : ''}</td></tr>`).join('')}</tbody></table></div>
    <h3 class="mt-16">${te('admin.el.ov.countries')}</h3><div class="table-wrap"><table class="table" data-testid="adm-el-countries"><thead><tr><th>${te('admin.el.ov.country')}</th><th>${te('admin.el.field.currency')}</th><th>${te('admin.el.field.time_zone')}</th><th>${te('admin.el.field.locale')}</th><th>${te('admin.el.ov.divisions')}</th></tr></thead>
    <tbody>${ov.countries.map((c) => `<tr data-testid="adm-el-country" data-code="${esc(c.code)}"><td><b>${esc(c.code)}</b> ${esc(c.name)}</td><td>${esc(c.currency)}</td><td>${esc(c.time_zone)}</td><td>${esc(c.locale)}</td><td>${c.divisions.map((d) => `${esc(d.level)} ${esc(d.n)}`).join(' · ')}</td></tr>`).join('')}</tbody></table></div>`;
  el.onclick = async (e) => {
    const b = e.target.closest('[data-sim]'); if (!b) return;
    const action = b.dataset.sim;
    const extra = action === 'advance' ? `<label class="field"><span>${te('admin.el.sim.advance_minutes')}</span><input type="number" name="minutes" min="1" max="2880" value="60" data-testid="adm-el-sim-minutes"></label>`
      : action === 'speed' ? `<label class="field"><span>${te('admin.el.sim.speed_label')}</span><input type="number" name="speed" min="1" max="100000" value="60" data-testid="adm-el-sim-speed"></label>` : '';
    const r = await confirmAction({ title: tx(`admin.el.sim.confirm_${action}`), confirm: tx(`admin.el.sim.${action}`), danger: action === 'reset', reason: true, extraHtml: extra });
    if (!r) return;
    const bodyOut = { action, reason: r.reason };
    if (action === 'advance') bodyOut.minutes = Number(r.form.minutes.value);
    if (action === 'speed') bodyOut.speed = Number(r.form.speed.value);
    try { await put(`/elections/elections/${encodeURIComponent(b.dataset.id)}/simulator`, bodyOut); toast(tx('admin.el.sim.done')); reload(); } catch (ex) { toast(ex.message, 'error'); }
  };
}

// ---------------------------------------------------------------------------------------------- results desk
async function desk(el, ov, ctx, my) {
  const elections = ov.elections;
  const q = ctx.query;
  const eid = elections.some((e) => e.id === q.get('election')) ? q.get('election') : elections[0]?.id;
  const office = q.get('office') || '';
  const canCall = ctx.perms.has('resolution.write');
  el.innerHTML = `<div class="d-flex gap-8 fw-wrap"><label class="field"><span>${te('admin.el.ov.election')}</span><select data-testid="adm-el-desk-election">${elections.map((e) => `<option value="${esc(e.id)}" ${e.id === eid ? 'selected' : ''}>${esc(e.title)}</option>`).join('')}</select></label>
      <label class="field"><span>${te('admin.el.desk.office')}</span><input data-testid="adm-el-desk-office" value="${esc(office)}" maxlength="20" placeholder="${te('admin.el.desk.office_hint')}"></label></div>
    <h3>${te('admin.el.desk.pending')}</h3><div data-testid="adm-el-calls"></div><h3 class="mt-16">${te('admin.el.desk.races')}</h3><div data-testid="adm-el-races"><div class="skeleton minh-260"></div></div>`;
  const go = () => ctx.navigate(`/admin/elections/desk?election=${encodeURIComponent(el.querySelector('[data-testid=adm-el-desk-election]').value)}&office=${encodeURIComponent(el.querySelector('[data-testid=adm-el-desk-office]').value.trim())}`);
  el.querySelector('[data-testid=adm-el-desk-election]').onchange = go;
  el.querySelector('[data-testid=adm-el-desk-office]').onchange = go;
  const [d, calls] = await Promise.all([get(`/elections/elections/${encodeURIComponent(eid)}/desk${office ? `?office=${encodeURIComponent(office)}` : ''}`), get('/elections/calls?status=pending')]);
  if (my !== seq) return;
  el.querySelector('[data-testid=adm-el-calls]').innerHTML = calls.calls.length ? `<table class="table"><tbody>${calls.calls.map((c) => `<tr data-testid="adm-el-call" data-id="${esc(c.id)}" data-race="${esc(c.race_id)}"><td><b>${esc(c.race_name)}</b> · ${esc(c.action)}${c.outcome ? ` (${esc(c.outcome)})` : ''}</td><td>${esc(c.reason)}</td><td class="faint">${esc(c.requested_by)} · ${esc(fmtTime(c.requested_time))}</td>
    <td>${canCall ? `<button type="button" class="btn btn-sm btn-primary" data-approve="${esc(c.id)}" data-testid="adm-el-approve">${te('admin.el.desk.approve')}</button> <button type="button" class="btn btn-sm" data-reject="${esc(c.id)}" data-testid="adm-el-reject">${te('admin.el.desk.reject')}</button>` : ''}</td></tr>`).join('')}</tbody></table>` : `<p class="faint">${te('admin.el.desk.no_pending')}</p>`;
  const meets = (r) => (r.rule && r.rule.candidates ? r.rule.candidates.find((c) => c.meets) : null);
  el.querySelector('[data-testid=adm-el-races]').innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>${te('admin.el.desk.race')}</th><th class="num">${te('admin.el.desk.reported')}</th><th>${te('admin.el.desk.leader')}</th><th>${te('admin.el.desk.rule')}</th><th>${te('admin.el.desk.status')}</th><th></th></tr></thead><tbody>${d.races.slice(0, 300).map((r) => {
    const lead = r.candidates[0]; const m = meets(r);
    return `<tr data-testid="adm-el-race" data-race="${esc(r.id)}" data-status="${esc(r.status)}"><td>${esc(r.name)} ${r.two_person ? badge(tx('admin.el.desk.two_person'), 'warn') : ''}</td><td class="num">${esc(pct(r.pct_reported))}</td><td>${lead ? `${esc(lead.name)} <span class="faint">${esc(lead.party.short_name)}</span>` : '—'}</td>
      <td>${r.rule.type === 'spread' ? `${m ? badge(tx('admin.el.desk.meets'), 'ok') : badge(tx('admin.el.desk.not_met'))} <span class="faint">${esc(r.rule.needed)}/${esc(r.rule.units)}</span>` : badge(tx('admin.el.desk.plurality'))}</td>
      <td>${badge(r.status, r.status === 'called' ? 'ok' : r.status === 'runoff' ? 'warn' : '')}${r.pending ? ` ${badge(tx('admin.el.desk.awaiting'), 'warn')}` : ''}</td>
      <td>${canCall ? (r.status === 'open' ? `<button type="button" class="btn btn-sm" data-call="${esc(r.id)}" data-testid="adm-el-call-btn">${te('admin.el.desk.call')}</button>${r.rule.on_fail === 'runoff' ? ` <button type="button" class="btn btn-sm btn-ghost" data-runoff="${esc(r.id)}" data-testid="adm-el-runoff-btn">${te('admin.el.desk.runoff')}</button>` : ''}` : `<button type="button" class="btn btn-sm btn-ghost" data-uncall="${esc(r.id)}" data-testid="adm-el-uncall-btn">${te('admin.el.desk.uncall')}</button>`) : ''}</td></tr>`;
  }).join('')}</tbody></table></div>`;
  const race = (id) => d.races.find((x) => x.id === id);
  const done = (res) => { toast(res && res.status === 'pending_approval' ? tx('admin.el.desk.sent_for_approval') : tx('admin.el.desk.done')); render(ctx); };
  el.onclick = async (e) => {
    const c = e.target.closest('[data-call]'); const ro = e.target.closest('[data-runoff]'); const u = e.target.closest('[data-uncall]');
    const ap = e.target.closest('[data-approve]'); const rj = e.target.closest('[data-reject]');
    try {
      if (c) {
        const r = race(c.dataset.call);
        const sel = `<label class="field"><span>${te('admin.el.desk.winner')}</span><select name="candidate" data-testid="adm-el-call-candidate">${r.candidates.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.party.short_name)}</option>`).join('')}</select></label>`;
        const ok = await confirmAction({ title: tx('admin.el.desk.call_title', { race: r.name }), body: r.two_person ? te('admin.el.desk.two_person_note') : te('admin.el.desk.call_note'), confirm: tx('admin.el.desk.call'), reason: true, extraHtml: sel });
        if (ok) done(await post(`/elections/races/${encodeURIComponent(r.id)}/call`, { outcome: 'winner', candidate_id: ok.form.candidate.value, reason: ok.reason }));
      }
      if (ro) { const r = race(ro.dataset.runoff); const ok = await confirmAction({ title: tx('admin.el.desk.runoff_title', { race: r.name }), confirm: tx('admin.el.desk.runoff'), reason: true }); if (ok) done(await post(`/elections/races/${encodeURIComponent(r.id)}/call`, { outcome: 'runoff', reason: ok.reason })); }
      if (u) { const r = race(u.dataset.uncall); const ok = await confirmAction({ title: tx('admin.el.desk.uncall_title', { race: r.name }), confirm: tx('admin.el.desk.uncall'), danger: true, reason: true }); if (ok) done(await post(`/elections/races/${encodeURIComponent(r.id)}/uncall`, { reason: ok.reason })); }
      if (ap) { const ok = await confirmAction({ title: tx('admin.el.desk.approve_title'), confirm: tx('admin.el.desk.approve') }); if (ok) { await post(`/elections/calls/${encodeURIComponent(ap.dataset.approve)}/approve`, {}); done(null); } }
      if (rj) { const ok = await confirmAction({ title: tx('admin.el.desk.reject_title'), confirm: tx('admin.el.desk.reject'), danger: true, reason: true }); if (ok) { await post(`/elections/calls/${encodeURIComponent(rj.dataset.reject)}/reject`, { note: ok.reason }); done(null); } }
    } catch (ex) { toast(ex.message, 'error'); }
  };
}

// ---------------------------------------------------------------------------------------------- data (country model)
// Editable fields per kind (json: parsed from a JSON text area). Create-only fields are listed in CREATE.
const FIELDS = {
  countries: [['name'], ['currency'], ['time_zone'], ['locale'], ['config', 'json'], ['active', 'checkbox']],
  divisions: [['name'], ['data', 'json'], ['sort', 'number']],
  offices: [['name'], ['level'], ['seats', 'number'], ['chamber', 'checkbox'], ['two_person', 'checkbox'], ['rule', 'json'], ['sort', 'number']],
  parties: [['name'], ['short_name'], ['color', 'color'], ['logo_media_id'], ['coalition'], ['active', 'checkbox'], ['sort', 'number']],
  candidates: [['name'], ['party_id'], ['photo_media_id'], ['running_mate'], ['sort', 'number']],
  elections: [['title'], ['kind'], ['date'], ['config', 'json'], ['active', 'checkbox']],
  races: [['name'], ['division_id'], ['seat', 'number'], ['date'], ['featured', 'checkbox'], ['prior', 'json'], ['sort', 'number']],
};
const CREATE = { countries: [['code']], divisions: [['country'], ['level'], ['code'], ['parent_id']], offices: [['country'], ['key']], parties: [['country'], ['code']], candidates: [['race_id']], elections: [['country'], ['slug']], races: [['election_id'], ['office_id'], ['area', 'json']] };
const NULLABLE = new Set(['logo_media_id', 'photo_media_id', 'coalition', 'running_mate', 'name', 'date']);
const FILTERS = { divisions: ['country', 'parent', 'level'], offices: ['country'], parties: ['country'], candidates: ['race'], elections: ['country'], races: ['election', 'office'] };
const label = (k) => tx(`admin.el.field.${k}`);
const shown = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
async function data(el, ov, ctx, my) {
  const kind = KINDS.includes(ctx.query.get('kind')) ? ctx.query.get('kind') : 'parties';
  const filters = Object.fromEntries((FILTERS[kind] || []).map((f) => [f, ctx.query.get(f) || '']));
  if (!filters.country && 'country' in filters) filters.country = ov.countries[0]?.code || '';
  if ('parent' in filters && !filters.parent && kind === 'divisions') filters.level = filters.level || 'state';
  if (kind === 'races' && !filters.election) filters.election = ov.elections[0]?.id || '';
  const canWrite = ctx.perms.has('catalog.write');
  const qs = new URLSearchParams(Object.entries({ ...filters, q: ctx.query.get('q') || '' }).filter(([, v]) => v));
  el.innerHTML = `<div class="d-flex gap-8 fw-wrap">${KINDS.map((k) => `<a href="/admin/elections/data?kind=${esc(k)}" data-link class="btn btn-sm ${k === kind ? 'btn-primary' : ''}" data-testid="adm-el-kind" data-kind="${esc(k)}">${te(`admin.el.kind.${k}`)}</a>`).join('')}</div>
    <form class="d-flex gap-8 fw-wrap mt-12" data-testid="adm-el-filter">${[...Object.keys(filters), 'q'].map((f) => `<label class="field"><span>${te(`admin.el.filter.${f}`)}</span><input name="${esc(f)}" value="${esc(f === 'q' ? ctx.query.get('q') || '' : filters[f])}" maxlength="60"></label>`).join('')}<button class="btn btn-sm" type="submit">${te('admin.el.filter.apply')}</button>${canWrite ? `<button class="btn btn-sm btn-primary" type="button" data-testid="adm-el-new">${te('admin.el.data.new')}</button>` : ''}</form>
    <div data-testid="adm-el-rows" class="mt-12"><div class="skeleton minh-260"></div></div>`;
  el.querySelector('[data-testid=adm-el-filter]').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); const p = new URLSearchParams([['kind', kind], ...[...f.entries()].filter(([, v]) => v)]); ctx.navigate(`/admin/elections/data?${p}`); };
  const r = await get(`/elections/${kind}?${qs}`);
  if (my !== seq) return;
  const rows = r[kind];
  const key = kind === 'countries' ? 'code' : 'id';
  const cols = ['id', ...FIELDS[kind].map((f) => f[0]).filter((f) => !['config', 'data', 'rule', 'prior'].includes(f))].slice(0, 7);
  el.querySelector('[data-testid=adm-el-rows]').innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>${cols.map((c) => `<th>${esc(c === 'id' ? tx('admin.el.field.id') : label(c))}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map((x) => `<tr data-testid="adm-el-row" data-id="${esc(x[key])}">${cols.map((c) => `<td>${c === 'color' ? `<span class="el-swatch v-bg"${vars({ '--bg': x.color })}></span> ` : ''}${esc(shown(c === 'id' ? x[key] : x[c]))}</td>`).join('')}<td>${canWrite ? `<button type="button" class="btn btn-sm" data-edit="${esc(x[key])}" data-testid="adm-el-edit">${te('admin.el.data.edit')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>${rows.length >= 500 ? `<p class="faint">${te('admin.el.data.first_500')}</p>` : ''}`;
  const openForm = (row) => {
    const fields = [...(row ? [] : CREATE[kind]), ...FIELDS[kind]].map(([name, type]) => ({ name, label: label(name), type: type === 'json' ? 'textarea' : type || 'text', value: row ? (type === 'json' ? JSON.stringify(row[name] ?? null) : type === 'checkbox' ? !!row[name] : row[name] ?? '') : type === 'checkbox' && name === 'active' ? true : '', span: type === 'json' }))
      .concat([{ name: 'reason', label: tx('admin.el.data.reason'), required: true, span: true }]);
    const d = dialog(`<h3>${row ? te('admin.el.data.edit_title', { id: esc(row[key]) }) : te('admin.el.data.new_title', { kind: esc(tx(`admin.el.kind.${kind}`)) })}</h3>${formHtml(fields, { submit: tx('admin.el.data.save'), id: 'eld', testid: 'adm-el-form' })}`, { wide: true });
    wireForm(d.querySelector('form'), fields, async (v) => {
      const out = { reason: v.reason };
      const errs = {};
      for (const [name, type] of [...(row ? [] : CREATE[kind]), ...FIELDS[kind]]) {
        let x = v[name];
        if (type === 'json') { if (x === '' || x === 'null') { if (!row) continue; x = null; } else { try { x = JSON.parse(x); } catch { errs[name] = tx('admin.el.data.bad_json'); continue; } } if (x === null) continue; }
        else if (type === 'number') { if (x === '') continue; }
        else if (type !== 'checkbox' && x === '') { if (row && NULLABLE.has(name) && row[name] != null && name !== 'name') x = null; else continue; }
        if (row && type !== 'json' && shown(row[name]) === shown(x) && type !== 'checkbox') continue;
        if (row && type === 'checkbox' && !!row[name] === x) continue;
        out[name] = x;
      }
      if (Object.keys(errs).length) throw Object.assign(new Error(tx('admin.el.data.bad_json')), { fields: errs });
      if (row) await put(`/elections/${kind}/${encodeURIComponent(row[key])}`, out); else await post(`/elections/${kind}`, out);
      d.close(); toast(tx('admin.el.data.saved')); render(ctx);
    });
  };
  el.querySelector('[data-testid=adm-el-rows]').onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) openForm(rows.find((x) => String(x[key]) === b.dataset.edit)); };
  const nb = el.querySelector('[data-testid=adm-el-new]'); if (nb) nb.onclick = () => openForm(null);
}

// ---------------------------------------------------------------------------------------------- Power Index
async function power(el, ov, ctx, my) {
  const country = ov.countries.some((c) => c.code === ctx.query.get('country')) ? ctx.query.get('country') : ov.countries[0]?.code;
  const r = await get(`/elections/power_index/${encodeURIComponent(country)}`);
  if (my !== seq) return;
  const f = r.formula;
  const fields = [{ name: 'enabled', label: tx('admin.el.pi.enabled'), type: 'checkbox', value: f.enabled }, { name: 'label_pos', label: tx('admin.el.pi.label_pos'), value: f.label_pos }, { name: 'label_neg', label: tx('admin.el.pi.label_neg'), value: f.label_neg },
    { name: 'offset', label: tx('admin.el.pi.offset'), type: 'number', step: 'any', value: f.offset }, { name: 'scale', label: tx('admin.el.pi.scale'), type: 'number', value: f.scale },
    { name: 'terms', label: tx('admin.el.pi.terms'), type: 'textarea', span: true, value: f.terms.map((t) => `${t.ticker} ${t.weight}`).join('\n'), hint: tx('admin.el.pi.terms_hint') }, { name: 'reason', label: tx('admin.el.data.reason'), required: true, span: true }];
  el.innerHTML = `<div class="d-flex gap-8">${ov.countries.map((c) => `<a class="btn btn-sm ${c.code === country ? 'btn-primary' : ''}" href="/admin/elections/power?country=${esc(c.code)}" data-link>${esc(c.code)}</a>`).join('')}</div>
    <p data-testid="adm-el-pi-value">${r.power_index ? te('admin.el.pi.now', { value: esc(r.power_index.value ?? '—'), change: esc(r.power_index.change_24h ?? '—') }) : te('admin.el.pi.off')}</p>
    <p class="faint">${te('admin.el.pi.intro')}</p>${ctx.perms.has('settings.write') ? formHtml(fields, { submit: tx('admin.el.data.save'), id: 'elpi', testid: 'adm-el-pi-form' }) : ''}`;
  const form = el.querySelector('[data-testid=adm-el-pi-form]');
  if (form) wireForm(form, fields, async (v) => {
    const terms = String(v.terms || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [ticker, w] = l.split(/\s+/); return { ticker, weight: Number(w) }; });
    await put(`/elections/power_index/${encodeURIComponent(country)}`, { enabled: v.enabled, label_pos: v.label_pos, label_neg: v.label_neg, offset: v.offset === '' ? 0 : v.offset, scale: v.scale === '' ? 20 : v.scale, terms, reason: v.reason });
    toast(tx('admin.el.data.saved')); render(ctx);
  });
}
