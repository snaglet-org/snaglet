import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchError } from '@desktop/utils/api/core';
import { subscribeTableEvents, type TableEvent } from '@desktop/features/database/tableEvents';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  list: vi.fn(),
  hardDelete: vi.fn(),
  restore: vi.fn(),
  sweepAll: vi.fn(),
}));
const fieldApi = vi.hoisted(() => ({
  restoreField: vi.fn(),
  purgeField: vi.fn(),
}));
const feedback = vi.hoisted(() => ({ showToast: vi.fn() }));
const automationApi = vi.hoisted(() => ({ restore: vi.fn(), purge: vi.fn() }));
const automationStore = vi.hoisted(() => ({ upsert: vi.fn(), load: vi.fn() }));

vi.mock('@desktop/utils/api', () => ({ archiveApi: api, tablesApi: fieldApi }));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: automationApi }));
vi.mock('@desktop/features/automations/automationsStore', () => ({
  upsertAutomation: (...args: unknown[]) => automationStore.upsert(...args),
  loadAutomations: () => automationStore.load(),
}));
vi.mock('@desktop/utils/toast', () => feedback);
vi.mock('@desktop/utils/workspaceEvents.js', () => ({ emitLibraryEvent: vi.fn() }));

import { ArchivedDrawer } from './ArchivedDrawer';

const agentRoot = {
  id: 'agent-retired',
  type: 'agent',
  title: 'Retired Bot',
  archived: true,
  archived_at: '2026-07-06T00:00:00Z',
  container_id: null,
  sort_order: 0,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-06T00:00:00Z',
};

function renderDrawer() {
  return render(<ArchivedDrawer open onClose={() => undefined} />);
}

