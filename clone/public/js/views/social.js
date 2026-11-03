// Social (spec §13.6): feed (All / Following / Saved) with composer, likes, replies, bookmarks;
// leaderboard; public profiles with follow, stats and shared holdings.
import { api } from '../api.js';
import { session } from '../store.js';
import { esc, avatar, money, qty, relTime, toast, shortDate } from '../lib.js';
import { postCard, badgeChips, authorAvatar, stickerImg } from './components.js';
import { composerExtrasHtml, wireComposerExtras, openStickerPicker, toggleMute, startTimelineBadge, h } from './social2.js'; // Phase 2 (§24)

// Wire like / reply / bookmark / delete on every post inside `root`. Used by the feed, profiles and event pages.
export function wirePosts(root, { navigate, onDeleted } = {}) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('[data-post]');
    if (!btn || !card || !root.contains(card)) return;
    const pid = card.dataset.post;
    const act = btn.dataset.act;
    if (act === 'share' || act === 'read-more') return; // handled document-wide (views/social2.js)
    if (!session.user && act !== 'comments') { navigate('/sign-in?next=' + encodeURIComponent(location.pathname)); return; }
    try {
      if (act === 'like') {
        const on = btn.classList.contains('on');
        const { post } = on ? await api.unlike(session.uid, pid) : await api.like(session.uid, pid);
        btn.classList.toggle('on', post.liked); btn.setAttribute('aria-pressed', String(post.liked));
        btn.querySelector('[data-testid=like-count]').textContent = post.like_count;
      } else if (act === 'bookmark') {
        const on = btn.classList.contains('on');
        const { post } = on ? await api.unbookmark(session.uid, pid) : await api.bookmark(session.uid, pid);
        btn.classList.toggle('on', post.bookmarked); btn.setAttribute('aria-pressed', String(post.bookmarked));
        toast(post.bookmarked ? 'Saved' : 'Removed from saved');
      } else if (act === 'delete') {
        if (!confirm('Delete this post?')) return;
        await api.deletePost(session.uid, pid);
        card.remove(); toast('Post deleted'); onDeleted?.();
      } else if (act === 'comments') {
        const box = card.querySelector('.comments');
        if (!box.hidden && !btn.dataset.reload) { box.hidden = true; return; }
        delete btn.dataset.reload;
        const { comments } = await api.comments(pid);
        box.hidden = false;
        box.innerHTML = `${comments.map((c) => `<div class="comment" data-comment="${esc(c.id)}" data-testid="comment"><a href="/social/profile/${encodeURIComponent(c.author.nickname)}" data-link><strong>@${esc(c.author.nickname)}</strong></a>${c.author.verified ? '<span class="verified-badge" title="Verified profile" aria-label="Verified">✓</span>' : ''}${badgeChips(c.author.badges)} <span class="faint">${relTime(c.created_time)}</span>${c.is_mine ? ' <button class="btn btn-sm btn-ghost btn-danger" data-act="del-comment">Delete</button>' : ` <button class="btn btn-sm btn-ghost" data-report-comment="${esc(c.id)}">Report</button>`}${c.body ? `<div data-testid="comment-body">${esc(c.body)}</div>` : ''}${stickerImg(c.sticker, 'comment-sticker')}</div>`).join('') || '<div class="faint">No replies yet.</div>'}
          ${session.user ? `<form class="inline-form mt-8" data-reply><label class="field"><span hidden>Reply</span><input name="body" placeholder="Write a reply" maxlength="300" data-testid="reply-input"></label><button class="btn btn-sm" type="submit">Reply</button></form><div class="reply-extras"><button class="btn btn-sm btn-ghost" type="button" data-sticker-btn="reply-${esc(pid)}" data-testid="reply-sticker" aria-label="Reply with a sticker">Sticker</button></div>` : ''}`;
        const f = box.querySelector('[data-reply]');
        const sendReply = async (b) => {
          await api.commentWith(session.uid, pid, b);
          const cnt = card.querySelector('[data-testid=comment-count]');
          cnt.textContent = Number(cnt.textContent) + 1;
          btn.dataset.reload = '1'; btn.click();
        };
        if (f) box.querySelector('[data-testid=reply-sticker]').onclick = (ev) => openStickerPicker(ev.currentTarget, (s) => sendReply({ body: f.body.value, sticker_id: s.id }).catch((ex) => toast(profileHint(ex), 'error')));
        if (f) f.onsubmit = async (ev) => {
          ev.preventDefault();
          try {
            await api.comment(session.uid, pid, f.body.value);
            const cnt = card.querySelector('[data-testid=comment-count]');
            cnt.textContent = Number(cnt.textContent) + 1;
            btn.dataset.reload = '1'; btn.click();
          } catch (ex) { toast(profileHint(ex), 'error'); }
        };
      } else if (act === 'del-comment') {
        const c = btn.closest('[data-comment]');
        await api.deleteComment(session.uid, pid, c.dataset.comment);
        const cnt = card.querySelector('[data-testid=comment-count]');
        cnt.textContent = Math.max(0, Number(cnt.textContent) - 1);
        c.remove();
      }
    } catch (ex) { toast(profileHint(ex), 'error'); }
  });
}
const profileHint = (ex) => (ex.code === 'social_profile_required' ? 'Pick a nickname in Account › Social profile first.' : ex.message);

