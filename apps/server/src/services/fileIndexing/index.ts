/**
 * fileIndexing — watch project folders and index their text files into the RAG
 * system, gated by per-folder opt-in (snaglet.config.json with embeddings.enabled).
 *
 * A folder tree is indexed by exactly one project (its "owner"); other projects
 * pointing at the same folder or a subfolder are "satellites" that reuse the
 * owner's index (see ownership.ts). Boot, gate-file edits, folder changes and a
 * periodic safety net all funnel through reindexAll. The reconciliation scan
 * owns correctness; the watcher is the low-latency path on top.
 */

import { Projects } from '@snaglet/db/tables/projects';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { gcOrphanFileEmbeddings } from '@server/services/embedding/fileContentEmbedding';
import { reconcileProjectFolderSymlinks } from '@server/services/projectFolder';
import {
  recoverProjectFolder,
  isProjectFolderMissing,
} from '@server/services/projectFolderRecovery';
import {
  ensureWatchConfig,
  readWatchConfig,
  watchConfigPath,
  type WatchConfig,
} from './watchConfig';
import { compileIgnoreRules, type IgnoreRules } from './exclusions';
import { forgetProjectHashedStats } from './hashedStatCache';
import { resolveOwnership, type FolderOwnership } from './ownership';
import { reconcileProject } from './reconcile';
import { createReindexScheduler, startPeriodicSweep } from './reindexScheduler';
import { clearFileIndexingImpact } from './scan';
import {
  hasFailedConfigWatcher,
  startConfigWatcher,
  stopAllConfigWatchers,
  stopConfigWatcher,
} from './configWatcher';
import {
  clearScanOnly,
  isWatchingProject,
  purgeProjectIndex,
  startProjectWatcher,
  stopAllWatchers,
  stopProjectWatcher,
} from './watcher';

/** Read + compile a folder's snaglet.config.json ignore rules in one step. */
async function loadIgnoreRules(folderPath: string): Promise<IgnoreRules> {
  return compileIgnoreRules(await readWatchConfig(folderPath));
}

/**
 * What the sweep should do with one project-with-folder: `active` (gate on in
 * both the DB mirror and the on-disk config: own, reconcile, watch), `pause`
 * (stop the watcher; rows and embeddings stay searchable), `unreachable` (a
 * pause because the folder or its gate file could not be read), or `purge`
 * (the folder exists but `snaglet.config.json` was removed from it). Invariant:
 * pausing never purges. `enabled: false` on either side or an invalid config
 * resolve to `pause`.
 */
type ProjectLifecycleDecision = 'active' | 'pause' | 'unreachable' | 'purge';

async function resolveProjectLifecycle(project: ProjectRow): Promise<ProjectLifecycleDecision> {
  let cfg: WatchConfig;
  try {
    cfg = await readWatchConfig(project.folderPath as string);
  } catch {
    return 'unreachable'; // never destroy data on ambiguity
  }
  if (cfg.status === 'missing') return 'purge';
  if (cfg.status === 'unreadable') return 'unreachable';
  if (cfg.status !== 'present') return 'pause'; // invalid — fail safe
  if (!cfg.enabled || !project.fileIndexingEnabled) return 'pause';
  return 'active';
}

/** Long enough to absorb the route write plus chokidar's settled-write event. */
const CONFIG_REINDEX_DEBOUNCE_MS = 750;

let stopPeriodicSweep: (() => void) | null = null;
/** Sweeps running now; a periodic sweep never starts on top of one. */
let sweepsInFlight = 0;
/** Linked, non-archived projects the latest sweep looked at. */
let sweptProjectIds = new Set<string>();
/** Projects the latest sweep paused because their folder could not be read. */
let unreachableProjectIds = new Set<string>();
/** Whether live watching is running on this instance (gated by RUN_BACKGROUND_WORKERS).
 * DB reconcile/purge still runs on folder changes regardless, so cleanup is never
 * silently skipped; only the chokidar watchers are conditional. */
