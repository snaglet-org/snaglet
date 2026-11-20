import { TABLE_ENTRY_ID_PATTERN } from '../types/table-entries';
import { TABLE_RELATION_MAX_LINKS, type TableField } from '../types/table-fields';
import { TABLE_REFERENCE_ID_PATTERN, type TableReferenceKind } from '../types/table-references';
import { parseTableDateRange, type TableDateRangeKind } from './tableDateRange';
import { userTimeZone } from './tableDateTime';
import { tableFieldDefinitionProblem } from './tableFields';
import { tableReferenceKindArticle, tableReferenceKindName } from './tableReferences';
import { selectValueProblem } from './tableSelectOptions';

/** One Snaglet item id of `kind`, or a problem. */
function itemIdProblem(kind: TableReferenceKind, value: unknown): string | null {
  return typeof value === 'string' && TABLE_REFERENCE_ID_PATTERN.test(value)
    ? null
    : `Choose ${tableReferenceKindArticle(kind)} to link.`;
}

/** An ordered list of unique Snaglet item ids of `kind` (null clears it), or a problem. */
function itemListProblem(kind: TableReferenceKind, value: unknown): string | null {
  if (value === null) return null;
  const plural = tableReferenceKindName(kind, true);
  if (!Array.isArray(value)) return `Choose ${plural} to link.`;
  if (value.length > TABLE_RELATION_MAX_LINKS)
    return `Link at most ${TABLE_RELATION_MAX_LINKS} ${plural}.`;
  if (
    !value.every(
      (item): item is string => typeof item === 'string' && TABLE_REFERENCE_ID_PATTERN.test(item)
    )
  )
    return `Choose ${plural} to link.`;
  // Item ids are case-sensitive, unlike entry UUIDs.
  if (new Set(value).size !== value.length) return 'Link each item only once.';
  return null;
}

function multipleRelationProblem(value: unknown): string | null {
  // Null clears the list; it is stored as [].
  if (value === null) return null;
  if (!Array.isArray(value)) return 'Choose entries from the related table.';
  if (value.length > TABLE_RELATION_MAX_LINKS)
    return `Link at most ${TABLE_RELATION_MAX_LINKS} entries.`;
  if (
    !value.every(
      (item): item is string => typeof item === 'string' && TABLE_ENTRY_ID_PATTERN.test(item)
    )
  )
    return 'Choose entries from the related table.';
  if (new Set(value.map((item) => item.toLowerCase())).size !== value.length)
    return 'Link each entry only once.';
  return null;
}

/** The full form, with an example, that every range value problem ends with. */
const RANGE_FORM: Record<TableDateRangeKind, string> = {
  date: 'Write a date range as start/end, like 2026-10-12/2026-10-15 (both days included), or as one date.',
  datetime:
    'Write a date and time range as start/end, like 2026-10-12T09:00/2026-10-12T10:30, or as one date and time.',
};

/** A range field's value: `start/end` or a single start (see `parseTableDateRange`). */
function rangeValueProblem(kind: TableDateRangeKind, value: unknown, timeZone: string) {
  if (typeof value !== 'string') return RANGE_FORM[kind];
  const parsed = parseTableDateRange(value, kind, timeZone);
  return parsed.ok ? null : `${parsed.problem} ${RANGE_FORM[kind]}`;
}

/**
 * Shared UI/model validation. Link targets (entries, and whether a Snaglet item
 * exists, is the right kind and is live) are checked by the database. A
 * range value without an offset is read in `timeZone`, as the server stores it.
 */
export function tableEntryValueProblem(
  field: TableField,
  value: unknown,
  timeZone: string = userTimeZone()
): string | null {
  if (field.managed) return 'This field is managed by Snaglet and cannot be edited.';
  const kind = field.type === 'relation' ? (field.referenceKind ?? null) : null;
  if (kind && field.multiple) return itemListProblem(kind, value);
  if (kind) return value === null ? null : itemIdProblem(kind, value);
  if (field.type === 'relation' && field.multiple) return multipleRelationProblem(value);
  if (field.type === 'select' && field.multiple) return selectValueProblem(field, value);
  if (value === null) return field.nullable ? null : `${field.name} is required.`;
  if (field.range && (field.type === 'date' || field.type === 'datetime'))
    return rangeValueProblem(field.type, value, timeZone);
  if (field.type === 'select') return selectValueProblem(field, value);
  if (field.type === 'relation') {
    return typeof value === 'string' && TABLE_ENTRY_ID_PATTERN.test(value)
      ? null
      : 'Choose an entry from the related table.';
  }
  if (field.type === 'uuid') return 'This field type cannot be edited.';
  if (typeof value !== 'string' && typeof value !== 'boolean')
    return 'Enter a value matching this field type.';
  // Reuse scalar rules without coercing decimal strings to JavaScript Number.
  const problem = tableFieldDefinitionProblem({
    name: 'value',
    description: null,
    type: field.type,
    nullable: true,
    defaultValue: value,
    referenceTableId: null,
  });
  return (
    problem
      ?.replace(/for the default/g, 'for this field')
      .replace(/default date/g, 'date')
      .replace(/text default/g, 'text value') ?? null
  );
}
