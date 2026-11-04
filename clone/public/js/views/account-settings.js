// Account › Settings (CLONE_SPEC §13.16, in the observed page order; CLONE_SPEC.md §25.8):
//   1. "Browse and manage markets by" Payout and odds / Shares and prices, with a live market-card preview
//   2. Connected apps (OAuth grants; empty until the public API of Phase 7 issues them)
//   3. Notifications — Phase 2's settings module, mounted here (views/notification-settings.js)
//   4. Marketing text messages: status, SMS disclosure, consent checkbox, "Opt in to marketing texts" / "No thanks"
//   5. Security notifications toggle (Phase 2's preference, mounted from the same module)
//   6. Theme System / Light / Dark + Accessible colors (red-green safe palette)
//   7. Trade mechanics toggles (live since Phase 5A, CLONE_SPEC.md §28.5–§28.6: flip sell, auto-sell prompt, order review, collateral return)
//   8. Market preview price type: Last traded price / Current buy price
// Every change is saved to the account at once (PUT /users/:uid/preferences) and applied app-wide.
import { t as T } from '../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { api } from '../api.js';
import { esc, toast, relTime, fmtDate, pxCents } from '../lib.js';
import { eventCard } from './components.js';

// Invented sample market for the live preview (not a real market).
const SAMPLE = { event_ticker: 'PREVIEW', series_ticker: 'PREVIEW', series_slug: 'preview', title: 'Will the sample harbor bridge open by June?', category: 'Science and Technology', series_title: 'Sample', dollar_volume: 125000, close_time: '2027-06-30T00:00:00Z', icon_color: '#4b3fe0',
  markets: [{ ticker: 'PREVIEW-YES', yes_sub_title: 'Opens by June', status: 'active', last_price_dollars: '0.4700', previous_price_dollars: '0.4500', yes_ask_dollars: '0.4800', no_ask_dollars: '0.5400', yes_bid_dollars: '0.4600', color_code: '#3a7bff' },
    { ticker: 'PREVIEW-NO', yes_sub_title: 'Opens later', status: 'active', last_price_dollars: '0.5300', previous_price_dollars: '0.5500', yes_ask_dollars: '0.5400', no_ask_dollars: '0.4800', yes_bid_dollars: '0.5200', color_code: '#ff4d5e' }] };

const radio = (name, value, label, cur, hint = '') => `<label class="set-radio"><input type="radio" name="${esc(name)}" value="${esc(value)}" ${cur === value ? 'checked' : ''} data-testid="${esc(name)}-${esc(value)}"><span><strong>${esc(label)}</strong>${hint ? `<small class="faint">${esc(hint)}</small>` : ''}</span></label>`;
const toggle = (key, label, hint, on, extra = '') => `<div class="set-toggle"><div><strong>${esc(label)}</strong><p class="faint">${esc(hint)}</p>${extra /* eslint-disable-line parlance/no-unescaped-html -- extra: static markup passed by callers in this file */}</div>
  <label class="switch"><input type="checkbox" data-pref="${esc(key)}" ${on ? 'checked' : ''} data-testid="toggle-${esc(key)}" aria-label="${esc(label)}"><span aria-hidden="true"></span></label></div>`;

