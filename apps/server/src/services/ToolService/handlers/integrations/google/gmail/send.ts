import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface GmailSendArgs {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}

/**
 * Encode a string to base64url (RFC 4648 §5) as required by the Gmail API
 * for the `raw` field of users.messages.send.
 */
function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * RFC 2047 encoded-word for header values containing non-ASCII characters.
 * Email headers are 7-bit ASCII; a raw UTF-8 byte (e.g. an em-dash) in the
 * Subject header is non-conformant and breaks Gmail's subject indexing/search.
 * Pure-ASCII input is returned unchanged so plain subjects stay readable.
 */
function encodeHeaderWord(input: string): string {
  if (/^[\x00-\x7F]*$/.test(input)) {
    return input;
  }
  const b64 = Buffer.from(input, 'utf-8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

export default async function googleGmailSend(
  args: GmailSendArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { to, subject, body, cc, bcc } = args;

  if (!to || typeof to !== 'string') {
    throw new Error('to is required');
  }
  if (!subject || typeof subject !== 'string') {
    throw new Error('subject is required');
  }
  if (!body || typeof body !== 'string') {
    throw new Error('body is required');
  }
  if (cc !== undefined && typeof cc !== 'string') {
    throw new Error('cc must be a string when provided');
  }
  if (bcc !== undefined && typeof bcc !== 'string') {
    throw new Error('bcc must be a string when provided');
  }

  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: 'v1', auth });

  // Build an RFC 822 message. CRLF line endings, headers then a blank line,
  // then the body. UTF-8 declared so non-ASCII subjects/bodies survive.
  const headers: string[] = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  const rawMessage = `${headers.join('\r\n')}\r\n\r\n${body}`;
  const raw = toBase64Url(rawMessage);

  const sent = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return JSON.stringify({
    id: sent.data.id,
    threadId: sent.data.threadId,
    labelIds: sent.data.labelIds,
    to,
    subject,
  });
}
