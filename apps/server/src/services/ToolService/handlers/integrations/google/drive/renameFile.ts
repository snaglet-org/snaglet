import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface RenameArgs {
  fileId: string;
  name: string;
}

export default async function googleDriveRenameFile(
  args: RenameArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { fileId, name } = args;

  if (!fileId || typeof fileId !== 'string') {
    throw new Error('fileId is required');
  }
  if (!name || typeof name !== 'string') {
    throw new Error('name (new file name) is required');
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  const updated = await drive.files.update({
    fileId,
    requestBody: { name },
    supportsAllDrives: true,
    fields: 'id, name, mimeType, parents, modifiedTime',
  });
  const file = updated.data as drive_v3.Schema$File;

  return JSON.stringify({
    fileId,
    name: file.name ?? undefined,
    mimeType: file.mimeType ?? undefined,
    parents: file.parents ?? [],
    modifiedTime: file.modifiedTime ?? undefined,
    renamed: true,
  });
}
