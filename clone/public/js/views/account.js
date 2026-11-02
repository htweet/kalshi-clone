// Account & security (spec §13.6–13.9): social profile, two-factor login, account limits, price alerts, appearance.
import { api } from '../api.js';
import { session } from '../store.js';
import { esc, money, toast, relTime } from '../lib.js';

const SECTIONS = [['profile', 'Social profile'], ['security', 'Two-factor login'], ['limits', 'Account limits'], ['alerts', 'Price alerts'], ['appearance', 'Appearance']];

export async function render({ el, params, navigate }) {
  if (!session.user) { navigate('/sign-in?next=' + encodeURIComponent(location.pathname), { replace: true }); return; }
  const section = SECTIONS.some(([k]) => k === params.section) ? params.section : 'profile';
  document.title = 'Account · Parlance';
  el.innerHTML = `<div class="page-head"><h1 class="typ-title-x10">Account</h1></div>
    <div class="account-layout"><nav class="side-nav">${SECTIONS.map(([k, l]) => `<a href="/account/${k}" data-link class="${k === section ? 'on' : ''}">${l}</a>`).join('')}</nav><div id="panel"></div></div>`;
  const panel = el.querySelector('#panel');
  await ({ profile, security, limits, alerts, appearance })[section](panel);
}

async function profile(panel) {
  const { profile: p } = await api.myProfile(session.uid);
  panel.innerHTML = `<form class="card panel" id="profile-form"><h2>Social profile</h2><p class="muted">Your nickname appears on posts, replies, the leaderboard and (if you allow it) next to your trades.</p>
    <label class="field">Nickname<input name="nickname" value="${esc(p?.nickname || '')}" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" required data-testid="nickname-input"></label>
    <label class="field">Bio<textarea name="bio" maxlength="280">${esc(p?.bio || '')}</textarea></label>
    <label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" name="share_trades" ${!p || p.share_trades ? 'checked' : ''}> Show my nickname on my trades and positions</label>
    <div class="form-error" id="p-error" role="alert"></div>
    <button class="btn btn-primary" type="submit">${p ? 'Save' : 'Create profile'}</button>
    ${p ? ` <a class="btn btn-ghost" href="/social/profile/${encodeURIComponent(p.nickname)}" data-link>View profile</a>` : ''}</form>`;
  const f = panel.querySelector('#profile-form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    f.querySelector('#p-error').textContent = '';
    try {
      const r = await api.saveProfile(session.uid, { nickname: f.nickname.value.trim(), bio: f.bio.value, share_trades: f.share_trades.checked });
      session.nickname = r.profile.nickname; session.notify();
      toast('Profile saved');
      await profile(panel);
    } catch (ex) { f.querySelector('#p-error').textContent = ex.message; }
  };
}

async function security(panel) {
  const { enabled } = await api.mfa(session.uid);
  panel.innerHTML = `<section class="card panel" data-testid="mfa-panel"><h2>Two-factor login</h2>
    <p class="muted">Ask for a 6-digit code from an authenticator app every time you log in.</p>
    <p>Status: <strong data-testid="mfa-status">${enabled ? 'On' : 'Off'}</strong></p><div id="mfa-body"></div></section>`;
  const body = panel.querySelector('#mfa-body');
  const codeForm = (label, onCode) => {
    body.insertAdjacentHTML('beforeend', `<form class="inline-form" id="mfa-form"><label class="field">6-digit code<input name="code" inputmode="numeric" maxlength="6" required data-testid="mfa-input"></label><button class="btn btn-primary" type="submit">${label}</button></form><div class="form-error" id="mfa-error" role="alert"></div>`);
    const f = body.querySelector('#mfa-form');
    f.onsubmit = async (e) => { e.preventDefault(); try { await onCode(f.code.value.trim()); } catch (ex) { body.querySelector('#mfa-error').textContent = ex.message; } };
  };
  if (enabled) {
    codeForm('Turn off', async (code) => { await api.mfaDisable(session.uid, code); toast('Two-factor login turned off'); security(panel); });
  } else {
    body.innerHTML = '<button class="btn btn-primary" id="mfa-start">Set up two-factor login</button>';
    body.querySelector('#mfa-start').onclick = async () => {
      const s = await api.mfaSetup(session.uid);
      body.innerHTML = `<p>1. Add this key to your authenticator app (or open the setup link on your phone):</p>
        <div class="code" data-testid="mfa-secret">${esc(s.secret)}</div><p class="faint" style="margin-top:6px"><a href="${esc(s.otpauth_url)}" style="color:var(--brand)">Open setup link</a></p><p>2. Enter the code it shows:</p>`;
      codeForm('Turn on', async (code) => { await api.mfaEnable(session.uid, code); toast('Two-factor login is on'); security(panel); });
    };
  }
}

