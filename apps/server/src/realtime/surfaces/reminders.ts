/**
 * Reminders surface, on the workspace channel:
 *
 * - `reminder:due` ({@link REMINDER_DUE_EVENT}), payload {@link ReminderDue}:
 *   a reminder fired; desktop clients show the in-app banner and play its
 *   sound. Sent once per reminder key (the delivery ledger dedupes).
 * - `reminders:changed` ({@link REMINDERS_CHANGED_EVENT}), payload `{}`:
 *   upcoming reminders may have moved (settings saved or removed, a calendar
 *   item written); the desktop shell refetches /api/reminders/upcoming and
 *   reschedules its native notifications.
 *
 * Calendar writes reach `reminders:changed` through the calendar surface;
 * table-row writes through {@link emitRemindersChangedForTable}, which only
 * fires for tables that hold reminder settings (an in-memory set the
 * reminders domain keeps current, so this file never touches the database).
 */
import {
  REMINDER_DUE_EVENT,
  REMINDERS_CHANGED_EVENT,
  type ReminderDue,
} from '@snaglet/shared/types';
import { WORKSPACE_EVENT_CHANNEL } from '@snaglet/shared/types/workspace-events';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { wsService } from '@server/services/WebSocketService';

let reminderTables: ReadonlySet<string> = new Set();

export function emitReminderDue(reminder: ReminderDue): void {
  try {
    wsService.broadcastToChannel(WORKSPACE_EVENT_CHANNEL, {
      type: REMINDER_DUE_EVENT,
      payload: reminder,
    });
  } catch (error) {
    logger.warn('[reminders] failed to broadcast reminder:due', { error: getErrorMessage(error) });
  }
}

export function emitRemindersChanged(): void {
  try {
    wsService.broadcastToChannel(WORKSPACE_EVENT_CHANNEL, {
      type: REMINDERS_CHANGED_EVENT,
      payload: {},
    });
  } catch (error) {
    logger.warn('[reminders] failed to broadcast reminders:changed', {
      error: getErrorMessage(error),
    });
  }
}

/** The tables whose rows have reminder settings (set by the reminders domain). */
export function setReminderTables(tableIds: Iterable<string>): void {
  reminderTables = new Set(tableIds);
}

/** `reminders:changed` after a write to `tableId`, when its rows have reminders. */
export function emitRemindersChangedForTable(tableId: string): void {
  if (reminderTables.has(tableId)) emitRemindersChanged();
}
