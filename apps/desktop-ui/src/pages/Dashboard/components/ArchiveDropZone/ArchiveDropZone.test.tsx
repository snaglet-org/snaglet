/**
 * ArchiveDropZone, the sidebar Trash drop target. Agents have their own
 * `archived` column and POST /api/archive/:id routes an agent id to the
 * agents-table archive, so dropping an agent card on the trash archives it.
 * This suite pins that `partitionArchivable` keeps 'agent' and the drop
 * reaches archiveApi.archive; an unarchivable kind still shows a notice.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveApi, FetchError, hooksWorkspacesApi, tablesApi } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { showToast } from '@desktop/utils/toast';
import { NODE_CHIP_MIME, setActiveDragChip, type NodeChipData } from '@desktop/utils/nodeChip';
import { subscribeTableEvents, type TableEvent } from '@desktop/features/database/tableEvents';
import {
  __setActiveTableFieldDragForTests,
  TABLE_FIELD_MIME,
  type TableFieldDragPayload,
} from '@desktop/features/database/tableFieldDrag';
import { ArchiveDropZone, partitionArchivable } from './ArchiveDropZone';

vi.mock('@desktop/utils/api', async (importOriginal) => ({
  // Refusals arrive as the API layer's FetchError.
  FetchError: (await importOriginal<typeof import('@desktop/utils/api')>()).FetchError,
  archiveApi: { archive: vi.fn(), restore: vi.fn() },
  // A dropped table column archives through the table's field routes.
  tablesApi: { archiveField: vi.fn() },
  // The move-to-Trash modal (rendered when a hook is dropped) reads these.
  hooksWorkspacesApi: { get: vi.fn(), delete: vi.fn() },
}));

vi.mock('@desktop/utils/workspaceEvents.js', () => ({
  emitLibraryEvent: vi.fn(),
}));

// A dropped Automations view row archives through the automation's own delete.
const automations = vi.hoisted(() => ({ remove: vi.fn(), upsert: vi.fn() }));
vi.mock('@desktop/utils/api/automations', () => ({
  automationsApi: { remove: (...args: unknown[]) => automations.remove(...args) },
}));
vi.mock('@desktop/features/automations/automationsStore', () => ({
  upsertAutomation: (...args: unknown[]) => automations.upsert(...args),
}));

vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn() }));

const TREE_NODE_MIME = 'application/x-snaglet-tree-node';

/** Minimal DataTransfer stand-in — jsdom has no native DataTransfer, but
 *  fireEvent accepts a plain object with the shape the handler reads. */
function dragging(payload: unknown) {
  return {
    types: [TREE_NODE_MIME],
    getData: (type: string) => (type === TREE_NODE_MIME ? JSON.stringify(payload) : ''),
  };
}

describe('partitionArchivable', () => {
  it('keeps agent kind alongside real node kinds (agents are archivable)', () => {
    const { archivable, rejected } = partitionArchivable([
      { id: 'doc-1', kind: 'doc' },
      { id: 'agent-1', kind: 'agent' },
      { id: 'container-1', kind: 'container' },
    ]);
    expect(archivable.map((p) => p.id)).toEqual(['doc-1', 'agent-1', 'container-1']);
    expect(rejected).toEqual([]);
  });

  it('rejects a kind with no archive path, keeps the archivable ones', () => {
    const { archivable, rejected } = partitionArchivable([
      { id: 'doc-1', kind: 'doc' },
      { id: 'pane-1', kind: 'pane' },
    ]);
    expect(archivable.map((p) => p.id)).toEqual(['doc-1']);
    expect(rejected.map((p) => p.id)).toEqual(['pane-1']);
  });

  it('is a no-op split when every payload is an archivable kind', () => {
    const payloads = [{ id: 'doc-1', kind: 'doc' }];
    expect(partitionArchivable(payloads)).toEqual({ archivable: payloads, rejected: [] });
  });
});

