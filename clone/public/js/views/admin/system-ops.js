// Admin › System and Admin › Launch readiness (PLAN Phase 9A, CLONE_SPEC.md §39).
//   system  health and schema version; the operating switches (maintenance, trading halt, read-only, traces, backups,
//           alerts) with the two-person approvals; backups and WAL shipping; restore drills; keys and rotation; the audit
//           anchor; verifiers; alerts with their contacts (add, test, confirm by code, remove); object storage.
//   launch  automatic checks (green / red, refreshed live), owner-ticked items with a note and date, scan and load-test
//           results, the real-money waitlist target next to its count.
// Both pages refresh every few seconds while open; a slower answer never overwrites a newer one (sequence guard).
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.sysops-strings.js';
import { esc, get, put, post, call, toast, dialog, formHtml, wireForm, confirmAction, section, badge, fmtTime } from './ui.js';

const ok = (b) => badge(b ? tx('admin.sysops.ok') : tx('admin.sysops.failed'), b ? 'ok' : 'bad');
const ago = (sec) => (sec == null ? '—' : sec < 90 ? `${Math.round(sec)} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : sec < 172800 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86400)} d`);
const size = (n) => (n == null ? '—' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
const where = (d) => (!d ? '—' : d.driver === 's3' ? `S3 ${d.endpoint} / ${d.bucket}${d.prefix ? ` / ${d.prefix}` : ''}` : `${d.driver} ${d.dir}`);

export async function render(ctx) {
  if (ctx.section === 'launch') return renderLaunch(ctx);
  return renderSystem(ctx);
}

// A page that refetches every `ms` while its element is in the document; only the newest answer is drawn.
function live(el, load, draw, ms = 4000) {
  let seq = 0; let drawn = 0; let timer = null;
  const tick = async () => {
    const mine = ++seq;
    try { const data = await load(); if (mine > drawn && el.isConnected) { drawn = mine; draw(data); } } catch (e) { if (el.isConnected && mine > drawn) toast(e.message, 'error'); }
    if (el.isConnected) timer = setTimeout(tick, ms);
  };
  const now = () => { clearTimeout(timer); return tick(); };
  return { start: tick, now };
}

// ---------------------------------------------------------------- Admin › System
async function renderSystem({ el }) {
  let data = null;
  const draw = (d) => {
    data = d;
    const r = d.readiness;
    const health = `<section class="card panel" data-testid="sys-health" data-ready="${r.ok ? '1' : '0'}"><h2>${te('admin.sysops.ready.title')} ${r.ok ? badge(tx('admin.sysops.ready.ready'), 'ok') : badge(tx('admin.sysops.ready.not_ready'), 'bad')}</h2>
      <ul class="adm-list">${r.checks.map((c) => `<li data-testid="sys-ready-check" data-name="${esc(c.name)}" data-ok="${c.ok ? '1' : '0'}">${ok(c.ok)} <b>${esc(c.name)}</b> <span class="faint">${esc(c.detail || '')}</span></li>`).join('')}</ul>
      <p class="faint" data-testid="sys-migrations" data-version="${esc(d.migrations.version)}">${te('admin.sysops.ready.migrations', { version: esc(d.migrations.version), latest: esc(d.migrations.latest) })}</p>
      <p class="faint">${te('admin.sysops.ready.origins', { public: esc(d.public_origin || '—'), admin: esc(d.admin_origin || '—') })}</p>
      <p class="faint" data-testid="sys-metrics">${d.metrics.port ? te('admin.sysops.ready.metrics', { where: esc(`${d.metrics.host}:${d.metrics.port}`) }) : te('admin.sysops.ready.metrics_off')}</p></section>`;
    const sw = `<section class="card panel" data-testid="sys-switches"><h2>${te('admin.sysops.switches.title')}</h2><p class="muted">${te('admin.sysops.switches.intro')}</p>
      <div class="owner-list">${d.switches.map((s) => `<div class="owner-row" data-testid="sys-switch" data-key="${esc(s.key)}" data-on="${s.on ? '1' : '0'}"><div class="owner-main"><b>${esc(tx(`admin.sysops.switches.name.${s.key}`))}</b> <code class="faint">${esc(s.key)}</code><p class="owner-help">${esc(s.help)}</p>
        ${s.starts_time || s.ends_time ? `<div class="faint" data-testid="sys-switch-window">${te('admin.sysops.switches.window', { start: esc(fmtTime(s.starts_time)), end: esc(fmtTime(s.ends_time)) })}</div>` : ''}</div>
        <div class="owner-side">${s.on ? badge(tx('admin.sysops.on'), ['ops.maintenance', 'ops.trading_halt', 'ops.read_only'].includes(s.key) ? 'warn' : 'ok') : badge(tx('admin.sysops.off'), '')}
        <button class="btn btn-sm" data-switch="${esc(s.key)}" data-to="${s.enabled ? '0' : '1'}" data-testid="sys-switch-toggle">${s.enabled ? te('admin.sysops.switches.turn_off') : te('admin.sysops.switches.turn_on')}</button></div></div>`).join('')}</div>
      ${d.approvals.length ? `<h3>${te('admin.sysops.approvals.title')}</h3><ul class="adm-list">${d.approvals.map((a) => `<li data-testid="sys-approval" data-id="${esc(a.id)}">${te('admin.sysops.approvals.row', { kind: esc(tx(`admin.sysops.approvals.kind.${a.kind}`)), who: esc(a.requested_by), time: esc(fmtTime(a.requested_time)), reason: esc(a.reason) })}
        <button class="btn btn-sm btn-primary" data-approve="${esc(a.id)}" data-testid="sys-approve">${te('admin.sysops.approvals.approve')}</button> <button class="btn btn-sm" data-reject="${esc(a.id)}" data-testid="sys-reject">${te('admin.sysops.approvals.reject')}</button></li>`).join('')}</ul>` : ''}</section>`;
    const b = d.backups;
    const backupsHtml = `<section class="card panel" data-testid="sys-backups" data-has-backup="${b.last_backup ? '1' : '0'}"><h2>${te('admin.sysops.backups.title')}</h2>
      <p>${te('admin.sysops.backups.storage', { where: esc(where(b.storage)) })} · ${te('admin.sysops.backups.key', { id: esc(b.key.id), source: esc(b.key.source) })}</p>
      <p data-testid="sys-backup-last" data-age="${b.last_backup ? esc(b.last_backup.age_sec) : ''}">${b.last_backup ? te('admin.sysops.backups.last', { kind: esc(b.last_backup.kind), age: esc(ago(b.last_backup.age_sec)), size: esc(size(b.last_backup.bytes)) }) : te('admin.sysops.none')}</p>
      <p class="faint">${b.wal_shipping ? (b.last_wal_segment ? te('admin.sysops.backups.wal', { age: esc(ago(b.last_wal_segment.age_sec)), gen: esc(b.last_wal_segment.generation) }) : te('admin.sysops.none')) : te('admin.sysops.backups.wal_off')}</p>
      ${b.last_failure ? `<p class="form-error">${te('admin.sysops.backups.failure', { time: esc(fmtTime(b.last_failure.time)), error: esc(b.last_failure.error) })}</p>` : ''}
      <button class="btn btn-sm btn-primary" data-act="backup" data-testid="sys-backup-now">${te('admin.sysops.backups.now')}</button>
      <div class="table-wrap"><table class="table"><thead><tr><th>${te('admin.sysops.backups.col.time')}</th><th>${te('admin.sysops.backups.col.kind')}</th><th>${te('admin.sysops.backups.col.status')}</th><th>${te('admin.sysops.backups.col.size')}</th><th>${te('admin.sysops.backups.col.checksum')}</th></tr></thead>
      <tbody>${b.recent.map((x) => `<tr data-testid="sys-backup-row" data-kind="${esc(x.kind)}" data-status="${esc(x.status)}"><td>${esc(fmtTime(x.time))}</td><td>${esc(x.kind)}</td><td>${x.status === 'ok' ? badge(x.deleted ? 'deleted' : 'ok', x.deleted ? '' : 'ok') : badge(x.status, x.status === 'failed' ? 'bad' : 'warn')}</td><td class="num">${esc(size(x.bytes))}</td><td><code class="faint">${esc((x.sha256 || '').slice(0, 16))}</code></td></tr>`).join('')}</tbody></table></div></section>`;
    const dr = d.restore_drill;
    const drillHtml = `<section class="card panel" data-testid="sys-drill" data-has-drill="${dr.last_ok ? '1' : '0'}"><h2>${te('admin.sysops.drill.title')}</h2>
      <p data-testid="sys-drill-last">${dr.last_ok ? te('admin.sysops.drill.last', { age: esc(ago(dr.last_ok.age_sec)), segments: esc(dr.last_ok.segments) }) : te('admin.sysops.drill.never')}</p>
      ${dr.last_ok && dr.last_ok.checks ? `<ul class="adm-list">${Object.entries(dr.last_ok.checks).map(([k, c]) => `<li data-testid="sys-drill-check" data-name="${esc(k)}">${ok(c.ok)} ${esc(k)}</li>`).join('')}</ul>` : ''}
      <button class="btn btn-sm" data-act="drill" data-testid="sys-drill-run" ${dr.running ? 'disabled' : ''}>${te('admin.sysops.drill.run')}</button></section>`;
    const k = d.keys;
    const keysHtml = `<section class="card panel" data-testid="sys-keys" data-active="${esc(k.active)}" data-pending="${esc(k.pending)}"><h2>${te('admin.sysops.keys.title')}</h2>
      <p>${te('admin.sysops.keys.active', { kid: esc(k.active), hmac: esc(k.hmac), source: esc(k.source) })}</p>${k.pending ? `<p class="form-error">${te('admin.sysops.keys.pending', { count: esc(k.pending) })}</p>` : ''}
      <div class="table-wrap"><table class="table"><thead><tr><th>${te('admin.sysops.keys.col.kid')}</th><th>${te('admin.sysops.keys.col.status')}</th><th>${te('admin.sysops.keys.col.age')}</th><th>${te('admin.sysops.keys.col.values')}</th><th>${te('admin.sysops.keys.col.fingerprint')}</th></tr></thead>
      <tbody>${k.keys.map((x) => `<tr data-testid="sys-key-row" data-kid="${esc(x.kid)}" data-status="${esc(x.status)}"><td>${esc(x.kid)}</td><td>${esc(x.status)}</td><td data-testid="sys-key-age">${te('admin.sysops.keys.age_days', { days: esc(x.age_days) })}</td><td class="num">${esc(x.values)}</td><td><code class="faint">${esc(x.fingerprint)}</code></td></tr>`).join('')}</tbody></table></div>
      ${k.last_rotation ? `<p class="faint" data-testid="sys-key-rotation" data-status="${esc(k.last_rotation.status)}">${te('admin.sysops.keys.last', { status: esc(k.last_rotation.status), to: esc(k.last_rotation.to), time: esc(fmtTime(k.last_rotation.started_time)) })}</p>` : ''}
      ${k.rotatable ? `<button class="btn btn-sm" data-act="rotate" data-testid="sys-key-rotate">${te('admin.sysops.keys.rotate')}</button>` : `<p class="faint">${te('admin.sysops.keys.manual')}</p>`}</section>`;
    const an = d.anchor;
    const anchorHtml = `<section class="card panel" data-testid="sys-anchor" data-ok="${an.ok ? '1' : '0'}"><h2>${te('admin.sysops.anchor.title')}</h2>
      <p data-testid="sys-anchor-last">${an.anchor ? te('admin.sysops.anchor.last', { seq: esc(an.anchor.seq), chain: esc(an.anchor.chain_seq), age: esc(ago(an.anchor.age_sec)), source: esc(an.anchor.source), detail: esc(an.detail) }) : te('admin.sysops.anchor.none')}</p>
      <p class="faint">${te('admin.sysops.anchor.key', { key: `<code>${esc(an.public_key)}</code>` })}</p>
      <button class="btn btn-sm" data-act="anchor" data-testid="sys-anchor-now">${te('admin.sysops.anchor.now')}</button></section>`;
    const v = d.verifiers;
    const verifyHtml = `<section class="card panel" data-testid="sys-verifiers" data-ok="${v.ok ? '1' : '0'}"><h2>${te('admin.sysops.verify.title')}</h2>
      <ul class="adm-list">${Object.entries(v.checks).map(([n, c]) => `<li data-testid="sys-verifier" data-name="${esc(n)}" data-ok="${c.ok ? '1' : '0'}">${te('admin.sysops.verify.row', { name: esc(tx(`admin.sysops.verify.name.${n}`)), status: ok(c.ok) })}</li>`).join('')}</ul>
      <button class="btn btn-sm" data-act="verify" data-testid="sys-verify-now">${te('admin.sysops.verify.now')}</button></section>`;
    const al = d.alerts;
    const alertsHtml = `<section class="card panel" data-testid="sys-alerts"><h2>${te('admin.sysops.alerts.title')}</h2>
      <h3>${te('admin.sysops.alerts.firing')}</h3>${al.firing.length ? `<ul class="adm-list">${al.firing.map((a) => `<li data-testid="sys-alert-firing" data-rule="${esc(a.rule)}">${badge(a.severity, a.severity === 'critical' ? 'bad' : 'warn')} ${esc(a.rule)} <span class="faint">${esc(fmtTime(a.started_time))}</span></li>`).join('')}</ul>` : `<p class="faint">${te('admin.sysops.alerts.none_firing')}</p>`}
      <h3>${te('admin.sysops.alerts.contacts')}</h3>${al.contacts.length ? `<ul class="adm-list">${al.contacts.map((c) => `<li data-testid="sys-contact" data-id="${esc(c.id)}" data-confirmed="${c.confirmed ? '1' : '0'}">${badge(tx(`admin.sysops.alerts.kind.${c.kind}`), '')} <b>${esc(c.label)}</b> <code class="faint">${esc(c.target)}</code> ${c.confirmed ? badge(tx('admin.sysops.alerts.confirmed'), 'ok') : badge(tx('admin.sysops.alerts.unconfirmed'), 'warn')}
        ${c.last_result ? `<span class="faint" data-testid="sys-contact-result">${esc(c.last_result)}</span>` : ''}
        <button class="btn btn-sm" data-test="${esc(c.id)}" data-testid="sys-contact-test">${te('admin.sysops.alerts.test')}</button>
        ${c.code_pending && !c.confirmed ? `<form class="d-inline-flex gap-8" data-confirm-form="${esc(c.id)}"><label class="field"><span class="sr-only">${te('admin.sysops.alerts.code')}</span><input name="code" inputmode="numeric" maxlength="6" placeholder="${esc(tx('admin.sysops.alerts.code'))}" data-testid="sys-contact-code"></label><button class="btn btn-sm btn-primary" data-testid="sys-contact-confirm">${te('admin.sysops.alerts.confirm')}</button></form>` : ''}
        <button class="btn btn-sm" data-remove="${esc(c.id)}" data-testid="sys-contact-remove">${te('admin.sysops.alerts.remove')}</button></li>`).join('')}</ul>` : `<p class="faint">${te('admin.sysops.alerts.no_contacts')}</p>`}
      <button class="btn btn-sm btn-primary" data-act="contact" data-testid="sys-contact-add">${te('admin.sysops.alerts.add')}</button>
      <h3>${te('admin.sysops.alerts.history')}</h3><ul class="adm-list faint">${al.history.slice(0, 10).map((h) => `<li data-testid="sys-alert-history" data-rule="${esc(h.rule)}">${te('admin.sysops.alerts.history_row', { rule: esc(h.rule), status: esc(h.status), time: esc(fmtTime(h.started_time)) })}</li>`).join('')}</ul></section>`;
    const st = d.storage;
    const storageHtml = `<section class="card panel" data-testid="sys-storage"><h2>${te('admin.sysops.storage.title')}</h2><p>${te('admin.sysops.storage.media', { where: esc(where(st.media)) })}</p>
      <p class="faint" data-testid="sys-blob-move" data-remaining="${esc(st.blob_move.remaining)}">${te('admin.sysops.storage.moved', { moved: esc(st.blob_move.moved), remaining: esc(st.blob_move.remaining) })}</p></section>`;
    el.innerHTML = section(tx('admin.sysops.title'), te('admin.sysops.intro'), `<button class="btn btn-sm" data-act="refresh">${te('admin.sysops.refresh')}</button>`) + `<div data-testid="sys-page">${health}${sw}${backupsHtml}${drillHtml}${keysHtml}${anchorHtml}${verifyHtml}${alertsHtml}${storageHtml}</div>`;
  };
  const page = live(el, () => get('/system'), draw);
  await page.start();
  const busy = async (fn) => { try { await fn(); await page.now(); } catch (ex) { toast(ex.message, 'error'); } };
  el.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-confirm-form]');
    if (!f) return;
    e.preventDefault();
    busy(async () => { await post(`/system/alerts/contacts/${encodeURIComponent(f.dataset.confirmForm)}/confirm`, { code: f.code.value }); toast(tx('admin.sysops.alerts.confirmed')); });
  });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t || t.type === 'submit') return;
    const act = t.dataset.act;
    if (act === 'refresh') return busy(async () => {});
    if (act === 'backup') { const c = await confirmAction({ title: tx('admin.sysops.backups.now'), reason: true, confirm: tx('admin.sysops.backups.now') }); if (c) busy(async () => { await post('/system/backups', { reason: c.reason }); toast(tx('admin.sysops.backups.done')); }); return; }
    if (act === 'drill') { const c = await confirmAction({ title: tx('admin.sysops.drill.run'), reason: true, confirm: tx('admin.sysops.drill.run') }); if (c) busy(async () => { const r = await post('/system/restore_drill', { reason: c.reason }); toast(tx('admin.sysops.drill.done', { status: r.drill.status })); }); return; }
    if (act === 'anchor') { const c = await confirmAction({ title: tx('admin.sysops.anchor.now'), reason: true, confirm: tx('admin.sysops.anchor.now') }); if (c) busy(async () => { await post('/system/anchor', { reason: c.reason }); toast(tx('admin.sysops.anchor.done')); }); return; }
    if (act === 'verify') return busy(async () => { await post('/system/verify', {}); });
    if (act === 'rotate') { const c = await confirmAction({ title: tx('admin.sysops.keys.rotate'), body: te('admin.sysops.keys.rotate_body'), reason: true, danger: true, confirm: tx('admin.sysops.keys.rotate') }); if (c) busy(async () => { const r = await post('/system/keys/rotate', { reason: c.reason }); toast(tx('admin.sysops.keys.rotated', { kid: r.kid })); }); return; }
    if (act === 'contact') return addContact(() => page.now());
    if (t.dataset.switch) return toggleSwitch(t.dataset.switch, t.dataset.to === '1', data, () => page.now());
    if (t.dataset.approve) { const c = await confirmAction({ title: tx('admin.sysops.approvals.approve'), confirm: tx('admin.sysops.approvals.approve') }); if (c) busy(async () => { await post(`/ops/approvals/${encodeURIComponent(t.dataset.approve)}/approve`, {}); toast(tx('admin.sysops.approvals.approved')); }); return; }
    if (t.dataset.reject) { const c = await confirmAction({ title: tx('admin.sysops.approvals.reject'), reason: true, confirm: tx('admin.sysops.approvals.reject') }); if (c) busy(async () => { await post(`/ops/approvals/${encodeURIComponent(t.dataset.reject)}/reject`, { note: c.reason }); toast(tx('admin.sysops.approvals.rejected')); }); return; }
    if (t.dataset.test) return busy(async () => { const r = await post(`/system/alerts/contacts/${encodeURIComponent(t.dataset.test)}/test`, {}); toast(r.delivered ? tx('admin.sysops.alerts.tested', { detail: r.detail }) : tx('admin.sysops.alerts.test_failed', { detail: r.detail }), r.delivered ? '' : 'error'); });
    if (t.dataset.remove) { const c = await confirmAction({ title: tx('admin.sysops.alerts.remove'), reason: true, danger: true, confirm: tx('admin.sysops.alerts.remove') }); if (c) busy(async () => { await call('DELETE', `/system/alerts/contacts/${encodeURIComponent(t.dataset.remove)}`, { reason: c.reason }); toast(tx('admin.sysops.alerts.removed')); }); }
  });
}

