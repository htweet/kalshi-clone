// Public-site side of the CMS: site config (banners, category navigation, feature switches), help pages,
// event news items and the "report" menu on social posts / replies. Loaded by main.js for every visitor.
import { t as tx, te, ts } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.site-strings.js';
import { request } from '../../api.js';
import { session } from '../../store.js';
import { esc, toast } from '../../lib.js';
import { setCurrency, fmtDate, fmtDay } from '../../currency.js';

const DEFAULT_NAV = { categories: null, featured: { label: ts('admin.site.default_nav_featured_label.harbor_2026'), href: '/category/elections', color: '' } };
export const site = { banners: [], nav: DEFAULT_NAV, features: { social: true, perps: true, combos: true }, loaded: false };

export async function loadSite() {
  try {
    const r = await request('GET', '/v1/site_config');
    site.banners = r.banners || []; site.nav = r.nav || DEFAULT_NAV; site.features = r.features || site.features;
    setCurrency(r.display_currency); // display currency, locale, time zone (CLONE_SPEC.md §30)
  } catch { /* keep defaults */ }
  site.loaded = true;
  applyFeatures();
  renderBanners();
  window.dispatchEvent(new CustomEvent('parlance:site-loaded'));
}
// Feature switches hide entry points (CSS in admin.css keys off these attributes); routes are gated by featureGate().
function applyFeatures() {
  const d = document.documentElement.dataset;
  for (const k of ['social', 'perps', 'combos']) d[`feat${k[0].toUpperCase()}${k.slice(1)}`] = site.features[k] === false ? 'off' : 'on';
}
const GATES = [['social', /^\/social(\/|$)/, 'Social'], ['perps', /^\/(perps|portfolio\/perps)(\/|$)/, ts('admin.site.gates.perps')], ['combos', /^\/combos$/, 'Combos']];
export function featureGate(pathname) {
  const g = GATES.find(([k, re]) => site.features[k] === false && re.test(pathname));
  return g ? `<div class="card empty center-40" role="status" data-testid="feature-off"><h1 class="typ-title-x20 m-0">${te('admin.site.feature_gate.is_unavailable_right_now', { value: esc(g[2]) })}</h1><p class="muted m-0">${te('admin.site.feature_gate.this_part_of_parlance_is')}</p><div><a class="btn" href="/" data-link>${te('admin.site.feature_gate.go_home')}</a></div></div>` : null;
}

export function renderBanners() {
  document.querySelectorAll('.site-banner').forEach((b) => b.remove());
  const pick = (pos) => site.banners.find((b) => b.position === pos);
  const html = (b) => `<div class="site-banner ${esc(b.position)}" role="region" aria-label="${te('admin.site.render_banners.announcement')}" data-testid="site-banner" data-position="${esc(b.position)}"><div class="container">${b.link ? `<a href="${esc(b.link)}" ${b.link.startsWith('/') ? 'data-link' : 'target="_blank" rel="noopener"'}>${esc(b.content)} <span aria-hidden="true">›</span></a>` : `<span>${esc(b.content)}</span>`}</div></div>`;
  const top = pick('top'); const bottom = pick('bottom');
  if (top) document.querySelector('header.topbar')?.insertAdjacentHTML('afterend', html(top));
  if (bottom) document.querySelector('footer.footer')?.insertAdjacentHTML('beforebegin', html(bottom));
}
// Banner visibility depends on signed-in state: refetch when the user changes.
let lastUid;
session.subscribe(() => { if (!session.loaded) return; const uid = session.uid || null; if (uid !== lastUid) { const first = lastUid === undefined; lastUid = uid; if (!first) loadSite(); } });
window.addEventListener('parlance:site-config', () => loadSite());