describe('ArchivedDrawer confirmations and feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue({ roots: [agentRoot], children: [] });
    api.hardDelete.mockResolvedValue({
      id: 'agent-retired',
      deleted: 1,
      was: agentRoot,
    });
    api.sweepAll.mockResolvedValue({
      result: { deletedContainers: 0, deletedOther: 0, deletedAgents: 1 },
      ranAt: '2026-07-06T00:00:00Z',
    });
  });

  it('cancels a single-item permanent delete without calling the API', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Retired Bot');

    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    await user.click(deleteButton);
    const dialog = screen.getByRole('dialog', { name: 'Permanently delete archived item?' });
    expect(dialog).toHaveTextContent('Retired Bot');
    expect(dialog).toHaveTextContent('agent');
    expect(dialog).toHaveTextContent('cannot be undone');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.hardDelete).not.toHaveBeenCalled();
    expect(await screen.findByText('Retired Bot')).toBeVisible();
    await waitFor(() => expect(deleteButton).toHaveFocus());
  });

  it('closes a confirmation with Escape without closing the archived-items drawer', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Retired Bot');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('dialog', { name: 'Permanently delete archived item?' })).toBeVisible();
    await user.keyboard('{Escape}');

    expect(api.hardDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Permanently delete archived item?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Archived items' })).toBeVisible();
  });

  it('confirms one permanent delete, refreshes, and gives human success feedback', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Retired Bot');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Permanently delete' }));

    await waitFor(() => expect(api.hardDelete).toHaveBeenCalledWith('agent-retired'));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(feedback.showToast).toHaveBeenCalledWith('Permanently deleted “Retired Bot”.');
  });

  it('shows a failed delete inline in the confirmation and keeps the drawer actionable after cancel', async () => {
    api.hardDelete.mockRejectedValueOnce(new Error('delete unavailable'));
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Retired Bot');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Permanently delete' }));

    // The rejection renders inline in the confirmation, which stays open
    // with both buttons re-enabled (retry or cancel).
    const dialog = screen.getByRole('dialog', { name: 'Permanently delete archived item?' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('delete unavailable');
    expect(screen.getByRole('button', { name: 'Permanently delete' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(feedback.showToast).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Permanently delete archived item?' })).toBeNull();
    expect(screen.getByText('Retired Bot')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('cancels a workspace sweep and states the authoritative listed count', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Retired Bot');

    await user.click(screen.getByRole('button', { name: 'Sweep' }));
    const dialog = screen.getByRole('dialog', { name: 'Sweep all archived items?' });
    expect(dialog).toHaveTextContent('1 archived item');
    expect(dialog).toHaveTextContent('across this workspace');
    expect(dialog).toHaveTextContent('cannot be undone');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.sweepAll).not.toHaveBeenCalled();
    expect(await screen.findByText('Retired Bot')).toBeVisible();
  });

  it('confirms a sweep and reports a human singular result without internal buckets', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Retired Bot');

    await user.click(screen.getByRole('button', { name: 'Sweep' }));
    await user.click(screen.getByRole('button', { name: 'Sweep permanently' }));

    await waitFor(() => expect(api.sweepAll).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(feedback.showToast).toHaveBeenCalledWith('Permanently deleted 1 archived item.');
    expect(feedback.showToast.mock.calls.flat().join(' ')).not.toMatch(/other node|agent\(s\)/i);
  });

  it('shows a failed sweep inline in the confirmation and keeps the drawer intact after cancel', async () => {
    api.sweepAll.mockRejectedValueOnce(new Error('sweep unavailable'));
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Retired Bot');

    await user.click(screen.getByRole('button', { name: 'Sweep' }));
    await user.click(screen.getByRole('button', { name: 'Sweep permanently' }));

    // The rejection renders inline in the confirmation, which stays open
    // with both buttons re-enabled (retry or cancel).
    const dialog = screen.getByRole('dialog', { name: 'Sweep all archived items?' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('sweep unavailable');
    expect(screen.getByRole('button', { name: 'Sweep permanently' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(feedback.showToast).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Sweep all archived items?' })).toBeNull();
    expect(screen.getByText('Retired Bot')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sweep' })).toBeEnabled();
  });

  it('re-reads the list when a sweep stops partway and shows why in the confirmation', async () => {
    const message =
      'Sweep stopped partway: out of shared memory. What it deleted stays deleted; sweep again to finish.';
    api.sweepAll.mockRejectedValueOnce(new Error(message));
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Retired Bot');
    api.list.mockResolvedValue({ roots: [], children: [] });

    await user.click(screen.getByRole('button', { name: 'Sweep' }));
    await user.click(screen.getByRole('button', { name: 'Sweep permanently' }));

    const dialog = screen.getByRole('dialog', { name: 'Sweep all archived items?' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(api.list).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText('Retired Bot')).toBeNull());
    expect(feedback.showToast).not.toHaveBeenCalled();
  });
});

describe('ArchivedDrawer — archived Database tables', () => {
  const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
  const LINKING_TABLE_ID = 'table-2222222222222-bbbbbbbbb';
  const tableRoot = {
    id: TABLE_ID,
    type: 'table',
    title: 'reading_list',
    archived: true,
    archived_at: '2026-07-06T00:00:00Z',
    container_id: null,
    sort_order: 0,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-06T00:00:00Z',
  };
  const restoredRow = (title: string) => ({
    ...tableRoot,
    title,
    archived: false,
    archived_at: null,
  });
  let tableEvents: TableEvent[] = [];
  let stop: () => void = () => undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue({ roots: [tableRoot], children: [] });
    tableEvents = [];
    stop = subscribeTableEvents((event) => tableEvents.push(event));
  });

  afterEach(() => stop());

  it('lists an archived table by name, with no TTL, alongside Restore and Delete', async () => {
    renderDrawer();
    const row = (await screen.findByText('reading_list')).closest('li');
    expect(row).not.toBeNull();
    const scoped = within(row as HTMLElement);
    expect(scoped.getByText('Kept until deleted')).toBeInTheDocument();
    expect(scoped.queryByText(/TTL/)).not.toBeInTheDocument();
    expect(scoped.getByRole('button', { name: 'Restore' })).toBeEnabled();
    expect(scoped.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('restores a table and announces it so the workspace tree shows it again', async () => {
    api.restore.mockResolvedValue({ node: restoredRow('reading_list'), affected: 1 });
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('reading_list');
    api.list.mockResolvedValue({ roots: [], children: [] });

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(api.restore).toHaveBeenCalledWith(TABLE_ID, {}));
    await waitFor(() =>
      expect(tableEvents).toEqual([
        {
          type: 'table.restored',
          table: {
            id: TABLE_ID,
            name: 'reading_list',
            origin: 'custom',
            projectId: null,

            sortOrder: 0,
            createdAt: tableRoot.created_at,
          },
        },
      ])
    );
    expect(await screen.findByText('Nothing archived. The trash is empty.')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Restore under a new name' })).toBeNull();
  });

  it('asks for a new name when the old one is taken, and restores under it', async () => {
    api.restore
      .mockRejectedValueOnce(
        new FetchError(
          'The name "reading_list" is taken by another table. Choose a new name to restore it.',
          409,
          {
            reason: 'nameTaken',
            names: [{ kind: 'table', id: TABLE_ID, tableId: TABLE_ID, name: 'reading_list' }],
          }
        )
      )
      .mockResolvedValueOnce({ node: restoredRow('reading_list_old'), affected: 1 });
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('reading_list');

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    const prompt = await screen.findByRole('dialog', { name: 'Restore under a new name' });
    expect(prompt).toHaveTextContent('is taken by another table');
    const input = within(prompt).getByRole('textbox', { name: 'New table name' });
    expect(input).toHaveValue('reading_list_restored');
    expect(tableEvents).toEqual([]);

    await user.clear(input);
    await user.type(input, 'Reading List-Old');
    // Capitals and spaces are fixed as typed; the `-` is left for the error.
    expect(input).toHaveValue('reading_list-old');
    expect(within(prompt).getByRole('alert')).toHaveTextContent('lowercase');
    await user.click(within(prompt).getByRole('button', { name: 'Restore' }));
    expect(api.restore).toHaveBeenCalledTimes(1);

    await user.clear(input);
    await user.type(input, 'reading_list_old{Enter}');

    await waitFor(() =>
      expect(api.restore).toHaveBeenLastCalledWith(TABLE_ID, { name: 'reading_list_old' })
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore under a new name' })).toBeNull()
    );
    expect(feedback.showToast).toHaveBeenCalledWith('Restored as “reading_list_old”.');
    expect(tableEvents).toEqual([
      {
        type: 'table.restored',
        table: {
          id: TABLE_ID,
          name: 'reading_list_old',
          origin: 'custom',
          projectId: null,

          sortOrder: 0,
          createdAt: tableRoot.created_at,
        },
      },
    ]);
  });

  it('keeps the rename prompt open with the reason when the new name is taken too', async () => {
    const taken = (name: string) =>
      new FetchError(
        `The name "${name}" is taken by another table. Choose a new name to restore it.`,
        409,
        {
          reason: 'nameTaken',
          names: [{ kind: 'table', id: TABLE_ID, tableId: TABLE_ID, name }],
        }
      );
    api.restore
      .mockRejectedValueOnce(taken('reading_list'))
      .mockRejectedValueOnce(taken('reading_list_restored'));
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('reading_list');

    await user.click(screen.getByRole('button', { name: 'Restore' }));
    const prompt = await screen.findByRole('dialog', { name: 'Restore under a new name' });
    await user.click(within(prompt).getByRole('button', { name: 'Restore' }));

    expect(await within(prompt).findByRole('alert')).toHaveTextContent(
      'The name "reading_list_restored" is taken'
    );
    expect(within(prompt).getByRole('textbox', { name: 'New table name' })).toHaveValue(
      'reading_list_restored'
    );
    expect(tableEvents).toEqual([]);

    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Restore under a new name' })).toBeNull();
    expect(screen.getByText('reading_list')).toBeVisible();
  });

  it('confirms deleting the relation fields that link to it, then retries with clearReferences', async () => {
    api.hardDelete
      .mockRejectedValueOnce(
        new FetchError(
          'A relation field links to reading_list: budget.book. Confirm to delete it with the table.',
          409,
          {
            linkedFields: [
              {
                tableId: LINKING_TABLE_ID,
                tableName: 'budget',
                fieldId: 'field-1',
                fieldName: 'book',
                state: 'active',
              },
            ],
          }
        )
      )
      .mockResolvedValueOnce({
        id: TABLE_ID,
        deleted: 1,
        was: tableRoot,
        deletedLinkedFields: [
          {
            tableId: LINKING_TABLE_ID,
            tableName: 'budget',
            fieldId: 'field-1',
            fieldName: 'book',
            state: 'active',
          },
        ],
      });
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('reading_list');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const first = screen.getByRole('dialog', { name: 'Permanently delete archived item?' });
    expect(first).toHaveTextContent('Delete the table “reading_list” from Archived.');
    expect(first).toHaveTextContent('every entry in it');
    await user.click(screen.getByRole('button', { name: 'Permanently delete' }));

    const references = await screen.findByRole('dialog', {
      name: 'Delete linked relation fields too?',
    });
    expect(api.hardDelete).toHaveBeenCalledTimes(1);
    expect(api.hardDelete).toHaveBeenCalledWith(TABLE_ID);
    expect(screen.queryByRole('dialog', { name: 'Permanently delete archived item?' })).toBeNull();
    expect(references).toHaveTextContent('Other tables link to “reading_list”');
    expect(within(references).getByText('budget.book')).toBeInTheDocument();
    expect(references).toHaveTextContent('also deletes these fields');
    expect(tableEvents).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Delete table and fields' }));

    await waitFor(() =>
      expect(api.hardDelete).toHaveBeenLastCalledWith(TABLE_ID, { clearReferences: true })
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Delete linked relation fields too?' })
      ).toBeNull()
    );
    expect(feedback.showToast).toHaveBeenCalledWith('Permanently deleted “reading_list”.');
    expect(tableEvents).toEqual([
      { type: 'table.removed', tableId: TABLE_ID, state: 'deleted' },
      { type: 'table.fields.changed', tableId: LINKING_TABLE_ID },
    ]);
  });

  it('canceling the references confirm deletes nothing', async () => {
    api.hardDelete.mockRejectedValueOnce(
      new FetchError('A relation field links to reading_list: budget.book.', 409, {
        linkedFields: [
          { tableId: LINKING_TABLE_ID, tableName: 'budget', fieldId: 'field-1', fieldName: 'book' },
        ],
      })
    );
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('reading_list');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Permanently delete' }));
    await screen.findByRole('dialog', { name: 'Delete linked relation fields too?' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog', { name: 'Delete linked relation fields too?' })).toBeNull();
    expect(api.hardDelete).toHaveBeenCalledTimes(1);
    expect(screen.getByText('reading_list')).toBeVisible();
    expect(tableEvents).toEqual([]);
  });

  it('deletes an unlinked table in one confirm and announces it gone', async () => {
    api.hardDelete.mockResolvedValue({
      id: TABLE_ID,
      deleted: 1,
      was: tableRoot,
      deletedLinkedFields: [],
    });
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('reading_list');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Permanently delete' }));

    await waitFor(() =>
      expect(feedback.showToast).toHaveBeenCalledWith('Permanently deleted “reading_list”.')
    );
    expect(api.hardDelete).toHaveBeenCalledWith(TABLE_ID);
    expect(tableEvents).toEqual([{ type: 'table.removed', tableId: TABLE_ID, state: 'deleted' }]);
  });
});

describe('ArchivedDrawer — archived Database table columns', () => {
  const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
  const FIELD_ID = 'field-1111111111111-aaaaaaaaa';
  const tableRoot = {
    id: TABLE_ID,
    type: 'table',
    title: 'reading_list',
    archived: true,
    archived_at: '2026-07-06T00:00:00Z',
    container_id: null,
    sort_order: 0,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-06T00:00:00Z',
  };
  /** A column of an active table: a root titled `table › column`. */
  const fieldRoot = {
    id: FIELD_ID,
    type: 'table_field',
    title: 'reading_list › notes',
    archived: true,
    archived_at: '2026-07-05T00:00:00Z',
    container_id: TABLE_ID,
    sort_order: 3,
    created_at: '2026-07-05T00:00:00Z',
    updated_at: '2026-07-05T00:00:00Z',
  };
  const restoredField = {
    id: FIELD_ID,
    tableId: TABLE_ID,
    columnName: 'notes',
    name: 'notes',
    description: null,
    type: 'text',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    position: 3,
    managed: false,
    revision: 2,
    collapsed: false,
    isTitle: false,
    multiple: false,
    options: null,
  };
  let tableEvents: TableEvent[] = [];
  let stop: () => void = () => undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue({ roots: [fieldRoot], children: [] });
    fieldApi.restoreField.mockResolvedValue({
      field: restoredField,
      changed: true,
      madeOptional: false,
    });
    fieldApi.purgeField.mockResolvedValue({ field: restoredField, changed: true });
    tableEvents = [];
    stop = subscribeTableEvents((event) => tableEvents.push(event));
  });

  afterEach(() => stop());

  it('lists a column of an active table as “table › column”, kept until deleted', async () => {
    renderDrawer();
    const row = (await screen.findByText('reading_list › notes')).closest('li');
    expect(row).not.toBeNull();
    const scoped = within(row as HTMLElement);
    expect(scoped.getByText('Kept until deleted')).toBeInTheDocument();
    expect(scoped.getByRole('button', { name: 'Restore' })).toBeEnabled();
    expect(scoped.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('nests a column under its archived table', async () => {
    api.list.mockResolvedValue({
      roots: [tableRoot],
      children: [{ ...fieldRoot, title: 'notes' }],
    });
    renderDrawer();
    await screen.findByText('reading_list');
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('reading_list');
    expect(rows[1]).toHaveTextContent('notes');
    expect(rows[1]).toHaveStyle({ paddingLeft: '28px' });
  });

  it('restores a column through the table field route and tells the table panes', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('reading_list › notes');
    api.list.mockResolvedValue({ roots: [], children: [] });

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(fieldApi.restoreField).toHaveBeenCalledWith(TABLE_ID, FIELD_ID, {}));
    expect(api.restore).not.toHaveBeenCalled();
    expect(tableEvents).toEqual([{ type: 'table.fields.changed', tableId: TABLE_ID }]);
    expect(await screen.findByText('Nothing archived. The trash is empty.')).toBeVisible();
  });

  it('asks for a new column name when the old one is taken, and restores under it', async () => {
    fieldApi.restoreField
      .mockRejectedValueOnce(
        new FetchError(
          'The name "notes" is taken by another field. Choose a new name to restore it.',
          409,
          {
            reason: 'nameTaken',
            names: [{ kind: 'field', id: FIELD_ID, tableId: TABLE_ID, name: 'notes' }],
          }
        )
      )
      .mockResolvedValueOnce({
        field: { ...restoredField, name: 'notes_restored' },
        changed: true,
        madeOptional: false,
      });
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('reading_list › notes');

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    const dialog = await screen.findByRole('dialog', { name: 'Restore under a new name' });
    expect(dialog).toHaveTextContent('The name "notes" is taken by another field.');
    const input = within(dialog).getByLabelText('New column name');
    expect(input).toHaveValue('notes_restored');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() =>
      expect(fieldApi.restoreField).toHaveBeenLastCalledWith(TABLE_ID, FIELD_ID, {
        name: 'notes_restored',
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore under a new name' })).toBeNull()
    );
    expect(feedback.showToast).toHaveBeenCalledWith('Restored as “notes_restored”.');
    expect(tableEvents).toEqual([{ type: 'table.fields.changed', tableId: TABLE_ID }]);
  });

  it('deletes a column for good after one confirm and tells the table panes', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('reading_list › notes');
    api.list.mockResolvedValue({ roots: [], children: [] });

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Permanently delete archived item?' });
    expect(dialog).toHaveTextContent('Delete the column “reading_list › notes” from Archived.');
    expect(dialog).toHaveTextContent('drops the column and every value in it');
    await user.click(screen.getByRole('button', { name: 'Permanently delete' }));

    await waitFor(() => expect(fieldApi.purgeField).toHaveBeenCalledWith(TABLE_ID, FIELD_ID));
    expect(api.hardDelete).not.toHaveBeenCalled();
    expect(tableEvents).toEqual([{ type: 'table.fields.changed', tableId: TABLE_ID }]);
    expect(await screen.findByText('Nothing archived. The trash is empty.')).toBeVisible();
    expect(feedback.showToast).toHaveBeenCalledWith('Permanently deleted “reading_list › notes”.');
  });
});

describe('ArchivedDrawer — archived (deleted) automations', () => {
  const AUTOMATION_ID = 'automation-1111111111111-aaaaaaaaa';
  const automationRoot = {
    id: AUTOMATION_ID,
    type: 'automation',
    title: 'Morning check',
    archived: true,
    archived_at: '2026-07-06T00:00:00Z',
    container_id: null,
    project_id: null,
    sort_order: 0,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-06T00:00:00Z',
  };
  const restored = { id: AUTOMATION_ID, name: 'Morning check', status: 'paused' };

  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue({ roots: [automationRoot], children: [] });
    automationApi.restore.mockResolvedValue({ automation: restored });
    automationApi.purge.mockResolvedValue({
      automation: { ...restored, status: 'cancelled' },
    });
    automationStore.load.mockResolvedValue(undefined);
  });

  it('lists a deleted automation by name, kept until deleted, with Restore and Delete', async () => {
    renderDrawer();
    const row = (await screen.findByText('Morning check')).closest('li');
    expect(row).not.toBeNull();
    const scoped = within(row as HTMLElement);
    expect(scoped.getByText('Kept until deleted')).toBeInTheDocument();
    expect(scoped.queryByText(/TTL/)).not.toBeInTheDocument();
    expect(scoped.getByRole('button', { name: 'Restore' })).toHaveAttribute(
      'title',
      expect.stringContaining('as it was')
    );
    expect(scoped.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('restores it through the automations route, as it was, and puts it back in the shared list', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Morning check');
    api.list.mockResolvedValue({ roots: [], children: [] });

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(automationApi.restore).toHaveBeenCalledWith(AUTOMATION_ID));
    expect(api.restore).not.toHaveBeenCalled();
    expect(automationStore.upsert).toHaveBeenCalledWith(restored);
    expect(await screen.findByText('Nothing archived. The trash is empty.')).toBeVisible();
  });

  it("shows why a restore was refused (the agent's active limit) and keeps the row", async () => {
    automationApi.restore.mockRejectedValueOnce(
      new FetchError(
        'Test Agent A already has 10 active automations. Pause or cancel one first.',
        409
      )
    );
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Morning check');

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(await screen.findByText(/already has 10 active automations/)).toBeVisible();
    expect(screen.getByText('Morning check')).toBeVisible();
    expect(automationStore.upsert).not.toHaveBeenCalled();
  });

  it('deletes it for good after one confirm, through the automations route', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Morning check');
    api.list.mockResolvedValue({ roots: [], children: [] });

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Permanently delete archived item?' });
    expect(dialog).toHaveTextContent('Delete the automation “Morning check” from Archived.');
    expect(dialog).toHaveTextContent('its run log');
    await user.click(screen.getByRole('button', { name: 'Permanently delete' }));

    await waitFor(() => expect(automationApi.purge).toHaveBeenCalledWith(AUTOMATION_ID));
    expect(api.hardDelete).not.toHaveBeenCalled();
    expect(automationStore.load).toHaveBeenCalled();
    expect(await screen.findByText('Nothing archived. The trash is empty.')).toBeVisible();
    expect(feedback.showToast).toHaveBeenCalledWith('Permanently deleted “Morning check”.');
  });

  it('counts swept automations in the sweep result and re-reads the shared list', async () => {
    api.sweepAll.mockResolvedValue({
      result: { deletedContainers: 0, deletedOther: 0, deletedAutomations: 1 },
      ranAt: '2026-07-06T00:00:00Z',
    });
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('Morning check');
    api.list.mockResolvedValue({ roots: [], children: [] });

    await user.click(screen.getByRole('button', { name: 'Sweep' }));
    await user.click(screen.getByRole('button', { name: 'Sweep permanently' }));

    await waitFor(() =>
      expect(feedback.showToast).toHaveBeenCalledWith('Permanently deleted 1 archived item.')
    );
    expect(automationStore.load).toHaveBeenCalled();
  });
});
