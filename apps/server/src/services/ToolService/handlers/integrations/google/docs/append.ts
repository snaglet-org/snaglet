import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface AppendDocArgs {
  documentId: string;
  text: string;
}

export default async function googleDocsAppend(
  args: AppendDocArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { documentId, text } = args;

  if (!documentId || typeof documentId !== 'string') {
    throw new Error('documentId is required');
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('text is required and must be a non-empty string');
  }

  const auth = await getGoogleClient();
  const docs = google.docs({ version: 'v1', auth });

  // Find the current end of the document body. The body's content array ends
  // with a segment whose endIndex is the document length; the last valid
  // insertion index is endIndex - 1 (the trailing newline of the body).
  const doc = await docs.documents.get({ documentId });
  const content = doc.data.body?.content ?? [];
  let endIndex = 1;
  for (const el of content) {
    if (typeof el.endIndex === 'number' && el.endIndex > endIndex) {
      endIndex = el.endIndex;
    }
  }
  const insertIndex = Math.max(1, endIndex - 1);

  await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: insertIndex },
            text,
          },
        },
      ],
    },
  });

  return JSON.stringify({
    documentId,
    appended: true,
    insertedAt: insertIndex,
    insertedChars: text.length,
  });
}
