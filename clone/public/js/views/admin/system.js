// Audit log viewer and system settings (interest APY, feature switches, publish liquidity, health) plus the runtime-editable
// exchange + perimeter settings (gap G7: taker fee coefficient, rolling window, rate-limit tiers, bot management).
import { t as tx, te, ts } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.system-strings.js';
import { t as T } from '../../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { money, pxc, priceUnit, setCurrency, withCurrency, assetPrice, fmtDt } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { esc, get, put, toast, dataTable, formHtml, wireForm, section, fmtTime, badge } from './ui.js';

export async function render({ el, section: sec }) {
  if (sec === 'audit') return renderAudit(el);
  return renderSettings(el);
}

async function renderAudit(el) {
  el.innerHTML = section(tx('admin.system.render_audit.audit_log'), tx('admin.system.render_audit.every_admin_change_who_what')) +
    `<form class="adm-toolbar adm-filters" data-f data-testid="audit-filters"><label class="field"><span>${te('admin.system.render_audit.actor_email')}</span><input name="actor" class="adm-input"></label><label class="field"><span>${te('admin.system.render_audit.action_starts_with')}</span><input name="action" class="adm-input" placeholder="${te('admin.system.render_audit.users')}"></label>
     <label class="field"><span>${te('admin.system.render_audit.target')}</span><input name="target" class="adm-input" placeholder="${te('admin.system.render_audit.ticker_or_id')}"></label><label class="field"><span>${te('admin.system.render_audit.from')}</span><input type="date" name="from"></label><label class="field"><span>${te('admin.system.render_audit.to')}</span><input type="date" name="to"></label><button class="btn" type="submit">${te('admin.system.render_audit.filter')}</button></form>
     <p class="faint" data-total></p><div id="al"></div>`;
  const t = dataTable(el.querySelector('#al'), { testid: 'audit-log', pageSize: 50, rowAttrs: (r) => `data-action="${esc(r.action)}"`,
    searchText: (r) => [r.actor_email, r.action, r.target_type, r.target_id, r.reason].join(' '),
    cols: [{ key: 'time', label: tx('admin.system.render_audit.time'), render: (r) => esc(fmtTime(r.time)) }, { key: 'actor_email', label: tx('admin.system.render_audit.who') }, { key: 'action', label: tx('admin.system.render_audit.action'), render: (r) => `<code>${esc(r.action)}</code>` },
      { key: 'target_id', label: tx('admin.system.render_audit.target'), render: (r) => `<span class="faint">${esc(r.target_type)}</span> ${esc(r.target_id)}` }, { key: 'reason', label: tx('admin.system.render_audit.reason') },
      { key: '_d', label: tx('admin.system.render_audit.change'), sort: false, render: (r) => (r.before || r.after ? `<details><summary>${te('admin.system.render_audit.before_after')}</summary><div class="adm-diff"><pre>${esc(JSON.stringify(r.before, null, 1))}</pre><pre>${esc(JSON.stringify(r.after, null, 1))}</pre></div></details>` : '') }] });
  const form = el.querySelector('[data-f]');
  const load = async () => {
    const p = new URLSearchParams(Object.entries(Object.fromEntries(new FormData(form))).filter(([, v]) => v));
    const r = await get(`/audit?limit=500&${p}`);
    el.querySelector('[data-total]').textContent = tx('admin.system.render_audit.matching_entr', { total: r.total, value: r.total === 1 ? 'y' : 'ies', value_2: r.total > 500 ? (' ' + tx('admin.system.render_audit.showing_newest_500')) : '' });
    t.setRows(r.entries);
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); load().catch((ex) => toast(ex.message, 'error')); });
  await load();
}

