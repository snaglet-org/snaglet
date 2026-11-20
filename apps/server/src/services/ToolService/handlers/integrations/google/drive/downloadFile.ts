import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';
import { expandHome } from '@server/utils/paths';

interface DownloadArgs {
  fileId: string;
  exportMimeType?: string;
  savePath?: string;
  inMemory?: boolean;
}

// Expand a leading ~ to the user's home directory.
// Native Google MIME types that cannot be downloaded directly and must be exported.
const NATIVE_EXPORT_DEFAULTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'image/png',
};

// MIME types we treat as UTF-8 text; everything else is returned base64-encoded.
function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/csv'
  );
}

export default async function googleDriveDownloadFile(
  args: DownloadArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { fileId, exportMimeType, savePath, inMemory } = args;

  if (!fileId || typeof fileId !== 'string') {
    throw new Error('fileId is required');
  }

  // Resolve the effective write target. By default we write the file to the
  // user's ~/Downloads folder so "download" behaves the way a human expects
  // (the file lands somewhere they can open it). Callers can override with an
  // explicit savePath, or opt into pure in-memory bytes with inMemory: true.
  const effectiveSavePath =
    inMemory === true
      ? undefined
      : savePath && typeof savePath === 'string' && savePath.trim() !== ''
        ? savePath
        : path.join(os.homedir(), 'Downloads');

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  // Resolve the file's metadata first so we know its name and stored MIME type.
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size',
  });

  const file = meta.data as drive_v3.Schema$File;
  const sourceMime = file.mimeType ?? 'application/octet-stream';
  const isNative = sourceMime.startsWith('application/vnd.google-apps');

  let data: ArrayBuffer;
  let resultMime: string;

  if (isNative) {
    const targetMime = exportMimeType ?? NATIVE_EXPORT_DEFAULTS[sourceMime] ?? 'application/pdf';
    const res = await drive.files.export(
      { fileId, mimeType: targetMime },
      { responseType: 'arraybuffer' }
    );
    data = res.data as ArrayBuffer;
    resultMime = targetMime;
  } else {
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    data = res.data as ArrayBuffer;
    resultMime = sourceMime;
  }

  const buffer = Buffer.from(data);
  const asText = isTextMime(resultMime);

  // If savePath is provided, write the decoded bytes to disk and return the
  // absolute path instead of the (potentially large) content payload. This is
  // the "download to my machine" behavior — the file lands somewhere the user
  // can open it.
  if (effectiveSavePath) {
    let target = expandHome(effectiveSavePath.trim());
    target = path.resolve(target);

    // If target is an existing directory (or ends with a separator), write the
    // file inside it using the Drive file's own name.
    let dir: string;
    let isDirTarget = target.endsWith(path.sep);
    if (!isDirTarget) {
      try {
        const stat = await fs.stat(target);
        if (stat.isDirectory()) isDirTarget = true;
      } catch {
        // target does not exist yet — treat as a file path
      }
    }
    if (isDirTarget) {
      dir = target;
      target = path.join(target, file.name ?? file.id ?? 'download');
    } else {
      dir = path.dirname(target);
    }

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(target, buffer);

    return JSON.stringify({
      fileId: file.id,
      name: file.name,
      sourceMimeType: sourceMime,
      mimeType: resultMime,
      exported: isNative,
      size: buffer.length,
      savedTo: target,
      writtenToDisk: true,
    });
  }

  return JSON.stringify({
    fileId: file.id,
    name: file.name,
    sourceMimeType: sourceMime,
    mimeType: resultMime,
    exported: isNative,
    encoding: asText ? 'utf-8' : 'base64',
    size: buffer.length,
    content: asText ? buffer.toString('utf-8') : buffer.toString('base64'),
    writtenToDisk: false,
  });
}
