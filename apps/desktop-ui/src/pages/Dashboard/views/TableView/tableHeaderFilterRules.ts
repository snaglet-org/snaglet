import type { TableEntryWhere, TableEntryWhereOperator, TableField } from '@snaglet/shared/types';
import { filterOperators, isComplete, needsValue, operatorLabel } from './tableFilterRules';

/*
 * Rules for a column header's one-click filter. It edits the same `where`
 * the Filter control and filter bar show: a column's header owns that
 * column's conditions and never touches another column's.
 */

/** The column's first complete condition: the one its header shows as active. */
export function activeColumnCondition(
  where: readonly TableEntryWhere[],
  field: TableField
): TableEntryWhere | undefined {
  return where.find((condition) => condition.fieldId === field.id && isComplete(condition, field));
}

/** How many conditions (complete or not) the view has on this column. */
export function columnConditionCount(where: readonly TableEntryWhere[], fieldId: string): number {
  return where.filter((condition) => condition.fieldId === fieldId).length;
}

/**
 * The view's filter with `next` as the column's condition: it replaces the
 * column's first condition where it stands (any further ones on the column,
 * made in the Filter control, stay), or joins at the end.
 */
export function setColumnCondition(
  where: readonly TableEntryWhere[],
  next: TableEntryWhere
): TableEntryWhere[] {
  const condition: TableEntryWhere = needsValue(next.operator)
    ? { fieldId: next.fieldId, operator: next.operator, value: next.value }
    : { fieldId: next.fieldId, operator: next.operator };
  const at = where.findIndex((item) => item.fieldId === next.fieldId);
  if (at < 0) return [...where, condition];
  return where.map((item, index) => (index === at ? condition : item));
}

/** The view's filter without any condition on this column. */
export function clearColumnConditions(
  where: readonly TableEntryWhere[],
  fieldId: string
): TableEntryWhere[] {
  return where.filter((condition) => condition.fieldId !== fieldId);
}

export interface QuickPick {
  label: string;
  condition: TableEntryWhere;
}

export type QuickChoices =
  /** One click per value: select options, or checked / unchecked. */
  | { kind: 'options'; picks: QuickPick[]; operators: []; empty: QuickPick[] }
  /** A typed value with an operator: text, number, date. */
  | { kind: 'value'; picks: []; operators: TableEntryWhereOperator[]; empty: QuickPick[] }
  /** Only empty / not empty (relations). */
  | { kind: 'empty'; picks: []; operators: []; empty: QuickPick[] };

/** What a column's header filter offers, by field type, worded like the Filter control. */
export function quickChoices(field: TableField): QuickChoices {
  const operators = filterOperators(field);
  const empty: QuickPick[] = operators
    .filter((operator) => !needsValue(operator))
    .map((operator) => ({
      label: operatorLabel(field, operator),
      condition: { fieldId: field.id, operator },
    }));
  if (field.type === 'checkbox')
    return {
      kind: 'options',
      picks: [
        { label: 'Checked', condition: { fieldId: field.id, operator: 'is', value: true } },
        { label: 'Unchecked', condition: { fieldId: field.id, operator: 'is', value: false } },
      ],
      operators: [],
      empty,
    };
  if (field.type === 'select') {
    const operator: TableEntryWhereOperator = field.multiple ? 'contains' : 'is';
    return {
      kind: 'options',
      picks: (field.options ?? []).map((option) => ({
        label: option.label,
        condition: { fieldId: field.id, operator, value: option.label },
      })),
      operators: [],
      empty,
    };
  }
  const valued = operators.filter(needsValue);
  if (!valued.length) return { kind: 'empty', picks: [], operators: [], empty };
  return { kind: 'value', picks: [], operators: valued, empty };
}

/** Whether `condition` is exactly this pick (same operator and value). */
export function isPicked(condition: TableEntryWhere | undefined, pick: QuickPick): boolean {
  return (
    !!condition &&
    condition.operator === pick.condition.operator &&
    (!needsValue(pick.condition.operator) || condition.value === pick.condition.value)
  );
}
