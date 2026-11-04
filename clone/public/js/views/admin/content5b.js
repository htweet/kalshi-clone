// Admin sections for Phase 5B (CLONE_SPEC.md §29): AI summaries (content.write; settings need settings.write) and the
// Liquidity Incentive Program (markets.ops; payouts need users.money and step-up). Every change asks for a reason and
// is written to the hash-chained audit log by the server.
import { t as T } from '../../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { pxc, priceUnit, sym, currency, toApiDollars, moneyStep } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, post, put, toast, dataTable, formHtml, wireForm, confirmAction, section, badge, fmtTime, fmtMoney } from './ui.js';

export async function render({ el, section: key, perms }) {
  if (key === 'incentives') return renderIncentives(el, perms);
  return renderSummaries(el, perms);
}

// ---------------------------------------------------------------- AI summaries
async function renderSummaries(el, perms) {
  el.innerHTML = section('AI summaries', 'Summaries and timelines generated from each event’s news items. Hide a summary that is wrong or unsafe; regenerate after fixing the news. The external provider is used only when it is configured on the server and within the daily budget; otherwise the offline extractive summarizer is used.')
    + '<div data-status class="adm-toolbar"></div><div data-list></div><div data-settings></div>';
  const load = async () => {
    const r = await get('/ai_summaries');
    el.querySelector('[data-status]').innerHTML = `<p class="muted" data-testid="ai-usage">Provider: <b>${esc(r.external_provider ? r.external_provider.label : 'Offline extractive summarizer')}</b> · today ${esc(r.usage.requests)} request(s), ${esc(r.usage.input_tokens + r.usage.output_tokens)} tokens, ${esc(r.usage.fallbacks)} fallback(s), ${esc(r.usage.rejected)} rejected output(s)</p>`;
    dataTable(el.querySelector('[data-list]'), {
      testid: 'ai-summaries-table', rows: r.summaries, rowAttrs: (x) => `data-event="${esc(x.event_ticker)}"`,
      cols: [{ key: 'event_ticker', label: 'Event', render: (x) => `<code>${esc(x.event_ticker)}</code><div class="faint">${esc(x.title)}</div>` }, { key: 'items', label: 'News', num: true },
        { key: 'provider', label: 'Provider', render: (x) => (x.provider ? `${badge(x.provider, x.provider === 'extractive' ? '' : 'ok')}${x.fallback_reason ? ` <span class="faint" data-testid="ai-fallback">${esc(x.fallback_reason)}</span>` : ''}` : '<span class="faint">not generated</span>') },
        { key: 'hidden', label: 'State', render: (x) => (x.hidden ? `${badge('hidden', 'warn')} <span class="faint">${esc(x.hidden_reason)}</span>` : badge('shown', 'ok')) },
        { key: 'generated_time', label: 'Generated', render: (x) => esc(fmtTime(x.generated_time)) },
        { key: '_a', label: '', sort: false, render: (x) => `<span class="adm-actions">${x.hidden ? `<button class="btn btn-sm" data-unhide="${esc(x.event_ticker)}">Unhide</button>` : `<button class="btn btn-sm" data-hide="${esc(x.event_ticker)}" data-testid="ai-hide">Hide</button>`}<button class="btn btn-sm" data-regen="${esc(x.event_ticker)}" data-testid="ai-regenerate">Regenerate</button></span>` }],
      empty: 'No event has news items yet.',
    });
    if (perms.has('settings.write')) {
      const s = r.settings;
      const fields = [{ name: 'enabled', label: 'Use the external provider when configured', type: 'checkbox', value: s.enabled }, { name: 'daily_request_limit', label: 'Daily request limit', type: 'number', value: s.daily_request_limit },
        { name: 'daily_token_limit', label: 'Daily token limit', type: 'number', value: s.daily_token_limit }, { name: 'max_sentences', label: 'Sentences per summary', type: 'number', value: s.max_sentences },
        { name: 'blocklist', label: 'Moderation blocklist (comma-separated)', value: (s.blocklist || []).join(', '), span: true }, { name: 'reason', label: 'Reason (audit log)', required: true, span: true }];
      const box = el.querySelector('[data-settings]');
      box.innerHTML = `<h3>Budget and moderation</h3>${formHtml(fields, { id: 'ais', submit: 'Save settings', testid: 'ai-settings-form' })}`;
      wireForm(box.querySelector('form'), fields, async (v) => {
        await put('/ai_summaries/settings', { enabled: v.enabled, daily_request_limit: Number(v.daily_request_limit), daily_token_limit: Number(v.daily_token_limit), max_sentences: Number(v.max_sentences), blocklist: String(v.blocklist).split(',').map((x) => x.trim()).filter(Boolean), reason: v.reason });
        toast('Settings saved'); load();
      });
    }
  };
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-hide],[data-unhide],[data-regen]');
    if (!b) return;
    const t = b.dataset.hide || b.dataset.unhide || b.dataset.regen;
    const action = b.dataset.hide ? 'hide' : b.dataset.unhide ? 'unhide' : 'regenerate';
    const ok = await confirmAction({ title: `${action[0].toUpperCase()}${action.slice(1)} the summary for ${t}?`, confirm: action === 'hide' ? 'Hide' : action === 'unhide' ? 'Unhide' : 'Regenerate', reason: true, danger: action === 'hide' });
    if (!ok) return;
    try { await post(`/ai_summaries/${encodeURIComponent(t)}/${action}`, { reason: ok.reason }); toast(action === 'regenerate' ? 'Summary regenerated' : `Summary ${action === 'hide' ? 'hidden' : 'shown'}`); load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  await load();
}

