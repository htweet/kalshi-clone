// Social moderation (report queue, hide / delete, posting bans, verified badges) and announcements
// (broadcast notifications to a segment, templates, history).
import { esc, get, post, del, toast, dataTable, formHtml, wireForm, confirmAction, section, subTabs, statusBadge, badge, fmtTime } from './ui.js';

const MTABS = [['reports', 'Report queue'], ['profiles', 'Profiles & bans'], ['hidden', 'Hidden content']];

export async function render({ el, section: sec, parts }) {
  if (sec === 'announcements') return renderAnnouncements(el);
  const tab = MTABS.some(([k]) => k === parts[0]) ? parts[0] : 'reports';
  el.innerHTML = section('Moderation', 'Reports from users about posts and replies. Hiding removes content from every feed but keeps it for review; deleting removes it permanently.') + subTabs(MTABS, tab, '/admin/moderation') + '<div id="mod"></div>';
  const host = el.querySelector('#mod');
  if (tab === 'reports') {
    host.innerHTML = '<div class="adm-toolbar"><div class="seg" role="tablist" data-st>' + ['open', 'actioned', 'dismissed', 'all'].map((s, i) => `<button data-status="${s}" class="${i ? '' : 'on'}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('') + '</div></div><div data-list></div>';
    let status = 'open'; let rows = [];
    const t = dataTable(host.querySelector('[data-list]'), { testid: 'mod-reports', empty: 'No reports.', rowAttrs: (r) => `data-row="${esc(r.id)}" data-content="${esc(r.content_id)}"`,
      cols: [{ key: 'status', label: 'Status', render: (r) => statusBadge(r.status) }, { key: 'kind', label: 'Type' },
        { key: 'excerpt', label: 'Content', render: (r) => `<div class="adm-note">${esc(r.excerpt)}</div><div class="faint">by ${r.author_nickname ? '@' + esc(r.author_nickname) : 'unknown'}${r.author_banned ? ' · banned' : ''}${r.hidden ? ' · hidden' : ''}${r.content_exists ? '' : ' · deleted'}</div>` },
        { key: 'reason', label: 'Reason', render: (r) => `${esc(r.reason)}<div class="faint">${esc(r.reporter_email || '')} · ${esc(fmtTime(r.created_at))}${r.reports_on_content > 1 ? ` · ${r.reports_on_content} reports` : ''}</div>` },
        { key: '_a', label: '', sort: false, render: (r) => (r.status === 'open' ? `<span class="adm-actions"><button class="btn btn-sm btn-primary" data-act="hide" data-id="${esc(r.id)}">Hide</button><button class="btn btn-sm btn-ghost btn-danger" data-act="delete" data-id="${esc(r.id)}">Delete</button><button class="btn btn-sm" data-act="dismiss" data-id="${esc(r.id)}">Dismiss</button>${r.author_id && !r.author_banned ? `<button class="btn btn-sm" data-ban="${esc(r.author_id)}">Ban author</button>` : ''}</span>` : `<span class="faint">${esc(r.resolution || '')} by ${esc(r.resolved_by || '')}</span>`) }] });
    const load = async () => { rows = (await get(`/moderation/reports?status=${status}`)).reports; t.setRows(rows); };
    host.querySelector('[data-st]').addEventListener('click', (e) => { const b = e.target.closest('[data-status]'); if (!b) return; status = b.dataset.status; for (const x of host.querySelectorAll('[data-status]')) x.classList.toggle('on', x === b); load(); });
    host.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act],button[data-ban]');
      if (!b) return;
      try {
        if (b.dataset.ban) { const ok = await confirmAction({ title: 'Ban this author from posting?', body: 'They can still read and trade, but cannot post or reply.', confirm: 'Ban from posting', danger: true, reason: true }); if (!ok) return; await post(`/moderation/users/${encodeURIComponent(b.dataset.ban)}/ban`, { reason: ok.reason }); toast('Author banned from posting'); }
        else {
          const act = b.dataset.act;
          if (act === 'delete') { const ok = await confirmAction({ title: 'Delete this content permanently?', body: 'It cannot be restored.', confirm: 'Delete', danger: true }); if (!ok) return; }
          await post(`/moderation/reports/${encodeURIComponent(b.dataset.id)}/${act}`, {});
          toast(act === 'hide' ? 'Content hidden' : act === 'delete' ? 'Content deleted' : 'Report dismissed');
        }
        await load();
      } catch (ex) { toast(ex.message, 'error'); }
    });
    return load();
  }
  if (tab === 'hidden') {
    const t = dataTable(host, { testid: 'mod-hidden', empty: 'Nothing is hidden.', cols: [{ key: 'kind', label: 'Type' }, { key: 'excerpt', label: 'Content', render: (r) => `<div class="adm-note">${esc(r.excerpt)}</div><div class="faint">${r.author_nickname ? '@' + esc(r.author_nickname) : ''}</div>` }, { key: 'hidden_by', label: 'Hidden by' }, { key: 'created_at', label: 'When', render: (r) => esc(fmtTime(r.created_at)) },
      { key: '_a', label: '', sort: false, render: (r) => `<button class="btn btn-sm" data-unhide="${esc(r.content_id)}" data-kind="${esc(r.kind)}">Restore</button>` }] });
    const load = async () => t.setRows((await get('/moderation/hidden')).hidden);
    host.addEventListener('click', async (e) => { const b = e.target.closest('[data-unhide]'); if (!b) return; try { await post(`/moderation/content/${b.dataset.kind}/${encodeURIComponent(b.dataset.unhide)}/unhide`, {}); toast('Restored'); await load(); } catch (ex) { toast(ex.message, 'error'); } });
    return load();
  }
  host.innerHTML = '<form class="adm-search-row" data-s><input type="search" class="adm-input" name="q" placeholder="Search nickname or email" aria-label="Search profiles"><button class="btn" type="submit">Search</button></form><div data-list></div>';
  const t = dataTable(host.querySelector('[data-list]'), { search: false, testid: 'mod-profiles', rowAttrs: (r) => `data-nick="${esc(r.nickname)}"`,
    cols: [{ key: 'nickname', label: 'Nickname', render: (r) => `@${esc(r.nickname)}${r.verified ? ' <span class="verified-badge" title="Verified">✓</span>' : ''}` }, { key: 'email', label: 'Email' }, { key: 'posts', label: 'Posts', num: true },
      { key: 'banned', label: 'Posting', render: (r) => (r.banned ? `${badge('banned', 'bad')}<div class="faint">${esc(r.ban?.reason || '')}</div>` : badge('allowed', 'ok')) },
      { key: '_a', label: '', sort: false, render: (r) => `<span class="adm-actions">${r.banned ? `<button class="btn btn-sm" data-u="${esc(r.user_id)}" data-a="unban">Unban</button>` : `<button class="btn btn-sm btn-ghost btn-danger" data-u="${esc(r.user_id)}" data-a="ban">Ban posting</button>`}${r.verified ? `<button class="btn btn-sm" data-u="${esc(r.user_id)}" data-a="unverify">Remove badge</button>` : `<button class="btn btn-sm" data-u="${esc(r.user_id)}" data-a="verify">Verify</button>`}</span>` }] });
  let q = '';
  const load = async () => t.setRows((await get(`/moderation/profiles?q=${encodeURIComponent(q)}`)).profiles);
  host.querySelector('[data-s]').addEventListener('submit', (e) => { e.preventDefault(); q = e.target.q.value.trim(); load(); });
  host.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    try {
      let body = {};
      if (a === 'ban' || a === 'unban') { const ok = await confirmAction({ title: a === 'ban' ? 'Ban from posting?' : 'Restore posting?', confirm: a === 'ban' ? 'Ban' : 'Unban', danger: a === 'ban', reason: true }); if (!ok) return; body = { reason: ok.reason }; }
      await post(`/moderation/users/${encodeURIComponent(b.dataset.u)}/${a}`, body);
      toast({ ban: 'Banned from posting', unban: 'Posting restored', verify: 'Verified badge added', unverify: 'Badge removed' }[a]);
      await load();
    } catch (ex) { toast(ex.message, 'error'); }
  });
  return load();
}

async function renderAnnouncements(el) {
  el.innerHTML = section('Announcements', 'Send a notification to every user in a segment. It lands in their inbox and pops up live for anyone online.') + '<div class="adm-two"><div class="card adm-card" id="an-form"></div><div class="card adm-card" id="an-tpl"></div></div><h3 class="adm-h3">History</h3><div id="an-hist"></div>';
  let data;
  const hist = dataTable(el.querySelector('#an-hist'), { testid: 'ann-history', empty: 'Nothing sent yet.', cols: [{ key: 'created_at', label: 'Sent', render: (r) => esc(fmtTime(r.created_at)) }, { key: 'title', label: 'Title' }, { key: 'segment', label: 'Segment' }, { key: 'recipients', label: 'Recipients', num: true }, { key: 'created_by', label: 'By' }] });
  async function load() {
    data = await get('/announcements');
    hist.setRows(data.history);
    const fields = [
      { name: 'template_id', label: 'Start from template', type: 'select', options: [['', '— none —'], ...data.templates.map((t) => [t.id, t.name])] },
      { name: 'segment', label: 'Send to', type: 'select', options: data.segments.map((s) => [s.key, `${s.label} (${s.count})`]) },
      { name: 'title', label: 'Title', required: true, span: true }, { name: 'body', label: 'Message', type: 'textarea', span: true }, { name: 'link', label: 'Link (optional)', placeholder: '/browse' }];
    const box = el.querySelector('#an-form');
    box.innerHTML = `<h3>New announcement</h3>${formHtml(fields, { submit: 'Send…', id: 'ann', testid: 'ann-form', extra: '<button class="btn" type="button" data-save-tpl>Save as template</button>' })}`;
    const form = box.querySelector('form');
    form.template_id.onchange = () => { const t = data.templates.find((x) => x.id === form.template_id.value); if (t) { form.title.value = t.title; form.body.value = t.body; form.link.value = t.link; } };
    const w = wireForm(form, fields, async (v) => {
      const seg = data.segments.find((s) => s.key === v.segment);
      const ok = await confirmAction({ title: `Send to ${seg.count} user(s)?`, body: `<b>${esc(v.title)}</b><br>${esc(v.body)}`, confirm: 'Send now' });
      if (!ok) return;
      const r = await post('/announcements', v);
      toast(`Sent to ${r.announcement.recipients} user(s)`);
      await load();
    });
    box.querySelector('[data-save-tpl]').onclick = async () => {
      const v = w.values();
      const name = prompt('Template name', v.title);
      if (!name) return;
      try { await post('/announcements/templates', { name, title: v.title, body: v.body, link: v.link }); toast('Template saved'); await load(); } catch (ex) { toast(ex.message, 'error'); }
    };
    el.querySelector('#an-tpl').innerHTML = `<h3>Templates</h3>${data.templates.length ? `<ul class="adm-list" data-testid="ann-templates">${data.templates.map((t) => `<li><b>${esc(t.name)}</b> <button class="btn btn-sm btn-ghost btn-danger" data-del-tpl="${esc(t.id)}">Delete</button><div class="muted">${esc(t.title)}</div></li>`).join('')}</ul>` : '<p class="faint">No templates yet. Fill in the form and choose “Save as template”.</p>'}`;
  }
  el.querySelector('#an-tpl').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-tpl]');
    if (!b) return;
    const ok = await confirmAction({ title: 'Delete template?', confirm: 'Delete', danger: true });
    if (!ok) return;
    try { await del(`/announcements/templates/${encodeURIComponent(b.dataset.delTpl)}`); await load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  await load();
}
