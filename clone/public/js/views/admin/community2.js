// Admin › Community (CLONE_SPEC.md §24.9; permission social.moderate, outbox users.support): the sticker set with
// enable / disable, post lookup with edit history and the four social-admin actions (G8: subtype, market status,
// moderator edit, profile-picture decision), group chats (members, messages incl. removed, delete, remove member, lock;
// every view is audited), and the email / push notification outbox. All user content passes through esc().
import { t as tx, te, ts } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.community2-strings.js';
import { esc, get, put, post, toast, dataTable, confirmAction, section, subTabs, badge, fmtTime } from './ui.js';
import { session } from '../../store.js';
import { request } from '../../api.js';

const TABS = [['stickers', ts('admin.community2.tabs.stickers')], ['posts', ts('admin.community2.tabs.post_lookup')], ['groups', ts('admin.community2.tabs.group_chats')]];
const SUBTYPES = ['standard', 'analysis', 'news', 'humor', 'promotional'];
// Section header (markup built from static text and esc()'d tab keys).
function header(tab) { return tab === 'outbox' ? '' : section(tx('admin.community2.header.community'), tx('admin.community2.header.stickers_post_history_and_moderator')) + subTabs(TABS, tab, '/admin/community'); }
const sa = (path, body) => request('PUT', `/v1/users/${encodeURIComponent(session.uid)}/social/social-admin/${path}`, body);

export async function render({ el, section: sec, parts, perms, navigate }) {
  const tab = sec === 'outbox' ? 'outbox' : parts[0] || 'stickers';
  if (tab === 'outbox') return outbox(el, tab, perms);
  if (!perms.has('social.moderate')) { el.innerHTML = `${header(tab)}<div class="card empty" role="alert" data-testid="section-forbidden">${te('admin.community2.render.needs_the_social_moderate_permission')}</div>`; return undefined; }
  if (tab === 'posts') return posts(el, tab, parts[1]);
  if (tab === 'groups') return groups(el, tab, parts[1], navigate);
  return stickers(el, tab);
}

async function stickers(el, tab) {
  el.innerHTML = `${header(tab)}<p class="muted">${te('admin.community2.stickers.parlance_s_own_sticker_set')} <b data-testid="gif-status"></b>.</p><div id="stk"></div>`;
  const t = dataTable(el.querySelector('#stk'), { testid: 'adm-stickers', search: false, rowAttrs: (r) => `data-sticker="${esc(r.id)}"`,
    cols: [{ key: 'id', label: 'Sticker', render: (r) => `<img src="${esc(r.url)}" alt="" width="40" height="40" class="adm-sticker"> <b>${esc(r.label)}</b> <span class="faint">${esc(r.id)}</span>` },
      { key: 'uses', label: tx('admin.community2.stickers.uses'), num: true }, { key: 'enabled', label: 'State', render: (r) => (r.enabled ? badge('enabled', 'ok') : badge('disabled', 'bad')) },
      { key: '_a', label: '', sort: false, render: (r) => `<button class="btn btn-sm" data-toggle="${esc(r.id)}" data-on="${r.enabled ? '1' : '0'}" data-testid="sticker-toggle">${r.enabled ? te('admin.community2.stickers.disable') : te('admin.community2.stickers.enable')}</button>` }] });
  const load = async () => { const r = await get('/stickers'); el.querySelector('[data-testid=gif-status]').textContent = r.gifs.enabled ? tx('admin.community2.stickers.on_rating', { provider: r.gifs.provider, rating: r.gifs.rating }) : 'off'; t.setRows(r.stickers); };
  el.onclick = async (e) => {
    const b = e.target.closest('[data-toggle]');
    if (!b) return;
    const enable = b.dataset.on !== '1';
    const ok = await confirmAction({ title: `${enable ? tx('admin.community2.stickers.enable') : tx('admin.community2.stickers.disable')} sticker`, reason: true, reasonLabel: tx('admin.community2.stickers.reason_recorded_in_the_audit') });
    if (!ok) return;
    try { await put(`/stickers/${encodeURIComponent(b.dataset.toggle)}`, { enabled: enable, reason: ok.reason }); toast(enable ? tx('admin.community2.stickers.sticker_enabled') : tx('admin.community2.stickers.sticker_disabled')); await load(); } catch (ex) { toast(ex.message, 'error'); }
  };
  await load();
}

