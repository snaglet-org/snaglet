/**
 * Rows made on the calendar (docs/architecture.md): quick add into a date
 * field bound to the calendar, and turning a plain event into a row of such a
 * table.
 *
 * Both use the table's normal APIs (`POST /entries`, after a `POST /fields`
 * when a conversion needs a Description column), so each write is a step in
 * the table history. The calendar's undo reverts those steps newest first (a
 * refused one stops the rest) and, for a conversion, restores the event.
 *
 * A slot lands in the date field by kind: date = the start's day; date & time
 * = the start instant (all-day starts at 00:00 local); date range = first /
 * last day; date & time range = start / end instants (all-day runs to 00:00
 * after its last day).
 */
import type {
  CalendarBoundField,
  CalendarEvent,
  CalendarOccurrenceTime,
  TableEntry,
  TableEntryValues,
  TableField,
  TableHistoryStep,
} from '@snaglet/shared/types';
import { CALENDAR_DEFAULT_BLOCK_MINUTES, TABLE_ENTRY_PAGE_SIZES } from '@snaglet/shared/types';
import { generateId, getErrorMessage } from '@snaglet/shared/utils';
import { archiveApi, tablesApi } from '@desktop/utils/api';
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import { newestTableStep, stepTableHistory } from '@desktop/features/database/tableHistory';
import { addDays, instantToZoned, lastZonedDate, zonedToInstant } from './calendarDates';
import { calendarApi } from './calendarApi';
import { markOwnWrite } from './calendarRealtime';
import { recordStep, type UndoableStep } from './calendarUndo';
import { eventSpan } from './eventActions';

/** A date field bound to a calendar, as the calendar list carries it. */
export type RowTarget = Pick<
  CalendarBoundField,
  'tableId' | 'tableName' | 'fieldId' | 'fieldName' | 'fieldType'
>;

/** The sidebar's label for a bound field: "tasks · due". */
export function targetLabel(target: Pick<RowTarget, 'tableName' | 'fieldName'>): string {
  return `${target.tableName} · ${target.fieldName}`;
}

/** The field's shape that decides its value's form. */
type DateFieldShape = Pick<TableField, 'type' | 'range'>;

/** @public The date field's value for `time`, in its wire form (see the header). */
export function rowDateValue(
  field: DateFieldShape,
  time: CalendarOccurrenceTime,
  zone: string
): string {
  if (field.type === 'date') {
    const start = time.kind === 'all_day' ? time.startDate : instantToZoned(time.start, zone).date;
    const last =
      time.kind === 'all_day'
        ? addDays(time.endDate, -1)
        : lastZonedDate(time.start, time.end, zone);
    return field.range && last > start ? `${start}/${last}` : start;
  }
  const start = time.kind === 'timed' ? time.start : zonedToInstant(time.startDate, 0, zone);
  const end = time.kind === 'timed' ? time.end : zonedToInstant(time.endDate, 0, zone);
  return field.range && Date.parse(end) > Date.parse(start) ? `${start}/${end}` : start;
}

/**
 * How the calendar draws a row whose field holds `rowDateValue(field, time)`
 * (until the window is read again): a date as all-day days, a datetime from
 * its start to its end, or the default block when it has none.
 */
export function rowOccurrenceDraw(
  field: DateFieldShape,
  time: CalendarOccurrenceTime,
  zone: string
): { time: CalendarOccurrenceTime; hasEnd: boolean } {
  const [start = '', end] = rowDateValue(field, time, zone).split('/');
  if (field.type === 'date') {
    return {
      time: { kind: 'all_day', startDate: start, endDate: addDays(end ?? start, 1) },
      hasEnd: end !== undefined,
    };
  }
  const blockEnd = new Date(Date.parse(start) + CALENDAR_DEFAULT_BLOCK_MINUTES * 60_000);
  return {
    time: { kind: 'timed', start, end: end ?? blockEnd.toISOString() },
    hasEnd: end !== undefined,
  };
}

