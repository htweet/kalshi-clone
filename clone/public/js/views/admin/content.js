// Content CMS: home hero carousel, hubs, promo/spotlight cards, site banners, category navigation, info cards,
// event news items and help pages. Empty collections fall back to the built-in defaults on the public site.
import { t as tx, te, ts } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.content-strings.js';
import { vars } from '../../dynstyle.js';
import { esc, get, post, put, del, toast, dataTable, formHtml, wireForm, dialog, confirmAction, section, subTabs, badge, fmtTime } from './ui.js';
import { CATEGORIES, catLabel } from '../../lib.js';

// Promo targeting lists are stored as JSON arrays; the form edits them as comma-separated text.
const listText = (v) => { try { return (Array.isArray(v) ? v : JSON.parse(v || '[]')).join(', '); } catch { return ''; } };
const TABS = [['hero', ts('admin.content.tabs.hero_carousel')], ['hubs', ts('admin.content.tabs.hubs')], ['promos', ts('admin.content.tabs.promo_cards')], ['banners', ts('admin.content.tabs.site_banner')], ['nav', ts('admin.content.tabs.navigation')], ['info_cards', ts('admin.content.tabs.info_cards')], ['news', ts('admin.content.tabs.news_items')], ['help', ts('admin.content.tabs.help_pages')]];
const active = (r) => (r.active ? badge('active', 'ok') : badge('off'));
const windowText = (r) => (r.starts_at || r.ends_at ? `${r.starts_at ? fmtTime(r.starts_at) : '…'} → ${r.ends_at ? fmtTime(r.ends_at) : '…'}` : tx('admin.content.window_text.always'));
const COLL = {
  hubs: { noun: 'hub', hint: ts('admin.content.coll_hubs_hint.rail_cards_on_the_home'),
    fields: (r) => [{ name: 'title', label: tx('admin.content.coll_hubs_fields.title'), required: true, value: r.title }, { name: 'category', label: tx('admin.content.coll_hubs_fields.category'), type: 'select', options: CATEGORIES, value: r.category }, { name: 'position', label: 'Order', type: 'number', value: r.position ?? 0 }, { name: 'active', label: tx('admin.content.coll_hubs_fields.active'), type: 'checkbox', value: r.active ?? true }],
    cols: [{ key: 'position', label: '#', num: true }, { key: 'title', label: ts('admin.content.coll_hubs_cols_label.title') }, { key: 'category', label: ts('admin.content.coll_hubs_cols_label.category') }, { key: 'active', label: 'State', render: active }] },
  promos: { noun: 'promo card', hint: ts('admin.content.coll_promos_hint.spotlight_cards_in_the_home'),
    fields: (r) => [{ name: 'overline', label: tx('admin.content.coll_promos_fields.overline'), value: r.overline }, { name: 'title', label: tx('admin.content.coll_promos_fields.title'), required: true, value: r.title }, { name: 'subtitle', label: tx('admin.content.coll_promos_fields.subtitle'), value: r.subtitle, span: true },
      { name: 'link', label: tx('admin.content.coll_promos_fields.link'), required: true, value: r.link, placeholder: '/category/sports' }, { name: 'color', label: tx('admin.content.coll_promos_fields.colour'), type: 'color', value: r.color || '#008751' },
      { name: 'starts_at', label: tx('admin.content.coll_promos_fields.starts_optional'), type: 'datetime', value: r.starts_at }, { name: 'ends_at', label: tx('admin.content.coll_promos_fields.ends_optional'), type: 'datetime', value: r.ends_at },
      { name: 'position', label: 'Order', type: 'number', value: r.position ?? 0 }, { name: 'active', label: tx('admin.content.coll_promos_fields.active'), type: 'checkbox', value: r.active ?? true },
      // Targeting (gap G8, spec §13.11): untargeted cards show on home; series / category cards on those pages.
      { name: 'series_tickers', label: tx('admin.content.coll_promos_fields.show_on_series_tickers_comma'), value: listText(r.series_tickers), placeholder: tx('admin.content.coll_promos_fields.plxcouncil_plxstate'), span: true, hint: tx('admin.content.coll_promos_fields.event_pages_of_these_series') },
      { name: 'categories', label: tx('admin.content.coll_promos_fields.show_on_categories_comma_separated'), value: listText(r.categories), placeholder: tx('admin.content.coll_promos_fields.politics_crypto'), span: true, hint: tx('admin.content.coll_promos_fields.category_pages_show_the_card') },
      { name: 'hide_logged_out', label: tx('admin.content.coll_promos_fields.hide_from_signed_out_visitors'), type: 'checkbox', value: !!r.hide_logged_out }],
    cols: [{ key: 'position', label: '#', num: true }, { key: 'title', label: ts('admin.content.coll_promos_cols_label.title'), render: (r) => `<i class="adm-swatch v-bg"${vars({ '--bg': r.color })}></i>${r.overline ? `<span class="faint">${esc(r.overline)} · </span>` : ''}${esc(r.title)}` }, { key: 'link', label: ts('admin.content.coll_promos_cols_label.link') },
      { key: 'series_tickers', label: ts('admin.content.coll_promos_cols_label.targeting'), render: (r) => esc([listText(r.series_tickers), listText(r.categories), r.hide_logged_out ? 'signed-in only' : ''].filter(Boolean).join(' · ') || tx('admin.content.coll_promos_cols_render.home')) }, { key: 'starts_at', label: ts('admin.content.coll_promos_cols_label.window'), render: (r) => esc(windowText(r)) }, { key: 'active', label: 'State', render: active }] },
  banners: { noun: 'banner', hint: ts('admin.content.coll_banners_hint.a_message_bar_in_the'),
    fields: (r) => [{ name: 'content', label: tx('admin.content.coll_banners_fields.text'), required: true, value: r.content, span: true }, { name: 'link', label: tx('admin.content.coll_banners_fields.link_optional'), value: r.link },
      { name: 'visibility', label: tx('admin.content.coll_banners_fields.visible_to'), type: 'select', options: [['all', 'Everyone'], ['logged_in', tx('admin.content.coll_banners_fields.signed_in_users')], ['logged_out', tx('admin.content.coll_banners_fields.signed_out_visitors')]], value: r.visibility || 'all' },
      { name: 'position', label: tx('admin.content.coll_banners_fields.position'), type: 'select', options: [['top', tx('admin.content.coll_banners_fields.top_under_header')], ['bottom', tx('admin.content.coll_banners_fields.bottom_above_footer')]], value: r.position || 'top' },
      { name: 'starts_at', label: tx('admin.content.coll_banners_fields.starts_optional'), type: 'datetime', value: r.starts_at }, { name: 'ends_at', label: tx('admin.content.coll_banners_fields.ends_optional'), type: 'datetime', value: r.ends_at }, { name: 'active', label: tx('admin.content.coll_banners_fields.active'), type: 'checkbox', value: r.active ?? true }],
    cols: [{ key: 'content', label: ts('admin.content.coll_banners_cols_label.text') }, { key: 'visibility', label: ts('admin.content.coll_banners_cols_label.visible_to') }, { key: 'position', label: ts('admin.content.coll_banners_cols_label.position') }, { key: 'starts_at', label: ts('admin.content.coll_banners_cols_label.window'), render: (r) => esc(windowText(r)) }, { key: 'active', label: 'State', render: active }] },
  info_cards: { noun: 'info card', hint: ts('admin.content.coll_info_cards_hint.the_three_cards_under_the'),
    fields: (r) => [{ name: 'title', label: tx('admin.content.coll_info_cards_fields.title'), required: true, value: r.title }, { name: 'subtitle', label: tx('admin.content.coll_info_cards_fields.subtitle'), value: r.subtitle }, { name: 'link', label: tx('admin.content.coll_info_cards_fields.link'), required: true, value: r.link },
      { name: 'icon', label: tx('admin.content.coll_info_cards_fields.icon'), type: 'select', options: ['shield', 'bars', 'clock', 'star', 'info'], value: r.icon || 'info' }, { name: 'position', label: 'Order', type: 'number', value: r.position ?? 0 }, { name: 'active', label: tx('admin.content.coll_info_cards_fields.active'), type: 'checkbox', value: r.active ?? true }],
    cols: [{ key: 'position', label: '#', num: true }, { key: 'title', label: ts('admin.content.coll_info_cards_cols_label.title') }, { key: 'subtitle', label: ts('admin.content.coll_info_cards_cols_label.subtitle') }, { key: 'link', label: ts('admin.content.coll_info_cards_cols_label.link') }, { key: 'icon', label: ts('admin.content.coll_info_cards_cols_label.icon') }, { key: 'active', label: 'State', render: active }] },
  news: { noun: 'news item', hint: ts('admin.content.coll_news_hint.headlines_attached_to_an_event'),
    fields: (r) => [{ name: 'event_ticker', label: tx('admin.content.coll_news_fields.event_ticker'), required: true, value: r.event_ticker }, { name: 'source', label: tx('admin.content.coll_news_fields.source_label'), required: true, value: r.source, placeholder: tx('admin.content.coll_news_fields.harbor_gazette') },
      { name: 'published_at', label: tx('admin.content.coll_news_fields.published'), type: 'datetime', required: true, value: r.published_at || new Date().toISOString() }, { name: 'headline', label: tx('admin.content.coll_news_fields.headline'), required: true, value: r.headline, span: true },
      { name: 'summary', label: tx('admin.content.coll_news_fields.summary'), type: 'textarea', value: r.summary, span: true }, { name: 'active', label: tx('admin.content.coll_news_fields.active'), type: 'checkbox', value: r.active ?? true }],
    cols: [{ key: 'published_at', label: ts('admin.content.coll_news_cols_label.published'), render: (r) => esc(fmtTime(r.published_at)) }, { key: 'event_ticker', label: ts('admin.content.coll_news_cols_label.event'), render: (r) => `<code>${esc(r.event_ticker)}</code>` }, { key: 'source', label: ts('admin.content.coll_news_cols_label.source') }, { key: 'headline', label: ts('admin.content.coll_news_cols_label.headline') }, { key: 'active', label: 'State', render: active }] },
  help: { noun: 'help page', hint: ts('admin.content.coll_help_hint.plain_text_pages_served_at'),
    fields: (r) => [{ name: 'slug', label: tx('admin.content.coll_help_fields.slug'), required: true, value: r.slug, placeholder: 'fees' }, { name: 'title', label: tx('admin.content.coll_help_fields.title'), required: true, value: r.title },
      { name: 'body', label: tx('admin.content.coll_help_fields.body'), type: 'textarea', rows: 12, required: true, value: r.body, span: true }, { name: 'position', label: 'Order', type: 'number', value: r.position ?? 0 }, { name: 'published', label: tx('admin.content.coll_help_fields.published'), type: 'checkbox', value: r.published ?? true }],
    cols: [{ key: 'slug', label: 'URL', render: (r) => `<a href="/help/${esc(r.slug)}" data-link>${te('admin.content.coll_help_cols_render.help', { slug: esc(r.slug) })}</a>` }, { key: 'title', label: ts('admin.content.coll_help_cols_label.title') }, { key: 'published', label: 'State', render: (r) => (r.published ? badge('published', 'ok') : badge('draft', 'warn')) }, { key: 'updated_at', label: 'Updated', render: (r) => esc(fmtTime(r.updated_at)) }] },
};

