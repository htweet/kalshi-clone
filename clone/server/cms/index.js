'use strict';
// Content management (CLONE_SPEC.md §32, PLAN Phase 5C). Every user-facing text, notification and email template,
// image, page, footer link and brand value is managed here; only technical configuration stays in code.
//
// Content types (one store, server/cms/store.js):
//   text      Admin › Content › Texts      catalog keys (server/cms/texts.js); plain or allowlisted rich text
//   template  Admin › Content › Templates  notification channels and system emails/SMS (server/cms/templates.js)
//   media     Admin › Content › Media      usage slots → uploaded, re-encoded images (server/cms/images.js)
//   page      Admin › Content › Pages      legal, help and info pages with SEO fields
//   footer    Admin › Content › Pages      footer tagline and link columns
//   brand     Admin › Content › Branding   brand / YES colours per theme (contrast-checked), app name and short name
// Roles: content.write saves drafts and previews; content.publish publishes, schedules and rolls back (legal pages
// also need a fresh step-up). Every publish is versioned and writes a hash-chained audit row with its reason.
// Delivery: the public bundle (GET /v1/content/bundle, /content-bundle.js; ETag), /content-theme.css, /media/*,
// /manifest.webmanifest and the page template; live over the public `content` WebSocket channel.
const crypto = require('node:crypto');
const { createStore, CmsError, DEFAULT_LOCALE } = require('./store');
const texts = require('./texts');
const templates = require('./templates');
const images = require('./images');
const { sanitize, safeHref, plainProblem, esc } = require('./sanitize');
const catalog = require('../content/catalog');
const pwaContent = require('../content/pwa');
const { PAGES, FOOTER } = require('../content/pages');
const { createLimiter } = require('../content-rate');
const { check } = require('../validate');
const { ApiError, E, newId, nowIso } = require('../util');
const { CATEGORIES } = require('../features');

const MEDIA_SCHEMA = `
CREATE TABLE IF NOT EXISTS cms_media (id TEXT PRIMARY KEY, parent_id TEXT, variant TEXT NOT NULL DEFAULT 'original', mime TEXT NOT NULL, ext TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, original_name TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cms_media_parent ON cms_media(parent_id);
`;
// Usage slots. square: the upload must be square; icons: PWA / favicon sizes generated from the one upload.
const SLOTS = {
  logo: { label: 'Logo (header)', min: 32 },
  wordmark: { label: 'Wordmark', min: 32 },
  favicon: { label: 'Favicon', square: true, min: 48, icons: true },
  pwa_icon: { label: 'App icon (PWA, home screen)', square: true, min: 512, icons: true },
  'hero.home': { label: 'Home promo art', min: 64 },
  'promo.perps': { label: 'Perps promo art', min: 64 },
  'hub.elections': { label: 'Elections hub art', min: 64 },
  'hub.economics': { label: 'Economics hub art', min: 64 },
  email_header: { label: 'Email header', min: 64 },
  'empty.portfolio': { label: 'Empty state: portfolio', min: 64 },
  'empty.watchlist': { label: 'Empty state: watchlist', min: 64 },
  'empty.notifications': { label: 'Empty state: notifications', min: 64 },
  ...Object.fromEntries(CATEGORIES.map((c) => [`category.${c}`, { label: `Category icon: ${c}`, square: true, min: 32 }])),
};
const ICON_VARIANTS = [['icon-192', 192, 0, 'any'], ['icon-512', 512, 0, 'any'], ['icon-maskable-512', 512, 0.1, 'maskable'], ['apple-touch-icon', 180, 0, 'any'], ['badge-72', 72, 0, 'any'], ['favicon-48', 48, 0, 'any'], ['favicon-32', 32, 0, 'any']];
const BRAND_DEFAULT = {
  light: { brand: '#008751', yes: '#0b7285' }, dark: { brand: '#13a866', yes: '#22c3b5' },
  app_name: pwaContent.PWA_CONFIG.name, short_name: pwaContent.PWA_CONFIG.short_name, description: pwaContent.PWA_CONFIG.description,
};
const SURFACE = { light: '#ffffff', dark: '#0d0e11' }; // --surface-x10 per theme (public/app.css)
const HEX = /^#[0-9a-f]{6}$/i;
function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const PAGE_SLUG = /^[a-z0-9][a-z0-9-]{0,59}(\/[a-z0-9][a-z0-9-]{0,59})?$/;
const TYPES = ['text', 'template', 'media', 'page', 'footer', 'brand'];

