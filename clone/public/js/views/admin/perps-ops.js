// Admin › Perps ops, Phase 6 panels (CLONE_SPEC.md §34.10): size-tiered margin per market, risk limits, APY on
// collateral, the waitlist (approve, bulk invite, revoke) and the Perps referral program, plus the perps journal check.
// Money fields are entered in the display currency and sent as API dollars (CLONE_SPEC.md §30); every change asks for a
// reason (audited) and the risk / money ones a fresh password check (step-up, handled by ui.js call()).
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.perps-strings.js';
import { money, sym, toApiDollars, fromApiDollars, moneyCents } from '../../currency.js';
import { esc, get, post, put, toast, formHtml, wireForm, confirmAction, badge, fmtTime } from './ui.js';

const n = (v) => Number(v ?? 0);
const pctIn = (rate) => Number((n(rate) * 100).toFixed(4));
const dispMoney = (dollars) => Number(fromApiDollars(n(dollars)));

export async function renderPerpsOps(host) {
  host.innerHTML = `<div class="adm-stack" data-testid="perps-ops-extra">
    <section class="card adm-card" data-testid="pops-tiers"><h3 class="adm-h3">${te('admin.perps.tiers.title')}</h3><p class="faint">${te('admin.perps.tiers.intro')}</p><div data-slot="tiers"></div></section>
    <section class="card adm-card" data-testid="pops-risk"><h3 class="adm-h3">${te('admin.perps.risk.title')}</h3><div data-slot="risk"></div></section>
    <section class="card adm-card" data-testid="pops-apy"><h3 class="adm-h3">${te('admin.perps.apy.title')}</h3><p class="faint">${te('admin.perps.apy.intro')}</p><div data-slot="apy"></div></section>
    <section class="card adm-card" data-testid="pops-waitlist"><h3 class="adm-h3">${te('admin.perps.waitlist.title')}</h3><div data-slot="waitlist"></div></section>
    <section class="card adm-card" data-testid="pops-referrals"><h3 class="adm-h3">${te('admin.perps.ref.title')}</h3><div data-slot="referrals"></div></section>
    <section class="card adm-card" data-testid="pops-ledger"><h3 class="adm-h3">${te('admin.perps.ledger.title')}</h3><div data-slot="ledger"></div></section>
  </div>`;
  const slot = (k) => host.querySelector(`[data-slot=${k}]`);
  await Promise.all([tiers(slot('tiers')), risk(slot('risk')), apy(slot('apy')), waitlist(slot('waitlist')), referrals(slot('referrals')), ledger(slot('ledger'))]);
}

