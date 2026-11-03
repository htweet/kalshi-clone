// Admin › Community (PHASE2_SPEC.md §24.9; permission social.moderate, outbox users.support): the sticker set with
// enable / disable, post lookup with edit history and the four social-admin actions (G8: subtype, market status,
// moderator edit, profile-picture decision), group chats (members, messages incl. removed, delete, remove member, lock;
// every view is audited), and the email / push notification outbox. All user content passes through esc().
import { esc, get, put, post, toast, dataTable, confirmAction, section, subTabs, badge, fmtTime } from './ui.js';
import { session } from '../../store.js';
import { request } from '../../api.js';

const TABS = [['stickers', 'Stickers'], ['posts', 'Post lookup'], ['groups', 'Group chats']];
const SUBTYPES = ['standard', 'analysis', 'news', 'humor', 'promotional'];
// Section header (markup built from static text and esc()'d tab keys).
function header(tab) { return tab === 'outbox' ? '' : section('Community', 'Stickers, post history and moderator edits, group chats and the notification outbox.') + subTabs(TABS, tab, '/admin/community'); }
const sa = (path, body) => request('PUT', `/v1/users/${encodeURIComponent(session.uid)}/social/social-admin/${path}`, body);

export async function render({ el, section: sec, parts, perms, navigate }) {
  const tab = sec === 'outbox' ? 'outbox' : parts[0] || 'stickers';
  if (tab === 'outbox') return outbox(el, tab, perms);
  if (!perms.has('social.moderate')) { el.innerHTML = `${header(tab)}<div class="card empty" role="alert" data-testid="section-forbidden">Needs the social.moderate permission.</div>`; return undefined; }
  if (tab === 'posts') return posts(el, tab, parts[1]);
  if (tab === 'groups') return groups(el, tab, parts[1], navigate);
  return stickers(el, tab);
}

async function stickers(el, tab) {
  el.innerHTML = `${header(tab)}<p class="muted">Parlance's own sticker set (SVG, no third-party art). A disabled sticker disappears from the picker and from every post, reply and message that used it. The external GIF provider adapter is <b data-testid="gif-status"></b>.</p><div id="stk"></div>`;
  const t = dataTable(el.querySelector('#stk'), { testid: 'adm-stickers', search: false, rowAttrs: (r) => `data-sticker="${esc(r.id)}"`,
    cols: [{ key: 'id', label: 'Sticker', render: (r) => `<img src="${esc(r.url)}" alt="" width="40" height="40" class="adm-sticker"> <b>${esc(r.label)}</b> <span class="faint">${esc(r.id)}</span>` },
      { key: 'uses', label: 'Uses', num: true }, { key: 'enabled', label: 'State', render: (r) => (r.enabled ? badge('enabled', 'ok') : badge('disabled', 'bad')) },
      { key: '_a', label: '', sort: false, render: (r) => `<button class="btn btn-sm" data-toggle="${esc(r.id)}" data-on="${r.enabled ? '1' : '0'}" data-testid="sticker-toggle">${r.enabled ? 'Disable' : 'Enable'}</button>` }] });
  const load = async () => { const r = await get('/stickers'); el.querySelector('[data-testid=gif-status]').textContent = r.gifs.enabled ? `on (${r.gifs.provider}, rating ${r.gifs.rating})` : 'off'; t.setRows(r.stickers); };
  el.onclick = async (e) => {
    const b = e.target.closest('[data-toggle]');
    if (!b) return;
    const enable = b.dataset.on !== '1';
    const ok = await confirmAction({ title: `${enable ? 'Enable' : 'Disable'} sticker`, reason: true, reasonLabel: 'Reason (recorded in the audit log)' });
    if (!ok) return;
    try { await put(`/stickers/${encodeURIComponent(b.dataset.toggle)}`, { enabled: enable, reason: ok.reason }); toast(enable ? 'Sticker enabled' : 'Sticker disabled'); await load(); } catch (ex) { toast(ex.message, 'error'); }
  };
  await load();
}