// Composer used on the feed and on event pages.
export function composer(eventTicker) {
  if (!session.user) return '<div class="card composer"><a href="/sign-in?next=/social" data-link class="c-brand">Log in</a> to share your take.</div>';
  if (!session.nickname) return '<div class="card composer" data-testid="need-profile">Pick a nickname to post. <a href="/account/profile" data-link class="c-brand">Create your social profile</a></div>';
  return `<form class="card composer" id="composer" data-event="${esc(eventTicker || '')}">
    <div class="d-flex gap-10">${avatar(session.nickname)}<textarea name="body" maxlength="500" placeholder="${eventTicker ? "What's on your mind?" : 'What are you trading?'}" aria-label="New post" data-testid="composer-input"></textarea></div>
    ${composerExtrasHtml()}
    <div class="composer-foot"><span class="faint" id="composer-count">0 / 500</span><span class="flex-1"></span><button class="btn btn-primary btn-sm" type="submit" data-testid="composer-submit">Post</button></div></form>`;
}
export function wireComposer(root, onPosted) {
  const f = root.querySelector('#composer');
  if (!f) return;
  const ta = f.querySelector('textarea');
  const extras = wireComposerExtras(f); // sticker, "+ Add a position", audience (views/social2.js)
  ta.oninput = () => { f.querySelector('#composer-count').textContent = `${ta.value.length} / 500`; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!ta.value.trim() && !extras?.has()) return;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const { post } = await api.createPost(session.uid, { body: ta.value, event_ticker: f.dataset.event || undefined, ...(extras ? extras.get() : {}) });
      ta.value = ''; ta.oninput(); extras?.reset(); toast('Posted'); onPosted(post);
    } catch (ex) { toast(profileHint(ex), 'error'); } finally { btn.disabled = false; }
  };
}

