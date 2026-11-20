import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  TABLE_ENTRY_WHERE_MAX,
  TABLE_ENTRY_WHERE_OPERATORS,
  type TableEntryWhere,
  type TableEntryWhereOperator,
  type TableField,
} from '@snaglet/shared/types';
import { isRange, zoneLiteral } from '../table_fields/fieldSchema';
import { entryBadRequest } from './entrySchema';
import { likeLiteral } from './entryFilter';

const EMPTY_OPERATORS: readonly TableEntryWhereOperator[] = ['is_empty', 'is_not_empty'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER_PATTERN = /^-?(\d+(\.\d*)?|\.\d+)$/;
const ESCAPE = "ESCAPE '\\'";

/** The operators a field accepts (mirrored by the desktop filter control). */
function whereOperators(field: TableField): readonly TableEntryWhereOperator[] {
  if (field.state) return [];
  switch (field.type) {
    case 'text':
      return [
        'contains',
        'not_contains',
        'is',
        'is_not',
        'starts_with',
        'ends_with',
        ...EMPTY_OPERATORS,
      ];
    case 'number':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', ...EMPTY_OPERATORS];
    case 'select':
      return field.multiple
        ? ['contains', 'not_contains', ...EMPTY_OPERATORS]
        : ['is', 'is_not', ...EMPTY_OPERATORS];
    case 'date':
    case 'datetime':
      return ['is', 'before', 'after', 'on_or_before', 'on_or_after', ...EMPTY_OPERATORS];
    case 'checkbox':
      return ['is'];
    case 'relation':
      return EMPTY_OPERATORS;
    default:
      return [];
  }
}

/**
 * Validates a `where` list: at most TABLE_ENTRY_WHERE_MAX conditions, each on
 * an active field of this table with an operator its type accepts and a value
 * of the right shape.
 */
export function parseEntryWhere(input: unknown, fields: readonly TableField[]): TableEntryWhere[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > TABLE_ENTRY_WHERE_MAX)
    throw entryBadRequest(`where must list at most ${TABLE_ENTRY_WHERE_MAX} conditions.`);
  return input.map((condition: unknown) => {
    const { fieldId, operator, value } = (condition ?? {}) as Partial<TableEntryWhere>;
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (typeof fieldId !== 'string' || !field)
      throw entryBadRequest(`Field ${String(fieldId)} cannot be filtered.`);
    if (
      typeof operator !== 'string' ||
      !(TABLE_ENTRY_WHERE_OPERATORS as readonly string[]).includes(operator) ||
      !whereOperators(field).includes(operator)
    )
      throw entryBadRequest(`${field.name} cannot be filtered with ${String(operator)}.`);
    if (EMPTY_OPERATORS.includes(operator)) return { fieldId, operator };
    if (field.type === 'checkbox') {
      if (typeof value !== 'boolean') throw entryBadRequest(`${field.name} needs true or false.`);
      return { fieldId, operator, value };
    }
    if (typeof value !== 'string' || value.length > 500)
      throw entryBadRequest(`${field.name} needs a text value of at most 500 characters.`);
    if (field.type === 'number' && !NUMBER_PATTERN.test(value.trim()))
      throw entryBadRequest(`${field.name} needs a number.`);
    if ((field.type === 'date' || field.type === 'datetime') && !DATE_PATTERN.test(value))
      throw entryBadRequest(`${field.name} needs a date as YYYY-MM-DD.`);
    return { fieldId, operator, value: field.type === 'number' ? value.trim() : value };
  });
}

const COMPARE: Partial<Record<TableEntryWhereOperator, string>> = {
  eq: '=',
  is: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  before: '<',
  after: '>',
  on_or_before: '<=',
  on_or_after: '>=',
};

function emptyCheck(field: TableField, column: string): string {
  if (field.multiple) return `(${column} IS NULL OR cardinality(${column}) = 0)`;
  if (field.type === 'text') return `(${column} IS NULL OR ${column} !~ '[^[:space:]]')`;
  return `${column} IS NULL`;
}

