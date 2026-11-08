// Languages and data saver on the client (PLAN P8.4 / P8.6, CLONE_SPEC.md §38.5, §38.7).
//   Language   the server picks the bundle of the visitor's language (account setting, else the `plx_locale` cookie;
//              enabled languages only) and sets <html lang dir>. The footer switcher lists the enabled languages; a
//              choice is saved on the account (signed in) and in the cookie (everyone), then the page reloads so every
//              string, including the ones read when modules load, is in the new language.
//   Intl       numbers, dates and plurals follow <html lang> (Intl.NumberFormat / DateTimeFormat / PluralRules, with
//              English as the fallback for a language the browser's Intl does not know). Money keeps the display
//              currency's own format (§30).
//   Data saver the member's setting (server) or this browser's choice (guests), else the admin default (owner setting
//              `data_saver.default_on`), while the `data_saver` flag is on. Sets <html data-saver="1">: CSS and the
//              modules lighten the page (no promo art, batched ticks, polling fallback in ws.js, no autoplay).
import { t, te, hasText } from './i18n.js';
import './content/locale-strings.js';
import { request } from './api.js';
import { session } from './store.js';
import { flagOn, ownerSetting, onFlags } from './flags.js';
import { onFooter } from './content-live.js';
import { esc, toast } from './lib.js';

export const lang = () => (typeof document !== 'undefined' && document.documentElement.lang) || 'en-NG';
const intlLang = () => { const l = lang(); try { return Intl.PluralRules.supportedLocalesOf([l]).length ? l : 'en'; } catch { return 'en'; } };
export const pluralRule = (n) => { try { return new Intl.PluralRules(intlLang()).select(Number(n)); } catch { return Number(n) === 1 ? 'one' : 'other'; } };
// Plural text: `<base>.<rule>` (one, other, few, many, two, zero per the language), falling back to `<base>.other`.
export function tp(base, n, vars = {}) {
  const k = `${base}.${pluralRule(n)}`;
  return t(hasText(k) ? k : `${base}.other`, { count: fmtNumber(n), ...vars });
}
export const fmtNumber = (n, opts = {}) => { try { return new Intl.NumberFormat(intlLang(), opts).format(Number(n)); } catch { return String(n); } };
export const fmtDate = (d, opts = { dateStyle: 'medium' }) => { try { return new Intl.DateTimeFormat(intlLang(), opts).format(new Date(d)); } catch { return String(d); } };

const COOKIE = 'plx_locale';
let locales = { enabled: false, locales: [], current: 'en-NG' };
export async function loadLocales() {
  try { locales = await request('GET', '/v1/i18n/locales'); } catch { /* keep the last list */ }
  return locales;
}
export async function setLocale(code) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${encodeURIComponent(code)}; Path=/; Max-Age=${365 * 86400}; SameSite=Lax${secure}`;
  if (session.user) await request('PUT', `/v1/users/${encodeURIComponent(session.uid)}/locale`, { locale: code });
  location.reload();
}

// ---------------------------------------------------------------- data saver
const SAVER_KEY = 'plx-data-saver';
let memberSaver = null; // the account's saved choice (null: not loaded / guest)
const guestSaver = () => { try { const v = localStorage.getItem(SAVER_KEY); return v === '1' ? true : v === '0' ? false : null; } catch { return null; } };
export function saverOn() {
  if (!flagOn('data_saver')) return false;
  const own = session.user ? memberSaver : guestSaver();
  return own != null ? own : !!ownerSetting('data_saver.default_on', false);
}
export function applySaver() { document.documentElement.dataset.saver = saverOn() ? '1' : '0'; }
export async function loadMemberSaver() {
  memberSaver = null;
  if (session.user) { try { memberSaver = (await request('GET', `/v1/users/${encodeURIComponent(session.uid)}/reach`)).reach.data_saver; } catch { memberSaver = null; } }
  applySaver();
}
export async function setSaver(on) {
  if (session.user) { const r = await request('PUT', `/v1/users/${encodeURIComponent(session.uid)}/data_saver`, { enabled: !!on }); memberSaver = r.reach.data_saver; } else { try { localStorage.setItem(SAVER_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ } }
  applySaver();
  window.dispatchEvent(new CustomEvent('parlance:data-saver', { detail: { on: saverOn() } }));
}

// ---------------------------------------------------------------- footer tools
function toolsHtml() {
  const list = locales.enabled && flagOn('i18n') ? locales.locales : [];
  const sel = list.length > 1 ? `<label class="footer-tool" data-flag="i18n"><span>${te('locale.footer.language')}</span><select data-testid="locale-select" aria-label="${te('locale.footer.language')}">${list.map((l) => `<option value="${esc(l.code)}" lang="${esc(l.code)}"${l.code === lang() ? ' selected' : ''}>${esc(l.native_name)}${l.native_name !== l.name ? ` · ${esc(l.name)}` : ''}</option>`).join('')}</select></label>` : '';
  const saver = flagOn('data_saver') ? `<label class="footer-tool switch-row" data-flag="data_saver"><input type="checkbox" data-testid="saver-toggle"${saverOn() ? ' checked' : ''}><span>${te('locale.footer.data_saver')}</span></label>` : '';
  return sel + saver;
}
function drawTools(el) {
  if (!el) return;
  el.innerHTML = toolsHtml();
  const s = el.querySelector('[data-testid=locale-select]');
  if (s) s.onchange = () => { setLocale(s.value).catch((e) => toast(e.message, 'error')); };
  const v = el.querySelector('[data-testid=saver-toggle]');
  if (v) v.onchange = () => { setSaver(v.checked).then(() => toast(v.checked ? t('locale.saver.on') : t('locale.saver.off'))).catch((e) => { v.checked = !v.checked; toast(e.message, 'error'); }); };
}
export function initLocale() {
  // ?ref=<code> (a referral link): kept in a first-party cookie for 30 days; read by the server at sign-up (§38.2).
  try {
    const ref = new URLSearchParams(location.search).get('ref');
    if (ref && /^[A-Za-z0-9]{6,16}$/.test(ref)) document.cookie = `plx_ref=${ref.toUpperCase()}; Path=/; Max-Age=${30 * 86400}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  } catch { /* ignore */ }
  applySaver();
  const redraw = () => drawTools(document.querySelector('footer.footer .footer-tools'));
  onFooter(drawTools);
  loadLocales().then(redraw);
  // A flag change redraws the footer tools at once (a switched-off tool disappears with the change), then again once the
  // language list has been re-read.
  onFlags(() => { applySaver(); redraw(); loadLocales().then(redraw); });
  let lastUid;
  session.subscribe(() => { if (!session.loaded) return; const uid = session.uid || null; if (uid !== lastUid) { lastUid = uid; loadMemberSaver().then(redraw); } });
  window.addEventListener('parlance:data-saver', redraw);
}
// Called once the first flag bundle has arrived (main.js boot): the admin default (owner setting data_saver.default_on)
// and the flags are only known from then on, so a visitor who arrives while the default is on gets the lighter pages.
export function flagsReady() {
  applySaver();
  drawTools(document.querySelector('footer.footer .footer-tools'));
}
