import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';
import { clamp } from '@snaglet/shared/utils';

interface GmailListArgs {
  query?: string;
  labelIds?: string[];
  maxResults?: number;
  pageToken?: string;
}

// Decode RFC 2047 encoded-words (=?charset?B|Q?text?=) back to display text.
// Symmetric with the encode side in google-gmail-send; handles Base64 (B)
// and Quoted-Printable (Q), leaves plain-ASCII untouched.
function decodeRfc2047(value: string): string {
  if (!value || !value.includes('=?')) return value;

  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_match, charset: string, encoding: string, text: string) => {
      try {
        const enc = encoding.toUpperCase();
        const cs = charset.toLowerCase();
        const bufEnc = (cs === 'utf-8' || cs === 'utf8' ? 'utf-8' : cs) as BufferEncoding;
        if (enc === 'B') {
          return Buffer.from(text, 'base64').toString(bufEnc);
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
        return Buffer.from(bytes).toString(bufEnc);
      } catch {
        return _match;
      }
    }
  );
}

function header(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string
): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return decodeRfc2047(h?.value ?? '');
}

export default async function googleGmailList(
  args: GmailListArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { query, labelIds, maxResults, pageToken } = args;

  const limit = clamp(maxResults ?? 25, 1, 100);

  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    labelIds: labelIds && labelIds.length > 0 ? labelIds : undefined,
    maxResults: limit,
    pageToken,
  });

  const refs = listRes.data.messages ?? [];

  // Hydrate each ref with metadata headers (subject/from/date) + snippet.
  // format: 'metadata' keeps it light and avoids pulling full bodies.
  const messages = await Promise.all(
    refs.map(async (ref) => {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: ref.id!,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      const headers = detail.data.payload?.headers ?? undefined;
      return {
        id: detail.data.id,
        threadId: detail.data.threadId,
        labelIds: detail.data.labelIds ?? [],
        from: header(headers, 'From'),
        subject: header(headers, 'Subject'),
        date: header(headers, 'Date'),
        snippet: detail.data.snippet ?? '',
      };
    })
  );

  return JSON.stringify({
    count: messages.length,
    resultSizeEstimate: listRes.data.resultSizeEstimate ?? 0,
    nextPageToken: listRes.data.nextPageToken ?? null,
    messages,
  });
}
