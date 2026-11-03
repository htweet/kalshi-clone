// Content CMS: home hero carousel, hubs, promo/spotlight cards, site banners, category navigation, info cards,
// event news items and help pages. Empty collections fall back to the built-in defaults on the public site.
import { vars } from '../../dynstyle.js';
import { esc, get, post, put, del, toast, dataTable, formHtml, wireForm, dialog, confirmAction, section, subTabs, badge, fmtTime } from './ui.js';
import { CATEGORIES, catLabel } from '../../lib.js';

// Promo targeting lists are stored as JSON arrays; the form edits them as comma-separated text.
const listText = (v) => { try { return (Array.isArray(v) ? v : JSON.parse(v || '[]')).join(', '); } catch { return ''; } };
const TABS = [['hero', 'Hero carousel'], ['hubs', 'Hubs'], ['promos', 'Promo cards'], ['banners', 'Site banner'], ['nav', 'Navigation'], ['info_cards', 'Info cards'], ['news', 'News items'], ['help', 'Help pages']];
const active = (r) => (r.active ? badge('active', 'ok') : badge('off'));
const windowText = (r) => (r.starts_at || r.ends_at ? `${r.starts_at ? fmtTime(r.starts_at) : '…'} → ${r.ends_at ? fmtTime(r.ends_at) : '…'}` : 'Always');
const COLL = {
  hubs: { noun: 'hub', hint: 'Rail cards on the home page linking to a category. With no hubs configured the two built-in hubs are shown.',
    fields: (r) => [{ name: 'title', label: 'Title', required: true, value: r.title }, { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, value: r.category }, { name: 'position', label: 'Order', type: 'number', value: r.position ?? 0 }, { name: 'active', label: 'Active', type: 'checkbox', value: r.active ?? true }],
    cols: [{ key: 'position', label: '#', num: true }, { key: 'title', label: 'Title' }, { key: 'category', label: 'Category' }, { key: 'active', label: 'State', render: active }] },
  promos: { noun: 'promo card', hint: 'Spotlight cards in the home rail (overline, title, subtitle, link, colour, active dates). With none active, the built-in Perps promo is shown.',
    fields: (r) => [{ name: 'overline', label: 'Overline', value: r.overline }, { name: 'title', label: 'Title', required: true, value: r.title }, { name: 'subtitle', label: 'Subtitle', value: r.subtitle, span: true },
      { name: 'link', label: 'Link', required: true, value: r.link, placeholder: '/category/sports' }, { name: 'color', label: 'Colour', type: 'color', value: r.color || '#008751' },
      { name: 'starts_at', label: 'Starts (optional)', type: 'datetime', value: r.starts_at }, { name: 'ends_at', label: 'Ends (optional)', type: 'datetime', value: r.ends_at },
      { name: 'position', label: 'Order', type: 'number', value: r.position ?? 0 }, { name: 'active', label: 'Active', type: 'checkbox', value: r.active ?? true },
      // Targeting (gap G8, spec §13.11): untargeted cards show on home; series / category cards on those pages.
      { name: 'series_tickers', label: 'Show on series (tickers, comma-separated)', value: listText(r.series_tickers), placeholder: 'PLXCOUNCIL, PLXSTATE', span: true, hint: 'Event pages of these series show the card instead of home.' },
      { name: 'categories', label: 'Show on categories (comma-separated)', value: listText(r.categories), placeholder: 'Politics, Crypto', span: true, hint: 'Category pages show the card instead of home.' },
      { name: 'hide_logged_out', label: 'Hide from signed-out visitors', type: 'checkbox', value: !!r.hide_logged_out }],
    cols: [{ key: 'position', label: '#', num: true }, { key: 'title', label: 'Title', render: (r) => `<i class="adm-swatch v-bg"${vars({ '--bg': r.color })}></i>${r.overline ? `<span class="faint">${esc(r.overline)} · </span>` : ''}${esc(r.title)}` }, { key: 'link', label: 'Link' },
      { key: 'series_tickers', label: 'Targeting', render: (r) => esc([listText(r.series_tickers), listText(r.categories), r.hide_logged_out ? 'signed-in only' : ''].filter(Boolean).join(' · ') || 'Home') }, { key: 'starts_at', label: 'Window', render: (r) => esc(windowText(r)) }, { key: 'active', label: 'State', render: active }] },
  banners: { noun: 'banner', hint: 'A message bar in the site shell (spec §13.5 manual banner: content, visibility, position). The newest active banner per position is shown.',
    fields: (r) => [{ name: 'content', label: 'Text', required: true, value: r.content, span: true }, { name: 'link', label: 'Link (optional)', value: r.link },
      { name: 'visibility', label: 'Visible to', type: 'select', options: [['all', 'Everyone'], ['logged_in', 'Signed-in users'], ['logged_out', 'Signed-out visitors']], value: r.visibility || 'all' },
      { name: 'position', label: 'Position', type: 'select', options: [['top', 'Top (under header)'], ['bottom', 'Bottom (above footer)']], value: r.position || 'top' },
      { name: 'starts_at', label: 'Starts (optional)', type: 'datetime', value: r.starts_at }, { name: 'ends_at', label: 'Ends (optional)', type: 'datetime', value: r.ends_at }, { name: 'active', label: 'Active', type: 'checkbox', value: r.active ?? true }],
    cols: [{ key: 'content', label: 'Text' }, { key: 'visibility', label: 'Visible to' }, { key: 'position', label: 'Position' }, { key: 'starts_at', label: 'Window', render: (r) => esc(windowText(r)) }, { key: 'active', label: 'State', render: active }] },
  info_cards: { noun: 'info card', hint: 'The three cards under the home hero. With none active, the built-in cards are shown.',
    fields: (r) => [{ name: 'title', label: 'Title', required: true, value: r.title }, { name: 'subtitle', label: 'Subtitle', value: r.subtitle }, { name: 'link', label: 'Link', required: true, value: r.link },
      { name: 'icon', label: 'Icon', type: 'select', options: ['shield', 'bars', 'clock', 'star', 'info'], value: r.icon || 'info' }, { name: 'position', label: 'Order', type: 'number', value: r.position ?? 0 }, { name: 'active', label: 'Active', type: 'checkbox', value: r.active ?? true }],
    cols: [{ key: 'position', label: '#', num: true }, { key: 'title', label: 'Title' }, { key: 'subtitle', label: 'Subtitle' }, { key: 'link', label: 'Link' }, { key: 'icon', label: 'Icon' }, { key: 'active', label: 'State', render: active }] },
  news: { noun: 'news item', hint: 'Headlines attached to an event and shown in the News section of its page.',
    fields: (r) => [{ name: 'event_ticker', label: 'Event ticker', required: true, value: r.event_ticker }, { name: 'source', label: 'Source label', required: true, value: r.source, placeholder: 'Harbor Gazette' },
      { name: 'published_at', label: 'Published', type: 'datetime', required: true, value: r.published_at || new Date().toISOString() }, { name: 'headline', label: 'Headline', required: true, value: r.headline, span: true },
      { name: 'summary', label: 'Summary', type: 'textarea', value: r.summary, span: true }, { name: 'active', label: 'Active', type: 'checkbox', value: r.active ?? true }],
    cols: [{ key: 'published_at', label: 'Published', render: (r) => esc(fmtTime(r.published_at)) }, { key: 'event_ticker', label: 'Event', render: (r) => `<code>${esc(r.event_ticker)}</code>` }, { key: 'source', label: 'Source' }, { key: 'headline', label: 'Headline' }, { key: 'active', label: 'State', render: active }] },
  help: { noun: 'help page', hint: 'Plain-text pages served at /help/slug. Supports # headings, - bullets, **bold** and [links](/path); everything else is shown as typed.',
    fields: (r) => [{ name: 'slug', label: 'Slug', required: true, value: r.slug, placeholder: 'fees' }, { name: 'title', label: 'Title', required: true, value: r.title },
      { name: 'body', label: 'Body', type: 'textarea', rows: 12, required: true, value: r.body, span: true }, { name: 'position', label: 'Order', type: 'number', value: r.position ?? 0 }, { name: 'published', label: 'Published', type: 'checkbox', value: r.published ?? true }],
    cols: [{ key: 'slug', label: 'URL', render: (r) => `<a href="/help/${esc(r.slug)}" data-link>/help/${esc(r.slug)}</a>` }, { key: 'title', label: 'Title' }, { key: 'published', label: 'State', render: (r) => (r.published ? badge('published', 'ok') : badge('draft', 'warn')) }, { key: 'updated_at', label: 'Updated', render: (r) => esc(fmtTime(r.updated_at)) }] },
};

