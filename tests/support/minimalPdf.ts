/**
 * minimalPdf — build a tiny, valid, uncompressed PDF entirely in memory so
 * PDF-handling tests exercise the real parser (unpdf/pdf.js) without committing
 * binary fixtures. One entry per page: a string draws that text on the page; a
 * null yields a page with an empty content stream (no text layer — the
 * scanned-image case as far as text extraction is concerned).
 */

function escapePdfString(text: string): string {
  return text.replace(/[\\()]/g, (ch) => `\\${ch}`);
}

export function buildMinimalPdf(pages: Array<string | null>): Buffer {
  if (pages.length === 0) throw new Error('buildMinimalPdf: at least one page required');
  const pageCount = pages.length;
  const fontObjId = 3 + 2 * pageCount;
  const kids = pages.map((_, i) => `${3 + 2 * i} 0 R`).join(' ');

  const objects: string[] = [];
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);
  pages.forEach((text, i) => {
    const pageId = 3 + 2 * i;
    const contentId = pageId + 1;
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`
    );
    const stream = text === null ? '' : `BT /F1 12 Tf 72 720 Td (${escapePdfString(text)}) Tj ET`;
    objects.push(
      `${contentId} 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`
    );
  });
  objects.push(
    `${fontObjId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`
  );

  const header = '%PDF-1.4\n';
  const offsets: number[] = [];
  let offset = Buffer.byteLength(header);
  for (const obj of objects) {
    offsets.push(offset);
    offset += Buffer.byteLength(obj);
  }
  const xrefStart = offset;
  const size = objects.length + 1;
  // Each xref entry must be exactly 20 bytes: 10-digit offset, space, 5-digit
  // generation, space, keyword, space, newline.
  const entries = ['0000000000 65535 f '];
  for (const o of offsets) entries.push(`${String(o).padStart(10, '0')} 00000 n `);
  const xref =
    `xref\n0 ${size}\n${entries.join('\n')}\n` +
    `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.concat([
    Buffer.from(header),
    ...objects.map((o) => Buffer.from(o)),
    Buffer.from(xref),
  ]);
}