export async function render({ el, parts }) {
  const tab = TABS.some(([k]) => k === parts[0]) ? parts[0] : 'hero';
  el.innerHTML = section(tx('admin.content.render.content'), tx('admin.content.render.what_the_public_site_shows')) + subTabs(TABS, tab, '/admin/content') + '<div id="ct-body"></div>';
  const body = el.querySelector('#ct-body');
  if (tab === 'hero') return renderHero(body);
  if (tab === 'nav') return renderNav(body);
  return renderCollection(body, tab);
}

async function renderCollection(body, name) {
  const c = COLL[name];
  body.innerHTML = `<div class="adm-toolbar"><p class="muted">${esc(c.hint)}</p><button class="btn btn-primary" data-new data-testid="content-new">${te('admin.content.render_collection.new', { noun: esc(c.noun) })}</button></div><div data-list></div>`;
  let rows = [];
  const table = dataTable(body.querySelector('[data-list]'), { testid: `content-${name}`, rowAttrs: (r) => `data-row="${esc(r.id)}"`,
    cols: [...c.cols, { key: '_a', label: '', sort: false, render: (r) => `<span class="adm-actions"><button class="btn btn-sm" data-edit="${esc(r.id)}">${te('admin.content.render_collection.edit')}</button><button class="btn btn-sm btn-ghost btn-danger" data-del="${esc(r.id)}">${te('admin.content.render_collection.delete')}</button></span>` }] });
  const load = async () => { rows = (await get(`/content/${name}`)).items; table.setRows(rows); };
  const open = (row) => {
    const fields = c.fields(row || {});
    const d = dialog(`<h3>${row ? te('admin.content.render_collection.edit') : te('admin.content.render_collection.new_2')} ${esc(c.noun)}</h3>${formHtml(fields, { submit: row ? 'Save' : 'Create', id: name, extra: `<button class="btn" type="button" data-close>${te('admin.content.render_collection.cancel')}</button>`, testid: `${name}-form` })}`, { wide: true });
    d.querySelector('[data-close]').onclick = () => d.close();
    wireForm(d.querySelector('form'), fields, async (v) => {
      if (row) await put(`/content/${name}/${encodeURIComponent(row.id)}`, v); else await post(`/content/${name}`, v);
      d.close(); toast(tx('admin.content.render_collection.saved', { to_upper_case: c.noun[0].toUpperCase(), slice: c.noun.slice(1) })); await load();
    });
  };
  body.querySelector('[data-new]').onclick = () => open(null);
  body.querySelector('[data-list]').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.edit) open(rows.find((r) => r.id === b.dataset.edit));
    if (b.dataset.del) {
      const ok = await confirmAction({ title: tx('admin.content.render_collection.delete_this', { noun: c.noun }), body: tx('admin.content.render_collection.it_disappears_from_the_public'), confirm: tx('admin.content.render_collection.delete'), danger: true });
      if (!ok) return;
      try { await del(`/content/${name}/${encodeURIComponent(b.dataset.del)}`); toast(tx('admin.content.render_collection.deleted')); await load(); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
  await load();
}

async function renderHero(body) {
  const r = await get('/hero');
  let sel = r.selected.map((s) => s.event_ticker);
  const title = (t) => r.candidates.find((c) => c.event_ticker === t)?.title || t;
  function draw() {
    body.innerHTML = `<div class="adm-two" data-testid="hero-editor"><div class="card adm-card"><h3>${te('admin.content.render_hero.carousel_order')}</h3>
      <p class="muted">${sel.length ? te('admin.content.render_hero.these_events_rotate_in_the') : `${te('admin.content.render_hero.nothing_selected_the_hero_shows')} <b>${te('admin.content.render_hero.featured')}</b> ${te('admin.content.render_hero.event_the_default')}`}</p>
      <ol class="adm-order" data-testid="hero-selected">${sel.map((t, i) => `<li data-t="${esc(t)}"><span>${esc(title(t))} <code class="faint">${esc(t)}</code></span><span class="adm-actions"><button class="btn btn-sm" data-up="${i}" ${i ? '' : 'disabled'} aria-label="${te('admin.content.render_hero.move_up')}">↑</button><button class="btn btn-sm" data-down="${i}" ${i < sel.length - 1 ? '' : 'disabled'} aria-label="${te('admin.content.render_hero.move_down')}">↓</button><button class="btn btn-sm btn-ghost btn-danger" data-rm="${i}" aria-label="${te('admin.content.render_hero.remove')}">✕</button></span></li>`).join('')}</ol>
      <div class="adm-form-actions"><button class="btn btn-primary" data-save data-testid="hero-save">${te('admin.content.render_hero.save_carousel')}</button><button class="btn" data-reset>${te('admin.content.render_hero.use_featured_events')}</button></div></div>
      <div class="card adm-card"><h3>${te('admin.content.render_hero.add_events')}</h3><input type="search" class="adm-input" placeholder="${te('admin.content.render_hero.filter_events')}" data-f aria-label="${te('admin.content.render_hero.filter_events')}"><div class="adm-pick" data-pick>${r.candidates.filter((c) => !sel.includes(c.event_ticker)).map((c) => `<button class="adm-pick-row" data-add="${esc(c.event_ticker)}" data-text="${esc((c.title + ' ' + c.event_ticker).toLowerCase())}"><span>${esc(c.title)}</span><span class="faint">${esc(c.category)}${c.featured ? (' ' + te('admin.content.render_hero.featured_2')) : ''}</span></button>`).join('')}</div></div></div>`;
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
      try { await put('/hero', { event_tickers: sel }); toast(tx('admin.content.render_hero.hero_carousel_saved')); draw(); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
}

async function renderNav(body) {
  const cfg = await get('/nav');
  let cats = cfg.categories.map((c) => ({ ...c }));
  const draw = () => {
    body.innerHTML = `<div class="adm-two" data-testid="nav-editor"><div class="card adm-card"><h3>${te('admin.content.render_nav.category_strip')}</h3><p class="muted">${te('admin.content.render_nav.order_display_label_blank_default')}</p>
      <table class="table adm-grid"><thead><tr><th>${te('admin.content.render_nav.category')}</th><th>${te('admin.content.render_nav.label')}</th><th>${te('admin.content.render_nav.hidden')}</th><th></th></tr></thead><tbody>${cats.map((c, i) => `<tr data-cat="${esc(c.name)}"><td>${esc(c.name)}</td>
        <td><input class="adm-input" data-label="${i}" value="${esc(c.label)}" placeholder="${esc(catLabel(c.name))}" maxlength="24" aria-label="${te('admin.content.render_nav.label_for', { name: esc(c.name) })}"></td>
        <td><input type="checkbox" data-hidden="${i}" ${c.hidden ? 'checked' : ''} aria-label="${te('admin.content.render_nav.hide', { name: esc(c.name) })}"></td>
        <td class="adm-actions"><button class="btn btn-sm" data-up="${i}" ${i ? '' : 'disabled'} aria-label="${te('admin.content.render_nav.move_up')}">↑</button><button class="btn btn-sm" data-down="${i}" ${i < cats.length - 1 ? '' : 'disabled'} aria-label="${te('admin.content.render_nav.move_down')}">↓</button></td></tr>`).join('')}</tbody></table></div>
      <div class="card adm-card"><h3>${te('admin.content.render_nav.featured_tab')}</h3><p class="muted">${te('admin.content.render_nav.the_highlighted_tab_after_trending')}</p>
      ${formHtml([{ name: 'label', label: tx('admin.content.render_nav.label'), required: true, value: cfg.featured.label }, { name: 'href', label: tx('admin.content.render_nav.link'), required: true, value: cfg.featured.href }, { name: 'color', label: tx('admin.content.render_nav.colour_blank_theme_default'), type: 'color', value: cfg.featured.color }], { submit: tx('admin.content.render_nav.save_navigation'), id: 'nav', testid: 'nav-form' })}</div></div>`;
    const fields = [{ name: 'label', required: true }, { name: 'href', required: true }, { name: 'color', type: 'color' }];
    wireForm(body.querySelector('form'), fields, async (v) => {
      const out = await put('/nav', { categories: cats, featured: v });
      cfg.featured = out.featured; cats = out.categories.map((c) => ({ ...c }));
      toast(tx('admin.content.render_nav.navigation_saved')); draw();
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
