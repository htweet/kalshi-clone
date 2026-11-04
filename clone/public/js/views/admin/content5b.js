// Admin sections for Phase 5B (CLONE_SPEC.md §29): AI summaries (content.write; settings need settings.write) and the
// Liquidity Incentive Program (markets.ops; payouts need users.money and step-up). Every change asks for a reason and
// is written to the hash-chained audit log by the server.
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.content5b-strings.js';
import { t as T } from '../../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { pxc, priceUnit, sym, currency, toApiDollars, moneyStep } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, post, put, toast, dataTable, formHtml, wireForm, confirmAction, section, badge, fmtTime, fmtMoney } from './ui.js';

export async function render({ el, section: key, perms }) {
  if (key === 'incentives') return renderIncentives(el, perms);
  return renderSummaries(el, perms);
}

// ---------------------------------------------------------------- AI summaries
async function renderSummaries(el, perms) {
  el.innerHTML = section(tx('admin.content5b.render_summaries.ai_summaries'), tx('admin.content5b.render_summaries.summaries_and_timelines_generated_from'))
    + '<div data-status class="adm-toolbar"></div><div data-list></div><div data-settings></div>';
  const load = async () => {
    const r = await get('/ai_summaries');
    el.querySelector('[data-status]').innerHTML = `<p class="muted" data-testid="ai-usage">${te('admin.content5b.render_summaries.provider')} <b>${esc(r.external_provider ? r.external_provider.label : tx('admin.content5b.render_summaries.offline_extractive_summarizer'))}</b> ${te('admin.content5b.render_summaries.today_request_s_tokens_fallback', { requests: esc(r.usage.requests), value: esc(r.usage.input_tokens + r.usage.output_tokens), fallbacks: esc(r.usage.fallbacks), rejected: esc(r.usage.rejected) })}</p>`;
    dataTable(el.querySelector('[data-list]'), {
      testid: 'ai-summaries-table', rows: r.summaries, rowAttrs: (x) => `data-event="${esc(x.event_ticker)}"`,
      cols: [{ key: 'event_ticker', label: tx('admin.content5b.render_summaries.event'), render: (x) => `<code>${esc(x.event_ticker)}</code><div class="faint">${esc(x.title)}</div>` }, { key: 'items', label: tx('admin.content5b.render_summaries.news'), num: true },
        { key: 'provider', label: tx('admin.content5b.render_summaries.provider_2'), render: (x) => (x.provider ? `${badge(x.provider, x.provider === 'extractive' ? '' : 'ok')}${x.fallback_reason ? ` <span class="faint" data-testid="ai-fallback">${esc(x.fallback_reason)}</span>` : ''}` : `<span class="faint">${te('admin.content5b.render_summaries.not_generated')}</span>`) },
        { key: 'hidden', label: 'State', render: (x) => (x.hidden ? `${badge('hidden', 'warn')} <span class="faint">${esc(x.hidden_reason)}</span>` : badge('shown', 'ok')) },
        { key: 'generated_time', label: tx('admin.content5b.render_summaries.generated'), render: (x) => esc(fmtTime(x.generated_time)) },
        { key: '_a', label: '', sort: false, render: (x) => `<span class="adm-actions">${x.hidden ? `<button class="btn btn-sm" data-unhide="${esc(x.event_ticker)}">${te('admin.content5b.render_summaries.unhide')}</button>` : `<button class="btn btn-sm" data-hide="${esc(x.event_ticker)}" data-testid="ai-hide">${te('admin.content5b.render_summaries.hide')}</button>`}<button class="btn btn-sm" data-regen="${esc(x.event_ticker)}" data-testid="ai-regenerate">${te('admin.content5b.render_summaries.regenerate')}</button></span>` }],
      empty: tx('admin.content5b.render_summaries.no_event_has_news_items'),
    });
    if (perms.has('settings.write')) {
      const s = r.settings;
      const fields = [{ name: 'enabled', label: tx('admin.content5b.render_summaries.use_the_external_provider_when'), type: 'checkbox', value: s.enabled }, { name: 'daily_request_limit', label: tx('admin.content5b.render_summaries.daily_request_limit'), type: 'number', value: s.daily_request_limit },
        { name: 'daily_token_limit', label: tx('admin.content5b.render_summaries.daily_token_limit'), type: 'number', value: s.daily_token_limit }, { name: 'max_sentences', label: tx('admin.content5b.render_summaries.sentences_per_summary'), type: 'number', value: s.max_sentences },
        { name: 'blocklist', label: tx('admin.content5b.render_summaries.moderation_blocklist_comma_separated'), value: (s.blocklist || []).join(', '), span: true }, { name: 'reason', label: tx('admin.content5b.render_summaries.reason_audit_log'), required: true, span: true }];
      const box = el.querySelector('[data-settings]');
      box.innerHTML = `<h3>${te('admin.content5b.render_summaries.budget_and_moderation')}</h3>${formHtml(fields, { id: 'ais', submit: tx('admin.content5b.render_summaries.save_settings'), testid: 'ai-settings-form' })}`;
      wireForm(box.querySelector('form'), fields, async (v) => {
        await put('/ai_summaries/settings', { enabled: v.enabled, daily_request_limit: Number(v.daily_request_limit), daily_token_limit: Number(v.daily_token_limit), max_sentences: Number(v.max_sentences), blocklist: String(v.blocklist).split(',').map((x) => x.trim()).filter(Boolean), reason: v.reason });
        toast(tx('admin.content5b.render_summaries.settings_saved')); load();
      });
    }
  };
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-hide],[data-unhide],[data-regen]');
    if (!b) return;
    const t = b.dataset.hide || b.dataset.unhide || b.dataset.regen;
    const action = b.dataset.hide ? 'hide' : b.dataset.unhide ? 'unhide' : 'regenerate';
    const ok = await confirmAction({ title: tx('admin.content5b.render_summaries.the_summary_for', { to_upper_case: action[0].toUpperCase(), slice: action.slice(1), t }), confirm: action === 'hide' ? tx('admin.content5b.render_summaries.hide') : action === 'unhide' ? tx('admin.content5b.render_summaries.unhide') : tx('admin.content5b.render_summaries.regenerate'), reason: true, danger: action === 'hide' });
    if (!ok) return;
    try { await post(`/ai_summaries/${encodeURIComponent(t)}/${action}`, { reason: ok.reason }); toast(action === 'regenerate' ? tx('admin.content5b.render_summaries.summary_regenerated') : tx('admin.content5b.render_summaries.summary', { value: action === 'hide' ? 'hidden' : 'shown' })); load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  await load();
}

