import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@server/config/logger';
import { compileIgnoreRules, shouldExcludePath, type IgnoreRules } from './exclusions';
import { readWatchConfig } from './watchConfig';

/** Defends against pathological trees. If hit, the UI and logs both disclose it. */
const MAX_WALK_ENTRIES = 50_000;

export interface FileIndexingImpact {
  eligibleFiles: number;
  scannedEntries: number;
  capped: boolean;
}

/** A directory the walk could not list. Its subtree is UNKNOWN, not empty. */
interface UnreadableDir {
  /** Project-relative path; `''` means the root itself. */
  path: string;
  code: string;
}

/** Device + inode of the walked root, so callers can detect a moved/swapped root. */
export interface RootIdentity {
  dev: number;
  ino: number;
}

export interface ProjectFileScan {
  paths: string[];
  impact: FileIndexingImpact;
  /**
   * True only when every directory in the tree was listed and the entry cap was
   * not hit. An incomplete walk must never be read as "these files are gone".
   */
  complete: boolean;
  /** Directories that could not be listed (EACCES, EPERM, EIO, …). */
  unreadableDirs: UnreadableDir[];
  /** Root identity read before the walk; null when the root could not be stat'd. */
  rootIdentity: RootIdentity | null;
}

/** Read a folder's device/inode identity, or null if it is missing/unreadable. */
export async function readRootIdentity(folderPath: string): Promise<RootIdentity | null> {
  try {
    const s = await stat(folderPath);
    return s.isDirectory() ? { dev: s.dev, ino: s.ino } : null;
  } catch {
    return null;
  }
}

export function sameRootIdentity(a: RootIdentity | null, b: RootIdentity | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Readdir codes that mean "this directory is genuinely gone" (deleted, or
 * replaced by a file) rather than "we could not look". Anything else marks the
 * subtree unreadable so its indexed files are kept. A missing root is never
 * treated as gone here — the reconcile's root-identity check owns that case.
 */
const GONE_CODES = new Set(['ENOENT', 'ENOTDIR']);

interface CachedImpact {
  folderPath: string;
  rulesKey: string;
  impact: FileIndexingImpact;
}

const impactCache = new Map<string, CachedImpact>();
const activeScans = new Map<string, Promise<ProjectFileScan>>();

function rulesKey(rules: IgnoreRules): string {
  return JSON.stringify([
    rules.includePaths,
    rules.paths,
    [...rules.fileTypes].sort((a, b) => a.localeCompare(b)),
  ]);
}

export function cacheFileIndexingImpact(
  projectId: string,
  folderPath: string,
  rules: IgnoreRules,
  impact: FileIndexingImpact
): void {
  impactCache.set(projectId, { folderPath, rulesKey: rulesKey(rules), impact });
}

export function clearFileIndexingImpact(projectId: string): void {
  impactCache.delete(projectId);
}

/**
 * Walk only traversable paths. Excluded directories are counted as one scanned
 * entry and pruned; we intentionally do not descend merely to produce a large
 * "skipped files" number, because that would recreate the waste this feature
 * is meant to prevent.
 */
export async function scanProjectFiles(
  folderPath: string,
  rules: IgnoreRules,
  signal?: AbortSignal
): Promise<ProjectFileScan> {
  // A cancellable caller owns its traversal, never aborts a shared scan.
  if (signal) return walkProjectFiles(folderPath, rules, signal);
  const scanKey = `${folderPath}\0${rulesKey(rules)}`;
  const active = activeScans.get(scanKey);
  if (active) return active;

  const scan = walkProjectFiles(folderPath, rules);
  activeScans.set(scanKey, scan);
  try {
    return await scan;
  } finally {
    if (activeScans.get(scanKey) === scan) activeScans.delete(scanKey);
  }
}

async function walkProjectFiles(
  folderPath: string,
  rules: IgnoreRules,
  signal?: AbortSignal
): Promise<ProjectFileScan> {
  const paths: string[] = [];
  const stack: string[] = [''];
  const unreadableDirs: UnreadableDir[] = [];
  let scannedEntries = 0;
  let capped = false;
  const rootIdentity = await readRootIdentity(folderPath);
  const result = (): ProjectFileScan => ({
    paths,
    impact: { eligibleFiles: paths.length, scannedEntries, capped },
    complete: !capped && unreadableDirs.length === 0 && rootIdentity !== null,
    unreadableDirs,
    rootIdentity,
  });

  while (stack.length > 0) {
    signal?.throwIfAborted();
    const relDir = stack.pop() as string;
    const absDir = relDir ? path.join(folderPath, relDir) : folderPath;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      // A subdirectory deleted between its parent's listing and now is really
      // gone. Everything else (permissions, I/O, a vanished root) is UNKNOWN —
      // record it so the reconcile keeps that subtree's rows instead of
      // deleting them as if the folder were empty.
      if (relDir === '' || !GONE_CODES.has(code)) {
        unreadableDirs.push({ path: relDir, code });
        logger.warn(
          `[fileIndexing] could not read ${absDir} (${code}) — its indexed files are kept`
        );
      }
      continue;
    }
    for (const entry of entries) {
      if (scannedEntries >= MAX_WALK_ENTRIES) {
        capped = true;
        logger.warn(
          `[fileIndexing] walk cap ${MAX_WALK_ENTRIES} hit under ${folderPath} — remaining entries skipped this scan`
        );
        return result();
      }
      scannedEntries += 1;
      const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!shouldExcludePath(relPath, rules, 'directory')) stack.push(relPath);
      } else if (entry.isFile() && !shouldExcludePath(relPath, rules, 'file')) {
        paths.push(relPath);
      }
    }
  }

  return result();
}

/** Return a cached impact from reconciliation, or perform one bounded scan. */
export async function getFileIndexingImpact(
  projectId: string,
  folderPath: string
): Promise<FileIndexingImpact> {
  const rules = compileIgnoreRules(await readWatchConfig(folderPath));
  const cached = impactCache.get(projectId);
  if (cached?.folderPath === folderPath && cached.rulesKey === rulesKey(rules))
    return cached.impact;

  const scan = await scanProjectFiles(folderPath, rules);
  cacheFileIndexingImpact(projectId, folderPath, rules, scan.impact);
  return scan.impact;
}