// ---------------------------------------------------------------- Liquidity Incentive Program
async function renderIncentives(el, perms) {
  el.innerHTML = section('Liquidity incentives', 'Programs pay a reward pool to resting orders near the best price (see CLONE_SPEC.md §29.7 for the formula). Payouts post through the double-entry journal as cash or credits.', '<button class="btn" data-snapshot data-testid="lip-snapshot">Run snapshot now</button><button class="btn btn-primary" data-new data-testid="lip-new">New program</button>')
    + '<div data-form></div><div data-list></div><div data-settings></div>';
  const fields = [
    { name: 'event_ticker', label: 'Event ticker', required: true }, { name: 'title', label: 'Title (optional)' },
    { name: 'start_time', label: 'Start', type: 'datetime', required: true, value: new Date().toISOString() }, { name: 'end_time', label: 'End', type: 'datetime', required: true, value: new Date(Date.now() + 14 * 864e5).toISOString() },
    { name: 'reward_pool_dollars', label: T('admin.reward_pool', { symbol: sym() }), type: 'number', step: moneyStep(), required: true, value: currency.code === 'USD' ? 100 : 10000 }, { name: 'target_size', label: 'Target size (contracts)', type: 'number', value: 100 },
    { name: 'max_spread_cents', label: T('admin.spread_window', { unit: priceUnit() }), type: 'number', value: 3 }, { name: 'discount', label: T('admin.discount', { price: pxc(100) }), type: 'number', step: '0.05', value: 0.5 },
    { name: 'competition', label: 'Competition', type: 'select', options: [['auto', 'Automatic'], ['low', 'Low'], ['high', 'High']], value: 'auto' },
    { name: 'payout_mode', label: 'Pay as', type: 'select', options: [['cash', 'Cash'], ['credits', 'Credits']], value: 'cash' }, { name: 'reason', label: 'Reason (audit log)', required: true, span: true }];
  const load = async () => {
    const r = await get('/incentives/programs');
    dataTable(el.querySelector('[data-list]'), {
      testid: 'lip-admin-table', rows: r.programs, rowAttrs: (p) => `data-program="${esc(p.id)}"`,
      cols: [{ key: 'title', label: 'Program', render: (p) => `${esc(p.title)}<div class="faint"><code>${esc(p.event_ticker)}</code></div>` }, { key: 'status', label: 'Status', render: (p) => badge(p.status, p.status === 'active' ? 'ok' : p.status === 'canceled' ? 'bad' : '') },
        { key: 'start_date', label: 'Window', render: (p) => `${esc(fmtTime(p.start_date))} → ${esc(fmtTime(p.end_date))}` }, { key: 'period_reward_dollars', label: 'Pool', num: true, render: (p) => esc(fmtMoney(p.period_reward_dollars)) },
        { key: 'accrued_dollars', label: 'Accrued', num: true, render: (p) => `<span data-testid="lip-admin-accrued">${esc(fmtMoney(p.accrued_dollars))}</span>` }, { key: 'paid_dollars', label: 'Paid', num: true, render: (p) => esc(fmtMoney(p.paid_dollars)) },
        { key: 'accruals', label: 'Earners', num: true }, { key: 'payout_mode', label: 'Pays' },
        { key: '_a', label: '', sort: false, render: (p) => `<span class="adm-actions">${perms.has('users.money') && !['canceled'].includes(p.status) ? `<button class="btn btn-sm" data-payout="${esc(p.id)}" data-testid="lip-payout">Pay out</button>` : ''}${['scheduled', 'active'].includes(p.status) ? `<button class="btn btn-sm btn-ghost" data-cancel-program="${esc(p.id)}">Cancel</button>` : ''}</span>` }],
      empty: 'No programs yet.',
    });
    if (perms.has('settings.write')) {
      const sf = [{ name: 'blocked_regions', label: 'Blocked regions (country codes, comma-separated)', value: (r.settings.blocked_regions || []).join(', '), span: true }, { name: 'auto_payout', label: 'Pay out automatically when a program ends', type: 'checkbox', value: r.settings.auto_payout }, { name: 'reason', label: 'Reason (audit log)', required: true, span: true }];
      const box = el.querySelector('[data-settings]');
      box.innerHTML = `<h3>Eligibility</h3>${formHtml(sf, { id: 'lips', submit: 'Save', testid: 'lip-settings-form' })}`;
      wireForm(box.querySelector('form'), sf, async (v) => { await put('/incentives/settings', { blocked_regions: String(v.blocked_regions).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean), auto_payout: v.auto_payout, reason: v.reason }); toast('Saved'); load(); });
    }
  };
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-new]')) {
      const box = el.querySelector('[data-form]');
      box.innerHTML = `<div class="card adm-panel">${formHtml(fields, { id: 'lip', submit: 'Create program', testid: 'lip-form' })}</div>`;
      wireForm(box.querySelector('form'), fields, async (v) => {
        await post('/incentives/programs', { event_ticker: v.event_ticker, ...(v.title ? { title: v.title } : {}), start_time: v.start_time, end_time: v.end_time, reward_pool_dollars: toApiDollars(v.reward_pool_dollars), target_size: Number(v.target_size), max_spread_cents: Number(v.max_spread_cents), discount: Number(v.discount), competition: v.competition, payout_mode: v.payout_mode, reason: v.reason });
        box.innerHTML = ''; toast('Program created'); load();
      });
      return;
    }
    if (e.target.closest('[data-snapshot]')) { try { const r = await post('/incentives/snapshot', {}); toast(`Snapshot: ${r.snapshots.length} program(s)`); load(); } catch (ex) { toast(ex.message, 'error'); } return; }
    const pay = e.target.closest('[data-payout]');
    if (pay) {
      const ok = await confirmAction({ title: 'Pay out accrued rewards?', body: 'Every participant receives the whole cents accrued and not yet paid. This posts journal entries and cannot be undone.', confirm: 'Pay out', reason: true });
      if (!ok) return;
      try { const r = await post(`/incentives/programs/${encodeURIComponent(pay.dataset.payout)}/payout`, { reason: ok.reason }); toast(`Paid ${fmtMoney(r.total_dollars)} to ${r.paid.length} participant(s)`); load(); } catch (ex) { toast(ex.message, 'error'); }
      return;
    }
    const c = e.target.closest('[data-cancel-program]');
    if (c) {
      const ok = await confirmAction({ title: 'Cancel this program?', confirm: 'Cancel program', danger: true, reason: true });
      if (!ok) return;
      try { await put(`/incentives/programs/${encodeURIComponent(c.dataset.cancelProgram)}`, { status: 'canceled', reason: ok.reason }); load(); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
  await load();
}
