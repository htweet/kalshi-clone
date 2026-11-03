// Social and community completion on the client (PLAN Phase 2, PHASE2_SPEC.md §24): sticker picker, the post ⋯ menu
// (copy link, share, edit within the window, delete, mute, report), the canonical post page (/social/post/:id), social
// settings (/social/settings: picture, muted traders, followed topics), notification settings (/notifications/settings:
// per-type × channel toggles, quiet hours, price-movement alerts), event-page extras (follow event / market, move alerts,
// targeted promos), profile search, the "new posts" timeline badge and category promos.
//
// Security: user content is either escaped with esc() inside templates (checked by the parlance/no-unescaped-html lint
// rule) or written with textContent through h(); sticker images only ever come from the server's sticker table URLs.
import { api } from '../api.js';
import { session } from '../store.js';
import { vars } from '../dynstyle.js';
import { esc, toast, relTime, shortDate } from '../lib.js';
import { postCard, authorAvatar, badgeChips, stickerImg } from './components.js';
import { reportDialog } from './admin/site.js';

export const REACTIONS = [['up', '👍', 'Thumbs up'], ['heart', '❤️', 'Love'], ['laugh', '😂', 'Funny'], ['wow', '😮', 'Wow'], ['fire', '🔥', 'Fire'], ['chart', '📈', 'Bullish']];
export const REACTION_EMOJI = Object.fromEntries(REACTIONS.map(([k, e]) => [k, e]));

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
    const img = h('img', { src: s.url, alt: s.label, width: '56', height: '56' });
    const b = h('button', { type: 'button', role: 'menuitem', class: 'sticker-opt', 'data-pick-sticker': s.id, 'data-testid': `sticker-opt-${s.id}`, title: s.label, 'aria-label': s.label }, img);
    b.onclick = (ev) => { ev.stopPropagation(); closePicker(); onPick(s); };
    box.append(b);
  }
  if (!list.length) box.append(h('div', { class: 'faint p-8' }, 'No stickers are available right now.'));
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
export async function sharePost(path, title = 'Post on Parlance') {
  const url = absolute(path);
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  await copyLink(path);
}

// ------------------------------------------------------------------ post ⋯ menu (every post card on any page)
let pmenu = null;
const closePostMenu = () => { pmenu?.remove(); pmenu = null; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePostMenu(); });
document.addEventListener('click', (e) => {
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
    item(card.classList.contains('muted-author') ? `Unmute @${nick}` : `Mute @${nick}`, 'post-mute', () => toggleMute(nick, !card.classList.contains('muted-author')));
    item('Report post', 'report-post', () => reportDialog('post', card.dataset.post));
  }
  btn.insertAdjacentElement('afterend', menu);
  pmenu = menu;
  menu.querySelector('button,a')?.focus();
}, true);

