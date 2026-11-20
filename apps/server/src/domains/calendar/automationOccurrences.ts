/**
 * Automation wakes on the calendar: once and repeat automations that
 * are active or finished, on the requested (active) calendars. A first-open
 * one has no fixed time, so only the wakes it ran show (each at that
 * day's `after`, its claim), none ahead. A paused
 * automation is left off the calendar entirely, past wakes included, until it
 * is resumed. Each wake is a 15-minute block at its time; it is never moved or resized from
 * the calendar (that would edit its rule). Every (interval) automations are
 * not wakes but spans ({@link automationIntervals}): one per day each is
 * active, from its start on, with no end.
 *
 * Status per wake: a logged schedule run decides (succeeded → done, skipped
 * → skipped, failed → skipped with `note: 'failed'`); a past wake with no run
 * since the automation existed is skipped (it was paused then, or Snaglet was
 * off); the rest are upcoming. Repeats expand
 * with the shared tableRecurrence engine (automationTiming).
 */
import { getDb } from '@snaglet/db/db';
import {
  Automations,
  automationWhen,
  type AutomationListRow,
} from '@snaglet/db/tables/automations';
import type {
  CalendarAutomationOccurrence,
  CalendarIntervalSpan,
  ScheduleRunStatus,
} from '@snaglet/shared/types';
import {
  intervalWindowOf,
  nextWindowedIntervalRun,
  repeatRunsBetween,
} from '@snaglet/shared/utils';

/** How long a wake is drawn, in minutes (display only). */
const AUTOMATION_OCCURRENCE_MINUTES = 15;
/** Most wakes one window returns. */
const AUTOMATION_OCCURRENCES_CAP = 200;
/** Most Every automations one window draws (each gets a span per day). */
const AUTOMATION_INTERVALS_CAP = 50;
/** A wake this recent with no run yet is still about to run, not missed. */
const DUE_SLACK_MS = 5 * 60_000;

interface LoggedRun {
  status: ScheduleRunStatus;
  error: string | null;
}

export interface AutomationOccurrencesWindow {
  calendarIds: readonly string[];
  fromInstant: string;
  toInstant: string;
  now?: Date;
}

async function runsInWindow(
  scheduleIds: string[],
  from: Date,
  to: Date
): Promise<Map<string, Map<number, LoggedRun>>> {
  const out = new Map<string, Map<number, LoggedRun>>();
  if (!scheduleIds.length) return out;
  const { rows } = await getDb().query<{
    schedule_id: string;
    scheduled_for: string | Date;
    status: ScheduleRunStatus;
    error: string | null;
  }>(
    `SELECT schedule_id, scheduled_for, status, error FROM public.schedule_runs
      WHERE schedule_id = ANY($1::text[]) AND scheduled_for >= $2 AND scheduled_for < $3`,
    [scheduleIds, from.toISOString(), to.toISOString()]
  );
  for (const row of rows) {
    const bySchedule = out.get(row.schedule_id) ?? new Map<number, LoggedRun>();
    bySchedule.set(new Date(row.scheduled_for).getTime(), { status: row.status, error: row.error });
    out.set(row.schedule_id, bySchedule);
  }
  return out;
}

/** Planned wakes of one once / repeat automation inside [from, to), at most `limit`. */
function plannedWakes(
  row: AutomationListRow,
  from: Date,
  to: Date,
  limit = AUTOMATION_OCCURRENCES_CAP
): number[] {
  const when = automationWhen(row);
  if (when.kind === 'once') {
    const at = Date.parse(when.at);
    return at >= from.getTime() && at < to.getTime() ? [at] : [];
  }
  if (when.kind !== 'repeat') return [];
  try {
    return repeatRunsBetween(when, when.tz, from, to, limit).map((d) => d.getTime());
  } catch {
    return [];
  }
}

/**
 * Reminders: the planned runs of one automation inside [from, to), oldest
 * first, at most `limit`. A once runs at its time and a repeat expands with
 * the shared engine, as the calendar draws them; an Every automation runs on
 * its interval from `anchor` (its next run, else its interval anchor or
 * creation), the lattice the schedule runner keeps, or with a daily window
 * from the window's start each day, inside it only. Runs from before
 * the automation existed never happen.
 */
export function automationRunsBetween(
  row: AutomationListRow,
  anchor: number,
  from: Date,
  to: Date,
  limit: number
): number[] {
  const createdAt = Date.parse(row.createdAt) - 60_000;
  if (row.whenKind !== 'interval')
    return plannedWakes(row, from, to, limit).filter((at) => at >= createdAt);
  const every = row.everyMs;
  if (!every || every <= 0 || !Number.isFinite(anchor)) return [];
  const start = Math.max(from.getTime(), createdAt, anchor);
  const out: number[] = [];
  const window = intervalWindowOf(row);
  if (window) {
    let cursor = new Date(start - 1);
    while (out.length < limit) {
      const next = nextWindowedIntervalRun(every, window, row.tz, cursor);
      if (next.getTime() >= to.getTime()) break;
      out.push(next.getTime());
      cursor = next;
    }
    return out;
  }
  let at = anchor + Math.ceil((start - anchor) / every) * every;
  for (; at < to.getTime() && out.length < limit; at += every) out.push(at);
  return out;
}

