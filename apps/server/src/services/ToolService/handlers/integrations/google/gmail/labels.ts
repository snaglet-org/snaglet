import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

export default async function handler(
  _params: Record<string, unknown>,
  context: ToolHandlerContext
) {
  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.labels.list({ userId: 'me' });
  const labels = res.data.labels ?? [];

  const detailed = await Promise.all(
    labels.map(async (label) => {
      try {
        const detail = await gmail.users.labels.get({
          userId: 'me',
          id: label.id!,
        });
        return {
          id: detail.data.id,
          name: detail.data.name,
          type: detail.data.type,
          messagesTotal: detail.data.messagesTotal ?? 0,
          messagesUnread: detail.data.messagesUnread ?? 0,
          threadsTotal: detail.data.threadsTotal ?? 0,
          threadsUnread: detail.data.threadsUnread ?? 0,
        };
      } catch {
        return {
          id: label.id,
          name: label.name,
          type: label.type,
          messagesTotal: 0,
          messagesUnread: 0,
          threadsTotal: 0,
          threadsUnread: 0,
        };
      }
    })
  );

  return {
    ok: true,
    count: detailed.length,
    labels: detailed,
  };
}
