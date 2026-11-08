'use strict';
// Public pages for search and social (PLAN P8.3, CLONE_SPEC.md §38.4). Flags `ssr` (server rendering, share cards,
// sitemaps) and `ssr.crawlers` (search and link-preview crawlers skip the browser check on public pages).
//
//   server rendering  public routes (home, all markets, categories, event pages, elections hubs, the rates hub, the API
//                     docs, the status page, CMS pages and help articles) get their content in the page template's <main>
//                     and full metadata in <head>; the SPA renders over it once loaded. Private routes (account, portfolio,
//                     admin, funds…) get `noindex` and no content.
//   cache             the rendered fragment is cached per path (no query except an enabled ?lang), language, display
//                     currency and canonical origin, for the owner setting `ssr.cache_seconds` (60 s). It is built only from
//                     public data and never reads the session, cookies or headers other than the path: no cookie is ever
//                     part of the key, so one visitor can never be served another's page (cache-poisoning tests in the
//                     reach suite). The page response itself stays `no-store` (it carries a per-response CSP nonce).
//   metadata          title, description, canonical URL (the configured public origin), hreflang for every enabled
//                     language plus x-default, Open Graph and X card tags, JSON-LD (Organization + WebSite on home,
//                     BreadcrumbList on event pages).
//   share cards       /og/site.png, /og/event/<TICKER>.png, /og/hub/<slug>.png, /og/share/<token>.png: 1200 × 630 PNG drawn
//                     in pure JavaScript (server/og-image.js) with the CMS brand colours; cached in memory for the
//                     same TTL.
//   search engines    /sitemap.xml (an index) → /sitemaps/{pages,categories,markets,hubs}.xml with <lastmod>; robots.txt
//                     gains a Sitemap line while the flag is on. AI crawlers stay refused (robots.txt, the bot challenge).
//   old hub           GET /hubs/elections answers 301 to the Nigeria elections hub (owner decision 2026-11-08: the Phase 5B
//                     hub is removed, CLONE_SPEC.md §29.8).
const crypto = require('node:crypto');
const C = require('./currency');
const { renderCard } = require('./og-image');
const { esc, sanitize } = require('./cms/sanitize');
const { s: GS } = require('./content/growth');
const catalog = require('./content/catalog');
const { CATEGORIES } = require('./features');

const COMBO_SERIES = 'PLXCOMBO';
// Search and link-preview crawlers (they render share cards and index public pages). AI training / answer crawlers are not
// in this list: they stay behind the challenge and robots.txt (server/bot.js AI_CRAWLERS).
const CRAWLER_UA = /(googlebot|bingbot|duckduckbot|yandex(bot)?|baiduspider|slurp|applebot(?!-extended)|facebookexternalhit|facebot|twitterbot|whatsapp|telegrambot|linkedinbot|slackbot|discordbot|pinterest|redditbot)/i;
const AI_UA = /(gptbot|chatgpt|oai-searchbot|claudebot|claude-web|anthropic-ai|ccbot|google-extended|perplexitybot|bytespider|amazonbot|applebot-extended|meta-externalagent|cohere-ai|diffbot)/i;
const PRIVATE = /^\/(admin|account|portfolio|funds|notifications|messages|watchlist|sign-up\/identity|verify|dev|setup|rewards|waitlist\/(confirm|unsubscribe|manage))(\/|$)/;
const PAGE_ROUTE = /^\/(legal|trust|research|support)\/([a-z0-9-]+)$/;

