// Social completion on the client (PLAN Phase 2, CLONE_SPEC.md §24): the post ⋯ menu (copy link, share, edit within
// the window, delete, mute, report), Read more, the share button (Web Share API, else copy link), the sticker picker,
// the composer's "+ Add a position" / sticker / audience controls, targeted promos, event-page extras (follow the
// event, price-move alerts) and the "N new posts" timeline badge.
//
// Security: user content goes through esc() inside templates (checked by the parlance/no-unescaped-html lint rule) or
// is written with textContent through h(); sticker images only ever come from the server's sticker table URLs.
import { t as tx, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/social2-strings.js';
import { t as tc } from '../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { api } from '../api.js';
import { session } from '../store.js';
import { vars } from '../dynstyle.js';
import { esc, toast, pxCents, priceUnit } from '../lib.js';
import { postCard } from './components.js';
import { reportDialog } from './admin/site.js';

// Tiny DOM builder: attributes come from code, string children become text nodes (never parsed as HTML).
export function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}

export const REACTIONS = [['up', '👍', ts('social2.reactions.thumbs_up')], ['heart', '❤️', ts('social2.reactions.love')], ['laugh', '😂', ts('social2.reactions.funny')], ['wow', '😮', ts('social2.reactions.wow')], ['fire', '🔥', ts('social2.reactions.fire')], ['chart', '📈', 'Bullish']];

// ------------------------------------------------------------------ caches
let stickerCache = null;
export function loadStickers() {
  if (!stickerCache) stickerCache = api.stickers().then((r) => r.stickers).catch((e) => { stickerCache = null; throw e; });
  return stickerCache;
}
let muteCache = null; let muteUid = null;
export function mutedNicks() {
  if (!session.user) return Promise.resolve(new Set());
  if (muteUid !== session.uid) { muteCache = null; muteUid = session.uid; }
  if (!muteCache) muteCache = api.mutes(session.uid).then((r) => new Set(r.mutes.map((m) => m.nickname.toLowerCase()))).catch(() => new Set());
  return muteCache;
}
export const invalidateMutes = () => { muteCache = null; };

// ------------------------------------------------------------------ sticker picker (popover)
let picker = null;
function closePicker() { picker?.remove(); picker = null; }
document.addEventListener('click', (e) => { if (picker && !e.target.closest('.sticker-picker') && !e.target.closest('[data-sticker-btn]')) closePicker(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });
export async function openStickerPicker(anchor, onPick) {
  if (picker && picker.dataset.for === anchor.dataset.stickerBtn) { closePicker(); return; }
  closePicker();
  let list;
  try { list = await loadStickers(); } catch (e) { toast(e.message, 'error'); return; }
  const box = h('div', { class: 'sticker-picker', role: 'menu', 'aria-label': tx('social2.open_sticker_picker.stickers'), 'data-testid': 'sticker-picker', 'data-for': anchor.dataset.stickerBtn || '' });
  for (const s of list) {
    const b = h('button', { type: 'button', role: 'menuitem', class: 'sticker-opt', 'data-testid': `sticker-opt-${s.id}`, title: s.label, 'aria-label': s.label }, h('img', { src: s.url, alt: '', width: '56', height: '56' }));
    b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); closePicker(); onPick(s); };
    box.append(b);
  }
  if (!list.length) box.append(h('div', { class: 'faint p-8' }, tx('social2.open_sticker_picker.no_stickers_are_available_right')));
  box.append(h('div', { class: 'faint sticker-note' }, tx('social2.open_sticker_picker.parlance_stickers_gif_search_is')));
  anchor.insertAdjacentElement('afterend', box);
  picker = box;
  box.querySelector('button')?.focus();
}

// ------------------------------------------------------------------ share + copy link
const absolute = (path) => new URL(path, location.origin).href;
export async function copyLink(path) {
  const url = absolute(path);
  try { await navigator.clipboard.writeText(url); toast(tx('social2.copy_link.link_copied')); } catch { toast(url); }
  return url;
}
export async function sharePost(path, title = tx('social2.share_post.a_post_on_parlance')) {
  const url = absolute(path);
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  await copyLink(path);
}

