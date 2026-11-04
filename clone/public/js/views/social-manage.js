// /social/circle — Inner Circle: members, incoming and outgoing requests, add by nickname (PLAN §11 A11).
// /social/settings — profile picture from the sticker set, muted traders, followed topics (PLAN P2.1–P2.3).
// All user content is written with textContent through h(); nothing user-supplied reaches innerHTML.
import { t as tx } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/social-manage-strings.js';
import { api } from '../api.js';
import { session } from '../store.js';
import { toast, relTime, fmtDate } from '../lib.js';
import { h, loadStickers, invalidateMutes } from './social2.js';

const head = (title, active) => {
  const tab = (href, label, key) => h('a', { class: `btn btn-sm${active === key ? '' : ' btn-ghost'}`, href, 'data-link': '' }, label);
  return h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, title), h('div', { class: 'd-flex gap-6 fw-wrap' }, tab('/social', tx('social-manage.head.feed'), 'feed'), tab('/social/circle', tx('social-manage.head.inner_circle'), 'circle'), tab('/messages', tx('social-manage.head.group_chats'), 'messages'), tab('/social/settings', tx('social-manage.head.settings'), 'settings')));
};
const nickLink = (n) => h('a', { href: `/social/profile/${encodeURIComponent(n)}`, 'data-link': '' }, `@${n}`);

export async function render({ el, params, navigate }) {
  if (!session.user) { navigate(`/sign-in?next=${encodeURIComponent(location.pathname)}`, { replace: true }); return undefined; }
  return params.tab === 'circle' ? renderCircle(el) : renderSettings(el);
}

async function renderCircle(el) {
  document.title = tx('social-manage.render_circle.inner_circle_parlance');
  const body = h('div', { class: 'circle-page', 'data-testid': 'circle-page' });
  el.replaceChildren(head(tx('social-manage.render_circle.inner_circle'), 'circle'), h('p', { class: 'muted' }, tx('social-manage.render_circle.your_close_friends_circle_people')), body);
  let seq = 0;
  async function draw() {
    const mine = ++seq;
    const c = await api.circle(session.uid);
    if (mine !== seq || !body.isConnected) return;
    const form = h('form', { class: 'inline-form card ns-card', 'data-testid': 'circle-add' },
      h('label', { class: 'field flex-1' }, h('span', {}, tx('social-manage.render_circle.add_someone_by_nickname')), h('input', { name: 'nick', required: true, maxlength: '20', pattern: '@?[A-Za-z0-9_]{1,20}', placeholder: 'nickname', autocomplete: 'off', 'data-testid': 'circle-nick' })),
      h('button', { class: 'btn btn-primary', type: 'submit', 'data-testid': 'circle-send' }, tx('social-manage.render_circle.send_request')));
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api.circleRequest(session.uid, form.nick.value.trim().replace(/^@/, '')); toast(r.relation === 'member' ? tx('social-manage.render_circle.added_to_your_inner_circle') : tx('social-manage.render_circle.request_sent')); await draw(); } catch (ex) { toast(ex.notFound ? tx('social-manage.render_circle.no_trader_has_that_nickname') : ex.message, 'error'); }
    };
    const act = (label, testid, fn, cls = 'btn btn-sm') => { const b = h('button', { class: cls, type: 'button', 'data-testid': testid }, label); b.onclick = async () => { b.disabled = true; try { if ((await fn()) === false) { b.disabled = false; return; } await draw(); } catch (ex) { toast(ex.message, 'error'); b.disabled = false; } }; return b; };
    const section = (title, testid, rows, empty) => h('section', { class: 'card ns-card', 'data-testid': testid }, h('h3', {}, title), rows.length ? h('div', { class: 'circle-list' }, ...rows) : h('div', { class: 'faint' }, empty));
    body.replaceChildren(form,
      section(tx('social-manage.render_circle.requests_for_you', { value: c.incoming.length }), 'circle-incoming', c.incoming.map((r) => h('div', { class: 'circle-row', 'data-testid': 'circle-incoming-row', 'data-nick': r.nickname }, nickLink(r.nickname), h('span', { class: 'faint' }, relTime(r.created_time)), h('span', { class: 'grow' }),
        act(tx('social-manage.render_circle.accept'), 'circle-accept', () => api.circleAccept(session.uid, r.id), 'btn btn-sm btn-primary'), act(tx('social-manage.render_circle.decline'), 'circle-decline', () => api.circleDecline(session.uid, r.id)))), tx('social-manage.render_circle.no_requests')),
      section(tx('social-manage.render_circle.members', { value: c.members.length, limit: c.limit }), 'circle-members', c.members.map((m) => h('div', { class: 'circle-row', 'data-testid': 'circle-member', 'data-nick': m.nickname }, nickLink(m.nickname), h('span', { class: 'faint' }, tx('social-manage.render_circle.since', { fmt_date: fmtDate(m.since) })), h('span', { class: 'grow' }),
        act(tx('social-manage.render_circle.remove'), 'circle-remove', async () => { if (!confirm(tx('social-manage.render_circle.remove_from_your_inner_circle', { nickname: m.nickname }))) return false; await api.circleRemove(session.uid, m.nickname); return true; }, 'btn btn-sm btn-ghost btn-danger'))), tx('social-manage.render_circle.nobody_yet_send_a_request')),
      section(tx('social-manage.render_circle.sent_requests', { value: c.outgoing.length }), 'circle-outgoing', c.outgoing.map((r) => h('div', { class: 'circle-row', 'data-testid': 'circle-outgoing-row', 'data-nick': r.nickname }, nickLink(r.nickname), h('span', { class: 'faint' }, tx('social-manage.render_circle.sent', { rel_time: relTime(r.created_time) })), h('span', { class: 'grow' }),
        act(tx('social-manage.render_circle.cancel'), 'circle-cancel', () => api.circleCancel(session.uid, r.id)))), tx('social-manage.render_circle.no_pending_requests')));
  }
  await draw();
  const onNotif = (e) => { if (/^circle_/.test(e.detail?.type || '')) draw().catch(() => {}); };
  window.addEventListener('parlance:notification', onNotif);
  return () => window.removeEventListener('parlance:notification', onNotif);
}

