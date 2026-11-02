// Calendar (spec §13.4): category filter rail with counts / live counts, then a live section and one section per date.
import { api } from '../api.js';
import { esc, CATEGORIES } from '../lib.js';
import { eventCard } from './components.js';

const fmtDate = (d) => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (d === today) return 'Today';
  if (d === tomorrow) return 'Tomorrow';
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

export async function render({ el, query, navigate }) {
  document.title = 'Calendar · Parlance';
  const category = query.get('category') || '';
  const data = await api.calendar({ category });
  const f = data.filters;
  const row = (name, c, on) => `<button data-cat="${esc(name)}" class="${on ? 'on' : ''}"><span>${esc(name || 'All')}</span><span class="n">${c ? c.count : 0}${c && c.live_count ? ` · <span style="color:var(--live)">${c.live_count} live</span>` : ''}</span></button>`;
  el.innerHTML = `<div class="page-head"><h1 class="typ-title-x10">Calendar</h1><span class="faint">${data.total_count} events</span></div>
    <div class="cal-layout">
      <nav class="cal-filters" aria-label="Calendar categories" data-testid="cal-filters">${row('', f.all, !category)}${CATEGORIES.filter((c) => f.categories[c]).map((c) => row(c, f.categories[c], c === category)).join('')}</nav>
      <div>${data.sections.map((s) => `<section class="cal-section" data-testid="cal-section" data-date="${esc(s.date)}" data-live="${s.is_live}">
          <h2 class="cal-date">${s.is_live ? '<span class="live-dot" style="font-size:13px">Live now</span>' : esc(fmtDate(s.date))}<span class="faint">${s.events.length}</span></h2>
          <div class="grid">${s.events.map(eventCard).join('')}</div></section>`).join('') || '<div class="card empty">No upcoming events in this category.</div>'}</div>
    </div>`;
  for (const b of el.querySelectorAll('[data-cat]')) b.onclick = () => navigate(b.dataset.cat ? `/calendar?category=${encodeURIComponent(b.dataset.cat)}` : '/calendar', { replace: true });
}
