import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface GetFileArgs {
  fileId: string;
  fields?: string;
}

const DEFAULT_FIELDS =
  'id, name, mimeType, size, parents, owners(displayName,emailAddress), ' +
  'createdTime, modifiedTime, webViewLink, webContentLink, iconLink, ' +
  'trashed, shared, starred, version';

export default async function googleDriveGetFile(
  args: GetFileArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { fileId } = args;

  if (!fileId || typeof fileId !== 'string') {
    throw new Error('fileId is required');
  }

  const fields = args.fields && typeof args.fields === 'string' ? args.fields : DEFAULT_FIELDS;

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.get({
    fileId,
    fields,
    supportsAllDrives: true,
  });
  const file = res.data as drive_v3.Schema$File;

  return JSON.stringify({
    fileId: file.id ?? fileId,
    name: file.name ?? undefined,
    mimeType: file.mimeType ?? undefined,
    size: file.size ?? undefined,
    parents: file.parents ?? [],
    owners: file.owners ?? [],
    createdTime: file.createdTime ?? undefined,
    modifiedTime: file.modifiedTime ?? undefined,
    webViewLink: file.webViewLink ?? undefined,
    webContentLink: file.webContentLink ?? undefined,
    trashed: file.trashed ?? undefined,
    shared: file.shared ?? undefined,
    starred: file.starred ?? undefined,
    version: file.version ?? undefined,
  });
}
