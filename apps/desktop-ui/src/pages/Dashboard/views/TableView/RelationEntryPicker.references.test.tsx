import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RelatedTableItems,
  TableField,
  TableReferenceSearchResponse,
} from '@snaglet/shared/types';
import { __resetSnagletItemTitlesForTests } from '@desktop/features/table-entries/snagletItemTitles';
import { TableEntryValueView } from './TableEntryValueView';
import { RelationEntryPicker } from './RelationEntryPicker';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});
const search = vi.hoisted(() => vi.fn());
vi.mock('@desktop/utils/api/tableReferences', () => ({ tableReferencesApi: { search } }));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, containersApi: { ...actual.containersApi, listTree: async () => [] } };
});

const doc = (n: number) => `doc-1111111111111-${String(n).padStart(9, 'a')}`;
const owners: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId: 'table-1111111111111-aaaaaaaaa',
  columnName: 'briefs',
  name: 'briefs',
  description: null,
  type: 'relation',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: 'doc',
  position: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
  revision: 1,
};
const list: TableField = { ...owners, multiple: true, nullable: false, defaultValue: [] };
const page = (from: number, count: number, hasMore = false): TableReferenceSearchResponse => ({
  results: Array.from({ length: count }, (_, index) => ({
    id: doc(from + index),
    title: `Brief ${from + index}`,
    context: from + index === 1 ? null : 'Test Project',
  })),
  hasMore,
});

function setup(overrides: Partial<Parameters<typeof RelationEntryPicker>[0]> = {}) {
  const props = {
    field: owners,
    value: null,
    relatedItems: {} as RelatedTableItems,
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
  __resetSnagletItemTitlesForTests();
  search.mockResolvedValue(page(1, 3));
});
afterEach(() => {
  __resetSnagletItemTitlesForTests();
  vi.useRealTimers();
});

describe('RelationEntryPicker for Snaglet items', () => {
  it('searches the field kind, listing titles with their container as a second line', async () => {
    setup();
    await screen.findByRole('option', { name: 'Brief 2 Test Project' });
    expect(screen.getByRole('option', { name: 'Brief 1' })).toBeInTheDocument();
    expect(search).toHaveBeenCalledWith({ kind: 'doc', q: '', limit: 20, offset: 0, exclude: [] });
    expect(screen.getByRole('combobox', { name: 'Search briefs' })).toHaveAttribute(
      'placeholder',
      'Find a doc…'
    );
    expect(screen.getByRole('listbox', { name: 'Docs for briefs' })).toBeInTheDocument();
  });

  it('debounces typing and excludes the linked ids exactly', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup({ field: list, value: [doc(2)] });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(search).toHaveBeenLastCalledWith({
      kind: 'doc',
      q: '',
      limit: 20,
      offset: 0,
      exclude: [doc(2)],
    });
    search.mockClear();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bri' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'brief' } });
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(search).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ q: 'brief' }));
  });

  it('picks by keyboard and names the chip before any page reload', async () => {
    const { props } = setup();
    await screen.findByRole('option', { name: 'Brief 1' });
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(props.onChange).toHaveBeenLastCalledWith(doc(2));
    expect(props.onCommit).toHaveBeenLastCalledWith(doc(2));
    expect(screen.getByRole('button', { name: 'Remove Brief 2' })).toBeInTheDocument();
    // The cell that shows the committed value reads the same title.
    render(<TableEntryValueView field={owners} value={doc(2)} relatedItems={{}} />);
    expect(screen.getAllByText('Brief 2').length).toBeGreaterThan(0);
  });

  it('pages with Show more while the server has more', async () => {
    search.mockResolvedValueOnce(page(1, 2, true)).mockResolvedValueOnce(page(3, 1));
    setup({ field: list, value: [] });
    await userEvent.click(await screen.findByRole('option', { name: 'Show more docs' }));
    await screen.findByRole('option', { name: 'Brief 3 Test Project' });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 2 }));
    expect(screen.queryByRole('option', { name: 'Show more docs' })).not.toBeInTheDocument();
  });

  it('keeps archived and purged links removable, and multiple picks stay open', async () => {
    const related: RelatedTableItems = {
      doc: { [doc(5)]: { title: 'Old brief', archived: true } },
    };
    const { props } = setup({ field: list, value: [doc(5), doc(9)], relatedItems: related });
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Old brief').closest('.md-chip')).toHaveClass('md-chip-archived');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Unavailable' }));
    expect(props.onChange).toHaveBeenLastCalledWith([doc(5)]);
    await userEvent.click(await screen.findByRole('option', { name: 'Brief 1' }));
    expect(props.onChange).toHaveBeenLastCalledWith([doc(5), doc(1)]);
    expect(props.onCommit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({ exclude: [doc(1), doc(5)] })
      )
    );
  });

  it('shows a search failure with a retry', async () => {
    search.mockRejectedValueOnce(new Error('kind must be one of doc, agent.'));
    setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('kind must be one of doc, agent.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('option', { name: 'Brief 1' });
  });
});
