/**
 * The date picker's floating card: a day grid (with month and year jumps), a
 * time list, or both for a datetime. Portaled to `<body>` and marked
 * `data-keeps-cell` so the table cell it opens from stays open.
 *
 * It is the topmost layer: Escape is caught in the window's capture phase
 * (pickerLayer), and keys, clicks and focus changes inside it never reach the
 * field's hosts (a cell's Enter-to-commit, a modal's Tab trap). Follows the
 * WAI-ARIA date picker dialog pattern. A host can extend the card through
 * `addon`, as the table's repeating dates do (DateRepeatPopover).
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { userTimeZone } from '@snaglet/shared/utils';
import { useAnchoredPosition } from '@desktop/components/Popover';
import {
  addDays,
  addMonths,
  dayOfMonth,
  instantToZoned,
  monthGridDays,
  startOfMonth,
  startOfWeek,
} from '@desktop/features/calendar/calendarDates';
import { cn } from '@desktop/utils/classNames';
import { fixedLayerScale, fixedLayerViewport } from '@desktop/utils/cssZoom';
import {
  DEFAULT_TIME,
  dayInRange,
  dayOf,
  formatDayLabel,
  formatMonthLong,
  formatMonthShort,
  formatMonthTitle,
  formatWeekday,
  isIsoDate,
  rangeProblem,
  timeOf,
  type PickerKind,
} from './dateText';
import {
  DATE_PICKER_ATTR,
  isInsideDatePicker,
  isPendingDateField,
  isTopDatePicker,
  registerOpenDatePicker,
} from './pickerLayer';
import { TimeList } from './TimeList';
import styles from './DatePicker.module.scss';

/** Below this much room (CSS px) the card becomes a full-width sheet. */
const SHEET_BELOW_PX = 360;
/** Below this much room a datetime stacks its time list under the grid. */
const STACK_BELOW_PX = 420;

type View = 'days' | 'months' | 'years';
export type PickerLayout = 'wide' | 'stacked' | 'sheet';

/** The picker is one end of a range: which end, and the other end's day ('' when empty). */
export interface PickerRange {
  part: 'start' | 'end';
  otherDay: string;
}

/** Days the grid dots under their number (a repeat's next occurrences). */
export interface DatePickerMarks {
  /**
   * The days of the month on screen (its first day, `YYYY-MM-01`) to dot,
   * asked again only when the month changes: keep it stable between renders.
   */
  daysIn: (month: string) => ReadonlySet<string>;
  /** What a dotted day's label adds after a comma ("repeats"). */
  label: string;
}

/**
 * What a host adds to the card (the table's Repeat row and Repeat view).
 * Every part is optional; without an addon the card is the plain picker.
 */
export interface DatePickerAddon {
  /** Under the days and times, above the footer. */
  below?: ReactNode;
  /** Another view of the same card: shown instead of the days, times and footer while set. */
  view?: ReactNode;
  /** The card's width while `view` shows (at least the picker's own). */
  viewWidth?: number;
  /**
   * A day or time the host holds back (a move waiting for its answer): the
   * grid marks its day like typed text, and a time pick keeps its day.
   */
  pending?: string | null;
  /**
   * A pick from the days, the times or Today, before it commits: true when
   * the host takes it (it doesn't commit and the card stays open).
   */
  interceptPick?: (next: string) => boolean;
  /** Escape, before the card's own: true when the host stepped back (out of `view`, a pending move). */
  onEscape?: () => boolean;
  /** Days of the shown month to dot; never the picked day, nor the other months' days in the grid. */
  marks?: DatePickerMarks;
  /**
   * A time pick leaves the card open (Done closes it): the host has more to
   * set under the grid (the Repeat row), so picking the time is not the end.
   */
  stayOpenOnTime?: boolean;
}

