import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { Projects } from '@snaglet/db/tables/projects';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import type { NodeRunner } from '@snaglet/db/tables/nodes';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { emitTreeNodeUpdated } from '@server/realtime/surfaces/tree';
import { notificationService } from './NotificationService';
import { linkProjectFolder } from './projectFolder';
import { assertProjectFolderIdle } from './projectFolderImpact';
import { findProjectFolderByMarker } from './projectFolderIdentity';
import { findFolderOverlaps } from './fileIndexing/ownership';

/** Native following is deliberately unavailable until a helper is packaged and verified. */
export interface NativeFolderResolver {
  /** A found result must be proven filesystem identity, never a path guess. */
  resolve(
    projectId: string
  ): Promise<{ status: 'found'; path: string } | { status: 'unavailable' | 'missing' }>;
}
export const unavailableNativeFolderResolver: NativeFolderResolver = {
  resolve: async () => ({ status: 'unavailable' }),
};

export type FolderRecoveryResult =
  | { status: 'recovered'; project: ProjectRow }
  | {
      status:
        | 'unlinked'
        | 'present'
        | 'missing'
        | 'ambiguous'
        | 'incomplete'
        | 'busy'
        | 'changed'
        | 'unverified'
        | 'failed';
    };

type RecoveryOptions = {
  candidate?: string;
  roots?: string[];
  nativeResolver?: NativeFolderResolver;
  /** Close old watchers only; must not purge or recursively invoke a sweep. */
  beforeApply?: (projectId: string) => Promise<void>;
};
const recovering = new Set<string>();
const reportedUnresolved = new Map<string, Set<string>>();
const missingNotices = new Set<string>();

async function notifyUnresolved(projectId: string, status: string): Promise<void> {
  if (missingNotices.has(projectId)) return;
  const project = await Projects.findById(projectId);
  if (!project || project.archived || !project.folderPath) return;
  // A concurrent manual relink may already have fixed the missing root.
  if (!(await isProjectFolderMissing(project.folderPath))) return;
  missingNotices.add(projectId);
  try {
    await notificationService.create({
      type: 'app_update',
      title: `${project.name} folder missing`,
      body: `Snaglet could not locate ${project.folderPath} (${status}). Your file index is kept and indexing is paused. Update the folder path in Project Properties to locate it.`,
    });
  } catch (err) {
    missingNotices.delete(projectId);
    logger.warn(`[projectFolder] missing notice failed for ${projectId}: ${getErrorMessage(err)}`);
  }
}

function reportUnresolved(projectId: string, status: string, detail?: string): void {
  let reported = reportedUnresolved.get(projectId);
  if (!reported) {
    reported = new Set();
    reportedUnresolved.set(projectId, reported);
  }
  if (reported.has(status)) return;
  reported.add(status);
  logger.warn(
    `[projectFolder] recovery unresolved for ${projectId}: ${status}${detail ? ` (${detail})` : ''}`
  );
}

/** Recovery must never silently turn an existing index into a purged satellite. */
async function hasRecoveryOverlap(
  projectId: string,
  candidate: string,
  runner?: NodeRunner
): Promise<boolean> {
  const others = await Promise.all(
    (await Projects.listAll(runner))
      .filter((project) => project.id !== projectId && !project.archived && project.folderPath)
      .map(async (project) => ({
        ...project,
        folderPath: project.folderPath
          ? await realpath(project.folderPath).catch(() => project.folderPath)
          : null,
      }))
  );
  return findFolderOverlaps(candidate, others).length > 0;
}

