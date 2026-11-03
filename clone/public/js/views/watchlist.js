import { api } from '../api.js';
import { session } from '../store.js';
import { eventCard } from './components.js';
import { esc } from '../lib.js';

export async function render({ el, navigate }) {
  if (!session.user) { navigate('/sign-in?next=/watchlist', { replace: true }); return; }
  document.title = 'Watchlist · Parlance';
  const { events } = await api.watchlist(session.uid);
  const { events: recent } = await api.recent(session.uid);
  el.innerHTML = `<div class="page-head"><h1 class="page-title">Watchlist</h1></div>
    <div class="grid" data-testid="watchlist">${events.map(eventCard).join('') || '<div class="card empty" data-testid="watchlist-empty">You aren\'t watching any events yet. Use ☆ Watch on an event page.</div>'}</div>
    <h2 class="section-title">Recently viewed</h2>
    <div class="faint" data-testid="recent">${recent.map((e) => `<div>${esc(e.title)}</div>`).join('') || 'Nothing yet.'}</div>`;
}