export interface DatePickerProps {
  id: string;
  anchor: HTMLElement;
  kind: PickerKind;
  /** The committed wire value (may be `''`). */
  value: string;
  /** What the field's typed text reads as, so the grid follows typing. */
  preview: string | null;
  min?: string;
  max?: string;
  /** Minutes between time rows. */
  step: number;
  clearable: boolean;
  locale: string;
  today: string;
  weekStart: number;
  /** Opened from the keyboard: focus goes into the card. */
  focusOnOpen: boolean;
  /** Bumped by the field (↓ while open) to move focus into the card. */
  focusRequest: number;
  label: string;
  /** Why the field refused its typed text, shown above the footer. */
  problem?: string | null;
  /** This field is one end of a range: the grid shows the range (see `rangeSpan`). */
  range?: PickerRange;
  /** The host's additions to the card (see {@link DatePickerAddon}). */
  addon?: DatePickerAddon;
  onCommit: (next: string, close: boolean) => void;
  onClose: (returnFocus: boolean) => void;
}

/** Room for the card, in the card's own px (the fixed layer's, see utils/cssZoom). */
function availableWidth(anchor: HTMLElement): number {
  const pane = anchor.closest('.pane-body')?.getBoundingClientRect();
  const viewport = fixedLayerViewport().width;
  const width = pane && pane.width > 0 ? Math.min(pane.width, viewport) : viewport;
  return width / fixedLayerScale();
}

function pickerLayout(kind: PickerKind, room: number): PickerLayout {
  if (room < SHEET_BELOW_PX) return 'sheet';
  if (kind === 'datetime-local' && room < STACK_BELOW_PX) return 'stacked';
  return 'wide';
}

const WIDTH: Record<PickerKind, number> = { date: 272, time: 200, 'datetime-local': 400 };

/**
 * @public The days a range picker tints, first to last, or null: from the Start to
 * the End. On the End's picker a hovered day on or after the Start stands in
 * for the End, previewing the range it would make.
 */
