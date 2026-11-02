// Social (spec §13.6): feed (All / Following / Saved) with composer, likes, replies, bookmarks;
// leaderboard; public profiles with follow, stats and shared holdings.
import { api } from '../api.js';
import { session } from '../store.js';
import { esc, avatar, money, qty, relTime, toast, shortDate } from '../lib.js';
import { postCard } from './components.js';

// Wire like / reply / bookmark / delete on every post inside `root`. Used by the feed, profiles and event pages.
export function wirePosts(root, { navigate, onDeleted } = {}) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('[data-post]');
    if (!btn || !card || !root.contains(card)) return;
    const pid = card.dataset.post;
    const act = btn.dataset.act;
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
        box.innerHTML = `${comments.map((c) => `<div class="comment" data-comment="${esc(c.id)}"><a href="/social/profile/${encodeURIComponent(c.author.nickname)}" data-link><strong>@${esc(c.author.nickname)}</strong></a> <span class="faint">${relTime(c.created_time)}</span>${c.is_mine ? ' <button class="btn btn-sm btn-ghost btn-danger" data-act="del-comment">Delete</button>' : ''}<div>${esc(c.body)}</div></div>`).join('') || '<div class="faint">No replies yet.</div>'}
          ${session.user ? `<form class="inline-form" data-reply style="margin-top:8px"><label class="field"><span hidden>Reply</span><input name="body" placeholder="Write a reply" maxlength="300" data-testid="reply-input"></label><button class="btn btn-sm" type="submit">Reply</button></form>` : ''}`;
        const f = box.querySelector('[data-reply]');
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
  if (!session.user) return '<div class="card composer"><a href="/sign-in?next=/social" data-link style="color:var(--brand)">Log in</a> to share your take.</div>';
  if (!session.nickname) return '<div class="card composer" data-testid="need-profile">Pick a nickname to post. <a href="/account/profile" data-link style="color:var(--brand)">Create your social profile</a></div>';
  return `<form class="card composer" id="composer" data-event="${esc(eventTicker || '')}">
    <div style="display:flex;gap:10px">${avatar(session.nickname)}<textarea name="body" maxlength="500" placeholder="${eventTicker ? 'Share your view on this market' : 'What are you trading?'}" aria-label="New post" data-testid="composer-input"></textarea></div>
    <div class="composer-foot"><span class="faint" id="composer-count">0 / 500</span><span style="flex:1"></span><button class="btn btn-primary btn-sm" type="submit" data-testid="composer-submit">Post</button></div></form>`;
}
export function wireComposer(root, onPosted) {
  const f = root.querySelector('#composer');
  if (!f) return;
  const ta = f.querySelector('textarea');
  ta.oninput = () => { f.querySelector('#composer-count').textContent = `${ta.value.length} / 500`; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!ta.value.trim()) return;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const { post } = await api.createPost(session.uid, { body: ta.value, event_ticker: f.dataset.event || undefined });
      ta.value = ''; ta.oninput(); toast('Posted'); onPosted(post);
    } catch (ex) { toast(profileHint(ex), 'error'); } finally { btn.disabled = false; }
  };
}

