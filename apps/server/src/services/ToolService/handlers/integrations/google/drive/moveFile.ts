import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface MoveArgs {
  fileId: string;
  addParents: string;
  removeParents?: string;
}

export default async function googleDriveMoveFile(
  args: MoveArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { fileId, addParents } = args;

  if (!fileId || typeof fileId !== 'string') {
    throw new Error('fileId is required');
  }
  if (!addParents || typeof addParents !== 'string') {
    throw new Error('addParents (destination folder id) is required');
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  // Determine the current parents so we know what to remove unless the
  // caller specified removeParents explicitly.
  let removeParents = args.removeParents;
  if (!removeParents) {
    const meta = await drive.files.get({ fileId, fields: 'parents' });
    const parents = (meta.data as drive_v3.Schema$File).parents ?? [];
    removeParents = parents.join(',');
  }

  const updated = await drive.files.update({
    fileId,
    addParents,
    removeParents,
    fields: 'id, name, parents',
  });
  const file = updated.data as drive_v3.Schema$File;

  return JSON.stringify({
    fileId,
    name: file.name ?? undefined,
    parents: file.parents ?? [],
    addedParent: addParents,
    removedParents: removeParents ? removeParents.split(',').filter(Boolean) : [],
    moved: true,
  });
}