export async function render({ el, params, navigate }) {
  if (params.tab === 'profile') return renderProfile({ el, nickname: params.nickname, navigate });
  if (params.tab === 'post') return renderPost({ el, id: params.id, navigate });
  document.title = 'Social · Parlance';
  const FEEDS = [['all', 'For you'], ['following', 'Following'], ['circle', 'Inner Circle'], ['topics', 'Topics'], ['bookmarks', 'Saved']];
  let feed = session.user ? (session.props.social_feed || 'all') : 'all';
  const lbTab = params.tab === 'leaderboard';
  el.innerHTML = `<div class="page-head"><h1 class="typ-title-x10">Social</h1><div class="seg"><a class="btn btn-sm ${lbTab ? 'btn-ghost' : ''}" href="/social" data-link>Feed</a><a class="btn btn-sm ${lbTab ? '' : 'btn-ghost'}" href="/social/leaderboard" data-link data-testid="lb-link">Leaderboard</a></div></div>
    <div class="social-layout"><div id="main-col"></div><aside id="side-col"></aside></div>`;
  const main = el.querySelector('#main-col');
  const side = el.querySelector('#side-col');

  async function drawLeaders(target, metric = 'pnl') {
    const { leaders } = await api.leaderboard(metric);
    target.innerHTML = `<div class="card side-card" data-testid="leaderboard"><div class="d-flex jc-between ai-center"><h3>Top traders</h3>
      <div class="seg"><button data-metric="pnl" class="${metric === 'pnl' ? 'on' : ''}">Profit</button><button data-metric="volume" class="${metric === 'volume' ? 'on' : ''}">Volume</button></div></div>
      ${leaders.map((l) => `<a class="rank-row rank-4" href="/social/profile/${encodeURIComponent(l.nickname)}" data-link><span class="faint">${esc(l.rank)}</span>${avatar(l.nickname)}<span class="t">@${esc(l.nickname)}</span><span class="num">${metric === 'pnl' ? money(l.value) : qty(l.value)}</span></a>`).join('') || '<p class="faint">No traders yet.</p>'}</div>`;
    for (const b of target.querySelectorAll('[data-metric]')) b.onclick = () => drawLeaders(target, b.dataset.metric);
  }

  if (lbTab) { document.title = 'Leaderboard · Parlance'; await drawLeaders(main); side.innerHTML = ''; return; }

  main.innerHTML = `${composer()}<div class="tabs" role="tablist">${FEEDS.map(([k, l]) => `<button data-feed="${k}" class="${k === feed ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="feed-top"></div><div class="card" id="posts"></div><div class="ta-c mt-12"><button class="btn" id="more-posts" hidden>Load more</button></div>`;
  let cursor = '';
  let loadSeq = 0; // guards against a slower earlier feed response overwriting a newer one
  const box = main.querySelector('#posts');
  const EMPTY = { following: 'Follow traders to see their posts here.', bookmarks: 'Saved posts appear here.', circle: 'Posts from your Inner Circle appear here.', topics: 'Follow events, markets or keywords to see posts about them here.' };
  async function load(append) {
    const seq = ++loadSeq;
    if (feed !== 'all' && !session.user) { box.innerHTML = '<div class="empty"><a href="/sign-in?next=/social" data-link class="c-brand">Log in</a> to see this feed.</div>'; return; }
    const r = await api.posts({ feed, cursor: append ? cursor : '' });
    if (seq !== loadSeq || !box.isConnected) return;
    cursor = r.cursor;
    const html = r.posts.map((p) => postCard(p)).join('');
    if (append) box.insertAdjacentHTML('beforeend', html);
    else box.innerHTML = html || `<div class="empty" data-testid="empty-feed">${esc(EMPTY[feed] || 'No posts yet.')}</div>`;
    main.querySelector('#more-posts').hidden = !cursor;
    box.dataset.feed = feed;
    if (!append) timeline?.reset();
  }
  const timeline = feed === 'bookmarks' ? null : startTimelineBadge({ host: main.querySelector('#feed-top'), feed: () => (feed === 'bookmarks' ? 'all' : feed), onShow: () => load(false) });
  wirePosts(box, { navigate });
  wireComposer(main, (post) => { if (feed === 'all') { box.querySelector('[data-testid=empty-feed]')?.remove(); box.insertAdjacentHTML('afterbegin', postCard(post)); } });
  for (const b of main.querySelectorAll('[data-feed]')) {
    b.onclick = () => {
      feed = b.dataset.feed;
      for (const x of main.querySelectorAll('[data-feed]')) x.classList.toggle('on', x === b);
      if (session.user) session.setProp('social_feed', feed).catch(() => {});
      load(false);
    };
  }
  main.querySelector('#more-posts').onclick = () => load(true);
  await load(false);
  side.innerHTML = `<div class="card side-card" data-testid="profile-search"><h3>Find traders</h3><label class="field"><span hidden>Search by nickname</span><input type="search" placeholder="Search nicknames" maxlength="20" autocomplete="off" data-testid="profile-search-input" aria-label="Search traders by nickname"></label><div data-results class="search-results"></div></div>
    ${session.user ? '<div class="card side-card social-links"><a href="/messages" data-link data-testid="link-messages">Group chats</a><a href="/social/circle" data-link data-testid="link-circle">Inner Circle</a><a href="/social/settings" data-link data-testid="link-social-settings">Muted traders &amp; topics</a><a href="/notifications/settings" data-link>Notification settings</a></div>' : ''}<div data-leaders></div>`;
  wireProfileSearch(side.querySelector('[data-testid=profile-search]'));
  await drawLeaders(side.querySelector('[data-leaders]'));
  return () => timeline?.stop();
}

