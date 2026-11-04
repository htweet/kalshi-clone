// Users (search, detail with balances / positions / orders / ledger / limits / MFA, audited support actions) and
// Roles (staff role assignments + permission matrix).
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.users-strings.js';
import { t as T } from '../../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { pxc, sym, currency, toApiDollars, moneyStep } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, post, put, toast, dataTable, formHtml, wireForm, dialog, confirmAction, section, badge, fmtTime, fmtQty, fmtMoney } from './ui.js';

export async function render({ el, section: sec, parts, perms, navigate }) {
  if (sec === 'roles') return renderRoles(el);
  if (parts[0]) return renderUser(el, parts[0], perms, navigate);
  el.innerHTML = section(tx('admin.users.render.users'), tx('admin.users.render.search_by_email_display_name')) +
    `<form class="adm-search-row" data-search role="search"><input type="search" class="adm-input" name="q" placeholder="${te('admin.users.render.search_users')}" aria-label="${te('admin.users.render.search_users')}" data-testid="user-search"><button class="btn" type="submit">${te('admin.users.render.search')}</button></form><div id="ul"></div>`;
  const t = dataTable(el.querySelector('#ul'), { search: false, testid: 'user-results', rowAttrs: (r) => `data-row="${esc(r.user_id)}" data-email="${esc(r.email)}"`,
    cols: [{ key: 'email', label: tx('admin.users.render.email'), render: (r) => `<a href="/admin/users/${encodeURIComponent(r.user_id)}" data-link>${esc(r.email)}</a>` }, { key: 'display_name', label: tx('admin.users.render.name') },
      { key: 'nickname', label: tx('admin.users.render.nickname'), render: (r) => (r.nickname ? `@${esc(r.nickname)}` : '—') }, { key: 'balance_dollars', label: tx('admin.users.render.cash'), num: true, render: (r) => fmtMoney(r.balance_dollars) },
      { key: 'created_at', label: tx('admin.users.render.joined'), render: (r) => esc(fmtTime(r.created_at)) },
      { key: 'locked', label: tx('admin.users.render.flags'), sort: false, render: (r) => [r.locked && badge('locked', 'bad'), r.banned && badge('posting banned', 'warn'), r.is_system && badge('system'), ...r.roles.map((x) => badge(x, 'brand'))].filter(Boolean).join(' ') }] });
  const run = async (q) => { const r = await get(`/users?q=${encodeURIComponent(q)}&limit=200`); t.setRows(r.users); };
  el.querySelector('[data-search]').addEventListener('submit', (e) => { e.preventDefault(); run(e.target.q.value.trim()).catch((ex) => toast(ex.message, 'error')); });
  await run('');
}