// ------------------------------------------------------------------ post ⋯ menu, Read more, share (every post card on any page)
let pmenu = null;
const closePostMenu = () => { pmenu?.remove(); pmenu = null; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePostMenu(); });
document.addEventListener('click', (e) => {
  const readMore = e.target.closest('[data-act=read-more]');
  if (readMore) {
    const body = readMore.closest('[data-post]')?.querySelector('[data-testid=post-body]');
    if (body) { const open = body.classList.toggle('clamped') === false; readMore.textContent = open ? tx('social2.common.show_less') : tx('social2.common.read_more'); readMore.setAttribute('aria-expanded', String(open)); }
    return;
  }
  const share = e.target.closest('[data-act=share]');
  if (share && share.closest('[data-post]')) { sharePost(share.closest('[data-post]').dataset.share); return; }
  const btn = e.target.closest('[data-post-more]');
  if (!btn) { if (pmenu && !e.target.closest('.post-menu')) closePostMenu(); return; }
  e.preventDefault(); e.stopPropagation();
  if (pmenu && pmenu.dataset.for === btn.dataset.postMore) { closePostMenu(); return; }
  closePostMenu();
  const card = btn.closest('[data-post]');
  const mine = card.dataset.mine === '1';
  const nick = card.dataset.nick;
  const editable = mine && card.dataset.editableUntil && Date.parse(card.dataset.editableUntil) > Date.now();
  const menu = h('div', { class: 'menu post-menu', role: 'menu', 'data-for': btn.dataset.postMore, 'data-testid': 'post-menu-list' });
  const item = (label, testid, fn) => { const b = h('button', { type: 'button', role: 'menuitem', 'data-testid': testid }, label); b.onclick = (ev) => { ev.stopPropagation(); closePostMenu(); fn(); }; menu.append(b); };
  item(tx('social2.common.copy_link'), 'post-copy-link', () => copyLink(card.dataset.share));
  if (navigator.share) item(tx('social2.common.share'), 'post-share-native', () => sharePost(card.dataset.share));
  if (!session.user) {
    menu.append(h('a', { href: `/sign-in?next=${encodeURIComponent(location.pathname)}`, 'data-link': '' }, tx('social2.common.log_in_to_report_or')));
  } else if (mine) {
    if (editable) item(tx('social2.common.edit_post'), 'post-edit', () => startEdit(card));
    item(tx('social2.common.delete_post'), 'post-delete', () => card.querySelector('[data-act=delete]')?.click());
  } else {
    const muted = card.classList.contains('muted-author');
    item(muted ? tx('social2.common.unmute', { nick }) : tx('social2.common.mute', { nick }), 'post-mute', () => toggleMute(nick, !muted));
    item(tx('social2.common.report_post'), 'report-post', () => reportDialog('post', card.dataset.post));
  }
  card.querySelector('.post-head').append(menu);
  pmenu = menu;
  menu.querySelector('button,a')?.focus();
}, true);

export async function toggleMute(nick, on) {
  try {
    if (on) await api.mute(session.uid, nick); else await api.unmute(session.uid, nick);
    invalidateMutes();
    toast(on ? tx('social2.toggle_mute.muted_their_posts_replies_and', { nick }) : tx('social2.toggle_mute.unmuted', { nick }));
    const keep = location.pathname.toLowerCase() === `/social/profile/${nick}`.toLowerCase() || location.pathname.startsWith('/social/post/');
    for (const c of document.querySelectorAll('[data-post]')) {
      if (c.dataset.nick.toLowerCase() !== nick.toLowerCase()) continue;
      if (on && !keep) c.remove(); else c.classList.toggle('muted-author', on);
    }
    window.dispatchEvent(new CustomEvent('parlance:mutes-changed', { detail: { nickname: nick, muted: on } }));
  } catch (ex) { toast(ex.message, 'error'); }
}

