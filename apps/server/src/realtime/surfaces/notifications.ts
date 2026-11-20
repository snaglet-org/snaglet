/**
 * Notification realtime surface.
 *
 * Notifications are their own table, not workspace nodes, so they do not
 * travel on the `workspace.updated` node patch. They get their own event on
 * the same `workspace` channel so every connected client's notification tray
 * updates in real time.
 *
 * Broadcast (not addressed): a notification is workspace-level state — every
 * client shows the same tray — so the fan-out funnel is correct here, unlike
 * the addressed `ui` surface.
 */

import type { NotificationRecord } from '@snaglet/shared/types';
import { emitWorkspaceEvent } from '../emit';

/** Announce a freshly persisted notification to all connected clients. */
export function emitNotificationCreated(notification: NotificationRecord): void {
  emitWorkspaceEvent({
    type: 'notification.created',
    notification,
  });
}

/**
 * Announce that a notification was dismissed, so every client drops it from
 * its tray (and closes its OS banner). Fired for a user's dismissal and for
 * an agent ask that settled, so a stale "needs your approval" never lingers.
 */
export function emitNotificationDismissed(id: string): void {
  emitWorkspaceEvent({
    type: 'notification.dismissed',
    id,
  });
}
