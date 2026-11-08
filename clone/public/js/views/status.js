// Status page (/status; CLONE_SPEC.md §35.10): the API, WebSocket, FIX, demo environment and website, from live state
// on the server, and the incidents staff publish through the CMS (GET /v1/status, polled every 30 s).
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/status-strings.js';
import { request } from '../api.js';
import { esc, fmtDateTime } from '../lib.js';

function html(s) {
  const comp = new Map(s.components.map((c) => [c.id, c.name]));
  return `<div class="status-page" data-testid="status-page"><div class="status-head"><h1 class="page-title">${te('status.page.title')}</h1><a href="/docs" data-link>${te('status.page.docs')}</a></div>
    <div class="card status-overall" data-testid="status-overall" data-status="${esc(s.status)}"><span class="status-dot s-${esc(s.status)}"></span><strong>${esc(t(`status.overall.${s.status}`))}</strong><span class="faint">${esc(t('status.page.updated', { time: fmtDateTime(s.updated_time) }))}</span></div>
    <ul class="card status-components">${s.components.map((c) => `<li data-testid="status-component" data-component="${esc(c.id)}" data-status="${esc(c.status)}"><span>${esc(c.name)}</span><span class="status-state"><span class="status-dot s-${esc(c.status)}"></span>${esc(t(`status.component.${c.status}`))}${c.port ? ` <span class="faint">${esc(t('status.component.port', { port: c.port }))}</span>` : ''}</span></li>`).join('')}</ul>
    <h2>${te('status.incidents.title')}</h2>${s.incidents.length ? s.incidents.map((i) => `<article class="card status-incident" data-testid="status-incident" data-incident="${esc(i.id)}" data-status="${esc(i.status)}"><h3>${esc(i.title)}</h3>
      <p><span class="dev-chip">${esc(t(`status.incident.status.${i.status}`))}</span> <span class="dev-chip">${esc(t(`status.incident.impact.${i.impact}`))}</span></p>${i.body ? `<p>${esc(i.body)}</p>` : ''}
      <p class="faint">${esc(t('status.incident.affects', { components: i.components.map((x) => comp.get(x) || x).join(', ') }))} · ${esc(t('status.incident.started', { time: fmtDateTime(i.started_time) }))}${i.resolved_time ? ` · ${esc(t('status.incident.resolved', { time: fmtDateTime(i.resolved_time) }))}` : ''}</p></article>`).join('') : `<p class="muted" data-testid="status-no-incidents">${te('status.incidents.empty')}</p>`}</div>`;
}

export async function render({ el }) {
  document.title = t('status.page.doc_title');
  const draw = async () => {
    try { el.innerHTML = html(await request('GET', '/v1/status')); } catch (e) {
      el.innerHTML = `<div class="card empty center-40" data-testid="status-unavailable"><p>${te('status.unavailable')}</p></div>`;
      if (e.code !== 'feature_disabled') throw e;
    }
  };
  await draw();
  const iv = setInterval(() => { draw().catch(() => {}); }, 30000);
  return () => clearInterval(iv);
}
