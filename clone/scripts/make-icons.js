#!/usr/bin/env node
'use strict';
// App icons for the web app manifest (CLONE_SPEC.md §31). An original "P" mark, drawn from the same geometry as the
// SVG below and rasterised here with no dependencies (4×4 supersampling, PNG written with node:zlib). Re-run after
// changing the mark; the PNGs are committed so the server and the build need nothing extra.
//
//   node scripts/make-icons.js          write public/icons/*
//   node scripts/make-icons.js --check  exit 1 when a committed icon differs from what this script draws
//
// Output: icon.svg (any size), icon-192.png and icon-512.png (rounded tile, transparent corners), icon-maskable-512.png
// (full-bleed tile, mark inside the 80% safe zone), apple-touch-icon.png (180, opaque; iOS rounds it), badge-72.png
// (white mark on transparency for the Android status bar).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const BRAND = [0x00, 0x87, 0x51]; // Nigerian green, the light-theme --brand (CLONE_SPEC §27.6)
const WHITE = [0xff, 0xff, 0xff];

// The mark in a 32-unit box: a stem, two bars and a half ring (stroke 3.2), centred.
const G = { stemL: 8.15, stemR: 11.35, top: 7.2, bottom: 24.8, barTopB: 10.4, barBotT: 17.2, barBotB: 20.4, cx: 17.25, cy: 13.8, rIn: 3.4, rOut: 6.6 };
function inMark(x, y) {
  if (x >= G.stemL && x <= G.stemR && y >= G.top && y <= G.bottom) return true;
  if (x >= G.stemL && x <= G.cx && ((y >= G.top && y <= G.barTopB) || (y >= G.barBotT && y <= G.barBotB))) return true;
  if (x >= G.cx) { const d = Math.hypot(x - G.cx, y - G.cy); return d >= G.rIn && d <= G.rOut; }
  return false;
}
function inRoundRect(x, y, r) {
  const qx = Math.max(Math.abs(x - 16) - (16 - r), 0); const qy = Math.max(Math.abs(y - 16) - (16 - r), 0);
  return x >= 0 && x <= 32 && y >= 0 && y <= 32 && Math.hypot(qx, qy) <= r;
}

const SVG = (rx) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="${rx}" fill="#008751"/><path fill="#fff" fill-rule="evenodd" d="M8.15 7.2H17.25A6.6 6.6 0 0 1 17.25 20.4H11.35V24.8H8.15ZM11.35 10.4V17.2H17.25A3.4 3.4 0 0 0 17.25 10.4Z"/></svg>\n`;

// variant: 'tile' (rounded, transparent corners), 'full' (opaque square), 'badge' (white mark only).
function draw(size, variant, scale = 1) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sj = 0; sj < S; sj++) {
        for (let si = 0; si < S; si++) {
          const x = ((i + (si + 0.5) / S) / size) * 32; const y = ((j + (sj + 0.5) / S) / size) * 32;
          const mx = 16 + (x - 16) / scale; const my = 16 + (y - 16) / scale;
          const mark = inMark(mx, my);
          let c = null;
          if (variant === 'badge') c = mark ? WHITE : null;
          else if (variant === 'full' || inRoundRect(x, y, 7)) c = mark ? WHITE : BRAND;
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const o = (j * size + i) * 4;
      if (a) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
      px[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return png(size, size, px);
}

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const FILES = {
  'icon.svg': () => Buffer.from(SVG(7)),
  'icon-192.png': () => draw(192, 'tile'),
  'icon-512.png': () => draw(512, 'tile'),
  'icon-maskable-512.png': () => draw(512, 'full', 0.82),
  'apple-touch-icon.png': () => draw(180, 'full', 0.9),
  'badge-72.png': () => draw(72, 'badge', 1.15),
};

if (require.main === module) {
  const check = process.argv.includes('--check');
  fs.mkdirSync(OUT, { recursive: true });
  let diff = 0;
  for (const [name, make] of Object.entries(FILES)) {
    const buf = make(); const file = path.join(OUT, name);
    if (check) { if (!fs.existsSync(file) || !fs.readFileSync(file).equals(buf)) { console.error(`differs: ${name}`); diff++; } } else fs.writeFileSync(file, buf);
  }
  if (check) { if (diff) process.exit(1); console.log('icons up to date'); } else console.log(`wrote ${Object.keys(FILES).length} icons to public/icons/`);
}

module.exports = { FILES, inMark };
