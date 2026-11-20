/**
 * Calendars list store (module-level, shared by the sidebar and the pane):
 * every calendar, plus per-viewer hidden ids
 * (`snaglet.calendar.hidden`). Writes patch the list from the server's reply;
 * realtime `calendar:changed` reloads it.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Calendar, CalendarColor } from '@snaglet/shared/types';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { subscribeTheme } from '@desktop/utils/workspaceTheme';
import { calendarApi } from './calendarApi';

export const HIDDEN_CALENDARS_KEY = 'snaglet.calendar.hidden';
const HIDDEN_FIELDS_KEY = 'snaglet.calendar.hiddenFields';
export const COLLAPSED_CALENDARS_KEY = 'snaglet.calendar.collapsed';

interface CalendarsSnapshot {
  calendars: Calendar[] | null;
  error: string | null;
  loading: boolean;
  hidden: ReadonlySet<string>;
  /** Per-viewer hidden bound fields (field ids): kept on the calendar, not drawn. */
  hiddenFields: ReadonlySet<string>;
  /** Per-viewer calendars whose fields are folded away in the sidebar (open by default). */
  collapsed: ReadonlySet<string>;
}

function readHidden(key = HIDDEN_CALENDARS_KEY): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? safeJsonParse<unknown>(raw, []) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

let state: CalendarsSnapshot = {
  calendars: null,
  error: null,
  loading: false,
  hidden: new Set(),
  hiddenFields: new Set(),
  collapsed: new Set(),
};
let hiddenLoaded = false;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<CalendarsSnapshot>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

let unsubscribeTheme: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // A custom color's ink is picked against the live theme (calendarColors.ts),
  // so a theme edit re-renders whatever draws calendars.
  unsubscribeTheme ??= subscribeTheme(() => setState({}));
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeTheme?.();
      unsubscribeTheme = null;
    }
  };
}

function sortCalendars(list: Calendar[]): Calendar[] {
  return [...list].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function loadCalendars(): Promise<void> {
  if (pending) return pending;
  setState({ loading: true });
  pending = Promise.resolve()
    .then(() => calendarApi.listCalendars())
    .then(({ calendars }) => {
      const ids = new Set(calendars.map((c) => c.id));
      for (const id of state.hidden) if (!ids.has(id)) setCalendarHidden(id, false);
      for (const id of state.collapsed) if (!ids.has(id)) setCalendarCollapsed(id, false);
      setState({ calendars: sortCalendars(calendars), error: null });
    })
    .catch((err: unknown) => setState({ error: getErrorMessage(err, "Couldn't load calendars") }))
    .finally(() => {
      pending = null;
      setState({ loading: false });
    });
  return pending;
}

/** Replace (or add) one calendar from a write's reply. */
export function upsertCalendar(calendar: Calendar): void {
  const list = state.calendars ?? [];
  const next = list.some((c) => c.id === calendar.id)
    ? list.map((c) => (c.id === calendar.id ? calendar : c))
    : [...list, calendar];
  setState({ calendars: sortCalendars(next) });
}

export function setCalendarsOrder(ids: string[]): void {
  const list = state.calendars ?? [];
  const order = new Map(ids.map((id, i) => [id, i]));
  setState({
    calendars: sortCalendars(
      list.map((c) => (order.has(c.id) ? { ...c, sortOrder: order.get(c.id)! } : c))
    ),
  });
}

export function setCalendarHidden(id: string, hidden: boolean): void {
  const next = new Set(state.hidden);
  if (hidden) next.add(id);
  else next.delete(id);
  try {
    window.localStorage.setItem(HIDDEN_CALENDARS_KEY, JSON.stringify([...next]));
  } catch {
    // Private mode / quota: the toggle still works for this session.
  }
  setState({ hidden: next });
}

export function setFieldHidden(fieldId: string, hidden: boolean): void {
  const next = new Set(state.hiddenFields);
  if (hidden) next.add(fieldId);
  else next.delete(fieldId);
  try {
    window.localStorage.setItem(HIDDEN_FIELDS_KEY, JSON.stringify([...next]));
  } catch {
    // Private mode / quota: the toggle still works for this session.
  }
  setState({ hiddenFields: next });
}

export function setCalendarCollapsed(id: string, collapsed: boolean): void {
  const next = new Set(state.collapsed);
  if (collapsed) next.add(id);
  else next.delete(id);
  try {
    window.localStorage.setItem(COLLAPSED_CALENDARS_KEY, JSON.stringify([...next]));
  } catch {
    // Private mode / quota: the fold still works for this session.
  }
  setState({ collapsed: next });
}

export function showAllCalendars(): void {
  try {
    window.localStorage.removeItem(HIDDEN_CALENDARS_KEY);
  } catch {
    // ignore
  }
  setState({ hidden: new Set() });
}

/**
 * The workspace theme colors an automatic calendar color cycles through, in
 * order. Theme tokens, so the dots follow theme edits.
 */
const AUTOMATIC_THEME_TOKENS = [
  'detail',
  'color-container-default',
  'agent',
  'color-node-tool',
  'detail-2',
  'color-node-image',
  'color-node-memory',
  'color-node-thread',
  'color-container-project',
] as const;

/**
 * The color a calendar draws in: its own (palette id, theme token or custom
 * hex), else a workspace theme color by sort order. Paint it with
 * calendarColorProps.
 */
export function calendarColor(calendar: Pick<Calendar, 'color' | 'sortOrder'>): CalendarColor {
  return (
    calendar.color ??
    `theme:${AUTOMATIC_THEME_TOKENS[calendar.sortOrder % AUTOMATIC_THEME_TOKENS.length]!}`
  );
}

export interface CalendarsState extends CalendarsSnapshot {
  active: Calendar[];
  visible: Calendar[];
  reload: () => Promise<void>;
}

export function useCalendars(): CalendarsState {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!hiddenLoaded && typeof window !== 'undefined') {
      hiddenLoaded = true;
      setState({
        hidden: readHidden(),
        hiddenFields: readHidden(HIDDEN_FIELDS_KEY),
        collapsed: readHidden(COLLAPSED_CALENDARS_KEY),
      });
    }
    if (!state.calendars && !pending) void loadCalendars();
  }, []);
  return useMemo(() => {
    const all = snapshot.calendars ?? [];
    const active = all;
    return {
      ...snapshot,
      active,
      visible: active.filter((c) => !snapshot.hidden.has(c.id)),
      reload: loadCalendars,
    };
  }, [snapshot]);
}

export function getCalendarsSnapshot(): CalendarsSnapshot {
  return state;
}

export function __resetCalendarStoreForTests(seed?: Partial<CalendarsSnapshot>): void {
  state = {
    calendars: null,
    error: null,
    loading: false,
    hidden: new Set(),
    hiddenFields: new Set(),
    collapsed: new Set(),
    ...seed,
  };
  hiddenLoaded = seed?.hidden !== undefined;
  pending = null;
  listeners.clear();
  unsubscribeTheme?.();
  unsubscribeTheme = null;
}
