import type { TableEntryValue, TableField } from '@snaglet/shared/types';
import {
  formatTableDateRange,
  parseTableDateRange,
  tableEntryValueProblem,
  userTimeZone,
  type TableDateRangeKind,
} from '@snaglet/shared/utils';

/** The kind of range a field holds, or null when its values have no end. */
export function rangeKindOf(field: TableField | undefined): TableDateRangeKind | null {
  if (!field?.range) return null;
  return field.type === 'date' || field.type === 'datetime' ? field.type : null;
}

/**
 * {@link tableEntryValueProblem}, with a range field's text checked by the
 * shared range parser (`start/end`, or a single value).
 */
export function entryValueProblem(
  field: TableField,
  value: unknown,
  timeZone = userTimeZone()
): string | null {
  const kind = rangeKindOf(field);
  if (!kind || field.managed || typeof value !== 'string')
    return tableEntryValueProblem(field, value);
  const parsed = parseTableDateRange(value, kind, timeZone);
  return parsed.ok ? null : parsed.problem;
}

export interface RangeParts {
  /** Wire form of the start (`YYYY-MM-DD` or an instant); '' when empty. */
  start: string;
  /** Same form as `start`; '' for a single value. */
  end: string;
}

/** A stored range value split at its slash; text that is not a string reads as empty. */
export function rangeParts(value: TableEntryValue): RangeParts {
  if (typeof value !== 'string') return { start: '', end: '' };
  const slash = value.indexOf('/');
  return slash < 0
    ? { start: value, end: '' }
    : { start: value.slice(0, slash), end: value.slice(slash + 1) };
}

/**
 * The value two range inputs make: null when both are empty, the canonical
 * wire form when valid, otherwise the raw `start/end` text with the parser's
 * sentence, so the row's validation keeps refusing it.
 */
export function joinRangeParts(
  parts: RangeParts,
  kind: TableDateRangeKind,
  timeZone = userTimeZone()
): { value: string | null; problem: string | null } {
  if (!parts.start && !parts.end) return { value: null, problem: null };
  const text = parts.end ? `${parts.start}/${parts.end}` : parts.start;
  const parsed = parseTableDateRange(text, kind, timeZone);
  return parsed.ok
    ? { value: formatTableDateRange(parsed.range), problem: null }
    : { value: text, problem: parsed.problem };
}
