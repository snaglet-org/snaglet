/**
 * calendar {op: "move_occurrence" | "complete_occurrence" |
 * "skip_occurrence"}: one occurrence of a repeating row, through
 * tableEntryRepeatAction (the function the table repeat routes call and
 * table's own `repeat` step uses), so each is one undoable step with the
 * usual realtime events and table_entry hooks. They are table writes: the
 * caller needs `table` write access (access.ts), and the table must be a
 * custom, active one (rows.ts).
 *
 * `rev` is the row's rev from a query (8 or more hex characters of the
 * entry revision). Complete and skip work on the row's current occurrence
 * only; passing `occurrence` guards that it still is. Move takes any current
 * or upcoming occurrence (default the current one).
 */
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, tableRepeatSummary } from '@snaglet/shared/utils';
import {
  getTableEntry,
  getTableEntryRepeats,
  tableEntryRepeatAction,
} from '@server/domains/tables/tableEntries';
import { badInput } from '@server/services/ToolService/tools/database/_shared/input';
import { assertTableAccess, type CalendarCaller } from './access';
import { ROW_REV_LENGTH } from './errors';
import { resolveRowTarget } from './rows';

type Input = Record<string, unknown>;
type OccurrenceAction = 'move' | 'complete' | 'skip';

const REV_PATTERN = /^[0-9a-f]{8,64}$/i;
const PAST: Record<OccurrenceAction, string> = {
  move: 'moved',
  complete: 'done',
  skip: 'skipped',
};
const WHAT: Record<OccurrenceAction, string> = {
  move: 'Moving an occurrence',
  complete: 'Completing an occurrence',
  skip: 'Skipping an occurrence',
};

function optionalText(input: Input, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw badInput(`${key} must be text`);
  return value.trim();
}

function rowRev(input: Input): string {
  const rev = optionalText(input, 'rev');
  if (!rev || !REV_PATTERN.test(rev))
    throw badInput('rev is required: the row’s rev from query (8 or more hex characters)');
  return rev.toLowerCase();
}

function conflict(message: string, entry: { id: string; revision: string }): AppError {
  return new AppError(message, ErrorCode.CONFLICT, HTTP_STATUS.CONFLICT, true, { entry });
}

async function occurrenceOp(
  action: OccurrenceAction,
  input: Input,
  caller: CalendarCaller
): Promise<unknown> {
  await assertTableAccess(caller, 'write', WHAT[action]);
  const target = await resolveRowTarget(input);
  const rev = rowRev(input);
  const occurrence = optionalText(input, 'occurrence');
  const moveTo = action === 'move' ? optionalText(input, 'move_to') : undefined;
  if (action === 'move' && moveTo === undefined) throw badInput('move_to is required');

  const { entry, schemaVersion } = await getTableEntry(target.tableId, target.entryId);
  if (!entry.revision.toLowerCase().startsWith(rev))
    throw conflict('The row changed since you read it; query again for its rev.', entry);
  const repeat = (await getTableEntryRepeats(target.tableId, target.entryId)).repeats[
    target.field.id
  ];
  if (!repeat)
    throw badInput(
      `This row's ${target.field.name} doesn't repeat, so it has no occurrence to mark ${PAST[action]}. ` +
        'Change its date with table {op: "write", update: [...]}.'
    );
  if (action !== 'move' && occurrence !== undefined && occurrence !== repeat.current)
    throw conflict(
      `Only the row's current occurrence (${repeat.current}) can be marked ${PAST[action]}; ${occurrence} is not it.`,
      entry
    );

  const result = await tableEntryRepeatAction(
    target.tableId,
    target.entryId,
    target.field.id,
    action,
    {
      expectedRevision: entry.revision,
      schemaVersion,
      expectedCurrent: repeat.current,
      ...(action === 'move' ? { to: moveTo, ...(occurrence ? { occurrence } : {}) } : {}),
    }
  );
  const after = result.repeat;
  return {
    table: target.tableName,
    entry_id: target.entryId,
    field: target.field.name,
    [PAST[action]]: action === 'move' ? (occurrence ?? repeat.current) : repeat.current,
    ...(action === 'move' ? { to: moveTo } : {}),
    rev: result.entry.revision.slice(0, ROW_REV_LENGTH),
    changed: result.changed,
    repeat: after
      ? {
          summary: tableRepeatSummary(after, { hasEnd: target.field.range }),
          current: after.current,
        }
      : null,
  };
}

export const moveOccurrenceOp = (input: Input, caller: CalendarCaller) =>
  occurrenceOp('move', input, caller);
export const completeOccurrenceOp = (input: Input, caller: CalendarCaller) =>
  occurrenceOp('complete', input, caller);
export const skipOccurrenceOp = (input: Input, caller: CalendarCaller) =>
  occurrenceOp('skip', input, caller);
