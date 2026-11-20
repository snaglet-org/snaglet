import { readFile } from 'node:fs/promises';
import { asNonEmptyString, requireString } from '@snaglet/shared/utils';
import { extractPdfDocument } from '@server/services/pdfTextExtraction';
import { resolvePathOrDownload } from '@server/services/ToolService/handlers/_shared';
import type { ToolHandler } from '@server/services/ToolService/types';

const tool: ToolHandler = async (input, settings) => {
  const source = requireString(input, 'source');
  const pages = asNonEmptyString(input.pages) ?? '';
  const includeMetadata = input.includeMetadata !== false;
  const resolved = await resolvePathOrDownload(source, settings, 'snaglet-pdf-extract', '.pdf');

  try {
    const data = await readFile(resolved.path);
    const extracted = await extractPdfDocument(data, { pageSpec: pages, includeMetadata });
    if (!extracted.ok) throw new Error(extracted.error ?? 'Unable to read PDF');
    return JSON.stringify({
      pageCount: extracted.pageCount,
      selectedPages: extracted.selectedPages,
      text: extracted.text,
      ...(includeMetadata ? { metadata: extracted.metadata } : {}),
    });
  } finally {
    await resolved.cleanup();
  }
};

export default tool;