export async function render(panel, { navigate }) {
  const [{ preferences: p, phase5 }, apps, consent] = await Promise.all([idApi.preferences(session.uid), idApi.connectedApps(session.uid), idApi.consent(session.uid)]);
  const later = (k) => (phase5.includes(k) ? '<span class="phase-tag" data-testid="phase5-tag">Saved now · takes effect in Phase 5</span>' : '');
  panel.innerHTML = `<div class="settings" data-testid="settings">
    <section class="card panel set-sec" data-testid="set-display" data-order="1"><h2>Browse and manage markets by</h2>
      <div class="set-display"><div class="set-radios">${radio('display_mode', 'payout', 'Payout and odds', p.display_mode, 'Multiplier and chance, e.g. 2.1x · 47%')}${radio('display_mode', 'shares', 'Shares and prices', p.display_mode, T('settings.shares_example', { price: pxCents(48) }))}</div>
      <div class="set-preview" data-testid="display-preview" aria-label="Preview"></div></div></section>

    <section class="card panel set-sec" data-testid="set-connected-apps" data-order="2"><h2>Connected apps</h2><p class="muted">Manage applications you have authorized to access your Parlance account.</p>
      <div data-apps>${apps.apps.length ? `<ul class="set-apps">${apps.apps.map((a) => `<li data-testid="connected-app" data-app="${esc(a.id)}"><div><strong>${esc(a.name)}</strong><div class="faint">${esc(a.scopes.join(', ') || 'read')} · authorized ${esc(relTime(a.authorized_time))}</div></div><button class="btn btn-sm" data-revoke="${esc(a.id)}" data-testid="app-revoke">Remove access</button></li>`).join('')}</ul>`
    : '<p class="faint" data-testid="connected-apps-empty">No connected apps. Apps you authorize through the Parlance API (coming in Phase 7) appear here.</p>'}</div></section>

    <section class="card panel set-sec" data-testid="set-notifications" data-order="3"><div data-notif-settings><p class="faint">Loading…</p></div></section>

    <section class="card panel set-sec" data-testid="set-marketing" data-order="4"><h2>Marketing text messages</h2><div data-consent></div></section>

    <section class="card panel set-sec" data-testid="set-security-notifications" data-order="5"><h2>Security notifications</h2><div data-security-setting></div></section>

    <section class="card panel set-sec" data-testid="set-theme" data-order="6"><h2>Theme</h2>
      <div class="set-radios">${radio('theme', 'system', 'System', p.theme, 'Match your device')}${radio('theme', 'light', 'Light', p.theme)}${radio('theme', 'dark', 'Dark', p.theme)}</div>
      ${toggle('accessible_colors', 'Accessible colors', 'Best for red-green color blindness: Yes is blue and No is orange everywhere.', p.accessible_colors)}</section>

    <section class="card panel set-sec" data-testid="set-trade-mechanics" data-order="7"><h2>Trade mechanics</h2>
      ${toggle('trade_flip_sell', 'Flip sell', 'Sell more shares than you own to buy the other side.', p.trade_flip_sell, later('trade_flip_sell'))}
      ${toggle('trade_auto_sell_prompt', 'Auto-sell prompt after buy', 'After a fill, offer to place an automatic sell at a target price.', p.trade_auto_sell_prompt, later('trade_auto_sell_prompt'))}
      ${toggle('trade_skip_review', 'Skip order review', 'Place orders immediately unless a warning or a required step needs your attention.', p.trade_skip_review, later('trade_skip_review'))}
      ${toggle('trade_collateral_return', 'Collateral return', 'Get cash back early for hedged positions on mutually exclusive outcomes.', p.trade_collateral_return, later('trade_collateral_return'))}
      ${toggle('rfq_enabled', 'Create and respond to “Request for quotes”', 'Ask market makers for a price on combos and large orders, and answer other traders’ requests.', p.rfq_enabled, '<a class="c-brand" href="/support/help-center" data-link>RFQ terms</a>')}
      <div class="set-toggle"><div><strong>Advanced shard settings ›</strong><p class="faint">Balance management and transfers between exchange shards arrive with the multi-instance architecture (Phase 9).</p></div></div></section>

    <section class="card panel set-sec" data-testid="set-price-type" data-order="8"><h2>Market preview price type</h2><p class="muted">The price shown for markets on the home page and in your portfolio.</p>
      <div class="set-radios">${radio('market_price_type', 'last_traded', 'Last traded price', p.market_price_type)}${radio('market_price_type', 'current_buy', 'Current buy price', p.market_price_type, 'The best price to buy right now')}</div></section>
  </div>`;

  const save = async (prefs) => {
    try { await session.setPreferences(prefs); toast('Saved'); drawPreview(); } catch (ex) { toast(ex.message, 'error'); }
  };
  const drawPreview = () => { panel.querySelector('[data-testid=display-preview]').innerHTML = eventCard(SAMPLE); };
  drawPreview();
  for (const r of panel.querySelectorAll('input[type=radio]')) r.onchange = () => { if (r.checked) save({ [r.name]: r.value }); };
  for (const c of panel.querySelectorAll('[data-pref]')) {
    c.onchange = async () => {
      await save({ [c.dataset.pref]: c.checked });
      // Collateral return re-derives at once: on releases what hedged positions guarantee, off stops new releases.
      if (c.dataset.pref === 'trade_collateral_return') api.refreshCollateral(session.uid).catch(() => {});
    };
  }
  panel.querySelector('[data-testid=display-preview]').addEventListener('click', (e) => { if (e.target.closest('a')) { e.preventDefault(); e.stopPropagation(); } }, true); // preview only
  for (const b of panel.querySelectorAll('[data-revoke]')) {
    b.onclick = async () => { await idApi.revokeApp(session.uid, b.dataset.revoke); toast('Access removed'); render(panel, { navigate }); };
  }
  drawConsent(panel.querySelector('[data-consent]'), consent);
  mountNotifications(panel.querySelector('[data-notif-settings]'), panel.querySelector('[data-security-setting]'));
}