let started = false;
/** Latest folder ownership, refreshed each reindexAll. The read path
 * (resolveFileProjectId) consults this so file searches in a satellite project
 * redirect to the owner's index without re-reading gate files on the hot path. */
let currentOwnership = new Map<string, FolderOwnership>();

/**
 * Resolve where a project's file searches should look. Returns the owning
 * project id plus the satellite's subpath ('' = the owner's whole tree, i.e.
 * the project is its own owner or shares the folder exactly). Returns null when
 * the project isn't a known indexing-eligible folder (caller falls back to
 * scoping to the project itself).
 */
export function getFileSearchScope(
  projectId: string
): { projectId: string; pathPrefix: string } | null {
  const own = currentOwnership.get(projectId);
  if (!own) return null;
  return { projectId: own.ownerProjectId, pathPrefix: own.prefix };
}

async function projectsWithFolder(): Promise<ProjectRow[]> {
  const all = await Projects.listAll();
  return all.filter((p) => !p.archived && p.folderPath != null && p.folderPath.trim().length > 0);
}

/** Watch a project's gate file so create/enable/disable/delete/edit flips take effect live. */
function watchProjectConfig(project: ProjectRow): void {
  // A gate edit can change enabled-state OR ignore rules OR folder ownership, so
  // re-sweep everything and refresh the watcher of the affected tree's owner.
  startConfigWatcher(project, () => scheduleProjectReindex('config changed', project.id));
}

/**
 * Make the index reflect current projects, gates and folder ownership. Owners
 * are reconciled and watched; paused projects only lose their watcher (rows and
 * embeddings stay searchable); a removed gate file or a satellite is purged, so
 * each tree is indexed exactly once. Ownership is global, so every folder/gate
 * change funnels through here. `changedProjectId` limits re-reconciliation to
 * that tree's owner; a full sweep reconciles every owner. DB reconcile/purge
 * runs regardless of `started`; only the chokidar watchers are gated on it.
 * `projectsOverride` scopes the sweep to an explicit project set.
 */
export async function reindexAll(
  label: string,
  changedProjectId?: string,
  projectsOverride?: ProjectRow[],
  preservedProjectIds = new Set<string>()
): Promise<void> {
  const scope: SweepScope =
    changedProjectId === undefined ? { kind: 'all' } : { kind: 'changed', changedProjectId };
  await sweep(label, scope, projectsOverride, preservedProjectIds);
}

/**
 * Which owners a sweep reconciles. Every sweep also reconciles an owner without
 * a live watcher; `gaps` adds the listed projects (a failed gate-file watcher
 * leaves the project watcher running).
 */
type SweepScope =
  | { kind: 'all' }
  | { kind: 'changed'; changedProjectId: string }
  | { kind: 'gaps'; projectIds: ReadonlySet<string> };

