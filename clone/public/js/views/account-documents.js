// Account › Documents (/account/taxes; CLONE_SPEC §13.16, §13.19; CLONE_SPEC.md §25.9): realized P&L per year with and
// without fees, the year's transactions as CSV, and simulated yearly statements (CSV + PDF) — clearly not tax advice.
import { te, t } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/account-documents-strings.js';
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { esc, money } from '../lib.js';

const DL = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true"><path d="M8 2v8M4.5 7L8 10.5 11.5 7M3 13.5h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export async function render(panel) {
  const r = await idApi.taxDocuments(session.uid);
  panel.innerHTML = `<section class="acct-docs" data-testid="documents">
    <p class="muted" data-testid="documents-intro">${te('account-documents.render.your_realized_profit_and_loss')} <strong>${te('account-documents.render.not_tax_advice')}</strong>${te('account-documents.render.see_the')} <a href="/support/help-center" data-link class="c-brand">${te('account-documents.render.help_centre_s_taxes_page')}</a> ${te('account-documents.render.for_how_amounts_are_calculated')}</p>
    <table class="table" data-testid="pnl-table"><thead><tr><th>${te('account-documents.render.year')}</th><th class="num">${te('account-documents.render.pnl_with_fees')}</th><th class="num">${te('account-documents.render.pnl_without_fees')}</th><th class="num">${te('account-documents.render.transactions')}</th></tr></thead><tbody>
    ${r.years.map((y) => `<tr data-year="${esc(y.year)}"><td>${esc(y.year)}</td><td class="num" data-testid="pnl-with-fees">${esc(money(y.pnl_with_fees_dollars))}</td><td class="num" data-testid="pnl-without-fees">${esc(money(y.pnl_without_fees_dollars))}</td>
      <td class="num"><a class="icon-btn" href="${esc(y.transactions_csv)}" download aria-label="${te('account-documents.render.download_transactions_csv', { year: esc(y.year) })}" data-testid="transactions-download">${DL}</a></td></tr>`).join('')}</tbody></table>
    <h2 class="acct-h2 mt-16">${te('account-documents.render.yearly_statements')}</h2>
    <p class="muted">${te('account-documents.render.each_year_with_interest_or')} <strong data-testid="not-tax-advice">${esc(r.notice)}</strong></p>
    <ul class="form-chips" data-testid="statement-list">${r.years.map((y) => `<li data-year="${esc(y.year)}"><strong>${esc(y.year)}:</strong> ${y.forms.map((f) => `<span class="chip form-chip" data-form="${esc(f.form)}">${esc(f.form === 'PNL' ? t('account-documents.render.p_l_summary') : f.form)} <a href="${esc(f.pdf)}" download data-testid="statement-pdf">${te('account-documents.render.pdf')}</a> · <a href="${esc(f.csv)}" download data-testid="statement-csv">${te('account-documents.render.csv')}</a></span>`).join(' ')}</li>`).join('')}</ul>
  </section>`;
}
