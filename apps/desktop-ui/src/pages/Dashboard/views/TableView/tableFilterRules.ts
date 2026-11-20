import type { TableEntryWhere, TableEntryWhereOperator, TableField } from '@snaglet/shared/types';
import { rangeKindOf } from './dateRange';

/*
 * The Filter control's rules, kept out of the component file so it holds
 * only components (React Fast Refresh) and so boardViewPreference can use
 * them without importing the control.
 */

/** Operators a field accepts (mirrors the server's `whereOperators`). */
export function filterOperators(field: TableField): TableEntryWhereOperator[] {
  if (field.state) return [];
  const empty: TableEntryWhereOperator[] = ['is_empty', 'is_not_empty'];
  switch (field.type) {
    case 'text':
      return ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', ...empty];
    case 'number':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', ...empty];
    case 'select':
      return field.multiple ? ['contains', 'not_contains', ...empty] : ['is', 'is_not', ...empty];
    case 'date':
    case 'datetime':
      return ['is', 'before', 'after', 'on_or_before', 'on_or_after', ...empty];
    case 'checkbox':
      return ['is'];
    case 'relation':
      return empty;
    default:
      return [];
  }
}

export function isFilterableField(field: TableField): boolean {
  return filterOperators(field).length > 0;
}

const OPERATOR_LABELS: Record<TableEntryWhereOperator, string> = {
  contains: 'contains',
  not_contains: 'does not contain',
  is: 'is',
  is_not: 'is not',
  starts_with: 'starts with',
  ends_with: 'ends with',
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  before: 'is before',
  after: 'is after',
  on_or_before: 'is on or before',
  on_or_after: 'is on or after',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
};

/** On a date range the comparisons read its start, and "is" means the range includes that day. */
const RANGE_OPERATOR_LABELS: Partial<Record<TableEntryWhereOperator, string>> = {
  is: 'includes',
  before: 'starts before',
  after: 'starts after',
  on_or_before: 'starts on or before',
  on_or_after: 'starts on or after',
};

export function operatorLabel(field: TableField | undefined, operator: TableEntryWhereOperator) {
  if (field?.type === 'select' && field.multiple) {
    if (operator === 'contains') return 'has';
    if (operator === 'not_contains') return 'does not have';
  }
  if (rangeKindOf(field)) return RANGE_OPERATOR_LABELS[operator] ?? OPERATOR_LABELS[operator];
  return OPERATOR_LABELS[operator];
}

export function needsValue(operator: TableEntryWhereOperator): boolean {
  return operator !== 'is_empty' && operator !== 'is_not_empty';
}

/** A new condition's starting value for `field` and `operator`. */
export function defaultValue(
  field: TableField,
  operator: TableEntryWhereOperator
): string | boolean | undefined {
  if (!needsValue(operator)) return undefined;
  if (field.type === 'checkbox') return true;
  if (field.type === 'select') return field.options?.[0]?.label ?? '';
  return '';
}

/** Whether the condition is complete enough to send (blank text values wait). */
export function isComplete(condition: TableEntryWhere, field: TableField | undefined): boolean {
  if (!field) return false;
  if (!needsValue(condition.operator)) return true;
  if (field.type === 'checkbox') return typeof condition.value === 'boolean';
  if (typeof condition.value !== 'string' || condition.value.trim() === '') return false;
  if (field.type === 'number') return /^-?(\d+(\.\d*)?|\.\d+)$/.test(condition.value.trim());
  if (field.type === 'date' || field.type === 'datetime')
    return /^\d{4}-\d{2}-\d{2}$/.test(condition.value);
  return true;
}

export function valueText(field: TableField | undefined, condition: TableEntryWhere): string {
  if (!needsValue(condition.operator)) return '';
  if (field?.type === 'checkbox') return condition.value ? 'checked' : 'unchecked';
  return String(condition.value ?? '');
}
