/**
 * Event popover: title (inline, debounced ~400 ms + blur/Enter),
 * time line (click → date/time inputs + all-day Switch; saves on change),
 * calendar picker (saves on change), description (debounced), Delete (no
 * confirm; undo toast). Esc closes, flushing a pending text save. One undo
 * step per field edit: a typing burst is one step.
 *
 * Table field (None for an event): picking one of the calendar's bound date
 * fields turns the event into a row of that table (`onConvert`, after the
 * pending text saves land); the pane then shows the row's popover instead.
 *
 * A timed event has a Notify section (reminders, autosaved on their own).
 *
 * A repeating event opened from one of its occurrences shows that
 * occurrence's day and time (`occurrence`), not the series' first; editing
 * the time edits the series' start, so the editor says so.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  Calendar,
  CalendarEvent,
  CalendarEventTime,
  CalendarOccurrenceTime,
} from '@snaglet/shared/types';
import { CALENDAR_EVENT_TITLE_MAX_LENGTH } from '@snaglet/shared/types';
import { DateInput, Switch, TextInput } from '@desktop/components';
import { TrashIcon } from '@desktop/components/Icons';
import { ReminderSettingsControl } from '@desktop/features/reminders/ReminderSettingsControl';
import { AnchoredSurface } from './AnchoredSurface';
import { addDays, diffDays, instantToZoned, zonedToInstant } from './calendarDates';
import { calendarApi } from './calendarApi';
import { calendarColor } from './calendarStore';
import { calendarColorProps } from './calendarColors';
import { CalendarFieldPickers } from './CalendarFieldPickers';
import { EventDescriptionField } from './EventDescriptionField';
import { EventRepeatControl } from './EventRepeatControl';
import {
  deleteEvent,
  eventSpan,
  isConflict,
  reportWriteError,
  updateEvent,
  withEndTime,
} from './eventActions';
import { describeSpan, sameTime } from './occurrenceMoves';
import type { RowTarget } from './rowCreate';
import { useDebouncedField } from './useDebouncedField';
import styles from './CalendarPopovers.module.scss';

interface EventPopoverProps {
  anchor: HTMLElement;
  eventId: string;
  calendars: readonly Calendar[];
  viewerZone: string;
  focusTitle?: boolean;
  /** The clicked occurrence's time: a repeating event shows it, not the series start. */
  occurrence?: CalendarOccurrenceTime;
  onClose: () => void;
  /** After any write: the event as saved (null = deleted). */
  onChanged: (event: CalendarEvent | null) => void;
  /**
   * Turn the event (as last saved) into a row of `target`'s table. Resolves
   * true once converted (the pane swaps this popover for the row's).
   */
  onConvert?: (event: CalendarEvent, target: RowTarget) => Promise<boolean>;
}

/** The repeat's anchor: the start date, or the start as a wall time in the event's zone. */
function repeatAnchor(time: CalendarEventTime): string {
  if (time.kind === 'all_day') return time.startDate;
  const { date, minutes } = instantToZoned(time.startAt, time.timeZone);
  return `${date}T${minutesToTime(minutes)}:00`;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}
