import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface GmailSearchArgs {
  query: string;
  maxResults?: number;
}

// Decode RFC 2047 encoded-words (=?charset?B|Q?text?=) back to display text.
// Handles both Base64 (B) and Quoted-Printable (Q) encodings, multiple
// adjacent encoded-words, and leaves plain-ASCII values untouched.
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
        // Q-encoding: '_' => space, =XX => byte
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
  // Per RFC 2047, whitespace between adjacent encoded-words is removed.
  return decoded;
}

function header(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string
): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return decodeRfc2047(h?.value ?? '');
}

export default async function googleGmailSearch(
  args: GmailSearchArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { query, maxResults } = args;

  if (!query || typeof query !== 'string') {
    throw new Error('query is required');
  }
  if (
    maxResults !== undefined &&
    (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults < 1)
  ) {
    throw new Error('maxResults must be a positive integer when provided');
  }

  const limit = Math.min(maxResults ?? 10, 50);

  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: limit,
  });

  const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);

  // Fetch metadata for each match. METADATA format + header filter keeps it light.
  const messages = await Promise.all(
    ids.map(async (id) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });
      const headers = msg.data.payload?.headers ?? undefined;
      return {
        id: msg.data.id,
        threadId: msg.data.threadId,
        from: header(headers, 'From'),
        to: header(headers, 'To'),
        subject: header(headers, 'Subject'),
        date: header(headers, 'Date'),
        snippet: msg.data.snippet ?? '',
      };
    })
  );

  return JSON.stringify({
    query,
    count: messages.length,
    messages,
  });
}
