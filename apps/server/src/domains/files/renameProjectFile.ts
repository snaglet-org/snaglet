/**
 * Rename a file inside a linked project folder, in place.
 *
 * The file keeps its folder and its bytes; only its name changes. The request
 * names the file by absolute path, and the rename happens only when that path
 * really lies inside a live project's linked folder (symlinks may not lead
 * out). An existing file is never replaced: a name taken by another file is a
 * 409, while a case-only change (`a.png` to `A.png`) works on case-insensitive
 * volumes too. Only renamable files (isRenamableProjectFile: images) qualify,
 * and they keep their type (see nameToSave).
 *
 * Image files are never indexed, so no file-index row follows the rename.
 */

import path from 'node:path';
import { link, lstat, rename, rm, stat } from 'node:fs/promises';
import { Projects } from '@snaglet/db';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, isRenamableProjectFile } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { canonicalFolder } from '@server/services/fileIndexing/ownership';
import { renameRefusal } from '@server/utils/fsRefusal';
import { realFileWithin } from './previewPaths';

export interface RenamedProjectFile {
  /** Absolute path of the file under its new name, in the form it was requested. */
  path: string;
  name: string;
}

/** Longest file name, in UTF-8 bytes, that APFS, ext4 and NTFS all accept. */
const MAX_NAME_BYTES = 255;
const FORBIDDEN_NAME_CHARS = /[/\\:\u0000-\u001f\u007f]/;
/** Extensions that spell the same image format another way. */
const FORMAT_SPELLINGS: Readonly<Record<string, string>> = { jpeg: 'jpg', tiff: 'tif' };
/** Errors `link` raises on a volume without hard links. */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS']);

function badRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

/** Why `name` cannot be a file name, or null when it can. */
function projectFileNameProblem(name: string): string | null {
  if (!name) return 'Enter a file name.';
  if (name === '.' || name === '..') return `"${name}" cannot be a file name.`;
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    return 'File names cannot contain /, \\, : or control characters.';
  }
  if (name.startsWith('.')) return 'File names cannot start with a dot; that would hide the file.';
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return 'That file name is too long.';
  return null;
}

/** A file's format by extension: lowercase, one spelling per format. */
function formatOf(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return FORMAT_SPELLINGS[ext] ?? ext;
}

/**
 * The name to save for `typed`, never refused: a typed name ending in the
 * file's own format (any case or spelling, `.jpeg` for a `.jpg`) is used as
 * typed; anything else gets the old extension appended, so the file keeps its
 * type and dots inside a name ("v1.2 final", "notes.txt") stay part of it.
 */
export function nameToSave(oldName: string, typed: string): string {
  const oldExtension = path.extname(oldName);
  return oldExtension && formatOf(typed) === formatOf(oldName) ? typed : `${typed}${oldExtension}`;
}

/** Names that differ only in case or Unicode form reach one entry on a case-insensitive volume. */
function sameNameIgnoringCase(a: string, b: string): boolean {
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
}

async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

function nameTaken(name: string): AppError {
  return new AppError(
    `A file named "${name}" already exists in this folder.`,
    ErrorCode.CONFLICT,
    HTTP_STATUS.CONFLICT
  );
}

/**
 * Rename `source` to `dest` in one folder without ever replacing a file at
 * `dest`. A hard link claims the new name atomically (it fails if the name is
 * taken) before the old name is removed. On a volume without hard links the
 * name is checked and then renamed, which leaves a window of microseconds.
 */
async function renameWithoutOverwrite(source: string, dest: string): Promise<void> {
  const caseOnly = sameNameIgnoringCase(path.basename(source), path.basename(dest));
  try {
    await link(source, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'EEXIST') {
      if (caseOnly && (await sameFile(source, dest))) {
        await rename(source, dest);
        return;
      }
      throw nameTaken(path.basename(dest));
    }
    if (!LINK_UNSUPPORTED.has(code)) throw err;
    const existing = await lstat(dest).catch(() => null);
    if (existing && !(caseOnly && (await sameFile(source, dest)))) {
      throw nameTaken(path.basename(dest));
    }
    await rename(source, dest);
    return;
  }
  try {
    await rm(source);
  } catch (err) {
    await rm(dest, { force: true });
    throw err;
  }
}

/** Linked folders of every live (non-archived) project. */
export async function activeProjectRoots(): Promise<Array<{ id: string; folderPath: string }>> {
  const projects = await Projects.listAll();
  return projects
    .filter((p) => !p.archived && !!p.folderPath)
    .map((p) => ({ id: p.id, folderPath: p.folderPath as string }));
}

export async function renameProjectFile(
  requestedPath: string,
  typedName: string
): Promise<RenamedProjectFile> {
  if (!path.isAbsolute(requestedPath)) throw badRequest('path must be absolute');
  const target = canonicalFolder(requestedPath);
  const oldName = path.basename(target);
  if (!isRenamableProjectFile(oldName)) {
    throw badRequest('Only image files in a linked project folder can be renamed from Snaglet.');
  }

  const trimmed = typedName.trim();
  const typedProblem = projectFileNameProblem(trimmed);
  if (typedProblem) throw badRequest(typedProblem);
  const newName = nameToSave(oldName, trimmed);
  const problem = projectFileNameProblem(newName);
  if (problem) throw badRequest(problem);

  const notFound = new AppError(
    'File not found in a linked project folder',
    ErrorCode.NOT_FOUND,
    HTTP_STATUS.NOT_FOUND
  );
  const lexicalDir = path.dirname(target);
  let realDir: string | null = null;
  for (const root of await activeProjectRoots()) {
    realDir = await realFileWithin(root.folderPath, lexicalDir);
    if (realDir) break;
  }
  if (!realDir) throw notFound;

  const source = path.join(realDir, oldName);
  const info = await lstat(source).catch(() => null);
  if (!info) throw notFound;
  if (!info.isFile()) throw badRequest('Only files can be renamed here, not folders or links.');

  const renamedPath = path.join(lexicalDir, newName);
  if (newName === oldName) return { path: renamedPath, name: newName };

  try {
    await renameWithoutOverwrite(source, path.join(realDir, newName));
  } catch (err) {
    throw renameRefusal(err, oldName) ?? err;
  }
  logger.info(`[files] renamed ${source} to ${newName}`);
  return { path: renamedPath, name: newName };
}
