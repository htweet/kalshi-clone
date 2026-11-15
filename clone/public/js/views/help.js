// Help Center (owner request 2026-11-15, CLONE_SPEC.md §40).
//   /help, /support/help-center   home: search, topics with their guides, contact; ?q= searches, ?topic= lists one topic
//   /help/:slug                   a step-by-step guide: breadcrumb, the topic's guides, numbered steps and screenshots,
//                                 "Was this helpful?" (stored per member, or per browser for visitors), related guides
// Guides are CMS pages (Admin › Content › Pages, `help/<slug>`); labels here are text-catalog keys (help.*).
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/help-strings.js';
import { request } from '../api.js';
import { session } from '../store.js';
import { esc, toast } from '../lib.js';
import { inPreview } from '../content-live.js';
import { renderHelpText } from './admin/site.js';
import { setMeta } from './placeholder.js';

const ICONS = { // static SVG markup, one per topic
  'getting-started': '<path d="M4 15l4-4 3 3 5-7" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  trading: '<path d="M3 14l4-5 3 3 6-8M13 4h3v3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  money: '<rect x="2.5" y="5" width="15" height="10" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="10" cy="10" r="2.2" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  'account-security': '<path d="M10 2.5l6 2.5v4.5c0 4-2.6 6.8-6 8-3.4-1.2-6-4-6-8V5z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
  features: '<path d="M10 2.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 7.8l5-.7z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
  troubleshooting: '<path d="M12.5 3a4 4 0 00-4.8 5.3L3 13v4h4l4.7-4.7A4 4 0 0017 7.5l-2.5 1-2-2z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
  more: '<circle cx="5" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="15" cy="10" r="1.5" fill="currentColor"/>',
};
// static SVG markup from the ICONS table above
const icon = (k) => `<span class="help-ic" aria-hidden="true"><svg viewBox="0 0 20 20" width="20" height="20">${ICONS[k] || ICONS.more}</svg></span>`;
const topicTitle = (k) => t(`help.category.${k}.title`);
const topicText = (k) => t(`help.category.${k}.description`);
const pv = () => (inPreview() ? 'preview=1' : '');
const qs = (...parts) => { const s = parts.filter(Boolean).join('&'); return s ? `?${s}` : ''; };

// Visitors vote with a random token kept in this browser (the server stores only its hash; members vote as themselves).
function voterToken() {
  try {
    let v = localStorage.getItem('help_voter');
    if (!v || !/^[A-Za-z0-9_-]{16,64}$/.test(v)) { v = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('help_voter', v); }
    return v;
  } catch { return null; }
}

const searchForm = (q = '', big = false) => `<form class="help-search${big ? ' big' : ''}" role="search" data-testid="help-search" action="/help">
  <label class="sr-only" for="help-q">${te('help.search.label')}</label>
  <input id="help-q" name="q" type="search" value="${esc(q)}" placeholder="${te('help.search.placeholder')}" autocomplete="off" maxlength="100" data-testid="help-search-input">
  <button class="btn btn-primary" type="submit" data-testid="help-search-submit">${te('help.search.submit')}</button></form>`;
const contactCard = () => `<aside class="card help-contact" data-testid="help-contact"><h2>${te('help.contact.title')}</h2><p class="muted">${te('help.contact.body')}</p>
  <div class="help-contact-links"><a class="btn btn-primary" href="/support/contact" data-link>${te('help.contact.contact_support')}</a><a class="btn" href="/support/faq" data-link>${te('help.contact.faq')}</a><a class="btn" href="/status" data-link>${te('help.contact.status')}</a></div></aside>`;
const guideLink = (g) => `<li><a href="/help/${esc(g.slug)}" data-link data-testid="help-guide-link" data-slug="${esc(g.slug)}"><span class="help-guide-title">${esc(g.title)}</span>${g.summary ? `<span class="help-guide-sum muted">${esc(g.summary)}</span>` : ''}</a></li>`;

function wireSearch(el, navigate) {
  const f = el.querySelector('[data-testid=help-search]');
  if (!f) return;
  f.addEventListener('submit', (e) => { e.preventDefault(); const q = f.q.value.trim(); navigate(`/help${qs(q ? `q=${encodeURIComponent(q)}` : '', pv())}`); });
}