describe('ArchiveDropZone drop handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dropping an agent archives it via the archive endpoint', async () => {
    vi.mocked(archiveApi.archive).mockResolvedValue({
      node: null,
      affected: 1,
    } as never);
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    const zone = screen.getByTestId('archive-drop-zone');

    fireEvent.drop(zone, { dataTransfer: dragging({ id: 'agent-1', kind: 'agent' }) });

    await waitFor(() => expect(archiveApi.archive).toHaveBeenCalledWith('agent-1'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Archived 1 item'));
  });

  it('dropping a real node kind still archives it normally', async () => {
    vi.mocked(archiveApi.archive).mockResolvedValue({
      node: null,
      affected: 1,
    } as never);
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    const zone = screen.getByTestId('archive-drop-zone');

    fireEvent.drop(zone, { dataTransfer: dragging({ id: 'doc-1', kind: 'doc' }) });

    await waitFor(() => expect(archiveApi.archive).toHaveBeenCalledWith('doc-1'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Archived 1 item'));
  });

  it('shows the first refusal when several dropped rows fail, even after an earlier failure', async () => {
    vi.mocked(archiveApi.archive).mockImplementation(async (id: string) => {
      throw new Error(`refused ${id}`);
    });
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    const zone = screen.getByTestId('archive-drop-zone');

    fireEvent.drop(zone, { dataTransfer: dragging({ id: 'doc-0', kind: 'doc' }) });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('refused doc-0'));

    fireEvent.drop(zone, {
      dataTransfer: dragging([
        { id: 'doc-1', kind: 'doc' },
        { id: 'doc-2', kind: 'doc' },
      ]),
    });

    await waitFor(() => expect(archiveApi.archive).toHaveBeenCalledWith('doc-2'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('refused doc-1'));
  });

  it('dropping an unarchivable kind fires no network call and shows a notice', async () => {
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    const zone = screen.getByTestId('archive-drop-zone');

    fireEvent.drop(zone, { dataTransfer: dragging({ id: 'pane-1', kind: 'pane' }) });

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent("Can't archive this item")
    );
    expect(archiveApi.archive).not.toHaveBeenCalled();
  });
});

describe('ArchiveDropZone — hook drops open the move-to-Trash modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hooksWorkspacesApi.get).mockResolvedValue({
      hookName: 'daily-digest',
      dir: '/Users/me/.snaglet/hooks/daily-digest',
      homeRelativeDir: '~/.snaglet/hooks/daily-digest',
      files: ['hook.ts'],
      hasBuild: true,
    });
  });

  it('a dropped hook never reaches the archive endpoint — the explanatory modal opens instead, naming the local path', async () => {
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    const zone = screen.getByTestId('archive-drop-zone');

    fireEvent.drop(zone, { dataTransfer: dragging([{ id: 'daily-digest', kind: 'hook' }]) });

    expect(await screen.findByText(/you can.t archive this script/i)).toBeInTheDocument();
    expect(await screen.findByText('~/.snaglet/hooks/daily-digest')).toBeInTheDocument();
    expect(archiveApi.archive).not.toHaveBeenCalled();
    // No "Can't archive this item" flash either — the modal IS the answer.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('cancel closes the modal without deleting anything', async () => {
    const user = userEvent.setup();
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: dragging([{ id: 'daily-digest', kind: 'hook' }]),
    });
    await screen.findByText(/you can.t archive this script/i);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByText(/you can.t archive this script/i)).not.toBeInTheDocument()
    );
    expect(hooksWorkspacesApi.delete).not.toHaveBeenCalled();
    expect(emitLibraryEvent).not.toHaveBeenCalled();
  });

  it('"Move to Trash" deletes via the hooks API and broadcasts hook-deleted so lists drop the row', async () => {
    const user = userEvent.setup();
    vi.mocked(hooksWorkspacesApi.delete).mockResolvedValue({
      hookName: 'daily-digest',
      deletedRuns: 3,
      deletedRegistration: true,
      deletedSchedules: 1,
      trash: { disposition: 'system-trash', fallbackDir: null },
    });
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: dragging([{ id: 'daily-digest', kind: 'hook' }]),
    });
    await screen.findByText(/you can.t archive this script/i);

    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));

    await waitFor(() => expect(hooksWorkspacesApi.delete).toHaveBeenCalledWith('daily-digest'));
    await waitFor(() =>
      expect(emitLibraryEvent).toHaveBeenCalledWith({
        type: 'hook-deleted',
        hookName: 'daily-digest',
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Moved "daily-digest" to the Trash'
    );
    expect(archiveApi.archive).not.toHaveBeenCalled();
  });

  it('a mixed drop still archives the node payloads while the hook goes to the modal', async () => {
    vi.mocked(archiveApi.archive).mockResolvedValue({ node: null, affected: 1 } as never);
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: dragging([
        { id: 'daily-digest', kind: 'hook' },
        { id: 'doc-1', kind: 'doc' },
      ]),
    });

    await waitFor(() => expect(archiveApi.archive).toHaveBeenCalledWith('doc-1'));
    expect(await screen.findByText(/you can.t archive this script/i)).toBeInTheDocument();
  });
});

