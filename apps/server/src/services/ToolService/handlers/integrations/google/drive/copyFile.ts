import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface CopyFileArgs {
  fileId: string;
  name?: string;
  parentFolderId?: string;
}

const FIELDS = 'id, name, mimeType, parents, webViewLink, createdTime, modifiedTime';

export default async function googleDriveCopyFile(
  args: CopyFileArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { fileId, name, parentFolderId } = args;

  if (!fileId || typeof fileId !== 'string') {
    throw new Error('fileId is required');
  }

  const requestBody: drive_v3.Schema$File = {};
  if (name && typeof name === 'string') {
    requestBody.name = name;
  }
  if (parentFolderId && typeof parentFolderId === 'string') {
    requestBody.parents = [parentFolderId];
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.copy({
    fileId,
    requestBody,
    fields: FIELDS,
    supportsAllDrives: true,
  });
  const file = res.data as drive_v3.Schema$File;

  return JSON.stringify({
    sourceFileId: fileId,
    fileId: file.id ?? undefined,
    name: file.name ?? undefined,
    mimeType: file.mimeType ?? undefined,
    parents: file.parents ?? [],
    webViewLink: file.webViewLink ?? undefined,
    createdTime: file.createdTime ?? undefined,
    modifiedTime: file.modifiedTime ?? undefined,
  });
}
