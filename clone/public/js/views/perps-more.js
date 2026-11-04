// Perps completion UI (CLONE_SPEC.md §34): subaccounts and transfers, order groups, margin tiers, trailing stops, order
// amend / decrease, the waitlist, interest on collateral (APY) and referrals. views/perps.js uses these builders on the
// market page and in the Perps portfolio. Money goes to the API in dollars (toApiDollars), shown in the display currency.
import { t as tx, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/perps2-strings.js';
import { perpsApi as P } from '../perps-api.js';
import { flagOn } from '../flags.js';
import { esc, money, toast, toApiDollars, validMoneyInput, moneyInputHint, moneyMin, moneyStep, sym, fmtDt } from '../lib.js';

const n = (s) => Number(s ?? 0);
const when = (iso) => (iso ? fmtDt(iso, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const pct = (r, d = 2) => `${(n(r) * 100).toFixed(d)}%`;
export const subLabel = (s) => (Number(s.subaccount) === 0 ? tx('perps2.sub.primary_label', { name: s.name }) : tx('perps2.sub.label', { n: s.subaccount, name: s.name }));
export const modeLabel = (mode) => (mode === 'cross' ? tx('perps2.sub.mode_cross') : tx('perps2.sub.mode_isolated'));
// Whole or fractional contract counts, shown with up to 2 decimals.
export const contracts = (v) => n(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
export const fractionalOn = (m) => !!m.fractional_trading_enabled && flagOn('perps.fractional');

// ---------------------------------------------------------------- size tiers (client copy of server/perps-risk.js)
const tiersCc = (m) => (m.margin_tiers || []).map((t) => ({ cap: n(t.max_notional_dollars) * 10000, im: n(t.initial_margin_rate), mm: n(t.maintenance_margin_rate) }));
function bracket(tiers, N, key) {
  let lo = 0; let sum = 0;
  for (const t of tiers) { if (N <= lo) break; sum += (Math.min(N, t.cap) - lo) * t[key]; lo = t.cap; }
  if (N > lo && tiers.length) sum += (N - lo) * tiers[tiers.length - 1][key];
  return sum;
}
// Blended maximum leverage at a notional (dollars) and the tier it falls in.
export function tierAt(m, notionalDollars) {
  const tiers = tiersCc(m); const N = n(notionalDollars) * 10000;
  if (!tiers.length) return { tier: 1, maxLev: n(m.max_leverage) };
  const im = bracket(tiers, N, 'im');
  const i = tiers.findIndex((t) => N <= t.cap);
  return { tier: i < 0 ? tiers.length : i + 1, maxLev: N > 0 ? N / im : 1 / tiers[0].im, overCap: N > tiers[tiers.length - 1].cap };
}
// Estimated liquidation price (per contract, dollars) of a new isolated position: contracts q (signed), entry px, margin.
export function estLiq(m, q, px, margin) {
  const tiers = tiersCc(m);
  if (!q || !tiers.length) return null;
  const a = Math.abs(q); const A = margin * 10000 - q * px * 10000; // cc
  let lo = 0; let fixed = 0;
  for (let k = 0; k < tiers.length; k++) {
    const t = tiers[k]; const d = fixed - t.mm * lo; const last = k === tiers.length - 1;
    const mm = q > 0 ? (d - A) / (a * (1 - t.mm)) : (d - A) / (-a * (1 + t.mm));
    const N = a * mm;
    if (mm > 0 && N >= lo - 1e-6 && (last || N <= t.cap + 1e-6)) return Math.round(mm) / 10000;
    fixed += t.mm * (t.cap - lo); lo = t.cap;
  }
  return null;
}
export function tiersHtml(m) {
  const ts = m.margin_tiers || [];
  if (!ts.length) return '';
  let lo = 0;
  return `<h4 class="perps-sub">${te('perps2.tiers.title')}</h4><div class="perps-scroll"><table class="table" data-testid="perp-tiers"><thead><tr><th>${te('perps2.tiers.tier')}</th><th class="num">${te('perps2.tiers.position_size')}</th><th class="num">${te('perps2.tiers.initial')}</th><th class="num">${te('perps2.tiers.maintenance')}</th><th class="num">${te('perps2.tiers.max_leverage')}</th></tr></thead><tbody>
    ${ts.map((t) => { const from = lo; lo = n(t.max_notional_dollars); return `<tr data-testid="perp-tier-row" data-tier="${Number(t.tier)}"><td>${Number(t.tier)}</td><td class="num">${te('perps2.tiers.range', { from: esc(money(from)), to: esc(money(t.max_notional_dollars)) })}</td><td class="num">${pct(t.initial_margin_rate)}</td><td class="num">${pct(t.maintenance_margin_rate)}</td><td class="num">${n(t.max_leverage).toFixed(1)}x</td></tr>`; }).join('')}</tbody></table></div>
    <p class="faint">${te('perps2.tiers.note', { max: esc(money(m.max_position_notional_dollars)) })}</p>`;
}

// ---------------------------------------------------------------- subaccount picker
export function subSelect(subs, current, testid) {
  return `<select class="perps-select" data-testid="${esc(testid)}" aria-label="${te('perps2.sub.select_aria')}">${subs.map((s) => `<option value="${Number(s.subaccount)}"${Number(s.subaccount) === Number(current) ? ' selected' : ''}>${esc(subLabel(s))}</option>`).join('')}</select>`;
}

// ---------------------------------------------------------------- waitlist
export function waitlistHtml(w) {
  if (w.status === 'revoked') return `<div class="perps-waitlist" data-testid="perps-waitlist" data-status="revoked"><h3 class="perps-box-title">${te('perps2.waitlist.title')}</h3><p class="muted">${te('perps2.waitlist.revoked')}</p></div>`;
  if (w.has_joined && w.status === 'waiting') {
    return `<div class="perps-waitlist" data-testid="perps-waitlist" data-status="waiting"><h3 class="perps-box-title">${te('perps2.waitlist.title')}</h3>
      <p class="perps-waitlist-pos" data-testid="waitlist-position">${te('perps2.waitlist.position', { position: Number(w.position || 0), total: Number(w.waiting_count || 0) })}</p>
      <p class="faint">${te('perps2.waitlist.waiting_note')}</p></div>`;
  }
  return `<div class="perps-waitlist" data-testid="perps-waitlist" data-status="not_joined"><h3 class="perps-box-title">${te('perps2.waitlist.title')}</h3>
    <p class="muted">${te('perps2.waitlist.intro', { total: Number(w.waiting_count || 0) })}</p>
    <button class="btn btn-primary perps-submit" type="button" data-testid="waitlist-join">${te('perps2.waitlist.join')}</button></div>`;
}
export function wireWaitlist(root, onChange) {
  const b = root.querySelector('[data-testid=waitlist-join]');
  if (!b) return;
  b.onclick = async () => {
    b.disabled = true;
    try { const r = await P.joinWaitlist(); toast(tx('perps2.waitlist.joined_toast', { position: r.waitlist.position })); onChange(r.waitlist); } catch (e) { toast(e.message, 'error'); b.disabled = false; }
  };
}

// ---------------------------------------------------------------- order amend (inline editor under an order row)
export function wireAmend(root, orders, metas, { toLevel, toContract, onDone }) {
  for (const b of root.querySelectorAll('[data-amend]')) {
    b.onclick = () => {
      const tr = b.closest('tr');
      if (tr.nextElementSibling && tr.nextElementSibling.classList.contains('perps-amend-row')) { tr.nextElementSibling.remove(); return; }
      const o = orders.find((x) => x.order_id === b.dataset.amend);
      const m = metas.get(o.ticker);
      const frac = fractionalOn(m);
      tr.insertAdjacentHTML('afterend', `<tr class="perps-amend-row"><td colspan="${tr.children.length}"><form class="perps-tpsl" data-testid="amend-form" data-order="${esc(o.order_id)}">
        <label>${te('perps2.amend.price')} <input name="price" type="number" step="any" inputmode="decimal" value="${esc(toLevel(m, o.price))}" data-testid="amend-price"></label>
        <label>${te('perps2.amend.count')} <input name="count" type="number" min="0" step="${frac ? '0.01' : '1'}" inputmode="decimal" value="${esc(String(n(o.remaining_count)))}" data-testid="amend-count"></label>
        <button class="btn btn-sm btn-primary" type="submit" data-testid="amend-save">${te('perps2.amend.save')}</button>
        <span class="faint">${te('perps2.amend.hint')}</span>
        <span class="form-error" role="alert" data-testid="amend-error"></span></form></td></tr>`);
      const f = tr.nextElementSibling.querySelector('form');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const err = f.querySelector('[data-testid=amend-error]');
        err.textContent = '';
        const count = f.count.value.trim(); const price = toContract(m, f.price.value.trim());
        try {
          const samePrice = Number(price) === n(o.price);
          if (samePrice && n(count) < n(o.remaining_count)) {
            const r = await P.decreaseOrder(o.order_id, { reduce_to: count });
            toast(r.order.status === 'canceled' ? tx('perps2.amend.canceled') : tx('perps2.amend.decreased', { count: contracts(r.order.remaining_count) }));
          } else {
            const r = await P.amendOrder(o.order_id, { price, count });
            toast(tx('perps2.amend.amended', { count: contracts(r.order.remaining_count) }));
          }
          f.closest('tr').remove();
          onDone();
        } catch (er) { err.textContent = er.message; }
      };
    };
  }
}

// ---------------------------------------------------------------- trailing stop (inline editor under a position row)
export function trailText(m, ts, fmtPx) {
  return ts ? tx('perps2.trail.active', { trail: ts.trail_percent != null ? `${n(ts.trail_percent)}%` : fmtPx(m, ts.trail_amount), stop: fmtPx(m, ts.stop_price) }) : tx('perps2.trail.add');
}
export function wireTrailing(root, positions, metas, { fmtPx, toContract, onDone }) {
  for (const b of root.querySelectorAll('[data-trail]')) {
    b.onclick = () => {
      const tr = b.closest('tr');
      if (tr.nextElementSibling && tr.nextElementSibling.classList.contains('perps-trail-row')) { tr.nextElementSibling.remove(); return; }
      const p = positions.find((x) => x.market_ticker === b.dataset.trail && Number(x.subaccount) === Number(b.dataset.sub || 0));
      const m = metas.get(p.market_ticker);
      const ts = p.trailing_stop;
      tr.insertAdjacentHTML('afterend', `<tr class="perps-trail-row"><td colspan="${tr.children.length}"><form class="perps-tpsl" data-testid="trail-form">
        <label>${te('perps2.trail.percent')} <input name="pct" type="number" step="0.1" min="0.1" max="50" inputmode="decimal" value="${ts && ts.trail_percent != null ? Number(ts.trail_percent) : ''}" data-testid="trail-input"></label>
        <span class="faint">${te('perps2.trail.hint', { side: esc(n(p.position) > 0 ? tx('perps2.trail.below_high') : tx('perps2.trail.above_low')) })}</span>
        <button class="btn btn-sm btn-primary" type="submit" data-testid="trail-save">${te('perps2.trail.save')}</button>
        ${ts ? `<button class="btn btn-sm btn-ghost" type="button" data-clear data-testid="trail-clear">${te('perps2.trail.remove')}</button>` : ''}
        <span class="form-error" role="alert" data-testid="trail-error"></span></form></td></tr>`);
      const f = tr.nextElementSibling.querySelector('form');
      void toContract;
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await P.setExitTrigger(p.market_ticker, { kind: 'trailing', trail_percent: f.pct.value.trim(), subaccount: Number(p.subaccount) });
          toast(tx('perps2.trail.saved'));
          f.closest('tr').remove();
          onDone();
        } catch (er) { f.querySelector('[data-testid=trail-error]').textContent = er.message; }
      };
      const clr = f.querySelector('[data-clear]');
      if (clr) clr.onclick = async () => { try { await P.clearExitTrigger(p.market_ticker, 'trailing', Number(p.subaccount)); toast(tx('perps2.trail.removed')); f.closest('tr').remove(); onDone(); } catch (er) { toast(er.message, 'error'); } };
    };
  }
}

// ---------------------------------------------------------------- Perps portfolio: subaccounts
export async function subaccountsPanel(panel, refresh) {
  const { subaccounts: subs, max_subaccounts: max } = await P.subaccounts();
  const moneyInput = (id, testid) => `<input id="${esc(id)}" type="number" min="${esc(moneyMin())}" step="${esc(moneyStep())}" inputmode="decimal" placeholder="${esc(sym())}" data-testid="${esc(testid)}" aria-label="${te('perps2.sub.amount')}">`;
  panel.innerHTML = `<div data-testid="perp-subaccounts-panel">
    <div class="perps-scroll"><table class="table" data-testid="perp-subaccounts"><thead><tr><th>${te('perps2.sub.account')}</th><th>${te('perps2.sub.margin')}</th><th class="num">${te('perps2.sub.available')}</th><th class="num">${te('perps2.sub.equity')}</th><th class="num">${te('perps2.sub.maintenance')}</th><th class="num">${te('perps2.sub.ratio')}</th><th></th></tr></thead><tbody>
      ${subs.map((s) => `<tr data-testid="perp-sub-row" data-sub="${Number(s.subaccount)}"><td><strong>${esc(subLabel(s))}</strong></td><td data-f="mode">${esc(modeLabel(s.margin_mode))}</td><td class="num" data-f="available">${money(s.available_balance)}</td><td class="num" data-f="equity">${money(s.account_equity)}</td><td class="num">${money(s.maintenance_margin)}</td><td class="num">${s.margin_ratio == null ? '—' : Number(s.margin_ratio).toFixed(2)}</td>
        <td><button class="btn btn-sm btn-ghost" type="button" data-mode="${Number(s.subaccount)}" data-to="${s.margin_mode === 'cross' ? 'isolated' : 'cross'}" data-testid="sub-mode-btn" data-flag="perps.portfolio_margin">${s.margin_mode === 'cross' ? te('perps2.sub.to_isolated') : te('perps2.sub.to_cross')}</button></td></tr>`).join('')}</tbody></table></div>
    <div class="perps-duo">
      <form class="perps-form" data-testid="sub-create-form"><h4 class="perps-sub">${te('perps2.sub.new')}</h4>
        <label class="perps-field"><span>${te('perps2.sub.name')}</span><input name="name" maxlength="40" data-testid="sub-name" aria-label="${te('perps2.sub.name')}"></label>
        <label class="perps-field"><span>${te('perps2.sub.margin')}</span><select name="mode" class="perps-select" data-testid="sub-mode"><option value="isolated">${te('perps2.sub.mode_isolated')}</option><option value="cross" data-flag="perps.portfolio_margin">${te('perps2.sub.mode_cross')}</option></select></label>
        <button class="btn btn-primary" type="submit" data-testid="sub-create"${subs.length >= max ? ' disabled' : ''}>${te('perps2.sub.create')}</button>
        <p class="faint">${te('perps2.sub.limit', { used: subs.length, max: Number(max) })}</p>
        <div class="form-error" role="alert" data-testid="sub-create-error"></div></form>
      <form class="perps-form" data-testid="subx-form"><h4 class="perps-sub">${te('perps2.sub.move')}</h4>
        <label class="perps-field"><span>${te('perps2.sub.from')}</span>${subSelect(subs, 0, 'subx-from')}</label>
        <label class="perps-field"><span>${te('perps2.sub.to')}</span>${subSelect(subs, subs.length > 1 ? subs[1].subaccount : 0, 'subx-to')}</label>
        <label class="perps-field"><span>${te('perps2.sub.amount')}</span>${moneyInput('subx-amount', 'subx-amount')}</label>
        <button class="btn btn-primary" type="submit" data-testid="subx-submit">${te('perps2.sub.move_button')}</button>
        <div class="form-error" role="alert" data-testid="subx-error"></div></form>
    </div></div>`;
  const cf = panel.querySelector('[data-testid=sub-create-form]');
  cf.onsubmit = async (e) => {
    e.preventDefault();
    const err = cf.querySelector('[data-testid=sub-create-error]'); err.textContent = '';
    try { const r = await P.createSubaccount({ name: cf.name.value.trim(), margin_mode: cf.mode.value }); toast(tx('perps2.sub.created', { n: r.subaccount })); await refresh(); } catch (er) { err.textContent = er.message; }
  };
  const xf = panel.querySelector('[data-testid=subx-form]');
  xf.onsubmit = async (e) => {
    e.preventDefault();
    const err = xf.querySelector('[data-testid=subx-error]'); err.textContent = '';
    const raw = xf.querySelector('#subx-amount').value;
    if (!validMoneyInput(raw)) { err.textContent = tx('perps2.sub.amount_invalid', { hint: moneyInputHint() }); return; }
    const amt = toApiDollars(raw);
    try {
      await P.subTransfer(Number(xf.querySelector('[data-testid=subx-from]').value), Number(xf.querySelector('[data-testid=subx-to]').value), amt);
      toast(tx('perps2.sub.moved', { amount: money(amt) }));
      await refresh();
    } catch (er) { err.textContent = er.message; }
  };
  for (const b of panel.querySelectorAll('[data-mode]')) {
    b.onclick = async () => { b.disabled = true; try { await P.updateSubaccount(Number(b.dataset.mode), { margin_mode: b.dataset.to }); toast(tx('perps2.sub.mode_saved', { mode: modeLabel(b.dataset.to) })); } catch (er) { toast(er.message, 'error'); } await refresh(); };
  }
}

// ---------------------------------------------------------------- Perps portfolio: order groups
export async function groupsPanel(panel, refresh) {
  const { order_groups: groups } = await P.orderGroups();
  panel.innerHTML = `<div data-testid="perp-groups-panel">
    <form class="perps-form perps-inline" data-testid="og-form">
      <label class="perps-field"><span>${te('perps2.groups.kind')}</span><select name="kind" class="perps-select" data-testid="og-kind"><option value="limit">${te('perps2.groups.kind_limit')}</option><option value="oco">${te('perps2.groups.kind_oco')}</option></select></label>
      <label class="perps-field" data-limit-field><span>${te('perps2.groups.limit')}</span><input name="limit" type="number" min="0.01" step="0.01" inputmode="decimal" data-testid="og-limit" aria-label="${te('perps2.groups.limit')}"></label>
      <button class="btn btn-primary" type="submit" data-testid="og-create">${te('perps2.groups.create')}</button>
      <div class="form-error" role="alert" data-testid="og-error"></div></form>
    <p class="faint">${te('perps2.groups.help')}</p>
    ${groups.length ? `<div class="perps-scroll"><table class="table" data-testid="perp-groups"><thead><tr><th>${te('perps2.groups.group')}</th><th>${te('perps2.groups.kind')}</th><th class="num">${te('perps2.groups.filled')}</th><th class="num">${te('perps2.groups.open')}</th><th>${te('perps2.groups.status')}</th><th></th></tr></thead><tbody>
      ${groups.map((g) => `<tr data-testid="perp-group-row" data-group="${esc(g.order_group_id)}" data-status="${esc(g.status)}"><td><code>${esc(g.order_group_id.slice(-6))}</code></td><td>${g.kind === 'oco' ? te('perps2.groups.kind_oco') : te('perps2.groups.kind_limit')}</td>
        <td class="num">${g.kind === 'oco' ? esc(contracts(g.filled_count)) : te('perps2.groups.filled_of', { filled: esc(contracts(g.filled_count)), limit: esc(contracts(g.contracts_limit)) })}</td><td class="num" data-f="open">${Number(g.open_orders)}</td><td data-f="status">${esc(tx(`perps2.groups.status_${g.status}`))}</td>
        <td class="perps-actions">${g.status !== 'canceled' ? `<button class="btn btn-sm" type="button" data-og-cancel="${esc(g.order_group_id)}" data-testid="og-cancel">${te('perps2.groups.cancel_all')}</button>` : ''}${g.status === 'triggered' ? `<button class="btn btn-sm btn-ghost" type="button" data-og-reset="${esc(g.order_group_id)}" data-testid="og-reset">${te('perps2.groups.reset')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty" data-testid="perp-no-groups">${te('perps2.groups.none')}</div>`}</div>`;
  const f = panel.querySelector('[data-testid=og-form]');
  const syncKind = () => { f.querySelector('[data-limit-field]').hidden = f.kind.value === 'oco'; };
  f.kind.onchange = syncKind; syncKind();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('[data-testid=og-error]'); err.textContent = '';
    try { await P.createOrderGroup(f.kind.value === 'oco' ? { kind: 'oco' } : { kind: 'limit', contracts_limit: f.limit.value.trim() }); toast(tx('perps2.groups.created')); await refresh(); } catch (er) { err.textContent = er.message; }
  };
  for (const b of panel.querySelectorAll('[data-og-cancel]')) b.onclick = async () => { b.disabled = true; try { const r = await P.cancelOrderGroup(b.dataset.ogCancel); toast(tx('perps2.groups.canceled', { count: r.canceled_count })); } catch (er) { toast(er.message, 'error'); } await refresh(); };
  for (const b of panel.querySelectorAll('[data-og-reset]')) b.onclick = async () => { b.disabled = true; try { await P.resetOrderGroup(b.dataset.ogReset); toast(tx('perps2.groups.reset_done')); } catch (er) { toast(er.message, 'error'); } await refresh(); };
}
export const groupOptions = (groups, sub) => groups.filter((g) => g.status === 'active' && Number(g.subaccount) === Number(sub));

// ---------------------------------------------------------------- Perps portfolio: rewards (APY + referrals)
export async function rewardsPanel(panel, refresh) {
  const [apy, ref] = await Promise.all([flagOn('perps.apy') ? P.apy().then((r) => r.apy).catch(() => null) : null, flagOn('perps.referrals') ? P.referrals().then((r) => r.referrals).catch(() => null) : null]);
  const apyHtml = apy ? `<section class="card perps-box" data-testid="perps-apy"><h3 class="perps-box-title">${te('perps2.apy.title')}</h3>
      <div class="perps-kv"><span>${te('perps2.apy.rate')}</span><strong data-testid="apy-rate">${apy.enabled ? te('perps2.apy.rate_value', { rate: Number(apy.rate_percent).toFixed(2) }) : te('perps2.apy.off')}</strong></div>
      <div class="perps-kv"><span>${te('perps2.apy.accrued')}</span><strong data-testid="apy-accrued">${money(apy.total_accrued_dollars, { exact: 4 })}</strong></div>
      <div class="perps-kv"><span>${te('perps2.apy.paid')}</span><strong data-testid="apy-paid">${money(apy.total_paid_dollars)}</strong></div>
      <div class="perps-kv"><span>${te('perps2.apy.next')}</span><strong>${esc(when(apy.next_payout_time))}</strong></div>
      <p class="faint">${te('perps2.apy.note')}</p>
      ${apy.payouts.length ? `<div class="perps-scroll"><table class="table"><thead><tr><th>${te('perps2.apy.time')}</th><th>${te('perps2.sub.account')}</th><th class="num">${te('perps2.apy.amount')}</th><th>${te('perps2.apy.status')}</th></tr></thead><tbody>${apy.payouts.map((p) => `<tr data-testid="perp-apy-row" data-status="${esc(p.status)}"><td>${esc(when(p.created_time))}</td><td>${Number(p.subaccount)}</td><td class="num">${money(p.amount_dollars)}</td><td>${esc(tx(`perps2.apy.status_${p.status}`))}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty faint">${te('perps2.apy.none')}</div>`}
    </section>` : '';
  const refHtml = ref ? `<section class="card perps-box" data-testid="perps-referrals"><h3 class="perps-box-title">${te('perps2.ref.title')}</h3>
      <p class="muted">${te('perps2.ref.offer', { referrer: esc(money(ref.current_offer.referrer_dollars)), referee: esc(money(ref.current_offer.referee_dollars)), threshold: esc(money(ref.current_offer.threshold_dollars)), days: Number(ref.current_offer.expiry_days) })}</p>
      <div class="perps-kv"><span>${te('perps2.ref.your_code')}</span><strong data-testid="ref-code">${esc(ref.referral_code)}</strong></div>
      <div class="perps-kv"><span>${te('perps2.ref.earned')}</span><strong data-testid="ref-earned">${money(ref.total_earned_dollars)}</strong></div>
      <div class="perps-kv"><span>${te('perps2.ref.counts')}</span><strong data-testid="ref-counts">${te('perps2.ref.counts_value', { pending: Number(ref.pending_count), completed: Number(ref.completed_count), expired: Number(ref.expired_count) })}</strong></div>
      ${ref.referred_by ? `<p class="faint" data-testid="ref-referred">${te('perps2.ref.referred', { status: esc(tx(`perps2.ref.status_${ref.referred_by.status}`)), progress: esc(money(ref.referred_by.progress_dollars)), threshold: esc(money(ref.referred_by.threshold_dollars)) })}</p>`
        : `<form class="perps-xfer" data-testid="ref-form"><input name="code" maxlength="16" autocomplete="off" placeholder="${te('perps2.ref.placeholder')}" aria-label="${te('perps2.ref.placeholder')}" data-testid="ref-input"><div class="perps-xfer-btns"><button class="btn btn-primary" type="submit" data-testid="ref-apply">${te('perps2.ref.apply')}</button></div><div class="form-error" role="alert" data-testid="ref-error"></div></form>`}
      ${ref.rewards.length ? `<div class="perps-scroll"><table class="table"><thead><tr><th>${te('perps2.apy.time')}</th><th>${te('perps2.ref.role')}</th><th class="num">${te('perps2.apy.amount')}</th><th>${te('perps2.apy.status')}</th></tr></thead><tbody>${ref.rewards.map((w) => `<tr data-testid="perp-reward-row" data-role="${esc(w.role)}" data-status="${esc(w.status)}"><td>${esc(when(w.created_time))}</td><td>${esc(tx(`perps2.ref.role_${w.role}`))}</td><td class="num">${money(w.amount_dollars)}</td><td>${esc(tx(`perps2.apy.status_${w.status}`))}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </section>` : '';
  panel.innerHTML = `<div class="perps-duo" data-testid="perp-rewards-panel">${apyHtml}${refHtml}</div>${!apy && !ref ? `<div class="empty">${te('perps2.rewards.none')}</div>` : ''}`;
  const f = panel.querySelector('[data-testid=ref-form]');
  if (f) f.onsubmit = async (e) => { e.preventDefault(); const err = f.querySelector('[data-testid=ref-error]'); err.textContent = ''; try { await P.applyReferral(f.code.value.trim()); toast(tx('perps2.ref.applied')); await refresh(); } catch (er) { err.textContent = er.message; } };
}
