import {
  CUSTOM_FIELD_ID_PATTERN,
  EDITABLE_TABLE_FIELD_TYPES,
  TABLE_FIELD_DESCRIPTION_MAX_LENGTH,
  TABLE_FIELD_WIDTH_MAX,
  TABLE_FIELD_WIDTH_MIN,
  type TableFieldDefinition,
  type TableFieldRecurrence,
} from '../types/table-fields';
import {
  TABLE_SELECT_MAX_OPTIONS,
  TABLE_SELECT_OPTION_ID_PATTERN,
} from '../types/table-select-options';
import { TABLE_REFERENCE_KINDS } from '../types/table-references';
import { CUSTOM_TABLE_ID_PATTERN } from '../types/tables';
import { isTableDateTime } from './tableDateTime';
import { tableNameProblem } from './tableName';
import { isTableReferenceKind } from './tableReferences';
import { selectDefinitionProblem } from './tableSelectOptions';

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

/**
 * A grid column width a view write may set: null (auto) or whole px from
 * {@link TABLE_FIELD_WIDTH_MIN} to {@link TABLE_FIELD_WIDTH_MAX}.
 */
export function tableFieldWidthProblem(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TABLE_FIELD_WIDTH_MIN &&
    value <= TABLE_FIELD_WIDTH_MAX
  )
    return null;
  return `width must be a whole number of pixels from ${TABLE_FIELD_WIDTH_MIN} to ${TABLE_FIELD_WIDTH_MAX}, or null for auto.`;
}

/**
 * The stored form of a definition once `multiple` is decided: a list (multiple
 * relation or multi-select) is never null. A multiple relation's default is
 * `[]`; a multi-select keeps its list default, null becoming `[]`. Anything
 * else is unchanged.
 */
export function normalizeTableFieldDefinition<
  T extends TableFieldDefinition & { multiple: boolean },
>(value: T): T {
  if (!value.multiple) return value;
  const keep = value.type === 'select' && Array.isArray(value.defaultValue);
  return { ...value, nullable: false, defaultValue: keep ? value.defaultValue : [] };
}

