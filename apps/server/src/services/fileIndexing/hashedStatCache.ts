/**
 * hashedStatCache — per project, in memory, each file's stat when it was last
 * read and what that read found: its content hash, or a skip its bytes or size
 * alone decided (binary, too large). The reconcile settles an unchanged file
 * from one stat instead of reading it again.
 *
 * A file is settled from the cache only when its size, mtime, ctime, inode and
 * device all match the entry and, for a hash, the entry's hash equals the row's
 * content_hash. ctime is in the match because userland cannot set it; inode
 * and device because a file renamed over it or a retargeted symlink is another
 * file. Anything else is read again. The cache starts empty on every boot, so
 * the first scan after a restart reads every file.
 */

import type { Stats } from 'node:fs';
import { sameRootIdentity, type RootIdentity } from './scan';

export type CachedRead = { kind: 'hashed'; contentHash: string } | { kind: 'skipped' };

interface CachedEntry {
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
  read: CachedRead;
}

interface ProjectEntries {
  folderPath: string;
  root: RootIdentity;
  entries: Map<string, CachedEntry>;
}

/**
 * A file whose mtime or ctime is this close to the moment of its stat is not
 * remembered: a second write inside the file system's timestamp granularity
 * (1 s on HFS+, 2 s on FAT) could leave the stat unchanged.
 */
const RECENT_WRITE_MS = 2_000;

const projects = new Map<string, ProjectEntries>();
let clock: () => number = Date.now;

/** The time to pass to {@link rememberRead} as `statAt`: read it before the stat. */
export function readStatClock(): number {
  return clock();
}

/** Test seam for the recent-write clock. */
export function setHashedStatClockForTests(next: (() => number) | null): void {
  clock = next ?? Date.now;
}

/**
 * Bind a project's cache to the folder and root a walk just saw. A different
 * folder or root identity (moved, swapped or remounted) starts it empty.
 */
export function openHashedStats(
  projectId: string,
  folderPath: string,
  root: RootIdentity | null
): void {
  if (!root) {
    projects.delete(projectId);
    return;
  }
  const current = projects.get(projectId);
  if (current?.folderPath === folderPath && sameRootIdentity(current.root, root)) return;
  projects.set(projectId, { folderPath, root, entries: new Map() });
}

/** What the last read of this file found, when its stat has not moved since. */
export function cachedRead(
  projectId: string,
  relativePath: string,
  info: Stats
): CachedRead | null {
  const entry = projects.get(projectId)?.entries.get(relativePath);
  if (
    !entry ||
    entry.sizeBytes !== info.size ||
    entry.mtimeMs !== info.mtimeMs ||
    entry.ctimeMs !== info.ctimeMs ||
    entry.ino !== info.ino ||
    entry.dev !== info.dev
  ) {
    return null;
  }
  return entry.read;
}

/**
 * Record what a read found against the stat taken just before it, at `statAt`.
 * A no-op until a reconcile has opened the project's cache for this folder.
 */
export function rememberRead(
  projectId: string,
  folderPath: string,
  relativePath: string,
  info: Stats,
  statAt: number,
  read: CachedRead
): void {
  const current = projects.get(projectId);
  if (current?.folderPath !== folderPath) return;
  if (statAt - Math.max(info.mtimeMs, info.ctimeMs) < RECENT_WRITE_MS) {
    current.entries.delete(relativePath);
    return;
  }
  current.entries.set(relativePath, {
    sizeBytes: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    ino: info.ino,
    dev: info.dev,
    read,
  });
}

export function forgetHashedStat(projectId: string, relativePath: string): void {
  projects.get(projectId)?.entries.delete(relativePath);
}

export function forgetProjectHashedStats(projectId: string): void {
  projects.delete(projectId);
}
