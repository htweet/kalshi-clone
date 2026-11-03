// Notifications inbox (spec §13.7): fills, settlements, price alerts, social activity, security events.
import { api } from '../api.js';
import { session } from '../store.js';
import { esc, relTime } from '../lib.js';

export async function render({ el, navigate }) {
  if (!session.user) { navigate('/sign-in?next=/notifications', { replace: true }); return undefined; }
  document.title = 'Notifications · Parlance';
  async function draw() {
    const { notifications, unread_count: unread } = await api.notifications(session.uid);
    el.innerHTML = `<div class="page-head"><h1 class="typ-title-x10">Notifications</h1><div class="d-flex gap-8"><a class="btn" href="/notifications/settings" data-link data-testid="notif-settings-link">Settings</a><button class="btn" id="read-all-page" ${unread ? '' : 'disabled'}>Mark all read</button></div></div>
      <div class="card" data-testid="notifications">${notifications.map((n) => `<a class="notif ${n.read ? '' : 'unread'}" href="${esc(n.link || '/notifications')}" data-link data-nid="${esc(n.id)}" data-type="${esc(n.type)}"><span class="ind"></span><span><div class="t">${esc(n.title)}</div><div class="faint">${esc(n.body)}</div></span><span class="faint">${relTime(n.created_time)}</span></a>`).join('') || '<div class="empty">No notifications yet. Fills, settlements, price alerts and replies show up here.</div>'}</div>`;
    el.querySelector('#read-all-page').onclick = async () => { await api.readAll(session.uid); draw(); };
    el.querySelector('[data-testid=notifications]').addEventListener('click', (e) => { const a = e.target.closest('[data-nid]'); if (a) api.readNotification(session.uid, a.dataset.nid).catch(() => {}); });
  }
  await draw();
  const onNew = () => draw().catch(() => {});
  window.addEventListener('parlance:notification', onNew);
  return () => window.removeEventListener('parlance:notification', onNew);
}
