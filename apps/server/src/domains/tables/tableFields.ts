import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import { TableFields } from '@snaglet/db/tables/table_fields';
import {
  CUSTOM_FIELD_ID_PATTERN,
  ErrorCode,
  HTTP_STATUS,
  type CreateTableFieldRequest,
  type ReorderTableFieldsRequest,
  type SetTableFieldCalendarRequest,
  type TableField,
  type TableFieldDefinition,
  type UpdateTableFieldRequest,
  type UpdateTableFieldViewRequest,
} from '@snaglet/shared/types';
import {
  AppError,
  tableFieldDefinitionProblem,
  tableFieldWidthProblem,
} from '@snaglet/shared/utils';
import { emitTableFieldsChanged } from '@server/realtime/surfaces/tables';
import { emitCalendarChanged } from '@server/realtime/surfaces/calendar';
import { afterTableWrite, historyContext } from './tableHistory';
import { tableBadRequest } from './tableValidation';

/** Option labels are stored trimmed; anything malformed is left for the validator. */
function trimmedOption(option: unknown): unknown {
  if (typeof option !== 'object' || option === null || Array.isArray(option)) return option;
  const record = option as Record<string, unknown>;
  return typeof record.label === 'string' ? { ...record, label: record.label.trim() } : option;
}

function parseDefinition(input: unknown): TableFieldDefinition & Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw tableBadRequest('Request body must be a field definition');
  }
  const raw = input as Record<string, unknown>;
  const normalized = {
    ...raw,
    name: typeof raw.name === 'string' ? raw.name.trim() : raw.name,
    description:
      typeof raw.description === 'string' ? raw.description.trim() || null : raw.description,
    ...(Array.isArray(raw.options) ? { options: raw.options.map(trimmedOption) } : {}),
  } as TableFieldDefinition & Record<string, unknown>;
  const problem = tableFieldDefinitionProblem(normalized) ?? calendarBindingProblem(normalized);
  if (problem) throw tableBadRequest(problem);
  return normalized;
}

/**
 * Calendar binding shape. The type rule (date/datetime only) is checked
 * against the stored field in the model too; this only rejects malformed
 * values with a readable message. A range field holds its own end.
 */
function calendarBindingProblem(value: Record<string, unknown>): string | null {
  const calendarId = value.calendarId;
  if (
    calendarId !== undefined &&
    calendarId !== null &&
    (typeof calendarId !== 'string' || !calendarId.trim())
  )
    return "calendarId must be a calendar id, 'default', or null.";
  if (
    calendarId !== undefined &&
    calendarId !== null &&
    value.type !== 'date' &&
    value.type !== 'datetime'
  )
    return 'Only date and datetime fields can show on a calendar.';
  return null;
}

/**
 * Only the definition's own keys; `multiple`, `range`, `options`,
 * `referenceKind` and `recurrence` only when sent (an update keeps them
 * otherwise). A left-out table target is none.
 */
function definitionFields(value: TableFieldDefinition): TableFieldDefinition {
  return {
    name: value.name,
    description: value.description,
    type: value.type,
    nullable: value.nullable,
    defaultValue: value.defaultValue,
    referenceTableId: value.referenceTableId ?? null,
    ...(value.referenceKind !== undefined ? { referenceKind: value.referenceKind } : {}),
    ...(value.multiple !== undefined ? { multiple: value.multiple } : {}),
    ...(value.range !== undefined ? { range: value.range } : {}),
    ...(value.options !== undefined ? { options: value.options } : {}),
    ...(value.recurrence !== undefined ? { recurrence: value.recurrence } : {}),
    ...(value.calendarId !== undefined ? { calendarId: value.calendarId } : {}),
  };
}

