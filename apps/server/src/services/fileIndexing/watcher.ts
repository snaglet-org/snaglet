/**
 * watcher — per-project chokidar watcher with a batched, debounced dirty queue.
 *
 * The watcher is the live-latency optimization on top of the reconciliation
 * scan (which owns correctness). Its only job is to mark paths dirty and drain
 * them through the shared ingest path — never embed inline. chokidar earns its
 * dependency here: node:fs watch can't reliably distinguish add vs delete
 * without a stat, while chokidar gives clean add/change/unlink plus
 * awaitWriteFinish (so a half-written file isn't read mid-save).
 *
 * Batching: a git pull touching 800 files collapses into one drain via the
 * per-project debounce. Last-event-wins per path (a Map, not two sets) so an
 * add-then-delete within the window resolves to the final on-disk state.
 *
 * Removal safety: moving or deleting the watched folder makes
 * chokidar report every file as unlinked. A drain therefore only applies a
 * removal while (a) this watcher is still the active one and (b) the root still
 * exists with the device/inode it had when watching began — re-checked before
 * every removal, so a move landing mid-drain stops the deletes there. If the
 * root is gone or swapped, the queued removals are dropped and the watcher
 * stops through the same non-destructive pause as an unreadable config: the
 * rows stay, and the next sweep resumes (and reconciles) when the folder is
 * back or its path is updated. A mass-removal backstop (removalSafety.ts)
 * holds back any batch that would empty most of the project.
 */

import path from 'node:path';
import type { Stats } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import type { NodeRunner } from '@snaglet/db/tables/nodes';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import { Files } from '@snaglet/db/tables/files';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { gcOrphanFileEmbeddings } from '@server/services/embedding/fileContentEmbedding';
import { shouldExcludePath, type IgnoreRules } from './exclusions';
import { ingestFile, removeFile } from './ingest';
import { forgetHashedStat, forgetProjectHashedStats } from './hashedStatCache';
import { emitFileEmbeddingCoverageChanged } from '@server/realtime/surfaces/fileEmbeddings';
import { recordProjectIndexingWarning } from './projectIndexingStatus';
import { isMassRemoval } from './removalSafety';
import { readRootIdentity, sameRootIdentity, type RootIdentity } from './scan';
import { NEVER_POLL, warnIfFseventsUnavailable } from './watchBackend';

/** Collect a burst of FS events into one drain. */
const DRAIN_DEBOUNCE_MS = 500;

type Intent = 'upsert' | 'remove';

interface ProjectWatcher {
  watcher: FSWatcher;
  project: ProjectRow;
  pending: Map<string, Intent>;
  timer: NodeJS.Timeout | null;
  /** Compiled snaglet.config.json ignore rules, captured at watcher start. A config
   * edit restarts the watcher (see index.reevaluateProject) so these stay fresh. */
  rules: IgnoreRules;
  /** Root device/inode when watching began; resolved asynchronously at start. */
  rootIdentity: Promise<RootIdentity | null>;
}

const watchers = new Map<string, ProjectWatcher>();

/** Projects whose watcher hit a fatal error (inotify limit, too many open
 * files, unreadable root): value = when it failed. The periodic scan keeps them
 * correct; the watcher is retried at most once per {@link SCAN_ONLY_RETRY_MS}. */
const scanOnly = new Map<string, number>();
const SCAN_ONLY_RETRY_MS = 60 * 60_000;
let now: () => number = Date.now;

/** Test seam for the scan-only retry clock. */
export function setWatcherClockForTests(clock: (() => number) | null): void {
  now = clock ?? Date.now;
}

export function isWatchingProject(projectId: string): boolean {
  return watchers.has(projectId);
}

export function getProjectWatchMode(projectId: string): 'live' | 'scan-only' | 'off' {
  if (watchers.has(projectId)) return 'live';
  return scanOnly.has(projectId) ? 'scan-only' : 'off';
}

/** Forget a scan-only mark so the next sweep may try a watcher again (config or
 * folder change, purge). */
export function clearScanOnly(projectId: string): void {
  scanOnly.delete(projectId);
}

/**
 * Fatal = this watcher cannot be trusted to keep running: the inotify watch
 * limit (ENOSPC), too many open files (EMFILE/ENFILE), or no permission on the
 * watched root. Everything else (EBUSY, EPERM on one file while Windows locks it
 * mid-save) is transient: the path is picked up by the next event or scan.
 */
function isFatalWatchError(err: unknown, folderPath: string): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOSPC' || code === 'EMFILE' || code === 'ENFILE') return true;
  if (code === 'EPERM' || code === 'EACCES') {
    // Only the watched root itself; an error with no path can't be attributed.
    const errPath = (err as NodeJS.ErrnoException).path;
    return errPath !== undefined && path.resolve(errPath) === path.resolve(folderPath);
  }
  return false;
}

