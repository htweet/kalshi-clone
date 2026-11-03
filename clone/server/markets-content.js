'use strict';
// Phase 5B — markets and content (PLAN P5.2–P5.4, G9, A13, A15; CLONE_SPEC.md §29). One mount for the content
// features; sports derivatives and the hockey league live in server/sports.js, calendar event_limits in
// server/calendar-limits.js.
//   ballot      "What's on your ballot?" (server/ballot.js)
//   aiSummary   AI news summaries and timeline (server/ai-summary.js, server/ai-providers.js)
//   incentives  Liquidity Incentive Program (server/incentives.js)
//   hubs        Senate map, Fed funds outlook, event forecast history, optional demo seed (server/hubs.js)
// Options: start({ marketsContent: { seedHubs, ai: { adapter, regeneratePer10Min }, incentives: { snapshotMs }, ballot } }).
const { mountBallot } = require('./ballot');
const { mountAiSummary } = require('./ai-summary');
const { mountIncentives } = require('./incentives');
const { mountHubs } = require('./hubs');

function mountMarketsContent(ctx) {
  const o = ctx.options || {};
  const ballot = mountBallot({ ...ctx, options: o.ballot || {} });
  const aiSummary = mountAiSummary({ ...ctx, options: o.ai || {} });
  const incentives = mountIncentives({ ...ctx, options: o.incentives || {} });
  const hubs = mountHubs({ ...ctx, incentives, options: { seedHubs: !!o.seedHubs } });
  return { ballot, aiSummary, incentives, hubs };
}

module.exports = { mountMarketsContent };
