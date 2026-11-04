// Admin › Security (PLAN P1.10 / P1.14): perimeter security events — bot challenges served / passed / failed, honeypot
// probes, CSP violation reports, rate-limit blocks, rejected client tokens and cross-origin requests.
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.security-strings.js';
import { esc, get, toast, dataTable, section, fmtTime, badge } from './ui.js';

const KINDS = ['challenge_served', 'challenge_passed', 'challenge_failed', 'honeypot', 'csp_report', 'rate_limited', 'client_token_rejected', 'ws_rejected', 'cors_rejected'];
const KIND_BADGE = { challenge_passed: 'ok', challenge_failed: 'bad', honeypot: 'bad', csp_report: 'warn', rate_limited: 'warn', client_token_rejected: 'warn', ws_rejected: 'warn', cors_rejected: 'warn' };

export async function render({ el }) {
  el.innerHTML = section(tx('admin.security.render.security'), tx('admin.security.render.perimeter_events_from_the_last')) +
    `<div class="adm-tiles" data-testid="security-counts"></div>
     <form class="adm-toolbar adm-filters" data-f data-testid="security-filters"><label class="field"><span>${te('admin.security.render.kind')}</span><select name="kind"><option value="">${te('admin.security.render.all_kinds')}</option>${KINDS.map((k) => `<option value="${k}">${k.replace(/_/g, ' ')}</option>`).join('')}</select></label>
       <label class="field"><span>${te('admin.security.render.ip')}</span><input name="ip" class="adm-input"></label><button class="btn" type="submit">${te('admin.security.render.filter')}</button></form>
     <p class="faint" data-total></p><div id="se"></div>`;
  const t = dataTable(el.querySelector('#se'), { testid: 'security-events', pageSize: 50, rowAttrs: (r) => `data-kind="${esc(r.kind)}"`,
    searchText: (r) => [r.kind, r.ip, r.path, r.ua, r.user_id, JSON.stringify(r.detail || {})].join(' '),
    cols: [{ key: 'time', label: tx('admin.security.render.time'), render: (r) => esc(fmtTime(r.time)) }, { key: 'kind', label: tx('admin.security.render.kind'), render: (r) => badge(r.kind.replace(/_/g, ' '), KIND_BADGE[r.kind] || '') },
      { key: 'ip', label: 'IP' }, { key: 'path', label: tx('admin.security.render.request'), render: (r) => `<code>${esc(r.method || '')} ${esc(r.path || '')}</code>` },
      { key: 'ua', label: tx('admin.security.render.user_agent'), render: (r) => `<span class="faint">${esc((r.ua || '').slice(0, 80))}</span>` },
      { key: '_d', label: tx('admin.security.render.detail'), sort: false, render: (r) => (r.detail ? `<details><summary>${te('admin.security.render.details')}</summary><pre>${esc(JSON.stringify(r.detail, null, 1))}</pre></details>` : '') }] });
  const form = el.querySelector('[data-f]');
  const load = async () => {
    const p = new URLSearchParams(Object.entries(Object.fromEntries(new FormData(form))).filter(([, v]) => v));
    const r = await get(`/security/events?limit=500&${p}`);
    el.querySelector('[data-total]').textContent = tx('admin.security.render.matching_event', { total: r.total, value: r.total === 1 ? '' : 's', value_2: r.total > 500 ? (' ' + tx('admin.security.render.showing_newest_500')) : '' });
    el.querySelector('[data-testid=security-counts]').innerHTML = KINDS.map((k) => `<div class="adm-tile" data-kind="${k}"><span>${esc(k.replace(/_/g, ' '))} · 24 h</span><b data-testid="count-${k}">${Number(r.counts_24h[k] || 0).toLocaleString('en-US')}</b></div>`).join('');
    t.setRows(r.events);
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); load().catch((ex) => toast(ex.message, 'error')); });
  await load();
}