describe('ArchiveDropZone — Database table chips', () => {
  const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
  const tableChip: NodeChipData = { id: TABLE_ID, kind: 'table', title: 'reading_list' };
  let tableEvents: TableEvent[] = [];
  let stop: () => void = () => undefined;

  /** A chip drag as the Database sidebar writes it (chip MIME + text/plain). */
  function chipDrag(chip: NodeChipData) {
    return {
      types: [NODE_CHIP_MIME, 'text/plain'],
      getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(chip) : ''),
      dropEffect: 'none',
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tableEvents = [];
    stop = subscribeTableEvents((event) => tableEvents.push(event));
  });

  afterEach(() => {
    stop();
    setActiveDragChip(null);
  });

  it('accepts a table chip on dragover and rejects every other chip kind', () => {
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    const zone = screen.getByTestId('archive-drop-zone');

    // fireEvent returns false when the handler called preventDefault (accepted).
    expect(fireEvent.dragOver(zone, { dataTransfer: chipDrag(tableChip) })).toBe(false);
    expect(
      fireEvent.dragOver(zone, {
        dataTransfer: chipDrag({ id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Notes' }),
      })
    ).toBe(true);
    expect(
      fireEvent.dragOver(zone, {
        dataTransfer: chipDrag({ id: 'test-agent-a', kind: 'agent', title: 'Agent A' }),
      })
    ).toBe(true);
  });

  it('archives a dropped table, toasts its name and drops it from table surfaces', async () => {
    vi.mocked(archiveApi.archive).mockResolvedValue({
      node: {
        id: TABLE_ID,
        type: 'table',
        title: 'reading_list',
        archived: true,
        archived_at: '2026-01-02T00:00:00.000Z',
        container_id: null,
        project_id: null,
        sort_order: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
      affected: 1,
      alreadyArchived: false,
    });
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), { dataTransfer: chipDrag(tableChip) });

    await waitFor(() => expect(archiveApi.archive).toHaveBeenCalledWith(TABLE_ID));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Archived “reading_list”', {
        action: { label: 'Undo', run: expect.any(Function) },
      })
    );
    expect(tableEvents).toEqual([{ type: 'table.removed', tableId: TABLE_ID, state: 'archived' }]);
    // Tables are not tree nodes: the workspace tree is left alone.
    expect(emitLibraryEvent).not.toHaveBeenCalled();
  });

  it('reads the chip from the in-memory drag store when the webview hides custom types', async () => {
    vi.mocked(archiveApi.archive).mockResolvedValue({ node: null, affected: 1 });
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    const zone = screen.getByTestId('archive-drop-zone');
    setActiveDragChip(tableChip);
    const bare = { types: [], getData: () => '', dropEffect: 'none' };

    expect(fireEvent.dragOver(zone, { dataTransfer: bare })).toBe(false);
    fireEvent.drop(zone, { dataTransfer: bare });

    await waitFor(() => expect(archiveApi.archive).toHaveBeenCalledWith(TABLE_ID));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Archived “reading_list”', {
        action: { label: 'Undo', run: expect.any(Function) },
      })
    );
  });

  it('ignores a dropped chip of any other kind', () => {
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: chipDrag({ id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Notes' }),
    });

    expect(archiveApi.archive).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(tableEvents).toEqual([]);
  });

  it("explains that Snaglet's built-in tables can't be archived, without a request", async () => {
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: chipDrag({ id: 'table-builtin-docs', kind: 'table', title: 'Docs' }),
    });

    expect(await screen.findByRole('status')).toHaveTextContent("Snaglet tables can't be archived");
    expect(archiveApi.archive).not.toHaveBeenCalled();
    expect(tableEvents).toEqual([]);
  });

  it('shows a failed table archive in the flash and keeps the table listed', async () => {
    vi.mocked(archiveApi.archive).mockRejectedValue(new Error('archive unavailable'));
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), { dataTransfer: chipDrag(tableChip) });

    expect(await screen.findByRole('status')).toHaveTextContent('archive unavailable');
    expect(showToast).not.toHaveBeenCalled();
    expect(tableEvents).toEqual([]);
  });

  it('does not mistake a table chip drop for a column drop', async () => {
    vi.mocked(archiveApi.archive).mockResolvedValue({ node: null, affected: 1 });
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    fireEvent.drop(screen.getByTestId('archive-drop-zone'), { dataTransfer: chipDrag(tableChip) });
    await waitFor(() => expect(archiveApi.archive).toHaveBeenCalledWith(TABLE_ID));
    expect(tablesApi.archiveField).not.toHaveBeenCalled();
  });

  it('still routes a tree-node drag through the tree path, not the chip path', async () => {
    vi.mocked(archiveApi.archive).mockResolvedValue({ node: null, affected: 1 });
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: {
        types: [TREE_NODE_MIME, NODE_CHIP_MIME],
        getData: (type: string) =>
          type === TREE_NODE_MIME
            ? JSON.stringify({ id: 'doc-1', kind: 'doc' })
            : type === NODE_CHIP_MIME
              ? JSON.stringify(tableChip)
              : '',
      },
    });

    await waitFor(() => expect(archiveApi.archive).toHaveBeenCalledWith('doc-1'));
    expect(archiveApi.archive).toHaveBeenCalledTimes(1);
    expect(tableEvents).toEqual([]);
  });
});