/** The field a new row's title goes into: the Name field, else the first text field. */
export function titleFieldOf(fields: readonly TableField[]): TableField | undefined {
  return (
    fields.find((f) => !f.managed && f.isTitle && f.type === 'text') ??
    fields.find((f) => !f.managed && f.type === 'text')
  );
}

const DESCRIPTION = 'description';
const EVENT_DESCRIPTION = 'event_description';
const LOCATION = 'location';

function sameName(field: TableField, name: string): boolean {
  return field.name.trim().toLowerCase() === name.toLowerCase();
}

function holdsText(field: TableField): boolean {
  return field.type === 'text' && !field.managed && !field.isTitle;
}

/**
 * @public Where a converted event's description goes: the table's text field named
 * `description` (any case), else a new one of that name, or
 * `event_description` when a field that can't hold it (not text, or the
 * Name) already has the name. Field names are column names (lowercase
 * snake_case, `tableNameProblem`), so the new names are too.
 */
export function descriptionFieldFor(fields: readonly TableField[]): {
  field: TableField | null;
  name: string;
} {
  const owners = fields.filter((f) => sameName(f, DESCRIPTION));
  const text = owners.find(holdsText);
  if (text) return { field: text, name: text.name };
  if (owners.length === 0) return { field: null, name: DESCRIPTION };
  const other = fields.find((f) => sameName(f, EVENT_DESCRIPTION) && holdsText(f));
  return other ? { field: other, name: other.name } : { field: null, name: EVENT_DESCRIPTION };
}

/**
 * @public Where a converted event's location goes: the table's text field
 * named `location` (any case), or null when it has none (the location then
 * joins the description, see `eventDescriptionText`).
 */
export function locationFieldFor(fields: readonly TableField[]): TableField | null {
  return fields.find((f) => sameName(f, LOCATION) && holdsText(f)) ?? null;
}

/**
 * @public The text a converted event's description column gets: its
 * description, then a "Location: …" paragraph for a non-empty `location`
 * (the caller passes '' when the location has a column of its own). Empty
 * when there is neither.
 */
export function eventDescriptionText(description: string, location: string): string {
  const body = description.trim() ? description : '';
  const place = location.trim();
  if (!place) return body;
  const line = `Location: ${place}`;
  return body ? `${body.trimEnd()}\n\n${line}` : line;
}

interface TableSchema {
  fields: TableField[];
  schemaVersion: string;
}

/** The table's live fields and the schemaVersion a create must carry. */
async function readSchema(tableId: string): Promise<TableSchema> {
  const { fields, schemaVersion } = await tablesApi.entries(tableId, {
    pageSize: TABLE_ENTRY_PAGE_SIZES[0],
  });
  return { fields, schemaVersion };
}

/** A new row's values: every field's default, as the grid and Board start one. */
function defaultValues(fields: readonly TableField[]): TableEntryValues {
  return Object.fromEntries(fields.filter((f) => !f.managed).map((f) => [f.id, f.defaultValue]));
}

function dateFieldOf(schema: TableSchema, target: RowTarget): TableField {
  const field = schema.fields.find((f) => f.id === target.fieldId);
  if (!field || (field.type !== 'date' && field.type !== 'datetime')) {
    throw new Error(`${targetLabel(target)} isn't a date field any more. Reload and try again.`);
  }
  if (field.managed) {
    throw new Error(`Snaglet sets ${targetLabel(target)}, so a row can't be added there.`);
  }
  return field;
}

interface CreatedRow {
  tableId: string;
  entry: TableEntry;
  schemaVersion: string;
  /** The table's fields as the create saw them. */
  fields: TableField[];
  /** The bound date field written. */
  dateField: TableField;
  /** The history step of the create, or null when it couldn't be read. */
  step: TableHistoryStep | null;
}