function fatalWatchAdvice(code: string | undefined): string {
  if (code === 'ENOSPC') return 'raise fs.inotify.max_user_watches';
  if (code === 'EMFILE' || code === 'ENFILE') return 'raise the open-file limit (ulimit -n)';
  return 'check permissions on the project folder';
}

async function failToScanOnly(pw: ProjectWatcher, err: unknown): Promise<void> {
  if (!isActive(pw)) return; // already handled (one warning per failure)
  const code = (err as NodeJS.ErrnoException).code;
  scanOnly.set(pw.project.id, now());
  const msg = `live file watching failed (${code ?? 'error'}: ${getErrorMessage(err)}); falling back to the periodic scan. To fix: ${fatalWatchAdvice(code)}`;
  logger.warn(`[fileIndexing] ${pw.project.id}: ${msg}`);
  recordProjectIndexingWarning(pw.project.id, msg);
  await stopProjectWatcher(pw.project.id);
}

function scheduleDrain(pw: ProjectWatcher): void {
  if (pw.timer) clearTimeout(pw.timer);
  pw.timer = setTimeout(() => void drain(pw), DRAIN_DEBOUNCE_MS);
}

function isActive(pw: ProjectWatcher): boolean {
  return watchers.get(pw.project.id) === pw;
}

/** True while the watched root is still the same directory it was at start. */
async function rootIntact(pw: ProjectWatcher): Promise<boolean> {
  const folderPath = pw.project.folderPath;
  if (!folderPath) return false;
  return sameRootIdentity(await pw.rootIdentity, await readRootIdentity(folderPath));
}

/**
 * The root vanished or was swapped: drop the queued removals and stop watching,
 * keeping every indexed row. This is the same non-destructive pause the sweep
 * applies to an `unreadable` config — the next sweep resumes the project once
 * the folder is readable again (or its path is updated).
 */
async function pauseForLostRoot(pw: ProjectWatcher, droppedRemovals: number): Promise<void> {
  if (!isActive(pw)) return;
  const msg = `project folder ${pw.project.folderPath ?? ''} is missing or was moved — watching paused, ${droppedRemovals} queued removal(s) dropped, indexed files kept`;
  logger.warn(`[fileIndexing] ${pw.project.id}: ${msg}`);
  recordProjectIndexingWarning(pw.project.id, msg);
  await stopProjectWatcher(pw.project.id);
}

async function drain(pw: ProjectWatcher): Promise<void> {
  pw.timer = null;
  if (!isActive(pw)) return;
  // Snapshot then reset so events arriving mid-drain queue for the next cycle.
  const batch = pw.pending;
  pw.pending = new Map();

  const removals = [...batch.values()].filter((i) => i === 'remove').length;
  if (removals > 0 && !(await rootIntact(pw))) {
    await pauseForLostRoot(pw, removals);
    return;
  }

  let holdRemovals = false;
  if (removals > 0) {
    const total = await Files.countByProject(pw.project.id);
    if (isMassRemoval(removals, total)) {
      holdRemovals = true;
      const msg = `${removals} of ${total} indexed files are missing from the folder; Snaglet kept them in case this was a mistake. The next full check will look again`;
      logger.warn(`[fileIndexing] ${pw.project.id}: ${msg}`);
      recordProjectIndexingWarning(pw.project.id, msg);
    }
  }

  let up = 0;
  let rm = 0;
  let applied = 0;
  for (const [rel, intent] of batch) {
    // A stop (pause, purge, config change) mid-drain halts the rest of it.
    if (!isActive(pw)) return;
    try {
      if (intent === 'upsert') {
        if ((await ingestFile(pw.project, rel, pw.rules)) === 'upserted') up += 1;
        continue;
      }
      if (holdRemovals) continue;
      // Re-check before every removal: a move can land mid-drain.
      if (!(await rootIntact(pw))) {
        await pauseForLostRoot(pw, removals - applied);
        return;
      }
      if (!isActive(pw)) return;
      applied += 1;
      if (await removeFile(pw.project, rel)) rm += 1;
    } catch (err) {
      logger.error(`[fileIndexing] drain failed for ${pw.project.id}:${rel}`, err);
    }
  }
  if (up || rm) {
    logger.info(`[fileIndexing] ${pw.project.id}: watch batch indexed +${up} -${rm}`);
  }
}

/**
 * Start watching a project's folder. No-op if the folder is unset or already
 * watched. Assumes the caller has already run reconcileProject for the initial
 * tree (ignoreInitial: true), so the watcher only handles subsequent changes.
 *
 * `rules` are the project's compiled snaglet.config.json ignore rules; both the
 * chokidar `ignored` predicate and the per-event filter honor them so ignored
 * paths never get watched or ingested. Pass {@link EMPTY_IGNORE_RULES} when none.
 */
