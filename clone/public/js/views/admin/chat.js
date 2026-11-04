// Chat moderation (CLONE_SPEC.md §20.7): rooms list with activity, then one room: state (slow mode, lock, read-only
// after close), pinned message, active mutes, and the latest 200 messages (including deleted ones) with delete / pin /
// mute actions. Every action is permission-checked server-side (social.moderate) and written to the audit log.
// All user content is passed through esc() before it reaches the table markup.
import { t as tx, te, ts } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.chat-strings.js';
import { esc, get, post, toast, dataTable, confirmAction, section, statusBadge, badge, fmtTime } from './ui.js';

const SLOW = [[0, ts('admin.chat.slow.off')], [5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']];
const STATE_KIND = { open: 'ok', read_only: '', locked: 'bad' };
const roomBadge = (s) => badge(s.replace('_', '-'), STATE_KIND[s] || '');

export async function render({ el, parts, navigate }) {
  if (parts[0]) return renderRoom(el, decodeURIComponent(parts[0]).toUpperCase(), navigate);
  el.innerHTML = section(tx('admin.chat.render.chat'), tx('admin.chat.render.live_chat_rooms_on_event'))
    + `<form class="adm-search-row" data-open><input class="adm-input" name="ticker" placeholder="${te('admin.chat.render.event_ticker_e_g_plxcouncil')}" aria-label="${te('admin.chat.render.event_ticker')}" data-testid="chat-open-ticker" required><button class="btn" type="submit">${te('admin.chat.render.open_room')}</button></form><div id="rooms"></div>`;
  el.querySelector('[data-open]').addEventListener('submit', (e) => { e.preventDefault(); navigate(`/admin/chat/${encodeURIComponent(e.target.ticker.value.trim().toUpperCase())}`); });
  const t = dataTable(el.querySelector('#rooms'), { testid: 'chat-rooms', empty: tx('admin.chat.render.no_chat_rooms_yet'), rowAttrs: (r) => `data-room="${esc(r.event_ticker)}"`,
    cols: [
      { key: 'title', label: tx('admin.chat.render.event'), render: (r) => `<a href="/admin/chat/${encodeURIComponent(r.event_ticker)}" data-link><b>${esc(r.title)}</b></a><div class="faint">${esc(r.event_ticker)}</div>` },
      { key: 'status', label: 'State', render: (r) => `${roomBadge(r.status)}${r.slow_mode_sec ? ` ${badge(`slow ${r.slow_mode_sec}s`, 'warn')}` : ''}${r.pinned ? ` ${badge('pinned')}` : ''}` },
      { key: 'messages', label: tx('admin.chat.render.messages'), num: true }, { key: 'messages_24h', label: tx('admin.chat.render.last_24h'), num: true }, { key: 'online', label: tx('admin.chat.render.online'), num: true },
      { key: 'active_mutes', label: tx('admin.chat.render.mutes'), num: true }, { key: 'open_reports', label: tx('admin.chat.render.open_reports'), num: true },
      { key: 'last_message_time', label: tx('admin.chat.render.last_message'), render: (r) => esc(fmtTime(r.last_message_time)) },
      { key: '_a', label: '', sort: false, render: (r) => `<a class="btn btn-sm" href="/admin/chat/${encodeURIComponent(r.event_ticker)}" data-link data-testid="chat-room-open">${te('admin.chat.render.open')}</a>` }] });
  t.setRows((await get('/chat/rooms')).rooms);
}

async function renderRoom(el, ticker, navigate) {
  const base = `/chat/rooms/${encodeURIComponent(ticker)}`;
  el.innerHTML = `<div class="faint">${te('admin.chat.render_room.loading')}</div>`;
  let data;
  const act = async (action, body, msg) => {
    try { await post(`${base}/${action}`, body); toast(msg); await load(); } catch (ex) { toast(ex.message, 'error'); }
  };
  async function load() {
    try { data = await get(base); } catch (ex) { el.innerHTML = `${section(tx('admin.chat.render_room.chat_room'))}<div class="card empty" role="alert">${esc(ex.message)}</div><a class="btn" href="/admin/chat" data-link>${te('admin.chat.render_room.back_to_rooms')}</a>`; return; }
    const r = data.room;
    el.innerHTML = section(r.title, `${esc(r.event_ticker)} · ${r.message_count} messages · ${r.online} online now`, `<a class="btn" href="/admin/chat" data-link>${te('admin.chat.render_room.all_rooms')}</a>`)
      + `<div class="adm-two"><div class="card adm-card" data-testid="chat-room-state"><h3>${te('admin.chat.render_room.room', { room_badge: roomBadge(r.status) })}</h3>
          <div class="adm-form-actions jc-start fw-wrap">
            <label class="field"><span>${te('admin.chat.render_room.slow_mode')}</span><select class="adm-input" data-slow data-testid="adm-chat-slow">${SLOW.map(([v, l]) => `<option value="${esc(v)}" ${v === r.slow_mode_sec ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
            <label class="field"><span>${te('admin.chat.render_room.after_the_event_closes')}</span><select class="adm-input" data-after data-testid="adm-chat-after"><option value="read_only" ${r.after_close === 'read_only' ? 'selected' : ''}>${te('admin.chat.render_room.read_only')}</option><option value="open" ${r.after_close === 'open' ? 'selected' : ''}>${te('admin.chat.render_room.keep_open')}</option></select></label>
          </div>
          <p class="muted">${r.locked ? te('admin.chat.render_room.locked', { value: r.lock_reason ? `: ${esc(r.lock_reason)}` : '' }) : r.event_active ? te('admin.chat.render_room.the_event_has_an_active') : te('admin.chat.render_room.no_active_market_the_room')}</p>
          <button class="btn ${r.locked ? '' : 'btn-danger-solid'}" data-lock data-testid="adm-chat-lock">${r.locked ? te('admin.chat.render_room.unlock_room') : te('admin.chat.render_room.lock_room')}</button></div>
        <div class="card adm-card" data-testid="chat-room-pinned"><h3>${te('admin.chat.render_room.pinned_message')}</h3>${r.pinned ? `<p><b>@${esc(r.pinned.author.nickname)}</b> ${esc(r.pinned.body)}</p><button class="btn btn-sm" data-unpin>${te('admin.chat.render_room.unpin')}</button>` : `<p class="faint">${te('admin.chat.render_room.nothing_pinned')}</p>`}
          <h3 class="mt-16">${te('admin.chat.render_room.muted_in_this_room')}</h3>${data.mutes.length ? `<ul class="adm-list" data-testid="chat-mutes">${data.mutes.map((m) => `<li><b>@${esc(m.nickname)}</b> ${te('admin.chat.render_room.until', { fmt_time: esc(fmtTime(m.muted_until)), value: m.reason ? `<div class="faint">${esc(m.reason)}</div>` : '' })} <button class="btn btn-sm" data-unmute="${esc(m.nickname)}">${te('admin.chat.render_room.unmute')}</button></li>`).join('')}</ul>` : `<p class="faint">${te('admin.chat.render_room.nobody_is_muted')}</p>`}</div></div>
        <h3 class="adm-h3">${te('admin.chat.render_room.latest_messages')}</h3><div id="msgs"></div>`;
    const t = dataTable(el.querySelector('#msgs'), { testid: 'chat-messages', pageSize: 50, empty: tx('admin.chat.render_room.no_messages_yet'), rowAttrs: (m) => `data-msg="${esc(m.id)}"`,
      cols: [
        { key: 'created_time', label: tx('admin.chat.render_room.time'), render: (m) => esc(fmtTime(m.created_time)) },
        { key: 'nickname', label: tx('admin.chat.render_room.author'), sort: (m) => m.author.nickname, render: (m) => `@${esc(m.author.nickname)}${m.author.verified ? ` <span class="verified-badge" title="${te('admin.chat.render_room.verified')}">✓</span>` : ''}` },
        { key: 'body', label: tx('admin.chat.render_room.message'), render: (m) => `${m.reply_to ? `<div class="faint">↪ ${m.reply_to.deleted ? te('admin.chat.render_room.deleted_message') : `@${esc(m.reply_to.nickname)}: ${esc(m.reply_to.excerpt)}`}</div>` : ''}<div class="adm-note">${esc(m.body)}</div>` },
        { key: 'mod_state', label: 'State', render: (m) => (m.deleted ? badge(m.mod_state === 'author_deleted' ? 'deleted by author' : 'removed', m.mod_state === 'author_deleted' ? '' : 'bad') : statusBadge('active')) },
        { key: '_a', label: '', sort: false, render: (m) => (m.deleted ? '' : `<span class="adm-actions"><button class="btn btn-sm btn-ghost btn-danger" data-del="${esc(m.id)}">${te('admin.chat.render_room.delete')}</button><button class="btn btn-sm" data-pin="${esc(m.id)}">${te('admin.chat.render_room.pin')}</button><button class="btn btn-sm" data-mute="${esc(m.id)}">${te('admin.chat.render_room.mute')}</button></span>`) }],
      searchText: (m) => `${m.author.nickname} ${m.body}` });
    t.setRows(data.messages);
  }
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-slow]')) act('slow_mode', { seconds: Number(e.target.value) }, Number(e.target.value) ? tx('admin.chat.render_room.slow_mode_updated') : tx('admin.chat.render_room.slow_mode_off'));
    if (e.target.matches('[data-after]')) act('settings', { after_close: e.target.value }, tx('admin.chat.render_room.room_setting_saved'));
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('[data-lock]')) {
      if (data.room.locked) return act('unlock', {}, tx('admin.chat.render_room.room_unlocked'));
      const ok = await confirmAction({ title: tx('admin.chat.render_room.lock_this_chat_room'), body: tx('admin.chat.render_room.everyone_can_still_read_it'), confirm: tx('admin.chat.render_room.lock_room_2'), danger: true, reason: true });
      if (ok) act('lock', { reason: ok.reason }, tx('admin.chat.render_room.room_locked'));
    } else if (b.matches('[data-unpin]')) act('unpin', {}, tx('admin.chat.render_room.unpinned'));
    else if (b.dataset.unmute) act('unmute', { nickname: b.dataset.unmute }, tx('admin.chat.render_room.unmuted'));
    else if (b.dataset.pin) act('pin', { message_id: b.dataset.pin }, tx('admin.chat.render_room.pinned'));
    else if (b.dataset.del) {
      const ok = await confirmAction({ title: tx('admin.chat.render_room.delete_this_message'), body: tx('admin.chat.render_room.it_disappears_for_everyone_right'), confirm: tx('admin.chat.render_room.delete'), danger: true, reason: true, reasonLabel: tx('admin.chat.render_room.reason_recorded_in_the_audit') });
      if (ok) act('delete', { message_id: b.dataset.del, reason: ok.reason }, tx('admin.chat.render_room.message_deleted'));
    } else if (b.dataset.mute) {
      const ok = await confirmAction({ title: tx('admin.chat.render_room.mute_the_author_in_this'), confirm: tx('admin.chat.render_room.mute_2'), danger: true, reason: true,
        extraHtml: `<label class="field"><span>${te('admin.chat.render_room.for')}</span><select name="minutes" class="adm-input" data-testid="adm-mute-minutes"><option value="10">${te('admin.chat.render_room.n10_minutes')}</option><option value="60" selected>${te('admin.chat.render_room.n1_hour')}</option><option value="1440">${te('admin.chat.render_room.n24_hours')}</option><option value="10080">${te('admin.chat.render_room.n7_days')}</option></select></label>` });
      if (ok) act('mute', { message_id: b.dataset.mute, minutes: Number(ok.form.minutes.value), reason: ok.reason }, tx('admin.chat.render_room.author_muted'));
    }
  });
  void navigate;
  await load();
}
