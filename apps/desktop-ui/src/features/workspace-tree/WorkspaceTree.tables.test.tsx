/**
 * The workspace Tables group: the user's own catalog tables linked to no
 * project sit in a generated group at the root of the tree, after the
 * workspace Threads group, mirroring the project Tables groups. Table rows
 * keep a manual order, select like tree rows (cmd/ctrl and shift), and drag
 * together: beside another table row (reorder), onto a project row or a
 * Tables group header (the workspace header unlinks them). Other tree rows
 * never land on the group; reveal opens the group that holds a table. A new
 * table starts from a Tables header's `+` or the create menu's Table, both
 * opening the table draft pane in the right scope.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { ContainerTreeNode, DocTreeNode, ThreadTreeNode } from '@desktop/utils/api';
import {
  DashboardNavigationProvider,
  type DashboardNavigationValue,
} from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { EXPANDED_STORAGE_KEY } from './constants';
import styles from './WorkspaceTree.module.scss';
import { __resetTableCatalogForTests } from '@desktop/features/database/useTableCatalog';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  listTree: vi.fn(),
  listTables: vi.fn(),
  setThreadProject: vi.fn(),
  setThreadPlacement: vi.fn(),
  setTablePlacement: vi.fn(),
  createTable: vi.fn(),
  updateDoc: vi.fn(),
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: api.listTree },
    tablesApi: {
      ...actual.tablesApi,
      list: api.listTables,
      setPlacement: api.setTablePlacement,
      create: api.createTable,
    },
    threadsApi: {
      ...actual.threadsApi,
      setProject: api.setThreadProject,
      setPlacement: api.setThreadPlacement,
    },
    docsApi: { ...actual.docsApi, update: api.updateDoc },
  };
});

import { WorkspaceTree } from './WorkspaceTree';

const timestamp = '2026-01-01T00:00:00.000Z';
const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const OTHER_PROJECT_ID = 'container-2222222222222-bbbbbbbbb';
const WORKSPACE_TABLES = 'workspace/tables';

const container = (
  id: string,
  name: string,
  category: ContainerTreeNode['category'],
  children: ContainerTreeNode['children'] = []
): ContainerTreeNode => ({
  kind: 'container',
  id,
  parentId: null,
  name,
  sortOrder: 0,
  category,
  folderPath: null,
  githubUrl: null,
  createdBy: null,
  lastEditedBy: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  children,
});

const doc: DocTreeNode = {
  kind: 'doc',
  id: 'doc-1111111111111-aaaaaaaaa',
  containerId: PROJECT_ID,
  title: 'Project notes',
  content: '',
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const flatThread: ThreadTreeNode = {
  kind: 'thread',
  id: 'thread-2222222222222-bbbbbbbbb',
  projectId: null,
  title: 'Flat chat',
  sortOrder: 0,
  lastMessageAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const table = (
  id: string,
  name: string,
  projectId: string | null,
  extra: Partial<TableCatalogEntry> = {}
): TableCatalogEntry => ({
  id,
  name,
  origin: 'custom',
  projectId,
  sortOrder: 0,
  createdAt: timestamp,
  ...extra,
});

const linkedTable = table('table-1111111111111-aaaaaaaaa', 'Reading list', PROJECT_ID);
const unlinkedTable = table('table-2222222222222-bbbbbbbbb', 'Budget', null, { sortOrder: 0 });
const secondUnlinkedTable = table('table-3333333333333-ccccccccc', 'Addresses', null, {
  sortOrder: 1,
});
const thirdUnlinkedTable = table('table-4444444444444-ddddddddd', 'Contacts', null, {
  sortOrder: 2,
});
const builtinTable = table('table-builtin-agents', 'Agents', null, { origin: 'builtin' });
const allTables = [
  linkedTable,
  unlinkedTable,
  secondUnlinkedTable,
  thirdUnlinkedTable,
  builtinTable,
];

const tree = () => [
  container(PROJECT_ID, 'Test project', 'project', [doc]),
  container(OTHER_PROJECT_ID, 'Other project', 'project'),
  flatThread,
];

/** Minimal DataTransfer double for the tree's own row and chip drags. */
function dataTransfer() {
  const values = new Map<string, string>();
  return {
    files: [] as File[],
    types: [] as string[],
    effectAllowed: 'none',
    dropEffect: 'none',
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => values.set(type, value),
    setDragImage: vi.fn(),
  };
}

