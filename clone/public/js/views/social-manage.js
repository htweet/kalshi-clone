// /social/circle — Inner Circle: members, incoming and outgoing requests, add by nickname (PLAN §11 A11).
// /social/settings — profile picture from the sticker set, muted traders, followed topics (PLAN P2.1–P2.3).
// All user content is written with textContent through h(); nothing user-supplied reaches innerHTML.
import { api } from '../api.js';
import { session } from '../store.js';
import { toast, relTime, fmtDate } from '../lib.js';
import { h, loadStickers, invalidateMutes } from './social2.js';

const head = (title, active) => {
  const tab = (href, label, key) => h('a', { class: `btn btn-sm${active === key ? '' : ' btn-ghost'}`, href, 'data-link': '' }, label);
  return h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, title), h('div', { class: 'd-flex gap-6 fw-wrap' }, tab('/social', 'Feed', 'feed'), tab('/social/circle', 'Inner Circle', 'circle'), tab('/messages', 'Group chats', 'messages'), tab('/social/settings', 'Settings', 'settings')));
};
const nickLink = (n) => h('a', { href: `/social/profile/${encodeURIComponent(n)}`, 'data-link': '' }, `@${n}`);

export async function render({ el, params, navigate }) {
  if (!session.user) { navigate(`/sign-in?next=${encodeURIComponent(location.pathname)}`, { replace: true }); return undefined; }
  return params.tab === 'circle' ? renderCircle(el) : renderSettings(el);
}

async function renderCircle(el) {
  document.title = 'Inner Circle · Parlance';
  const body = h('div', { class: 'circle-page', 'data-testid': 'circle-page' });
  el.replaceChildren(head('Inner Circle', 'circle'), h('p', { class: 'muted' }, 'Your close-friends circle. People in it see your circle-only posts, and you can start group chats with them. Requests need the other person to accept.'), body);
  let seq = 0;
  async function draw() {
    const mine = ++seq;
    const c = await api.circle(session.uid);
    if (mine !== seq || !body.isConnected) return;
    const form = h('form', { class: 'inline-form card ns-card', 'data-testid': 'circle-add' },
      h('label', { class: 'field flex-1' }, h('span', {}, 'Add someone by nickname'), h('input', { name: 'nick', required: true, maxlength: '20', pattern: '@?[A-Za-z0-9_]{1,20}', placeholder: 'nickname', autocomplete: 'off', 'data-testid': 'circle-nick' })),
      h('button', { class: 'btn btn-primary', type: 'submit', 'data-testid': 'circle-send' }, 'Send request'));
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api.circleRequest(session.uid, form.nick.value.trim().replace(/^@/, '')); toast(r.relation === 'member' ? 'Added to your Inner Circle' : 'Request sent'); await draw(); } catch (ex) { toast(ex.notFound ? 'No trader has that nickname.' : ex.message, 'error'); }
    };
    const act = (label, testid, fn, cls = 'btn btn-sm') => { const b = h('button', { class: cls, type: 'button', 'data-testid': testid }, label); b.onclick = async () => { b.disabled = true; try { if ((await fn()) === false) { b.disabled = false; return; } await draw(); } catch (ex) { toast(ex.message, 'error'); b.disabled = false; } }; return b; };
    const section = (title, testid, rows, empty) => h('section', { class: 'card ns-card', 'data-testid': testid }, h('h3', {}, title), rows.length ? h('div', { class: 'circle-list' }, ...rows) : h('div', { class: 'faint' }, empty));
    body.replaceChildren(form,
      section(`Requests for you (${c.incoming.length})`, 'circle-incoming', c.incoming.map((r) => h('div', { class: 'circle-row', 'data-testid': 'circle-incoming-row', 'data-nick': r.nickname }, nickLink(r.nickname), h('span', { class: 'faint' }, relTime(r.created_time)), h('span', { class: 'grow' }),
        act('Accept', 'circle-accept', () => api.circleAccept(session.uid, r.id), 'btn btn-sm btn-primary'), act('Decline', 'circle-decline', () => api.circleDecline(session.uid, r.id)))), 'No requests.'),
      section(`Members (${c.members.length}/${c.limit})`, 'circle-members', c.members.map((m) => h('div', { class: 'circle-row', 'data-testid': 'circle-member', 'data-nick': m.nickname }, nickLink(m.nickname), h('span', { class: 'faint' }, `since ${fmtDate(m.since)}`), h('span', { class: 'grow' }),
        act('Remove', 'circle-remove', async () => { if (!confirm(`Remove @${m.nickname} from your Inner Circle? You leave theirs too.`)) return false; await api.circleRemove(session.uid, m.nickname); return true; }, 'btn btn-sm btn-ghost btn-danger'))), 'Nobody yet. Send a request to someone you trust.'),
      section(`Sent requests (${c.outgoing.length})`, 'circle-outgoing', c.outgoing.map((r) => h('div', { class: 'circle-row', 'data-testid': 'circle-outgoing-row', 'data-nick': r.nickname }, nickLink(r.nickname), h('span', { class: 'faint' }, `sent ${relTime(r.created_time)}`), h('span', { class: 'grow' }),
        act('Cancel', 'circle-cancel', () => api.circleCancel(session.uid, r.id)))), 'No pending requests.'));
  }
  await draw();
  const onNotif = (e) => { if (/^circle_/.test(e.detail?.type || '')) draw().catch(() => {}); };
  window.addEventListener('parlance:notification', onNotif);
  return () => window.removeEventListener('parlance:notification', onNotif);
}

