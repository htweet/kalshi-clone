// Admin › Content › Landing page (CLONE_SPEC.md §44.4): the layout variants (who sees which home), the landing page's
// sections, Weekly forecasts chips, Markets to watch, the Monthly forecast and, per event or series, the hero context
// text, image (from the media library) and "keep out of the automatic slides". Hero pins are the Hero carousel tab.
import { t as tx, te } from '../../i18n.js';
import '../../content/admin.landing-strings.js';
import { esc, get, put, del, call, toast, badge, dialog, formHtml, wireForm, fmtMoney } from './ui.js';
import { catLabel } from '../../lib.js';

const SECTION_LABEL = (s) => tx(`admin.landing.section.${s}`);

export async function render(body) {
  let r = await get('/landing');
  const draw = () => {
    const c = r.config;
    const evOptions = [['', tx('admin.landing.automatic')], ...r.events.map((e) => [e.event_ticker, `${e.title} (${e.event_ticker})`])];
    body.innerHTML = `<div class="adm-two" data-testid="landing-editor">
      <div class="card adm-card" data-testid="landing-variants"><h3>${te('admin.landing.variants')}</h3><p class="muted">${te('admin.landing.variants_help')}</p>
        ${[['visitors', 'layout.home_visitors'], ['members', 'layout.home_members']].map(([who, key]) => `<div class="adm-row"><span>${te(`admin.landing.variant_${who}`)}</span>
          <select class="adm-input" data-variant="${esc(key)}" data-testid="variant-${who}" aria-label="${te(`admin.landing.variant_${who}`)}">${['classic', 'new'].map((v) => `<option value="${v}" ${r.variants[key] === v ? 'selected' : ''}>${te(`admin.landing.variant.${v}`)}</option>`).join('')}</select></div>`).join('')}
        <p class="faint">${te('admin.landing.variants_more')} <a href="/admin/owner_settings" data-link>${te('admin.landing.owner_settings')}</a></p></div>
      <div class="card adm-card" data-testid="landing-sections"><h3>${te('admin.landing.sections')}</h3><p class="muted">${te('admin.landing.sections_help')}</p>
        <ol class="adm-order">${c.sections.map((s, i) => `<li data-sec="${esc(s)}"><label class="adm-check"><input type="checkbox" data-show="${esc(s)}" ${c.hidden.includes(s) ? '' : 'checked'}> <span>${esc(SECTION_LABEL(s))}</span></label>
          <span class="adm-actions"><button class="btn btn-sm" data-up="${i}" ${i ? '' : 'disabled'} aria-label="${te('admin.landing.move_up')}">↑</button><button class="btn btn-sm" data-down="${i}" ${i < c.sections.length - 1 ? '' : 'disabled'} aria-label="${te('admin.landing.move_down')}">↓</button></span></li>`).join('')}</ol>
        ${formHtml([
    { name: 'hero_count', label: tx('admin.landing.hero_count'), type: 'number', value: c.hero_count },
    { name: 'category_count', label: tx('admin.landing.category_count'), type: 'number', value: c.category_count },
    { name: 'hero_fill_auto', label: tx('admin.landing.hero_fill_auto'), type: 'checkbox', value: c.hero_fill_auto, span: true },
    { name: 'chips_auto', label: tx('admin.landing.chips_auto'), type: 'checkbox', value: c.chips_auto, span: true },
    { name: 'monthly_event', label: tx('admin.landing.monthly_event'), type: 'select', options: evOptions, value: c.monthly.event_ticker, span: true },
    { name: 'monthly_title', label: tx('admin.landing.monthly_title'), value: c.monthly.title, span: true, hint: tx('admin.landing.monthly_title_hint') },
    { name: 'watch_1', label: tx('admin.landing.watch', { n: 1 }), type: 'select', options: evOptions, value: c.watch_pins[0] || '' },
    { name: 'watch_2', label: tx('admin.landing.watch', { n: 2 }), type: 'select', options: evOptions, value: c.watch_pins[1] || '' },
    { name: 'watch_3', label: tx('admin.landing.watch', { n: 3 }), type: 'select', options: evOptions, value: c.watch_pins[2] || '' },
  ], { submit: tx('admin.landing.save'), id: 'lp', testid: 'landing-config-form' })}</div>
      <div class="card adm-card" data-testid="landing-chips"><h3>${te('admin.landing.chips')}</h3><p class="muted">${te('admin.landing.chips_help')}</p>
        <ol class="adm-order" data-testid="chip-pins">${c.chip_pins.map((p, i) => `<li><span>${esc(p.label || r.markets.find((m) => m.ticker === p.market_ticker)?.event_title || p.market_ticker)} <code class="faint">${esc(p.market_ticker)}</code></span><button class="btn btn-sm btn-ghost btn-danger" data-chip-rm="${i}" aria-label="${te('admin.landing.remove')}">✕</button></li>`).join('')}</ol>
        <div class="adm-form-grid"><label class="field span2"><span>${te('admin.landing.chip_market')}</span><select class="adm-input" data-chip-market data-testid="chip-market">${r.markets.map((m) => `<option value="${esc(m.ticker)}">${esc(m.event_title)} · ${esc(m.yes_sub_title)}</option>`).join('')}</select></label>
          <label class="field span2"><span>${te('admin.landing.chip_label')}</span><input class="adm-input" data-chip-label maxlength="32" data-testid="chip-label"></label></div>
        <div class="adm-form-actions"><button class="btn" data-chip-add data-testid="chip-add">${te('admin.landing.chip_add')}</button></div>
        <p class="faint">${te('admin.landing.showing')} ${r.chips.map((x) => `${esc(x.label)}${x.pinned ? ' ★' : ''}`).join(' · ') || '—'}</p></div>
      <div class="card adm-card" data-testid="landing-hero"><h3>${te('admin.landing.hero')}</h3><p class="muted">${te('admin.landing.hero_help')} <a href="/admin/content/hero" data-link>${te('admin.landing.hero_tab')}</a></p>
        <ol class="adm-order">${r.hero.map((h) => `<li><span>${esc(h.title)}</span>${h.pinned ? badge(tx('admin.landing.pinned'), 'ok') : badge(tx('admin.landing.auto'))}</li>`).join('')}</ol></div>
    </div>
    <div class="card adm-card mt-16"><h3>${te('admin.landing.events')}</h3><p class="muted">${te('admin.landing.events_help')}</p>
      <table class="table adm-grid" data-testid="landing-events"><thead><tr><th>${te('admin.landing.event')}</th><th>${te('admin.landing.category')}</th><th class="num">${te('admin.landing.volume')}</th><th>${te('admin.landing.state')}</th><th></th></tr></thead><tbody>
      ${r.events.map((e) => `<tr data-event="${esc(e.event_ticker)}"><td>${esc(e.title)} <code class="faint">${esc(e.event_ticker)}</code></td><td>${esc(catLabel(e.category))}</td><td class="num">${esc(fmtMoney(e.dollar_volume))}</td>
        <td>${e.pinned ? badge(tx('admin.landing.pinned'), 'ok') : ''}${e.content?.hero_exclude ? badge(tx('admin.landing.excluded'), 'warn') : ''}${e.content?.context ? badge(tx('admin.landing.own_text')) : ''}${e.content?.image ? badge(tx('admin.landing.own_image')) : ''}</td>
        <td class="adm-actions"><button class="btn btn-sm" data-pin="${esc(e.event_ticker)}" data-testid="landing-pin">${e.pinned ? te('admin.landing.unpin') : te('admin.landing.pin')}</button><button class="btn btn-sm" data-edit="${esc(e.event_ticker)}" data-testid="landing-edit">${te('admin.landing.edit')}</button></td></tr>`).join('')}</tbody></table></div>`;

    const sec = body.querySelector('[data-testid=landing-sections]');
    const fields = [{ name: 'hero_count', type: 'number' }, { name: 'category_count', type: 'number' }, { name: 'hero_fill_auto', type: 'checkbox' }, { name: 'chips_auto', type: 'checkbox' }, { name: 'monthly_event' }, { name: 'monthly_title' }, { name: 'watch_1' }, { name: 'watch_2' }, { name: 'watch_3' }];
    wireForm(sec.querySelector('form'), fields, async (v) => {
      const out = await put('/landing/config', { sections: c.sections, hidden: c.sections.filter((s) => !sec.querySelector(`[data-show="${s}"]`).checked), hero_count: v.hero_count, category_count: v.category_count, hero_fill_auto: v.hero_fill_auto, chips_auto: v.chips_auto,
        monthly: { event_ticker: v.monthly_event, title: v.monthly_title }, watch_pins: [v.watch_1, v.watch_2, v.watch_3].filter(Boolean) });
      r.config = out.config; toast(tx('admin.landing.saved')); r = await get('/landing'); draw();
    });
  };
  draw();
  const saveCfg = async (patch) => { try { await put('/landing/config', patch); r = await get('/landing'); draw(); toast(tx('admin.landing.saved')); } catch (ex) { toast(ex.message, 'error'); } };
  body.addEventListener('change', async (e) => {
    const s = e.target.closest('[data-variant]');
    if (!s) return;
    try { await call('PUT', `/owner_settings/${s.dataset.variant}`, { value: s.value, reason: tx('admin.landing.variant_reason') }); toast(tx('admin.landing.saved')); } catch (ex) { toast(ex.message, 'error'); r = await get('/landing'); draw(); }
  });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const c = r.config;
    if (b.dataset.up || b.dataset.down) {
      const i = Number(b.dataset.up ?? b.dataset.down); const j = b.dataset.up ? i - 1 : i + 1;
      const s = [...c.sections]; [s[i], s[j]] = [s[j], s[i]];
      await saveCfg({ sections: s });
    } else if (b.dataset.chipRm) {
      await saveCfg({ chip_pins: c.chip_pins.filter((_, i) => i !== Number(b.dataset.chipRm)) });
    } else if (b.dataset.chipAdd !== undefined) {
      await saveCfg({ chip_pins: [...c.chip_pins, { market_ticker: body.querySelector('[data-chip-market]').value, label: body.querySelector('[data-chip-label]').value }] });
    } else if (b.dataset.pin) {
      try {
        const h = await get('/hero');
        const sel = h.selected.map((x) => x.event_ticker);
        const next = sel.includes(b.dataset.pin) ? sel.filter((t) => t !== b.dataset.pin) : [...sel, b.dataset.pin];
        await put('/hero', { event_tickers: next });
        r = await get('/landing'); draw(); toast(tx('admin.landing.saved'));
      } catch (ex) { toast(ex.message, 'error'); }
    } else if (b.dataset.edit) openEditor(r.events.find((x) => x.event_ticker === b.dataset.edit));
  });

  function openEditor(ev) {
    const cur = ev.content || {};
    const fields = [
      { name: 'context', label: tx('admin.landing.context'), type: 'textarea', rows: 5, max: 600, value: cur.context || '', placeholder: ev.context_default, span: true, hint: tx('admin.landing.context_hint') },
      { name: 'image_asset_id', label: tx('admin.landing.image'), type: 'select', options: [['', tx('admin.landing.image_none')], ...r.media.map((m) => [m.id, `${m.name || m.id} (${m.width}×${m.height})`])], value: cur.image_asset_id || '', span: true, hint: tx('admin.landing.image_hint') },
      { name: 'image_alt', label: tx('admin.landing.image_alt'), value: cur.image_alt || '', span: true },
      { name: 'hero_exclude', label: tx('admin.landing.exclude'), type: 'checkbox', value: !!cur.hero_exclude, span: true },
    ];
    const d = dialog(`<h3>${esc(ev.title)}</h3>${formHtml(fields, { submit: tx('admin.landing.save'), id: 'lpe', testid: 'landing-content-form', extra: `<button class="btn" type="button" data-reset data-testid="landing-content-reset">${te('admin.landing.reset')}</button><button class="btn" type="button" data-close>${te('admin.landing.cancel')}</button>` })}`, { wide: true });
    d.querySelector('[data-close]').onclick = () => d.close();
    d.querySelector('[data-reset]').onclick = async () => { try { await del(`/landing/content/event/${encodeURIComponent(ev.event_ticker)}`); d.close(); r = await get('/landing'); draw(); toast(tx('admin.landing.saved')); } catch (ex) { toast(ex.message, 'error'); } };
    wireForm(d.querySelector('form'), fields, async (v) => {
      await put(`/landing/content/event/${encodeURIComponent(ev.event_ticker)}`, { context: v.context, image_asset_id: v.image_asset_id || null, image_alt: v.image_alt, hero_exclude: v.hero_exclude });
      d.close(); r = await get('/landing'); draw(); toast(tx('admin.landing.saved'));
    });
  }
}
