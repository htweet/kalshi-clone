// Social (spec §13.6): feed (All / Following / Saved) with composer, likes, replies, bookmarks;
// leaderboard; public profiles with follow, stats and shared holdings.
import { t as tx, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/social-strings.js';
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
        toast(post.bookmarked ? tx('social.wire_posts.saved') : tx('social.wire_posts.removed_from_saved'));
      } else if (act === 'delete') {
        if (!confirm(tx('social.wire_posts.delete_this_post'))) return;
        await api.deletePost(session.uid, pid);
        card.remove(); toast(tx('social.wire_posts.post_deleted')); onDeleted?.();
      } else if (act === 'comments') {
        const box = card.querySelector('.comments');
        if (!box.hidden && !btn.dataset.reload) { box.hidden = true; return; }
        delete btn.dataset.reload;
        const { comments } = await api.comments(pid);
        box.hidden = false;
        box.innerHTML = `${comments.map((c) => `<div class="comment" data-comment="${esc(c.id)}" data-testid="comment"><a href="/social/profile/${encodeURIComponent(c.author.nickname)}" data-link><strong>@${esc(c.author.nickname)}</strong></a>${c.author.verified ? `<span class="verified-badge" title="${te('social.wire_posts.verified_profile')}" aria-label="${te('social.wire_posts.verified')}">✓</span>` : ''}${badgeChips(c.author.badges)} <span class="faint">${relTime(c.created_time)}</span>${c.is_mine ? ` <button class="btn btn-sm btn-ghost btn-danger" data-act="del-comment">${te('social.wire_posts.delete')}</button>` : ` <button class="btn btn-sm btn-ghost" data-report-comment="${esc(c.id)}">${te('social.wire_posts.report')}</button>`}${c.body ? `<div data-testid="comment-body">${esc(c.body)}</div>` : ''}${stickerImg(c.sticker, 'comment-sticker')}</div>`).join('') || `<div class="faint">${te('social.wire_posts.no_replies_yet')}</div>`}
          ${session.user ? `<form class="inline-form mt-8" data-reply><label class="field"><span hidden>${te('social.wire_posts.reply')}</span><input name="body" placeholder="${te('social.wire_posts.write_a_reply')}" maxlength="300" data-testid="reply-input"></label><button class="btn btn-sm" type="submit">${te('social.wire_posts.reply')}</button></form><div class="reply-extras"><button class="btn btn-sm btn-ghost" type="button" data-sticker-btn="reply-${esc(pid)}" data-testid="reply-sticker" aria-label="${te('social.wire_posts.reply_with_a_sticker')}">${te('social.wire_posts.sticker')}</button></div>` : ''}`;
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
const profileHint = (ex) => (ex.code === 'social_profile_required' ? tx('social.profile_hint.pick_a_nickname_in_account') : ex.message);

// Composer used on the feed and on event pages.
export function composer(eventTicker) {
  if (!session.user) return `<div class="card composer"><a href="/sign-in?next=/social" data-link class="c-brand">${te('social.composer.log_in')}</a> ${te('social.composer.to_share_your_take')}</div>`;
  if (!session.nickname) return `<div class="card composer" data-testid="need-profile">${te('social.composer.pick_a_nickname_to_post')} <a href="/account/profile" data-link class="c-brand">${te('social.composer.create_your_social_profile')}</a></div>`;
  return `<form class="card composer" id="composer" data-event="${esc(eventTicker || '')}">
    <div class="d-flex gap-12">${avatar(session.nickname)}<textarea name="body" maxlength="500" placeholder="${eventTicker ? te('social.composer.what_s_on_your_mind') : te('social.composer.what_are_you_trading')}" aria-label="${te('social.composer.new_post')}" data-testid="composer-input"></textarea></div>
    ${composerExtrasHtml()}
    <div class="composer-foot"><span class="faint" id="composer-count">0 / 500</span><span class="flex-1"></span><button class="btn btn-primary btn-sm" type="submit" data-testid="composer-submit">${te('social.composer.post')}</button></div></form>`;
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
      ta.value = ''; ta.oninput(); extras?.reset(); toast(tx('social.wire_composer.posted')); onPosted(post);
    } catch (ex) { toast(profileHint(ex), 'error'); } finally { btn.disabled = false; }
  };
}