async function renderSettings(el) {
  const [{ settings: s }, h, cur] = await Promise.all([get('/settings'), get('/health'), get('/settings/currency')]);
  const fields = [
    { name: 'interest_apy_pct', label: tx('admin.system.render_settings.interest_apy'), type: 'number', step: '0.01', required: true, value: +(s.interest_apy * 100).toFixed(4), hint: tx('admin.system.render_settings.paid_daily_on_cash_open') },
    { name: 'social', label: tx('admin.system.render_settings.social_features_visible'), type: 'checkbox', value: s.features.social },
    { name: 'perps', label: tx('admin.system.render_settings.perps_visible'), type: 'checkbox', value: s.features.perps },
    { name: 'combos', label: tx('admin.system.render_settings.combos_visible'), type: 'checkbox', value: s.features.combos },
    { name: 'pl_enabled', label: tx('admin.system.render_settings.seed_liquidity_when_publishing_markets'), type: 'checkbox', value: s.publish_liquidity.enabled, span: true },
    { name: 'pl_spread', label: T('admin.seed_spread', { unit: priceUnit() }), type: 'number', value: s.publish_liquidity.spread_cents },
    { name: 'pl_size', label: tx('admin.system.render_settings.seed_size_per_level_contracts'), type: 'number', value: s.publish_liquidity.size_contracts },
    { name: 'pl_levels', label: tx('admin.system.render_settings.seed_levels_per_side'), type: 'number', value: s.publish_liquidity.levels },
  ];
  const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
  const up = (sec) => `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ${sec % 60}s`;
  el.innerHTML = section(tx('admin.system.render_settings.settings_health')) + `<div class="adm-two"><div class="card adm-card"><h3>${te('admin.system.render_settings.settings')}</h3>${formHtml(fields, { submit: tx('admin.system.render_settings.save_settings'), id: 'set', testid: 'settings-form' })}</div>
    <div><div class="card adm-card" data-testid="health"><h3>${te('admin.system.render_settings.health', { value: h.ok ? badge('OK', 'ok') : badge(tx('admin.system.render_settings.problem'), 'bad') })}</h3><dl class="adm-dl">
      <dt>${te('admin.system.render_settings.database_size')}</dt><dd data-testid="health-db">${mb(h.db.bytes)} <span class="faint">${te('admin.system.render_settings.wal', { mb: mb(h.db.wal_bytes) })}</span></dd><dt>${te('admin.system.render_settings.uptime')}</dt><dd data-testid="health-uptime">${up(h.uptime_seconds)}</dd>
      <dt>${te('admin.system.render_settings.websocket_clients')}</dt><dd data-testid="health-ws">${esc(h.ws_clients ?? '—')}</dd><dt>${te('admin.system.render_settings.trading')}</dt><dd>${h.trading_active ? 'on' : te('admin.system.render_settings.paused')}</dd><dt>${te('admin.system.render_settings.node')}</dt><dd>${te('admin.system.render_settings.mb_rss', { node: esc(h.node), memory_mb: esc(h.memory_mb) })}</dd>
      ${Object.entries(h.tables).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${Number(v).toLocaleString('en-US')}</dd>`).join('')}</dl></div>
    <div class="card adm-card" data-testid="taker-fee"><h3>${te('admin.system.render_settings.taker_fee')}</h3><p><b data-testid="taker-fee-coefficient">${esc(s.taker_fee.coefficient)}</b> · <code>${esc(s.taker_fee.formula)}</code></p><p class="faint">${esc(s.taker_fee.note)}</p></div>
    <div class="card adm-card" data-testid="rate-limit"><h3>${te('admin.system.render_settings.rate_limit')}</h3><p>${te('admin.system.render_settings.burst_s', { burst: esc(s.rate_limit.burst), per_second: esc(s.rate_limit.per_second), scope: esc(s.rate_limit.scope) })}</p><p class="faint">${esc(s.rate_limit.note)}</p><p class="faint">${te('admin.system.render_settings.rolling_market_window_s', { rolling_window_seconds: esc(s.rolling_window_seconds) })}</p></div></div></div>
    ${currencyCard(cur)}
    ${s.rate_limits && s.bot ? `<div class="card adm-card"><h3>${te('admin.system.render_settings.exchange_perimeter')}</h3><p class="faint">${te('admin.system.render_settings.take_effect_immediately_without_a')}</p>${formHtml(perimeterFields(s), { submit: tx('admin.system.render_settings.save_exchange_perimeter_settings'), id: 'per', testid: 'perimeter-form' })}</div>` : ''}`;
  const pf = el.querySelector('[data-testid=perimeter-form]');
  if (pf) wirePerimeter(pf, s);
  wireCurrency(el.querySelector('[data-testid=currency-panel]'), cur);
  wireForm(el.querySelector('[data-testid=settings-form]'), fields, async (v) => {
    const r = await put('/settings', { interest_apy: Number(v.interest_apy_pct) / 100, features: { social: v.social, perps: v.perps, combos: v.combos },
      publish_liquidity: { enabled: v.pl_enabled, spread_cents: v.pl_spread, size_contracts: v.pl_size, levels: v.pl_levels } }).catch((ex) => {
      if (ex.fields) ex.fields = Object.fromEntries(Object.entries(ex.fields).map(([k, m]) => [{ interest_apy: 'interest_apy_pct', 'publish_liquidity.spread_cents': 'pl_spread', 'publish_liquidity.size_contracts': 'pl_size', 'publish_liquidity.levels': 'pl_levels' }[k] || k, m]));
      throw ex;
    });
    toast(tx('admin.system.render_settings.settings_saved_apy', { value: (r.settings.interest_apy * 100).toFixed(2) }));
    window.dispatchEvent(new CustomEvent('parlance:site-config'));
  });
}

const TIERS = [['anonymous', ts('admin.system.tiers.anonymous_per_ip')], ['user', ts('admin.system.tiers.signed_in_per_account')], ['admin', ts('admin.system.tiers.staff_per_account')], ['auth', ts('admin.system.tiers.credential_endpoints_per_ip')], ['write', ts('admin.system.tiers.writes_per_account_or_ip')]];
const BOT_FIELDS = { challenge_mode: 'challenge_mode', pow_difficulty: 'pow_difficulty', client_token_ttl_seconds: 'ct_ttl', challenge_pass_ttl_seconds: 'pass_ttl', html_per_minute: 'html_per_minute' };
function perimeterFields(s) {
  return [
    { name: 'taker_fee_coefficient', label: tx('admin.system.perimeter_fields.taker_fee_coefficient'), type: 'number', step: '0.0001', required: true, value: s.taker_fee.coefficient, hint: tx('admin.system.perimeter_fields.fee_ceil_coefficient_c_p') },
    { name: 'rolling_window_seconds', label: tx('admin.system.perimeter_fields.rolling_market_window_s'), type: 'number', required: true, value: s.rolling_window_seconds, hint: tx('admin.system.perimeter_fields.open_windows_keep_their_close') },
    ...TIERS.flatMap(([k, l]) => [
      { name: `rl_${k}_burst`, label: `${l}: burst`, type: 'number', required: true, value: s.rate_limits[k].burst },
      { name: `rl_${k}_rate`, label: tx('admin.system.perimeter_fields.per_second', { l }), type: 'number', step: '0.01', required: true, value: s.rate_limits[k].per_second },
    ]),
    { name: 'challenge_mode', label: tx('admin.system.perimeter_fields.bot_challenge'), type: 'select', value: s.bot.challenge_mode, options: [['off', tx('admin.system.perimeter_fields.off')], ['suspicious', tx('admin.system.perimeter_fields.suspicious_html_requests')], ['all', tx('admin.system.perimeter_fields.every_html_request_attack_mode')]] },
    { name: 'pow_difficulty', label: tx('admin.system.perimeter_fields.proof_of_work_difficulty_bits'), type: 'number', required: true, value: s.bot.pow_difficulty, hint: tx('admin.system.perimeter_fields.each_extra_bit_doubles_the') },
    { name: 'ct_ttl', label: tx('admin.system.perimeter_fields.client_token_lifetime_s'), type: 'number', required: true, value: s.bot.client_token_ttl_seconds },
    { name: 'pass_ttl', label: tx('admin.system.perimeter_fields.challenge_pass_lifetime_s'), type: 'number', required: true, value: s.bot.challenge_pass_ttl_seconds },
    { name: 'html_per_minute', label: tx('admin.system.perimeter_fields.html_pages_per_ip_per'), type: 'number', required: true, value: s.bot.html_per_minute },
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
    toast(tx('admin.system.wire_perimeter.saved_taker_fee_challenge', { coefficient: r.settings.taker_fee.coefficient, challenge_mode: r.settings.bot.challenge_mode }));
    const c = document.querySelector('[data-testid=taker-fee-coefficient]'); if (c) c.textContent = String(r.settings.taker_fee.coefficient);
  });
}

// ---------------------------------------------------------------- Currency & defaults (CLONE_SPEC.md §30)
// Display currency, locale and time zone for every money string and date (pages, toasts, notifications, emails, CSV and
// PDF exports), plus the settings NEW accounts start with. Saving needs settings.write, a reason and step-up (the
// server asks; ui.js call() opens the step-up dialog) and is audited; open pages update live over WebSocket.
const ZONES = ['Africa/Lagos', 'UTC', 'Africa/Accra', 'Africa/Nairobi', 'Africa/Johannesburg', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
function currencyFields(cur) {
  const c = cur.display_currency; const a = cur.account_defaults; const o = cur.options;
  return [
    { name: 'code', label: T('currency.field.code'), type: 'select', value: c.code, options: o.codes.map((k) => [k, T(`currency.field.code.${k}`)]) },
    { name: 'locale', label: T('currency.field.locale'), type: 'select', value: c.locale, options: o.locales.map((k) => [k, `${T(`currency.locale.${k}`)} · ${k}`]) },
    { name: 'timezone', label: T('currency.field.timezone'), type: 'select', value: c.timezone, options: [...new Set([c.timezone, ...ZONES])] },
    { name: 'theme', label: T('currency.field.theme'), type: 'select', value: a.theme, options: o.themes.map((k) => [k, k[0].toUpperCase() + k.slice(1)]) },
    { name: 'display_mode', label: T('currency.field.display_mode'), type: 'select', value: a.display_mode, options: o.display_modes.map((k) => [k, T(`currency.field.display_mode.${k}`)]) },
    { name: 'order_review', label: T('currency.field.order_review'), type: 'checkbox', value: a.order_review },
    { name: 'flip_sell', label: T('currency.field.flip_sell'), type: 'checkbox', value: a.flip_sell },
    ...o.channels.map((ch) => ({ name: `ch_${ch}`, label: T('currency.field.channel', { channel: T(`currency.field.channel.${ch}`) }), type: 'checkbox', value: a.notification_channels[ch] })),
    { name: 'reason', label: T('currency.field.reason'), required: true, span: true },
  ];
}
function currencyCard(cur) {
  return `<div class="card adm-card" data-testid="currency-panel"><h3>${esc(T('currency.panel.title'))}</h3>
    <p class="faint">${esc(T('currency.panel.intro'))}</p>
    ${formHtml(currencyFields(cur), { submit: T('currency.panel.submit'), id: 'cur', testid: 'currency-form' })}
    <h3>${esc(T('currency.panel.preview'))}</h3><dl class="adm-dl" data-testid="currency-preview"></dl></div>`;
}
function wireCurrency(card, cur) {
  if (!card) return;
  const form = card.querySelector('form');
  const fields = currencyFields(cur);
  const sample = Date.parse('2026-11-04T23:30:00Z'); // 00:30 the next day in Lagos: shows the zone's day boundary
  const preview = () => {
    const d = { code: form.elements.code.value, locale: form.elements.locale.value, timezone: form.elements.timezone.value };
    const rows = withCurrency(d, () => [
      ['price', pxc(6400)], ['fine', pxc(6450)], ['balance', money(25)], ['payout', money(10)],
      ['perps', assetPrice(96250, 2)], ['funding', money(0.0123, { plus: true, exact: d.code === 'USD' ? 4 : 2 })],
      ['datetime', fmtDt(sample, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })], ['unit', priceUnit()],
    ]);
    card.querySelector('[data-testid=currency-preview]').innerHTML = rows.map(([k, v]) => `<dt>${esc(T(`currency.preview.${k}`))}</dt><dd data-preview="${esc(k)}">${esc(v)}</dd>`).join('');
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
    toast(T('currency.panel.saved', { code: r.descriptor.code, timezone: r.descriptor.timezone }));
    setCurrency(r.descriptor); // this page at once; every other open page gets the WebSocket push
  });
}
