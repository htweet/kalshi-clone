'use strict';
// A minimal PDF 1.4 writer for the simulated yearly statements (PLAN A5; PHASE3_SPEC.md §25.9). One or more A4/Letter
// pages of left-aligned text in the standard Helvetica fonts (no embedding, no images, no scripts, no forms): every
// object is written by hand and the cross-reference table is computed from the byte offsets.
const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 54;

// Standard-14 fonts use WinAnsi; keep to printable ASCII so no glyph is missing, and escape PDF string delimiters.
const pdfText = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
  .replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');

// lines: [{ text, size = 10, bold = false, gap = 0 (extra space before) }]
function textPdf(lines, { title = 'Statement' } = {}) {
  const pages = [];
  let cur = [];
  let y = PAGE_H - MARGIN;
  for (const l of lines) {
    const size = l.size || 10;
    const step = size * 1.45 + (l.gap || 0);
    if (y - step < MARGIN) { pages.push(cur); cur = []; y = PAGE_H - MARGIN; }
    y -= step;
    cur.push({ ...l, size, y });
  }
  pages.push(cur);

  const objs = []; // index i → object number i + 1
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null); // filled once the page tree number is known
  const pagesObj = add(null);
  const fontR = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title (${pdfText(title)}) /Producer (Parlance Exchange statement writer) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
  const kids = [];
  pages.forEach((pl, i) => {
    const ops = ['BT'];
    for (const l of pl) ops.push(`/${l.bold ? 'F2' : 'F1'} ${l.size} Tf 1 0 0 1 ${MARGIN} ${l.y.toFixed(2)} Tm (${pdfText(l.text)}) Tj`);
    ops.push(`/F1 8 Tf 1 0 0 1 ${MARGIN} ${MARGIN / 2} Tm (${pdfText(`${title} - page ${i + 1} of ${pages.length}`)}) Tj`, 'ET');
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontR} 0 R /F2 ${fontB} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { textPdf, pdfText };
