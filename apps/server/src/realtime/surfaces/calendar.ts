/**
 * Calendar surface: `calendar:changed` on the workspace channel, payload
 * {@link CalendarChangedEvent} (`{ kind, calendarId?, eventId?, automationId? }`), for
 * calendar, event, binding and automation writes only. Row writes stay on the tables
 * surface. Clients refetch their visible window. Each one is followed by `reminders:changed`:
 * any of those writes can move a reminder.
 */
import type { CalendarChangedEvent } from '@snaglet/shared/types';
import { WORKSPACE_EVENT_CHANNEL } from '@snaglet/shared/types/workspace-events';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { wsService } from '@server/services/WebSocketService';
import { emitRemindersChanged } from './reminders';

const CALENDAR_CHANGED_FRAME = 'calendar:changed';

export function emitCalendarChanged(event: CalendarChangedEvent): void {
  const payload: CalendarChangedEvent = {
    kind: event.kind,
    ...(event.calendarId ? { calendarId: event.calendarId } : {}),
    ...(event.eventId ? { eventId: event.eventId } : {}),
    ...(event.automationId ? { automationId: event.automationId } : {}),
  };
  try {
    wsService.broadcastToChannel(WORKSPACE_EVENT_CHANNEL, {
      type: CALENDAR_CHANGED_FRAME,
      payload,
    });
  } catch (error) {
    logger.warn('[calendar] failed to broadcast calendar:changed', {
      error: getErrorMessage(error),
    });
  }
  emitRemindersChanged();
}
