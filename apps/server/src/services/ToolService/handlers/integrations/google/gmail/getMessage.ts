import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface GmailGetMessageArgs {
  messageId: string;
  format?: 'full' | 'metadata' | 'minimal';
}

// Decode RFC 2047 encoded-words (=?charset?B|Q?text?=) back to display text.
// Symmetric with the encode side in google-gmail-send; handles Base64 (B)
// and Quoted-Printable (Q), leaves plain-ASCII untouched.
function decodeRfc2047(value: string): string {
  if (!value || !value.includes('=?')) return value;

  const decoded = value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_match, charset: string, encoding: string, text: string) => {
      try {
        const enc = encoding.toUpperCase();
        const cs = charset.toLowerCase() as BufferEncoding | string;
        if (enc === 'B') {
          const buf = Buffer.from(text, 'base64');
          return buf.toString((cs === 'utf-8' || cs === 'utf8' ? 'utf-8' : cs) as BufferEncoding);
        }
        const bytes: number[] = [];
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (ch === '_') {
            bytes.push(0x20);
          } else if (ch === '=' && i + 2 < text.length) {
            bytes.push(parseInt(text.substr(i + 1, 2), 16));
            i += 2;
          } else {
            bytes.push(ch.charCodeAt(0));
          }
        }
        return Buffer.from(bytes).toString(
          (cs === 'utf-8' || cs === 'utf8' ? 'utf-8' : cs) as BufferEncoding
        );
      } catch {
        return _match;
      }
    }
  );
  return decoded;
}

function header(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string
): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return decodeRfc2047(h?.value ?? '');
}

// Recursively walk the MIME tree to extract a plain-text body. Prefers
// text/plain; falls back to text/html. Decodes base64url payloads as UTF-8.
function extractBody(
  payload:
    | {
        mimeType?: string | null;
        body?: { data?: string | null } | null;
        parts?: unknown[] | null;
      }
    | undefined
): string {
  if (!payload) return '';

  const decodePart = (data?: string | null): string => {
    if (!data) return '';
    return Buffer.from(data, 'base64url').toString('utf-8');
  };

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodePart(payload.body.data);
  }

  const parts = (payload.parts ?? []) as Array<typeof payload>;
  // First pass: prefer text/plain anywhere in the tree.
  for (const part of parts) {
    const found = extractBody(part);
    if (found && part.mimeType === 'text/plain') return found;
  }
  // Second pass: any extractable body (e.g. text/html).
  for (const part of parts) {
    const found = extractBody(part);
    if (found) return found;
  }
  // Single-part fallback.
  if (payload.body?.data) return decodePart(payload.body.data);
  return '';
}

export default async function googleGmailGetMessage(
  args: GmailGetMessageArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { messageId, format } = args;

  if (!messageId || typeof messageId !== 'string') {
    throw new Error('messageId is required');
  }
  const fmt = format ?? 'full';
  if (!['full', 'metadata', 'minimal'].includes(fmt)) {
    throw new Error("format must be one of 'full', 'metadata', 'minimal'");
  }

  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: fmt,
  });

  const headers = msg.data.payload?.headers ?? undefined;

  return JSON.stringify({
    id: msg.data.id,
    threadId: msg.data.threadId,
    labelIds: msg.data.labelIds ?? [],
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    subject: header(headers, 'Subject'),
    date: header(headers, 'Date'),
    snippet: msg.data.snippet ?? '',
    body: fmt === 'full' ? extractBody(msg.data.payload ?? undefined) : undefined,
  });
}
