/**
 * Threads leave the folder tree: a project row shows generated Threads and
 * Tables groups ahead of its folders, flat threads sit in a workspace-level
 * Threads group, and a dragged thread lands on a project, a Threads group
 * header, or beside another thread (threads keep a manual order), while a
 * dragged table links to the project it lands on. The generated groups are
 * tree items a keyboard walks like folder rows. Top-level folders and docs
 * follow the projects in their own Docs & context group.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { ContainerTreeNode, DocTreeNode, ThreadTreeNode } from '@desktop/utils/api';
import {
  DashboardNavigationProvider,
  type DashboardNavigationValue,
} from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { TOAST_EVENT_NAME, type ToastDetail } from '@desktop/utils/toast';
import { __resetTableCatalogForTests } from '@desktop/features/database/useTableCatalog';
import { EXPANDED_STORAGE_KEY } from './constants';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  listTree: vi.fn(),
  listTables: vi.fn(),
  setThreadPlacement: vi.fn(),
  setTablePlacement: vi.fn(),
  updateDoc: vi.fn(),
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: api.listTree },
    tablesApi: { ...actual.tablesApi, list: api.listTables, setPlacement: api.setTablePlacement },
    threadsApi: { ...actual.threadsApi, setPlacement: api.setThreadPlacement },
    docsApi: { ...actual.docsApi, update: api.updateDoc },
  };
});

import { FetchError } from '@desktop/utils/api';
import { WorkspaceTree } from './WorkspaceTree';

const timestamp = '2026-01-01T00:00:00.000Z';
const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const OTHER_PROJECT_ID = 'container-2222222222222-bbbbbbbbb';
const FOLDER_ID = 'container-3333333333333-ccccccccc';

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

const thread = (id: string, title: string, projectId: string | null): ThreadTreeNode => ({
  kind: 'thread',
  id,
  projectId,
  title,
  sortOrder: 0,
  lastMessageAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
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

const looseDoc: DocTreeNode = {
  ...doc,
  id: 'doc-2222222222222-bbbbbbbbb',
  containerId: null,
  title: 'Loose notes',
};

const projectThread = thread('thread-1111111111111-aaaaaaaaa', 'Project chat', PROJECT_ID);
const flatThread = thread('thread-2222222222222-bbbbbbbbb', 'Flat chat', null);

const linkedTable: TableCatalogEntry = {
  id: 'table-1111111111111-aaaaaaaaa',
  name: 'Reading list',
  origin: 'custom',
  projectId: PROJECT_ID,
  sortOrder: 0,
  createdAt: timestamp,
};
const workspaceTable: TableCatalogEntry = {
  id: 'table-2222222222222-bbbbbbbbb',
  name: 'Budget',
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: timestamp,
};

const tree = () => [
  container(PROJECT_ID, 'Test project', 'project', [doc, projectThread]),
  container(OTHER_PROJECT_ID, 'Other project', 'project'),
  container(FOLDER_ID, 'Plain folder', null),
  looseDoc,
  flatThread,
];

/** Minimal DataTransfer double for the tree's own row drags. */
function dataTransfer(files: File[] = []) {
  const values = new Map<string, string>();
  return {
    files,
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
/** Toast messages the tree reports failed actions with. */
function listenForToasts() {
  const toasts: string[] = [];
  const listener = (event: Event) =>
    toasts.push((event as CustomEvent<ToastDetail>).detail.message);
  window.addEventListener(TOAST_EVENT_NAME, listener);
  return { toasts, stop: () => window.removeEventListener(TOAST_EVENT_NAME, listener) };
}

beforeEach(() => {
  __resetTableCatalogForTests();
  window.localStorage.setItem(
    EXPANDED_STORAGE_KEY,
    JSON.stringify([
      PROJECT_ID,
      `${PROJECT_ID}/threads`,
      `${PROJECT_ID}/tables`,
      'workspace/threads',
    ])
  );
  api.listTree.mockResolvedValue(tree());
  api.listTables.mockResolvedValue({ tables: [linkedTable, workspaceTable] });
  api.setThreadPlacement.mockResolvedValue({});
  api.setTablePlacement.mockImplementation(
    (id: string, placement: { projectId?: string | null; sortOrder?: number }) => {
      const table = [linkedTable, workspaceTable].find((entry) => entry.id === id)!;
      return Promise.resolve({
        table: { ...table, projectId: placement.projectId ?? null, sortOrder: 0 },
      });
    }
  );
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('WorkspaceTree thread and table groups', () => {
  it('draws Threads and Tables groups under a project and a workspace Threads group for flat threads', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    const projectRow = await screen.findByRole('treeitem', { name: 'Test project' });

    // The project's Threads and Tables groups come first (right under its
    // Files group); its own folders and docs follow below them.
    const projectDoc = within(projectRow).getByRole('treeitem', { name: 'Project notes' });
    expect(projectDoc).toBeInTheDocument();
    const threadsHeader = groupHeader(`${PROJECT_ID}/threads`);
    const tablesHeader = groupHeader(`${PROJECT_ID}/tables`);
    expect(
      threadsHeader.compareDocumentPosition(tablesHeader) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      tablesHeader.compareDocumentPosition(projectDoc) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(groupHeader(`${PROJECT_ID}/threads`)).toHaveTextContent('Threads1');
    expect(groupHeader(`${PROJECT_ID}/threads`)).toHaveAccessibleName('Threads (1)');
    expect(within(projectRow).getByRole('treeitem', { name: 'Project chat' })).toBeInTheDocument();
    expect(
      await within(projectRow).findByRole('treeitem', { name: 'Reading list' })
    ).toBeInTheDocument();
    expect(groupHeader(`${PROJECT_ID}/tables`)).toHaveTextContent('Tables1');
    // A workspace-wide table is not a project's table.
    expect(screen.queryByRole('treeitem', { name: 'Budget' })).not.toBeInTheDocument();

    // Flat threads sit in the workspace Threads group, not among root rows.
    expect(groupHeader('workspace/threads')).toHaveTextContent('Threads1');
    const flatRow = screen.getByRole('treeitem', { name: 'Flat chat' });
    expect(flatRow).toHaveAttribute('aria-level', '2');
    expect(projectRow).not.toContainElement(flatRow);
  });

  it('collapses a Threads group from its header and keeps the thread count visible', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Flat chat' });

    fireEvent.click(groupHeader('workspace/threads'));
    expect(screen.queryByRole('treeitem', { name: 'Flat chat' })).not.toBeInTheDocument();
    expect(groupHeader('workspace/threads')).toHaveAttribute('aria-expanded', 'false');
    expect(groupHeader('workspace/threads')).toHaveTextContent('Threads1');
  });

  it('moves a dragged thread onto a project with setPlacement', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Flat chat' });

    const { accepted } = dragRow(rowOf('Flat chat'), rowOf('Other project'));
    expect(accepted).toBe(true);
    await waitFor(() =>
      expect(api.setThreadPlacement).toHaveBeenCalledWith(flatThread.id, {
        projectId: OTHER_PROJECT_ID,
      })
    );
    expect(api.updateDoc).not.toHaveBeenCalled();
  });

  it('makes a project thread flat when dropped on the workspace Threads group header', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Project chat' });

    const { accepted } = dragRow(rowOf('Project chat'), groupHeader('workspace/threads'));
    expect(accepted).toBe(true);
    await waitFor(() =>
      expect(api.setThreadPlacement).toHaveBeenCalledWith(projectThread.id, { projectId: null })
    );
  });

  it('rejects a thread dragged onto a plain folder, a doc or its own project', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Project chat' });

    expect(dragRow(rowOf('Flat chat'), rowOf('Plain folder')).accepted).toBe(false);
    expect(dragRow(rowOf('Flat chat'), rowOf('Project notes')).accepted).toBe(false);
    expect(dragRow(rowOf('Project chat'), rowOf('Test project')).accepted).toBe(false);
    expect(dragRow(rowOf('Project chat'), groupHeader(`${PROJECT_ID}/threads`)).accepted).toBe(
      false
    );
    expect(api.setThreadPlacement).not.toHaveBeenCalled();
  });

  it('does nothing when a doc is dropped on a thread row', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Project chat' });

    // The thread row itself never accepts the hover (the tree wrapper behind
    // it does, as for any rejected row), and the drop resolves to nothing.
    dragRow(rowOf('Project notes'), rowOf('Project chat'));
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'Project notes' })).toBeVisible()
    );
    expect(api.updateDoc).not.toHaveBeenCalled();
  });

  it('links a dragged table to the project it lands on and repaints its Tables group', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    const tableRow = await screen.findByRole('treeitem', { name: 'Reading list' });

    const { accepted } = dragRow(tableRow, rowOf('Other project'));
    expect(accepted).toBe(true);
    await waitFor(() =>
      expect(api.setTablePlacement).toHaveBeenCalledWith(linkedTable.id, {
        projectId: OTHER_PROJECT_ID,
      })
    );
    // The catalog upsert moves the row to the other project's group.
    const otherProject = screen.getByRole('treeitem', { name: 'Other project' });
    fireEvent.click(within(otherProject).getByTestId('library-tree-chevron'));
    fireEvent.click(groupHeader(`${OTHER_PROJECT_ID}/tables`));
    expect(
      await within(otherProject).findByRole('treeitem', { name: 'Reading list' })
    ).toBeInTheDocument();
    // The project it left has no tables now, so no Tables heading either.
    expect(queryGroupHeader(`${PROJECT_ID}/tables`)).toBeUndefined();
    expect(api.setThreadPlacement).not.toHaveBeenCalled();
  });

  it('rejects a table dragged onto the project it is already linked to', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    const tableRow = await screen.findByRole('treeitem', { name: 'Reading list' });

    const { accepted } = dragRow(tableRow, rowOf('Test project'));
    expect(accepted).toBe(false);
    expect(api.setTablePlacement).not.toHaveBeenCalled();
  });

  it('toasts the server refusal of a table link and leaves the table where it was', async () => {
    api.setTablePlacement.mockRejectedValue(
      new FetchError('Project "Other project" is archived; restore it first', 400)
    );
    const { toasts, stop } = listenForToasts();
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    const tableRow = await screen.findByRole('treeitem', { name: 'Reading list' });

    dragRow(tableRow, rowOf('Other project'));
    await waitFor(() =>
      expect(toasts).toEqual(['Move failed: Project "Other project" is archived; restore it first'])
    );
    expect(groupHeader(`${PROJECT_ID}/tables`)).toHaveTextContent('Tables1');
    stop();
  });

  it('reorders a thread dropped beside another thread in its project', async () => {
    const second = {
      ...thread('thread-3333333333333-ccccccccc', 'Second chat', PROJECT_ID),
      sortOrder: 1,
    };
    api.listTree.mockResolvedValue([
      container(PROJECT_ID, 'Test project', 'project', [projectThread, second, doc]),
      flatThread,
    ]);
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Second chat' });

    // jsdom rows have no height, so the pointer reads as the lower half: below.
    const { accepted } = dragRow(rowOf('Project chat'), rowOf('Second chat'));
    expect(accepted).toBe(true);
    await waitFor(() =>
      expect(api.setThreadPlacement).toHaveBeenCalledWith(projectThread.id, {
        projectId: PROJECT_ID,
        sortOrder: 2,
      })
    );
  });

  it('moves a flat thread into a project list beside one of its threads', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Project chat' });

    const { accepted } = dragRow(rowOf('Flat chat'), rowOf('Project chat'));
    expect(accepted).toBe(true);
    await waitFor(() =>
      expect(api.setThreadPlacement).toHaveBeenCalledWith(flatThread.id, {
        projectId: PROJECT_ID,
        sortOrder: 1,
      })
    );
  });

  it('rejects a table dropped beside a thread', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Reading list' });

    expect(
      dragRow(screen.getByRole('treeitem', { name: 'Reading list' }), rowOf('Project chat'))
        .accepted
    ).toBe(false);
    expect(api.setThreadPlacement).not.toHaveBeenCalled();
    expect(api.setTablePlacement).not.toHaveBeenCalled();
  });

  it('moves only the doc of a mixed selection dropped on the project its thread is already in', async () => {
    api.updateDoc.mockResolvedValue({});
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Project chat' });

    fireEvent.click(rowOf('Loose notes'));
    fireEvent.click(rowOf('Project chat'), { metaKey: true });
    const { accepted } = dragRow(rowOf('Project chat'), rowOf('Test project'));
    expect(accepted).toBe(true);

    await waitFor(() =>
      expect(api.updateDoc).toHaveBeenCalledWith(looseDoc.id, { containerId: PROJECT_ID })
    );
    expect(api.updateDoc).toHaveBeenCalledTimes(1);
    expect(api.setThreadPlacement).not.toHaveBeenCalled();
  });
});

