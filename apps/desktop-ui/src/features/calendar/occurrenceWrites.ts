/**
 * Commit a move / resize of an occurrence:
 * - event → `PATCH /events/:id` (eventActions.moveEvent);
 * - plain row → the normal entry update of the bound field, with
 *   `entryRevision` / `schemaVersion`; on a range field (End date on) it
 *   writes the whole shifted range in that one update;
 * - repeating row → the repeat's move-one / shift-all (`moveRepeatOccurrence`, the
 *   one seam for those routes), which keep the range's length;
 * - resize (range rows only) → one plain entry update with the new end, a
 *   repeating row too: its new length applies to every later occurrence.
 *
 * Row writes land in the user's table history; the calendar stack records a
 * step that undoes / redoes exactly that history step through `tableHistory`
 * (the server refuses a stale one instead of reverting something else).
 *
 * Repeats (docs/architecture.md): "done" marks the row's current occurrence done
 * and advances the row; "skip" skips it. `setOrClearRepeat` is the calendar's
 * "Repeat…". Each is one table history step.
 */
import type {
  CalendarOccurrence,
  CalendarOccurrenceTime,
  CalendarRowOccurrence,
  TableEntryResponse,
  TableEntryValues,
  TableHistoryStep,
} from '@snaglet/shared/types';
import { type TableRepeatInput } from '@snaglet/shared/utils';
import { tableRepeatsApi, type RepeatActionResult } from '@desktop/utils/api/tableRepeats';
import { tablesApi } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';
import { newestTableStep, stepTableHistory } from '@desktop/features/database/tableHistory';
import { addDays } from './calendarDates';
import { markOwnWrite } from './calendarRealtime';
import { offerUndo } from './calendarUndo';
import { moveEvent, toEventTime } from './eventActions';

export type RepeatMoveMode = 'one' | 'all';

/** The row's start cell value: a UTC instant (datetime) or `YYYY-MM-DD` (date). */
function startValue(time: CalendarOccurrenceTime): string {
  return time.kind === 'timed' ? time.start : time.startDate;
}

export type WriteKind = 'move' | 'resize';

/**
 * The bound field's new value for `after`, in its wire form. A plain field
 * gets the start. A date range gets `start/last day` (the end day is
 * included on the wire; the server writes a single day without the slash).
 * A datetime range gets `start/end`, except that a move keeps a range that
 * holds only a start single (a resize gives it an end). A move keeps the
 * range's exact length (the drag keeps at least 15 minutes for drawing).
 */
export function cellValue(
  o: CalendarRowOccurrence,
  after: CalendarOccurrenceTime,
  kind: WriteKind = 'move'
): string {
  if (!o.range) return startValue(after);
  if (after.kind === 'all_day') {
    const last = addDays(after.endDate, -1);
    return last > after.startDate ? `${after.startDate}/${last}` : after.startDate;
  }
  if (kind === 'resize') return `${after.start}/${after.end}`;
  if (!o.hasEnd) return after.start;
  const length = o.time.kind === 'timed' ? Date.parse(o.time.end) - Date.parse(o.time.start) : 0;
  const end = length > 0 ? new Date(Date.parse(after.start) + length).toISOString() : after.end;
  return `${after.start}/${end}`;
}

function offerRowUndo(o: CalendarRowOccurrence, step: TableHistoryStep | null, message: string) {
  // Without the exact step, an undo could reverse some other change of the
  // user's: say where to undo it instead of guessing.
  if (!step) {
    showToast(`${message}. To undo it, use the table's history.`);
    return;
  }
  const mark = () => markOwnWrite(`entry:${o.tableId}:${o.entryId}`);
  offerUndo(message, {
    label: step.label,
    undo: async () => {
      mark();
      await stepTableHistory('undo', { expected: step, tableId: o.tableId });
    },
    redo: async () => {
      mark();
      await stepTableHistory('redo', {
        expected: { ...step, state: 'undone' },
        tableId: o.tableId,
      });
    },
  });
}

