// Account › Documents (/account/taxes; CLONE_SPEC §13.16, §13.19; PHASE3_SPEC.md §25.9): realized P&L per year with and
// without fees, the year's transactions as CSV, and simulated yearly statements (CSV + PDF) — clearly not tax advice.
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { esc, money } from '../lib.js';

const DL = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true"><path d="M8 2v8M4.5 7L8 10.5 11.5 7M3 13.5h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export async function render(panel) {
  const r = await idApi.taxDocuments(session.uid);
  panel.innerHTML = `<section class="acct-docs" data-testid="documents">
    <p class="muted" data-testid="documents-intro">Your realized profit and loss for each year, including fees and any credits or rebates. Figures update monthly. This page is for your records and is <strong>not tax advice</strong>; see the <a href="/support/help-center" data-link class="c-brand">help centre’s taxes page</a> for how amounts are calculated.</p>
    <table class="table" data-testid="pnl-table"><thead><tr><th>Year</th><th class="num">PnL with fees</th><th class="num">PnL without fees</th><th class="num">Transactions</th></tr></thead><tbody>
    ${r.years.map((y) => `<tr data-year="${esc(y.year)}"><td>${esc(y.year)}</td><td class="num" data-testid="pnl-with-fees">${esc(money(y.pnl_with_fees_dollars))}</td><td class="num" data-testid="pnl-without-fees">${esc(money(y.pnl_without_fees_dollars))}</td>
      <td class="num"><a class="icon-btn" href="${esc(y.transactions_csv)}" download aria-label="Download ${esc(y.year)} transactions (CSV)" data-testid="transactions-download">${DL}</a></td></tr>`).join('')}</tbody></table>
    <h2 class="acct-h2 mt-16">Yearly statements</h2>
    <p class="muted">Each year with interest or credits gets statements modelled on the usual US forms: interest income (1099-INT) and credits and rewards (1099-MISC), plus a P&amp;L summary. Digital-asset reporting would come from a crypto partner; Parlance uses simulated funds only. <strong data-testid="not-tax-advice">${esc(r.notice)}</strong></p>
    <ul class="form-chips" data-testid="statement-list">${r.years.map((y) => `<li data-year="${esc(y.year)}"><strong>${esc(y.year)}:</strong> ${y.forms.map((f) => `<span class="chip form-chip" data-form="${esc(f.form)}">${esc(f.form === 'PNL' ? 'P&L summary' : f.form)} <a href="${esc(f.pdf)}" download data-testid="statement-pdf">PDF</a> · <a href="${esc(f.csv)}" download data-testid="statement-csv">CSV</a></span>`).join(' ')}</li>`).join('')}</ul>
  </section>`;
}
