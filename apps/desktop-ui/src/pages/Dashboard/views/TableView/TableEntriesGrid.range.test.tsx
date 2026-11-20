import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableEntriesQuery,
  TableEntriesResponse,
  TableEntry,
  TableEntrySort,
  TableEntryWhere,
  TableField,
} from '@snaglet/shared/types';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { __resetEntryNameCacheForTests } from '@desktop/features/table-entries/entryNameCache';
import { TableEntriesGrid } from './TableEntriesGrid';

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: ({ value, onChange, ariaLabel }: ChipEditableInputProps) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock('@desktop/features/rich-markdown/renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));

const api = vi.hoisted(() => ({
  entries: vi.fn<(tableId: string, query: TableEntriesQuery) => Promise<TableEntriesResponse>>(),
  entry: vi.fn(),
  fields: vi.fn(),
  createEntry: vi.fn(),
  updateEntry: vi.fn(),
  reorderFields: vi.fn(),
  setFieldView: vi.fn(),
  deleteEntries: vi.fn(),
  searchEntries: vi.fn(),
  resolveEntries: vi.fn(),
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const schemaVersion = 'a'.repeat(64);
const name: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId,
  name: 'name',
  columnName: 'name',
  description: null,
  type: 'text',
  nullable: false,
  defaultValue: '',
  referenceTableId: null,
  referenceKind: null,
  revision: 1,
  managed: false,
  position: 0,
  collapsed: false,
  isTitle: true,
  multiple: false,
  options: null,
};
const fields = [name];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function entry(n: number): TableEntry {
  return {
    id: id(n),
    createdAt: '2026-01-01T00:00:00.000000Z',
    revision: 'b'.repeat(64),
    values: { [name.id]: `Entry ${n}` },
  };
}
const rows = [1, 2, 3, 4, 5].map(entry);

/** A server that reverses the rows for any sort and keeps odd rows for any filter. */
function response(query: TableEntriesQuery): TableEntriesResponse {
  let listed = query.sort?.length ? [...rows].reverse() : rows;
  if (query.where?.length) listed = listed.filter((_, index) => index % 2 === 0);
  return {
    entries: listed,
    fields,
    totalCount: listed.length,
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 25,
    schemaVersion,
    relatedEntries: {},
    relatedItems: {},
  };
}

const descending: TableEntrySort[] = [{ fieldId: name.id, direction: 'desc' }];
const filtered: TableEntryWhere[] = [{ fieldId: name.id, operator: 'is_not_empty' }];

function grid(options: { sort?: TableEntrySort[]; where?: TableEntryWhere[] } = {}) {
  return <TableEntriesGrid tableId={tableId} columns={[]} fields={fields} {...options} />;
}
async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
}
const box = (n: number) => screen.getByRole('checkbox', { name: `Select entry Entry ${n}` });
const selectAll = () => screen.getByRole('checkbox', { name: 'Select all displayed entries' });
/** The entries checked, by number, in table order. */
function checkedRows(): number[] {
  return [1, 2, 3, 4, 5].filter((n) => {
    const element = screen.queryByRole('checkbox', { name: `Select entry Entry ${n}` });
    return element instanceof HTMLInputElement && element.checked;
  });
}
async function withKey(user: UserEvent, key: 'Shift' | 'Meta' | 'Control', act: () => unknown) {
  await user.keyboard(`{${key}>}`);
  await act();
  await user.keyboard(`{/${key}}`);
}
const shiftClick = (user: UserEvent, n: number) => withKey(user, 'Shift', () => user.click(box(n)));

beforeEach(() => {
  vi.resetAllMocks();
  __resetEntryNameCacheForTests();
  localStorage.clear();
  api.entries.mockImplementation((_id, query) => Promise.resolve(response(query)));
  api.fields.mockResolvedValue({ fields });
});

describe('TableEntriesGrid Shift-click range selection', () => {
  it('ranges from the anchor and re-ranges from the same anchor', async () => {
    const user = userEvent.setup();
    render(grid());
    await ready();
    await user.click(box(1));
    await shiftClick(user, 3);
    expect(checkedRows()).toEqual([1, 2, 3]);
    expect(screen.getByText('3 selected')).toBeInTheDocument();

    await shiftClick(user, 5);
    expect(checkedRows()).toEqual([1, 2, 3, 4, 5]);

    // The anchor stays on the first row, so a nearer Shift-click shrinks the range.
    await shiftClick(user, 2);
    expect(checkedRows()).toEqual([1, 2]);
  });

  it('ranges upward and keeps rows checked before the anchor was set', async () => {
    const user = userEvent.setup();
    render(grid());
    await ready();
    await user.click(box(1));
    await user.click(box(5));
    await shiftClick(user, 3);
    expect(checkedRows()).toEqual([1, 3, 4, 5]);
  });

  it('unchecks the range when the anchor is unchecked', async () => {
    const user = userEvent.setup();
    render(grid());
    await ready();
    await user.click(selectAll());
    expect(checkedRows()).toEqual([1, 2, 3, 4, 5]);
    await user.click(box(2));
    await shiftClick(user, 4);
    expect(checkedRows()).toEqual([1, 5]);
  });

  it('ranges in the sorted order shown', async () => {
    const user = userEvent.setup();
    render(grid({ sort: descending }));
    await ready();
    await user.click(box(4));
    await shiftClick(user, 2);
    expect(checkedRows()).toEqual([2, 3, 4]);
    await shiftClick(user, 5);
    expect(checkedRows()).toEqual([4, 5]);
  });

  it('ranges over the filtered rows only', async () => {
    const user = userEvent.setup();
    const view = render(grid({ where: filtered }));
    await ready();
    expect(screen.queryByRole('checkbox', { name: 'Select entry Entry 2' })).toBeNull();
    await user.click(box(1));
    await shiftClick(user, 5);
    expect(screen.getByText('3 selected')).toBeInTheDocument();

    view.rerender(grid());
    await waitFor(() => expect(box(2)).toBeInTheDocument());
    expect(checkedRows()).toEqual([1, 3, 5]);
  });

  it('toggles one row on Cmd- or Ctrl-click, even with Shift held', async () => {
    const user = userEvent.setup();
    render(grid());
    await ready();
    await user.click(box(1));
    await withKey(user, 'Meta', () => shiftClick(user, 4));
    expect(checkedRows()).toEqual([1, 4]);
    await withKey(user, 'Control', () => user.click(box(2)));
    expect(checkedRows()).toEqual([1, 2, 4]);
    await withKey(user, 'Meta', () => user.click(box(4)));
    expect(checkedRows()).toEqual([1, 2]);
  });

  it('treats a Shift-click with no anchor as a plain click that sets one', async () => {
    const user = userEvent.setup();
    render(grid());
    await ready();
    await shiftClick(user, 3);
    expect(checkedRows()).toEqual([3]);
    await shiftClick(user, 5);
    expect(checkedRows()).toEqual([3, 4, 5]);
  });

  it('keeps the header checkbox selecting all and none, and it clears the anchor', async () => {
    const user = userEvent.setup();
    render(grid());
    await ready();
    await user.click(box(2));
    await user.click(selectAll());
    expect(checkedRows()).toEqual([1, 2, 3, 4, 5]);
    await user.click(selectAll());
    expect(checkedRows()).toEqual([]);
    // No anchor is left behind to range (or uncheck) from.
    await shiftClick(user, 4);
    expect(checkedRows()).toEqual([4]);
  });

  it('extends with Shift+Space on a focused row checkbox or row', async () => {
    const user = userEvent.setup();
    render(grid());
    await ready();
    await user.click(box(1));
    box(3).focus();
    await user.keyboard('{Shift>} {/Shift}');
    expect(checkedRows()).toEqual([1, 2, 3]);

    const row = document.querySelector<HTMLElement>(`tr[data-entry-id="${id(5)}"]`);
    row?.focus();
    expect(row).toHaveFocus();
    await user.keyboard('{Shift>} {/Shift}');
    expect(checkedRows()).toEqual([1, 2, 3, 4, 5]);

    // Plain Space still toggles the focused box alone, and it becomes the anchor.
    box(4).focus();
    await user.keyboard(' ');
    expect(checkedRows()).toEqual([1, 2, 3, 5]);
  });

  it('does not let a Shift-press on a row checkbox start a text selection', async () => {
    render(grid());
    await ready();
    // A prevented mousedown is what stops Shift from extending the page's selection.
    expect(fireEvent.mouseDown(box(3), { shiftKey: true })).toBe(false);
    // The rest of the selection cell is not selectable text either.
    const styles = readFileSync(
      resolve(process.cwd(), 'src/pages/Dashboard/views/TableView/TableEntries.module.scss'),
      'utf8'
    );
    expect(styles).toMatch(/\n\.selectionCell \{[^}]*user-select: none;/);
  });
});