describe('ArchiveDropZone — table rows dragged from the workspace tree', () => {
  const TABLE_A = 'table-1111111111111-aaaaaaaaa';
  const TABLE_B = 'table-2222222222222-bbbbbbbbb';
  let tableEvents: TableEvent[] = [];
  let stop: () => void = () => undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tableEvents = [];
    stop = subscribeTableEvents((event) => tableEvents.push(event));
  });

  afterEach(() => stop());

  it('keeps custom table rows archivable and rejects built-in ones', () => {
    const { archivable, rejected } = partitionArchivable([
      { id: TABLE_A, kind: 'table' },
      { id: 'table-builtin-agents', kind: 'table' },
    ]);
    expect(archivable.map((p) => p.id)).toEqual([TABLE_A]);
    expect(rejected.map((p) => p.id)).toEqual(['table-builtin-agents']);
  });

  it('archives a selection of tables and docs in one drop and drops the tables from table surfaces', async () => {
    vi.mocked(archiveApi.archive).mockResolvedValue({ node: null, affected: 1 });
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: dragging([
        { id: TABLE_A, kind: 'table' },
        { id: 'doc-1', kind: 'doc' },
        { id: TABLE_B, kind: 'table' },
      ]),
    });

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Archived 3 items'));
    expect(vi.mocked(archiveApi.archive).mock.calls.map(([id]) => id)).toEqual([
      TABLE_A,
      'doc-1',
      TABLE_B,
    ]);
    expect(tableEvents).toEqual([
      { type: 'table.removed', tableId: TABLE_A, state: 'archived' },
      { type: 'table.removed', tableId: TABLE_B, state: 'archived' },
    ]);
    expect(emitLibraryEvent).toHaveBeenCalledWith({
      type: 'archive-changed',
      ids: [TABLE_A, 'doc-1', TABLE_B],
      reload: false,
    });
  });
});