export async function toggleMute(nick, on) {
  try {
    if (on) await api.mute(session.uid, nick); else await api.unmute(session.uid, nick);
    invalidateMutes();
    toast(on ? `Muted @${nick}. Their posts, replies and chat messages are hidden for you.` : `Unmuted @${nick}`);
    const onProfile = location.pathname.toLowerCase() === `/social/profile/${encodeURIComponent(nick)}`.toLowerCase();
    for (const c of document.querySelectorAll('[data-post]')) {
      if (c.dataset.nick.toLowerCase() !== nick.toLowerCase()) continue;
      if (on && !onProfile && !location.pathname.startsWith('/social/post/')) c.remove(); else c.classList.toggle('muted-author', on);
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
  const err = h('div', { class: 'form-error', role: 'alert' });
  const save = h('button', { class: 'btn btn-primary btn-sm', type: 'submit', 'data-testid': 'post-edit-save' }, 'Save');
  const cancel = h('button', { class: 'btn btn-sm', type: 'button' }, 'Cancel');
  const form = h('form', { class: 'post-edit', 'data-edit-form': '' }, ta, h('div', { class: 'd-flex gap-6 mt-6' }, save, cancel, h('span', { class: 'faint ai-center d-flex' }, 'Edits are visible to moderators.')), err);
  (bodyEl || card.querySelector('.post-head')).insertAdjacentElement('afterend', form);
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

// ------------------------------------------------------------------ composer extras: sticker + "+ Add a position"
export function composerExtrasHtml() {
  return `<div class="composer-extras"><button class="btn btn-sm btn-ghost" type="button" data-sticker-btn="composer" data-testid="composer-sticker" aria-label="Add a sticker">GIF · Sticker</button>
    <button class="btn btn-sm btn-ghost" type="button" data-add-position data-testid="add-position">+ Add a position</button><span class="composer-chips" data-chips></span></div><div data-pos-list></div>`;
}
export function wireComposerExtras(form) {
  const st = { sticker: null, position: null };
  const chips = form.querySelector('[data-chips]');
  const draw = () => {
    chips.replaceChildren();
    if (st.sticker) {
      const x = h('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove sticker' }, '✕'); x.onclick = () => { st.sticker = null; draw(); };
      chips.append(h('span', { class: 'composer-chip', 'data-testid': 'composer-sticker-chip' }, h('img', { src: st.sticker.url, alt: st.sticker.label, width: '28', height: '28' }), st.sticker.label, x));
    }
    if (st.position) {
      const x = h('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove position' }, '✕'); x.onclick = () => { st.position = null; draw(); };
      chips.append(h('span', { class: `composer-chip pos-tag pos-${st.position.side}`, 'data-testid': 'composer-position-chip' }, st.position.label, x));
    }
    form.dispatchEvent(new Event('extras-change'));
  };
  form.querySelector('[data-sticker-btn]').onclick = (e) => openStickerPicker(e.currentTarget, (s) => { st.sticker = s; draw(); });
  const posList = form.querySelector('[data-pos-list]');
  form.querySelector('[data-add-position]').onclick = async () => {
    if (!posList.hidden && posList.childNodes.length) { posList.replaceChildren(); return; }
    let rows = [];
    try { rows = (await api.positionTags(session.uid)).positions; } catch (ex) { toast(ex.message, 'error'); return; }
    posList.replaceChildren();
    const box = h('div', { class: 'pos-picker', 'data-testid': 'position-picker', role: 'listbox', 'aria-label': 'Your positions' });
    if (!rows.length) box.append(h('div', { class: 'faint' }, 'Trade a market first: you can tag positions you hold or have held.'));
    for (const r of rows) {
      const b = h('button', { type: 'button', role: 'option', class: `pos-opt pos-${r.side}`, 'data-testid': 'position-opt', 'data-ticker': r.market_ticker, 'data-side': r.side }, r.label, h('span', { class: 'faint' }, r.held === 'current' ? ` · holding ${r.position_fp}` : ' · held before'));
      b.onclick = () => { st.position = r; posList.replaceChildren(); draw(); };
      box.append(b);
    }
    posList.append(box);
  };
  return {
    get: () => ({ sticker_id: st.sticker?.id, position: st.position ? { market_ticker: st.position.market_ticker, side: st.position.side } : undefined }),
    has: () => !!st.sticker,
    reset: () => { st.sticker = null; st.position = null; posList.replaceChildren(); draw(); },
  };
}

// ------------------------------------------------------------------ comment pieces (stickers in replies)
export function commentHtml(c) {
  return `<div class="comment" data-comment="${esc(c.id)}" data-nick="${esc(c.author.nickname)}"><a href="/social/profile/${encodeURIComponent(c.author.nickname)}" data-link><strong>@${esc(c.author.nickname)}</strong></a>${c.author.verified ? '<span class="verified-badge" title="Verified profile" aria-label="Verified">✓</span>' : ''}${badgeChips(c.author.badges)} <span class="faint">${relTime(c.created_time)}</span>${c.is_mine ? ' <button class="btn btn-sm btn-ghost btn-danger" data-act="del-comment">Delete</button>' : ` <button class="btn btn-sm btn-ghost" data-report-comment="${esc(c.id)}">Report</button>`}${c.body ? `<div data-testid="comment-body">${esc(c.body)}</div>` : ''}${stickerImg(c.sticker, 'sticker sticker-sm')}</div>`;
}

// ------------------------------------------------------------------ canonical post page: /social/post/:id
export async function renderPostPage({ el, params, navigate }) {
  let post;
  try { post = (await api.post(params.id)).post; } catch (e) {
    if (e.notFound) { el.innerHTML = '<div class="card empty center-50" data-testid="post-missing"><h1 class="typ-title-x20 m-0">Post not found</h1><p class="muted">It may have been deleted or hidden by a moderator.</p><a class="btn" href="/social" data-link>Back to Social</a></div>'; document.title = 'Post · Parlance'; return; }
    throw e;
  }
  document.title = `@${post.author.nickname} on Parlance`;
  el.innerHTML = `<div class="post-page"><a class="faint" href="/social" data-link>← Social</a>
    ${post.author_muted ? `<div class="card muted-note" data-testid="muted-note">You muted @${esc(post.author.nickname)}. <button class="btn btn-sm" data-unmute>Unmute</button></div>` : ''}
    <div class="card mt-10" id="post-one" data-testid="post-page">${postCard(post, { expanded: true })}</div></div>`;
  const { wirePosts } = await import('./social.js');
  wirePosts(el.querySelector('#post-one'), { navigate, onDeleted: () => navigate('/social') });
  el.querySelector('[data-unmute]')?.addEventListener('click', async () => { await toggleMute(post.author.nickname, false); navigate(location.pathname, { replace: true }); });
  el.querySelector('#post-one [data-act=comments]')?.click(); // replies open on the post's own page
}

// ------------------------------------------------------------------ social settings: /social/settings
export async function renderSocialSettings({ el, navigate }) {
  if (!session.user) { navigate('/sign-in?next=/social/settings', { replace: true }); return; }
  document.title = 'Social settings · Parlance';
  const [prof, mutes, topics, stickers] = await Promise.all([api.myProfile(session.uid), api.mutes(session.uid), api.topics(session.uid), loadStickers().catch(() => [])]);
  const p = prof.profile;
  const av = p?.avatar_status;
  el.innerHTML = `<div class="page-head"><h1 class="typ-title-x10">Social settings</h1><a class="btn btn-ghost" href="/social" data-link>Back to Social</a></div>
    <div class="settings-grid">
    <section class="card panel" data-testid="avatar-panel"><h2>Profile picture</h2>${p ? `<p class="muted">Pick a picture from the Parlance sticker set, or keep your monogram.${av && av.status === 'rejected' ? ` <span class="c-no" data-testid="avatar-rejected">A moderator removed your last picture${av.reason ? `: ${esc(av.reason)}` : ''}.</span>` : ''}</p>
      <div class="avatar-grid" data-av-grid><button type="button" class="avatar-opt ${p.avatar ? '' : 'on'}" data-av="" data-testid="avatar-none">${authorAvatar({ nickname: p.nickname })}<span>Monogram</span></button>${stickers.map((s) => `<button type="button" class="avatar-opt ${p.avatar && p.avatar.sticker_id === s.id ? 'on' : ''}" data-av="${esc(s.id)}" data-testid="avatar-opt-${esc(s.id)}"><img src="${esc(s.url)}" alt="" width="40" height="40"><span>${esc(s.label)}</span></button>`).join('')}</div>`
    : '<p class="muted">Create a social profile first. <a href="/account/profile" data-link class="c-brand">Pick a nickname</a></p>'}</section>
    <section class="card panel" data-testid="mutes-panel"><h2>Muted traders</h2><p class="muted">You won't see their posts, replies or live-chat messages, or notifications about them. They are not told.</p>
      <div data-mutes>${mutes.mutes.map((m) => `<div class="outcome-row" data-mute-row="${esc(m.nickname)}"><span class="outcome-name">@${esc(m.nickname)} <span class="faint">since ${esc(shortDate(m.created_time))}</span></span><button class="btn btn-sm" data-unmute="${esc(m.nickname)}">Unmute</button></div>`).join('') || '<p class="faint" data-testid="no-mutes">Nobody muted.</p>'}</div></section>
    <section class="card panel" data-testid="topics-panel"><h2>Followed topics</h2><p class="muted">Posts about events, markets and keywords you follow appear in the Topics feed, and you get a notification.</p>
      <form class="inline-form" data-kw-form><label class="field flex-1">Keyword<input name="kw" maxlength="32" placeholder="e.g. tram, rate cut" data-testid="keyword-input"></label><button class="btn" type="submit" data-testid="keyword-add">Follow</button></form>
      <div class="form-error" data-kw-err role="alert"></div>
      <div data-topics>${topics.topics.map((t) => `<div class="outcome-row" data-topic="${esc(t.kind)}:${esc(t.value)}"><span class="outcome-name"><span class="faint">${esc(t.kind)}</span> ${t.link ? `<a href="${esc(t.link)}" data-link>${esc(t.label)}</a>` : esc(t.label)}</span><button class="btn btn-sm" data-unfollow-kind="${esc(t.kind)}" data-unfollow-value="${esc(t.value)}">Unfollow</button></div>`).join('') || '<p class="faint">No topics yet. Use “Follow” on an event page, or add a keyword.</p>'}</div></section></div>`;
  const redraw = () => renderSocialSettings({ el, navigate });
  el.querySelector('[data-av-grid]')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-av]'); if (!b) return;
    try { await api.setAvatar(session.uid, b.dataset.av || null); toast('Profile picture saved'); redraw(); } catch (ex) { toast(ex.message, 'error'); }
  });
  el.querySelector('[data-mutes]').addEventListener('click', async (e) => { const b = e.target.closest('[data-unmute]'); if (!b) return; await toggleMute(b.dataset.unmute, false); redraw(); });
  el.querySelector('[data-topics]').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-unfollow-kind]'); if (!b) return;
    try { await api.unfollowTopic(session.uid, b.dataset.unfollowKind, b.dataset.unfollowValue); toast('Unfollowed'); redraw(); } catch (ex) { toast(ex.message, 'error'); }
  });
  el.querySelector('[data-kw-form]').onsubmit = async (e) => {
    e.preventDefault();
    try { await api.followTopic(session.uid, 'keyword', e.target.kw.value); toast('Keyword followed'); redraw(); } catch (ex) { el.querySelector('[data-kw-err]').textContent = ex.message; }
  };
}