async function renderSettings(el) {
  document.title = tx('social-manage.render_settings.social_settings_parlance');
  const avatarBox = h('section', { class: 'card ns-card', 'data-testid': 'avatar-settings' }, h('h3', {}, tx('social-manage.render_settings.profile_picture')), h('div', { class: 'faint' }, tx('social-manage.render_settings.loading')));
  const muteBox = h('section', { class: 'card ns-card', 'data-testid': 'mute-settings' }, h('h3', {}, tx('social-manage.render_settings.muted_traders')));
  const topicBox = h('section', { class: 'card ns-card', 'data-testid': 'topic-settings' }, h('h3', {}, tx('social-manage.render_settings.followed_topics')));
  el.replaceChildren(head(tx('social-manage.render_settings.social_settings'), 'settings'), avatarBox, muteBox, topicBox);

  // Profile picture: one of Parlance's own stickers (no uploads); moderators can decline a choice.
  const drawAvatar = async () => {
    const [{ profile }, list] = await Promise.all([api.myProfile(session.uid), loadStickers()]);
    if (!avatarBox.isConnected) return;
    const st = profile?.avatar_status;
    const grid = h('div', { class: 'sticker-grid' }, ...list.map((s) => {
      const b = h('button', { type: 'button', class: `sticker-opt${profile?.avatar?.sticker_id === s.id ? ' on' : ''}`, title: s.label, 'aria-label': s.label, 'data-testid': `avatar-opt-${s.id}` }, h('img', { src: s.url, alt: '', width: '56', height: '56' }));
      b.onclick = async () => { try { await api.setAvatar(session.uid, s.id); toast(tx('social-manage.render_settings.profile_picture_updated')); drawAvatar(); } catch (ex) { toast(ex.message, 'error'); } };
      return b;
    }));
    const clear = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, tx('social-manage.render_settings.use_my_initial'));
    clear.onclick = async () => { await api.setAvatar(session.uid, null); drawAvatar(); };
    avatarBox.replaceChildren(h('h3', {}, tx('social-manage.render_settings.profile_picture')), !profile ? h('div', { class: 'faint' }, tx('social-manage.render_settings.create_your_social_profile_first')) : grid,
      st && st.status === 'rejected' ? h('div', { class: 'form-error', 'data-testid': 'avatar-rejected' }, tx('social-manage.render_settings.a_moderator_removed_your_picture', { value: st.reason ? `: ${st.reason}` : '' })) : null, profile ? clear : null);
  };
  const drawMutes = async () => {
    const { mutes } = await api.mutes(session.uid);
    if (!muteBox.isConnected) return;
    muteBox.replaceChildren(h('h3', {}, tx('social-manage.render_settings.muted_traders')), h('p', { class: 'faint m-0' }, tx('social-manage.render_settings.you_won_t_see_their')),
      mutes.length ? h('div', { class: 'circle-list' }, ...mutes.map((m) => {
        const b = h('button', { class: 'btn btn-sm', type: 'button', 'data-testid': 'unmute' }, tx('social-manage.render_settings.unmute'));
        b.onclick = async () => { await api.unmute(session.uid, m.nickname); invalidateMutes(); toast(tx('social-manage.render_settings.unmuted', { nickname: m.nickname })); drawMutes(); };
        return h('div', { class: 'circle-row', 'data-testid': 'muted-row', 'data-nick': m.nickname }, nickLink(m.nickname), h('span', { class: 'grow' }), b);
      })) : h('div', { class: 'faint', 'data-testid': 'no-mutes' }, tx('social-manage.render_settings.nobody_is_muted')));
  };
  const drawTopics = async () => {
    const { topics } = await api.topics(session.uid);
    if (!topicBox.isConnected) return;
    const form = h('form', { class: 'inline-form', 'data-testid': 'topic-add' }, h('label', { class: 'field flex-1' }, h('span', {}, tx('social-manage.render_settings.follow_a_keyword')), h('input', { name: 'kw', required: true, maxlength: '32', placeholder: tx('social-manage.render_settings.e_g_tram'), 'data-testid': 'topic-keyword' })), h('button', { class: 'btn', type: 'submit' }, tx('social-manage.render_settings.follow')));
    form.onsubmit = async (e) => { e.preventDefault(); try { await api.followTopic(session.uid, 'keyword', form.kw.value); toast(tx('social-manage.render_settings.keyword_followed')); drawTopics(); } catch (ex) { toast(ex.message, 'error'); } };
    topicBox.replaceChildren(h('h3', {}, tx('social-manage.render_settings.followed_topics')), h('p', { class: 'faint m-0' }, tx('social-manage.render_settings.posts_about_these_events_markets')), form,
      topics.length ? h('div', { class: 'circle-list' }, ...topics.map((t) => {
        const b = h('button', { class: 'btn btn-sm', type: 'button', 'data-testid': 'unfollow-topic' }, tx('social-manage.render_settings.unfollow'));
        b.onclick = async () => { await api.unfollowTopic(session.uid, t.kind, t.value); drawTopics(); };
        return h('div', { class: 'circle-row', 'data-testid': 'topic-row', 'data-kind': t.kind }, h('span', { class: 'faint' }, t.kind), t.link ? h('a', { href: t.link, 'data-link': '' }, t.label) : h('span', {}, t.label), h('span', { class: 'grow' }), b);
      })) : h('div', { class: 'faint' }, tx('social-manage.render_settings.no_topics_yet_use_follow')));
  };
  await Promise.all([drawAvatar(), drawMutes(), drawTopics()]);
}
