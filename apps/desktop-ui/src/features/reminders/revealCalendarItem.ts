/**
 * Open a calendar event from a reminder: the caller opens the Calendar pane,
 * this moves it to the event's day and, once the event is drawn, opens its
 * popover the way a click does (the item is a button; its key is
 * `event:<id>`, see `CalendarOccurrenceBase.key`).
 */
import { calendarApi } from '@desktop/features/calendar/calendarApi';
import { instantToZoned, viewerTimeZone } from '@desktop/features/calendar/calendarDates';
import { jumpCalendarTo } from '@desktop/features/calendar/calendarViewStore';

const FIND_TRIES = 40;
const FIND_EVERY_MS = 100;

/** The event's day in the viewer's zone, from the reminder's start or the event itself. */
async function eventDay(eventId: string, startsAt: string | null): Promise<string | null> {
  const zone = viewerTimeZone();
  if (startsAt && !Number.isNaN(Date.parse(startsAt))) return instantToZoned(startsAt, zone).date;
  try {
    const { event } = await calendarApi.getEvent(eventId);
    return event.time.kind === 'timed'
      ? instantToZoned(event.time.startAt, zone).date
      : event.time.startDate;
  } catch {
    return null;
  }
}

function findEventItem(eventId: string): HTMLElement | null {
  const key = `event:${eventId}`;
  for (const el of document.querySelectorAll<HTMLElement>('[data-calendar-item]')) {
    // The grid's own item, not a copy in a floating "+N more" list.
    if (el.closest('[data-calendar-surface]')) continue;
    const k = el.dataset.key;
    if (k === key || k?.startsWith(`${key}:`)) return el;
  }
  return null;
}

export async function revealCalendarEvent(eventId: string, startsAt: string | null): Promise<void> {
  const day = await eventDay(eventId, startsAt);
  if (day) jumpCalendarTo(day);
  for (let i = 0; i < FIND_TRIES; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, FIND_EVERY_MS));
    const item = findEventItem(eventId);
    if (item) {
      item.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      item.click();
      return;
    }
  }
}
