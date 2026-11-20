import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

export default async function handler(
  params: Record<string, unknown>,
  context: ToolHandlerContext
) {
  const { messageId, messageIds, addLabelIds, removeLabelIds } = params as {
    messageId?: string;
    messageIds?: string[];
    addLabelIds?: string[];
    removeLabelIds?: string[];
  };

  const ids: string[] = [];
  if (messageId) ids.push(messageId);
  if (Array.isArray(messageIds)) ids.push(...messageIds);

  if (ids.length === 0) {
    throw new Error('Provide either messageId (single) or messageIds (array).');
  }

  const add = Array.isArray(addLabelIds) ? addLabelIds : [];
  const remove = Array.isArray(removeLabelIds) ? removeLabelIds : [];

  if (add.length === 0 && remove.length === 0) {
    throw new Error('Provide at least one of addLabelIds or removeLabelIds.');
  }

  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: 'v1', auth });

  // For batch operations (>1 message), use batchModify
  if (ids.length > 1) {
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids,
        addLabelIds: add.length > 0 ? add : undefined,
        removeLabelIds: remove.length > 0 ? remove : undefined,
      },
    });

    return {
      ok: true,
      modified: ids.length,
      addedLabels: add,
      removedLabels: remove,
    };
  }

  // Single message
  const result = await gmail.users.messages.modify({
    userId: 'me',
    id: ids[0],
    requestBody: {
      addLabelIds: add.length > 0 ? add : undefined,
      removeLabelIds: remove.length > 0 ? remove : undefined,
    },
  });

  return {
    ok: true,
    messageId: result.data.id,
    labelIds: result.data.labelIds,
    addedLabels: add,
    removedLabels: remove,
  };
}
