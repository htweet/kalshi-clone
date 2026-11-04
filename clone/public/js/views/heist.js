// Vault Heist (/heist, CLONE_SPEC.md §33): a Mastermind-style code-cracking game against the Central Bank vault, play
// money only. The server holds the code and judges every guess; this page shows the vault (live over the public
// `central_bank` channel), the crew's timer, alarm meter and tries, the result, the live heist feed and Most Wanted.
import { t as tx, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/heist-strings.js';
import { request } from '../api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { esc, money, toast, relTime, fmtTime } from '../lib.js';
import { vars } from '../dynstyle.js';
import { playLabel, playOn, flagOn } from '../flags.js';

const api = {
  bank: () => request('GET', '/v1/central_bank'),
  feed: () => request('GET', '/v1/central_bank/feed'),
  wanted: () => request('GET', '/v1/central_bank/most_wanted'),
  mine: () => request('GET', `/v1/users/${encodeURIComponent(session.uid)}/heists`),
  start: (clientId) => request('POST', `/v1/users/${encodeURIComponent(session.uid)}/heists`, { client_id: clientId }),
  guess: (id, guess, n) => request('POST', `/v1/users/${encodeURIComponent(session.uid)}/heists/${encodeURIComponent(id)}/guesses`, { guess, n }),
};
const newClientId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`).slice(0, 32);

function vaultDoor(level, max, state = 'idle') {
  const pips = Array.from({ length: Math.max(1, max) }, (_, i) => `<span class="hz-pip${i < level ? ' on' : ''}"></span>`).join('');
  return `<div class="hz-door ${esc(state)}" aria-hidden="true"><div class="hz-ring"><div class="hz-dial"><span class="hz-handle"></span><span class="hz-handle r90"></span><span class="hz-handle r45"></span><span class="hz-handle r135"></span></div></div><div class="hz-bolts">${'<span></span>'.repeat(8)}</div></div>
    <div class="hz-level"><span class="faint">${te('heist.vault.level')}</span><span class="hz-pips" data-testid="heist-level" data-level="${esc(level)}">${pips}</span></div>`;
}
// eslint-disable-next-line parlance/no-unescaped-html -- the repeated pieces are static markup; counts come from the server as numbers
const pegs = (g, digits) => `<span class="hz-pegs" aria-label="${te('heist.active.exact', { n: esc(g.exact) })}, ${te('heist.active.near', { n: esc(g.near) })}">${'<span class="hz-peg exact"></span>'.repeat(g.exact)}${'<span class="hz-peg near"></span>'.repeat(g.near)}${'<span class="hz-peg"></span>'.repeat(Math.max(0, digits - g.exact - g.near))}</span>`;
function feedRow(f) {
  const key = f.status === 'cracked' ? 'heist.feed.cracked' : f.status === 'caught' ? 'heist.feed.caught' : 'heist.feed.timeout';
  return `<li class="hz-feed-row ${esc(f.status)}" data-testid="heist-feed-row" data-status="${esc(f.status)}"><span class="hz-feed-ic" aria-hidden="true"></span><span>${te(key, { name: `<b>${esc(f.name)}</b>`, loot: esc(money(f.loot_dollars)) })}</span><span class="faint">${esc(relTime(f.time))}</span></li>`;
}

export async function render({ el }) {
  document.title = tx('heist.page.doc_title');
  el.innerHTML = `<div class="hz" data-testid="heist"><div class="hz-head"><div><div class="d-flex ai-center gap-8">${playLabel()}<h1 class="page-title m-0">${te('heist.page.title')}</h1></div><p class="muted m-0">${te('heist.page.tagline')}</p></div>
      <div class="hz-vault-stat card" data-testid="heist-vault-card"><span class="faint">${te('heist.vault.label')}</span><strong data-testid="heist-vault">—</strong></div></div>
    <div class="hz-layout"><section class="card hz-main" data-main></section><aside class="hz-side"><section class="card hz-feed"><h2>${te('heist.feed.title')}</h2><ul data-feed data-testid="heist-feed"></ul></section>
      <section class="card hz-wanted"><h2>${te('heist.wanted.title')}</h2><ol data-wanted data-testid="most-wanted"></ol></section></aside></div></div>`;
  const main = el.querySelector('[data-main]');
  const st = { bank: null, mine: null, timer: null, busy: false };
  const unsubs = [];
  const drawVault = (b) => { el.querySelector('[data-testid=heist-vault]').textContent = b.balance_dollars == null ? '—' : money(b.balance_dollars); };
  async function loadSide() {
    try {
      const [f, w] = await Promise.all([api.feed(), api.wanted()]);
      el.querySelector('[data-feed]').innerHTML = f.feed.length ? f.feed.map(feedRow).join('') : `<li class="faint">${te('heist.feed.empty')}</li>`;
      el.querySelector('[data-wanted]').innerHTML = w.most_wanted.length ? w.most_wanted.map((r) => `<li class="hz-wanted-row" data-testid="most-wanted-row"><span class="hz-rank">${esc(r.rank)}</span><b>${esc(r.name)}</b><span class="num">${esc(money(r.loot_dollars))}</span><span class="faint">${te('heist.wanted.row', { heists: esc(r.heists) })}</span></li>`).join('') : `<li class="faint">${te('heist.wanted.empty')}</li>`;
    } catch { /* side panels are optional */ }
  }
  function rules(b) {
    const h = b.heist;
    return `<details class="hz-rules" ${st.mine && st.mine.history.length ? '' : 'open'}><summary>${te('heist.rules.title')}</summary><ul>
      <li>${te('heist.rules.fee', { fee: esc(money(h.crew_fee_dollars)) })}</li><li>${te('heist.rules.code', { digits: esc(h.digits), guesses: esc(h.guesses), seconds: esc(h.timer_seconds) })}</li>
      <li>${te('heist.rules.feedback')}</li><li>${te('heist.rules.loot', { share: esc(h.max_share_pct), max: esc(money(h.max_loot_dollars)), day: esc(money(h.max_loot_user_day_dollars)) })}</li>
      <li>${te('heist.rules.jail', { minutes: esc(h.jail_minutes) })}</li><li>${te('heist.rules.level')}</li></ul></details>`;
  }
  function idle(last) {
    const b = st.bank; const m = st.mine;
    const left = m.attempts_per_day - m.attempts_today;
    const jailed = m.jail_until && Date.parse(m.jail_until) > Date.now();
    const result = last ? resultHtml(last) : '';
    main.innerHTML = `<div class="hz-stage">${vaultDoor(b.security_level, b.max_level, last ? (last.status === 'cracked' ? 'open' : 'alarm') : 'idle')}<div class="hz-panel">${result}
      ${jailed ? `<p class="hz-jail" data-testid="heist-jailed">${te('heist.start.jailed', { time: esc(fmtTime(m.jail_until)) })}</p>` : left <= 0 ? `<p class="hz-jail" data-testid="heist-no-attempts">${te('heist.start.no_attempts')}</p>`
        : `<button class="btn btn-primary hz-start" data-start data-testid="heist-start">${te('heist.start.button', { fee: esc(money(b.heist.crew_fee_dollars)) })}</button>`}
      <p class="faint" data-testid="heist-attempts">${te('heist.start.attempts', { left: esc(Math.max(0, left)), total: esc(m.attempts_per_day) })}</p><p class="form-error" role="alert" data-err data-testid="heist-error"></p>${rules(b)}</div></div>`;
    const s = main.querySelector('[data-start]');
    if (s) s.onclick = async () => {
      if (st.busy) return; st.busy = true; s.disabled = true;
      try { const r = await api.start(newClientId()); st.mine.active = r.heist; active(); } catch (ex) { main.querySelector('[data-err]').textContent = ex.message; s.disabled = false; } finally { st.busy = false; }
    };
  }
  function resultHtml(h) {
    const won = h.status === 'cracked';
    const title = won ? te('heist.result.won_title') : h.status === 'timeout' ? te('heist.result.timeout_title') : te('heist.result.lost_title');
    const body = won ? (Number(h.loot_dollars) > 0 ? te('heist.result.won_body', { loot: `<b data-testid="heist-loot">${esc(money(h.loot_dollars))}</b>` }) : te('heist.result.won_nothing', { loot: `<b data-testid="heist-loot">${esc(money(h.loot_dollars))}</b>` })) : te('heist.result.lost_body', { fee: esc(money(h.crew_fee_dollars)) });
    return `<div class="hz-result ${won ? 'won' : 'lost'}" data-testid="heist-result" data-status="${esc(h.status)}" role="status"><h2>${title}</h2><p>${body}</p>${h.code ? `<p class="faint">${te('heist.result.code')} <span class="hz-code" data-testid="heist-code">${[...h.code].map((c) => `<span>${esc(c)}</span>`).join('')}</span></p>` : ''}</div>`;
  }
  function active() {
    const h = st.mine.active; const b = st.bank;
    const boxes = Array.from({ length: h.digits }, (_, i) => `<input class="hz-digit" inputmode="numeric" maxlength="1" pattern="[0-9]" aria-label="${te('heist.active.digit', { n: i + 1 })}" data-digit="${i}" data-testid="heist-digit" autocomplete="off">`).join('');
    const hist = h.guesses.length ? h.guesses.slice().reverse().map((g) => `<li class="hz-try" data-testid="heist-try" data-exact="${esc(g.exact)}" data-near="${esc(g.near)}"><span class="hz-try-n">${esc(g.n)}</span><span class="hz-code">${[...g.guess].map((c) => `<span>${esc(c)}</span>`).join('')}</span>${pegs(g, h.digits)}</li>`).join('') : `<li class="faint">${te('heist.active.no_tries')}</li>`;
    const total = b.heist.timer_seconds; const pct = Math.max(0, Math.min(100, (h.seconds_left / total) * 100));
    main.innerHTML = `<div class="hz-stage">${vaultDoor(h.level, b.max_level, 'active')}<div class="hz-panel">
      <div class="hz-meters"><div class="hz-timer" data-testid="heist-timer"><div class="hz-timer-ring v-pct"${vars({ '--pct': `${pct}%` })}><span data-seconds>${te('heist.active.seconds', { seconds: esc(h.seconds_left) })}</span></div><span class="faint">${te('heist.active.time_left')}</span></div>
        <div class="hz-alarm"><span class="faint">${te('heist.active.alarm')}</span><div class="hz-alarm-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(h.alarm)}" data-testid="heist-alarm" data-alarm="${esc(h.alarm)}"><span class="v-w"${vars({ '--w': `${h.alarm}%` })}></span></div>
          <span class="faint" data-testid="heist-tries-left">${te('heist.active.tries_left', { left: esc(h.guesses_left) })}</span></div></div>
      <form class="hz-form" data-guess novalidate><div class="hz-digits">${boxes}</div><button class="btn btn-primary" type="submit" data-testid="heist-try-btn">${te('heist.active.try')}</button></form>
      <p class="form-error" role="alert" data-err data-testid="heist-error"></p>
      <h3>${te('heist.active.history')}</h3><ol class="hz-tries" data-testid="heist-tries">${hist}</ol></div></div>`;
    const inputs = [...main.querySelectorAll('.hz-digit')];
    inputs[0]?.focus();
    for (const [i, inp] of inputs.entries()) {
      inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(-1); if (inp.value && inputs[i + 1]) inputs[i + 1].focus(); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !inp.value && inputs[i - 1]) inputs[i - 1].focus(); });
    }
    main.querySelector('[data-guess]').onsubmit = async (e) => {
      e.preventDefault();
      if (st.busy) return;
      const g = inputs.map((x) => x.value).join('');
      const err = main.querySelector('[data-err]');
      if (!new RegExp(`^\\d{${h.digits}}$`).test(g) || new Set(g).size !== h.digits) { err.textContent = tx('heist.active.invalid', { digits: h.digits }); return; }
      st.busy = true;
      try {
        const r = await api.guess(h.id, g, h.guesses_used + 1);
        st.mine.active = r.heist.status === 'active' ? r.heist : null;
        if (r.heist.status === 'active') active(); else { stopTimer(); st.mine = await api.mine(); idle(r.heist); loadSide(); }
      } catch (ex) { err.textContent = ex.message; if (ex.code === 'heist_over') { st.mine = await api.mine(); idle(null); } } finally { st.busy = false; }
    };
    startTimer();
  }
  function startTimer() {
    stopTimer();
    const h = st.mine.active; const total = st.bank.heist.timer_seconds;
    const end = Date.now() + h.seconds_left * 1000;
    st.timer = setInterval(async () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      const s = main.querySelector('[data-seconds]');
      if (s) { s.textContent = tx('heist.active.seconds', { seconds: left }); const ring = main.querySelector('.hz-timer-ring'); if (ring) ring.style.setProperty('--pct', `${Math.max(0, (left / total) * 100)}%`); }
      if (left <= 0) { stopTimer(); const last = st.mine.active; await new Promise((r) => setTimeout(r, 400)); try { st.mine = await api.mine(); idle(st.mine.history.find((x) => x.id === last?.id) || null); loadSide(); } catch { /* next load */ } }
    }, 250);
  }
  const stopTimer = () => { if (st.timer) clearInterval(st.timer); st.timer = null; };
  try { st.bank = (await api.bank()).central_bank; } catch (ex) { main.innerHTML = `<div class="empty" data-testid="heist-closed">${esc(ex.message)}</div>`; return () => {}; }
  drawVault(st.bank);
  if (!playOn() || !st.bank.heist_open || !flagOn('heist')) { main.innerHTML = `<div class="empty" data-testid="heist-closed">${!playOn() ? te('heist.page.play_only') : te('heist.page.closed')}</div>`; loadSide(); return () => {}; }
  loadSide();
  if (!session.user) { main.innerHTML = `<div class="hz-stage">${vaultDoor(st.bank.security_level, st.bank.max_level)}<div class="hz-panel">${rules(st.bank)}<a class="btn btn-primary" href="/sign-in?next=/heist" data-link>${te('heist.page.sign_in')}</a></div></div>`; }
  else {
    st.mine = await api.mine();
    if (st.mine.active) active(); else idle(null);
  }
  unsubs.push(socket.subscribe({ channels: ['central_bank'] }, (m) => {
    if (m.type !== 'central_bank' || !m.msg) return;
    if (m.msg.type === 'vault') { drawVault(m.msg); if (st.bank) { st.bank.balance_dollars = m.msg.balance_dollars; st.bank.security_level = m.msg.security_level; } }
    if (m.msg.type === 'feed') { const ul = el.querySelector('[data-feed]'); if (ul) { if (!ul.querySelector('[data-testid=heist-feed-row]')) ul.innerHTML = ''; ul.insertAdjacentHTML('afterbegin', feedRow(m.msg.item)); } api.wanted().then((w) => { const ol = el.querySelector('[data-wanted]'); if (ol && w.most_wanted.length) ol.innerHTML = w.most_wanted.map((r) => `<li class="hz-wanted-row" data-testid="most-wanted-row"><span class="hz-rank">${esc(r.rank)}</span><b>${esc(r.name)}</b><span class="num">${esc(money(r.loot_dollars))}</span><span class="faint">${te('heist.wanted.row', { heists: esc(r.heists) })}</span></li>`).join(''); }).catch(() => {}); }
  }));
  void toast;
  return () => { stopTimer(); unsubs.forEach((f) => f()); };
}
