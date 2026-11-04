// Users (search, detail with balances / positions / orders / ledger / limits / MFA, audited support actions) and
// Roles (staff role assignments + permission matrix).
import { t as T } from '../../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { pxc, sym, currency, toApiDollars, moneyStep } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, post, put, toast, dataTable, formHtml, wireForm, dialog, confirmAction, section, badge, fmtTime, fmtQty, fmtMoney } from './ui.js';

export async function render({ el, section: sec, parts, perms, navigate }) {
  if (sec === 'roles') return renderRoles(el);
  if (parts[0]) return renderUser(el, parts[0], perms, navigate);
  el.innerHTML = section('Users', 'Search by email, display name or nickname.') +
    `<form class="adm-search-row" data-search role="search"><input type="search" class="adm-input" name="q" placeholder="Search users" aria-label="Search users" data-testid="user-search"><button class="btn" type="submit">Search</button></form><div id="ul"></div>`;
  const t = dataTable(el.querySelector('#ul'), { search: false, testid: 'user-results', rowAttrs: (r) => `data-row="${esc(r.user_id)}" data-email="${esc(r.email)}"`,
    cols: [{ key: 'email', label: 'Email', render: (r) => `<a href="/admin/users/${encodeURIComponent(r.user_id)}" data-link>${esc(r.email)}</a>` }, { key: 'display_name', label: 'Name' },
      { key: 'nickname', label: 'Nickname', render: (r) => (r.nickname ? `@${esc(r.nickname)}` : '—') }, { key: 'balance_dollars', label: 'Cash', num: true, render: (r) => fmtMoney(r.balance_dollars) },
      { key: 'created_at', label: 'Joined', render: (r) => esc(fmtTime(r.created_at)) },
      { key: 'locked', label: 'Flags', sort: false, render: (r) => [r.locked && badge('locked', 'bad'), r.banned && badge('posting banned', 'warn'), r.is_system && badge('system'), ...r.roles.map((x) => badge(x, 'brand'))].filter(Boolean).join(' ') }] });
  const run = async (q) => { const r = await get(`/users?q=${encodeURIComponent(q)}&limit=200`); t.setRows(r.users); };
  el.querySelector('[data-search]').addEventListener('submit', (e) => { e.preventDefault(); run(e.target.q.value.trim()).catch((ex) => toast(ex.message, 'error')); });
  await run('');
}