// Switch on / off with a reason (+ an optional schedule for maintenance). Ending a halt answers 202: a second admin approves.
function toggleSwitch(key, to, data, done) {
  const fields = [
    ...(to && key === 'ops.maintenance' ? [{ name: 'starts_at', label: tx('admin.sysops.switches.starts'), type: 'datetime' }, { name: 'ends_at', label: tx('admin.sysops.switches.ends'), type: 'datetime' }] : []),
    { name: 'reason', label: tx('admin.sysops.reason'), required: true, span: true },
  ];
  const d = dialog(`<h3>${esc(tx(`admin.sysops.switches.name.${key}`))} — ${to ? te('admin.sysops.switches.turn_on') : te('admin.sysops.switches.turn_off')}</h3>${formHtml(fields, { submit: to ? tx('admin.sysops.switches.turn_on') : tx('admin.sysops.switches.turn_off'), id: 'sw', testid: 'sys-switch-form' })}`, { testid: 'sys-switch-dialog' });
  wireForm(d.querySelector('form'), fields, async (v) => {
    const body = { enabled: to, reason: v.reason };
    if (to && key === 'ops.maintenance') { body.starts_at = v.starts_at || null; body.ends_at = v.ends_at || null; }
    if (!to) { body.starts_at = null; body.ends_at = null; }
    const r = await put(`/flags/${encodeURIComponent(key)}`, body);
    toast(r.status === 'pending_approval' ? tx('admin.sysops.switches.pending') : tx('admin.sysops.switches.saved'));
    d.close();
    await done();
  });
  void data;
}

