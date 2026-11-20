/**
 * Calendar binding and repeat setting in the field editor's draft.
 *
 * The draft carries `calendarId` / `recurrence` only
 * once the user touches them, so an untouched edit never re-sends a binding
 * or a repeat setting. Shown
 * values fall back to the saved field; a new field shows None.
 */
import {
  type TableField,
  type TableFieldDefinition,
  type TableFieldRecurrence,
  type TableSelectOption,
} from '@snaglet/shared/types';

export function isDateType(type: string): type is 'date' | 'datetime' {
  return type === 'date' || type === 'datetime';
}

/** The calendar the editor shows: the draft's choice, else the saved field's (None when new). */
export function shownCalendarId(
  draft: TableFieldDefinition,
  saved?: TableField
): string | 'default' | null {
  return 'calendarId' in draft ? (draft.calendarId ?? null) : (saved?.calendarId ?? null);
}

export function shownRecurrence(
  draft: TableFieldDefinition,
  saved?: TableField
): TableFieldRecurrence | null {
  return 'recurrence' in draft ? (draft.recurrence ?? null) : (saved?.recurrence ?? null);
}

/**
 * What goes out for the draft's type. Away from date/datetime the binding
 * key is dropped (the server clears it). An explicit "repeat off" (null)
 * always goes out: it is how a repeating field changes type.
 */
export function stripForType<T extends TableFieldDefinition>(value: T): T {
  const { calendarId: _calendar, recurrence: _recurrence, ...rest } = value;
  if (isDateType(value.type))
    return {
      ...rest,
      ...('calendarId' in value ? { calendarId: value.calendarId } : {}),
      ...('recurrence' in value ? { recurrence: value.recurrence } : {}),
    } as T;
  return (value.recurrence === null ? { ...rest, recurrence: null } : rest) as T;
}

/** Single selects of the table other than `fieldId`: the fields a repeat can use as its status. */
export function statusFieldsOf(fields: TableField[], fieldId?: string): TableField[] {
  return fields.filter((f) => f.id !== fieldId && f.type === 'select' && !f.multiple);
}

type StatusChoice = Pick<TableFieldRecurrence, 'doneOptionIds' | 'resetOptionId'>;

/**
 * Done and reset for a status field just picked: its last option counts as
 * done (usually "Done") and rows reset to its first (usually "To do"). With
 * one option there is no reset; with none, nothing is chosen yet.
 */
export function statusDefaults(field: TableField): StatusChoice {
  const options = field.options ?? [];
  const last = options[options.length - 1];
  return {
    doneOptionIds: last ? [last.id] : [],
    resetOptionId: options.length > 1 ? options[0].id : null,
  };
}

/**
 * The setting with done option `index` set to `optionId` (`index` = the
 * count adds one). Done never includes the reset: a reset that becomes done
 * moves to the first option left, else None.
 */
export function withDoneOption(
  recurrence: TableFieldRecurrence,
  options: readonly TableSelectOption[],
  index: number,
  optionId: string
): TableFieldRecurrence {
  const next = [...recurrence.doneOptionIds];
  next[index] = optionId;
  const done = next.filter((id, at) => next.indexOf(id) === at);
  const { resetOptionId } = recurrence;
  return {
    ...recurrence,
    doneOptionIds: done,
    resetOptionId:
      resetOptionId !== null && done.includes(resetOptionId)
        ? (options.find((option) => !done.includes(option.id))?.id ?? null)
        : resetOptionId,
  };
}

/**
 * Client-side mirror of the server's `assertRecurrenceTargets` plus the
 * setting's shape, in the editor's words. `fields` null = not loaded yet
 * (the server still checks).
 */
export function repeatProblem(
  draft: TableFieldDefinition,
  saved: TableField | undefined,
  fields: TableField[] | null
): string | null {
  const recurrence = 'recurrence' in draft ? draft.recurrence : undefined;
  if (!recurrence || !isDateType(draft.type)) return null;
  // No status field: rows are completed with Done / Skip only.
  if (recurrence.statusFieldId === null) return null;
  let statusName = 'the status field';
  if (fields) {
    const status = fields.find((f) => f.id === recurrence.statusFieldId);
    if (!status || status.id === saved?.id)
      return 'The status field must be a field of this table. Choose another one.';
    if (status.type !== 'select' || status.multiple)
      return `The status field ${status.name} must be a single select.`;
    statusName = status.name;
    const ids = new Set((status.options ?? []).map((o) => o.id));
    const named = [
      ...recurrence.doneOptionIds,
      ...(recurrence.resetOptionId ? [recurrence.resetOptionId] : []),
    ];
    if (!named.every((id) => ids.has(id)))
      return `Choose the done and reset statuses from the options of ${statusName}.`;
  }
  if (recurrence.doneOptionIds.length === 0)
    return `Choose at least one status of ${statusName} that counts as done.`;
  if (recurrence.resetOptionId && recurrence.doneOptionIds.includes(recurrence.resetOptionId))
    return 'The status a row resets to cannot also count as done.';
  return null;
}

/** Toast text for a calendar change saved from the editor (edit mode); null = no change. */
export function bindingChangeMessage(
  fieldName: string,
  before: string | null,
  after: string | null,
  calendarTitle: (id: string) => string
): string | null {
  if (before === after) return null;
  if (!after) return `${fieldName} no longer shows on a calendar`;
  return `${fieldName} shows on ${calendarTitle(after)}`;
}
