'use strict';
// Server-side wording of the elections hub v2 (PLAN Phase 7B, CLONE_SPEC.md §37): results-desk errors, staff notices
// and the seeded market wording. Keyed templates with named variables; Admin › Content › Texts overrides them as
// `server.elections.<key>` (server/cms/texts.js lists this module).
const catalog = require('./catalog');

const STRINGS = {
  // errors (API messages)
  'error.unknown_hub': 'There is no such elections hub.',
  'error.reason_required': 'A reason of 3-500 characters is required.',
  'error.race_called': 'This race has already been called. Uncall it first.',
  'error.race_not_called': 'This race has not been called.',
  'error.no_results': 'No results have been reported for this race yet.',
  'error.rule_not_met': '{candidate} does not meet the win rule on the reported results ({detail}).',
  'error.runoff_not_due': 'A runoff can only be called once every polling unit has reported and no candidate meets the win rule.',
  'error.no_runoff_rule': 'This office has no runoff rule.',
  'error.call_pending': 'A call for this race is already waiting for a second person.',
  'error.same_person': 'A different person must approve this call (two-person rule).',
  'error.call_closed': 'This request is {status}.',
  'error.settlement_executed': 'A market of this race has already been resolved from the call. Reverse it on the resolution desk first.',
  'error.simulator_off': 'The results simulator is switched off (flag elections.simulator).',
  'error.unknown_media': 'Choose an image from the media library.',
  'error.unknown_market': 'Unknown market {ticker}.',
  // rule detail fragments (inside error.rule_not_met)
  'rule.not_leading': 'not leading',
  'rule.spread_short': '25% in {count} of {needed} required',
  'rule.territory_short': 'below the threshold in a required territory',
  // staff notifications
  'notify.call_pending.title': 'Second person needed: call of {race}',
  'notify.call_pending.body': '{who} asked to {action} {race}. Approve or reject it on Admin › Elections › Results desk.',
  'notify.settlement.title': 'Settlement proposed: {race}',
  'notify.settlement.body': 'The results desk called {race}. {count} market resolution(s) wait for approval on the resolution desk.',
  'action.call': 'call',
  'action.uncall': 'uncall',
  // seeded markets
  'market.winner_title': '{race} winner?',
  'market.winner_sub': '{election}',
  'market.runoff_title': '{race}: runoff?',
  'market.runoff_yes': 'Runoff',
  'market.runoff_no': 'No runoff',
  'market.control_title': '{office}: which party wins the most seats?',
  'market.rules_winner': 'Resolves YES for the candidate or party the Parlance results desk calls as the winner of {race} under the published win rule, otherwise NO. Each contract pays {value}.',
  'market.rules_runoff': 'Resolves YES if the Parlance results desk calls a runoff for {race} (no candidate met the win rule), otherwise NO. Each contract pays {value}.',
  'market.rules_control': 'Resolves YES for the party that wins the most seats in the {office} once every seat in this election is called, otherwise NO. Each contract pays {value}.',
  'series.title': '{election}',
  'source.note': 'Results desk call: {race} — {outcome}. {reason}',
  'outcome.runoff': 'runoff',
  // labels used in generated names
  'race.president': '{country} President',
  'race.governor': '{state} Governor',
  'race.senate': '{state} Senate district {n}',
  'race.senate_single': '{state} Senate',
  'race.house': '{state} federal constituency {n}',
  'party.candidate': '{party} candidate',
  // ground rule 6 (CLONE_SPEC.md §38.1): the second-resolver switch is off, so a call settles its markets at once
  'second_resolver_off': 'Settled by the results-desk call (the second-resolver switch is off).',
};

const s = catalog.scoped('server.elections.', STRINGS);
module.exports = { STRINGS, s };
