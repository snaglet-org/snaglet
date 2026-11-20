import { describe, expect, it } from 'vitest';
import type { TableField } from '@snaglet/shared/types';
import { entryValueProblem, joinRangeParts, rangeKindOf, rangeParts } from './dateRange';

const base: TableField = {
  id: 'field-1111111111111-aaaaaaaaa',
  tableId: 'table-1111111111111-aaaaaaaaa',
  columnName: 'f_aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'When',
  description: null,
  type: 'date',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  position: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  range: true,
  multiple: false,
  options: null,
  revision: 1,
};

describe('rangeKindOf', () => {
  it('is the field type only for date and datetime fields with an end', () => {
    expect(rangeKindOf(base)).toBe('date');
    expect(rangeKindOf({ ...base, type: 'datetime' })).toBe('datetime');
    expect(rangeKindOf({ ...base, range: false })).toBeNull();
    expect(rangeKindOf({ ...base, type: 'text' })).toBeNull();
    expect(rangeKindOf(undefined)).toBeNull();
  });
});

describe('entryValueProblem', () => {
  it('accepts ranges and single values of a range field', () => {
    expect(entryValueProblem(base, '2026-10-12/2026-10-15')).toBeNull();
    expect(entryValueProblem(base, '2026-10-12')).toBeNull();
    expect(
      entryValueProblem(
        { ...base, type: 'datetime' },
        '2026-10-12T09:00:00.000000Z/2026-10-12T10:30:00.000000Z'
      )
    ).toBeNull();
  });

  it("refuses with the parser's sentence", () => {
    expect(entryValueProblem(base, '2026-10-15/2026-10-12')).toBe('The end is before the start.');
    expect(entryValueProblem(base, '/2026-10-12')).toBe("The range's start is empty.");
  });

  it('keeps the shared rules for empty values and other fields', () => {
    expect(entryValueProblem({ ...base, nullable: false }, null)).toBe('When is required.');
    expect(entryValueProblem({ ...base, range: false }, '2026-10-12/2026-10-15')).not.toBeNull();
  });
});

describe('rangeParts / joinRangeParts', () => {
  it('splits a stored value at its slash', () => {
    expect(rangeParts('2026-10-12/2026-10-15')).toEqual({
      start: '2026-10-12',
      end: '2026-10-15',
    });
    expect(rangeParts('2026-10-12')).toEqual({ start: '2026-10-12', end: '' });
    expect(rangeParts(null)).toEqual({ start: '', end: '' });
  });

  it('joins to the canonical wire form, a single value, or null', () => {
    expect(joinRangeParts({ start: '2026-10-12', end: '2026-10-15' }, 'date')).toEqual({
      value: '2026-10-12/2026-10-15',
      problem: null,
    });
    expect(joinRangeParts({ start: '2026-10-12', end: '2026-10-12' }, 'date').value).toBe(
      '2026-10-12'
    );
    expect(joinRangeParts({ start: '2026-10-12', end: '' }, 'date').value).toBe('2026-10-12');
    expect(joinRangeParts({ start: '', end: '' }, 'date')).toEqual({ value: null, problem: null });
    expect(
      joinRangeParts({ start: '2026-10-12T09:00', end: '2026-10-12T10:30' }, 'datetime', 'UTC')
        .value
    ).toBe('2026-10-12T09:00:00.000000Z/2026-10-12T10:30:00.000000Z');
  });

  it('keeps an invalid pair as text with its problem', () => {
    expect(joinRangeParts({ start: '2026-10-15', end: '2026-10-12' }, 'date')).toEqual({
      value: '2026-10-15/2026-10-12',
      problem: 'The end is before the start.',
    });
    expect(joinRangeParts({ start: '', end: '2026-10-12' }, 'date').problem).toBe(
      "The range's start is empty."
    );
  });
});
