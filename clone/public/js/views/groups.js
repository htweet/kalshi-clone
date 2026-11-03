// Group chats (/messages, /messages/:id; PLAN §11 A11, PHASE2_SPEC.md §24.7): the list of your groups with unread
// counts, a conversation with live messages over the private `groups` WebSocket channel, replies, stickers, delete own,
// report others, mute (hides that person everywhere for you), members (add from your mutual follows / Inner Circle,
// owner removes, rename, leave), and "New group".
//
// Security: every piece of user content (group name, nicknames, bodies, quotes) is written with textContent through
// h(); no user content reaches innerHTML. Live frames only arrive for groups you belong to (server-side membership).
import { api } from '../api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { toast, relTime } from '../lib.js';
import { h, openStickerPicker, mutedNicks, toggleMute } from './social2.js';

const MAX = 500;
const chars = (s) => [...s].length;
const REPORTS = ['Spam or scam', 'Harassment or hate', 'Something else'];

export async function render({ el, params, navigate }) {
  if (!session.user) { navigate(`/sign-in?next=${encodeURIComponent(location.pathname)}`, { replace: true }); return undefined; }
  document.title = 'Group chats · Parlance';
  const st = { groups: [], current: params.id || null, group: null, ids: new Set(), muted: new Set(), replyTo: null, oldest: null, hasMore: false, gone: false, listSeq: 0, convSeq: 0, menu: null };
  const listBox = h('div', { class: 'group-list', 'data-testid': 'group-list' });
  const conv = h('section', { class: 'group-conv card', 'data-testid': 'group-conv' });
  const newBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-testid': 'new-group' }, 'New group');
  const aside = h('aside', { class: 'group-side card' }, h('div', { class: 'd-flex jc-between ai-center group-side-head' }, h('h2', { class: 'typ-title-x20 m-0' }, 'Group chats'), newBtn), listBox);
  const layout = h('div', { class: `groups-layout${st.current ? ' has-conv' : ''}`, 'data-testid': 'groups-page' }, aside, conv);
  el.replaceChildren(layout);
  newBtn.onclick = () => newGroupDialog(navigate);
  st.muted = await mutedNicks();

  // ---------------- list
  async function loadList() {
    const seq = ++st.listSeq;
    const { groups } = await api.groups(session.uid);
    if (seq !== st.listSeq || st.gone) return;
    st.groups = groups;
    drawList();
  }
  function drawList() {
    listBox.replaceChildren(...(st.groups.length ? st.groups.map((g) => h('a', { class: `group-item${g.id === st.current ? ' on' : ''}`, href: `/messages/${encodeURIComponent(g.id)}`, 'data-link': '', 'data-group': g.id, 'data-testid': 'group-item' },
      h('span', { class: 'group-name' }, g.name), g.unread && g.id !== st.current ? h('span', { class: 'dot-count', 'data-testid': 'group-unread' }, String(g.unread)) : null,
      h('span', { class: 'faint group-last' }, g.last_message ? `${g.last_message.nickname ? `@${g.last_message.nickname}: ` : ''}${g.last_message.excerpt}` : `${g.member_count} members`))) : [h('div', { class: 'faint empty', 'data-testid': 'no-groups' }, 'No group chats yet. Start one with people who follow you back or are in your Inner Circle.')]));
  }

  // ---------------- conversation
  const msgsBox = h('div', { class: 'gmsgs', 'data-testid': 'group-messages', role: 'log', 'aria-live': 'polite' });
  function msgEl(m) {
    if (m.kind === 'system') return h('div', { class: 'gmsg system', 'data-id': m.id, 'data-testid': 'group-system' }, m.body);
    const mine = m.is_mine;
    const row = h('div', { class: `gmsg${mine ? ' mine' : ''}`, 'data-id': m.id, 'data-nick': m.author.nickname, 'data-testid': 'group-msg' });
    if (m.reply_to) row.append(m.reply_to.deleted ? h('div', { class: 'chat-quote deleted' }, 'Original message was deleted') : h('div', { class: 'chat-quote', 'data-testid': 'group-quote' }, h('b', {}, `@${m.reply_to.nickname}`), ' ', m.reply_to.excerpt));
    const acts = h('span', { class: 'chat-acts' }, h('button', { class: 'chat-act', type: 'button', 'data-act': 'reply', 'data-testid': 'group-reply' }, 'Reply'),
      mine ? h('button', { class: 'chat-act danger', type: 'button', 'data-act': 'delete', 'data-testid': 'group-del' }, 'Delete') : h('button', { class: 'chat-act more', type: 'button', 'data-act': 'more', 'aria-label': 'More actions', 'data-testid': 'group-more' }, '⋯'));
    row.append(h('div', { class: 'chat-meta' }, h('span', { class: 'chat-nick', 'data-testid': 'group-nick' }, `@${m.author.nickname}`), m.author.verified ? h('span', { class: 'verified-badge', title: 'Verified profile' }, '✓') : null,
      h('time', { class: 'chat-time', datetime: m.created_time }, relTime(m.created_time)), acts));
    if (m.body) row.append(h('div', { class: 'chat-body', 'data-testid': 'group-body' }, m.body));
    if (m.sticker) row.append(h('img', { class: 'chat-sticker', src: m.sticker.url, alt: m.sticker.label, title: m.sticker.label, width: '72', height: '72', 'data-testid': 'group-sticker' }));
    return row;
  }
  function add(m, { prepend = false } = {}) {
    if (st.ids.has(m.id)) return false;
    if (m.author && st.muted.has(m.author.nickname.toLowerCase())) return false; // muted: hidden for me only
    st.ids.add(m.id);
    if (prepend) msgsBox.querySelector('[data-older]')?.after(msgEl(m)); else msgsBox.append(msgEl(m));
    return true;
  }
  const toBottom = () => { msgsBox.scrollTop = msgsBox.scrollHeight; };

  async function openGroup(id) {
    const seq = ++st.convSeq;
    st.ids = new Set(); st.replyTo = null;
    let r;
    try { r = await api.group(session.uid, id, { limit: 50 }); } catch (e) {
      if (seq !== st.convSeq) return;
      conv.replaceChildren(h('div', { class: 'empty', 'data-testid': 'group-missing' }, e.notFound ? 'This group chat isn’t available. You may have left or been removed.' : e.message), h('a', { class: 'btn btn-sm', href: '/messages', 'data-link': '' }, 'All group chats'));
      return;
    }
    if (seq !== st.convSeq || st.gone) return;
    st.group = r.group;
    document.title = `${r.group.name} · Group chats · Parlance`;
    msgsBox.replaceChildren(h('div', { 'data-older': '' }));
    st.hasMore = r.has_more; st.oldest = r.messages[0]?.id || null;
    drawOlder();
    for (const m of r.messages) add(m);
    drawConv();
    toBottom();
    api.groupRead(session.uid, id).then(() => { const g = st.groups.find((x) => x.id === id); if (g) { g.unread = 0; drawList(); } }).catch(() => {});
  }
  function drawOlder() {
    const box = msgsBox.querySelector('[data-older]');
    if (!box) return;
    box.replaceChildren(st.hasMore ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-load-older': '', 'data-testid': 'group-older' }, 'Load earlier messages') : h('span', { class: 'faint' }, 'Beginning of the conversation'));
  }
  async function loadOlder() {
    if (!st.hasMore || !st.oldest) return;
    const r = await api.group(session.uid, st.current, { before: st.oldest, limit: 50 });
    for (const m of [...r.messages].reverse()) add(m, { prepend: true });
    if (r.messages.length) st.oldest = r.messages[0].id;
    st.hasMore = r.has_more; drawOlder();
  }
  function drawConv() {
    const g = st.group;
    const back = h('a', { class: 'btn btn-sm btn-ghost group-back', href: '/messages', 'data-link': '' }, '← Chats');
    const membersBtn = h('button', { class: 'btn btn-sm', type: 'button', 'data-testid': 'group-members-btn' }, `${g.members.length} members`);
    membersBtn.onclick = () => membersDialog();
    const input = h('textarea', { class: 'chat-input', rows: '1', maxlength: String(MAX * 2), placeholder: g.locked ? 'A moderator locked this group' : 'Message', 'aria-label': 'Message', 'data-testid': 'group-input', disabled: g.locked });
    const send = h('button', { class: 'btn btn-primary btn-sm', type: 'submit', 'data-testid': 'group-send', disabled: true }, 'Send');
    const sticker = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-sticker-btn': 'group', 'data-testid': 'group-sticker-btn', 'aria-label': 'Send a sticker', disabled: g.locked }, 'Sticker');
    const count = h('span', { class: 'chat-count', 'data-testid': 'group-count' }, `0/${MAX}`);
    const err = h('div', { class: 'form-error', role: 'alert', 'data-testid': 'group-error' });
    const replying = h('div', { class: 'chat-replying', hidden: true, 'data-testid': 'group-replying' });
    const form = h('form', { class: 'chat-form' }, sticker, input, send);
    const update = () => { const n = chars(input.value); count.textContent = `${n}/${MAX}`; count.classList.toggle('over', n > MAX); send.disabled = !input.value.trim() || n > MAX || g.locked; };
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    const submit = async (b) => {
      err.textContent = '';
      try {
        const { message } = await api.groupSend(session.uid, g.id, { ...b, reply_to: st.replyTo?.id || null });
        add(message); toBottom(); input.value = ''; update(); setReply(null);
      } catch (ex) { err.textContent = ex.tooManyRequests ? `You're sending too quickly. Try again in ${ex.retryAfter || 5}s.` : ex.message; }
    };
    form.onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) submit({ body: input.value }); };
    sticker.onclick = (e) => openStickerPicker(e.currentTarget, (s) => submit({ body: input.value, sticker_id: s.id }));
    st.setReply = (m) => { st.replyTo = m; replying.hidden = !m; replying.replaceChildren(...(m ? [h('span', {}, 'Replying to ', h('b', {}, `@${m.nickname}`)), Object.assign(h('button', { class: 'chat-act', type: 'button', 'aria-label': 'Cancel reply' }, '✕'), { onclick: () => st.setReply(null) })] : [])); if (m) input.focus(); };
    conv.replaceChildren(
      h('header', { class: 'group-head' }, back, h('h2', { class: 'typ-title-x20 m-0 group-title', 'data-testid': 'group-title' }, g.name), g.locked ? h('span', { class: 'adm-badge bad', 'data-testid': 'group-locked' }, 'Locked') : null, h('span', { class: 'grow' }), membersBtn),
      msgsBox, replying, form, h('div', { class: 'chat-foot-row' }, h('span', { class: 'grow' }), count), err);
    update();
  }
  const setReply = (m) => st.setReply?.(m);

  // ---------------- members, add, remove, rename, leave
  async function membersDialog() {
    const g = st.group;
    const d = document.createElement('dialog');
    d.className = 'adm-dialog';
    d.dataset.testid = 'group-members-dialog';
    const list = h('div', { class: 'circle-list' });
    const owner = g.role === 'owner';
    for (const m of g.members) {
      const row = h('div', { class: 'circle-row', 'data-testid': 'group-member', 'data-nick': m.nickname }, h('a', { href: `/social/profile/${encodeURIComponent(m.nickname)}`, 'data-link': '' }, `@${m.nickname}`), m.role === 'owner' ? h('span', { class: 'faint' }, 'owner') : null, h('span', { class: 'grow' }));
      if (owner && m.nickname !== session.nickname) {
        const rm = h('button', { class: 'btn btn-sm btn-ghost btn-danger', type: 'button', 'data-testid': 'group-remove' }, 'Remove');
        rm.onclick = async () => { try { await api.removeGroupMember(session.uid, g.id, m.nickname); toast(`Removed @${m.nickname}`); d.close(); await openGroup(g.id); } catch (ex) { toast(ex.message, 'error'); } };
        row.append(rm);
      }
      list.append(row);
    }
    const cands = h('div', { class: 'cand-list', 'data-testid': 'group-candidates' }, h('span', { class: 'faint' }, 'Loading…'));
    const addBtn = h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-testid': 'group-add-submit' }, 'Add selected');
    const rename = owner ? h('form', { class: 'inline-form' }, h('label', { class: 'field flex-1' }, h('span', {}, 'Group name'), h('input', { name: 'name', value: g.name, maxlength: '50', required: true, 'data-testid': 'group-rename-input' })), h('button', { class: 'btn btn-sm', type: 'submit', 'data-testid': 'group-rename' }, 'Rename')) : null;
    const leave = h('button', { class: 'btn btn-sm btn-ghost btn-danger', type: 'button', 'data-testid': 'group-leave' }, 'Leave group');
    const close = h('button', { class: 'btn btn-sm', type: 'button' }, 'Close');
    d.append(h('div', { class: 'adm-confirm' }, h('h3', {}, g.name), list, h('h4', {}, 'Add people'), h('p', { class: 'faint m-0' }, 'People who follow you back or are in your Inner Circle.'), cands, addBtn, rename, h('div', { class: 'adm-form-actions' }, leave, close)));
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    close.onclick = () => d.close();
    if (rename) rename.onsubmit = async (e) => { e.preventDefault(); try { await api.renameGroup(session.uid, g.id, rename.name.value); d.close(); await openGroup(g.id); loadList(); } catch (ex) { toast(ex.message, 'error'); } };
    leave.onclick = async () => { if (!confirm('Leave this group? You will stop receiving its messages.')) return; try { await api.leaveGroup(session.uid, g.id); d.close(); toast('You left the group'); navigate('/messages'); } catch (ex) { toast(ex.message, 'error'); } };
    addBtn.onclick = async () => {
      const picked = [...cands.querySelectorAll('input:checked')].map((x) => x.value);
      if (!picked.length) return;
      try { await api.addGroupMembers(session.uid, g.id, picked); d.close(); toast('Added'); await openGroup(g.id); } catch (ex) { toast(ex.message, 'error'); }
    };
    d.showModal();
    try {
      const { candidates } = await api.groupCandidates(session.uid);
      const inGroup = new Set(g.members.map((m) => m.nickname.toLowerCase()));
      const avail = candidates.filter((c) => !inGroup.has(c.nickname.toLowerCase()));
      cands.replaceChildren(...(avail.length ? avail.map((c) => h('label', { class: 'opt-row', 'data-testid': 'group-candidate' }, h('input', { type: 'checkbox', value: c.nickname }), `@${c.nickname}`, c.in_circle ? h('span', { class: 'faint' }, ' · Inner Circle') : null)) : [h('span', { class: 'faint' }, 'Everyone you can add is already here.')]));
    } catch (ex) { cands.replaceChildren(h('span', { class: 'form-error' }, ex.message)); }
  }

  // ---------------- message actions
  msgsBox.addEventListener('click', async (e) => {
    if (e.target.closest('[data-load-older]')) { loadOlder().catch((ex) => toast(ex.message, 'error')); return; }
    const row = e.target.closest('.gmsg[data-id]');
    if (!row) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'reply') setReply({ id: row.dataset.id, nickname: row.dataset.nick });
      else if (act === 'delete') { await api.groupDelete(session.uid, st.current, row.dataset.id); row.remove(); st.ids.delete(row.dataset.id); }
      else if (act === 'more') {
        st.menu?.remove();
        const menu = h('div', { class: 'chat-menu', role: 'menu', 'data-testid': 'group-menu' }, h('div', { class: 'chat-menu-head' }, 'Report'),
          ...REPORTS.map((r, i) => Object.assign(h('button', { type: 'button', role: 'menuitem', 'data-testid': `group-report-${i}` }, r), { onclick: async (ev) => { ev.stopPropagation(); menu.remove(); try { await api.groupReport(session.uid, st.current, row.dataset.id, r); toast('Thanks. A moderator will review this message.'); } catch (ex) { toast(ex.message, 'error'); } } })),
          Object.assign(h('button', { type: 'button', role: 'menuitem', 'data-testid': 'group-mute' }, `Mute @${row.dataset.nick}`), { onclick: async (ev) => { ev.stopPropagation(); menu.remove(); await toggleMute(row.dataset.nick, true); st.muted = await mutedNicks(); for (const x of msgsBox.querySelectorAll('.gmsg[data-nick]')) if (x.dataset.nick.toLowerCase() === row.dataset.nick.toLowerCase()) x.remove(); } }));
        row.append(menu); st.menu = menu;
      }
    } catch (ex) { toast(ex.message, 'error'); }
  });

  // ---------------- live
  const onSocket = (m) => {
    const msg = m.msg || {};
    if (m.type === 'group_message') {
      const g = st.groups.find((x) => x.id === msg.group_id);
      if (msg.group_id === st.current && st.group) {
        const near = msgsBox.scrollHeight - msgsBox.scrollTop - msgsBox.clientHeight < 120;
        if (add(msg) && (near || msg.is_mine)) toBottom();
        api.groupRead(session.uid, st.current).catch(() => {});
      } else if (g && !msg.is_mine && msg.kind === 'text' && !st.muted.has(msg.author.nickname.toLowerCase())) { g.unread += 1; }
      if (g) { g.last_message = { nickname: msg.author ? msg.author.nickname : null, excerpt: msg.body || 'Sticker', created_time: msg.created_time }; st.groups = [g, ...st.groups.filter((x) => x !== g)]; drawList(); } else loadList().catch(() => {});
    } else if (m.type === 'group_message_deleted') {
      if (msg.group_id === st.current) { msgsBox.querySelector(`.gmsg[data-id="${CSS.escape(msg.id)}"]`)?.remove(); st.ids.delete(msg.id); }
    } else if (m.type === 'group_updated') {
      const i = st.groups.findIndex((x) => x.id === msg.id);
      if (i >= 0) { st.groups[i] = { ...st.groups[i], ...msg, unread: msg.id === st.current ? 0 : msg.unread }; drawList(); } else loadList().catch(() => {});
      if (msg.id === st.current && st.group && (msg.name !== st.group.name || msg.locked !== st.group.locked || msg.member_count !== st.group.members.length)) openGroup(msg.id).catch(() => {});
    } else if (m.type === 'group_removed') {
      st.groups = st.groups.filter((x) => x.id !== msg.id); drawList();
      if (msg.id === st.current) { conv.replaceChildren(h('div', { class: 'empty', 'data-testid': 'group-removed' }, msg.by === 'self' ? 'You left this group.' : 'You were removed from this group.'), h('a', { class: 'btn btn-sm', href: '/messages', 'data-link': '' }, 'All group chats')); st.group = null; }
    }
  };
  const unsub = socket.subscribe({ channels: ['groups'] }, onSocket);
  const onMutes = async () => { st.muted = await mutedNicks(); };
  window.addEventListener('parlance:mutes-changed', onMutes);
  const offState = socket.onState((s) => { if (s.connected && st.current) openGroup(st.current).catch(() => {}); });

  await loadList();
  if (st.current) await openGroup(st.current);
  else conv.replaceChildren(h('div', { class: 'empty faint' }, 'Pick a group chat, or start a new one.'));
  return () => { st.gone = true; unsub(); offState(); window.removeEventListener('parlance:mutes-changed', onMutes); };
}