async function limits(panel) {
  const [d, t, s] = await Promise.all(['deposit', 'trading', 'session'].map((k) => api.limit(session.uid, k)));
  const pend = (l, unit) => (l.pending ? `<div class="faint" data-testid="pending">Change to ${l.pending[unit] == null ? 'no limit' : unit === 'limit_minutes' ? l.pending[unit] + ' min' : money(l.pending[unit])} takes effect ${new Date(l.pending.effective_time).toLocaleString()} (24-hour cooling-off for loosening a limit).</div>` : '');
  const box = (kind, title, l, unit, used, hint) => `<form class="card panel" data-limit="${kind}" data-testid="limit-${kind}"><h2>${title}</h2><p class="muted">${hint}</p>
    <p>Current: <strong data-testid="limit-value">${l.limit[unit] == null ? 'No limit' : unit === 'limit_minutes' ? l.limit[unit] + ' minutes per day' : money(l.limit[unit]) + ' per day'}</strong> · <span class="faint">Used today: ${used}</span></p>${pend(l.limit, unit)}
    <div class="inline-form"><label class="field">${unit === 'limit_minutes' ? 'Minutes per day' : 'Dollars per day'}<input name="v" type="number" min="1" step="${unit === 'limit_minutes' ? 1 : 0.01}" placeholder="No limit"></label>
    <button class="btn btn-primary" type="submit">Set limit</button><button class="btn" type="button" data-remove>Remove limit</button></div><div class="form-error" role="alert"></div></form>`;
  panel.innerHTML = box('deposit', 'Deposit limit', d, 'limit_dollars', money(d.limit.used_today_dollars), 'Caps how much you can deposit per day (UTC).')
    + box('trading', 'Trading limit', t, 'limit_dollars', money(t.limit.used_today_dollars), 'Caps the total cost of orders you can place per day (UTC).')
    + box('session', 'Daily session time', s, 'limit_minutes', `${Math.floor(s.limit.used_today_seconds / 60)} min`, 'Locks trading and browsing in your account after this much active time per day.');
  for (const f of panel.querySelectorAll('[data-limit]')) {
    const kind = f.dataset.limit;
    const key = kind === 'session' ? 'limit_minutes' : 'limit_dollars';
    const save = async (v) => {
      try { await api.setLimit(session.uid, kind, { [key]: v }); toast('Limit updated'); limits(panel); } catch (ex) { f.querySelector('.form-error').textContent = ex.message; }
    };
    f.onsubmit = (e) => { e.preventDefault(); if (f.v.value) save(Number(f.v.value)); };
    f.querySelector('[data-remove]').onclick = () => save(null);
  }
}

async function alerts(panel) {
  const { price_targets: list } = await api.priceTargets(session.uid);
  panel.innerHTML = `<section class="card panel" data-testid="alerts-panel"><h2>Price alerts</h2><p class="muted">Create alerts from any market page. You get a notification when the Yes price crosses your level.</p>
    <table class="table"><thead><tr><th>Market</th><th>When Yes is</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map((t) => `<tr data-alert="${esc(t.id)}"><td>${esc(t.market_title)}</td><td>${t.direction} ${Math.round(Number(t.price_dollars) * 100)}¢</td><td>${t.triggered_time ? `Triggered ${relTime(t.triggered_time)}` : 'Active'}</td><td><button class="btn btn-sm" data-del>Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="faint">No price alerts yet.</td></tr>'}</tbody></table></section>`;
  for (const b of panel.querySelectorAll('[data-del]')) b.onclick = async () => { await api.deletePriceTarget(session.uid, b.closest('[data-alert]').dataset.alert); toast('Alert deleted'); alerts(panel); };
}

async function appearance(panel) {
  const cur = document.documentElement.dataset.theme;
  panel.innerHTML = `<section class="card panel"><h2>Appearance</h2><p class="muted">Saved to your account and applied on every device.</p>
    <div class="seg"><button data-theme-set="light" class="${cur === 'light' ? 'on' : ''}">Light</button><button data-theme-set="dark" class="${cur === 'dark' ? 'on' : ''}">Dark</button></div></section>`;
  for (const b of panel.querySelectorAll('[data-theme-set]')) b.onclick = async () => { await session.setProp('theme', b.dataset.themeSet); appearance(panel); };
}
