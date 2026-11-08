// Developer portal (/docs; CLONE_SPEC.md §13.18, §35.9). Header: wordmark + "API Docs", search (Ctrl K) and a theme
// toggle; tabs Welcome · Quick Start · Concepts · Predictions APIs · Perps APIs · FIX · Changelog; side links to Rate
// limits, the demo environment and the Developer Agreement. Prose is CMS pages docs/* (GET /v1/developer/portal);
// the reference is generated from /docs/openapi.json, /docs/asyncapi.json and /docs/fix.json. Each REST endpoint has a
// Try it panel that signs requests in the browser (public/js/docs-sign.js, WebCrypto) against the demo environment.
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/docs-strings.js';
import { request } from '../api.js';
import { session, applyTheme } from '../store.js';
import { esc } from '../lib.js';

const API_BASE = '/trade-api/v2';
const TABS = ['welcome', 'quick-start', 'concepts', 'predictions', 'perps', 'fix', 'changelog'];
const SIDE = ['rate-limits', 'demo', 'agreement'];
const hrefOf = (id) => (id === 'welcome' ? '/docs' : `/docs/${id}`);
let generated = null; // { openapi, asyncapi, fix }: the generated documents, kept for a minute

// The CMS prose is fetched on every render, so a publish (which re-renders the open route, content-live.js) shows live.
async function load() {
  const json = (u) => fetch(u, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null));
  const [portal, gen] = await Promise.all([request('GET', '/v1/developer/portal'), generated || Promise.all([json('/docs/openapi.json'), json('/docs/asyncapi.json'), json('/docs/fix.json')]).then(([openapi, asyncapi, fix]) => {
    generated = { openapi, asyncapi, fix };
    setTimeout(() => { generated = null; }, 60000);
    return generated;
  })]);
  return { portal, ...gen };
}
// Flat list of operations from the OpenAPI document.
function opsOf(openapi) {
  const out = [];
  for (const [path, item] of Object.entries(openapi?.paths || {})) {
    for (const [m, o] of Object.entries(item)) out.push({ id: o.operationId, method: m.toUpperCase(), path, summary: o.summary || '', tag: o.tags?.[0] || '', product: o['x-parlance-product'], scopes: o['x-parlance-scopes'] || [], cost: o['x-parlance-token-cost'], bucket: o['x-parlance-bucket'], auth: (o.security || []).length ? 'key' : 'public', params: o.parameters || [], body: o.requestBody?.content?.['application/json']?.schema || null, responses: o.responses });
  }
  return out;
}
const schemaName = (sch) => (sch?.$ref ? sch.$ref.split('/').pop() : null);
const typeText = (sch) => (sch ? schemaName(sch) || (Array.isArray(sch.type) ? sch.type.join(' | ') : sch.type || '') + (sch.enum ? ` (${sch.enum.join(', ')})` : '') : '');
// eslint-disable-next-line parlance/no-unescaped-html -- body is the CMS page, sanitised by the server's 'page' allowlist (server/cms/sanitize.js) when saved and again when served
const prose = (p) => (p ? `<div class="docs-prose cms-body" data-testid="docs-prose" data-slug="${esc(p.slug)}"><h1 class="docs-h1">${esc(p.title)}</h1>${p.body}</div>` : '');

