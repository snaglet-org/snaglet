/**
 * The Calendar pane's view state, shared with the sidebar's mini month:
 * anchor day, chosen zoom, "This project's tables", whether Week / Day show
 * the overview strip, and what the pane has loaded (its range and
 * occurrences, so the mini month draws density dots with no extra request).
 *
 * One Calendar pane per window, so one store. It persists to localStorage
 * (`snaglet.calendar.view`). The pane's history entry also holds the zoom and day
 * (`CalendarView` reports them and follows them), so the back / forward arrows
 * step through the views visited: a change of zoom is a stop, a change of day
 * within a zoom updates the current one.
 */
import { useSyncExternalStore } from 'react';
import type { CalendarOccurrence, CalendarOccurrencesResponse } from '@snaglet/shared/types';
import type { StoredZoom } from './calendarDates';
import { safeJsonParse } from '@snaglet/shared/utils';

const CALENDAR_VIEW_KEY = 'snaglet.calendar.view';

export interface CalendarViewState {
  /** The focused day (YYYY-MM-DD); null = today. */
  anchor: string | null;
  zoom: StoredZoom;
  projectOnly: boolean;
  /**
   * The day the sidebar mini month opened; Week / 3-day mark it with a focus
   * ring. Not persisted; moving on (‹ ›, Today, zoom, opening a day) clears it.
   */
  focusDay: string | null;
  /** Loaded window, for the mini month band and dots. */
  loaded: { from: string; to: string; occurrences: CalendarOccurrence[] } | null;
  /** Bound fields the last read couldn't show (archived table / field). */
  unavailable: CalendarOccurrencesResponse['unavailable'];
  /** Week / Day show the overview strip at the right (the toolbar's Overview; off by default). */
  overview: boolean;
}

function readStored(): Partial<CalendarViewState> {
  try {
    const raw = window.localStorage.getItem(CALENDAR_VIEW_KEY);
    const parsed = raw ? safeJsonParse<Partial<CalendarViewState>>(raw, {}) : {};
    const out: Partial<CalendarViewState> = {};
    if (typeof parsed.anchor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.anchor)) {
      out.anchor = parsed.anchor;
    }
    if (
      parsed.zoom === 'month' ||
      parsed.zoom === 'week' ||
      parsed.zoom === 'day' ||
      parsed.zoom === 'year'
    ) {
      out.zoom = parsed.zoom;
    }
    if (typeof parsed.projectOnly === 'boolean') out.projectOnly = parsed.projectOnly;
    if (typeof parsed.overview === 'boolean') out.overview = parsed.overview;
    return out;
  } catch {
    return {};
  }
}

const DEFAULTS: CalendarViewState = {
  anchor: null,
  zoom: 'week',
  projectOnly: false,
  focusDay: null,
  loaded: null,
  unavailable: [],
  overview: false,
};

let state: CalendarViewState = { ...DEFAULTS };
let hydrated = false;
const listeners = new Set<() => void>();

function hydrate(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  state = { ...state, ...readStored() };
}

function persist(): void {
  try {
    const { anchor, zoom, projectOnly, overview } = state;
    window.localStorage.setItem(
      CALENDAR_VIEW_KEY,
      JSON.stringify({ anchor, zoom, projectOnly, overview })
    );
  } catch {
    // ignore storage failures
  }
}

export function updateCalendarView(patch: Partial<CalendarViewState>): void {
  hydrate();
  state = { ...state, ...patch };
  if ('anchor' in patch || 'zoom' in patch || 'projectOnly' in patch || 'overview' in patch) {
    persist();
  }
  for (const l of listeners) l();
}

/**
 * Sidebar mini month: open `day` in the pane. Month and Year open it in Day view (as
 * their date numbers do); Week / 3-day show the range holding it with the day
 * marked; Day goes to it.
 */
export function jumpCalendarTo(day: string): void {
  hydrate();
  updateCalendarView({
    anchor: day,
    zoom: state.zoom === 'month' || state.zoom === 'year' ? 'day' : state.zoom,
    focusDay: day,
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): CalendarViewState {
  hydrate();
  return state;
}

export function useCalendarView(): CalendarViewState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function __resetCalendarViewForTests(seed: Partial<CalendarViewState> = {}): void {
  state = { ...DEFAULTS, ...seed };
  hydrated = true;
  listeners.clear();
}
