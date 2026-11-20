import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface AdvancedSearchInput {
  query?: string;
  rawQuery?: string;
  searchScope?: 'content' | 'name';
  mimeType?: string;
  parentFolderId?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  includeTrashed?: boolean;
  maxResults?: number;
  pageToken?: string;
  orderBy?: string;
}

function formatFile(file: drive_v3.Schema$File) {
  return {
    id: file.id ?? null,
    name: file.name ?? '(unnamed)',
    mimeType: file.mimeType ?? null,
    modifiedTime: file.modifiedTime ?? null,
    createdTime: file.createdTime ?? null,
    size: file.size ?? null,
    webViewLink: file.webViewLink ?? null,
    parents: file.parents ?? [],
    owners: (file.owners ?? [])
      .map((o: drive_v3.Schema$User) => o.emailAddress ?? o.displayName ?? '')
      .filter(Boolean),
  };
}

const ALLOWED_ORDER_BY = new Set([
  'modifiedTime',
  'modifiedTime desc',
  'createdTime',
  'createdTime desc',
  'name',
  'name desc',
]);

/**
 * Validates an RFC 3339 date string the Drive API accepts (e.g. 2024-01-31T00:00:00).
 * Throws on malformed input so a bad filter fails loudly instead of silently matching nothing.
 */
function assertRfc3339(label: string, value: string): void {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `${label} must be an RFC 3339 date string (e.g. "2024-01-31" or "2024-01-31T00:00:00Z")`
    );
  }
}

function buildQuery(input: AdvancedSearchInput): string {
  const parts: string[] = [];

  // Escape hatch: when rawQuery is supplied, pass the caller's Drive q expression
  // through untouched. Only the trashed clause is AND-ed on (unless includeTrashed),
  // so callers can use raw syntax the structured builder can't express
  // (e.g. name = 'exact', compound or/and, starred = true, sharedWithMe).
  const rawQuery = input.rawQuery?.trim();
  if (rawQuery) {
    parts.push(`(${rawQuery})`);
    if (!input.includeTrashed) {
      parts.push('trashed = false');
    }
    return parts.join(' and ');
  }

  const query = input.query?.trim();

  if (query) {
    const escaped = query.replace(/'/g, "\\'");
    if (input.searchScope === 'name') {
      parts.push(`name contains '${escaped}'`);
    } else {
      parts.push(`fullText contains '${escaped}'`);
    }
  }

  if (input.mimeType) {
    parts.push(`mimeType = '${input.mimeType.replace(/'/g, "\\'")}'`);
  }

  if (input.parentFolderId) {
    parts.push(`'${input.parentFolderId.replace(/'/g, "\\'")}' in parents`);
  }

  if (input.modifiedAfter) {
    assertRfc3339('modifiedAfter', input.modifiedAfter);
    parts.push(`modifiedTime > '${input.modifiedAfter}'`);
  }

  if (input.modifiedBefore) {
    assertRfc3339('modifiedBefore', input.modifiedBefore);
    parts.push(`modifiedTime < '${input.modifiedBefore}'`);
  }

  if (!input.includeTrashed) {
    parts.push('trashed = false');
  }

  return parts.join(' and ');
}

const tool = async (input: AdvancedSearchInput, _context: ToolHandlerContext): Promise<string> => {
  const hasAnyFilter =
    !!input.rawQuery?.trim() ||
    !!input.query?.trim() ||
    !!input.mimeType ||
    !!input.parentFolderId ||
    !!input.modifiedAfter ||
    !!input.modifiedBefore;

  if (!hasAnyFilter) {
    throw new Error(
      'at least one filter is required (rawQuery, query, mimeType, parentFolderId, modifiedAfter, or modifiedBefore)'
    );
  }

  const maxResults = input.maxResults ?? 20;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
    throw new Error('maxResults must be an integer between 1 and 100');
  }

  const orderBy = input.orderBy ?? 'modifiedTime desc';
  if (!ALLOWED_ORDER_BY.has(orderBy)) {
    throw new Error(`orderBy must be one of: ${Array.from(ALLOWED_ORDER_BY).join(', ')}`);
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  const driveQuery = buildQuery(input);

  const res = await drive.files.list({
    q: driveQuery,
    pageSize: maxResults,
    pageToken: input.pageToken,
    orderBy,
    fields:
      'nextPageToken, files(id, name, mimeType, modifiedTime, createdTime, size, webViewLink, parents, owners(displayName, emailAddress))',
  });

  const files = (res.data.files ?? []).map(formatFile);

  return JSON.stringify({
    query: driveQuery,
    count: files.length,
    nextPageToken: res.data.nextPageToken ?? null,
    files,
  });
};

export default tool;
