'use strict';
// Share-card images (PLAN P8.3, CLONE_SPEC.md §38.4): 1200 × 630 PNG for Open Graph and X cards, drawn in pure JavaScript
// (no canvas, no native module, no external service) with a built-in 5 × 7 bitmap font and encoded by the CMS PNG encoder
// (server/cms/images.js). Colours come from the CMS brand (light theme brand and YES colours, §32.8).
const { encodePng } = require('./cms/images');

// 5 × 7 glyphs, one string per row ('#' = ink). Lower case is drawn as upper case; unknown characters as a space.
const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'], B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'], D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'], F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'], H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'], J: ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'], L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'], N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'], R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'], T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'], X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'], Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'], 1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'], 3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'], 5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'], 7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'], 9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'], ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'], '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'], '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  '%': ['##...', '##..#', '...#.', '..#..', '.#...', '#..##', '...##'], '/': ['.....', '....#', '...#.', '..#..', '.#...', '#....', '.....'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'], ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'], '"': ['.#.#.', '.#.#.', '.....', '.....', '.....', '.....', '.....'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'], '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'], '@': ['.###.', '#...#', '#.###', '#.#.#', '#.###', '#....', '.###.'],
  '$': ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'], '¢': ['..#..', '.###.', '#.#..', '#.#..', '#.#..', '.###.', '..#..'],
  '₦': ['#...#', '##..#', '#####', '#.#.#', '#####', '#..##', '#...#'], '·': ['.....', '.....', '.....', '..#..', '.....', '.....', '.....'],
  '—': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'], '–': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '›': ['.....', '.#...', '..#..', '...#.', '..#..', '.#...', '.....'], '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
};
const W = 1200; const H = 630;
const hex = (c, def) => { const m = /^#([0-9a-f]{6})$/i.exec(String(c || '')); const v = m ? m[1] : def; return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]; };

function canvas(bg) {
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255; }
  const rect = (x, y, w, h, c) => {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) { const o = (yy * W + xx) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; }
  };
  const glyph = (ch) => FONT[ch] || FONT[String(ch).toUpperCase()] || null;
  // Text at (x, y) with `scale` pixels per font dot; returns the x after the text.
  const text = (s, x, y, scale, c) => {
    let cx = x;
    for (const ch of String(s)) {
      const g = glyph(ch);
      if (g) for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++) if (g[r][k] === '#') rect(cx + k * scale, y + r * scale, scale, scale, c);
      cx += 6 * scale;
    }
    return cx;
  };
  const width = (s, scale) => [...String(s)].length * 6 * scale;
  return { data, rect, text, width };
}
// Greedy word wrap to `max` characters per line, at most `lines` lines (the last one ellipsed).
function wrap(s, max, lines) {
  const words = String(s || '').replace(/\s+/g, ' ').trim().split(' ');
  const out = []; let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = w.length > max ? `${w.slice(0, max - 1)}.` : w;
    if (out.length === lines) break;
  }
  if (cur && out.length < lines) out.push(cur);
  if (out.length > lines) out.length = lines;
  const used = out.join(' ').length;
  if (used < String(s || '').trim().length && out.length) { const last = out[out.length - 1]; out[out.length - 1] = `${last.slice(0, Math.max(0, max - 3))}...`; }
  return out;
}

// card: { app, title, chance (0-100 or null), yes, no (labels), footer, brand, yesColor }
function renderCard(card) {
  const ink = [244, 245, 247]; const faint = [168, 174, 184]; const bgc = [13, 14, 17];
  const brand = hex(card.brand, '13a866'); const yes = hex(card.yesColor, '22c3b5');
  const c = canvas(bgc);
  c.rect(0, 0, W, 14, brand);
  c.rect(60, 60, 64, 64, brand); // logo block
  c.text('P', 74, 70, 7, bgc);
  c.text(card.app || 'Parlance', 150, 74, 6, ink);
  let y = 180;
  for (const line of wrap(card.title, 30, 3)) { c.text(line, 60, y, 7, ink); y += 7 * 9; }
  if (card.chance != null) {
    const s = String(card.chanceLabel || `${card.chance}%`);
    c.text(s, 60, 440, 10, yes);
    const bw = 1080; const filled = Math.round((Math.max(0, Math.min(100, card.chance)) / 100) * bw);
    c.rect(60, 530, bw, 16, [40, 44, 52]); c.rect(60, 530, filled, 16, yes);
  }
  if (card.yes || card.no) {
    let x = card.chance != null ? 60 + c.width(String(card.chanceLabel || `${card.chance}%`), 10) + 48 : 60;
    if (card.yes) { x = c.text(card.yes, x, 466, 5, yes) + 36; }
    if (card.no) c.text(card.no, x, 466, 5, faint);
  }
  if (card.footer) c.text(wrap(card.footer, 45, 1)[0] || '', 60, 572, 4, faint);
  return encodePng({ width: W, height: H, data: c.data });
}

module.exports = { renderCard, wrap, FONT, W, H };