describe('WorkspaceTree generated groups by keyboard', () => {
  const navigation: DashboardNavigationValue = {
    openInPane: vi.fn(),
    openTable: vi.fn(),
    openThreadAgent: vi.fn(),
    requestReveal: vi.fn(),
  };

  it('exposes group headers as expandable tree items that Left/Right and Enter toggle', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Project chat' });
    const threads = groupHeader(`${PROJECT_ID}/threads`);
    expect(threads).toHaveAttribute('aria-level', '2');
    expect(threads).toHaveAttribute('aria-expanded', 'true');
    expect(threads).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(threads, { key: 'ArrowLeft' });
    expect(screen.queryByRole('treeitem', { name: 'Project chat' })).not.toBeInTheDocument();
    expect(groupHeader(`${PROJECT_ID}/threads`)).toHaveAttribute('aria-expanded', 'false');
    // Left on a collapsed group is inert, Right reopens it.
    fireEvent.keyDown(groupHeader(`${PROJECT_ID}/threads`), { key: 'ArrowLeft' });
    expect(groupHeader(`${PROJECT_ID}/threads`)).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(groupHeader(`${PROJECT_ID}/threads`), { key: 'ArrowRight' });
    expect(screen.getByRole('treeitem', { name: 'Project chat' })).toBeInTheDocument();

    const workspaceThreads = groupHeader('workspace/threads');
    expect(workspaceThreads).toHaveAttribute('aria-level', '1');
    fireEvent.keyDown(workspaceThreads, { key: 'Enter' });
    expect(screen.queryByRole('treeitem', { name: 'Flat chat' })).not.toBeInTheDocument();
    fireEvent.keyDown(groupHeader('workspace/threads'), { key: ' ' });
    expect(screen.getByRole('treeitem', { name: 'Flat chat' })).toBeInTheDocument();
  });

  it('renders each linked table as one focusable tree item that Enter opens', async () => {
    render(
      <DashboardNavigationProvider value={navigation}>
        <WorkspaceTree onNodeClick={vi.fn()} />
      </DashboardNavigationProvider>
    );
    const tableRow = await screen.findByRole('treeitem', { name: 'Reading list' });
    expect(tableRow).toHaveAttribute('tabindex', '0');
    expect(tableRow).toHaveAttribute('aria-level', '3');
    expect(within(tableRow).queryByRole('treeitem')).not.toBeInTheDocument();
    expect(
      within(tableRow).queryByRole('button', { name: 'Reading list' })
    ).not.toBeInTheDocument();

    fireEvent.keyDown(tableRow, { key: 'Enter' });
    expect(navigation.openTable).toHaveBeenCalledWith(linkedTable.id);
    // The copy action inside the row keeps its own keys.
    fireEvent.keyDown(within(tableRow).getByRole('button', { name: 'Copy link to Reading list' }), {
      key: 'Enter',
    });
    expect(navigation.openTable).toHaveBeenCalledTimes(1);

    const tables = groupHeader(`${PROJECT_ID}/tables`);
    expect(tables).toHaveAccessibleName('Tables (1)');
    fireEvent.keyDown(tables, { key: 'ArrowLeft' });
    expect(screen.queryByRole('treeitem', { name: 'Reading list' })).not.toBeInTheDocument();
  });
});

