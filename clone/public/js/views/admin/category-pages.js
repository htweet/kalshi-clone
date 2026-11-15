// Admin › Category pages (CLONE_SPEC.md §42.5, ground rule 6): per category the layout (site default / new / classic),
// the featured carousel (size, pinned events in order, exclusions; the rest is picked by volume), the sidebar groups
// (automatic or custom: label, what the group matches, icon), the hub link, the Top-cities strip, the docked ticket,
// outcome avatars and the banner. Each choice shows its recommended default and explanation; every save needs a reason
// and is written to the hash-chained audit log by the server.
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.category-strings.js';
import { esc, get, put, toast, formHtml, wireForm, section, badge, fmtTime, confirmAction } from './ui.js';

// One custom group per line: "Label | type:value1,value2 | glyph or img:<media id> | #colour".
const groupLine = (g) => [g.label, `${g.filter.type}:${g.filter.values.join(',')}`, g.icon && g.icon.asset_id ? `img:${g.icon.asset_id}` : (g.icon && g.icon.glyph) || '', (g.icon && g.icon.color) || ''].join(' | ').replace(/( \| )+$/, '');
function parseGroups(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
    const [label, filter = '', icon = '', color = ''] = line.split('|').map((x) => x.trim());
    const c = filter.indexOf(':');
    const g = { id: `g${i + 1}`, label, filter: { type: c > 0 ? filter.slice(0, c).trim() : filter, values: c > 0 ? filter.slice(c + 1).split(',').map((x) => x.trim()).filter(Boolean) : [] }, icon: {} };
    if (icon.startsWith('img:')) g.icon.asset_id = icon.slice(4); else if (icon) g.icon.glyph = icon;
    if (color) g.icon.color = color;
    return g;
  });
}
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const onOff = (v) => (v ? tx('admin.category.on') : tx('admin.category.off'));