/** Shared form and request policy; relation existence is checked transactionally by the model. */
export function tableFieldDefinitionProblem(value: TableFieldDefinition): string | null {
  if (typeof value.name !== 'string') return 'Field name must be a string.';
  const nameProblem = tableNameProblem(value.name, 'field');
  if (nameProblem) return nameProblem;
  if (
    value.description !== null &&
    (typeof value.description !== 'string' ||
      value.description.length > TABLE_FIELD_DESCRIPTION_MAX_LENGTH)
  ) {
    return `Field descriptions must be text of at most ${TABLE_FIELD_DESCRIPTION_MAX_LENGTH} characters.`;
  }
  if (value.description?.includes('\0'))
    return 'Field descriptions cannot contain null characters.';
  if (!EDITABLE_TABLE_FIELD_TYPES.includes(value.type)) return 'Choose a supported field type.';
  if (typeof value.nullable !== 'boolean') return 'Field nullable must be true or false.';
  if (value.multiple !== undefined && typeof value.multiple !== 'boolean')
    return 'Field multiple must be true or false.';
  if (value.type !== 'select' && value.options !== undefined && value.options !== null)
    return 'Only select fields have options.';
  if (
    value.referenceKind !== undefined &&
    value.referenceKind !== null &&
    !isTableReferenceKind(value.referenceKind)
  )
    return `Choose what this relation links to: Snaglet item types are ${TABLE_REFERENCE_KINDS.join(', ')}.`;
  if (
    value.type !== 'relation' &&
    value.referenceKind !== undefined &&
    value.referenceKind !== null
  )
    return 'Only relation fields can link to Snaglet items.';
  if (value.recurrence !== undefined && value.recurrence !== null) {
    if (value.type !== 'date' && value.type !== 'datetime')
      return 'Only date and datetime fields can repeat.';
    const problem = tableFieldRecurrenceProblem(value.recurrence);
    if (problem) return problem;
  }
  if (value.range !== undefined && typeof value.range !== 'boolean')
    return 'Field range must be true or false.';
  // Left out, `range` may still be on (an update keeps the field's setting),
  // so the model re-checks once it is decided.
  if (value.range === true) {
    if (value.type !== 'date' && value.type !== 'datetime')
      return 'Only date and datetime fields can have an end date.';
    if (value.defaultValue !== null) return 'A field with an end date cannot have a default value.';
    // A range may repeat: the series is on its start and every occurrence
    // keeps the current value's length.
  }
  if (value.type === 'select') return selectDefinitionProblem(value);
  if (value.type === 'relation') {
    const table = value.referenceTableId ?? null;
    const kind = value.referenceKind;
    if (table !== null && kind !== undefined && kind !== null)
      return 'Choose what this relation links to: a table or a Snaglet item type, not both.';
    // Left out, the kind may still be set (an update keeps the current one),
    // so the model re-checks once it is decided.
    if (table === null && kind === null)
      return 'Choose what this relation links to: a table or a Snaglet item type.';
    if (table !== null && (typeof table !== 'string' || !CUSTOM_TABLE_ID_PATTERN.test(table)))
      return 'Choose a custom table for this relation.';
    const emptyDefault =
      value.defaultValue === null ||
      (Array.isArray(value.defaultValue) && value.defaultValue.length === 0);
    // A multiple relation is stored never-null with a `[]` default, whatever
    // nullability or empty default the caller sent. Left out, `multiple` may
    // still mean one (an update keeps the current setting), so the model
    // re-checks once it is decided.
    if (value.multiple !== false)
      return emptyDefault ? null : 'Relation fields cannot have a default value.';
    if (!value.nullable) return 'Relation fields must allow empty values.';
    if (value.defaultValue !== null) return 'Relation fields cannot have a default value.';
    return null;
  }
  if (value.multiple === true) return 'Only relation fields can link to multiple entries.';
  if (value.referenceTableId !== null) return 'Only relation fields can reference another table.';
  if (value.defaultValue === null) return null;
  switch (value.type) {
    case 'text':
      return typeof value.defaultValue === 'string' && !value.defaultValue.includes('\0')
        ? null
        : 'Enter a text default without null characters.';
    case 'number':
      return typeof value.defaultValue === 'string' &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.defaultValue)
        ? null
        : 'Enter a decimal number for the default.';
    case 'date':
      return typeof value.defaultValue === 'string' && isDate(value.defaultValue)
        ? null
        : 'Enter a valid default date in YYYY-MM-DD format.';
    case 'datetime':
      return isTableDateTime(value.defaultValue)
        ? null
        : 'Enter a valid default date and time in ISO 8601 format, like 2026-10-01T15:30 or 2026-10-01T22:30:00Z.';
    case 'checkbox':
      return typeof value.defaultValue === 'boolean'
        ? null
        : 'Choose true or false for the default.';
  }
}

const RECURRENCE_KEYS = new Set(['statusFieldId', 'doneOptionIds', 'resetOptionId']);

/**
 * The shape of a field's repeat setting. The status field is optional: with
 * none, rows are completed with Done / Skip only. That a named status field
 * is an active single select of the same table, and the options are its own,
 * is checked by the model under the table lock.
 */
export function tableFieldRecurrenceProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return 'A repeat setting must be an object.';
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !RECURRENCE_KEYS.has(key));
  if (unknown) return `A repeat setting has no ${unknown}.`;
  const setting = record as Partial<TableFieldRecurrence>;
  // No status field: rows repeat and are completed with Done / Skip only.
  if (setting.statusFieldId === null) {
    if (!Array.isArray(setting.doneOptionIds) || setting.doneOptionIds.length > 0)
      return 'Without a status field, doneOptionIds must be an empty list.';
    if (setting.resetOptionId !== null)
      return 'Without a status field, resetOptionId must be null.';
    return null;
  }
  if (
    typeof setting.statusFieldId !== 'string' ||
    !CUSTOM_FIELD_ID_PATTERN.test(setting.statusFieldId)
  )
    return 'statusFieldId must be the select field that marks a row done, or null for none.';
  const done = setting.doneOptionIds;
  if (
    !Array.isArray(done) ||
    done.length === 0 ||
    done.length > TABLE_SELECT_MAX_OPTIONS ||
    !done.every((id) => typeof id === 'string' && TABLE_SELECT_OPTION_ID_PATTERN.test(id))
  )
    return 'A repeat setting needs doneOptionIds: at least one option id of the status field.';
  if (new Set(done).size !== done.length) return 'List each done option only once.';
  const reset = setting.resetOptionId;
  if (reset !== null && (typeof reset !== 'string' || !TABLE_SELECT_OPTION_ID_PATTERN.test(reset)))
    return 'resetOptionId must be an option id of the status field, or null to clear it.';
  if (reset !== null && done.includes(reset))
    return 'The status a row resets to cannot be one of its done options.';
  return null;
}