async function sweep(
  label: string,
  scope: SweepScope,
  projectsOverride: ProjectRow[] | undefined,
  preservedProjectIds = new Set<string>()
): Promise<void> {
  sweepsInFlight += 1;
  try {
    const projects = projectsOverride ?? (await projectsWithFolder());
    sweptProjectIds = new Set(projects.map((p) => p.id));
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      if (project.folderPath && (await isProjectFolderMissing(project.folderPath))) {
        const recovered = await recoverProjectFolder(project.id, {
          beforeApply: stopProjectFolderWatchers,
        });
        if (recovered.status === 'recovered') {
          projects[i] = recovered.project;
          preservedProjectIds.add(project.id);
        }
      }
    }
    // Gate-file liveness watchers run only on instances that own live watching.
    if (started) for (const p of projects) watchProjectConfig(p);

    // Ownership is computed among active projects only, so a project nested
    // under a parent whose indexing is off still owns its own subtree.
    //
    // A paused project only has its watcher stopped; its rows stay searchable
    // via the read path's fall-back-to-self scope. Only "snaglet.config.json removed
    // from an existing folder" purges.
    const active: ProjectRow[] = [];
    const unreachable = new Set<string>();
    for (const p of projects) {
      const decision = await resolveProjectLifecycle(p);
      if (decision === 'purge') {
        if (preservedProjectIds.has(p.id)) {
          await stopProjectWatcher(p.id);
          continue;
        }
        await purgeProjectIndex(p.id);
        continue;
      }
      if (decision === 'pause' || decision === 'unreachable') {
        if (decision === 'unreachable') unreachable.add(p.id);
        // Non-destructive by contract: stop watching, keep every indexed row.
        await stopProjectWatcher(p.id);
        continue;
      }
      active.push(p);
    }
    unreachableProjectIds = unreachable;
    const ownership = resolveOwnership(
      active.map((p) => ({
        id: p.id,
        folderPath: p.folderPath as string,
        createdAt: p.createdAt,
      }))
    );
    currentOwnership = ownership; // publish for the read-path redirect
    const ownerOfChanged =
      scope.kind === 'changed' ? ownership.get(scope.changedProjectId)?.ownerProjectId : undefined;

    let owners = 0;
    for (const p of active) {
      try {
        if (ownership.get(p.id)?.isOwner !== true) {
          if (preservedProjectIds.has(p.id)) continue;
          // Satellite → it must own no index (the owner indexes its tree once
          // for everyone). Purge stops the watcher and cascade-deletes its file
          // nodes + embedding references (no-op if already clean).
          await purgeProjectIndex(p.id);
          continue;
        }
        owners += 1;
        const rules = await loadIgnoreRules(p.folderPath as string);
        const isChangedOwner = p.id === ownerOfChanged;
        // Refresh live ignore rules for the tree that just changed.
        if (started && isChangedOwner && isWatchingProject(p.id)) {
          await stopProjectWatcher(p.id);
        }
        // Reconcile this owner on a full sweep, when it's the changed tree or a
        // listed gap, or when it isn't watched (e.g. just promoted from
        // satellite, or its watcher failed).
        if (
          scope.kind === 'all' ||
          isChangedOwner ||
          (scope.kind === 'gaps' && scope.projectIds.has(p.id)) ||
          !isWatchingProject(p.id)
        ) {
          await reconcileProject(p, rules);
        }
        if (started && !isWatchingProject(p.id)) startProjectWatcher(p, rules);
      } catch (err) {
        logger.error(`[fileIndexing] reindex failed for ${p.id}: ${getErrorMessage(err)}`);
      }
    }
    // Opportunistic GC: reconciles/purges above may have dropped the last
    // reference to some content — reap chunk sets nothing references anymore.
    await gcOrphanFileEmbeddings();

    logger.info(
      `[fileIndexing] ${label}: ${projects.length} project(s) with a folder, ${owners} owner(s) indexing`
    );
  } catch (err) {
    logger.error(`[fileIndexing] ${label} failed: ${getErrorMessage(err)}`);
  } finally {
    sweepsInFlight -= 1;
  }
}

const configReindexScheduler = createReindexScheduler(
  ({ label, projectId }) => reindexAll(label, projectId),
  CONFIG_REINDEX_DEBOUNCE_MS
);

/** Queue an ignore-rule reconciliation without making the config save wait for it. */
export function scheduleProjectReindex(label: string, projectId?: string): void {
  configReindexScheduler.schedule(label, projectId);
}

/** A proven move must never take the cleared-folder or satellite purge path. */
export async function onProjectFolderRelocated(projectId: string): Promise<void> {
  clearFileIndexingImpact(projectId);
  await stopProjectFolderWatchers(projectId);
  await reindexAll('folder relocated', projectId, undefined, new Set([projectId]));
}

/** Non-destructive teardown for a proven root relocation. */
export async function stopProjectFolderWatchers(projectId: string): Promise<void> {
  clearScanOnly(projectId); // a config/folder change earns a fresh watcher attempt
  forgetProjectHashedStats(projectId);
  await stopProjectWatcher(projectId);
  await stopConfigWatcher(projectId);
}

