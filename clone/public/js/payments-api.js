// Phase 4 transport (CLONE_SPEC.md §26): the observed funds route families, sandbox rails. One Idempotency-Key per user
// action on every deposit / withdrawal creation; retries of that action (client token refresh, step-up) reuse it.
import { request, newIdempotencyKey } from './api.js';

const u = (uid, p) => `/v1/users/${encodeURIComponent(uid)}${p}`;
const idem = () => ({ idempotencyKey: newIdempotencyKey() });

export const payApi = {
  metadata: (uid) => request('GET', u(uid, '/payments/metadata')),
  networks: () => request('GET', '/v1/payments/supported_networks'),
  withdrawalTimes: (uid) => request('GET', u(uid, '/withdrawal_times')),
  creditHistory: (uid) => request('GET', u(uid, '/credit_history')),
  deposits: (uid) => request('GET', u(uid, '/deposits')),
  withdrawals: (uid) => request('GET', u(uid, '/withdrawals')),
  // generic creation with a saved method (method_id); the key is generated once per call = per user action
  deposit: (uid, methodId, amount) => request('POST', u(uid, '/deposits'), { method_id: methodId, amount_dollars: amount }, idem()),
  withdraw: (uid, methodId, amount) => request('POST', u(uid, '/withdrawals'), { method_id: methodId, amount_dollars: amount }, idem()),
  // cards
  cards: (uid) => request('GET', u(uid, '/debit/cards')),
  removeCard: (uid, id) => request('DELETE', u(uid, `/debit/cards/${encodeURIComponent(id)}`)),
  paymentSession: (uid) => request('POST', u(uid, '/debit/payment_session'), {}),
  // The card number goes only to the isolated tokenizer; the caller clears its form right after.
  tokenize: (b) => request('POST', '/v1/payments/tokenize/card', b),
  cardPayment: (uid, b) => request('POST', u(uid, '/debit/payment'), b, idem()),
  paymentStatus: (uid, id) => request('GET', u(uid, `/debit/payment_status_web?payment_id=${encodeURIComponent(id)}`)),
  challenge: (uid, id, result) => request('POST', u(uid, `/debit/payment/${encodeURIComponent(id)}/challenge`), { result }),
  // bank
  bankLogin: (uid, b) => request('POST', u(uid, '/bank_link/accounts'), b),
  banks: (uid) => request('GET', u(uid, '/banks/all_accounts')),
  linkBank: (uid, b) => request('POST', u(uid, '/banks/linked_accounts'), b),
  removeBank: (uid, id) => request('DELETE', u(uid, `/banks/linked_accounts/${encodeURIComponent(id)}`)),
  // crypto
  cryptoAccount: (uid) => request('GET', u(uid, '/crypto/account')),
  openCrypto: (uid) => request('PUT', u(uid, '/crypto/account'), { accept_terms: true }),
  wallets: (uid) => request('GET', u(uid, '/crypto/wallets')),
  addWallet: (uid, b) => request('POST', u(uid, '/crypto/wallets'), b),
  removeWallet: (uid, id) => request('DELETE', u(uid, `/crypto/wallets/${encodeURIComponent(id)}`)),
  simulateCrypto: (uid, amount) => request('POST', u(uid, '/crypto/simulate_deposit'), { amount_dollars: amount }),
};
