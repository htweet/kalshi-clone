// Account › API keys (CLONE_SPEC.md §35.2): create a key (step-up; the identity lock answers 403 until verification is
// approved), with a label, scopes, an optional IP allowlist and expiry, either generated here (the private key is shown
// once, with copy and download) or from the user's own RSA / Ed25519 public key; rotate, revoke; the usage dashboard
// (requests, 429s and errors per key per day, last used time and address).
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/api-keys-strings.js';
import { request } from '../api.js';
import { session } from '../store.js';
import { esc, toast, fmtDateTime } from '../lib.js';

const base = (p = '') => `/v1/users/${encodeURIComponent(session.uid)}/api_keys${p}`;
const when = (iso) => (iso ? fmtDateTime(iso) : t('api-keys.common.never'));

function statusLabel(k) {
  if (k.status === 'active' && k.rotated_to && k.expires_time) return t('api-keys.status.rotating', { time: fmtDateTime(k.expires_time) });
  return t(`api-keys.status.${k.status}`);
}

function keyRow(k) {
  const active = k.status === 'active';
  return `<tr data-testid="api-key-row" data-key="${esc(k.api_key_id)}" data-status="${esc(k.status)}">
    <td><strong>${esc(k.label)}</strong><div class="faint">${esc(t(`api-keys.origin.${k.origin}`))}</div></td>
    <td><code class="dev-mono" data-f="id">${esc(k.api_key_id)}</code><div class="faint dev-mono" data-f="fingerprint" title="${esc(k.fingerprint)}">${esc(k.fingerprint.slice(0, 26))}…</div></td>
    <td data-f="scopes">${k.scopes.map((x) => `<span class="dev-chip">${esc(x)}</span>`).join(' ')}<div class="faint" data-f="ips">${k.ip_allowlist.length ? esc(k.ip_allowlist.join(', ')) : te('api-keys.ips.any')}</div></td>
    <td data-f="tier">${esc(k.tier)}</td>
    <td data-f="status">${esc(statusLabel(k))}</td>
    <td data-f="last-used">${k.last_used_time ? esc(t('api-keys.last_used.from', { time: fmtDateTime(k.last_used_time), ip: k.last_used_ip || '' })) : te('api-keys.common.never')}</td>
    <td data-f="expires">${k.expires_time ? esc(fmtDateTime(k.expires_time)) : te('api-keys.common.no_expiry')}</td>
    <td class="dev-actions">${active ? `<button class="btn btn-sm" data-rotate="${esc(k.api_key_id)}" data-testid="key-rotate">${te('api-keys.action.rotate')}</button> <button class="btn btn-sm btn-danger" data-revoke="${esc(k.api_key_id)}" data-testid="key-revoke">${te('api-keys.action.revoke')}</button>` : ''}</td></tr>`;
}

function usageHtml(keys, usage) {
  if (!usage.length) return `<p class="muted" data-testid="api-usage-empty">${te('api-keys.usage.empty')}</p>`;
  const label = (id) => keys.find((k) => k.api_key_id === id)?.label || id;
  return `<div class="dev-scroll"><table class="table dev-table" data-testid="api-usage"><thead><tr><th>${te('api-keys.usage.day')}</th><th>${te('api-keys.usage.key')}</th><th class="num">${te('api-keys.usage.requests')}</th><th class="num">${te('api-keys.usage.throttled')}</th><th class="num">${te('api-keys.usage.errors')}</th><th class="num">${te('api-keys.usage.ws')}</th><th class="num">${te('api-keys.usage.fix')}</th></tr></thead>
    <tbody>${usage.map((u) => `<tr data-testid="usage-row" data-key="${esc(u.api_key_id)}" data-day="${esc(u.day)}"><td>${esc(u.day)}</td><td>${esc(label(u.api_key_id))}</td><td class="num" data-f="requests">${esc(u.requests)}</td><td class="num" data-f="throttled">${esc(u.throttled)}</td><td class="num" data-f="errors">${esc(u.errors)}</td><td class="num">${esc(u.ws_connections)}</td><td class="num">${esc(u.fix_messages)}</td></tr>`).join('')}</tbody></table></div>`;
}

