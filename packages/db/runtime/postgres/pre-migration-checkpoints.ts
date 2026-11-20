import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { PRE_UPDATE_SNAPSHOT_RETENTION } from '@snaglet/shared/constants/backups';
import { formatBytes, getErrorMessage } from '@snaglet/shared/utils';

/**
 * The packaged app's pre-migration checkpoints: one folder per update, named
 * `<ISO timestamp with - for : and .>-<8 hex>`, holding `database.dump` and
 * `manifest.json`. A folder is written as `.preparing-<name>` and renamed
 * once complete. startup-upgrade.ts writes them; this module names, measures
 * and prunes them.
 */
const CHECKPOINT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
export const CHECKPOINT_STAGING_PREFIX = '.preparing-';

export function preMigrationCheckpointDir(snagletHome: string): string {
  return path.join(snagletHome, 'backups', 'pre-migration');
}

export function newCheckpointName(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
}

/** Entries of `root`, or none when the folder does not exist yet. */
async function readEntries(root: string): Promise<Dirent[]> {
  try {
    return await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Bytes under `dir`. A symlink counts as itself and is never followed. */
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    total += entry.isDirectory() ? await treeBytes(target) : (await lstat(target)).size;
  }
  return total;
}

/**
 * A staging folder this young may still be filling: another Snaglet process on the
 * same home could be mid-dump. Only older ones count as abandoned.
 */
const STAGING_MIN_AGE_MS = 60 * 60 * 1000;

/** Newest mtime of `dir` or anything under it. A symlink counts as itself. */
async function newestMtimeMs(dir: string): Promise<number> {
  let newest = (await lstat(dir)).mtimeMs;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    const mtime = entry.isDirectory() ? await newestMtimeMs(target) : (await lstat(target)).mtimeMs;
    newest = Math.max(newest, mtime);
  }
  return newest;
}

/** True when nothing in `dir` changed for STAGING_MIN_AGE_MS. Unreadable counts as fresh. */
async function isStale(dir: string): Promise<boolean> {
  const newest = await newestMtimeMs(dir).catch(() => Number.POSITIVE_INFINITY);
  return Date.now() - newest >= STAGING_MIN_AGE_MS;
}

/**
 * Completed checkpoint names among `entries`, newest first (names start with
 * the creation time). Only real directories with generated names count:
 * files, symlinks and anything a person put there are never checkpoints.
 */
function completedCheckpoints(entries: readonly Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isDirectory() && CHECKPOINT_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

export interface CheckpointSummary {
  count: number;
  totalBytes: number;
}

/** How many checkpoints `base` holds and their size on disk. Never throws. */
export async function summarizePreMigrationCheckpoints(base: string): Promise<CheckpointSummary> {
  const root = path.resolve(base);
  const names = completedCheckpoints(await readEntries(root).catch(() => []));
  let totalBytes = 0;
  for (const name of names) {
    totalBytes += await treeBytes(path.join(root, name)).catch(() => 0);
  }
  return { count: names.length, totalBytes };
}

export interface CheckpointPruneOptions {
  /** The checkpoint this boot just wrote: always kept, and nothing newer is removed. */
  current?: string;
  /** Checkpoints kept, counting `current`. */
  retain?: number;
}

export interface CheckpointPruneResult {
  removed: string[];
  bytesFreed: number;
}

/**
 * Keep the newest `retain` checkpoints in `base` and delete the older ones,
 * plus staging folders a crashed boot left half-written (untouched for
 * STAGING_MIN_AGE_MS). Call only after the migrations succeeded, holding the
 * migration lock. Only real directories whose names this module generates
 * are touched, never symlinks or anything else. Never throws: a folder that
 * cannot be removed is logged and skipped, and the next run retries it.
 */
export async function prunePreMigrationCheckpoints(
  base: string,
  options: CheckpointPruneOptions = {}
): Promise<CheckpointPruneResult> {
  const result: CheckpointPruneResult = { removed: [], bytesFreed: 0 };
  const root = path.resolve(base);
  try {
    const entries = await readEntries(root);
    const currentName = options.current ? path.basename(options.current) : undefined;
    // A clock change can give an older folder a later name; such a folder is
    // kept rather than risk deleting anything newer than this boot's snapshot.
    const olderThanCurrent = (name: string) => currentName === undefined || name < currentName;

    const newestFirst = completedCheckpoints(entries);
    const keep = new Set(
      newestFirst.slice(0, Math.max(1, options.retain ?? PRE_UPDATE_SNAPSHOT_RETENTION))
    );
    if (currentName) keep.add(currentName);
    const abandonedStaging: string[] = [];
    for (const entry of entries) {
      const stamp = entry.name.slice(CHECKPOINT_STAGING_PREFIX.length);
      if (
        entry.isDirectory() &&
        entry.name.startsWith(CHECKPOINT_STAGING_PREFIX) &&
        CHECKPOINT_NAME.test(stamp) &&
        olderThanCurrent(stamp) &&
        (await isStale(path.join(root, entry.name)))
      ) {
        abandonedStaging.push(entry.name);
      }
    }
    const doomed = [
      ...newestFirst.filter((name) => !keep.has(name) && olderThanCurrent(name)),
      ...abandonedStaging,
    ];

    for (const name of doomed) {
      const target = path.join(root, name);
      if (path.dirname(target) !== root) continue;
      try {
        const bytes = await treeBytes(target).catch(() => 0);
        await rm(target, { recursive: true, force: true });
        result.removed.push(name);
        result.bytesFreed += bytes;
      } catch (error: unknown) {
        console.warn(
          `[db] Could not remove old pre-migration checkpoint ${target}: ${getErrorMessage(error)}`
        );
      }
    }
  } catch (error: unknown) {
    console.warn(`[db] Could not prune old pre-migration checkpoints: ${getErrorMessage(error)}`);
  }
  if (result.removed.length > 0) {
    console.log(
      `[db] Pruned ${result.removed.length} old pre-migration checkpoint(s) from ${root}, ` +
        `freed ${formatBytes(result.bytesFreed)}: ${result.removed.join(', ')}`
    );
  }
  return result;
}