function addContact(done) {
  const fields = [
    { name: 'kind', label: tx('admin.sysops.alerts.kind'), type: 'select', value: 'email', options: [['email', tx('admin.sysops.alerts.kind.email')], ['webhook', tx('admin.sysops.alerts.kind.webhook')], ['push', tx('admin.sysops.alerts.kind.push')]] },
    { name: 'label', label: tx('admin.sysops.alerts.label'), required: true },
    { name: 'target', label: tx('admin.sysops.alerts.target'), required: true, span: true },
    { name: 'reason', label: tx('admin.sysops.reason'), required: true, span: true },
  ];
  const d = dialog(`<h3>${te('admin.sysops.alerts.add')}</h3>${formHtml(fields, { submit: tx('admin.sysops.alerts.add'), id: 'contact', testid: 'sys-contact-form' })}`, { testid: 'sys-contact-dialog' });
  wireForm(d.querySelector('form'), fields, async (v) => {
    await post('/system/alerts/contacts', v);
    toast(tx('admin.sysops.alerts.added'));
    d.close();
    await done();
  });
}

// ---------------------------------------------------------------- Admin › Launch readiness
async function renderLaunch({ el }) {
  const draw = (r) => {
    const fmt = (x) => Number(x || 0).toLocaleString('en-NG');
    el.innerHTML = section(tx('admin.sysops.launch.title'), te('admin.sysops.launch.intro'), '<a class="btn btn-sm" href="/admin/play_mode" data-link>' + te('admin.sysops.launch.to_play') + '</a>') +
      `<div data-testid="launch-page" data-ready="${r.ready ? '1' : '0'}" data-blocking="${esc(r.blocking.length)}">
      <section class="card panel" data-testid="launch-summary"><h2>${r.ready ? `${badge(tx('admin.sysops.launch.ready'), 'ok')}` : badge(tx('admin.sysops.launch.not_ready', { count: r.blocking.length }), 'bad')}</h2>
        <p class="faint" data-testid="launch-gate" data-enforced="${r.gate_enforced ? '1' : '0'}">${r.gate_enforced ? te('admin.sysops.launch.gate_on') : te('admin.sysops.launch.gate_off')}</p>
        <p data-testid="launch-waitlist" data-count="${esc(r.waitlist ? r.waitlist.count : '')}" data-target="${esc(r.waitlist && r.waitlist.target != null ? r.waitlist.target : '')}">${r.waitlist ? (r.waitlist.target ? te('admin.sysops.launch.waitlist', { count: esc(fmt(r.waitlist.count)), target: esc(fmt(r.waitlist.target)) }) : te('admin.sysops.launch.waitlist_none', { count: esc(fmt(r.waitlist.count)) })) : ''}</p></section>
      <section class="card panel"><h2>${te('admin.sysops.launch.checks')}</h2><ul class="adm-list">${r.checks.map((c) => `<li data-testid="launch-check" data-key="${esc(c.key)}" data-ok="${c.ok ? '1' : '0'}">${badge(c.ok ? '✓' : '✗', c.ok ? 'ok' : 'bad')} <b>${esc(c.label)}</b> <span class="faint" data-testid="launch-check-detail">${esc(c.detail || '')}</span><div class="owner-help">${esc(c.help)}</div></li>`).join('')}</ul>
        <p class="faint">${te('admin.sysops.launch.targets', { orders: esc(r.load_targets.orders_per_sec), order: esc(r.load_targets.order_p99_ms), ws: esc(r.load_targets.ws_fanout_p99_ms), page: esc(r.load_targets.page_p95_ms) })}</p>
        <button class="btn btn-sm" data-act="evidence" data-testid="launch-evidence">${te('admin.sysops.launch.evidence')}</button></section>
      <section class="card panel"><h2>${te('admin.sysops.launch.items')}</h2><ul class="adm-list">${r.items.map((i) => `<li data-testid="launch-item" data-key="${esc(i.key)}" data-done="${i.done ? '1' : '0'}">${badge(i.done ? tx('admin.sysops.launch.item_done', { date: i.done_date || '' }) : tx('admin.sysops.launch.item_open'), i.done ? 'ok' : 'warn')} <b>${esc(i.label)}</b>
        ${i.note ? `<span class="faint">${esc(i.note)}</span>` : ''} <button class="btn btn-sm" data-item="${esc(i.key)}" data-testid="launch-item-edit">${te('admin.sysops.launch.edit')}</button></li>`).join('')}</ul></section></div>`;
    el.__launch = r;
  };
  const page = live(el, () => get('/launch_readiness'), draw);
  await page.start();
  el.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.item) {
      const it = el.__launch.items.find((i) => i.key === t.dataset.item);
      const fields = [
        { name: 'done', label: tx('admin.sysops.launch.done'), type: 'checkbox', value: it.done },
        { name: 'done_date', label: tx('admin.sysops.launch.done_date'), type: 'date', value: it.done_date || new Date().toISOString().slice(0, 10) },
        { name: 'note', label: tx('admin.sysops.launch.note'), value: it.note, span: true },
        { name: 'reason', label: tx('admin.sysops.reason'), required: true, span: true },
      ];
      const d = dialog(`<h3>${esc(it.label)}</h3>${formHtml(fields, { submit: tx('admin.sysops.launch.edit'), id: 'item', testid: 'launch-item-form' })}`, { testid: 'launch-item-dialog' });
      wireForm(d.querySelector('form'), fields, async (v) => { await put(`/launch_readiness/items/${encodeURIComponent(it.key)}`, { done: !!v.done, done_date: v.done ? v.done_date : null, note: v.note, reason: v.reason }); toast(tx('admin.sysops.launch.saved')); d.close(); await page.now(); });
      return;
    }
    if (t.dataset.act === 'evidence') {
      const fields = [
        { name: 'kind', label: tx('admin.sysops.launch.evidence_kind'), type: 'select', value: 'dependency_scan', options: ['dependency_scan', 'image_scan', 'load_test'].map((k) => [k, tx(`admin.sysops.launch.evidence_kind.${k}`)]) },
        { name: 'report', label: tx('admin.sysops.launch.evidence_json'), type: 'textarea', rows: 6, required: true, span: true },
        { name: 'reason', label: tx('admin.sysops.reason'), required: true, span: true },
      ];
      const d = dialog(`<h3>${te('admin.sysops.launch.evidence')}</h3>${formHtml(fields, { submit: tx('admin.sysops.launch.evidence'), id: 'evidence', testid: 'launch-evidence-form' })}`, { testid: 'launch-evidence-dialog', wide: true });
      const w = wireForm(d.querySelector('form'), fields, async (v) => {
        let report;
        try { report = JSON.parse(v.report); } catch { w.showErrors({ report: tx('admin.sysops.launch.evidence_bad_json') }); return; }
        await post('/launch_readiness/evidence', { kind: v.kind, report, reason: v.reason });
        toast(tx('admin.sysops.launch.evidence_saved'));
        d.close();
        await page.now();
      });
    }
  });
}
