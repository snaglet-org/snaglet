import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface UploadFileArgs {
  /** Absolute path to a local file to upload. Provide this OR content. */
  filePath?: string;
  /** Inline UTF-8 text content to upload as the file body. Provide this OR filePath. */
  content?: string;
  /** Name the file should have in Drive. Required when using content; defaults to basename(filePath). */
  name?: string;
  /** MIME type of the uploaded file. Defaults to text/plain for content, application/octet-stream for filePath. */
  mimeType?: string;
  /** Optional parent folder ID. Omitted = uploads to Drive root. */
  parentId?: string;
}

export default async function googleDriveUploadFile(
  args: UploadFileArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { filePath, content, parentId } = args;

  if ((!filePath || typeof filePath !== 'string') && typeof content !== 'string') {
    throw new Error('Provide either filePath (local file) or content (inline text)');
  }
  if (filePath && typeof content === 'string') {
    throw new Error('Provide only one of filePath or content, not both');
  }

  let name = args.name;
  let mimeType = args.mimeType;
  let body: NodeJS.ReadableStream | string;

  if (filePath) {
    // Validate the local file exists before streaming.
    await fs.access(filePath);
    if (!name) name = path.basename(filePath);
    if (!mimeType) mimeType = 'application/octet-stream';
    body = createReadStream(filePath);
  } else {
    if (!name || typeof name !== 'string') {
      throw new Error('name is required when uploading inline content');
    }
    if (!mimeType) mimeType = 'text/plain';
    body = content as string;
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  const requestBody: drive_v3.Schema$File = { name };
  if (parentId && typeof parentId === 'string') {
    requestBody.parents = [parentId];
  }

  const res = await drive.files.create({
    requestBody,
    media: {
      mimeType,
      body,
    },
    fields: 'id, name, mimeType, size, parents, webViewLink, createdTime',
    supportsAllDrives: true,
  });
  const file = res.data as drive_v3.Schema$File;

  return JSON.stringify({
    fileId: file.id ?? undefined,
    name: file.name ?? name,
    mimeType: file.mimeType ?? mimeType,
    size: file.size ?? undefined,
    parents: file.parents ?? [],
    webViewLink: file.webViewLink ?? undefined,
    createdTime: file.createdTime ?? undefined,
  });
}