function opRow(o) {
  return `<li class="docs-op" data-testid="ref-op" data-op="${esc(o.id)}"><a href="/docs/reference/${esc(o.id)}" data-link data-testid="ref-link"><span class="docs-method m-${esc(o.method.toLowerCase())}">${esc(o.method)}</span> <code class="dev-mono">${esc(API_BASE + o.path)}</code></a><span class="faint"> ${esc(o.summary)}</span></li>`;
}
function referenceHtml(ops, asyncapi, product) {
  const mine = ops.filter((o) => o.product === product);
  const tags = [...new Set(mine.map((o) => o.tag))];
  const chans = Object.entries(asyncapi?.channels || {}).filter(([, c]) => c['x-parlance-product'] === product);
  const wsPath = product === 'perps' ? '/trade-api/ws/v2/margin' : '/trade-api/ws/v2';
  return `<section class="docs-ref" data-testid="docs-reference" data-product="${esc(product)}"><h2>${te('docs.ref.title')}</h2>${tags.map((tg) => `<h3 class="docs-tag">${esc(tg)}</h3><ul class="docs-ops">${mine.filter((o) => o.tag === tg).map(opRow).join('')}</ul>`).join('')}
    <h2>${te('docs.ref.ws_title')}</h2><p class="muted">${te('docs.ref.ws_path', { path: `<code class="dev-mono">${esc(wsPath)}</code>` })}</p>
    <div class="dev-scroll"><table class="table dev-table" data-testid="ws-channels"><thead><tr><th>${te('docs.ref.channel')}</th><th></th><th>${te('docs.ref.messages')}</th></tr></thead><tbody>${chans.map(([, c]) => `<tr data-channel="${esc(c['x-parlance-channel'])}"><td><code class="dev-mono">${esc(c['x-parlance-channel'])}</code></td><td>${c['x-parlance-auth'].startsWith('private') ? te('docs.ref.private') : te('docs.ref.public')}</td><td>${esc(c.description || '')}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function fixHtml(spec) {
  if (!spec) return '';
  const dir = (d) => t(d === 'in' ? 'docs.fix.dir_in' : d === 'out' ? 'docs.fix.dir_out' : 'docs.fix.dir_both');
  const table = (fields) => `<div class="dev-scroll"><table class="table dev-table" data-testid="fix-table"><thead><tr><th>${te('docs.fix.tag')}</th><th>${te('docs.fix.field')}</th><th>${te('docs.fix.req')}</th><th>${te('docs.fix.note')}</th></tr></thead><tbody>${fields.map((f) => `<tr><td>${esc(f.tag ?? f[0])}</td><td>${esc(f.field ?? f[1])}</td><td>${(f.required ?? f[2]) ? te('docs.ref.yes') : te('docs.ref.no')}</td><td>${esc(f.note ?? f[3] ?? '')}</td></tr>`).join('')}</tbody></table></div>`;
  return `<section class="docs-ref" data-testid="fix-reference"><h2>${te('docs.fix.tables')}</h2><p class="muted">${te('docs.fix.signed', { text: esc(spec.signed_logon) })}</p>
    <h3>${te('docs.fix.header')}</h3>${table(spec.header.map(([tag, field, required, note]) => ({ tag, field, required, note })))}
    ${spec.messages.map((m) => `<h3 data-testid="fix-msg" data-type="${esc(m.type)}">${esc(m.type)} · ${esc(m.name)} <span class="faint">${esc(dir(m.direction))} · ${esc(t('docs.fix.sessions', { sessions: m.sessions.join(', ') }))}</span></h3>${table(m.fields)}`).join('')}</section>`;
}
function limitsHtml(portal, ops) {
  return `<section class="docs-ref"><h2>${te('docs.limits.tiers')}</h2><div class="dev-scroll"><table class="table dev-table" data-testid="tiers-table"><thead><tr><th>${te('docs.limits.tier')}</th><th class="num">${te('docs.limits.read')}</th><th class="num">${te('docs.limits.write')}</th><th class="num">${te('docs.limits.ws')}</th><th class="num">${te('docs.limits.fix')}</th></tr></thead>
    <tbody>${portal.tiers.map((x) => `<tr data-tier="${esc(x.id)}"><td>${esc(x.label)}</td><td class="num">${esc(x.read_per_sec)}</td><td class="num">${esc(x.write_per_sec)}</td><td class="num">${esc(x.ws_connections)}</td><td class="num">${esc(x.fix_sessions)}</td></tr>`).join('')}</tbody></table></div>
    <h2>${te('docs.limits.costs')}</h2><div class="dev-scroll"><table class="table dev-table" data-testid="costs-table"><thead><tr><th>${te('docs.limits.endpoint')}</th><th class="num">${te('docs.limits.cost')}</th></tr></thead><tbody>${ops.map((o) => `<tr><td><span class="docs-method m-${esc(o.method.toLowerCase())}">${esc(o.method)}</span> <code class="dev-mono">${esc(o.path)}</code></td><td class="num">${esc(o.cost)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function welcomeHtml(portal) {
  const card = (p, title, body) => `<a class="card docs-card" href="/docs/${esc(p)}" data-link data-testid="api-card" data-product="${esc(p)}"><h3>${esc(title)}</h3><p class="muted">${esc(body)}</p><p><span class="dev-chip">${te('docs.welcome.rest')}</span> <span class="dev-chip">${te('docs.welcome.ws')}</span> <span class="dev-chip">${te('docs.welcome.fix')}</span></p></a>`;
  return `<h2>${te('docs.welcome.apis')}</h2><div class="docs-cards">${card('predictions', t('docs.welcome.predictions'), t('docs.welcome.predictions_body'))}${card('perps', t('docs.welcome.perps'), t('docs.welcome.perps_body'))}</div>
    <h2>${te('docs.welcome.get_started')}</h2><ul class="dev-list"><li><a href="/account/api-keys" data-link>${te('docs.welcome.create_key')}</a></li>${portal.demo.enabled ? `<li><a href="/docs/demo" data-link>${te('docs.welcome.try_demo')}</a></li>` : ''}<li><a href="/docs/openapi.json" data-testid="openapi-link" download>${te('docs.welcome.openapi')}</a></li><li><a href="/docs/asyncapi.json" data-testid="asyncapi-link" download>${te('docs.welcome.asyncapi')}</a></li></ul>
    <p class="muted"><a href="/docs/agreement" data-link data-testid="docs-agreement-link">${te('docs.welcome.agreement')}</a></p>`;
}

// ---------------------------------------------------------------- reference page + Try it
function paramsTable(o) {
  if (!o.params.length) return '';
  return `<h2>${te('docs.ref.params')}</h2><div class="dev-scroll"><table class="table dev-table"><thead><tr><th>${te('docs.ref.param')}</th><th>${te('docs.ref.in')}</th><th>${te('docs.ref.type')}</th><th>${te('docs.ref.required')}</th></tr></thead><tbody>${o.params.map((p) => `<tr><td><code class="dev-mono">${esc(p.name)}</code></td><td>${esc(p.in)}</td><td>${esc(typeText(p.schema))}</td><td>${p.required ? te('docs.ref.yes') : te('docs.ref.no')}</td></tr>`).join('')}</tbody></table></div>`;
}
function bodyExample(o, ticker) {
  const ex = { create_order: { ticker, side: 'yes', action: 'buy', type: 'limit', count: 1, yes_price: 5 }, batch_create_orders: { orders: [{ ticker, side: 'yes', action: 'buy', type: 'limit', count: 1, yes_price: 4 }] }, batch_cancel_orders: { ids: [] },
    amend_order: { yes_price: 6 }, decrease_order: { reduce_by: 1 }, create_order_group: { contracts_limit: 10 }, create_rfq: { market_ticker: ticker, contracts_fp: '10.00' }, create_margin_order: { ticker: 'PLXBTCPERP', side: 'bid', type: 'limit', price: '1.0000', count: 1, leverage: 2 } };
  if (ex[o.id]) return JSON.stringify(ex[o.id], null, 2);
  return o.body ? '{}' : '';
}
async function tryIt(host, o, portal) {
  const { loadDemoKey, saveDemoKey, clearDemoKey, newKeyPair, signedHeaders } = await import('../docs-sign.js');
  if (!portal.demo.enabled) { host.innerHTML = `<p class="muted" data-testid="try-unavailable">${te('docs.try.unavailable')}</p>`; return; }
  const rec = await loadDemoKey();
  let ticker = '';
  try { ticker = (await (await fetch('/demo-api/trade-api/v2/markets?limit=1&status=open', { credentials: 'omit' })).json()).markets[0].ticker; } catch { /* examples without a ticker */ }
  const pathParams = o.params.filter((p) => p.in === 'path');
  const queryParams = o.params.filter((p) => p.in === 'query');
  host.innerHTML = `<section class="card docs-try" data-testid="try-it" data-op="${esc(o.id)}"><h2>${te('docs.try.title')}</h2>
    <div data-key>${rec ? `<p class="faint" data-testid="try-key-id" data-key-id="${esc(rec.keyId)}">${te('docs.try.key', { id: esc(rec.keyId) })} <button class="btn btn-sm btn-ghost" type="button" data-reset data-testid="try-reset">${te('docs.try.reset')}</button></p>`
    : session.user ? `<button class="btn" type="button" data-create data-testid="try-create-key">${te('docs.try.create')}</button>` : `<p class="muted" data-testid="try-sign-in">${te('docs.try.sign_in')} <a href="/sign-in?next=${esc(encodeURIComponent(location.pathname))}" data-link>${te('docs.try.sign_in_link')}</a></p>`}</div>
    <form data-try novalidate>${pathParams.map((p) => `<label class="field">${esc(t('docs.try.path', { name: p.name }))}<input name="p_${esc(p.name)}" data-param="${esc(p.name)}" value="${esc(p.name === 'ticker' ? ticker : '')}"></label>`).join('')}
      ${queryParams.map((p) => `<label class="field">${esc(t('docs.try.query', { name: p.name }))}<input name="q_${esc(p.name)}" data-query="${esc(p.name)}"></label>`).join('')}
      ${['POST', 'PUT', 'DELETE'].includes(o.method) && o.body ? `<label class="field">${te('docs.try.body')}<textarea class="dev-pem" rows="6" name="body" data-testid="try-body"></textarea></label>` : ''}
      <button class="btn btn-primary" type="submit" data-testid="try-send" ${rec ? '' : 'disabled'}>${te('docs.try.send')}</button></form>
    <p class="faint dev-mono" data-testid="try-url"></p><p data-testid="try-status" class="docs-status"></p><pre class="docs-pre" data-testid="try-response"></pre></section>`;
  const ta = host.querySelector('textarea[name=body]');
  if (ta) ta.value = bodyExample(o, ticker);
  host.querySelector('[data-reset]')?.addEventListener('click', async () => { await clearDemoKey(); tryIt(host, o, portal); });
  host.querySelector('[data-create]')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = t('docs.try.creating');
    try {
      const kp = await newKeyPair();
      const r = await request('POST', '/v1/developer/demo_credentials', { public_key: kp.publicPem });
      await saveDemoKey({ keyId: r.api_key.api_key_id, privateKey: kp.privateKey });
      tryIt(host, o, portal);
    } catch (ex) { host.querySelector('[data-testid=try-status]').textContent = ex.message; e.target.disabled = false; e.target.textContent = t('docs.try.create'); }
  });
  host.querySelector('[data-try]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const k = await loadDemoKey();
    if (!k) return;
    let path = `/demo-api/trade-api/v2${o.path}`;
    for (const p of pathParams) path = path.replace(`{${p.name}}`, encodeURIComponent(f[`p_${p.name}`].value.trim()));
    const qs = new URLSearchParams(queryParams.map((p) => [p.name, f[`q_${p.name}`].value.trim()]).filter(([, v]) => v)).toString();
    const url = qs ? `${path}?${qs}` : path;
    let body;
    if (ta && ta.value.trim()) { try { body = JSON.stringify(JSON.parse(ta.value)); } catch { host.querySelector('[data-testid=try-status]').textContent = t('docs.try.bad_json'); return; } }
    const headers = { Accept: 'application/json', ...(await signedHeaders(k, o.method, path)), ...(body ? { 'Content-Type': 'application/json' } : {}) };
    host.querySelector('[data-testid=try-url]').textContent = t('docs.try.request', { url: `${o.method} ${url}` });
    // credentials: 'omit' — the demo API authenticates the signature only; the site's cookies never go with it.
    const res = await fetch(url, { method: o.method, headers, body, credentials: 'omit' });
    const text = await res.text();
    const st = host.querySelector('[data-testid=try-status]');
    st.textContent = t('docs.try.status', { status: res.status }); st.dataset.status = String(res.status);
    let pretty = text; try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
    host.querySelector('[data-testid=try-response]').textContent = pretty;
  });
}
function refPage(o) {
  const ok = Object.entries(o.responses || {}).find(([c]) => Number(c) < 300);
  const tab = o.product === 'perps' ? 'perps' : 'predictions';
  return `<div class="docs-prose" data-testid="ref-page" data-op="${esc(o.id)}"><p><a href="/docs/${esc(tab)}" data-link>${te('docs.ref.back', { tab: esc(t(`docs.tab.${tab}`)) })}</a></p>
    <h1 class="docs-h1">${esc(o.summary)}</h1><p><span class="docs-method m-${esc(o.method.toLowerCase())}">${esc(o.method)}</span> <code class="dev-mono" data-testid="ref-path">${esc(API_BASE + o.path)}</code></p>
    <p class="muted">${o.auth === 'key' ? te('docs.ref.auth_key', { scopes: esc(o.scopes.join(', ')) }) : te('docs.ref.auth_public')} · ${esc(t('docs.ref.cost', { cost: o.cost, bucket: o.bucket }))}</p>
    ${paramsTable(o)}${o.body ? `<h2>${te('docs.ref.body')}</h2><pre class="docs-pre">${esc(JSON.stringify(o.body, null, 2))}</pre>` : ''}
    ${ok ? `<h2>${te('docs.ref.response', { status: esc(ok[0]) })}</h2><pre class="docs-pre">${esc(JSON.stringify(ok[1].content?.['application/json']?.schema || {}, null, 2))}</pre>` : ''}</div><div data-try-host></div>`;
}

