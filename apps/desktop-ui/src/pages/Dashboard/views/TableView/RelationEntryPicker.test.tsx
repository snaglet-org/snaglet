import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableEntry, TableEntrySearchResponse, TableField } from '@snaglet/shared/types';
import type { ReactNode } from 'react';
import { NODE_CHIP_MIME } from '@desktop/utils/nodeChip';
import { usePaneDropZone } from '../../chrome/PaneChrome/usePaneDropZone';
import { __resetEntryNameCacheForTests } from '@desktop/features/table-entries/entryNameCache';
import { EntryCell } from './cells/EntryCell';
import { RelationEntryPicker, entryLabel } from './RelationEntryPicker';

const api = vi.hoisted(() => ({
  searchEntries: vi.fn(),
  resolveEntries: vi.fn(),
  entries: vi.fn(),
}));
vi.mock('@desktop/utils/api', () => ({ tablesApi: api }));
vi.mock('@desktop/features/table-entries', async () => {
  const cache = await vi.importActual<
    typeof import('@desktop/features/table-entries/entryNameCache')
  >('@desktop/features/table-entries/entryNameCache');
  return {
    useLiveEntryLabels: cache.useLiveEntryLabels,
    EntryReferenceChip: ({ entryId, name }: { entryId: string; name?: string }) => (
      <span title={entryId}>{name === undefined ? 'Entry' : name.trim() || 'Untitled'}</span>
    ),
  };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const targetId = 'table-1111111111111-bbbbbbbbb';
const title: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId: targetId,
  columnName: 'f_aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Title',
  type: 'text',
  description: null,
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  position: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
  revision: 1,
};
const relation: TableField = {
  ...title,
  id: 'field-1111111111111-bbbbbbbbb',
  name: 'Related entry',
  tableId,
  type: 'relation',
  referenceTableId: targetId,
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const results: TableEntrySearchResponse = {
  results: [1, 2, 3].map((n) => ({ id: id(n), name: `Entry ${n}`, preview: `Note ${n}` })),
  hasMore: false,
};
const names = {
  [targetId]: Object.fromEntries(results.results.map((entry) => [entry.id, { name: entry.name }])),
};

function DropPane({ onOpen, children }: { onOpen: () => void; children: ReactNode }) {
  const { handlers, hoverZone } = usePaneDropZone(onOpen);
  return (
    <div {...handlers} data-testid="drop-pane" data-hover-zone={hoverZone ?? ''}>
      {children}
    </div>
  );
}

function setup(overrides: Partial<Parameters<typeof RelationEntryPicker>[0]> = {}) {
  const props = {
    field: relation,
    value: null,
    relatedEntries: names,
    relatedItems: {},
    onChange: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    busy: false,
    autoFocus: true,
    ...overrides,
  };
  return { props, ...render(<RelationEntryPicker {...props} />) };
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetEntryNameCacheForTests();
  api.searchEntries.mockResolvedValue(results);
  api.resolveEntries.mockResolvedValue({ entries: [] });
  api.entries.mockResolvedValue({ page: 4 });
});
afterEach(() => {
  __resetEntryNameCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RelationEntryPicker', () => {
  it('searches a bounded list by name and preview, with no old paged select', async () => {
    setup();
    await screen.findByRole('option', { name: 'Entry 1 Note 1' });
    expect(api.searchEntries).toHaveBeenCalledWith(targetId, {
      q: '',
      limit: 20,
      offset: 0,
      exclude: [],
    });
    expect(screen.queryByRole('button', { name: /related entries/ })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveFocus();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-autocomplete', 'list');
  });

  it('labels unnamed results and linked entries by their row number', async () => {
    api.searchEntries.mockResolvedValue({
      results: [{ id: id(4), name: '', preview: 'Note 4' }],
      hasMore: false,
    });
    const { props } = setup({ field: { ...relation, multiple: true } });
    const option = await screen.findByRole('option', { name: 'Untitled 4 Note 4' });
    expect(option).toHaveTextContent('Untitled 4');
    expect(api.entries).toHaveBeenCalledWith(targetId, { focusEntryId: id(4), pageSize: 1 });
    await userEvent.click(option);
    expect(props.onChange).toHaveBeenLastCalledWith([id(4)]);
    expect(await screen.findByRole('button', { name: 'Remove Untitled 4' })).toBeInTheDocument();
    expect(api.entries).toHaveBeenCalledTimes(1);
  });

  it('commits a single selection by pointer and keeps its name before any refetch', async () => {
    const { props } = setup();
    await userEvent.click(await screen.findByRole('option', { name: 'Entry 2 Note 2' }));
    expect(props.onChange).toHaveBeenLastCalledWith(id(2));
    expect(props.onCommit).toHaveBeenLastCalledWith(id(2));
    expect(screen.getByRole('button', { name: 'Remove Entry 2' })).toBeInTheDocument();
  });

  it('supports arrows and Enter in the search without submitting a stale value', async () => {
    const { props } = setup();
    await screen.findByRole('option', { name: 'Entry 1 Note 1' });
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(props.onChange).toHaveBeenLastCalledWith(id(2));
    expect(props.onCommit).toHaveBeenLastCalledWith(id(2));
  });

  it('clears single relations to null, and Tab commits the latest same-tick edit', async () => {
    const { props } = setup({ value: id(1) });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove Entry 1' }));
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Tab' });
    });
    expect(props.onChange).toHaveBeenLastCalledWith(null);
    expect(props.onCommit).toHaveBeenLastCalledWith(null);
  });

  it('keeps multiple selections open, excludes duplicates, removes to an empty array', async () => {
    const { props } = setup({ field: { ...relation, multiple: true }, value: null });
    await userEvent.click(await screen.findByRole('option', { name: 'Entry 1 Note 1' }));
    expect(props.onChange).toHaveBeenLastCalledWith([id(1)]);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: 'Entry 1 Note 1' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('option', { name: 'Entry 2 Note 2' }));
    expect(props.onChange).toHaveBeenLastCalledWith([id(1), id(2)]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Entry 1' }));
    expect(props.onChange).toHaveBeenLastCalledWith([id(2)]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Entry 2' }));
    expect(props.onChange).toHaveBeenLastCalledWith([]);
    await userEvent.tab();
    expect(props.onCommit).toHaveBeenLastCalledWith([]);
  });

  it('commits an untouched empty multiple relation as [] rather than null', async () => {
    const { props } = setup({ field: { ...relation, multiple: true }, value: null });
    await userEvent.tab();
    expect(props.onCommit).toHaveBeenCalledWith([]);
  });

  it('reaches selected chips by keyboard, reorders accessibly, and retains focus', async () => {
    const { props } = setup({ field: { ...relation, multiple: true }, value: [id(1), id(2)] });
    await userEvent.keyboard('{ArrowLeft}');
    const second = screen.getByRole('button', { name: 'Reorder Entry 2, position 2 of 2' });
    expect(second).toHaveFocus();
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(props.onChange).toHaveBeenLastCalledWith([id(2), id(1)]);
    expect(screen.getByRole('button', { name: 'Reorder Entry 2, position 1 of 2' })).toHaveFocus();
    expect(screen.getByText('Entry 2 moved to position 1 of 2.')).toBeInTheDocument();
    await userEvent.keyboard('{Delete}');
    expect(props.onChange).toHaveBeenLastCalledWith([id(1)]);
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('reorders by local drag without producing a reference-chip drag', () => {
    const { props } = setup({
      field: { ...relation, multiple: true },
      value: [id(1), id(2), id(3)],
    });
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: (type: string) => data.get(type) ?? '',
      types: [],
      effectAllowed: '',
      dropEffect: '',
    };
    const first = screen.getByRole('button', { name: 'Reorder Entry 1, position 1 of 3' });
    const last = screen.getByRole('button', { name: 'Reorder Entry 3, position 3 of 3' });
    fireEvent.dragStart(first, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      'application/x-snaglet-relation-order',
      expect.any(String)
    );
    expect(data.has(NODE_CHIP_MIME)).toBe(false);
    fireEvent.dragOver(last, { dataTransfer });
    fireEvent.drop(last, { dataTransfer: { ...dataTransfer, getData: () => '' } });
    expect(props.onChange).toHaveBeenLastCalledWith([id(2), id(3), id(1)]);
  });

  it('never activates the pane split overlay for a local relation drag', () => {
    const onOpen = vi.fn();
    const onChange = vi.fn();
    render(
      <DropPane onOpen={onOpen}>
        <RelationEntryPicker
          field={{ ...relation, multiple: true }}
          value={[id(1), id(2)]}
          relatedEntries={names}
          onChange={onChange}
          onCommit={vi.fn()}
          onCancel={vi.fn()}
          busy={false}
        />
      </DropPane>
    );
    const dataTransfer = {
      types: ['application/x-snaglet-relation-order'],
      setData: vi.fn(),
      getData: () => '',
      effectAllowed: '',
      dropEffect: '',
    };
    const first = screen.getByRole('button', { name: 'Reorder Entry 1, position 1 of 2' });
    const second = screen.getByRole('button', { name: 'Reorder Entry 2, position 2 of 2' });
    fireEvent.dragStart(first, { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('drop-pane'), { dataTransfer });
    expect(screen.getByTestId('drop-pane')).toHaveAttribute('data-hover-zone', '');
    fireEvent.dragOver(second, { dataTransfer });
    fireEvent.drop(second, { dataTransfer });
    expect(onChange).toHaveBeenCalledWith([id(2), id(1)]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('enforces the 100-link limit without preventing removal', async () => {
    api.searchEntries.mockResolvedValue({
      results: [{ id: id(101), name: 'Extra', preview: '' }],
      hasMore: false,
    });
    const { props } = setup({
      field: { ...relation, multiple: true },
      value: Array.from({ length: 100 }, (_, n) => id(n + 1)),
    });
    const extra = await screen.findByRole('option', { name: 'Extra' });
    expect(extra).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(await screen.findByRole('option', { name: 'Extra' }));
    expect(props.onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Up to 100 entries can be linked.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Entry 1' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Extra' }));
    expect(props.onChange).toHaveBeenLastCalledWith([
      ...Array.from({ length: 99 }, (_, n) => id(n + 2)),
      id(101),
    ]);
  });

  it('debounces queries and ignores an older successful search', async () => {
    vi.useFakeTimers();
    let resolveOld: (value: TableEntrySearchResponse) => void = () => undefined;
    api.searchEntries.mockImplementation((_table: string, query: { q: string }) =>
      query.q === 'old'
        ? new Promise<TableEntrySearchResponse>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({
            results: [{ id: id(4), name: query.q || 'Initial', preview: '' }],
            hasMore: false,
          })
    );
    setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'old' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(api.searchEntries).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByRole('option', { name: 'new' })).toBeInTheDocument();
    await act(async () =>
      resolveOld({ results: [{ id: id(5), name: 'old', preview: '' }], hasMore: false })
    );
    expect(screen.queryByRole('option', { name: 'old' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'new' })).toBeInTheDocument();
  });

  it('keeps failed queries retryable and restores input focus', async () => {
    api.searchEntries.mockRejectedValueOnce(new Error('Search is unavailable'));
    const { props } = setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('Search is unavailable');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('option', { name: 'Entry 1 Note 1' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveFocus();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it('excludes linked entries before paging, so twenty links do not hide later choices', async () => {
    const selected = Array.from({ length: 20 }, (_, n) => id(n + 1));
    api.searchEntries.mockResolvedValue({
      results: [{ id: id(21), name: 'Available entry', preview: '' }],
      hasMore: false,
    });
    setup({ field: { ...relation, multiple: true }, value: selected });
    await screen.findByRole('option', { name: 'Available entry' });
    expect(api.searchEntries).toHaveBeenCalledWith(targetId, {
      q: '',
      limit: 20,
      offset: 0,
      exclude: selected,
    });
    expect(screen.queryByText('No more entries to link')).not.toBeInTheDocument();
  });

  it('offers keyboard-accessible Show more and advances by the returned count without duplicate choices', async () => {
    api.searchEntries
      .mockResolvedValueOnce({ results: results.results.slice(0, 2), hasMore: true })
      .mockResolvedValueOnce({ results: results.results.slice(1), hasMore: true })
      .mockResolvedValueOnce({
        results: [{ id: id(4), name: 'Final entry', preview: '' }],
        hasMore: false,
      });
    const { props } = setup();
    const more = await screen.findByRole('option', { name: 'Show more entries' });
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-activedescendant');
    await userEvent.click(more);
    await screen.findByRole('option', { name: 'Entry 3 Note 3' });
    expect(screen.getAllByRole('option', { name: 'Entry 2 Note 2' })).toHaveLength(1);
    expect(api.searchEntries).toHaveBeenNthCalledWith(2, targetId, {
      q: '',
      limit: 20,
      offset: 2,
      exclude: [],
    });
    // Focus stays in the input: Down reaches the next-page option, Enter activates it.
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await screen.findByRole('option', { name: 'Final entry', selected: true });
    expect(api.searchEntries).toHaveBeenNthCalledWith(3, targetId, {
      q: '',
      limit: 20,
      offset: 4,
      exclude: [],
    });
    expect(screen.queryByRole('option', { name: 'Show more entries' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(props.onCommit).toHaveBeenCalledWith(id(4));
  });

  it('retains the loaded choices on a page failure and retries the same offset', async () => {
    api.searchEntries
      .mockResolvedValueOnce({ results: results.results.slice(0, 2), hasMore: true })
      .mockRejectedValueOnce(new Error('Next page is unavailable'))
      .mockResolvedValueOnce({ results: results.results.slice(2), hasMore: false });
    setup();
    await userEvent.click(await screen.findByRole('option', { name: 'Show more entries' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Next page is unavailable');
    expect(screen.getByRole('option', { name: 'Entry 1 Note 1' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('option', { name: 'Entry 3 Note 3' });
    expect(api.searchEntries.mock.calls.map(([, query]) => query.offset)).toEqual([0, 2, 2]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('ignores a late page after a different search starts', async () => {
    let resolvePage!: (page: TableEntrySearchResponse) => void;
    api.searchEntries
      .mockResolvedValueOnce({ results: results.results.slice(0, 2), hasMore: true })
      .mockImplementationOnce(
        () =>
          new Promise<TableEntrySearchResponse>((resolve) => {
            resolvePage = resolve;
          })
      )
      .mockResolvedValueOnce({
        results: [{ id: id(4), name: 'New search', preview: '' }],
        hasMore: false,
      });
    setup();
    await userEvent.click(await screen.findByRole('option', { name: 'Show more entries' }));
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-busy', 'true');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'New' } });
    await screen.findByRole('option', { name: 'New search' });
    await act(async () => resolvePage({ results: results.results.slice(2), hasMore: true }));
    expect(screen.queryByRole('option', { name: 'Entry 3 Note 3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Show more entries' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'New search' })).toBeInTheDocument();
  });

  it('restarts at zero with new exclusions after selecting during a pending page', async () => {
    let resolvePage!: (page: TableEntrySearchResponse) => void;
    api.searchEntries
      .mockResolvedValueOnce({ results: results.results.slice(0, 1), hasMore: true })
      .mockImplementationOnce(
        () =>
          new Promise<TableEntrySearchResponse>((resolve) => {
            resolvePage = resolve;
          })
      )
      .mockResolvedValueOnce({ results: results.results.slice(1, 2), hasMore: false });
    const { props } = setup({ field: { ...relation, multiple: true }, value: [] });
    await userEvent.click(await screen.findByRole('option', { name: 'Show more entries' }));
    await userEvent.click(screen.getByRole('option', { name: 'Entry 1 Note 1' }));
    await screen.findByRole('option', { name: 'Entry 2 Note 2' });
    expect(api.searchEntries).toHaveBeenLastCalledWith(targetId, {
      q: '',
      limit: 20,
      offset: 0,
      exclude: [id(1)],
    });
    await act(async () => resolvePage({ results: results.results.slice(2), hasMore: true }));
    expect(screen.queryByRole('option', { name: 'Entry 3 Note 3' })).not.toBeInTheDocument();
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith([id(1)]);
    await userEvent.keyboard('{Enter}');
    expect(props.onCommit).toHaveBeenCalledWith([id(1)]);
  });

  it('deduplicates a same-tick page request and ignores its resolution after unmount', async () => {
    let resolvePage!: (page: TableEntrySearchResponse) => void;
    api.searchEntries
      .mockResolvedValueOnce({ results: results.results.slice(0, 1), hasMore: true })
      .mockImplementationOnce(
        () =>
          new Promise<TableEntrySearchResponse>((resolve) => {
            resolvePage = resolve;
          })
      );
    const { props, unmount } = setup();
    const more = await screen.findByRole('option', { name: 'Show more entries' });
    act(() => {
      fireEvent.click(more);
      fireEvent.click(more);
    });
    await waitFor(() => expect(api.searchEntries).toHaveBeenCalledTimes(2));
    unmount();
    await act(async () => resolvePage({ results: results.results.slice(1), hasMore: false }));
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('retries a failed search with Enter without committing the cell', async () => {
    api.searchEntries.mockRejectedValueOnce(new Error('Search is unavailable'));
    const { props } = setup();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Entry' } });
    await screen.findByRole('alert');
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('option', { name: 'Entry 1 Note 1' });
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(api.searchEntries).toHaveBeenCalledTimes(2);
  });

  it.each([null, id(2)])(
    'commits an untouched empty search without replacing %s with another result',
    async (value) => {
      const { props } = setup({ value });
      await screen.findByRole('option', { name: 'Entry 1 Note 1' });
      const input = screen.getByRole('combobox');
      expect(input).not.toHaveAttribute('aria-activedescendant');
      expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument();
      fireEvent.pointerMove(screen.getByRole('option', { name: 'Entry 1 Note 1' }));
      await userEvent.keyboard('{Enter}');
      expect(props.onChange).not.toHaveBeenCalled();
      expect(props.onCommit).toHaveBeenCalledWith(value);
    }
  );

  it('commits a multiple relation after an addition instead of linking the next result on Enter', async () => {
    const { props } = setup({ field: { ...relation, multiple: true }, value: [id(2)] });
    await userEvent.click(await screen.findByRole('option', { name: 'Entry 1 Note 1' }));
    expect(props.onChange).toHaveBeenCalledOnce();
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-activedescendant');
    await userEvent.keyboard('{Enter}');
    expect(props.onChange).toHaveBeenCalledOnce();
    expect(props.onCommit).toHaveBeenCalledWith([id(2), id(1)]);
  });

  it('clearing a typed search disarms Enter selection until an arrow is pressed', async () => {
    const { props } = setup({ value: id(2) });
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Entry' } });
    await screen.findByRole('option', { name: 'Entry 1 Note 1', selected: true });
    fireEvent.change(input, { target: { value: '' } });
    await screen.findByRole('option', { name: 'Entry 1 Note 1' });
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(props.onChange).toHaveBeenCalledWith(id(1));
  });

  it('cancels with Escape even during a search, while outside clicks leave it open', async () => {
    api.searchEntries.mockReturnValue(new Promise(() => undefined));
    const { props } = setup();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(document.body);
    expect(props.onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it('does not edit, reorder, commit, or cancel while blocked', async () => {
    const { props } = setup({
      field: { ...relation, multiple: true },
      value: [id(1), id(2)],
      busy: true,
      error: 'Saved row changed elsewhere',
    });
    const option = await screen.findByRole('option', { name: 'Entry 3 Note 3' });
    await userEvent.click(option);
    const search = screen.getByRole('combobox');
    expect(search).toHaveAttribute('readonly');
    fireEvent.keyDown(search, { key: 'Escape' });
    fireEvent.keyDown(search, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Remove Entry 1' })).toBeDisabled();
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Saved row changed elsewhere');
  });

  it('anchors the search outside row flow and follows the cell on scroll', async () => {
    const rect = vi
      .spyOn(HTMLDivElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(100, 200, 150, 36));
    const { container } = setup();
    const popup = screen.getByRole('combobox').parentElement;
    expect(container.contains(popup)).toBe(false);
    expect(popup).toHaveAttribute('data-keeps-cell', '');
    expect(popup).toHaveStyle({ left: '100px', top: '240px', width: '260px' });
    expect(screen.getByRole('combobox')).toHaveFocus();
    rect.mockReturnValue(new DOMRect(80, 160, 150, 36));
    fireEvent.scroll(window);
    expect(popup).toHaveStyle({ left: '80px', top: '200px' });
  });

  it('leaves chip rejection to its enclosing cell, including the search portal', async () => {
    const paneDrop = vi.fn();
    const onChange = vi.fn();
    render(
      <div onDrop={paneDrop}>
        <table>
          <tbody>
            <tr>
              <EntryCell field={relation} active>
                <RelationEntryPicker
                  field={relation}
                  value={null}
                  onChange={onChange}
                  onCommit={vi.fn()}
                  onCancel={vi.fn()}
                  busy={false}
                />
              </EntryCell>
            </tr>
          </tbody>
        </table>
      </div>
    );
    const dataTransfer = {
      types: [NODE_CHIP_MIME],
      getData: (type: string) =>
        type === NODE_CHIP_MIME
          ? JSON.stringify({ id: tableId, kind: 'table', title: 'Related table' })
          : '',
      dropEffect: 'copy',
      files: [],
    };
    // The floating search is marked so the pane never offers a split over it;
    // the enclosing cell alone decides what the drop means.
    expect(screen.getByRole('combobox').closest('[data-cell-picker-popover]')).toHaveAttribute(
      'data-pane-drop-target',
      'node-chip'
    );
    expect(fireEvent.drop(screen.getByRole('combobox'), { dataTransfer })).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Drop an entry from the related table here'
    );
    expect(paneDrop).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('entryLabel', () => {
  const entry: TableEntry = {
    id: id(1),
    createdAt: '2026-01-01T00:00:00.000000Z',
    revision: 'a'.repeat(64),
    values: { [title.id]: 'Entry 1' },
  };
  it('uses legacy text only when no title field exists', () => {
    expect(entryLabel(entry, [title])).toBe('Entry 1');
    expect(entryLabel(entry, [{ ...title, managed: true }])).toBe('Untitled');
    expect(entryLabel({ ...entry, values: { [title.id]: 'x'.repeat(101) } }, [title])).toBe(
      `${'x'.repeat(100)}…`
    );
  });
  it('keeps an unnamed title Untitled rather than borrowing another field', () => {
    const name = { ...title, id: 'field-1111111111111-name', isTitle: true };
    expect(entryLabel(entry, [title, name])).toBe('Untitled');
    expect(
      entryLabel({ ...entry, values: { ...entry.values, [name.id]: '  Named entry  ' } }, [
        title,
        name,
      ])
    ).toBe('Named entry');
  });
});
