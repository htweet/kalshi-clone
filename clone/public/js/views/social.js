// Social (spec §13.6): feed (All / Following / Saved) with composer, likes, replies, bookmarks;
// leaderboard; public profiles with follow, stats and shared holdings.
import { api } from '../api.js';
import { session } from '../store.js';
import { esc, money, qty, toast, shortDate } from '../lib.js';
import { postCard, authorAvatar, badgeChips } from './components.js';
import { composerExtrasHtml, wireComposerExtras, commentHtml, openStickerPicker, sharePost, wireProfileSearch, timelineBadge, toggleMute } from './social2.js'; // Phase 2 (PHASE2_SPEC.md §24)

// Wire like / reply / bookmark / delete on every post inside `root`. Used by the feed, profiles and event pages.
export function wirePosts(root, { navigate, onDeleted } = {}) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('[data-post]');
    if (!btn || !card || !root.contains(card)) return;
    const pid = card.dataset.post;
    const act = btn.dataset.act;
    if (act === 'read-more') { const b = card.querySelector('[data-testid=post-body]'); const open = b.classList.toggle('clamp'); btn.textContent = open ? 'Read more' : 'Show less'; btn.setAttribute('aria-expanded', String(!open)); return; }
    if (act === 'share') { sharePost(card.dataset.share); return; }
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
        box.innerHTML = `${comments.map((c) => commentHtml(c)).join('') || '<div class="faint">No replies yet.</div>'}
          ${session.user ? `<form class="inline-form mt-8" data-reply><label class="field"><span hidden>Reply</span><input name="body" placeholder="Write a reply" maxlength="300" data-testid="reply-input"></label><button class="btn btn-sm btn-ghost" type="button" data-sticker-btn="reply-${esc(pid)}" data-testid="reply-sticker" aria-label="Reply with a sticker">Sticker</button><button class="btn btn-sm" type="submit">Reply</button></form>` : ''}`;
        const f = box.querySelector('[data-reply]');
        const sendReply = async (extra = {}) => {
          try {
            await api.commentWith(session.uid, pid, { body: f.body.value, ...extra });
            const cnt = card.querySelector('[data-testid=comment-count]');
            cnt.textContent = Number(cnt.textContent) + 1;
            btn.dataset.reload = '1'; btn.click();
          } catch (ex) { toast(profileHint(ex), 'error'); }
        };
        if (f) {
          f.onsubmit = (ev) => { ev.preventDefault(); sendReply(); };
          f.querySelector('[data-sticker-btn]').onclick = (ev) => openStickerPicker(ev.currentTarget, (s) => sendReply({ sticker_id: s.id }));
        }
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
    <div class="d-flex gap-10">${authorAvatar({ nickname: session.nickname })}<textarea name="body" maxlength="500" placeholder="${eventTicker ? "What's on your mind?" : 'What are you trading?'}" aria-label="New post" data-testid="composer-input"></textarea></div>
    ${composerExtrasHtml()}
    <div class="composer-foot"><span class="faint" id="composer-count">0 / 500</span><span class="flex-1"></span><button class="btn btn-primary btn-sm" type="submit" data-testid="composer-submit">Post</button></div></form>`;
}
export function wireComposer(root, onPosted) {
  const f = root.querySelector('#composer');
  if (!f) return;
  const ta = f.querySelector('textarea');
  const extras = wireComposerExtras(f); // sticker + "+ Add a position" (social2.js)
  ta.oninput = () => { f.querySelector('#composer-count').textContent = `${ta.value.length} / 500`; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!ta.value.trim() && !extras.has()) return;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const { post } = await api.createPost(session.uid, { body: ta.value, event_ticker: f.dataset.event || undefined, ...extras.get() });
      ta.value = ''; ta.oninput(); extras.reset(); toast('Posted'); onPosted(post);
    } catch (ex) { toast(ex.code === 'position_not_held' ? 'You can only tag a position you hold or have held.' : profileHint(ex), 'error'); } finally { btn.disabled = false; }
  };
}

export async function render({ el, params, navigate }) {
  if (params.tab === 'profile') return renderProfile({ el, nickname: params.nickname, navigate });
  document.title = 'Social · Parlance';
  const FEEDS = [['all', 'For you'], ['following', 'Following'], ['topics', 'Topics'], ['bookmarks', 'Saved']];
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
      ${leaders.map((l) => `<a class="rank-row rank-4" href="/social/profile/${encodeURIComponent(l.nickname)}" data-link><span class="faint">${esc(l.rank)}</span>${authorAvatar({ nickname: l.nickname })}<span class="t">@${esc(l.nickname)}</span><span class="num">${metric === 'pnl' ? money(l.value) : qty(l.value)}</span></a>`).join('') || '<p class="faint">No traders yet.</p>'}</div>`;
    for (const b of target.querySelectorAll('[data-metric]')) b.onclick = () => drawLeaders(target, b.dataset.metric);
  }

  if (lbTab) { document.title = 'Leaderboard · Parlance'; await drawLeaders(main); side.innerHTML = ''; return; }

  main.innerHTML = `${composer()}<div class="tabs" role="tablist">${FEEDS.map(([k, l]) => `<button data-feed="${k}" class="${k === feed ? 'on' : ''}" data-testid="feed-${k}">${l}</button>`).join('')}</div>
    <button class="new-posts-btn" type="button" id="new-posts" data-testid="new-posts" hidden></button>
    <div class="card" id="posts"></div><div class="ta-c mt-12"><button class="btn" id="more-posts" hidden>Load more</button></div>`;
  if (!FEEDS.some(([k]) => k === feed)) feed = 'all';
  let cursor = '';
  const box = main.querySelector('#posts');
  const badge = timelineBadge(main.querySelector('#new-posts'), { feed: feed === 'bookmarks' ? 'all' : feed, since: new Date().toISOString(), onShow: () => load(false) });
  async function load(append) {
    if (feed !== 'all' && !session.user) { box.innerHTML = '<div class="empty"><a href="/sign-in?next=/social" data-link class="c-brand">Log in</a> to see this feed.</div>'; return; }
    if (!append) badge.reset(new Date().toISOString());
    const r = await api.posts({ feed, cursor: append ? cursor : '' });
    cursor = r.cursor;
    const html = r.posts.map((p) => postCard(p)).join('');
    if (append) box.insertAdjacentHTML('beforeend', html);
    else box.innerHTML = html || `<div class="empty" data-testid="empty-feed">${feed === 'following' ? 'Follow traders to see their posts here.' : feed === 'bookmarks' ? 'Saved posts appear here.' : feed === 'topics' ? 'Follow events, markets or keywords to see posts about them here. <a href="/social/settings" data-link class="c-brand">Social settings</a>' : 'No posts yet.'}</div>`;
    main.querySelector('#more-posts').hidden = !cursor;
  }
  wirePosts(box, { navigate });
  wireComposer(main, (post) => { if (feed === 'all') { box.querySelector('[data-testid=empty-feed]')?.remove(); box.insertAdjacentHTML('afterbegin', postCard(post)); } });
  for (const b of main.querySelectorAll('[data-feed]')) {
    b.onclick = () => {
      feed = b.dataset.feed;
      badge.stop();
      Object.assign(badge, timelineBadge(main.querySelector('#new-posts'), { feed: feed === 'bookmarks' ? 'all' : feed, since: new Date().toISOString(), onShow: () => load(false) }));
      for (const x of main.querySelectorAll('[data-feed]')) x.classList.toggle('on', x === b);
      if (session.user) session.setProp('social_feed', feed).catch(() => {});
      load(false);
    };
  }
  main.querySelector('#more-posts').onclick = () => load(true);
  await load(false);
  side.innerHTML = `<form class="card side-card profile-search" role="search" data-testid="profile-search"><h3>Find traders</h3><label class="field"><span hidden>Search nicknames</span><input type="search" maxlength="21" placeholder="Search @nickname" autocomplete="off" data-testid="profile-search-input"></label><div data-results class="search-results"></div></form>
    ${session.user ? '<a class="faint d-block mb-8" href="/social/settings" data-link data-testid="social-settings-link">Social settings · muted traders · topics</a>' : ''}<div id="lb-box"></div>`;
  wireProfileSearch(side.querySelector('[data-testid=profile-search]'));
  await drawLeaders(side.querySelector('#lb-box'));
  return () => badge.stop();
}

