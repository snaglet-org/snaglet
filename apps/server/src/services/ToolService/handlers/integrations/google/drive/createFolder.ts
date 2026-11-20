import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

interface CreateFolderArgs {
  name: string;
  parentId?: string;
}

export default async function googleDriveCreateFolder(
  args: CreateFolderArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { name, parentId } = args;

  if (!name || typeof name !== 'string') {
    throw new Error('name is required');
  }
  if (parentId !== undefined && typeof parentId !== 'string') {
    throw new Error('parentId must be a string when provided');
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  const requestBody: drive_v3.Schema$File = {
    name,
    mimeType: FOLDER_MIME,
  };
  if (parentId) requestBody.parents = [parentId];

  const created = await drive.files.create({
    requestBody,
    fields: 'id, name, mimeType, parents, webViewLink',
  });

  const folder = created.data as drive_v3.Schema$File;

  return JSON.stringify({
    folderId: folder.id,
    name: folder.name,
    mimeType: folder.mimeType,
    parents: folder.parents ?? undefined,
    webViewLink: folder.webViewLink ?? undefined,
  });
}
