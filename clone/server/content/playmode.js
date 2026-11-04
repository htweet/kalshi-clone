'use strict';
// Server-side wording of Phase 5D (CLONE_SPEC.md §33): feature flags, play mode, money controls, the Central Bank and
// the Vault Heist. Keyed templates with named variables; Admin › Content › Texts overrides them as `server.playmode.<key>`
// (server/cms/texts.js lists this module). Amounts are formatted by server/currency.js before substitution.
const catalog = require('./catalog');

const STRINGS = {
  'flag.disabled': 'This feature is not available right now.',
  // money controls
  'money.deposits_off': 'Deposits are turned off right now.',
  'money.withdrawals_off': 'Withdrawals are turned off right now.',
  'money.deposits_revoked': 'Deposits are switched off for your account.',
  'money.withdrawals_revoked': 'Withdrawals are switched off for your account.',
  'money.revoked_details': 'Reason: {reason}',
  'money.play_withdrawals': 'Withdrawals are disabled while Parlance runs on play money.',
  'money.play_rails': 'Payment methods are not used in play mode: deposits are free play money.',
  'money.play_cap': 'You can add up to {amount} of play money today ({left} left).',
  'money.real_deposit_in_play': 'Real-money deposits are not possible while play mode is on.',
  'money.play_off': 'Play money is only available while play mode is on.',
  // play mode switching
  'play.real_money_exists': 'Play mode cannot be turned on while real customer money exists.',
  'play.real_money_details': '{balances} accounts with a balance, {positions} open positions, {perps} perps accounts, {pending} pending payments, {holds} held withdrawals',
  'play.not_on': 'Play mode is not on.',
  'play.confirm_reset': 'Type RESET to confirm the switch to production.',
  'play.pending_exists': 'A switch to production is already waiting for a second admin.',
  'play.backup_failed': 'The database backup could not be written, so nothing was reset.',
  // notifications (titles and bodies; the CMS templates notify.<type> wrap them)
  'notify.bonus.title': 'Welcome bonus: {amount}',
  'notify.bonus.body_play': '{amount} of play money is in your account. Have fun!',
  'notify.bonus.body_real': '{amount} of promotional credit is in your account. It can be traded, not withdrawn.',
  'notify.bonus.queued': 'Your welcome bonus of {amount} is queued and will arrive when the promotions budget is topped up.',
  'notify.heist.won.title': 'Heist cracked: you got away with {amount}',
  'notify.heist.won.body': 'The vault code was {code}. Security just went up a level.',
  'notify.heist.lost.title': 'Heist failed: the crew fee of {amount} is gone',
  'notify.heist.lost.body': 'The code was {code}. You are in jail until {until}.',
  'notify.controls.title': 'Your {what} were switched off',
  'notify.controls.title_on': 'Your {what} were switched back on',
  'notify.controls.body': '{reason}',
  'notify.controls.what.deposits': 'deposits',
  'notify.controls.what.withdrawals': 'withdrawals',
  'notify.controls.what.both': 'deposits and withdrawals',
  'notify.reset.title': 'Parlance is moving to real money',
  'notify.reset.body': 'Play mode has ended. Your play balance and positions were archived and reset to {zero}. Your account, watchlist and history are kept.',
  'notify.payout_paid.title': 'Promotion paid: {amount}',
  'notify.payout_paid.body': '{memo}',
  // ledger memos and history labels
  'memo.play_deposit': 'Play money',
  'memo.bonus_play': 'Welcome bonus (play money)',
  'memo.bonus_real': 'Welcome bonus',
  'memo.heist_fee': 'Vault Heist crew fee',
  'memo.heist_loot': 'Vault Heist loot',
  'memo.reset': 'Play mode ended: balance archived and reset (batch {batch})',
  'memo.closure_play': 'account closed: play money returned to the Central Bank',
  'history.bonus': 'Welcome bonus',
  'history.heist_fee': 'Heist crew fee',
  'history.heist_loot': 'Heist loot',
  'history.play_reset': 'Play money reset',
  // Central Bank and heist errors
  'bank.off': 'The Central Bank is closed right now.',
  'bank.vault_empty': 'The vault is empty. Come back after the Central Bank is funded.',
  'bank.insufficient_vault': 'The vault holds only {amount}.',
  'bank.budget_empty': 'The promotions budget is empty.',
  'heist.play_only': 'The Vault Heist is only open in play mode.',
  'heist.jailed': 'You are in jail until {until}.',
  'heist.daily_limit': 'You have used all {limit} heist attempts for today.',
  'heist.active': 'You already have a heist in progress.',
  'heist.fee': 'The crew fee is {amount}; your balance is {balance}.',
  'heist.not_active': 'This heist is over.',
  'heist.guess_format': 'Enter {digits} different digits.',
  'heist.too_fast': 'Slow down: one guess at a time.',
  'heist.feed.won': '{name} cracked the vault and took {amount}',
  'heist.feed.lost': '{name} tripped the alarm',
  'heist.feed.timeout': "{name} ran out of time",
};
const s = catalog.scoped('server.playmode.', STRINGS);

module.exports = { STRINGS, s };
