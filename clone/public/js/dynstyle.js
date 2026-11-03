// Strict style CSP support (PLAN P1.1 / G13). Rendered HTML never carries style="" attributes, because the site CSP
// is `style-src 'self' 'nonce-…'` without 'unsafe-inline'. Dynamic values (bar widths, series colours, depth
// meters) are emitted as `data-vars="--name:value;…"` and applied as CSS custom properties through the CSSOM
// (element.style.setProperty), which CSP permits. Stylesheets read them with var(--name) (see utilities.css).

const ATTR = 'data-vars';
const NAME = /^--[A-Za-z0-9_-]+$/;
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// vars({ '--bg': color, '--w': '40%' }) -> ' data-vars="--bg:…;--w:40%"' (leading space, ready to splice into a tag).
export function vars(o) {
  const parts = [];
  for (const [k, v] of Object.entries(o)) {
    if (v == null || v === '' || !NAME.test(k)) continue;
    parts.push(`${k}:${String(v).replace(/[;\n\r]/g, '')}`);
  }
  return parts.length ? ` ${ATTR}="${escAttr(parts.join(';'))}"` : '';
}

function applyOne(el) {
  const spec = el.getAttribute(ATTR);
  if (spec == null) return;
  for (const decl of spec.split(';')) {
    const i = decl.indexOf(':');
    if (i < 1) continue;
    const k = decl.slice(0, i).trim();
    if (NAME.test(k)) el.style.setProperty(k, decl.slice(i + 1).trim());
  }
}

export function applyVars(root = document) {
  if (root.nodeType === 1 && root.hasAttribute(ATTR)) applyOne(root);
  for (const el of root.querySelectorAll(`[${ATTR}]`)) applyOne(el);
}

// One observer for the whole document: every innerHTML / insertAdjacentHTML / outerHTML render is hydrated before the
// next paint (MutationObserver callbacks run as microtasks).
let observer = null;
export function watchVars() {
  if (observer) return;
  applyVars(document);
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') { applyOne(m.target); continue; }
      for (const n of m.addedNodes) if (n.nodeType === 1) applyVars(n);
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: [ATTR] });
}
