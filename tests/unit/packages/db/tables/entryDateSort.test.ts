import { describe, expect, it } from '@jest/globals';
import type { TableField } from '@snaglet/shared/types';
import { dateSortSql } from '@snaglet/db/tables/table_entries/entryDate';

const field = (overrides: Partial<TableField>) =>
  ({ id: 'field-1', type: 'datetime', range: false, ...overrides }) as TableField;

describe('dateSortSql', () => {
  it('sorts a plain date or datetime column by itself', () => {
    expect(dateSortSql(field({}), 'entry."due"')).toBe('entry."due"::timestamp');
  });

  it('sorts a date range column (daterange, tstzrange) by its start, which casts to a timestamp', () => {
    expect(dateSortSql(field({ range: true }), 'entry."starts"')).toBe(
      'lower(entry."starts")::timestamp'
    );
    expect(dateSortSql(field({ type: 'date', range: true }), 'entry."span"')).toBe(
      'lower(entry."span")::timestamp'
    );
  });
});
