/**
 * The Calendar sidebar's automations. Each calendar lists its active and
 * paused automations after its date fields (swirl, name, "paused"); those on
 * no calendar (made with none, or left with none when their calendar was
 * deleted) sit in a "No calendar" group at the bottom. A row opens the
 * automation; its ⋯ (or a right-click, or the keyboard's menu key) has Move
 * to calendar…, which saves at once through the automation's update and
 * offers Undo on the calendar's stack. Finished and deleted automations stay
 * in the Automations view.
 */
import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  DEFAULT_CALENDAR_TITLE,
  type AutomationRecord,
  type AutomationStatus,
  type Calendar,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { SwirlIcon } from '@desktop/components/Icons';
import { cn } from '@desktop/utils/classNames';
import { showToast } from '@desktop/utils/toast';
import {
  moveAutomationToCalendar,
  type OfferUndo,
} from '@desktop/features/automations/automationActions';
import { loadAutomations, upsertAutomation } from '@desktop/features/automations/automationsStore';
import { AnchoredSurface } from '@desktop/features/calendar/AnchoredSurface';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import { calendarColor } from '@desktop/features/calendar/calendarStore';
import { offerUndo } from '@desktop/features/calendar/calendarUndo';
import styles from './CalendarSidebar.module.scss';

const LISTED: ReadonlySet<AutomationStatus> = new Set(['active', 'paused']);

/** Whether the sidebar lists `a` (active or paused). */
export function sidebarListsAutomation(a: AutomationRecord): boolean {
  return LISTED.has(a.status);
}

interface SidebarAutomationGroups {
  /** Calendar id → its automations, by name. */
  byCalendar: ReadonlyMap<string, AutomationRecord[]>;
  /** On no calendar, by name. */
  unplaced: AutomationRecord[];
}

const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Active and paused automations under their calendars, or in No calendar; by name ("Task 2" before "Task 10"). */
export function groupSidebarAutomations(
  automations: readonly AutomationRecord[] | null,
  calendars: readonly Calendar[]
): SidebarAutomationGroups {
  const known = new Set(calendars.map((c) => c.id));
  const byCalendar = new Map<string, AutomationRecord[]>();
  const unplaced: AutomationRecord[] = [];
  const listed = (automations ?? [])
    .filter(sidebarListsAutomation)
    .sort((a, b) => byName.compare(a.name, b.name));
  for (const a of listed) {
    if (a.calendarId === null) unplaced.push(a);
    // A calendar the list hasn't loaded yet: the row shows once it has.
    else if (known.has(a.calendarId)) {
      const list = byCalendar.get(a.calendarId);
      if (list) list.push(a);
      else byCalendar.set(a.calendarId, [a]);
    }
  }
  return { byCalendar, unplaced };
}

/** The calendar list as Move to calendar… needs it. */
interface MoveCatalog {
  calendars: readonly Calendar[];
  /** The list is in and its last read didn't fail (not loading, not errored). */
  ready: boolean;
  /** Its last read failed. */
  failed: boolean;
}

/** A Move to calendar… choice. `newDefault`: no calendar exists, so the move makes the Default one. */
type MoveTarget =
  | { kind: 'calendar'; calendar: Calendar }
  | { kind: 'none' }
  | { kind: 'newDefault' };

/**
 * Where an automation can move: every other calendar, then No calendar when
 * it is on one. With no calendar at all, and only once the list is ready,
 * the Default calendar (new), as New automation offers.
 */
function moveTargets(a: AutomationRecord, catalog: MoveCatalog): MoveTarget[] {
  const others: MoveTarget[] = catalog.calendars
    .filter((c) => c.id !== a.calendarId)
    .map((calendar) => ({ kind: 'calendar', calendar }));
  if (a.calendarId !== null) return [...others, { kind: 'none' }];
  if (others.length > 0) return others;
  return catalog.ready && catalog.calendars.length === 0 ? [{ kind: 'newDefault' }] : [];
}

function targetLabel(target: MoveTarget): string {
  if (target.kind === 'calendar') return target.calendar.title;
  return target.kind === 'none' ? 'No calendar' : `${DEFAULT_CALENDAR_TITLE} (new)`;
}

function targetKey(target: MoveTarget): string {
  return target.kind === 'calendar' ? target.calendar.id : target.kind;
}

/** Undo on the calendar's stack (toast and ⌘Z in the pane), then a fresh list. */
const sidebarUndo: OfferUndo = (message, undo) =>
  offerUndo(message, {
    label: message,
    undo: async () => {
      await undo();
      await loadAutomations();
    },
  });

/** Move `a`; the saved record shows at once (the realtime re-read confirms it). Null when refused. */
async function moveSidebarAutomation(
  a: AutomationRecord,
  target: MoveTarget
): Promise<AutomationRecord | null> {
  const pick =
    target.kind === 'calendar' ? target.calendar.id : target.kind === 'none' ? null : undefined;
  try {
    const moved = await moveAutomationToCalendar(a, pick, sidebarUndo);
    upsertAutomation(moved);
    return moved;
  } catch (err) {
    showToast(getErrorMessage(err, pick === null ? "Couldn't remove it" : "Couldn't move it"));
    return null;
  }
}

/** Where a context menu opens: the pointer, or under the row for the keyboard's menu key. */
export function menuPoint(event: MouseEvent<HTMLElement>): { x: number; y: number } {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
  const r = event.currentTarget.getBoundingClientRect();
  return { x: r.left, y: r.bottom };
}

