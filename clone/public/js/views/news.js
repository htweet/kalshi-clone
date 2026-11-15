// Public side of content operations (CLONE_SPEC.md §41): the event page's news list (approved publisher items carry a
// link to the publisher's article and its name), the category news strip on category pages, and the market's published
// description, background and resolution notes. Everything shown is plain text from the server, escaped here; links
// open the publisher's site (https / http only) with noopener and no referrer.
import { te, t as tx } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/news-strings.js';
import { request } from '../api.js';
import { socket } from '../ws.js';
import { esc, fmtDay, eventHref } from '../lib.js';

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const ext = (url, inner, cls = 'news-link', testid = '') => `<a class="${esc(cls)}" href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow" ${testid ? `data-testid="${esc(testid)}"` : ''}>${inner /* eslint-disable-line parlance/no-unescaped-html -- inner is markup built by the callers below from esc()'d parts */}</a>`;

// Event page: CMS news items (server/admin.js decorateEvent): manual items and approved publisher items.
export function newsListHtml(ev) {
  return (ev.news_items || []).map((n) => {
    const url = safeUrl(n.url);
    const head = `<b>${esc(n.headline)}</b>`;
    return `<div class="news-item" data-testid="news-item" id="news-${esc(n.id)}" data-news-id="${esc(n.id)}"><div class="src"><span class="news-src">${esc(String(n.source || '').toUpperCase())}</span> · ${esc(fmtDay(n.published_time))}</div>${url ? ext(url, head, 'news-link', 'news-item-link') : head}${n.summary ? `<span class="muted">${esc(n.summary)}</span>` : ''}${url ? `<div class="news-attr">${ext(url, `${te('news.item.read_at', { publisher: esc(n.source) })} <span class="sr-only">${te('news.item.opens_new_tab')}</span>`, '', 'news-item-source')}</div>` : ''}</div>`;
  }).join('');
}

// Category page: the latest approved items of the category (hidden when there are none).
export async function mountCategoryNews(box, category) {
  if (!box) return;
  let r;
  try { r = await request('GET', `/v1/news?category=${encodeURIComponent(category)}&limit=6`); } catch { return; }
  if (!box.isConnected || !r.items || !r.items.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="news-strip-head"><h2>${te('news.strip.title')}</h2><span class="faint">${te('news.strip.note')}</span></div><div class="news-strip-grid">${r.items.map((n) => {
    const url = safeUrl(n.url);
    const head = esc(n.headline);
    return `<article class="card news-card" data-testid="category-news-item" data-news-id="${esc(n.id)}"><div class="src">${esc(String(n.publisher).toUpperCase())} · ${esc(fmtDay(n.published_time))}</div>${url ? ext(url, head) : `<b>${head}</b>`}${n.excerpt ? `<p>${esc(n.excerpt)}</p>` : ''}${n.events.length ? `<div class="faint">${te('news.strip.events')} ${n.events.map((e) => `<a href="${esc(eventHref(e))}" data-link>${esc(e.title)}</a>`).join(', ')}</div>` : ''}</article>`;
  }).join('')}</div>`;
}

const paras = (s) => String(s || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p.split('\n').map(esc).join('<br>')}</p>`).join('');
// Event page: the market's published description, background and resolution notes (live on publish / restore).
export function mountMarketContent(box, ev) {
  if (!box) return () => {};
  let gone = false;
  const draw = async () => {
    let r;
    try { r = await request('GET', `/v1/events/${encodeURIComponent(ev.event_ticker)}/content`); } catch { return; }
    if (gone || !box.isConnected) return;
    const c = r.content;
    if (!c) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<section class="card mc-about" data-testid="market-content" data-version="${esc(c.version)}"><h2>${te('news.about.title')}</h2>
      <div data-testid="market-content-description">${paras(c.description)}</div>
      ${c.background ? `<h3>${te('news.about.background')}</h3><div data-testid="market-content-background">${paras(c.background)}</div>` : ''}
      ${c.resolution_notes ? `<h3>${te('news.about.resolution')}</h3><div data-testid="market-content-resolution">${paras(c.resolution_notes)}</div>` : ''}
      <div class="faint mc-meta">${esc(tx('news.about.meta', { date: fmtDay(c.updated_time) }))}</div></section>`;
  };
  draw();
  const unsub = socket.subscribe({ channels: ['event_content'], event_tickers: [ev.event_ticker] }, (m) => { if (m.type === 'event_content' && m.msg.kind === 'market_content') draw(); });
  return () => { gone = true; unsub(); };
}