// Phase 2 owns the notification matrix and the security-notifications preference; this page mounts its exported module
// in the observed positions (§13.16 items 3 and 5).
async function mountNotifications(el, securityEl) {
  let m = null;
  try { m = await import('./notification-settings.js'); } catch { /* not installed */ }
  if (m && typeof m.mountNotificationSettings === 'function') await m.mountNotificationSettings(el);
  else el.innerHTML = '<h2>Notifications</h2><p class="faint" data-testid="notifications-pending">Notification preferences are part of Phase 2 and appear here once that module is installed.</p>';
  if (m && typeof m.mountSecurityNotificationSetting === 'function') m.mountSecurityNotificationSetting(securityEl);
  else securityEl.innerHTML = '<p class="faint">Notifications for all sensitive actions on your account. Managed with the notification preferences (Phase 2).</p>';
}

function drawConsent(el, c) {
  const status = c.opted_in ? `You’re opted in to marketing texts${c.phone_last4 ? ` at the number ending ${c.phone_last4}` : ''} since ${fmtDate(c.consented_time)}.`
    : c.status === 'reconsent_required' ? 'Our marketing-text terms changed. Opt in again to keep receiving them.'
      : c.status === 'opted_out' ? `You opted out of marketing texts on ${fmtDate(c.revoked_time)}.` : 'You’re not receiving marketing texts.';
  el.innerHTML = `<p data-testid="consent-status" data-status="${esc(c.status)}">${esc(status)}</p>
    <div class="set-disclosure" data-testid="sms-disclosure" data-version="${esc(c.disclosure.version)}"><strong>SMS marketing disclosure</strong><p>${esc(c.disclosure.text)}</p><small class="faint">Version ${esc(c.disclosure.version)}</small></div>
    ${c.opted_in ? '<div class="ob-actions"><button class="btn" data-optout data-testid="consent-optout">Opt out of marketing texts</button></div>'
    : `<label class="set-check"><input type="checkbox" data-agree data-testid="consent-agree"> <span>I agree to receive marketing text messages as described above.</span></label>
      <div class="form-error" role="alert" data-testid="consent-error"></div>
      <div class="ob-actions"><button class="btn btn-primary" data-optin data-testid="consent-optin">Opt in to marketing texts</button><button class="btn btn-ghost" data-nothanks data-testid="consent-no-thanks">No thanks</button></div>`}`;
  const err = el.querySelector('[data-testid=consent-error]');
  el.querySelector('[data-optin]')?.addEventListener('click', async () => {
    err.textContent = '';
    if (!el.querySelector('[data-agree]').checked) { err.textContent = 'Tick the box to agree to the disclosure first.'; return; }
    try { drawConsent(el, await idApi.setConsent(session.uid, { opt_in: true, agreed: true, text_version: c.disclosure.version })); toast('Marketing texts on'); } catch (ex) { err.textContent = ex.code === 'phone_required' ? 'Verify a mobile number first (identity verification asks for it).' : ex.message; }
  });
  el.querySelector('[data-nothanks]')?.addEventListener('click', async () => { drawConsent(el, await idApi.setConsent(session.uid, { opt_in: false })); toast('No marketing texts'); });
  el.querySelector('[data-optout]')?.addEventListener('click', async () => { drawConsent(el, await idApi.setConsent(session.uid, { opt_in: false })); toast('Marketing texts off'); });
}