/**
 * A date operator on a range column: `is` holds when the
 * range covers that day (a datetime range overlapping its local day; one that
 * ends at midnight does not reach the next day), and every other operator
 * compares the range's start day.
 */
function rangeConditionSql(
  type: 'date' | 'datetime',
  column: string,
  operator: TableEntryWhereOperator,
  date: string
): string {
  const zone = zoneLiteral();
  if (operator === 'is')
    return type === 'date'
      ? `${column} @> ${date}`
      : `${column} && tstzrange(${date}::timestamp AT TIME ZONE ${zone}, (${date} + 1)::timestamp AT TIME ZONE ${zone}, '[)')`;
  const start =
    type === 'datetime' ? `(lower(${column}) AT TIME ZONE ${zone})::date` : `lower(${column})`;
  return `${start} ${COMPARE[operator] ?? '='} ${date}`;
}

/** One condition over `entry`; parameters go through `param`. */
function conditionSql(
  field: TableField,
  { operator, value }: TableEntryWhere,
  param: (value: unknown) => string
): string {
  const column = `entry.${quoteIdentifier(field.columnName)}`;
  if (operator === 'is_empty') return emptyCheck(field, column);
  if (operator === 'is_not_empty') return `NOT ${emptyCheck(field, column)}`;
  switch (field.type) {
    case 'text': {
      const text = String(value);
      switch (operator) {
        case 'contains':
          return `${column} ILIKE ${param(`%${likeLiteral(text)}%`)} ${ESCAPE}`;
        case 'not_contains':
          return `(${column} IS NULL OR ${column} NOT ILIKE ${param(`%${likeLiteral(text)}%`)} ${ESCAPE})`;
        case 'starts_with':
          return `${column} ILIKE ${param(`${likeLiteral(text)}%`)} ${ESCAPE}`;
        case 'ends_with':
          return `${column} ILIKE ${param(`%${likeLiteral(text)}`)} ${ESCAPE}`;
        case 'is':
          return `lower(${column}) = lower(${param(text)})`;
        default:
          return `(${column} IS NULL OR lower(${column}) <> lower(${param(text)}))`;
      }
    }
    case 'number': {
      const op = COMPARE[operator] ?? '=';
      const sql = `${column} ${op} ${param(String(value))}::numeric`;
      return operator === 'neq' ? `(${column} IS NULL OR ${sql})` : sql;
    }
    case 'select': {
      const label = param(String(value));
      if (field.multiple)
        return operator === 'contains'
          ? `${label} = ANY(${column})`
          : `NOT (${label} = ANY(coalesce(${column}, '{}'::text[])))`;
      return operator === 'is'
        ? `${column} = ${label}`
        : `(${column} IS NULL OR ${column} <> ${label})`;
    }
    case 'date':
    case 'datetime': {
      const date = `${param(String(value))}::date`;
      if (isRange(field)) return rangeConditionSql(field.type, column, operator, date);
      const day =
        field.type === 'datetime' ? `(${column} AT TIME ZONE ${zoneLiteral()})::date` : column;
      return `${day} ${COMPARE[operator] ?? '='} ${date}`;
    }
    case 'checkbox':
      return `coalesce(${column}, false) = ${param(value === true)}::boolean`;
    default:
      return 'false';
  }
}

/** The AND of every condition over `entry`, or null for none. */
export function entryWhereCondition(
  where: readonly TableEntryWhere[],
  fields: readonly TableField[],
  param: (value: unknown) => string
): string | null {
  if (!where.length) return null;
  return where
    .map((condition) => {
      const field = fields.find((candidate) => candidate.id === condition.fieldId);
      if (!field) throw entryBadRequest(`Field ${condition.fieldId} cannot be filtered.`);
      return `(${conditionSql(field, condition, param)})`;
    })
    .join(' AND ');
}