async function insertRow(
  tableId: string,
  schema: TableSchema,
  values: TableEntryValues
): Promise<{ entry: TableEntry; schemaVersion: string; step: TableHistoryStep | null }> {
  const id = crypto.randomUUID();
  const saved = await tablesApi.createEntry(tableId, {
    id,
    values,
    schemaVersion: schema.schemaVersion,
  });
  const step = await newestTableStep(tableId, 'entry.create');
  emitTableEvent({ type: 'table.entries.changed', tableId, entryId: saved.entry.id });
  return { entry: saved.entry, schemaVersion: saved.schemaVersion, step };
}

function undoStep(step: TableHistoryStep, tableId: string): Promise<void> {
  return stepTableHistory('undo', { expected: step, tableId, rethrow: true });
}

function redoStep(step: TableHistoryStep, tableId: string): Promise<void> {
  return stepTableHistory('redo', {
    expected: { ...step, state: 'undone' },
    tableId,
    rethrow: true,
  });
}

/**
 * Quick add into a bound date field: one new row with `title` as its Name
 * and `time` in the date field (by its kind, see the header).
 */
export async function createRowAt(
  target: RowTarget,
  title: string,
  time: CalendarOccurrenceTime,
  zone: string
): Promise<CreatedRow> {
  const schema = await readSchema(target.tableId);
  const dateField = dateFieldOf(schema, target);
  const titleField = titleFieldOf(schema.fields);
  const values: TableEntryValues = {
    ...defaultValues(schema.fields),
    ...(titleField ? { [titleField.id]: title } : {}),
    [dateField.id]: rowDateValue(dateField, time, zone),
  };
  const row = await insertRow(target.tableId, schema, values);
  return { tableId: target.tableId, fields: schema.fields, dateField, ...row };
}

/**
 * The calendar undo step for a quick-added row: undo (and redo) exactly its
 * create step. Null when the step couldn't be read: an undo then might
 * revert some other change, so the toast says to use the table's history.
 */
export function createdRowUndo(row: CreatedRow): UndoableStep | null {
  const { step, tableId } = row;
  if (!step) return null;
  return {
    label: step.label,
    undo: () => undoStep(step, tableId),
    redo: () => redoStep(step, tableId),
  };
}

/**
 * A row edited in the calendar's row popover: its table-history step goes on
 * the calendar stack too (no toast, like the row window's edits), so Cmd+Z
 * in the pane steps back through it before the row's create.
 */
export async function recordRowEdit(tableId: string): Promise<void> {
  const step = await newestTableStep(tableId, 'entry.update');
  if (!step) return;
  recordStep({
    label: step.label,
    undo: () => undoStep(step, tableId),
    redo: () => redoStep(step, tableId),
  });
}

interface ConvertedEvent extends CreatedRow {
  /** Where the description went (null: the event had none). */
  descriptionField: TableField | null;
  /** Where the location went (null: it had none, or it joined the description). */
  locationField: TableField | null;
  /** The conversion added `descriptionField` to the table. */
  addedField: boolean;
  /** Toast text: "Moved to tasks · description, location". */
  message: string;
  /** The one undo step, or null when the history steps couldn't be read. */
  undo: UndoableStep | null;
}

async function undoQuietly(step: TableHistoryStep | null, tableId: string): Promise<void> {
  if (!step) return;
  try {
    await undoStep(step, tableId);
  } catch (err) {
    console.error('[calendar] rolling back a conversion failed', getErrorMessage(err));
  }
}

/**
 * Turn a plain event into a row of `target`'s table: its title becomes the
 * row's Name, its span the date field's value (by kind), a location goes
 * into the table's Location text column when it has one, and a non-empty
 * description (with the location appended when it has no column) goes into
 * the table's Description text column, which is added when missing. Then the
 * event is archived. A failure part-way undoes what was done and rethrows.
 * `event` must be the event as last saved (its revision guards the archive).
 */