// Nickname-prefix search (server rate-limited, never by email); results render as text.
function wireProfileSearch(card) {
  const input = card.querySelector('input');
  const out = card.querySelector('[data-results]');
  let t = null; let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value.trim().replace(/^@/, '');
      const mine = ++seq;
      if (!q) { out.replaceChildren(); return; }
      if (!/^[A-Za-z0-9_]{1,20}$/.test(q)) { out.replaceChildren(h('div', { class: 'faint' }, 'Nicknames use letters, digits and underscores.')); return; }
      try {
        const { profiles } = await api.searchProfiles(q);
        if (mine !== seq) return;
        out.replaceChildren(...(profiles.length ? profiles.map((p) => h('a', { class: 'rank-row rank-2', href: `/social/profile/${encodeURIComponent(p.nickname)}`, 'data-link': '', 'data-testid': 'profile-result' }, h('span', { class: 't' }, `@${p.nickname}`), h('span', { class: 'faint' }, `${p.followers} follower${p.followers === 1 ? '' : 's'}`))) : [h('div', { class: 'faint' }, 'No traders found.')]));
      } catch (ex) { if (mine === seq) out.replaceChildren(h('div', { class: 'form-error' }, ex.tooManyRequests ? 'Too many searches, try again in a moment.' : ex.message)); }
    }, 250);
  });
}

// Canonical post page (/social/post/:id): the post with its replies open; circle-only posts are 404 to others.
async function renderPost({ el, id, navigate }) {
  let post;
  try { ({ post } = await api.post(id)); } catch (e) {
    if (!e.notFound) throw e;
    document.title = 'Post not found · Parlance';
    el.innerHTML = '<div class="card empty center-50" data-testid="post-missing"><h1 class="typ-title-x20 m-0">This post isn’t available</h1><p class="muted m-0">It may have been deleted, or it is shared with an Inner Circle you are not part of.</p><a class="btn" href="/social" data-link>Back to Social</a></div>';
    return;
  }
  document.title = `@${post.author.nickname} on Parlance`;
  el.innerHTML = `<div class="social-layout"><div><div class="page-head"><a class="btn btn-sm btn-ghost" href="/social" data-link>← Social</a></div><div class="card" id="posts" data-testid="post-page">${postCard(post, { expanded: true })}</div></div><aside></aside></div>`;
  const box = el.querySelector('#posts');
  wirePosts(box, { navigate, onDeleted: () => navigate('/social') });
  box.querySelector('[data-act=comments]')?.click();
}

