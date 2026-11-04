// Liquidity Incentive Program (Phase 5B, PLAN A13; CLONE_SPEC.md §13.17 observed layout, §29.7): left "PREDICTIONS"
// category nav, title with a dotted Terms link, region banner, this month's and lifetime rewards (⟲ history), enrolment,
// ACTIVE · UPCOMING tabs with search, and the program table (Market with "N markets" expander · Start · End ·
// Competition · Reward, sortable). Program changes arrive on the public `incentives` channel; the user's own accruals
// and payouts on the private `incentive_rewards` channel.
import { t as tx, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/incentives-strings.js';
import { request } from '../api.js';
import { socket } from '../ws.js';
import { session } from '../store.js';
import { esc, money, eventHref, CATEGORIES, catLabel, toast, fmtDt, fmtDay } from '../lib.js';

const get = (u) => request('GET', u);
const when = (iso) => fmtDt(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

export async function render({ el, params, query, navigate }) {
  if (params.page === 'terms') return renderTerms(el);
  document.title = tx('incentives.render.liquidity_incentive_program_parlance');
  const state = { tab: query.get('tab') === 'upcoming' ? 'upcoming' : 'active', q: '', cat: query.get('category') || '', dir: -1, open: new Set(), showHistory: false };
  el.innerHTML = `<div class="lip-layout" data-testid="incentives-page">
    <nav class="lip-side" aria-label="${te('incentives.render.categories')}"><div class="overline">${te('incentives.render.predictions')}</div><div data-cats></div></nav>
    <div class="minw-0">
      <div class="lip-head"><h1 class="page-title">${te('incentives.render.liquidity_incentive_program')}</h1><a class="lip-terms" href="/incentives/terms" data-link data-testid="lip-terms-link">${te('incentives.render.terms')}</a></div>
      <div data-banner></div><div class="lip-stats stat-row" data-stats></div><div data-enroll></div>
      <div class="tabs lip-tabs" role="tablist"><button data-tab="active" role="tab">${te('incentives.render.active')}</button><button data-tab="upcoming" role="tab">${te('incentives.render.upcoming')}</button>
        <input class="lip-search" type="search" placeholder="${te('incentives.render.search_title_or_ticker')}" aria-label="${te('incentives.render.search_title_or_ticker')}" data-testid="lip-search"></div>
      <div data-table></div></div></div>`;
  const $ = (s) => el.querySelector(s);
  let programs = []; let region = { eligible: true }; let me = null;

  function drawCats() {
    const cats = ['', ...CATEGORIES];
    $('[data-cats]').innerHTML = cats.map((c) => `<button class="${c === state.cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c ? catLabel(c) : tx('incentives.render.all'))}</button>`).join('');
  }
  function drawTable() {
    for (const b of el.querySelectorAll('[data-tab]')) { b.classList.toggle('on', b.dataset.tab === state.tab); b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)); }
    const q = state.q.toLowerCase();
    const rows = programs.filter((p) => (!state.cat || p.category === state.cat) && (!q || `${p.title} ${p.event_sub_title} ${p.event_ticker} ${p.markets.map((m) => m.ticker).join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => state.dir * (Number(a.period_reward_dollars) - Number(b.period_reward_dollars)));
    if (!region.eligible) { $('[data-table]').innerHTML = ''; return; }
    $('[data-table]').innerHTML = `<div class="table-wrap"><table class="table lip-table" data-testid="lip-table"><thead><tr><th>${te('incentives.render.market')}</th><th>${te('incentives.render.start')}</th><th>${te('incentives.render.end')}</th><th>${te('incentives.render.competition')}</th>
      <th class="num"><button class="lip-sort" data-sort data-testid="lip-sort">${te('incentives.render.reward', { value: state.dir < 0 ? '↓' : '↑' })}</button></th></tr></thead><tbody>
      ${rows.map((p) => `<tr data-testid="lip-row" data-program="${esc(p.id)}"><td><a href="${eventHref(p)}" data-link class="lip-title">${esc(p.title)}</a><div class="faint">${esc(p.event_sub_title)}</div>
          <button class="lip-markets" data-expand="${esc(p.id)}" aria-expanded="${state.open.has(p.id)}">${te('incentives.render.market_2', { value: esc(p.markets.length), value_2: p.markets.length === 1 ? '' : 's' })}</button>
          ${state.open.has(p.id) ? `<ul class="lip-market-list" data-testid="lip-markets">${p.markets.map((m) => `<li><span>${esc(m.title)}</span> <code>${esc(m.ticker)}</code></li>`).join('')}</ul>` : ''}</td>
        <td>${esc(when(p.start_date))}</td><td>${esc(when(p.end_date))}</td><td><span class="lip-comp ${esc(p.competition)}" data-testid="lip-competition">${p.competition === 'high' ? te('incentives.render.high') : te('incentives.render.low')}</span></td>
        <td class="num" data-testid="lip-reward">${money(p.period_reward_dollars)}</td></tr>`).join('') || `<tr><td colspan="5" class="faint">${te('incentives.render.no_programs', { tab: esc(state.tab), value: state.q ? (' ' + te('incentives.render.match_your_search')) : '' })}</td></tr>`}</tbody></table></div>`;
  }
  function drawMe() {
    $('[data-banner]').innerHTML = region.eligible ? '' : `<div class="banner-inline lip-region" role="status" data-testid="lip-region-banner">${te('incentives.render.incentive_programs_are_not_available', { value: region.country_name ? ` (${esc(region.country_name)})` : '' })}</div>`;
    if (!session.user) { $('[data-stats]').innerHTML = `<p class="faint"><a href="/sign-in?next=/incentives" data-link>${te('incentives.render.log_in')}</a> ${te('incentives.render.to_see_your_rewards_and')}</p>`; $('[data-enroll]').innerHTML = ''; return; }
    if (!me) return;
    $('[data-stats]').innerHTML = `<div class="card stat"><span class="label">${esc(me.month.label)}</span><span class="value num" data-testid="lip-month">${money(me.month.rewards_dollars)}</span></div>
      <div class="card stat"><span class="label">${te('incentives.render.lifetime_rewards')} <button class="icon-btn lip-hist-btn" data-history aria-label="${te('incentives.render.reward_history')}" data-testid="lip-history-btn">⟲</button></span><span class="value num" data-testid="lip-lifetime">${money(me.lifetime_dollars)}</span></div>
      <div class="card stat"><span class="label">${te('incentives.render.accruing_not_yet_paid')}</span><span class="value num" data-testid="lip-pending">${money(me.month.pending_dollars)}</span></div>
      ${state.showHistory ? `<div class="card lip-history" data-testid="lip-history">${me.rewards.length ? me.rewards.map((r) => `<div class="lip-hist-row"><span>${esc(r.title)}</span><span class="faint">${esc(fmtDay(r.paid_time))} · ${esc(r.mode === 'credits' ? tx('incentives.render.credits') : tx('incentives.render.cash'))}</span><b class="num">${money(r.amount_dollars)}</b></div>`).join('') : `<p class="faint">${te('incentives.render.no_rewards_paid_yet')}</p>`}
        ${me.programs.length ? `<div class="overline mt-12">${te('incentives.render.accrued_per_program')}</div>${me.programs.map((p) => `<div class="lip-hist-row" data-testid="lip-accrual"><span>${esc(p.title)}</span><span class="faint">${esc(p.status)}</span><b class="num">${money(p.accrued_dollars)}</b></div>`).join('')}` : ''}</div>` : ''}`;
    $('[data-enroll]').innerHTML = !me.eligible ? '' : me.enrolled
      ? `<div class="lip-enrolled" data-testid="lip-enrolled">${te('incentives.render.you_re_taking_part_resting')} <button class="btn btn-sm btn-ghost" data-leave>${te('incentives.render.leave')}</button></div>`
      : `<form class="card lip-enroll" data-testid="lip-enroll"><label class="adm-check"><input type="checkbox" name="accept" data-testid="lip-accept"> <span>${te('incentives.render.i_accept_the')} <a href="/incentives/terms" data-link>${te('incentives.render.program_terms')}</a> ${te('incentives.render.version', { terms_version: esc(me.terms_version) })}</span></label><button class="btn btn-primary" type="submit" data-testid="lip-join">${te('incentives.render.take_part')}</button></form>`;
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
    if (!e.target.elements.accept.checked) { toast(tx('incentives.render.accept_the_program_terms_to'), 'error'); return; }
    try { await request('POST', `/v1/users/${encodeURIComponent(session.uid)}/incentives/enrollment`, { accept_terms: true, terms_version: me.terms_version }); toast(tx('incentives.render.you_re_taking_part')); await load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  $('[data-testid=lip-search]').addEventListener('input', (e) => { state.q = e.target.value.trim(); drawTable(); });
  await load();
  const unsubs = [socket.subscribe({ channels: ['incentives'] }, () => load())];
  if (session.user) { let t = null; unsubs.push(socket.subscribe({ channels: ['incentive_rewards'] }, () => { clearTimeout(t); t = setTimeout(load, 300); })); }
  void navigate;
  return () => { for (const u of unsubs) u(); };
}

async function renderTerms(el) {
  document.title = tx('incentives.render_terms.liquidity_incentive_program_terms_2');
  const t = await get('/v1/incentive_programs/terms');
  el.innerHTML = `<article class="card lip-terms-page" data-testid="lip-terms"><div class="overline">${te('incentives.render_terms.version', { version: esc(t.version) })}</div><h1 class="page-title">${te('incentives.render_terms.liquidity_incentive_program_terms')}</h1>
    ${t.html ? `<div class="cms-body" data-testid="lip-terms-cms">${t.html /* eslint-disable-line parlance/no-unescaped-html -- CMS page body, sanitised by the server allowlist (server/cms/sanitize.js) */}</div>` : t.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}<a class="btn" href="/incentives" data-link>${te('incentives.render_terms.back_to_programs')}</a></article>`;
}