async function renderUser(el, id, perms, navigate) {
  const [d, mc] = await Promise.all([get(`/users/${encodeURIComponent(id)}`), get(`/users/${encodeURIComponent(id)}/money_controls`)]); // money controls (CLONE_SPEC.md §33)
  const u = d.user;
  const lim = (l, money) => (l ? `${money ? (l.limit_dollars == null ? 'none' : fmtMoney(l.limit_dollars)) : (l.limit_minutes == null ? 'none' : te('admin.users.render_user.min', { limit_minutes: esc(l.limit_minutes) }))} <span class="faint">${te('admin.users.render_user.used_today', { value: money ? fmtMoney(l.used_today_dollars) : te('admin.users.render_user.min_2', { round: Math.round(l.used_today_seconds / 60) }), value_2: l.pending ? (' ' + te('admin.users.render_user.change_pending')) : '' })}</span>` : '—');
  const can = (p) => perms.has(p);
  el.innerHTML = section(u.display_name, `${esc(u.email)}${u.nickname ? ` · @${esc(u.nickname)}` : ''} · joined ${esc(fmtTime(u.created_at))}`, `<a class="btn" href="/admin/users" data-link>${te('admin.users.render_user.all_users')}</a>`) +
    `<div class="adm-tiles" data-testid="user-detail" data-user="${esc(u.user_id)}">
      <div class="adm-tile"><span>${te('admin.users.render_user.cash')}</span><b data-testid="user-cash">${fmtMoney(d.balance.balance_dollars)}</b></div>
      <div class="adm-tile"><span>${te('admin.users.render_user.reserved_in_orders')}</span><b>${fmtMoney(d.balance.reserved_dollars)}</b></div>
      <div class="adm-tile"><span>${te('admin.users.render_user.positions_value')}</span><b>${fmtMoney(d.balance.portfolio_value_dollars)}</b></div>
      <div class="adm-tile"><span>${te('admin.users.render_user.status')}</span><b data-testid="user-status">${u.locked ? badge(tx('admin.users.render_user.locked'), 'bad') : badge(tx('admin.users.render_user.active'), 'ok')} ${u.banned ? badge('posting banned', 'warn') : ''}</b></div>
      <div class="adm-tile"><span>${te('admin.users.render_user.two_factor')}</span><b data-testid="user-mfa">${d.mfa_enabled ? te('admin.users.render_user.on') : te('admin.users.render_user.off')}</b></div>
      <div class="adm-tile"><span>${te('admin.users.render_user.sessions')}</span><b>${esc(d.sessions)}</b></div>
    </div>
    ${u.lock ? `<div class="adm-banner bad" role="status">${te('admin.users.render_user.locked_by_on', { value: esc(u.lock.locked_by || ''), fmt_time: esc(fmtTime(u.lock.locked_at)), reason: esc(u.lock.reason) })}</div>` : ''}
    <div class="adm-actions adm-user-actions">
      ${can('users.money') ? `<button class="btn btn-primary" data-act="adjust" data-testid="user-adjust">${te('admin.users.render_user.adjust_balance')}</button>` : ''}
      ${can('users.support') ? (u.locked ? `<button class="btn" data-act="unlock" data-testid="user-unlock">${te('admin.users.render_user.unlock_account')}</button>` : `<button class="btn btn-danger-solid" data-act="lock" data-testid="user-lock">${te('admin.users.render_user.lock_account')}</button>`) : ''}
      ${can('users.support') ? `<button class="btn" data-act="reset_mfa" ${d.mfa_enabled ? '' : 'disabled'}>${te('admin.users.render_user.reset_two_factor')}</button><button class="btn" data-act="clear_session_time">${te('admin.users.render_user.clear_session_time')}</button>` : ''}
    </div>
    <div class="adm-two">
      <div class="card adm-card"><h3>${te('admin.users.render_user.limits')}</h3><dl class="adm-dl" data-testid="user-limits"><dt>${te('admin.users.render_user.deposit_day')}</dt><dd>${lim(d.limits.deposit, true)}</dd><dt>${te('admin.users.render_user.trading_day')}</dt><dd>${lim(d.limits.trading, true)}</dd><dt>${te('admin.users.render_user.session_day')}</dt><dd>${lim(d.limits.session, false)}</dd></dl>
        ${can('users.money') ? `<button class="btn btn-sm" data-act="limits">${te('admin.users.render_user.override_a_limit')}</button>` : ''}</div>
      <div class="card adm-card" data-testid="user-money-controls"><h3>${te('admin.users.money.title')}</h3>
        <p>${te('admin.users.money.deposits')} ${mc.money_controls.deposits_revoked ? badge(tx('admin.users.money.revoked'), 'bad') : badge(tx('admin.users.money.allowed'), 'ok')} · ${te('admin.users.money.withdrawals')} ${mc.money_controls.withdrawals_revoked ? badge(tx('admin.users.money.revoked'), 'bad') : badge(tx('admin.users.money.allowed'), 'ok')}</p>
        ${mc.money_controls.reason && (mc.money_controls.deposits_revoked || mc.money_controls.withdrawals_revoked) ? `<p class="faint">${te('admin.users.money.reason', { reason: esc(mc.money_controls.reason) })}</p>` : ''}
        ${mc.history.length ? `<ul class="adm-list" data-testid="money-controls-history">${mc.history.slice(0, 5).map((h) => `<li class="faint">${te('admin.users.money.history', { time: esc(fmtTime(h.time)), who: esc(h.actor_email || ''), dep: h.deposits_revoked ? te('admin.users.money.revoked') : te('admin.users.money.allowed'), wd: h.withdrawals_revoked ? te('admin.users.money.revoked') : te('admin.users.money.allowed'), reason: esc(h.reason) })}</li>`).join('')}</ul>` : ''}
        ${can('users.money') ? `<button class="btn btn-sm" data-act="money_controls" data-testid="user-money-controls-btn">${te('admin.users.money.change')}</button>` : ''}</div>
      <div class="card adm-card"><h3>${te('admin.users.render_user.recent_admin_actions')}</h3>${d.audit.length ? `<ul class="adm-list">${d.audit.map((a) => `<li><b>${esc(a.action)}</b> <span class="faint">${esc(fmtTime(a.time))} · ${esc(a.actor_email || '')}</span><div class="muted">${esc(a.reason)}</div></li>`).join('')}</ul>` : `<p class="faint">${te('admin.users.render_user.none')}</p>`}</div>
    </div>
    <h3 class="adm-h3">${te('admin.users.render_user.positions')}</h3><div id="u-pos"></div>
    <h3 class="adm-h3">${te('admin.users.render_user.resting_orders')}</h3><div id="u-ord"></div>
    <h3 class="adm-h3">${te('admin.users.render_user.ledger')} <span class="faint">${te('admin.users.render_user.latest_50_of', { transactions_total: esc(d.transactions_total) })}</span></h3><div id="u-led"></div>`;
  dataTable(el.querySelector('#u-pos'), { search: false, rows: d.positions, empty: tx('admin.users.render_user.no_positions'), testid: 'user-positions',
    cols: [{ key: 'ticker', label: 'Market', render: (r) => `<code>${esc(r.ticker)}</code><div class="faint">${esc(r.outcome || '')}</div>` }, { key: 'side', label: tx('admin.users.render_user.side'), render: (r) => (r.side ? r.side.toUpperCase() : '—') },
      { key: 'position_fp', label: tx('admin.users.render_user.contracts'), num: true, render: (r) => fmtQty(r.position_fp) }, { key: 'total_cost_dollars', label: tx('admin.users.render_user.cost'), num: true, render: (r) => fmtMoney(r.total_cost_dollars) },
      { key: 'market_value_dollars', label: tx('admin.users.render_user.value'), num: true, render: (r) => fmtMoney(r.market_value_dollars) }, { key: 'realized_pnl_dollars', label: tx('admin.users.render_user.realized'), num: true, render: (r) => fmtMoney(r.realized_pnl_dollars) }, { key: 'market_status', label: 'Market' }] });
  dataTable(el.querySelector('#u-ord'), { search: false, rows: d.resting_orders, empty: tx('admin.users.render_user.no_resting_orders'), testid: 'user-orders',
    cols: [{ key: 'ticker', label: 'Market', render: (r) => `<code>${esc(r.ticker)}</code>` }, { key: 'user_side', label: tx('admin.users.render_user.side'), render: (r) => `${esc(r.user_action || 'buy')} ${esc(String(r.user_side || r.side).toUpperCase())}` },
      { key: 'user_price_dollars', label: tx('admin.users.render_user.price'), num: true, render: (r) => esc(pxc(Math.round(Number(r.user_price_dollars ?? r.price_dollars) * 10000))) }, { key: 'remaining_count_fp', label: tx('admin.users.render_user.remaining'), num: true, render: (r) => fmtQty(r.remaining_count_fp) },
      { key: 'reserved_dollars', label: tx('admin.users.render_user.reserved'), num: true, render: (r) => fmtMoney(r.reserved_dollars) }, { key: 'created_time', label: tx('admin.users.render_user.placed'), render: (r) => esc(fmtTime(r.created_time)) }] });
  dataTable(el.querySelector('#u-led'), { rows: d.transactions, empty: tx('admin.users.render_user.no_ledger_entries'), testid: 'user-ledger', pageSize: 15,
    cols: [{ key: 'created_time', label: tx('admin.users.render_user.time'), render: (r) => esc(fmtTime(r.created_time)) }, { key: 'kind', label: tx('admin.users.render_user.type') }, { key: 'amount_dollars', label: tx('admin.users.render_user.amount'), num: true, render: (r) => fmtMoney(r.amount_dollars) }, { key: 'memo', label: tx('admin.users.render_user.memo') }] });

  const reload = () => renderUser(el, id, perms, navigate);
  el.onclick = async (e) => { // assigned (not added) so re-rendering after an action never stacks handlers
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    try {
      if (act === 'adjust') {
        const fields = [{ name: 'amount_dollars', label: T('admin.adjust_amount', { mode: T(`currency.mode.${currency.code}`).toLowerCase() }), type: 'number', step: moneyStep(), required: true }, { name: 'reason', label: tx('admin.users.render_user.reason_shown_to_the_user'), required: true, span: true }];
        const dlg = dialog(`<h3>${te('admin.users.render_user.adjust_balance_2', { email: esc(u.email) })}</h3><p class="muted">${te('admin.users.render_user.creates_an')} <code>${te('admin.users.render_user.adjustment')}</code> ${te('admin.users.render_user.ledger_entry_and_updates_the')}</p>${formHtml(fields, { submit: tx('admin.users.render_user.apply_adjustment'), id: 'adj', extra: `<button class="btn" type="button" data-close>${te('admin.users.render_user.cancel')}</button>`, testid: 'adjust-form' })}`);
        dlg.querySelector('[data-close]').onclick = () => dlg.close();
        wireForm(dlg.querySelector('form'), fields, async (v) => { const r = await post(`/users/${encodeURIComponent(u.user_id)}/adjust`, { ...v, amount_dollars: toApiDollars(v.amount_dollars) }); dlg.close(); toast(tx('admin.users.render_user.new_balance', { fmt_money: fmtMoney(r.balance_dollars) })); await reload(); });
        return;
      }
      if (act === 'money_controls') {
        const c = mc.money_controls;
        const fields = [{ name: 'deposits_revoked', label: tx('admin.users.money.revoke_deposits'), type: 'checkbox', value: c.deposits_revoked }, { name: 'withdrawals_revoked', label: tx('admin.users.money.revoke_withdrawals'), type: 'checkbox', value: c.withdrawals_revoked },
          { name: 'reason', label: tx('admin.users.money.reason_field'), required: true, span: true }];
        const dlg = dialog(`<h3>${te('admin.users.money.dialog_title', { email: esc(u.email) })}</h3><p class="muted">${te('admin.users.money.dialog_body')}</p>${formHtml(fields, { submit: tx('admin.users.money.save'), id: 'mc', extra: `<button class="btn" type="button" data-close>${te('admin.users.render_user.cancel')}</button>`, testid: 'money-controls-form' })}`);
        dlg.querySelector('[data-close]').onclick = () => dlg.close();
        wireForm(dlg.querySelector('form'), fields, async (v) => { await put(`/users/${encodeURIComponent(u.user_id)}/money_controls`, v); dlg.close(); toast(tx('admin.users.money.saved')); await reload(); });
        return;
      }
      if (act === 'limits') {
        const fields = [{ name: 'kind', label: 'Limit', type: 'select', options: [['deposit', T('admin.limit_deposit', { symbol: sym() })], ['trading', T('admin.limit_trading', { symbol: sym() })], ['session', tx('admin.users.render_user.session_minutes_day')]] }, { name: 'value', label: tx('admin.users.render_user.new_value_empty_removes_the'), type: 'number', step: moneyStep() }, { name: 'reason', label: tx('admin.users.render_user.reason'), required: true, span: true }];
        const dlg = dialog(`<h3>${te('admin.users.render_user.override_limit')}</h3><p class="muted">${te('admin.users.render_user.takes_effect_immediately_skipping_the')}</p>${formHtml(fields, { submit: 'Override', id: 'lim', extra: `<button class="btn" type="button" data-close>${te('admin.users.render_user.cancel')}</button>` })}`);
        dlg.querySelector('[data-close]').onclick = () => dlg.close();
        wireForm(dlg.querySelector('form'), fields, async (v) => { await put(`/users/${encodeURIComponent(u.user_id)}/limits/${v.kind}`, { value: v.value === '' ? null : v.kind === 'session' ? v.value : toApiDollars(v.value), reason: v.reason }); dlg.close(); toast(tx('admin.users.render_user.limit_overridden')); await reload(); });
        return;
      }
      const copy = { lock: [tx('admin.users.render_user.lock_this_account'), tx('admin.users.render_user.the_user_is_signed_out'), tx('admin.users.render_user.lock_account'), true],
        unlock: [tx('admin.users.render_user.unlock_this_account'), tx('admin.users.render_user.the_user_can_sign_in'), tx('admin.users.render_user.unlock'), false], reset_mfa: [tx('admin.users.render_user.reset_two_factor_login'), tx('admin.users.render_user.the_authenticator_is_removed_the'), tx('admin.users.render_user.reset_two_factor'), true],
        clear_session_time: [tx('admin.users.render_user.clear_today_s_session_time'), tx('admin.users.render_user.resets_the_daily_session_time'), tx('admin.users.render_user.clear'), false] }[act];
      const ok = await confirmAction({ title: copy[0], body: copy[1], confirm: copy[2], danger: copy[3], reason: true });
      if (!ok) return;
      await post(`/users/${encodeURIComponent(u.user_id)}/${act}`, { reason: ok.reason });
      toast(tx('admin.users.render_user.done')); await reload();
    } catch (ex) { toast(ex.message, 'error'); }
  };
}