async function posts(el, tab, pid) {
  el.innerHTML = `${header(tab)}<form class="adm-search-row" data-find><input class="adm-input" name="pid" placeholder="${te('admin.community2.posts.post_id_p_or_a')}" aria-label="${te('admin.community2.posts.post_id')}" data-testid="adm-post-id" required value="${esc(pid || '')}"><button class="btn" type="submit">${te('admin.community2.posts.open_post')}</button></form><div id="post-box"></div>`;
  el.querySelector('[data-find]').addEventListener('submit', (e) => { e.preventDefault(); const v = e.target.pid.value.trim().split('/').pop(); el.dataset.pid = v; load(v); });
  const box = el.querySelector('#post-box');
  async function load(id) {
    if (!id) return;
    let r;
    try { r = await get(`/moderation/posts/${encodeURIComponent(id)}`); } catch (ex) { box.innerHTML = `<div class="card empty" role="alert">${esc(ex.message)}</div>`; return; }
    const p = r.post;
    box.innerHTML = `<div class="card adm-card" data-testid="adm-post"><h3>@${esc(p.author_nickname || tx('admin.community2.posts.unknown'))} · ${esc(fmtTime(p.created_time))} ${p.hidden ? badge('hidden', 'bad') : ''} ${badge(p.visibility)} ${badge(p.subtype)}</h3>
        <div class="post-body" data-testid="adm-post-body">${esc(p.body)}</div>
        <p class="faint">${te('admin.community2.posts.event_position_tag_sticker', { value: esc(p.event_ticker || '—'), value_2: esc(p.position ? p.position.label : '—'), value_3: esc(p.sticker_id || '—') })}</p>
        <div class="adm-form-actions jc-start fw-wrap"><label class="field"><span>${te('admin.community2.posts.post_type')}</span><select class="adm-input" data-subtype data-testid="adm-post-subtype">${SUBTYPES.map((s) => `<option ${s === p.subtype ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <button class="btn btn-sm" data-act="subtype" data-testid="adm-post-subtype-save">${te('admin.community2.posts.save_type')}</button><button class="btn btn-sm" data-act="unlink" data-testid="adm-post-unlink">${te('admin.community2.posts.detach_event_position')}</button><button class="btn btn-sm" data-act="edit" data-testid="adm-post-edit">${te('admin.community2.posts.edit_text')}</button>
          ${p.author_nickname ? `<button class="btn btn-sm" data-act="avatar" data-testid="adm-post-avatar">${te('admin.community2.posts.decline_profile_picture')}</button>` : ''}</div></div>
      <div class="card adm-card" data-testid="adm-post-edits"><h3>${te('admin.community2.posts.edit_history', { value: r.edits.length })}</h3>${r.edits.length ? `<table class="table"><thead><tr><th>${te('admin.community2.posts.when')}</th><th>${te('admin.community2.posts.by')}</th><th>${te('admin.community2.posts.before')}</th><th>${te('admin.community2.posts.after')}</th><th>${te('admin.community2.posts.reason')}</th></tr></thead><tbody>${r.edits.map((x) => `<tr data-testid="adm-edit-row"><td>${esc(fmtTime(x.edited_time))}</td><td>${esc(x.by_moderator ? tx('admin.community2.posts.moderator') : `@${x.editor || '?'}`)}</td><td>${esc(x.previous_body)}</td><td>${esc(x.new_body)}</td><td>${esc(x.reason)}</td></tr>`).join('')}</tbody></table>` : `<p class="faint">${te('admin.community2.posts.never_edited')}</p>`}</div>`;
    box.querySelector('[data-act=subtype]').onclick = async () => { try { await sa(`posts/${encodeURIComponent(p.id)}/post_subtype`, { post_subtype: box.querySelector('[data-subtype]').value }); toast(tx('admin.community2.posts.post_type_saved')); load(p.id); } catch (ex) { toast(ex.message, 'error'); } };
    box.querySelector('[data-act=unlink]').onclick = async () => { const ok = await confirmAction({ title: tx('admin.community2.posts.detach_the_event_link_and'), reason: true }); if (!ok) return; try { await sa(`posts/${encodeURIComponent(p.id)}/market_status`, { event_ticker: null, position_tag: 'remove', reason: ok.reason }); toast(tx('admin.community2.posts.detached')); load(p.id); } catch (ex) { toast(ex.message, 'error'); } };
    box.querySelector('[data-act=edit]').onclick = async () => {
      const ok = await confirmAction({ title: tx('admin.community2.posts.edit_post_text'), reason: true, extraHtml: `<label class="field"><span>${te('admin.community2.posts.new_text')}</span><textarea name="body" rows="4" maxlength="500" data-testid="adm-edit-body">${esc(p.body)}</textarea></label>` });
      if (!ok) return;
      try { await sa(`posts/${encodeURIComponent(p.id)}/update`, { body: ok.form.body.value, reason: ok.reason }); toast(tx('admin.community2.posts.post_edited_the_author_was')); load(p.id); } catch (ex) { toast(ex.message, 'error'); }
    };
    box.querySelector('[data-act=avatar]')?.addEventListener('click', async () => { const ok = await confirmAction({ title: tx('admin.community2.posts.decline_s_profile_picture', { author_nickname: p.author_nickname }), reason: true, danger: true }); if (!ok) return; try { await sa(`determine_profile_image/${encodeURIComponent(p.author_nickname)}`, { decision: 'reject', reason: ok.reason }); toast(tx('admin.community2.posts.picture_declined')); } catch (ex) { toast(ex.notFound ? tx('admin.community2.posts.this_trader_has_no_profile') : ex.message, 'error'); } });
  }
  await load(pid);
}

async function groups(el, tab, gid, navigate) {
  if (gid) return groupView(el, tab, gid, navigate);
  el.innerHTML = `${header(tab)}<p class="muted">${te('admin.community2.groups.private_group_chats_opening_one')}</p><div id="grp"></div>`;
  const t = dataTable(el.querySelector('#grp'), { testid: 'adm-groups', empty: tx('admin.community2.groups.no_group_chats_yet'), rowAttrs: (r) => `data-group="${esc(r.id)}"`,
    cols: [{ key: 'name', label: tx('admin.community2.groups.group'), render: (r) => `<a href="/admin/community/groups/${encodeURIComponent(r.id)}" data-link><b>${esc(r.name)}</b></a>${r.locked ? ` ${badge('locked', 'bad')}` : ''}${r.archived ? ` ${badge('archived')}` : ''}` },
      { key: 'members', label: tx('admin.community2.groups.members'), num: true }, { key: 'messages', label: tx('admin.community2.groups.messages'), num: true }, { key: 'open_reports', label: tx('admin.community2.groups.open_reports'), num: true }, { key: 'updated_time', label: tx('admin.community2.groups.last_activity'), render: (r) => esc(fmtTime(r.updated_time)) }] });
  t.setRows((await get('/groups')).groups);
}
async function groupView(el, tab, gid, navigate) {
  const base = `/groups/${encodeURIComponent(gid)}`;
  let r;
  try { r = await get(base); } catch (ex) { el.innerHTML = `${header(tab)}<div class="card empty" role="alert">${esc(ex.message)}</div>`; return; }
  const g = r.group;
  el.innerHTML = `${header(tab)}<div class="adm-head"><div><h2 data-testid="adm-group-name">${esc(g.name)}</h2><p class="muted">${te('admin.community2.group_view.members_created', { value: esc(g.members.length), fmt_time: esc(fmtTime(g.created_time)) })}</p></div><div class="adm-head-actions"><a class="btn" href="/admin/community/groups" data-link>${te('admin.community2.group_view.all_groups')}</a><button class="btn" data-lock data-testid="adm-group-lock">${g.locked ? te('admin.community2.group_view.unlock') : te('admin.community2.group_view.lock')}</button></div></div>
    <div class="card adm-card"><h3>${te('admin.community2.group_view.members')}</h3>${g.members.map((m) => `<div class="circle-row" data-testid="adm-group-member"><span>@${esc(m.nickname)}</span> <span class="faint">${esc(m.role)}</span><span class="grow"></span><button class="btn btn-sm" data-remove="${esc(m.nickname)}" data-testid="adm-group-remove">${te('admin.community2.group_view.remove')}</button></div>`).join('')}</div>
    <div id="gmsgs"></div>`;
  const t = dataTable(el.querySelector('#gmsgs'), { testid: 'adm-group-messages', rowAttrs: (m) => `data-id="${esc(m.id)}"`,
    cols: [{ key: 'created_time', label: tx('admin.community2.group_view.when'), render: (m) => esc(fmtTime(m.created_time)) }, { key: 'author', label: tx('admin.community2.group_view.author'), render: (m) => esc(m.author ? `@${m.author.nickname}` : 'system') },
      { key: 'body', label: tx('admin.community2.group_view.message'), render: (m) => `${esc(m.body)}${m.sticker ? ` <span class="faint">${te('admin.community2.group_view.sticker', { id: esc(m.sticker.id) })}</span>` : ''}` }, { key: 'mod_state', label: 'State', render: (m) => (m.deleted ? badge(m.mod_state.replace('_', ' '), 'bad') : badge('visible', 'ok')) },
      { key: '_a', label: '', sort: false, render: (m) => (m.deleted || m.kind === 'system' ? '' : `<button class="btn btn-sm btn-danger" data-del="${esc(m.id)}" data-testid="adm-group-del">${te('admin.community2.group_view.delete')}</button>`) }] });
  t.setRows(r.messages);
  el.querySelector('[data-lock]').onclick = async () => { const ok = await confirmAction({ title: tx('admin.community2.group_view.this_group', { value: g.locked ? tx('admin.community2.group_view.unlock') : tx('admin.community2.group_view.lock') }), reason: true }); if (!ok) return; try { await post(`${base}/${g.locked ? 'unlock' : 'lock'}`, { reason: ok.reason }); toast(g.locked ? tx('admin.community2.group_view.unlocked') : tx('admin.community2.group_view.locked')); groupView(el, tab, gid, navigate); } catch (ex) { toast(ex.message, 'error'); } };
  el.onclick = async (e) => {
    const d = e.target.closest('[data-del]'); const rm = e.target.closest('[data-remove]');
    if (!d && !rm) return;
    const ok = await confirmAction({ title: d ? tx('admin.community2.group_view.delete_this_message') : tx('admin.community2.group_view.remove_2', { remove: rm.dataset.remove }), reason: true, danger: true });
    if (!ok) return;
    try {
      if (d) await post(`${base}/delete`, { message_id: d.dataset.del, reason: ok.reason });
      else await post(`${base}/remove_member`, { nickname: rm.dataset.remove, reason: ok.reason });
      toast(tx('admin.community2.group_view.done')); groupView(el, tab, gid, navigate);
    } catch (ex) { toast(ex.message, 'error'); }
  };
}

async function outbox(el, tab, perms) {
  if (!perms.has('users.support')) { el.innerHTML = `${header(tab)}<div class="card empty" role="alert" data-testid="section-forbidden">${te('admin.community2.outbox.needs_the_users_support_permission')}</div>`; return; }
  el.innerHTML = `${section(tx('admin.community2.outbox.notification_outbox'), tx('admin.community2.outbox.email_and_push_deliveries_settings'))}<p class="muted">${te('admin.community2.outbox.development_outbox_email_goes_to')}</p><div id="ob"></div>`;
  const t = dataTable(el.querySelector('#ob'), { testid: 'adm-outbox', empty: tx('admin.community2.outbox.nothing_delivered_yet'),
    cols: [{ key: 'created_time', label: tx('admin.community2.outbox.queued'), render: (d) => esc(fmtTime(d.created_time)) }, { key: 'channel', label: tx('admin.community2.outbox.channel') }, { key: 'user_email', label: tx('admin.community2.outbox.user') }, { key: 'title', label: tx('admin.community2.outbox.notification') },
      { key: 'preference', label: tx('admin.community2.outbox.type') }, { key: 'status', label: tx('admin.community2.outbox.status'), render: (d) => badge(d.status.replace('_', ' '), d.status === 'sent' ? 'ok' : d.status === 'deferred' ? 'warn' : '') }, { key: 'devices', label: tx('admin.community2.outbox.devices'), num: true }] });
  t.setRows((await get('/notifications/deliveries')).deliveries);
}
