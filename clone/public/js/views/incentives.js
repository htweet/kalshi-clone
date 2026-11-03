// Liquidity Incentive Program (Phase 5B, PLAN A13; CLONE_SPEC.md §13.17 observed layout, §29.7): left "PREDICTIONS"
// category nav, title with a dotted Terms link, region banner, this month's and lifetime rewards (⟲ history), enrolment,
// ACTIVE · UPCOMING tabs with search, and the program table (Market with "N markets" expander · Start · End ·
// Competition · Reward, sortable). Program changes arrive on the public `incentives` channel; the user's own accruals
// and payouts on the private `incentive_rewards` channel.
import { request } from '../api.js';
import { socket } from '../ws.js';
import { session } from '../store.js';
import { esc, money, eventHref, CATEGORIES, catLabel, toast } from '../lib.js';

const get = (u) => request('GET', u);
const when = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

export async function render({ el, params, query, navigate }) {
  if (params.page === 'terms') return renderTerms(el);
  document.title = 'Liquidity Incentive Program · Parlance';
  const state = { tab: query.get('tab') === 'upcoming' ? 'upcoming' : 'active', q: '', cat: query.get('category') || '', dir: -1, open: new Set(), showHistory: false };
  el.innerHTML = `<div class="lip-layout" data-testid="incentives-page">
    <nav class="lip-side" aria-label="Categories"><div class="overline">Predictions</div><div data-cats></div></nav>
    <div class="minw-0">
      <div class="lip-head"><h1 class="page-title">Liquidity Incentive Program</h1><a class="lip-terms" href="/incentives/terms" data-link data-testid="lip-terms-link">Terms</a></div>
      <div data-banner></div><div class="lip-stats stat-row" data-stats></div><div data-enroll></div>
      <div class="tabs lip-tabs" role="tablist"><button data-tab="active" role="tab">Active</button><button data-tab="upcoming" role="tab">Upcoming</button>
        <input class="lip-search" type="search" placeholder="Search title or ticker" aria-label="Search title or ticker" data-testid="lip-search"></div>
      <div data-table></div></div></div>`;
  const $ = (s) => el.querySelector(s);
  let programs = []; let region = { eligible: true }; let me = null;

  function drawCats() {
    const cats = ['', ...CATEGORIES];
    $('[data-cats]').innerHTML = cats.map((c) => `<button class="${c === state.cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c ? catLabel(c) : 'All')}</button>`).join('');
  }
  function drawTable() {
    for (const b of el.querySelectorAll('[data-tab]')) { b.classList.toggle('on', b.dataset.tab === state.tab); b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)); }
    const q = state.q.toLowerCase();
    const rows = programs.filter((p) => (!state.cat || p.category === state.cat) && (!q || `${p.title} ${p.event_sub_title} ${p.event_ticker} ${p.markets.map((m) => m.ticker).join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => state.dir * (Number(a.period_reward_dollars) - Number(b.period_reward_dollars)));
    if (!region.eligible) { $('[data-table]').innerHTML = ''; return; }
    $('[data-table]').innerHTML = `<div class="table-wrap"><table class="table lip-table" data-testid="lip-table"><thead><tr><th>Market</th><th>Start</th><th>End</th><th>Competition</th>
      <th class="num"><button class="lip-sort" data-sort data-testid="lip-sort">Reward ${state.dir < 0 ? '↓' : '↑'}</button></th></tr></thead><tbody>
      ${rows.map((p) => `<tr data-testid="lip-row" data-program="${esc(p.id)}"><td><a href="${eventHref(p)}" data-link class="lip-title">${esc(p.title)}</a><div class="faint">${esc(p.event_sub_title)}</div>
          <button class="lip-markets" data-expand="${esc(p.id)}" aria-expanded="${state.open.has(p.id)}">${esc(p.markets.length)} market${p.markets.length === 1 ? '' : 's'} ⌄</button>
          ${state.open.has(p.id) ? `<ul class="lip-market-list" data-testid="lip-markets">${p.markets.map((m) => `<li><span>${esc(m.title)}</span> <code>${esc(m.ticker)}</code></li>`).join('')}</ul>` : ''}</td>
        <td>${esc(when(p.start_date))}</td><td>${esc(when(p.end_date))}</td><td><span class="lip-comp ${esc(p.competition)}" data-testid="lip-competition">${p.competition === 'high' ? 'High' : 'Low'}</span></td>
        <td class="num" data-testid="lip-reward">${money(p.period_reward_dollars)}</td></tr>`).join('') || `<tr><td colspan="5" class="faint">No ${esc(state.tab)} programs${state.q ? ' match your search' : ''}.</td></tr>`}</tbody></table></div>`;
  }
  function drawMe() {
    $('[data-banner]').innerHTML = region.eligible ? '' : `<div class="banner-inline lip-region" role="status" data-testid="lip-region-banner">Incentive programs are not available in your region${region.country_name ? ` (${esc(region.country_name)})` : ''}.</div>`;
    if (!session.user) { $('[data-stats]').innerHTML = '<p class="faint"><a href="/sign-in?next=/incentives" data-link>Log in</a> to see your rewards and take part.</p>'; $('[data-enroll]').innerHTML = ''; return; }
    if (!me) return;
    $('[data-stats]').innerHTML = `<div class="card stat"><span class="label">${esc(me.month.label)}</span><span class="value num" data-testid="lip-month">${money(me.month.rewards_dollars)}</span></div>
      <div class="card stat"><span class="label">Lifetime rewards <button class="icon-btn lip-hist-btn" data-history aria-label="Reward history" data-testid="lip-history-btn">⟲</button></span><span class="value num" data-testid="lip-lifetime">${money(me.lifetime_dollars)}</span></div>
      <div class="card stat"><span class="label">Accruing, not yet paid</span><span class="value num" data-testid="lip-pending">${money(me.month.pending_dollars)}</span></div>
      ${state.showHistory ? `<div class="card lip-history" data-testid="lip-history">${me.rewards.length ? me.rewards.map((r) => `<div class="lip-hist-row"><span>${esc(r.title)}</span><span class="faint">${esc(new Date(r.paid_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))} · ${esc(r.mode === 'credits' ? 'credits' : 'cash')}</span><b class="num">${money(r.amount_dollars)}</b></div>`).join('') : '<p class="faint">No rewards paid yet.</p>'}
        ${me.programs.length ? `<div class="overline mt-12">Accrued per program</div>${me.programs.map((p) => `<div class="lip-hist-row" data-testid="lip-accrual"><span>${esc(p.title)}</span><span class="faint">${esc(p.status)}</span><b class="num">${money(p.accrued_dollars)}</b></div>`).join('')}` : ''}</div>` : ''}`;
    $('[data-enroll]').innerHTML = !me.eligible ? '' : me.enrolled
      ? `<div class="lip-enrolled" data-testid="lip-enrolled">You’re taking part. Resting orders near the best price earn rewards. <button class="btn btn-sm btn-ghost" data-leave>Leave</button></div>`
      : `<form class="card lip-enroll" data-testid="lip-enroll"><label class="adm-check"><input type="checkbox" name="accept" data-testid="lip-accept"> <span>I accept the <a href="/incentives/terms" data-link>program terms</a> (version ${esc(me.terms_version)})</span></label><button class="btn btn-primary" type="submit" data-testid="lip-join">Take part</button></form>`;
  }
  async function load() {
    try {
      const r = await get(`/v1/incentive_programs?status=${state.tab}`);
      programs = r.incentive_programs; region = r.region;
    } catch (e) { programs = []; toast(e.message, 'error'); }
    if (session.user) { try { me = await get(`/v1/users/${encodeURIComponent(session.uid)}/incentives`); region = me.region; } catch { me = null; } }
    drawMe(); drawTable();
  }
  drawCats();
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]'); if (t) { state.tab = t.dataset.tab; history.replaceState({}, '', `/incentives${state.tab === 'upcoming' ? '?tab=upcoming' : ''}`); load(); return; }
    const c = e.target.closest('[data-cat]'); if (c) { state.cat = c.dataset.cat; drawCats(); drawTable(); return; }
    if (e.target.closest('[data-sort]')) { state.dir = -state.dir; drawTable(); return; }
    const x = e.target.closest('[data-expand]'); if (x) { const id = x.dataset.expand; if (state.open.has(id)) state.open.delete(id); else state.open.add(id); drawTable(); return; }
    if (e.target.closest('[data-history]')) { state.showHistory = !state.showHistory; drawMe(); return; }
    if (e.target.closest('[data-leave]')) { try { await request('DELETE', `/v1/users/${encodeURIComponent(session.uid)}/incentives/enrollment`); await load(); } catch (ex) { toast(ex.message, 'error'); } }
  });
  el.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-testid=lip-enroll]')) return;
    e.preventDefault();
    if (!e.target.elements.accept.checked) { toast('Accept the program terms to take part', 'error'); return; }
    try { await request('POST', `/v1/users/${encodeURIComponent(session.uid)}/incentives/enrollment`, { accept_terms: true, terms_version: me.terms_version }); toast('You’re taking part'); await load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  $('[data-testid=lip-search]').addEventListener('input', (e) => { state.q = e.target.value.trim(); drawTable(); });
  await load();
  const unsubs = [socket.subscribe({ channels: ['incentives'] }, () => load())];
  if (session.user) { let t = null; unsubs.push(socket.subscribe({ channels: ['incentive_rewards'] }, () => { clearTimeout(t); t = setTimeout(load, 300); })); }
  void navigate;
  return () => { for (const u of unsubs) u(); };
}

async function renderTerms(el) {
  document.title = 'Liquidity Incentive Program terms · Parlance';
  const t = await get('/v1/incentive_programs/terms');
  el.innerHTML = `<article class="card lip-terms-page" data-testid="lip-terms"><div class="overline">Version ${esc(t.version)}</div><h1 class="page-title">Liquidity Incentive Program terms</h1>
    ${t.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}<a class="btn" href="/incentives" data-link>Back to programs</a></article>`;
}
