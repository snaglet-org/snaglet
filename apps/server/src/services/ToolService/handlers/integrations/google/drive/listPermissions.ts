import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface ListPermissionsArgs {
  fileId: string;
}

export default async function googleDriveListPermissions(
  args: ListPermissionsArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { fileId } = args;

  if (!fileId || typeof fileId !== 'string') {
    throw new Error('fileId is required');
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  // Page through all permissions so the caller gets the complete grant list.
  const permissions: drive_v3.Schema$Permission[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.permissions.list({
      fileId,
      supportsAllDrives: true,
      pageSize: 100,
      pageToken,
      fields:
        'nextPageToken, permissions(id, type, role, emailAddress, domain, displayName, deleted)',
    });
    const page = (res.data.permissions ?? []) as drive_v3.Schema$Permission[];
    permissions.push(...page);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return JSON.stringify({
    fileId,
    count: permissions.length,
    permissions: permissions.map((p) => ({
      permissionId: p.id,
      type: p.type,
      role: p.role,
      emailAddress: p.emailAddress ?? undefined,
      domain: p.domain ?? undefined,
      displayName: p.displayName ?? undefined,
      deleted: p.deleted ?? undefined,
    })),
  });
}