/** A plain (non-repeating) row's move, or any row's resize: one entry update. */
async function writeRow(
  o: CalendarRowOccurrence,
  after: CalendarOccurrenceTime,
  kind: WriteKind,
  message: string
): Promise<void> {
  const values: TableEntryValues = { [o.fieldId]: cellValue(o, after, kind) };
  markOwnWrite(`entry:${o.tableId}:${o.entryId}`);
  await tablesApi.updateEntry(o.tableId, o.entryId, {
    values,
    schemaVersion: o.schemaVersion,
    expectedRevision: o.entryRevision,
  });
  offerRowUndo(o, await newestTableStep(o.tableId), message);
}

/**
 * The repeat occurrence routes (mounted in apps/server/src/routes/tables.ts),
 * via `tableRepeatsApi` (utils/api/tableRepeats.ts):
 *   POST /api/tables/:id/entries/:entryId/repeats/:fieldId/move|shift
 *   { occurrence?, to, expectedRevision, schemaVersion }
 * `occurrence` is the planned wall time (omitted = the repeat's current one);
 * `to` is the new start: a UTC instant for datetime fields (the server reads
 * it in the repeat's zone) or `YYYY-MM-DD` for date fields. Each call is one
 * step in the user's table history.
 */
async function moveRepeatOccurrence(
  o: CalendarRowOccurrence,
  mode: RepeatMoveMode,
  after: CalendarOccurrenceTime
): Promise<TableEntryResponse> {
  markOwnWrite(`entry:${o.tableId}:${o.entryId}`);
  const input = {
    ...(o.repeat ? { occurrence: o.repeat.occurrence } : {}),
    to: startValue(after),
    expectedRevision: o.entryRevision,
    schemaVersion: o.schemaVersion,
  };
  return mode === 'one'
    ? tableRepeatsApi.move(o.tableId, o.entryId, o.fieldId, input)
    : tableRepeatsApi.shift(o.tableId, o.entryId, o.fieldId, input);
}

/**
 * A history state that can't be done / skipped again: only `done` and
 * `skipped`. A moved current occurrence is still open (the server's
 * `isFinished` checks the same two), so it can be completed or skipped.
 */
export function isSettled(o: CalendarOccurrence): boolean {
  return o.status === 'done' || o.status === 'skipped';
}

/** Toast text worked out from the write's result. */
export type RepeatMessage = string | ((result: RepeatActionResult) => string);

/** One repeat write: mark our echo, write, then offer Undo of exactly its history step. */
async function repeatWrite(
  o: CalendarRowOccurrence,
  write: () => Promise<RepeatActionResult>,
  message: RepeatMessage
): Promise<string> {
  markOwnWrite(`entry:${o.tableId}:${o.entryId}`);
  const result = await write();
  const text = typeof message === 'function' ? message(result) : message;
  // Nothing changed means no history step: the newest one isn't ours to undo.
  if (result?.changed === false) {
    showToast(text);
    return text;
  }
  offerRowUndo(o, await newestTableStep(o.tableId), text);
  return text;
}

export interface RepeatWriteOptions {
  /** The entry revision a fresh read gave; default the occurrence's. */
  expectedRevision?: string;
  /** The repeat's `current` that read saw; default the occurrence's own. */
  expectedCurrent?: string | null;
}

/**
 * Mark a repeating row's current occurrence done, or skip it (context menu).
 * Only the row's current occurrence can be completed / skipped. Returns the
 * toast's text.
 */
export async function completeOrSkip(
  o: CalendarRowOccurrence,
  action: 'done' | 'skip',
  message: RepeatMessage,
  options: RepeatWriteOptions = {}
): Promise<string> {
  const expectedCurrent =
    options.expectedCurrent !== undefined ? options.expectedCurrent : o.repeat?.occurrence;
  const input = {
    expectedRevision: options.expectedRevision ?? o.entryRevision,
    schemaVersion: o.schemaVersion,
    ...(expectedCurrent !== undefined ? { expectedCurrent } : {}),
  };
  return repeatWrite(
    o,
    () =>
      action === 'done'
        ? tableRepeatsApi.complete(o.tableId, o.entryId, o.fieldId, input)
        : tableRepeatsApi.skip(o.tableId, o.entryId, o.fieldId, input),
    message
  );
}