// ---------------------------------------------------------------- margin tiers
async function tiers(box, pick = null) {
  const d = await get('/perps_ops/margin_tiers');
  const cur = d.markets.find((m) => m.ticker === pick) || d.markets[0];
  const row = (t) => `<tr data-testid="pops-tier-row"><td><input type="number" min="0" step="any" value="${esc(dispMoney(t.max_notional_dollars))}" data-tier-input="cap" aria-label="${te('admin.perps.tiers.cap', { sym: esc(sym()) })}"></td>
    <td><input type="number" min="0" max="100" step="0.01" value="${esc(pctIn(t.initial_margin_rate))}" data-tier-input="im" aria-label="${te('admin.perps.tiers.initial')}"></td>
    <td><input type="number" min="0" max="100" step="0.01" value="${esc(pctIn(t.maintenance_margin_rate))}" data-tier-input="mm" aria-label="${te('admin.perps.tiers.maintenance')}"></td>
    <td class="num" data-f="maxlev">${n(t.max_leverage).toFixed(2)}x</td><td><button class="btn btn-sm btn-ghost" type="button" data-tier-del>${te('admin.perps.tiers.remove')}</button></td></tr>`;
  box.innerHTML = `<label class="field"><span>${te('admin.perps.tiers.market')}</span><select data-testid="pops-tier-market">${d.markets.map((m) => `<option value="${esc(m.ticker)}"${m.ticker === cur.ticker ? ' selected' : ''}>${esc(m.ticker)} · ${esc(m.title)}</option>`).join('')}</select></label>
    <p class="faint" data-testid="pops-tier-summary">${te('admin.perps.tiers.summary', { lev: n(cur.max_leverage), max: esc(money(cur.max_position_notional_dollars)) })}</p>
    <table class="adm-table"><thead><tr><th>${te('admin.perps.tiers.cap', { sym: esc(sym()) })}</th><th>${te('admin.perps.tiers.initial')}</th><th>${te('admin.perps.tiers.maintenance')}</th><th class="num">${te('admin.perps.tiers.max_lev')}</th><th></th></tr></thead><tbody data-testid="pops-tier-rows">${cur.tiers.map(row).join('')}</tbody></table>
    <div class="adm-form-actions"><button class="btn" type="button" data-testid="pops-tier-add">${te('admin.perps.tiers.add')}</button><button class="btn btn-primary" type="button" data-testid="pops-tier-save">${te('admin.perps.tiers.save')}</button><small class="adm-err" role="alert" data-testid="pops-tier-error"></small></div>`;
  box.querySelector('[data-testid=pops-tier-market]').onchange = (e) => tiers(box, e.target.value).catch((ex) => toast(ex.message, 'error'));
  const body = box.querySelector('[data-testid=pops-tier-rows]');
  const wireDel = () => { for (const b of body.querySelectorAll('[data-tier-del]')) b.onclick = () => { if (body.children.length > 1) b.closest('tr').remove(); }; };
  wireDel();
  box.querySelector('[data-testid=pops-tier-add]').onclick = () => {
    const last = cur.tiers[cur.tiers.length - 1];
    body.insertAdjacentHTML('beforeend', row({ max_notional_dollars: n(last.max_notional_dollars) * 2, initial_margin_rate: Math.min(1, n(last.initial_margin_rate) * 2), maintenance_margin_rate: Math.min(0.99, n(last.maintenance_margin_rate) * 2), max_leverage: 1 / Math.min(1, n(last.initial_margin_rate) * 2) }));
    wireDel();
  };
  box.querySelector('[data-testid=pops-tier-save]').onclick = async () => {
    const err = box.querySelector('[data-testid=pops-tier-error]'); err.textContent = '';
    const list = [...body.querySelectorAll('tr')].map((tr) => ({ max_notional_dollars: toApiDollars(tr.querySelector('[data-tier-input=cap]').value), initial_rate: n(tr.querySelector('[data-tier-input=im]').value) / 100, maintenance_rate: n(tr.querySelector('[data-tier-input=mm]').value) / 100 }));
    const ok = await confirmAction({ title: tx('admin.perps.tiers.confirm', { ticker: cur.ticker }), body: esc(tx('admin.perps.tiers.confirm_body')), confirm: tx('admin.perps.tiers.save'), reason: true });
    if (!ok) return;
    try { await put(`/perps_ops/margin_tiers/${encodeURIComponent(cur.ticker)}`, { tiers: list, reason: ok.reason }); toast(tx('admin.perps.tiers.saved', { ticker: cur.ticker })); await tiers(box, cur.ticker); } catch (ex) { err.textContent = ex.fields ? Object.values(ex.fields).join('; ') : ex.message; }
  };
}

// ---------------------------------------------------------------- risk limits
async function risk(box) {
  const { risk: r } = await get('/perps_ops/risk');
  const keys = ['max_open_orders_per_market', 'max_open_orders_total', 'max_subaccounts', 'max_order_groups', 'max_orders_per_group'];
  const fields = [...keys.map((k) => ({ name: k, label: tx(`admin.perps.risk.${k}`), type: 'number', step: '1', required: true, value: r[k] })), { name: 'reason', label: tx('admin.perps.common.reason'), required: true, span: true }];
  box.innerHTML = formHtml(fields, { submit: tx('admin.perps.risk.save'), id: 'prisk', testid: 'pops-risk-form' });
  wireForm(box.querySelector('form'), fields, async (v) => { await put('/perps_ops/risk', v); toast(tx('admin.perps.risk.saved')); await risk(box); });
}

