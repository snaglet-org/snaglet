import { google } from 'googleapis';
import type { docs_v1 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface ReadDocArgs {
  documentId: string;
}

function extractParagraphText(paragraph: docs_v1.Schema$Paragraph): string {
  const elements = paragraph.elements ?? [];
  let text = '';
  for (const el of elements) {
    if (el.textRun?.content) {
      text += el.textRun.content;
    }
  }
  return text;
}

function extractStructuralElements(
  elements: docs_v1.Schema$StructuralElement[] | undefined
): string {
  if (!elements) return '';
  let text = '';
  for (const el of elements) {
    if (el.paragraph) {
      text += extractParagraphText(el.paragraph);
    } else if (el.table) {
      const rows = el.table.tableRows ?? [];
      for (const row of rows) {
        const cells = row.tableCells ?? [];
        for (const cell of cells) {
          text += extractStructuralElements(cell.content);
        }
      }
    } else if (el.tableOfContents) {
      text += extractStructuralElements(el.tableOfContents.content);
    }
  }
  return text;
}

export default async function googleDocsRead(
  args: ReadDocArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { documentId } = args;

  if (!documentId || typeof documentId !== 'string') {
    throw new Error('documentId is required');
  }

  const auth = await getGoogleClient();
  const docs = google.docs({ version: 'v1', auth });

  const res = await docs.documents.get({ documentId });

  const title = res.data.title ?? '';
  const content = extractStructuralElements(res.data.body?.content);

  return JSON.stringify({
    documentId,
    title,
    content,
    charCount: content.length,
  });
}
