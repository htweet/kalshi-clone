// Perps REST client (PERPS_SPEC_SECTION.md): one method per /v1/perps endpoint, same transport as api.js.
import { request, newIdempotencyKey } from './api.js';

const qs = (o = {}) => {
  const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
  return s ? `?${s}` : '';
};
const enc = encodeURIComponent;
const B = '/v1/perps';

export const perpsApi = {
  assetClasses: () => request('GET', `${B}/asset_classes`),
  markets: (o) => request('GET', `${B}/markets${qs(o)}`),
  market: (t) => request('GET', `${B}/markets/${enc(t)}`),
  orderbook: (t, depth = 12) => request('GET', `${B}/markets/${enc(t)}/orderbook${qs({ depth })}`),
  trades: (t, limit = 25) => request('GET', `${B}/markets/${enc(t)}/trades${qs({ limit })}`),
  candles: (t, o) => request('GET', `${B}/markets/${enc(t)}/candlesticks${qs(o)}`),
  fundingRates: (t) => request('GET', `${B}/funding_rates/historical${qs({ ticker: t })}`),
  fundingEstimate: (t) => request('GET', `${B}/funding_rates/estimate${qs({ ticker: t })}`),
  riskParameters: () => request('GET', `${B}/risk_parameters`),
  balance: (sub) => request('GET', `${B}/balance${qs({ subaccount: sub })}`),
  transfer: (direction, amountDollars, sub) => request('POST', `${B}/transfers`, { direction, amount_dollars: amountDollars, ...(sub ? { subaccount: sub } : {}) }, { idempotencyKey: newIdempotencyKey() }),
  transfers: () => request('GET', `${B}/transfers`),
  placeOrder: (b) => request('POST', `${B}/orders`, b, { idempotencyKey: newIdempotencyKey() }),
  orders: (o) => request('GET', `${B}/orders${qs(o)}`),
  cancelOrder: (id) => request('DELETE', `${B}/orders/${enc(id)}`),
  amendOrder: (id, b) => request('POST', `${B}/orders/${enc(id)}/amend`, b, { idempotencyKey: newIdempotencyKey() }),
  decreaseOrder: (id, b) => request('POST', `${B}/orders/${enc(id)}/decrease`, b),
  // Phase 6 (CLONE_SPEC.md §34): subaccounts, order groups, margin tiers, APY, waitlist, referrals.
  subaccounts: () => request('GET', `${B}/subaccounts`),
  createSubaccount: (b) => request('POST', `${B}/subaccounts`, b),
  updateSubaccount: (n, b) => request('PUT', `${B}/subaccounts/${enc(n)}`, b),
  subTransfer: (from, to, amountDollars) => request('POST', `${B}/subaccounts/transfers`, { from_subaccount: from, to_subaccount: to, amount_dollars: amountDollars }, { idempotencyKey: newIdempotencyKey() }),
  orderGroups: () => request('GET', `${B}/order_groups`),
  createOrderGroup: (b) => request('POST', `${B}/order_groups`, b),
  cancelOrderGroup: (id) => request('DELETE', `${B}/order_groups/${enc(id)}`),
  resetOrderGroup: (id) => request('POST', `${B}/order_groups/${enc(id)}/reset`, {}),
  marginTiers: (t) => request('GET', `${B}/markets/${enc(t)}/margin_tiers`),
  apy: () => request('GET', `${B}/apy`),
  waitlist: () => request('GET', `${B}/waitlist`),
  joinWaitlist: () => request('POST', `${B}/waitlist`, {}),
  referrals: () => request('GET', `${B}/referrals`),
  applyReferral: (code) => request('POST', `${B}/referrals/apply`, { code }),
  positions: (o) => request('GET', `${B}/positions${qs(o)}`),
  closePosition: (t, percent = 100, sub = 0) => request('POST', `${B}/positions/${enc(t)}/close`, { percent, ...(sub ? { subaccount: sub } : {}) }, { idempotencyKey: newIdempotencyKey() }),
  fills: (o) => request('GET', `${B}/fills${qs(o)}`),
  fundingHistory: (o) => request('GET', `${B}/funding_history${qs(o)}`),
  liquidations: () => request('GET', `${B}/liquidations`),
  risk: () => request('GET', `${B}/risk`),
  exitTriggers: (o) => request('GET', `${B}/exit_triggers${qs(o)}`),
  setExitTrigger: (t, b) => request('PUT', `${B}/positions/${enc(t)}/exit_trigger`, b),
  clearExitTrigger: (t, kind, sub) => request('DELETE', `${B}/positions/${enc(t)}/exit_trigger${qs({ kind, subaccount: sub || null })}`),
};
