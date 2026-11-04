// Settings › Notifications (CLONE_SPEC §13.16 item 3; PLAN §11 A6; CLONE_SPEC.md §24.5).
//
// mountNotificationSettings(el) renders the module into any container: the Phase 3 /account/settings page includes it,
// and /notifications/settings shows it on its own. Collapsible groups (General, Predictions, Sports, Social,
// Promotional); each type has channel pills In-app · Email · Push (filled = on), only for the channels that type offers;
// ⌄ opens sub-options (price-move threshold and window, every fill vs order complete, auto-cancel reasons, sports
// moments). Below: quiet hours, push in this browser (in-page pop-ups while Parlance is open, and system notifications
// through Web Push with the list of subscribed devices, CLONE_SPEC.md §31), and the recent email / push deliveries.
// mountSecurityNotificationSetting(el) is the separate "Security notifications" toggle (§13.16 item 5).
// Every value comes from GET /v1/users/:uid/notifications/preferences and every change is saved server-side.
import { api } from '../api.js';
import { session } from '../store.js';
import { esc, toast, relTime } from '../lib.js';
import { webPushSupported, enableWebPush, disableWebPush, thisDevice } from '../pwa.js';
import { t } from '../content/pwa-strings.js'; // System notifications text is keyed (CLONE_SPEC §31.12)

const CH_LABEL = { in_app: 'In-app', email: 'Email', push: 'Push' };
const PUSH_KEY = 'plx-push-device';
const deviceId = () => { try { return localStorage.getItem(PUSH_KEY); } catch { return null; } };
const setDeviceId = (v) => { try { if (v) localStorage.setItem(PUSH_KEY, v); else localStorage.removeItem(PUSH_KEY); } catch { /* storage unavailable */ } };
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();