describe('WorkspaceTree Docs & context group', () => {
  const ROOT_ITEMS = 'workspace/items';
  const follows = (a: HTMLElement, b: HTMLElement) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('draws projects first, then the top-level folders and docs under their own open header', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Loose notes' });

    const header = groupHeader(ROOT_ITEMS);
    expect(header).toHaveAccessibleName('Docs & context (2)');
    expect(header).toHaveAttribute('aria-level', '1');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    for (const name of ['Plain folder', 'Loose notes']) {
      const row = screen.getByRole('treeitem', { name });
      expect(row).toHaveAttribute('aria-level', '2');
      expect(header.parentElement).toContainElement(row);
    }
    // Below every project row, above the workspace Threads group.
    expect(follows(screen.getByRole('treeitem', { name: 'Other project' }), header)).toBe(true);
    expect(follows(rowOf('Project notes'), header)).toBe(true);
    expect(follows(header, groupHeader('workspace/threads'))).toBe(true);
  });

  it('collapses from its header and stays collapsed on the next load', async () => {
    const first = render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Loose notes' });
    fireEvent.click(groupHeader(ROOT_ITEMS));
    expect(screen.queryByRole('treeitem', { name: 'Loose notes' })).not.toBeInTheDocument();
    first.unmount();

    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Test project' });
    expect(groupHeader(ROOT_ITEMS)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('treeitem', { name: 'Loose notes' })).not.toBeInTheDocument();
  });

  it('opens again to reveal a top-level doc', async () => {
    const { rerender } = render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Loose notes' });
    fireEvent.click(groupHeader(ROOT_ITEMS));

    rerender(<WorkspaceTree onNodeClick={vi.fn()} revealNodeId={looseDoc.id} revealNonce={1} />);
    expect(await screen.findByRole('treeitem', { name: 'Loose notes' })).toBeInTheDocument();
    expect(groupHeader(ROOT_ITEMS)).toHaveAttribute('aria-expanded', 'true');
  });

  it('moves a doc dropped on its header out to the top level, and refuses threads and tables', async () => {
    api.updateDoc.mockResolvedValue({});
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('treeitem', { name: 'Loose notes' });

    expect(dragRow(rowOf('Flat chat'), groupHeader(ROOT_ITEMS)).accepted).toBe(false);
    expect(
      dragRow(screen.getByRole('treeitem', { name: 'Reading list' }), groupHeader(ROOT_ITEMS))
        .accepted
    ).toBe(false);
    expect(api.updateDoc).not.toHaveBeenCalled();

    expect(dragRow(rowOf('Project notes'), groupHeader(ROOT_ITEMS)).accepted).toBe(true);
    await waitFor(() =>
      expect(api.updateDoc).toHaveBeenCalledWith(
        doc.id,
        expect.objectContaining({ containerId: null })
      )
    );
    expect(api.setThreadPlacement).not.toHaveBeenCalled();
  });
});
