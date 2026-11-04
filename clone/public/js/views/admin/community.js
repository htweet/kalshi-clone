// Social moderation (report queue, hide / delete, posting bans, verified badges) and announcements
// (broadcast notifications to a segment, templates, history).
import { t as tx, te, ts } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.community-strings.js';
import { esc, get, post, del, toast, dataTable, formHtml, wireForm, confirmAction, section, subTabs, statusBadge, badge, fmtTime } from './ui.js';

const MTABS = [['reports', ts('admin.community.mtabs.report_queue')], ['profiles', ts('admin.community.mtabs.profiles_bans')], ['hidden', ts('admin.community.mtabs.hidden_content')]];

export async function render({ el, section: sec, parts }) {
  if (sec === 'announcements') return renderAnnouncements(el);
  const tab = MTABS.some(([k]) => k === parts[0]) ? parts[0] : 'reports';
  el.innerHTML = section(tx('admin.community.render.moderation'), tx('admin.community.render.reports_from_users_about_posts')) + subTabs(MTABS, tab, '/admin/moderation') + '<div id="mod"></div>';
  const host = el.querySelector('#mod');
  if (tab === 'reports') {
    host.innerHTML = '<div class="adm-toolbar"><div class="seg" role="tablist" data-st>' + ['open', 'actioned', 'dismissed', 'all'].map((s, i) => `<button data-status="${s}" class="${i ? '' : 'on'}">${esc(s[0].toUpperCase() + s.slice(1))}</button>`).join('') + '</div></div><div data-list></div>';
    let status = 'open'; let rows = [];
    const t = dataTable(host.querySelector('[data-list]'), { testid: 'mod-reports', empty: tx('admin.community.render.no_reports'), rowAttrs: (r) => `data-row="${esc(r.id)}" data-content="${esc(r.content_id)}"`,
      cols: [{ key: 'status', label: tx('admin.community.render.status'), render: (r) => statusBadge(r.status) }, { key: 'kind', label: tx('admin.community.render.type') },
        { key: 'excerpt', label: tx('admin.community.render.content'), render: (r) => `<div class="adm-note">${esc(r.excerpt)}</div><div class="faint">${te('admin.community.render.by', { value: r.author_nickname ? '@' + esc(r.author_nickname) : te('admin.community.render.unknown'), value_2: r.author_banned ? (' ' + te('admin.community.render.banned')) : '', value_3: r.hidden ? (' ' + te('admin.community.render.hidden')) : '', value_4: r.content_exists ? '' : (' ' + te('admin.community.render.deleted')) })}</div>` },
        { key: 'reason', label: tx('admin.community.render.reason'), render: (r) => `${esc(r.reason)}<div class="faint">${esc(r.reporter_email || '')} · ${esc(fmtTime(r.created_at))}${r.reports_on_content > 1 ? (' ' + te('admin.community.render.reports', { reports_on_content: esc(r.reports_on_content) })) : ''}</div>` },
        { key: '_a', label: '', sort: false, render: (r) => (r.status === 'open' ? `<span class="adm-actions"><button class="btn btn-sm btn-primary" data-act="hide" data-id="${esc(r.id)}">${te('admin.community.render.hide')}</button><button class="btn btn-sm btn-ghost btn-danger" data-act="delete" data-id="${esc(r.id)}">${te('admin.community.render.delete')}</button><button class="btn btn-sm" data-act="dismiss" data-id="${esc(r.id)}">${te('admin.community.render.dismiss')}</button>${r.author_id && !r.author_banned ? `<button class="btn btn-sm" data-ban="${esc(r.author_id)}">${te('admin.community.render.ban_author')}</button>` : ''}</span>` : `<span class="faint">${te('admin.community.render.by_2', { value: esc(r.resolution || ''), value_2: esc(r.resolved_by || '') })}</span>`) }] });
    const load = async () => { rows = (await get(`/moderation/reports?status=${status}`)).reports; t.setRows(rows); };
    host.querySelector('[data-st]').addEventListener('click', (e) => { const b = e.target.closest('[data-status]'); if (!b) return; status = b.dataset.status; for (const x of host.querySelectorAll('[data-status]')) x.classList.toggle('on', x === b); load(); });
    host.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act],button[data-ban]');
      if (!b) return;
      try {
        if (b.dataset.ban) { const ok = await confirmAction({ title: tx('admin.community.render.ban_this_author_from_posting'), body: tx('admin.community.render.they_can_still_read_and'), confirm: tx('admin.community.render.ban_from_posting'), danger: true, reason: true }); if (!ok) return; await post(`/moderation/users/${encodeURIComponent(b.dataset.ban)}/ban`, { reason: ok.reason }); toast(tx('admin.community.render.author_banned_from_posting')); }
        else {
          const act = b.dataset.act;
          if (act === 'delete') { const ok = await confirmAction({ title: tx('admin.community.render.delete_this_content_permanently'), body: tx('admin.community.render.it_cannot_be_restored'), confirm: tx('admin.community.render.delete'), danger: true }); if (!ok) return; }
          await post(`/moderation/reports/${encodeURIComponent(b.dataset.id)}/${act}`, {});
          toast(act === 'hide' ? tx('admin.community.render.content_hidden') : act === 'delete' ? tx('admin.community.render.content_deleted') : tx('admin.community.render.report_dismissed'));
        }
        await load();
      } catch (ex) { toast(ex.message, 'error'); }
    });
    return load();
  }
  if (tab === 'hidden') {
    const t = dataTable(host, { testid: 'mod-hidden', empty: tx('admin.community.render.nothing_is_hidden'), cols: [{ key: 'kind', label: tx('admin.community.render.type') }, { key: 'excerpt', label: tx('admin.community.render.content'), render: (r) => `<div class="adm-note">${esc(r.excerpt)}</div><div class="faint">${r.author_nickname ? '@' + esc(r.author_nickname) : ''}</div>` }, { key: 'hidden_by', label: tx('admin.community.render.hidden_by') }, { key: 'created_at', label: tx('admin.community.render.when'), render: (r) => esc(fmtTime(r.created_at)) },
      { key: '_a', label: '', sort: false, render: (r) => `<button class="btn btn-sm" data-unhide="${esc(r.content_id)}" data-kind="${esc(r.kind)}">${te('admin.community.render.restore')}</button>` }] });
    const load = async () => t.setRows((await get('/moderation/hidden')).hidden);
    host.addEventListener('click', async (e) => { const b = e.target.closest('[data-unhide]'); if (!b) return; try { await post(`/moderation/content/${b.dataset.kind}/${encodeURIComponent(b.dataset.unhide)}/unhide`, {}); toast(tx('admin.community.render.restored')); await load(); } catch (ex) { toast(ex.message, 'error'); } });
    return load();
  }
  host.innerHTML = `<form class="adm-search-row" data-s><input type="search" class="adm-input" name="q" placeholder="${te('admin.community.render.search_nickname_or_email')}" aria-label="${te('admin.community.render.search_profiles')}"><button class="btn" type="submit">${te('admin.community.render.search')}</button></form><div data-list></div>`;
  const t = dataTable(host.querySelector('[data-list]'), { search: false, testid: 'mod-profiles', rowAttrs: (r) => `data-nick="${esc(r.nickname)}"`,
    cols: [{ key: 'nickname', label: tx('admin.community.render.nickname'), render: (r) => `@${esc(r.nickname)}${r.verified ? ` <span class="verified-badge" title="${te('admin.community.render.verified')}">✓</span>` : ''}` }, { key: 'email', label: tx('admin.community.render.email') }, { key: 'posts', label: tx('admin.community.render.posts'), num: true },
      { key: 'banned', label: tx('admin.community.render.posting'), render: (r) => (r.banned ? `${badge('banned', 'bad')}<div class="faint">${esc(r.ban?.reason || '')}</div>` : badge('allowed', 'ok')) },
      { key: '_a', label: '', sort: false, render: (r) => `<span class="adm-actions">${r.banned ? `<button class="btn btn-sm" data-u="${esc(r.user_id)}" data-a="unban">${te('admin.community.render.unban')}</button>` : `<button class="btn btn-sm btn-ghost btn-danger" data-u="${esc(r.user_id)}" data-a="ban">${te('admin.community.render.ban_posting')}</button>`}${r.verified ? `<button class="btn btn-sm" data-u="${esc(r.user_id)}" data-a="unverify">${te('admin.community.render.remove_badge')}</button>` : `<button class="btn btn-sm" data-u="${esc(r.user_id)}" data-a="verify">${te('admin.community.render.verify')}</button>`}</span>` }] });
  let q = '';
  const load = async () => t.setRows((await get(`/moderation/profiles?q=${encodeURIComponent(q)}`)).profiles);
  host.querySelector('[data-s]').addEventListener('submit', (e) => { e.preventDefault(); q = e.target.q.value.trim(); load(); });
  host.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    try {
      let body = {};
      if (a === 'ban' || a === 'unban') { const ok = await confirmAction({ title: a === 'ban' ? tx('admin.community.render.ban_from_posting_2') : tx('admin.community.render.restore_posting'), confirm: a === 'ban' ? tx('admin.community.render.ban') : tx('admin.community.render.unban'), danger: a === 'ban', reason: true }); if (!ok) return; body = { reason: ok.reason }; }
      await post(`/moderation/users/${encodeURIComponent(b.dataset.u)}/${a}`, body);
      toast({ ban: tx('admin.community.render.banned_from_posting'), unban: tx('admin.community.render.posting_restored'), verify: tx('admin.community.render.verified_badge_added'), unverify: tx('admin.community.render.badge_removed') }[a]);
      await load();
    } catch (ex) { toast(ex.message, 'error'); }
  });
  return load();
}

