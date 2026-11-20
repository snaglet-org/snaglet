import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

export default async function handler(
  params: Record<string, unknown>,
  context: ToolHandlerContext
) {
  const { to, subject, body, cc, bcc, inReplyTo } = params as {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    inReplyTo?: string;
  };

  if (!to || typeof to !== 'string') {
    throw new Error('to is required and must be a string.');
  }
  if (!subject || typeof subject !== 'string') {
    throw new Error('subject is required and must be a string.');
  }
  if (!body || typeof body !== 'string') {
    throw new Error('body is required and must be a string.');
  }

  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const myEmail = profile.data.emailAddress ?? '';

  let threadId: string | undefined;
  let replyHeaders: string[] = [];

  // If replying to an existing message, fetch its headers
  if (inReplyTo) {
    try {
      const original = await gmail.users.messages.get({
        userId: 'me',
        id: inReplyTo,
        format: 'metadata',
        metadataHeaders: ['Message-ID'],
      });
      threadId = original.data.threadId ?? undefined;
      const msgId =
        original.data.payload?.headers?.find((h) => h.name?.toLowerCase() === 'message-id')
          ?.value ?? '';
      if (msgId) {
        replyHeaders = [`In-Reply-To: ${msgId}`, `References: ${msgId}`];
      }
    } catch {
      // If we can't fetch the original, proceed without threading
    }
  }

  const lines = [
    `From: ${myEmail}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`,
    ...replyHeaders,
    `Content-Type: text/plain; charset="UTF-8"`,
    '',
    body,
  ];

  const raw = Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const draft = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        threadId,
      },
    },
  });

  return {
    ok: true,
    draftId: draft.data.id,
    messageId: draft.data.message?.id,
    threadId: draft.data.message?.threadId,
    to,
    subject,
  };
}
