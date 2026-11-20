import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateTableEntryRequest,
  TableEntriesQuery,
  TableEntriesResponse,
  TableEntry,
  TableEntryResponse,
  TableField,
  UpdateTableEntryRequest,
} from '@snaglet/shared/types';
import { subscribeTableEvents } from '@desktop/features/database';
import { FetchError } from '@desktop/utils/api';
import { TOAST_EVENT_NAME, type ToastDetail } from '@desktop/utils/toast';
import { TableBoard } from './TableBoard';

const api = vi.hoisted(() => ({
  entries: vi.fn<(id: string, query: TableEntriesQuery) => Promise<TableEntriesResponse>>(),
  updateEntry:
    vi.fn<
      (id: string, entryId: string, request: UpdateTableEntryRequest) => Promise<TableEntryResponse>
    >(),
  createEntry:
    vi.fn<(id: string, request: CreateTableEntryRequest) => Promise<TableEntryResponse>>(),
  history: vi.fn<(limit?: number) => Promise<unknown>>(),
}));
vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return { ...actual, tablesApi: { ...actual.tablesApi, ...api } };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const schemaVersion = 'a'.repeat(64);
const name: TableField = {
  range: false,
  id: 'field-1111111111111-name',
  tableId,
  columnName: 'name',
  name: 'Name',
  description: null,
  type: 'text',
  nullable: false,
  defaultValue: '',
  referenceTableId: null,
  referenceKind: null,
  options: null,
  multiple: false,
  position: 0,
  managed: false,
  collapsed: false,
  isTitle: true,
  revision: 1,
};
const status: TableField = {
  ...name,
  id: 'field-1111111111111-status',
  columnName: 'status',
  name: 'Status',
  type: 'select',
  nullable: true,
  defaultValue: null,
  isTitle: false,
  position: 1,
  options: [
    { id: 'opt-todo', label: 'To do', color: 'gray' },
    { id: 'opt-doing', label: 'Doing', color: 'blue' },
    { id: 'opt-done', label: 'Done', color: 'green' },
  ],
};
const due: TableField = {
  ...name,
  id: 'field-1111111111111-due',
  columnName: 'due',
  name: 'Due',
  type: 'date',
  nullable: true,
  defaultValue: null,
  isTitle: false,
  position: 2,
};
const fields = [name, status, due];

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const row = (n: number, values: TableEntry['values']): TableEntry => ({
  id: id(n),
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: `rev-${n}`,
  values: { [name.id]: `Entry ${n}`, [status.id]: null, [due.id]: null, ...values },
});

let rows: TableEntry[];

function page(): TableEntriesResponse {
  return {
    entries: rows,
    fields,
    totalCount: rows.length,
    page: 1,
    pageSize: 25,
    schemaVersion,
    relatedEntries: {},
    relatedItems: {},
  };
}

function column(label: string) {
  return screen.getByRole('region', { name: new RegExp(`^${label} \\(`) });
}

function card(label: string) {
  return screen.getByRole('button', { name: `Open ${label}` }).closest('li')!;
}

function setup() {
  const onOpenEntry = vi.fn();
  render(<TableBoard tableId={tableId} field={status} fields={fields} onOpenEntry={onOpenEntry} />);
  return { onOpenEntry };
}