// ---------------------------------------------------------------- search
function searchIndex(c) {
  const items = [];
  const tmp = document.createElement('div');
  for (const p of c.portal.pages) {
    // eslint-disable-next-line parlance/no-unescaped-html -- server-sanitised CMS page body, parsed off-document only to extract its text for search
    tmp.innerHTML = p.body;
    items.push({ kind: t('docs.search.page'), title: p.title, text: `${p.title} ${tmp.textContent}`.toLowerCase(), href: hrefOf(p.id) });
  }
  for (const o of opsOf(c.openapi)) items.push({ kind: t('docs.search.op'), title: `${o.method} ${o.path}`, sub: o.summary, text: `${o.method} ${o.path} ${o.summary} ${o.id} ${o.tag}`.toLowerCase(), href: `/docs/reference/${o.id}` });
  return items;
}

export async function render({ el, params, navigate }) {
  let c;
  try { c = await load(); } catch (e) {
    el.innerHTML = `<div class="card empty center-40" data-testid="docs-unavailable"><p>${te('docs.unavailable')}</p></div>`;
    if (e.code !== 'feature_disabled') throw e;
    return undefined;
  }
  const ops = opsOf(c.openapi);
  const page = params.op ? 'reference' : params.page || 'welcome';
  const cmsPage = c.portal.pages.find((p) => p.id === page);
  const activeTab = page === 'reference' ? (ops.find((o) => o.id === params.op)?.product === 'perps' ? 'perps' : 'predictions') : page;
  let main = '';
  if (page === 'reference') { const o = ops.find((x) => x.id === params.op); main = o ? refPage(o) : `<p class="muted" data-testid="ref-missing">${te('docs.ref.not_found')}</p>`; } else {
    main = prose(cmsPage);
    if (page === 'welcome') main += welcomeHtml(c.portal);
    if (page === 'predictions' || page === 'perps') main += referenceHtml(ops, c.asyncapi, page);
    if (page === 'fix') main += fixHtml(c.fix);
    if (page === 'rate-limits') main += limitsHtml(c.portal, ops);
  }
  document.title = t('docs.page.doc_title', { title: cmsPage ? cmsPage.title : page === 'reference' ? ops.find((o) => o.id === params.op)?.summary || '' : t(`docs.tab.${page}`) });
  el.innerHTML = `<div class="docs" data-testid="docs-portal" data-page="${esc(page)}">
    <header class="docs-head"><a class="docs-brand" href="/docs" data-link><strong>${te('docs.head.brand')}</strong> <span>${te('docs.head.title')}</span></a>
      <div class="docs-search"><input type="search" placeholder="${te('docs.head.search')}" aria-label="${te('docs.head.search')}" data-testid="docs-search" autocomplete="off"><kbd class="docs-kbd">${te('docs.head.search_hint')}</kbd><div class="docs-results card" data-testid="docs-results" hidden></div></div>
      <a class="btn btn-sm btn-ghost" href="/status" data-link>${te('docs.head.status')}</a><button class="btn btn-sm" type="button" data-testid="docs-theme" aria-label="${te('docs.head.theme')}">${te('docs.head.theme')}</button></header>
    <nav class="docs-tabs" aria-label="${te('docs.head.title')}" data-testid="docs-tabs">${TABS.map((id) => `<a href="${esc(hrefOf(id))}" data-link data-tab="${esc(id)}" class="${id === activeTab ? 'on' : ''}"${id === activeTab ? ' aria-current="page"' : ''}>${esc(t(`docs.tab.${id}`))}</a>`).join('')}</nav>
    <div class="docs-body"><article class="docs-main" data-testid="docs-content">${main}</article>
      <aside class="docs-side"><h4>${te('docs.side.more')}</h4><ul class="dev-list">${SIDE.map((id) => `<li><a href="/docs/${esc(id)}" data-link data-side="${esc(id)}">${esc(t(`docs.side.${id}`))}</a></li>`).join('')}<li><a href="/account/api-keys" data-link>${te('docs.side.keys')}</a></li></ul></aside></div></div>`;

  // Search: Ctrl K / Cmd K focuses it; results are links into guides and the reference.
  const input = el.querySelector('[data-testid=docs-search]');
  const box = el.querySelector('[data-testid=docs-results]');
  const index = searchIndex(c);
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { box.hidden = true; box.innerHTML = ''; return; }
    const hits = index.filter((x) => q.split(/\s+/).every((w) => x.text.includes(w))).slice(0, 12);
    box.hidden = false;
    box.innerHTML = hits.length ? hits.map((x) => `<a href="${esc(x.href)}" data-link data-testid="docs-result"><span class="faint">${esc(x.kind)}</span> ${esc(x.title)}${x.sub ? ` <span class="faint">${esc(x.sub)}</span>` : ''}</a>`).join('') : `<p class="faint">${te('docs.search.none')}</p>`;
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; box.hidden = true; } if (e.key === 'Enter') { const a = box.querySelector('a'); if (a) navigate(a.getAttribute('href')); } });
  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); } };
  document.addEventListener('keydown', onKey);
  el.querySelector('[data-testid=docs-theme]').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('parlance-theme', next); } catch { /* private mode */ }
  });
  // Try it last: search and the theme toggle work while it loads the demo key and example data.
  if (page === 'reference') { const o = ops.find((x) => x.id === params.op); const host = el.querySelector('[data-try-host]'); if (o && host) await tryIt(host, o, c.portal); }
  return () => document.removeEventListener('keydown', onKey);
}
