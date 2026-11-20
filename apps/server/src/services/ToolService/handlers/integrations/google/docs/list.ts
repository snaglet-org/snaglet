import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface DocsListInput {
  query?: string;
  maxResults?: number;
}

const DOC_MIME = 'application/vnd.google-apps.document';

function formatFile(file: drive_v3.Schema$File) {
  return {
    id: file.id ?? null,
    name: file.name ?? '(unnamed)',
    modifiedTime: file.modifiedTime ?? null,
    createdTime: file.createdTime ?? null,
    webViewLink: file.webViewLink ?? null,
    owners: (file.owners ?? [])
      .map((o: drive_v3.Schema$User) => o.emailAddress ?? o.displayName ?? '')
      .filter(Boolean),
  };
}

function buildQuery(userQuery?: string): string {
  const parts: string[] = [`mimeType = '${DOC_MIME}'`, 'trashed = false'];
  if (userQuery && userQuery.trim()) {
    const escaped = userQuery.trim().replace(/'/g, "\\'");
    parts.push(`fullText contains '${escaped}'`);
  }
  return parts.join(' and ');
}

const tool = async (input: DocsListInput, _context: ToolHandlerContext): Promise<string> => {
  const maxResults = input.maxResults ?? 20;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    throw new Error('maxResults must be an integer between 1 and 50');
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  const q = buildQuery(input.query);

  const res = await drive.files.list({
    q,
    pageSize: maxResults,
    fields:
      'files(id,name,mimeType,modifiedTime,createdTime,webViewLink,owners(displayName,emailAddress))',
    orderBy: 'modifiedTime desc',
  });

  const files = (res.data.files ?? []).map(formatFile);

  return JSON.stringify({
    query: q,
    count: files.length,
    files,
  });
};

export default tool;