function occurrence(
  row: AutomationListRow,
  at: number,
  run: LoggedRun | undefined,
  now: number
): CalendarAutomationOccurrence {
  const start = new Date(at).toISOString();
  let status: CalendarAutomationOccurrence['status'] = 'upcoming';
  let note: CalendarAutomationOccurrence['note'];
  if (run?.status === 'succeeded') status = 'done';
  else if (run?.status === 'skipped') status = 'skipped';
  else if (run?.status === 'failed') {
    status = 'skipped';
    note = 'failed';
  } else if (!run && at < now - DUE_SLACK_MS) status = 'skipped';
  return {
    key: `automation:${row.id}:${start}`,
    source: 'automation',
    calendarId: row.calendarId!,
    title: row.name,
    time: {
      kind: 'timed',
      start,
      end: new Date(at + AUTOMATION_OCCURRENCE_MINUTES * 60_000).toISOString(),
    },
    status,
    ...(note ? { note } : {}),
    canMove: false,
    canResize: false,
    automationId: row.id,
    agentId: row.agentId,
    agentName: row.agentName ?? 'Agent',
    threadId: row.threadId,
    // Canceled rows are never listed here.
    automationStatus: row.status as CalendarAutomationOccurrence['automationStatus'],
  };
}

/** Wakes of once, repeat and first-open automations on `calendarIds` inside the window, oldest first. */
export async function automationOccurrences(
  window: AutomationOccurrencesWindow
): Promise<CalendarAutomationOccurrence[]> {
  if (!window.calendarIds.length) return [];
  const rows = await Automations.list({
    statuses: ['active', 'finished'],
    calendarIds: window.calendarIds,
    whenKinds: ['once', 'repeat', 'first_open'],
  });
  if (!rows.length) return [];
  const from = new Date(window.fromInstant);
  const to = new Date(window.toInstant);
  const now = (window.now ?? new Date()).getTime();
  const runs = await runsInWindow(
    rows.map((row) => row.scheduleId).filter((id): id is string => Boolean(id)),
    from,
    to
  );
  const out: CalendarAutomationOccurrence[] = [];
  for (const row of rows) {
    if (!row.calendarId) continue;
    const logged = (row.scheduleId && runs.get(row.scheduleId)) || new Map<number, LoggedRun>();
    // Wakes before the automation existed never happened.
    const createdAt = Date.parse(row.createdAt) - 60_000;
    const times = new Set(plannedWakes(row, from, to).filter((at) => at >= createdAt));
    for (const at of logged.keys()) times.add(at); // incl. Run now wakes
    for (const at of times) out.push(occurrence(row, at, logged.get(at), now));
  }
  const startOf = (o: CalendarAutomationOccurrence) =>
    o.time.kind === 'timed' ? Date.parse(o.time.start) : 0;
  out.sort((a, b) => startOf(a) - startOf(b) || (a.key < b.key ? -1 : 1));
  return out.slice(0, AUTOMATION_OCCURRENCES_CAP);
}

/** A visible day and the instant it ends (the next midnight in the query's zone). */
export interface IntervalWindowDay {
  day: string;
  end: string;
}

export interface AutomationIntervalsWindow {
  calendarIds: readonly string[];
  /** The visible days, in order. */
  days: readonly IntervalWindowDay[];
}

/** Each schedule's interval anchor (when its timing was set), by schedule id. */
export async function intervalAnchors(scheduleIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!scheduleIds.length) return out;
  const { rows } = await getDb().query<{ id: string; anchor: string | null }>(
    `SELECT id, schedule_json->>'anchor' AS anchor FROM public.schedules WHERE id = ANY($1::text[])`,
    [scheduleIds]
  );
  for (const row of rows) {
    const at = row.anchor ? Date.parse(row.anchor) : Number.NaN;
    if (Number.isFinite(at)) out.set(row.id, at);
  }
  return out;
}

/**
 * Active Every automations on `calendarIds` (a paused one is not drawn): one
 * span per visible day from the day each started (its interval anchor; its
 * creation when the schedule has none). Ordered by day, then start, then id.
 */
export async function automationIntervals(
  window: AutomationIntervalsWindow
): Promise<CalendarIntervalSpan[]> {
  if (!window.calendarIds.length || !window.days.length) return [];
  const rows = (
    await Automations.list({
      statuses: ['active'],
      calendarIds: window.calendarIds,
      whenKinds: ['interval'],
    })
  ).filter((row) => row.calendarId && row.everyMs);
  if (!rows.length) return [];
  const anchors = await intervalAnchors(
    rows.map((row) => row.scheduleId).filter((id): id is string => Boolean(id))
  );
  const started = rows
    .map((row) => ({
      row,
      start: (row.scheduleId && anchors.get(row.scheduleId)) || Date.parse(row.createdAt),
    }))
    .sort((a, b) => a.start - b.start || (a.row.id < b.row.id ? -1 : 1))
    .slice(0, AUTOMATION_INTERVALS_CAP);
  const out: CalendarIntervalSpan[] = [];
  for (const { day, end } of window.days) {
    const dayEnd = Date.parse(end);
    for (const { row, start } of started) {
      if (start >= dayEnd) continue; // not started yet on this day
      out.push({
        key: `automation:${row.id}:span:${day}`,
        source: 'automation',
        kind: 'interval',
        automationId: row.id,
        calendarId: row.calendarId!,
        name: row.name,
        day,
        everyMs: row.everyMs!,
        ...(row.windowStart && row.windowEnd
          ? { window: { start: row.windowStart, end: row.windowEnd, tz: row.tz } }
          : {}),
        startsAt: new Date(start).toISOString(),
        nextRunAt: row.nextRunAt,
        agentId: row.agentId,
        agentName: row.agentName ?? 'Agent',
        threadId: row.threadId,
      });
    }
  }
  return out;
}