function pill(t, ch) {
  const on = !!t.channels[ch];
  return `<button type="button" class="ch-pill${on ? ' on' : ''}" aria-pressed="${on}" data-type="${esc(t.type)}" data-channel="${esc(ch)}" data-testid="pill-${esc(t.type)}-${esc(ch)}" aria-label="${esc(t.label)}: ${esc(CH_LABEL[ch])} ${on ? 'on' : 'off'}">${esc(CH_LABEL[ch])}</button>`;
}
function optionField(t, o) {
  const v = t.options[o.key];
  const id = `opt-${t.type}-${o.key}`;
  if (o.kind === 'bool') return `<label class="opt-row" for="${esc(id)}"><input type="checkbox" id="${esc(id)}" data-opt="${esc(o.key)}" ${v ? 'checked' : ''}> ${esc(o.label)}</label>`;
  if (o.kind === 'int') return `<label class="opt-row" for="${esc(id)}">${esc(o.label)} <input type="number" id="${esc(id)}" data-opt="${esc(o.key)}" min="${esc(o.min)}" max="${esc(o.max)}" value="${esc(v)}" class="opt-num" data-testid="${esc(id)}"></label>`;
  const label = (x) => (o.labels && o.labels[x]) || (o.key === 'window_minutes' ? (x >= 60 ? `${x / 60} hour${x === 60 ? '' : 's'}` : `${x} minutes`) : String(x));
  return `<label class="opt-row" for="${esc(id)}">${esc(o.label)} <select id="${esc(id)}" data-opt="${esc(o.key)}" data-testid="${esc(id)}">${o.values.map((x) => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(label(x))}</option>`).join('')}</select></label>`;
}
function typeRow(t) {
  return `<div class="nt-row" data-row="${esc(t.type)}" data-testid="nt-${esc(t.type)}">
    <div class="nt-main"><span class="nt-label">${esc(t.label)}</span>${t.option_spec ? `<button type="button" class="nt-more" data-more="${esc(t.type)}" aria-expanded="false" aria-label="${esc(t.label)} options" data-testid="more-${esc(t.type)}">⌄</button>` : ''}
      <span class="grow"></span><span class="nt-pills">${t.offered.map((ch) => pill(t, ch)).join('')}</span></div>
    ${t.option_spec ? `<form class="nt-opts" data-opts="${esc(t.type)}" hidden>${t.option_spec.map((o) => optionField(t, o)).join('')}<button class="btn btn-sm" type="submit" data-testid="save-${esc(t.type)}">Save</button></form>` : ''}
  </div>`;
}

export function mountNotificationSettings(el) {
  if (!session.user) { el.innerHTML = '<div class="card empty"><a href="/sign-in?next=/notifications/settings" data-link class="c-brand">Log in</a> to manage notifications.</div>'; return () => {}; }
  let prefs = null; let gone = false;
  const openGroups = new Set(['general', 'predictions']); // kept across re-renders after each save
  const root = document.createElement('section');
  root.className = 'notif-settings';
  root.dataset.testid = 'notification-settings';
  el.replaceChildren(root);
  root.innerHTML = '<div class="faint">Loading notification settings…</div>';

  function draw() {
    const p = prefs;
    const q = p.quiet_hours;
    const dev = deviceId();
    root.innerHTML = `<div class="ns-head"><h2 class="m-0">Notifications <span class="info" title="Choose where each kind of notification reaches you. Filled pills are on." aria-hidden="true">ⓘ</span></h2></div>
      ${p.groups.map((g) => `<details class="card nt-group" data-group="${esc(g.key)}" data-testid="group-${esc(g.key)}" ${openGroups.has(g.key) ? 'open' : ''}><summary><b>${esc(g.label)}</b><span class="faint">${g.types.length} type${g.types.length === 1 ? '' : 's'}</span></summary>${g.types.map(typeRow).join('')}</details>`).join('')}
      <div class="card ns-card" data-testid="quiet-hours"><h3>Quiet hours</h3><p class="faint m-0">Email and push wait until quiet hours end; in-app notifications are kept without a pop-up.${p.in_quiet_hours ? ' <b data-testid="quiet-now">Quiet hours are on now.</b>' : ''}</p>
        <form class="quiet-form" data-quiet><label class="opt-row"><input type="checkbox" name="enabled" data-testid="quiet-enabled" ${q.enabled ? 'checked' : ''}> Pause email and push</label>
          <label class="opt-row">From <input type="time" name="start" value="${esc(q.start)}" required data-testid="quiet-start"></label><label class="opt-row">to <input type="time" name="end" value="${esc(q.end)}" required data-testid="quiet-end"></label>
          <label class="opt-row">Time zone <input name="timezone" value="${esc(q.timezone)}" maxlength="64" data-testid="quiet-tz" list="tz-list"></label><datalist id="tz-list"><option value="${esc(TZ)}"><option value="UTC"></datalist>
          <button class="btn btn-sm" type="submit" data-testid="quiet-save">Save quiet hours</button><span class="form-error" data-err role="alert"></span></form></div>
      <div class="card ns-card" data-testid="push-browser"><h3>Push in this browser</h3>
        <p class="faint m-0">Push notifications go to the browsers you register here. ${p.push_devices ? `${esc(p.push_devices)} browser${p.push_devices === 1 ? '' : 's'} registered.` : 'No browser is registered, so push notifications are recorded but not shown.'}</p>
        <div class="d-flex gap-8 ai-center fw-wrap mt-8">${dev ? '<span data-testid="push-on">This browser receives push notifications.</span><button class="btn btn-sm" type="button" data-push-off data-testid="push-off">Stop in this browser</button>' : '<button class="btn btn-sm btn-primary" type="button" data-push-on data-testid="push-enable">Turn on in this browser</button>'}</div>
        <div class="webpush" data-testid="webpush"><h4>${esc(t('push.section_title'))}</h4><p class="faint m-0">${esc(t('push.section_intro'))}</p>
          <div class="d-flex gap-8 ai-center fw-wrap mt-8" data-webpush-actions></div><ul class="webpush-list" data-webpush-list data-testid="webpush-devices"></ul></div></div>
      <div class="card ns-card"><h3>Recent email and push deliveries</h3><div data-deliveries class="faint">Loading…</div></div>`;
    loadDeliveries();
    loadWebPush();
  }
  async function loadWebPush() {
    const box = root.querySelector('[data-webpush-actions]'); const list = root.querySelector('[data-webpush-list]');
    if (!box) return;
    const mine = thisDevice();
    box.innerHTML = !webPushSupported() ? `<span class="faint" data-testid="webpush-unsupported">${esc(t('push.unsupported'))}</span>`
      : mine ? `<span data-testid="webpush-on">${esc(t('push.on'))}</span><button class="btn btn-sm" type="button" data-webpush-off data-testid="webpush-disable">${esc(t('push.turn_off'))}</button>`
        : `<button class="btn btn-sm btn-primary" type="button" data-webpush-on data-testid="webpush-enable">${esc(t('push.turn_on'))}</button>`;
    try {
      const { subscriptions } = await api.pushSubscriptions(session.uid);
      if (gone || !list.isConnected) return;
      const when = (x) => (x ? relTime(x) : t('push.never'));
      list.innerHTML = subscriptions.length ? subscriptions.map((s) => `<li class="webpush-item" data-testid="webpush-device" data-id="${esc(s.id)}"><span class="grow"><b>${esc(s.label)}</b>${s.id === mine ? ` <span class="faint">· ${esc(t('push.this_device'))}</span>` : ''}<div class="faint">${esc(s.service)} · ${esc(t('push.added'))} ${relTime(s.created_time)} · ${esc(t('push.last_delivered'))} ${esc(when(s.last_success_time))}${s.failures ? ` · ${esc(s.failures)} ${esc(t('push.failed'))}` : ''}</div></span>
        <button class="btn btn-sm" type="button" data-webpush-test="${esc(s.id)}" data-testid="webpush-test">${esc(t('push.send_test'))}</button><button class="btn btn-sm btn-ghost" type="button" data-webpush-remove="${esc(s.id)}" data-testid="webpush-remove">${esc(t('push.remove'))}</button></li>`).join('')
        : `<li class="faint" data-testid="webpush-none">${esc(t('push.none'))}</li>`;
    } catch { if (list.isConnected) list.textContent = t('push.list_unavailable'); }
  }
  async function webPushAction(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); } catch (ex) { toast(ex.message, 'error'); }
    if (!gone) loadWebPush();
  }
  async function loadDeliveries() {
    const box = root.querySelector('[data-deliveries]');
    try {
      const { deliveries } = await api.deliveries(session.uid);
      if (gone || !box.isConnected) return;
      box.classList.remove('faint');
      box.innerHTML = deliveries.length ? `<table class="table" data-testid="deliveries"><thead><tr><th>Channel</th><th>Notification</th><th>Status</th><th class="num">When</th></tr></thead><tbody>${deliveries.slice(0, 20).map((d) => `<tr data-channel="${esc(d.channel)}" data-status="${esc(d.status)}"><td>${esc(CH_LABEL[d.channel] || d.channel)}</td><td>${esc(d.title)}</td><td>${esc(d.status.replace('_', ' '))}</td><td class="num faint">${relTime(d.created_time)}</td></tr>`).join('')}</tbody></table>` : '<div class="faint">Nothing sent by email or push yet.</div>';
    } catch { if (box.isConnected) box.textContent = 'Deliveries are unavailable.'; }
  }
  const replace = (next) => { prefs = next; draw(); };
  async function save(fn, okMsg) {
    try { replace(await fn()); if (okMsg) toast(okMsg); } catch (ex) { toast(ex.message, 'error'); }
  }

  root.addEventListener('toggle', (e) => { const d = e.target; if (d.matches && d.matches('details[data-group]')) { if (d.open) openGroups.add(d.dataset.group); else openGroups.delete(d.dataset.group); } }, true);
  root.addEventListener('click', (e) => {
    const p = e.target.closest('[data-channel][data-type]');
    if (p) {
      const t = p.dataset.type; const ch = p.dataset.channel;
      const on = p.getAttribute('aria-pressed') === 'true';
      p.disabled = true;
      save(() => api.setNotifType(session.uid, t, { [ch]: !on }));
      return;
    }
    const more = e.target.closest('[data-more]');
    if (more) {
      const f = root.querySelector(`[data-opts="${CSS.escape(more.dataset.more)}"]`);
      f.hidden = !f.hidden; more.setAttribute('aria-expanded', String(!f.hidden)); more.classList.toggle('open', !f.hidden);
      return;
    }
    if (e.target.closest('[data-push-on]')) { enablePush(); return; }
    const wp = e.target.closest('[data-webpush-on],[data-webpush-off],[data-webpush-test],[data-webpush-remove]');
    if (wp) {
      wp.disabled = true;
      if (wp.matches('[data-webpush-on]')) webPushAction(() => enableWebPush(), t('push.toast_on'));
      else if (wp.matches('[data-webpush-off]')) webPushAction(() => disableWebPush(), t('push.toast_off'));
      else if (wp.dataset.webpushTest) webPushAction(() => api.testPushSubscription(session.uid, wp.dataset.webpushTest), t('push.toast_test'));
      else {
        const id = wp.dataset.webpushRemove;
        webPushAction(async () => { const self = id === thisDevice(); await api.removePushSubscription(session.uid, id); if (self) await disableWebPush(); }, t('push.toast_removed'));
      }
      return;
    }
    if (e.target.closest('[data-push-off]')) { disablePush(); }
  });
  root.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.matches('[data-opts]')) {
      const type = f.dataset.opts;
      const options = {};
      for (const inp of f.querySelectorAll('[data-opt]')) {
        const k = inp.dataset.opt;
        if (inp.type === 'checkbox') options[k] = inp.checked;
        else if (inp.type === 'number') options[k] = Number(inp.value);
        else options[k] = /^\d+$/.test(inp.value) ? Number(inp.value) : inp.value;
      }
      save(() => api.setNotifType(session.uid, type, { options }), 'Saved');
    } else if (f.matches('[data-quiet]')) {
      save(() => api.setNotifPrefs(session.uid, { quiet_hours: { enabled: f.enabled.checked, start: f.start.value, end: f.end.value, timezone: f.timezone.value.trim() || 'UTC' } }), 'Quiet hours saved')
        .catch(() => {});
    }
  });
  async function enablePush() {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* the browser may refuse */ } }
      const { device } = await api.addPushDevice(session.uid, navigator.userAgent.includes('Mobile') ? 'Mobile browser' : 'Desktop browser');
      setDeviceId(device.id);
      replace(await api.notifPrefs(session.uid));
      toast(typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'Push notifications are on in this browser' : 'Registered. Allow notifications in your browser to see them as pop-ups.');
    } catch (ex) { toast(ex.message, 'error'); }
  }
  async function disablePush() {
    const id = deviceId();
    try { if (id) await api.removePushDevice(session.uid, id); } catch { /* already gone */ }
    setDeviceId(null);
    replace(await api.notifPrefs(session.uid));
  }

  api.notifPrefs(session.uid).then((p) => { if (!gone) replace(p); }).catch((e) => { if (!gone) root.innerHTML = `<div class="form-error" role="alert">${esc(e.message)}</div>`; });
  const onPush = () => loadDeliveries();
  window.addEventListener('parlance:push', onPush);
  return () => { gone = true; window.removeEventListener('parlance:push', onPush); };
}

// "Security notifications — Notifications for all sensitive actions on your account" (§13.16 item 5): adds push for
// sign-in alerts and other account notices (they always reach the inbox, and sign-in alerts also go by email).
export function mountSecurityNotificationSetting(el) {
  if (!session.user) return () => {};
  el.innerHTML = '<label class="opt-row" data-testid="security-notifications"><input type="checkbox" disabled> Notifications for all sensitive actions on your account</label>';
  const box = el.querySelector('input');
  api.notifPrefs(session.uid).then((p) => { box.checked = p.security_notifications; box.disabled = false; }).catch(() => {});
  box.onchange = async () => {
    try { const p = await api.setNotifPrefs(session.uid, { security_notifications: box.checked }); box.checked = p.security_notifications; toast('Saved'); } catch (ex) { box.checked = !box.checked; toast(ex.message, 'error'); }
  };
  return () => {};
}

export async function render({ el, navigate }) {
  if (!session.user) { navigate('/sign-in?next=/notifications/settings', { replace: true }); return undefined; }
  document.title = 'Notification settings · Parlance';
  el.innerHTML = `<div class="page-head"><h1 class="page-title">Notification settings</h1><a class="btn" href="/notifications" data-link>Inbox</a></div>
    <div class="ns-layout"><div data-module></div><aside class="card ns-card"><h3>Security notifications</h3><div data-security></div></aside></div>`;
  const stop = mountNotificationSettings(el.querySelector('[data-module]'));
  mountSecurityNotificationSetting(el.querySelector('[data-security]'));
  return stop;
}