async function renderProfile({ el, nickname, navigate }) {
  const { profile: p } = await api.profile(nickname);
  document.title = `@${p.nickname} · Parlance`;
  el.innerHTML = `<div class="social-layout"><div>
      <section class="card profile-head" data-testid="profile">${authorAvatar(p, 'lg')}
        <div class="flex-1 minw-200"><h1 class="typ-title-x20 m-0">@${esc(p.nickname)}${p.verified ? '<span class="verified-badge" title="Verified profile" aria-label="Verified">✓</span>' : ''}</h1><div class="badge-row" data-testid="profile-badges">${badgeChips(p.badges)}</div><div class="muted">${esc(p.bio)}</div>
          <div class="profile-stats mt-8"><span><strong data-testid="followers">${esc(p.followers)}</strong> followers</span><span><strong>${esc(p.following)}</strong> following</span><span><strong>${esc(p.posts)}</strong> posts</span><span class="faint">Joined ${shortDate(p.joined_time)}</span></div></div>
        ${p.is_me ? '<div class="d-flex gap-8 fw-wrap"><a class="btn" href="/account/profile" data-link>Edit profile</a><a class="btn" href="/social/settings" data-link data-testid="profile-settings">Picture, mutes &amp; topics</a></div>' : `<div class="profile-actions"><button class="btn ${p.is_following ? '' : 'btn-primary'}" id="follow-btn" data-testid="follow-btn">${p.is_following ? 'Following' : 'Follow'}</button><div data-extra class="d-flex gap-8 fw-wrap"></div></div>`}
      </section>
      <div class="stat-row mt-8"><div class="card stat"><div class="label">Realized profit</div><div class="value">${money(p.metrics.realized_pnl_dollars)}</div></div><div class="card stat"><div class="label">Contracts traded</div><div class="value">${qty(p.metrics.volume_fp)}</div></div></div>
      <h2 class="section-title">Posts</h2><div class="card" id="posts"></div></div>
    <aside><div class="card side-card"><h3>Positions</h3><div id="holdings" class="faint">Loading…</div></div></aside></div>`;
  const fb = el.querySelector('#follow-btn');
  if (fb) wireProfileExtras(el.querySelector('[data-extra]'), p, navigate);
  if (fb) {
    let following = p.is_following;
    fb.onclick = async () => {
      if (!session.user) return navigate('/sign-in?next=' + encodeURIComponent(location.pathname));
      try {
        const r = following ? await api.unfollow(session.uid, p.nickname) : await api.follow(session.uid, p.nickname);
        following = r.profile.is_following;
        fb.textContent = following ? 'Following' : 'Follow';
        fb.classList.toggle('btn-primary', !following);
        el.querySelector('[data-testid=followers]').textContent = r.profile.followers;
        Object.assign(p, r.profile); wireProfileExtras(el.querySelector('[data-extra]'), p, navigate);
      } catch (ex) { toast(profileHint(ex), 'error'); }
    };
  }
  const box = el.querySelector('#posts');
  const r = await api.posts({ nickname: p.nickname });
  box.innerHTML = r.posts.map((x) => postCard(x)).join('') || '<div class="empty">No posts yet.</div>';
  wirePosts(box, { navigate });
  const h = await api.holdings(p.nickname);
  el.querySelector('#holdings').innerHTML = h.hidden ? 'This trader keeps positions private.' : h.holdings.map((x) => `<a class="rank-row rank-2" href="${esc(x.link)}" data-link><span><div class="t">${esc(x.event_title)}</div><div class="faint">${esc(x.outcome)} · ${esc(x.side.toUpperCase())}</div></span><span class="num">${qty(x.position_fp)}</span></a>`).join('') || 'No open positions.';
}

// Profile actions beyond Follow (PHASE2_SPEC.md §24): Inner Circle request / accept / remove, trade-alert bell (followers
// only), mute / unmute. State comes from the profile response (circle, trade_alerts, is_muted) and is re-drawn in place.
const CIRCLE_LABEL = { member: 'In your Inner Circle', requested: 'Circle request sent', incoming: 'Accept Inner Circle request' };
function wireProfileExtras(box, p, navigate) {
  if (!box) return;
  box.replaceChildren();
  if (!session.user) return;
  const btn = (label, testid, fn, cls = 'btn') => { const b = h('button', { class: cls, type: 'button', 'data-testid': testid }, label); b.onclick = async () => { b.disabled = true; try { await fn(); } catch (ex) { toast(profileHint(ex), 'error'); } finally { b.disabled = false; } }; box.append(b); return b; };
  const refresh = async () => { const { profile } = await api.profile(p.nickname); Object.assign(p, profile); wireProfileExtras(box, p, navigate); };
  btn(p.circle ? CIRCLE_LABEL[p.circle] : 'Add to Inner Circle', 'circle-btn', async () => {
    if (p.circle === 'member') { if (!confirm(`Remove @${p.nickname} from your Inner Circle?`)) return; await api.circleRemove(session.uid, p.nickname); toast('Removed from your Inner Circle'); }
    else if (p.circle === 'requested') { navigate('/social/circle'); return; }
    else { const r = await api.circleRequest(session.uid, p.nickname); toast(r.relation === 'member' ? `@${p.nickname} is now in your Inner Circle` : 'Inner Circle request sent'); }
    await refresh();
  });
  if (p.is_following) btn(p.trade_alerts ? 'Trade alerts on' : 'Trade alerts', 'trade-alerts-btn', async () => {
    if (p.trade_alerts) await api.removeAccountSub(session.uid, p.nickname); else await api.addAccountSub(session.uid, p.nickname);
    toast(p.trade_alerts ? 'Trade alerts off' : `You'll be notified when @${p.nickname} trades`);
    await refresh();
  }, `btn${p.trade_alerts ? ' on' : ''}`);
  btn(p.is_muted ? 'Unmute' : 'Mute', 'profile-mute', async () => { await toggleMute(p.nickname, !p.is_muted); await refresh(); }, 'btn btn-ghost');
}
