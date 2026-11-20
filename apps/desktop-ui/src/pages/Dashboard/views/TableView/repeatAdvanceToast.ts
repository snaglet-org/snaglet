/**
 * Feedback for the done-advance in the table views (Board, grid, entry
 * modal). Setting a repeating row's status to a done option makes the
 * server log the occurrence, move the row's date to the next one and reset
 * the status in the same write — so on a Board the card goes straight back
 * to its "To do" column. This says what happened: "Pay rent done for
 * Mon, Oct 12 · next Mon, Oct 19", with Undo for that exact table-history
 * step (a toast without Undo when the step can't be read, rather than
 * undoing some other change).
 */
import type { TableEntry, TableField } from '@snaglet/shared/types';
import { tableDateTimeToUtc, userTimeZone } from '@snaglet/shared/utils';
import { newestTableStep, stepTableHistory } from '@desktop/features/database/tableHistory';
import { showToast } from '@desktop/utils/toast';
import { entryLabel } from './RelationEntryPicker';
import { rangeParts } from './dateRange';
import { formatWallDate } from './repeat/repeatWallDates';

export interface RepeatAdvance {
  field: TableField;
  /** The value before the write: the occurrence that was done. */
  from: string;
  /** The value after: the next occurrence. */
  to: string;
}

/** A value's start: a range (`start/end`) repeats on its start; anything else is itself. */
function startOf(field: TableField, value: string): string {
  return field.range ? rangeParts(value).start : value;
}

/**
 * Repeating date fields whose value the server moved on although the patch
 * didn't write them, because the patch set the field's status. A patch that
 * wrote only a range's end (a resize, same start) still lets it advance.
 */
export function repeatAdvances(
  fields: readonly TableField[],
  before: TableEntry,
  after: TableEntry,
  patch: Readonly<Record<string, unknown>>
): RepeatAdvance[] {
  const out: RepeatAdvance[] = [];
  for (const field of fields) {
    const recurrence = field.recurrence;
    if (!recurrence || (field.type !== 'date' && field.type !== 'datetime')) continue;
    const from = before.values[field.id];
    const to = after.values[field.id];
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (field.id in patch) {
      const written = patch[field.id];
      const resize =
        field.range &&
        typeof written === 'string' &&
        startOf(field, written) === startOf(field, from);
      if (!resize) continue;
    }
    if (!recurrence.statusFieldId || !(recurrence.statusFieldId in patch)) continue;
    if (startOf(field, from) === startOf(field, to)) continue;
    out.push({ field, from, to });
  }
  return out;
}

const timedFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * "Mon, Oct 12" for a date; "Mon, Oct 12, 9:00 AM" (viewer's zone) for a
 * datetime. A range names its start (the occurrence the repeat is on).
 */
export function advanceDateText(field: TableField, value: string): string {
  const start = startOf(field, value);
  if (field.type === 'datetime') {
    const utc = tableDateTimeToUtc(start, userTimeZone());
    if (utc) return timedFormat.format(new Date(utc));
  }
  return formatWallDate(start.slice(0, 10), { weekday: true, year: false });
}

/** Toast text: "Pay rent done for Mon, Oct 12 · next Mon, Oct 19". */
export function repeatAdvanceMessage(title: string, advances: readonly RepeatAdvance[]): string {
  const first = advances[0]!;
  const text = `${title} done for ${advanceDateText(first.field, first.from)} · next ${advanceDateText(first.field, first.to)}`;
  return advances.length > 1 ? `${text} (+${advances.length - 1} more date)` : text;
}

/**
 * Call after a successful entry update. Shows the toast only when a
 * repeating date advanced that the patch didn't set; returns whether it did.
 */
export async function noteRepeatAdvance(args: {
  tableId: string;
  fields: readonly TableField[];
  before: TableEntry;
  after: TableEntry;
  patch: Readonly<Record<string, unknown>>;
}): Promise<boolean> {
  const title = entryLabel(args.after, [...args.fields]);
  const advances = repeatAdvances(args.fields, args.before, args.after, args.patch);
  if (!advances.length) return false;
  const message = repeatAdvanceMessage(title, advances);
  if (args.after.revision === args.before.revision) {
    showToast(message);
    return true;
  }
  const step = await newestTableStep(args.tableId);
  if (!step) {
    showToast(`${message}. To undo it, use the table's history.`, { durationMs: 6000 });
    return true;
  }
  showToast(message, {
    action: {
      label: 'Undo',
      run: () => void stepTableHistory('undo', { expected: step, tableId: args.tableId }),
    },
  });
  return true;
}