function dragRow(source: HTMLElement, target: HTMLElement) {
  const dt = dataTransfer();
  fireEvent.dragStart(source, { dataTransfer: dt });
  const over = fireEvent.dragOver(target, { dataTransfer: dt });
  fireEvent.drop(target, { dataTransfer: dt });
  fireEvent.dragEnd(source, { dataTransfer: dt });
  // `fireEvent` returns false when a handler called preventDefault — i.e.
  // the target accepted the hover; true means it kept the not-allowed cursor.
  return { accepted: !over };
}

/** The draggable row line of a node: its label (titled with the full name) sits on it. */
const rowOf = (name: string) => within(screen.getByRole('treeitem', { name })).getByTitle(name);
/** A generated group's header tree item, by its expansion key. */
const groupHeader = (id: string) => {
  const header = queryGroupHeader(id);
  if (!header) throw new Error(`No group header for ${id}`);
  return header;
};
/** A generated group's header tree item, if drawn (a project hides its empty groups). */
const queryGroupHeader = (id: string) =>
  screen.getAllByRole('treeitem').find((item) => item.dataset.groupId === id);
/** The rows rendered under the workspace Tables group header. */
const workspaceTableRows = () => {
  const group = groupHeader(WORKSPACE_TABLES).parentElement!;
  return within(group)
    .queryAllByRole('treeitem')
    .filter((item) => item.dataset.tableId)
    .map((item) => item.getAttribute('aria-label'));
};

function setExpandedGroups(ids: string[]) {
  window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(ids));
}