describe('ArchiveDropZone — a selection of table rows only', () => {
  const TABLE_A = 'table-1111111111111-aaaaaaaaa';
  const TABLE_B = 'table-2222222222222-bbbbbbbbb';
  const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
  const archivedRow = (id: string, title: string, projectId: string | null) => ({
    id,
    type: 'table',
    title,
    archived: false,
    archived_at: null,
    container_id: null,
    project_id: projectId,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  });
  let tableEvents: TableEvent[] = [];
  let stop: () => void = () => undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tableEvents = [];
    stop = subscribeTableEvents((event) => tableEvents.push(event));
  });

  afterEach(() => stop());

  /** The one Undo the drop offered. */
  function undoAction() {
    expect(showToast).toHaveBeenCalledTimes(1);
    const action = vi.mocked(showToast).mock.calls[0][1]?.action;
    if (!action) throw new Error('The toast offered no Undo');
    return action;
  }

  it('archives them as one step: one toast, and its Undo restores all of them in place', async () => {
    vi.mocked(archiveApi.archive).mockResolvedValue({ node: null, affected: 1 });
    vi.mocked(archiveApi.restore).mockImplementation((id) =>
      Promise.resolve({
        node:
          id === TABLE_A
            ? archivedRow(TABLE_A, 'budget', PROJECT_ID)
            : archivedRow(TABLE_B, 'contacts', null),
        affected: 1,
      })
    );
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: dragging([
        { id: TABLE_A, kind: 'table', label: 'budget', parentId: PROJECT_ID, sortOrder: 4 },
        { id: TABLE_B, kind: 'table', label: 'contacts', parentId: null, sortOrder: 2 },
      ]),
    });

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Archived 2 tables', {
        action: { label: 'Undo', run: expect.any(Function) },
      })
    );
    expect(vi.mocked(archiveApi.archive).mock.calls.map(([id]) => id)).toEqual([TABLE_A, TABLE_B]);
    expect(tableEvents).toEqual([
      { type: 'table.removed', tableId: TABLE_A, state: 'archived' },
      { type: 'table.removed', tableId: TABLE_B, state: 'archived' },
    ]);
    // The toast is the answer; the trash shows no flash of its own.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    tableEvents = [];
    undoAction().run();
    await waitFor(() => expect(tableEvents).toHaveLength(2));
    expect(vi.mocked(archiveApi.restore).mock.calls.map(([id]) => id)).toEqual([TABLE_A, TABLE_B]);
    expect(tableEvents).toEqual([
      {
        type: 'table.restored',
        table: {
          id: TABLE_A,
          name: 'budget',
          origin: 'custom',
          projectId: PROJECT_ID,
          sortOrder: 4,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'table.restored',
        table: {
          id: TABLE_B,
          name: 'contacts',
          origin: 'custom',
          projectId: null,
          sortOrder: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);
  });

  it('offers Undo for the tables that went and flashes the first refusal', async () => {
    vi.mocked(archiveApi.archive)
      .mockRejectedValueOnce(new Error('table is locked'))
      .mockResolvedValueOnce({ node: null, affected: 1 });
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: dragging([
        { id: TABLE_A, kind: 'table', label: 'budget' },
        { id: TABLE_B, kind: 'table', label: 'contacts' },
      ]),
    });

    expect(await screen.findByRole('status')).toHaveTextContent('table is locked');
    expect(showToast).toHaveBeenCalledWith('Archived “contacts”', {
      action: { label: 'Undo', run: expect.any(Function) },
    });
    expect(tableEvents).toEqual([{ type: 'table.removed', tableId: TABLE_B, state: 'archived' }]);
  });

  it('toasts a restore the server refuses and still restores the rest', async () => {
    vi.mocked(archiveApi.archive).mockResolvedValue({ node: null, affected: 1 });
    vi.mocked(archiveApi.restore)
      .mockRejectedValueOnce(new FetchError('The name "budget" is taken by another table.', 409))
      .mockResolvedValueOnce({ node: archivedRow(TABLE_B, 'contacts', null), affected: 1 });
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: dragging([
        { id: TABLE_A, kind: 'table', label: 'budget' },
        { id: TABLE_B, kind: 'table', label: 'contacts' },
      ]),
    });
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));

    tableEvents = [];
    undoAction().run();

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Couldn\'t restore “budget”: The name "budget" is taken by another table.'
      )
    );
    await waitFor(() =>
      expect(tableEvents).toEqual([
        { type: 'table.restored', table: expect.objectContaining({ id: TABLE_B }) },
      ])
    );
  });
});