// The private key, shown once: copy, download, dismiss. It is never stored by this page or the server.
function showOnce(host, keyVo, pem) {
  host.innerHTML = `<section class="card dev-once" role="alert" data-testid="private-key-once"><h3>${te('api-keys.once.title')}</h3>
    <p>${te('api-keys.once.body', { label: esc(keyVo.label) })}</p><p class="dev-mono" data-testid="private-key-id">${te('api-keys.once.key_id', { id: esc(keyVo.api_key_id) })}</p>
    <textarea class="dev-pem" readonly rows="8" data-testid="private-key-pem" aria-label="${te('api-keys.once.title')}"></textarea>
    <div class="dev-row"><button class="btn" type="button" data-copy data-testid="private-key-copy">${te('api-keys.once.copy')}</button><a class="btn" data-download data-testid="private-key-download">${te('api-keys.once.download')}</a><button class="btn btn-primary" type="button" data-done data-testid="private-key-done">${te('api-keys.once.done')}</button></div></section>`;
  const ta = host.querySelector('textarea');
  ta.value = pem;
  const url = URL.createObjectURL(new Blob([pem], { type: 'application/x-pem-file' }));
  const a = host.querySelector('[data-download]');
  a.href = url; a.download = `${keyVo.api_key_id}.pem`;
  host.querySelector('[data-copy]').onclick = async () => { try { await navigator.clipboard.writeText(pem); toast(t('api-keys.once.copied')); } catch { ta.select(); } };
  host.querySelector('[data-done]').onclick = () => { ta.value = ''; URL.revokeObjectURL(url); host.innerHTML = ''; };
}

