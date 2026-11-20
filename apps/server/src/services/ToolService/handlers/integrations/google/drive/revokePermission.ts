import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface RevokePermissionArgs {
  fileId: string;
  permissionId: string;
}

export default async function googleDriveRevokePermission(
  args: RevokePermissionArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { fileId, permissionId } = args;

  if (!fileId || typeof fileId !== 'string') {
    throw new Error('fileId is required');
  }
  if (!permissionId || typeof permissionId !== 'string') {
    throw new Error('permissionId is required');
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  // permissions.delete returns 204 No Content on success.
  await drive.permissions.delete({
    fileId,
    permissionId,
    supportsAllDrives: true,
  });

  return JSON.stringify({
    fileId,
    permissionId,
    revoked: true,
  });
}