export async function render({ el, params, navigate }) {
  if (params.tab === 'profile') return renderProfile({ el, nickname: params.nickname, navigate });
  if (params.tab === 'post') return renderPost({ el, id: params.id, navigate });
  document.title = tx('social.render.social_parlance');
  const FEEDS = [['all', tx('social.render.for_you')], ['following', tx('social.render.following')], ['circle', tx('social.render.inner_circle')], ['topics', tx('social.render.topics')], ['bookmarks', tx('social.render.saved')]];
  let feed = session.user ? (session.props.social_feed || 'all') : 'all';
  const lbTab = params.tab === 'leaderboard';
  el.innerHTML = `<div class="page-head"><h1 class="page-title">${te('social.render.social')}</h1><div class="seg"><a class="btn btn-sm ${lbTab ? 'btn-ghost' : ''}" href="/social" data-link>${te('social.render.feed')}</a><a class="btn btn-sm ${lbTab ? '' : 'btn-ghost'}" href="/social/leaderboard" data-link data-testid="lb-link">${te('social.render.leaderboard')}</a></div></div>
    <div class="social-layout"><div id="main-col"></div><aside id="side-col"></aside></div>`;
  const main = el.querySelector('#main-col');
  const side = el.querySelector('#side-col');

  async function drawLeaders(target, metric = 'pnl') {
    const { leaders } = await api.leaderboard(metric);
    target.innerHTML = `<div class="card side-card" data-testid="leaderboard"><div class="d-flex jc-between ai-center"><h3>${te('social.render.top_traders')}</h3>
      <div class="seg"><button data-metric="pnl" class="${metric === 'pnl' ? 'on' : ''}">${te('social.render.profit')}</button><button data-metric="volume" class="${metric === 'volume' ? 'on' : ''}">${te('social.render.volume')}</button></div></div>
      ${leaders.map((l) => `<a class="rank-row rank-4" href="/social/profile/${encodeURIComponent(l.nickname)}" data-link><span class="faint">${esc(l.rank)}</span>${avatar(l.nickname)}<span class="t">@${esc(l.nickname)}</span><span class="num">${metric === 'pnl' ? money(l.value) : qty(l.value)}</span></a>`).join('') || `<p class="faint">${te('social.render.no_traders_yet')}</p>`}</div>`;
    for (const b of target.querySelectorAll('[data-metric]')) b.onclick = () => drawLeaders(target, b.dataset.metric);
  }

  if (lbTab) { document.title = tx('social.render.leaderboard_parlance'); await drawLeaders(main); side.innerHTML = ''; return; }

  main.innerHTML = `${composer()}<div class="tabs" role="tablist">${FEEDS.map(([k, l]) => `<button data-feed="${esc(k)}" class="${k === feed ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
    <div id="feed-top"></div><div class="card" id="posts"></div><div class="ta-c mt-12"><button class="btn" id="more-posts" hidden>${te('social.render.load_more')}</button></div>`;
  let cursor = '';
  let loadSeq = 0; // guards against a slower earlier feed response overwriting a newer one
  const box = main.querySelector('#posts');
  const EMPTY = { following: tx('social.render.follow_traders_to_see_their'), bookmarks: tx('social.render.saved_posts_appear_here'), circle: tx('social.render.posts_from_your_inner_circle'), topics: tx('social.render.follow_events_markets_or_keywords') };
  async function load(append) {
    const seq = ++loadSeq;
    if (feed !== 'all' && !session.user) { box.innerHTML = `<div class="empty"><a href="/sign-in?next=/social" data-link class="c-brand">${te('social.render.log_in')}</a> ${te('social.render.to_see_this_feed')}</div>`; return; }
    const r = await api.posts({ feed, cursor: append ? cursor : '' });
    if (seq !== loadSeq || !box.isConnected) return;
    cursor = r.cursor;
    const html = r.posts.map((p) => postCard(p)).join('');
    if (append) box.insertAdjacentHTML('beforeend', html);
    else box.innerHTML = html || `<div class="empty" data-testid="empty-feed">${esc(EMPTY[feed] || tx('social.render.no_posts_yet'))}</div>`;
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
  side.innerHTML = `<div class="card side-card" data-testid="profile-search"><h3>${te('social.render.find_traders')}</h3><label class="field"><span hidden>${te('social.render.search_by_nickname')}</span><input type="search" placeholder="${te('social.render.search_nicknames')}" maxlength="20" autocomplete="off" data-testid="profile-search-input" aria-label="${te('social.render.search_traders_by_nickname')}"></label><div data-results class="search-results"></div></div>
    ${session.user ? `<div class="card side-card social-links"><a href="/messages" data-link data-testid="link-messages">${te('social.render.group_chats')}</a><a href="/social/circle" data-link data-testid="link-circle">${te('social.render.inner_circle')}</a><a href="/social/settings" data-link data-testid="link-social-settings">${te('social.render.muted_traders_topics')}</a><a href="/notifications/settings" data-link>${te('social.render.notification_settings')}</a></div>` : ''}<div data-leaders></div>`;
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
      if (!/^[A-Za-z0-9_]{1,20}$/.test(q)) { out.replaceChildren(h('div', { class: 'faint' }, tx('social.wire_profile_search.nicknames_use_letters_digits_and'))); return; }
      try {
        const { profiles } = await api.searchProfiles(q);
        if (mine !== seq) return;
        out.replaceChildren(...(profiles.length ? profiles.map((p) => h('a', { class: 'rank-row rank-2', href: `/social/profile/${encodeURIComponent(p.nickname)}`, 'data-link': '', 'data-testid': 'profile-result' }, h('span', { class: 't' }, `@${p.nickname}`), h('span', { class: 'faint' }, tx('social.wire_profile_search.follower', { followers: p.followers, value: p.followers === 1 ? '' : 's' })))) : [h('div', { class: 'faint' }, tx('social.wire_profile_search.no_traders_found'))]));
      } catch (ex) { if (mine === seq) out.replaceChildren(h('div', { class: 'form-error' }, ex.tooManyRequests ? tx('social.wire_profile_search.too_many_searches_try_again') : ex.message)); }
    }, 250);
  });
}

// Canonical post page (/social/post/:id): the post with its replies open; circle-only posts are 404 to others.
async function renderPost({ el, id, navigate }) {
  let post;
  try { ({ post } = await api.post(id)); } catch (e) {
    if (!e.notFound) throw e;
    document.title = tx('social.render_post.post_not_found_parlance');
    el.innerHTML = `<div class="card empty center-50" data-testid="post-missing"><h1 class="typ-title-x20 m-0">${te('social.render_post.this_post_isn_t_available')}</h1><p class="muted m-0">${te('social.render_post.it_may_have_been_deleted')}</p><a class="btn" href="/social" data-link>${te('social.render_post.back_to_social')}</a></div>`;
    return;
  }
  document.title = tx('social.render_post.on_parlance', { nickname: post.author.nickname });
  el.innerHTML = `<div class="social-layout"><div><div class="page-head"><a class="btn btn-sm btn-ghost" href="/social" data-link>${te('social.render_post.social')}</a></div><div class="card" id="posts" data-testid="post-page">${postCard(post, { expanded: true })}</div></div><aside></aside></div>`;
  const box = el.querySelector('#posts');
  wirePosts(box, { navigate, onDeleted: () => navigate('/social') });
  box.querySelector('[data-act=comments]')?.click();
}

async function renderProfile({ el, nickname, navigate }) {
  const { profile: p } = await api.profile(nickname);
  document.title = tx('social.render_profile.parlance', { nickname: p.nickname });
  el.innerHTML = `<div class="social-layout"><div>
      <section class="card profile-head" data-testid="profile">${authorAvatar(p, 'lg')}
        <div class="flex-1 minw-200"><h1 class="typ-title-x20 m-0">@${esc(p.nickname)}${p.verified ? `<span class="verified-badge" title="${te('social.render_profile.verified_profile')}" aria-label="${te('social.render_profile.verified')}">✓</span>` : ''}</h1><div class="badge-row" data-testid="profile-badges">${badgeChips(p.badges)}</div><div class="muted">${esc(p.bio)}</div>
          <div class="profile-stats mt-8"><span><strong data-testid="followers">${esc(p.followers)}</strong> ${te('social.render_profile.followers')}</span><span><strong>${esc(p.following)}</strong> ${te('social.render_profile.following')}</span><span><strong>${esc(p.posts)}</strong> ${te('social.render_profile.posts')}</span><span class="faint">${te('social.render_profile.joined', { short_date: shortDate(p.joined_time) })}</span></div></div>
        ${p.is_me ? `<div class="d-flex gap-8 fw-wrap"><a class="btn" href="/account/profile" data-link>${te('social.render_profile.edit_profile')}</a><a class="btn" href="/social/settings" data-link data-testid="profile-settings">${te('social.render_profile.picture_mutes_topics')}</a></div>` : `<div class="profile-actions"><button class="btn ${p.is_following ? '' : 'btn-primary'}" id="follow-btn" data-testid="follow-btn">${p.is_following ? te('social.render_profile.following_2') : te('social.render_profile.follow')}</button><div data-extra class="d-flex gap-8 fw-wrap"></div></div>`}
      </section>
      <div class="stat-row mt-8"><div class="card stat"><div class="label">${te('social.render_profile.realized_profit')}</div><div class="value">${money(p.metrics.realized_pnl_dollars)}</div></div><div class="card stat"><div class="label">${te('social.render_profile.contracts_traded')}</div><div class="value">${qty(p.metrics.volume_fp)}</div></div></div>
      <h2 class="section-title">${te('social.render_profile.posts_2')}</h2><div class="card" id="posts"></div></div>
    <aside><div class="card side-card"><h3>${te('social.render_profile.positions')}</h3><div id="holdings" class="faint">${te('social.render_profile.loading')}</div></div></aside></div>`;
  const fb = el.querySelector('#follow-btn');
  if (fb) wireProfileExtras(el.querySelector('[data-extra]'), p, navigate);
  if (fb) {
    let following = p.is_following;
    fb.onclick = async () => {
      if (!session.user) return navigate('/sign-in?next=' + encodeURIComponent(location.pathname));
      try {
        const r = following ? await api.unfollow(session.uid, p.nickname) : await api.follow(session.uid, p.nickname);
        following = r.profile.is_following;
        fb.textContent = following ? tx('social.render_profile.following_2') : tx('social.render_profile.follow');
        fb.classList.toggle('btn-primary', !following);
        el.querySelector('[data-testid=followers]').textContent = r.profile.followers;
        Object.assign(p, r.profile); wireProfileExtras(el.querySelector('[data-extra]'), p, navigate);
      } catch (ex) { toast(profileHint(ex), 'error'); }
    };
  }
  const box = el.querySelector('#posts');
  const r = await api.posts({ nickname: p.nickname });
  box.innerHTML = r.posts.map((x) => postCard(x)).join('') || `<div class="empty">${te('social.render_profile.no_posts_yet')}</div>`;
  wirePosts(box, { navigate });
  const h = await api.holdings(p.nickname);
  el.querySelector('#holdings').innerHTML = h.hidden ? te('social.render_profile.this_trader_keeps_positions_private') : h.holdings.map((x) => `<a class="rank-row rank-2" href="${esc(x.link)}" data-link><span><div class="t">${esc(x.event_title)}</div><div class="faint">${esc(x.outcome)} · ${esc(x.side.toUpperCase())}</div></span><span class="num">${qty(x.position_fp)}</span></a>`).join('') || te('social.render_profile.no_open_positions');
}

// Profile actions beyond Follow (CLONE_SPEC.md §24): Inner Circle request / accept / remove, trade-alert bell (followers
// only), mute / unmute. State comes from the profile response (circle, trade_alerts, is_muted) and is re-drawn in place.
const CIRCLE_LABEL = { member: ts('social.circle_label_member.in_your_inner_circle'), requested: ts('social.circle_label_requested.circle_request_sent'), incoming: ts('social.circle_label_incoming.accept_inner_circle_request') };
function wireProfileExtras(box, p, navigate) {
  if (!box) return;
  box.replaceChildren();
  if (!session.user) return;
  const btn = (label, testid, fn, cls = 'btn') => { const b = h('button', { class: cls, type: 'button', 'data-testid': testid }, label); b.onclick = async () => { b.disabled = true; try { await fn(); } catch (ex) { toast(profileHint(ex), 'error'); } finally { b.disabled = false; } }; box.append(b); return b; };
  const refresh = async () => { const { profile } = await api.profile(p.nickname); Object.assign(p, profile); wireProfileExtras(box, p, navigate); };
  btn(p.circle ? CIRCLE_LABEL[p.circle] : tx('social.wire_profile_extras.add_to_inner_circle'), 'circle-btn', async () => {
    if (p.circle === 'member') { if (!confirm(tx('social.wire_profile_extras.remove_from_your_inner_circle', { nickname: p.nickname }))) return; await api.circleRemove(session.uid, p.nickname); toast(tx('social.wire_profile_extras.removed_from_your_inner_circle')); }
    else if (p.circle === 'requested') { navigate('/social/circle'); return; }
    else { const r = await api.circleRequest(session.uid, p.nickname); toast(r.relation === 'member' ? tx('social.wire_profile_extras.is_now_in_your_inner', { nickname: p.nickname }) : tx('social.wire_profile_extras.inner_circle_request_sent')); }
    await refresh();
  });
  if (p.is_following) btn(p.trade_alerts ? tx('social.wire_profile_extras.trade_alerts_on') : tx('social.wire_profile_extras.trade_alerts'), 'trade-alerts-btn', async () => {
    if (p.trade_alerts) await api.removeAccountSub(session.uid, p.nickname); else await api.addAccountSub(session.uid, p.nickname);
    toast(p.trade_alerts ? tx('social.wire_profile_extras.trade_alerts_off') : tx('social.wire_profile_extras.you_ll_be_notified_when', { nickname: p.nickname }));
    await refresh();
  }, `btn${p.trade_alerts ? ' on' : ''}`);
  btn(p.is_muted ? tx('social.wire_profile_extras.unmute') : tx('social.wire_profile_extras.mute'), 'profile-mute', async () => { await toggleMute(p.nickname, !p.is_muted); await refresh(); }, 'btn btn-ghost');
}
