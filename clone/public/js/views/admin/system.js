// Audit log viewer and system settings (interest APY, feature switches, publish liquidity, health) plus the runtime-editable
// exchange + perimeter settings (gap G7: taker fee coefficient, rolling window, rate-limit tiers, bot management).
import { money, pxc, priceUnit, setCurrency, withCurrency, assetPrice, fmtDt } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, put, toast, dataTable, formHtml, wireForm, section, fmtTime, badge } from './ui.js';

export async function render({ el, section: sec }) {
  if (sec === 'audit') return renderAudit(el);
  return renderSettings(el);
}

async function renderAudit(el) {
  el.innerHTML = section('Audit log', 'Every admin change: who, what, the before/after state and the reason.') +
    `<form class="adm-toolbar adm-filters" data-f data-testid="audit-filters"><label class="field"><span>Actor email</span><input name="actor" class="adm-input"></label><label class="field"><span>Action starts with</span><input name="action" class="adm-input" placeholder="users."></label>
     <label class="field"><span>Target</span><input name="target" class="adm-input" placeholder="ticker or id"></label><label class="field"><span>From</span><input type="date" name="from"></label><label class="field"><span>To</span><input type="date" name="to"></label><button class="btn" type="submit">Filter</button></form>
     <p class="faint" data-total></p><div id="al"></div>`;
  const t = dataTable(el.querySelector('#al'), { testid: 'audit-log', pageSize: 50, rowAttrs: (r) => `data-action="${esc(r.action)}"`,
    searchText: (r) => [r.actor_email, r.action, r.target_type, r.target_id, r.reason].join(' '),
    cols: [{ key: 'time', label: 'Time', render: (r) => esc(fmtTime(r.time)) }, { key: 'actor_email', label: 'Who' }, { key: 'action', label: 'Action', render: (r) => `<code>${esc(r.action)}</code>` },
      { key: 'target_id', label: 'Target', render: (r) => `<span class="faint">${esc(r.target_type)}</span> ${esc(r.target_id)}` }, { key: 'reason', label: 'Reason' },
      { key: '_d', label: 'Change', sort: false, render: (r) => (r.before || r.after ? `<details><summary>before / after</summary><div class="adm-diff"><pre>${esc(JSON.stringify(r.before, null, 1))}</pre><pre>${esc(JSON.stringify(r.after, null, 1))}</pre></div></details>` : '') }] });
  const form = el.querySelector('[data-f]');
  const load = async () => {
    const p = new URLSearchParams(Object.entries(Object.fromEntries(new FormData(form))).filter(([, v]) => v));
    const r = await get(`/audit?limit=500&${p}`);
    el.querySelector('[data-total]').textContent = `${r.total} matching entr${r.total === 1 ? 'y' : 'ies'}${r.total > 500 ? ' (showing newest 500)' : ''}`;
    t.setRows(r.entries);
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); load().catch((ex) => toast(ex.message, 'error')); });
  await load();
}