// ---------------------------------------------------------------- APY
async function apy(box) {
  const a = await get('/perps_ops/apy');
  const s = a.settings;
  const fields = [
    { name: 'enabled', label: tx('admin.perps.apy.enabled'), type: 'checkbox', value: s.enabled },
    { name: 'rate_percent', label: tx('admin.perps.apy.rate'), type: 'number', step: '0.01', required: true, value: n(s.rate_bps) / 100 },
    { name: 'payout_minutes', label: tx('admin.perps.apy.interval'), type: 'number', step: '1', required: true, value: Math.round(n(s.payout_interval_ms) / 60000) },
    { name: 'reason', label: tx('admin.perps.common.reason'), required: true, span: true },
  ];
  box.innerHTML = `<dl class="adm-dl" data-testid="pops-apy-stats">
      <dt>${te('admin.perps.apy.source')}</dt><dd data-testid="pops-apy-source">${badge(tx(`admin.perps.apy.source_${a.funding_source}`), a.funding_source === 'none' ? 'warn' : 'ok')}</dd>
      <dt>${te('admin.perps.apy.outstanding')}</dt><dd>${money(a.accrued_outstanding_dollars, { exact: 4 })}</dd>
      <dt>${te('admin.perps.apy.paid')}</dt><dd data-testid="pops-apy-paid">${te('admin.perps.apy.count_amount', { count: n(a.paid.count), amount: esc(money(a.paid.dollars)) })}</dd>
      <dt>${te('admin.perps.apy.queued')}</dt><dd data-testid="pops-apy-queued">${te('admin.perps.apy.count_amount', { count: n(a.queued.count), amount: esc(money(a.queued.dollars)) })}</dd>
      <dt>${te('admin.perps.apy.refused')}</dt><dd>${te('admin.perps.apy.count_amount', { count: n(a.refused.count), amount: esc(money(a.refused.dollars)) })}</dd>
      <dt>${te('admin.perps.apy.next')}</dt><dd>${esc(fmtTime(a.next_payout_time))}</dd></dl>
    ${formHtml(fields, { submit: tx('admin.perps.apy.save'), id: 'papy', testid: 'pops-apy-form', extra: `<button class="btn" type="button" data-testid="pops-apy-payout">${te('admin.perps.apy.payout_now')}</button>` })}`;
  wireForm(box.querySelector('form'), fields, async (v) => {
    await put('/perps_ops/apy', { enabled: v.enabled, rate_percent: v.rate_percent, payout_interval_ms: Math.round(n(v.payout_minutes) * 60000), reason: v.reason });
    toast(tx('admin.perps.apy.saved'));
    await apy(box);
  });
  box.querySelector('[data-testid=pops-apy-payout]').onclick = async () => {
    const ok = await confirmAction({ title: tx('admin.perps.apy.payout_now'), body: esc(tx('admin.perps.apy.payout_body')), confirm: tx('admin.perps.apy.payout_now'), reason: true });
    if (!ok) return;
    try { const r = await post('/perps_ops/apy/payout', { reason: ok.reason }); toast(tx('admin.perps.apy.paid_out', { count: r.payouts })); await apy(box); } catch (ex) { toast(ex.message, 'error'); }
  };
}

