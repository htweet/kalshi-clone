// Content pages and placeholders for ☰ menu destinations (CLONE_SPEC §13.16–§13.18; CLONE_SPEC.md §25.7, §32.7).
// /legal/:slug, /trust/:slug, /research/:slug and /support/:slug show the CMS page `<group>/<slug>` (Admin › Content ›
// Pages; sanitised rich text, SEO title and description). A destination without a page says plainly what it is and
// when it arrives, instead of a dead link or a 404.
import { t, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/placeholder-strings.js';
import { esc } from '../lib.js';
import { GROUPS } from './account-menu.js';
import { inPreview } from '../content-live.js';
import { refreshClientToken } from '../security.js';

const PAGES = {
  incentives: [ts('placeholder.pages_incentives.liquidity_rewards'), ts('placeholder.pages_incentives.the_liquidity_incentive_program_reward')],
  docs: [ts('placeholder.pages_docs.api_docs'), ts('placeholder.pages_docs.the_developer_portal_rest_websocket')],
};

// The page's SEO fields go to document.title and the description meta (the server sets both on a direct load too).
export function setMeta(title, description) {
  document.title = title;
  const m = document.querySelector('meta[name="description"]');
  if (m && description) m.setAttribute('content', description);
}

export async function fetchPage(slug) {
  const ct = await refreshClientToken();
  const r = await fetch(`/v1/pages/${slug.split('/').map(encodeURIComponent).join('/')}${inPreview() ? '?preview=1' : ''}`, { credentials: 'same-origin', headers: { Accept: 'application/json', ...(ct ? { 'X-Client-Token': ct } : {}) } });
  return r.ok ? (await r.json()).page : null;
}
export function pageHtml(p) {
  // eslint-disable-next-line parlance/no-unescaped-html -- p.body is sanitised by the server's allowlist (server/cms/sanitize.js 'page': headings, paragraphs, lists, bold, italic, quotes, safe links) when saved and again when served
  return `<article class="card cms-page" data-testid="cms-page" data-page="${esc(p.slug)}"><h1 class="page-title">${esc(p.title)}</h1><div class="cms-body" data-testid="cms-page-body">${p.body}</div></article>`;
}

export async function render({ el, params }) {
  if (params.group) {
    const p = await fetchPage(`${params.group}/${params.slug}`).catch(() => null);
    if (p && p.body) {
      el.innerHTML = pageHtml(p);
      setMeta(p.seo_title || t('placeholder.render.parlance', { title: p.title }), p.seo_description);
      return;
    }
  }
  let title; let text;
  if (params.group) {
    const g = GROUPS.find(([k]) => k === params.group);
    const item = g && g[2].find(([s]) => s === params.slug);
    title = item ? `${g[1]} · ${item[1]}` : t('placeholder.render.page');
    text = t('placeholder.render.help_centre_and_company_pages');
  } else {
    [title, text] = PAGES[params.slug] || [t('placeholder.render.page'), t('placeholder.render.this_page_is_not_available')];
  }
  document.title = t('placeholder.render.parlance', { title });
  el.innerHTML = `<div class="card empty center-60" data-testid="placeholder-page" data-page="${esc(params.group ? `${params.group}/${params.slug}` : params.slug)}">
    <h1 class="typ-title-x20">${esc(title)}</h1><p class="muted">${esc(text)}</p><div class="d-flex gap-8 jc-center"><a class="btn" href="/" data-link>${te('placeholder.render.go_home')}</a></div></div>`;
}