export function rangeSpan(
  range: PickerRange | undefined,
  selectedDay: string,
  hoveredDay: string | null
): { from: string; to: string } | null {
  if (!range?.otherDay) return null;
  if (range.part === 'start') {
    return selectedDay && selectedDay <= range.otherDay
      ? { from: selectedDay, to: range.otherDay }
      : null;
  }
  const end = hoveredDay && hoveredDay >= range.otherDay ? hoveredDay : selectedDay;
  return end && end >= range.otherDay ? { from: range.otherDay, to: end } : null;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const PRIMARY_DAY = '[role="gridcell"][tabindex="0"], [data-choice][tabindex="0"]';
// A roving group (radios, options) is one stop: its tabindex -1 members are left out.
const TABBABLE = [
  'button:not(:disabled):not([tabindex="-1"])',
  'input:not(:disabled):not([tabindex="-1"])',
  'select:not(:disabled)',
  '[tabindex="0"]:not([aria-hidden="true"])',
].join(', ');

export function DatePicker({
  id,
  anchor,
  kind,
  value,
  preview,
  min,
  max,
  step,
  clearable,
  locale,
  today,
  weekStart,
  focusOnOpen,
  focusRequest,
  label,
  problem,
  range,
  addon,
  onCommit,
  onClose,
}: DatePickerProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const hasDays = kind !== 'time';
  const hasTimes = kind !== 'date';
  const selectedDay = dayOf(kind, value);
  const selectedTime = timeOf(kind, value);
  // A move the host holds back: its day reads as the preview, its time stays picked.
  const heldDay = addon?.pending ? dayOf(kind, addon.pending) : '';
  const heldTime = addon?.pending ? timeOf(kind, addon.pending) : '';
  const previewDay = (preview ? dayOf(kind, preview) : '') || heldDay;
  const altView = addon?.view ?? null;
  const viewOpen = Boolean(altView);

  const [layout, setLayout] = useState<PickerLayout>(() =>
    pickerLayout(kind, availableWidth(anchor))
  );
  const baseWidth = layout === 'sheet' ? 4096 : layout === 'stacked' ? WIDTH.date : WIDTH[kind];
  const width = viewOpen && addon?.viewWidth ? Math.max(baseWidth, addon.viewWidth) : baseWidth;
  const { position } = useAnchoredPosition({
    anchor,
    surfaceRef,
    width,
    // A card with a host's additions grows to show them whole (the pane still caps it).
    maxHeight: addon ? 720 : 480,
  });

  const [view, setView] = useState<View>('days');
  const viewRef = useRef(view);
  viewRef.current = view;
  const [focusedDay, setFocusedDay] = useState(
    () => previewDay || selectedDay || clampDay(today, min, max)
  );
  const focusPending = useRef(false);

  // Typing in the field (or a typed ISO taking effect) moves the grid there.
  const [lastPreview, setLastPreview] = useState(previewDay);
  if (previewDay !== lastPreview) {
    setLastPreview(previewDay);
    if (previewDay) setFocusedDay(previewDay);
  }
  const [lastSelected, setLastSelected] = useState(selectedDay);
  if (selectedDay !== lastSelected) {
    setLastSelected(selectedDay);
    if (selectedDay) setFocusedDay(selectedDay);
  }
  const [timeFocusRequest, setTimeFocusRequest] = useState(0);

  const close = useRef(onClose);
  close.current = onClose;
  const escapeAddon = useRef(addon?.onEscape);
  escapeAddon.current = addon?.onEscape;

  // An open picker is the top layer (RepeatSurface asks); one opened from
  // inside this card (the Repeat view's end date) is above it.
  const layer = useRef({});
  useEffect(() => registerOpenDatePicker(layer.current), []);

  // Escape closes only the picker (a month/year view, or the host's view,
  // steps back first), and a press anywhere outside the card and its field
  // closes it. A picker above this one takes both.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!isTopDatePicker(layer.current)) return;
      // A field inside the card (a host's) with typed text reverts it first.
      const target = event.target;
      if (
        target instanceof Node &&
        surfaceRef.current?.contains(target) &&
        isPendingDateField(target)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (escapeAddon.current?.()) return;
      if (viewRef.current !== 'days') {
        focusPending.current = surfaceRef.current?.contains(document.activeElement) ?? false;
        setView('days');
        return;
      }
      close.current(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (surfaceRef.current?.contains(target) || anchor.contains(target)) return;
      // A press in a picker opened above this one (the Repeat view's end
      // date) is that picker's; a press outside every picker closes them all.
      if (!isTopDatePicker(layer.current) && isInsideDatePicker(target)) return;
      close.current(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchor]);

  // The pane narrowing (a split, a sidebar) switches the layout live.
  useEffect(() => {
    const update = () => setLayout(pickerLayout(kind, availableWidth(anchor)));
    const pane = anchor.closest('.pane-body');
    const observer =
      pane && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (pane) observer?.observe(pane);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [anchor, kind]);

  // Keyboard opens (and ↓ from the field while open) put focus on the
  // focused day, or the active time when there is no grid.
  const placed = position !== null;
  const focusPrimary = useRef(() => {});
  focusPrimary.current = () => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const target = hasDays
      ? surface.querySelector<HTMLElement>(PRIMARY_DAY)
      : listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]');
    target?.focus({ preventScroll: true });
  };
  const openedByKeyboard = useRef(focusOnOpen);
  useEffect(() => {
    if (placed && openedByKeyboard.current) focusPrimary.current();
  }, [placed]);
  const firstRequest = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest !== firstRequest.current) focusPrimary.current();
  }, [focusRequest]);

  // Back from the host's view: focus that went with it (its control gone,
  // the host with nothing of its own to focus) comes to the focused day.
  const hadView = useRef(viewOpen);
  useEffect(() => {
    const closed = hadView.current && !viewOpen;
    hadView.current = viewOpen;
    if (!closed) return;
    const active = document.activeElement;
    const inside = active && (surfaceRef.current?.contains(active) || anchor.contains(active));
    if (!inside) focusPrimary.current();
  }, [viewOpen, anchor]);

  // Keyboard moves focus the new day (or month, or year) once it renders.
  useLayoutEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    surfaceRef.current?.querySelector<HTMLElement>(PRIMARY_DAY)?.focus({ preventScroll: true });
  });

  const moveTo = (day: string, viaKeyboard = true) => {
    focusPending.current = viaKeyboard;
    setFocusedDay(day);
  };
  /** Switch views; focus follows only when it was already in the card (keyboard). */
  const switchView = (next: View, day?: string) => {
    focusPending.current = surfaceRef.current?.contains(document.activeElement) ?? false;
    if (day) setFocusedDay(day);
    setView(next);
  };

  const dateTimeFor = (day: string, time: string): string => {
    const next = `${day}T${time}`;
    const problem = rangeProblem(kind, next, min, max);
    // A day at the edge of the range keeps the time in range.
    if (problem === 'before-min' && min && !isIsoDate(min)) return min;
    if (problem === 'after-max' && max && !isIsoDate(max)) return max;
    return next;
  };

  /** Commit a pick, unless the host takes it (a repeating date's move). */
  const commit = (next: string, closeAfter: boolean) => {
    if (next && addon?.interceptPick?.(next)) return;
    onCommit(next, closeAfter);
  };

  const pickDay = (day: string, viaKeyboard: boolean) => {
    if (!dayInRange(day, min, max)) return;
    setFocusedDay(day);
    if (kind === 'date') {
      commit(day, true);
      return;
    }
    commit(dateTimeFor(day, heldTime || selectedTime || DEFAULT_TIME), false);
    // Next stop for a keyboard user: the time.
    if (viaKeyboard) setTimeFocusRequest((n) => n + 1);
  };

  const pickTime = (time: string) => {
    if (kind === 'time') commit(time, true);
    else
      commit(
        dateTimeFor(heldDay || selectedDay || focusedDay || today, time),
        !addon?.stayOpenOnTime
      );
  };

  const timeDisabled = (time: string) =>
    kind === 'time'
      ? rangeProblem('time', time, min, max) !== null
      : rangeProblem(kind, `${heldDay || selectedDay || focusedDay}T${time}`, min, max) !== null;

  const now = instantToZoned(new Date().toISOString(), userTimeZone());
  const nowTime = `${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')}`;
  const todayValue =
    kind === 'date'
      ? today
      : kind === 'time'
        ? nowTime
        : dateTimeFor(today, selectedTime || DEFAULT_TIME);
  const todayDisabled = rangeProblem(kind, todayValue, min, max) !== null;

  const onSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Never let the card's keys reach the field's hosts (cell commit, modal trap).
    event.stopPropagation();
    if (event.key !== 'Tab') return;
    const surface = surfaceRef.current;
    if (!surface) return;
    // Document order (selector lists don't promise it everywhere).
    const stops = Array.from(surface.querySelectorAll<HTMLElement>(TABBABLE)).sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    if (!stops.length) return;
    event.preventDefault();
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const next =
      at === -1
        ? 0
        : event.shiftKey
          ? (at - 1 + stops.length) % stops.length
          : (at + 1) % stops.length;
    stops[next].focus({ preventScroll: true });
  };

  const style: CSSProperties = position ?? {
    position: 'fixed',
    opacity: 0,
    pointerEvents: 'none',
    width,
  };

  return createPortal(
    <div
      ref={surfaceRef}
      id={id}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      className={cn(
        styles.surface,
        layout === 'sheet' && styles.sheet,
        layout === 'stacked' && styles.stacked,
        kind === 'date' && styles.kindDate,
        kind === 'time' && styles.kindTime,
        kind === 'datetime-local' && styles.kindDateTime,
        viewOpen && styles.viewOpen
      )}
      style={style}
      data-layout={layout}
      data-keeps-cell=""
      data-floating-layer=""
      {...{ [DATE_PICKER_ATTR]: '' }}
      onKeyDown={onSurfaceKeyDown}
      // Mouse picks keep focus where it is (the field, or the focused day);
      // the time entry (and a host's inputs and selects) still take a click.
      onMouseDown={(event) => {
        event.stopPropagation();
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement))
          event.preventDefault();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onFocus={(event) => event.stopPropagation()}
      onBlur={(event) => {
        event.stopPropagation();
        const next = event.relatedTarget;
        if (!(next instanceof Node)) return;
        if (surfaceRef.current?.contains(next) || anchor.contains(next)) return;
        // Into a picker opened from inside the card: still here.
        if (isInsideDatePicker(next)) return;
        close.current(false);
      }}
    >
      {position && viewOpen && <div className={styles.addonView}>{altView}</div>}
      {position && !viewOpen && (
        <div className={styles.body}>
          {hasDays && (
            <div className={styles.calendar}>
              {view === 'days' ? (
                <DaysView
                  titleId={titleId}
                  focusedDay={focusedDay}
                  selectedDay={selectedDay}
                  previewDay={previewDay}
                  today={today}
                  min={min}
                  max={max}
                  weekStart={weekStart}
                  locale={locale}
                  range={range}
                  marks={addon?.marks}
                  gridRef={gridRef}
                  onMove={moveTo}
                  onPick={pickDay}
                  onTitle={() => switchView('months')}
                />
              ) : (
                <ChoiceView
                  view={view}
                  titleId={titleId}
                  focusedDay={focusedDay}
                  selectedDay={selectedDay}
                  today={today}
                  min={min}
                  max={max}
                  locale={locale}
                  onMove={moveTo}
                  onTitle={() => switchView(view === 'months' ? 'years' : 'days')}
                  onChoose={(day) => switchView(view === 'years' ? 'months' : 'days', day)}
                />
              )}
            </div>
          )}
          {hasTimes && (
            <TimeList
              value={heldTime || selectedTime}
              step={step}
              locale={locale}
              fallbackMinutes={now.minutes}
              isDisabled={timeDisabled}
              onPick={pickTime}
              listRef={listRef}
              idPrefix={id}
              focusRequest={timeFocusRequest}
            />
          )}
        </div>
      )}
      {position && !viewOpen && addon?.below}
      {position && !viewOpen && (
        <p className={styles.problem} role="status" aria-live="polite">
          {problem}
        </p>
      )}
      {position && !viewOpen && (
        <div className={styles.footer}>
          <button
            type="button"
            className={cn(styles.footerButton, styles.footerToday)}
            disabled={todayDisabled}
            onClick={() => commit(todayValue, true)}
          >
            {kind === 'time' ? 'Now' : 'Today'}
          </button>
          {clearable && (
            <button
              type="button"
              className={styles.footerButton}
              disabled={!value}
              onClick={() => onCommit('', true)}
            >
              Clear
            </button>
          )}
          {(kind === 'datetime-local' || addon) && (
            <button
              type="button"
              className={cn(styles.footerButton, styles.footerDone)}
              onClick={() => close.current(true)}
            >
              Done
            </button>
          )}
        </div>
      )}
    </div>,
    document.body
  );
}

