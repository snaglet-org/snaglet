/**
 * configWatcher — the always-on chokidar watcher on each project's gate file
 * (snaglet.config.json), so create/enable/disable/delete/edit flips take effect live.
 *
 * Like the project watchers it has no polling mode (usePolling: false). On a
 * fatal watch error (inotify limit, too many open files) it warns once, closes,
 * and leaves that project's gate to the periodic scan (which sweeps it at the
 * short cadence while a mark is set); a retry is allowed at most once per hour,
 * or sooner after a config/folder change clears the mark.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { NEVER_POLL } from './watchBackend';
import { watchConfigPath } from './watchConfig';

const watchers = new Map<string, FSWatcher>();
/** projectId -> when its gate watcher last failed fatally. */
const failedAt = new Map<string, number>();
const RETRY_MS = 60 * 60_000;
let now: () => number = Date.now;

/** Test seam for the retry clock. */
export function setConfigWatcherClockForTests(clock: (() => number) | null): void {
  now = clock ?? Date.now;
}

export function startConfigWatcher(project: ProjectRow, onChange: () => void): void {
  if (!project.folderPath) return;
  if (watchers.has(project.id)) return;
  const failed = failedAt.get(project.id);
  if (failed !== undefined) {
    if (now() - failed < RETRY_MS) return; // the periodic scan re-reads the gate
    failedAt.delete(project.id);
  }
  const watcher = chokidar.watch(watchConfigPath(project.folderPath), {
    ...NEVER_POLL,
    ignoreInitial: true, // current state is handled by the boot sweep
    persistent: true,
    // Wait for the write to settle before firing. A non-atomic external editor
    // save can otherwise trigger reindexAll mid-write on a half-written (→
    // malformed → fail-safe-disabled) config, transiently purging the index.
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  watcher
    .on('add', onChange)
    .on('change', onChange)
    .on('unlink', onChange)
    .on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOSPC' && code !== 'EMFILE' && code !== 'ENFILE') {
        logger.debug(
          `[fileIndexing] config watcher error for ${project.id}: ${getErrorMessage(err)}`
        );
        return;
      }
      if (watchers.get(project.id) !== watcher) return; // already handled
      watchers.delete(project.id);
      failedAt.set(project.id, now());
      logger.warn(
        `[fileIndexing] ${project.id}: config file watching failed (${code}); config edits are picked up by the periodic scan`
      );
      void watcher.close();
    });
  watchers.set(project.id, watcher);
}

/** True while the project's gate file has no watcher because it failed. */
export function hasFailedConfigWatcher(projectId: string): boolean {
  return failedAt.has(projectId);
}

/** Close one project's gate watcher and forget a failure mark. */
export async function stopConfigWatcher(projectId: string): Promise<void> {
  failedAt.delete(projectId);
  const watcher = watchers.get(projectId);
  if (!watcher) return;
  watchers.delete(projectId);
  await watcher.close();
}

export async function stopAllConfigWatchers(): Promise<void> {
  failedAt.clear();
  const all = [...watchers.values()];
  watchers.clear();
  await Promise.all(all.map((w) => w.close()));
}
