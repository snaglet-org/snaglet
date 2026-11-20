/**
 * Notification system — shared types between server and client.
 *
 * Notifications are created server-side by event hooks (run failures,
 * mentions, tool approvals) and delivered in real time via WebSocket.
 * They persist in the DB so the notification center can show recent
 * history even after reconnect.
 */

export type NotificationType =
  | 'run_completed'
  | 'run_failed'
  | 'mention'
  | 'tool_approval'
  | 'thread_activity'
  | 'app_update'
  /** An automation an agent scheduled or changed, auto-paused, or missed. */
  | 'automation';

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  threadId: string | null;
  agentId: string | null;
  runId: string | null;
  read: boolean;
  dismissed: boolean;
  createdAt: string;
}
