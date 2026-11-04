// Notifications inbox (spec §13.7): fills, settlements, price alerts, social activity, security events.
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import { slotImg } from '../content-live.js';
import '../content/notifications-strings.js';
import { api } from '../api.js';
import { session } from '../store.js';
import { esc, relTime } from '../lib.js';

export async function render({ el, navigate }) {
  if (!session.user) { navigate('/sign-in?next=/notifications', { replace: true }); return undefined; }
  document.title = t('notifications.render.notifications_parlance');
  async function draw() {
    const { notifications, unread_count: unread } = await api.notifications(session.uid);
    el.innerHTML = `<div class="page-head"><h1 class="page-title">${te('notifications.render.notifications')}</h1><div class="d-flex gap-8"><a class="btn" href="/notifications/settings" data-link data-testid="notif-settings-link">${te('notifications.render.settings')}</a><button class="btn" id="read-all-page" ${unread ? '' : 'disabled'}>${te('notifications.render.mark_all_read')}</button></div></div>
      <div class="card" data-testid="notifications">${notifications.map((n) => `<a class="notif ${n.read ? '' : 'unread'}" href="${esc(n.link || '/notifications')}" data-link data-nid="${esc(n.id)}" data-type="${esc(n.type)}"><span class="ind"></span><span><div class="t">${esc(n.title)}</div><div class="faint">${esc(n.body)}</div></span><span class="faint">${relTime(n.created_time)}</span></a>`).join('') || `<div class="empty">${slotImg('empty.notifications', 'empty-art')}${te('notifications.render.no_notifications_yet_fills_settlements')}</div>`}</div>`;
    el.querySelector('#read-all-page').onclick = async () => { await api.readAll(session.uid); draw(); };
    el.querySelector('[data-testid=notifications]').addEventListener('click', (e) => { const a = e.target.closest('[data-nid]'); if (a) api.readNotification(session.uid, a.dataset.nid).catch(() => {}); });
  }
  await draw();
  const onNew = () => draw().catch(() => {});
  window.addEventListener('parlance:notification', onNew);
  return () => window.removeEventListener('parlance:notification', onNew);
}