async function renderUser(el, id, perms, navigate) {
  const d = await get(`/users/${encodeURIComponent(id)}`);
  const u = d.user;
  const lim = (l, money) => (l ? `${money ? (l.limit_dollars == null ? 'none' : fmtMoney(l.limit_dollars)) : (l.limit_minutes == null ? 'none' : `${esc(l.limit_minutes)} min`)} <span class="faint">· used ${money ? fmtMoney(l.used_today_dollars) : `${Math.round(l.used_today_seconds / 60)} min`} today${l.pending ? ' · change pending' : ''}</span>` : '—');
  const can = (p) => perms.has(p);
  el.innerHTML = section(u.display_name, `${esc(u.email)}${u.nickname ? ` · @${esc(u.nickname)}` : ''} · joined ${esc(fmtTime(u.created_at))}`, '<a class="btn" href="/admin/users" data-link>All users</a>') +
    `<div class="adm-tiles" data-testid="user-detail" data-user="${esc(u.user_id)}">
      <div class="adm-tile"><span>Cash</span><b data-testid="user-cash">${fmtMoney(d.balance.balance_dollars)}</b></div>
      <div class="adm-tile"><span>Reserved in orders</span><b>${fmtMoney(d.balance.reserved_dollars)}</b></div>
      <div class="adm-tile"><span>Positions value</span><b>${fmtMoney(d.balance.portfolio_value_dollars)}</b></div>
      <div class="adm-tile"><span>Status</span><b data-testid="user-status">${u.locked ? badge('Locked', 'bad') : badge('Active', 'ok')} ${u.banned ? badge('posting banned', 'warn') : ''}</b></div>
      <div class="adm-tile"><span>Two-factor</span><b data-testid="user-mfa">${d.mfa_enabled ? 'On' : 'Off'}</b></div>
      <div class="adm-tile"><span>Sessions</span><b>${esc(d.sessions)}</b></div>
    </div>
    ${u.lock ? `<div class="adm-banner bad" role="status">Locked by ${esc(u.lock.locked_by || '')} on ${esc(fmtTime(u.lock.locked_at))}: ${esc(u.lock.reason)}</div>` : ''}
    <div class="adm-actions adm-user-actions">
      ${can('users.money') ? '<button class="btn btn-primary" data-act="adjust" data-testid="user-adjust">Adjust balance…</button>' : ''}
      ${can('users.support') ? (u.locked ? '<button class="btn" data-act="unlock" data-testid="user-unlock">Unlock account</button>' : '<button class="btn btn-danger-solid" data-act="lock" data-testid="user-lock">Lock account</button>') : ''}
      ${can('users.support') ? `<button class="btn" data-act="reset_mfa" ${d.mfa_enabled ? '' : 'disabled'}>Reset two-factor</button><button class="btn" data-act="clear_session_time">Clear session time</button>` : ''}
    </div>
    <div class="adm-two">
      <div class="card adm-card"><h3>Limits</h3><dl class="adm-dl" data-testid="user-limits"><dt>Deposit / day</dt><dd>${lim(d.limits.deposit, true)}</dd><dt>Trading / day</dt><dd>${lim(d.limits.trading, true)}</dd><dt>Session / day</dt><dd>${lim(d.limits.session, false)}</dd></dl>
        ${can('users.money') ? '<button class="btn btn-sm" data-act="limits">Override a limit…</button>' : ''}</div>
      <div class="card adm-card"><h3>Recent admin actions</h3>${d.audit.length ? `<ul class="adm-list">${d.audit.map((a) => `<li><b>${esc(a.action)}</b> <span class="faint">${esc(fmtTime(a.time))} · ${esc(a.actor_email || '')}</span><div class="muted">${esc(a.reason)}</div></li>`).join('')}</ul>` : '<p class="faint">None</p>'}</div>
    </div>
    <h3 class="adm-h3">Positions</h3><div id="u-pos"></div>
    <h3 class="adm-h3">Resting orders</h3><div id="u-ord"></div>
    <h3 class="adm-h3">Ledger <span class="faint">(latest 50 of ${esc(d.transactions_total)})</span></h3><div id="u-led"></div>`;
  dataTable(el.querySelector('#u-pos'), { search: false, rows: d.positions, empty: 'No positions', testid: 'user-positions',
    cols: [{ key: 'ticker', label: 'Market', render: (r) => `<code>${esc(r.ticker)}</code><div class="faint">${esc(r.outcome || '')}</div>` }, { key: 'side', label: 'Side', render: (r) => (r.side ? r.side.toUpperCase() : '—') },
      { key: 'position_fp', label: 'Contracts', num: true, render: (r) => fmtQty(r.position_fp) }, { key: 'total_cost_dollars', label: 'Cost', num: true, render: (r) => fmtMoney(r.total_cost_dollars) },
      { key: 'market_value_dollars', label: 'Value', num: true, render: (r) => fmtMoney(r.market_value_dollars) }, { key: 'realized_pnl_dollars', label: 'Realized', num: true, render: (r) => fmtMoney(r.realized_pnl_dollars) }, { key: 'market_status', label: 'Market' }] });
  dataTable(el.querySelector('#u-ord'), { search: false, rows: d.resting_orders, empty: 'No resting orders', testid: 'user-orders',
    cols: [{ key: 'ticker', label: 'Market', render: (r) => `<code>${esc(r.ticker)}</code>` }, { key: 'user_side', label: 'Side', render: (r) => `${esc(r.user_action || 'buy')} ${esc(String(r.user_side || r.side).toUpperCase())}` },
      { key: 'user_price_dollars', label: 'Price', num: true, render: (r) => esc(pxc(Math.round(Number(r.user_price_dollars ?? r.price_dollars) * 10000))) }, { key: 'remaining_count_fp', label: 'Remaining', num: true, render: (r) => fmtQty(r.remaining_count_fp) },
      { key: 'reserved_dollars', label: 'Reserved', num: true, render: (r) => fmtMoney(r.reserved_dollars) }, { key: 'created_time', label: 'Placed', render: (r) => esc(fmtTime(r.created_time)) }] });
  dataTable(el.querySelector('#u-led'), { rows: d.transactions, empty: 'No ledger entries', testid: 'user-ledger', pageSize: 15,
    cols: [{ key: 'created_time', label: 'Time', render: (r) => esc(fmtTime(r.created_time)) }, { key: 'kind', label: 'Type' }, { key: 'amount_dollars', label: 'Amount', num: true, render: (r) => fmtMoney(r.amount_dollars) }, { key: 'memo', label: 'Memo' }] });

  const reload = () => renderUser(el, id, perms, navigate);
  el.onclick = async (e) => { // assigned (not added) so re-rendering after an action never stacks handlers
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    try {
      if (act === 'adjust') {
        const fields = [{ name: 'amount_dollars', label: T('admin.adjust_amount', { mode: T(`currency.mode.${currency.code}`).toLowerCase() }), type: 'number', step: moneyStep(), required: true }, { name: 'reason', label: 'Reason (shown to the user, audited)', required: true, span: true }];
        const dlg = dialog(`<h3>Adjust balance · ${esc(u.email)}</h3><p class="muted">Creates an <code>adjustment</code> ledger entry and updates the user's balance live.</p>${formHtml(fields, { submit: 'Apply adjustment', id: 'adj', extra: '<button class="btn" type="button" data-close>Cancel</button>', testid: 'adjust-form' })}`);
        dlg.querySelector('[data-close]').onclick = () => dlg.close();
        wireForm(dlg.querySelector('form'), fields, async (v) => { const r = await post(`/users/${encodeURIComponent(u.user_id)}/adjust`, { ...v, amount_dollars: toApiDollars(v.amount_dollars) }); dlg.close(); toast(`New balance ${fmtMoney(r.balance_dollars)}`); await reload(); });
        return;
      }
      if (act === 'limits') {
        const fields = [{ name: 'kind', label: 'Limit', type: 'select', options: [['deposit', T('admin.limit_deposit', { symbol: sym() })], ['trading', T('admin.limit_trading', { symbol: sym() })], ['session', 'Session (minutes/day)']] }, { name: 'value', label: 'New value (empty removes the limit)', type: 'number', step: moneyStep() }, { name: 'reason', label: 'Reason', required: true, span: true }];
        const dlg = dialog(`<h3>Override limit</h3><p class="muted">Takes effect immediately, skipping the user's 24-hour cooling-off.</p>${formHtml(fields, { submit: 'Override', id: 'lim', extra: '<button class="btn" type="button" data-close>Cancel</button>' })}`);
        dlg.querySelector('[data-close]').onclick = () => dlg.close();
        wireForm(dlg.querySelector('form'), fields, async (v) => { await put(`/users/${encodeURIComponent(u.user_id)}/limits/${v.kind}`, { value: v.value === '' ? null : v.kind === 'session' ? v.value : toApiDollars(v.value), reason: v.reason }); dlg.close(); toast('Limit overridden'); await reload(); });
        return;
      }
      const copy = { lock: ['Lock this account?', 'The user is signed out everywhere, cannot sign in or trade, and their resting orders are canceled.', 'Lock account', true],
        unlock: ['Unlock this account?', 'The user can sign in and trade again.', 'Unlock', false], reset_mfa: ['Reset two-factor login?', 'The authenticator is removed; the user signs in with their password only until they set it up again.', 'Reset two-factor', true],
        clear_session_time: ['Clear today’s session time?', 'Resets the daily session-time counter so a session-limited user can continue today.', 'Clear', false] }[act];
      const ok = await confirmAction({ title: copy[0], body: copy[1], confirm: copy[2], danger: copy[3], reason: true });
      if (!ok) return;
      await post(`/users/${encodeURIComponent(u.user_id)}/${act}`, { reason: ok.reason });
      toast('Done'); await reload();
    } catch (ex) { toast(ex.message, 'error'); }
  };
}

