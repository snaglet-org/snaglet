import { mountedDisclosure } from '@desktop/ws/sidebarMounted';
/**
 * Calendar sidebar: mini month, the calendar list (rename, show / hide, ⋯
 * menu, pointer-drag reorder), each calendar's bound fields and its
 * automations (SidebarAutomations). "Remove from the calendar" is the only way
 * to unbind Snaglet's own `created_at`, which has no field settings. Row controls
 * show on hover or keyboard focus, and always on touch and narrow viewports.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { AutomationRecord, Calendar, CalendarBoundField } from '@snaglet/shared/types';
import { EyeIcon, EyeSlashIcon, LeafToggle } from '@desktop/components/Icons';
import { ContextMenu } from '@desktop/components/ContextMenu';
import { TreeHeader } from '@desktop/features/workspace-tree/TreeHeader';
import { RenameInput } from '@desktop/features/workspace-tree';
import { getEffectiveZoom } from '@desktop/utils/cssZoom';
import { cn } from '@desktop/utils/classNames';
import { showToast } from '@desktop/utils/toast';
import { getErrorMessage } from '@snaglet/shared/utils';
import { todayIn, viewerTimeZone } from '@desktop/features/calendar/calendarDates';
import { swallowNextClick } from '@desktop/features/calendar/calendarDrag';
import { useCalendarWeekStart } from '@desktop/features/calendar/weekStart';
import {
  calendarColor,
  loadCalendars,
  setCalendarCollapsed,
  setCalendarHidden,
  setFieldHidden,
  useCalendars,
} from '@desktop/features/calendar/calendarStore';
import { jumpCalendarTo, useCalendarView } from '@desktop/features/calendar/calendarViewStore';
import {
  createCalendar,
  moveId,
  recolorCalendar,
  renameCalendar,
  reorderCalendars,
} from '@desktop/features/calendar/calendarListActions';
import { CalendarColorPopover } from '@desktop/features/calendar/CalendarColorPopover';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import { FieldPicker } from '@desktop/features/calendar/FieldPicker';
import { setFieldBinding } from '@desktop/features/calendar/bindField';
import { offerUndo } from '@desktop/features/calendar/calendarUndo';
import { DeleteCalendarDialog } from '@desktop/features/calendar/DeleteCalendarDialog';
import { useAutomations } from '@desktop/features/automations/automationsStore';
import { MiniMonth } from './MiniMonth';
import {
  automationRowButton,
  groupSidebarAutomations,
  menuPoint,
  MoveToCalendarMenu,
  SidebarAutomationRow,
  sidebarListsAutomation,
} from './SidebarAutomations';
import styles from './CalendarSidebar.module.scss';

export interface CalendarSidebarProps {
  /** Open (or focus) the Calendar pane. */
  onOpenCalendar?: () => void;
  /** Open a bound field's table in a pane. */
  onOpenTable?: (tableId: string) => void;
  /** Open an automation in the Automations pane. */
  onOpenAutomation?: (automation: AutomationRecord) => void;
}

const DRAG_THRESHOLD_PX = 5;

/** Eye (shown) / struck-out eye (hidden). */
function EyeGlyph({ open }: { open: boolean }) {
  return open ? <EyeIcon /> : <EyeSlashIcon />;
}

type Surface =
  | { kind: 'palette'; calendar: Calendar; anchor: HTMLElement }
  | { kind: 'picker'; calendar: Calendar; anchor: HTMLElement }
  | { kind: 'menu'; calendar: Calendar; x: number; y: number; anchor: HTMLElement }
  | { kind: 'fieldMenu'; calendar: Calendar; field: CalendarBoundField; x: number; y: number }
  | { kind: 'automationMenu'; automation: AutomationRecord; x: number; y: number; row: HTMLElement }
  | { kind: 'automationMove'; automation: AutomationRecord; row: HTMLElement }
  | null;

/** Take a bound field off its calendar, with Undo on the calendar stack. */
async function removeBoundField(calendar: Calendar, field: CalendarBoundField): Promise<void> {
  const label = `${field.tableName} · ${field.fieldName}`;
  try {
    const { step } = await setFieldBinding(field.tableId, field.fieldId, null, `Remove ${label}`);
    await loadCalendars();
    const { undo, redo } = step;
    offerUndo(`${label} no longer shows on ${calendar.title}`, {
      ...step,
      undo: () => undo().then(loadCalendars),
      ...(redo ? { redo: () => redo().then(loadCalendars) } : {}),
    });
  } catch (err) {
    showToast(getErrorMessage(err, `Couldn't remove ${label}`));
  }
}

