// Social completion on the client (PLAN Phase 2, CLONE_SPEC.md §24): the post ⋯ menu (copy link, share, edit within
// the window, delete, mute, report), Read more, the share button (Web Share API, else copy link), the sticker picker,
// the composer's "+ Add a position" / sticker / audience controls, targeted promos, event-page extras (follow the
// event, price-move alerts) and the "N new posts" timeline badge.
//
// Security: user content goes through esc() inside templates (checked by the parlance/no-unescaped-html lint rule) or
// is written with textContent through h(); sticker images only ever come from the server's sticker table URLs.
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

export const REACTIONS = [['up', '👍', 'Thumbs up'], ['heart', '❤️', 'Love'], ['laugh', '😂', 'Funny'], ['wow', '😮', 'Wow'], ['fire', '🔥', 'Fire'], ['chart', '📈', 'Bullish']];

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
  const box = h('div', { class: 'sticker-picker', role: 'menu', 'aria-label': 'Stickers', 'data-testid': 'sticker-picker', 'data-for': anchor.dataset.stickerBtn || '' });
  for (const s of list) {
    const b = h('button', { type: 'button', role: 'menuitem', class: 'sticker-opt', 'data-testid': `sticker-opt-${s.id}`, title: s.label, 'aria-label': s.label }, h('img', { src: s.url, alt: '', width: '56', height: '56' }));
    b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); closePicker(); onPick(s); };
    box.append(b);
  }
  if (!list.length) box.append(h('div', { class: 'faint p-8' }, 'No stickers are available right now.'));
  box.append(h('div', { class: 'faint sticker-note' }, 'Parlance stickers · GIF search is not enabled'));
  anchor.insertAdjacentElement('afterend', box);
  picker = box;
  box.querySelector('button')?.focus();
}

// ------------------------------------------------------------------ share + copy link
const absolute = (path) => new URL(path, location.origin).href;
export async function copyLink(path) {
  const url = absolute(path);
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
  return url;
}
export async function sharePost(path, title = 'A post on Parlance') {
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
    if (body) { const open = body.classList.toggle('clamped') === false; readMore.textContent = open ? 'Show less' : 'Read more'; readMore.setAttribute('aria-expanded', String(open)); }
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
  item('Copy link', 'post-copy-link', () => copyLink(card.dataset.share));
  if (navigator.share) item('Share…', 'post-share-native', () => sharePost(card.dataset.share));
  if (!session.user) {
    menu.append(h('a', { href: `/sign-in?next=${encodeURIComponent(location.pathname)}`, 'data-link': '' }, 'Log in to report or mute'));
  } else if (mine) {
    if (editable) item('Edit post', 'post-edit', () => startEdit(card));
    item('Delete post', 'post-delete', () => card.querySelector('[data-act=delete]')?.click());
  } else {
    const muted = card.classList.contains('muted-author');
    item(muted ? `Unmute @${nick}` : `Mute @${nick}`, 'post-mute', () => toggleMute(nick, !muted));
    item('Report post', 'report-post', () => reportDialog('post', card.dataset.post));
  }
  card.querySelector('.post-head').append(menu);
  pmenu = menu;
  menu.querySelector('button,a')?.focus();
}, true);

export async function toggleMute(nick, on) {
  try {
    if (on) await api.mute(session.uid, nick); else await api.unmute(session.uid, nick);
    invalidateMutes();
    toast(on ? `Muted @${nick}. Their posts, replies and chat messages are hidden for you.` : `Unmuted @${nick}`);
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
  const ta = h('textarea', { maxlength: '500', 'aria-label': 'Edit post', 'data-testid': 'post-edit-input', rows: '3' });
  ta.value = bodyEl ? bodyEl.textContent : '';
  const err = h('div', { class: 'form-error', role: 'alert', 'data-testid': 'post-edit-error' });
  const save = h('button', { class: 'btn btn-primary btn-sm', type: 'submit', 'data-testid': 'post-edit-save' }, 'Save');
  const cancel = h('button', { class: 'btn btn-sm', type: 'button' }, 'Cancel');
  const form = h('form', { class: 'post-edit', 'data-edit-form': '' }, ta, h('div', { class: 'd-flex gap-6 mt-6 ai-center fw-wrap' }, save, cancel, h('span', { class: 'faint' }, 'Edits show "edited"; moderators can see earlier versions.')), err);
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
      toast('Post updated');
    } catch (ex) { err.textContent = ex.code === 'edit_window_closed' ? 'The 10-minute edit window has closed.' : ex.message; save.disabled = false; }
  };
}