async function renderRoles(el) {
  const r = await get('/roles');
  el.innerHTML = section('Roles', 'Grant staff roles. Permissions are enforced on every admin API call; the admin role also controls the legacy admin endpoints.') +
    `<div class="card adm-card"><form class="inline-form" data-grant data-testid="role-grant"><label class="field"><span>User email</span><input name="email" type="email" required class="adm-input" data-testid="role-email"></label>
      <label class="field"><span>Role</span><select name="role" data-testid="role-select">${r.roles.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label><button class="btn btn-primary" type="submit">Grant role</button><small class="adm-err" data-err role="alert"></small></form></div>
    <h3 class="adm-h3">Staff</h3><div id="staff"></div><h3 class="adm-h3">Permission matrix</h3>
    <div class="adm-scroll"><table class="table adm-grid adm-matrix" data-testid="role-matrix"><thead><tr><th>Permission</th>${r.roles.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${r.all_permissions.map((p) => `<tr><td><code>${esc(p)}</code></td>${r.roles.map((x) => `<td>${r.role_matrix[x].includes(p) ? '✓' : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  let staff = r.staff;
  const t = dataTable(el.querySelector('#staff'), { search: false, rows: staff, testid: 'staff', rowAttrs: (s) => `data-email="${esc(s.email)}"`,
    cols: [{ key: 'email', label: 'Email' }, { key: 'display_name', label: 'Name' }, { key: 'roles', label: 'Roles', sort: false, render: (s) => s.roles.map((x) => `<span class="adm-chip">${esc(x)} <button class="adm-x" data-revoke="${esc(x)}" data-uid="${esc(s.user_id)}" aria-label="Remove ${esc(x)}">×</button></span>`).join(' ') }] });
  const save = async (uid, roles) => { await put(`/roles/${encodeURIComponent(uid)}`, { roles }); staff = (await get('/roles')).staff; t.setRows(staff); };
  el.querySelector('[data-grant]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const err = f.querySelector('[data-err]'); err.textContent = '';
    const email = f.email.value.trim().toLowerCase();
    try {
      const found = (await get(`/users?q=${encodeURIComponent(email)}`)).users.find((x) => x.email === email);
      if (!found) { err.textContent = 'No user with that email'; return; }
      await save(found.user_id, [...new Set([...found.roles, f.role.value])]);
      toast(`${f.role.value} granted to ${email}`); f.reset();
    } catch (ex) { err.textContent = ex.message; }
  });
  el.querySelector('#staff').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    const s = staff.find((x) => x.user_id === b.dataset.uid);
    const ok = await confirmAction({ title: `Remove ${b.dataset.revoke} from ${s.email}?`, confirm: 'Remove role', danger: true });
    if (!ok) return;
    try { await save(s.user_id, s.roles.filter((x) => x !== b.dataset.revoke)); toast('Role removed'); } catch (ex) { toast(ex.message, 'error'); }
  });
}