// ---------------------------------------------------------------- waitlist
async function waitlist(box) {
  const w = await get('/perps_ops/waitlist');
  const c = w.counts || {};
  box.innerHTML = `<p data-testid="pops-waitlist-gate">${w.gate_active ? badge(tx('admin.perps.waitlist.gate_on'), 'warn') : badge(tx('admin.perps.waitlist.gate_off'))} <span class="faint">${te('admin.perps.waitlist.counts', { waiting: n(c.waiting), approved: n(c.approved), revoked: n(c.revoked) })}</span></p>
    <div class="adm-form-actions"><label class="field"><span>${te('admin.perps.waitlist.invite_count')}</span><input type="number" min="1" max="1000" step="1" value="10" data-testid="pops-invite-count"></label>
      <button class="btn btn-primary" type="button" data-testid="pops-invite">${te('admin.perps.waitlist.invite')}</button>
      <button class="btn" type="button" data-testid="pops-approve">${te('admin.perps.waitlist.approve')}</button>
      <button class="btn" type="button" data-testid="pops-revoke">${te('admin.perps.waitlist.revoke')}</button></div>
    ${w.entries.length ? `<table class="adm-table" data-testid="pops-waitlist-table"><thead><tr><th></th><th>${te('admin.perps.waitlist.user')}</th><th>${te('admin.perps.waitlist.status')}</th><th class="num">${te('admin.perps.waitlist.position')}</th><th>${te('admin.perps.waitlist.joined')}</th><th>${te('admin.perps.waitlist.decided')}</th></tr></thead><tbody>
      ${w.entries.map((e) => `<tr data-testid="pops-waitlist-row" data-user="${esc(e.user_id)}" data-status="${esc(e.status)}"><td><input type="checkbox" data-pick="${esc(e.user_id)}" aria-label="${te('admin.perps.waitlist.select', { email: esc(e.email) })}"></td><td>${esc(e.email)}<div class="faint">${esc(e.display_name)}</div></td><td>${badge(tx(`admin.perps.waitlist.status_${e.status}`), e.status === 'approved' ? 'ok' : e.status === 'revoked' ? 'bad' : 'warn')}</td><td class="num">${e.position == null ? '—' : n(e.position)}</td><td>${esc(fmtTime(e.joined_time))}</td><td>${esc(fmtTime(e.decided_time))}${e.note ? `<div class="faint">${esc(e.note)}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : `<p class="faint">${te('admin.perps.waitlist.empty')}</p>`}`;
  const picked = () => [...box.querySelectorAll('[data-pick]:checked')].map((x) => x.dataset.pick);
  const act = async (path, body, title) => {
    const ok = await confirmAction({ title, confirm: title, reason: true });
    if (!ok) return;
    try { const r = await post(`/perps_ops/waitlist/${path}`, { ...body, reason: ok.reason }); toast(tx('admin.perps.waitlist.done', { count: r.changed })); await waitlist(box); } catch (ex) { toast(ex.message, 'error'); }
  };
  box.querySelector('[data-testid=pops-invite]').onclick = () => act('invite', { count: n(box.querySelector('[data-testid=pops-invite-count]').value) }, tx('admin.perps.waitlist.invite'));
  box.querySelector('[data-testid=pops-approve]').onclick = () => { const ids = picked(); if (!ids.length) { toast(tx('admin.perps.waitlist.pick'), 'error'); return; } act('approve', { user_ids: ids }, tx('admin.perps.waitlist.approve')); };
  box.querySelector('[data-testid=pops-revoke]').onclick = () => { const ids = picked(); if (!ids.length) { toast(tx('admin.perps.waitlist.pick'), 'error'); return; } act('revoke', { user_ids: ids }, tx('admin.perps.waitlist.revoke')); };
}

// ---------------------------------------------------------------- referrals
async function referrals(box) {
  const d = await get('/perps_ops/referrals');
  const s = d.settings;
  const centsField = (name, label) => ({ name, label: tx(label, { sym: sym() }), type: 'number', step: 'any', required: true, value: dispMoney(n(s[name]) / 100) });
  const fields = [
    { name: 'enabled', label: tx('admin.perps.ref.enabled'), type: 'checkbox', value: s.enabled },
    centsField('reward_referrer_cents', 'admin.perps.ref.referrer'), centsField('reward_referee_cents', 'admin.perps.ref.referee'), centsField('threshold_cents', 'admin.perps.ref.threshold'),
    { name: 'expiry_days', label: tx('admin.perps.ref.expiry'), type: 'number', step: '1', required: true, value: s.expiry_days },
    { name: 'signup_window_days', label: tx('admin.perps.ref.window'), type: 'number', step: '1', required: true, value: s.signup_window_days },
    { name: 'lifetime_cap_count', label: tx('admin.perps.ref.cap_count'), type: 'number', step: '1', required: true, value: s.lifetime_cap_count },
    centsField('lifetime_cap_cents', 'admin.perps.ref.cap_amount'),
    { name: 'reason', label: tx('admin.perps.common.reason'), required: true, span: true },
  ];
  const c = d.counts || {};
  box.innerHTML = `<p class="faint" data-testid="pops-ref-counts">${te('admin.perps.ref.counts', { pending: n(c.pending), rewarded: n(c.rewarded), expired: n(c.expired), total: esc(moneyCents(d.rewards_total_cents)) })}</p>${formHtml(fields, { submit: tx('admin.perps.ref.save'), id: 'pref', testid: 'pops-ref-form' })}
    ${d.rewards.length ? `<table class="adm-table"><thead><tr><th>${te('admin.perps.waitlist.user')}</th><th>${te('admin.perps.ref.role')}</th><th class="num">${te('admin.perps.ref.amount')}</th><th>${te('admin.perps.waitlist.status')}</th><th>${te('admin.perps.ref.time')}</th></tr></thead><tbody>${d.rewards.map((r) => `<tr data-testid="pops-ref-reward" data-status="${esc(r.status)}"><td>${esc(r.user)}</td><td>${esc(r.role)}</td><td class="num">${esc(moneyCents(r.amount_cents))}</td><td>${esc(r.status)}</td><td>${esc(fmtTime(r.created_time))}</td></tr>`).join('')}</tbody></table>` : ''}`;
  const toCents = (v) => Math.round(toApiDollars(v) * 100);
  wireForm(box.querySelector('form'), fields, async (v) => {
    await put('/perps_ops/referrals', { enabled: v.enabled, reward_referrer_cents: toCents(v.reward_referrer_cents), reward_referee_cents: toCents(v.reward_referee_cents), threshold_cents: toCents(v.threshold_cents), expiry_days: v.expiry_days, signup_window_days: v.signup_window_days, lifetime_cap_count: v.lifetime_cap_count, lifetime_cap_cents: toCents(v.lifetime_cap_cents), reason: v.reason });
    toast(tx('admin.perps.ref.saved'));
    await referrals(box);
  });
}

// ---------------------------------------------------------------- perps journal
async function ledger(box) {
  const l = await get('/perps_ops/ledger');
  box.innerHTML = `<p data-testid="pops-ledger-status">${l.ok ? badge(tx('admin.perps.ledger.ok'), 'ok') : badge(tx('admin.perps.ledger.problems', { count: l.problems.length }), 'bad')} <span class="faint">${te('admin.perps.ledger.entries', { count: n(l.entries) })}</span></p>
    <dl class="adm-dl"><dt>${te('admin.perps.ledger.insurance')}</dt><dd data-testid="pops-insurance">${money(l.insurance_dollars, { exact: 4 })}</dd><dt>${te('admin.perps.ledger.backstop')}</dt><dd>${money(l.backstop_dollars, { exact: 4 })}</dd><dt>${te('admin.perps.ledger.fees')}</dt><dd>${money(l.fees_dollars, { exact: 4 })}</dd></dl>
    ${l.problems.length ? `<ul class="faint">${l.problems.map((p) => `<li>${esc(p.check)}: ${esc(p.detail)} ${esc(p.account || '')}</li>`).join('')}</ul>` : ''}`;
}