describe('ArchiveDropZone — automation rows dragged from the Automations view', () => {
  const AUTOMATION_ID = 'automation-1111111111111-aaaaaaaaa';
  const canceled = { id: AUTOMATION_ID, name: 'Morning check', status: 'cancelled' };

  beforeEach(() => vi.clearAllMocks());

  it('keeps automation rows archivable', () => {
    const { archivable, rejected } = partitionArchivable([
      { id: AUTOMATION_ID, kind: 'automation' },
    ]);
    expect(archivable.map((p) => p.id)).toEqual([AUTOMATION_ID]);
    expect(rejected).toEqual([]);
  });

  it('archives an automation through its own delete, beside a doc, and keeps it off the tree', async () => {
    automations.remove.mockResolvedValue({ automation: canceled });
    vi.mocked(archiveApi.archive).mockResolvedValue({ node: null, affected: 1 });
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    const zone = screen.getByTestId('archive-drop-zone');

    // The trash takes the drag (the row carries the tree-node MIME).
    const over = fireEvent.dragOver(zone, {
      dataTransfer: dragging([{ id: AUTOMATION_ID, kind: 'automation' }]),
    });
    expect(over).toBe(false);

    fireEvent.drop(zone, {
      dataTransfer: dragging([
        { id: AUTOMATION_ID, kind: 'automation', label: 'Morning check' },
        { id: 'doc-1', kind: 'doc' },
      ]),
    });

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Archived 2 items'));
    expect(automations.remove).toHaveBeenCalledWith(AUTOMATION_ID);
    // The shared list drops it at once (the server's automations:changed confirms).
    expect(automations.upsert).toHaveBeenCalledWith(canceled);
    // It never reaches the node archive route, nor the tree's node prune.
    expect(vi.mocked(archiveApi.archive).mock.calls.map(([id]) => id)).toEqual(['doc-1']);
    expect(emitLibraryEvent).toHaveBeenCalledWith({
      type: 'archive-changed',
      ids: ['doc-1'],
      reload: false,
    });
  });

  it("shows the server's refusal and leaves the list alone", async () => {
    automations.remove.mockRejectedValue(
      new FetchError(`Automation ${AUTOMATION_ID} is canceled.`, 409)
    );
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: dragging([{ id: AUTOMATION_ID, kind: 'automation', label: 'Morning check' }]),
    });

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        `Automation ${AUTOMATION_ID} is canceled.`
      )
    );
    expect(automations.upsert).not.toHaveBeenCalled();
    expect(archiveApi.archive).not.toHaveBeenCalled();
    expect(emitLibraryEvent).not.toHaveBeenCalled();
  });
});

