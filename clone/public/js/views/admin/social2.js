// Moderation › Post tools and Stickers (PHASE2_SPEC.md §24.5–24.6). Post tools open one post by id or link and use the
// four social-admin PUT endpoints (market status, subtype, moderator edit, profile picture decision); every change is
// audited server-side. Stickers lists the self-hosted set with enable / disable. User content goes through esc().
import { request } from '../../api.js';
import { session } from '../../store.js';
import { esc, get, put, toast, dataTable, confirmAction, badge, fmtTime } from './ui.js';

const SUBTYPES = ['standard', 'analysis', 'news', 'humor', 'promotional'];
const sa = (path, body) => request('PUT', `/v1/users/${encodeURIComponent(session.uid)}/social/social-admin${path}`, body);

export async function render({ el, tab, parts }) {
  if (tab === 'stickers') return renderStickers(el);
  return renderPostTools(el, parts[1] || '');
}

async function renderStickers(el) {
  el.innerHTML = '<p class="muted">Parlance\'s own sticker set. Turning a sticker off removes it from the picker and from every post, reply and chat message that used it. GIF search from an external provider is <strong data-gif-state></strong>.</p><div data-list></div>';
  const t = dataTable(el.querySelector('[data-list]'), { testid: 'adm-stickers', search: false, rowAttrs: (s) => `data-sticker-row="${esc(s.id)}"`,
    cols: [{ key: 'id', label: 'Sticker', render: (s) => `<img src="${esc(s.url)}" alt="" width="40" height="40" class="adm-sticker"> <b>${esc(s.label)}</b> <span class="faint">${esc(s.id)}</span>` },
      { key: 'uses', label: 'Uses', num: true }, { key: 'enabled', label: 'State', render: (s) => (s.enabled ? badge('enabled', 'ok') : badge('disabled', 'bad')) },
      { key: '_a', label: '', sort: false, render: (s) => `<button class="btn btn-sm" data-toggle="${esc(s.id)}" data-on="${s.enabled ? '0' : '1'}" data-testid="sticker-toggle-${esc(s.id)}">${s.enabled ? 'Disable' : 'Enable'}</button>` }] });
  const load = async () => { const r = await get('/stickers'); el.querySelector('[data-gif-state]').textContent = r.gifs.enabled ? `on (${r.gifs.provider}, rating ${r.gifs.rating})` : 'off (no provider key configured)'; t.setRows(r.stickers); };
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-toggle]'); if (!b) return;
    try { await put(`/stickers/${encodeURIComponent(b.dataset.toggle)}`, { enabled: b.dataset.on === '1' }); toast(b.dataset.on === '1' ? 'Sticker enabled' : 'Sticker disabled'); await load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  await load();
}

