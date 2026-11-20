/**
 * Which reminders fire in a window: for every item with enabled settings,
 * the occurrences that start inside the window shifted by each of its
 * offsets, placed exactly as the calendar places them (events, repeating
 * rows through the calendar's own expansion, automation runs), each
 * producing one {@link ReminderDue} per (occurrence, offset or at-start)
 * whose `fireAt` is in the window.
 *
 * Only occurrences with a start time count: all-day events, date-only rows
 * and repeat periods never remind; done and skipped row occurrences don't
 * either. Deleted events, rows of a field no
 * longer bound to a calendar, and paused or canceled automations
 * produce nothing; settings whose item is gone simply produce nothing.
 *
 * The `key` is stable for an item, occurrence start and offset:
 * `<item key>@<start ISO>#start` or `#<amount><m|h|d>`, e.g.
 * `event:event-1@2026-03-09T13:00:00.000Z#15m`.
 */
import { Automations, type AutomationListRow } from '@snaglet/db/tables/automations';
import { Calendars, type CalendarRow } from '@snaglet/db/tables/calendars';
import {
  CalendarEvents,
  CalendarReaderUnavailableError,
  listBindings,
  type BindingMeta,
} from '@snaglet/db/tables/calendar_events';
import { Reminders, reminderDeliveryKeyPrefix } from '@snaglet/db/tables/reminders';
import type { ReminderDue, ReminderOffset, ReminderSettings } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { setReminderTables } from '@server/realtime/surfaces/reminders';
import { automationRunsBetween, intervalAnchors } from '../calendar/automationOccurrences';
import { entryOccurrences } from '../calendar/occurrences';
import { offsetMs } from './reminderInput';

/**
 * Most occurrences of one item a window reads: an every-minute automation or
 * a row repeating every minute stays bounded (the earliest ones), so the
 * upcoming list (and the native sync, which keeps the nearest 60) can't flood.
 */
const OCCURRENCES_PER_ITEM_WINDOW = 50;

const UNIT_LETTER = { minutes: 'm', hours: 'h', days: 'd' } as const;

/** One occurrence of an item: when it starts and how the calendar names it. */
interface ItemOccurrence {
  startsAt: number;
  title: string;
  calendarName: string | null;
}

/** A closed instant range [from, to] in milliseconds. */
interface Span {
  from: number;
  to: number;
}

/** The fire offsets of one settings row, in ms (0 = at the start), with their offset. */
function firings(settings: ReminderSettings): { ms: number; offset: ReminderOffset | null }[] {
  const out: { ms: number; offset: ReminderOffset | null }[] = settings.atStart
    ? [{ ms: 0, offset: null }]
    : [];
  for (const offset of settings.offsets) out.push({ ms: offsetMs(offset), offset });
  return out;
}

/**
 * Where an item's occurrences must start for one of its reminders to fire
 * in `window`: the window shifted later by each offset, merged where they
 * overlap (an hour-wide tick window with offsets 15m and 1d reads two small
 * spans, not a day).
 */
function startSpans(settings: ReminderSettings, window: Span): Span[] {
  return mergeSpans(
    firings(settings).map(({ ms }) => ({ from: window.from + ms, to: window.to + ms }))
  );
}

/** Spans sorted and merged where they overlap. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

function offsetToken(offset: ReminderOffset | null): string {
  return offset ? `${offset.amount}${UNIT_LETTER[offset.unit]}` : 'start';
}

/** The reminder key for an item, occurrence start and offset. */
function reminderKey(
  item: ReminderSettings['item'],
  startsAt: string,
  offset: ReminderOffset | null
): string {
  return `${reminderDeliveryKeyPrefix(item)}${startsAt}#${offsetToken(offset)}`;
}

function calendarTitle(calendars: Map<string, CalendarRow>, id: string | null): string | null {
  return (id && calendars.get(id)?.title) || null;
}

async function eventOccurrences(
  settings: ReminderSettings,
  calendars: Map<string, CalendarRow>
): Promise<ItemOccurrence[]> {
  if (settings.item.kind !== 'event') return [];
  const event = await CalendarEvents.findById(settings.item.eventId);
  if (!event || event.archived || event.time.kind !== 'timed') return [];
  const calendar = calendars.get(event.calendarId);
  if (!calendar) return [];
  return [
    { startsAt: Date.parse(event.time.startAt), title: event.title, calendarName: calendar.title },
  ];
}

