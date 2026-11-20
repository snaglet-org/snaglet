/**
 * The calendar's week start (0 = Sunday): one source for everything that lays
 * out weeks, so they always agree — the Calendar pane, its sidebar mini
 * month and every date picker (calendar popovers, table cells and field
 * settings, the row window). Repeats are separate: they always start their
 * weeks on Monday.
 *
 * The viewer's locale decides it (`localeWeekStart`), read once. An
 * override replaces it everywhere at once; only tests set one so far.
 */
import { useSyncExternalStore } from 'react';
import { localeWeekStart } from './calendarDates';

let override: number | null = null;
let fromLocale: number | null = null;
const listeners = new Set<() => void>();

function calendarWeekStart(): number {
  if (override !== null) return override;
  if (fromLocale === null) fromLocale = localeWeekStart();
  return fromLocale;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The week start, re-rendering when an override changes it. */
export function useCalendarWeekStart(): number {
  return useSyncExternalStore(subscribe, calendarWeekStart, calendarWeekStart);
}

/** @public Pin the week start (0 = Sunday … 6), or null for the locale's again. */
export function __setCalendarWeekStartForTests(day: number | null): void {
  override = day === null ? null : ((day % 7) + 7) % 7;
  fromLocale = null;
  for (const listener of listeners) listener();
}