async function loaded() {
  await screen.findByRole('button', { name: 'Open Entry 1' });
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  rows = [
    row(1, { [status.id]: 'To do', [due.id]: '2026-10-20' }),
    row(2, { [status.id]: 'Done' }),
    row(3, {}),
  ];
  api.entries.mockImplementation(async () => page());
  api.updateEntry.mockImplementation(async (_id, entryId, request) => {
    const current = rows.find((entry) => entry.id === entryId)!;
    const entry = {
      ...current,
      revision: `${current.revision}+`,
      values: { ...current.values, ...request.values },
    };
    rows = rows.map((item) => (item.id === entryId ? entry : item));
    return { entry, schemaVersion, relatedEntries: {}, relatedItems: {} };
  });
  api.createEntry.mockImplementation(async (_id, request) => {
    const entry: TableEntry = {
      id: request.id,
      createdAt: '2026-01-02T00:00:00.000000Z',
      revision: 'rev-new',
      values: request.values,
    };
    rows = [...rows, entry];
    return { entry, schemaVersion, relatedEntries: {}, relatedItems: {} };
  });
  document.elementFromPoint = () => null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TableBoard', () => {
  it('groups rows into one column per option, in order, plus "No Status"', async () => {
    setup();
    await loaded();
    const regions = screen.getAllByRole('region');
    expect(regions.map((region) => region.getAttribute('aria-label'))).toEqual([
      'To do (1)',
      'Doing (0)',
      'Done (1)',
      'No Status (1)',
    ]);
    expect(within(column('To do')).getByRole('button', { name: 'Open Entry 1' })).toBeVisible();
    expect(within(column('Done')).getByRole('button', { name: 'Open Entry 2' })).toBeVisible();
    expect(within(column('No Status')).getByRole('button', { name: 'Open Entry 3' })).toBeVisible();
    // Other filled-in fields read compactly under the title; the grouping field does not.
    const first = card('Entry 1');
    expect(within(first).getByText('Due')).toBeInTheDocument();
    expect(within(first).queryByText('Status')).not.toBeInTheDocument();
    expect(within(card('Entry 3')).queryByText('Due')).not.toBeInTheDocument();
    expect(screen.getByText('Grouped by')).toBeInTheDocument();
  });

  it('shows a date range on its card as the grid does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
    const when: TableField = { ...due, range: true };
    rows = [row(1, { [status.id]: 'To do', [due.id]: '2026-10-12/2026-10-15' })];
    api.entries.mockImplementation(async () => ({ ...page(), fields: [name, status, when] }));
    render(
      <TableBoard
        tableId={tableId}
        field={status}
        fields={[name, status, when]}
        onOpenEntry={vi.fn()}
      />
    );
    await loaded();
    const shown = within(card('Entry 1')).getByText('Oct 12 – 15');
    expect(shown.parentElement).toHaveAttribute('title', 'October 12 to October 15');
    expect(within(card('Entry 1')).getByText('October 12 to October 15')).toBeInTheDocument();
  });

  it('"+ New" under a column creates an entry with that option preset', async () => {
    setup();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'New entry in Doing' }));
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    expect(api.createEntry).toHaveBeenCalledWith(tableId, {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      values: { [name.id]: '', [status.id]: 'Doing', [due.id]: null },
      schemaVersion,
    });
    await waitFor(() =>
      expect(within(column('Doing')).getByRole('button', { name: 'Open Untitled 4' })).toBeVisible()
    );
    // The no-value column presets null.
    await userEvent.click(screen.getByRole('button', { name: 'New entry in No Status' }));
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(2));
    expect(api.createEntry.mock.calls[1]?.[1].values[status.id]).toBeNull();
  });

  it('dropping a card on another column writes that field with the row revision', async () => {
    setup();
    await loaded();
    const events: string[] = [];
    const unsubscribe = subscribeTableEvents((event) => events.push(event.type));
    const source = card('Entry 1');
    const target = column('Done');
    document.elementFromPoint = () => target;

    fireEvent.pointerDown(source, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 20, pointerId: 1 });
    // Past the threshold the card is a drag: the pointer's column is the target.
    expect(target).toHaveAttribute('data-board-drop-target');
    expect(document.querySelector('[data-board-card-ghost]')).not.toBeNull();
    fireEvent.pointerUp(window, { clientX: 400, clientY: 20, pointerId: 1 });

    // Optimistic: the card is in Done before the server answers.
    expect(within(column('Done')).getByRole('button', { name: 'Open Entry 1' })).toBeVisible();
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
    expect(api.updateEntry).toHaveBeenCalledWith(tableId, id(1), {
      values: { [status.id]: 'Done' },
      schemaVersion,
      expectedRevision: 'rev-1',
    });
    await waitFor(() => expect(events).toContain('table.entries.changed'));
    expect(within(column('Done')).getByRole('button', { name: 'Open Entry 1' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Done (2)' })).toBeInTheDocument();
    expect(document.querySelector('[data-board-card-ghost]')).toBeNull();
    expect(target).not.toHaveAttribute('data-board-drop-target');
    unsubscribe();
  });

  it('a drop on the "No Status" column clears the field', async () => {
    setup();
    await loaded();
    const target = column('No Status');
    document.elementFromPoint = () => target;
    fireEvent.pointerDown(card('Entry 2'), { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 20, pointerId: 1 });
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
    expect(api.updateEntry.mock.calls[0]?.[2].values).toEqual({ [status.id]: null });
  });

  it('the Move menu moves a card without a pointer', async () => {
    setup();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Move Entry 3' }));
    const menu = await screen.findByRole('menu', { name: 'Move Entry 3 to' });
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.getAttribute('aria-checked'))
    ).toEqual(['false', 'false', 'false', 'true']);
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Doing' }));
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
    expect(api.updateEntry).toHaveBeenCalledWith(tableId, id(3), {
      values: { [status.id]: 'Doing' },
      schemaVersion,
      expectedRevision: 'rev-3',
    });
    await waitFor(() =>
      expect(within(column('Doing')).getByRole('button', { name: 'Open Entry 3' })).toBeVisible()
    );
  });

  it('a repeating row moved to Done that the server advances says so with Undo', async () => {
    const repeatingDue = {
      ...due,
      recurrence: {
        statusFieldId: status.id,
        doneOptionIds: ['opt-done'],
        resetOptionId: 'opt-todo',
      },
    } as TableField;
    const repeatingFields = [name, status, repeatingDue];
    api.entries.mockImplementation(async () => ({ ...page(), fields: repeatingFields }));
    // Done logs the occurrence, moves the date on a week and resets the status.
    api.updateEntry.mockImplementation(async (_id, entryId) => {
      const current = rows.find((item) => item.id === entryId)!;
      const entry = {
        ...current,
        revision: `${current.revision}+`,
        values: { ...current.values, [status.id]: 'To do', [due.id]: '2026-10-27' },
      };
      rows = rows.map((item) => (item.id === entryId ? entry : item));
      return { entry, schemaVersion, relatedEntries: {}, relatedItems: {} };
    });
    api.history.mockResolvedValue({ undo: null, redo: null });
    const toasts: string[] = [];
    const listener = (e: Event) => toasts.push((e as CustomEvent<ToastDetail>).detail.message);
    window.addEventListener(TOAST_EVENT_NAME, listener);
    try {
      render(
        <TableBoard
          tableId={tableId}
          field={status}
          fields={repeatingFields}
          onOpenEntry={vi.fn()}
        />
      );
      await loaded();
      await userEvent.click(screen.getByRole('button', { name: 'Move Entry 1' }));
      const menu = await screen.findByRole('menu', { name: 'Move Entry 1 to' });
      await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Done' }));
      await waitFor(() =>
        expect(toasts).toContain(
          "Entry 1 done for Tue, Oct 20 · next Tue, Oct 27. To undo it, use the table's history."
        )
      );
      expect(within(column('To do')).getByRole('button', { name: 'Open Entry 1' })).toBeVisible();
    } finally {
      window.removeEventListener(TOAST_EVENT_NAME, listener);
    }
  });

  it('a refused move puts the card back and says why', async () => {
    api.updateEntry.mockRejectedValue(new FetchError('Entry changed elsewhere', 409));
    setup();
    await loaded();
    const target = column('Done');
    document.elementFromPoint = () => target;
    fireEvent.pointerDown(card('Entry 1'), { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 20, pointerId: 1 });
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed elsewhere/);
    expect(within(column('To do')).getByRole('button', { name: 'Open Entry 1' })).toBeVisible();
    // A 409 means the page is stale: the Board re-reads it.
    await waitFor(() => expect(api.entries.mock.calls.length).toBeGreaterThan(1));
  });

  it('opens an entry from its title, but not after a drag', async () => {
    const { onOpenEntry } = setup();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Open Entry 2' }));
    expect(onOpenEntry).toHaveBeenCalledWith(id(2));

    const target = column('Done');
    document.elementFromPoint = () => target;
    const title = screen.getByRole('button', { name: 'Open Entry 1' });
    fireEvent.pointerDown(title, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 20, pointerId: 1 });
    fireEvent.click(title);
    expect(onOpenEntry).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  });

  it('Escape cancels a drag in flight', async () => {
    setup();
    await loaded();
    const target = column('Done');
    document.elementFromPoint = () => target;
    fireEvent.pointerDown(card('Entry 1'), { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 20, pointerId: 1 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 20, pointerId: 1 });
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(target).not.toHaveAttribute('data-board-drop-target');
    expect(within(column('To do')).getByRole('button', { name: 'Open Entry 1' })).toBeVisible();
  });
});
