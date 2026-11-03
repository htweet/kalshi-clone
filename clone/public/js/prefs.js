// Display preferences applied app-wide (Settings, CLONE_SPEC §13.16; CLONE_SPEC.md §25.8). Kept in a tiny module with no
// imports so lib.js, components and views can read them without import cycles. The session store fills them from the
// account's saved settings (GET /users/:uid/properties); signed-out visitors get the defaults.
export const uiPrefs = { display_mode: 'payout', market_price_type: 'last_traded', accessible_colors: false, theme: 'dark' };

export function setUiPrefs(props = {}) {
  for (const k of Object.keys(uiPrefs)) if (props[k] !== undefined) uiPrefs[k] = props[k];
  const root = document.documentElement;
  root.dataset.palette = uiPrefs.accessible_colors ? 'accessible' : '';
  root.dataset.display = uiPrefs.display_mode;
  root.dataset.pricePreview = uiPrefs.market_price_type;
}
export function resetUiPrefs() { setUiPrefs({ display_mode: 'payout', market_price_type: 'last_traded', accessible_colors: false }); }