function startEdit(card) {
  const pid = card.dataset.post;
  if (card.querySelector('[data-edit-form]')) return;
  const bodyEl = card.querySelector('[data-testid=post-body]');
  const ta = h('textarea', { maxlength: '500', 'aria-label': tx('social2.start_edit.edit_post'), 'data-testid': 'post-edit-input', rows: '3' });
  ta.value = bodyEl ? bodyEl.textContent : '';
  const err = h('div', { class: 'form-error', role: 'alert', 'data-testid': 'post-edit-error' });
  const save = h('button', { class: 'btn btn-primary btn-sm', type: 'submit', 'data-testid': 'post-edit-save' }, tx('social2.start_edit.save'));
  const cancel = h('button', { class: 'btn btn-sm', type: 'button' }, tx('social2.start_edit.cancel'));
  const form = h('form', { class: 'post-edit', 'data-edit-form': '' }, ta, h('div', { class: 'd-flex gap-6 mt-6 ai-center fw-wrap' }, save, cancel, h('span', { class: 'faint' }, tx('social2.start_edit.edits_show_edited_moderators_can'))), err);
  const anchor = bodyEl || card.querySelector('.post-head');
  anchor.insertAdjacentElement('afterend', form);
  if (bodyEl) bodyEl.hidden = true;
  card.querySelector('[data-act=read-more]')?.setAttribute('hidden', '');
  ta.focus();
  cancel.onclick = () => { form.remove(); if (bodyEl) bodyEl.hidden = false; card.querySelector('[data-act=read-more]')?.removeAttribute('hidden'); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const { post } = await api.editPost(session.uid, pid, ta.value);
      const tmp = document.createElement('div');
      tmp.innerHTML = postCard(post, { showEvent: !!card.querySelector('.post-event') });
      card.replaceWith(tmp.firstElementChild);
      toast(tx('social2.start_edit.post_updated'));
    } catch (ex) { err.textContent = ex.code === 'edit_window_closed' ? tx('social2.start_edit.the_10_minute_edit_window') : ex.message; save.disabled = false; }
  };
}

// ------------------------------------------------------------------ composer extras: sticker, "+ Add a position", audience
export function composerExtrasHtml() {
  return `<div class="composer-extras"><button class="btn btn-sm btn-ghost" type="button" data-sticker-btn="composer" data-testid="composer-sticker" aria-label="${te('social2.composer_extras_html.add_a_sticker')}">${te('social2.composer_extras_html.gif_sticker')}</button>
    <button class="btn btn-sm btn-ghost" type="button" data-add-position data-testid="add-position">${te('social2.composer_extras_html.add_a_position')}</button>
    <label class="audience"><span class="faint">${te('social2.composer_extras_html.audience')}</span><select data-visibility data-testid="composer-visibility" aria-label="${te('social2.composer_extras_html.who_can_see_this_post')}"><option value="public">${te('social2.composer_extras_html.everyone')}</option><option value="circle">${te('social2.composer_extras_html.inner_circle')}</option></select></label>
    <span class="composer-chips" data-chips></span></div><div data-pos-list></div>`;
}
export function wireComposerExtras(form) {
  const st = { sticker: null, position: null };
  const chips = form.querySelector('[data-chips]');
  if (!chips) return null;
  const draw = () => {
    chips.replaceChildren();
    if (st.sticker) {
      const x = h('button', { type: 'button', class: 'chip-x', 'aria-label': tx('social2.wire_composer_extras.remove_sticker') }, '✕'); x.onclick = () => { st.sticker = null; draw(); };
      chips.append(h('span', { class: 'composer-chip', 'data-testid': 'composer-sticker-chip' }, h('img', { src: st.sticker.url, alt: '', width: '28', height: '28' }), st.sticker.label, x));
    }
    if (st.position) {
      const x = h('button', { type: 'button', class: 'chip-x', 'aria-label': tx('social2.wire_composer_extras.remove_position') }, '✕'); x.onclick = () => { st.position = null; draw(); };
      chips.append(h('span', { class: `composer-chip pos-tag pos-${st.position.side}`, 'data-testid': 'composer-position-chip' }, st.position.label, x));
    }
  };
  form.querySelector('[data-sticker-btn]').onclick = (e) => openStickerPicker(e.currentTarget, (s) => { st.sticker = s; draw(); });
  const posList = form.querySelector('[data-pos-list]');
  form.querySelector('[data-add-position]').onclick = async () => {
    if (posList.childNodes.length) { posList.replaceChildren(); return; }
    let rows = [];
    try { rows = (await api.positionTags(session.uid)).positions; } catch (ex) { toast(ex.message, 'error'); return; }
    const box = h('div', { class: 'pos-picker', 'data-testid': 'position-picker', role: 'listbox', 'aria-label': tx('social2.wire_composer_extras.your_positions') });
    if (!rows.length) box.append(h('div', { class: 'faint' }, tx('social2.wire_composer_extras.trade_a_market_first_you')));
    for (const r of rows) {
      const b = h('button', { type: 'button', role: 'option', class: `pos-opt pos-${r.side}`, 'data-testid': 'position-opt', 'data-ticker': r.market_ticker, 'data-side': r.side }, r.label, h('span', { class: 'faint' }, r.held === 'current' ? (' ' + tx('social2.wire_composer_extras.holding', { position_fp: r.position_fp })) : (' ' + tx('social2.wire_composer_extras.held_before'))));
      b.onclick = () => { st.position = r; posList.replaceChildren(); draw(); };
      box.append(b);
    }
    posList.replaceChildren(box);
  };
  return {
    get: () => ({ sticker_id: st.sticker ? st.sticker.id : undefined, position: st.position ? { market_ticker: st.position.market_ticker, side: st.position.side } : undefined, visibility: form.querySelector('[data-visibility]')?.value || 'public' }),
    has: () => !!st.sticker,
    reset: () => { st.sticker = null; st.position = null; posList.replaceChildren(); draw(); },
  };
}

