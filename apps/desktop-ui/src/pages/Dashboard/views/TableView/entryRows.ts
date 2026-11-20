import type { TableEntriesResponse, TableEntryValues, TableField } from '@snaglet/shared/types';

/** A new row's values: every editable field at its default. */
export function newEntryValues(fields: readonly TableField[]): TableEntryValues {
  return Object.fromEntries(
    fields.filter((field) => !field.managed).map((field) => [field.id, field.defaultValue])
  );
}

/**
 * Each listed entry's row number in the whole table: the server's numbers
 * for a search (a row saved since has none until the next read), else the
 * page offset plus its index.
 */
export function pageRowNumbers(page: TableEntriesResponse): Array<readonly [string, number]> {
  const numbered = page.rowNumbers;
  const offset = (page.page - 1) * page.pageSize;
  return page.entries.flatMap((entry, index) => {
    const number = numbered ? numbered[entry.id] : offset + index + 1;
    return number === undefined ? [] : [[entry.id, number] as const];
  });
}