async function renderRoles(el) {
  const r = await get('/roles');
  el.innerHTML = section(tx('admin.users.render_roles.roles'), tx('admin.users.render_roles.grant_staff_roles_permissions_are')) +
    `<div class="card adm-card"><form class="inline-form" data-grant data-testid="role-grant"><label class="field"><span>${te('admin.users.render_roles.user_email')}</span><input name="email" type="email" required class="adm-input" data-testid="role-email"></label>
      <label class="field"><span>${te('admin.users.render_roles.role')}</span><select name="role" data-testid="role-select">${r.roles.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label><button class="btn btn-primary" type="submit">${te('admin.users.render_roles.grant_role')}</button><small class="adm-err" data-err role="alert"></small></form></div>
    <h3 class="adm-h3">${te('admin.users.render_roles.staff')}</h3><div id="staff"></div><h3 class="adm-h3">${te('admin.users.render_roles.permission_matrix')}</h3>
    <div class="adm-scroll"><table class="table adm-grid adm-matrix" data-testid="role-matrix"><thead><tr><th>${te('admin.users.render_roles.permission')}</th>${r.roles.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${r.all_permissions.map((p) => `<tr><td><code>${esc(p)}</code></td>${r.roles.map((x) => `<td>${r.role_matrix[x].includes(p) ? '✓' : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  let staff = r.staff;
  const t = dataTable(el.querySelector('#staff'), { search: false, rows: staff, testid: 'staff', rowAttrs: (s) => `data-email="${esc(s.email)}"`,
    cols: [{ key: 'email', label: tx('admin.users.render_roles.email') }, { key: 'display_name', label: tx('admin.users.render_roles.name') }, { key: 'roles', label: tx('admin.users.render_roles.roles'), sort: false, render: (s) => s.roles.map((x) => `<span class="adm-chip">${esc(x)} <button class="adm-x" data-revoke="${esc(x)}" data-uid="${esc(s.user_id)}" aria-label="${te('admin.users.render_roles.remove', { x: esc(x) })}">×</button></span>`).join(' ') }] });
  const save = async (uid, roles) => { await put(`/roles/${encodeURIComponent(uid)}`, { roles }); staff = (await get('/roles')).staff; t.setRows(staff); };
  el.querySelector('[data-grant]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const err = f.querySelector('[data-err]'); err.textContent = '';
    const email = f.email.value.trim().toLowerCase();
    try {
      const found = (await get(`/users?q=${encodeURIComponent(email)}`)).users.find((x) => x.email === email);
      if (!found) { err.textContent = tx('admin.users.render_roles.no_user_with_that_email'); return; }
      await save(found.user_id, [...new Set([...found.roles, f.role.value])]);
      toast(tx('admin.users.render_roles.granted_to', { value: f.role.value, email })); f.reset();
    } catch (ex) { err.textContent = ex.message; }
  });
  el.querySelector('#staff').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    const s = staff.find((x) => x.user_id === b.dataset.uid);
    const ok = await confirmAction({ title: tx('admin.users.render_roles.remove_from', { revoke: b.dataset.revoke, email: s.email }), confirm: tx('admin.users.render_roles.remove_role'), danger: true });
    if (!ok) return;
    try { await save(s.user_id, s.roles.filter((x) => x !== b.dataset.revoke)); toast(tx('admin.users.render_roles.role_removed')); } catch (ex) { toast(ex.message, 'error'); }
  });
}