async function renderSettings(el) {
  document.title = 'Social settings · Parlance';
  const avatarBox = h('section', { class: 'card ns-card', 'data-testid': 'avatar-settings' }, h('h3', {}, 'Profile picture'), h('div', { class: 'faint' }, 'Loading…'));
  const muteBox = h('section', { class: 'card ns-card', 'data-testid': 'mute-settings' }, h('h3', {}, 'Muted traders'));
  const topicBox = h('section', { class: 'card ns-card', 'data-testid': 'topic-settings' }, h('h3', {}, 'Followed topics'));
  el.replaceChildren(head('Social settings', 'settings'), avatarBox, muteBox, topicBox);

  // Profile picture: one of Parlance's own stickers (no uploads); moderators can decline a choice.
  const drawAvatar = async () => {
    const [{ profile }, list] = await Promise.all([api.myProfile(session.uid), loadStickers()]);
    if (!avatarBox.isConnected) return;
    const st = profile?.avatar_status;
    const grid = h('div', { class: 'sticker-grid' }, ...list.map((s) => {
      const b = h('button', { type: 'button', class: `sticker-opt${profile?.avatar?.sticker_id === s.id ? ' on' : ''}`, title: s.label, 'aria-label': s.label, 'data-testid': `avatar-opt-${s.id}` }, h('img', { src: s.url, alt: '', width: '56', height: '56' }));
      b.onclick = async () => { try { await api.setAvatar(session.uid, s.id); toast('Profile picture updated'); drawAvatar(); } catch (ex) { toast(ex.message, 'error'); } };
      return b;
    }));
    const clear = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Use my initial');
    clear.onclick = async () => { await api.setAvatar(session.uid, null); drawAvatar(); };
    avatarBox.replaceChildren(h('h3', {}, 'Profile picture'), !profile ? h('div', { class: 'faint' }, 'Create your social profile first (Account › Social profile).') : grid,
      st && st.status === 'rejected' ? h('div', { class: 'form-error', 'data-testid': 'avatar-rejected' }, `A moderator removed your picture${st.reason ? `: ${st.reason}` : ''}. Pick another one.`) : null, profile ? clear : null);
  };
  const drawMutes = async () => {
    const { mutes } = await api.mutes(session.uid);
    if (!muteBox.isConnected) return;
    muteBox.replaceChildren(h('h3', {}, 'Muted traders'), h('p', { class: 'faint m-0' }, 'You won’t see their posts, replies, chat or group messages, or get notifications they cause. They are not told.'),
      mutes.length ? h('div', { class: 'circle-list' }, ...mutes.map((m) => {
        const b = h('button', { class: 'btn btn-sm', type: 'button', 'data-testid': 'unmute' }, 'Unmute');
        b.onclick = async () => { await api.unmute(session.uid, m.nickname); invalidateMutes(); toast(`Unmuted @${m.nickname}`); drawMutes(); };
        return h('div', { class: 'circle-row', 'data-testid': 'muted-row', 'data-nick': m.nickname }, nickLink(m.nickname), h('span', { class: 'grow' }), b);
      })) : h('div', { class: 'faint', 'data-testid': 'no-mutes' }, 'Nobody is muted.'));
  };
  const drawTopics = async () => {
    const { topics } = await api.topics(session.uid);
    if (!topicBox.isConnected) return;
    const form = h('form', { class: 'inline-form', 'data-testid': 'topic-add' }, h('label', { class: 'field flex-1' }, h('span', {}, 'Follow a keyword'), h('input', { name: 'kw', required: true, maxlength: '32', placeholder: 'e.g. tram', 'data-testid': 'topic-keyword' })), h('button', { class: 'btn', type: 'submit' }, 'Follow'));
    form.onsubmit = async (e) => { e.preventDefault(); try { await api.followTopic(session.uid, 'keyword', form.kw.value); toast('Keyword followed'); drawTopics(); } catch (ex) { toast(ex.message, 'error'); } };
    topicBox.replaceChildren(h('h3', {}, 'Followed topics'), h('p', { class: 'faint m-0' }, 'Posts about these events, markets and keywords appear in your Topics feed and can notify you (Post alerts).'), form,
      topics.length ? h('div', { class: 'circle-list' }, ...topics.map((t) => {
        const b = h('button', { class: 'btn btn-sm', type: 'button', 'data-testid': 'unfollow-topic' }, 'Unfollow');
        b.onclick = async () => { await api.unfollowTopic(session.uid, t.kind, t.value); drawTopics(); };
        return h('div', { class: 'circle-row', 'data-testid': 'topic-row', 'data-kind': t.kind }, h('span', { class: 'faint' }, t.kind), t.link ? h('a', { href: t.link, 'data-link': '' }, t.label) : h('span', {}, t.label), h('span', { class: 'grow' }), b);
      })) : h('div', { class: 'faint' }, 'No topics yet. Use Follow on an event page, or add a keyword.'));
  };
  await Promise.all([drawAvatar(), drawMutes(), drawTopics()]);
}