// ------------------------------------------------------------------ home
export async function renderHome({ el, query, navigate }) {
  const q = String(query?.get?.('q') || '').trim();
  const topic = String(query?.get?.('topic') || '');
  const [list, intro, found] = await Promise.all([
    request('GET', `/v1/help${qs(pv())}`),
    request('GET', `/v1/pages/support/help-center${qs(pv())}`).then((r) => r.page).catch(() => null),
    q ? request('GET', `/v1/help/search${qs(`q=${encodeURIComponent(q)}`, pv())}`) : null,
  ]);
  const byTopic = new Map(list.categories.map((c) => [c, list.pages.filter((p) => p.category === c)]));
  setMeta(intro?.seo_title || t('help.home.doc_title'), intro?.seo_description || t('help.home.description'));
  let main;
  if (found) {
    main = `<section class="help-results" data-testid="help-results" aria-live="polite"><h2>${te('help.search.results_for', { query: esc(q) })}</h2>
      ${found.results.length ? `<ul class="help-guides">${found.results.map((g) => guideLink({ ...g, summary: g.snippet })).join('')}</ul>` : `<p class="muted" data-testid="help-no-results">${te('help.search.no_results')}</p>`}
      <p><a href="/help${qs(pv())}" data-link class="c-brand">${te('help.search.all_topics')}</a></p></section>`;
  } else if (topic && byTopic.has(topic)) {
    main = `<section class="help-topic-page" data-testid="help-topic-page" data-topic="${esc(topic)}"><h2>${icon(topic)}${esc(topicTitle(topic))}</h2><p class="muted">${esc(topicText(topic))}</p>
      <ul class="help-guides">${byTopic.get(topic).map(guideLink).join('')}</ul><p><a href="/help${qs(pv())}" data-link class="c-brand">${te('help.search.all_topics')}</a></p></section>`;
  } else {
    main = `<div class="help-topics" data-testid="help-topics">${list.categories.filter((c) => byTopic.get(c).length).map((c) => {
      const gs = byTopic.get(c);
      return `<section class="card help-topic" data-testid="help-topic" data-topic="${esc(c)}"><h2>${icon(c)}<a href="/help${qs(`topic=${c}`, pv())}" data-link>${esc(topicTitle(c))}</a></h2><p class="muted">${esc(topicText(c))}</p>
        <ul class="help-topic-list">${gs.slice(0, 5).map((g) => `<li><a href="/help/${esc(g.slug)}" data-link data-testid="help-guide-link" data-slug="${esc(g.slug)}">${esc(g.title)}</a></li>`).join('')}</ul>
        ${gs.length > 5 ? `<a class="help-more c-brand" href="/help${qs(`topic=${c}`, pv())}" data-link data-testid="help-topic-more">${te('help.home.see_all', { count: gs.length })}</a>` : ''}</section>`;
    }).join('')}</div>`;
  }
  el.innerHTML = `<div class="help-center" data-testid="help-center">
    <header class="help-hero"><h1 class="page-title">${te('help.home.title')}</h1>
      ${intro?.body ? `<div class="help-intro muted" data-testid="help-intro">${intro.body /* eslint-disable-line parlance/no-unescaped-html -- CMS page body, sanitised by the server allowlist (server/cms/sanitize.js) */}</div>` : ''}
      ${searchForm(q, true)}</header>
    ${main}${contactCard()}</div>`;
  wireSearch(el, navigate);
}

// ------------------------------------------------------------------ one guide
function feedbackHtml(p) {
  const v = p.your_vote;
  return `<section class="help-feedback" data-testid="help-feedback" data-vote="${esc(v || '')}"><h2 id="hf-q">${te('help.feedback.question')}</h2>
    <div class="help-feedback-btns" role="group" aria-labelledby="hf-q"><button class="btn${v === 'yes' ? ' on' : ''}" type="button" data-vote="yes" aria-pressed="${v === 'yes'}" data-testid="help-yes">${te('help.feedback.yes')}</button><button class="btn${v === 'no' ? ' on' : ''}" type="button" data-vote="no" aria-pressed="${v === 'no'}" data-testid="help-no">${te('help.feedback.no')}</button></div>
    <form class="help-feedback-more" data-testid="help-feedback-form" hidden><label class="field"><span>${te('help.feedback.what_was_missing')}</span><textarea name="comment" rows="3" maxlength="500" data-testid="help-feedback-comment"></textarea></label>
      <button class="btn btn-primary" type="submit" data-testid="help-feedback-send">${te('help.feedback.send')}</button></form>
    <p class="help-thanks" data-testid="help-thanks" role="status">${v ? te('help.feedback.thanks') : ''}</p></section>`;
}
function wireFeedback(el, slug) {
  const box = el.querySelector('[data-testid=help-feedback]');
  const form = box.querySelector('form'); const thanks = box.querySelector('[data-testid=help-thanks]');
  const send = async (helpful, comment) => {
    const body = { helpful };
    if (comment !== undefined) body.comment = comment;
    if (!session.user) body.voter = voterToken();
    await request('POST', `/v1/help/${encodeURIComponent(slug)}/feedback`, body);
  };
  for (const b of box.querySelectorAll('[data-vote]')) {
    if (b.tagName !== 'BUTTON') continue;
    b.onclick = async () => {
      const yes = b.dataset.vote === 'yes';
      try {
        await send(yes);
        box.dataset.vote = b.dataset.vote;
        for (const x of box.querySelectorAll('button[data-vote]')) { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }
        thanks.textContent = t(yes ? 'help.feedback.thanks' : 'help.feedback.thanks_tell_more');
        form.hidden = yes;
        if (!yes) form.comment.focus();
      } catch (ex) { toast(ex.message, 'error'); }
    };
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await send(false, form.comment.value.trim()); form.hidden = true; thanks.textContent = t('help.feedback.thanks'); } catch (ex) { toast(ex.message, 'error'); }
  };
}

