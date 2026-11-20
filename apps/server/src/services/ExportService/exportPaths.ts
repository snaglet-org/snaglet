/**
 * exportPaths — the destination guard for `POST /api/export`.
 *
 * Export is a write-anywhere primitive by design: the endpoint is callable by
 * the UI, by agents as a tool, and by authenticated external MCP clients, and
 * the native save dialog is a convenience rather than an authorization step.
 * Nothing downstream re-checks the destination. **These guards are therefore
 * the only control, not belt-and-braces** — do not relax them on the grounds
 * that the picker already constrained the path, because for two of the three
 * callers there is no picker.
 *
 * The contract is `{ destDir, fileName }`, never a single file path:
 *  - `destDir` must be an EXISTING directory, so it can be realpath-resolved.
 *    A not-yet-created file has no realpath, which is exactly why the file
 *    path itself is never the thing we resolve.
 *  - `fileName` is collapsed to one segment by `safeFilename`.
 *
 * `resolveExportTarget` performs the only path join in the export service.
 * With one guarded directory and one single-segment name, traversal is not
 * something the code defends against — it has nowhere to express itself.
 */

import path from 'path';
import { realpath, stat } from 'fs/promises';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { SNAGLET_HOME } from '@server/services/snagletHome';

function reject(message: string): never {
  throw new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

/**
 * Is `candidate` the Snaglet home directory, or inside it?
 *
 * Note the equality arm. The containment idiom used elsewhere in the server
 * (`target.startsWith(root + sep)`, see snagletHome.clearSnagletVoiceStorageModel) is
 * deliberately exclusive of the root itself, which is right when you are
 * confirming something lives under a root you own. Inverted into a deny check
 * it would permit writing directly into `~/.snaglet` — the one directory this
 * guard most needs to protect. Both arms, always.
 *
 * Exported for direct testing: this predicate is the guard.
 */
export function isWithinSnagletHome(
  candidate: string,
  snagletHome: string = SNAGLET_HOME
): boolean {
  const root = path.resolve(snagletHome);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Is `candidate` a filesystem root (`/`, or `C:\` on Windows)? */
export function isFilesystemRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return path.dirname(resolved) === resolved;
}

/**
 * Validate an export destination directory and return its canonical form.
 *
 * Order matters: the path is realpath-resolved first, then checked. Resolving
 * afterward would let a symlink pointing into `~/.snaglet` pass a check performed
 * on the link's own harmless-looking path — which is the whole reason the
 * guard uses symlink resolution rather than string comparison.
 *
 * `snagletHome` is injectable so the guard can be exercised against a temp home
 * without the test having to relocate the real one.
 */
export async function resolveExportDir(
  destDir: string,
  snagletHome: string = SNAGLET_HOME
): Promise<string> {
  const raw = destDir.trim();
  if (!raw) reject('destDir is required when writing to disk.');
  if (!path.isAbsolute(raw)) reject(`destDir must be an absolute path: ${raw}`);

  // Must already exist — resolve symlinks before any comparison.
  let resolved: string;
  try {
    resolved = await realpath(raw);
  } catch {
    reject(`Destination folder does not exist: ${raw}`);
  }

  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) reject(`Destination is not a folder: ${raw}`);

  if (isFilesystemRoot(resolved)) {
    reject('Refusing to export to the filesystem root. Choose a folder.');
  }
  if (isWithinSnagletHome(resolved, snagletHome)) {
    // Named explicitly: a user who picked a symlink has no way to know it
    // landed here, and a silent "invalid path" would send them hunting.
    reject(
      `Refusing to export into Snaglet's own storage (${snagletHome}). ` +
        'Choose a folder outside it — exports written there would be treated as app data.'
    );
  }

  return resolved;
}

/**
 * The one path join in the service.
 *
 * `fileName` must already have been through `safeFilename` /
 * `safeFilenameWithExtension`; this asserts that rather than trusting it, so a
 * future caller that forgets fails loudly here instead of writing outside the
 * guarded directory.
 */
export function resolveExportTarget(resolvedDir: string, fileName: string): string {
  if (fileName !== path.basename(fileName) || !fileName.trim()) {
    throw new AppError(
      `Export filename must be a single path segment: ${fileName}`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return path.join(resolvedDir, fileName);
}
