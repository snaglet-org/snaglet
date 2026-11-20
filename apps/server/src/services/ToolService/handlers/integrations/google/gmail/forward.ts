import { google, type gmail_v1 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

/**
 * Recursively extract plain-text body from a Gmail message payload.
 */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  return '';
}

export default async function handler(
  params: Record<string, unknown>,
  context: ToolHandlerContext
) {
  const { messageId, to, note } = params as {
    messageId: string;
    to: string;
    note?: string;
  };

  if (!messageId || typeof messageId !== 'string') {
    throw new Error('messageId is required.');
  }
  if (!to || typeof to !== 'string') {
    throw new Error('to is required.');
  }

  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const original = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const headers = original.data.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const origFrom = getHeader('From');
  const origTo = getHeader('To');
  const origDate = getHeader('Date');
  const origSubject = getHeader('Subject');

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const myEmail = profile.data.emailAddress ?? '';

  const origBody = extractBody(original.data.payload);

  const fwdSubject = origSubject.startsWith('Fwd:') ? origSubject : `Fwd: ${origSubject}`;

  const forwardBlock = [
    '---------- Forwarded message ----------',
    `From: ${origFrom}`,
    `Date: ${origDate}`,
    `Subject: ${origSubject}`,
    `To: ${origTo}`,
    '',
    origBody,
  ].join('\n');

  const fullBody = note ? `${note}\n\n${forwardBlock}` : forwardBlock;

  const lines = [
    `From: ${myEmail}`,
    `To: ${to}`,
    `Subject: ${fwdSubject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    '',
    fullBody,
  ];

  const raw = Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const sent = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return {
    ok: true,
    messageId: sent.data.id,
    threadId: sent.data.threadId,
    to,
    subject: fwdSubject,
  };
}
