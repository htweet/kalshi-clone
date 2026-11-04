// Account › Your activity (CLONE_SPEC §13.16; CLONE_SPEC.md §25.8): a condensed title with a ⤓ download icon, filter
// chips All · Deposit · Withdrawal · Order · Trade · Settlement · Credit, the timeline from server/history.js, and the
// empty state "No activity with these filters". The chosen chip is remembered with the account (user_settings).
import { te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/account-activity-strings.js';
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { esc, money, qty, relTime, fmtDate } from '../lib.js';

const CHIPS = [['all', ts('account-activity.chips.all')], ['deposit', 'Deposit'], ['withdrawal', 'Withdrawal'], ['order', 'Order'], ['trade', 'Trade'], ['settlement', 'Settlement'], ['credit', 'Credit']];
const DOWNLOAD = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="M8 2v8M4.5 7L8 10.5 11.5 7M3 13.5h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const EMPTY = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M5.6 5.6l12.8 12.8" stroke="currentColor" stroke-width="1.6"/></svg>';

export async function render(panel) {
  let type = CHIPS.some(([k]) => k === session.props.activity_filter) ? session.props.activity_filter : 'all';
  let cursor = '';
  const draw = async (append = false) => {
    const r = await idApi.activity(session.uid, { type, cursor: append ? cursor : '' });
    cursor = r.cursor;
    const rows = r.activity.map((a) => `<tr data-testid="activity-row" data-type="${esc(a.type)}"><td>${esc(relTime(a.time))}<div class="faint">${esc(fmtDate(a.time))}</div></td>
      <td>${esc(a.type_label)}</td><td>${a.market_title ? (a.link ? `<a href="${esc(a.link)}" data-link>${esc(a.market_title)}</a>` : esc(a.market_title)) : '<span class="faint">—</span>'}<div class="faint">${esc(a.description)}</div></td>
      <td class="num">${a.quantity_fp ? esc(qty(a.quantity_fp)) : ''}</td><td class="num">${a.amount_dollars == null ? '' : esc(money(a.amount_dollars))}</td></tr>`).join('');
    if (append) { panel.querySelector('tbody').insertAdjacentHTML('beforeend', rows); } else {
      panel.querySelector('[data-list]').innerHTML = r.activity.length
        ? `<table class="table" data-testid="activity-table"><thead><tr><th>${te('account-activity.render.when')}</th><th>${te('account-activity.render.type')}</th><th>${te('account-activity.render.details')}</th><th class="num">${te('account-activity.render.qty')}</th><th class="num">${te('account-activity.render.amount')}</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="empty acct-empty" data-testid="activity-empty">${EMPTY}<p>${te('account-activity.render.no_activity_with_these_filters')}</p></div>`;
    }
    panel.querySelector('[data-more]').hidden = !cursor;
  };
  panel.innerHTML = `<section class="acct-activity" data-testid="activity">
    <div class="acct-row"><h2 class="acct-h2">${te('account-activity.render.activity')}</h2><a class="icon-btn" data-download href="${esc(idApi.activityCsvUrl(session.uid, type))}" download aria-label="${te('account-activity.render.download_as_csv')}" title="${te('account-activity.render.download_as_csv')}" data-testid="activity-download">${DOWNLOAD}</a></div>
    <div class="chips" role="tablist" aria-label="${te('account-activity.render.filter_activity')}" data-testid="activity-chips">${CHIPS.map(([k, l]) => `<button class="chip ${k === type ? 'on' : ''}" role="tab" aria-selected="${k === type}" data-chip="${esc(k)}">${esc(l)}</button>`).join('')}</div>
    <div data-list></div><div class="ta-c mt-12"><button class="btn" data-more hidden>${te('account-activity.render.load_more')}</button></div></section>`;
  for (const b of panel.querySelectorAll('[data-chip]')) {
    b.onclick = async () => {
      type = b.dataset.chip;
      for (const x of panel.querySelectorAll('[data-chip]')) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); }
      panel.querySelector('[data-download]').href = idApi.activityCsvUrl(session.uid, type);
      session.setProp('activity_filter', type).catch(() => {});
      await draw();
    };
  }
  panel.querySelector('[data-more]').onclick = () => draw(true);
  await draw();
}