// ---------------------------------------------------------------- help pages (/help/:slug)
function inline(s) {
  // s is already escaped; allow **bold** and [text](/path or https://…)
  return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:\/(?!\/)|https:\/\/)[^\s)]*)\)/g, (m, t, href) => `<a href="${href}" ${href.startsWith('/') ? 'data-link' : 'target="_blank" rel="noopener"'}>${t}</a>`); // eslint-disable-line parlance/no-unescaped-html -- s is esc()'d by the caller before this substitution, and the pattern only accepts site paths or https:// URLs without spaces or quotes
}
export function renderHelpText(text) {
  const out = []; let list = null; let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } if (list) { out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`); list = null; } };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = esc(raw.trim());
    if (!line) { flush(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flush(); const lvl = h[1].length + 1; out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } (list ||= []).push(li[1]); continue; }
    if (list) flush();
    para.push(line);
  }
  flush();
  return out.join('');
}
export const helpView = {
  async render({ el, params }) {
    let r;
    try { r = await request('GET', `/v1/help/${encodeURIComponent(params.slug)}`); } catch (e) {
      if (e.notFound) { el.innerHTML = `<div class="empty center-50" data-testid="help-missing"><h1 class="typ-title-x10 m-0">${te('admin.site.help_view_render.help_page_not_found')}</h1><a class="btn" href="/" data-link>${te('admin.site.help_view_render.go_home')}</a></div>`; document.title = tx('admin.site.help_view_render.help_parlance'); return; }
      throw e;
    }
    let pages = [];
    try { pages = (await request('GET', '/v1/help')).pages; } catch { /* optional */ }
    document.title = tx('admin.site.help_view_render.help_parlance_2', { title: r.page.title });
    el.innerHTML = `<div class="help-layout"><nav class="help-nav card" aria-label="${te('admin.site.help_view_render.help_pages')}"><h2>${te('admin.site.help_view_render.help')}</h2>${pages.map((p) => `<a href="/help/${esc(p.slug)}" data-link class="${p.slug === r.page.slug ? 'on' : ''}">${esc(p.title)}</a>`).join('')}</nav>
      <article class="card help-page" data-testid="help-page"><h1 class="typ-title-x10">${esc(r.page.title)}</h1><div class="help-body" data-testid="help-body">${r.page.format === 'html' ? r.page.html /* eslint-disable-line parlance/no-unescaped-html -- CMS help page (CLONE_SPEC.md §32.7), sanitised by the server allowlist */ : renderHelpText(r.page.body)}</div><p class="faint">${te('admin.site.help_view_render.updated', { fmt_date: fmtDate(r.page.updated_time) })}</p></article></div>`;
  },
};

// ---------------------------------------------------------------- event news items
export function newsItemsHtml(ev) {
  return (ev.news_items || []).map((n) => `<div class="news-item" data-testid="news-item" id="news-${esc(n.id)}" data-news-id="${esc(n.id)}"><div class="src"><span class="news-src">${esc(n.source.toUpperCase())}</span> · ${esc(fmtDay(n.published_time))}</div><b>${esc(n.headline)}</b>${n.summary ? `<span class="muted">${esc(n.summary)}</span>` : ''}</div>`).join('');
}

// ---------------------------------------------------------------- report menu on posts / replies
let menu = null;
const closeMenu = () => { menu?.remove(); menu = null; };
export function reportDialog(kind, id) { // also used by the post ⋯ menu (views/social2.js)
  const d = document.createElement('dialog');
  d.className = 'adm-dialog';
  d.dataset.testid = 'report-dialog';
  d.innerHTML = `<form method="dialog" class="adm-confirm"><h3>${te('admin.site.report_dialog.report', { value: kind === 'post' ? 'post' : te('admin.site.report_dialog.reply') })}</h3><p class="muted">${te('admin.site.report_dialog.our_moderators_review_every_report')}</p>
    <fieldset class="adm-choice"><legend>${te('admin.site.report_dialog.what_s_wrong')}</legend>${[tx('admin.site.report_dialog.spam_or_scam'), tx('admin.site.report_dialog.harassment_or_hate'), tx('admin.site.report_dialog.misleading_market_information'), tx('admin.site.report_dialog.other')].map((r, i) => `<label><input type="radio" name="why" value="${esc(r)}" ${i ? '' : 'checked'}> ${esc(r)}</label>`).join('')}</fieldset>
    <label class="field"><span>${te('admin.site.report_dialog.details_optional')}</span><textarea name="details" rows="2" maxlength="250" data-testid="report-details"></textarea></label>
    <div class="adm-form-actions"><button class="btn" type="button" data-cancel>${te('admin.site.report_dialog.cancel')}</button><button class="btn btn-primary" type="submit" data-testid="report-submit">${te('admin.site.report_dialog.send_report')}</button></div></form>`;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.querySelector('[data-cancel]').onclick = () => d.close();
  d.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const reason = [f.why.value, f.details.value.trim()].filter(Boolean).join(': ');
    try { await request('POST', `/v1/users/${encodeURIComponent(session.uid)}/social/reports`, { kind, id, reason }); toast(tx('admin.site.report_dialog.thanks_your_report_was_sent')); d.close(); } catch (ex) { toast(ex.message, 'error'); }
  });
  d.showModal();
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-post-menu],[data-report-comment]');
  if (!btn) { if (menu && !e.target.closest('.post-menu')) closeMenu(); return; }
  e.preventDefault(); e.stopPropagation();
  if (btn.dataset.reportComment) {
    if (!session.user) { location.assign(`/sign-in?next=${encodeURIComponent(location.pathname)}`); return; }
    reportDialog('comment', btn.dataset.reportComment); return;
  }
  if (menu && menu.dataset.for === btn.dataset.postMenu) { closeMenu(); return; }
  closeMenu();
  menu = document.createElement('div');
  menu.className = 'menu post-menu';
  menu.dataset.for = btn.dataset.postMenu;
  menu.innerHTML = session.user ? `<button data-report-post data-testid="report-post">${te('admin.site.common.report_post')}</button>` : `<a href="/sign-in?next=${encodeURIComponent(location.pathname)}" data-link>${te('admin.site.common.log_in_to_report')}</a>`;
  btn.parentElement.style.position = 'relative';
  btn.insertAdjacentElement('afterend', menu);
  menu.querySelector('[data-report-post]')?.addEventListener('click', (ev) => { ev.stopPropagation(); const id = menu.dataset.for; closeMenu(); reportDialog('post', id); });
}, true);