export function CalendarSidebar({
  onOpenCalendar,
  onOpenTable,
  onOpenAutomation,
}: CalendarSidebarProps) {
  const zone = useMemo(viewerTimeZone, []);
  const weekStart = useCalendarWeekStart();
  const today = todayIn(zone);
  const view = useCalendarView();
  const calendars = useCalendars();
  const { automations } = useAutomations();
  const automationGroups = useMemo(
    () => groupSidebarAutomations(automations, calendars.active),
    [automations, calendars.active]
  );
  const [surface, setSurface] = useState<Surface>(null);
  const rootRef = useRef<HTMLElement>(null);

  // An automation's menu or picker follows the live record: it closes when
  // the automation drops out of the list (finished, deleted) or moves to
  // another calendar (an agent's change, another window).
  const automationSurface =
    surface?.kind === 'automationMenu' || surface?.kind === 'automationMove' ? surface : null;
  const liveAutomation = automationSurface
    ? automations?.find((a) => a.id === automationSurface.automation.id)
    : undefined;
  const staleAutomationSurface =
    automationSurface !== null &&
    (!liveAutomation ||
      !sidebarListsAutomation(liveAutomation) ||
      liveAutomation.calendarId !== automationSurface.automation.calendarId);
  useEffect(() => {
    if (staleAutomationSurface) setSurface(null);
  }, [staleAutomationSurface]);

  // After a move the row is drawn in another list, and its old button (which
  // had focus) is gone: focus the moved row, or its calendar's leaf when that
  // calendar is folded. Only while focus is still in the sidebar (or lost).
  const [movedFocus, setMovedFocus] = useState<AutomationRecord | null>(null);
  useEffect(() => {
    if (!movedFocus) return;
    setMovedFocus(null);
    const root = rootRef.current;
    const active = document.activeElement;
    if (!root || (active && active !== document.body && !root.contains(active))) return;
    const leaf = Array.from(root.querySelectorAll<HTMLElement>('[data-sidebar-disclosure]')).find(
      (el) => el.dataset.inspectId === movedFocus.calendarId
    );
    (automationRowButton(root, movedFocus.id) ?? leaf)?.focus();
  }, [movedFocus]);

  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Calendar | null>(null);
  const closeDeletion = useCallback(() => setDeleting(null), []);
  const visibleIds = useMemo(
    () => new Set(calendars.visible.map((c) => c.id)),
    [calendars.visible]
  );

  // Pointer-drag reorder (never HTML5 DnD)
  const listRef = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<{ id: string; overIndex: number } | null>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);
  const onRowPointerDown = (event: ReactPointerEvent<HTMLElement>, calendar: Calendar) => {
    if (event.button !== 0 || renaming) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input')) return;
    const startY = event.clientY;
    const zoom = getEffectiveZoom(listRef.current);
    let active = false;
    const ids = calendars.active.map((c) => c.id);
    const rows = () =>
      Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-calendar-row]') ?? []);
    const indexAt = (clientY: number) => {
      const list = rows();
      for (let i = 0; i < list.length; i += 1) {
        const r = list[i].getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return i;
      }
      return list.length;
    };
    const move = (e: PointerEvent) => {
      if (!active && Math.abs(e.clientY - startY) / zoom < DRAG_THRESHOLD_PX) return;
      active = true;
      setDrag({ id: calendar.id, overIndex: indexAt(e.clientY) });
    };
    /** The gesture is over: drop at `clientY`, or (null) cancel. */
    const end = (clientY: number | null) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      cancelDrag.current = null;
      setDrag(null);
      if (!active || clientY === null) return;
      // The click after the release must not open the calendar.
      swallowNextClick();
      const from = ids.indexOf(calendar.id);
      let to = indexAt(clientY);
      if (to > from) to -= 1;
      if (to !== from) void reorderCalendars(moveId(ids, calendar.id, to));
    };
    const up = (e: PointerEvent) => end(e.clientY);
    const cancel = () => end(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    cancelDrag.current?.();
    cancelDrag.current = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  };

  const boundFieldRow = (calendar: Calendar, field: CalendarBoundField) => {
    // Archived table / field: struck through with "archived".
    const archived = view.unavailable.some((u) => u.fieldId === field.fieldId);
    const fieldHidden = calendars.hiddenFields.has(field.fieldId);
    // The row's own order (field, then table) names its controls too.
    const label = `${field.fieldName} · ${field.tableName}`;
    const undated = field.unscheduledCount;
    const undatedText = `${undated} ${undated === 1 ? 'row' : 'rows'} with no ${field.fieldName}`;
    const note = [archived ? 'archived' : '', undated > 0 ? `${undated} undated` : '']
      .filter(Boolean)
      .join(' · ');
    const menuOpen = surface?.kind === 'fieldMenu' && surface.field.fieldId === field.fieldId;
    return (
      <li key={field.fieldId} className={cn(styles.fieldRow, fieldHidden && styles.rowPinned)}>
        <button
          type="button"
          className={cn(
            styles.fieldButton,
            archived && styles.fieldArchived,
            fieldHidden && styles.fieldHidden
          )}
          onClick={() => onOpenTable?.(field.tableId)}
          onContextMenu={(e) => {
            e.preventDefault();
            setSurface({ kind: 'fieldMenu', calendar, field, ...menuPoint(e) });
          }}
          data-inspect-id={field.fieldId}
          data-inspect-name={label}
          aria-label={`${label}${archived ? ', archived' : ''}${undated > 0 ? `, ${undated} undated` : ''}`}
          title={`Open ${field.tableName}${undated > 0 ? ` · ${undatedText}` : ''}`}
        >
          <span aria-hidden className={styles.fieldGlyph}>
            ▦
          </span>
          <span className={styles.itemLabel}>
            <span className={styles.itemName}>{field.fieldName}</span>
            <span className={styles.itemTable}>{field.tableName}</span>
          </span>
          <span className={styles.itemNote}>{note}</span>
        </button>
        <span className={styles.rowControls}>
          <button
            type="button"
            className={cn(styles.iconBtn, styles.rowAction)}
            aria-pressed={!fieldHidden}
            aria-label={fieldHidden ? `Show ${label}` : `Hide ${label}`}
            title={fieldHidden ? 'Show on the calendar' : 'Hide from the calendar'}
            onClick={() => setFieldHidden(field.fieldId, !fieldHidden)}
          >
            <EyeGlyph open={!fieldHidden} />
          </button>
          <button
            type="button"
            className={cn(styles.iconBtn, styles.rowAction)}
            aria-label={`More for ${label}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSurface({ kind: 'fieldMenu', calendar, field, x: r.left, y: r.bottom });
            }}
          >
            ⋯
          </button>
        </span>
      </li>
    );
  };

  const automationRow = (automation: AutomationRecord) => (
    <SidebarAutomationRow
      key={automation.id}
      automation={automation}
      menuOpen={automationSurface?.automation.id === automation.id}
      onOpen={onOpenAutomation}
      onMenu={(a, x, y, row) => setSurface({ kind: 'automationMenu', automation: a, x, y, row })}
    />
  );

  const order = drag
    ? moveId(
        calendars.active.map((c) => c.id),
        drag.id,
        drag.overIndex -
          (calendars.active.findIndex((c) => c.id === drag.id) < drag.overIndex ? 1 : 0)
      )
    : null;
  const activeShown = order
    ? order.map((id) => calendars.active.find((c) => c.id === id)!).filter(Boolean)
    : calendars.active;

  return (
    <section
      ref={rootRef}
      data-sidebar-mounted={calendars.error ? 'error' : calendars.loading ? 'loading' : 'ready'}
      className={styles.root}
      aria-label="Calendar"
    >
      <TreeHeader
        label="Calendar"
        addTitle="New calendar"
        addLabel="New calendar"
        onAdd={() => setCreating(true)}
      />
      <MiniMonth
        today={today}
        anchor={view.anchor ?? today}
        weekStart={weekStart}
        zone={zone}
        loaded={view.loaded}
        visibleCalendarIds={visibleIds}
        zoom={view.zoom}
        onPick={(day) => {
          jumpCalendarTo(day);
          onOpenCalendar?.();
        }}
      />

      <div className={styles.sectionHead}>Calendars</div>
      {calendars.error && (
        <p className={styles.muted}>
          {calendars.error} ·{' '}
          <button type="button" className={styles.link} onClick={() => void calendars.reload()}>
            Retry
          </button>
        </p>
      )}
      <ul ref={listRef} className={styles.list} aria-label="Calendars">
        {creating && (
          <li className={styles.calRow}>
            <span className={styles.swatchStatic} data-cal-color="gray" aria-hidden />
            <RenameInput
              initialValue=""
              onCommit={async (value) => {
                setCreating(false);
                // A saved calendar opens the Calendar pane, as a click on its row does.
                if (value.trim() && (await createCalendar(value))) onOpenCalendar?.();
              }}
              onCancel={() => setCreating(false)}
            />
          </li>
        )}
        {activeShown.map((calendar) => {
          const color = calendarColor(calendar);
          const hidden = calendars.hidden.has(calendar.id);
          const collapsed = calendars.collapsed.has(calendar.id);
          const calendarAutomations = automationGroups.byCalendar.get(calendar.id) ?? [];
          return (
            <li key={calendar.id} className={styles.calItem}>
              <div
                className={cn(styles.calRow, drag?.id === calendar.id && styles.dragging)}
                data-calendar-row=""
                {...calendarColorProps(color)}
                onPointerDown={(e) => onRowPointerDown(e, calendar)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSurface({
                    kind: 'menu',
                    calendar,
                    x: e.clientX,
                    y: e.clientY,
                    anchor: e.currentTarget,
                  });
                }}
              >
                <button
                  type="button"
                  className={styles.leafButton}
                  data-sidebar-disclosure=""
                  data-inspect-id={calendar.id}
                  data-inspect-name={calendar.title}
                  ref={mountedDisclosure((open) => setCalendarCollapsed(calendar.id, !open))}
                  aria-expanded={!collapsed}
                  aria-label={`${collapsed ? 'Show' : 'Hide'} the date fields and automations of ${calendar.title}`}
                  title={
                    collapsed
                      ? 'Show date fields and automations'
                      : 'Hide date fields and automations'
                  }
                  onClick={() => setCalendarCollapsed(calendar.id, !collapsed)}
                >
                  <LeafToggle open={!collapsed} className={styles.leaf} />
                </button>
                {renaming === calendar.id ? (
                  <RenameInput
                    initialValue={calendar.title}
                    onCommit={async (value) => {
                      const ok = await renameCalendar(calendar, value);
                      if (ok) setRenaming(null);
                      return ok;
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span
                    className={cn(styles.calTitle, hidden && styles.calHidden)}
                    onDoubleClick={() => setRenaming(calendar.id)}
                    onClick={() => onOpenCalendar?.()}
                  >
                    {calendar.title}
                  </span>
                )}
                <button
                  type="button"
                  className={cn(styles.iconBtn, styles.rowAction)}
                  aria-pressed={!hidden}
                  aria-label={hidden ? `Show ${calendar.title}` : `Hide ${calendar.title}`}
                  title={hidden ? 'Show' : 'Hide'}
                  onClick={() => setCalendarHidden(calendar.id, !hidden)}
                >
                  <EyeGlyph open={!hidden} />
                </button>
                <button
                  type="button"
                  className={cn(styles.iconBtn, styles.rowAction)}
                  aria-label={`More for ${calendar.title}`}
                  aria-haspopup="menu"
                  aria-expanded={surface?.kind === 'menu' && surface.calendar.id === calendar.id}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setSurface({
                      kind: 'menu',
                      calendar,
                      x: r.left,
                      y: r.bottom,
                      anchor: e.currentTarget,
                    });
                  }}
                >
                  ⋯
                </button>
              </div>
              {!collapsed && (
                <ul className={styles.fields} aria-label={`Fields on ${calendar.title}`}>
                  {calendar.boundFields.map((f) => boundFieldRow(calendar, f))}
                  {/* Once a calendar has a field, more come from its ⋯ menu. */}
                  {calendar.boundFields.length === 0 && (
                    <li className={styles.fieldRow}>
                      <button
                        type="button"
                        className={cn(styles.fieldButton, styles.addField)}
                        onClick={(e) =>
                          setSurface({ kind: 'picker', calendar, anchor: e.currentTarget })
                        }
                      >
                        ＋ Add a date field
                      </button>
                    </li>
                  )}
                </ul>
              )}
              {!collapsed && calendarAutomations.length > 0 && (
                <ul className={styles.fields} aria-label={`Automations on ${calendar.title}`}>
                  {calendarAutomations.map(automationRow)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {calendars.calendars?.length === 0 && <p>No calendars yet. Add a calendar to get started.</p>}
      {automationGroups.unplaced.length > 0 && (
        <div className={styles.unplaced}>
          <div className={styles.unplacedHead}>
            <span className={styles.unplacedSwatch} aria-hidden />
            No calendar
          </div>
          <ul className={styles.fields} aria-label="Automations with no calendar">
            {automationGroups.unplaced.map(automationRow)}
          </ul>
        </div>
      )}
      {deleting && <DeleteCalendarDialog calendar={deleting} onClose={closeDeletion} />}
      {surface?.kind === 'palette' && (
        <CalendarColorPopover
          anchor={surface.anchor}
          value={surface.calendar.color}
          onPick={(color) => {
            void recolorCalendar(surface.calendar, color);
            setSurface(null);
          }}
          onDismiss={() => setSurface(null)}
        />
      )}
      {surface?.kind === 'picker' && (
        <FieldPicker
          anchor={surface.anchor}
          calendarId={surface.calendar.id}
          calendarTitle={surface.calendar.title}
          onClose={() => setSurface(null)}
        />
      )}
      {surface?.kind === 'menu' && (
        <ContextMenu
          ariaLabel={`${surface.calendar.title} actions`}
          x={surface.x}
          y={surface.y}
          onClose={() => setSurface(null)}
          items={[
            { label: 'Rename', onSelect: () => setRenaming(surface.calendar.id) },
            {
              label: 'Color',
              onSelect: () =>
                setSurface({
                  kind: 'palette',
                  calendar: surface.calendar,
                  anchor: surface.anchor,
                }),
            },
            {
              label: 'Add a date field',
              onSelect: () =>
                setSurface({
                  kind: 'picker',
                  calendar: surface.calendar,
                  anchor: surface.anchor,
                }),
            },
            { label: 'Delete calendar', onSelect: () => setDeleting(surface.calendar) },
          ]}
        />
      )}
      {surface?.kind === 'fieldMenu' && (
        <ContextMenu
          ariaLabel={`${surface.field.fieldName} · ${surface.field.tableName} actions`}
          x={surface.x}
          y={surface.y}
          onClose={() => setSurface(null)}
          items={[
            { label: 'Open table', onSelect: () => onOpenTable?.(surface.field.tableId) },
            {
              label: `Remove from ${surface.calendar.title}`,
              onSelect: () => void removeBoundField(surface.calendar, surface.field),
            },
          ]}
        />
      )}
      {surface?.kind === 'automationMenu' && liveAutomation && !staleAutomationSurface && (
        <ContextMenu
          ariaLabel={`${liveAutomation.name} actions`}
          x={surface.x}
          y={surface.y}
          onClose={() => setSurface(null)}
          items={[
            ...(onOpenAutomation
              ? [{ label: 'Open', onSelect: () => onOpenAutomation(liveAutomation) }]
              : []),
            {
              label: 'Move to calendar…',
              onSelect: () =>
                setSurface({
                  kind: 'automationMove',
                  automation: liveAutomation,
                  row: surface.row,
                }),
            },
          ]}
        />
      )}
      {surface?.kind === 'automationMove' && liveAutomation && !staleAutomationSurface && (
        <MoveToCalendarMenu
          anchor={surface.row}
          resolveAnchor={() => automationRowButton(rootRef.current, liveAutomation.id)}
          automation={liveAutomation}
          catalog={{
            calendars: calendars.active,
            ready: calendars.calendars !== null && !calendars.loading && !calendars.error,
            failed: Boolean(calendars.error),
          }}
          onClose={() => setSurface(null)}
          onMoved={setMovedFocus}
        />
      )}
    </section>
  );
}
