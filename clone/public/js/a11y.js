// Accessibility helpers applied to every page (PLAN P8.5, CLONE_SPEC.md §38.6).
//   Tabs   every [role=tablist] child button or link is a tab (role=tab) whose aria-selected follows the `on` class the
//          views toggle, so screen readers announce the selected tab; arrow keys move between tabs (WAI-ARIA pattern).
// It watches the DOM (new views, re-renders, class changes), so views need no per-file code.
const sync = (list) => {
  for (const el of list.children) {
    if (!/^(BUTTON|A)$/.test(el.tagName)) continue;
    if (el.getAttribute('role') !== 'tab') el.setAttribute('role', 'tab');
    const on = el.classList.contains('on') || el.getAttribute('aria-pressed') === 'true';
    if (el.getAttribute('aria-selected') !== String(on)) el.setAttribute('aria-selected', String(on));
  }
};
const scan = (root) => {
  if (!root || root.nodeType !== 1) return;
  if (root.getAttribute('role') === 'tablist') sync(root);
  for (const l of root.querySelectorAll('[role=tablist]')) sync(l);
};
export function initA11y() {
  if (typeof MutationObserver === 'undefined') return;
  scan(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') { const p = r.target.parentElement; if (p && p.getAttribute('role') === 'tablist') sync(p); continue; }
      for (const n of r.addedNodes) scan(n);
      if (r.target.nodeType === 1 && r.target.getAttribute('role') === 'tablist') sync(r.target);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-pressed'] });
  // Arrow keys between tabs.
  document.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const t = e.target.closest && e.target.closest('[role=tab]');
    const list = t && t.parentElement;
    if (!list || list.getAttribute('role') !== 'tablist') return;
    const tabs = [...list.querySelectorAll(':scope > [role=tab]')].filter((x) => x.offsetParent !== null);
    const i = tabs.indexOf(t);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    if (next) { e.preventDefault(); next.focus(); }
  });
}
