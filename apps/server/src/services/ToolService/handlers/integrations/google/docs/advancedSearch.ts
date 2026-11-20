import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

const DOC_MIME = 'application/vnd.google-apps.document';

interface DocsSearchInput {
  query?: string;
  searchScope?: 'content' | 'name';
  parentFolderId?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  includeTrashed?: boolean;
  maxResults?: number;
  pageToken?: string;
  orderBy?: string;
}

function formatDoc(file: drive_v3.Schema$File) {
  return {
    id: file.id ?? null,
    name: file.name ?? '(unnamed)',
    modifiedTime: file.modifiedTime ?? null,
    createdTime: file.createdTime ?? null,
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

function assertRfc3339(label: string, value: string): void {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `${label} must be an RFC 3339 date string (e.g. "2024-01-31" or "2024-01-31T00:00:00Z")`
    );
  }
}

function buildQuery(input: DocsSearchInput): string {
  // Always scoped to Google Docs.
  const parts: string[] = [`mimeType = '${DOC_MIME}'`];
  const query = input.query?.trim();

  if (query) {
    const escaped = query.replace(/'/g, "\\'");
    if (input.searchScope === 'name') {
      parts.push(`name contains '${escaped}'`);
    } else {
      parts.push(`fullText contains '${escaped}'`);
    }
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

const tool = async (input: DocsSearchInput, _context: ToolHandlerContext): Promise<string> => {
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
      'nextPageToken, files(id, name, modifiedTime, createdTime, webViewLink, parents, owners(displayName, emailAddress))',
  });

  const docs = (res.data.files ?? []).map(formatDoc);

  return JSON.stringify({
    query: driveQuery,
    count: docs.length,
    nextPageToken: res.data.nextPageToken ?? null,
    documents: docs,
  });
};

export default tool;
