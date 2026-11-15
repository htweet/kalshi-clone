// Text catalog defaults for the new member home (public/js/views/home-new.js, CLONE_SPEC.md §44.3). Admin overrides live
// in the database (Admin › Content › Texts); this object is only the default. The object between the markers must stay
// strict JSON: the server reads it to build the catalog (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "home-new.onboarding.overline": "Get ready to trade",
  "home-new.onboarding.title.email": "Confirm your email",
  "home-new.onboarding.title.identity": "Verify your identity",
  "home-new.onboarding.title.deposit": "Make your first deposit",
  "home-new.onboarding.title.trade": "Place your first trade",
  "home-new.onboarding.action.email": "Confirm email",
  "home-new.onboarding.action.identity": "Verify identity",
  "home-new.onboarding.action.deposit": "Deposit",
  "home-new.onboarding.action.trade": "Find a market",
  "home-new.onboarding.step": "Step {n} of {total}",
  "home-new.onboarding.all_steps": "View all steps",
  "home-new.onboarding.progress": "Onboarding progress",
  "home-new.onboarding.dismiss": "Hide this card",
  "home-new.fifteen.heading": "15 Min Markets",
  "home-new.fifteen.countdown": "Next close in {time}",
  "home-new.fifteen.target": "Target {money}",
  "home-new.fifteen.above": "{money} Above",
  "home-new.fifteen.below": "{money} Below",
  "home-new.fifteen.buy_above": "Above · {pct}%",
  "home-new.fifteen.buy_below": "Below · {pct}%",
  "home-new.fifteen.vol": "{money} vol",
  "home-new.fifteen.none": "No 15-minute markets are open right now.",
  "home-new.customize.title": "Customize your view",
  "home-new.customize.mode_label": "View mode",
  "home-new.customize.prediction": "Prediction",
  "home-new.customize.trader": "Trader",
  "home-new.customize.help_prediction": "Get the classic Parlance experience. You can always switch between modes in Settings later.",
  "home-new.customize.help_trader": "The home address opens the Pro screener and the ticket starts on limit orders. You can always switch between modes in Settings later.",
  "home-new.customize.close": "Close",
  "home-new.customize.saved_trader": "Trader mode on: the home address now opens Pro.",
  "home-new.customize.saved_prediction": "Prediction mode on."
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