export async function convertEventToRow(
  event: CalendarEvent,
  target: RowTarget,
  zone: string
): Promise<ConvertedEvent> {
  const { tableId } = target;
  let schema = await readSchema(tableId);
  const dateField = dateFieldOf(schema, target);
  const location = event.location.trim();
  const locationField = location ? locationFieldFor(schema.fields) : null;
  const description = eventDescriptionText(event.description, locationField ? '' : location);

  let descriptionField: TableField | null = null;
  let fieldStep: TableHistoryStep | null = null;
  let addedField = false;
  if (description) {
    const found = descriptionFieldFor(schema.fields);
    descriptionField = found.field;
    if (!descriptionField) {
      const created = await tablesApi.createField(tableId, {
        id: generateId('field'),
        name: found.name,
        description: null,
        type: 'text',
        nullable: true,
        defaultValue: null,
        referenceTableId: null,
      });
      descriptionField = created.field;
      addedField = true;
      fieldStep = await newestTableStep(tableId, 'field.create');
      emitTableEvent({ type: 'table.fields.changed', tableId });
      // The new column moved the schemaVersion on.
      try {
        schema = await readSchema(tableId);
      } catch (err) {
        await undoQuietly(fieldStep, tableId);
        throw err;
      }
    }
  }

  const titleField = titleFieldOf(schema.fields);
  const values: TableEntryValues = {
    ...defaultValues(schema.fields),
    ...(titleField ? { [titleField.id]: event.title } : {}),
    [dateField.id]: rowDateValue(dateField, eventSpan(event.time), zone),
    ...(descriptionField ? { [descriptionField.id]: description } : {}),
    ...(locationField ? { [locationField.id]: location } : {}),
  };

  let row: Awaited<ReturnType<typeof insertRow>>;
  try {
    row = await insertRow(tableId, schema, values);
  } catch (err) {
    await undoQuietly(fieldStep, tableId);
    throw err;
  }

  try {
    markOwnWrite(`event:${event.id}`);
    await calendarApi.deleteEvent(event.id, event.revision);
  } catch (err) {
    await undoQuietly(row.step, tableId);
    await undoQuietly(fieldStep, tableId);
    throw err;
  }

  const columns = [descriptionField, locationField].flatMap((f) => (f ? [f.name] : []));
  const where = columns.length ? `${target.tableName} · ${columns.join(', ')}` : target.tableName;
  const added =
    addedField && descriptionField
      ? `. Added a ${descriptionField.name} column to ${target.tableName}`
      : '';
  const message = `Moved to ${where}${added}`;

  const entryStep = row.step;
  // A created column we can't undo exactly (its step unread) is deleted instead.
  const createdField = addedField ? descriptionField : null;
  const undo: UndoableStep | null = entryStep
    ? {
        label: `Convert ${event.title || 'event'}`,
        undo: async () => {
          // The row first: it's the step most likely refused (edited since),
          // and a refusal must leave the event archived, not doubled.
          await undoStep(entryStep, tableId);
          let fieldError: unknown = null;
          try {
            if (fieldStep) await undoStep(fieldStep, tableId);
            else if (createdField) await tablesApi.deleteField(tableId, createdField.id);
          } catch (err) {
            fieldError = err;
          }
          markOwnWrite(`event:${event.id}`);
          await archiveApi.restore(event.id);
          if (fieldError) throw fieldError;
        },
        ...(fieldStep || !createdField
          ? {
              redo: async () => {
                if (fieldStep) await redoStep(fieldStep, tableId);
                await redoStep(entryStep, tableId);
                markOwnWrite(`event:${event.id}`);
                const current = await calendarApi.getEvent(event.id);
                markOwnWrite(`event:${event.id}`);
                await calendarApi.deleteEvent(event.id, current.event.revision);
              },
            }
          : {}),
      }
    : null;

  return {
    tableId,
    fields: schema.fields,
    dateField,
    ...row,
    descriptionField,
    locationField,
    addedField,
    message,
    undo,
  };
}