async function renderSettings(el) {
  const [{ settings: s }, h, cur] = await Promise.all([get('/settings'), get('/health'), get('/settings/currency')]);
  const fields = [
    { name: 'interest_apy_pct', label: 'Interest APY (%)', type: 'number', step: '0.01', required: true, value: +(s.interest_apy * 100).toFixed(4), hint: 'Paid daily on cash + open-position cost basis; used by the next accrual.' },
    { name: 'social', label: 'Social features visible', type: 'checkbox', value: s.features.social },
    { name: 'perps', label: 'Perps visible', type: 'checkbox', value: s.features.perps },
    { name: 'combos', label: 'Combos visible', type: 'checkbox', value: s.features.combos },
    { name: 'pl_enabled', label: 'Seed liquidity when publishing markets', type: 'checkbox', value: s.publish_liquidity.enabled, span: true },
    { name: 'pl_spread', label: `Seed spread (${priceUnit()})`, type: 'number', value: s.publish_liquidity.spread_cents },
    { name: 'pl_size', label: 'Seed size per level (contracts)', type: 'number', value: s.publish_liquidity.size_contracts },
    { name: 'pl_levels', label: 'Seed levels per side', type: 'number', value: s.publish_liquidity.levels },
  ];
  const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
  const up = (sec) => `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ${sec % 60}s`;
  el.innerHTML = section('Settings & health') + `<div class="adm-two"><div class="card adm-card"><h3>Settings</h3>${formHtml(fields, { submit: 'Save settings', id: 'set', testid: 'settings-form' })}</div>
    <div><div class="card adm-card" data-testid="health"><h3>Health ${h.ok ? badge('OK', 'ok') : badge('Problem', 'bad')}</h3><dl class="adm-dl">
      <dt>Database size</dt><dd data-testid="health-db">${mb(h.db.bytes)} <span class="faint">(+ ${mb(h.db.wal_bytes)} WAL)</span></dd><dt>Uptime</dt><dd data-testid="health-uptime">${up(h.uptime_seconds)}</dd>
      <dt>WebSocket clients</dt><dd data-testid="health-ws">${esc(h.ws_clients ?? '—')}</dd><dt>Trading</dt><dd>${h.trading_active ? 'on' : 'paused'}</dd><dt>Node</dt><dd>${esc(h.node)} · ${esc(h.memory_mb)} MB RSS</dd>
      ${Object.entries(h.tables).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${Number(v).toLocaleString('en-US')}</dd>`).join('')}</dl></div>
    <div class="card adm-card" data-testid="taker-fee"><h3>Taker fee</h3><p><b data-testid="taker-fee-coefficient">${esc(s.taker_fee.coefficient)}</b> · <code>${esc(s.taker_fee.formula)}</code></p><p class="faint">${esc(s.taker_fee.note)}</p></div>
    <div class="card adm-card" data-testid="rate-limit"><h3>Rate limit</h3><p>${esc(s.rate_limit.burst)} burst · ${esc(s.rate_limit.per_second)}/s ${esc(s.rate_limit.scope)}</p><p class="faint">${esc(s.rate_limit.note)}</p><p class="faint">Rolling market window: ${esc(s.rolling_window_seconds)} s</p></div></div></div>
    ${currencyCard(cur)}
    ${s.rate_limits && s.bot ? `<div class="card adm-card"><h3>Exchange &amp; perimeter</h3><p class="faint">Take effect immediately, without a restart; every change is in the audit log.</p>${formHtml(perimeterFields(s), { submit: 'Save exchange & perimeter settings', id: 'per', testid: 'perimeter-form' })}</div>` : ''}`;
  const pf = el.querySelector('[data-testid=perimeter-form]');
  if (pf) wirePerimeter(pf, s);
  wireCurrency(el.querySelector('[data-testid=currency-panel]'), cur);
  wireForm(el.querySelector('[data-testid=settings-form]'), fields, async (v) => {
    const r = await put('/settings', { interest_apy: Number(v.interest_apy_pct) / 100, features: { social: v.social, perps: v.perps, combos: v.combos },
      publish_liquidity: { enabled: v.pl_enabled, spread_cents: v.pl_spread, size_contracts: v.pl_size, levels: v.pl_levels } }).catch((ex) => {
      if (ex.fields) ex.fields = Object.fromEntries(Object.entries(ex.fields).map(([k, m]) => [{ interest_apy: 'interest_apy_pct', 'publish_liquidity.spread_cents': 'pl_spread', 'publish_liquidity.size_contracts': 'pl_size', 'publish_liquidity.levels': 'pl_levels' }[k] || k, m]));
      throw ex;
    });
    toast(`Settings saved · APY ${(r.settings.interest_apy * 100).toFixed(2)}%`);
    window.dispatchEvent(new CustomEvent('parlance:site-config'));
  });
}

const TIERS = [['anonymous', 'Anonymous (per IP)'], ['user', 'Signed-in (per account)'], ['admin', 'Staff (per account)'], ['auth', 'Credential endpoints (per IP)'], ['write', 'Writes (per account or IP)']];
const BOT_FIELDS = { challenge_mode: 'challenge_mode', pow_difficulty: 'pow_difficulty', client_token_ttl_seconds: 'ct_ttl', challenge_pass_ttl_seconds: 'pass_ttl', html_per_minute: 'html_per_minute' };
function perimeterFields(s) {
  return [
    { name: 'taker_fee_coefficient', label: 'Taker fee coefficient', type: 'number', step: '0.0001', required: true, value: s.taker_fee.coefficient, hint: 'fee = ceil(coefficient × C × P × (1 − P)); 0.07 by default, 0–0.25.' },
    { name: 'rolling_window_seconds', label: 'Rolling market window (s)', type: 'number', required: true, value: s.rolling_window_seconds, hint: 'Open windows keep their close time; the next one uses the new length.' },
    ...TIERS.flatMap(([k, l]) => [
      { name: `rl_${k}_burst`, label: `${l}: burst`, type: 'number', required: true, value: s.rate_limits[k].burst },
      { name: `rl_${k}_rate`, label: `${l}: per second`, type: 'number', step: '0.01', required: true, value: s.rate_limits[k].per_second },
    ]),
    { name: 'challenge_mode', label: 'Bot challenge', type: 'select', value: s.bot.challenge_mode, options: [['off', 'Off'], ['suspicious', 'Suspicious HTML requests'], ['all', 'Every HTML request (attack mode)']] },
    { name: 'pow_difficulty', label: 'Proof-of-work difficulty (bits)', type: 'number', required: true, value: s.bot.pow_difficulty, hint: 'Each extra bit doubles the average solve time (14 ≈ 16k hashes).' },
    { name: 'ct_ttl', label: 'Client token lifetime (s)', type: 'number', required: true, value: s.bot.client_token_ttl_seconds },
    { name: 'pass_ttl', label: 'Challenge pass lifetime (s)', type: 'number', required: true, value: s.bot.challenge_pass_ttl_seconds },
    { name: 'html_per_minute', label: 'HTML pages per IP per minute before challenging', type: 'number', required: true, value: s.bot.html_per_minute },
  ];
}
function wirePerimeter(form, s) {
  const fields = perimeterFields(s);
  const back = { taker_fee_coefficient: 'taker_fee_coefficient', rolling_window_seconds: 'rolling_window_seconds' };
  for (const [k] of TIERS) { back[`rate_limits.${k}.burst`] = `rl_${k}_burst`; back[`rate_limits.${k}.per_second`] = `rl_${k}_rate`; }
  for (const [k, f] of Object.entries(BOT_FIELDS)) back[`bot.${k}`] = f;
  wireForm(form, fields, async (v) => {
    const body = {
      taker_fee_coefficient: v.taker_fee_coefficient, rolling_window_seconds: v.rolling_window_seconds,
      rate_limits: Object.fromEntries(TIERS.map(([k]) => [k, { burst: v[`rl_${k}_burst`], per_second: v[`rl_${k}_rate`] }])),
      bot: Object.fromEntries(Object.entries(BOT_FIELDS).map(([k, f]) => [k, v[f]])),
    };
    const r = await put('/settings', body).catch((ex) => { if (ex.fields) ex.fields = Object.fromEntries(Object.entries(ex.fields).map(([k, m]) => [back[k] || k, m])); throw ex; });
    toast(`Saved · taker fee ${r.settings.taker_fee.coefficient} · challenge ${r.settings.bot.challenge_mode}`);
    const c = document.querySelector('[data-testid=taker-fee-coefficient]'); if (c) c.textContent = String(r.settings.taker_fee.coefficient);
  });
}

// ---------------------------------------------------------------- Currency & defaults (CLONE_SPEC.md §30)
// Display currency, locale and time zone for every money string and date (pages, toasts, notifications, emails, CSV and
// PDF exports), plus the settings NEW accounts start with. Saving needs settings.write, a reason and step-up (the
// server asks; ui.js call() opens the step-up dialog) and is audited; open pages update live over WebSocket.
const ZONES = ['Africa/Lagos', 'UTC', 'Africa/Accra', 'Africa/Nairobi', 'Africa/Johannesburg', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
const LOCALE_LABELS = { 'en-NG': 'English (Nigeria)', 'en-US': 'English (United States)', 'en-GB': 'English (United Kingdom)' };
function currencyFields(cur) {
  const c = cur.display_currency; const a = cur.account_defaults; const o = cur.options;
  return [
    { name: 'code', label: 'Display currency', type: 'select', value: c.code, options: o.codes.map((k) => [k, k === 'NGN' ? 'NGN · Nigerian naira (₦, a contract pays ₦100)' : 'USD · US dollar ($, cents)']) },
    { name: 'locale', label: 'Locale (numbers and dates)', type: 'select', value: c.locale, options: o.locales.map((k) => [k, `${LOCALE_LABELS[k] || k} · ${k}`]) },
    { name: 'timezone', label: 'Time zone (dates, calendar days, exports, notifications)', type: 'select', value: c.timezone, options: [...new Set([c.timezone, ...ZONES])] },
    { name: 'theme', label: 'New accounts: theme', type: 'select', value: a.theme, options: o.themes.map((k) => [k, k[0].toUpperCase() + k.slice(1)]) },
    { name: 'display_mode', label: 'New accounts: market preview', type: 'select', value: a.display_mode, options: [['payout', 'Payout and odds'], ['shares', 'Shares and prices']] },
    { name: 'order_review', label: 'New accounts: review orders before placing', type: 'checkbox', value: a.order_review },
    { name: 'flip_sell', label: 'New accounts: flip sell on', type: 'checkbox', value: a.flip_sell },
    ...o.channels.map((ch) => ({ name: `ch_${ch}`, label: `New accounts: ${ch === 'in_app' ? 'in-app' : ch} notifications`, type: 'checkbox', value: a.notification_channels[ch] })),
    { name: 'reason', label: 'Reason (required, recorded in the audit log)', required: true, span: true },
  ];
}
function currencyCard(cur) {
  return `<div class="card adm-card" data-testid="currency-panel"><h3>Currency &amp; defaults</h3>
    <p class="faint">Display only: balances, prices and the API keep their internal units and field names. Under NGN 1 internal cent shows as ₦1 (a contract pays ₦100); perps use the same rule. Existing accounts keep their saved settings; the defaults apply to accounts created from now on.</p>
    ${formHtml(currencyFields(cur), { submit: 'Save currency & defaults', id: 'cur', testid: 'currency-form' })}
    <h3>Preview</h3><dl class="adm-dl" data-testid="currency-preview"></dl></div>`;
}
function wireCurrency(card, cur) {
  if (!card) return;
  const form = card.querySelector('form');
  const fields = currencyFields(cur);
  const sample = Date.parse('2026-11-04T23:30:00Z'); // 00:30 the next day in Lagos: shows the zone's day boundary
  const preview = () => {
    const d = { code: form.elements.code.value, locale: form.elements.locale.value, timezone: form.elements.timezone.value };
    const rows = withCurrency(d, () => [
      ['Price (64¢ internal)', pxc(6400)], ['Fine-grid price (64.50¢)', pxc(6450)], ['Balance ($25.00 internal)', money(25)], ['Max payout, 10 contracts', money(10)],
      ['Perps BTC level ($96,250)', assetPrice(96250, 2)], ['Funding ($0.0123)', money(0.0123, { plus: true, exact: d.code === 'USD' ? 4 : 2 })],
      ['Date and time (23:30 UTC)', fmtDt(sample, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })], ['Price input unit', priceUnit()],
    ]);
    card.querySelector('[data-testid=currency-preview]').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd data-preview="${esc(k)}">${esc(v)}</dd>`).join('');
  };
  form.addEventListener('input', preview); form.addEventListener('change', preview);
  preview();
  const back = { 'display_currency.code': 'code', 'display_currency.locale': 'locale', 'display_currency.timezone': 'timezone', 'account_defaults.theme': 'theme', 'account_defaults.display_mode': 'display_mode', 'account_defaults.order_review': 'order_review', 'account_defaults.flip_sell': 'flip_sell' };
  wireForm(form, fields, async (v) => {
    const body = {
      display_currency: { code: v.code, locale: v.locale, timezone: v.timezone },
      account_defaults: { theme: v.theme, display_mode: v.display_mode, order_review: v.order_review, flip_sell: v.flip_sell, notification_channels: Object.fromEntries(cur.options.channels.map((ch) => [ch, v[`ch_${ch}`]])) },
      reason: v.reason,
    };
    const r = await put('/settings/currency', body).catch((ex) => { if (ex.fields) ex.fields = Object.fromEntries(Object.entries(ex.fields).map(([k, m]) => [back[k] || k, m])); throw ex; });
    toast(`Currency & defaults saved · ${r.descriptor.code} · ${r.descriptor.timezone}`);
    setCurrency(r.descriptor); // this page at once; every other open page gets the WebSocket push
  });
}
