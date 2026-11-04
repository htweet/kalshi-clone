// Event live chat (CLONE_SPEC.md §20): the "● Live chat" pill on the event header, a right-side panel (bottom drawer on
// phones) with history (infinite scroll up), live messages over the shared socket (`chat` channel), replies, own-message
// delete, report, pinned message, online count, slow-mode countdown, read-only / locked states and moderator tools.
//
// Security: every piece of user content (nickname, body, reply excerpt, lock reason) is written with textContent or
// text nodes via h(); no user content ever goes through innerHTML. Links are http(s) only, built with the URL parser
// and opened with rel="noopener noreferrer nofollow ugc".
import { t as tx, ts, tes } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/chat-strings.js';
import { api } from '../api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { relTime, toast, fmtDt, fmtDateTime } from '../lib.js';
import { REACTIONS, openStickerPicker, mutedNicks } from './social2.js'; // reactions, stickers, mutes (CLONE_SPEC.md §24.8)

const MAX = 280;
const PAGE = 40;
const SLOW = [[0, ts('chat.slow.off')], [5, '5s'], [10, '10s'], [30, '30s'], [60, '1m'], [120, '2m'], [300, '5m']];
const REPORT_REASONS = [[ts('chat.report_reasons.spam_or_scam'), 'spam'], [ts('chat.report_reasons.harassment_or_hate'), 'abuse'], [ts('chat.report_reasons.off_topic'), 'offtopic']];
const MUTES = [[10, '10 min'], [60, '1 hour'], [1440, '24 hours']];
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const EDIT_MS = 5 * 60 * 1000; // own messages can be edited for 5 minutes (server/chat-extras.js)

// Tiny DOM builder: attributes come from code, children strings become text nodes (never parsed as HTML).
function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
// Plain text with safe auto-links (http/https only).
function linkify(node, text) {
  let last = 0;
  for (const mt of text.matchAll(URL_RE)) {
    const raw = mt[0].replace(/[.,!?;:)\]}]+$/, '');
    node.append(document.createTextNode(text.slice(last, mt.index)));
    let href = null;
    try { const u = new URL(raw); if (u.protocol === 'http:' || u.protocol === 'https:') href = u.href; } catch { /* not a URL */ }
    node.append(href ? h('a', { class: 'chat-link', href, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, raw) : document.createTextNode(raw));
    last = mt.index + raw.length;
  }
  node.append(document.createTextNode(text.slice(last)));
}
const chars = (s) => [...s].length;
const clock = (iso) => fmtDt(iso, { hour: 'numeric', minute: '2-digit' });

// Static markup only (no data interpolated).
const PANEL = `<header class="chat-head">
    <div class="chat-title-row"><h2 class="chat-title" id="chat-title"><span class="chat-live" data-live aria-hidden="true"></span>${tes('chat.panel.live_chat')}</h2>
      <span class="chat-online faint" data-online data-testid="chat-online"></span><span class="grow"></span>
      <button class="icon-btn chat-icon" type="button" data-mod-toggle data-testid="chat-mod-toggle" hidden aria-expanded="false" aria-label="${tes('chat.panel.moderation_tools')}" title="${tes('chat.panel.moderation_tools')}"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 17V3.5M5 4h9l-2 3.5 2 3.5H5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
      <button class="icon-btn chat-icon" type="button" data-close data-testid="chat-close" aria-label="${tes('chat.panel.close_chat')}"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>
    <div class="chat-modbar" data-modbar data-testid="chat-modbar" hidden>
      <label class="chat-mod-field">${tes('chat.panel.slow_mode')} <select data-slow data-testid="chat-slow" aria-label="${tes('chat.panel.slow_mode')}"></select></label>
      <button class="btn btn-sm" type="button" data-lock data-testid="chat-lock"></button>
      <a class="btn btn-sm btn-ghost" data-admin-link data-link>${tes('chat.panel.open_in_admin')}</a></div>
    <div class="chat-pinned" data-pinned data-testid="chat-pinned" hidden><span class="chat-pin-ic" aria-hidden="true">📌</span><div class="chat-pin-text"><b data-pin-nick></b> <span data-pin-body></span></div>
      <button class="btn btn-sm btn-ghost" type="button" data-unpin data-testid="chat-unpin" hidden>${tes('chat.panel.unpin')}</button></div>
    <div class="chat-state" data-state data-testid="chat-state" hidden></div>
  </header>
  <div class="chat-list" data-list data-testid="chat-list" role="log" aria-live="polite" aria-relevant="additions" tabindex="0">
    <div class="chat-older" data-older></div><div class="chat-msgs" data-msgs></div><div class="chat-empty faint" data-empty hidden>${tes('chat.panel.no_messages_yet_say_hello')}</div>
  </div>
  <button class="chat-jump" type="button" data-jump data-testid="chat-jump" hidden>${tes('chat.panel.jump_to_latest')}</button>
  <footer class="chat-foot" data-foot></footer>`;