async function renderPostTools(el, initial) {
  el.innerHTML = `<p class="muted">Open a post by its id or link to change its market link, subtype or text. Edits keep the author's earlier text in the history below.</p>
    <form class="adm-search-row" data-open><input class="adm-input" name="pid" placeholder="Post id or /social/post/… link" aria-label="Post id" data-testid="post-tools-id" value="${esc(initial)}" required><button class="btn" type="submit">Open post</button></form>
    <div data-post></div>
    <h3 class="adm-h3">Profile picture review</h3><form class="adm-search-row" data-avatar><input class="adm-input" name="nick" placeholder="Nickname" aria-label="Nickname" data-testid="avatar-review-nick" required>
      <select class="adm-input" name="decision" aria-label="Decision" data-testid="avatar-review-decision"><option value="reject">Reject picture</option><option value="approve">Approve picture</option></select><button class="btn" type="submit" data-testid="avatar-review-submit">Apply…</button></form>`;
  const host = el.querySelector('[data-post]');
  const open = async (raw) => {
    const pid = String(raw).trim().replace(/^.*\/social\/post\//, '').replace(/[?#].*$/, '');
    if (!pid) return;
    let r;
    try { r = await get(`/moderation/posts/${encodeURIComponent(pid)}`); } catch (ex) { host.innerHTML = `<div class="card empty" role="alert">${esc(ex.message)}</div>`; return; }
    const p = r.post;
    host.innerHTML = `<div class="card adm-card" data-testid="post-tools" data-pid="${esc(p.id)}"><h3>@${esc(p.author_nickname || 'unknown')} · ${esc(fmtTime(p.created_time))} ${p.hidden ? badge('hidden', 'bad') : ''}</h3>
      <div class="adm-note" data-testid="post-tools-body">${esc(p.body)}</div>
      <p class="faint">Event: ${esc(p.event_ticker || 'none')} · Position tag: ${p.position ? esc(p.position.label) : 'none'} · Subtype: ${esc(p.subtype)}</p>
      <div class="adm-form-actions jc-start fw-wrap">
        <label class="field"><span>Subtype</span><select class="adm-input" data-subtype data-testid="post-subtype-select">${SUBTYPES.map((s) => `<option ${s === p.subtype ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        <button class="btn" data-market data-testid="post-market-status">Market link…</button><button class="btn" data-edit data-testid="post-mod-edit">Edit text…</button></div>
      <h3 class="mt-16">Edit history</h3>${r.edits.length ? `<ol class="adm-list" data-testid="post-edit-history">${r.edits.map((x) => `<li><div class="faint">${esc(fmtTime(x.edited_time))} · ${x.by_moderator ? 'moderator' : `@${esc(x.editor || '')}`}${x.reason ? ` · ${esc(x.reason)}` : ''}</div><div><s>${esc(x.previous_body)}</s></div><div>→ ${esc(x.new_body)}</div></li>`).join('')}</ol>` : '<p class="faint" data-testid="post-edit-history">Never edited.</p>'}</div>`;
    host.querySelector('[data-subtype]').onchange = async (e) => { try { await sa(`/posts/${encodeURIComponent(p.id)}/post_subtype`, { post_subtype: e.target.value, reason: 'set from Post tools' }); toast('Subtype saved'); open(p.id); } catch (ex) { toast(ex.message, 'error'); } };
    host.querySelector('[data-market]').onclick = async () => {
      const ok = await confirmAction({ title: 'Change the post\'s market link', confirm: 'Save', reason: true,
        extraHtml: `<label class="field"><span>Event ticker (empty = no event)</span><input class="adm-input" name="et" value="${esc(p.event_ticker || '')}" data-testid="market-status-event"></label><label class="adm-check"><input type="checkbox" name="rm" data-testid="market-status-remove-tag"> <span>Remove the position tag</span></label>` });
      if (!ok) return;
      try { await sa(`/posts/${encodeURIComponent(p.id)}/market_status`, { event_ticker: ok.form.et.value.trim() || null, position_tag: ok.form.rm.checked ? 'remove' : 'keep', reason: ok.reason }); toast('Market link saved'); open(p.id); } catch (ex) { toast(ex.message, 'error'); }
    };
    host.querySelector('[data-edit]').onclick = async () => {
      const ok = await confirmAction({ title: 'Edit this post as a moderator', body: 'The author is notified and the post shows “edited by a moderator”.', confirm: 'Save text', reason: true,
        extraHtml: `<label class="field"><span>Text</span><textarea class="adm-input" name="body" rows="4" maxlength="500" data-testid="mod-edit-body">${esc(p.body)}</textarea></label>` });
      if (!ok) return;
      try { await sa(`/posts/${encodeURIComponent(p.id)}/update`, { body: ok.form.body.value, reason: ok.reason }); toast('Post updated'); open(p.id); } catch (ex) { toast(ex.message, 'error'); }
    };
  };
  el.querySelector('[data-open]').addEventListener('submit', (e) => { e.preventDefault(); open(e.target.pid.value); });
  el.querySelector('[data-avatar]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const ok = await confirmAction({ title: `${f.decision.value === 'reject' ? 'Reject' : 'Approve'} @${f.nick.value.trim()}'s profile picture?`, confirm: 'Apply', danger: f.decision.value === 'reject', reason: true });
    if (!ok) return;
    try { await sa(`/determine_profile_image/${encodeURIComponent(f.nick.value.trim())}`, { decision: f.decision.value, reason: ok.reason }); toast('Decision saved'); } catch (ex) { toast(ex.message, 'error'); }
  });
  if (initial) await open(initial);
}
