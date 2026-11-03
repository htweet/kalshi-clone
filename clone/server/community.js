'use strict';
// Phase 2 — social and community completion (PLAN §3 Phase 2, §11 A6 + A11, gaps G8 and G10; PHASE2_SPEC.md §24).
// One entry point so server/app.js needs only two lines:
//   const community = mountCommunity({...});   // after mountFeatures: hooks, routes, notification gate
//   community.attachChat(mountChat({...}));      // event-chat reactions, edits, stickers, mutes
// Modules: circle.js (Inner Circle) → social2.js (posts, stickers, mutes, topics, search, badges, alerts, G8) →
// notify-prefs.js (A6 matrix, channels, quiet hours, price-movement subscriptions) → groups.js (Group chats) and
// chat-extras.js (G10). Each creates its own tables (CREATE TABLE IF NOT EXISTS) and validates its own write bodies.
const { mountCircle } = require('./circle');
const { mountSocial2 } = require('./social2');
const { mountNotifyPrefs } = require('./notify-prefs');
const { mountGroups } = require('./groups');
const { mountChatExtras } = require('./chat-extras');

function mountCommunity({ v1, app, db, engine, feat, admin, requireUser, getEvent }) {
  const getFeat = () => feat;
  const rolesOf = admin.rolesOf;
  const can = admin.can;
  let social = null;
  const isMuted = (a, b) => (social ? social.isMuted(a, b) : false);
  const circle = mountCircle({ v1, db, requireUser, rolesOf, getFeat, isMuted });
  social = mountSocial2({ v1, db, engine, requireUser, can, rolesOf, getFeat, circle, getEvent });
  social.attachFeatures(feat);
  const prefs = mountNotifyPrefs({ v1, app, db, engine, requireUser, rolesOf, can, getFeat, isMuted });
  feat.hooks.notifyGate = prefs.gate;
  const groups = mountGroups({ v1, app, db, engine, requireUser, rolesOf, can, getFeat, social, circle });
  let chatExtras = null;
  return {
    social, circle, prefs, groups,
    attachChat(chat) { if (chat && chat.hooks) chatExtras = mountChatExtras({ v1, db, chat, social, requireUser, rolesOf, can }); return chat; },
    get chatExtras() { return chatExtras; },
  };
}

module.exports = { mountCommunity };