export async function render({ el, parts }) {
  const tab = TABS.some(([k]) => k === parts[0]) ? parts[0] : 'hero';
  el.innerHTML = section('Content', 'What the public site shows. Changes go live immediately and are recorded in the audit log.') + subTabs(TABS, tab, '/admin/content') + '<div id="ct-body"></div>';
  const body = el.querySelector('#ct-body');
  if (tab === 'hero') return renderHero(body);
  if (tab === 'nav') return renderNav(body);
  return renderCollection(body, tab);
}

async function renderCollection(body, name) {
  const c = COLL[name];
  body.innerHTML = `<div class="adm-toolbar"><p class="muted">${esc(c.hint)}</p><button class="btn btn-primary" data-new data-testid="content-new">New ${esc(c.noun)}</button></div><div data-list></div>`;
  let rows = [];
  const table = dataTable(body.querySelector('[data-list]'), { testid: `content-${name}`, rowAttrs: (r) => `data-row="${esc(r.id)}"`,
    cols: [...c.cols, { key: '_a', label: '', sort: false, render: (r) => `<span class="adm-actions"><button class="btn btn-sm" data-edit="${esc(r.id)}">Edit</button><button class="btn btn-sm btn-ghost btn-danger" data-del="${esc(r.id)}">Delete</button></span>` }] });
  const load = async () => { rows = (await get(`/content/${name}`)).items; table.setRows(rows); };
  const open = (row) => {
    const fields = c.fields(row || {});
    const d = dialog(`<h3>${row ? 'Edit' : 'New'} ${esc(c.noun)}</h3>${formHtml(fields, { submit: row ? 'Save' : 'Create', id: name, extra: '<button class="btn" type="button" data-close>Cancel</button>', testid: `${name}-form` })}`, { wide: true });
    d.querySelector('[data-close]').onclick = () => d.close();
    wireForm(d.querySelector('form'), fields, async (v) => {
      if (row) await put(`/content/${name}/${encodeURIComponent(row.id)}`, v); else await post(`/content/${name}`, v);
      d.close(); toast(`${c.noun[0].toUpperCase()}${c.noun.slice(1)} saved`); await load();
    });
  };
  body.querySelector('[data-new]').onclick = () => open(null);
  body.querySelector('[data-list]').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.edit) open(rows.find((r) => r.id === b.dataset.edit));
    if (b.dataset.del) {
      const ok = await confirmAction({ title: `Delete this ${c.noun}?`, body: 'It disappears from the public site immediately.', confirm: 'Delete', danger: true });
      if (!ok) return;
      try { await del(`/content/${name}/${encodeURIComponent(b.dataset.del)}`); toast('Deleted'); await load(); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
  await load();
}

async function renderHero(body) {
  const r = await get('/hero');
  let sel = r.selected.map((s) => s.event_ticker);
  const title = (t) => r.candidates.find((c) => c.event_ticker === t)?.title || t;
  function draw() {
    body.innerHTML = `<div class="adm-two" data-testid="hero-editor"><div class="card adm-card"><h3>Carousel order</h3>
      <p class="muted">${sel.length ? 'These events rotate in the home hero, in this order (events with no open market are skipped).' : 'Nothing selected: the hero shows every <b>featured</b> event (the default).'}</p>
      <ol class="adm-order" data-testid="hero-selected">${sel.map((t, i) => `<li data-t="${esc(t)}"><span>${esc(title(t))} <code class="faint">${esc(t)}</code></span><span class="adm-actions"><button class="btn btn-sm" data-up="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button class="btn btn-sm" data-down="${i}" ${i < sel.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button><button class="btn btn-sm btn-ghost btn-danger" data-rm="${i}" aria-label="Remove">✕</button></span></li>`).join('')}</ol>
      <div class="adm-form-actions"><button class="btn btn-primary" data-save data-testid="hero-save">Save carousel</button><button class="btn" data-reset>Use featured events</button></div></div>
      <div class="card adm-card"><h3>Add events</h3><input type="search" class="adm-input" placeholder="Filter events" data-f aria-label="Filter events"><div class="adm-pick" data-pick>${r.candidates.filter((c) => !sel.includes(c.event_ticker)).map((c) => `<button class="adm-pick-row" data-add="${esc(c.event_ticker)}" data-text="${esc((c.title + ' ' + c.event_ticker).toLowerCase())}"><span>${esc(c.title)}</span><span class="faint">${esc(c.category)}${c.featured ? ' · featured' : ''}</span></button>`).join('')}</div></div></div>`;
    body.querySelector('[data-f]').oninput = (e) => { const q = e.target.value.toLowerCase(); for (const b of body.querySelectorAll('[data-add]')) b.hidden = !b.dataset.text.includes(q); };
  }
  draw();
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.add) { sel.push(b.dataset.add); draw(); }
    else if (b.dataset.up) { const i = Number(b.dataset.up); [sel[i - 1], sel[i]] = [sel[i], sel[i - 1]]; draw(); }
    else if (b.dataset.down) { const i = Number(b.dataset.down); [sel[i + 1], sel[i]] = [sel[i], sel[i + 1]]; draw(); }
    else if (b.dataset.rm) { sel.splice(Number(b.dataset.rm), 1); draw(); }
    else if (b.dataset.save !== undefined || b.dataset.reset !== undefined) {
      if (b.dataset.reset !== undefined) sel = [];
      try { await put('/hero', { event_tickers: sel }); toast('Hero carousel saved'); draw(); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
}

async function renderNav(body) {
  const cfg = await get('/nav');
  let cats = cfg.categories.map((c) => ({ ...c }));
  const draw = () => {
    body.innerHTML = `<div class="adm-two" data-testid="nav-editor"><div class="card adm-card"><h3>Category strip</h3><p class="muted">Order, display label (blank = default) and visibility of the categories in the strip under the header.</p>
      <table class="table adm-grid"><thead><tr><th>Category</th><th>Label</th><th>Hidden</th><th></th></tr></thead><tbody>${cats.map((c, i) => `<tr data-cat="${esc(c.name)}"><td>${esc(c.name)}</td>
        <td><input class="adm-input" data-label="${i}" value="${esc(c.label)}" placeholder="${esc(catLabel(c.name))}" maxlength="24" aria-label="Label for ${esc(c.name)}"></td>
        <td><input type="checkbox" data-hidden="${i}" ${c.hidden ? 'checked' : ''} aria-label="Hide ${esc(c.name)}"></td>
        <td class="adm-actions"><button class="btn btn-sm" data-up="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button class="btn btn-sm" data-down="${i}" ${i < cats.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button></td></tr>`).join('')}</tbody></table></div>
      <div class="card adm-card"><h3>Featured tab</h3><p class="muted">The highlighted tab after “Trending”.</p>
      ${formHtml([{ name: 'label', label: 'Label', required: true, value: cfg.featured.label }, { name: 'href', label: 'Link', required: true, value: cfg.featured.href }, { name: 'color', label: 'Colour (blank = theme default)', type: 'color', value: cfg.featured.color }], { submit: 'Save navigation', id: 'nav', testid: 'nav-form' })}</div></div>`;
    const fields = [{ name: 'label', required: true }, { name: 'href', required: true }, { name: 'color', type: 'color' }];
    wireForm(body.querySelector('form'), fields, async (v) => {
      const out = await put('/nav', { categories: cats, featured: v });
      cfg.featured = out.featured; cats = out.categories.map((c) => ({ ...c }));
      toast('Navigation saved'); draw();
    });
  };
  draw();
  body.addEventListener('input', (e) => {
    if (e.target.dataset.label !== undefined) cats[Number(e.target.dataset.label)].label = e.target.value;
    if (e.target.dataset.hidden !== undefined) cats[Number(e.target.dataset.hidden)].hidden = e.target.checked;
  });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-up],button[data-down]');
    if (!b) return;
    const i = Number(b.dataset.up ?? b.dataset.down); const j = b.dataset.up !== undefined ? i - 1 : i + 1;
    [cats[i], cats[j]] = [cats[j], cats[i]]; cfg.featured = { ...cfg.featured, ...Object.fromEntries(new FormData(body.querySelector('form'))) }; draw();
  });
}