async function posts(el, tab, pid) {
  el.innerHTML = `${header(tab)}<form class="adm-search-row" data-find><input class="adm-input" name="pid" placeholder="Post id (p_…) or a /social/post/… link" aria-label="Post id" data-testid="adm-post-id" required value="${esc(pid || '')}"><button class="btn" type="submit">Open post</button></form><div id="post-box"></div>`;
  el.querySelector('[data-find]').addEventListener('submit', (e) => { e.preventDefault(); const v = e.target.pid.value.trim().split('/').pop(); el.dataset.pid = v; load(v); });
  const box = el.querySelector('#post-box');
  async function load(id) {
    if (!id) return;
    let r;
    try { r = await get(`/moderation/posts/${encodeURIComponent(id)}`); } catch (ex) { box.innerHTML = `<div class="card empty" role="alert">${esc(ex.message)}</div>`; return; }
    const p = r.post;
    box.innerHTML = `<div class="card adm-card" data-testid="adm-post"><h3>@${esc(p.author_nickname || 'unknown')} · ${esc(fmtTime(p.created_time))} ${p.hidden ? badge('hidden', 'bad') : ''} ${badge(p.visibility)} ${badge(p.subtype)}</h3>
        <div class="post-body" data-testid="adm-post-body">${esc(p.body)}</div>
        <p class="faint">Event: ${esc(p.event_ticker || '—')} · Position tag: ${esc(p.position ? p.position.label : '—')} · Sticker: ${esc(p.sticker_id || '—')}</p>
        <div class="adm-form-actions jc-start fw-wrap"><label class="field"><span>Post type</span><select class="adm-input" data-subtype data-testid="adm-post-subtype">${SUBTYPES.map((s) => `<option ${s === p.subtype ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <button class="btn btn-sm" data-act="subtype" data-testid="adm-post-subtype-save">Save type</button><button class="btn btn-sm" data-act="unlink" data-testid="adm-post-unlink">Detach event / position</button><button class="btn btn-sm" data-act="edit" data-testid="adm-post-edit">Edit text</button>
          ${p.author_nickname ? '<button class="btn btn-sm" data-act="avatar" data-testid="adm-post-avatar">Decline profile picture</button>' : ''}</div></div>
      <div class="card adm-card" data-testid="adm-post-edits"><h3>Edit history (${r.edits.length})</h3>${r.edits.length ? `<table class="table"><thead><tr><th>When</th><th>By</th><th>Before</th><th>After</th><th>Reason</th></tr></thead><tbody>${r.edits.map((x) => `<tr data-testid="adm-edit-row"><td>${esc(fmtTime(x.edited_time))}</td><td>${esc(x.by_moderator ? 'moderator' : `@${x.editor || '?'}`)}</td><td>${esc(x.previous_body)}</td><td>${esc(x.new_body)}</td><td>${esc(x.reason)}</td></tr>`).join('')}</tbody></table>` : '<p class="faint">Never edited.</p>'}</div>`;
    box.querySelector('[data-act=subtype]').onclick = async () => { try { await sa(`posts/${encodeURIComponent(p.id)}/post_subtype`, { post_subtype: box.querySelector('[data-subtype]').value }); toast('Post type saved'); load(p.id); } catch (ex) { toast(ex.message, 'error'); } };
    box.querySelector('[data-act=unlink]').onclick = async () => { const ok = await confirmAction({ title: 'Detach the event link and position tag', reason: true }); if (!ok) return; try { await sa(`posts/${encodeURIComponent(p.id)}/market_status`, { event_ticker: null, position_tag: 'remove', reason: ok.reason }); toast('Detached'); load(p.id); } catch (ex) { toast(ex.message, 'error'); } };
    box.querySelector('[data-act=edit]').onclick = async () => {
      const ok = await confirmAction({ title: 'Edit post text', reason: true, extraHtml: `<label class="field"><span>New text</span><textarea name="body" rows="4" maxlength="500" data-testid="adm-edit-body">${esc(p.body)}</textarea></label>` });
      if (!ok) return;
      try { await sa(`posts/${encodeURIComponent(p.id)}/update`, { body: ok.form.body.value, reason: ok.reason }); toast('Post edited; the author was told'); load(p.id); } catch (ex) { toast(ex.message, 'error'); }
    };
    box.querySelector('[data-act=avatar]')?.addEventListener('click', async () => { const ok = await confirmAction({ title: `Decline @${p.author_nickname}'s profile picture`, reason: true, danger: true }); if (!ok) return; try { await sa(`determine_profile_image/${encodeURIComponent(p.author_nickname)}`, { decision: 'reject', reason: ok.reason }); toast('Picture declined'); } catch (ex) { toast(ex.notFound ? 'This trader has no profile picture.' : ex.message, 'error'); } });
  }
  await load(pid);
}

async function groups(el, tab, gid, navigate) {
  if (gid) return groupView(el, tab, gid, navigate);
  el.innerHTML = `${header(tab)}<p class="muted">Private group chats. Opening one is recorded in the audit log.</p><div id="grp"></div>`;
  const t = dataTable(el.querySelector('#grp'), { testid: 'adm-groups', empty: 'No group chats yet.', rowAttrs: (r) => `data-group="${esc(r.id)}"`,
    cols: [{ key: 'name', label: 'Group', render: (r) => `<a href="/admin/community/groups/${encodeURIComponent(r.id)}" data-link><b>${esc(r.name)}</b></a>${r.locked ? ` ${badge('locked', 'bad')}` : ''}${r.archived ? ` ${badge('archived')}` : ''}` },
      { key: 'members', label: 'Members', num: true }, { key: 'messages', label: 'Messages', num: true }, { key: 'open_reports', label: 'Open reports', num: true }, { key: 'updated_time', label: 'Last activity', render: (r) => esc(fmtTime(r.updated_time)) }] });
  t.setRows((await get('/groups')).groups);
}
async function groupView(el, tab, gid, navigate) {
  const base = `/groups/${encodeURIComponent(gid)}`;
  let r;
  try { r = await get(base); } catch (ex) { el.innerHTML = `${header(tab)}<div class="card empty" role="alert">${esc(ex.message)}</div>`; return; }
  const g = r.group;
  el.innerHTML = `${header(tab)}<div class="adm-head"><div><h2 data-testid="adm-group-name">${esc(g.name)}</h2><p class="muted">${esc(g.members.length)} members · created ${esc(fmtTime(g.created_time))}</p></div><div class="adm-head-actions"><a class="btn" href="/admin/community/groups" data-link>All groups</a><button class="btn" data-lock data-testid="adm-group-lock">${g.locked ? 'Unlock' : 'Lock'}</button></div></div>
    <div class="card adm-card"><h3>Members</h3>${g.members.map((m) => `<div class="circle-row" data-testid="adm-group-member"><span>@${esc(m.nickname)}</span> <span class="faint">${esc(m.role)}</span><span class="grow"></span><button class="btn btn-sm" data-remove="${esc(m.nickname)}" data-testid="adm-group-remove">Remove</button></div>`).join('')}</div>
    <div id="gmsgs"></div>`;
  const t = dataTable(el.querySelector('#gmsgs'), { testid: 'adm-group-messages', rowAttrs: (m) => `data-id="${esc(m.id)}"`,
    cols: [{ key: 'created_time', label: 'When', render: (m) => esc(fmtTime(m.created_time)) }, { key: 'author', label: 'Author', render: (m) => esc(m.author ? `@${m.author.nickname}` : 'system') },
      { key: 'body', label: 'Message', render: (m) => `${esc(m.body)}${m.sticker ? ` <span class="faint">[sticker ${esc(m.sticker.id)}]</span>` : ''}` }, { key: 'mod_state', label: 'State', render: (m) => (m.deleted ? badge(m.mod_state.replace('_', ' '), 'bad') : badge('visible', 'ok')) },
      { key: '_a', label: '', sort: false, render: (m) => (m.deleted || m.kind === 'system' ? '' : `<button class="btn btn-sm btn-danger" data-del="${esc(m.id)}" data-testid="adm-group-del">Delete</button>`) }] });
  t.setRows(r.messages);
  el.querySelector('[data-lock]').onclick = async () => { const ok = await confirmAction({ title: `${g.locked ? 'Unlock' : 'Lock'} this group`, reason: true }); if (!ok) return; try { await post(`${base}/${g.locked ? 'unlock' : 'lock'}`, { reason: ok.reason }); toast(g.locked ? 'Unlocked' : 'Locked'); groupView(el, tab, gid, navigate); } catch (ex) { toast(ex.message, 'error'); } };
  el.onclick = async (e) => {
    const d = e.target.closest('[data-del]'); const rm = e.target.closest('[data-remove]');
    if (!d && !rm) return;
    const ok = await confirmAction({ title: d ? 'Delete this message' : `Remove @${rm.dataset.remove}`, reason: true, danger: true });
    if (!ok) return;
    try {
      if (d) await post(`${base}/delete`, { message_id: d.dataset.del, reason: ok.reason });
      else await post(`${base}/remove_member`, { nickname: rm.dataset.remove, reason: ok.reason });
      toast('Done'); groupView(el, tab, gid, navigate);
    } catch (ex) { toast(ex.message, 'error'); }
  };
}

async function outbox(el, tab, perms) {
  if (!perms.has('users.support')) { el.innerHTML = `${header(tab)}<div class="card empty" role="alert" data-testid="section-forbidden">Needs the users.support permission.</div>`; return; }
  el.innerHTML = `${section('Notification outbox', 'Email and push deliveries (Settings › Notifications channels).')}<p class="muted">Development outbox: email goes to the dev mailbox (no SMTP), push goes to the browsers users registered. Deferred rows are waiting for the end of a user's quiet hours.</p><div id="ob"></div>`;
  const t = dataTable(el.querySelector('#ob'), { testid: 'adm-outbox', empty: 'Nothing delivered yet.',
    cols: [{ key: 'created_time', label: 'Queued', render: (d) => esc(fmtTime(d.created_time)) }, { key: 'channel', label: 'Channel' }, { key: 'user_email', label: 'User' }, { key: 'title', label: 'Notification' },
      { key: 'preference', label: 'Type' }, { key: 'status', label: 'Status', render: (d) => badge(d.status.replace('_', ' '), d.status === 'sent' ? 'ok' : d.status === 'deferred' ? 'warn' : '') }, { key: 'devices', label: 'Devices', num: true }] });
  t.setRows((await get('/notifications/deliveries')).deliveries);
}