async function renderAnnouncements(el) {
  el.innerHTML = section(tx('admin.community.render_announcements.announcements'), tx('admin.community.render_announcements.send_a_notification_to_every')) + `<div class="adm-two"><div class="card adm-card" id="an-form"></div><div class="card adm-card" id="an-tpl"></div></div><h3 class="adm-h3">${te('admin.community.render_announcements.history')}</h3><div id="an-hist"></div>`;
  let data;
  const hist = dataTable(el.querySelector('#an-hist'), { testid: 'ann-history', empty: tx('admin.community.render_announcements.nothing_sent_yet'), cols: [{ key: 'created_at', label: 'Sent', render: (r) => esc(fmtTime(r.created_at)) }, { key: 'title', label: tx('admin.community.render_announcements.title') }, { key: 'segment', label: tx('admin.community.render_announcements.segment') }, { key: 'recipients', label: tx('admin.community.render_announcements.recipients'), num: true }, { key: 'created_by', label: tx('admin.community.render_announcements.by') }] });
  async function load() {
    data = await get('/announcements');
    hist.setRows(data.history);
    const fields = [
      { name: 'template_id', label: tx('admin.community.render_announcements.start_from_template'), type: 'select', options: [['', '— none —'], ...data.templates.map((t) => [t.id, t.name])] },
      { name: 'segment', label: tx('admin.community.render_announcements.send_to'), type: 'select', options: data.segments.map((s) => [s.key, `${s.label} (${s.count})`]) },
      { name: 'title', label: tx('admin.community.render_announcements.title'), required: true, span: true }, { name: 'body', label: tx('admin.community.render_announcements.message'), type: 'textarea', span: true }, { name: 'link', label: tx('admin.community.render_announcements.link_optional'), placeholder: '/browse' }];
    const box = el.querySelector('#an-form');
    box.innerHTML = `<h3>${te('admin.community.render_announcements.new_announcement')}</h3>${formHtml(fields, { submit: 'Send…', id: 'ann', testid: 'ann-form', extra: `<button class="btn" type="button" data-save-tpl>${te('admin.community.render_announcements.save_as_template')}</button>` })}`;
    const form = box.querySelector('form');
    form.template_id.onchange = () => { const t = data.templates.find((x) => x.id === form.template_id.value); if (t) { form.title.value = t.title; form.body.value = t.body; form.link.value = t.link; } };
    const w = wireForm(form, fields, async (v) => {
      const seg = data.segments.find((s) => s.key === v.segment);
      const ok = await confirmAction({ title: tx('admin.community.render_announcements.send_to_user_s', { count: seg.count }), body: `<b>${esc(v.title)}</b><br>${esc(v.body)}`, confirm: tx('admin.community.render_announcements.send_now') });
      if (!ok) return;
      const r = await post('/announcements', v);
      toast(tx('admin.community.render_announcements.sent_to_user_s', { recipients: r.announcement.recipients }));
      await load();
    });
    box.querySelector('[data-save-tpl]').onclick = async () => {
      const v = w.values();
      const name = prompt(tx('admin.community.render_announcements.template_name'), v.title);
      if (!name) return;
      try { await post('/announcements/templates', { name, title: v.title, body: v.body, link: v.link }); toast(tx('admin.community.render_announcements.template_saved')); await load(); } catch (ex) { toast(ex.message, 'error'); }
    };
    el.querySelector('#an-tpl').innerHTML = `<h3>${te('admin.community.render_announcements.templates')}</h3>${data.templates.length ? `<ul class="adm-list" data-testid="ann-templates">${data.templates.map((t) => `<li><b>${esc(t.name)}</b> <button class="btn btn-sm btn-ghost btn-danger" data-del-tpl="${esc(t.id)}">${te('admin.community.render_announcements.delete')}</button><div class="muted">${esc(t.title)}</div></li>`).join('')}</ul>` : `<p class="faint">${te('admin.community.render_announcements.no_templates_yet_fill_in')}</p>`}`;
  }
  el.querySelector('#an-tpl').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-tpl]');
    if (!b) return;
    const ok = await confirmAction({ title: tx('admin.community.render_announcements.delete_template'), confirm: tx('admin.community.render_announcements.delete'), danger: true });
    if (!ok) return;
    try { await del(`/announcements/templates/${encodeURIComponent(b.dataset.delTpl)}`); await load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  await load();
}