/** Permission/I/O errors are not evidence of a moved folder. */
export async function isProjectFolderMissing(folder: string): Promise<boolean> {
  try {
    await stat(folder);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

async function hasMatchingProjectMarker(folder: string, projectId: string): Promise<boolean> {
  try {
    if (!(await stat(folder)).isDirectory()) return false;
    const raw = await readFile(path.join(folder, 'snaglet.config.json'), 'utf8');
    const marker = safeJsonParse<unknown>(raw, null);
    return (
      marker !== null &&
      typeof marker === 'object' &&
      !Array.isArray(marker) &&
      (marker as Record<string, unknown>).projectId === projectId
    );
  } catch {
    return false;
  }
}

async function resolveNativeWithDeadline(
  resolver: NativeFolderResolver,
  projectId: string
): ReturnType<NativeFolderResolver['resolve']> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      resolver.resolve(projectId),
      new Promise<{ status: 'unavailable' }>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'unavailable' }), 2000);
      }),
    ]);
  } catch {
    return { status: 'unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function verifyRecoveryCandidate(
  folder: string,
  projectId: string,
  nativeProven: boolean
): Promise<boolean> {
  if (!nativeProven) return hasMatchingProjectMarker(folder, projectId);
  if (!(await stat(folder)).isDirectory()) return false;
  try {
    const raw = await readFile(path.join(folder, 'snaglet.config.json'), 'utf8');
    const marker = safeJsonParse<unknown>(raw, null);
    if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return false;
    const claimed = (marker as Record<string, unknown>).projectId;
    return claimed === undefined || claimed === projectId;
  } catch {
    // Missing config cannot be accepted until subsequent lifecycle sweeps persist
    // native identity; otherwise the removed-config gate would purge the index.
    return false;
  }
}

/** Recover only a missing root proven by its marker. Never clears file rows or changes opt-outs.
 * Called before the lifecycle gate decision; the caller reconciles the refreshed row.
 */
export async function recoverProjectFolder(
  projectId: string,
  options: RecoveryOptions = {}
): Promise<FolderRecoveryResult> {
  const result = await recoverProjectFolderOnce(projectId, options);
  if (
    result.status === 'recovered' ||
    result.status === 'present' ||
    result.status === 'unlinked'
  ) {
    reportedUnresolved.delete(projectId);
    missingNotices.delete(projectId);
  } else if (result.status !== 'changed') {
    reportUnresolved(projectId, result.status);
    if (result.status !== 'busy') {
      await notifyUnresolved(projectId, result.status).catch((err) => {
        logger.warn(
          `[projectFolder] missing notice check failed for ${projectId}: ${getErrorMessage(err)}`
        );
      });
    }
  }
  return result;
}

async function recoverProjectFolderOnce(
  projectId: string,
  options: RecoveryOptions
): Promise<FolderRecoveryResult> {
  if (recovering.has(projectId)) return { status: 'busy' };
  recovering.add(projectId);
  try {
    const original = await Projects.findById(projectId);
    if (!original || original.archived) return { status: 'changed' };
    if (!original.folderPath) return { status: 'unlinked' };
    const originalFolder = original.folderPath;
    if (!(await isProjectFolderMissing(originalFolder))) return { status: 'present' };
    try {
      assertProjectFolderIdle(projectId);
    } catch {
      return { status: 'busy' };
    }
    const native = options.candidate
      ? { status: 'unavailable' as const }
      : await resolveNativeWithDeadline(
          options.nativeResolver ?? unavailableNativeFolderResolver,
          projectId
        );
    const nativeProven = native.status === 'found';
    const discovered = options.candidate
      ? { status: 'found' as const, path: options.candidate }
      : native.status === 'found'
        ? native
        : await findProjectFolderByMarker(projectId, options.roots);
    if (discovered.status !== 'found') return discovered;
    const candidate = await realpath(discovered.path);
    if (!(await verifyRecoveryCandidate(candidate, projectId, nativeProven)))
      return { status: 'unverified' };
    const applied = await Projects.withFolderWriteLock<FolderRecoveryResult>(async (tx) => {
      // Discovery is outside the lock; all authority/ownership reads and alias
      // changes below share the same cross-process serialization boundary.
      const current = await Projects.findById(projectId, tx);
      if (!current || current.archived || current.folderPath !== originalFolder)
        return { status: 'changed' };
      if (!(await isProjectFolderMissing(originalFolder))) return { status: 'present' };
      if (!(await verifyRecoveryCandidate(candidate, projectId, nativeProven)))
        return { status: 'unverified' };
      if (await hasRecoveryOverlap(projectId, candidate, tx)) return { status: 'unverified' };
      try {
        assertProjectFolderIdle(projectId);
      } catch {
        return { status: 'busy' };
      }
      await options.beforeApply?.(projectId);
      try {
        assertProjectFolderIdle(projectId);
      } catch {
        return { status: 'busy' };
      }
      const latest = await Projects.findById(projectId, tx);
      if (!latest || latest.archived || latest.folderPath !== originalFolder)
        return { status: 'changed' };
      if (await hasRecoveryOverlap(projectId, candidate, tx)) return { status: 'unverified' };
      try {
        await linkProjectFolder(projectId, candidate);
        const project = await Projects.update(projectId, { folderPath: candidate }, tx);
        if (project) return { status: 'recovered', project };
        await linkProjectFolder(projectId, originalFolder);
        return { status: 'changed' };
      } catch (err) {
        await linkProjectFolder(projectId, originalFolder);
        throw err;
      }
    });
    if (applied.status !== 'recovered') return applied;
    const project = applied.project;
    emitTreeNodeUpdated({ id: project.id, kind: 'container', updatedAt: project.updatedAt });
    await notificationService
      .create({
        type: 'app_update',
        title: `${project.name} folder moved`,
        body: `${originalFolder} → ${candidate}`,
      })
      .catch((err) => {
        logger.warn(`[projectFolder] move notice failed for ${projectId}: ${getErrorMessage(err)}`);
      });
    logger.info(`[projectFolder] folder moved for ${projectId}: ${originalFolder} -> ${candidate}`);
    return { status: 'recovered', project };
  } catch (err) {
    reportUnresolved(projectId, 'failed', getErrorMessage(err));
    return { status: 'failed' };
  } finally {
    recovering.delete(projectId);
  }
}