export async function render(panel) {
  let data;
  try { data = await request('GET', base()); } catch (e) {
    if (e.code === 'permission_denied') {
      panel.innerHTML = `<div class="card panel" data-testid="api-keys-locked"><h2>${te('api-keys.locked.title')}</h2><p class="muted">${te('api-keys.locked.body')}</p><a class="btn btn-primary" href="/sign-up/identity" data-link>${te('api-keys.locked.cta')}</a></div>`;
      return;
    }
    if (e.code === 'feature_disabled') { panel.innerHTML = `<div class="card panel" data-testid="api-keys-unavailable"><p>${te('api-keys.unavailable')}</p></div>`; return; }
    throw e;
  }
  const usage = await request('GET', base('/usage?days=14')).catch(() => ({ usage: [] }));
  const keys = data.api_keys;
  const tierRows = Object.values(data.tiers).map((x) => `<li>${esc(t('api-keys.tiers.row', { label: x.label, read: x.read_per_sec, write: x.write_per_sec, ws: x.ws_connections, fix: x.fix_sessions }))}</li>`).join('');
  panel.innerHTML = `<div class="dev-keys" data-testid="api-keys">
    <div class="card panel"><h2>${te('api-keys.page.title')}</h2><p class="muted">${te('api-keys.page.intro')} <a href="/docs/quick-start" data-link>${te('api-keys.page.docs')}</a></p></div>
    <div data-once></div>
    <form class="card panel dev-form" data-testid="api-key-form" novalidate><h3>${te('api-keys.form.title')}</h3>
      <label class="field">${te('api-keys.form.label')}<input name="label" maxlength="60" required data-testid="key-label"><small class="faint">${te('api-keys.form.label_hint')}</small></label>
      <fieldset class="dev-fieldset"><legend>${te('api-keys.form.scopes')}</legend>
        <label class="dev-check"><input type="checkbox" name="scope_read" checked disabled> ${te('api-keys.form.scope_read')}</label>
        <label class="dev-check"><input type="checkbox" name="scope_trade" data-testid="scope-trade"> ${te('api-keys.form.scope_trade')}</label>
        <label class="dev-check"><input type="checkbox" name="scope_perps" data-testid="scope-perps"> ${te('api-keys.form.scope_perps')}</label></fieldset>
      <fieldset class="dev-fieldset"><legend>${te('api-keys.form.mode')}</legend>
        <label class="dev-check"><input type="radio" name="mode" value="generate" checked data-testid="mode-generate"> ${te('api-keys.form.mode_generate')}</label>
        <label class="dev-check"><input type="radio" name="mode" value="public_key" data-testid="mode-public"> ${te('api-keys.form.mode_public')}</label>
        <label class="field" data-pem hidden>${te('api-keys.form.public_key')}<textarea name="public_key" rows="6" class="dev-pem" data-testid="key-public-pem"></textarea></label></fieldset>
      <label class="field">${te('api-keys.form.ips')}<textarea name="ips" rows="2" data-testid="key-ips"></textarea><small class="faint">${te('api-keys.form.ips_hint')}</small></label>
      <label class="field">${te('api-keys.form.expires')}<input type="datetime-local" name="expires" data-testid="key-expires"></label>
      <div class="form-error" role="alert" data-testid="key-error"></div>
      <button class="btn btn-primary" type="submit" data-testid="key-create">${te('api-keys.form.submit')}</button></form>
    <div class="card panel"><h3>${te('api-keys.list.title')}</h3>${keys.length ? `<div class="dev-scroll"><table class="table dev-table" data-testid="api-key-list"><thead><tr><th>${te('api-keys.col.label')}</th><th>${te('api-keys.col.key')}</th><th>${te('api-keys.col.scopes')}</th><th>${te('api-keys.col.tier')}</th><th>${te('api-keys.col.status')}</th><th>${te('api-keys.col.last_used')}</th><th>${te('api-keys.col.expires')}</th><th>${te('api-keys.col.actions')}</th></tr></thead><tbody>${keys.map(keyRow).join('')}</tbody></table></div>` : `<p class="muted" data-testid="api-keys-empty">${te('api-keys.list.empty')}</p>`}</div>
    <div class="card panel"><h3>${te('api-keys.usage.title')}</h3>${usageHtml(keys, usage.usage)}</div>
    <div class="card panel"><h3>${te('api-keys.tiers.title')}</h3><ul class="dev-list" data-testid="api-tiers">${tierRows}</ul></div></div>`;
  const once = panel.querySelector('[data-once]');
  const f = panel.querySelector('[data-testid=api-key-form]');
  for (const r of f.querySelectorAll('input[name=mode]')) r.onchange = () => { f.querySelector('[data-pem]').hidden = f.mode.value !== 'public_key'; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('[data-testid=key-error]');
    err.textContent = '';
    const scopes = ['read', ...(f.scope_trade.checked ? ['trade'] : []), ...(f.scope_perps.checked ? ['perps'] : [])];
    const body = { label: f.label.value.trim(), scopes, mode: f.mode.value, ip_allowlist: f.ips.value.split(/[\s,]+/).filter(Boolean), expires_at: f.expires.value ? new Date(f.expires.value).toISOString() : null };
    if (body.mode === 'public_key') body.public_key = f.public_key.value.trim();
    const btn = f.querySelector('[data-testid=key-create]');
    btn.disabled = true;
    try {
      const r = await request('POST', base(), body);
      toast(t('api-keys.form.created'));
      await render(panel);
      if (r.private_key) showOnce(panel.querySelector('[data-once]'), r.api_key, r.private_key);
    } catch (ex) { err.textContent = ex.fields ? Object.values(ex.fields).join(' ') : ex.message; } finally { btn.disabled = false; }
  };
  for (const b of panel.querySelectorAll('[data-rotate]')) {
    b.onclick = async () => {
      if (!window.confirm(t('api-keys.rotate.confirm', { hours: Math.round(data.rotation_grace_seconds / 3600) }))) return;
      try {
        const r = await request('POST', base(`/${encodeURIComponent(b.dataset.rotate)}/rotate`), { mode: 'generate' });
        toast(t('api-keys.rotate.done'));
        await render(panel);
        if (r.private_key) showOnce(panel.querySelector('[data-once]'), r.api_key, r.private_key);
      } catch (ex) { toast(ex.message, 'error'); }
    };
  }
  for (const b of panel.querySelectorAll('[data-revoke]')) {
    b.onclick = async () => {
      const k = keys.find((x) => x.api_key_id === b.dataset.revoke);
      if (!window.confirm(t('api-keys.revoke.confirm', { label: k.label }))) return;
      try { await request('DELETE', base(`/${encodeURIComponent(k.api_key_id)}`)); toast(t('api-keys.revoke.done')); await render(panel); } catch (ex) { toast(ex.message, 'error'); }
    };
  }
  void once;
}