// ---------------------------------------------------------------- Liquidity Incentive Program
async function renderIncentives(el, perms) {
  el.innerHTML = section(tx('admin.content5b.render_incentives.liquidity_incentives'), tx('admin.content5b.render_incentives.programs_pay_a_reward_pool'), `<button class="btn" data-snapshot data-testid="lip-snapshot">${te('admin.content5b.render_incentives.run_snapshot_now')}</button><button class="btn btn-primary" data-new data-testid="lip-new">${te('admin.content5b.render_incentives.new_program')}</button>`)
    + '<div data-form></div><div data-list></div><div data-settings></div>';
  const fields = [
    { name: 'event_ticker', label: tx('admin.content5b.render_incentives.event_ticker'), required: true }, { name: 'title', label: tx('admin.content5b.render_incentives.title_optional') },
    { name: 'start_time', label: tx('admin.content5b.render_incentives.start'), type: 'datetime', required: true, value: new Date().toISOString() }, { name: 'end_time', label: tx('admin.content5b.render_incentives.end'), type: 'datetime', required: true, value: new Date(Date.now() + 14 * 864e5).toISOString() },
    { name: 'reward_pool_dollars', label: T('admin.reward_pool', { symbol: sym() }), type: 'number', step: moneyStep(), required: true, value: currency.code === 'USD' ? 100 : 10000 }, { name: 'target_size', label: tx('admin.content5b.render_incentives.target_size_contracts'), type: 'number', value: 100 },
    { name: 'max_spread_cents', label: T('admin.spread_window', { unit: priceUnit() }), type: 'number', value: 3 }, { name: 'discount', label: T('admin.discount', { price: pxc(100) }), type: 'number', step: '0.05', value: 0.5 },
    { name: 'competition', label: tx('admin.content5b.render_incentives.competition'), type: 'select', options: [['auto', tx('admin.content5b.render_incentives.automatic')], ['low', tx('admin.content5b.render_incentives.low')], ['high', tx('admin.content5b.render_incentives.high')]], value: 'auto' },
    { name: 'payout_mode', label: tx('admin.content5b.render_incentives.pay_as'), type: 'select', options: [['cash', tx('admin.content5b.render_incentives.cash')], ['credits', tx('admin.content5b.render_incentives.credits')]], value: 'cash' }, { name: 'reason', label: tx('admin.content5b.render_incentives.reason_audit_log'), required: true, span: true }];
  const load = async () => {
    const r = await get('/incentives/programs');
    dataTable(el.querySelector('[data-list]'), {
      testid: 'lip-admin-table', rows: r.programs, rowAttrs: (p) => `data-program="${esc(p.id)}"`,
      cols: [{ key: 'title', label: tx('admin.content5b.render_incentives.program'), render: (p) => `${esc(p.title)}<div class="faint"><code>${esc(p.event_ticker)}</code></div>` }, { key: 'status', label: tx('admin.content5b.render_incentives.status'), render: (p) => badge(p.status, p.status === 'active' ? 'ok' : p.status === 'canceled' ? 'bad' : '') },
        { key: 'start_date', label: tx('admin.content5b.render_incentives.window'), render: (p) => `${esc(fmtTime(p.start_date))} → ${esc(fmtTime(p.end_date))}` }, { key: 'period_reward_dollars', label: tx('admin.content5b.render_incentives.pool'), num: true, render: (p) => esc(fmtMoney(p.period_reward_dollars)) },
        { key: 'accrued_dollars', label: tx('admin.content5b.render_incentives.accrued'), num: true, render: (p) => `<span data-testid="lip-admin-accrued">${esc(fmtMoney(p.accrued_dollars))}</span>` }, { key: 'paid_dollars', label: tx('admin.content5b.render_incentives.paid'), num: true, render: (p) => esc(fmtMoney(p.paid_dollars)) },
        { key: 'accruals', label: tx('admin.content5b.render_incentives.earners'), num: true }, { key: 'payout_mode', label: tx('admin.content5b.render_incentives.pays') },
        { key: '_a', label: '', sort: false, render: (p) => `<span class="adm-actions">${perms.has('users.money') && !['canceled'].includes(p.status) ? `<button class="btn btn-sm" data-payout="${esc(p.id)}" data-testid="lip-payout">${te('admin.content5b.render_incentives.pay_out')}</button>` : ''}${['scheduled', 'active'].includes(p.status) ? `<button class="btn btn-sm btn-ghost" data-cancel-program="${esc(p.id)}">${te('admin.content5b.render_incentives.cancel')}</button>` : ''}</span>` }],
      empty: tx('admin.content5b.render_incentives.no_programs_yet'),
    });
    if (perms.has('settings.write')) {
      const sf = [{ name: 'blocked_regions', label: tx('admin.content5b.render_incentives.blocked_regions_country_codes_comma'), value: (r.settings.blocked_regions || []).join(', '), span: true }, { name: 'auto_payout', label: tx('admin.content5b.render_incentives.pay_out_automatically_when_a'), type: 'checkbox', value: r.settings.auto_payout }, { name: 'reason', label: tx('admin.content5b.render_incentives.reason_audit_log'), required: true, span: true }];
      const box = el.querySelector('[data-settings]');
      box.innerHTML = `<h3>${te('admin.content5b.render_incentives.eligibility')}</h3>${formHtml(sf, { id: 'lips', submit: 'Save', testid: 'lip-settings-form' })}`;
      wireForm(box.querySelector('form'), sf, async (v) => { await put('/incentives/settings', { blocked_regions: String(v.blocked_regions).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean), auto_payout: v.auto_payout, reason: v.reason }); toast(tx('admin.content5b.render_incentives.saved')); load(); });
    }
  };
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-new]')) {
      const box = el.querySelector('[data-form]');
      box.innerHTML = `<div class="card adm-panel">${formHtml(fields, { id: 'lip', submit: tx('admin.content5b.render_incentives.create_program'), testid: 'lip-form' })}</div>`;
      wireForm(box.querySelector('form'), fields, async (v) => {
        await post('/incentives/programs', { event_ticker: v.event_ticker, ...(v.title ? { title: v.title } : {}), start_time: v.start_time, end_time: v.end_time, reward_pool_dollars: toApiDollars(v.reward_pool_dollars), target_size: Number(v.target_size), max_spread_cents: Number(v.max_spread_cents), discount: Number(v.discount), competition: v.competition, payout_mode: v.payout_mode, reason: v.reason });
        box.innerHTML = ''; toast(tx('admin.content5b.render_incentives.program_created')); load();
      });
      return;
    }
    if (e.target.closest('[data-snapshot]')) { try { const r = await post('/incentives/snapshot', {}); toast(tx('admin.content5b.render_incentives.snapshot_program_s', { value: r.snapshots.length })); load(); } catch (ex) { toast(ex.message, 'error'); } return; }
    const pay = e.target.closest('[data-payout]');
    if (pay) {
      const ok = await confirmAction({ title: tx('admin.content5b.render_incentives.pay_out_accrued_rewards'), body: tx('admin.content5b.render_incentives.every_participant_receives_the_whole'), confirm: tx('admin.content5b.render_incentives.pay_out'), reason: true });
      if (!ok) return;
      try { const r = await post(`/incentives/programs/${encodeURIComponent(pay.dataset.payout)}/payout`, { reason: ok.reason }); toast(tx('admin.content5b.render_incentives.paid_to_participant_s', { fmt_money: fmtMoney(r.total_dollars), value: r.paid.length })); load(); } catch (ex) { toast(ex.message, 'error'); }
      return;
    }
    const c = e.target.closest('[data-cancel-program]');
    if (c) {
      const ok = await confirmAction({ title: tx('admin.content5b.render_incentives.cancel_this_program'), confirm: tx('admin.content5b.render_incentives.cancel_program'), danger: true, reason: true });
      if (!ok) return;
      try { await put(`/incentives/programs/${encodeURIComponent(c.dataset.cancelProgram)}`, { status: 'canceled', reason: ok.reason }); load(); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
  await load();
}
