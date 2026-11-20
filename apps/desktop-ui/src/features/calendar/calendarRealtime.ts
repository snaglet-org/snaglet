/**
 * Calendar realtime plumbing.
 *
 * - `calendar:changed` (the server's calendar surface) arrives on the workspace WS
 *   channel. The shared bridge drops event types it doesn't know, so the
 *   calendar listens to the raw channel itself and accepts both the
 *   `calendar:changed` and `calendar.changed` spellings.
 * - Row changes arrive on the tables surface (`subscribeTableEvents`). Only
 *   entries of a bound table matter; field / lifecycle changes always refetch
 *   (a binding may have moved).
 * - Bursts (agents' bulk edits) collapse into one trailing refetch ~250 ms
 *   after the last event.
 * - Our own writes echo back; `markOwnWrite` lets the echo be swallowed once
 *   so an optimistic write isn't followed by a second refetch. A batch is
 *   our echo only when every entry it names is (`isOwnEchoOfAll`).
 */
import type { Calendar, CalendarChangedEvent } from '@snaglet/shared/types';
import type { TableEvent } from '@desktop/features/database/tableEvents';

const CALENDAR_REFETCH_DEBOUNCE_MS = 250;
const OWN_ECHO_WINDOW_MS = 4000;

export interface Coalescer {
  trigger: () => void;
  cancel: () => void;
}

export function createCoalescer(
  run: () => void,
  delayMs = CALENDAR_REFETCH_DEBOUNCE_MS
): Coalescer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function relevantTableChange(event: TableEvent, calendars: readonly Calendar[]): boolean {
  switch (event.type) {
    case 'table.entries.changed':
      return calendars.some((c) => c.boundFields.some((f) => f.tableId === event.tableId));
    case 'table.fields.changed':
    case 'table.removed':
    case 'table.restored':
    case 'tables.invalidated':
      return true;
    default:
      return false;
  }
}

export function parseCalendarChanged(message: {
  type?: unknown;
  payload?: unknown;
}): CalendarChangedEvent | null {
  if (message.type !== 'calendar:changed' && message.type !== 'calendar.changed') return null;
  const payload = (message.payload ?? {}) as Partial<CalendarChangedEvent> & { type?: string };
  const kind = payload.kind;
  if (kind !== 'calendar' && kind !== 'event' && kind !== 'binding' && kind !== 'automation')
    return null;
  return {
    kind,
    ...(payload.calendarId ? { calendarId: payload.calendarId } : {}),
    ...(payload.eventId ? { eventId: payload.eventId } : {}),
    ...(payload.automationId ? { automationId: payload.automationId } : {}),
  };
}

const ownWrites = new Map<string, number>();

/** Note a write this client made, so its echo can be skipped. Keys: `event:<id>`, `entry:<table>:<entry>`, `calendar:<id>`. */
export function markOwnWrite(key: string): void {
  ownWrites.set(key, Date.now() + OWN_ECHO_WINDOW_MS);
}

/** True (once) when an incoming change is the echo of our own recent write. */
export function isOwnEcho(key: string): boolean {
  return isOwnEchoOfAll([key]);
}

/**
 * True (once) when every key is the echo of our own recent write, using up
 * those marks. A change that also names a write that isn't ours (an agent's
 * batch over our row and others) is not our echo, and keeps our live marks
 * for the echo still to come; expired marks go either way.
 */
export function isOwnEchoOfAll(keys: readonly string[]): boolean {
  const now = Date.now();
  const own = keys.length > 0 && keys.every((key) => (ownWrites.get(key) ?? -1) >= now);
  for (const key of keys) {
    const until = ownWrites.get(key);
    if (until !== undefined && (own || until < now)) ownWrites.delete(key);
  }
  return own;
}

export function __resetCalendarRealtimeForTests(): void {
  ownWrites.clear();
}
