/**
 * File → workspace-doc conversion for the drop-to-import flow.
 *
 * Text-bearing files become regular docs: markdown/plain text passes
 * through as-is, data formats (json/csv/yaml/…) are wrapped in a fenced
 * code block so the doc renders them readably, and PDFs go through the
 * shared text-extraction helper (pdfTextExtraction — unpdf, a pure-JS
 * pdf.js build; works in the packaged sidecar where the Swift CLI used
 * by the pdf_extract agent tool may not be installed).
 */

import path from 'path';
import { AppError, DOC_IMPORT_EXTENSIONS } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { extractPdfText } from '@server/services/pdfTextExtraction';

/**
 * Data formats — fenced with this language tag so the doc renders
 * cleanly. Everything else in DOC_IMPORT_EXTENSIONS (the shared
 * accept-list the client drop filter also uses) imports as plain text,
 * so a client-accepted file always converts.
 */
const FENCED_EXTENSIONS: Record<string, string> = {
  '.json': 'json',
  '.jsonl': 'json',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
};

function importError(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

/**
 * Prose formats whose extension is dropped from the doc title
 * ("notes.md" → "notes"). Data formats keep it ("config.json" →
 * "config.json") — there the extension carries meaning the fenced
 * body alone doesn't surface in the tree.
 */
const TITLE_STRIP_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text', '.pdf']);

function titleFromName(name: string, ext: string): string {
  const base = TITLE_STRIP_EXTENSIONS.has(ext) ? path.basename(name, ext) : path.basename(name);
  const trimmed = base.trim();
  return trimmed || name.trim() || 'Imported doc';
}

function decodeText(name: string, data: Buffer): string {
  // NUL bytes never appear in legitimate utf-8 text — a binary payload
  // wearing a text extension fails here instead of producing a garbage doc.
  if (data.includes(0)) {
    throw importError(`"${name}" looks like binary data, not text.`);
  }
  return data.toString('utf8');
}

async function extractPdfTextForImport(name: string, data: Buffer): Promise<string> {
  // No page/char caps here: import is an explicit one-shot user action on one
  // file, unlike indexing, which sweeps whole folders and caps in fileSource.
  const result = await extractPdfText(data);
  if (!result.ok) {
    if (result.reason === 'no-text') {
      throw importError(
        `"${name}" contains no extractable text (scanned/image-only PDFs aren't supported).`
      );
    }
    throw importError(
      `Could not read "${name}" as a PDF${result.error ? `: ${result.error}` : ''}.`
    );
  }
  return result.text;
}

/**
 * Convert an uploaded file into doc fields. Throws a 400 AppError for
 * unsupported extensions, binary-masquerading text, or unreadable PDFs.
 */
export async function convertFileToDoc(
  name: string,
  data: Buffer
): Promise<{ title: string; content: string }> {
  const ext = path.extname(name).toLowerCase();
  const title = titleFromName(name, ext);

  if (!DOC_IMPORT_EXTENSIONS.has(ext)) {
    throw importError(
      `Unsupported file type "${ext || '(none)'}" — supported: ${[...DOC_IMPORT_EXTENSIONS].sort().join(', ')}.`
    );
  }
  if (ext === '.pdf') {
    return { title, content: await extractPdfTextForImport(name, data) };
  }
  const lang = FENCED_EXTENSIONS[ext];
  if (lang) {
    const body = decodeText(name, data).trim();
    return { title, content: `\`\`\`${lang}\n${body}\n\`\`\`` };
  }
  // Plain-text formats (.md/.txt/…) — the body IS the doc content.
  return { title, content: decodeText(name, data).trim() };
}
