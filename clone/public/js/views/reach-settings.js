// Account › Settings › Data and messages (PLAN P8.4 / P8.6, CLONE_SPEC.md §38.5, §38.7): data saver, SMS notifications
// (with the recorded consent; off always works) and the language. Each saves at once.
import { t, te } from '../i18n.js';
import '../content/reach-strings.js';
import { request } from '../api.js';
import { session } from '../store.js';
import { flagOn } from '../flags.js';
import { esc, toast } from '../lib.js';
import { setSaver, loadLocales, setLocale, lang } from '../locale.js';

export async function mountReachSettings(el) {
  const draw = async () => {
    const [{ reach: r }, loc] = await Promise.all([request('GET', `/v1/users/${encodeURIComponent(session.uid)}/reach`), loadLocales()]);
    const langs = loc.enabled ? loc.locales : [];
    el.innerHTML = `<h2>${te('reach.title')}</h2>
      ${r.data_saver_available ? `<div class="set-toggle" data-flag="data_saver"><div><strong>${te('reach.saver.label')}</strong><p class="faint">${te('reach.saver.hint')}</p></div>
        <label class="switch"><input type="checkbox" data-saver data-testid="toggle-data_saver" ${r.data_saver ? 'checked' : ''} aria-label="${te('reach.saver.label')}"><span aria-hidden="true"></span></label></div>` : ''}
      ${r.sms.available || r.sms.enabled ? `<div class="set-sms" data-testid="sms-settings" data-enabled="${r.sms.enabled ? '1' : '0'}"><strong>${te('reach.sms.label')}</strong>
        <p class="faint">${r.sms.enabled ? te('reach.sms.on', { time: esc(r.sms.consent_time ? new Date(r.sms.consent_time).toLocaleString() : '') }) : te('reach.sms.off', { per_day: esc(r.sms.per_day) })}</p>
        ${r.sms.enabled ? `<button class="btn" data-sms-off data-testid="sms-off">${te('reach.sms.turn_off')}</button>`
    : !r.sms.phone_verified ? `<p class="faint" data-testid="sms-phone-needed">${te('reach.sms.phone_needed')} <a href="/account/identity" data-link>${te('reach.sms.verify_phone')}</a></p>`
      : `<div class="set-disclosure" data-testid="sms-consent" data-version="${esc(r.sms.consent.version)}"><p>${esc(r.sms.consent.text)}</p></div>
          <label class="set-check"><input type="checkbox" data-sms-agree data-testid="sms-agree"> <span>${te('reach.sms.agree')}</span></label>
          <div class="form-error" role="alert" data-testid="sms-error"></div>
          <button class="btn btn-primary" data-sms-on data-testid="sms-on">${te('reach.sms.turn_on')}</button>`}</div>` : ''}
      ${langs.length > 1 && flagOn('i18n') ? `<label class="field set-lang"><span>${te('reach.language')}</span><select data-testid="settings-locale">${langs.map((l) => `<option value="${esc(l.code)}" lang="${esc(l.code)}"${l.code === lang() ? ' selected' : ''}>${esc(l.native_name)}</option>`).join('')}</select></label>` : ''}`;
    el.querySelector('[data-saver]')?.addEventListener('change', async (e) => { try { await setSaver(e.target.checked); toast(t(e.target.checked ? 'reach.saver.on_toast' : 'reach.saver.off_toast')); } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message, 'error'); } });
    el.querySelector('[data-sms-on]')?.addEventListener('click', async () => {
      const err = el.querySelector('[data-testid=sms-error]'); err.textContent = '';
      if (!el.querySelector('[data-sms-agree]').checked) { err.textContent = t('reach.sms.tick'); return; }
      try { await request('PUT', `/v1/users/${encodeURIComponent(session.uid)}/sms_notifications`, { enabled: true, consent_version: r.sms.consent.version }); toast(t('reach.sms.on_toast')); draw(); } catch (ex) { err.textContent = ex.message; }
    });
    el.querySelector('[data-sms-off]')?.addEventListener('click', async () => { try { await request('PUT', `/v1/users/${encodeURIComponent(session.uid)}/sms_notifications`, { enabled: false }); toast(t('reach.sms.off_toast')); draw(); } catch (ex) { toast(ex.message, 'error'); } });
    el.querySelector('[data-testid=settings-locale]')?.addEventListener('change', (e) => { setLocale(e.target.value).catch((ex) => toast(ex.message, 'error')); });
  };
  await draw();
}
