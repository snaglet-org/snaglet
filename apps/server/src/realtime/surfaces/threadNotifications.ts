/**
 * Thread run-alert realtime surface.
 *
 * A run ended in a thread the user asked to be told about. The tray entry is
 * already handled by the `notification.created` surface (a `run_completed` /
 * `run_failed` / question `mention` record); this event carries only the
 * alert — the OS banner and the chosen sound — so no duplicate tray entry
 * appears.
 *
 * Broadcast, like notifications: the settings belong to the thread, not to a
 * connection, so every window learns about it and each decides for itself
 * whether to alert (a window already watching that thread stays quiet).
 */

import type { ThreadRunAlert } from '@snaglet/shared/types';
import { emitWorkspaceEvent } from '../emit';

/** Tell every client to alert the user about a finished run in this thread. */
export function emitThreadRunAlert(alert: ThreadRunAlert): void {
  emitWorkspaceEvent({
    type: 'thread.run_alert',
    alert,
  });
}