/** The main button of automation `id`'s row in `root`, if it is drawn. */
export function automationRowButton(root: ParentNode | null, id: string): HTMLElement | null {
  const rows = root?.querySelectorAll<HTMLElement>('[data-automation-row]') ?? [];
  return Array.from(rows).find((row) => row.dataset.inspectId === id) ?? null;
}

interface SidebarAutomationRowProps {
  automation: AutomationRecord;
  /** Its ⋯ menu (or Move to calendar…) is open. */
  menuOpen: boolean;
  onOpen?: (automation: AutomationRecord) => void;
  /** Open the row's menu at (x, y); `row` is the row's main button (the picker anchors there). */
  onMenu: (automation: AutomationRecord, x: number, y: number, row: HTMLElement) => void;
}

export function SidebarAutomationRow({
  automation: a,
  menuOpen,
  onOpen,
  onMenu,
}: SidebarAutomationRowProps) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const paused = a.status === 'paused';
  return (
    <li className={cn(styles.fieldRow, styles.automationRow)}>
      <button
        ref={rowRef}
        type="button"
        className={cn(styles.fieldButton, paused && styles.itemPaused)}
        onClick={() => onOpen?.(a)}
        onContextMenu={(e) => {
          e.preventDefault();
          const { x, y } = menuPoint(e);
          onMenu(a, x, y, e.currentTarget);
        }}
        data-automation-row=""
        data-inspect-id={a.id}
        data-inspect-name={a.name}
        aria-label={`${a.name}, automation${paused ? ', paused' : ''}`}
        title={`${a.whenText} · wakes ${a.agentName ?? 'an agent'}`}
      >
        <span aria-hidden className={styles.automationGlyph}>
          <SwirlIcon size={11} />
        </span>
        <span className={styles.itemLabel}>
          <span className={styles.itemName}>{a.name}</span>
        </span>
        <span className={styles.itemNote}>{paused ? 'paused' : ''}</span>
      </button>
      <span className={styles.rowControls}>
        <button
          type="button"
          className={cn(styles.iconBtn, styles.rowAction)}
          aria-label={`More for ${a.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            if (rowRef.current) onMenu(a, r.left, r.bottom, rowRef.current);
          }}
        >
          ⋯
        </button>
      </span>
    </li>
  );
}

interface MoveToCalendarMenuProps {
  anchor: HTMLElement;
  automation: AutomationRecord;
  catalog: MoveCatalog;
  /** Finds the row again if a redraw replaced it. */
  resolveAnchor: () => HTMLElement | null;
  onClose: () => void;
  /** After a move landed, with the saved record. */
  onMoved: (automation: AutomationRecord) => void;
}

/**
 * Move to calendar…: the choices from {@link moveTargets} as a menu with one
 * Tab stop (↑ / ↓ / Home / End move between them); a pick saves at once.
 */
export function MoveToCalendarMenu({
  anchor,
  automation,
  catalog,
  resolveAnchor,
  onClose,
  onMoved,
}: MoveToCalendarMenuProps) {
  const targets = moveTargets(automation, catalog);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const focusAt = (index: number) => {
    setActive(index);
    listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[index]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || targets.length === 0) return;
    e.preventDefault();
    const last = targets.length - 1;
    const at = Math.min(active, last);
    focusAt(
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? last
          : e.key === 'ArrowDown'
            ? (at + 1) % targets.length
            : (at - 1 + targets.length) % targets.length
    );
  };
  return (
    <AnchoredSurface
      anchor={anchor}
      resolveAnchor={resolveAnchor}
      label={`Move ${automation.name} to`}
      width={240}
      onDismiss={onClose}
    >
      <p className={styles.moveTitle}>
        Move <strong>{automation.name}</strong> to
      </p>
      {targets.length === 0 ? (
        <p className={styles.moveStatus} data-autofocus="" tabIndex={-1}>
          {catalog.failed ? "Couldn't load the calendars" : 'Loading calendars…'}
        </p>
      ) : (
        <div
          ref={listRef}
          role="menu"
          aria-label="Calendars"
          className={styles.moveList}
          onKeyDown={onKeyDown}
        >
          {targets.map((target, index) => (
            <button
              key={targetKey(target)}
              type="button"
              role="menuitem"
              tabIndex={index === Math.min(active, targets.length - 1) ? 0 : -1}
              className={styles.moveOption}
              data-autofocus={index === 0 ? '' : undefined}
              onFocus={() => setActive(index)}
              onClick={() => {
                onClose();
                void moveSidebarAutomation(automation, target).then((moved) => {
                  if (moved) onMoved(moved);
                });
              }}
            >
              {target.kind === 'none' ? (
                <span className={cn(styles.moveSwatch, styles.moveSwatchNone)} aria-hidden />
              ) : (
                <span
                  className={styles.moveSwatch}
                  {...calendarColorProps(
                    target.kind === 'calendar' ? calendarColor(target.calendar) : 'gray'
                  )}
                  aria-hidden
                />
              )}
              <span className={cn(styles.moveLabel, target.kind === 'none' && styles.moveMuted)}>
                {targetLabel(target)}
              </span>
            </button>
          ))}
        </div>
      )}
    </AnchoredSurface>
  );
}
