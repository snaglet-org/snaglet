import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface CreateDocInput {
  title?: string;
  body?: string;
}

const tool = async (input: CreateDocInput, _context: ToolHandlerContext): Promise<string> => {
  const title = input.title?.trim();
  if (!title) {
    throw new Error('title is required');
  }

  const auth = await getGoogleClient();
  const docs = google.docs({ version: 'v1', auth });

  const created = await docs.documents.create({
    requestBody: { title },
  });

  const documentId = created.data.documentId;
  if (!documentId) {
    throw new Error('Google Docs API did not return a document id');
  }

  const body = input.body?.length ? input.body : '';
  if (body) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: body,
            },
          },
        ],
      },
    });
  }

  return JSON.stringify({
    created: true,
    documentId,
    title: created.data.title ?? title,
    bodyInserted: Boolean(body),
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  });
};

export default tool;
