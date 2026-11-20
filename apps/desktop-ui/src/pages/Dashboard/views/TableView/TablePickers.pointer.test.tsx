/**
 * The table cell pickers (select options, relation targets) highlight a choice
 * on hover only after the pointer really moves: choices that appear or shift
 * under a resting pointer after typing must not take Enter. An untouched empty
 * search still never highlights on hover, so Enter there commits unchanged.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RelatedTableItems,
  TableField,
  TableReferenceSearchResponse,
  TableSelectOption,
} from '@snaglet/shared/types';

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

import { RelationEntryPicker } from './RelationEntryPicker';
import { SelectEntryPicker } from './SelectEntryPicker';

/** What a browser sends when choices appear or move under a resting pointer. */
function contentAppearsUnder(element: HTMLElement, clientX: number, clientY: number) {
  fireEvent.pointerOver(element, { clientX, clientY });
  fireEvent.pointerEnter(element, { clientX, clientY });
  fireEvent.pointerMove(element, { clientX, clientY });
  fireEvent.pointerMove(element, { clientX, clientY });
}

function moveAcross(element: HTMLElement, clientX = 100, clientY = 80) {
  fireEvent.pointerMove(element, { clientX, clientY });
  fireEvent.pointerMove(element, { clientX: clientX + 4, clientY: clientY + 3 });
}

const option = (name: string | RegExp) => screen.getByRole('option', { name });

describe('SelectEntryPicker: a pointer that has not moved', () => {
  const options: TableSelectOption[] = [
    { id: 'opt-todo', label: 'To do', color: 'gray' },
    { id: 'opt-progress', label: 'In progress', color: 'blue' },
    { id: 'opt-done', label: 'Done', color: 'green' },
  ];
  const field: TableField = {
    range: false,
    id: 'field-1111111111111-aaaaaaaaa',
    tableId: 'table-1111111111111-aaaaaaaaa',
    columnName: 'status',
    name: 'Status',
    type: 'select',
    description: null,
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    options,
    multiple: false,
    position: 0,
    managed: false,
    collapsed: false,
    isTitle: false,
    revision: 1,
  };

  function setup() {
    const props = {
      field,
      value: null,
      onChange: vi.fn(),
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      busy: false,
      autoFocus: true,
    };
    render(<SelectEntryPicker {...props} />);
    return { props, input: screen.getByRole('combobox', { name: 'Find Status' }) };
  }

  it('cannot take the highlight after typing, so Enter picks the first match', async () => {
    const { props, input } = setup();
    await userEvent.type(input, 'o');

    contentAppearsUnder(option('Done'), 100, 80);
    expect(option('To do')).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    expect(props.onCommit).toHaveBeenCalledWith('To do');
  });

  it('cannot take it after the search changes either', async () => {
    const { input } = setup();
    await userEvent.type(input, 'o');
    moveAcross(option('Done'));
    expect(option('Done')).toHaveAttribute('aria-selected', 'true');

    await userEvent.type(input, ' ');
    expect(option('To do')).toHaveAttribute('aria-selected', 'true');
    contentAppearsUnder(option('Done'), 104, 83);
    expect(option('To do')).toHaveAttribute('aria-selected', 'true');
  });

  it('still follows a real move and the arrow keys after typing', async () => {
    const { props, input } = setup();
    await userEvent.type(input, 'o');
    moveAcross(option('Done'));
    expect(option('Done')).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowUp}{Enter}');
    expect(props.onCommit).toHaveBeenCalledWith('In progress');
  });

  it('never highlights on hover with an untouched empty search, so Enter commits unchanged', async () => {
    const { props } = setup();
    moveAcross(option('Done'));
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onCommit).toHaveBeenCalledWith(null);
  });
});

describe('RelationEntryPicker: a pointer that has not moved', () => {
  const doc = (n: number) => `doc-1111111111111-${String(n).padStart(9, 'a')}`;
  const field: TableField = {
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
  const page = (count: number): TableReferenceSearchResponse => ({
    results: Array.from({ length: count }, (_, index) => ({
      id: doc(index + 1),
      title: `Brief ${index + 1}`,
      context: null,
    })),
    hasMore: false,
  });

  beforeEach(() => {
    search.mockReset();
    search.mockResolvedValue(page(3));
  });

  async function typed(query: string) {
    const props = {
      field,
      value: null,
      relatedItems: {} as RelatedTableItems,
      onChange: vi.fn(),
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      busy: false,
      autoFocus: true,
    };
    render(<RelationEntryPicker {...props} />);
    await screen.findByRole('option', { name: 'Brief 3' });
    const input = screen.getByRole('combobox', { name: 'Search briefs' });
    fireEvent.change(input, { target: { value: query } });
    // The typed search is debounced; let it land.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
    await screen.findByRole('option', { name: 'Brief 3' });
    return { props, input };
  }

  it('cannot take the highlight after typing, so Enter links the first match', async () => {
    const { props, input } = await typed('brief');

    contentAppearsUnder(option('Brief 3'), 100, 80);
    expect(option('Brief 1')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onCommit).toHaveBeenCalledWith(doc(1));
  });

  it('still follows a real move and the arrow keys after typing', async () => {
    const { props, input } = await typed('brief');
    moveAcross(option('Brief 3'));
    expect(option('Brief 3')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onCommit).toHaveBeenCalledWith(doc(2));
  });
});