// ------------------------------------------------------------------ notification settings: /notifications/settings
const WINDOWS = [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours'], [1440, '24 hours']];
export function windowLabel(min) { return (WINDOWS.find(([m]) => m === min) || [0, min >= 60 ? `${min / 60} h` : `${min} min`])[1]; }
export async function renderNotifSettings({ el, navigate }) {
  if (!session.user) { navigate('/sign-in?next=/notifications/settings', { replace: true }); return; }
  document.title = 'Notification settings · Parlance';
  const [prefs, subs] = await Promise.all([api.notifPrefs(session.uid), api.moveSubs(session.uid)]);
  const q = prefs.quiet_hours;
  const zones = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC']; } })();
  const zone = q.timezone || 'UTC';
  el.innerHTML = `<div class="page-head"><h1 class="typ-title-x10">Notification settings</h1><a class="btn btn-ghost" href="/notifications" data-link>Back to notifications</a></div>
    <section class="card panel" data-testid="prefs-panel"><h2>What you hear about</h2><p class="muted">In-app notifications appear under the bell. Email is a development stub: messages are recorded on the server, not sent.</p>
      <table class="table prefs-table"><thead><tr><th>Notification</th><th class="ta-c">In-app</th><th class="ta-c">Email</th></tr></thead><tbody>
      ${prefs.types.map((t) => `<tr data-type="${esc(t.type)}"><td>${esc(t.label)}${t.locked ? ' <span class="faint">(always on)</span>' : ''}</td><td class="ta-c"><input type="checkbox" data-ch="in_app" aria-label="${esc(t.label)} in-app" data-testid="pref-${esc(t.type)}-in_app" ${t.in_app ? 'checked' : ''} ${t.locked ? 'disabled' : ''}></td><td class="ta-c"><input type="checkbox" data-ch="email" aria-label="${esc(t.label)} email" data-testid="pref-${esc(t.type)}-email" ${t.email ? 'checked' : ''} ${t.locked ? 'disabled' : ''}></td></tr>`).join('')}</tbody></table></section>
    <form class="card panel" data-quiet data-testid="quiet-panel"><h2>Quiet hours</h2><p class="muted">During quiet hours nothing pops up and email waits until they end; notifications still collect in your inbox.${prefs.in_quiet_hours ? ' <strong data-testid="quiet-now">Quiet hours are on now.</strong>' : ''}</p>
      <label class="d-flex gap-8 ai-center"><input type="checkbox" name="enabled" data-testid="quiet-enabled" ${q.enabled ? 'checked' : ''}> Turn on quiet hours</label>
      <div class="inline-form mt-8"><label class="field">From<input type="time" name="start" value="${esc(q.start)}" required data-testid="quiet-start"></label><label class="field">To<input type="time" name="end" value="${esc(q.end)}" required data-testid="quiet-end"></label>
        <label class="field flex-1">Time zone<select name="timezone" data-testid="quiet-tz">${[...new Set([zone, 'UTC', ...zones])].map((z) => `<option ${z === zone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label></div>
      <div class="form-error" data-quiet-err role="alert"></div><button class="btn btn-primary mt-8" type="submit" data-testid="quiet-save">Save quiet hours</button></form>
    <section class="card panel" data-testid="moves-panel"><h2>Price-movement alerts</h2><p class="muted">Get notified when a market moves by at least N points within a time window. Add them from a market's page.</p>
      <div data-subs>${subs.subscriptions.map((s) => `<div class="outcome-row" data-sub="${esc(s.id)}"><span class="outcome-name"><a href="${esc(s.link || '/')}" data-link>${esc(s.outcome)} · ${esc(s.market_title)}</a> <span class="faint">≥ ${esc(s.threshold_cents)}¢ ${esc(s.direction === 'any' ? 'either way' : s.direction)} in ${esc(windowLabel(s.window_minutes))}${s.last_notified_time ? ` · last alert ${esc(relTime(s.last_notified_time))}` : ''}</span></span><button class="btn btn-sm" data-del-sub="${esc(s.id)}">Remove</button></div>`).join('') || '<p class="faint">No price-movement alerts yet.</p>'}</div></section>`;
  el.querySelector('[data-testid=prefs-panel] tbody').addEventListener('change', async (e) => {
    const cb = e.target.closest('[data-ch]'); if (!cb) return;
    const type = cb.closest('[data-type]').dataset.type;
    try { await api.saveNotifPrefs(session.uid, { types: { [type]: { [cb.dataset.ch]: cb.checked } } }); toast('Saved'); } catch (ex) { cb.checked = !cb.checked; toast(ex.message, 'error'); }
  });
  el.querySelector('[data-quiet]').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api.saveNotifPrefs(session.uid, { quiet_hours: { enabled: f.enabled.checked, start: f.start.value, end: f.end.value, timezone: f.timezone.value } }); toast('Quiet hours saved'); renderNotifSettings({ el, navigate }); } catch (ex) { el.querySelector('[data-quiet-err]').textContent = ex.message; }
  };
  el.querySelector('[data-subs]').addEventListener('click', async (e) => { const b = e.target.closest('[data-del-sub]'); if (!b) return; try { await api.deleteMoveSub(session.uid, b.dataset.delSub); renderNotifSettings({ el, navigate }); } catch (ex) { toast(ex.message, 'error'); } });
}

// ------------------------------------------------------------------ event page extras (aside card + promos)
export async function drawEventExtras(box, { ev, market, navigate }) {
  if (!box) return;
  const m = market;
  let promos = [];
  try { promos = (await api.promos({ series_ticker: ev.series_ticker })).promos; } catch { /* optional */ }
  const promoHtml = promos.map((p) => promoCard(p)).join('');
  if (!session.user) { box.innerHTML = promoHtml; return; }
  let topics = []; let subs = [];
  try { [topics, subs] = await Promise.all([api.topics(session.uid).then((r) => r.topics), api.moveSubs(session.uid, m.ticker).then((r) => r.subscriptions)]); } catch { /* ignore */ }
  const has = (kind, value) => topics.some((t) => t.kind === kind && t.value === value);
  const evOn = has('event', ev.event_ticker); const mkOn = has('market', m.ticker);
  box.innerHTML = `${promoHtml}<section class="card side-card" data-testid="follow-card"><h3>Follow</h3><p class="faint m-0">Posts about what you follow show in Social › Topics and notify you.</p>
    <div class="d-flex gap-6 fw-wrap mt-8"><button class="btn btn-sm ${evOn ? '' : 'btn-primary'}" data-follow="event" data-testid="follow-event" aria-pressed="${evOn}">${evOn ? 'Following event' : 'Follow event'}</button>
    ${ev.markets.length > 1 ? `<button class="btn btn-sm ${mkOn ? '' : 'btn-primary'}" data-follow="market" data-testid="follow-market" aria-pressed="${mkOn}">${mkOn ? `Following ${esc(m.yes_sub_title)}` : `Follow ${esc(m.yes_sub_title)}`}</button>` : ''}</div>
    <h3 class="mt-12">Price-movement alert</h3>
    <form class="inline-form" data-move-form><label class="field flex-70">Moves ≥ (¢)<input name="th" type="number" min="1" max="99" value="5" required data-testid="move-threshold"></label>
      <label class="field flex-90">Within<select name="win" data-testid="move-window">${WINDOWS.map(([v, l]) => `<option value="${esc(v)}" ${v === 60 ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="field flex-70">Way<select name="dir"><option value="any">either</option><option value="up">up</option><option value="down">down</option></select></label><button class="btn" type="submit" data-testid="move-add">Add</button></form>
    <div class="form-error" data-move-err role="alert"></div>
    ${subs.map((s) => `<div class="outcome-row" data-sub="${esc(s.id)}"><span class="outcome-name">≥ ${esc(s.threshold_cents)}¢ ${esc(s.direction === 'any' ? 'either way' : s.direction)} in ${esc(windowLabel(s.window_minutes))}</span><button class="btn btn-sm btn-ghost" data-del-sub="${esc(s.id)}">Remove</button></div>`).join('')}
    <a class="faint" href="/notifications/settings" data-link>Notification settings</a></section>`;
  const redraw = () => drawEventExtras(box, { ev, market, navigate });
  for (const b of box.querySelectorAll('[data-follow]')) {
    b.onclick = async () => {
      const kind = b.dataset.follow; const value = kind === 'event' ? ev.event_ticker : m.ticker;
      try { if (has(kind, value)) await api.unfollowTopic(session.uid, kind, value); else await api.followTopic(session.uid, kind, value); redraw(); } catch (ex) { toast(ex.message, 'error'); }
    };
  }
  box.querySelector('[data-move-form]').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api.addMoveSub(session.uid, { market_ticker: m.ticker, threshold_cents: Number(f.th.value), window_minutes: Number(f.win.value), direction: f.dir.value }); toast('Price-movement alert added'); redraw(); } catch (ex) { box.querySelector('[data-move-err]').textContent = ex.message; }
  };
  for (const b of box.querySelectorAll('[data-del-sub]')) b.onclick = async () => { try { await api.deleteMoveSub(session.uid, b.dataset.delSub); redraw(); } catch (ex) { toast(ex.message, 'error'); } };
}
export function promoCard(p) {
  return `<a class="card promo-card" href="${esc(p.link)}" ${String(p.link).startsWith('/') ? 'data-link' : 'target="_blank" rel="noopener noreferrer"'} data-testid="targeted-promo" data-promo="${esc(p.id)}"><span class="promo-dot v-bg"${vars({ '--bg': p.color })} aria-hidden="true"></span>${p.overline ? `<div class="overline">${esc(p.overline)}</div>` : ''}<strong>${esc(p.title)}</strong>${p.subtitle ? `<div class="faint">${esc(p.subtitle)}</div>` : ''}</a>`;
}
export async function categoryPromos(box, category) {
  if (!box) return;
  try { const { promos } = await api.promos({ category }); box.innerHTML = promos.map(promoCard).join(''); } catch { box.innerHTML = ''; }
}

// ------------------------------------------------------------------ profile search (nickname prefix)
export function wireProfileSearch(form) {
  const input = form.querySelector('input');
  const out = form.querySelector('[data-results]');
  let t = null; let seq = 0;
  const run = async () => {
    const qv = input.value.trim().replace(/^@/, '');
    const mine = ++seq;
    if (!qv) { out.replaceChildren(); return; }
    if (!/^[A-Za-z0-9_]{1,20}$/.test(qv)) { out.replaceChildren(h('div', { class: 'faint p-8' }, 'Nicknames use letters, digits and _')); return; }
    try {
      const { profiles } = await api.searchProfiles(qv);
      if (mine !== seq) return;
      out.replaceChildren(...(profiles.length ? profiles.map((p) => h('a', { class: 'search-hit', href: `/social/profile/${encodeURIComponent(p.nickname)}`, 'data-link': '', 'data-testid': 'profile-hit' }, `@${p.nickname}`, p.verified ? h('span', { class: 'verified-badge', 'aria-label': 'Verified' }, '✓') : null, h('span', { class: 'faint' }, ` · ${p.followers} followers`))) : [h('div', { class: 'faint p-8', 'data-testid': 'no-profile-hits' }, 'No traders found')]));
    } catch (ex) { if (mine === seq) out.replaceChildren(h('div', { class: 'faint p-8' }, ex.tooManyRequests ? 'Searching too fast, wait a moment.' : ex.message)); }
  };
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 200); });
  form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(t); run(); });
}

// ------------------------------------------------------------------ "N new posts" badge (timeline_count polling)
export function timelineBadge(btn, { feed, since, onShow }) {
  let sinceIso = since;
  let timer = null;
  const tick = async () => {
    if (document.hidden || !btn.isConnected) return;
    const asked = sinceIso;
    try {
      const r = await api.timelineCount({ feed, since: asked });
      if (asked !== sinceIso) return; // the feed was refreshed while this count was in flight
      btn.hidden = !r.count;
      btn.textContent = r.count === 1 ? '1 new post' : `${r.count > 99 ? '99+' : r.count} new posts`;
    } catch { /* keep the last state */ }
  };
  timer = setInterval(tick, 5000);
  btn.onclick = () => { btn.hidden = true; sinceIso = new Date().toISOString(); onShow(); };
  return { reset: (iso) => { sinceIso = iso; btn.hidden = true; }, stop: () => clearInterval(timer), tick };
}
