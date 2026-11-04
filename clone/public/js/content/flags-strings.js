// Text catalog defaults for public/js/flags.js and the play-mode shell (CLONE_SPEC.md §33, §32.3). Admin overrides live
// in the database (Admin › Content › Texts); this object is only the default. Keys: <area>.<section>.<slug>; {name}
// placeholders are the declared variables. The object between the markers must stay strict JSON: the server reads it
// to build the catalog (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "flags.unavailable.title": "{feature} is not available right now",
  "flags.unavailable.body": "This part of Parlance is switched off at the moment. Please check back later.",
  "flags.unavailable.home": "Go home",
  "flags.feature.trading": "Trading",
  "flags.feature.trading.rolling": "Live rolling markets",
  "flags.feature.combos": "Combos",
  "flags.feature.combos.rfq": "Requests for quote",
  "flags.feature.perps": "Perps",
  "flags.feature.sports": "Sports",
  "flags.feature.social": "Social",
  "flags.feature.social.chat": "Live chat",
  "flags.feature.social.group_chat": "Group chats",
  "flags.feature.watchlist": "Watchlist",
  "flags.feature.payments.deposits": "Deposits",
  "flags.feature.payments.withdrawals": "Withdrawals",
  "flags.feature.ballot": "Ballot lookup",
  "flags.feature.incentives": "Liquidity rewards",
  "flags.feature.rewards": "Rewards",
  "flags.feature.hubs": "Hubs",
  "flags.feature.identity.kyc": "Identity verification",
  "flags.feature.accounts.signup": "Sign-up",
  "flags.feature.central_bank": "The Central Bank",
  "flags.feature.heist": "Vault Heist",
  "flags.feature.default": "This feature",
  "flags.play.banner": "Play money: everything on Parlance runs on free play money right now. Nothing can be withdrawn.",
  "flags.play.banner_link": "Try the Vault Heist",
  "flags.play.label": "Play money",
  "flags.play.cash": "Play cash",
  "flags.money.revoked_reason": "Reason: {reason}"
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
