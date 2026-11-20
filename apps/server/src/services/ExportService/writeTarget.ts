/**
 * writeTarget — the actual export write. Only a human who confirmed "replace?"
 * in the native save dialog may overwrite; agents, MCP clients and
 * server-derived names get no-clobber with a deterministic ` (2)` suffix.
 * `resolveExportDir` guards the directory; here `O_NOFOLLOW`/`O_EXCL` defeat a
 * symlink final component and `nlink === 1` rejects a hard link. Create-first,
 * truncate last: an existing target is opened without `O_TRUNC`, checked via
 * the descriptor, then truncated. Windows (no `O_NOFOLLOW`) replaces the entry
 * with a written sibling; other platforms without either fail closed.
 */

import { lstat, open, rename, unlink, type FileHandle } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants as FS } from 'fs';
import path from 'path';
import { dedupeFilename } from './safeFilename';
import { resolveExportTarget } from './exportPaths';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { logger } from '@server/config/logger';

/** Absent on platforms that do not implement it (notably Windows). */
const O_NOFOLLOW = typeof FS.O_NOFOLLOW === 'number' ? FS.O_NOFOLLOW : 0;
const HAS_NOFOLLOW = O_NOFOLLOW !== 0;
/** Keeps a FIFO with no reader from blocking the open forever. */
const O_NONBLOCK = typeof FS.O_NONBLOCK === 'number' ? FS.O_NONBLOCK : 0;
const execFileAsync = promisify(execFile);

export interface WriteOutcome {
  /** Absolute path actually written. */
  path: string;
  /** The final single-segment filename (may carry a ` (2)` suffix). */
  fileName: string;
  /** True when an existing file was replaced. */
  overwritten: boolean;
}

function refuse(message: string): never {
  throw new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

/** Create `target` exclusively. Returns null when something is already there. */
async function createExclusive(target: string): Promise<FileHandle | null> {
  try {
    // O_EXCL refuses an existing path of any type — symlink, dangling symlink,
    // directory, FIFO — so this branch needs no further checks.
    return await open(target, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
}

/**
 * Replace the contents of an existing file, having first proven it is an
 * ordinary file with exactly one link.
 *
 * Every check runs against the open descriptor, never the path: validating a
 * path and then opening it is a TOCTOU, and the whole point here is that the
 * thing at this name may be adversarial.
 */
async function overwriteExisting(target: string, data: Buffer): Promise<void> {
  if (process.platform === 'win32') {
    await replaceWindowsFile(target, data);
    return;
  }
  if (!HAS_NOFOLLOW) {
    refuse(
      `Cannot safely replace ${path.basename(target)} on this platform: Snaglet cannot ` +
        'guarantee it will not write through a link. Export under a new name instead.'
    );
  }

  let handle: FileHandle;
  try {
    // No O_TRUNC — nothing is destroyed before the checks below pass.
    handle = await open(target, FS.O_WRONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      refuse(
        `Refusing to write through a symlink: ${path.basename(target)} is a link, ` +
          'and following it would leave the folder you chose.'
      );
    }
    if (code === 'EISDIR') refuse(`${path.basename(target)} is a folder, not a file.`);
    if (code === 'ENXIO') refuse(`${path.basename(target)} is not a regular file.`);
    // Vanished between the failed create and this open — the caller retries.
    throw err;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      refuse(
        `${path.basename(target)} is not a regular file, so Snaglet will not write to it. ` +
          'Choose a different name.'
      );
    }
    if (info.nlink !== 1) {
      // A hard link is indistinguishable from an ordinary file except here.
      refuse(
        `Refusing to replace ${path.basename(target)}: it is a hard link, so the same ` +
          'bytes are reachable from somewhere outside the folder you chose. ' +
          'Export under a different name.'
      );
    }
    // Only now is anything destroyed, and only through the validated handle.
    await handle.truncate(0);
    await handle.write(data, 0, data.byteLength, 0);
  } finally {
    await handle.close().catch((err: unknown) => {
      // Nothing actionable if the descriptor is already gone.
      logger.warn(`[export] file handle close failed: ${getErrorMessage(err)}`);
    });
  }
}

async function replaceWindowsFile(target: string, data: Buffer): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) refuse(`Refusing to replace a symlink: ${path.basename(target)}.`);
  if (!info.isFile()) refuse(`${path.basename(target)} is not a regular file.`);
  if (info.nlink !== 1) refuse(`Refusing to replace a hard link: ${path.basename(target)}.`);

  const temporary = path.join(path.dirname(target), `.snaglet-export-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', info.mode & 0o777);
  try {
    // Replacing a directory entry also replaces its ACL. Preserve the user's
    // existing restrictions before the new file receives any document bytes.
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ErrorActionPreference = "Stop"; Get-Acl -LiteralPath $env:SNAGLET_EXPORT_ACL_SOURCE | Set-Acl -LiteralPath $env:SNAGLET_EXPORT_ACL_TARGET',
      ],
      {
        windowsHide: true,
        timeout: 10_000,
        env: {
          ...process.env,
          SNAGLET_EXPORT_ACL_SOURCE: target,
          SNAGLET_EXPORT_ACL_TARGET: temporary,
        },
      }
    );
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    // libuv uses MoveFileExW(MOVEFILE_REPLACE_EXISTING). A concurrent change
    // to the final entry cannot redirect these bytes through a link: rename
    // replaces that entry, without opening the old target for writing.
    await rename(temporary, target);
  } finally {
    await handle.close().catch((err: unknown) => {
      logger.warn(`[export] temporary file close failed: ${getErrorMessage(err)}`);
    });
    await unlink(temporary).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') {
        logger.warn(`[export] temporary file cleanup failed: ${getErrorMessage(err)}`);
      }
    });
  }
}

/**
 * Write `data` into the (already guarded) `resolvedDir`.
 *
 * When `allowOverwrite` is false a collision advances to the next
 * deterministic candidate. Checking existence first and then writing would be
 * a race — between the check and the write another export (or the user) can
 * create the file, and the loser silently clobbers. The kernel arbitrates.
 */
export async function writeExport(
  resolvedDir: string,
  fileName: string,
  data: Buffer | string,
  allowOverwrite: boolean
): Promise<WriteOutcome> {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');

  if (allowOverwrite) {
    const target = resolveExportTarget(resolvedDir, fileName);
    // Create-first: the ordinary case is a new file, and it is safe by
    // construction. Only a genuine collision reaches the guarded path.
    const created = await createExclusive(target);
    if (created) {
      try {
        await created.write(bytes, 0, bytes.byteLength, 0);
      } finally {
        await created.close().catch((err: unknown) => {
          logger.warn(`[export] file handle close failed: ${getErrorMessage(err)}`);
        });
      }
      return { path: target, fileName, overwritten: false };
    }
    await overwriteExisting(target, bytes);
    return { path: target, fileName, overwritten: true };
  }

  const taken = new Set<string>();
  let candidate = fileName;
  for (;;) {
    const target = resolveExportTarget(resolvedDir, candidate);
    const handle = await createExclusive(target);
    if (!handle) {
      taken.add(candidate);
      candidate = dedupeFilename(fileName, taken);
      continue;
    }
    try {
      await handle.write(bytes, 0, bytes.byteLength, 0);
    } finally {
      await handle.close().catch((err: unknown) => {
        logger.warn(`[export] file handle close failed: ${getErrorMessage(err)}`);
      });
    }
    return { path: target, fileName: candidate, overwritten: false };
  }
}
