/**
 * Notification store — module-level reactive state for the notification
 * center. Fed by:
 *   1. REST seed on connect/reconnect (`seedNotifications`)
 *   2. WS push events (`addNotification`, `removeNotification`)
 *   3. User actions (`markNotificationRead`, `dismissNotification`, etc.)
 *
 * Consumers subscribe via `useNotifications()` / `useUnreadCount()`.
 * Follows the same external-store pattern as `agentWorkState.ts`.
 */

import { useSyncExternalStore } from 'react';
import type { NotificationRecord } from '@snaglet/shared/types';

const items = new Map<string, NotificationRecord>();
const listeners = new Set<() => void>();

/** Cached, sorted (newest first) snapshot. */
let snapshot: NotificationRecord[] = [];
let unreadCount = 0;

function rebuildSnapshot(): void {
  snapshot = Array.from(items.values()).sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
  );
  unreadCount = snapshot.filter((n) => !n.read && !n.dismissed).length;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Add a notification from a WS push event. */
export function addNotification(record: NotificationRecord): void {
  items.set(record.id, record);
  rebuildSnapshot();
  notify();
}

/**
 * Drop a notification the server dismissed (`notification.dismissed`): the
 * user dismissed it elsewhere, or the agent ask it announced was settled.
 */
export function removeNotification(id: string): void {
  if (!items.delete(id)) return;
  rebuildSnapshot();
  notify();
}

/** Replace the set with a server snapshot (connect/reconnect seeding). */
export function seedNotifications(list: NotificationRecord[]): void {
  items.clear();
  for (const n of list) items.set(n.id, n);
  rebuildSnapshot();
  notify();
}

/** Mark a single notification as read (optimistic update). */
export function markNotificationRead(id: string): void {
  const existing = items.get(id);
  if (!existing || existing.read) return;
  items.set(id, { ...existing, read: true });
  rebuildSnapshot();
  notify();
}

/** Mark all notifications as read (optimistic update). */
export function markAllNotificationsRead(): void {
  let changed = false;
  for (const [id, n] of items) {
    if (!n.read && !n.dismissed) {
      items.set(id, { ...n, read: true });
      changed = true;
    }
  }
  if (changed) {
    rebuildSnapshot();
    notify();
  }
}

/** Dismiss a single notification (optimistic update — removes from visible list). */
export function dismissNotification(id: string): void {
  const existing = items.get(id);
  if (!existing || existing.dismissed) return;
  items.set(id, { ...existing, dismissed: true });
  rebuildSnapshot();
  notify();
}

/** Dismiss all notifications (optimistic update). */
export function dismissAllNotifications(): void {
  let changed = false;
  for (const [id, n] of items) {
    if (!n.dismissed) {
      items.set(id, { ...n, dismissed: true });
      changed = true;
    }
  }
  if (changed) {
    rebuildSnapshot();
    notify();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** All non-dismissed notifications, newest first. */
export function useNotifications(): NotificationRecord[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot
  );
}

/** Unread count — drives the bell badge. */
export function useUnreadCount(): number {
  return useSyncExternalStore(
    subscribe,
    () => unreadCount,
    () => unreadCount
  );
}

/**
 * Whether a tool-permission prompt is waiting in `threadId`: its
 * `tool_approval` ask notification is showing. The server dismisses that
 * notification the moment the prompt settles (answered, timed out, aborted).
 */
export function useToolApprovalPending(threadId: string): boolean {
  const pending = () =>
    !!threadId &&
    snapshot.some((n) => n.type === 'tool_approval' && n.threadId === threadId && !n.dismissed);
  return useSyncExternalStore(subscribe, pending, pending);
}
