import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import { slotImg } from '../content-live.js';
import '../content/watchlist-strings.js';
import { api } from '../api.js';
import { session } from '../store.js';
import { eventCard } from './components.js';
import { esc } from '../lib.js';

export async function render({ el, navigate }) {
  if (!session.user) { navigate('/sign-in?next=/watchlist', { replace: true }); return; }
  document.title = t('watchlist.render.watchlist_parlance');
  const { events } = await api.watchlist(session.uid);
  const { events: recent } = await api.recent(session.uid);
  el.innerHTML = `<div class="page-head"><h1 class="page-title">${te('watchlist.render.watchlist')}</h1></div>
    <div class="grid" data-testid="watchlist">${events.map(eventCard).join('') || `<div class="card empty" data-testid="watchlist-empty">${slotImg('empty.watchlist', 'empty-art')}${te('watchlist.render.you_aren_t_watching_any')}</div>`}</div>
    <h2 class="section-title">${te('watchlist.render.recently_viewed')}</h2>
    <div class="faint" data-testid="recent">${recent.map((e) => `<div>${esc(e.title)}</div>`).join('') || te('watchlist.render.nothing_yet')}</div>`;
}
