// Audit log viewer and system settings (interest APY, feature switches, publish liquidity, fee / rate-limit view, health).
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
  const [{ settings: s }, h] = await Promise.all([get('/settings'), get('/health')]);
  const fields = [
    { name: 'interest_apy_pct', label: 'Interest APY (%)', type: 'number', step: '0.01', required: true, value: +(s.interest_apy * 100).toFixed(4), hint: 'Paid daily on cash + open-position cost basis; used by the next accrual.' },
    { name: 'social', label: 'Social features visible', type: 'checkbox', value: s.features.social },
    { name: 'perps', label: 'Perps visible', type: 'checkbox', value: s.features.perps },
    { name: 'combos', label: 'Combos visible', type: 'checkbox', value: s.features.combos },
    { name: 'pl_enabled', label: 'Seed liquidity when publishing markets', type: 'checkbox', value: s.publish_liquidity.enabled, span: true },
    { name: 'pl_spread', label: 'Seed spread (¢)', type: 'number', value: s.publish_liquidity.spread_cents },
    { name: 'pl_size', label: 'Seed size per level (contracts)', type: 'number', value: s.publish_liquidity.size_contracts },
    { name: 'pl_levels', label: 'Seed levels per side', type: 'number', value: s.publish_liquidity.levels },
  ];
  const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
  const up = (sec) => `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ${sec % 60}s`;
  el.innerHTML = section('Settings & health') + `<div class="adm-two"><div class="card adm-card"><h3>Settings</h3>${formHtml(fields, { submit: 'Save settings', id: 'set', testid: 'settings-form' })}</div>
    <div><div class="card adm-card" data-testid="health"><h3>Health ${h.ok ? badge('OK', 'ok') : badge('Problem', 'bad')}</h3><dl class="adm-dl">
      <dt>Database size</dt><dd data-testid="health-db">${mb(h.db.bytes)} <span class="faint">(+ ${mb(h.db.wal_bytes)} WAL)</span></dd><dt>Uptime</dt><dd data-testid="health-uptime">${up(h.uptime_seconds)}</dd>
      <dt>WebSocket clients</dt><dd data-testid="health-ws">${h.ws_clients ?? '—'}</dd><dt>Trading</dt><dd>${h.trading_active ? 'on' : 'paused'}</dd><dt>Node</dt><dd>${esc(h.node)} · ${h.memory_mb} MB RSS</dd>
      ${Object.entries(h.tables).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${Number(v).toLocaleString('en-US')}</dd>`).join('')}</dl></div>
    <div class="card adm-card"><h3>Taker fee</h3><p><b>${s.taker_fee.coefficient}</b> · <code>${esc(s.taker_fee.formula)}</code></p><p class="faint">${esc(s.taker_fee.note)}</p></div>
    <div class="card adm-card" data-testid="rate-limit"><h3>Rate limit</h3><p>${s.rate_limit.burst} burst · ${s.rate_limit.per_second}/s ${esc(s.rate_limit.scope)}</p><p class="faint">${esc(s.rate_limit.note)}</p><p class="faint">Rolling market window: ${s.rolling_window_seconds} s</p></div></div></div>`;
  wireForm(el.querySelector('form'), fields, async (v) => {
    const r = await put('/settings', { interest_apy: Number(v.interest_apy_pct) / 100, features: { social: v.social, perps: v.perps, combos: v.combos },
      publish_liquidity: { enabled: v.pl_enabled, spread_cents: v.pl_spread, size_contracts: v.pl_size, levels: v.pl_levels } }).catch((ex) => {
      if (ex.fields) ex.fields = Object.fromEntries(Object.entries(ex.fields).map(([k, m]) => [{ interest_apy: 'interest_apy_pct', 'publish_liquidity.spread_cents': 'pl_spread', 'publish_liquidity.size_contracts': 'pl_size', 'publish_liquidity.levels': 'pl_levels' }[k] || k, m]));
      throw ex;
    });
    toast(`Settings saved · APY ${(r.settings.interest_apy * 100).toFixed(2)}%`);
    window.dispatchEvent(new CustomEvent('parlance:site-config'));
  });
}