export function mountChat({ el, ev }) {
  const T = ev.event_ticker;
  const actions = el.querySelector('.ev-actions');
  if (!actions || !T) return () => {};
  const st = { room: null, viewer: null, ids: new Set(), oldest: null, hasMore: false, loadingOlder: false, open: false, replyTo: null, unseen: 0, unreadClosed: 0, coolUntil: 0, footMode: '', menu: null, wasDown: false, muted: new Set() };
  mutedNicks().then((m) => { st.muted = m; }).catch(() => {});
  const timers = [];

  // ---------------- entry points: header pill (+ compact entry under a sports scoreboard)
  const pill = h('button', { class: 'chat-pill', type: 'button', 'data-testid': 'chat-pill', 'data-flag': 'social.chat', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'chat-panel' },
    h('span', { class: 'chat-pill-dot', 'aria-hidden': 'true' }), h('span', { class: 'chat-pill-label' }, tx('chat.mount_chat.live_chat')), h('span', { class: 'chat-pill-badge', 'data-testid': 'chat-unread', hidden: true }));
  actions.prepend(pill);
  const sb = el.querySelector('#sports-board');
  const sbEntry = sb ? h('button', { class: 'chat-sb-entry', type: 'button', 'data-testid': 'chat-sb-entry' }, h('span', { class: 'chat-pill-dot', 'aria-hidden': 'true' }), h('span', {}, tx('chat.mount_chat.live_chat')), h('span', { class: 'faint', 'data-sb-online': '' })) : null;
  if (sbEntry) sb.after(sbEntry);

  // ---------------- panel
  const backdrop = h('div', { class: 'chat-backdrop', hidden: true, 'data-testid': 'chat-backdrop' });
  const panel = h('aside', { class: 'chat-panel', id: 'chat-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'chat-title', 'data-testid': 'chat-panel', hidden: true });
  panel.innerHTML = PANEL;
  document.body.append(backdrop, panel);
  const $ = (s) => panel.querySelector(s);
  const list = $('[data-list]');
  const msgsBox = $('[data-msgs]');
  for (const [v, l] of SLOW) $('[data-slow]').append(h('option', { value: v }, l));
  $('[data-admin-link]').setAttribute('href', `/admin/chat/${encodeURIComponent(T)}`);

  // ---------------- state helpers
  const isMod = () => !!st.viewer?.is_moderator;
  const mineOf = (m) => (m.is_mine != null ? m.is_mine : !!st.viewer?.nickname && m.author.nickname === st.viewer.nickname);
  // Effective reason the composer is unavailable (room state is live; account state comes from the server).
  function block() {
    const v = st.viewer;
    if (!v || !v.signed_in) return 'signed_out';
    if (['banned', 'feature_disabled', 'no_nickname'].includes(v.block)) return v.block;
    if (st.room?.status === 'locked') return 'locked';
    if (st.room?.status === 'read_only') return 'closed';
    if (v.muted_until && Date.parse(v.muted_until) > Date.now()) return 'muted';
    return null;
  }
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const toBottom = () => { list.scrollTop = list.scrollHeight; st.unseen = 0; drawJump(); };

  // ---------------- messages
  function quoteEl(r) {
    if (r.deleted) return h('div', { class: 'chat-quote deleted', 'data-testid': 'chat-quote' }, tx('chat.mount_chat.original_message_was_deleted'));
    return h('div', { class: 'chat-quote', 'data-testid': 'chat-quote', 'data-quote': r.id }, h('b', {}, `@${r.nickname}`), ' ', r.excerpt);
  }
  function msgEl(m) {
    const mine = mineOf(m);
    const row = h('div', { class: `chat-msg${mine ? ' mine' : ''}`, 'data-id': m.id, 'data-testid': 'chat-msg', 'data-nick': m.author.nickname });
    if (m.reply_to) row.append(quoteEl(m.reply_to));
    const acts = h('div', { class: 'chat-acts' });
    if (st.viewer?.signed_in) acts.append(h('button', { class: 'chat-act', type: 'button', 'data-act': 'reply', 'data-testid': 'chat-reply', title: tx('chat.mount_chat.reply') }, tx('chat.mount_chat.reply')));
    if (mine || isMod()) acts.append(h('button', { class: 'chat-act danger', type: 'button', 'data-act': 'delete', 'data-testid': 'chat-del', title: tx('chat.mount_chat.delete') }, tx('chat.mount_chat.delete')));
    if (mine && Date.now() - Date.parse(m.created_time) < EDIT_MS) acts.append(h('button', { class: 'chat-act', type: 'button', 'data-act': 'edit', 'data-testid': 'chat-edit', title: tx('chat.mount_chat.edit') }, tx('chat.mount_chat.edit')));
    if ((st.viewer?.signed_in && !mine) || isMod()) acts.append(h('button', { class: 'chat-act more', type: 'button', 'data-act': 'more', 'data-testid': 'chat-more', 'aria-haspopup': 'menu', 'aria-label': tx('chat.mount_chat.more_actions') }, '⋯'));
    row.append(h('div', { class: 'chat-meta' },
      h('span', { class: 'chat-nick', 'data-testid': 'chat-nick' }, `@${m.author.nickname}`),
      m.author.verified ? h('span', { class: 'verified-badge', title: tx('chat.mount_chat.verified_profile'), 'aria-label': tx('chat.mount_chat.verified'), 'data-testid': 'chat-verified' }, '✓') : null,
      h('time', { class: 'chat-time', datetime: m.created_time, title: fmtDateTime(m.created_time) }, relTime(m.created_time)), acts));
    const body = h('div', { class: 'chat-body', 'data-testid': 'chat-body' });
    linkify(body, m.body);
    if (m.edited) body.append(h('span', { class: 'chat-edited faint', 'data-testid': 'chat-edited', title: m.edited_time ? fmtDateTime(m.edited_time) : '' }, (' ' + tx('chat.mount_chat.edited'))));
    row.append(body);
    if (m.sticker) row.append(h('img', { class: 'chat-sticker', src: m.sticker.url, alt: m.sticker.label, title: m.sticker.label, width: '72', height: '72', 'data-testid': 'chat-sticker' }));
    row.dataset.created = m.created_time;
    row.append(reactionsEl(m));
    return row;
  }
  // Reactions row: one chip per reaction with a count; mine are highlighted; "+" opens the picker (signed in only).
  function reactionsEl(m) {
    const box = h('div', { class: 'chat-reactions', 'data-testid': 'chat-reactions' });
    const mine = new Set(m.my_reactions || []);
    for (const [k, emoji, label] of REACTIONS) {
      const n = (m.reactions || {})[k] || 0;
      if (!n) continue;
      box.append(h('button', { class: `chat-react${mine.has(k) ? ' on' : ''}`, type: 'button', 'data-react': k, 'aria-pressed': String(mine.has(k)), 'aria-label': `${label} (${n})`, 'data-testid': `chat-react-${k}` }, `${emoji} `, h('span', { 'data-testid': 'chat-react-count' }, String(n))));
    }
    if (st.viewer?.signed_in) box.append(h('button', { class: 'chat-react add', type: 'button', 'data-react-add': '', 'aria-label': tx('chat.mount_chat.add_a_reaction'), 'data-testid': 'chat-react-add' }, '+'));
    return box;
  }
  function add(m, { prepend = false } = {}) {
    if (st.ids.has(m.id)) return false;
    if (m.author && st.muted.has(String(m.author.nickname).toLowerCase())) return false; // muted by me: hidden for me only
    st.ids.add(m.id);
    const node = msgEl(m);
    if (prepend) msgsBox.prepend(node); else msgsBox.append(node);
    $('[data-empty]').hidden = true;
    return true;
  }
  function removeMsg(id) {
    st.ids.delete(id);
    panel.querySelector(`.chat-msg[data-id="${CSS.escape(id)}"]`)?.remove();
    for (const q of panel.querySelectorAll(`[data-quote="${CSS.escape(id)}"]`)) q.replaceWith(quoteEl({ deleted: true }));
    if (st.replyTo?.id === id) setReply(null);
    $('[data-empty]').hidden = st.ids.size > 0;
  }
  function drawOlder() {
    const box = $('[data-older]');
    box.replaceChildren();
    if (st.hasMore) box.append(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-load-older': '', 'data-testid': 'chat-older' }, st.loadingOlder ? tx('chat.mount_chat.loading') : tx('chat.mount_chat.load_earlier_messages')));
    else if (st.ids.size) box.append(h('span', { class: 'faint' }, tx('chat.mount_chat.beginning_of_the_chat')));
  }
  async function loadOlder() {
    if (!st.hasMore || st.loadingOlder || !st.oldest) return;
    st.loadingOlder = true; drawOlder();
    try {
      const r = await api.chat(T, { before: st.oldest, limit: PAGE });
      const prevH = list.scrollHeight; const prevTop = list.scrollTop;
      for (const m of [...r.messages].reverse()) add(m, { prepend: true });
      if (r.messages.length) st.oldest = r.messages[0].id;
      st.hasMore = r.has_more;
      list.scrollTop = prevTop + (list.scrollHeight - prevH);
    } catch (e) { toast(e.message, 'error'); }
    st.loadingOlder = false; drawOlder();
  }
  function drawJump() {
    const j = $('[data-jump]');
    j.hidden = !(st.unseen > 0 || (st.open && !nearBottom() && list.scrollHeight > list.clientHeight + 200));
    j.textContent = st.unseen ? tx('chat.mount_chat.jump_to_latest_new', { unseen: st.unseen }) : tx('chat.mount_chat.jump_to_latest');
  }

  // ---------------- room chrome
  function drawRoom() {
    const r = st.room;
    if (!r) return;
    if (st.lastSlow && !r.slow_mode_sec) st.coolUntil = 0; // slow mode switched off: drop its countdown
    st.lastSlow = r.slow_mode_sec;
    const open = r.status === 'open';
    pill.classList.toggle('on', open);
    pill.setAttribute('aria-label', tx('chat.mount_chat.live_chat', { value: open ? '' : r.status === 'locked' ? (' ' + tx('chat.mount_chat.locked')) : (' ' + tx('chat.mount_chat.read_only')) }));
    pill.dataset.status = r.status;
    $('[data-live]').classList.toggle('on', open);
    $('[data-online]').textContent = tx('chat.mount_chat.online', { online: r.online });
    if (sbEntry) { sbEntry.classList.toggle('on', open); sbEntry.querySelector('[data-sb-online]').textContent = tx('chat.mount_chat.online', { online: r.online }); }
    const stateBox = $('[data-state]');
    stateBox.replaceChildren();
    if (r.status === 'locked') stateBox.append(h('div', { 'data-testid': 'chat-locked' }, tx('chat.mount_chat.chat_locked_by_a_moderator'), r.lock_reason ? h('span', { class: 'faint' }, ` · ${r.lock_reason}`) : null));
    else if (r.status === 'read_only') stateBox.append(h('div', { 'data-testid': 'chat-readonly-banner' }, tx('chat.mount_chat.this_event_has_closed_the')));
    if (r.slow_mode_sec && r.status === 'open') stateBox.append(h('div', { 'data-testid': 'chat-slow-banner' }, tx('chat.mount_chat.slow_mode_one_message_every', { slow_mode_sec: r.slow_mode_sec })));
    stateBox.hidden = !stateBox.childNodes.length;
    drawPinned();
    // moderator tools
    $('[data-mod-toggle]').hidden = !isMod();
    $('[data-slow]').value = String(r.slow_mode_sec);
    $('[data-lock]').textContent = r.locked ? tx('chat.mount_chat.unlock_chat') : tx('chat.mount_chat.lock_chat');
    drawFoot();
  }
  function drawPinned() {
    const p = st.room?.pinned;
    const box = $('[data-pinned]');
    box.hidden = !p;
    if (!p) return;
    box.dataset.id = p.id;
    $('[data-pin-nick]').textContent = `@${p.author.nickname}`;
    $('[data-pin-body]').textContent = p.body;
    $('[data-unpin]').hidden = !isMod();
  }

  // ---------------- composer / prompts
  function footMode() { const b = block(); return b ? `block:${b}` : 'compose'; }
  function drawFoot() {
    const mode = footMode();
    if (mode === st.footMode) { updateComposer(); return; }
    st.footMode = mode;
    const foot = $('[data-foot]');
    foot.replaceChildren();
    const b = block();
    if (b === 'signed_out') {
      const a = h('a', { class: 'btn btn-sm btn-primary', href: `/sign-in?next=${encodeURIComponent(location.pathname)}`, 'data-link': '' }, tx('chat.mount_chat.log_in'));
      foot.append(h('div', { class: 'chat-prompt', 'data-testid': 'chat-signin' }, h('span', {}, tx('chat.mount_chat.log_in_to_join_the')), a));
    } else if (b === 'no_nickname') {
      const form = h('form', { class: 'chat-nick-form', 'data-testid': 'chat-nick-form' },
        h('label', { class: 'chat-prompt-text', for: 'chat-nick-input' }, tx('chat.mount_chat.pick_a_nickname_to_chat')),
        h('div', { class: 'chat-nick-row' }, h('input', { id: 'chat-nick-input', name: 'nickname', autocomplete: 'off', placeholder: 'nickname', pattern: '[A-Za-z0-9_]{3,20}', required: true, maxlength: '20', 'data-testid': 'chat-nick-input', 'aria-describedby': 'chat-nick-err' }),
          h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, tx('chat.mount_chat.save'))),
        h('div', { class: 'form-error', id: 'chat-nick-err', role: 'alert' }));
      form.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api.saveProfile(session.uid, { nickname: form.nickname.value.trim() });
          session.nickname = r.profile.nickname; session.notify();
          await refreshViewer();
          $('[data-input]')?.focus();
        } catch (ex) { form.querySelector('.form-error').textContent = ex.message; }
      };
      foot.append(form);
    } else if (b) {
      const text = {
        banned: tx('chat.mount_chat.your_posting_privileges_were_removed'),
        feature_disabled: tx('chat.mount_chat.social_features_are_turned_off'),
        locked: tx('chat.mount_chat.a_moderator_locked_this_chat'),
        closed: tx('chat.mount_chat.this_event_has_closed_the'),
        muted: tx('chat.mount_chat.you_re_muted_in_this', { value: st.viewer?.muted_until ? clock(st.viewer.muted_until) : 'later' }),
      }[b];
      foot.append(h('div', { class: `chat-prompt blocked ${b}`, 'data-testid': `chat-blocked`, 'data-block': b }, text));
      foot.append(h('div', { class: 'form-error chat-err', 'data-err': '', role: 'alert', 'data-testid': 'chat-error' }));
    } else {
      const input = h('textarea', { class: 'chat-input', 'data-input': '', rows: '1', placeholder: tx('chat.mount_chat.say_something'), 'aria-label': tx('chat.mount_chat.chat_message'), 'data-testid': 'chat-input', enterkeyhint: 'send', spellcheck: 'true' });
      const send = h('button', { class: 'btn btn-primary btn-sm chat-send', type: 'submit', 'data-send': '', 'data-testid': 'chat-send', disabled: true }, tx('chat.mount_chat.send'));
      const stickerBtn = h('button', { class: 'btn btn-sm btn-ghost chat-sticker-btn', type: 'button', 'data-sticker-btn': 'chat', 'data-testid': 'chat-sticker-btn', 'aria-label': tx('chat.mount_chat.send_a_sticker') }, '☺');
      stickerBtn.onclick = (e) => openStickerPicker(e.currentTarget, (sk) => submit({ sticker_id: sk.id }));
      const form = h('form', { class: 'chat-form', 'data-form': '' }, stickerBtn, input, send);
      foot.append(
        h('div', { class: 'chat-replying', 'data-reply': '', 'data-testid': 'chat-replying', hidden: true }, h('span', { class: 'chat-replying-text' }, (tx('chat.mount_chat.replying_to') + ' '), h('b', { 'data-reply-nick': '' })),
          h('button', { class: 'chat-act', type: 'button', 'data-reply-cancel': '', 'aria-label': tx('chat.mount_chat.cancel_reply') }, '✕')),
        form,
        h('div', { class: 'chat-foot-row' }, h('span', { class: 'chat-cool', 'data-cool': '', 'data-testid': 'chat-cooldown', hidden: true }), h('span', { class: 'grow' }), h('span', { class: 'chat-count', 'data-count': '', 'data-testid': 'chat-count' }, `0/${MAX}`)),
        h('div', { class: 'form-error chat-err', 'data-err': '', role: 'alert', 'data-testid': 'chat-error' }));
      input.addEventListener('input', () => { autosize(input); updateComposer(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
      form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
      foot.querySelector('[data-reply-cancel]').onclick = () => setReply(null);
      setReply(st.replyTo);
      updateComposer();
    }
  }
  function autosize(t) { t.style.height = 'auto'; t.style.height = `${Math.min(120, t.scrollHeight)}px`; }
  function updateComposer() {
    const input = $('[data-input]');
    if (!input) return;
    const n = chars(input.value);
    const count = $('[data-count]');
    count.textContent = `${n}/${MAX}`;
    count.classList.toggle('over', n > MAX);
    const cool = Math.max(0, Math.ceil((st.coolUntil - Date.now()) / 1000));
    const c = $('[data-cool]');
    c.hidden = !cool;
    c.textContent = cool ? tx('chat.mount_chat.slow_mode_wait_s', { cool }) : '';
    $('[data-send]').disabled = !input.value.trim() || n > MAX || cool > 0 || st.sending;
  }
  function startCooldown(sec) {
    st.coolUntil = Date.now() + sec * 1000;
    updateComposer();
  }
  function setReply(m) {
    st.replyTo = m;
    const box = $('[data-reply]');
    if (!box) return;
    box.hidden = !m;
    if (m) { box.querySelector('[data-reply-nick]').textContent = `@${m.nickname}`; $('[data-input]')?.focus(); }
  }
  const showErr = (msg) => { const e = $('[data-err]'); if (e) e.textContent = msg; };
  async function submit(extra = null) {
    const input = $('[data-input]');
    const body = input.value.trim();
    if ((!body && !extra) || chars(body) > MAX || st.sending || Date.now() < st.coolUntil) return;
    st.sending = true; updateComposer(); showErr('');
    try {
      const r = extra ? await api.chatPostWith(session.uid, T, { ...extra, body: body || null, reply_to: st.replyTo?.id || null }) : await api.chatPost(session.uid, T, { body, reply_to: st.replyTo?.id || null });
      add(r.message); toBottom();
      input.value = ''; autosize(input); setReply(null);
      if (r.slow_mode_sec && !isMod()) startCooldown(r.slow_mode_sec);
    } catch (e) {
      if (e.status === 429) { startCooldown(e.retryAfter || 5); showErr(e.message); }
      else if (e.code === 'chat_muted') { st.viewer.muted_until = e.mutedUntil || new Date(Date.now() + 60000).toISOString(); drawFoot(); showErr(e.message); }
      else if (e.code === 'chat_locked' || e.code === 'chat_closed') { st.room.status = e.code === 'chat_locked' ? 'locked' : 'read_only'; drawRoom(); showErr(e.message); }
      else if (e.code === 'social_profile_required') { st.viewer.block = 'no_nickname'; drawFoot(); }
      else if (e.code === 'posting_banned') { st.viewer.block = 'banned'; drawFoot(); showErr(e.message); }
      else showErr(e.unauthorized ? tx('chat.mount_chat.your_session_expired_please_log') : e.message);
    } finally { st.sending = false; updateComposer(); }
  }

  // ---------------- per-message actions (event delegation)
  function closeMenu() { st.menu?.remove(); st.menu = null; }
  function openMenu(row, btn) {
    closeMenu();
    const id = row.dataset.id;
    const mine = row.classList.contains('mine');
    const menu = h('div', { class: 'chat-menu', role: 'menu', 'data-testid': 'chat-menu' });
    if (st.viewer?.signed_in && !mine) {
      menu.append(h('div', { class: 'chat-menu-head' }, tx('chat.mount_chat.report')));
      for (const [label, code] of REPORT_REASONS) menu.append(h('button', { type: 'button', role: 'menuitem', 'data-report': code, 'data-testid': `chat-report-${code}` }, label));
    }
    if (isMod()) {
      menu.append(h('div', { class: 'chat-menu-head' }, tx('chat.mount_chat.moderate')));
      menu.append(h('button', { type: 'button', role: 'menuitem', 'data-pin': id, 'data-testid': 'chat-pin' }, tx('chat.mount_chat.pin_message')));
      if (!mine) for (const [min, label] of MUTES) menu.append(h('button', { type: 'button', role: 'menuitem', 'data-mute': min, 'data-testid': `chat-mute-${min}` }, tx('chat.mount_chat.mute_author', { label })));
    }
    row.append(menu);
    st.menu = menu;
    menu.querySelector('button')?.focus();
    void btn;
  }
  list.addEventListener('click', async (e) => {
    const older = e.target.closest('[data-load-older]');
    if (older) { loadOlder(); return; }
    const row = e.target.closest('.chat-msg');
    if (!row) return;
    const id = row.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'reply') { setReply({ id, nickname: row.dataset.nick }); return; }
      if (act === 'edit') { startEdit(row); return; }
      const rx = e.target.closest('[data-react]');
      if (rx) { const on = rx.getAttribute('aria-pressed') !== 'true'; const r = await api.chatReact(session.uid, T, id, rx.dataset.react, on); applyReactions(id, r.reactions, r.my_reactions); return; }
      if (e.target.closest('[data-react-add]')) { openReactionPicker(row); return; }
      const pick = e.target.closest('[data-react-pick]');
      if (pick) { closeMenu(); const r = await api.chatReact(session.uid, T, id, pick.dataset.reactPick, true); applyReactions(id, r.reactions, r.my_reactions); return; }
      if (act === 'delete') { await api.chatDelete(session.uid, T, id); removeMsg(id); toast(tx('chat.mount_chat.message_deleted')); return; }
      if (act === 'more') { if (st.menu && st.menu.parentElement === row) closeMenu(); else openMenu(row, e.target); return; }
      const rep = e.target.closest('[data-report]');
      if (rep) {
        const label = REPORT_REASONS.find(([, c]) => c === rep.dataset.report)[0];
        closeMenu();
        await api.chatReport(session.uid, T, id, label);
        toast(tx('chat.mount_chat.thanks_a_moderator_will_review'));
        return;
      }
      if (e.target.closest('[data-pin]')) { closeMenu(); const r = await api.chatMod(T, 'pin', { message_id: id }); st.room.pinned = r.room.pinned; drawPinned(); toast(tx('chat.mount_chat.message_pinned')); return; }
      const mute = e.target.closest('[data-mute]');
      if (mute) { closeMenu(); const r = await api.chatMod(T, 'mute', { message_id: id, minutes: Number(mute.dataset.mute), reason: 'muted from the event chat' }); toast(tx('chat.mount_chat.muted_until', { nickname: r.nickname, clock: clock(r.muted_until) })); }
    } catch (ex) { closeMenu(); toast(ex.message, 'error'); }
  });
  function openReactionPicker(row) {
    closeMenu();
    const menu = h('div', { class: 'chat-menu chat-react-menu', role: 'menu', 'data-testid': 'chat-react-menu' }, ...REACTIONS.map(([k, emoji, label]) => h('button', { type: 'button', role: 'menuitem', 'data-react-pick': k, 'aria-label': label, 'data-testid': `chat-react-pick-${k}` }, emoji)));
    row.append(menu); st.menu = menu;
  }
  // Server counts are authoritative; my own selection is kept from the REST answer (live frames carry counts only).
  function applyReactions(id, reactions, myReactions) {
    const row = panel.querySelector(`.chat-msg[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const prev = row.querySelector('[data-testid=chat-reactions]');
    const mineNow = myReactions || [...row.querySelectorAll('.chat-react.on[data-react]')].map((b) => b.dataset.react);
    prev.replaceWith(reactionsEl({ reactions, my_reactions: mineNow }));
  }
  function startEdit(row) {
    if (row.querySelector('[data-edit-form]')) return;
    const bodyEl = row.querySelector('[data-testid=chat-body]');
    const input = h('input', { class: 'chat-edit-input', maxlength: String(MAX * 2), 'aria-label': tx('chat.mount_chat.edit_message'), 'data-testid': 'chat-edit-input' });
    input.value = [...bodyEl.childNodes].filter((n) => !(n.classList && n.classList.contains('chat-edited'))).map((n) => n.textContent).join('');
    const form = h('form', { class: 'chat-edit', 'data-edit-form': '' }, input, h('button', { class: 'btn btn-sm btn-primary', type: 'submit', 'data-testid': 'chat-edit-save' }, tx('chat.mount_chat.save')), Object.assign(h('button', { class: 'btn btn-sm', type: 'button' }, tx('chat.mount_chat.cancel')), { onclick: () => { form.remove(); bodyEl.hidden = false; } }));
    bodyEl.hidden = true; bodyEl.after(form); input.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api.chatEdit(session.uid, T, row.dataset.id, input.value); replaceMsg(r.message); } catch (ex) { toast(ex.code === 'edit_window_closed' ? tx('chat.mount_chat.messages_can_be_edited_for') : ex.message, 'error'); }
    };
  }
  function replaceMsg(m) {
    const row = panel.querySelector(`.chat-msg[data-id="${CSS.escape(m.id)}"]`);
    if (!row) return;
    const keepMine = [...row.querySelectorAll('.chat-react.on[data-react]')].map((b) => b.dataset.react);
    row.replaceWith(msgEl({ ...m, my_reactions: m.my_reactions || keepMine }));
  }
  list.addEventListener('scroll', () => {
    if (list.scrollTop < 60) loadOlder();
    if (nearBottom()) st.unseen = 0;
    drawJump();
  });
  $('[data-jump]').onclick = () => toBottom();
  $('[data-close]').onclick = () => setOpen(false);
  backdrop.onclick = () => setOpen(false);
  $('[data-unpin]').onclick = async () => { try { const r = await api.chatMod(T, 'unpin', {}); st.room.pinned = r.room.pinned; drawPinned(); } catch (ex) { toast(ex.message, 'error'); } };
  $('[data-mod-toggle]').onclick = () => { const bar = $('[data-modbar]'); bar.hidden = !bar.hidden; $('[data-mod-toggle]').setAttribute('aria-expanded', String(!bar.hidden)); };
  $('[data-slow]').onchange = async (e) => {
    try { const r = await api.chatMod(T, 'slow_mode', { seconds: Number(e.target.value), reason: 'set from the event chat' }); st.room = { ...st.room, ...r.room }; drawRoom(); toast(Number(e.target.value) ? tx('chat.mount_chat.slow_mode_s', { value: e.target.value }) : tx('chat.mount_chat.slow_mode_off')); } catch (ex) { toast(ex.message, 'error'); }
  };
  $('[data-lock]').onclick = async () => {
    const lock = !st.room.locked;
    try { const r = await api.chatMod(T, lock ? 'lock' : 'unlock', { reason: lock ? 'locked from the event chat' : '' }); st.room = { ...st.room, ...r.room }; drawRoom(); toast(lock ? tx('chat.mount_chat.chat_locked') : tx('chat.mount_chat.chat_unlocked')); } catch (ex) { toast(ex.message, 'error'); }
  };
  document.addEventListener('click', onDocClick);
  function onDocClick(e) { if (st.menu && !e.target.closest('.chat-menu') && !e.target.closest('[data-act=more]') && !e.target.closest('[data-react-add]')) closeMenu(); }

  // ---------------- open / close
  function setOpen(open) {
    st.open = open;
    panel.hidden = !open;
    backdrop.hidden = !open;
    pill.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('chat-open', open);
    if (open) {
      st.unreadClosed = 0; drawUnread();
      toBottom();
      ($('[data-input]') || $('[data-close]')).focus();
    } else { closeMenu(); pill.focus({ preventScroll: true }); }
  }
  function drawUnread() { const b = pill.querySelector('[data-testid=chat-unread]'); b.hidden = !st.unreadClosed; b.textContent = st.unreadClosed > 99 ? '99+' : String(st.unreadClosed); }
  pill.onclick = () => setOpen(!st.open);
  if (sbEntry) sbEntry.onclick = () => setOpen(true);
  const onKey = (e) => { if (e.key === 'Escape' && st.open) { if (st.menu) closeMenu(); else setOpen(false); } };
  document.addEventListener('keydown', onKey);

  // ---------------- data: initial page, live updates, reconnect gap-fill
  async function refreshViewer() {
    const r = await api.chat(T, { limit: 1 });
    st.viewer = r.viewer; st.room = r.room;
    st.footMode = ''; drawRoom();
  }
  async function loadLatest({ merge = false } = {}) {
    const r = await api.chat(T, { limit: PAGE });
    st.room = r.room; st.viewer = r.viewer;
    if (merge && r.messages.length) {
      const fresh = new Set(r.messages.map((m) => m.id));
      const since = Date.parse(r.messages[0].created_time);
      for (const node of [...msgsBox.children]) {
        const t = Date.parse(node.querySelector('time')?.getAttribute('datetime') || 0);
        if (t >= since && !fresh.has(node.dataset.id)) removeMsg(node.dataset.id); // deleted while we were offline
      }
    }
    const stick = !st.open || nearBottom();
    for (const m of r.messages) add(m);
    if (!merge) { st.oldest = r.messages[0]?.id || null; st.hasMore = r.has_more; }
    $('[data-empty]').hidden = st.ids.size > 0;
    st.footMode = '';
    drawRoom(); drawOlder();
    if (st.open && stick) toBottom();
    if (st.viewer?.slow_mode_wait_sec) startCooldown(st.viewer.slow_mode_wait_sec);
  }
  function onSocket(m) {
    const msg = m.msg || {};
    if (msg.event_ticker !== T) return;
    if (m.type === 'chat_message') {
      const stick = nearBottom();
      if (!add(msg)) return;
      if (!st.open) { st.unreadClosed += 1; drawUnread(); } else if (stick || mineOf(msg)) toBottom(); else { st.unseen += 1; drawJump(); }
      if (st.room) st.room.message_count += 1;
    } else if (m.type === 'chat_deleted') {
      removeMsg(msg.id);
      if (st.room?.pinned?.id === msg.id) { st.room.pinned = null; drawPinned(); }
    } else if (m.type === 'chat_pinned') {
      if (st.room) { st.room.pinned = msg.pinned; drawPinned(); }
    } else if (m.type === 'chat_room_state') {
      st.room = msg; drawRoom();
    } else if (m.type === 'chat_reactions') {
      applyReactions(msg.id, msg.reactions, null);
    } else if (m.type === 'chat_edited') {
      replaceMsg(msg);
    }
  }
  const unsub = socket.subscribe({ channels: ['chat'], event_tickers: [T] }, onSocket);
  const offState = socket.onState((s) => {
    if (!s.connected) { st.wasDown = true; return; }
    if (st.wasDown) { st.wasDown = false; loadLatest({ merge: true }).catch(() => {}); }
  });
  timers.push(setInterval(() => { for (const t of panel.querySelectorAll('.chat-msg time')) t.textContent = relTime(t.getAttribute('datetime')); }, 30000));
  timers.push(setInterval(() => {
    if (st.coolUntil && Date.now() < st.coolUntil + 1000) updateComposer();
    if (st.viewer?.muted_until && block() !== 'muted' && st.footMode === 'block:muted') drawFoot(); // mute expired
  }, 250));
  loadLatest().catch((e) => { pill.title = e.message; });

  return () => {
    unsub(); offState();
    for (const t of timers) clearInterval(t);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onDocClick);
    document.body.classList.remove('chat-open');
    panel.remove(); backdrop.remove(); pill.remove(); sbEntry?.remove();
  };
}
