/**
 * Calendar pane: toolbar, state lines, and the Month / Week / 3-day / Day
 * grids. View state (anchor, zoom, project filter) lives in `calendarViewStore`;
 * a change of zoom is also a history stop. Moves come from `useCalendarMoves`,
 * zoom from `useTimeScale`, and every edit records one step on the calendar
 * undo stack (`calendarUndo`). The ranges either side of the visible one are
 * prefetched, so switching views usually draws at once.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type {
  AutomationRecord,
  CalendarAutomationOccurrence,
  CalendarEvent,
  CalendarIntervalSpan,
  CalendarOccurrence,
  CalendarRowOccurrence,
  TableField,
} from '@snaglet/shared/types';
import { Button, Segmented, TextInput, Tooltip } from '@desktop/components';
import { ChevronLeftIcon, ChevronRightIcon, OverviewIcon } from '@desktop/components/Icons';
import { cn } from '@desktop/utils/classNames';
import { tablesApi } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';
import { getErrorMessage } from '@snaglet/shared/utils';
import { markOwnWrite } from '@desktop/features/calendar/calendarRealtime';
import { tableRepeatsApi } from '@desktop/utils/api/tableRepeats';
import { useYearOccurrences } from '@desktop/features/calendar/useYearOccurrences';
import { ContextMenu } from '@desktop/components/ContextMenu';
import { usePaneIsActive } from '@desktop/features/pane-find/PaneFindContext';
import {
  offerUndo,
  onCalendarUndoChange,
  useCalendarUndoShortcuts,
} from '@desktop/features/calendar/calendarUndo';
import { AutomationOccurrencePopover } from '@desktop/features/calendar/AutomationOccurrencePopover';
import { AutomationEditForm } from '@desktop/features/automations/AutomationEditForm';
import type { OfferUndo } from '@desktop/features/automations/automationActions';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import {
  moveToDay,
  shiftTime,
  stretchAllDayEnd,
  stretchEnd,
} from '@desktop/features/calendar/occurrenceMoves';
import {
  completeOrSkip,
  isSettled,
  markRowStatus,
} from '@desktop/features/calendar/occurrenceWrites';
import { RepeatMoveChoice } from '@desktop/features/calendar/RepeatMoveChoice';
import { MoveToPopover } from '@desktop/features/calendar/MoveToPopover';
import { useCalendarMoves } from './useCalendarMoves';
import {
  addDays,
  clampZoom,
  instantToZoned,
  navigate,
  NARROW_DAY_PX,
  NARROW_PANE_PX,
  rangeFor,
  rangeLabel,
  THREE_DAY_PX,
  todayIn,
  viewerTimeZone,
  zoneAbbreviation,
  type CalendarZoom,
  type StoredZoom,
} from '@desktop/features/calendar/calendarDates';
import {
  calendarColor,
  showAllCalendars,
  useCalendars,
} from '@desktop/features/calendar/calendarStore';
import { updateCalendarView, useCalendarView } from '@desktop/features/calendar/calendarViewStore';
import { useCalendarWeekStart } from '@desktop/features/calendar/weekStart';
import { useCalendarOccurrences } from '@desktop/features/calendar/useCalendarOccurrences';
import { occurrencesSearch } from '@desktop/features/calendar/calendarApi';
import {
  defaultCalendarId,
  QuickAddPopover,
  slotTime,
  type QuickAddInput,
  type QuickAddSlot,
} from '@desktop/features/calendar/QuickAddPopover';
import {
  convertEventToRow,
  createdRowUndo,
  createRowAt,
  recordRowEdit,
  rowOccurrenceDraw,
  type RowTarget,
} from '@desktop/features/calendar/rowCreate';
import { EventPopover } from '@desktop/features/calendar/EventPopover';
import {
  createEvent,
  deleteEvent,
  eventSpan,
  reportWriteError,
  toEventTime,
} from '@desktop/features/calendar/eventActions';
import { TableEntryModal } from '../TableView/TableEntryModal';
import type { CalendarPaneView } from '@desktop/pages/Dashboard/selection/types';
import { YearGrid } from './YearGrid';
import { MonthGrid } from './MonthGrid';
import { TimeGrid } from './TimeGrid';
import { TimeOverview } from './TimeOverview';
import { TimeScaleContext } from './timeScaleContext';
import { useTimeScale } from './useTimeScale';
import { RepeatEditPopover } from './RepeatEditPopover';
import { RowPopover, type RowPopoverAction } from './RowPopover';
import { displayTitle } from './occurrenceText';
import styles from './CalendarView.module.scss';

export interface CalendarViewProps {
  /** The project the pane sits in, if any: enables "This project's tables". */
  projectId?: string | null;
  /**
   * The view the pane's history entry holds (zoom and day). Stepping back or
   * forward changes it; the view then follows it.
   */
  paneView?: CalendarPaneView;
  /** The view changed (zoom or day): the pane records it in its history. */
  onPaneViewChange?: (view: CalendarPaneView) => void;
}

/** + / − zoom the Week / Day times by this much. */
const KEY_ZOOM = 1.25;

const ZOOM_SHORT: Record<CalendarZoom, string> = {
  month: 'M',
  week: 'W',
  '3day': '3D',
  day: 'D',
  year: 'Y',
};
const ZOOM_LONG: Record<CalendarZoom, string> = {
  month: 'Month',
  week: 'Week',
  '3day': '3 days',
  day: 'Day',
  year: 'Year',
};

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.closest('[role="dialog"]') !== null
  );
}

/** Width of the element in layout px (unzoomed by the pane's CSS zoom). */
function usePaneWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(1024);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The pane body is the `pane` container; its inline size is what the
    // `@container pane` rules see, so measure the same box.
    const box = (el.closest('[class*="body"]') as HTMLElement | null) ?? el;
    const measure = () => setWidth(box.clientWidth || el.clientWidth || 1024);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

type Popover =
  | { kind: 'quick'; slot: QuickAddSlot }
  | { kind: 'menu'; occurrence: CalendarOccurrence; anchor: HTMLElement; x: number; y: number }
  | { kind: 'moveTo'; occurrence: CalendarOccurrence; anchor: HTMLElement }
  | {
      kind: 'event';
      eventId: string;
      anchor: HTMLElement;
      focusTitle?: boolean;
      /** The clicked occurrence's time (a repeating event shows that one). */
      occurrence?: CalendarOccurrence['time'];
    }
  | { kind: 'repeat'; occurrence: CalendarRowOccurrence; anchor: HTMLElement }
  | {
      kind: 'automation';
      occurrence: CalendarAutomationOccurrence | CalendarIntervalSpan;
      anchor: HTMLElement;
      /** An Every line's popover anchors where it was pressed; focus returns to the line. */
      returnFocusTo?: HTMLElement;
      /** The run an Every automation's dot stands for. */
      runAt?: string;
    }
  | {
      kind: 'row';
      /** The occurrence's key; the live one is read from the window by it. */
      key: string;
      /** As opened (or as made): shown until the window has it. */
      occurrence: CalendarRowOccurrence;
      anchor: HTMLElement;
      /** The table's fields, when the pane already has them (a row just made). */
      fields?: TableField[];
    }
  | null;

