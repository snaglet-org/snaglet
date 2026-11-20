/**
 * reconcile — the correctness backbone for file indexing. The watcher misses
 * offline changes (git pull, branch switch, rename), so this disk↔DB diff,
 * with disk as the authority, is the source of truth. Deletes happen only for
 * what the walk saw was gone: none if the root is missing or swapped
 * (device/inode) or the walk hit its entry cap; rows under an unlistable
 * subfolder are kept; a mass removal is held until a person releases it
 * (`allowMassRemoval`) with a matching count (see removalSafety.ts). The root
 * is re-checked before every removal.
 */

import { Files } from '@snaglet/db/tables/files';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { emitFileIndexingImpactChanged } from '@server/realtime/surfaces/fileEmbeddings';
import { compileIgnoreRules, type IgnoreRules } from './exclusions';
import { readWatchConfig } from './watchConfig';
import { ingestFile, removeFile } from './ingest';
import { forgetProjectHashedStats, openHashedStats } from './hashedStatCache';
import { beginProjectScan, endProjectScan } from './projectIndexingStatus';
import {
  cacheFileIndexingImpact,
  readRootIdentity,
  sameRootIdentity,
  scanProjectFiles,
} from './scan';
import { heldRemovalsMatch, isMassRemoval, isUnderAnyDir } from './removalSafety';

export interface ReconcileResult {
  upserted: number;
  unchanged: number;
  removed: number;
  skipped: number;
  /**
   * Rows not on disk that were kept anyway: under an unreadable folder, or held
   * back by the mass-removal backstop. Left for the next full reconcile.
   */
  kept: number;
  /**
   * Set when a person's release (`allowMassRemoval`) was not applied: the fresh
   * count does not match what they confirmed, or the walk was incomplete.
   * Nothing beyond a normal reconcile happened; the hold (if any) is updated.
   */
  releaseRefused?: {
    reason: 'count-changed' | 'incomplete-walk';
    found: number;
    expected: number;
    total: number;
  };
}

export interface ReconcileOptions {
  /**
   * A person confirmed removing `expected` held files. Skips only the
   * mass-removal check, and only when the fresh count matches (see
   * heldRemovalsMatch). Never passed by the watcher, sweeps, agents or hooks.
   */
  allowMassRemoval?: { expected: number };
}

/** Thrown when the project root vanished or was swapped; nothing was deleted. */
class ReconcileRootChangedError extends Error {
  constructor(projectId: string, folderPath: string) {
    super(
      `project folder ${folderPath} is missing or was moved during the scan — no files were removed (project ${projectId})`
    );
    this.name = 'ReconcileRootChangedError';
  }
}

/** Files ingested between yields, so a large scan never holds the event loop for long. */
const INGEST_BATCH_SIZE = 100;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Bidirectional disk↔DB reconcile for one project. No-op when folder is unset.
 *
 * Applies the project's `ignorePaths`/`ignoreFileTypes` (passed in, or read from
 * snaglet.config.json when omitted). Because ignored paths are absent from the disk
 * walk's `seen` set, the DB→disk half deletes any file node + embeddings that a
 * tightened rule now excludes — so editing the rules and re-reconciling is the
 * cleanup of stale embeddings.
 */
