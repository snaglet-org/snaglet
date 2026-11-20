import { describe, expect, it } from 'vitest';
import type { TableEntryWhere, TableField } from '@snaglet/shared/types';
import {
  activeColumnCondition,
  clearColumnConditions,
  columnConditionCount,
  quickChoices,
  setColumnCondition,
} from './tableHeaderFilterRules';

const base: TableField = {
  range: false,
  id: 'field-1111111111111-a',
  tableId: 'table-1111111111111-aaaaaaaaa',
  columnName: 'a',
  name: 'A',
  description: null,
  type: 'text',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  options: null,
  multiple: false,
  position: 0,
  managed: false,
  collapsed: false,
  isTitle: false,
  revision: 1,
};
const field = (extra: Partial<TableField>): TableField => ({ ...base, ...extra });
const A = 'field-1111111111111-a';
const B = 'field-1111111111111-b';

describe('setColumnCondition', () => {
  it('appends when the column has no condition, keeping the others', () => {
    const where: TableEntryWhere[] = [{ fieldId: B, operator: 'is_empty' }];
    expect(setColumnCondition(where, { fieldId: A, operator: 'contains', value: 'x' })).toEqual([
      { fieldId: B, operator: 'is_empty' },
      { fieldId: A, operator: 'contains', value: 'x' },
    ]);
  });

  it("replaces the column's first condition in place and leaves its others and other columns", () => {
    const where: TableEntryWhere[] = [
      { fieldId: B, operator: 'is_empty' },
      { fieldId: A, operator: 'gt', value: '1' },
      { fieldId: A, operator: 'lt', value: '9' },
    ];
    expect(setColumnCondition(where, { fieldId: A, operator: 'eq', value: '5' })).toEqual([
      { fieldId: B, operator: 'is_empty' },
      { fieldId: A, operator: 'eq', value: '5' },
      { fieldId: A, operator: 'lt', value: '9' },
    ]);
  });

  it('drops a value the operator does not take', () => {
    expect(setColumnCondition([], { fieldId: A, operator: 'is_empty', value: 'x' })).toEqual([
      { fieldId: A, operator: 'is_empty' },
    ]);
  });
});

describe('clearColumnConditions', () => {
  it('removes every condition on that column and nothing else', () => {
    const where: TableEntryWhere[] = [
      { fieldId: A, operator: 'gt', value: '1' },
      { fieldId: B, operator: 'is_empty' },
      { fieldId: A, operator: 'lt', value: '9' },
    ];
    expect(clearColumnConditions(where, A)).toEqual([{ fieldId: B, operator: 'is_empty' }]);
  });
});

describe('activeColumnCondition / columnConditionCount', () => {
  it('ignores incomplete conditions (blank text) for the active state', () => {
    const text = field({});
    expect(activeColumnCondition([{ fieldId: A, operator: 'contains', value: ' ' }], text)).toBe(
      undefined
    );
    expect(
      activeColumnCondition([{ fieldId: A, operator: 'contains', value: 'hi' }], text)
    ).toEqual({ fieldId: A, operator: 'contains', value: 'hi' });
  });

  it('counts every condition on the column', () => {
    expect(
      columnConditionCount(
        [
          { fieldId: A, operator: 'gt', value: '1' },
          { fieldId: B, operator: 'is_empty' },
          { fieldId: A, operator: 'lt', value: '9' },
        ],
        A
      )
    ).toBe(2);
  });
});

describe('quickChoices', () => {
  it('select: one choice per option with is, plus empty / not empty', () => {
    const status = field({
      type: 'select',
      options: [
        { id: 'o1', label: 'Todo', color: 'gray' },
        { id: 'o2', label: 'Done', color: 'green' },
      ],
    });
    const choices = quickChoices(status);
    expect(choices.kind).toBe('options');
    expect(choices.picks).toEqual([
      { label: 'Todo', condition: { fieldId: A, operator: 'is', value: 'Todo' } },
      { label: 'Done', condition: { fieldId: A, operator: 'is', value: 'Done' } },
    ]);
    expect(choices.empty.map((pick) => pick.condition.operator)).toEqual([
      'is_empty',
      'is_not_empty',
    ]);
  });

  it('multi-select picks use contains ("has")', () => {
    const tags = field({
      type: 'select',
      multiple: true,
      options: [{ id: 'o1', label: 'Red', color: 'red' }],
    });
    expect(quickChoices(tags).picks).toEqual([
      { label: 'Red', condition: { fieldId: A, operator: 'contains', value: 'Red' } },
    ]);
  });

  it('checkbox: checked / unchecked, no empty choices', () => {
    const done = field({ type: 'checkbox' });
    const choices = quickChoices(done);
    expect(choices.kind).toBe('options');
    expect(choices.picks).toEqual([
      { label: 'Checked', condition: { fieldId: A, operator: 'is', value: true } },
      { label: 'Unchecked', condition: { fieldId: A, operator: 'is', value: false } },
    ]);
    expect(choices.empty).toEqual([]);
  });

  it('text, number and date take a typed value with their operators (empties apart)', () => {
    expect(quickChoices(field({})).kind).toBe('value');
    expect(quickChoices(field({})).operators[0]).toBe('contains');
    expect(quickChoices(field({ type: 'number' })).operators).toEqual([
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
    ]);
    expect(quickChoices(field({ type: 'date' })).operators).toEqual([
      'is',
      'before',
      'after',
      'on_or_before',
      'on_or_after',
    ]);
  });

  it('relation: only empty / not empty', () => {
    const link = field({ type: 'relation' });
    const choices = quickChoices(link);
    expect(choices.kind).toBe('empty');
    expect(choices.empty.map((pick) => pick.label)).toEqual(['is empty', 'is not empty']);
  });
});