function minutesToTime(m: number) {
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function EventPopover({
  anchor,
  eventId,
  calendars,
  viewerZone,
  focusTitle,
  occurrence,
  onClose,
  onChanged,
  onConvert,
}: EventPopoverProps) {
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  // Until the time is edited (that moves the series), the clicked occurrence.
  const [shownOccurrence, setShownOccurrence] = useState(occurrence);
  const [error, setError] = useState<string | null>(null);
  const [editingTime, setEditingTime] = useState(false);
  const [converting, setConverting] = useState(false);
  /** Saves still in flight; a conversion waits for them. */
  const inflight = useRef<Promise<void>>(Promise.resolve());
  const eventRef = useRef<CalendarEvent | null>(null);
  eventRef.current = event;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  /** Show the event as saved now (a load, or after a conflict). */
  const adopt = (loaded: CalendarEvent) => {
    setEvent(loaded);
    eventRef.current = loaded;
    title.reset(loaded.title);
    description.reset(loaded.description);
  };

  useEffect(() => {
    let canceled = false;
    calendarApi
      .getEvent(eventId)
      .then(({ event: loaded }) => {
        if (!canceled) adopt(loaded);
      })
      .catch(() => {
        if (!canceled) setError("Couldn't load the event");
      });
    return () => {
      canceled = true;
    };
    // Load once per event; title/description resets are stable callbacks.
  }, [eventId]);

  /** Snapshot used as "before" for text bursts (one undo step per edit). */
  const baseline = useRef<CalendarEvent | null>(null);
  useEffect(() => {
    if (event && !baseline.current) baseline.current = event;
  }, [event]);

  const save = async (
    patch: Parameters<typeof updateEvent>[1],
    label: string,
    before?: CalendarEvent
  ) => {
    const current = eventRef.current;
    if (!current) return;
    const write = (async () => {
      try {
        const saved = await updateEvent(before ?? current, patch, current.revision, label);
        setEvent(saved);
        eventRef.current = saved;
        onChangedRef.current(saved);
      } catch (err) {
        reportWriteError(err, "Couldn't save the event");
        if (!isConflict(err)) {
          onChangedRef.current(current);
          return;
        }
        // Changed elsewhere: read it again, so the next edit carries the
        // new revision instead of failing the same way.
        try {
          const { event: fresh } = await calendarApi.getEvent(current.id);
          adopt(fresh);
          onChangedRef.current(fresh);
        } catch {
          onChangedRef.current(current);
        }
      }
    })();
    inflight.current = inflight.current.then(() => write);
    await write;
  };

  const title = useDebouncedField('', (next, before) => {
    const current = eventRef.current;
    if (!current) return;
    void save({ title: next.trim() || 'Untitled' }, 'Rename event', { ...current, title: before });
  });
  const description = useDebouncedField('', (next, before) => {
    const current = eventRef.current;
    if (!current) return;
    void save({ description: next }, 'Edit description', { ...current, description: before });
  });

  const calendar = calendars.find((c) => c.id === event?.calendarId);

  const setTime = (time: CalendarEventTime) => {
    setShownOccurrence(undefined);
    void save({ time }, 'Change time');
  };

  const toggleAllDay = (allDay: boolean) => {
    if (!event) return;
    const t = event.time;
    if (allDay && t.kind === 'timed') {
      const s = instantToZoned(t.startAt, viewerZone).date;
      const e = instantToZoned(t.endAt, viewerZone);
      const lastDay = e.minutes === 0 && e.date > s ? addDays(e.date, -1) : e.date;
      setTime({
        kind: 'all_day',
        startDate: s,
        endDate: addDays(lastDay, 1),
        timeZone: t.timeZone,
      });
    } else if (!allDay && t.kind === 'all_day') {
      setTime({
        kind: 'timed',
        startAt: zonedToInstant(t.startDate, 9 * 60, viewerZone),
        endAt: zonedToInstant(t.startDate, 9 * 60 + 30, viewerZone),
        timeZone: viewerZone,
      });
    }
  };

  const close = () => {
    title.flush();
    description.flush();
    onClose();
  };

  const convert = async (target: RowTarget | null) => {
    if (!target || !onConvert || converting) return;
    setConverting(true);
    title.flush();
    description.flush();
    await inflight.current;
    const current = eventRef.current;
    const converted = current ? await onConvert(current, target) : false;
    if (!converted) setConverting(false);
  };

  const remove = async () => {
    if (!event) return;
    try {
      await deleteEvent(event);
      onChangedRef.current(null);
      onClose();
    } catch (err) {
      reportWriteError(err, "Couldn't delete the event");
    }
  };

  return (
    <AnchoredSurface anchor={anchor} label="Event" width={320} onDismiss={close}>
      {error && <p className={styles.muted}>{error}</p>}
      {!event && !error && <p className={styles.muted}>Loading…</p>}
      {event && (
        <div
          className={styles.grow}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <div className={styles.row}>
            <span
              className={styles.swatch}
              {...calendarColorProps(calendar ? calendarColor(calendar) : undefined)}
              aria-hidden
            />
            <TextInput
              size="sm"
              className={styles.titleInput}
              aria-label="Event title"
              autoFocus={focusTitle}
              maxLength={CALENDAR_EVENT_TITLE_MAX_LENGTH}
              value={title.value}
              onChange={(e) => title.setValue(e.target.value)}
              onBlur={title.flush}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  title.flush();
                }
              }}
            />
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Delete event"
              title="Delete event"
              onClick={() => void remove()}
            >
              <TrashIcon />
            </button>
          </div>

          {(() => {
            const series = eventSpan(event.time);
            // One occurrence of a series, not its first: show that one.
            const shown =
              event.repeat && shownOccurrence && !sameTime(shownOccurrence, series)
                ? shownOccurrence
                : null;
            if (!editingTime)
              return (
                <button
                  type="button"
                  className={styles.timeLine}
                  onClick={() => setEditingTime(true)}
                  aria-label={`Time: ${describeSpan(shown ?? series, viewerZone)}. Edit`}
                >
                  {describeSpan(shown ?? series, viewerZone)}
                </button>
              );
            return (
              <>
                {event.repeat && <p className={styles.muted}>Series start</p>}
                <TimeEditor time={event.time} viewerZone={viewerZone} onChange={setTime} />
              </>
            );
          })()}
          <div className={styles.row}>
            <Switch
              size="sm"
              checked={event.time.kind === 'all_day'}
              onChange={toggleAllDay}
              onLabel="All day"
              offLabel="All day"
              aria-label="All day"
            />
          </div>

          <EventRepeatControl
            anchor={repeatAnchor(event.time)}
            timeZone={event.time.timeZone}
            value={event.repeat}
            onChange={(repeat) => void save({ repeat }, 'Change repeat')}
          />

          <div className={styles.pickers}>
            <CalendarFieldPickers
              calendars={calendars}
              calendarId={event.calendarId}
              onCalendarChange={(calendarId) => void save({ calendarId }, 'Change calendar')}
              target={null}
              onTargetChange={(target) => void convert(target)}
              fieldDisabled={!onConvert || converting}
            />
          </div>

          <EventDescriptionField value={description.value} onChange={description.setValue} />

          {/* Reminders need a start time: a timed event, not an all-day one. */}
          {event.time.kind === 'timed' && (
            <ReminderSettingsControl item={{ kind: 'event', eventId: event.id }} />
          )}
        </div>
      )}
    </AnchoredSurface>
  );
}

