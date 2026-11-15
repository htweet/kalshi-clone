'use strict';
// Server-side wording of the Pro trading terminal (CLONE_SPEC.md §15.6). Keyed templates; Admin › Content › Texts
// overrides them as `server.pro.<key>` (server/cms/texts.js lists this module).
const catalog = require('./catalog');

const STRINGS = {
  'error.one_click_off': 'One-click trading is not switched on for your account. Review the order first, or switch one-click trading on in the Pro terminal.',
  'error.one_click_confirm': 'Confirm that orders will be placed without a review step to switch on one-click trading.',
  'error.screen_name_taken': 'You already have a screen with this name.',
  'error.too_many_screens': 'You can save up to {max} screens. Delete one first.',
  'error.unknown_screen': 'There is no such saved screen.',
  'error.invalid': 'This is not a valid value: {detail}',
};

const s = catalog.scoped('server.pro.', STRINGS);
module.exports = { STRINGS, s };
