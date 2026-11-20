/**
 * ContainerView — the project pane lists its threads (in the server's order)
 * and its linked tables, each in their manual order, in their own sections
 * under the folder/doc grid. A plain container has neither section, keeps the
 * bare grid, and says so when a thread is dropped on it.
 */
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type {
  ContainerTreeNode,
  DocTreeNode,
  LibraryTreeChild,
  ThreadTreeNode,
} from '@desktop/utils/api';
import {
  DashboardNavigationProvider,
  type DashboardNavigationValue,
} from '../../selection/DashboardNavigationContext';
import { ContainerView } from './ContainerView';
import { TREE_NODE_MIME } from './dnd';
import { PROJECT_SECTION_PREVIEW } from './ProjectPaneSection';

const api = vi.hoisted(() => ({ get: vi.fn(), listTree: vi.fn() }));
const catalog = vi.hoisted(() => ({ useTableCatalog: vi.fn() }));
vi.mock('@desktop/utils/api', async (original) => ({
  ...(await original<typeof import('@desktop/utils/api')>()),
  containersApi: api,
  // ContainerProperties resolves attribution names; keep the folder pane quiet.
  membersApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@desktop/features/database/useTableCatalog', () => catalog);
vi.mock('./DetailsPanel/DetailsPanel', () => ({
  DetailsPanel: () => <div data-testid="project-details">PROJECT</div>,
}));
vi.mock('../../chrome/PaneChrome/PaneChrome', () => ({
  usePaneChromeActions: () => undefined,
  useHasPaneChrome: () => false,
}));
vi.mock('./IconsMode', () => ({
  IconsMode: ({ children }: { children: LibraryTreeChild[] }) => (
    <div data-testid="grid">{children.map((node) => node.id).join(',')}</div>
  ),
}));
vi.mock('@desktop/features/workspace-tree/hooks/useTreeClipboard', () => ({
  useTreeClipboard: () => ({}),
}));
vi.mock('@desktop/features/workspace-tree/undo/useWorkspaceUndoShortcuts', () => ({
  useWorkspaceUndoShortcuts: () => undefined,
}));

const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const OTHER_PROJECT_ID = 'container-2222222222222-bbbbbbbbb';

const doc: DocTreeNode = {
  kind: 'doc',
  id: 'doc-1111111111111-aaaaaaaaa',
  containerId: PROJECT_ID,
  title: 'Doc A',
  content: '',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const thread = (
  id: string,
  title: string,
  lastMessageAt: string | null,
  createdAt: string
): ThreadTreeNode => ({
  kind: 'thread',
  id,
  projectId: PROJECT_ID,
  title,
  sortOrder: 0,
  lastMessageAt,
  createdAt,
  updatedAt: createdAt,
});
const quiet = thread(
  'thread-1111111111111-aaaaaaaaa',
  'Thread quiet',
  null,
  '2026-03-01T00:00:00.000Z'
);
const older = thread(
  'thread-2222222222222-bbbbbbbbb',
  'Thread older',
  '2026-01-02T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
);
const newer = thread(
  'thread-3333333333333-ccccccccc',
  'Thread newer',
  '2026-02-02T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
);
const project: ContainerTreeNode = {
  kind: 'container',
  id: PROJECT_ID,
  name: 'Test project',
  category: 'project',
  parentId: null,
  folderPath: null,
  githubUrl: null,
  // The server nests a project's threads in their manual order.
  children: [doc, newer, older, quiet],
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const table = (
  id: string,
  name: string,
  projectId: string | null,
  sortOrder: number
): TableCatalogEntry => ({
  id,
  name,
  origin: 'custom',
  projectId,
  sortOrder,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const tables = [
  table('table-1111111111111-aaaaaaaaa', 'zeta', PROJECT_ID, 0),
  table('table-2222222222222-bbbbbbbbb', 'alpha', PROJECT_ID, 1),
  table('table-3333333333333-ccccccccc', 'elsewhere', OTHER_PROJECT_ID, 0),
  table('table-4444444444444-ddddddddd', 'workspace-wide', null, 0),
];

const navigation: DashboardNavigationValue = {
  openInPane: vi.fn(),
  openTable: vi.fn(),
  openThreadAgent: vi.fn(),
  requestReveal: vi.fn(),
};

function renderView(container: ContainerTreeNode, onOpenNode = vi.fn()) {
  render(
    <DashboardNavigationProvider value={navigation}>
      <ContainerView container={container} onOpenNode={onOpenNode} />
    </DashboardNavigationProvider>
  );
  return onOpenNode;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(project);
  api.listTree.mockResolvedValue([project]);
  catalog.useTableCatalog.mockReturnValue({ tables, error: null, reload: vi.fn() });
});

it('lists a project’s threads in the server’s order and keeps them out of the grid', async () => {
  const onOpenNode = renderView(project);
  const threads = await screen.findByRole('region', { name: 'Threads' });
  await waitFor(() => expect(within(threads).getAllByRole('button')).toHaveLength(3));
  // Scoped sections lead the pane: Threads, then Tables, then the Contents grid.
  const tables = await screen.findByRole('region', { name: 'Tables' });
  const contents = screen.getByRole('region', { name: 'Contents' });
  expect(threads.compareDocumentPosition(tables) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(tables.compareDocumentPosition(contents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(
    within(threads)
      .getAllByRole('button')
      .map((row) => row.textContent)
  ).toEqual([
    expect.stringContaining('Thread newer'),
    expect.stringContaining('Thread older'),
    expect.stringContaining('Thread quiet'),
  ]);
  expect(screen.getByTestId('grid')).toHaveTextContent(doc.id);
  expect(screen.getByTestId('grid')).not.toHaveTextContent('thread-');

  fireEvent.click(within(threads).getByRole('button', { name: /Thread newer/ }));
  expect(onOpenNode).toHaveBeenCalledWith(newer);
});

it('lists only the tables linked to this project, in their manual order, and opens one by catalog id', async () => {
  renderView(project);
  const section = await screen.findByRole('region', { name: 'Tables' });
  // Accessible names skip the aria-hidden chevron glyph each row carries.
  const rows = within(section).getAllByRole('button');
  expect(within(section).getByRole('button', { name: 'zeta' })).toBe(rows[0]);
  expect(within(section).getByRole('button', { name: 'alpha' })).toBe(rows[1]);
  expect(rows).toHaveLength(2);
  fireEvent.click(rows[0]);
  expect(navigation.openTable).toHaveBeenCalledWith('table-1111111111111-aaaaaaaaa');
});

it('drags a table row as a pane item so it can open in a split', async () => {
  renderView(project);
  const section = await screen.findByRole('region', { name: 'Tables' });
  const row = within(section).getByRole('button', { name: 'zeta' });
  expect(row).toHaveAttribute('draggable', 'true');

  const data = new Map<string, string>();
  fireEvent.dragStart(row, {
    dataTransfer: {
      setData: (type: string, value: string) => data.set(type, value),
      setDragImage: () => undefined,
      effectAllowed: 'all',
    },
  });
  const pane = [...data.entries()].find(([type]) => type.includes('pane'));
  expect(pane).toBeDefined();
  expect(JSON.parse(pane![1])).toMatchObject({
    kind: 'table',
    table_id: 'table-1111111111111-aaaaaaaaa',
  });
});

it('folds a long Contents grid in the order it draws, folders first', async () => {
  const docs = Array.from(
    { length: PROJECT_SECTION_PREVIEW + 1 },
    (_, i): DocTreeNode => ({
      ...doc,
      id: `doc-${1111111111111 + i}-aaaaaaaaa`,
      title: `Doc ${i + 1}`,
      sortOrder: i,
    })
  );
  // Last in the payload, but the grid draws folders before docs.
  const folder: ContainerTreeNode = {
    ...project,
    id: 'container-3333333333333-ccccccccc',
    name: 'Folder',
    category: null,
    parentId: PROJECT_ID,
    children: [],
  };
  const busy: ContainerTreeNode = { ...project, children: [...docs, folder] };
  api.get.mockResolvedValue(busy);
  api.listTree.mockResolvedValue([busy]);
  renderView(busy);

  const contents = await screen.findByRole('region', { name: 'Contents' });
  const gridIds = () => within(contents).getByTestId('grid').textContent?.split(',');
  await waitFor(() =>
    expect(gridIds()).toEqual([
      folder.id,
      ...docs.slice(0, PROJECT_SECTION_PREVIEW - 1).map((d) => d.id),
    ])
  );

  fireEvent.click(within(contents).getByRole('button', { name: `Show all ${docs.length + 1}` }));
  expect(gridIds()).toEqual([folder.id, ...docs.map((d) => d.id)]);
});

it('shows a plain container’s grid with neither section', async () => {
  const folder: ContainerTreeNode = { ...project, category: null, children: [doc] };
  api.get.mockResolvedValue(folder);
  api.listTree.mockResolvedValue([folder]);
  renderView(folder);
  await waitFor(() => expect(api.listTree).toHaveBeenCalled());
  expect(screen.getByTestId('grid')).toHaveTextContent(doc.id);
  expect(screen.queryByRole('region', { name: 'Threads' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Tables' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Contents' })).not.toBeInTheDocument();
});

/** A shift-drop of tree payloads on `target`; the pane only moves on shift. */
function shiftDrop(target: HTMLElement, payloads: unknown[]) {
  const event = createEvent.drop(target, {
    dataTransfer: {
      types: [TREE_NODE_MIME],
      getData: (type: string) => (type === TREE_NODE_MIME ? JSON.stringify(payloads) : ''),
    },
  });
  Object.defineProperty(event, 'shiftKey', { value: true });
  fireEvent(target, event);
}

it('explains a thread dropped on a plain folder instead of ignoring it', async () => {
  const folder: ContainerTreeNode = { ...project, category: null, children: [doc] };
  api.get.mockResolvedValue(folder);
  api.listTree.mockResolvedValue([folder]);
  renderView(folder);
  await waitFor(() => expect(api.listTree).toHaveBeenCalled());

  shiftDrop(screen.getByTestId('grid'), [
    { id: newer.id, kind: 'thread', parentId: PROJECT_ID, sortOrder: 0, label: newer.title },
  ]);

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Threads can only be moved into a project'
  );
});

it('keeps the icon/list view toggle in the Properties panel, not the pane bar', async () => {
  const folder: ContainerTreeNode = { ...project, category: null, children: [doc] };
  api.get.mockResolvedValue(folder);
  api.listTree.mockResolvedValue([folder]);
  renderView(folder);
  await waitFor(() => expect(api.listTree).toHaveBeenCalled());

  // Closed panel: the toggle is nowhere, only the Properties button shows.
  expect(screen.queryByRole('radiogroup', { name: 'View mode' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('properties-toggle'));

  const body = await screen.findByTestId('properties-panel-body');
  const toggle = within(body).getByRole('radiogroup', { name: 'View mode' });
  expect(within(body).getByText('View')).toBeInTheDocument();
  expect(within(toggle).getByRole('radio', { name: 'Icon view' })).toBeInTheDocument();
  expect(within(toggle).getByRole('radio', { name: 'List view' })).toBeInTheDocument();
  expect(screen.getAllByRole('radiogroup', { name: 'View mode' })).toHaveLength(1);
});