async function automationOccurrencesFor(
  list: ReminderSettings[],
  spansOf: Map<ReminderSettings, Span[]>,
  calendars: Map<string, CalendarRow>
): Promise<Map<ReminderSettings, ItemOccurrence[]>> {
  const out = new Map<ReminderSettings, ItemOccurrence[]>();
  const ids = list.flatMap((s) => (s.item.kind === 'automation' ? [s.item.automationId] : []));
  if (!ids.length) return out;
  // Finished ones too: a once (or a repeat's last run) that just ran still
  // has its catch-up reminder. Paused and canceled ones fire nothing.
  const rows = await Automations.list({ ids, statuses: ['active', 'finished'] });
  const byId = new Map<string, AutomationListRow>(rows.map((row) => [row.id, row]));
  const intervalScheduleIds = rows
    .filter((row) => row.whenKind === 'interval' && row.scheduleId)
    .map((row) => row.scheduleId!);
  const anchors = await intervalAnchors(intervalScheduleIds);
  for (const settings of list) {
    if (settings.item.kind !== 'automation') continue;
    const row = byId.get(settings.item.automationId);
    if (!row) continue;
    const anchor = row.nextRunAt
      ? Date.parse(row.nextRunAt)
      : (row.scheduleId && anchors.get(row.scheduleId)) || Date.parse(row.createdAt);
    const occurrences: ItemOccurrence[] = [];
    for (const span of spansOf.get(settings) ?? []) {
      const runs = automationRunsBetween(
        row,
        anchor,
        new Date(span.from),
        new Date(span.to + 1),
        OCCURRENCES_PER_ITEM_WINDOW
      );
      for (const at of runs)
        occurrences.push({
          startsAt: at,
          title: row.name,
          calendarName: calendarTitle(calendars, row.calendarId),
        });
    }
    out.set(settings, occurrences);
  }
  return out;
}

