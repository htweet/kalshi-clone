#!/usr/bin/env node
// Rewrites literal typography, spacing and radius values in public/*.css to the visual-system tokens defined in
// public/app.css (CLONE_SPEC §27), and renames px-named utility classes (mt-14, fs-17, h-44, …) in the views to their
// on-scale equivalents. Safe to re-run: values that are already tokens are left alone, so a second run is a no-op.
//
//   node scripts/apply-type-tokens.js            rewrite files in place, print a summary
//   node scripts/apply-type-tokens.js --check    exit 1 if anything would change (CI / pre-merge check)
//
// Manual judgement still applies after a run: the script picks the nearest step, which is right for most rules but
// not for every display headline. tests/visual-system.e2e.test.js enforces the result.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public');
const CHECK = process.argv.includes('--check');

// ---------------------------------------------------------------- scales (mirror the :root block in app.css)
const FS = [[10, '3xs'], [11, '2xs'], [12, 'xs'], [13, 'sm'], [14, 'md'], [16, 'lg'], [18, 'xl'], [22, '2xl'], [28, '3xl'], [36, '4xl'], [44, '5xl']];
// Explicit choices where two steps are equally near (15 → 16: body-large/inputs; 20 → 22: stat values; 32 → 28).
const FS_OVERRIDE = { 15: 'lg', 17: 'lg', 20: '2xl', 32: '3xl', 40: '4xl' };
const SPACE = [[0, '0'], [2, 'half'], [4, '1'], [6, '1h'], [8, '2'], [12, '3'], [16, '4'], [20, '5'], [24, '6'], [32, '8'], [40, '10'], [48, '12'], [64, '16']];
const CONTROL = [[32, 'sm'], [40, 'md'], [48, 'lg']];
const SPACING_PROPS = /^(margin|padding)(-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?$|^(gap|row-gap|column-gap|grid-gap)$/;

function nearest(table, v, tieUp = true) {
  let best = table[0];
  for (const row of table) {
    const d = Math.abs(row[0] - v); const bd = Math.abs(best[0] - v);
    if (d < bd || (d === bd && tieUp && row[0] > best[0])) best = row;
  }
  return best;
}
const fsName = (px) => FS_OVERRIDE[px] || nearest(FS, px, false)[1];
const spacePx = (px) => nearest(SPACE, px, true)[0];
const spaceTok = (px) => { const [v, n] = nearest(SPACE, px, true); return v === 0 ? '0' : `var(--space-${n})`; };
function weightTok(w) {
  const n = w === 'bold' ? 700 : w === 'normal' ? 400 : Number(w);
  if (!Number.isFinite(n)) return null;
  return n >= 700 ? 'var(--fw-bold)' : n >= 600 ? 'var(--fw-semibold)' : n >= 500 ? 'var(--fw-medium)' : 'var(--fw-regular)';
}
function lsTok(v) {
  const m = /^(-?\d*\.?\d+)(em)?$/.exec(v.trim());
  if (!m) return null;
  const x = Number(m[1]);
  if (x <= -0.015) return 'var(--ls-tight)';
  if (x < 0) return 'var(--ls-display)';
  if (x < 0.04) return 'var(--ls-normal)';
  return 'var(--ls-caps)';
}
function radiusTok(px) {
  if (px <= 3) return null;
  if (px <= 6) return 'var(--rounded-x05)';
  if (px <= 10) return 'var(--rounded-x10)';
  if (px <= 14) return 'var(--rounded-x20)';
  if (px <= 24) return 'var(--rounded-x30)';
  if (px >= 100) return 'var(--rounded-pill)';
  return null;
}

// ---------------------------------------------------------------- CSS
// Split a declaration block on ';' outside parentheses and quotes.
function splitDecls(s) {
  const out = []; let depth = 0; let q = null; let cur = '';
  for (const ch of s) {
    if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '(') depth++; else if (ch === ')') depth--;
    else if (ch === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function transformBlock(body, prelude, stats) {
  if (/^@font-face/.test(prelude)) return body;
  const parts = splitDecls(body);
  const decls = parts.map((raw) => {
    const m = /^(\s*)([a-z-]+)(\s*:\s*)([\s\S]*?)(\s*!important)?(\s*)$/i.exec(raw);
    return m && !m[2].startsWith('--') ? { raw, lead: m[1], prop: m[2].toLowerCase(), sep: m[3], value: m[4], imp: m[5] || '', trail: m[6] } : { raw };
  });
  const has = (p) => decls.some((d) => d.prop === p);
  let pairedLh = null; let lhDecl = null;
  for (const d of decls) {
    if (!d.prop) continue;
    let v = d.value;
    if (d.prop === 'font-size') {
      const m = /^(\d*\.?\d+)px$/.exec(v.trim());
      if (m) { const n = fsName(Number(m[1])); v = `var(--fs-${n})`; pairedLh = `var(--lh-${n})`; stats.fontSize++; }
    } else if (d.prop === 'font-weight') {
      const t = /^(\d{3}|bold|normal)$/.test(v.trim()) ? weightTok(v.trim()) : null;
      if (t) { v = t; stats.fontWeight++; }
    } else if (d.prop === 'font') {
      const m = /^(?:(\d{3}|bold|normal)\s+)?(\d*\.?\d+)px(?:\/(\d*\.?\d+)(px)?)?\s+(.+)$/.exec(v.trim());
      if (m) {
        const n = fsName(Number(m[2]));
        const lh = m[3] == null ? '' : `/${m[4] ? `var(--lh-${n})` : m[3]}`;
        v = `${m[1] ? weightTok(m[1]) + ' ' : ''}var(--fs-${n})${lh} ${m[5]}`;
        stats.fontSize++;
      }
    } else if (d.prop === 'letter-spacing') {
      const t = /var\(/.test(v) ? null : lsTok(v);
      if (t) { v = t; stats.letterSpacing++; }
    } else if (d.prop === 'line-height') {
      lhDecl = d;
    } else if (SPACING_PROPS.test(d.prop)) {
      v = v.replace(/(^|[\s(,*+/])(-?)(\d*\.?\d+)px\b/g, (all, pre, neg, num) => {
        const px = Number(num);
        if (px === 1 && d.prop.startsWith('margin')) return all; // hairline border compensation stays literal
        const tok = spaceTok(px);
        stats.spacing++;
        if (tok === '0') return `${pre}0`;
        return neg ? `${pre}calc(${tok} * -1)` : `${pre}${tok}`;
      });
    } else if (/^border(-(top|bottom)-(left|right))?-radius$/.test(d.prop)) {
      v = v.replace(/(^|\s)(\d*\.?\d+)px\b/g, (all, pre, num) => { const t = radiusTok(Number(num)); if (!t) return all; stats.radius++; return `${pre}${t}`; });
    }
    if (v !== d.value) { d.value = v; d.changed = true; }
  }
  // A font-size that moved onto the scale takes its paired line height (unless the rule keeps a unitless one).
  if (pairedLh) {
    if (lhDecl && /^\d*\.?\d+px$/.test(lhDecl.value.trim())) { lhDecl.value = pairedLh; lhDecl.changed = true; stats.lineHeight++; }
    else if (!lhDecl && !has('font')) {
      const fsd = decls.find((d) => d.prop === 'font-size');
      fsd.extra = `; line-height: ${pairedLh}`; fsd.changed = true; stats.lineHeight++;
    }
  }
  return decls.map((d) => (d.changed ? `${d.lead}${d.prop}${d.sep}${d.value}${d.imp}${d.extra || ''}${d.trail}` : d.raw)).join(';');
}

function transformCss(src, stats, file) {
  const comments = [];
  const masked = src.replace(/\/\*[\s\S]*?\*\//g, (m) => `\u0000${comments.push(m) - 1}\u0000`);
  let out = ''; let last = 0; const stack = []; const re = /[{}]/g; let m;
  while ((m = re.exec(masked))) {
    const seg = masked.slice(last, m.index);
    if (m[0] === '{') { stack.push(seg.replace(/\u0000\d+\u0000/g, '').trim()); out += file === 'utilities.css' ? renameUtilitySelector(seg) : seg; out += '{'; }
    else { const pre = stack.pop() || ''; out += transformBlock(seg, pre, stats); out += '}'; }
    last = re.lastIndex;
  }
  out += masked.slice(last);
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => comments[Number(i)]);
  if (file === 'utilities.css') out = utilityFixups(out);
  return out;
}

// ---------------------------------------------------------------- utility class names (px-named)
function renameClass(name) {
  let m = /^(m|mt|mb|ml|mr|mx|my|p|pt|pb|pl|pr|px|py|gap)-(\d+)(?:-(\d+))?$/.exec(name);
  if (m) return `${m[1]}-${spacePx(Number(m[2]))}${m[3] != null ? `-${spacePx(Number(m[3]))}` : ''}`;
  m = /^fs-(\d+)$/.exec(name);
  if (m) return `fs-${fsName(Number(m[1]))}`;
  m = /^h-(\d+)$/.exec(name);
  if (m && Number(m[1]) >= 28 && Number(m[1]) <= 52) return `h-${nearest(CONTROL, Number(m[1]), true)[0]}`;
  return name;
}
const CLASS_RE = /(?<![\w-])((?:m|mt|mb|ml|mr|mx|my|p|pt|pb|pl|pr|px|py|gap)-\d+(?:-\d+)?|fs-\d+|h-\d+)(?![\w-])/g;
const renameUtilitySelector = (sel) => sel.replace(/\.([a-z][\w-]*)/g, (all, n) => `.${renameClass(n)}`);
function utilityFixups(css) {
  // .h-N utilities take the control-height token; identical rules produced by renames collapse to one.
  css = css.replace(/\.h-(32|40|48) \{ height: [^;}]+(!important)? ?;? ?\}/g, (all, n) => `.h-${n} { height: var(--control-${nearest(CONTROL, Number(n))[1]}) !important; }`);
  const seen = new Set();
  return css.split('\n').filter((line) => { const k = line.trim(); if (!/^\.[\w-]+ \{.*\}$/.test(k)) return true; if (seen.has(k)) return false; seen.add(k); return true; }).join('\n');
}
function transformJs(src, stats) {
  // Only inside class attribute values and class-list strings: class="…", class: '…', className = '…'.
  return src.replace(/(class(?:Name)?\s*[=:]\s*)(["'`])((?:(?!\2)[\s\S])*?)\2/g, (all, pre, q, body) => {
    const next = body.replace(CLASS_RE, (c) => { const r = renameClass(c); if (r !== c) stats.classes++; return r; });
    return `${pre}${q}${next}${q}`;
  });
}

// ---------------------------------------------------------------- run
function walk(dir, ext, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, acc); else if (ext.some((x) => e.name.endsWith(x))) acc.push(p);
  }
  return acc;
}
const stats = { fontSize: 0, fontWeight: 0, letterSpacing: 0, lineHeight: 0, spacing: 0, radius: 0, classes: 0 };
const changed = [];
for (const f of fs.readdirSync(ROOT).filter((n) => n.endsWith('.css'))) {
  const p = path.join(ROOT, f); const src = fs.readFileSync(p, 'utf8');
  const out = transformCss(src, stats, f);
  if (out !== src) { changed.push(path.relative(process.cwd(), p)); if (!CHECK) fs.writeFileSync(p, out); }
}
for (const p of [...walk(path.join(ROOT, 'js'), ['.js']), path.join(ROOT, 'index.html')]) {
  const src = fs.readFileSync(p, 'utf8'); const out = transformJs(src, stats);
  if (out !== src) { changed.push(path.relative(process.cwd(), p)); if (!CHECK) fs.writeFileSync(p, out); }
}
console.log(`${CHECK ? 'would change' : 'changed'} ${changed.length} file(s)${changed.length ? ':\n  ' + changed.join('\n  ') : ''}`);
console.log(Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' '));
if (CHECK && changed.length) process.exit(1);
