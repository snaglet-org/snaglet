/**
 * extractPdfText — the shared server-side PDF → text helper, exercised against
 * real PDFs built in memory (tests/support/minimalPdf) and parsed by the real
 * unpdf/pdf.js path: text layer extracted with per-page joins, page/char caps
 * mark truncation, image-only PDFs resolve to no-text, and corrupt input
 * resolves to unreadable — never a throw.
 */

import { describe, expect, it } from '@jest/globals';
import {
  extractPdfDocument,
  extractPdfText,
  resolvePdfPageRange,
} from '@server/services/pdfTextExtraction';
import { buildMinimalPdf } from '../../../../support/minimalPdf';

describe('extractPdfText', () => {
  it('extracts the text layer, one blank-line-joined block per page', async () => {
    const pdf = buildMinimalPdf(['Hello searchable PDF', 'Second page of prose']);
    const result = await extractPdfText(pdf);
    expect(result).toMatchObject({
      ok: true,
      totalPages: 2,
      extractedPages: 2,
      truncated: false,
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.text).toContain('Hello searchable PDF');
    expect(result.text).toContain('Second page of prose');
    // Page boundary must survive as a real newline (unlike unpdf mergePages,
    // which collapses all whitespace) so the chunker sees structure.
    expect(result.text.indexOf('Hello searchable PDF')).toBeLessThan(
      result.text.indexOf('Second page of prose')
    );
    expect(result.text).toMatch(/Hello searchable PDF\s*\n/);
  });

  it('is deterministic for identical bytes (content-addressing contract)', async () => {
    const pdf = buildMinimalPdf(['Stable bytes, stable text']);
    const a = await extractPdfText(pdf);
    const b = await extractPdfText(pdf);
    expect(a).toEqual(b);
  });

  it('stops at maxPages and reports truncation', async () => {
    const pdf = buildMinimalPdf(['page one', 'page two', 'page three']);
    const result = await extractPdfText(pdf, { maxPages: 2 });
    expect(result).toMatchObject({ ok: true, totalPages: 3, extractedPages: 2, truncated: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.text).toContain('page two');
    expect(result.text).not.toContain('page three');
  });

  it('resolves selected page ranges once the document page count is known', async () => {
    const pdf = buildMinimalPdf(['first page', 'second page', 'third page']);
    const result = await extractPdfDocument(pdf, { pageSpec: '3, 1-2, 9, invalid' });
    expect(result).toMatchObject({ ok: true, pageCount: 3, selectedPages: [1, 2, 3] });
    if (!result.ok) throw new Error('unreachable');
    expect(result.text).toContain('first page');
    expect(result.text).toContain('third page');
  });

  it('keeps invalid page-range segments empty rather than selecting arbitrary pages', () => {
    expect(resolvePdfPageRange('bad,-2,0,8', 3)).toEqual([]);
  });

  it('cuts at maxChars and reports truncation', async () => {
    const pdf = buildMinimalPdf(['alpha beta gamma delta epsilon']);
    const result = await extractPdfText(pdf, { maxChars: 10 });
    expect(result).toMatchObject({ ok: true, truncated: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.text.length).toBeLessThanOrEqual(10);
    expect(result.text.startsWith('alpha')).toBe(true);
  });

  it('resolves no-text for a PDF without a text layer (never OCR, never throw)', async () => {
    const pdf = buildMinimalPdf([null]);
    const result = await extractPdfText(pdf);
    expect(result).toEqual({ ok: false, reason: 'no-text', totalPages: 1 });
  });

  it('resolves unreadable for bytes that are not a PDF', async () => {
    const result = await extractPdfText(Buffer.from('definitely not a pdf'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unreadable');
    expect(result.error).toBeTruthy();
  });
});
