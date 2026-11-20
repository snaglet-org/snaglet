import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

export default async function handler(
  params: Record<string, unknown>,
  context: ToolHandlerContext
) {
  const { messageId, body, replyAll } = params as {
    messageId: string;
    body: string;
    replyAll?: boolean;
  };

  if (!messageId || typeof messageId !== 'string') {
    throw new Error('messageId is required and must be a string.');
  }
  if (!body || typeof body !== 'string') {
    throw new Error('body is required and must be a string.');
  }

  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const original = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID'],
  });

  const headers = original.data.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const from = getHeader('From');
  const to = getHeader('To');
  const cc = getHeader('Cc');
  const subject = getHeader('Subject');
  const originalMessageId = getHeader('Message-ID');
  const threadId = original.data.threadId;

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const myEmail = profile.data.emailAddress ?? '';

  let replyTo = from;
  let replyCc = '';

  if (replyAll) {
    // Reply-all: To = original sender, Cc = original To + Cc minus ourselves
    const allRecipients = [to, cc]
      .filter(Boolean)
      .join(', ')
      .split(',')
      .map((e) => e.trim())
      .filter((e) => !e.toLowerCase().includes(myEmail.toLowerCase()));
    replyCc = allRecipients.join(', ');
  }

  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  const lines = [
    `From: ${myEmail}`,
    `To: ${replyTo}`,
    ...(replyCc ? [`Cc: ${replyCc}`] : []),
    `Subject: ${replySubject}`,
    `In-Reply-To: ${originalMessageId}`,
    `References: ${originalMessageId}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    '',
    body,
  ];

  const raw = Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const sent = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: threadId ?? undefined },
  });

  return {
    ok: true,
    messageId: sent.data.id,
    threadId: sent.data.threadId,
    to: replyTo,
    cc: replyCc || undefined,
    subject: replySubject,
  };
}