export async function renderGuide({ el, params, navigate }) {
  let r;
  const voter = session.user ? '' : (() => { try { const v = localStorage.getItem('help_voter'); return v ? `voter=${encodeURIComponent(v)}` : ''; } catch { return ''; } })();
  try { r = await request('GET', `/v1/help/${encodeURIComponent(params.slug)}${qs(voter, pv())}`); } catch (e) {
    if (e.notFound) {
      el.innerHTML = `<div class="help-center"><div class="card empty center-50" data-testid="help-missing"><h1 class="typ-title-x10 m-0">${te('help.guide.not_found')}</h1><p class="muted">${te('help.guide.not_found_body')}</p>${searchForm('', true)}<a class="btn" href="/help" data-link>${te('help.guide.back_home')}</a></div></div>`;
      document.title = t('help.home.doc_title');
      wireSearch(el, navigate);
      return;
    }
    throw e;
  }
  const p = r.page;
  let siblings = [];
  try { siblings = (await request('GET', `/v1/help${qs(pv())}`)).pages.filter((g) => g.category === p.category); } catch { /* optional */ }
  setMeta(t('help.guide.doc_title', { title: p.title }), p.summary);
  const body = p.format === 'html' ? p.html : renderHelpText(p.body); // CMS guide: sanitised by the server allowlist (CLONE_SPEC.md §40)
  el.innerHTML = `<div class="help-center help-guide-page">
    <nav class="help-crumbs" aria-label="${te('help.guide.breadcrumb')}" data-testid="help-crumbs"><a href="/help" data-link>${te('help.home.title')}</a><span aria-hidden="true">›</span><a href="/help?topic=${esc(p.category)}" data-link>${esc(topicTitle(p.category))}</a></nav>
    <div class="help-layout">
      <nav class="help-nav card" aria-label="${te('help.guide.topic_guides', { topic: esc(topicTitle(p.category)) })}" data-testid="help-nav"><h2>${esc(topicTitle(p.category))}</h2>${siblings.map((g) => `<a href="/help/${esc(g.slug)}" data-link class="${g.slug === p.slug ? 'on' : ''}"${g.slug === p.slug ? ' aria-current="page"' : ''}>${esc(g.title)}</a>`).join('')}</nav>
      <div class="help-main">
        <article class="card help-page" data-testid="help-page" data-slug="${esc(p.slug)}"><h1 class="typ-title-x10">${esc(p.title)}</h1>${p.summary ? `<p class="help-lead muted" data-testid="help-summary">${esc(p.summary)}</p>` : ''}
          <div class="help-body" data-testid="help-body">${body /* eslint-disable-line parlance/no-unescaped-html -- CMS help guide sanitised by the server allowlist (server/cms/sanitize.js), or the §18.5 renderer that escapes */}</div>${feedbackHtml(p)}</article>
        ${p.related?.length ? `<section class="card help-related" data-testid="help-related"><h2>${te('help.guide.related')}</h2><ul class="help-guides">${p.related.map(guideLink).join('')}</ul></section>` : ''}
        ${searchForm('')}${contactCard()}
      </div>
    </div></div>`;
  wireFeedback(el, p.slug);
  wireSearch(el, navigate);
}

export const render = (ctx) => (ctx.params?.slug ? renderGuide(ctx) : renderHome(ctx));