function clampDay(day: string, min?: string, max?: string): string {
  if (min && day < min.slice(0, 10)) return min.slice(0, 10);
  if (max && day > max.slice(0, 10)) return max.slice(0, 10);
  return day;
}

// Days

interface DaysViewProps {
  titleId: string;
  focusedDay: string;
  selectedDay: string;
  previewDay: string;
  today: string;
  min?: string;
  max?: string;
  weekStart: number;
  locale: string;
  range?: PickerRange;
  marks?: DatePickerMarks;
  gridRef: RefObject<HTMLDivElement | null>;
  onMove: (day: string, viaKeyboard?: boolean) => void;
  onPick: (day: string, viaKeyboard: boolean) => void;
  onTitle: () => void;
}

function DaysView({
  titleId,
  focusedDay,
  selectedDay,
  previewDay,
  today,
  min,
  max,
  weekStart,
  locale,
  range,
  marks,
  gridRef,
  onMove,
  onPick,
  onTitle,
}: DaysViewProps) {
  const month = startOfMonth(focusedDay);
  const weeks = chunk(monthGridDays(month, weekStart), 7);
  const title = formatMonthTitle(month, locale);
  // Asked for the month on screen only; arrowing within it asks nothing.
  const daysIn = marks?.daysIn;
  const marked = useMemo(() => daysIn?.(month) ?? null, [daysIn, month]);
  // Only the End's picker previews under the pointer (an event's Start moves
  // its whole span); the Start's shows the range as it stands.
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);
  const previewing = range?.part === 'end';
  const span = rangeSpan(range, selectedDay, previewing ? hoveredDay : null);
  const band = span && span.from !== span.to ? span : null;
  const candidate = span && previewing && hoveredDay === span.to ? hoveredDay : null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const weekFirst = startOfWeek(focusedDay, weekStart);
    let next: string | null = null;
    switch (event.key) {
      case 'ArrowLeft':
        next = addDays(focusedDay, -1);
        break;
      case 'ArrowRight':
        next = addDays(focusedDay, 1);
        break;
      case 'ArrowUp':
        next = addDays(focusedDay, -7);
        break;
      case 'ArrowDown':
        next = addDays(focusedDay, 7);
        break;
      case 'PageUp':
        next = addMonths(focusedDay, event.shiftKey ? -12 : -1);
        break;
      case 'PageDown':
        next = addMonths(focusedDay, event.shiftKey ? 12 : 1);
        break;
      case 'Home':
        next = weekFirst;
        break;
      case 'End':
        next = addDays(weekFirst, 6);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        onPick(focusedDay, true);
        return;
      default:
        return;
    }
    event.preventDefault();
    onMove(next);
  };

  return (
    <>
      <div className={styles.header}>
        <NavButton
          label="Previous month"
          direction={-1}
          onClick={() => onMove(addMonths(focusedDay, -1), false)}
        />
        <button
          type="button"
          className={styles.title}
          aria-label={`Choose month and year, ${title}`}
          onClick={onTitle}
        >
          <span id={titleId} aria-live="polite">
            {title}
          </span>
          <Chevron />
        </button>
        <NavButton
          label="Next month"
          direction={1}
          onClick={() => onMove(addMonths(focusedDay, 1), false)}
        />
      </div>
      <div
        ref={gridRef}
        role="grid"
        aria-labelledby={titleId}
        className={styles.grid}
        onKeyDown={onKeyDown}
        onMouseLeave={previewing ? () => setHoveredDay(null) : undefined}
      >
        <div role="row" className={styles.weekdays}>
          {weeks[0].map((day) => {
            const name = formatWeekday(day, locale);
            return (
              <span key={day} role="columnheader" aria-label={name.long} className={styles.weekday}>
                {name.short}
              </span>
            );
          })}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} role="row" className={styles.week}>
            {week.map((day) => {
              const disabled = !dayInRange(day, min, max);
              const selected = day === selectedDay;
              // The range's other end looks picked too; only this field's value is aria-selected.
              const picked = selected || (!!range?.otherDay && day === range.otherDay);
              const inMonth = day.slice(0, 7) === month.slice(0, 7);
              const dotted = !picked && inMonth && !!marked?.has(day);
              const label = formatDayLabel(day, locale);
              return (
                <div
                  key={day}
                  role="gridcell"
                  data-day={day}
                  tabIndex={day === focusedDay ? 0 : -1}
                  aria-selected={selected || undefined}
                  aria-current={day === today ? 'date' : undefined}
                  aria-disabled={disabled || undefined}
                  aria-label={dotted && marks ? `${label}, ${marks.label}` : label}
                  className={cn(
                    styles.day,
                    !inMonth && styles.dayOther,
                    day === today && styles.dayToday,
                    picked && styles.daySelected,
                    !picked && (day === previewDay || day === candidate) && styles.dayPreview,
                    band && day > band.from && day < band.to && styles.dayInRange,
                    band?.from === day && styles.dayRangeStart,
                    band?.to === day && styles.dayRangeEnd,
                    disabled && styles.dayDisabled,
                    dotted && styles.dayMarked
                  )}
                  onClick={() => onPick(day, false)}
                  onMouseEnter={previewing ? () => setHoveredDay(disabled ? null : day) : undefined}
                >
                  <span className={styles.pill} aria-hidden="true">
                    {dayOfMonth(day)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}

// Months and years

interface ChoiceViewProps {
  view: Exclude<View, 'days'>;
  titleId: string;
  focusedDay: string;
  selectedDay: string;
  today: string;
  min?: string;
  max?: string;
  locale: string;
  onMove: (day: string, viaKeyboard?: boolean) => void;
  onTitle: () => void;
  onChoose: (day: string) => void;
}

/** Twelve months of a year, or twelve years, three to a row: fast jumps. */
function ChoiceView({
  view,
  titleId,
  focusedDay,
  selectedDay,
  today,
  min,
  max,
  locale,
  onMove,
  onTitle,
  onChoose,
}: ChoiceViewProps) {
  const year = Number(focusedDay.slice(0, 4));
  const monthIndex = Number(focusedDay.slice(5, 7)) - 1;
  const months = view === 'months';
  const first = months ? 0 : year - (year % 12);
  const pageMonths = months ? 12 : 144;
  const unit = months ? 1 : 12;
  const title = months ? String(year) : `${first} – ${first + 11}`;
  const minMonth = min?.slice(0, 7);
  const maxMonth = max?.slice(0, 7);

  const items = Array.from({ length: 12 }, (_, i) => {
    if (months) {
      const key = `${year}-${String(i + 1).padStart(2, '0')}`;
      return {
        key,
        label: formatMonthShort(i, locale),
        name: `${formatMonthLong(i, locale)} ${year}`,
        day: addMonths(focusedDay, i - monthIndex),
        focused: i === monthIndex,
        current: key === today.slice(0, 7),
        selected: key === selectedDay.slice(0, 7),
        disabled: (!!minMonth && key < minMonth) || (!!maxMonth && key > maxMonth),
      };
    }
    const y = first + i;
    return {
      key: String(y),
      label: String(y),
      name: String(y),
      day: addMonths(focusedDay, (y - year) * 12),
      focused: y === year,
      current: y === Number(today.slice(0, 4)),
      selected: y === Number(selectedDay.slice(0, 4)),
      disabled: (!!min && String(y) < min.slice(0, 4)) || (!!max && String(y) > max.slice(0, 4)),
    };
  });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -3,
      ArrowDown: 3,
    };
    const delta = steps[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      onMove(addMonths(focusedDay, delta * unit));
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      onMove(addMonths(focusedDay, (event.key === 'PageUp' ? -1 : 1) * pageMonths));
    }
  };

  return (
    <>
      <div className={styles.header}>
        <NavButton
          label={months ? 'Previous year' : 'Previous years'}
          direction={-1}
          onClick={() => onMove(addMonths(focusedDay, -pageMonths), false)}
        />
        <button
          type="button"
          className={styles.title}
          aria-label={months ? `Choose year, ${title}` : `Back to days, ${title}`}
          onClick={onTitle}
        >
          <span id={titleId} aria-live="polite">
            {title}
          </span>
          <Chevron up={!months} />
        </button>
        <NavButton
          label={months ? 'Next year' : 'Next years'}
          direction={1}
          onClick={() => onMove(addMonths(focusedDay, pageMonths), false)}
        />
      </div>
      <div role="group" aria-labelledby={titleId} className={styles.choices} onKeyDown={onKeyDown}>
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            data-choice=""
            tabIndex={item.focused ? 0 : -1}
            aria-label={item.name}
            aria-pressed={item.selected}
            aria-current={item.current ? 'date' : undefined}
            disabled={item.disabled}
            className={cn(
              styles.choice,
              item.current && styles.choiceCurrent,
              item.selected && styles.choiceSelected
            )}
            onClick={() => onChoose(item.day)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

function NavButton({
  label,
  direction,
  onClick,
}: {
  label: string;
  direction: 1 | -1;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.nav} aria-label={label} onClick={onClick}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path
          d={direction < 0 ? 'M7.5 2.5 4 6l3.5 3.5' : 'M4.5 2.5 8 6 4.5 9.5'}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg
      className={styles.titleChevron}
      viewBox="0 0 10 10"
      width="9"
      height="9"
      aria-hidden="true"
    >
      <path
        d={up ? 'M2 6.5 5 3.5l3 3' : 'M2 3.5 5 6.5l3-3'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
