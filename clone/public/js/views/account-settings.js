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
import { t as tx, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/account-settings-strings.js';
import { t as T } from '../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { api } from '../api.js';
import { esc, toast, relTime, fmtDate, pxCents } from '../lib.js';
import { eventCard } from './components.js';

// Invented sample market for the live preview (not a real market).
const SAMPLE = { event_ticker: 'PREVIEW', series_ticker: 'PREVIEW', series_slug: 'preview', title: ts('account-settings.sample_title.will_the_sample_harbor_bridge'), category: 'Science and Technology', series_title: 'Sample', dollar_volume: 125000, close_time: '2027-06-30T00:00:00Z', icon_color: '#4b3fe0',
  markets: [{ ticker: 'PREVIEW-YES', yes_sub_title: ts('account-settings.sample_markets_yes_sub_title.opens_by_june'), status: 'active', last_price_dollars: '0.4700', previous_price_dollars: '0.4500', yes_ask_dollars: '0.4800', no_ask_dollars: '0.5400', yes_bid_dollars: '0.4600', color_code: '#3a7bff' },
    { ticker: 'PREVIEW-NO', yes_sub_title: ts('account-settings.sample_markets_yes_sub_title.opens_later'), status: 'active', last_price_dollars: '0.5300', previous_price_dollars: '0.5500', yes_ask_dollars: '0.5400', no_ask_dollars: '0.4800', yes_bid_dollars: '0.5200', color_code: '#ff4d5e' }] };

const radio = (name, value, label, cur, hint = '') => `<label class="set-radio"><input type="radio" name="${esc(name)}" value="${esc(value)}" ${cur === value ? 'checked' : ''} data-testid="${esc(name)}-${esc(value)}"><span><strong>${esc(label)}</strong>${hint ? `<small class="faint">${esc(hint)}</small>` : ''}</span></label>`;
const toggle = (key, label, hint, on, extra = '') => `<div class="set-toggle"><div><strong>${esc(label)}</strong><p class="faint">${esc(hint)}</p>${extra /* eslint-disable-line parlance/no-unescaped-html -- extra: static markup passed by callers in this file */}</div>
  <label class="switch"><input type="checkbox" data-pref="${esc(key)}" ${on ? 'checked' : ''} data-testid="toggle-${esc(key)}" aria-label="${esc(label)}"><span aria-hidden="true"></span></label></div>`;

export async function render(panel, { navigate }) {
  const [{ preferences: p, phase5 }, apps, consent] = await Promise.all([idApi.preferences(session.uid), idApi.connectedApps(session.uid), idApi.consent(session.uid)]);
  const later = (k) => (phase5.includes(k) ? `<span class="phase-tag" data-testid="phase5-tag">${te('account-settings.render.saved_now_takes_effect_in')}</span>` : '');
  panel.innerHTML = `<div class="settings" data-testid="settings">
    <section class="card panel set-sec" data-testid="set-display" data-order="1"><h2>${te('account-settings.render.browse_and_manage_markets_by')}</h2>
      <div class="set-display"><div class="set-radios">${radio('display_mode', 'payout', tx('account-settings.render.payout_and_odds'), p.display_mode, tx('account-settings.render.multiplier_and_chance_e_g'))}${radio('display_mode', 'shares', tx('account-settings.render.shares_and_prices'), p.display_mode, T('settings.shares_example', { price: pxCents(48) }))}</div>
      <div class="set-preview" data-testid="display-preview" aria-label="${te('account-settings.render.preview')}"></div></div></section>

    <section class="card panel set-sec" data-testid="set-connected-apps" data-order="2"><h2>${te('account-settings.render.connected_apps')}</h2><p class="muted">${te('account-settings.render.manage_applications_you_have_authorized')}</p>
      <div data-apps>${apps.apps.length ? `<ul class="set-apps">${apps.apps.map((a) => `<li data-testid="connected-app" data-app="${esc(a.id)}"><div><strong>${esc(a.name)}</strong><div class="faint">${te('account-settings.render.authorized', { value: esc(a.scopes.join(', ') || 'read'), rel_time: esc(relTime(a.authorized_time)) })}</div></div><button class="btn btn-sm" data-revoke="${esc(a.id)}" data-testid="app-revoke">${te('account-settings.render.remove_access')}</button></li>`).join('')}</ul>`
    : `<p class="faint" data-testid="connected-apps-empty">${te('account-settings.render.no_connected_apps_apps_you')}</p>`}</div></section>

    <section class="card panel set-sec" data-testid="set-notifications" data-order="3"><div data-notif-settings><p class="faint">${te('account-settings.render.loading')}</p></div></section>

    <section class="card panel set-sec" data-testid="set-marketing" data-order="4"><h2>${te('account-settings.render.marketing_text_messages')}</h2><div data-consent></div></section>

    <section class="card panel set-sec" data-testid="set-security-notifications" data-order="5"><h2>${te('account-settings.render.security_notifications')}</h2><div data-security-setting></div></section>

    <section class="card panel set-sec" data-testid="set-theme" data-order="6"><h2>${te('account-settings.render.theme')}</h2>
      <div class="set-radios">${radio('theme', 'system', tx('account-settings.render.system'), p.theme, tx('account-settings.render.match_your_device'))}${radio('theme', 'light', tx('account-settings.render.light'), p.theme)}${radio('theme', 'dark', tx('account-settings.render.dark'), p.theme)}</div>
      ${toggle('accessible_colors', tx('account-settings.render.accessible_colors'), tx('account-settings.render.best_for_red_green_color'), p.accessible_colors)}</section>

    <section class="card panel set-sec" data-testid="set-trade-mechanics" data-order="7"><h2>${te('account-settings.render.trade_mechanics')}</h2>
      ${toggle('trade_flip_sell', tx('account-settings.render.flip_sell'), tx('account-settings.render.sell_more_shares_than_you'), p.trade_flip_sell, later('trade_flip_sell'))}
      ${toggle('trade_auto_sell_prompt', tx('account-settings.render.auto_sell_prompt_after_buy'), tx('account-settings.render.after_a_fill_offer_to'), p.trade_auto_sell_prompt, later('trade_auto_sell_prompt'))}
      ${toggle('trade_skip_review', tx('account-settings.render.skip_order_review'), tx('account-settings.render.place_orders_immediately_unless_a'), p.trade_skip_review, later('trade_skip_review'))}
      ${toggle('trade_collateral_return', tx('account-settings.render.collateral_return'), tx('account-settings.render.get_cash_back_early_for'), p.trade_collateral_return, later('trade_collateral_return'))}
      ${toggle('rfq_enabled', tx('account-settings.render.create_and_respond_to_request'), tx('account-settings.render.ask_market_makers_for_a'), p.rfq_enabled, `<a class="c-brand" href="/support/help-center" data-link>${te('account-settings.render.rfq_terms')}</a>`)}
      <div class="set-toggle"><div><strong>${te('account-settings.render.advanced_shard_settings')}</strong><p class="faint">${te('account-settings.render.balance_management_and_transfers_between')}</p></div></div></section>

    <section class="card panel set-sec" data-testid="set-price-type" data-order="8"><h2>${te('account-settings.render.market_preview_price_type')}</h2><p class="muted">${te('account-settings.render.the_price_shown_for_markets')}</p>
      <div class="set-radios">${radio('market_price_type', 'last_traded', tx('account-settings.render.last_traded_price'), p.market_price_type)}${radio('market_price_type', 'current_buy', tx('account-settings.render.current_buy_price'), p.market_price_type, tx('account-settings.render.the_best_price_to_buy'))}</div></section>
  </div>`;

  const save = async (prefs) => {
    try { await session.setPreferences(prefs); toast(tx('account-settings.render.saved')); drawPreview(); } catch (ex) { toast(ex.message, 'error'); }
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
    b.onclick = async () => { await idApi.revokeApp(session.uid, b.dataset.revoke); toast(tx('account-settings.render.access_removed')); render(panel, { navigate }); };
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
  else el.innerHTML = `<h2>${te('account-settings.mount_notifications.notifications')}</h2><p class="faint" data-testid="notifications-pending">${te('account-settings.mount_notifications.notification_preferences_are_part_of')}</p>`;
  if (m && typeof m.mountSecurityNotificationSetting === 'function') m.mountSecurityNotificationSetting(securityEl);
  else securityEl.innerHTML = `<p class="faint">${te('account-settings.mount_notifications.notifications_for_all_sensitive_actions')}</p>`;
}

function drawConsent(el, c) {
  const status = c.opted_in ? tx('account-settings.draw_consent.you_re_opted_in_to', { value: c.phone_last4 ? (' ' + tx('account-settings.draw_consent.at_the_number_ending', { phone_last4: c.phone_last4 })) : '', fmt_date: fmtDate(c.consented_time) })
    : c.status === 'reconsent_required' ? tx('account-settings.draw_consent.our_marketing_text_terms_changed')
      : c.status === 'opted_out' ? tx('account-settings.draw_consent.you_opted_out_of_marketing', { fmt_date: fmtDate(c.revoked_time) }) : tx('account-settings.draw_consent.you_re_not_receiving_marketing');
  el.innerHTML = `<p data-testid="consent-status" data-status="${esc(c.status)}">${esc(status)}</p>
    <div class="set-disclosure" data-testid="sms-disclosure" data-version="${esc(c.disclosure.version)}"><strong>${te('account-settings.draw_consent.sms_marketing_disclosure')}</strong><p>${esc(c.disclosure.text)}</p><small class="faint">${te('account-settings.draw_consent.version', { version: esc(c.disclosure.version) })}</small></div>
    ${c.opted_in ? `<div class="ob-actions"><button class="btn" data-optout data-testid="consent-optout">${te('account-settings.draw_consent.opt_out_of_marketing_texts')}</button></div>`
    : `<label class="set-check"><input type="checkbox" data-agree data-testid="consent-agree"> <span>${te('account-settings.draw_consent.i_agree_to_receive_marketing')}</span></label>
      <div class="form-error" role="alert" data-testid="consent-error"></div>
      <div class="ob-actions"><button class="btn btn-primary" data-optin data-testid="consent-optin">${te('account-settings.draw_consent.opt_in_to_marketing_texts')}</button><button class="btn btn-ghost" data-nothanks data-testid="consent-no-thanks">${te('account-settings.draw_consent.no_thanks')}</button></div>`}`;
  const err = el.querySelector('[data-testid=consent-error]');
  el.querySelector('[data-optin]')?.addEventListener('click', async () => {
    err.textContent = '';
    if (!el.querySelector('[data-agree]').checked) { err.textContent = tx('account-settings.draw_consent.tick_the_box_to_agree'); return; }
    try { drawConsent(el, await idApi.setConsent(session.uid, { opt_in: true, agreed: true, text_version: c.disclosure.version })); toast(tx('account-settings.draw_consent.marketing_texts_on')); } catch (ex) { err.textContent = ex.code === 'phone_required' ? tx('account-settings.draw_consent.verify_a_mobile_number_first') : ex.message; }
  });
  el.querySelector('[data-nothanks]')?.addEventListener('click', async () => { drawConsent(el, await idApi.setConsent(session.uid, { opt_in: false })); toast(tx('account-settings.draw_consent.no_marketing_texts')); });
  el.querySelector('[data-optout]')?.addEventListener('click', async () => { drawConsent(el, await idApi.setConsent(session.uid, { opt_in: false })); toast(tx('account-settings.draw_consent.marketing_texts_off')); });
}
