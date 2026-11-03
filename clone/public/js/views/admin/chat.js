// Chat moderation (CLONE_SPEC.md §20.7): rooms list with activity, then one room: state (slow mode, lock, read-only
// after close), pinned message, active mutes, and the latest 200 messages (including deleted ones) with delete / pin /
// mute actions. Every action is permission-checked server-side (social.moderate) and written to the audit log.
// All user content is passed through esc() before it reaches the table markup.
import { esc, get, post, toast, dataTable, confirmAction, section, statusBadge, badge, fmtTime } from './ui.js';

const SLOW = [[0, 'Off'], [5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']];
const STATE_KIND = { open: 'ok', read_only: '', locked: 'bad' };
const roomBadge = (s) => badge(s.replace('_', '-'), STATE_KIND[s] || '');

export async function render({ el, parts, navigate }) {
  if (parts[0]) return renderRoom(el, decodeURIComponent(parts[0]).toUpperCase(), navigate);
  el.innerHTML = section('Chat', 'Live chat rooms on event pages. A room is created when its first message is sent. Open a room to delete messages, mute people, pin a message, set slow mode or lock it.')
    + `<form class="adm-search-row" data-open><input class="adm-input" name="ticker" placeholder="Event ticker, e.g. PLXCOUNCIL-27TRAM" aria-label="Event ticker" data-testid="chat-open-ticker" required><button class="btn" type="submit">Open room</button></form><div id="rooms"></div>`;
  el.querySelector('[data-open]').addEventListener('submit', (e) => { e.preventDefault(); navigate(`/admin/chat/${encodeURIComponent(e.target.ticker.value.trim().toUpperCase())}`); });
  const t = dataTable(el.querySelector('#rooms'), { testid: 'chat-rooms', empty: 'No chat rooms yet.', rowAttrs: (r) => `data-room="${esc(r.event_ticker)}"`,
    cols: [
      { key: 'title', label: 'Event', render: (r) => `<a href="/admin/chat/${encodeURIComponent(r.event_ticker)}" data-link><b>${esc(r.title)}</b></a><div class="faint">${esc(r.event_ticker)}</div>` },
      { key: 'status', label: 'State', render: (r) => `${roomBadge(r.status)}${r.slow_mode_sec ? ` ${badge(`slow ${r.slow_mode_sec}s`, 'warn')}` : ''}${r.pinned ? ` ${badge('pinned')}` : ''}` },
      { key: 'messages', label: 'Messages', num: true }, { key: 'messages_24h', label: 'Last 24h', num: true }, { key: 'online', label: 'Online', num: true },
      { key: 'active_mutes', label: 'Mutes', num: true }, { key: 'open_reports', label: 'Open reports', num: true },
      { key: 'last_message_time', label: 'Last message', render: (r) => esc(fmtTime(r.last_message_time)) },
      { key: '_a', label: '', sort: false, render: (r) => `<a class="btn btn-sm" href="/admin/chat/${encodeURIComponent(r.event_ticker)}" data-link data-testid="chat-room-open">Open</a>` }] });
  t.setRows((await get('/chat/rooms')).rooms);
}

async function renderRoom(el, ticker, navigate) {
  const base = `/chat/rooms/${encodeURIComponent(ticker)}`;
  el.innerHTML = '<div class="faint">Loading…</div>';
  let data;
  const act = async (action, body, msg) => {
    try { await post(`${base}/${action}`, body); toast(msg); await load(); } catch (ex) { toast(ex.message, 'error'); }
  };
  async function load() {
    try { data = await get(base); } catch (ex) { el.innerHTML = `${section('Chat room')}<div class="card empty" role="alert">${esc(ex.message)}</div><a class="btn" href="/admin/chat" data-link>Back to rooms</a>`; return; }
    const r = data.room;
    el.innerHTML = section(r.title, `${esc(r.event_ticker)} · ${r.message_count} messages · ${r.online} online now`, `<a class="btn" href="/admin/chat" data-link>All rooms</a>`)
      + `<div class="adm-two"><div class="card adm-card" data-testid="chat-room-state"><h3>Room ${roomBadge(r.status)}</h3>
          <div class="adm-form-actions jc-start fw-wrap">
            <label class="field"><span>Slow mode</span><select class="adm-input" data-slow data-testid="adm-chat-slow">${SLOW.map(([v, l]) => `<option value="${v}" ${v === r.slow_mode_sec ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label class="field"><span>After the event closes</span><select class="adm-input" data-after data-testid="adm-chat-after"><option value="read_only" ${r.after_close === 'read_only' ? 'selected' : ''}>Read-only</option><option value="open" ${r.after_close === 'open' ? 'selected' : ''}>Keep open</option></select></label>
          </div>
          <p class="muted">${r.locked ? `Locked${r.lock_reason ? `: ${esc(r.lock_reason)}` : ''}` : r.event_active ? 'The event has an active market, so the room is open.' : 'No active market: the room follows the “after close” setting.'}</p>
          <button class="btn ${r.locked ? '' : 'btn-danger-solid'}" data-lock data-testid="adm-chat-lock">${r.locked ? 'Unlock room' : 'Lock room…'}</button></div>
        <div class="card adm-card" data-testid="chat-room-pinned"><h3>Pinned message</h3>${r.pinned ? `<p><b>@${esc(r.pinned.author.nickname)}</b> ${esc(r.pinned.body)}</p><button class="btn btn-sm" data-unpin>Unpin</button>` : '<p class="faint">Nothing pinned.</p>'}
          <h3 class="mt-16">Muted in this room</h3>${data.mutes.length ? `<ul class="adm-list" data-testid="chat-mutes">${data.mutes.map((m) => `<li><b>@${esc(m.nickname)}</b> until ${esc(fmtTime(m.muted_until))}${m.reason ? `<div class="faint">${esc(m.reason)}</div>` : ''} <button class="btn btn-sm" data-unmute="${esc(m.nickname)}">Unmute</button></li>`).join('')}</ul>` : '<p class="faint">Nobody is muted.</p>'}</div></div>
        <h3 class="adm-h3">Latest messages</h3><div id="msgs"></div>`;
    const t = dataTable(el.querySelector('#msgs'), { testid: 'chat-messages', pageSize: 50, empty: 'No messages yet.', rowAttrs: (m) => `data-msg="${esc(m.id)}"`,
      cols: [
        { key: 'created_time', label: 'Time', render: (m) => esc(fmtTime(m.created_time)) },
        { key: 'nickname', label: 'Author', sort: (m) => m.author.nickname, render: (m) => `@${esc(m.author.nickname)}${m.author.verified ? ' <span class="verified-badge" title="Verified">✓</span>' : ''}` },
        { key: 'body', label: 'Message', render: (m) => `${m.reply_to ? `<div class="faint">↪ ${m.reply_to.deleted ? 'deleted message' : `@${esc(m.reply_to.nickname)}: ${esc(m.reply_to.excerpt)}`}</div>` : ''}<div class="adm-note">${esc(m.body)}</div>` },
        { key: 'mod_state', label: 'State', render: (m) => (m.deleted ? badge(m.mod_state === 'author_deleted' ? 'deleted by author' : 'removed', m.mod_state === 'author_deleted' ? '' : 'bad') : statusBadge('active')) },
        { key: '_a', label: '', sort: false, render: (m) => (m.deleted ? '' : `<span class="adm-actions"><button class="btn btn-sm btn-ghost btn-danger" data-del="${esc(m.id)}">Delete</button><button class="btn btn-sm" data-pin="${esc(m.id)}">Pin</button><button class="btn btn-sm" data-mute="${esc(m.id)}">Mute…</button></span>`) }],
      searchText: (m) => `${m.author.nickname} ${m.body}` });
    t.setRows(data.messages);
  }
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-slow]')) act('slow_mode', { seconds: Number(e.target.value) }, Number(e.target.value) ? 'Slow mode updated' : 'Slow mode off');
    if (e.target.matches('[data-after]')) act('settings', { after_close: e.target.value }, 'Room setting saved');
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('[data-lock]')) {
      if (data.room.locked) return act('unlock', {}, 'Room unlocked');
      const ok = await confirmAction({ title: 'Lock this chat room?', body: 'Everyone can still read it, but nobody can send messages until it is unlocked.', confirm: 'Lock room', danger: true, reason: true });
      if (ok) act('lock', { reason: ok.reason }, 'Room locked');
    } else if (b.matches('[data-unpin]')) act('unpin', {}, 'Unpinned');
    else if (b.dataset.unmute) act('unmute', { nickname: b.dataset.unmute }, 'Unmuted');
    else if (b.dataset.pin) act('pin', { message_id: b.dataset.pin }, 'Pinned');
    else if (b.dataset.del) {
      const ok = await confirmAction({ title: 'Delete this message?', body: 'It disappears for everyone right away. It stays visible here as “removed”.', confirm: 'Delete', danger: true, reason: true, reasonLabel: 'Reason (recorded in the audit log)' });
      if (ok) act('delete', { message_id: b.dataset.del, reason: ok.reason }, 'Message deleted');
    } else if (b.dataset.mute) {
      const ok = await confirmAction({ title: 'Mute the author in this room?', confirm: 'Mute', danger: true, reason: true,
        extraHtml: '<label class="field"><span>For</span><select name="minutes" class="adm-input" data-testid="adm-mute-minutes"><option value="10">10 minutes</option><option value="60" selected>1 hour</option><option value="1440">24 hours</option><option value="10080">7 days</option></select></label>' });
      if (ok) act('mute', { message_id: b.dataset.mute, minutes: Number(ok.form.minutes.value), reason: ok.reason }, 'Author muted');
    }
  });
  void navigate;
  await load();
}
