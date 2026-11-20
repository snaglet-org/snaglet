import type { Element, ElementContent } from 'hast';

import { tsvCell } from '@desktop/utils/tsv';

/** A markdown table's cell text: the header row and each body row, in source order. */
export interface TableText {
  header: string[];
  rows: string[][];
}

export interface TableSort {
  column: number;
  direction: 'ascending' | 'descending';
}

/** The text of a hast subtree as it reads: text nodes joined, tags dropped,
 *  a line break (`<br>` in a cell) kept as a newline and a task checkbox as
 *  its marker, `[ ]` or `[x]`. */
function hastText(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element' && node.tagName === 'br') return '\n';
  if (node.type === 'element' && node.tagName === 'input' && node.properties.type === 'checkbox')
    return node.properties.checked ? '[x] ' : '[ ] ';
  if (node.type === 'element') return node.children.map(hastText).join('');
  return '';
}

function childElements(node: Element, tagName: string): Element[] {
  return node.children.filter(
    (child): child is Element => child.type === 'element' && child.tagName === tagName
  );
}

/** Cell text from react-markdown's hast `table` node (GFM: one header row, then the body). */
export function readTableText(table: Element): TableText {
  const headRow = childElements(table, 'thead').flatMap((head) => childElements(head, 'tr'))[0];
  const cellText = (cell: Element) => hastText(cell).trim();
  return {
    header: headRow ? childElements(headRow, 'th').map(cellText) : [],
    rows: childElements(table, 'tbody')
      .flatMap((body) => childElements(body, 'tr'))
      .map((row) => childElements(row, 'td').map(cellText)),
  };
}

// A number as people write one in a table: an optional sign and currency,
// thousands commas, decimals, a trailing percent.
const NUMBER = /^[-+−]?[$€£¥]?[-+−]?\d[\d,]*(?:\.\d+)?%?$/;

/** The cell's value for sorting: sign kept; currency, commas and percent dropped. */
function cellNumber(text: string): number {
  return Number.parseFloat(text.replace(/−/g, '-').replace(/[^\d.-]/g, ''));
}

/** A column reads as numbers when every non-empty body cell is one (and one isn't empty). */
export function isNumericColumn(rows: readonly string[][], column: number): boolean {
  const values = rows.map((row) => row[column] ?? '').filter(Boolean);
  return values.length > 0 && values.every((value) => NUMBER.test(value));
}

/** A header click: ascending, then descending, then back to the source order. */
export function nextSort(sort: TableSort | null, column: number): TableSort | null {
  if (sort?.column !== column) return { column, direction: 'ascending' };
  return sort.direction === 'ascending' ? { column, direction: 'descending' } : null;
}

// Text order: digit runs by value ("Step 9" before "Step 10"), case and
// accents ignored.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Source row indices in display order. Numeric columns compare as numbers,
 * the rest as text with digit runs compared by value. Empty cells stay last
 * in either direction; ties keep source order.
 */
export function sortedRowOrder(
  rows: readonly string[][],
  sort: TableSort | null,
  numeric: boolean
): number[] {
  const order = rows.map((_, index) => index);
  if (!sort) return order;
  const sign = sort.direction === 'ascending' ? 1 : -1;
  const key = (index: number) => rows[index]?.[sort.column] ?? '';
  return order.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (!x || !y) return Number(!x) - Number(!y) || a - b;
    const diff = numeric ? cellNumber(x) - cellNumber(y) : collator.compare(x, y);
    return sign * diff || a - b;
  });
}

export const rowsLabel = (count: number) => `${count} ${count === 1 ? 'row' : 'rows'}`;

/** Tab-separated, header first; a cell holding a tab, line break or quote is quoted. */
export function tableAsTsv(header: readonly string[], rows: readonly string[][]): string {
  return [header, ...rows].map((row) => row.map(tsvCell).join('\t')).join('\n');
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain HTML table of the cell text, for pasting into a sheet or a rich editor. */
export function tableAsHtml(header: readonly string[], rows: readonly string[][]): string {
  const cells = (tag: 'th' | 'td', row: readonly string[]) =>
    row.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join('');
  const body = rows.map((row) => `<tr>${cells('td', row)}</tr>`).join('');
  return `<table><thead><tr>${cells('th', header)}</tr></thead><tbody>${body}</tbody></table>`;
}