export async function render({ el, parts, navigate }) {
  const list = await get('/category_pages');
  const slug = parts[0] || list.categories[0].slug;
  const r = await get(`/category_pages/${encodeURIComponent(slug)}`);
  const c = r.config; const d = r.defaults; const h = r.help;
  el.innerHTML = section(tx('admin.category.title'), tx('admin.category.sub', { layout: r.site.layout, size: r.site.carousel_size }), `<a class="btn" href="/admin/owner_settings" data-link>${te('admin.category.owner_settings')}</a><a class="btn" href="/category/${esc(slug)}" data-link data-testid="cp-admin-view">${te('admin.category.view')}</a>`)
    + `<div class="adm-toolbar"><label class="field">${te('admin.category.category')}<select data-testid="cp-admin-category">${list.categories.map((x) => `<option value="${esc(x.slug)}"${x.slug === slug ? ' selected' : ''}>${esc(x.name)}${x.customised ? ' *' : ''}</option>`).join('')}</select></label>
      <span class="faint">${te('admin.category.effective', { layout: esc(r.effective_layout) })}${r.customised ? ` · ${te('admin.category.updated', { time: esc(fmtTime(r.updated_at)) })}` : ` · ${badge(tx('admin.category.defaults'), 'ok')}`}</span></div><div data-form></div>
    <h3>${te('admin.category.featured_now')}</h3><ol class="faint" data-testid="cp-admin-featured">${r.featured_now.map((e) => `<li><code>${esc(e.event_ticker)}</code> ${esc(e.title)} ${e.pinned ? badge(tx('admin.category.pinned'), 'ok') : ''}</li>`).join('') || `<li>${te('admin.category.none')}</li>`}</ol>
    <h3>${te('admin.category.series')}</h3><p class="faint">${r.series.map((s) => `<code>${esc(s.ticker)}</code> ${esc(s.title)} (${esc(s.tags.join(', '))})`).join(' · ')}</p>
    <h3>${te('admin.category.auto_groups')}</h3><pre class="faint" data-testid="cp-admin-auto">${esc(r.auto_groups.map((g) => groupLine({ ...g, icon: {} })).join('\n'))}</pre>
    <h3>${te('admin.category.history')}</h3><ul class="faint">${r.history.map((x) => `<li>${esc(fmtTime(x.time))} · ${esc(x.actor_email || '')} · ${esc(x.reason)}</li>`).join('') || `<li>${te('admin.category.none')}</li>`}</ul>`;
  el.querySelector('[data-testid=cp-admin-category]').onchange = (e) => navigate(`/admin/category_pages/${e.target.value}`);
  const rec = (k, v) => `${h[k].help} ${tx('admin.category.recommended', { value: v })}`;
  const fields = [
    { name: 'layout', label: h.layout.label, type: 'select', value: c.layout, options: [['inherit', tx('admin.category.inherit', { value: r.site.layout })], ['new', tx('admin.category.layout_new')], ['classic', tx('admin.category.layout_classic')]], hint: rec('layout', tx('admin.category.inherit', { value: r.site.layout })) },
    { name: 'carousel_size', label: h.carousel_size.label, type: 'number', value: c.carousel_size ?? '', hint: rec('carousel_size', tx('admin.category.inherit', { value: r.site.carousel_size })) },
    { name: 'top_cities', label: h.top_cities.label, type: 'checkbox', value: c.top_cities, hint: '' },
    { name: 'docked_ticket', label: h.docked_ticket.label, type: 'checkbox', value: c.docked_ticket },
    { name: 'outcome_avatars', label: h.outcome_avatars.label, type: 'checkbox', value: c.outcome_avatars },
    { name: 'pins', label: h.pins.label, type: 'textarea', rows: 3, value: c.featured.pins.join('\n'), hint: h.pins.help, span: true },
    { name: 'exclude', label: h.exclude.label, type: 'textarea', rows: 2, value: c.featured.exclude.join('\n'), hint: h.exclude.help, span: true },
    { name: 'grouping', label: h.groups.label, type: 'select', value: c.grouping, options: [['auto', tx('admin.category.grouping_auto')], ['custom', tx('admin.category.grouping_custom')]], hint: rec('groups', tx('admin.category.grouping_auto')) },
    { name: 'groups', label: tx('admin.category.groups'), type: 'textarea', rows: 5, value: c.groups.map(groupLine).join('\n'), hint: `${h.groups.help} ${tx('admin.category.groups_format', { glyphs: r.glyphs.join(', ') })}`, span: true },
    { name: 'hub_label', label: tx('admin.category.hub_label'), value: c.hub ? c.hub.label : '', hint: h.hub.help },
    { name: 'hub_href', label: tx('admin.category.hub_href'), value: c.hub ? c.hub.href : '' },
    { name: 'banner_enabled', label: h.banner.label, type: 'checkbox', value: c.banner.enabled, span: true },
    { name: 'banner_title', label: tx('admin.category.banner_title'), value: c.banner.title, hint: h.banner.help },
    { name: 'banner_body', label: tx('admin.category.banner_body'), value: c.banner.body },
    { name: 'banner_cta_label', label: tx('admin.category.banner_cta_label'), value: c.banner.cta_label },
    { name: 'banner_cta_href', label: tx('admin.category.banner_cta_href'), value: c.banner.cta_href },
    { name: 'banner_link_label', label: tx('admin.category.banner_link_label'), value: c.banner.link_label },
    { name: 'banner_link_href', label: tx('admin.category.banner_link_href'), value: c.banner.link_href },
    { name: 'reason', label: tx('admin.category.reason'), required: true, span: true },
  ];
  for (const k of ['top_cities', 'docked_ticket', 'outcome_avatars']) fields.find((x) => x.name === k).label = `${h[k].label} — ${h[k].help} ${tx('admin.category.recommended', { value: onOff(d[k]) })}`;
  const box = el.querySelector('[data-form]');
  box.innerHTML = formHtml(fields, { id: 'cpa', submit: tx('admin.category.save'), testid: 'cp-admin-form', extra: `<button class="btn" type="button" data-reset data-testid="cp-admin-reset">${te('admin.category.reset')}</button>` });
  wireForm(box.querySelector('form'), fields, async (v) => {
    const config = { layout: v.layout, carousel_size: v.carousel_size === '' ? null : v.carousel_size, top_cities: v.top_cities, docked_ticket: v.docked_ticket, outcome_avatars: v.outcome_avatars,
      featured: { pins: lines(v.pins), exclude: lines(v.exclude) }, grouping: v.grouping, groups: parseGroups(v.groups),
      hub: v.hub_label || v.hub_href ? { label: v.hub_label, href: v.hub_href } : null,
      banner: { enabled: v.banner_enabled, title: v.banner_title, body: v.banner_body, cta_label: v.banner_cta_label, cta_href: v.banner_cta_href, link_label: v.banner_link_label, link_href: v.banner_link_href } };
    await put(`/category_pages/${encodeURIComponent(slug)}`, { config, reason: v.reason });
    toast(tx('admin.category.saved'));
    render({ el, parts: [slug], navigate });
  });
  box.querySelector('[data-reset]').onclick = async () => {
    const ok = await confirmAction({ title: tx('admin.category.reset_title'), confirm: tx('admin.category.reset'), reason: true });
    if (!ok) return;
    try { await put(`/category_pages/${encodeURIComponent(slug)}`, { reset: true, reason: ok.reason }); toast(tx('admin.category.saved')); render({ el, parts: [slug], navigate }); } catch (ex) { toast(ex.message, 'error'); }
  };
}