function mountSeo({ app, db, engine, flags, security, cms, i18n, eventFull, options = {} }) {
  const OS = engine.ownerSettings;
  const norm = (o) => { try { const u = new URL(o); return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.host}`.toLowerCase() : null; } catch { return null; } };
  const configured = norm(options.publicOrigin || process.env.PUBLIC_ORIGIN || String(process.env.ALLOWED_ORIGINS || '').split(',')[0].trim());
  // Canonical origin: the configured public origin; on development servers without one, the request's own (validated)
  // origin — which is part of the cache key, so a forged Host header only ever sees its own entry.
  const originOf = (req) => configured || (security && security.selfOrigin ? security.selfOrigin(req) : null) || 'http://localhost';
  const ttl = () => OS.get('ssr.cache_seconds') * 1000;
  const cache = new Map();
  const cacheGet = (k) => { const v = cache.get(k); if (!v) return null; if (Date.now() - v.ts > ttl()) { cache.delete(k); return null; } return v; };
  const cacheSet = (k, v) => { if (!ttl()) return; if (cache.size > 2000) cache.delete(cache.keys().next().value); cache.set(k, { ...v, ts: Date.now() }); };
  const stats = { hits: 0, misses: 0 };
  engine.on('content', () => cache.clear());
  flags.listeners.push(() => cache.clear());

  const brand = () => { try { return cms.brand(); } catch { return { app_name: 'Parlance', light: { brand: '#008751', yes: '#0b7285' }, dark: { brand: '#13a866', yes: '#22c3b5' } }; } };
  const pct = (d) => (d == null || d === '' ? null : Math.round(Number(d) * 100));
  const lead = (ev) => ev.markets.filter((m) => m.status === 'active').concat(ev.markets).reduce((a, m) => (a == null || Number(m.last_price_dollars || 0) > Number(a.last_price_dollars || 0) ? m : a), null);
  const eventHref = (ev) => `/markets/${encodeURIComponent(String(ev.series_ticker).toLowerCase())}/${encodeURIComponent(ev.series_slug || 'event')}/${encodeURIComponent(String(ev.event_ticker).toLowerCase())}`;
  const openEvents = () => db.prepare('SELECT * FROM events WHERE series_ticker<>? ORDER BY rowid').all(COMBO_SERIES).map(eventFull).filter((e) => e.markets.some((m) => m.status === 'active'));
  const byVolume = (evs) => evs.sort((a, b) => Number(b.total_volume_fp) - Number(a.total_volume_fp));
  const catSlug = (c) => String(c).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const catOf = (slug) => CATEGORIES.find((c) => catSlug(c) === String(slug).toLowerCase()) || null;
  // A list of events, server-rendered (escaped).
  const listHtml = (evs, heading, T = GS) => `<section class="ssr-list"><h2>${esc(heading)}</h2><ul>${evs.map((e) => {
    const m = lead(e);
    const ch = m ? pct(m.last_price_dollars) : null;
    return `<li><a href="${esc(eventHref(e))}">${esc(e.title)}</a>${m && m.yes_sub_title && e.markets.length > 1 ? ` <span>${esc(m.yes_sub_title)}</span>` : ''}${ch != null ? ` <b>${esc(T('seo.chance', { chance: `${ch}%` }))}</b>` : ''} <span>${esc(T('seo.volume', { amount: C.moneyCents(Math.round(e.dollar_volume * 100)) }))}</span></li>`;
  }).join('')}</ul></section>`;

  // ---------------------------------------------------------------- route → page model (public data only)
  // T: the server texts of the request's language (published translations of server.growth.*), else English.
  function model(path, T = GS) {
    const b = brand();
    const appName = b.app_name || 'Parlance';
    if (path === '/') {
      const evs = byVolume(openEvents()).slice(0, 12);
      return { title: T('seo.home.title'), description: T('seo.home.description'), og: '/og/site.png', type: 'website', body: `<h1>${esc(T('seo.home.title'))}</h1><p>${esc(T('seo.home.description'))}</p>${listHtml(evs, T('seo.markets_heading'), T)}`,
        ld: [{ '@context': 'https://schema.org', '@type': 'Organization', name: appName, url: '__ORIGIN__/', logo: '__ORIGIN__/icons/icon-512.png' }, { '@context': 'https://schema.org', '@type': 'WebSite', name: appName, url: '__ORIGIN__/', potentialAction: { '@type': 'SearchAction', target: '__ORIGIN__/search?q={search_term_string}', 'query-input': 'required name=search_term_string' } }] };
    }
    if (path === '/browse') {
      const evs = byVolume(openEvents()).slice(0, 40);
      return { title: T('seo.browse.title'), description: T('seo.browse.description'), og: '/og/site.png', type: 'website', body: `<h1>${esc(T('seo.browse.title'))}</h1>${listHtml(evs, T('seo.markets_heading'), T)}` };
    }
    let m = /^\/category\/([a-z0-9-]+)$/.exec(path);
    if (m && catOf(m[1])) {
      const c = catOf(m[1]);
      const evs = byVolume(openEvents().filter((e) => e.category === c)).slice(0, 40);
      return { title: T('seo.category.title', { category: c }), description: T('seo.category.description', { category: c }), og: '/og/site.png', type: 'website', body: `<h1>${esc(T('seo.category.title', { category: c }))}</h1>${listHtml(evs, T('seo.markets_heading'), T)}`,
        ld: [crumbs([[c, `/category/${catSlug(c)}`]])] };
    }
    m = /^\/category\/elections\/([a-z0-9][a-z0-9-]{2,40})$/.exec(path);
    if (m) {
      let el = null;
      try { el = db.prepare('SELECT * FROM el_elections WHERE slug=? AND active=1').get(m[1]); } catch { el = null; }
      if (el) {
        let evs = [];
        try { evs = db.prepare("SELECT DISTINCT e.* FROM events e JOIN markets mk ON mk.event_ticker=e.ticker WHERE mk.ticker IN (SELECT rm.market_ticker FROM el_race_markets rm JOIN el_races r ON r.id=rm.race_id WHERE r.election_id=? UNION SELECT market_ticker FROM el_office_markets WHERE election_id=?) LIMIT 60").all(el.id, el.id).map(eventFull); } catch { evs = []; }
        return { title: T('seo.hub.title', { name: el.title }), description: T('seo.hub.description', { name: el.title }), og: `/og/hub/${el.slug}.png`, type: 'website', body: `<h1>${esc(el.title)}</h1><p>${esc(T('seo.hub.description', { name: el.title }))}</p>${listHtml(byVolume(evs).slice(0, 30), T('seo.markets_heading'), T)}`,
          ld: [crumbs([[T('seo.elections_crumb'), '/category/elections'], [el.title, path]])] };
      }
      return null;
    }
    m = /^\/markets\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (m) {
      const e = db.prepare('SELECT * FROM events WHERE ticker=?').get(decodeURIComponent(m[3]).toUpperCase());
      if (!e || e.series_ticker === COMBO_SERIES) return null;
      const ev = eventFull(e);
      const ld = lead(ev); const ch = ld ? pct(ld.last_price_dollars) : null;
      const desc = ld ? T('seo.event.description', { market: ld.yes_sub_title || ev.title, chance: ch != null ? `${ch}%` : '—' }) : ev.sub_title || ev.title;
      const rows = ev.markets.map((mk) => `<li><b>${esc(mk.yes_sub_title || mk.title)}</b> ${pct(mk.last_price_dollars) != null ? esc(T('seo.chance', { chance: `${pct(mk.last_price_dollars)}%` })) : ''}</li>`).join('');
      return { title: `${ev.title} · ${b.app_name || 'Parlance'}`, description: desc, og: `/og/event/${ev.event_ticker}.png`, type: 'article', canonical: eventHref(ev),
        body: `<nav aria-label="breadcrumb"><a href="/category/${esc(catSlug(ev.category))}">${esc(ev.category)}</a> / ${esc(ev.series_title)}</nav><h1>${esc(ev.title)}</h1>${ev.sub_title ? `<p>${esc(ev.sub_title)}</p>` : ''}<ul>${rows}</ul><p>${esc(T('seo.volume', { amount: C.moneyCents(Math.round(ev.dollar_volume * 100)) }))}</p>`,
        ld: [crumbs([[ev.category, `/category/${catSlug(ev.category)}`], [ev.title, eventHref(ev)]])] };
    }
    if (path === '/hubs/economics') return { title: T('seo.rates.title'), description: T('seo.rates.description'), og: '/og/site.png', type: 'website', body: `<h1>${esc(T('seo.rates.title'))}</h1><p>${esc(T('seo.rates.description'))}</p>` };
    if (path === '/docs' || /^\/docs\/[a-z-]+$/.test(path)) return { title: T('seo.docs.title'), description: T('seo.docs.description'), og: '/og/site.png', type: 'website', body: `<h1>${esc(T('seo.docs.title'))}</h1><p>${esc(T('seo.docs.description'))}</p>` };
    if (path === '/status') return { title: T('seo.status.title'), description: T('seo.status.description'), og: '/og/site.png', type: 'website', body: `<h1>${esc(T('seo.status.title'))}</h1>` };
    m = PAGE_ROUTE.exec(path);
    if (m) {
      const p = cms.pageOf(`${m[1]}/${m[2]}`);
      if (!p || (!p.body && !p.customised)) return null;
      return { title: p.seo_title || p.title, description: p.seo_description || b.description, og: '/og/site.png', type: 'article', body: `<article class="ssr-page"><h1>${esc(p.title)}</h1>${sanitize(p.body || '', 'page')}</article>` };
    }
    m = /^\/help\/([a-z0-9-]+)$/.exec(path);
    if (m) {
      const h = (appRef.locals.cmsHelp && appRef.locals.cmsHelp.get(m[1])) || null;
      if (h) return { title: h.seo_title || h.title, description: h.seo_description || b.description, og: '/og/site.png', type: 'article', body: `<article class="ssr-page"><h1>${esc(h.title)}</h1>${h.body}</article>` };
    }
    return null;
  }
  const appRef = app;
  function crumbs(list) {
    return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: list.map(([name, href], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `__ORIGIN__${href}` })) };
  }

  // ---------------------------------------------------------------- the page template
  const langParam = (req) => { const l = req.query && typeof req.query.lang === 'string' ? req.query.lang : null; return l && i18n && i18n.isOn(l) ? l : null; };
  function fragment(req) {
    const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
    const origin = originOf(req);
    const loc = res0Locale(req);
    const cur = C.config ? C.config().code : 'NGN';
    const lp = langParam(req);
    const key = JSON.stringify([origin, path, loc, cur, lp]);
    const hit = cacheGet(key);
    if (hit) { stats.hits += 1; return { ...hit, cached: true }; }
    stats.misses += 1;
    const pubLoc = loc !== 'en-NG' ? (() => { try { return cms.store.published('text', loc); } catch { return null; } })() : null;
    const T = (k, vars) => (pubLoc && pubLoc.has(`server.growth.${k}`) ? catalog.fill(`server.growth.${k}`, pubLoc.get(`server.growth.${k}`), vars) : GS(k, vars));
    const mdl = model(path, T);
    const out = mdl ? build(mdl, path, origin, lp, T) : null;
    cacheSet(key, { out });
    return { out, cached: false };
  }
  const res0Locale = (req) => (i18n ? i18n.localeOf(req) : 'en-NG');
  function build(mdl, path, origin, lp, T = GS) {
    const b = brand();
    const canonPath = mdl.canonical || path;
    const self = `${origin}${canonPath}${lp ? `?lang=${encodeURIComponent(lp)}` : ''}`;
    const locales = i18n ? i18n.enabledCodes() : ['en-NG'];
    const alt = locales.map((l) => `<link rel="alternate" hreflang="${esc(l)}" href="${esc(`${origin}${canonPath}${l === 'en-NG' ? '' : `?lang=${encodeURIComponent(l)}`}`)}">`).join('\n  ');
    const img = `${origin}${mdl.og}`;
    const ld = (mdl.ld || []).map((o) => JSON.stringify(o).replace(/__ORIGIN__/g, origin).replace(/</g, '\\u003c'));
    const head = [
      `<link rel="canonical" href="${esc(self)}">`, alt, `<link rel="alternate" hreflang="x-default" href="${esc(`${origin}${canonPath}`)}">`,
      `<meta property="og:site_name" content="${esc(b.app_name || 'Parlance')}">`, `<meta property="og:type" content="${esc(mdl.type || 'website')}">`, `<meta property="og:title" content="${esc(mdl.title)}">`,
      `<meta property="og:description" content="${esc(mdl.description)}">`, `<meta property="og:url" content="${esc(self)}">`, `<meta property="og:image" content="${esc(img)}">`,
      '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">', `<meta property="og:locale" content="${esc('en_NG')}">`,
      '<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:title" content="${esc(mdl.title)}">`, `<meta name="twitter:description" content="${esc(mdl.description)}">`, `<meta name="twitter:image" content="${esc(img)}">`,
    ].join('\n  ');
    return { title: mdl.title, description: mdl.description, head, ld, body: `<div class="ssr" data-testid="ssr">${mdl.body}<p class="faint">${esc(T('seo.js_note'))}</p></div>` };
  }
  const prev = app.locals.pageTransform;
  app.locals.pageTransform = (html, req, res) => {
    let out = prev ? prev(html, req, res) : html;
    if (!flags.jobOn('ssr')) return out;
    if (PRIVATE.test(req.path)) return out.replace('</head>', '  <meta name="robots" content="noindex">\n</head>');
    const fr = fragment(req);
    const f = fr.out;
    if (!f) return out;
    const nonce = esc(res.locals?.cspNonce || '');
    out = out.replace(/<title>[^<]*<\/title>/, `<title>${esc(f.title)}</title>`).replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(f.description)}">`);
    out = out.replace('</head>', `  ${f.head}\n${f.ld.map((j) => `  <script type="application/ld+json" nonce="${nonce}">${j}</script>`).join('\n')}\n</head>`);
    out = out.replace('<main id="view" tabindex="-1"></main>', `<main id="view" tabindex="-1" data-ssr="1">${f.body}</main>`);
    // `cached` when the fragment came from the cache (owner setting ssr.cache_seconds; 0 turns the cache off), else `rendered`.
    res.setHeader('X-Parlance-SSR', fr.cached ? 'cached' : 'rendered');
    return out;
  };
  // Search and link-preview crawlers get public pages without the browser check (flag ssr.crawlers).
  app.locals.challengeExempt = (req) => flags.jobOn('ssr.crawlers') && !PRIVATE.test(req.path) && CRAWLER_UA.test(String(req.headers['user-agent'] || '')) && !AI_UA.test(String(req.headers['user-agent'] || ''));
  app.locals.robotsTail = (req) => (flags.jobOn('ssr') ? `Sitemap: ${originOf(req)}/sitemap.xml\n` : '');

  // ---------------------------------------------------------------- share cards (PNG)
  const imgCache = new Map();
  function png(res, key, card) {
    const h = crypto.createHash('sha256').update(JSON.stringify(card)).digest('hex').slice(0, 32);
    let v = imgCache.get(key);
    if (!v || v.h !== h || Date.now() - v.ts > Math.max(ttl(), 5000)) {
      v = { h, ts: Date.now(), buf: renderCard(card) };
      if (imgCache.size > 300) imgCache.delete(imgCache.keys().next().value);
      imgCache.set(key, v);
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', `public, max-age=${Math.max(0, Math.round(ttl() / 1000))}`);
    res.setHeader('ETag', `"${h}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.end(v.buf);
  }
  // The card is dark: the dark-theme brand and YES colours (contrast-checked against the dark surface, §32.8).
  const baseCard = () => { const b = brand(); return { app: b.app_name || 'Parlance', brand: b.dark.brand, yesColor: b.dark.yes, footer: GS('seo.home.title') }; };
  const notFound = (res) => { res.status(404).setHeader('Cache-Control', 'no-store'); res.type('text/plain').send('Not found'); };
  const money = (cc) => C.priceCc(cc);
  function mountStatic(target) {
    // The Phase 5B elections hub is removed (owner decision 2026-11-08): its URL moves to the Nigeria hub.
    target.get('/hubs/elections', (req, res) => {
      let slug = null;
      try { slug = db.prepare("SELECT slug FROM el_elections WHERE country='NG' AND active=1 AND kind='general' ORDER BY date LIMIT 1").get()?.slug || db.prepare("SELECT slug FROM el_elections WHERE country='NG' AND active=1 ORDER BY date LIMIT 1").get()?.slug || null; } catch { slug = null; }
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.redirect(301, slug ? `/category/elections/${encodeURIComponent(slug)}` : '/category/elections');
    });
    target.get(/^\/og\/(site|event\/[A-Za-z0-9._-]{1,80}|hub\/[a-z0-9-]{1,60}|share\/[A-Za-z0-9_.-]{1,80})\.png$/, (req, res) => {
      if (!flags.jobOn('ssr')) return notFound(res);
      const p = /^\/og\/(.+)\.png$/.exec(req.path)[1];
      if (p === 'site') return png(res, 'site', { ...baseCard(), title: GS('seo.home.description') });
      let m = /^event\/(.+)$/.exec(p);
      if (m) {
        const e = db.prepare('SELECT * FROM events WHERE ticker=?').get(m[1].toUpperCase());
        if (!e || e.series_ticker === COMBO_SERIES) return notFound(res);
        const ev = eventFull(e); const ld = lead(ev); const ch = ld ? pct(ld.last_price_dollars) : null;
        const yesCc = ld && ld.last_price_dollars != null ? Math.round(Number(ld.last_price_dollars) * 10000) : null;
        return png(res, `event:${ev.event_ticker}`, { ...baseCard(), title: ld && ev.markets.length > 1 ? `${ev.title}: ${ld.yes_sub_title}` : ev.title, chance: ch, chanceLabel: ch != null ? GS('og.chance', { chance: `${ch}%` }) : null, yes: yesCc != null ? GS('og.yes', { price: money(yesCc) }) : null, no: yesCc != null ? GS('og.no', { price: money(10000 - yesCc) }) : null });
      }
      m = /^hub\/(.+)$/.exec(p);
      if (m) {
        let el = null; try { el = db.prepare('SELECT * FROM el_elections WHERE slug=? AND active=1').get(m[1]); } catch { el = null; }
        if (!el) return notFound(res);
        return png(res, `hub:${el.slug}`, { ...baseCard(), title: GS('seo.hub.title', { name: el.title }) });
      }
      m = /^share\/(.+)$/.exec(p);
      if (m && appRef.locals.shareLinks) {
        const l = appRef.locals.shareLinks.linkOf(m[1]);
        if (!l || l.status !== 'active') return notFound(res);
        const v = appRef.locals.shareLinks.publicVo(l, m[1]);
        const side = String(v.side || '').toUpperCase();
        const title = l.kind === 'trade' ? GS('share.title.trade', { name: v.sharer || '', side, title: v.title }) : l.kind === 'position' ? GS('share.title.position', { name: v.sharer || '', side, title: v.title }) : v.title;
        return png(res, `share:${l.id}`, { ...baseCard(), title, yes: v.price_cc != null ? `${side} ${money(v.price_cc)}` : null });
      }
      return notFound(res);
    });
    // Sitemaps: an index and one file per section, with <lastmod>.
    const xml = (res, body) => { res.setHeader('Content-Type', 'application/xml; charset=utf-8'); res.setHeader('Cache-Control', `public, max-age=${Math.max(0, Math.round(ttl() / 1000))}`); res.send(`<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`); };
    const day = (t) => new Date(t || Date.now()).toISOString().slice(0, 10);
    const urlset = (origin, items) => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items.map((u) => `<url><loc>${esc(origin + u.loc)}</loc><lastmod>${esc(u.lastmod)}</lastmod></url>`).join('')}</urlset>`;
    const SECTIONS = ['pages', 'categories', 'markets', 'hubs'];
    target.get('/sitemap.xml', (req, res) => {
      if (!flags.jobOn('ssr')) return notFound(res);
      const o = originOf(req);
      xml(res, `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${SECTIONS.map((s) => `<sitemap><loc>${esc(`${o}/sitemaps/${s}.xml`)}</loc><lastmod>${day()}</lastmod></sitemap>`).join('')}</sitemapindex>`);
    });
    target.get(/^\/sitemaps\/([a-z]+)\.xml$/, (req, res) => {
      if (!flags.jobOn('ssr')) return notFound(res);
      const s = /^\/sitemaps\/([a-z]+)\.xml$/.exec(req.path)[1];
      const o = originOf(req);
      const lastTrade = (tickers) => { if (!tickers.length) return null; const r = db.prepare(`SELECT MAX(created_ts) t FROM trades WHERE market_ticker IN (${tickers.map(() => '?').join(',')})`).get(...tickers); return r && r.t; };
      if (s === 'pages') {
        const pages = (() => { try { return db.prepare("SELECT key, published_at FROM cms_entries WHERE type='page' AND locale='en-NG' AND published_json IS NOT NULL").all(); } catch { return []; } })();
        const pub = new Map(pages.map((p) => [p.key, p.published_at]));
        const items = [{ loc: '/', lastmod: day() }, { loc: '/browse', lastmod: day() }, { loc: '/docs', lastmod: day() }, { loc: '/status', lastmod: day() }];
        for (const p of require('./content/pages').PAGES ? Object.keys(require('./content/pages').PAGES) : []) { const pg = cms.pageOf(p); if (pg && (pg.body || pg.customised) && /^(legal|trust|research|support)\//.test(p)) items.push({ loc: `/${p}`, lastmod: day(pub.get(p) ? Date.parse(pub.get(p)) : null) }); }
        return xml(res, urlset(o, items));
      }
      if (s === 'categories') return xml(res, urlset(o, CATEGORIES.map((c) => ({ loc: `/category/${catSlug(c)}`, lastmod: day() }))));
      if (s === 'markets') return xml(res, urlset(o, openEvents().map((e) => ({ loc: eventHref(e), lastmod: day(lastTrade(e.markets.map((mk) => mk.ticker)) || Date.parse(e.created_at || '') || null) }))));
      if (s === 'hubs') {
        let els = []; try { els = db.prepare('SELECT slug, updated_ts FROM el_elections WHERE active=1').all(); } catch { els = []; }
        return xml(res, urlset(o, [{ loc: '/hubs/economics', lastmod: day() }, ...els.map((e) => ({ loc: `/category/elections/${e.slug}`, lastmod: day(e.updated_ts) }))]));
      }
      return notFound(res);
    });
  }

  return { mountStatic, fragment, model, stats, cache, originOf, CRAWLER_UA };
}

module.exports = { mountSeo, CRAWLER_UA, AI_UA };
