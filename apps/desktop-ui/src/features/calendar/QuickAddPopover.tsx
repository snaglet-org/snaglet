/**
 * Quick add: anchored to the ghost of a drag-to-create sweep (time grid
 * or all-day band), of a slot opened with Enter, or of the clicked Month day
 * (a click on empty Week / Day grid opens nothing). Title input
 * focused; Enter saves, Escape cancels and removes the ghost. Clicking
 * outside saves when the title is non-empty, cancels when empty. Calendar
 * picker defaults to the last used visible calendar, else the Default
 * calendar; the ghost wears the picked calendar's color.
 *
 * Table field (default None): one of the calendar's bound date fields, to
 * add a row of that table instead of an event (the title is its Name, the
 * slot its date). Changing the calendar drops a field it doesn't show.
 */
import { useRef, useState } from 'react';
import {
  CALENDAR_EVENT_TITLE_MAX_LENGTH,
  type Calendar,
  type CalendarEventRepeat,
  type CalendarOccurrenceTime,
} from '@snaglet/shared/types';
import { Button, TextInput } from '@desktop/components';
import { AnchoredSurface } from './AnchoredSurface';
import {
  formatMinutes,
  formatTimedRange,
  longDayLabel,
  addDays,
  shortDayLabel,
  zonedToInstant,
} from './calendarDates';
import { CalendarFieldPickers, keepTargetOn } from './CalendarFieldPickers';
import { EventDescriptionField } from './EventDescriptionField';
import { EventRepeatControl } from './EventRepeatControl';
import type { RowTarget } from './rowCreate';
import styles from './CalendarPopovers.module.scss';

const LAST_CALENDAR_KEY = 'snaglet.calendar.lastUsed';

/**
 * Timed: `start` minutes on `day` to `end` minutes (≤ 1440) on `endDay`, which
 * is only set when a sweep ran into another day's column.
 */
export type QuickAddSlot =
  | { kind: 'timed'; day: string; start: number; end: number; endDay?: string }
  | { kind: 'all_day'; startDate: string; endDate: string };

function slotLabel(slot: QuickAddSlot): string {
  if (slot.kind === 'timed') {
    if (slot.endDay && slot.endDay !== slot.day) {
      return `${shortDayLabel(slot.day)}, ${formatMinutes(slot.start)} – ${shortDayLabel(slot.endDay)}, ${formatMinutes(slot.end)}`;
    }
    return formatTimedRange(slot.day, slot.start, slot.end);
  }
  const last = addDays(slot.endDate, -1);
  if (last <= slot.startDate) return `${longDayLabel(slot.startDate)} · All day`;
  return `${shortDayLabel(slot.startDate)} – ${shortDayLabel(last)} · All day`;
}

/** The slot's start as a repeat anchor: its date, or its wall time. */
function slotAnchor(slot: QuickAddSlot): string {
  if (slot.kind === 'all_day') return slot.startDate;
  const h = String(Math.floor(slot.start / 60)).padStart(2, '0');
  const m = String(slot.start % 60).padStart(2, '0');
  return `${slot.day}T${h}:${m}:00`;
}

/** The slot as an occurrence time: wall-clock minutes in `zone` become instants. */
export function slotTime(slot: QuickAddSlot, zone: string): CalendarOccurrenceTime {
  if (slot.kind === 'all_day') {
    return { kind: 'all_day', startDate: slot.startDate, endDate: slot.endDate };
  }
  return {
    kind: 'timed',
    start: zonedToInstant(slot.day, slot.start, zone),
    // A sweep into another day's column ends on that day.
    end: zonedToInstant(slot.endDay ?? slot.day, slot.end, zone),
  };
}

export function defaultCalendarId(visible: readonly Calendar[]): string | null {
  let last: string | null = null;
  try {
    last = window.localStorage.getItem(LAST_CALENDAR_KEY);
  } catch {
    // ignore
  }
  if (last && visible.some((c) => c.id === last)) return last;
  return visible.find((c) => c.isDefault)?.id ?? visible[0]?.id ?? null;
}