beforeEach(() => {
  __resetTableCatalogForTests();
  setExpandedGroups([PROJECT_ID, `${PROJECT_ID}/tables`, 'workspace/threads', WORKSPACE_TABLES]);
  api.listTree.mockResolvedValue(tree());
  api.listTables.mockResolvedValue({ tables: allTables });
  api.setThreadProject.mockResolvedValue({});
  api.setThreadPlacement.mockResolvedValue({});
  api.setTablePlacement.mockImplementation(
    (id: string, placement: { projectId?: string | null; sortOrder?: number }) => {
      const entry = allTables.find((candidate) => candidate.id === id)!;
      return Promise.resolve({
        table: {
          ...entry,
          projectId: placement.projectId === undefined ? entry.projectId : placement.projectId,
          sortOrder: placement.sortOrder ?? 99,
        },
      });
    }
  );
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('WorkspaceTree workspace Tables group', () => {
  it('lists only unlinked custom tables, in their manual order, after the workspace Threads group', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Budget' });

    const header = groupHeader(WORKSPACE_TABLES);
    expect(header).toHaveAccessibleName('Tables (3)');
    expect(header).toHaveAttribute('aria-level', '1');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(workspaceTableRows()).toEqual(['Budget', 'Addresses', 'Contacts']);
    expect(screen.getByRole('treeitem', { name: 'Budget' })).toHaveAttribute('aria-level', '2');

    // Linked and built-in tables belong elsewhere: the project's group, and nowhere.
    const projectRow = screen.getByRole('treeitem', { name: 'Test project' });
    expect(within(projectRow).getByRole('treeitem', { name: 'Reading list' })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'Agents' })).not.toBeInTheDocument();

    // The workspace Threads group precedes the workspace Tables group.
    const threadsHeader = groupHeader('workspace/threads');
    expect(threadsHeader.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('shows the empty hint when every custom table is linked', async () => {
    api.listTables.mockResolvedValue({ tables: [linkedTable, builtinTable] });
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Reading list' });

    expect(screen.getByText('No unlinked tables')).toBeInTheDocument();
    expect(groupHeader(WORKSPACE_TABLES)).toHaveAccessibleName('Tables');
  });

  it('unlinks a project table dropped on the workspace Tables header and moves its row', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    const tableRow = await screen.findByRole('treeitem', { name: 'Reading list' });

    const { accepted } = dragRow(tableRow, groupHeader(WORKSPACE_TABLES));
    expect(accepted).toBe(true);
    await waitFor(() =>
      expect(api.setTablePlacement).toHaveBeenCalledWith(linkedTable.id, { projectId: null })
    );
    // The catalog upsert repaints both groups at once; the table lands last.
    await waitFor(() =>
      expect(workspaceTableRows()).toEqual(['Budget', 'Addresses', 'Contacts', 'Reading list'])
    );
    // The project has no linked tables left, so it draws no Tables heading.
    expect(queryGroupHeader(`${PROJECT_ID}/tables`)).toBeUndefined();
  });

  it('links an unlinked table dropped on a project row', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Budget' });

    const { accepted } = dragRow(
      screen.getByRole('treeitem', { name: 'Budget' }),
      rowOf('Other project')
    );
    expect(accepted).toBe(true);
    await waitFor(() =>
      expect(api.setTablePlacement).toHaveBeenCalledWith(unlinkedTable.id, {
        projectId: OTHER_PROJECT_ID,
      })
    );
    await waitFor(() => expect(workspaceTableRows()).toEqual(['Addresses', 'Contacts']));
  });

  it("links an unlinked table dropped on a project's Tables header", async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Budget' });

    const { accepted } = dragRow(
      screen.getByRole('treeitem', { name: 'Budget' }),
      groupHeader(`${PROJECT_ID}/tables`)
    );
    expect(accepted).toBe(true);
    await waitFor(() =>
      expect(api.setTablePlacement).toHaveBeenCalledWith(unlinkedTable.id, {
        projectId: PROJECT_ID,
      })
    );
  });

  it('rejects an unlinked table dropped back on the workspace Tables header without a request', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Budget' });

    const { accepted } = dragRow(
      screen.getByRole('treeitem', { name: 'Budget' }),
      groupHeader(WORKSPACE_TABLES)
    );
    expect(accepted).toBe(false);
    await waitFor(() => expect(screen.getByRole('treeitem', { name: 'Budget' })).toBeVisible());
    expect(api.setTablePlacement).not.toHaveBeenCalled();
  });

  it('rejects threads and docs dropped on the workspace Tables header', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Budget' });

    // A thread has no root placement, so nothing on the bubble path takes
    // its hover; a doc's hover reaches the tree wrapper (the detach-to-root
    // gesture), but the header swallows the drop, so the doc stays put.
    expect(dragRow(rowOf('Flat chat'), groupHeader(WORKSPACE_TABLES)).accepted).toBe(false);
    dragRow(rowOf('Project notes'), groupHeader(WORKSPACE_TABLES));
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'Project notes' })).toBeVisible()
    );
    expect(
      within(screen.getByRole('treeitem', { name: 'Test project' })).getByRole('treeitem', {
        name: 'Project notes',
      })
    ).toBeInTheDocument();
    expect(api.setThreadProject).not.toHaveBeenCalled();
    expect(api.updateDoc).not.toHaveBeenCalled();
    expect(api.setTablePlacement).not.toHaveBeenCalled();
  });

  it('walks the group by keyboard: Left and Right toggle the header, Enter opens a table', async () => {
    const navigation: DashboardNavigationValue = {
      openInPane: vi.fn(),
      openTable: vi.fn(),
      openThreadAgent: vi.fn(),
      requestReveal: vi.fn(),
    };
    render(
      <DashboardNavigationProvider value={navigation}>
        <WorkspaceTree onNodeClick={vi.fn()} />
      </DashboardNavigationProvider>
    );
    const tableRow = await screen.findByRole('treeitem', { name: 'Budget' });
    expect(tableRow).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(tableRow, { key: 'Enter' });
    expect(navigation.openTable).toHaveBeenCalledWith(unlinkedTable.id);
    fireEvent.keyDown(within(tableRow).getByRole('button', { name: 'Copy link to Budget' }), {
      key: 'Enter',
    });
    expect(navigation.openTable).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(groupHeader(WORKSPACE_TABLES), { key: 'ArrowLeft' });
    expect(screen.queryByRole('treeitem', { name: 'Budget' })).not.toBeInTheDocument();
    expect(groupHeader(WORKSPACE_TABLES)).toHaveAttribute('aria-expanded', 'false');
    expect(groupHeader(WORKSPACE_TABLES)).toHaveTextContent('Tables3');
    fireEvent.keyDown(groupHeader(WORKSPACE_TABLES), { key: 'ArrowRight' });
    expect(screen.getByRole('treeitem', { name: 'Budget' })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(EXPANDED_STORAGE_KEY) ?? '[]')).toContain(
      WORKSPACE_TABLES
    );
  });

  it('reorders a table dropped beside another table row', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Contacts' });

    // jsdom drag events carry no pointer position, so a drop reads as the
    // lower half of the row: Contacts (slot 2) below Budget (slot 0) takes slot 1.
    const target = screen.getByRole('treeitem', { name: 'Budget' });
    const dt = dataTransfer();
    fireEvent.dragStart(screen.getByRole('treeitem', { name: 'Contacts' }), { dataTransfer: dt });
    const accepted = !fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    expect(accepted).toBe(true);
    await waitFor(() =>
      expect(api.setTablePlacement).toHaveBeenCalledWith(thirdUnlinkedTable.id, {
        projectId: null,
        sortOrder: 1,
      })
    );
  });

  it('makes no request for a table dropped right beside itself', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Addresses' });

    // Addresses (slot 1) below Budget (slot 0) is where it already is.
    const target = screen.getByRole('treeitem', { name: 'Budget' });
    const dt = dataTransfer();
    fireEvent.dragStart(screen.getByRole('treeitem', { name: 'Addresses' }), { dataTransfer: dt });
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    await waitFor(() => expect(screen.getByRole('treeitem', { name: 'Addresses' })).toBeVisible());
    expect(api.setTablePlacement).not.toHaveBeenCalled();
  });

  it('selects table rows with cmd and shift click and drags the selection to a project in order', async () => {
    const navigation: DashboardNavigationValue = {
      openInPane: vi.fn(),
      openTable: vi.fn(),
      openThreadAgent: vi.fn(),
      requestReveal: vi.fn(),
    };
    render(
      <DashboardNavigationProvider value={navigation}>
        <WorkspaceTree onNodeClick={vi.fn()} />
      </DashboardNavigationProvider>
    );
    const budget = await screen.findByRole('treeitem', { name: 'Budget' });
    const contacts = screen.getByRole('treeitem', { name: 'Contacts' });

    fireEvent.click(budget);
    expect(navigation.openTable).toHaveBeenCalledWith(unlinkedTable.id);
    fireEvent.click(contacts, { shiftKey: true });
    expect(navigation.openTable).toHaveBeenCalledTimes(1);
    for (const name of ['Budget', 'Addresses', 'Contacts']) {
      expect(screen.getByRole('treeitem', { name })).toHaveAttribute('aria-selected', 'true');
    }
    fireEvent.click(screen.getByRole('treeitem', { name: 'Addresses' }), { metaKey: true });
    expect(screen.getByRole('treeitem', { name: 'Addresses' })).toHaveAttribute(
      'aria-selected',
      'false'
    );

    // Dragging one selected row carries both, in on-screen order.
    const { accepted } = dragRow(contacts, rowOf('Other project'));
    expect(accepted).toBe(true);
    await waitFor(() => expect(api.setTablePlacement).toHaveBeenCalledTimes(2));
    expect(api.setTablePlacement.mock.calls).toEqual([
      [unlinkedTable.id, { projectId: OTHER_PROJECT_ID }],
      [thirdUnlinkedTable.id, { projectId: OTHER_PROJECT_ID }],
    ]);
  });

  it('rejects a table dropped on a plain doc or on tree whitespace', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Budget' });

    expect(
      dragRow(screen.getByRole('treeitem', { name: 'Budget' }), rowOf('Project notes')).accepted
    ).toBe(false);
    expect(
      dragRow(screen.getByRole('treeitem', { name: 'Budget' }), screen.getByRole('tree')).accepted
    ).toBe(false);
    expect(api.setTablePlacement).not.toHaveBeenCalled();
  });

  it('expands the workspace Tables group when revealing an unlinked table', async () => {
    setExpandedGroups([PROJECT_ID]);
    const { rerender } = render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Test project' });
    await waitFor(() => expect(api.listTables).toHaveBeenCalled());
    expect(screen.queryByRole('treeitem', { name: 'Budget' })).not.toBeInTheDocument();

    rerender(
      <WorkspaceTree onNodeClick={vi.fn()} revealNodeId={unlinkedTable.id} revealNonce={1} />
    );
    expect(await screen.findByRole('treeitem', { name: 'Budget' })).toBeInTheDocument();
    expect(groupHeader(WORKSPACE_TABLES)).toHaveAttribute('aria-expanded', 'true');
  });

  it('expands a collapsed project and its Tables group when revealing a linked table', async () => {
    setExpandedGroups([]);
    const { rerender } = render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Test project' });
    await waitFor(() => expect(api.listTables).toHaveBeenCalled());
    expect(screen.queryByRole('treeitem', { name: 'Reading list' })).not.toBeInTheDocument();

    rerender(<WorkspaceTree onNodeClick={vi.fn()} revealNodeId={linkedTable.id} revealNonce={1} />);
    const projectRow = screen.getByRole('treeitem', { name: 'Test project' });
    expect(
      await within(projectRow).findByRole('treeitem', { name: 'Reading list' })
    ).toBeInTheDocument();
    expect(groupHeader(`${PROJECT_ID}/tables`)).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens no group for a built-in table, which the tree never draws', async () => {
    setExpandedGroups([PROJECT_ID]);
    const { rerender } = render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Test project' });
    await waitFor(() => expect(api.listTables).toHaveBeenCalled());
    await waitFor(() => expect(groupHeader(WORKSPACE_TABLES)).toHaveAccessibleName('Tables (3)'));

    rerender(
      <WorkspaceTree onNodeClick={vi.fn()} revealNodeId={builtinTable.id} revealNonce={1} />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(groupHeader(WORKSPACE_TABLES)).toHaveAttribute('aria-expanded', 'false');
  });

  it("highlights the active pane's table row, as a doc row is for its doc", async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} activeTableId={linkedTable.id} />);
    const active = await screen.findByRole('treeitem', { name: 'Reading list' });

    expect(styles.rowActive).toBeTruthy();
    expect(active).toHaveClass(styles.rowActive!);
    expect(screen.getByRole('treeitem', { name: 'Budget' })).not.toHaveClass(styles.rowActive!);
  });
});

