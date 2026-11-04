// Admin › Play mode and Admin › Central Bank (CLONE_SPEC.md §33).
//   play_mode     the master switch (with the real-money guard), the signup bonus and deposit cap, the switch to
//                 production (preview → request with RESET → a second admin approves with RESET; backup first), the
//                 reset batches and the history.
//   central_bank  the vault (live), its switches (the central_bank / heist flags), funding and defunding, heist and
//                 treasury settings, the payout queue and recent heists.
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.playmode-strings.js';
import { socket } from '../../ws.js';
import { money, sym, toApiDollars, fromApiDollars, moneyCents } from '../../currency.js';
import { esc, get, put, post, toast, dataTable, dialog, formHtml, wireForm, confirmAction, section, badge, fmtTime } from './ui.js';

export async function render(ctx) {
  if (ctx.section === 'central_bank') return renderBank(ctx);
  return renderPlay(ctx);
}

// ---------------------------------------------------------------- play mode
function previewHtml(p) {
  const c = p.counts; const t = p.totals;
  const row = (k, v, kind) => `<dt>${esc(tx(`admin.playmode.${kind}.${k}`))}</dt><dd data-preview="${esc(kind)}:${esc(k)}">${esc(v)}</dd>`;
  return `<div class="adm-two" data-testid="reset-preview"><div><h4>${te('admin.playmode.preview.counts')}</h4><dl class="adm-dl">${Object.entries(c).filter(([k]) => !k.startsWith('kept_')).map(([k, v]) => row(k, v, 'count')).join('')}</dl></div>
    <div><h4>${te('admin.playmode.preview.totals')}</h4><dl class="adm-dl">${Object.entries(t).map(([k, v]) => row(k, k === 'perps_dollars' ? money(v) : money(v), 'total')).join('')}</dl>
    <p class="faint">${te('admin.playmode.preview.kept', { accounts: esc(c.kept_accounts), markets: esc(c.kept_markets) })}</p></div></div>`;
}
async function renderPlay({ el, me }) {
  const s = await get('/play_mode');
  const pm = s.play_mode; const rm = s.real_money;
  const pending = s.approvals.filter((a) => a.status === 'pending');
  const settingsFields = [
    { name: 'bonus_enabled', label: tx('admin.playmode.settings.bonus_enabled'), type: 'checkbox', value: pm.bonus.enabled },
    { name: 'bonus_amount', label: tx('admin.playmode.settings.bonus_amount', { symbol: sym() }), type: 'number', value: fromApiDollars(pm.bonus.amount_dollars) },
    { name: 'bonus_source', label: tx('admin.playmode.settings.bonus_source'), type: 'select', value: pm.bonus.source, options: [['mint', tx('admin.playmode.settings.source.mint')], ['treasury', tx('admin.playmode.settings.source.treasury')]] },
    { name: 'cap', label: tx('admin.playmode.settings.cap', { symbol: sym() }), type: 'number', value: pm.deposits.daily_cap_dollars == null ? '' : fromApiDollars(pm.deposits.daily_cap_dollars) },
    { name: 'reason', label: tx('admin.playmode.settings.reason'), required: true, span: true },
  ];
  const switchFields = [
    { name: 'reason', label: tx('admin.playmode.switch.reason'), required: true, span: true },
    { name: 'confirm', label: tx('admin.playmode.switch.type_reset'), required: true, placeholder: 'RESET' },
  ];
  el.innerHTML = section(tx('admin.playmode.page.title'), te('admin.playmode.page.intro', { zero: esc(moneyCents(0)) })) +
    `<div class="adm-two"><div class="card adm-card" data-testid="play-status" data-on="${pm.on ? '1' : '0'}"><h3>${te('admin.playmode.status.title')}</h3>
      <p>${pm.on ? badge(tx('admin.playmode.status.on'), 'warn') : badge(tx('admin.playmode.status.off'), 'ok')}</p><p class="faint">${te('admin.playmode.status.epoch', { epoch: esc(pm.epoch) })}</p>
      ${pm.on ? '' : `<p class="faint" data-testid="real-money">${te('admin.playmode.status.real_money', { balances: esc(rm.balances), positions: esc(rm.positions), orders: esc(rm.orders), perps: esc(rm.perps), pending: esc(rm.pending), holds: esc(rm.holds) })}</p>`}
      ${pm.on ? '' : `<button class="btn btn-primary" data-on data-testid="play-on">${te('admin.playmode.on.button')}</button><p class="form-error" data-on-err data-testid="play-on-error"></p>`}</div>
    <div class="card adm-card"><h3>${te('admin.playmode.settings.title')}</h3>${formHtml(settingsFields, { submit: tx('admin.playmode.settings.save'), id: 'pms', testid: 'play-settings' })}<p class="faint">${te('admin.playmode.settings.prod_note')}</p></div></div>
    ${pm.on ? `<div class="card adm-card" data-testid="production-switch"><h3>${te('admin.playmode.switch.title')}</h3><p class="faint">${te('admin.playmode.switch.intro')}</p>
      <button class="btn" data-preview data-testid="preview-reset">${te('admin.playmode.switch.preview')}</button><div data-preview-box></div>
      ${pending.length ? `<p>${badge(tx('admin.playmode.switch.requested'), 'warn')}</p>` : formHtml(switchFields, { submit: tx('admin.playmode.switch.request'), id: 'psw', testid: 'switch-form' })}</div>` : ''}
    <div class="card adm-card"><h3>${te('admin.playmode.approvals.title')}</h3><div id="pma"></div></div>
    <div class="adm-two"><div class="card adm-card"><h3>${te('admin.playmode.batches.title')}</h3><ul class="adm-hist" data-testid="reset-batches">${s.batches.map((b) => `<li data-testid="reset-batch" data-batch="${esc(b.id)}">${te('admin.playmode.batches.row', { batch: esc(b.id), time: esc(fmtTime(b.time)), who: esc(b.approved_by || '—'), file: esc(b.backup_file) })}<div class="faint">${esc(b.reason)}</div></li>`).join('')}</ul></div>
      <div class="card adm-card"><h3>${te('admin.playmode.events.title')}</h3><ul class="adm-hist">${s.events.map((e) => `<li><b>${esc(e.action)}</b> · ${esc(fmtTime(e.time))} · ${esc(e.actor_email || '—')}<div class="faint">${esc(e.reason)}</div></li>`).join('')}</ul></div></div>`;
  const again = () => renderPlay({ el, me });
  const on = el.querySelector('[data-on]');
  if (on) on.onclick = async () => {
    const r = await confirmAction({ title: tx('admin.playmode.on.title'), body: te('admin.playmode.on.body'), confirm: tx('admin.playmode.on.confirm'), reason: true });
    if (!r) return;
    try { await put('/play_mode', { on: true, reason: r.reason }); toast(tx('admin.playmode.on.done')); await again(); } catch (ex) { el.querySelector('[data-on-err]').textContent = ex.message; }
  };
  wireForm(el.querySelector('[data-testid=play-settings]'), settingsFields, async (v) => {
    const map = { 'bonus.enabled': 'bonus_enabled', 'bonus.amount_dollars': 'bonus_amount', 'bonus.source': 'bonus_source', 'deposits.daily_cap_dollars': 'cap' };
    await put('/play_mode/settings', { bonus: { enabled: v.bonus_enabled, amount_dollars: v.bonus_amount === '' ? 0 : toApiDollars(v.bonus_amount), source: v.bonus_source },
      deposits: { daily_cap_dollars: v.cap === '' ? null : toApiDollars(v.cap) }, reason: v.reason }).catch((ex) => { if (ex.fields) ex.fields = Object.fromEntries(Object.entries(ex.fields).map(([k, m]) => [map[k] || k, m])); throw ex; });
    toast(tx('admin.playmode.settings.saved'));
    await again();
  });
  const pv = el.querySelector('[data-preview]');
  if (pv) pv.onclick = async () => { try { const r = await get('/play_mode/preview'); el.querySelector('[data-preview-box]').innerHTML = previewHtml(r.preview); } catch (ex) { toast(ex.message, 'error'); } };
  const sw = el.querySelector('[data-testid=switch-form]');
  if (sw) wireForm(sw, switchFields, async (v) => {
    if (v.confirm !== 'RESET') { const e = new Error(tx('admin.playmode.switch.not_reset')); e.fields = { confirm: tx('admin.playmode.switch.not_reset') }; throw e; }
    await post('/play_mode/production_switch', { reason: v.reason, confirm: v.confirm });
    toast(tx('admin.playmode.switch.requested'));
    await again();
  });
  dataTable(el.querySelector('#pma'), { testid: 'pm-approvals', search: false, rows: s.approvals, rowAttrs: (a) => `data-approval="${esc(a.id)}" data-status="${esc(a.status)}"`,
    cols: [{ key: 'status', label: tx('admin.playmode.approvals.status'), render: (a) => badge(a.status, a.status === 'pending' ? 'warn' : a.status === 'executed' ? 'ok' : '') },
      { key: 'requested_by', label: tx('admin.playmode.approvals.requested') }, { key: 'requested_time', label: tx('admin.playmode.approvals.time'), render: (a) => esc(fmtTime(a.requested_time)) },
      { key: 'reason', label: tx('admin.playmode.approvals.reason') },
      { key: '_a', label: tx('admin.playmode.approvals.actions'), sort: false, render: (a) => (a.status === 'pending' ? `<div class="adm-actions"><button class="btn btn-sm btn-danger" data-approve="${esc(a.id)}" data-testid="approve-switch">${te('admin.playmode.approvals.approve')}</button><button class="btn btn-sm" data-reject="${esc(a.id)}" data-testid="reject-switch">${te('admin.playmode.approvals.reject')}</button></div>` : esc(a.batch_id || '')) }] });
  el.addEventListener('click', async (e) => {
    const ap = e.target.closest('[data-approve]'); const rj = e.target.closest('[data-reject]');
    if (ap) {
      const a = s.approvals.find((x) => x.id === ap.dataset.approve);
      const fields = [{ name: 'confirm', label: tx('admin.playmode.switch.type_reset'), required: true, placeholder: 'RESET' }];
      const d = dialog(`<h3>${te('admin.playmode.approvals.approve_title')}</h3><p class="muted">${te('admin.playmode.approvals.approve_body', { zero: esc(moneyCents(0)) })}</p>${previewHtml(a.preview)}${formHtml(fields, { submit: tx('admin.playmode.approvals.approve'), id: 'pmap', testid: 'approve-form' })}`, { wide: true, testid: 'approve-dialog' });
      wireForm(d.querySelector('form'), fields, async (v) => {
        if (v.confirm !== 'RESET') { const er = new Error(tx('admin.playmode.switch.not_reset')); er.fields = { confirm: tx('admin.playmode.switch.not_reset') }; throw er; }
        const r = await post(`/play_mode/approvals/${encodeURIComponent(a.id)}/approve`, { confirm: v.confirm });
        toast(tx('admin.playmode.approvals.done', { batch: r.result.batch_id, file: r.result.backup_file }));
        d.close();
        await again();
      });
    } else if (rj) {
      const r = await confirmAction({ title: tx('admin.playmode.approvals.reject_title'), confirm: tx('admin.playmode.approvals.reject'), reason: true });
      if (!r) return;
      try { await post(`/play_mode/approvals/${encodeURIComponent(rj.dataset.reject)}/reject`, { note: r.reason }); toast(tx('admin.playmode.approvals.rejected')); await again(); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
}

// ---------------------------------------------------------------- Central Bank
async function renderBank({ el, perms }) {
  const s = await get('/central_bank');
  const H = s.settings.heist;
  const nd = (c) => fromApiDollars((c / 100).toFixed(2));
  const fundFields = [{ name: 'amount', label: tx('admin.cb.fund.amount', { symbol: sym() }), type: 'number', required: true }, { name: 'reason', label: tx('admin.cb.fund.reason'), required: true, span: true }];
  const setFields = [
    { name: 'crew_fee', label: tx('admin.cb.settings.crew_fee', { symbol: sym() }), type: 'number', value: nd(H.crew_fee_cents), required: true },
    { name: 'timer_seconds', label: tx('admin.cb.settings.timer'), type: 'number', value: H.timer_seconds, required: true },
    { name: 'base_digits', label: tx('admin.cb.settings.digits'), type: 'number', value: H.base_digits, required: true },
    { name: 'base_guesses', label: tx('admin.cb.settings.guesses'), type: 'number', value: H.base_guesses, required: true },
    { name: 'max_share_pct', label: tx('admin.cb.settings.share'), type: 'number', value: H.max_share_pct, required: true },
    { name: 'max_loot', label: tx('admin.cb.settings.max_loot', { symbol: sym() }), type: 'number', value: nd(H.max_loot_cents), required: true },
    { name: 'max_day', label: tx('admin.cb.settings.max_day', { symbol: sym() }), type: 'number', value: nd(H.max_loot_user_day_cents), required: true },
    { name: 'attempts_per_day', label: tx('admin.cb.settings.attempts'), type: 'number', value: H.attempts_per_day, required: true },
    { name: 'jail_minutes', label: tx('admin.cb.settings.jail'), type: 'number', value: H.jail_minutes, required: true },
    { name: 'max_level', label: tx('admin.cb.settings.max_level'), type: 'number', value: H.max_level, required: true },
    { name: 'decay_minutes', label: tx('admin.cb.settings.decay'), type: 'number', value: H.decay_minutes, required: true },
    { name: 'min_vault', label: tx('admin.cb.settings.min_vault', { symbol: sym() }), type: 'number', value: nd(H.min_vault_cents), required: true },
    { name: 'on_empty', label: tx('admin.cb.settings.on_empty'), type: 'select', value: s.settings.treasury.on_empty, options: [['queue', tx('admin.cb.settings.queue')], ['refuse', tx('admin.cb.settings.refuse')]] },
    { name: 'reason', label: tx('admin.cb.settings.reason'), required: true, span: true },
  ];
  const bankOn = s.flags.central_bank.enabled && !s.flags.central_bank.kill; const heistOn = s.flags.heist.enabled && !s.flags.heist.kill;
  const canMoney = perms.has('users.money'); const canSet = perms.has('settings.write');
  const st = s.stats;
  el.innerHTML = section(tx('admin.cb.page.title'), te('admin.cb.page.intro')) +
    `<div class="adm-tiles" data-testid="cb-tiles"><div class="adm-tile"><span>${te('admin.cb.vault')}</span><b data-testid="cb-vault">${esc(money(s.balance_dollars))}</b></div>
      <div class="adm-tile"><span>${te('admin.cb.level')}</span><b data-testid="cb-level">${te('admin.cb.level_of', { level: esc(s.central_bank.security_level), max: esc(s.central_bank.max_level) })}</b></div>
      <div class="adm-tile"><span>${te('admin.cb.queued')}</span><b data-testid="cb-queued">${esc(money(s.queued_dollars))}</b></div></div>
    <p class="faint">${te('admin.cb.stats', { n: esc(st.n), cracked: esc(st.cracked), fees: esc(moneyCents(st.fees)), loot: esc(moneyCents(st.loot)) })}</p>
    <div class="adm-two"><div class="card adm-card" data-testid="cb-switches"><h3>${te('admin.cb.switches')}</h3>
      <p>${bankOn ? badge(tx('admin.cb.switch.bank_on'), 'ok') : badge(tx('admin.cb.switch.bank_off'), 'warn')} ${canSet ? `<button class="btn btn-sm" data-flip="central_bank" data-to="${bankOn ? '0' : '1'}" data-testid="cb-toggle-bank">${bankOn ? te('admin.cb.switch.turn_off') : te('admin.cb.switch.turn_on')}</button>` : ''}</p>
      <p>${heistOn ? badge(tx('admin.cb.switch.heist_on'), 'ok') : badge(tx('admin.cb.switch.heist_off'), 'warn')} ${canSet ? `<button class="btn btn-sm" data-flip="heist" data-to="${heistOn ? '0' : '1'}" data-testid="cb-toggle-heist">${heistOn ? te('admin.cb.switch.turn_off') : te('admin.cb.switch.turn_on')}</button>` : ''}</p></div>
    ${canMoney ? `<div class="card adm-card"><h3>${te('admin.cb.fund.title')}</h3>${formHtml(fundFields, { submit: tx('admin.cb.fund.fund'), id: 'cbf', testid: 'cb-fund-form', extra: `<button class="btn" type="button" data-defund data-testid="cb-defund">${te('admin.cb.fund.defund')}</button>` })}</div>` : ''}</div>
    ${canSet ? `<div class="card adm-card"><h3>${te('admin.cb.settings.title')}</h3>${formHtml(setFields, { submit: tx('admin.cb.settings.save'), id: 'cbs', testid: 'cb-settings-form' })}</div>` : ''}
    <div class="card adm-card"><h3>${te('admin.cb.ops.title')}</h3><div id="cbo"></div></div>
    <div class="card adm-card"><h3>${te('admin.cb.queue.title')} ${canMoney ? `<button class="btn btn-sm" data-process data-testid="cb-process">${te('admin.cb.queue.process')}</button>` : ''}</h3><div id="cbq"></div></div>
    <div class="card adm-card"><h3>${te('admin.cb.heists.title')}</h3><div id="cbh"></div></div>`;
  const again = () => renderBank({ el, perms });
  dataTable(el.querySelector('#cbo'), { testid: 'cb-ops', search: false, rows: s.ops, cols: [{ key: 'kind', label: tx('admin.cb.ops.kind') }, { key: 'amount_dollars', label: tx('admin.cb.ops.amount'), num: true, render: (o) => esc(money(o.amount_dollars)) },
    { key: 'balance_after_dollars', label: tx('admin.cb.ops.after'), num: true, render: (o) => esc(money(o.balance_after_dollars)) }, { key: 'actor_email', label: tx('admin.cb.ops.who') }, { key: 'reason', label: tx('admin.cb.ops.reason') }, { key: 'time', label: tx('admin.cb.ops.time'), render: (o) => esc(fmtTime(o.time)) }] });
  dataTable(el.querySelector('#cbq'), { testid: 'cb-queue', search: false, rows: s.queue, rowAttrs: (q) => `data-status="${esc(q.status)}"`, cols: [{ key: 'user_email', label: tx('admin.cb.queue.user') }, { key: 'purpose', label: tx('admin.cb.queue.purpose') },
    { key: 'amount_dollars', label: tx('admin.cb.queue.amount'), num: true, render: (q) => esc(money(q.amount_dollars)) }, { key: 'status', label: tx('admin.cb.queue.status'), render: (q) => badge(q.status, q.status === 'paid' ? 'ok' : q.status === 'queued' ? 'warn' : '') }, { key: 'created_time', label: tx('admin.cb.queue.time'), render: (q) => esc(fmtTime(q.created_time)) }] });
  dataTable(el.querySelector('#cbh'), { testid: 'cb-heists', search: false, rows: s.heists, cols: [{ key: 'user_email', label: tx('admin.cb.heists.user') }, { key: 'status', label: tx('admin.cb.heists.status'), render: (h) => badge(h.status, h.status === 'cracked' ? 'ok' : h.status === 'active' ? 'warn' : 'bad') },
    { key: 'loot_dollars', label: tx('admin.cb.heists.loot'), num: true, render: (h) => esc(money(h.loot_dollars)) }, { key: 'fee_dollars', label: tx('admin.cb.heists.fee'), num: true, render: (h) => esc(money(h.fee_dollars)) },
    { key: 'guesses_used', label: tx('admin.cb.heists.guesses'), num: true, render: (h) => `${esc(h.guesses_used)}/${esc(h.max_guesses)}` }, { key: 'time', label: tx('admin.cb.heists.time'), render: (h) => esc(fmtTime(h.time)) }] });
  const ff = el.querySelector('[data-testid=cb-fund-form]');
  if (ff) {
    const run = async (kind) => {
      const v = { amount: ff.elements.amount.value, reason: ff.elements.reason.value.trim() };
      const r = await post(`/central_bank/${kind}`, { amount_dollars: toApiDollars(v.amount), reason: v.reason });
      toast(tx('admin.cb.fund.done', { money: money(r.balance_dollars) }));
      await again();
    };
    wireForm(ff, fundFields, () => run('fund'));
    ff.querySelector('[data-defund]').onclick = () => run('defund').catch((ex) => { ff.querySelector('[data-form-error]').textContent = ex.message; });
  }
  const sf = el.querySelector('[data-testid=cb-settings-form]');
  if (sf) wireForm(sf, setFields, async (v) => {
    const c = (x) => Math.round(toApiDollars(x) * 100);
    await put('/central_bank/settings', { heist: { crew_fee_cents: c(v.crew_fee), timer_seconds: v.timer_seconds, base_digits: v.base_digits, base_guesses: v.base_guesses, max_share_pct: v.max_share_pct,
      max_loot_cents: c(v.max_loot), max_loot_user_day_cents: c(v.max_day), attempts_per_day: v.attempts_per_day, jail_minutes: v.jail_minutes, max_level: v.max_level, decay_minutes: v.decay_minutes, min_vault_cents: c(v.min_vault) },
    treasury: { on_empty: v.on_empty }, reason: v.reason });
    toast(tx('admin.cb.settings.saved'));
    await again();
  });
  el.querySelector('[data-process]')?.addEventListener('click', async () => { try { const r = await post('/central_bank/queue/process', {}); toast(tx('admin.cb.queue.paid', { count: r.paid })); await again(); } catch (ex) { toast(ex.message, 'error'); } });
  for (const b of el.querySelectorAll('[data-flip]')) b.onclick = async () => {
    const what = b.dataset.flip === 'heist' ? tx('admin.cb.switch.heist') : tx('admin.cb.switch.bank');
    const r = await confirmAction({ title: tx('admin.cb.switch.title', { action: b.dataset.to === '1' ? tx('admin.cb.switch.turn_on') : tx('admin.cb.switch.turn_off'), what }), reason: true });
    if (!r) return;
    try { await put(`/flags/${b.dataset.flip}`, { enabled: b.dataset.to === '1', kill: false, reason: r.reason }); await again(); } catch (ex) { toast(ex.message, 'error'); }
  };
  // The vault moves live (crew fees, loot, funding by another admin).
  const unsub = socket.subscribe({ channels: ['central_bank'] }, (m) => { if (m.type === 'central_bank' && m.msg && m.msg.type === 'vault') { const v = el.querySelector('[data-testid=cb-vault]'); if (v) v.textContent = money(m.msg.balance_dollars); } });
  return () => unsub();
}