export function startProjectWatcher(project: ProjectRow, rules: IgnoreRules): void {
  const folderPath = project.folderPath;
  if (!folderPath) return;
  if (watchers.has(project.id)) return;
  const failedAt = scanOnly.get(project.id);
  if (failedAt !== undefined) {
    if (now() - failedAt < SCAN_ONLY_RETRY_MS) return; // the periodic scan covers it
    scanOnly.delete(project.id);
  }
  warnIfFseventsUnavailable();

  const watcher = chokidar.watch(folderPath, {
    ...NEVER_POLL,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: (p: string, stats?: Stats) => {
      const rel = path.relative(folderPath, p);
      if (rel === '') return false; // never ignore the watched root itself
      // When chokidar has no stat yet, be conservative and keep a possible
      // parent directory traversable. File events are filtered exactly below.
      const kind = stats?.isFile() ? 'file' : 'directory';
      return shouldExcludePath(rel, rules, kind);
    },
  });

  const pw: ProjectWatcher = {
    watcher,
    project,
    pending: new Map(),
    timer: null,
    rules,
    rootIdentity: readRootIdentity(folderPath),
  };
  watchers.set(project.id, pw);

  const mark = (intent: Intent) => (p: string) => {
    const rel = path.relative(folderPath, p);
    if (!rel) return;
    if (intent === 'upsert' && shouldExcludePath(rel, rules, 'file')) return;
    // An event means the file changed, so no scan may trust its old stat.
    forgetHashedStat(project.id, rel);
    pw.pending.set(rel, intent);
    scheduleDrain(pw);
  };

  watcher
    .on('add', mark('upsert'))
    .on('change', mark('upsert'))
    .on('unlink', mark('remove'))
    .on('unlinkDir', (p: string) => {
      // The watched root itself went away (moved/deleted): pause right now
      // rather than waiting for the debounce to drain the flood of unlinks.
      if (path.relative(folderPath, p) !== '') return;
      if (pw.timer) clearTimeout(pw.timer);
      const dropped = [...pw.pending.values()].filter((i) => i === 'remove').length;
      pw.pending = new Map();
      void pauseForLostRoot(pw, dropped);
    })
    .on('error', (err) => {
      if (isFatalWatchError(err, folderPath)) {
        void failToScanOnly(pw, err);
        return;
      }
      // Transient (EBUSY, EPERM on one file): the next event or scan picks it up.
      logger.debug(
        `[fileIndexing] transient watcher error for ${project.id}: ${getErrorMessage(err)}`
      );
    });

  logger.info(`[fileIndexing] watching ${folderPath} (project ${project.id})`);
}

/** Stop watching a project (leaves indexed rows intact). */
export async function stopProjectWatcher(projectId: string): Promise<void> {
  const pw = watchers.get(projectId);
  if (!pw) return;
  if (pw.timer) clearTimeout(pw.timer);
  watchers.delete(projectId);
  await pw.watcher.close();
  logger.info(`[fileIndexing] stopped watching project ${projectId}`);
}

/**
 * Stop watching AND purge the project's index. This is the DESTRUCTIVE path,
 * reserved for genuine unconfigure signals: snaglet.config.json removed from a
 * still-existing folder, the folder path cleared, project demotion/deletion,
 * or satellite dedup (the tree's owner indexes it instead). Merely PAUSING
 * indexing (enabled:false) must call {@link stopProjectWatcher} instead —
 * never this.
 *
 * Deleting the file nodes drops this project's embedding REFERENCES only
 * (embeddings are content-addressed and possibly shared with other projects);
 * the GC pass then reaps any chunk sets nothing references anymore, so a purge
 * never breaks another project's search.
 */
export async function purgeProjectIndex(projectId: string, runner?: NodeRunner): Promise<void> {
  scanOnly.delete(projectId);
  forgetProjectHashedStats(projectId);
  await stopProjectWatcher(projectId);
  const removed = await Files.deleteByProject(projectId, runner);
  // A caller holding the ownership transaction must delete through that same
  // connection; GC waits for a later sweep rather than observing uncommitted rows.
  if (removed > 0 && !runner) await gcOrphanFileEmbeddings();
  if (removed > 0) emitFileEmbeddingCoverageChanged();
  logger.info(`[fileIndexing] purged ${removed} file node(s) for project ${projectId}`);
}

/** Stop every active watcher (shutdown). */
export async function stopAllWatchers(): Promise<void> {
  await Promise.all([...watchers.keys()].map((id) => stopProjectWatcher(id)));
}
