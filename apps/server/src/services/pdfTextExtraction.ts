/**
 * Cross-platform PDF text extraction for indexing, document import, and the
 * builtin PDF tool. The parser is unpdf/pdf.js, so packaged sidecars do not
 * depend on a native PDF toolchain.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

export interface ExtractPdfTextOptions {
  /** Stop extracting after this many pages. Omit for no page limit. */
  maxPages?: number;
  /** Cap extracted text length. Omit for no cap. */
  maxChars?: number;
}

interface PdfDocumentMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  creator: string | null;
  keywords: string | null;
}

export interface ExtractPdfDocumentOptions extends ExtractPdfTextOptions {
  /** One-indexed pages to read. Omit to read every page. */
  pageNumbers?: readonly number[];
  /** A user-facing page range such as `1-3,5`. */
  pageSpec?: string;
  /** Include conventional PDF information-dictionary fields. */
  includeMetadata?: boolean;
}

export type PdfTextExtraction =
  | {
      ok: true;
      text: string;
      totalPages: number;
      extractedPages: number;
      truncated: boolean;
    }
  | {
      ok: false;
      reason: 'no-text' | 'unreadable';
      totalPages?: number;
      error?: string;
    };

export type PdfDocumentExtraction =
  | {
      ok: true;
      text: string;
      pageCount: number;
      selectedPages: number[];
      truncated: boolean;
      metadata?: PdfDocumentMetadata;
    }
  | {
      ok: false;
      reason: 'unreadable';
      pageCount?: number;
      error?: string;
    };

type PdfDocument = Awaited<ReturnType<(typeof import('unpdf'))['getDocumentProxy']>>;

function isTextItem<T>(item: T): item is Extract<T, { str: string }> {
  return (
    typeof item === 'object' && item !== null && typeof (item as { str?: unknown }).str === 'string'
  );
}

function metadataString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

async function readPdfMetadata(pdf: PdfDocument): Promise<PdfDocumentMetadata> {
  const { info } = await pdf.getMetadata();
  const record = info as Record<string, unknown>;
  return {
    title: metadataString(record.Title),
    author: metadataString(record.Author),
    subject: metadataString(record.Subject),
    creator: metadataString(record.Creator),
    keywords: metadataString(record.Keywords),
  };
}

/** Resolve a page range such as `1-3,5` against a one-indexed page count. */
export function resolvePdfPageRange(spec: string, pageCount: number): number[] {
  const trimmed = spec.trim();
  if (!trimmed) return Array.from({ length: pageCount }, (_, index) => index + 1);

  const pages = new Set<number>();
  for (const part of trimmed.split(',')) {
    const segment = part.trim();
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(segment);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const lower = Math.max(1, Math.min(start, end));
      const upper = Math.min(pageCount, Math.max(start, end));
      for (let page = lower; page <= upper; page += 1) pages.add(page);
      continue;
    }
    if (/^\d+$/.test(segment)) {
      const page = Number(segment);
      if (page >= 1 && page <= pageCount) pages.add(page);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Parse a PDF once for callers that need page selection or metadata in
 * addition to text. `extractPdfText` below preserves the indexing-facing
 * no-text result contract on top of this lower-level result.
 */
export async function extractPdfDocument(
  data: Buffer | Uint8Array,
  options: ExtractPdfDocumentOptions = {}
): Promise<PdfDocumentExtraction> {
  const { maxPages, maxChars, pageNumbers, pageSpec, includeMetadata = false } = options;

  let pdf: PdfDocument;
  try {
    const { getDocumentProxy } = await import('unpdf');
    // pdf.js can transfer/detach the supplied buffer; callers may retain it.
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch (err) {
    return { ok: false, reason: 'unreadable', error: getErrorMessage(err) };
  }

  try {
    const pageCount = pdf.numPages;
    const requestedPages = pageNumbers
      ? [...new Set(pageNumbers)]
          .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
          .sort((a, b) => a - b)
      : pageSpec === undefined
        ? Array.from({ length: pageCount }, (_, index) => index + 1)
        : resolvePdfPageRange(pageSpec, pageCount);
    const selectedPages =
      maxPages === undefined ? requestedPages : requestedPages.slice(0, Math.max(0, maxPages));
    const texts: string[] = [];
    let chars = 0;
    let truncated = selectedPages.length < requestedPages.length;

    for (const pageNumber of selectedPages) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .filter(isTextItem)
        .map((item) => item.str + (item.hasEOL === true ? '\n' : ''))
        .join('');
      texts.push(pageText);
      chars += pageText.length;
      if (maxChars !== undefined && chars >= maxChars) {
        truncated ||= selectedPages.length > texts.length;
        break;
      }
    }

    let text = texts.join('\n\n').trim();
    if (maxChars !== undefined && text.length > maxChars) {
      text = text.slice(0, maxChars).trimEnd();
      truncated = true;
    }
    const metadata = includeMetadata ? await readPdfMetadata(pdf) : undefined;
    return {
      ok: true,
      text,
      pageCount,
      selectedPages: selectedPages.slice(0, texts.length),
      truncated,
      ...(metadata ? { metadata } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'unreadable',
      pageCount: pdf.numPages,
      error: getErrorMessage(err),
    };
  } finally {
    void pdf.destroy().catch((err: unknown) => {
      logger.warn(`[pdf-extract] pdf.destroy() failed: ${getErrorMessage(err)}`);
    });
  }
}

/**
 * Extract the text layer for indexing/import. This keeps the pre-existing
 * no-text and truncation contract while sharing the parser with the PDF tool.
 */
export async function extractPdfText(
  data: Buffer | Uint8Array,
  options: ExtractPdfTextOptions = {}
): Promise<PdfTextExtraction> {
  const extracted = await extractPdfDocument(data, options);
  if (!extracted.ok) {
    return {
      ok: false,
      reason: 'unreadable',
      ...(extracted.pageCount === undefined ? {} : { totalPages: extracted.pageCount }),
      ...(extracted.error ? { error: extracted.error } : {}),
    };
  }
  if (!extracted.text) return { ok: false, reason: 'no-text', totalPages: extracted.pageCount };
  return {
    ok: true,
    text: extracted.text,
    totalPages: extracted.pageCount,
    extractedPages: extracted.selectedPages.length,
    truncated: extracted.truncated,
  };
}