async function renderProfile({ el, nickname, navigate }) {
  const { profile: p } = await api.profile(nickname);
  document.title = `@${p.nickname} · Parlance`;
  el.innerHTML = `<div class="social-layout"><div>
      <section class="card profile-head" data-testid="profile">${authorAvatar(p, 'lg')}
        <div class="flex-1 minw-200"><h1 class="typ-title-x20 m-0">@${esc(p.nickname)}${p.verified ? '<span class="verified-badge" title="Verified profile" aria-label="Verified">✓</span>' : ''}</h1><div class="muted">${esc(p.bio)}</div>
          <div class="profile-badges" data-testid="profile-badges">${badgeChips(p.badges)}</div>
          <div class="profile-stats mt-8"><span><strong data-testid="followers">${esc(p.followers)}</strong> followers</span><span><strong>${esc(p.following)}</strong> following</span><span><strong>${esc(p.posts)}</strong> posts</span><span class="faint">Joined ${shortDate(p.joined_time)}</span></div></div>
        ${p.is_me ? '<a class="btn" href="/account/profile" data-link>Edit profile</a><a class="btn btn-ghost" href="/social/settings" data-link>Social settings</a>' : `<button class="btn ${p.is_following ? '' : 'btn-primary'}" id="follow-btn" data-testid="follow-btn">${p.is_following ? 'Following' : 'Follow'}</button>${session.user ? `<button class="btn btn-ghost" id="mute-btn" data-testid="profile-mute" aria-pressed="${esc(!!p.is_muted)}">${p.is_muted ? 'Unmute' : 'Mute'}</button>` : ''}`}
      </section>
      <div class="stat-row mt-8"><div class="card stat"><div class="label">Realized profit</div><div class="value">${money(p.metrics.realized_pnl_dollars)}</div></div><div class="card stat"><div class="label">Contracts traded</div><div class="value">${qty(p.metrics.volume_fp)}</div></div></div>
      <h2 class="section-title">Posts</h2><div class="card" id="posts"></div></div>
    <aside><div class="card side-card"><h3>Positions</h3><div id="holdings" class="faint">Loading…</div></div></aside></div>`;
  const fb = el.querySelector('#follow-btn');
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
      } catch (ex) { toast(profileHint(ex), 'error'); }
    };
  }
  const mb = el.querySelector('#mute-btn');
  if (mb) mb.onclick = async () => { await toggleMute(p.nickname, !p.is_muted); p.is_muted = !p.is_muted; mb.textContent = p.is_muted ? 'Unmute' : 'Mute'; mb.setAttribute('aria-pressed', String(p.is_muted)); };
  const box = el.querySelector('#posts');
  const r = await api.posts({ nickname: p.nickname });
  box.innerHTML = r.posts.map((x) => postCard(x)).join('') || '<div class="empty">No posts yet.</div>';
  wirePosts(box, { navigate });
  const h = await api.holdings(p.nickname);
  el.querySelector('#holdings').innerHTML = h.hidden ? 'This trader keeps positions private.' : h.holdings.map((x) => `<a class="rank-row rank-2" href="${esc(x.link)}" data-link><span><div class="t">${esc(x.event_title)}</div><div class="faint">${esc(x.outcome)} · ${esc(x.side.toUpperCase())}</div></span><span class="num">${qty(x.position_fp)}</span></a>`).join('') || 'No open positions.';
}