async function rowOccurrencesFor(
  list: ReminderSettings[],
  spansOf: Map<ReminderSettings, Span[]>,
  calendars: Map<string, CalendarRow>
): Promise<Map<ReminderSettings, ItemOccurrence[]>> {
  const out = new Map<ReminderSettings, ItemOccurrence[]>();
  const rowSettings = list.filter((s) => s.item.kind === 'table_entry');
  if (!rowSettings.length) return out;
  const activeCalendarIds = [...calendars.values()].map((c) => c.id);
  const bindings = new Map<string, BindingMeta>(
    (await listBindings(activeCalendarIds)).map((binding) => [binding.fieldId, binding])
  );
  // One read per bound field per span, for all of its rows with reminders.
  const byField = new Map<string, ReminderSettings[]>();
  for (const settings of rowSettings) {
    if (settings.item.kind !== 'table_entry') continue;
    const binding = bindings.get(settings.item.fieldId);
    if (
      !binding ||
      binding.tableId !== settings.item.tableId ||
      binding.fieldType !== 'datetime' ||
      binding.tableState !== 'active' ||
      binding.fieldState !== 'active'
    )
      continue;
    const group = byField.get(binding.fieldId) ?? [];
    group.push(settings);
    byField.set(binding.fieldId, group);
  }
  for (const [fieldId, group] of byField) {
    const binding = bindings.get(fieldId)!;
    const entryIds = group.map((s) => (s.item.kind === 'table_entry' ? s.item.entryId : ''));
    const spans = mergeSpans(group.flatMap((s) => spansOf.get(s) ?? []));
    const seen = new Set<string>();
    for (const span of spans) {
      let found;
      try {
        found = await entryOccurrences(
          binding,
          entryIds,
          new Date(span.from).toISOString(),
          new Date(span.to + 1).toISOString()
        );
      } catch (error) {
        if (error instanceof CalendarReaderUnavailableError) return out;
        logger.warn(`[reminders] reading rows of field ${fieldId} failed`, {
          error: getErrorMessage(error),
        });
        break;
      }
      for (const occurrence of found) {
        if (occurrence.time.kind !== 'timed') continue;
        if (occurrence.status === 'done' || occurrence.status === 'skipped') continue;
        const settings = group.find(
          (s) => s.item.kind === 'table_entry' && s.item.entryId === occurrence.entryId
        );
        if (!settings) continue;
        const startsAt = Date.parse(occurrence.time.start);
        const dedupe = `${occurrence.entryId}@${startsAt}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const list = out.get(settings) ?? [];
        list.push({
          startsAt,
          title: occurrence.title,
          calendarName: calendarTitle(calendars, binding.calendarId),
        });
        out.set(settings, list);
      }
    }
  }
  // An interval repeat ("every 1 min") keeps only its earliest ones that can
  // fire (the read also returns blocks that merely overlap a span).
  for (const [settings, list] of out) {
    if (list.length <= OCCURRENCES_PER_ITEM_WINDOW) continue;
    const spans = spansOf.get(settings) ?? [];
    out.set(
      settings,
      list
        .filter((o) => spans.some((span) => o.startsAt >= span.from && o.startsAt <= span.to))
        .sort((a, b) => a.startsAt - b.startsAt)
        .slice(0, OCCURRENCES_PER_ITEM_WINDOW)
    );
  }
  return out;
}

interface ReminderWindow {
  /** Earliest fire time included. */
  from: Date;
  /** Latest fire time included. */
  to: Date;
}

function noteReminderTables(active: readonly ReminderSettings[]): void {
  setReminderTables(active.flatMap((s) => (s.item.kind === 'table_entry' ? [s.item.tableId] : [])));
}

/** Tell the realtime surface which tables have rows with reminders (after a settings write). */
export async function refreshReminderTables(): Promise<void> {
  noteReminderTables(await Reminders.listActive());
}

/**
 * Every reminder whose `fireAt` is in [from, to], oldest first (ties by
 * key). Also refreshes the surface's set of tables with row reminders.
 */
export async function remindersBetween(window: ReminderWindow): Promise<ReminderDue[]> {
  const span: Span = { from: window.from.getTime(), to: window.to.getTime() };
  const active = await Reminders.listActive();
  noteReminderTables(active);
  if (!active.length || span.to < span.from) return [];
  const calendars = new Map<string, CalendarRow>(
    (await Calendars.list()).map((calendar) => [calendar.id, calendar])
  );
  const spansOf = new Map<ReminderSettings, Span[]>(
    active.map((settings) => [settings, startSpans(settings, span)])
  );

  const occurrencesOf = new Map<ReminderSettings, ItemOccurrence[]>();
  const collect = async (
    label: string,
    read: () => Promise<Map<ReminderSettings, ItemOccurrence[]>>
  ) => {
    try {
      for (const [settings, list] of await read()) occurrencesOf.set(settings, list);
    } catch (error) {
      // One kind failing (say the tables reader is down) must not silence the others.
      logger.warn(`[reminders] reading ${label} failed`, { error: getErrorMessage(error) });
    }
  };
  await collect('events', async () => {
    const out = new Map<ReminderSettings, ItemOccurrence[]>();
    for (const settings of active)
      if (settings.item.kind === 'event')
        out.set(settings, await eventOccurrences(settings, calendars));
    return out;
  });
  await collect('automations', () => automationOccurrencesFor(active, spansOf, calendars));
  await collect('rows', () => rowOccurrencesFor(active, spansOf, calendars));

  const out: ReminderDue[] = [];
  for (const settings of active) {
    const occurrences = occurrencesOf.get(settings) ?? [];
    const seen = new Set<string>();
    for (const occurrence of occurrences) {
      const startsAt = new Date(occurrence.startsAt).toISOString();
      for (const { ms, offset } of firings(settings)) {
        const fireAt = occurrence.startsAt - ms;
        if (fireAt < span.from || fireAt > span.to) continue;
        const key = reminderKey(settings.item, startsAt, offset);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          key,
          item: settings.item,
          title: occurrence.title,
          calendarName: occurrence.calendarName,
          startsAt,
          fireAt: new Date(fireAt).toISOString(),
          offset,
          sound: settings.sound,
        });
      }
    }
  }
  out.sort((a, b) =>
    a.fireAt === b.fireAt ? (a.key < b.key ? -1 : 1) : a.fireAt < b.fireAt ? -1 : 1
  );
  return out;
}
