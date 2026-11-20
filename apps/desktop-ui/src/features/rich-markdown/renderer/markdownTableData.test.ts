import { describe, expect, it } from 'vitest';

import {
  isNumericColumn,
  nextSort,
  sortedRowOrder,
  tableAsHtml,
  tableAsTsv,
} from './markdownTableData';

describe('markdown table data', () => {
  it('reads a column as numeric only when every non-empty cell is a number', () => {
    expect(isNumericColumn([['1,200'], ['-3.5'], ['$4'], ['12%'], ['']], 0)).toBe(true);
    expect(isNumericColumn([['12'], ['n/a']], 0)).toBe(false);
    expect(isNumericColumn([['#212'], ['#213']], 0)).toBe(false);
    expect(isNumericColumn([['1.2.3']], 0)).toBe(false);
    expect(isNumericColumn([[''], ['']], 0)).toBe(false);
  });

  it('cycles a column ascending, descending, then off; another column starts over', () => {
    const asc = nextSort(null, 1);
    expect(asc).toEqual({ column: 1, direction: 'ascending' });
    const desc = nextSort(asc, 1);
    expect(desc).toEqual({ column: 1, direction: 'descending' });
    expect(nextSort(desc, 1)).toBeNull();
    expect(nextSort(desc, 0)).toEqual({ column: 0, direction: 'ascending' });
  });

  it('keeps empty cells last in either direction', () => {
    const rows = [['b'], [''], ['a'], ['c']];
    expect(sortedRowOrder(rows, { column: 0, direction: 'ascending' }, false)).toEqual([
      2, 0, 3, 1,
    ]);
    expect(sortedRowOrder(rows, { column: 0, direction: 'descending' }, false)).toEqual([
      3, 0, 2, 1,
    ]);
  });

  it('sorts numeric cells by value, currency and commas aside', () => {
    const rows = [['$1,000'], ['-5'], ['20%'], ['3.5']];
    expect(sortedRowOrder(rows, { column: 0, direction: 'ascending' }, true)).toEqual([1, 3, 2, 0]);
  });

  it('copies as TSV, quoting a cell with a tab, line break or quote as spreadsheets read it', () => {
    expect(
      tableAsTsv(
        ['A', 'B'],
        [
          ['one\ttwo', 'line\nbreak'],
          ['say "hi"', 'y'],
        ]
      )
    ).toBe('A\tB\n"one\ttwo"\t"line\nbreak"\n"say ""hi"""\ty');
  });

  it('copies as an escaped HTML table', () => {
    expect(tableAsHtml(['<A>'], [['"x" & y']])).toBe(
      '<table><thead><tr><th>&lt;A&gt;</th></tr></thead>' +
        '<tbody><tr><td>&quot;x&quot; &amp; y</td></tr></tbody></table>'
    );
  });
});