export async function listTableFields(tableId: string): Promise<TableField[]> {
  const table = await TableCatalog.findById(tableId);
  if (!table) {
    throw new AppError('Table not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  if (table.origin === 'builtin') return [];
  if (table.state === 'deleted')
    throw new AppError('Table not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  return TableFields.listFields(tableId);
}

export async function createTableField(
  tableId: string,
  input: unknown
): Promise<{ field: TableField; created: boolean }> {
  const parsed = parseDefinition(input);
  if (typeof parsed.id !== 'string' || !CUSTOM_FIELD_ID_PATTERN.test(parsed.id)) {
    throw tableBadRequest('id must be a field id of the form field-<13 digits>-<suffix>');
  }
  const before = parsed.beforeFieldId;
  if (before !== undefined && typeof before !== 'string') {
    throw tableBadRequest('beforeFieldId must be a field id.');
  }
  const request: CreateTableFieldRequest = {
    ...definitionFields(parsed),
    id: parsed.id,
    ...(before !== undefined ? { beforeFieldId: before } : {}),
  };
  const history = historyContext();
  const result = await TableFields.createField(tableId, request, history);
  if (result.created) {
    emitTableFieldsChanged(tableId);
    if (result.field.calendarId)
      emitCalendarChanged({ kind: 'binding', calendarId: result.field.calendarId });
    await afterTableWrite(history.actor);
  }
  return result;
}

export async function reorderTableFields(tableId: string, input: unknown): Promise<TableField[]> {
  const raw: unknown =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>).fieldIds
      : undefined;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
    throw tableBadRequest('Request body must be { fieldIds: string[] } listing every field once');
  }
  const request: ReorderTableFieldsRequest = { fieldIds: raw as string[] };
  const history = historyContext();
  const fields = await TableFields.reorderFields(tableId, request.fieldIds, history);
  emitTableFieldsChanged(tableId);
  await afterTableWrite(history.actor);
  return fields;
}

const VIEW_BODY =
  'Request body must be { collapsed?: boolean, width?: number | null } with at least one';

/** The view keys a body sets: `collapsed`, `width` (null = auto), or both. */
function parseFieldView(input: unknown): UpdateTableFieldViewRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw tableBadRequest(VIEW_BODY);
  const raw = input as Record<string, unknown>;
  const request: UpdateTableFieldViewRequest = {};
  if (raw.collapsed !== undefined) {
    if (typeof raw.collapsed !== 'boolean') throw tableBadRequest(VIEW_BODY);
    request.collapsed = raw.collapsed;
  }
  if (raw.width !== undefined) {
    const problem = tableFieldWidthProblem(raw.width);
    if (problem) throw tableBadRequest(problem);
    request.width = raw.width as number | null;
  }
  if (request.collapsed === undefined && request.width === undefined)
    throw tableBadRequest(VIEW_BODY);
  return request;
}

/**
 * Collapse or expand a field's grid column and/or set its width; view
 * preferences, so last write wins, no revision and no history step.
 */
export async function updateTableFieldView(
  tableId: string,
  fieldId: string,
  input: unknown
): Promise<TableField> {
  const { field, changed } = await TableFields.setFieldView(
    tableId,
    fieldId,
    parseFieldView(input)
  );
  if (changed) emitTableFieldsChanged(tableId);
  return field;
}

export async function updateTableField(
  tableId: string,
  fieldId: string,
  input: unknown
): Promise<TableField> {
  const parsed = parseDefinition(input);
  if (
    typeof parsed.expectedRevision !== 'number' ||
    !Number.isSafeInteger(parsed.expectedRevision) ||
    parsed.expectedRevision < 1
  ) {
    throw tableBadRequest('expectedRevision must be a positive integer');
  }
  const request: UpdateTableFieldRequest = {
    ...definitionFields(parsed),
    expectedRevision: parsed.expectedRevision,
  };
  const history = historyContext();
  const before = (await TableFields.listFields(tableId)).find((f) => f.id === fieldId);
  const field = await TableFields.updateField(tableId, fieldId, request, history);
  if (field.revision !== request.expectedRevision) {
    emitTableFieldsChanged(tableId);
    announceBindingChange(before?.calendarId ?? null, field);
    await afterTableWrite(history.actor);
  }
  return field;
}

const CALENDAR_BODY =
  "Request body must be { calendarId: <calendar id> | 'default' | null, expectedRevision: number }";

function parseFieldCalendar(input: unknown): SetTableFieldCalendarRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw tableBadRequest(CALENDAR_BODY);
  const raw = input as Record<string, unknown>;
  const { calendarId, expectedRevision } = raw;
  if (calendarId === undefined) throw tableBadRequest(CALENDAR_BODY);
  const problem = calendarBindingProblem({ calendarId, type: 'date' });
  if (problem) throw tableBadRequest(problem);
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  )
    throw tableBadRequest('expectedRevision must be a positive integer');
  return { calendarId: calendarId as string | null, expectedRevision };
}

/**
 * Show a date or datetime field on a calendar (or take it off), managed
 * fields included; the calendar's bind and its undo use this, the field
 * editor keeps sending `calendarId` in its PATCH. No table history step.
 */
export async function setTableFieldCalendar(
  tableId: string,
  fieldId: string,
  input: unknown
): Promise<TableField> {
  const { field, previous, changed } = await TableFields.setFieldCalendar(
    tableId,
    fieldId,
    parseFieldCalendar(input)
  );
  if (changed) {
    emitTableFieldsChanged(tableId);
    announceBindingChange(previous, field);
  }
  return field;
}

/** `calendar:changed` (binding) when a field joins, leaves or changes its calendar binding. */
function announceBindingChange(was: string | null, after: TableField): void {
  const now = after.calendarId ?? null;
  if (was === now) return;
  if (was && was !== now) emitCalendarChanged({ kind: 'binding', calendarId: was });
  if (now) emitCalendarChanged({ kind: 'binding', calendarId: now });
}

/** Entries holding each option of a select field, keyed by option id. */
export async function selectOptionUsage(
  tableId: string,
  fieldId: string
): Promise<Record<string, number>> {
  return TableFields.selectOptionUsage(tableId, fieldId);
}
