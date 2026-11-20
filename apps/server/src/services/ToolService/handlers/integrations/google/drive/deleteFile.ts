import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface DeleteArgs {
  fileId: string;
  permanent?: boolean;
}

export default async function googleDriveDeleteFile(
  args: DeleteArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { fileId } = args;
  // Default to a recoverable trash, not a hard delete, unless caller opts in.
  const permanent = args.permanent === true;

  if (!fileId || typeof fileId !== 'string') {
    throw new Error('fileId is required');
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  // Capture the file's name before removal so the caller gets a useful echo.
  let name: string | undefined;
  try {
    const meta = await drive.files.get({ fileId, fields: 'name' });
    name = (meta.data as drive_v3.Schema$File).name ?? undefined;
  } catch {
    // Non-fatal — proceed with the delete/trash regardless.
    name = undefined;
  }

  if (permanent) {
    // Hard delete — irreversible, bypasses the trash.
    await drive.files.delete({ fileId });
    return JSON.stringify({ fileId, name, deleted: true, permanent: true });
  }

  // Soft delete — move to trash (recoverable).
  const updated = await drive.files.update({
    fileId,
    fields: 'id, name, trashed',
    requestBody: { trashed: true },
  });
  const file = updated.data as drive_v3.Schema$File;

  return JSON.stringify({
    fileId,
    name: file.name ?? name,
    deleted: true,
    permanent: false,
    trashed: file.trashed ?? true,
  });
}