async function newGroupDialog(navigate) {
  const d = document.createElement('dialog');
  d.className = 'adm-dialog';
  d.dataset.testid = 'new-group-dialog';
  const name = h('input', { name: 'name', maxlength: '50', required: true, placeholder: 'e.g. Rate watchers', 'data-testid': 'new-group-name' });
  const cands = h('div', { class: 'cand-list', 'data-testid': 'new-group-candidates' }, h('span', { class: 'faint' }, 'Loading…'));
  const err = h('div', { class: 'form-error', role: 'alert' });
  const create = h('button', { class: 'btn btn-primary', type: 'submit', 'data-testid': 'new-group-create' }, 'Create group');
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const form = h('form', { class: 'adm-confirm' }, h('h3', {}, 'New group chat'), h('label', { class: 'field' }, h('span', {}, 'Name'), name), h('h4', {}, 'People'), h('p', { class: 'faint m-0' }, 'You can add people who follow you back or are in your Inner Circle.'), cands, err, h('div', { class: 'adm-form-actions' }, cancel, create));
  d.append(form);
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  cancel.onclick = () => d.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const members = [...cands.querySelectorAll('input:checked')].map((x) => x.value);
    if (!members.length) { err.textContent = 'Pick at least one person.'; return; }
    try { const { group } = await api.createGroup(session.uid, { name: name.value, members }); d.close(); navigate(`/messages/${encodeURIComponent(group.id)}`); } catch (ex) { err.textContent = ex.message; }
  };
  d.showModal();
  try {
    const { candidates } = await api.groupCandidates(session.uid);
    cands.replaceChildren(...(candidates.length ? candidates.map((c) => h('label', { class: 'opt-row', 'data-testid': 'new-group-candidate' }, h('input', { type: 'checkbox', value: c.nickname }), `@${c.nickname}`, c.in_circle ? h('span', { class: 'faint' }, ' · Inner Circle') : null)) : [h('span', { class: 'faint', 'data-testid': 'no-candidates' }, 'Follow people who follow you back, or add them to your Inner Circle, to start a group.')]));
  } catch (ex) { cands.replaceChildren(h('span', { class: 'form-error' }, ex.message)); }
}