export interface QuickAddInput {
  title: string;
  calendarId: string | null;
  slot: QuickAddSlot;
  /** A bound date field: add a row of its table, not an event. */
  target: RowTarget | null;
  /** A plain event's description ('' = none). Always '' with a target. */
  description: string;
  /** How a plain event repeats; null = once. Never set with a target. */
  repeat: CalendarEventRepeat | null;
}

interface QuickAddPopoverProps {
  anchor: HTMLElement;
  slot: QuickAddSlot;
  calendars: readonly Calendar[];
  onSave: (input: QuickAddInput) => void;
  onCancel: () => void;
  /** The picked calendar changed (the ghost follows its color). */
  onCalendarChange?: (calendarId: string | null) => void;
}

export function QuickAddPopover({
  anchor,
  slot,
  calendars,
  onSave,
  onCancel,
  onCalendarChange,
}: QuickAddPopoverProps) {
  const [title, setTitle] = useState('');
  const [calendarId, setCalendarId] = useState<string | null>(() => defaultCalendarId(calendars));
  const [target, setTarget] = useState<RowTarget | null>(null);
  const [description, setDescription] = useState('');
  const [repeat, setRepeat] = useState<CalendarEventRepeat | null>(null);
  const done = useRef(false);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const trimmed = title.trim();
    if (save && trimmed) {
      if (calendarId) {
        try {
          window.localStorage.setItem(LAST_CALENDAR_KEY, calendarId);
        } catch {
          // ignore
        }
      }
      onSave({
        title: trimmed,
        calendarId,
        slot,
        target,
        description: target ? '' : description.trim(),
        repeat: target ? null : repeat,
      });
    } else {
      onCancel();
    }
  };

  return (
    <AnchoredSurface
      anchor={anchor}
      label={target ? 'New row' : 'New event'}
      width={300}
      // Outside press: save when there's a title, else cancel.
      onDismiss={() => finish(true)}
      keepOpenSelector="[data-calendar-ghost]"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
        onKeyDown={(e) => {
          // An open @ search takes its own Escape (it prevents default).
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
        className={`${styles.grow} ${styles.stack}`}
      >
        <TextInput
          autoFocus
          data-autofocus=""
          size="sm"
          className={styles.titleInput}
          aria-label={target ? 'Row title' : 'Event title'}
          placeholder="Add title"
          maxLength={CALENDAR_EVENT_TITLE_MAX_LENGTH}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <p className={styles.when}>{slotLabel(slot)}</p>
        {!target && (
          <EventDescriptionField
            value={description}
            onChange={setDescription}
            onSubmit={() => finish(true)}
          />
        )}
        <div className={styles.details}>
          <div className={styles.pickers}>
            <CalendarFieldPickers
              calendars={calendars}
              calendarId={calendarId}
              onCalendarChange={(next) => {
                setCalendarId(next || null);
                setTarget((t) =>
                  keepTargetOn(
                    calendars.find((c) => c.id === next),
                    t
                  )
                );
                onCalendarChange?.(next || null);
              }}
              target={target}
              onTargetChange={setTarget}
            />
          </div>
          {!target && (
            <EventRepeatControl
              anchor={slotAnchor(slot)}
              timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
              value={repeat}
              onChange={setRepeat}
            />
          )}
        </div>
        {target && slot.kind === 'all_day' && target.fieldType === 'datetime' && (
          <p className={styles.muted} style={{ marginTop: 'var(--space-2)' }}>
            {target.fieldName} has a time: the row starts at 12:00 AM on its first day.
          </p>
        )}
        <div className={styles.footer}>
          <span />
          <Button type="submit" size="sm" variant="primary" disabled={!title.trim()}>
            Save
          </Button>
        </div>
      </form>
    </AnchoredSurface>
  );
}