export async function reconcileProject(
  project: ProjectRow,
  rules?: IgnoreRules,
  signal?: AbortSignal,
  options: ReconcileOptions = {}
): Promise<ReconcileResult> {
  const result: ReconcileResult = { upserted: 0, unchanged: 0, removed: 0, skipped: 0, kept: 0 };
  if (!project.folderPath) return result;
  const folderPath = project.folderPath;
  const startedAt = performance.now();
  // Observational runtime marker so the UI can show "scanning" and stamp
  // "last checked". Failures release the marker with the error recorded.
  beginProjectScan(project.id);
  try {
    const effectiveRules = rules ?? compileIgnoreRules(await readWatchConfig(project.folderPath));

    // disk → DB: ingest new/changed files. A file whose stat still matches its
    // last hash is counted unchanged without a read (hashedStatCache.ts).
    const scan = await scanProjectFiles(folderPath, effectiveRules, signal);
    const diskPaths = scan.paths;
    // Publish the footprint as soon as the bounded traversal completes. The
    // potentially much longer ingest/delete phase must not hold the estimate UI.
    cacheFileIndexingImpact(project.id, folderPath, effectiveRules, scan.impact);
    emitFileIndexingImpactChanged(project.id, scan.impact);
    openHashedStats(project.id, folderPath, scan.rootIdentity);
    const rowsByPath = new Map(
      (await Files.listByProject(project.id)).map((row) => [row.relativePath, row])
    );
    const seen = new Set<string>();
    for (let i = 0; i < diskPaths.length; i++) {
      if (i > 0 && i % INGEST_BATCH_SIZE === 0) await yieldToEventLoop();
      signal?.throwIfAborted();
      const relPath = diskPaths[i];
      seen.add(relPath);
      const status = await ingestFile(project, relPath, effectiveRules, {
        existing: rowsByPath.get(relPath) ?? null,
        trustUnchangedStat: true,
      });
      if (status === 'upserted') result.upserted += 1;
      else if (status === 'unchanged') result.unchanged += 1;
      else result.skipped += 1;
    }

    // DB → disk: drop file nodes whose path no longer exists on disk or is now
    // excluded by the current rules (offline delete + newly-ignored cleanup) —
    // but only paths the walk could actually vouch for. The rows are re-read
    // here so the mass-removal total counts what this ingest just added.
    const rootStillSame = async () =>
      sameRootIdentity(scan.rootIdentity, await readRootIdentity(folderPath));
    const throwRootChanged = (): never => {
      forgetProjectHashedStats(project.id);
      throw new ReconcileRootChangedError(project.id, folderPath);
    };
    if (!(await rootStillSame())) throwRootChanged();

    const dbFiles = await Files.listByProject(project.id);
    const unreadable = scan.unreadableDirs.map((d) => d.path);
    const candidates: string[] = [];
    for (const file of dbFiles) {
      if (seen.has(file.relativePath)) continue;
      if (isUnderAnyDir(file.relativePath, unreadable)) result.kept += 1;
      else candidates.push(file.relativePath);
    }

    const warnings: string[] = [];
    let held: { count: number; total: number } | null = null;
    const release = options.allowMassRemoval;
    if (release) {
      if (scan.impact.capped) {
        result.releaseRefused = {
          reason: 'incomplete-walk',
          found: candidates.length,
          expected: release.expected,
          total: dbFiles.length,
        };
      } else if (!heldRemovalsMatch(candidates.length, release.expected)) {
        result.releaseRefused = {
          reason: 'count-changed',
          found: candidates.length,
          expected: release.expected,
          total: dbFiles.length,
        };
      }
    }
    const releaseApplies = release !== undefined && result.releaseRefused === undefined;
    if (unreadable.length > 0) {
      const list = scan.unreadableDirs.map((d) => `${d.path || '.'} (${d.code})`).join(', ');
      warnings.push(`kept ${result.kept} file(s) under unreadable folder(s): ${list}`);
    }
    if (scan.impact.capped) {
      result.kept += candidates.length;
      warnings.push(
        `walk hit its entry cap — kept ${candidates.length} file(s) it could not confirm were deleted`
      );
    } else if (!releaseApplies && isMassRemoval(candidates.length, dbFiles.length)) {
      result.kept += candidates.length;
      held = { count: candidates.length, total: dbFiles.length };
      warnings.push(
        `${candidates.length} of ${dbFiles.length} indexed files are missing from the folder; Snaglet kept them in case this was a mistake (mass-removal backstop)`
      );
    } else {
      if (releaseApplies) {
        logger.warn(
          `[fileIndexing] reconcile ${project.id}: removing ${candidates.length} of ${dbFiles.length} missing file(s) — confirmed by a person (expected ${release?.expected})`
        );
      }
      for (const relPath of candidates) {
        signal?.throwIfAborted();
        // A move can land mid-phase: stop deleting the moment the root changes.
        if (!(await rootStillSame())) throwRootChanged();
        await removeFile(project, relPath);
        result.removed += 1;
      }
    }

    const warning = warnings.length > 0 ? warnings.join('; ') : undefined;
    if (warning) logger.warn(`[fileIndexing] reconcile ${project.id}: ${warning}`);
    logger.info(
      `[fileIndexing] reconciled ${project.id}: +${result.upserted} new/changed, ${result.unchanged} unchanged, -${result.removed} removed (skipped ${result.skipped}, kept ${result.kept}) in ${Math.round(performance.now() - startedAt)} ms`
    );
    endProjectScan(project.id, undefined, true, warning, held);
    return result;
  } catch (err) {
    endProjectScan(
      project.id,
      signal?.aborted ? undefined : getErrorMessage(err),
      !signal?.aborted
    );
    throw err;
  }
}
