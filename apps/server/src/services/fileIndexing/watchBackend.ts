/**
 * watchBackend — the one-time macOS diagnostic for chokidar's native backend,
 * plus the shared no-polling chokidar options.
 *
 * Snaglet never enables chokidar's polling watch mode (usePolling: false). With
 * fsevents (macOS) chokidar uses FSEvents; without it chokidar uses fs.watch
 * (inotify / ReadDirectoryChangesW), which is event-driven too. (awaitWriteFinish
 * still stats a file briefly while it is being written; that is not a standing
 * poll.) If native watching cannot start at all, the project falls back to the
 * periodic scan (see watcher.ts scan-only mode), never to polling.
 */

import { createRequire } from 'node:module';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

/** Spread into every chokidar.watch call. An explicit `false` also beats the
 * CHOKIDAR_USEPOLLING / CHOKIDAR_INTERVAL environment overrides. */
export const NEVER_POLL = { usePolling: false } as const;

let fseventsChecked = false;

/**
 * On macOS, try loading fsevents once and log a single warning if it is missing
 * (a packaging regression). Per-process, not per-project. `load` is injectable.
 */
export function warnIfFseventsUnavailable(
  platform: NodeJS.Platform = process.platform,
  load: () => unknown = () => createRequire(import.meta.url)('fsevents')
): void {
  if (fseventsChecked || platform !== 'darwin') return;
  fseventsChecked = true;
  try {
    load();
  } catch (err) {
    logger.warn(
      `[fileIndexing] fsevents unavailable; using fs.watch (no polling): ${getErrorMessage(err)}`
    );
  }
}

/** Test seam: re-arm the once-per-process diagnostic. */
export function resetFseventsCheckForTests(): void {
  fseventsChecked = false;
}