function TimeEditor({
  time,
  viewerZone,
  onChange,
}: {
  time: CalendarEventTime;
  viewerZone: string;
  onChange: (time: CalendarEventTime) => void;
}) {
  if (time.kind === 'all_day') {
    const last = addDays(time.endDate, -1);
    return (
      <div className={styles.timeEditor}>
        <DateInput
          size="sm"
          required
          aria-label="Start date"
          value={time.startDate}
          range={{ part: 'start', other: last < time.startDate ? time.startDate : last }}
          onChange={(v) => {
            if (!v) return;
            const span = Math.max(0, diffDays(last, time.startDate));
            onChange({ ...time, startDate: v, endDate: addDays(v, span + 1) });
          }}
        />
        <DateInput
          size="sm"
          required
          aria-label="End date"
          value={last < time.startDate ? time.startDate : last}
          range={{ part: 'end', other: time.startDate }}
          onChange={(v) => {
            if (!v || v < time.startDate) return;
            onChange({ ...time, endDate: addDays(v, 1) });
          }}
        />
      </div>
    );
  }
  const s = instantToZoned(time.startAt, viewerZone);
  const e = instantToZoned(time.endAt, viewerZone);
  const duration = Math.max(
    15,
    Math.round((Date.parse(time.endAt) - Date.parse(time.startAt)) / 60_000)
  );
  return (
    <div className={styles.timeEditor}>
      <DateInput
        size="sm"
        required
        aria-label="Date"
        value={s.date}
        onChange={(v) => {
          if (!v) return;
          const startAt = zonedToInstant(v, s.minutes, viewerZone);
          onChange({
            ...time,
            startAt,
            endAt: new Date(Date.parse(startAt) + duration * 60_000).toISOString(),
          });
        }}
      />
      <span />
      <DateInput
        size="sm"
        type="time"
        required
        aria-label="Start time"
        value={minutesToTime(s.minutes)}
        onChange={(v) => {
          const m = timeToMinutes(v);
          if (m === null) return;
          const startAt = zonedToInstant(s.date, m, viewerZone);
          onChange({
            ...time,
            startAt,
            endAt: new Date(Date.parse(startAt) + duration * 60_000).toISOString(),
          });
        }}
      />
      <DateInput
        size="sm"
        type="time"
        required
        aria-label="End time"
        value={minutesToTime(e.minutes)}
        onChange={(v) => {
          const m = timeToMinutes(v);
          if (m === null) return;
          onChange(withEndTime(time, m, viewerZone));
        }}
      />
    </div>
  );
}