/** A non-repeating row's key, as the server gives it. */
const rowKey = (fieldId: string, entryId: string) => `row:${fieldId}:${entryId}:value`;

export function CalendarView({ projectId = null, paneView, onPaneViewChange }: CalendarViewProps) {
  const zone = useMemo(viewerTimeZone, []);
  // Shared with the sidebar's mini month and every date picker.
  const weekStart = useCalendarWeekStart();
  const view = useCalendarView();
  const calendars = useCalendars();
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const paneWidth = usePaneWidth(rootRef);
  const narrow = paneWidth < NARROW_PANE_PX;

  const [today, setToday] = useState(() => todayIn(zone));
  useEffect(() => {
    const id = window.setInterval(() => setToday(todayIn(zone)), 60_000);
    return () => window.clearInterval(id);
  }, [zone]);

  const anchor = view.anchor ?? today;

  // The pane's history (back / forward arrows)
  // The view (zoom and day) is recorded in the pane's selection: a change of
  // view pushes an entry, a change of day within a view updates the current
  // one, and stepping through history brings the view back. `fromPane` is the
  // pane view just applied, so the store catching up to it isn't reported back.
  const fromPane = useRef<string | null>(null);
  const viewKey = (zoom: string, day: string) => `${zoom}|${day}`;
  const paneKey = paneView ? viewKey(paneView.zoom, paneView.anchor) : null;
  useEffect(() => {
    if (!paneView || paneKey === viewKey(view.zoom, anchor)) return;
    fromPane.current = paneKey;
    updateCalendarView({ zoom: paneView.zoom, anchor: paneView.anchor, focusDay: null });
    // Only a change of the pane's own view applies; the view's changes are reported below.
  }, [paneKey]);
  useEffect(() => {
    const storeKey = viewKey(view.zoom, anchor);
    if (paneKey === storeKey) {
      fromPane.current = null;
      return;
    }
    // The pane's view was applied and the store hasn't caught up yet.
    if (fromPane.current !== null && fromPane.current === paneKey) return;
    onPaneViewChange?.({ zoom: view.zoom, anchor });
    // Only a change of the view is reported; the pane's own are applied above.
  }, [view.zoom, anchor]);
  const zoom: CalendarZoom = clampZoom(view.zoom, paneWidth);
  const range = useMemo(() => rangeFor(zoom, anchor, weekStart), [zoom, anchor, weekStart]);
  const label = rangeLabel(zoom, anchor, weekStart);
  const timed = zoom !== 'month' && zoom !== 'year';
  const timeScale = useTimeScale(scrollRef, timed);
  const timeScaleRef = useRef(timeScale);
  timeScaleRef.current = timeScale;
  const snapStep = useCallback(() => timeScaleRef.current.snapStep, []);
  const scrollId = useId();
  const overviewId = useId();

  const visibleIds = useMemo(() => calendars.visible.map((c) => c.id), [calendars.visible]);
  const allHidden = calendars.active.length > 0 && calendars.visible.length === 0;
  const projectOnly = Boolean(projectId) && view.projectOnly;

  const query = useMemo(
    () =>
      calendars.calendars === null || allHidden || zoom === 'year'
        ? null
        : {
            from: range.from,
            to: range.to,
            tz: zone,
            ...(visibleIds.length < calendars.active.length ? { calendarIds: visibleIds } : {}),
            ...(projectOnly && projectId ? { projectId } : {}),
          },
    [
      range.from,
      range.to,
      zone,
      visibleIds,
      calendars.active.length,
      calendars.calendars,
      allHidden,
      zoom,
      projectOnly,
      projectId,
    ]
  );
  const adjacent = useMemo(() => {
    if (!query) return [];
    const ranges = ([-1, 1] as const).map((dir) =>
      rangeFor(zoom, navigate(zoom, anchor, dir), weekStart)
    );
    // What a view switch would show next: Week / Day → the month; Month / Day → the week.
    if (zoom !== 'month') ranges.push(rangeFor('month', anchor, weekStart));
    if (zoom === 'month' || zoom === 'day')
      ranges.push(rangeFor(clampZoom('week', paneWidth), anchor, weekStart));
    return ranges.map((r) => ({ ...query, from: r.from, to: r.to }));
  }, [query, zoom, anchor, weekStart, paneWidth]);

  const data = useCalendarOccurrences(query, { calendars: calendars.active, adjacent });
  // The Year view reads six two-month windows (a request is at most 62 days).
  const yearQuery = useMemo(
    () =>
      zoom !== 'year' || calendars.calendars === null || allHidden
        ? null
        : {
            year: Number(anchor.slice(0, 4)),
            tz: zone,
            ...(visibleIds.length < calendars.active.length ? { calendarIds: visibleIds } : {}),
            ...(projectOnly && projectId ? { projectId } : {}),
          },
    [
      zoom,
      anchor,
      zone,
      visibleIds,
      calendars.active.length,
      calendars.calendars,
      allHidden,
      projectOnly,
      projectId,
    ]
  );
  const yearData = useYearOccurrences(yearQuery, { calendars: calendars.active });
  const sourceOccurrences = zoom === 'year' ? yearData.occurrences : data.occurrences;
  const loading = zoom === 'year' ? yearData.loading : data.loading;
  const loadError = zoom === 'year' ? yearData.error : data.error;
  const reloadView = zoom === 'year' ? yearData.refetch : data.refetch;
  // The items on screen belong to another range than the one asked for (a
  // view switch, or a step, before its reply): drawn dimmed until it comes.
  const stale =
    zoom === 'year'
      ? yearQuery !== null && yearData.shownYear !== null && yearData.shownYear !== yearQuery.year
      : query !== null && data.shownKey !== null && data.shownKey !== occurrencesSearch(query);

  // Calendar undo stack
  useCalendarUndoShortcuts(usePaneIsActive());
  // The Year view reads its own data, so an undo refreshes whichever view is up.
  const refetchRef = useRef(reloadView);
  refetchRef.current = reloadView;
  useEffect(() => onCalendarUndoChange(() => refetchRef.current()), []);

  // Share the loaded window with the sidebar's mini month (dots, band).
  useEffect(() => {
    updateCalendarView({
      loaded: { from: range.from, to: range.to, occurrences: sourceOccurrences },
      unavailable: data.unavailable,
    });
  }, [range.from, range.to, sourceOccurrences, data.unavailable]);

  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const visibleSet = new Set(visibleIds);
    const q = search.trim().toLowerCase();
    return sourceOccurrences.filter(
      (o) =>
        visibleSet.has(o.calendarId) &&
        !(o.source === 'row' && calendars.hiddenFields.has(o.fieldId)) &&
        (!q || displayTitle(o).toLowerCase().includes(q))
    );
  }, [sourceOccurrences, visibleIds, calendars.hiddenFields, search]);
  const gridItems = shown;
  const shownIntervals = useMemo(() => {
    const visibleSet = new Set(visibleIds);
    const q = search.trim().toLowerCase();
    return data.intervals.filter(
      (span) => visibleSet.has(span.calendarId) && (!q || span.name.toLowerCase().includes(q))
    );
  }, [data.intervals, visibleIds, search]);

  const calendarsById = useMemo(
    () => new Map((calendars.calendars ?? []).map((c) => [c.id, c])),
    [calendars.calendars]
  );
  const colorOf = useCallback(
    (id: string) => {
      const c = calendarsById.get(id);
      return c ? calendarColor(c) : 'gray';
    },
    [calendarsById]
  );

  // Navigation
  const [announcement, setAnnouncement] = useState('');
  // Moving on drops the mini month's day mark.
  const go = (dir: 1 | -1) =>
    updateCalendarView({ anchor: navigate(zoom, anchor, dir), focusDay: null });
  const goToday = () => updateCalendarView({ anchor: today, focusDay: null });
  const setZoom = (next: CalendarZoom) => {
    const stored: StoredZoom = next === '3day' ? 'week' : next;
    updateCalendarView({ zoom: stored, focusDay: null });
  };
  const openDay = (day: string) => updateCalendarView({ anchor: day, zoom: 'day', focusDay: null });
  useEffect(() => {
    setAnnouncement(zoom === 'week' ? `Week of ${label.split(' –')[0]}` : label);
  }, [label, zoom]);

  // A view or range change re-keys the grid; if the focused cell went with
  // it, focus lands on <body> and the next bare-letter shortcut is lost.
  // Pull it back to the pane root.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    root.focus({ preventScroll: true });
  }, [zoom, range.from]);

  // Popovers
  const [popover, setPopover] = useState<Popover>(null);
  const [ghostEl, setGhostEl] = useState<HTMLElement | null>(null);
  const ghostRef = useCallback((el: HTMLElement | null) => setGhostEl(el), []);
  const [entry, setEntry] = useState<{
    tableId: string;
    entryId: string;
    fields: TableField[];
  } | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // The automation, Repeat… and Move to… popovers show only while their item
  // is in the grid; a refetch that redraws the grid without it closes them for
  // good (else their state would hold the pane's shortcuts).
  const itemAnchor =
    popover?.kind === 'automation' || popover?.kind === 'repeat' || popover?.kind === 'moveTo'
      ? popover.anchor
      : null;
  useLayoutEffect(() => {
    if (itemAnchor && !itemAnchor.isConnected) setPopover(null);
  });
  // A popover that closes over a lost focus (its item deleted or redrawn
  // away) hands focus to the pane, so its keys keep working.
  const hadPopover = useRef(false);
  useEffect(() => {
    const had = hadPopover.current;
    hadPopover.current = popover !== null;
    if (popover || !had) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    rootRef.current?.focus({ preventScroll: true });
  }, [popover]);

  const draft = popover?.kind === 'quick' ? popover.slot : null;
  // Quick add offers the visible calendars (all active when every one is hidden).
  const quickCalendars = calendars.visible.length ? calendars.visible : calendars.active;
  // The ghost wears the color of the calendar the event lands in: quick
  // add's pick once it's open, else its default (last used, else Default).
  const [quickCalendarId, setQuickCalendarId] = useState<string | null>(null);
  const draftCalendarId = (draft ? quickCalendarId : null) ?? defaultCalendarId(quickCalendars);
  const draftColor = draftCalendarId ? colorOf(draftCalendarId) : undefined;

  // Automation wakes: the popover's Pause / Resume undo on this stack.
  const [editingAutomation, setEditingAutomation] = useState<AutomationRecord | null>(null);
  const nav = useDashboardNavigation();
  const automationUndo: OfferUndo = (message, undo) =>
    offerUndo(message, {
      label: message,
      undo: async () => {
        await undo();
        data.refetch();
      },
    });
  // The pane header reads the node's title, as for a tree click. A node passed
  // here is never re-read from the tree, so without it the header is the id.
  const openThread = (threadId: string, title: string | null) =>
    nav?.openInPane({
      kind: 'thread',
      id: threadId,
      projectId: null,
      title,
      sortOrder: 0,
      lastMessageAt: null,
      createdAt: '',
      updatedAt: null,
    });

  const onDraft = useCallback((slot: QuickAddSlot, from: HTMLElement) => {
    openerRef.current = from;
    setQuickCalendarId(null);
    setPopover({ kind: 'quick', slot });
  }, []);

  /** The row in the entry modal (Open full row, a period's Open row). */
  const openRow = useCallback((o: CalendarRowOccurrence, fields?: TableField[]) => {
    if (fields) {
      setEntry({ tableId: o.tableId, entryId: o.entryId, fields });
      return;
    }
    tablesApi
      .fields(o.tableId)
      .then(({ fields: loaded }) =>
        setEntry({ tableId: o.tableId, entryId: o.entryId, fields: loaded })
      )
      .catch((err: unknown) => showToast(getErrorMessage(err, "Couldn't open the row")));
  }, []);

  /** The grid's own item for `key` (not a copy in a floating list). */
  const gridItem = (key: string): HTMLElement | null =>
    Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-calendar-item]') ?? []).find(
      (el) => el.dataset.key === key
    ) ?? null;

  /** The row's item: `key`, else any occurrence of the same row and field. */
  const rowItem = (o: Pick<CalendarRowOccurrence, 'key' | 'fieldId' | 'entryId'>) => {
    const prefix = `row:${o.fieldId}:${o.entryId}:`;
    return (
      gridItem(o.key) ??
      Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-calendar-item]') ?? []).find(
        (el) => el.dataset.key?.startsWith(prefix)
      ) ??
      null
    );
  };

  /** The row popover's occurrence as the window has it now. */
  const liveRow = (key: string, fallback: CalendarRowOccurrence): CalendarRowOccurrence => {
    const prefix = `row:${fallback.fieldId}:${fallback.entryId}:`;
    const rows = data.occurrences.filter((o): o is CalendarRowOccurrence => o.source === 'row');
    return (
      rows.find((o) => o.key === key) ?? rows.find((o) => o.key.startsWith(prefix)) ?? fallback
    );
  };

  const openItem = useCallback((o: CalendarOccurrence, el: HTMLElement, focusTitle?: boolean) => {
    // From "+N more" (which closes as this opens): anchor to the item itself,
    // or to its day when the item only shows in that list.
    const anchor = el.closest('[data-calendar-surface]')
      ? (gridItem(o.key) ??
        rootRef.current?.querySelector<HTMLElement>(`[data-cal-day="${dayOf(o)}"]`) ??
        el)
      : el;
    openerRef.current = anchor;
    if (o.source === 'event') {
      setPopover({ kind: 'event', eventId: o.eventId, anchor, focusTitle, occurrence: o.time });
      return;
    }
    if (o.source === 'automation') {
      setPopover({ kind: 'automation', occurrence: o, anchor });
      return;
    }
    setPopover({ kind: 'row', key: o.key, occurrence: o, anchor });
  }, []);

  /** An Every automation's line or dot: the automation popover, as for a wake. */
  const openInterval = useCallback(
    (span: CalendarIntervalSpan, anchor: HTMLElement, opener: HTMLElement, runAt?: string) => {
      openerRef.current = opener;
      setPopover({ kind: 'automation', occurrence: span, anchor, returnFocusTo: opener, runAt });
    },
    []
  );

  const focusItem = (key: string) => {
    requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      el?.focus();
    });
  };

  /** The calendar a quick add draws in until saved: its pick, else the Default. */
  const quickCalendarOf = (input: QuickAddInput): string =>
    input.calendarId ??
    calendars.visible.find((c) => c.isDefault)?.id ??
    calendars.visible[0]?.id ??
    '';

  /** Quick add with a Table field: a row of that table, then its popover. */
  const saveQuickRow = async (input: QuickAddInput, target: RowTarget) => {
    const { title, slot } = input;
    const calendarId = quickCalendarOf(input);
    setPopover(null);
    const time = slotTime(slot, zone);
    const tempKey = `row:${target.fieldId}:pending-${Date.now()}:value`;
    const draftRow: CalendarRowOccurrence = {
      source: 'row',
      key: tempKey,
      calendarId,
      title,
      time,
      status: 'upcoming',
      canMove: false,
      canResize: false,
      tableId: target.tableId,
      tableName: target.tableName,
      projectId: null,
      entryId: '',
      fieldId: target.fieldId,
      range: false,
      hasEnd: false,
      entryRevision: '',
      schemaVersion: '',
    };
    data.patchLocal((list) => [...list, draftRow]);
    try {
      const row = await createRowAt(target, title, time, zone);
      const key = rowKey(target.fieldId, row.entry.id);
      const made: CalendarRowOccurrence = {
        ...draftRow,
        ...rowOccurrenceDraw(row.dateField, time, zone),
        key,
        entryId: row.entry.id,
        canMove: true,
        canResize: row.dateField.range,
        range: row.dateField.range,
        entryRevision: row.entry.revision,
        schemaVersion: row.schemaVersion,
      };
      // The pending item is still drawn: anchor there; the popover finds the
      // row's own item once it replaces it.
      const anchor = gridItem(tempKey) ?? openerRef.current;
      data.patchLocal((list) => list.map((o) => (o.key === tempKey ? made : o)));
      if (anchor) setPopover({ kind: 'row', key, occurrence: made, anchor, fields: row.fields });
      const message = `Added ${title} to ${target.tableName}`;
      const step = createdRowUndo(row);
      if (step) offerUndo(message, step);
      else showToast(`${message}. To undo it, use the table's history.`);
      setAnnouncement(message);
      data.refetch();
    } catch (err) {
      data.patchLocal((list) => list.filter((o) => o.key !== tempKey));
      reportWriteError(err, `Couldn't add a row to ${target.tableName}`);
    }
  };

  /** The event popover's Table field: the event becomes a row, then its popover. */
  const convertEvent = async (
    event: CalendarEvent,
    target: RowTarget,
    anchor: HTMLElement
  ): Promise<boolean> => {
    try {
      const result = await convertEventToRow(event, target, zone);
      const key = rowKey(target.fieldId, result.entry.id);
      const made: CalendarRowOccurrence = {
        source: 'row',
        key,
        calendarId: event.calendarId,
        title: event.title,
        ...rowOccurrenceDraw(result.dateField, eventSpan(event.time), zone),
        status: 'upcoming',
        canMove: true,
        canResize: result.dateField.range,
        tableId: target.tableId,
        tableName: target.tableName,
        projectId: null,
        entryId: result.entry.id,
        fieldId: target.fieldId,
        range: result.dateField.range,
        entryRevision: result.entry.revision,
        schemaVersion: result.schemaVersion,
      };
      // The event's item still anchors this render; the row's takes over.
      const from = gridItem(`event:${event.id}`) ?? anchor;
      data.patchLocal((list) => [
        ...list.filter((o) => !(o.source === 'event' && o.eventId === event.id)),
        made,
      ]);
      setPopover({ kind: 'row', key, occurrence: made, anchor: from, fields: result.fields });
      if (result.undo) offerUndo(result.message, result.undo);
      else showToast(`${result.message}. To undo it, use the table's history.`);
      setAnnouncement(result.message);
      data.refetch();
      return true;
    } catch (err) {
      reportWriteError(err, `Couldn't move the event to ${target.tableName}`);
      data.refetch();
      return false;
    }
  };

  const saveQuick = async (input: QuickAddInput) => {
    if (input.target) return saveQuickRow(input, input.target);
    const { title, calendarId, slot, repeat, description } = input;
    setPopover(null);
    const time = slotTime(slot, zone);
    const tempKey = `event:pending-${Date.now()}`;
    // Optimistic: draw it now.
    data.patchLocal((list) => [
      ...list,
      {
        source: 'event',
        key: tempKey,
        eventId: tempKey,
        revision: 0,
        calendarId: quickCalendarOf(input),
        title,
        time,
        status: 'upcoming',
        canMove: false,
        canResize: false,
      },
    ]);
    try {
      const event = await createEvent({
        title,
        time: toEventTime(time, zone),
        ...(calendarId ? { calendarId } : {}),
        ...(repeat ? { repeat } : {}),
        ...(description ? { description } : {}),
      });
      const key = `event:${event.id}`;
      // A series draws many occurrences: the server's expansion replaces the temp one.
      if (repeat) data.refetch();
      data.patchLocal((list) =>
        list.map((o) =>
          o.key === tempKey && o.source === 'event'
            ? {
                ...o,
                key,
                eventId: event.id,
                revision: event.revision,
                timeZone: event.time.timeZone,
                calendarId: event.calendarId,
                canMove: !repeat,
                canResize: !repeat && event.time.kind === 'timed',
              }
            : o
        )
      );
      setAnnouncement(`Added ${title}`);
      // The new event stays selected (focus ring) so Backspace can delete it.
      focusItem(key);
    } catch (err) {
      data.patchLocal((list) => list.filter((o) => o.key !== tempKey));
      reportWriteError(err, "Couldn't add the event");
    }
  };

  const removeFocused = async (o: CalendarOccurrence, el: HTMLElement) => {
    if (o.source !== 'event') return; // rows are never deleted from the calendar
    const cell = el.closest('[role="gridcell"]') as HTMLElement | null;
    data.patchLocal((list) => list.filter((x) => x.key !== o.key));
    try {
      await deleteEvent({ id: o.eventId, title: o.title, revision: o.revision });
      setAnnouncement(`Deleted ${displayTitle(o)}`);
      (cell ?? scrollRef.current)?.focus();
    } catch (err) {
      reportWriteError(err, "Couldn't delete the event");
      data.refetch();
    }
  };

  const onItemKeyDown = (e: KeyboardEvent<HTMLButtonElement>, o: CalendarOccurrence) => {
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      openItemMenu(o, e.currentTarget, rect.left + 8, rect.bottom);
      return;
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.startsWith('Arrow')) {
      e.preventDefault();
      e.stopPropagation();
      keyboardMove(o, e.key, e.shiftKey, e.currentTarget);
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      void removeFocused(o, e.currentTarget);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      openItem(o, e.currentTarget);
    }
  };

  // Moves: drag, Alt+arrows, Move to… — one commit path
  const moves = useCalendarMoves({
    rootRef,
    scrollRef,
    zone,
    patchLocal: data.patchLocal,
    refetch: data.refetch,
    announce: setAnnouncement,
    onCommitted: (o) => {
      if (document.activeElement === document.body || !document.activeElement?.isConnected) {
        focusItem(o.key);
      }
    },
    snapStep,
  });

  /**
   * Alt+↑/↓ ±15 min, Alt+←/→ ±1 day; resize: Alt+Shift+↑/↓ = a timed item's
   * end ±15 min, Alt+Shift+←/→ = an all-day range's end ±1 day.
   */
  const keyboardMove = (o: CalendarOccurrence, key: string, shift: boolean, el: HTMLElement) => {
    if (!o.canMove) {
      showToast(`${displayTitle(o)} is read-only here`);
      return;
    }
    const vertical = key === 'ArrowUp' || key === 'ArrowDown';
    const sign = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
    if (shift) {
      if (!o.canResize) return;
      if (o.time.kind === 'timed' && vertical)
        moves.commit(o, stretchEnd(o.time, sign * 15), el, 'Resized');
      else if (o.time.kind === 'all_day' && !vertical)
        moves.commit(o, stretchAllDayEnd(o.time, sign), el, 'Resized');
      return;
    }
    // Month and all-day items move by whole days (↑/↓ = ±1 week in Month).
    const byDays = !vertical || o.time.kind === 'all_day' || zoom === 'month';
    const step = vertical ? (zoom === 'month' ? 7 : 1) : 1;
    const after = byDays
      ? shiftTime(o.time, { days: sign * step }, zone)
      : shiftTime(o.time, { minutes: sign * 15 }, zone);
    moves.commit(o, after, el);
  };

  // Item context menu (right-click, Shift+F10)
  const openItemMenu = (o: CalendarOccurrence, anchor: HTMLElement, x: number, y: number) => {
    openerRef.current = anchor;
    setPopover({ kind: 'menu', occurrence: o, anchor, x, y });
  };
  const onItemContextMenu = useCallback(
    (e: { currentTarget: HTMLElement; clientX: number; clientY: number }, o: CalendarOccurrence) =>
      openItemMenu(o, e.currentTarget, e.clientX, e.clientY),
    []
  );

  const markRepeat = async (o: CalendarOccurrence, action: 'done' | 'skip') => {
    if (o.source !== 'row') return;
    const title = displayTitle(o);
    const message = action === 'done' ? `Marked ${title} done` : `Skipped ${title}`;
    try {
      await completeOrSkip(o, action, message);
      setAnnouncement(message);
    } catch (err) {
      reportWriteError(
        err,
        action === 'done' ? `Couldn't mark ${title} done` : `Couldn't skip ${title}`
      );
    } finally {
      data.refetch();
    }
  };

  /** Unmark a done or skipped occurrence: undo its entry in the row's occurrence log. */
  const undoMark = async (o: CalendarRowOccurrence) => {
    const title = displayTitle(o);
    const kind = o.status === 'skipped' ? 'skipped' : 'done';
    try {
      const view = await tableRepeatsApi.get(o.tableId, o.entryId);
      const logged = view.log.find(
        (row) =>
          row.fieldId === o.fieldId && row.occurrence === o.repeat?.occurrence && row.kind === kind
      );
      if (!logged) throw new Error(`This occurrence isn't logged as ${kind} any more`);
      markOwnWrite(`entry:${o.tableId}:${o.entryId}`);
      await tableRepeatsApi.undoOccurrence(o.tableId, o.entryId, logged.id, {
        expectedRevision: view.revision,
        schemaVersion: o.schemaVersion,
        fieldId: o.fieldId,
      });
      setAnnouncement(kind === 'skipped' ? `Unskipped ${title}` : `Unmarked ${title}`);
    } catch (err) {
      reportWriteError(
        err,
        `Couldn't undo ${kind === 'skipped' ? 'the skip of' : 'done on'} ${title}`
      );
    } finally {
      data.refetch();
    }
  };

  /** Done by status: set the row's status to one of the repeat's done options. */
  const markStatus = async (
    o: CalendarRowOccurrence,
    statusFieldId: string,
    label: string,
    fresh?: { expectedRevision: string; schemaVersion: string }
  ) => {
    const title = displayTitle(o);
    const message = `Marked ${title} ${label}`;
    try {
      await markRowStatus(o, statusFieldId, label, message, fresh);
      setAnnouncement(message);
    } catch (err) {
      reportWriteError(err, `Couldn't mark ${title} ${label}`);
    } finally {
      data.refetch();
    }
  };

  /** Whether the row's field repeats (rows of it may get a repeat). */
  const fieldRepeats = (o: CalendarRowOccurrence) =>
    Boolean(o.repeat) ||
    Boolean(
      calendarsById
        .get(o.calendarId)
        ?.boundFields.some((b) => b.tableId === o.tableId && b.fieldId === o.fieldId && b.repeats)
    );

  /** The item menu: only what applies to this item (nothing grayed out with a reason). */
  const menuItems = (o: CalendarOccurrence, anchor: HTMLElement) => {
    // An automation wake opens its popover; everything else lives there.
    if (o.source === 'automation') return [{ label: 'Open', onSelect: () => openItem(o, anchor) }];
    // Mark done / Skip: the current, still open occurrence of a repeating row.
    const markable = o.source === 'row' && Boolean(o.repeat?.isCurrent) && !isSettled(o);
    const items: { label: string; onSelect: () => void }[] = [
      { label: 'Open', onSelect: () => openItem(o, anchor) },
    ];
    if (markable) {
      items.push({ label: 'Mark done', onSelect: () => void markRepeat(o, 'done') });
      items.push({ label: 'Skip', onSelect: () => void markRepeat(o, 'skip') });
    }
    if (o.canMove)
      items.push({
        label: 'Move to…',
        onSelect: () => setPopover({ kind: 'moveTo', occurrence: o, anchor }),
      });
    if (o.source === 'row' && fieldRepeats(o))
      items.push({
        label: 'Repeat…',
        onSelect: () => {
          openerRef.current = anchor;
          setPopover({ kind: 'repeat', occurrence: o, anchor });
        },
      });
    if (o.source === 'event')
      items.push({ label: 'Delete', onSelect: () => void removeFocused(o, anchor) });
    return items;
  };

  /** The row popover's actions: the item menu's, for a row. */
  const rowActions = (
    o: CalendarRowOccurrence,
    anchorOf: () => HTMLElement
  ): RowPopoverAction[] => {
    const actions: RowPopoverAction[] = [];
    if (o.repeat) {
      const closed = isSettled(o) || !o.repeat.isCurrent;
      // The popover stays open: the pressed button turns into an Undo.
      const act = (action: 'done' | 'skip') => () => void markRepeat(o, action);
      actions.push({ label: 'Mark done', disabled: closed, onSelect: act('done') });
      actions.push({ label: 'Skip', disabled: closed, onSelect: act('skip') });
    }
    // A read-only occurrence (a managed created_at, a logged one) has no Move.
    if (o.canMove) {
      actions.push({
        label: 'Move to…',
        onSelect: () => setPopover({ kind: 'moveTo', occurrence: o, anchor: anchorOf() }),
      });
    }
    if (fieldRepeats(o)) {
      actions.push({
        label: 'Repeat…',
        onSelect: () => {
          const anchor = anchorOf();
          openerRef.current = anchor;
          setPopover({ kind: 'repeat', occurrence: o, anchor });
        },
      });
    }
    return actions;
  };

  const dayOf = (o: CalendarOccurrence) =>
    o.time.kind === 'all_day' ? o.time.startDate : instantToZoned(o.time.start, zone).date;

  // Pane shortcuts (bound on the root only, never while typing)
  const searchRef = useRef<HTMLInputElement>(null);
  const onRootKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || popover) return;
    const key = e.key;
    const actions: Record<string, () => void> = {
      t: goToday,
      T: goToday,
      m: () => setZoom('month'),
      M: () => setZoom('month'),
      w: () => setZoom('week'),
      W: () => setZoom('week'),
      d: () => setZoom('day'),
      D: () => setZoom('day'),
      y: () => setZoom('year'),
      Y: () => setZoom('year'),
      // j forward, k back, as in Google Calendar and Vim.
      j: () => go(1),
      J: () => go(1),
      k: () => go(-1),
      K: () => go(-1),
      '/': () => searchRef.current?.focus(),
      c: () => createAtNow(),
      C: () => createAtNow(),
    };
    // + / − zoom the times while the grid (or the overview) has focus; with
    // ⌘ / Ctrl they stay the app's own zoom (returned above).
    if (
      timed &&
      (key === '+' || key === '=' || key === '-') &&
      (e.target as HTMLElement).closest('[role="grid"], [data-time-overview]')
    ) {
      e.preventDefault();
      const target = (e.target as HTMLElement).getBoundingClientRect();
      const inTimes = (e.target as HTMLElement).closest('[data-cal-drop="timed"]');
      timeScale.zoomBy(
        key === '-' ? 1 / KEY_ZOOM : KEY_ZOOM,
        inTimes && target.height > 0 ? target.top + target.height / 2 : null
      );
      return;
    }
    // ←/→ navigate ranges only when the grid itself didn't consume them.
    if (
      (key === 'ArrowLeft' || key === 'ArrowRight') &&
      !(e.target as HTMLElement).closest('[role="grid"]')
    ) {
      e.preventDefault();
      go(key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    const run = actions[key];
    if (run) {
      e.preventDefault();
      run();
    }
  };

  const createAtNow = () => {
    if (zoom === 'year') return;
    const focusDay = range.days.includes(today) ? today : range.days[0]!;
    if (zoom === 'month') {
      const cell = rootRef.current?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]');
      setQuickCalendarId(null);
      setPopover({
        kind: 'quick',
        slot: { kind: 'all_day', startDate: focusDay, endDate: addDays(focusDay, 1) },
      });
      openerRef.current = cell ?? null;
      return;
    }
    const nowMin = instantToZoned(new Date().toISOString(), zone).minutes;
    const start = Math.min(Math.ceil((nowMin + 1) / 15) * 15, 1410);
    setQuickCalendarId(null);
    setPopover({ kind: 'quick', slot: { kind: 'timed', day: focusDay, start, end: start + 30 } });
  };

  // Month cell capacity (min 2; 2 when narrow)
  const [maxPerCell, setMaxPerCell] = useState(3);
  useLayoutEffect(() => {
    if (zoom !== 'month') return;
    const body = scrollRef.current;
    if (!body) return;
    const measure = () => {
      if (narrow) return setMaxPerCell(2);
      const weeks = range.days.length / 7;
      const cellPx = body.clientHeight / weeks - 28; // minus the date number row
      setMaxPerCell(Math.max(2, Math.floor(cellPx / 22)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    return () => ro.disconnect();
  }, [zoom, narrow, range.days.length]);

  // States
  const unavailableCount = data.unavailable.length;
  // Interval repeats too frequent to show every time (the server caps each row),
  // and those under a minute, which it doesn't draw at all (`hidden`).
  const truncated = data.truncated;
  const cutShort = truncated.filter((row) => !row.hidden);
  const tooFrequent = truncated.filter((row) => row.hidden);
  const zoneLabel = useMemo(() => zoneAbbreviation(zone), [zone]);

  // Smallest range first: Day, Week (3 days in a narrow pane), Month, Year.
  const zoomOptions: CalendarZoom[] =
    paneWidth < NARROW_DAY_PX
      ? ['day', 'month', 'year']
      : paneWidth < THREE_DAY_PX
        ? ['day', '3day', 'month', 'year']
        : ['day', 'week', 'month', 'year'];
  const overviewShown = timed && view.overview;

  const gridProps = {
    days: range.days,
    today,
    zone,
    occurrences: gridItems,
    intervals: shownIntervals,
    onOpenInterval: openInterval,
    calendarsById,
    colorOf,
    narrow,
    draft,
    draftColor,
    onDraft,
    focusDay: view.focusDay,
    onOpenItem: openItem,
    onOpenDay: openDay,
    onItemKeyDown,
    ghostRef,
    // The opening scroll waits for this range's items (not the previous
    // range's), and for the calendar list: no query yet is "not loaded",
    // unless every calendar is hidden (nothing will come).
    itemsReady: query ? data.shownKey === occurrencesSearch(query) : allHidden,
    dragPreview: moves.dragPreview,
    onItemDragStart: moves.onItemDragStart,
    onItemContextMenu,
  };

  const rangeNoun =
    zoom === 'month'
      ? 'month'
      : zoom === 'year'
        ? 'year'
        : zoom === 'day'
          ? 'day'
          : zoom === '3day'
            ? 'range'
            : 'week';

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={cn(styles.root, narrow && styles.narrow)}
      data-calendar-pane=""
      data-zoom={zoom}
      onKeyDown={onRootKeyDown}
    >
      <header className={styles.toolbar}>
        <div className={styles.navGroup}>
          <Button
            size="md"
            variant="ghost"
            iconOnly
            className={styles.navButton}
            aria-label={`Previous ${rangeNoun}`}
            aria-keyshortcuts="K ArrowLeft"
            title={`Previous ${rangeNoun} (K)`}
            onClick={() => go(-1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            size="md"
            variant="ghost"
            iconOnly
            className={styles.navButton}
            aria-label={`Next ${rangeNoun}`}
            aria-keyshortcuts="J ArrowRight"
            title={`Next ${rangeNoun} (J)`}
            onClick={() => go(1)}
          >
            <ChevronRightIcon />
          </Button>
          <Button size="sm" variant="neutral" onClick={goToday}>
            Today
          </Button>
          <h2 className={styles.rangeLabel}>{label}</h2>
        </div>
        <div className={styles.toolGroup}>
          {projectId && (
            <Button
              size="sm"
              variant={projectOnly ? 'primary' : 'ghost'}
              aria-pressed={projectOnly}
              onClick={() => updateCalendarView({ projectOnly: !view.projectOnly })}
            >
              This project&apos;s tables
            </Button>
          )}
          <TextInput
            ref={searchRef}
            size="sm"
            type="search"
            className={styles.search}
            placeholder="Search"
            aria-label="Search this range"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearch('');
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <Segmented
            size="sm"
            aria-label="Zoom"
            value={zoom}
            onChange={(v) => setZoom(v as CalendarZoom)}
          >
            {zoomOptions.map((z) => (
              <Segmented.Option key={z} value={z} aria-label={ZOOM_LONG[z]}>
                {narrow ? ZOOM_SHORT[z] : ZOOM_LONG[z]}
              </Segmented.Option>
            ))}
          </Segmented>
          {timed && (
            <Tooltip label="Overview" side="bottom">
              <Button
                size="sm"
                variant={view.overview ? 'primary' : 'ghost'}
                iconOnly
                aria-label="Overview"
                aria-pressed={view.overview}
                aria-controls={view.overview ? overviewId : undefined}
                onClick={() => updateCalendarView({ overview: !view.overview })}
              >
                <OverviewIcon />
              </Button>
            </Tooltip>
          )}
          <Tooltip label={zone} side="bottom">
            <span className={styles.zone} tabIndex={0} aria-label={`Time zone ${zone}`}>
              {zoneLabel}
            </span>
          </Tooltip>
        </div>
      </header>
      <div className={cn(styles.progress, loading && styles.progressActive)} aria-hidden />

      {(allHidden || unavailableCount > 0 || truncated.length > 0 || loadError) && (
        <div className={styles.notices}>
          {allHidden && (
            <p className={styles.noticeLine}>
              All calendars are hidden ·{' '}
              <button type="button" className={styles.linkButton} onClick={showAllCalendars}>
                Show all
              </button>
            </p>
          )}
          {unavailableCount > 0 && (
            <p className={styles.noticeLine}>
              {unavailableCount === 1 ? "1 field isn't" : `${unavailableCount} fields aren't`}{' '}
              showing because {unavailableCount === 1 ? 'its table is' : 'their tables are'}{' '}
              archived
            </p>
          )}
          {cutShort.length > 0 && (
            <p className={styles.noticeLine} role="note">
              {cutShort.length === 1
                ? `“${cutShort[0].title}” repeats too often to show every time in this ${rangeNoun}: only its first ${cutShort[0].shown} are here`
                : `${cutShort.length} rows repeat too often to show every time in this ${rangeNoun}: only their first ones are here`}
            </p>
          )}
          {tooFrequent.length > 0 && (
            <p className={styles.noticeLine} role="note">
              {tooFrequent.length === 1
                ? `“${tooFrequent[0].title}” repeats more often than once a minute: too frequent to show on the calendar`
                : `${tooFrequent.length} rows repeat more often than once a minute: too frequent to show on the calendar`}
            </p>
          )}
          {loadError && (
            <p className={cn(styles.noticeLine, styles.errorLine)} role="alert">
              Couldn&apos;t load this {rangeNoun} ·{' '}
              <button type="button" className={styles.linkButton} onClick={reloadView}>
                Retry
              </button>
            </p>
          )}
        </div>
      )}

      <TimeScaleContext.Provider value={timeScale}>
        <div className={styles.gridRow}>
          <div
            ref={scrollRef}
            id={scrollId}
            className={cn(styles.scroll, stale && styles.stale)}
            data-calendar-scroll=""
            data-stale={stale ? '' : undefined}
            aria-busy={stale || undefined}
            tabIndex={-1}
          >
            {zoom === 'year' ? (
              <>
                <YearGrid
                  anchor={anchor}
                  weekStart={weekStart}
                  today={today}
                  zone={zone}
                  occurrences={shown}
                  colorOf={colorOf}
                  onOpenMonth={(first) =>
                    updateCalendarView({ anchor: first, zoom: 'month', focusDay: null })
                  }
                  onOpenDay={openDay}
                  onOpenItem={openItem}
                />
              </>
            ) : zoom === 'month' ? (
              <MonthGrid {...gridProps} anchor={anchor} maxPerCell={maxPerCell} />
            ) : (
              <TimeGrid key={`${zoom}:${range.from}`} {...gridProps} />
            )}
          </div>
          {overviewShown && (
            <TimeOverview
              id={overviewId}
              days={range.days}
              zone={zone}
              occurrences={shown}
              intervals={shownIntervals}
              colorOf={colorOf}
              controls={scrollId}
            />
          )}
        </div>
      </TimeScaleContext.Provider>

      <div className={styles.srOnly} aria-live="polite">
        {announcement}
      </div>

      {popover?.kind === 'menu' && (
        <ContextMenu
          ariaLabel={`${displayTitle(popover.occurrence)} actions`}
          x={popover.x}
          y={popover.y}
          items={menuItems(popover.occurrence, popover.anchor)}
          onClose={() => {
            setPopover((p) => (p?.kind === 'menu' ? null : p));
            if (popover.anchor.isConnected) popover.anchor.focus({ preventScroll: true });
          }}
        />
      )}
      {popover?.kind === 'automation' && popover.anchor.isConnected && (
        <AutomationOccurrencePopover
          anchor={popover.anchor}
          returnFocusTo={popover.returnFocusTo}
          occurrence={popover.occurrence}
          runAt={popover.runAt}
          offerUndo={automationUndo}
          onEdit={setEditingAutomation}
          onOpenThread={openThread}
          onChanged={() => data.refetch()}
          onClose={() => setPopover(null)}
        />
      )}
      {editingAutomation && (
        <AutomationEditForm
          automation={editingAutomation}
          onClose={() => setEditingAutomation(null)}
          onSaved={(saved) => {
            setEditingAutomation(null);
            setAnnouncement(`Saved ${saved.name}`);
            data.refetch();
          }}
        />
      )}
      {popover?.kind === 'repeat' && popover.anchor.isConnected && (
        <RepeatEditPopover
          anchor={popover.anchor}
          occurrence={popover.occurrence}
          zone={zone}
          onClose={() => setPopover(null)}
          onDone={(message) => {
            setPopover(null);
            setAnnouncement(message);
            data.refetch();
          }}
        />
      )}
      {popover?.kind === 'moveTo' && popover.anchor.isConnected && (
        <MoveToPopover
          anchor={popover.anchor}
          title={displayTitle(popover.occurrence)}
          day={dayOf(popover.occurrence)}
          onCancel={() => setPopover(null)}
          onMove={(day) => {
            const o = popover.occurrence;
            setPopover(null);
            moves.commit(o, moveToDay(o.time, day, zone), popover.anchor);
          }}
        />
      )}
      {moves.choice && moves.choice.anchor.isConnected && (
        <RepeatMoveChoice
          anchor={moves.choice.anchor}
          title={displayTitle(moves.choice.occurrence)}
          target={moves.choice.target}
          canShiftAll={moves.choice.canShiftAll}
          onChoose={moves.choose}
          onCancel={moves.cancelChoice}
        />
      )}
      {popover?.kind === 'quick' && (ghostEl ?? openerRef.current) && (
        <QuickAddPopover
          anchor={(ghostEl ?? openerRef.current)!}
          slot={popover.slot}
          calendars={quickCalendars}
          onCalendarChange={setQuickCalendarId}
          onSave={(input) => void saveQuick(input)}
          onCancel={() => {
            setPopover(null);
            openerRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {popover?.kind === 'row' &&
        (() => {
          const o = liveRow(popover.key, popover.occurrence);
          const anchorOf = () => rowItem(o) ?? popover.anchor;
          return (
            <RowPopover
              key={`${o.tableId}:${o.entryId}`}
              anchor={popover.anchor}
              resolveAnchor={() => rowItem(o)}
              occurrence={o}
              calendar={calendarsById.get(o.calendarId)}
              zone={zone}
              fields={popover.fields}
              actions={rowActions(o, anchorOf)}
              onMarkStatus={(statusFieldId, label, fresh) =>
                void markStatus(o, statusFieldId, label, fresh)
              }
              onUndoMark={() => undoMark(o)}
              onOpenFull={(fields) => {
                openerRef.current = anchorOf();
                setPopover(null);
                openRow(o, fields);
              }}
              onClose={() => setPopover(null)}
              onSaved={() => {
                void recordRowEdit(o.tableId);
                data.refetch();
              }}
            />
          );
        })()}
      {popover?.kind === 'event' && (
        <EventPopover
          anchor={popover.anchor}
          eventId={popover.eventId}
          calendars={calendars.active}
          viewerZone={zone}
          focusTitle={popover.focusTitle}
          occurrence={popover.occurrence}
          onConvert={(event, target) => convertEvent(event, target, popover.anchor)}
          onClose={() => setPopover(null)}
          onChanged={(event) => {
            if (event === null) {
              data.patchLocal((list) =>
                list.filter((o) => !(o.source === 'event' && o.eventId === popover.eventId))
              );
              return;
            }
            data.patchLocal((list) =>
              list.map((o) =>
                o.source === 'event' && o.eventId === event.id
                  ? {
                      ...o,
                      title: event.title,
                      calendarId: event.calendarId,
                      revision: event.revision,
                      timeZone: event.time.timeZone,
                      time: eventSpan(event.time),
                      // As the server sends it: only timed events resize.
                      canResize: event.time.kind === 'timed',
                    }
                  : o
              )
            );
          }}
        />
      )}
      {entry && (
        <TableEntryModal
          tableId={entry.tableId}
          entryId={entry.entryId}
          fields={entry.fields}
          onClose={() => {
            setEntry(null);
            openerRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