// ------------------------------------------------------------------ composer extras: sticker, "+ Add a position", audience
export function composerExtrasHtml() {
  return `<div class="composer-extras"><button class="btn btn-sm btn-ghost" type="button" data-sticker-btn="composer" data-testid="composer-sticker" aria-label="Add a sticker">GIF · Sticker</button>
    <button class="btn btn-sm btn-ghost" type="button" data-add-position data-testid="add-position">+ Add a position</button>
    <label class="audience"><span class="faint">Audience</span><select data-visibility data-testid="composer-visibility" aria-label="Who can see this post"><option value="public">Everyone</option><option value="circle">Inner Circle</option></select></label>
    <span class="composer-chips" data-chips></span></div><div data-pos-list></div>`;
}
export function wireComposerExtras(form) {
  const st = { sticker: null, position: null };
  const chips = form.querySelector('[data-chips]');
  if (!chips) return null;
  const draw = () => {
    chips.replaceChildren();
    if (st.sticker) {
      const x = h('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove sticker' }, '✕'); x.onclick = () => { st.sticker = null; draw(); };
      chips.append(h('span', { class: 'composer-chip', 'data-testid': 'composer-sticker-chip' }, h('img', { src: st.sticker.url, alt: '', width: '28', height: '28' }), st.sticker.label, x));
    }
    if (st.position) {
      const x = h('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove position' }, '✕'); x.onclick = () => { st.position = null; draw(); };
      chips.append(h('span', { class: `composer-chip pos-tag pos-${st.position.side}`, 'data-testid': 'composer-position-chip' }, st.position.label, x));
    }
  };
  form.querySelector('[data-sticker-btn]').onclick = (e) => openStickerPicker(e.currentTarget, (s) => { st.sticker = s; draw(); });
  const posList = form.querySelector('[data-pos-list]');
  form.querySelector('[data-add-position]').onclick = async () => {
    if (posList.childNodes.length) { posList.replaceChildren(); return; }
    let rows = [];
    try { rows = (await api.positionTags(session.uid)).positions; } catch (ex) { toast(ex.message, 'error'); return; }
    const box = h('div', { class: 'pos-picker', 'data-testid': 'position-picker', role: 'listbox', 'aria-label': 'Your positions' });
    if (!rows.length) box.append(h('div', { class: 'faint' }, 'Trade a market first: you can tag positions you hold or have held.'));
    for (const r of rows) {
      const b = h('button', { type: 'button', role: 'option', class: `pos-opt pos-${r.side}`, 'data-testid': 'position-opt', 'data-ticker': r.market_ticker, 'data-side': r.side }, r.label, h('span', { class: 'faint' }, r.held === 'current' ? ` · holding ${r.position_fp}` : ' · held before'));
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
  const follow = h('button', { class: 'icon-btn ev-follow', type: 'button', 'data-testid': 'follow-event', 'aria-pressed': 'false', title: 'Follow this event in your Topics feed' }, 'Follow');
  const move = h('button', { class: 'icon-btn ev-move', type: 'button', 'data-testid': 'move-alert-btn', title: 'Price-movement alert' }, 'Move alert');
  actions.append(follow, move);
  let on = false;
  const draw = () => { follow.textContent = on ? 'Following' : 'Follow'; follow.setAttribute('aria-pressed', String(on)); follow.classList.toggle('on', on); };
  if (session.user) api.topics(session.uid).then((r) => { on = r.topics.some((t) => t.kind === 'event' && t.value === T); if (follow.isConnected) draw(); }).catch(() => {});
  follow.onclick = async () => {
    if (!session.user) { location.assign(`/sign-in?next=${encodeURIComponent(location.pathname)}`); return; }
    try { if (on) await api.unfollowTopic(session.uid, 'event', T); else await api.followTopic(session.uid, 'event', T); on = !on; draw(); toast(on ? 'Following this event: posts about it appear in your Topics feed' : 'Unfollowed'); } catch (ex) { toast(ex.message, 'error'); }
  };
  move.onclick = () => {
    if (!session.user) { location.assign(`/sign-in?next=${encodeURIComponent(location.pathname)}`); return; }
    const m = market() || ev.markets[0];
    const d = document.createElement('dialog');
    d.className = 'adm-dialog';
    d.dataset.testid = 'move-alert-dialog';
    d.innerHTML = `<form method="dialog" class="adm-confirm"><h3>Price-movement alert</h3><p class="muted">${esc(m.yes_sub_title)} · Yes price now ${esc(pxCents(Math.round(Number(m.last_price_dollars || 0) * 100)))}</p>
      <label class="field"><span>Notify me when the price moves by at least (${esc(priceUnit())})</span><input name="threshold" type="number" min="1" max="99" value="5" required data-testid="move-threshold"></label>
      <label class="field"><span>Within</span><select name="window" data-testid="move-window"><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="60" selected>1 hour</option><option value="240">4 hours</option><option value="1440">1 day</option></select></label>
      <label class="field"><span>Direction</span><select name="direction"><option value="any">Up or down</option><option value="up">Up only</option><option value="down">Down only</option></select></label>
      <div class="form-error" data-err role="alert"></div><div data-list class="move-list"></div>
      <div class="adm-form-actions"><button class="btn" type="button" data-cancel>Close</button><button class="btn btn-primary" type="submit" data-testid="move-save">Create alert</button></div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => d.remove());
    d.querySelector('[data-cancel]').onclick = () => d.close();
    const list = d.querySelector('[data-list]');
    const drawList = async () => {
      const { subscriptions } = await api.moveSubs(session.uid, m.ticker);
      list.replaceChildren(...subscriptions.map((s) => {
        const x = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': 'Delete alert' }, 'Delete');
        x.onclick = async () => { await api.deleteMoveSub(session.uid, s.id); drawList(); };
        return h('div', { class: 'move-row', 'data-testid': 'move-sub' }, `±${pxCents(s.threshold_cents)} in ${s.window_minutes >= 60 ? `${s.window_minutes / 60} h` : `${s.window_minutes} min`}${s.direction === 'any' ? '' : ` (${s.direction})`}`, x);
      }));
    };
    drawList().catch(() => {});
    d.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api.addMoveSub(session.uid, { market_ticker: m.ticker, threshold_cents: Number(f.threshold.value), window_minutes: Number(f.window.value), direction: f.direction.value });
        toast('Price-movement alert created'); d.querySelector('[data-err]').textContent = ''; drawList();
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
      pill.textContent = `${r.count} new post${r.count === 1 ? '' : 's'} · show`;
    } catch { /* optional */ }
  };
  const iv = setInterval(tick, 10000);
  return { reset: () => { since = Date.now(); pill.hidden = true; }, poll: tick, stop: () => { stopped = true; clearInterval(iv); pill.remove(); } };
}