// ------------------------------------------------------------------ targeted promos (G8): series and category placements
export async function renderPromos(host, opts) {
  if (!host) return;
  try {
    const { promos } = await api.promos(opts);
    if (!host.isConnected) return;
    host.innerHTML = promos.map((p) => `<a class="card promo targeted-promo v-bg" href="${esc(p.link)}" ${String(p.link).startsWith('/') ? 'data-link' : 'target="_blank" rel="noopener noreferrer"'} data-testid="targeted-promo"${vars({ '--bg': p.color })}>
      ${p.overline ? `<span class="overline">${esc(p.overline)}</span>` : ''}<b>${esc(p.title)}</b>${p.subtitle ? `<span>${esc(p.subtitle)}</span>` : ''}</a>`).join('');
  } catch { /* promos are optional */ }
}

// ------------------------------------------------------------------ event page extras: follow the event, price-move alerts
export function mountEventExtras({ el, ev, market }) {
  const actions = el.querySelector('.ev-actions');
  if (!actions || !ev) return () => {};
  const T = ev.event_ticker;
  const follow = h('button', { class: 'icon-btn ev-follow', type: 'button', 'data-testid': 'follow-event', 'aria-pressed': 'false', title: tx('social2.mount_event_extras.follow_this_event_in_your') }, tx('social2.mount_event_extras.follow'));
  const move = h('button', { class: 'icon-btn ev-move', type: 'button', 'data-testid': 'move-alert-btn', title: tx('social2.mount_event_extras.price_movement_alert') }, tx('social2.mount_event_extras.move_alert'));
  actions.append(follow, move);
  let on = false;
  const draw = () => { follow.textContent = on ? tx('social2.mount_event_extras.following') : tx('social2.mount_event_extras.follow'); follow.setAttribute('aria-pressed', String(on)); follow.classList.toggle('on', on); };
  if (session.user) api.topics(session.uid).then((r) => { on = r.topics.some((t) => t.kind === 'event' && t.value === T); if (follow.isConnected) draw(); }).catch(() => {});
  follow.onclick = async () => {
    if (!session.user) { location.assign(`/sign-in?next=${encodeURIComponent(location.pathname)}`); return; }
    try { if (on) await api.unfollowTopic(session.uid, 'event', T); else await api.followTopic(session.uid, 'event', T); on = !on; draw(); toast(on ? tx('social2.mount_event_extras.following_this_event_posts_about') : tx('social2.mount_event_extras.unfollowed')); } catch (ex) { toast(ex.message, 'error'); }
  };
  move.onclick = () => {
    if (!session.user) { location.assign(`/sign-in?next=${encodeURIComponent(location.pathname)}`); return; }
    const m = market() || ev.markets[0];
    const d = document.createElement('dialog');
    d.className = 'adm-dialog';
    d.dataset.testid = 'move-alert-dialog';
    d.innerHTML = `<form method="dialog" class="adm-confirm"><h3>${te('social2.mount_event_extras.price_movement_alert')}</h3><p class="muted">${te('social2.mount_event_extras.yes_price_now', { yes_sub_title: esc(m.yes_sub_title), px_cents: esc(pxCents(Math.round(Number(m.last_price_dollars || 0) * 100))) })}</p>
      <label class="field"><span>${esc(tc('input.move_threshold', { unit: priceUnit() }))}</span><input name="threshold" type="number" min="1" max="99" value="5" required data-testid="move-threshold"></label>
      <label class="field"><span>${te('social2.mount_event_extras.within')}</span><select name="window" data-testid="move-window"><option value="5">${te('social2.mount_event_extras.n5_minutes')}</option><option value="15">${te('social2.mount_event_extras.n15_minutes')}</option><option value="60" selected>${te('social2.mount_event_extras.n1_hour')}</option><option value="240">${te('social2.mount_event_extras.n4_hours')}</option><option value="1440">${te('social2.mount_event_extras.n1_day')}</option></select></label>
      <label class="field"><span>${te('social2.mount_event_extras.direction')}</span><select name="direction"><option value="any">${te('social2.mount_event_extras.up_or_down')}</option><option value="up">${te('social2.mount_event_extras.up_only')}</option><option value="down">${te('social2.mount_event_extras.down_only')}</option></select></label>
      <div class="form-error" data-err role="alert"></div><div data-list class="move-list"></div>
      <div class="adm-form-actions"><button class="btn" type="button" data-cancel>${te('social2.mount_event_extras.close')}</button><button class="btn btn-primary" type="submit" data-testid="move-save">${te('social2.mount_event_extras.create_alert')}</button></div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => d.remove());
    d.querySelector('[data-cancel]').onclick = () => d.close();
    const list = d.querySelector('[data-list]');
    const drawList = async () => {
      const { subscriptions } = await api.moveSubs(session.uid, m.ticker);
      list.replaceChildren(...subscriptions.map((s) => {
        const x = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': tx('social2.mount_event_extras.delete_alert') }, tx('social2.mount_event_extras.delete'));
        x.onclick = async () => { await api.deleteMoveSub(session.uid, s.id); drawList(); };
        return h('div', { class: 'move-row', 'data-testid': 'move-sub' }, tx('social2.mount_event_extras.in', { px_cents: pxCents(s.threshold_cents), value: s.window_minutes >= 60 ? `${s.window_minutes / 60} h` : tx('social2.mount_event_extras.min', { window_minutes: s.window_minutes }), value_2: s.direction === 'any' ? '' : ` (${s.direction})` }), x);
      }));
    };
    drawList().catch(() => {});
    d.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api.addMoveSub(session.uid, { market_ticker: m.ticker, threshold_cents: Number(f.threshold.value), window_minutes: Number(f.window.value), direction: f.direction.value });
        toast(tx('social2.mount_event_extras.price_movement_alert_created')); d.querySelector('[data-err]').textContent = ''; drawList();
      } catch (ex) { d.querySelector('[data-err]').textContent = ex.message; }
    });
    d.showModal();
  };
  return () => { follow.remove(); move.remove(); };
}

// ------------------------------------------------------------------ "N new posts" (social/timeline_count)
export function startTimelineBadge({ host, feed, eventTicker, onShow }) {
  let since = Date.now();
  let stopped = false;
  const pill = h('button', { class: 'new-posts', type: 'button', 'data-testid': 'new-posts', hidden: true });
  host.prepend(pill);
  pill.onclick = () => { pill.hidden = true; since = Date.now(); onShow(); };
  const tick = async () => {
    if (stopped || document.hidden) return;
    try {
      const r = await api.timelineCount({ feed: feed(), since, event_ticker: eventTicker || undefined });
      if (stopped) return;
      pill.hidden = !r.count;
      pill.textContent = tx('social2.start_timeline_badge.new_post_show', { count: r.count, value: r.count === 1 ? '' : 's' });
    } catch { /* optional */ }
  };
  const iv = setInterval(tick, 10000);
  return { reset: () => { since = Date.now(); pill.hidden = true; }, poll: tick, stop: () => { stopped = true; clearInterval(iv); pill.remove(); } };
}