/**
 * Mark a repeating row's current occurrence done by setting its status field
 * to one of the setting's done options (`label`; a select cell stores the
 * label). The server's entry write logs the occurrence, advances the date and
 * resets the status, as one history step. `fresh` is a newer read of the row
 * than the occurrence carries.
 */
export async function markRowStatus(
  o: CalendarRowOccurrence,
  statusFieldId: string,
  label: string,
  message: string,
  fresh?: { expectedRevision: string; schemaVersion: string }
): Promise<void> {
  markOwnWrite(`entry:${o.tableId}:${o.entryId}`);
  await tablesApi.updateEntry(o.tableId, o.entryId, {
    values: { [statusFieldId]: label },
    schemaVersion: fresh?.schemaVersion ?? o.schemaVersion,
    expectedRevision: fresh?.expectedRevision ?? o.entryRevision,
  });
  offerRowUndo(o, await newestTableStep(o.tableId), message);
}

/**
 * The calendar's "Repeat…": set the row's repeat (a quick choice or
 * Custom…'s Done) or clear it (`input` null = Doesn't repeat). Returns the
 * toast's text.
 */
export async function setOrClearRepeat(
  o: CalendarRowOccurrence,
  input: TableRepeatInput | null,
  guard: { expectedRevision: string; expectedCurrent: string | null },
  message: RepeatMessage
): Promise<string> {
  const revision = { ...guard, schemaVersion: o.schemaVersion };
  return repeatWrite(
    o,
    () =>
      input === null
        ? tableRepeatsApi.clear(o.tableId, o.entryId, o.fieldId, revision)
        : tableRepeatsApi.set(o.tableId, o.entryId, o.fieldId, { ...revision, ...input }),
    message
  );
}

/**
 * True when a move needs the Only this one / All upcoming choice first. A
 * resize never does: a range row's new length applies to every later one.
 */
export function needsRepeatChoice(o: CalendarOccurrence): o is CalendarRowOccurrence {
  return o.source === 'row' && Boolean(o.repeat);
}

/** Whether "All upcoming" is allowed (`repeat.canShiftAll`; missing = true). */
export function canShiftAll(o: CalendarRowOccurrence): boolean {
  return o.repeat?.canShiftAll !== false;
}

export interface CommitMoveOptions {
  /** The viewer's zone: an event's saved zone wins when the occurrence carries it. */
  zone: string;
  /** Toast and live-region text, e.g. "Moved Pay rent to Tue Oct 13, 10:15 AM". */
  message: string;
  /** Repeating rows' moves: the user's choice. */
  mode?: RepeatMoveMode;
  /** A move (default) or a resize (a range row's new end). */
  kind?: WriteKind;
  label?: string;
}

/** Write a move or resize; throws on failure (the caller snaps back and toasts). */
export async function commitMove(
  o: CalendarOccurrence,
  after: CalendarOccurrenceTime,
  { zone, message, mode, kind = 'move', label }: CommitMoveOptions
): Promise<void> {
  if (o.source === 'event') {
    // Keep the event's own zone: the viewer's is only for an occurrence
    // that doesn't carry one (older data).
    const eventZone = o.timeZone ?? zone;
    await moveEvent(
      o.eventId,
      o.revision,
      toEventTime(o.time, eventZone),
      toEventTime(after, eventZone),
      message,
      label
    );
    return;
  }
  // Automation wakes are never moved (canMove is false); edit the automation.
  if (o.source === 'automation') return;
  if (o.repeat && kind === 'move') {
    await moveRepeatOccurrence(o, mode ?? 'one', after);
    offerRowUndo(o, await newestTableStep(o.tableId), message);
    return;
  }
  await writeRow(o, after, kind, message);
}
