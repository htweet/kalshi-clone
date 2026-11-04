// Managed content in the SPA (CLONE_SPEC.md §32.4): the content bundle (texts, media slots, brand, footer), live
// updates over the public `content` WebSocket channel, and the staff-only preview mode.
//   - A publish anywhere reaches every open page: the bundle is refetched (ETag; usually 304) and the current route
//     re-rendered. Strings read once at module evaluation (ts()) need a reload; the page offers one.
//   - Preview mode (?cms_preview=1, staff only): the drafts bundle from /v1/admin/cms/preview_bundle replaces the
//     published one and a banner says so. The server answers that route only to content editors, so the mode cannot
//     show drafts to anyone else (the flag is dropped when the server refuses).
//   - Brand colours come from /v1/content/theme.css (a stylesheet: CSS custom properties, no inline styles).
import { setTexts, staticKeys, t, te, ts } from './i18n.js';
import { esc } from './lib.js';

const boot = (typeof self !== 'undefined' && self.__PLX_CONTENT__) || {};
let current = { media: boot.media || {}, brand: boot.brand || null, footer: boot.footer || null };
let etag = null;
let rerender = () => {};
const PREVIEW_KEY = 'plx-cms-preview';
const readPreview = () => { try { return sessionStorage.getItem(PREVIEW_KEY) === '1'; } catch { return false; } };
const writePreview = (on) => { try { if (on) sessionStorage.setItem(PREVIEW_KEY, '1'); else sessionStorage.removeItem(PREVIEW_KEY); } catch { /* storage unavailable */ } };
let previewOn = readPreview();
export const inPreview = () => previewOn;

// A media slot's image ({url, alt}) or null when the slot keeps its built-in artwork.
export const media = (slot) => current.media[slot] || null;
export const footerContent = () => current.footer;

function themeLink() {
  return document.getElementById('cms-theme');
}
function applyBrand() {
  const l = themeLink();
  if (!l) return;
  const href = previewOn ? `/v1/admin/cms/preview_theme.css?ts=${Date.now()}` : `/v1/content/theme.css?v=${encodeURIComponent((etag || '').replace(/"/g, ''))}`;
  if (l.getAttribute('href') !== href) l.setAttribute('href', href);
}

export function renderFooter() {
  const host = document.querySelector('footer.footer .container');
  const f = current.footer;
  if (!host || !f || !Array.isArray(f.columns)) return;
  const link = (l) => (l.href.startsWith('/') ? `<a href="${esc(l.href)}" data-link>${esc(l.label)}</a>` : `<a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`);
  host.innerHTML = `<span data-testid="footer-tagline">${esc(f.tagline || '')}</span><div class="footer-cols" data-testid="footer-cols">${f.columns.map((c) => `<div class="footer-col"><b>${esc(c.title)}</b>${c.links.map(link).join('')}</div>`).join('')}</div>`;
}

function previewBanner() {
  document.getElementById('cms-preview-banner')?.remove();
  if (!previewOn) return;
  const b = document.createElement('div');
  b.id = 'cms-preview-banner';
  b.className = 'banner cms-preview-banner';
  b.dataset.testid = 'cms-preview-banner';
  b.innerHTML = `<span>${te('content-live.preview_banner.preview_mode_you_are_seeing')}</span> <button type="button" class="btn btn-sm" data-testid="cms-preview-exit">${te('content-live.preview_banner.exit_preview')}</button>`;
  b.querySelector('button').onclick = () => { setPreview(false); };
  document.querySelector('main')?.before(b);
}

async function fetchBundle() {
  if (previewOn) {
    const r = await fetch('/v1/admin/cms/preview_bundle', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) { previewOn = false; writePreview(false); return fetchBundle(); }
    if (!r.ok) throw new Error(t('content-live.fetch_bundle.http', { status: r.status }));
    return r.json();
  }
  const r = await fetch('/v1/content/bundle', { credentials: 'same-origin', headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) } });
  if (r.status === 304) return null;
  if (!r.ok) throw new Error(t('content-live.fetch_bundle.http', { status: r.status }));
  etag = r.headers.get('ETag');
  return r.json();
}
function install(b) {
  setTexts(b.texts || {}, b.locale);
  current = { media: b.media || {}, brand: b.brand || null, footer: b.footer || null };
  applyBrand();
  renderFooter();
}

// Refetches and applies the bundle; `changed` lists the published entries.
export async function refresh(changed = []) {
  let b;
  try { b = await fetchBundle(); } catch { return; }
  if (!b) return;
  install(b);
  previewBanner();
  const stale = changed.some((c) => c.type === 'text' && staticKeys().has(c.key));
  if (stale) offerReload();
  rerender();
}
function offerReload() {
  if (document.querySelector('[data-testid=cms-reload]')) return;
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast pwa-update';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(t('content-live.offer_reload.content_was_updated'))}</span><button type="button" class="btn" data-testid="cms-reload">${esc(t('content-live.offer_reload.reload'))}</button>`;
  el.querySelector('button').onclick = () => location.reload();
  host.appendChild(el);
}

export function setPreview(on) {
  previewOn = !!on;
  writePreview(previewOn);
  etag = null;
  refresh();
  if (!previewOn) previewBanner();
}

// Called once by main.js. `socket` is the app WebSocket; `onChange` re-renders the current route.
export function initContent({ socket, onChange }) {
  rerender = onChange;
  const q = new URLSearchParams(location.search);
  if (q.get('cms_preview') === '1') { previewOn = true; writePreview(true); }
  if (q.get('cms_preview') === '0') { previewOn = false; writePreview(false); }
  renderFooter();
  applyBrand();
  if (previewOn) refresh(); else previewBanner();
  socket.subscribe({ channels: ['content'] }, (m) => {
    if (m.type !== 'content') return;
    const msg = m.msg || {};
    if (msg.preview && !previewOn) return; // a draft save: only preview pages care
    refresh(msg.changed || []);
  });
}
