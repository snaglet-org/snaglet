import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface ListFilesInput {
  folderId?: string;
  maxResults?: number;
  pageToken?: string;
  orderBy?: string;
  includeTrashed?: boolean;
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
  'folder',
]);

/**
 * Lists files and folders directly contained in a Drive folder (or the user's root
 * when folderId is omitted). Distinct from search: this is a folder-browse primitive
 * that does not require a query. Uses the workspace seam getGoogleClient() for auth;
 * the handler never touches credentials.
 */
const tool = async (input: ListFilesInput, _context: ToolHandlerContext): Promise<string> => {
  const maxResults = input.maxResults ?? 50;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
    throw new Error('maxResults must be an integer between 1 and 100');
  }

  const orderBy = input.orderBy ?? 'folder,name';
  // Allow the composite default plus any single allowed key.
  if (orderBy !== 'folder,name' && !ALLOWED_ORDER_BY.has(orderBy)) {
    throw new Error(
      `orderBy must be one of: folder,name, ${Array.from(ALLOWED_ORDER_BY).join(', ')}`
    );
  }

  const parts: string[] = [];
  const folderId = input.folderId?.trim() || 'root';
  parts.push(`'${folderId.replace(/'/g, "\\'")}' in parents`);
  if (!input.includeTrashed) {
    parts.push('trashed = false');
  }
  const driveQuery = parts.join(' and ');

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

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
    folderId,
    query: driveQuery,
    count: files.length,
    nextPageToken: res.data.nextPageToken ?? null,
    files,
  });
};

export default tool;
