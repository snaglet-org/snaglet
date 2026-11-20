import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface SearchFilesInput {
  query: string;
  mimeType?: string;
  maxResults?: number;
}

/**
 * Formats Drive API files into the tool's stable JSON response shape.
 * Credential lookup stays outside this helper; callers pass an authenticated
 * OAuth2Client from getGoogleClient().
 */
function formatFile(file: drive_v3.Schema$File) {
  return {
    id: file.id ?? null,
    name: file.name ?? '(unnamed)',
    mimeType: file.mimeType ?? null,
    modifiedTime: file.modifiedTime ?? null,
    webViewLink: file.webViewLink ?? null,
    owners: (file.owners ?? [])
      .map((o: drive_v3.Schema$User) => o.emailAddress ?? o.displayName ?? '')
      .filter(Boolean),
  };
}

function buildDriveQuery(userQuery: string, mimeType?: string): string {
  const parts: string[] = [];
  const escaped = userQuery.replace(/'/g, "\\'");
  parts.push(`fullText contains '${escaped}'`);
  if (mimeType) {
    parts.push(`mimeType = '${mimeType}'`);
  }
  parts.push('trashed = false');
  return parts.join(' and ');
}

const tool = async (input: SearchFilesInput, _context: ToolHandlerContext): Promise<string> => {
  const query = input.query?.trim();
  if (!query) {
    throw new Error('query is required and cannot be empty');
  }

  const maxResults = input.maxResults ?? 20;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    throw new Error('maxResults must be an integer between 1 and 50');
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  const driveQuery = buildDriveQuery(query, input.mimeType);

  const res = await drive.files.list({
    q: driveQuery,
    pageSize: maxResults,
    fields:
      'files(id, name, mimeType, modifiedTime, webViewLink, owners(displayName, emailAddress))',
    orderBy: 'modifiedTime desc',
  });

  const files = (res.data.files ?? []).map(formatFile);

  return JSON.stringify({
    query: driveQuery,
    count: files.length,
    files,
  });
};

export default tool;