/**
 * Linked, non-archived projects from the latest sweep that rely on the periodic
 * sweep alone: an owner without a live watcher (it failed, or its folder went
 * missing), a folder the sweep could not read, or a failed gate-file watcher.
 */
export function projectsWithWatcherGap(): Set<string> {
  const gaps = new Set<string>();
  for (const projectId of sweptProjectIds) {
    const ownsTree = currentOwnership.get(projectId)?.isOwner === true;
    if (
      unreachableProjectIds.has(projectId) ||
      hasFailedConfigWatcher(projectId) ||
      (ownsTree && !isWatchingProject(projectId))
    ) {
      gaps.add(projectId);
    }
  }
  return gaps;
}

/**
 * The short-cadence sweep: the lifecycle and ownership pass covers every
 * project (ownership is global), but only projects with a watcher gap are
 * reconciled. Nothing runs when there is no gap.
 */
export async function sweepWatcherGaps(): Promise<void> {
  const gaps = projectsWithWatcherGap();
  if (gaps.size === 0) return;
  await sweep('watcher-gap scan', { kind: 'gaps', projectIds: gaps }, undefined);
}

/**
 * Bring the index in line after a project's folder path was set, changed, or
 * cleared. Called by the projects route once the save commits. Tears down the
 * project's watchers, purges a cleared/deleted project, then delegates to
 * {@link reindexAll} (a folder change can promote or demote other projects).
 * Never throws: the folder path is already saved, so failures are logged and
 * the periodic sweep is the backstop.
 */
export async function onProjectFolderChanged(projectId: string): Promise<void> {
  try {
    clearFileIndexingImpact(projectId);
    await stopProjectFolderWatchers(projectId);

    const project = await Projects.findById(projectId);
    if (!project || !project.folderPath || project.folderPath.trim().length === 0) {
      // Folder cleared or project deleted — no working tree, so drop its index.
      // A satellite that was nested under it may now need to own its tree, so
      // still re-sweep the rest.
      await purgeProjectIndex(projectId);
    }
    await reindexAll('folder changed', projectId);
  } catch (err) {
    logger.error(
      `[fileIndexing] onProjectFolderChanged failed for ${projectId}: ${getErrorMessage(err)}`
    );
  }
}

/** Start file indexing (boot sweep + gate liveness + periodic safety net). */
export function startFileIndexing(): void {
  started = true;
  void (async () => {
    // Rename `~/.snaglet/projects/project-…` alias dirs from older homes to the
    // container id. Idempotent: a no-op once no such aliases remain.
    try {
      const projects = await projectsWithFolder();
      for (const project of projects) {
        // Existing explicit opt-outs are retained; only seed reachable roots.
        if (
          project.folderPath &&
          (await readWatchConfig(project.folderPath)).status === 'present'
        ) {
          await ensureWatchConfig(project.folderPath, project.id).catch((err) => {
            logger.warn(
              `[fileIndexing] marker initialization failed for ${project.id}: ${getErrorMessage(err)}`
            );
          });
        }
      }
      await reconcileProjectFolderSymlinks();
    } catch (err) {
      logger.error(`[fileIndexing] symlink reconcile failed: ${getErrorMessage(err)}`);
    }
    await reindexAll('bootstrap');
  })();
  stopPeriodicSweep ??= startPeriodicSweep({
    all: () => reindexAll('periodic scan'),
    gaps: sweepWatcherGaps,
    busy: () => sweepsInFlight > 0,
  });
}

/** Stop all watchers and the periodic timer (graceful shutdown). */
export async function stopFileIndexing(): Promise<void> {
  started = false;
  configReindexScheduler.cancel();
  stopPeriodicSweep?.();
  stopPeriodicSweep = null;
  await stopAllConfigWatchers();
  await stopAllWatchers();
  logger.info('[fileIndexing] stopped');
}

export { reconcileProject } from './reconcile';
export { ensureWatchConfig } from './watchConfig';
export { getDefaultExclusions } from './exclusions';
export { readIndexConfig, writeIndexConfig, type IndexConfigEdits } from './projectConfig';