describe('WorkspaceTree new table entry points', () => {
  const PLAIN_ID = 'container-3333333333333-ccccccccc';

  function renderWithNavigation() {
    const navigation: DashboardNavigationValue = {
      openInPane: vi.fn(),
      openTable: vi.fn(),
      openThreadAgent: vi.fn(),
      requestReveal: vi.fn(),
    };
    render(
      <DashboardNavigationProvider value={navigation}>
        <WorkspaceTree onNodeClick={vi.fn()} />
      </DashboardNavigationProvider>
    );
    return navigation;
  }

  const addButton = (groupId: string) =>
    within(groupHeader(groupId)).getByRole('button', { name: 'New table' });
  const menuLabels = () =>
    within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((item) => item.textContent);

  /** The inline name input open in the tree, if any. */
  const draftInput = (kind: 'table' | 'thread') =>
    screen.queryByRole('textbox', { name: `${kind} name` });
  /** The id of the Tables / Threads group whose body holds the draft input. */
  const groupHoldingDraft = (kind: 'table' | 'thread') => {
    const input = draftInput(kind);
    if (!input) return null;
    let el: HTMLElement | null = input;
    while (el) {
      const header = el.querySelector?.(':scope > [data-group-id]') as HTMLElement | null;
      if (header) return header.dataset.groupId ?? null;
      el = el.parentElement;
    }
    return null;
  };

  it("opens the table name row at the top of a Tables header's own group", async () => {
    renderWithNavigation();
    await screen.findByRole('treeitem', { name: 'Budget' });

    fireEvent.click(addButton(WORKSPACE_TABLES));
    expect(groupHoldingDraft('table')).toBe(WORKSPACE_TABLES);
    expect(groupHeader(WORKSPACE_TABLES)).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(draftInput('table')!, { key: 'Escape' });
    expect(draftInput('table')).toBeNull();
    // Canceling leaves the group open.
    expect(groupHeader(WORKSPACE_TABLES)).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(addButton(`${PROJECT_ID}/tables`));
    expect(groupHoldingDraft('table')).toBe(`${PROJECT_ID}/tables`);
  });

  it('expands a collapsed Tables group when its + opens a name row', async () => {
    renderWithNavigation();
    await screen.findByRole('treeitem', { name: 'Budget' });
    fireEvent.click(groupHeader(WORKSPACE_TABLES));
    expect(groupHeader(WORKSPACE_TABLES)).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(addButton(WORKSPACE_TABLES));
    expect(groupHeader(WORKSPACE_TABLES)).toHaveAttribute('aria-expanded', 'true');
    expect(draftInput('table')).toHaveFocus();
  });

  it('creates the table in its scope on Enter, under its formatted name, and opens it', async () => {
    const created = { ...unlinkedTable, id: 'table-1700000000000-new', name: 'bean_roasts' };
    api.createTable.mockResolvedValue({ table: created });
    const navigation = renderWithNavigation();
    await screen.findByRole('treeitem', { name: 'Budget' });

    fireEvent.click(addButton(`${PROJECT_ID}/tables`));
    const input = draftInput('table')!;
    fireEvent.change(input, { target: { value: 'Bean Roasts' } });
    expect(input).toHaveValue('bean_roasts');
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(navigation.openTable).toHaveBeenCalledWith(created.id));
    expect(api.createTable).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'bean_roasts', projectId: PROJECT_ID })
    );
  });

  it('opens a thread name row inside the Threads group, never at the root', async () => {
    renderWithNavigation();
    await screen.findByRole('treeitem', { name: 'Budget' });
    fireEvent.click(screen.getByRole('button', { name: 'Create at root' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Thread' }));

    expect(groupHoldingDraft('thread')).toBe('workspace/threads');
    expect(groupHeader('workspace/threads')).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows no Tables + outside a dashboard, where a new table could not open', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Budget' });
    expect(
      within(groupHeader(WORKSPACE_TABLES)).queryByRole('button', { name: 'New table' })
    ).toBeNull();
  });

  it('offers Table in the create menu where it offers Thread, scoped like a thread', async () => {
    api.listTree.mockResolvedValue([...tree(), container(PLAIN_ID, 'Plain folder', null)]);
    renderWithNavigation();
    await screen.findByRole('treeitem', { name: 'Plain folder' });

    // The root: a workspace-level table.
    fireEvent.click(screen.getByRole('button', { name: 'Create at root' }));
    expect(menuLabels()).toEqual(['Container', 'Project', 'Doc', 'Thread', 'Table']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Table' }));
    expect(groupHoldingDraft('table')).toBe(WORKSPACE_TABLES);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.keyDown(draftInput('table')!, { key: 'Escape' });

    // A project: its own Tables group.
    const projectRow = screen.getByRole('treeitem', { name: 'Other project' });
    fireEvent.click(
      within(projectRow).getByRole('button', { name: 'Create inside Other project' })
    );
    expect(menuLabels()).toContain('Table');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Table' }));
    expect(groupHoldingDraft('table')).toBe(`${OTHER_PROJECT_ID}/tables`);
    fireEvent.keyDown(draftInput('table')!, { key: 'Escape' });

    // A plain folder holds neither threads nor tables.
    const folderRow = screen.getByRole('treeitem', { name: 'Plain folder' });
    fireEvent.click(within(folderRow).getByRole('button', { name: 'Create inside Plain folder' }));
    expect(menuLabels()).toEqual(['Container', 'Project', 'Doc']);
  });
});
