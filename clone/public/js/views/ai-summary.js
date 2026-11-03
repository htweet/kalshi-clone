// AI news summary and timeline on the event page (Phase 5B, PLAN P5.4; CLONE_SPEC.md §29.6). Server-generated from the
// event's own news items: each sentence carries numbered citations that jump to the news item it came from. Updates
// (an admin hides or regenerates the summary) arrive on the public `event_content` channel.
import { request } from '../api.js';
import { socket } from '../ws.js';
import { esc } from '../lib.js';

const fmt = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function html(d) {
  const tl = d.timeline || [];
  const timeline = tl.length ? `<ol class="ai-timeline" data-testid="ai-timeline">${tl.map((t) => `<li data-news="${esc(t.id)}"><span class="ai-n">${esc(t.n)}</span><span class="faint">${esc(fmt(t.date))} · ${esc(t.source)}</span><span>${esc(t.headline)}</span></li>`).join('')}</ol>` : '';
  if (d.hidden) return `<section class="card ai-card" data-testid="ai-summary" data-state="hidden"><div class="ai-head"><h2>Summary</h2></div><p class="faint" data-testid="ai-summary-hidden">The summary for this event is not available.</p>${timeline}</section>`;
  if (!d.summary) return '';
  const s = d.summary;
  const body = s.sentences.length
    ? s.sentences.map((x) => `<span class="ai-sentence" data-testid="ai-sentence">${esc(x.text)}${x.citations.map((c) => `<a class="ai-cite" href="#news-${esc(c.id)}" data-cite="${esc(c.id)}" data-testid="ai-cite" aria-label="Source ${esc(c.n)}">${esc(c.n)}</a>`).join('')}</span>`).join(' ')
    : '<span class="faint">Not enough news to summarise yet.</span>';
  return `<section class="card ai-card" data-testid="ai-summary" data-state="shown" data-provider="${esc(s.provider)}" data-summary-id="${esc(s.id)}">
    <div class="ai-head"><h2>Summary</h2><span class="ai-badge" data-testid="ai-provider">${esc(s.provider === 'extractive' ? 'Extractive' : 'AI')}</span></div>
    <p class="ai-text" data-testid="ai-summary-text">${body}</p>
    <div class="ai-meta faint">${esc(s.provider_label)} · from ${esc(s.item_count)} news item${s.item_count === 1 ? '' : 's'} · ${esc(fmt(s.generated_time))}. Summaries can be wrong; check the sources. Not trading advice.</div>
    ${timeline ? `<h3 class="ai-sub">Timeline</h3>${timeline}` : ''}</section>`;
}

export function mountAiSummary(box, ev) {
  if (!box) return () => {};
  let gone = false;
  const draw = async () => {
    try { const d = await request('GET', `/v1/events/${encodeURIComponent(ev.event_ticker)}/ai_summary`); if (!gone && box.isConnected) box.innerHTML = html(d); } catch { if (!gone) box.innerHTML = ''; }
  };
  box.addEventListener('click', (e) => {
    const a = e.target.closest('[data-cite]');
    if (!a) return;
    e.preventDefault();
    const n = document.getElementById(`news-${a.dataset.cite}`);
    if (!n) return;
    n.scrollIntoView({ behavior: 'smooth', block: 'center' });
    n.classList.add('ai-highlight'); setTimeout(() => n.classList.remove('ai-highlight'), 1800);
  });
  draw();
  const unsub = socket.subscribe({ channels: ['event_content'], event_tickers: [ev.event_ticker] }, (m) => { if (m.type === 'event_content' && m.msg.kind === 'ai_summary') draw(); });
  return () => { gone = true; unsub(); };
}
