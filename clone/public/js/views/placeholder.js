// Placeholder pages for ☰ menu destinations whose features belong to later phases (CLONE_SPEC §13.16–§13.18;
// PHASE3_SPEC.md §25.7). Each says plainly what it is and when it arrives, instead of a dead link or a 404.
import { esc } from '../lib.js';
import { GROUPS } from './account-menu.js';

const PAGES = {
  incentives: ['Liquidity Rewards', 'The Liquidity Incentive Program — reward pools for resting orders near the market, with active and upcoming programs — arrives in Phase 5 (PLAN A13).'],
  docs: ['API Docs', 'The developer portal — REST, WebSocket and FIX documentation with a demo environment — arrives in Phase 7 (PLAN P7.3, A16).'],
};

export async function render({ el, params }) {
  let title; let text;
  if (params.group) {
    const g = GROUPS.find(([k]) => k === params.group);
    const item = g && g[2].find(([s]) => s === params.slug);
    title = item ? `${g[1]} · ${item[1]}` : 'Page';
    text = 'Help-centre and company pages (Trust, Research, Support) arrive in Phase 8 (PLAN A18). Until then, this placeholder keeps the menu honest.';
  } else {
    [title, text] = PAGES[params.slug] || ['Page', 'This page is not available yet.'];
  }
  document.title = `${title} · Parlance`;
  el.innerHTML = `<div class="card empty center-60" data-testid="placeholder-page" data-page="${esc(params.group ? `${params.group}/${params.slug}` : params.slug)}">
    <h1 class="typ-title-x20">${esc(title)}</h1><p class="muted">${esc(text)}</p><div class="d-flex gap-8 jc-center"><a class="btn" href="/" data-link>Go home</a></div></div>`;
}
