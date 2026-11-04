'use strict';
// Media uploads (CLONE_SPEC.md §32.6): PNG and JPEG only, recognised by their magic bytes (never by name or declared
// type), size- and dimension-limited, and always re-encoded from decoded pixels. Nothing of the uploaded file but its
// pixels survives: metadata (EXIF, XMP, ICC, text chunks, comments) is gone, and so is anything hidden in it
// (appended HTML or script, a second file format). Files that carry data after the image end, or markup anywhere in
// their bytes, are refused as polyglots. SVG and every other format are refused.
//   PNG   decoded here (chunk walk, CRC check, zlib inflate with an output cap, scanline unfiltering; colour types 0, 2,
//         3, 4, 6 at bit depths 1-16; interlaced files are refused), re-encoded as 8-bit RGBA with zlib.
//   JPEG  decoded and re-encoded with jpeg-js (pure JS, pinned; resolution and memory limits set).
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const jpeg = require('jpeg-js');

const LIMITS = { maxBytes: 8 * 1024 * 1024, maxSide: 4096, maxPixels: 16 * 1024 * 1024, minSide: 16 };
class ImageError extends Error { constructor(msg) { super(msg); this.code = 'invalid_image'; } }
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Long enough that compressed pixel data cannot match by chance.
const MARKUP = /<(script|html|svg[\s>/]|iframe|object|embed|body[\s>]|!doctype|\?php|\?xml)|javascript:/i;

