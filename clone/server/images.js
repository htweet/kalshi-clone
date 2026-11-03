'use strict';
// Identity-document image intake (PLAN P3.1a, A1; CLONE_SPEC.md §25.4). No image library is used: the browser
// re-encodes every capture through a canvas (which drops EXIF, GPS and maker notes), and the server then
//   1. sniffs the type from the bytes (JPEG or PNG only; the declared type and file name are ignored),
//   2. walks the container structure and rewrites it with only the segments needed to show the picture — every
//      metadata segment (EXIF/XMP/ICC/IPTC APPn, comments, PNG text/time/eXIf chunks) is dropped,
//   3. drops anything after the end-of-image marker (polyglot / appended payloads),
//   4. checks the dimensions (min 200 px, max 8000 px a side) and the size cap.
// The result is what gets encrypted and stored (server/docv.js); the original bytes are never written anywhere.
const crypto = require('node:crypto');

const MAX_BYTES = 6 * 1024 * 1024;
const MIN_SIDE = 200;
const MAX_SIDE = 8000;

class ImageError extends Error { constructor(msg) { super(msg); this.code = 'image_invalid'; } }

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

// A clean JFIF APP0 segment (version 1.01, no thumbnail, aspect 1:1).
const JFIF = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
// Segments kept: tables and frame/scan headers needed to decode (DQT, DHT, DAC, DRI, SOFn). APP0–APP15 and COM go.
const KEEP = new Set([0xdb, 0xc4, 0xcc, 0xdd, ...SOF]);

function cleanJpeg(buf) {
  const out = [Buffer.from([0xff, 0xd8]), JFIF];
  let pos = 2; let width = 0; let height = 0; let sawSof = false;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) throw new ImageError('corrupt JPEG');
    while (buf[pos] === 0xff) pos += 1; // fill bytes
    const marker = buf[pos++];
    if (marker === undefined) throw new ImageError('truncated JPEG');
    if (marker === 0xd9) throw new ImageError('JPEG has no image data');
    if (marker >= 0xd0 && marker <= 0xd7) continue; // stray RST
    if (pos + 2 > buf.length) throw new ImageError('truncated JPEG');
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) throw new ImageError('corrupt JPEG segment');
    const seg = buf.subarray(pos - 2, pos + len); // marker (2 bytes) + length + payload
    if (SOF.has(marker)) {
      if (len < 8) throw new ImageError('corrupt JPEG frame header');
      height = buf.readUInt16BE(pos + 3); width = buf.readUInt16BE(pos + 5); sawSof = true;
    }
    if (marker === 0xda) {
      if (!sawSof) throw new ImageError('JPEG scan before frame header');
      // Start of scan: copy the scan header and the entropy-coded data up to and including the end-of-image marker.
      let end = pos + len;
      let eoi = -1;
      for (let i = end; i < buf.length - 1; i++) {
        if (buf[i] === 0xff && buf[i + 1] === 0xd9) { eoi = i; break; }
      }
      if (eoi < 0) throw new ImageError('truncated JPEG (no end marker)');
      out.push(Buffer.from([0xff, marker]), buf.subarray(pos, eoi + 2));
      end = eoi + 2; // anything after EOI is discarded
      return { data: Buffer.concat(out), width, height };
    }
    if (KEEP.has(marker)) out.push(Buffer.concat([Buffer.from([0xff, marker]), seg.subarray(2)]));
    pos += len;
  }
  throw new ImageError('truncated JPEG');
}

// CRC-32 (PNG chunk check).
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

function cleanPng(buf) {
  const out = [buf.subarray(0, 8)];
  let pos = 8; let width = 0; let height = 0; let first = true;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (len > buf.length || pos + 12 + len > buf.length) throw new ImageError('corrupt PNG chunk');
    const body = buf.subarray(pos + 4, pos + 8 + len);
    if (crc32(body) !== buf.readUInt32BE(pos + 8 + len)) throw new ImageError('corrupt PNG (bad checksum)');
    if (first) {
      if (type !== 'IHDR' || len !== 13) throw new ImageError('PNG must start with IHDR');
      width = buf.readUInt32BE(pos + 8); height = buf.readUInt32BE(pos + 12); first = false;
    }
    if (PNG_KEEP.has(type)) out.push(buf.subarray(pos, pos + 12 + len));
    pos += 12 + len;
    if (type === 'IEND') return { data: Buffer.concat(out), width, height }; // trailing bytes discarded
  }
  throw new ImageError('truncated PNG (no IEND)');
}

// Returns { mime, data, width, height, sha256 } or throws ImageError with a user-safe message.
function sanitizeImage(input) {
  if (!Buffer.isBuffer(input) || !input.length) throw new ImageError('the image is empty');
  if (input.length > MAX_BYTES) throw new ImageError(`the image is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  const mime = sniff(input);
  if (!mime) throw new ImageError('upload a photo (JPEG or PNG)');
  const r = mime === 'image/jpeg' ? cleanJpeg(input) : cleanPng(input);
  if (!(r.width >= MIN_SIDE && r.height >= MIN_SIDE)) throw new ImageError(`the photo is too small (at least ${MIN_SIDE}×${MIN_SIDE} pixels)`);
  if (r.width > MAX_SIDE || r.height > MAX_SIDE) throw new ImageError(`the photo is too large (at most ${MAX_SIDE} pixels a side)`);
  return { mime, data: r.data, width: r.width, height: r.height, sha256: crypto.createHash('sha256').update(r.data).digest('hex') };
}

module.exports = { sanitizeImage, sniff, cleanJpeg, cleanPng, crc32, ImageError, MAX_BYTES };
