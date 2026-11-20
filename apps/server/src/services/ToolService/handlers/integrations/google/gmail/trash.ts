import { google } from 'googleapis';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

export default async function handler(
  params: Record<string, unknown>,
  context: ToolHandlerContext
) {
  const { messageId, messageIds } = params as {
    messageId?: string;
    messageIds?: string[];
  };

  // Collect all IDs to process
  const ids: string[] = [];
  if (messageId) ids.push(messageId);
  if (Array.isArray(messageIds)) ids.push(...messageIds);

  if (ids.length === 0) {
    throw new Error('Provide either messageId (single) or messageIds (array) to trash.');
  }

  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const results: { id: string; status: string }[] = [];

  for (const id of ids) {
    try {
      await gmail.users.messages.trash({ userId: 'me', id });
      results.push({ id, status: 'trashed' });
    } catch (err: unknown) {
      results.push({ id, status: `error: ${getErrorMessage(err)}` });
    }
  }

  return {
    ok: true,
    trashed: results.filter((r) => r.status === 'trashed').length,
    failed: results.filter((r) => r.status !== 'trashed').length,
    results,
  };
}