// CRC-32 (PNG chunks).
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf, start = 0, end = buf.length) { let c = -1; for (let i = start; i < end; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head = buf.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml') || head.includes('<svg')) throw new ImageError('SVG images are not accepted; upload a PNG or JPEG');
  if (head.startsWith('gif8')) throw new ImageError('GIF images are not accepted; upload a PNG or JPEG');
  throw new ImageError('only PNG and JPEG images are accepted (the file content is not one)');
}
function checkDims(w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new ImageError('the image has no valid size');
  if (w > LIMITS.maxSide || h > LIMITS.maxSide || w * h > LIMITS.maxPixels) throw new ImageError(`images can be at most ${LIMITS.maxSide}×${LIMITS.maxSide} pixels`);
  if (w < LIMITS.minSide || h < LIMITS.minSide) throw new ImageError(`images must be at least ${LIMITS.minSide}×${LIMITS.minSide} pixels`);
}

// ------------------------------------------------------------------------------------------------ PNG
function decodePng(buf) {
  let off = 8; let ihdr = null; const idat = []; let palette = null; let trns = null; let ended = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('latin1', off + 4, off + 8);
    if (len > buf.length - off - 12) throw new ImageError('the PNG file is truncated');
    const dataStart = off + 8; const dataEnd = dataStart + len;
    if (crc32(buf, off + 4, dataEnd) !== buf.readUInt32BE(dataEnd)) throw new ImageError('the PNG file is corrupt (chunk checksum)');
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (len !== 13) throw new ImageError('the PNG header is invalid');
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
      checkDims(ihdr.w, ihdr.h);
      if (data[10] !== 0 || data[11] !== 0) throw new ImageError('the PNG uses an unknown compression or filter method');
      if (ihdr.interlace) throw new ImageError('interlaced PNGs are not supported; save the image without interlacing');
      const ok = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[ihdr.color];
      if (!ok || !ok.includes(ihdr.depth)) throw new ImageError('the PNG colour format is not supported');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { ended = true; off = dataEnd + 4; break; }
    off = dataEnd + 4;
  }
  if (!ihdr || !ended || !idat.length) throw new ImageError('the PNG file is incomplete');
  if (off !== buf.length) throw new ImageError('the file has extra data after the image (possible polyglot); it was refused');
  const { w, h, depth, color } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((w * channels * depth) / 8);
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * h + 1 }); } catch { throw new ImageError('the PNG image data is corrupt'); }
  if (raw.length < (stride + 1) * h) throw new ImageError('the PNG image data is truncated');
  const cur = Buffer.alloc(stride); const prev = Buffer.alloc(stride);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; } else if (ft !== 0) throw new ImageError('the PNG uses an unknown row filter');
      cur[i] = v & 0xff;
    }
    const sample = (x, ch) => { // channel value scaled to 0-255
      if (depth === 8) return cur[x * channels + ch];
      if (depth === 16) return cur[(x * channels + ch) * 2];
      const bit = (x * channels + ch) * depth; const byte = cur[bit >> 3]; const v = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      return color === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
    };
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (color === 6) { out[o] = sample(x, 0); out[o + 1] = sample(x, 1); out[o + 2] = sample(x, 2); out[o + 3] = sample(x, 3); } else if (color === 2) { out[o] = sample(x, 0); out[o + 1] = sample(x, 1); out[o + 2] = sample(x, 2); out[o + 3] = 255; } else if (color === 0) { const g = sample(x, 0); out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255; } else if (color === 4) { const g = sample(x, 0); out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = sample(x, 1); } else {
        const idx = sample(x, 0);
        if (!palette || idx * 3 + 2 >= palette.length) throw new ImageError('the PNG palette is invalid');
        out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2]; out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    cur.copy(prev);
  }
  return { width: w, height: h, data: out };
}
function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
  b.writeUInt32BE(crc32(b, 4, 8 + data.length), 8 + data.length);
  return b;
}
function encodePng({ width: w, height: h, data }) {
  const stride = w * 4; const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { // Paeth filter on every row
    const o = y * (stride + 1); raw[o] = 4;
    for (let i = 0; i < stride; i++) {
      const v = data[y * stride + i]; const a = i >= 4 ? data[y * stride + i - 4] : 0; const b = y ? data[(y - 1) * stride + i] : 0; const c = y && i >= 4 ? data[(y - 1) * stride + i - 4] : 0;
      const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      raw[o + 1 + i] = (v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------------------------------------ JPEG
function jpegEnd(buf) { // offset just past the EOI marker of the first image, walking segments and entropy data
  let i = 2;
  while (i + 2 <= buf.length) {
    if (buf[i] !== 0xff) throw new ImageError('the JPEG file is corrupt');
    const m = buf[i + 1];
    if (m === 0xd9) return i + 2;
    if (m === 0xff) { i += 1; continue; }
    if (m >= 0xd0 && m <= 0xd7) { i += 2; continue; }
    if (i + 4 > buf.length) break;
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
    if (m === 0xda) { // scan: skip entropy-coded data up to the next marker that is not a stuffed byte or restart
      while (i + 1 < buf.length && !(buf[i] === 0xff && buf[i + 1] !== 0x00 && !(buf[i + 1] >= 0xd0 && buf[i + 1] <= 0xd7))) i += 1;
    }
  }
  throw new ImageError('the JPEG file is incomplete');
}
function decodeJpeg(buf) {
  const end = jpegEnd(buf);
  if (buf.subarray(end).some((b) => b !== 0)) throw new ImageError('the file has extra data after the image (possible polyglot); it was refused');
  let img;
  try { img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: LIMITS.maxPixels / 1e6, maxMemoryUsageInMB: 256, tolerantDecoding: false }); } catch (e) { throw new ImageError(`the JPEG could not be decoded (${String(e.message || e).slice(0, 80)})`); }
  checkDims(img.width, img.height);
  return { width: img.width, height: img.height, data: img.data };
}
const encodeJpeg = (img, quality = 88) => Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data);

// ------------------------------------------------------------------------------------------------ resize (area average)
function resize(img, nw, nh) {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(nw * nh * 4);
  const sx = w / nw; const sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = y * sy; const y1 = y0 + sy;
    for (let x = 0; x < nw; x++) {
      const x0 = x * sx; const x1 = x0 + sx;
      let r = 0; let g = 0; let b = 0; let a = 0; let wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.min(h, Math.ceil(y1)); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.min(w, Math.ceil(x1)); xx++) {
          const wt = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0)); const o = (yy * w + xx) * 4; const al = data[o + 3] * wt;
          r += data[o] * al; g += data[o + 1] * al; b += data[o + 2] * al; a += al; wsum += wt;
        }
      }
      const o = (y * nw + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / wsum);
    }
  }
  return { width: nw, height: nh, data: out };
}
// Square icon on a padded background (maskable icons keep the logo inside the 80% safe zone).
function padSquare(img, size, padRatio, bg) {
  const inner = Math.max(1, Math.round(size * (1 - 2 * padRatio)));
  const r = resize(img, inner, inner);
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) { out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = bg[3]; }
  const off = Math.floor((size - inner) / 2);
  for (let y = 0; y < inner; y++) for (let x = 0; x < inner; x++) {
    const s = (y * inner + x) * 4; const d = ((y + off) * size + x + off) * 4; const al = r.data[s + 3] / 255;
    for (let c = 0; c < 3; c++) out[d + c] = Math.round(r.data[s + c] * al + out[d + c] * (1 - al));
    out[d + 3] = Math.max(out[d + 3], r.data[s + 3]);
  }
  return { width: size, height: size, data: out };
}

// Validates and re-encodes an upload. Returns { mime, ext, width, height, bytes: Buffer, sha256, pixels }.
function process(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new ImageError('the file is empty');
  if (buf.length > LIMITS.maxBytes) throw new ImageError(`images can be at most ${LIMITS.maxBytes / 1048576} MB`);
  const mime = sniff(buf);
  if (MARKUP.test(buf.toString('latin1'))) throw new ImageError('the file contains markup or script (possible polyglot); it was refused');
  const img = mime === 'image/png' ? decodePng(buf) : decodeJpeg(buf);
  const bytes = mime === 'image/png' ? encodePng(img) : encodeJpeg(img);
  return { mime, ext: mime === 'image/png' ? 'png' : 'jpg', width: img.width, height: img.height, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), pixels: img };
}

module.exports = { process, decodePng, encodePng, decodeJpeg, encodeJpeg, resize, padSquare, sniff, ImageError, LIMITS, crc32 };
