/**
 * NotificationService — creates, stores, and broadcasts notifications.
 *
 * Notifications are persisted in the `notifications` table and broadcast
 * via the workspace WS channel so connected clients receive them in real
 * time. The service also provides query methods for the REST API (list,
 * mark read, dismiss).
 *
 * ## Integration points
 *
 * This service is consumed by event-hook listeners (registered in
 * `registerNotificationHooks`), by `askNotifications` (one notification per
 * parked agent ask, dismissed when the ask settles) and by the
 * `/api/notifications` REST routes. It is not consumed directly by tools or
 * route handlers for mutations — those fire HookService events, and the
 * notification hooks translate events into notification records.
 */

import { randomUUID } from 'node:crypto';
import { Notifications, type CreateNotificationInput } from '@snaglet/db/tables/notifications';
import type { NotificationRecord, NotificationType } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  emitNotificationCreated,
  emitNotificationDismissed,
} from '@server/realtime/surfaces/notifications';
import { logger } from '@server/config/logger';
import { isHelperAgent, isHelperThread } from '@server/services/subagents/helperVisibility';

interface CreateNotificationParams {
  type: NotificationType;
  title: string;
  body?: string | null;
  threadId?: string | null;
  agentId?: string | null;
  runId?: string | null;
}

/**
 * Id prefix that marks an agent-ask notification (a tool-permission prompt or
 * a Triage question). Asks have no notification type of their own (that needs
 * a migration), so the id carries the marker the boot sweep keys off.
 */
export const ASK_NOTIFICATION_ID_PREFIX = 'notif-ask-';

class NotificationServiceClass {
  /**
   * Create and persist a notification, then broadcast it to all connected
   * clients via the workspace WS channel. Returns null, creating nothing, for
   * a subagent helper's thread or agent: helpers report to their orchestrator,
   * never to the user's notification feed.
   */
  async create(params: CreateNotificationParams): Promise<NotificationRecord | null> {
    const [helperThread, helperAgent] = await Promise.all([
      isHelperThread(params.threadId),
      isHelperAgent(params.agentId),
    ]);
    if (helperThread || helperAgent) return null;
    return this.persist(`notif-${randomUUID()}`, params);
  }

  /**
   * Create the notification for an agent ask: a parked tool-permission prompt
   * or Triage question the user must answer before the run can continue.
   * Unlike {@link create}, a subagent helper's ask IS announced: it waits in a
   * hidden thread nobody is looking at, so the feed is the only way the user
   * learns of it. The caller dismisses it when the ask settles.
   */
  async createAsk(params: CreateNotificationParams): Promise<NotificationRecord> {
    return this.persist(`${ASK_NOTIFICATION_ID_PREFIX}${randomUUID()}`, params);
  }

  private async persist(id: string, params: CreateNotificationParams): Promise<NotificationRecord> {
    const input: CreateNotificationInput = {
      id,
      type: params.type,
      title: params.title,
      body: params.body ?? null,
      threadId: params.threadId ?? null,
      agentId: params.agentId ?? null,
      runId: params.runId ?? null,
    };

    const record = await Notifications.insert(input);

    // Broadcast to all connected clients.
    try {
      emitNotificationCreated(record);
    } catch (err) {
      // Best-effort — the DB mutation succeeded, so the notification
      // exists even if the broadcast fails. Clients will pick it up on
      // the next list/refresh.
      logger.error('[notifications] broadcast failed', {
        error: getErrorMessage(err),
      });
    }

    return record;
  }

  /** List recent non-dismissed notifications. */
  async listRecent(limit = 50): Promise<NotificationRecord[]> {
    return Notifications.listRecent(limit);
  }

  /** Every still-showing notification of one type, not only the recent ones. */
  async listVisibleOfType(type: NotificationType): Promise<NotificationRecord[]> {
    return Notifications.listVisibleOfType(type);
  }

  /** Count unread, non-dismissed notifications. */
  async countUnread(): Promise<number> {
    return Notifications.countUnread();
  }

  /** Mark a single notification as read. */
  async markRead(id: string): Promise<NotificationRecord | null> {
    return Notifications.markRead(id);
  }

  /** Mark all unread, non-dismissed notifications as read. */
  async markAllRead(): Promise<number> {
    return Notifications.markAllRead();
  }

  /**
   * Dismiss (hide) a single notification, then tell every connected client
   * so each tray drops it, not only the window that asked.
   */
  async dismiss(id: string): Promise<NotificationRecord | null> {
    const record = await Notifications.dismiss(id);
    if (!record) return null;
    try {
      emitNotificationDismissed(record.id);
    } catch (err) {
      // Best-effort, like create: the row is dismissed either way and the
      // next list/refresh drops it.
      logger.error('[notifications] dismiss broadcast failed', {
        error: getErrorMessage(err),
      });
    }
    return record;
  }

  /**
   * Dismiss every agent-ask notification created before `createdBefore` and
   * still showing. Called once at boot: pending asks live in memory, so none
   * survives a restart and their notifications would otherwise ask for an
   * answer nobody can give. Asks this process already raised are newer.
   */
  async dismissStaleAsks(createdBefore: Date): Promise<number> {
    return Notifications.dismissByIdPrefix(ASK_NOTIFICATION_ID_PREFIX, createdBefore.toISOString());
  }

  /** Dismiss all non-dismissed notifications. */
  async dismissAll(): Promise<number> {
    return Notifications.dismissAll();
  }

  /** Prune old dismissed notifications (housekeeping). */
  async pruneOld(olderThanDays = 30): Promise<number> {
    return Notifications.pruneOld(olderThanDays);
  }
}

export const notificationService = new NotificationServiceClass();