describe('ArchiveDropZone — Database table columns', () => {
  const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
  const FIELD_ID = 'field-1111111111111-aaaaaaaaa';
  const column: TableFieldDragPayload = { tableId: TABLE_ID, fieldId: FIELD_ID, name: 'notes' };
  const archivedField = {
    range: false,
    id: FIELD_ID,
    tableId: TABLE_ID,
    columnName: FIELD_ID,
    name: 'notes',
    description: null,
    type: 'text' as const,
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    position: 3,
    managed: false,
    revision: 1,
    collapsed: false,
    isTitle: false,
    multiple: false,
    options: null,
    state: 'archived' as const,
  };
  let tableEvents: TableEvent[] = [];
  let stop: () => void = () => undefined;

  /** A column drag as the header's trash handle writes it. */
  function columnDrag(payload: TableFieldDragPayload) {
    return {
      types: [TABLE_FIELD_MIME],
      getData: (type: string) => (type === TABLE_FIELD_MIME ? JSON.stringify(payload) : ''),
      dropEffect: 'none',
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tableEvents = [];
    stop = subscribeTableEvents((event) => tableEvents.push(event));
  });

  afterEach(() => {
    stop();
    __setActiveTableFieldDragForTests(null);
  });

  it('accepts a column drag on dragover, from the store while the payload is hidden', () => {
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    const zone = screen.getByTestId('archive-drop-zone');
    expect(fireEvent.dragOver(zone, { dataTransfer: columnDrag(column) })).toBe(false);
    __setActiveTableFieldDragForTests(column);
    const bare = { types: [], getData: () => '', dropEffect: 'none' };
    expect(fireEvent.dragOver(zone, { dataTransfer: bare })).toBe(false);
    expect(zone.className).toMatch(/hovering/);
  });

  it('archives a dropped column, toasts it and tells the table panes', async () => {
    vi.mocked(tablesApi.archiveField).mockResolvedValue({ field: archivedField, changed: true });
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), { dataTransfer: columnDrag(column) });

    await waitFor(() => expect(tablesApi.archiveField).toHaveBeenCalledWith(TABLE_ID, FIELD_ID));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Archived column “notes”. Restore it from Archived, or undo.',
        { durationMs: 3000 }
      )
    );
    expect(tableEvents).toEqual([{ type: 'table.fields.changed', tableId: TABLE_ID }]);
    expect(archiveApi.archive).not.toHaveBeenCalled();
    expect(emitLibraryEvent).not.toHaveBeenCalled();
  });

  it('shows a failed column archive in the flash and announces nothing', async () => {
    vi.mocked(tablesApi.archiveField).mockRejectedValue(new Error('archive unavailable'));
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);

    fireEvent.drop(screen.getByTestId('archive-drop-zone'), { dataTransfer: columnDrag(column) });

    expect(await screen.findByRole('status')).toHaveTextContent('archive unavailable');
    expect(showToast).not.toHaveBeenCalled();
    expect(tableEvents).toEqual([]);
  });

  it('a tree-node drag still takes the tree path even while a column store entry lingers', async () => {
    vi.mocked(archiveApi.archive).mockResolvedValue({ node: null, affected: 1 });
    __setActiveTableFieldDragForTests(column);
    render(<ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />);
    fireEvent.drop(screen.getByTestId('archive-drop-zone'), {
      dataTransfer: {
        types: [TREE_NODE_MIME],
        getData: (type: string) =>
          type === TREE_NODE_MIME ? JSON.stringify({ id: 'doc-1', kind: 'doc' }) : '',
      },
    });
    await waitFor(() => expect(archiveApi.archive).toHaveBeenCalledWith('doc-1'));
    expect(tablesApi.archiveField).not.toHaveBeenCalled();
  });
});