function mountCms({ v1, app, db, engine, admin, auth, options = {} }) {
  db.exec(MEDIA_SCHEMA);
  catalog.setFormatters({ money: (c) => require('../currency').moneyCents(Number(c)), number: (n) => Number(n).toLocaleString('en-NG') }); // typed variables (§32.3)
  const can = admin.can;
  const emit = (msg) => { bundleCache.clear(); try { engine.emit('content', msg); } catch (e) { console.error('cms emit', e); } };
  const requireFresh = (req, action) => auth.assertFresh(req, action);
  const store = createStore({ db, emit: (m) => emit(m), requireFresh });
  const writes = createLimiter(db, 'cms_write', { limit: options.writesPerMinute ?? 120, windowMs: 60000 });
  const uploads = createLimiter(db, 'cms_upload', { limit: options.uploadsPerMinute ?? 30, windowMs: 60000 });
  const sends = createLimiter(db, 'cms_test_send', { limit: options.testSendsPerMinute ?? 10, windowMs: 60000 });
  const bundleCache = new Map();

  // ---------------------------------------------------------------- type handlers
  const asset = (id) => db.prepare("SELECT id, parent_id, variant, mime, ext, width, height, bytes, sha256, original_name, created_by, created_at FROM cms_media WHERE id=?").get(String(id || ''));
  const mediaUrl = (a) => (a ? `/media/${a.id}.${a.ext}` : null);
  const variantOf = (id, v) => db.prepare('SELECT id, ext, width, height, mime FROM cms_media WHERE parent_id=? AND variant=?').get(id, v);
  const refreshServerTexts = () => {
    const entries = [];
    for (const [k, v] of store.published('text')) if (k.startsWith('server.')) entries.push([k, v]);
    catalog.setOverrides(entries);
  };
  store.register('text', {
    validate: (key, value) => texts.validate(key, value),
    changed: (key) => { if (key.startsWith('server.')) refreshServerTexts(); },
  });
  store.register('template', { validate: (key, value) => templates.validate(key, value), changed: () => templateCache.clear() });
  store.register('media', {
    validate: (key, value) => {
      const slot = SLOTS[key];
      if (!slot) throw { key: 'unknown media slot' };
      if (!value || typeof value !== 'object') throw { value: 'must be {asset_id, alt}' };
      const a = asset(value.asset_id);
      if (!a || a.variant !== 'original') throw { asset_id: 'no such uploaded image' };
      if (slot.square && a.width !== a.height) throw { asset_id: `this slot needs a square image (the upload is ${a.width}×${a.height})` };
      if (Math.min(a.width, a.height) < slot.min) throw { asset_id: `this slot needs an image at least ${slot.min} pixels on each side` };
      const alt = String(value.alt ?? '').trim();
      if (alt.length > 160) throw { alt: 'must be at most 160 characters' };
      const p = plainProblem(alt); if (p) throw { alt: p };
      return { asset_id: a.id, alt };
    },
  });
  store.register('page', {
    validate: (key, v) => {
      if (!PAGE_SLUG.test(key)) throw { key: 'a page slug is lowercase letters, digits and dashes, optionally group/slug' };
      if (!v || typeof v !== 'object') throw { value: 'must be a page object' };
      const errs = {}; const out = {};
      const str = (f, min, max) => { const s = String(v[f] ?? '').trim(); if (s.length < min || s.length > max) errs[f] = min ? `${min}-${max} characters` : `at most ${max} characters`; else { const p = plainProblem(s); if (p) errs[f] = p; else out[f] = s; } };
      str('title', 1, 140); str('seo_title', 0, 90); str('seo_description', 0, 200);
      out.section = ['legal', 'help', 'info'].includes(v.section) ? v.section : PAGES[key]?.section || 'info';
      const body = String(v.body ?? '');
      if (body.length > 100000) errs.body = 'at most 100000 characters'; else out.body = sanitize(body, 'page');
      if (Object.keys(errs).length) throw errs;
      return out;
    },
    legal: (key, v) => (v && v.section === 'legal') || PAGES[key]?.section === 'legal',
    changed: () => {},
  });
  store.register('footer', {
    validate: (key, v) => {
      if (key !== 'links') throw { key: 'the footer entry is "links"' };
      if (!v || typeof v !== 'object' || !Array.isArray(v.columns)) throw { value: 'must be {tagline, columns: [{title, links: [{label, href}]}]}' };
      const tagline = String(v.tagline ?? '').trim();
      if (tagline.length > 200 || plainProblem(tagline)) throw { tagline: 'plain text up to 200 characters' };
      if (v.columns.length > 6) throw { columns: 'at most 6 columns' };
      const columns = v.columns.map((c, i) => {
        const title = String(c?.title ?? '').trim();
        if (!title || title.length > 60 || plainProblem(title)) throw { [`columns.${i}.title`]: 'plain text, 1-60 characters' };
        if (!Array.isArray(c.links) || c.links.length > 12) throw { [`columns.${i}.links`]: 'a list of at most 12 links' };
        return { title, links: c.links.map((l, j) => {
          const label = String(l?.label ?? '').trim(); const href = safeHref(String(l?.href ?? '').trim());
          if (!label || label.length > 60 || plainProblem(label)) throw { [`columns.${i}.links.${j}.label`]: 'plain text, 1-60 characters' };
          if (!href || /^mailto:/i.test(href)) throw { [`columns.${i}.links.${j}.href`]: 'must be a site path (/…) or an https:// URL' };
          return { label, href };
        }) };
      });
      return { tagline, columns };
    },
  });
  store.register('brand', {
    validate: (key, v) => {
      if (key !== 'theme') throw { key: 'the brand entry is "theme"' };
      if (!v || typeof v !== 'object') throw { value: 'must be a brand object' };
      const errs = {}; const out = {};
      for (const theme of ['light', 'dark']) {
        out[theme] = {};
        for (const tok of ['brand', 'yes']) {
          const c = String(v[theme]?.[tok] ?? BRAND_DEFAULT[theme][tok]).toLowerCase();
          if (!HEX.test(c)) { errs[`${theme}.${tok}`] = 'must be a #rrggbb colour'; continue; }
          const r = contrast(c, SURFACE[theme]);
          if (r < 4.5) { errs[`${theme}.${tok}`] = `contrast ${r.toFixed(2)}:1 on the ${theme} surface ${SURFACE[theme]} is below 4.5:1 (text use); pick a ${theme === 'light' ? 'darker' : 'lighter'} colour`; errs.code = 'contrast_too_low'; continue; }
          out[theme][tok] = c;
        }
      }
      for (const [f, max] of [['app_name', 45], ['short_name', 12], ['description', 200]]) {
        const s = String(v[f] ?? BRAND_DEFAULT[f]).trim();
        if (!s || s.length > max || plainProblem(s)) errs[f] = `plain text, 1-${max} characters`; else out[f] = s;
      }
      if (Object.keys(errs).length) throw errs;
      return out;
    },
  });

  // ---------------------------------------------------------------- effective values
  const publishedOne = (type, key) => store.published(type).get(key) ?? null;
  const brand = (preview = false) => ({ ...BRAND_DEFAULT, ...((preview ? store.withDrafts('brand') : store.published('brand')).get('theme') || {}) });
  const footer = (preview = false) => (preview ? store.withDrafts('footer') : store.published('footer')).get('links') || FOOTER;
  function mediaMap(preview = false) {
    const out = {};
    for (const [slot, v] of (preview ? store.withDrafts('media') : store.published('media'))) {
      const a = asset(v.asset_id);
      if (a) out[slot] = { url: mediaUrl(a), alt: v.alt || '', width: a.width, height: a.height };
    }
    return out;
  }
  function pageOf(slug, preview = false) {
    const ov = (preview ? store.withDrafts('page') : store.published('page')).get(slug);
    const def = PAGES[slug];
    if (!ov && !def) return null;
    const p = ov || def;
    return { slug, section: p.section || 'info', title: p.title, body: p.body || '', seo_title: p.seo_title || p.title, seo_description: p.seo_description || '', customised: !!ov };
  }
  function pageList(preview = false) {
    const m = preview ? store.withDrafts('page') : store.published('page');
    const slugs = new Set([...Object.keys(PAGES), ...m.keys()]);
    return [...slugs].sort().map((s) => pageOf(s, preview)).filter(Boolean).map(({ body, ...rest }) => { void body; return rest; });
  }
  function bundle(preview = false) {
    const k = preview ? 'preview' : 'public';
    if (!preview && bundleCache.has(k)) return bundleCache.get(k);
    const cat = texts.load();
    const t = {};
    for (const [key, v] of (preview ? store.withDrafts('text') : store.published('text'))) {
      const e = cat.get(key);
      if (!e || e.scope !== 'client' || typeof v !== 'string') continue;
      t[key] = e.rich ? sanitize(v, 'rich') : v;
    }
    const br = brand(preview);
    const b = { locale: DEFAULT_LOCALE, preview: !!preview, texts: t, media: mediaMap(preview), brand: br, theme: brandIsDefault(br) ? null : themeVersion(br), footer: footer(preview) };
    const body = JSON.stringify(b);
    const out = { body, etag: `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}"`, data: b };
    if (!preview) bundleCache.set(k, out);
    return out;
  }
  const templateCache = new Map();
  const tplOverride = (key) => { if (!templateCache.has(key)) templateCache.set(key, publishedOne('template', key)); return templateCache.get(key); };

  // ---------------------------------------------------------------- delivery API (used by notify, messaging, push)
  const appName = () => brand().short_name;
  function renderNotification(type, msg) {
    const key = templates.definition(`notify.${type}`) ? `notify.${type}` : 'notify._default';
    const vars = { title: msg.title || '', body: msg.body || '', link: msg.link || '', open_line: msg.link ? `\n\nOpen: ${msg.link}` : '', app_name: appName() };
    const ov = tplOverride(key);
    if (!ov) return null; // defaults pass the composed wording through unchanged
    const f = (field) => templates.renderField(key, field, vars, ov);
    return { inapp: { title: f('inapp_title'), body: f('inapp_body') }, push: { title: f('push_title'), body: f('push_body') }, key };
  }
  function renderNotificationEmail(type, msg) {
    const key = templates.definition(`notify.${type}`) ? `notify.${type}` : 'notify._default';
    const vars = { title: msg.title || '', body: msg.body || '', link: msg.link || '', open_line: msg.link ? `\n\nOpen: ${msg.link}` : '', app_name: appName() };
    return templates.renderEmail(key, vars, tplOverride(key), tplOverride('email._layout'), { headerImage: mediaMap().email_header?.url || null });
  }
  function renderSystem(key, vars, { origin = '' } = {}) {
    const v = { app_name: appName(), ...vars };
    const d = templates.definition(key);
    if (!d) throw new Error(`unknown template ${key}`);
    if (d.kind === 'email') return templates.renderEmail(key, v, tplOverride(key), tplOverride('email._layout'), { headerImage: mediaMap().email_header?.url || null, origin });
    const out = {};
    for (const f of d.fields) out[f] = templates.renderField(key, f, v, tplOverride(key));
    return out;
  }

  // ---------------------------------------------------------------- PWA manifest, page template, theme CSS
  function pwaConfig() {
    const b = brand(); const m = mediaMap();
    const cfg = { ...pwaContent.PWA_CONFIG, name: b.app_name, short_name: b.short_name, description: b.description, theme_color: b.light.brand };
    const icon = publishedOne('media', 'pwa_icon');
    if (icon) {
      const v = (name) => variantOf(icon.asset_id, name);
      const list = ICON_VARIANTS.filter(([n]) => ['icon-192', 'icon-512', 'icon-maskable-512'].includes(n)).map(([n, size, , purpose]) => { const a = v(n); return a ? { src: mediaUrl(a), sizes: `${size}x${size}`, type: a.mime, purpose } : null; }).filter(Boolean);
      if (list.length) { cfg.icons = list; cfg.shortcut_icon = list[0]; }
    }
    void m;
    return cfg;
  }
  const PAGE_ROUTE = /^\/(legal|trust|research|support|incentives|help)\/([a-z0-9-]+)$/;
  function pageTransform(html, req, res) {
    const b = brand(); const m = mediaMap();
    let title = b.app_name; let desc = b.description;
    const pm = PAGE_ROUTE.exec(req.path);
    const p = pm && pageOf(`${pm[1]}/${pm[2]}`);
    if (p) { title = p.seo_title || p.title; desc = p.seo_description || desc; }
    let out = html
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
      .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`)
      .replace(/<meta name="theme-color" content="[^"]*" media="\(prefers-color-scheme: light\)">/, `<meta name="theme-color" content="${esc(b.light.brand)}" media="(prefers-color-scheme: light)">`)
      .replace(/<meta name="theme-color" content="[^"]*" media="\(prefers-color-scheme: dark\)">/, `<meta name="theme-color" content="${esc(b.dark.brand)}" media="(prefers-color-scheme: dark)">`)
      .replace(/<meta name="apple-mobile-web-app-title" content="[^"]*">/, `<meta name="apple-mobile-web-app-title" content="${esc(b.short_name)}">`);
    const fav = publishedOne('media', 'favicon') || publishedOne('media', 'pwa_icon');
    const favA = fav && (variantOf(fav.asset_id, 'favicon-48') || asset(fav.asset_id));
    if (favA) out = out.replace(/<link rel="icon" href="[^"]*">/, `<link rel="icon" href="${esc(mediaUrl(favA))}" type="${esc(favA.mime)}">`);
    const apple = publishedOne('media', 'pwa_icon');
    const appleA = apple && variantOf(apple.asset_id, 'apple-touch-icon');
    if (appleA) out = out.replace(/<link rel="apple-touch-icon" href="[^"]*">/, `<link rel="apple-touch-icon" href="${esc(mediaUrl(appleA))}">`);
    if (!brandIsDefault(b)) out = out.replace('</head>', `  <link rel="stylesheet" id="cms-theme" href="/content-theme.css?v=${esc(themeVersion(b))}" nonce="${esc(res.locals?.cspNonce || '')}">\n</head>`);
    void m;
    return out;
  }
  const brandIsDefault = (b) => ['light', 'dark'].every((t) => b[t].brand === BRAND_DEFAULT[t].brand && b[t].yes === BRAND_DEFAULT[t].yes);
  const themeVersion = (b) => crypto.createHash('sha256').update(JSON.stringify([b.light, b.dark])).digest('hex').slice(0, 12);
  function themeCss(preview = false) {
    const b = brand(preview);
    const decl = (t) => `--brand:${b[t].brand};--yes:${b[t].yes};--brand-x20:color-mix(in srgb,${b[t].brand} 16%,var(--surface-x10));--yes-x20:color-mix(in srgb,${b[t].yes} 16%,var(--surface-x10));`;
    return brandIsDefault(b) ? '/* brand colours: code defaults (public/app.css) */\n' : `/* brand colours from Admin › Content › Branding (CLONE_SPEC.md §32.8) */\n:root,:root[data-theme="dark"]{${decl('dark')}}\n:root[data-theme="light"]{${decl('light')}}\n`;
  }
  app.locals.pwaConfig = pwaConfig;
  // The incentive terms page (CLONE_SPEC.md §32.7): published body + version for server/incentives.js.
  try { require('../incentives').setTermsSource(() => { const v = store.get('page', 'incentives/terms'); const p = v.published; return p && p.body ? { body: sanitize(p.body, 'page'), title: p.title, version: v.published_version } : null; }); } catch (e) { console.error('cms incentive terms', e); }
  app.locals.pageTransform = pageTransform;

  // ---------------------------------------------------------------- public routes
  const sendCached = (req, res, type, { body, etag }) => {
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.type(type).send(body);
  };
  v1.get('/content/bundle', (req, res) => sendCached(req, res, 'application/json', bundle(false)));
  v1.get('/pages', (req, res) => res.json({ pages: pageList(false) }));
  const staffPreview = (req) => req.query.preview === '1' && req.auth && admin.rolesOf(req.auth.user).some((r) => ['admin', 'editor', 'publisher'].includes(r));
  const pageRoute = (req, res) => {
    const slug = req.params.b ? `${req.params.a}/${req.params.b}` : req.params.a;
    const preview = staffPreview(req);
    const p = PAGE_SLUG.test(slug) ? pageOf(slug, preview) : null;
    if (!p || (!p.body && !p.customised && slug !== 'incentives/terms')) throw E.notFound();
    if (preview) res.setHeader('Cache-Control', 'no-store');
    res.json({ page: { ...p, body: sanitize(p.body, 'page'), preview } });
  };
  // Help articles (CLONE_SPEC.md §32.7): CMS pages under help/<slug> are served by /v1/help(/:slug) too, after the §18.5
  // help collection (whose own rows keep their markdown-like rendering).
  app.locals.cmsHelp = { list: () => pageList(false).filter((p) => p.slug.startsWith('help/')).map((p) => ({ slug: p.slug.slice(5), title: p.title })), get: (slug) => { const p = pageOf(`help/${slug}`); return p && p.body ? { ...p, body: sanitize(p.body, 'page') } : null; } };
  v1.get('/pages/:a', pageRoute);
  v1.get('/pages/:a/:b', pageRoute);
  // Classic script loaded before the app modules: strings read while modules evaluate already see the published text.
  function mountStatic(target) {
    target.get('/content-bundle.js', (req, res) => {
      const b = bundle(false);
      // JSON.stringify output is a JS expression; "<" is escaped so the text can never close a script element.
      sendCached(req, res, 'text/javascript; charset=utf-8', { body: `self.__PLX_CONTENT__=${b.body.replace(/</g, '\\u003c')};\n`, etag: b.etag });
    });
    // Brand colours (a stylesheet: a <link> cannot send the /v1 client token, so it lives outside /v1).
    target.get('/content-theme.css', (req, res) => { const body = themeCss(false); sendCached(req, res, 'text/css; charset=utf-8', { body, etag: `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}"` }); });
    target.get(/^\/media\/([a-z0-9_]+)\.(png|jpg)$/, (req, res, next) => {
      const m = /^\/media\/([a-z0-9_]+)\.(png|jpg)$/.exec(req.path);
      const r = db.prepare('SELECT mime, ext, data, sha256 FROM cms_media WHERE id=?').get(m[1]);
      if (!r || r.ext !== m[2]) return next();
      res.setHeader('Content-Type', r.mime);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('ETag', `"${r.sha256.slice(0, 32)}"`);
      res.end(Buffer.from(r.data));
    });
  }

  // ---------------------------------------------------------------- admin routes
  const A = '/admin/cms';
  const wrap = (fn) => (req, res, next) => {
    try { const r = fn(req, res); if (r && typeof r.then === 'function') r.catch((e) => next(toApi(e))); } catch (e) { next(toApi(e)); }
  };
  function toApi(e) {
    if (e instanceof CmsError) {
      const err = new ApiError(e.status, e.code, e.message, e.fields ? Object.entries(e.fields).map(([k, v]) => `${k}: ${v}`).join('; ') : undefined);
      if (e.fields) { err.fields = e.fields; err.toJSON = () => ({ error: { code: e.code, message: e.message, details: err.details, fields: e.fields } }); }
      return err;
    }
    if (e instanceof images.ImageError) return new ApiError(400, 'invalid_image', e.message);
    return e;
  }
  const typeOf = (req) => { const t = req.params.type; if (!TYPES.includes(t)) throw new CmsError(404, 'not_found', 'unknown content type'); return t; };
  const hit = (lim, req) => lim.hit(req.auth.user.id);
  const KEY = { type: 'string', maxLen: 200, required: true };
  const body = (req, spec) => check(req.body || {}, spec, { unknown: 'reject' });

  v1.get(`${A}/overview`, can('content.write'), wrap((req, res) => {
    const count = (sql) => db.prepare(sql).get().c;
    res.json({
      counts: {
        texts: texts.load().size, text_overrides: count("SELECT COUNT(*) c FROM cms_entries WHERE type='text' AND published_json IS NOT NULL"),
        drafts: count('SELECT COUNT(*) c FROM cms_entries WHERE draft_json IS NOT NULL'), scheduled: count('SELECT COUNT(*) c FROM cms_entries WHERE scheduled_at IS NOT NULL'),
        templates: templates.list().length, pages: pageList(false).length, media: count("SELECT COUNT(*) c FROM cms_media WHERE variant='original'"),
      },
      scheduled: db.prepare('SELECT type, key, scheduled_at, scheduled_by_email FROM cms_entries WHERE scheduled_at IS NOT NULL ORDER BY scheduled_at LIMIT 50').all().map((r) => ({ type: r.type, key: r.key, at: new Date(r.scheduled_at).toISOString(), by: r.scheduled_by_email })),
      recent: db.prepare('SELECT type, key, version, action, author_email, reason, created_at FROM cms_versions ORDER BY id DESC LIMIT 20').all(),
      can_publish: admin.rolesOf(req.auth.user).some((r) => r === 'admin' || r === 'publisher'),
    });
  }));
  v1.get(`${A}/texts`, can('content.write'), wrap((req, res) => {
    const cat = texts.load();
    const pub = store.published('text'); const drafts = new Map(store.rows('text').filter((r) => r.has_draft).map((r) => [r.key, r]));
    const sched = new Map(store.rows('text').filter((r) => r.scheduled).map((r) => [r.key, r.scheduled]));
    const q = String(req.query.q || '').toLowerCase().slice(0, 100);
    const area = String(req.query.area || ''); const section = String(req.query.section || ''); const state = String(req.query.state || '');
    const areas = {};
    let items = [];
    for (const e of cat.values()) {
      areas[e.area] = (areas[e.area] || 0) + 1;
      if (area && e.area !== area) continue;
      if (section && e.section !== section) continue;
      const published = pub.has(e.key) ? pub.get(e.key) : null;
      const draft = drafts.has(e.key) ? drafts.get(e.key).draft : null;
      if (state === 'overridden' && published == null) continue;
      if (state === 'draft' && draft == null) continue;
      if (state === 'scheduled' && !sched.has(e.key)) continue;
      if (q && !e.key.toLowerCase().includes(q) && !e.default.toLowerCase().includes(q) && !String(published ?? '').toLowerCase().includes(q)) continue;
      items.push({ ...e, published, draft, scheduled: sched.get(e.key) || null, preview_path: texts.AREA_ROUTES[e.area.split('.')[0]] || (e.area.startsWith('admin') ? '/admin' : '/') });
    }
    const total = items.length;
    const offset = Math.max(0, Number(req.query.offset) || 0); const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    items = items.slice(offset, offset + limit);
    const sections = area ? [...new Set([...cat.values()].filter((e) => e.area === area).map((e) => e.section))].sort() : [];
    res.json({ total, offset, limit, items, areas: Object.entries(areas).sort().map(([name, n]) => ({ name, count: n })), sections });
  }));
  v1.get(`${A}/templates`, can('content.write'), wrap((req, res) => {
    const pub = store.published('template'); const rows = new Map(store.rows('template').map((r) => [r.key, r]));
    res.json({ templates: templates.list().map((t) => ({ ...t, published: pub.get(t.key) || null, draft: rows.get(t.key)?.draft || null, scheduled: rows.get(t.key)?.scheduled || null })) });
  }));
  v1.get(`${A}/pages`, can('content.write'), wrap((req, res) => {
    const rows = new Map(store.rows('page').map((r) => [r.key, r]));
    const all = new Set([...Object.keys(PAGES), ...rows.keys()]);
    res.json({ pages: [...all].sort().map((slug) => ({ slug, default: PAGES[slug] || null, effective: pageOf(slug), draft: rows.get(slug)?.draft || null, scheduled: rows.get(slug)?.scheduled || null, legal: (PAGES[slug]?.section || rows.get(slug)?.published?.section || rows.get(slug)?.draft?.section) === 'legal' })),
      footer: { effective: footer(), default: FOOTER, draft: store.get('footer', 'links').draft } });
  }));
  v1.get(`${A}/media`, can('content.write'), wrap((req, res) => {
    const assets = db.prepare("SELECT id, mime, ext, width, height, bytes, original_name, created_by, created_at FROM cms_media WHERE variant='original' ORDER BY created_at DESC LIMIT 500").all();
    const pub = store.published('media'); const rows = new Map(store.rows('media').map((r) => [r.key, r]));
    res.json({ assets: assets.map((a) => ({ ...a, url: mediaUrl(a) })), slots: Object.entries(SLOTS).map(([key, s]) => ({ key, ...s, published: pub.get(key) || null, draft: rows.get(key)?.draft || null, url: pub.get(key) ? mediaUrl(asset(pub.get(key).asset_id)) : null })) });
  }));
  v1.post(`${A}/media`, can('content.write'), wrap((req, res) => {
    hit(uploads, req);
    const b = body(req, { filename: { type: 'string', maxLen: 200 }, data: { type: 'string', maxLen: 12 * 1024 * 1024, required: true } });
    const raw = Buffer.from(String(b.data).replace(/^data:[^,]*,/, ''), 'base64');
    const img = images.process(raw);
    const id = newId('md_').replace(/[^a-z0-9_]/gi, '').toLowerCase();
    const ins = db.prepare('INSERT INTO cms_media(id,parent_id,variant,mime,ext,width,height,bytes,sha256,data,original_name,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const name = String(b.filename || '').replace(/[^\w. -]/g, '').slice(0, 120);
    ins.run(id, null, 'original', img.mime, img.ext, img.width, img.height, img.bytes.length, img.sha256, img.bytes, name, req.auth.user.email, nowIso());
    if (img.width === img.height && img.width >= 48) { // icon sizes for the favicon / PWA slots, generated once from the square upload
      for (const [variant, size, pad] of ICON_VARIANTS) {
        if (size > img.width) continue;
        const px = pad ? images.padSquare(img.pixels, size, pad, [13, 14, 17, 255]) : images.resize(img.pixels, size, size);
        const bytes = images.encodePng(px);
        ins.run(`${id}_${variant.replace(/-/g, '_')}`, id, variant, 'image/png', 'png', size, size, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), bytes, name, req.auth.user.email, nowIso());
      }
    }
    admin.audit(req, 'cms.media_upload', 'cms.media', id, null, { mime: img.mime, width: img.width, height: img.height, bytes: img.bytes.length, name });
    res.status(201).json({ asset: { ...asset(id), url: mediaUrl(asset(id)), variants: db.prepare('SELECT variant, width FROM cms_media WHERE parent_id=?').all(id) } });
  }));
  v1.get(`${A}/:type/entry`, can('content.write'), wrap((req, res) => {
    const type = typeOf(req); const key = String(req.query.key || '');
    if (!key || key.length > 200) throw new CmsError(400, 'validation_failed', 'validation failed', { key: 'is required' });
    const e = store.get(type, key, req.query.locale);
    const extra = type === 'text' ? { catalog: texts.load().get(key) || null } : type === 'template' ? { definition: templates.definition(key) } : type === 'page' ? { default: PAGES[key] || null } : type === 'brand' ? { defaults: BRAND_DEFAULT } : {};
    res.json({ entry: e, versions: store.versions(type, key, req.query.locale), ...extra });
  }));
  v1.put(`${A}/:type/draft`, can('content.write'), wrap((req, res) => {
    const type = typeOf(req); hit(writes, req);
    const b = body(req, { key: KEY, value: { type: ['string', 'object'], required: true }, locale: { type: 'string', maxLen: 10 } });
    if (type === 'text' && typeof b.value !== 'string') throw new CmsError(400, 'validation_failed', 'validation failed', { value: 'must be a string' });
    res.json({ entry: store.saveDraft(req, type, b.key, b.value, b.locale) });
  }));
  v1.delete(`${A}/:type/draft`, can('content.write'), wrap((req, res) => {
    const type = typeOf(req); hit(writes, req);
    res.json({ entry: store.discardDraft(req, type, String(req.query.key || ''), req.query.locale) });
  }));
  v1.post(`${A}/:type/publish`, can('content.publish'), wrap((req, res) => {
    const type = typeOf(req); hit(writes, req);
    const b = body(req, { key: KEY, reason: { type: 'string', maxLen: 500 }, at: { type: 'string', maxLen: 40, nullable: true }, locale: { type: 'string', maxLen: 10 }, reset: { type: 'boolean' } });
    res.json({ entry: store.publish(req, type, b.key, { reason: b.reason, at: b.at, locale: b.locale, ...(b.reset ? { value: null } : {}) }) });
  }));
  v1.post(`${A}/:type/unschedule`, can('content.publish'), wrap((req, res) => {
    const type = typeOf(req); hit(writes, req);
    const b = body(req, { key: KEY, reason: { type: 'string', maxLen: 500 }, locale: { type: 'string', maxLen: 10 } });
    res.json({ entry: store.unschedule(req, type, b.key, b) });
  }));
  v1.post(`${A}/:type/rollback`, can('content.publish'), wrap((req, res) => {
    const type = typeOf(req); hit(writes, req);
    const b = body(req, { key: KEY, version: { type: 'integer', min: 0, max: 1e9, required: true }, reason: { type: 'string', maxLen: 500 }, locale: { type: 'string', maxLen: 10 } });
    res.json({ entry: store.rollback(req, type, b.key, b) });
  }));
  v1.get(`${A}/preview_bundle`, can('content.write'), wrap((req, res) => { res.setHeader('Cache-Control', 'no-store'); res.type('application/json').send(bundle(true).body); }));
  v1.get(`${A}/preview_theme.css`, can('content.write'), wrap((req, res) => { res.setHeader('Cache-Control', 'no-store'); res.type('text/css').send(themeCss(true)); }));
  v1.post(`${A}/templates/preview`, can('content.write'), wrap((req, res) => {
    const b = body(req, { key: KEY, value: { type: 'object', nullable: true }, vars: { type: 'object', nullable: true } });
    const d = templates.definition(b.key); if (!d) throw new CmsError(404, 'not_found', 'unknown template');
    const ov = b.value ? templates.validate(b.key, b.value) : store.withDrafts('template').get(b.key) || null;
    const vars = { ...d.sample, ...(b.vars && typeof b.vars === 'object' ? Object.fromEntries(Object.entries(b.vars).filter(([k]) => d.vars.includes(k)).map(([k, v]) => [k, String(v).slice(0, 500)])) : {}) };
    const out = {};
    if (d.fields.some((f) => f.startsWith('email_'))) out.email = templates.renderEmail(b.key, vars, ov, store.withDrafts('template').get('email._layout'), { headerImage: mediaMap(true).email_header?.url || null });
    for (const f of d.fields) if (!f.startsWith('email_') || d.kind === 'layout') out[f] = templates.renderField(b.key, f, vars, ov);
    res.json({ preview: out, vars });
  }));
  v1.post(`${A}/templates/test_send`, can('content.write'), wrap(async (req, res) => {
    hit(sends, req);
    const b = body(req, { key: KEY, value: { type: 'object', nullable: true } });
    const d = templates.definition(b.key); if (!d) throw new CmsError(404, 'not_found', 'unknown template');
    const ov = b.value ? templates.validate(b.key, b.value) : store.withDrafts('template').get(b.key) || null;
    const messaging = app.locals.identity?.messaging;
    if (!messaging) throw new ApiError(503, 'unavailable', 'messaging is not available');
    const vars = { ...d.sample, app_name: appName() };
    const sent = [];
    if (d.fields.some((f) => f.startsWith('email_')) || d.kind === 'layout') {
      const key = d.kind === 'layout' ? 'notify._default' : b.key;
      const em = templates.renderEmail(key, d.kind === 'layout' ? { ...templates.definition(key).sample, app_name: appName() } : vars, d.kind === 'layout' ? tplOverride(key) : ov, d.kind === 'layout' ? ov : store.withDrafts('template').get('email._layout'), { headerImage: mediaMap(true).email_header?.url || null });
      await messaging.sendEmail({ userId: req.auth.user.id, to: req.auth.user.email, subject: `[Test] ${em.subject}`, text: em.text, html: em.html });
      sent.push('email');
    }
    if (d.fields.includes('sms')) {
      await messaging.sendSms({ userId: req.auth.user.id, to: '+00000000000', masked: 'test', body: `[Test] ${templates.renderField(b.key, 'sms', vars, ov)}`, kind: 'template_test' });
      sent.push('sms');
    }
    if (d.fields.includes('push_title') || d.fields.includes('inapp_title')) {
      const pf = d.fields.includes('inapp_title') ? 'inapp' : 'push';
      engine.emit('notification', req.auth.user.id, { id: newId('n_'), type: 'cms_test', title: `[Test] ${templates.renderField(b.key, `${pf}_title`, vars, ov)}`, body: templates.renderField(b.key, `${pf}_body`, vars, ov), link: '', read: false, created_time: nowIso(), quiet: false });
      sent.push(pf);
    }
    admin.audit(req, 'cms.template_test_send', 'cms.template', b.key, null, { channels: sent });
    res.json({ sent });
  }));
  v1.get(`${A}/export`, can('content.write'), wrap((req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="parlance-content-${nowIso().slice(0, 10)}.json"`);
    res.json(store.exportAll());
  }));
  v1.post(`${A}/import`, can('content.write'), wrap((req, res) => {
    hit(writes, req);
    const b = body(req, { data: { type: 'object', required: true }, dry_run: { type: 'boolean' }, reason: { type: 'string', maxLen: 500 } });
    const dry = b.dry_run !== false;
    if (!dry && !admin.rolesOf(req.auth.user).some((r) => r === 'admin' || r === 'publisher')) throw new ApiError(403, 'forbidden', 'forbidden', 'your role does not include content.publish');
    const r = store.importAll(req, b.data, { dryRun: dry, reason: b.reason });
    res.status(r.valid ? 200 : 400).json(r.valid ? r : { ...r, error: { code: 'validation_failed', message: 'the import file has invalid entries' } });
  }));

  // ---------------------------------------------------------------- scheduler (resumes after restart: state is in the DB)
  refreshServerTexts();
  const tick = () => { try { store.tick(); } catch (e) { console.error('cms tick', e); } };
  tick();
  const timer = setInterval(tick, options.tickMs ?? 1000);
  timer.unref?.();

  return { store, bundle, renderNotification, renderNotificationEmail, renderSystem, mountStatic, pwaConfig, pageTransform, pageOf, brand, mediaMap, close: () => clearInterval(timer), SLOTS, contrast };
}

module.exports = { mountCms, SLOTS, contrast, BRAND_DEFAULT };