export async function render({ el, params, navigate }) {
  if (params.tab === 'profile') return renderProfile({ el, nickname: params.nickname, navigate });
  document.title = 'Social · Parlance';
  const FEEDS = [['all', 'For you'], ['following', 'Following'], ['bookmarks', 'Saved']];
  let feed = session.user ? (session.props.social_feed || 'all') : 'all';
  const lbTab = params.tab === 'leaderboard';
  el.innerHTML = `<div class="page-head"><h1 class="typ-title-x10">Social</h1><div class="seg"><a class="btn btn-sm ${lbTab ? 'btn-ghost' : ''}" href="/social" data-link>Feed</a><a class="btn btn-sm ${lbTab ? '' : 'btn-ghost'}" href="/social/leaderboard" data-link data-testid="lb-link">Leaderboard</a></div></div>
    <div class="social-layout"><div id="main-col"></div><aside id="side-col"></aside></div>`;
  const main = el.querySelector('#main-col');
  const side = el.querySelector('#side-col');

  async function drawLeaders(target, metric = 'pnl') {
    const { leaders } = await api.leaderboard(metric);
    target.innerHTML = `<div class="card side-card" data-testid="leaderboard"><div style="display:flex;justify-content:space-between;align-items:center"><h3>Top traders</h3>
      <div class="seg"><button data-metric="pnl" class="${metric === 'pnl' ? 'on' : ''}">Profit</button><button data-metric="volume" class="${metric === 'volume' ? 'on' : ''}">Volume</button></div></div>
      ${leaders.map((l) => `<a class="rank-row" href="/social/profile/${encodeURIComponent(l.nickname)}" data-link style="grid-template-columns:22px 32px 1fr auto;align-items:center"><span class="faint">${l.rank}</span>${avatar(l.nickname)}<span class="t">@${esc(l.nickname)}</span><span class="num">${metric === 'pnl' ? money(l.value) : qty(l.value)}</span></a>`).join('') || '<p class="faint">No traders yet.</p>'}</div>`;
    for (const b of target.querySelectorAll('[data-metric]')) b.onclick = () => drawLeaders(target, b.dataset.metric);
  }

  if (lbTab) { document.title = 'Leaderboard · Parlance'; await drawLeaders(main); side.innerHTML = ''; return; }

  main.innerHTML = `${composer()}<div class="tabs" role="tablist">${FEEDS.map(([k, l]) => `<button data-feed="${k}" class="${k === feed ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="card" id="posts"></div><div style="text-align:center;margin-top:12px"><button class="btn" id="more-posts" hidden>Load more</button></div>`;
  let cursor = '';
  const box = main.querySelector('#posts');
  async function load(append) {
    if (feed !== 'all' && !session.user) { box.innerHTML = '<div class="empty"><a href="/sign-in?next=/social" data-link style="color:var(--brand)">Log in</a> to see this feed.</div>'; return; }
    const r = await api.posts({ feed, cursor: append ? cursor : '' });
    cursor = r.cursor;
    const html = r.posts.map((p) => postCard(p)).join('');
    if (append) box.insertAdjacentHTML('beforeend', html);
    else box.innerHTML = html || `<div class="empty" data-testid="empty-feed">${feed === 'following' ? 'Follow traders to see their posts here.' : feed === 'bookmarks' ? 'Saved posts appear here.' : 'No posts yet.'}</div>`;
    main.querySelector('#more-posts').hidden = !cursor;
  }
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
  await drawLeaders(side);
}

async function renderProfile({ el, nickname, navigate }) {
  const { profile: p } = await api.profile(nickname);
  document.title = `@${p.nickname} · Parlance`;
  el.innerHTML = `<div class="social-layout"><div>
      <section class="card profile-head" data-testid="profile">${avatar(p.nickname, 'lg')}
        <div style="flex:1;min-width:200px"><h1 class="typ-title-x20" style="margin:0">@${esc(p.nickname)}</h1><div class="muted">${esc(p.bio)}</div>
          <div class="profile-stats" style="margin-top:8px"><span><strong data-testid="followers">${p.followers}</strong> followers</span><span><strong>${p.following}</strong> following</span><span><strong>${p.posts}</strong> posts</span><span class="faint">Joined ${shortDate(p.joined_time)}</span></div></div>
        ${p.is_me ? '<a class="btn" href="/account/profile" data-link>Edit profile</a>' : `<button class="btn ${p.is_following ? '' : 'btn-primary'}" id="follow-btn" data-testid="follow-btn">${p.is_following ? 'Following' : 'Follow'}</button>`}
      </section>
      <div class="stat-row" style="margin-top:8px"><div class="card stat"><div class="label">Realized profit</div><div class="value">${money(p.metrics.realized_pnl_dollars)}</div></div><div class="card stat"><div class="label">Contracts traded</div><div class="value">${qty(p.metrics.volume_fp)}</div></div></div>
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
  const box = el.querySelector('#posts');
  const r = await api.posts({ nickname: p.nickname });
  box.innerHTML = r.posts.map((x) => postCard(x)).join('') || '<div class="empty">No posts yet.</div>';
  wirePosts(box, { navigate });
  const h = await api.holdings(p.nickname);
  el.querySelector('#holdings').innerHTML = h.hidden ? 'This trader keeps positions private.' : h.holdings.map((x) => `<a class="rank-row" href="${esc(x.link)}" data-link style="grid-template-columns:1fr auto"><span><div class="t">${esc(x.event_title)}</div><div class="faint">${esc(x.outcome)} · ${x.side.toUpperCase()}</div></span><span class="num">${qty(x.position_fp)}</span></a>`).join('') || 'No open positions.';
}
