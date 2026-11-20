import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ContainerTreeNode } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { ContainerView } from './ContainerView';

const api = vi.hoisted(() => ({ get: vi.fn(), listTree: vi.fn(), update: vi.fn() }));
const members = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@desktop/utils/api', async (original) => ({
  ...(await original<typeof import('@desktop/utils/api')>()),
  containersApi: api,
  membersApi: members,
}));
vi.mock('./DetailsPanel/DetailsPanel', () => ({
  DetailsPanel: () => <div data-testid="project-details">PROJECT</div>,
}));
vi.mock('../../chrome/PaneChrome/PaneChrome', () => ({
  usePaneChromeActions: () => undefined,
  useHasPaneChrome: () => false,
}));
vi.mock('./IconsMode', () => ({ IconsMode: () => null }));
vi.mock('@desktop/features/workspace-tree/hooks/useTreeClipboard', () => ({
  useTreeClipboard: () => ({}),
}));
vi.mock('@desktop/features/workspace-tree/undo/useWorkspaceUndoShortcuts', () => ({
  useWorkspaceUndoShortcuts: () => undefined,
}));

const container: ContainerTreeNode = {
  kind: 'container',
  id: 'container-test',
  name: 'Test container',
  category: null,
  parentId: null,
  folderPath: null,
  githubUrl: null,
  children: [],
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
};
beforeEach(() => {
  vi.clearAllMocks();
  api.listTree.mockResolvedValue([container]);
  api.get.mockResolvedValue({
    ...container,
    createdBy: 'member-1',
    lastEditedBy: null,
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
  });
  members.list.mockResolvedValue([{ id: 'member-1', kind: 'user', displayName: 'Test User' }]);
});

it('shows no kind badge, and read-only attribution plus the promote action when expanded', async () => {
  render(<ContainerView container={container} />);
  expect(screen.queryByText('Folder')).not.toBeInTheDocument();
  expect(screen.queryByText(/^Created by /)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Make this a project' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('properties-toggle'));
  expect(await screen.findByText('Created by Test User')).toBeInTheDocument();
  // No taxonomy editor: `project` is the only category, so the folder offers
  // the one-way promote action rather than a selector.
  expect(screen.getByRole('button', { name: 'Make this a project' })).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Phase')).not.toBeInTheDocument();
});

it('"Make this a project" asks for an inline confirm, and Cancel backs out without calling the API', async () => {
  render(<ContainerView container={container} />);
  fireEvent.click(screen.getByTestId('properties-toggle'));
  fireEvent.click(await screen.findByRole('button', { name: 'Make this a project' }));
  expect(
    screen.getByText('Projects can hold threads and tables and cannot be turned back into folders.')
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('group', { name: 'Confirm make project' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Make this a project' })).toBeInTheDocument();
  expect(api.update).not.toHaveBeenCalled();
});

it('Confirm promotes through the API and the pane becomes the project pane', async () => {
  api.update.mockImplementation(async () => {
    // The server has written the row by the time the PATCH resolves; the
    // pane's reconcile refetches it and sees the new category.
    api.get.mockResolvedValue({ ...container, category: 'project' });
    return { ...container, category: 'project' };
  });
  render(<ContainerView container={container} />);
  fireEvent.click(screen.getByTestId('properties-toggle'));
  fireEvent.click(await screen.findByRole('button', { name: 'Make this a project' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  });
  expect(api.update).toHaveBeenCalledWith(container.id, { category: 'project' });
  expect(await screen.findByTestId('project-details')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Container properties' })).not.toBeInTheDocument();
});

it('shows the server error inline when promotion is refused and stays a folder', async () => {
  api.update.mockRejectedValue(new Error('container not found'));
  render(<ContainerView container={container} />);
  fireEvent.click(screen.getByTestId('properties-toggle'));
  fireEvent.click(await screen.findByRole('button', { name: 'Make this a project' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('container not found');
  // Still a folder: the confirm stays open for a retry, no project pane.
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Container properties' })).toBeInTheDocument();
  expect(screen.queryByTestId('project-details')).not.toBeInTheDocument();
});

it('swaps between folder properties and project details when the saved category changes', async () => {
  render(<ContainerView container={container} />);
  fireEvent.click(screen.getByTestId('properties-toggle'));
  for (const category of ['project', null] as const) {
    api.get.mockResolvedValue({ ...container, category });
    await act(async () => {
      emitLibraryEvent({ type: 'tree-invalidated', ids: [container.id] });
    });
    if (category === 'project') {
      expect(screen.getByTestId('project-details')).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Project properties' })).toBeInTheDocument();
      expect(
        screen.queryByRole('region', { name: 'Container properties' })
      ).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole('region', { name: 'Container properties' })).toBeInTheDocument();
      expect(screen.queryByTestId('project-details')).not.toBeInTheDocument();
    }
  }
});

it('ContainerAttribution renders the read-only created/updated/edited line for any container (projects reuse it)', async () => {
  const { ContainerAttribution } = await import('./ContainerProperties');
  api.get.mockResolvedValue({
    ...container,
    category: 'project',
    createdBy: 'member-1',
    lastEditedBy: 'member-2',
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
  });
  members.list.mockResolvedValue([
    { id: 'member-1', kind: 'user', displayName: 'Test User' },
    { id: 'member-2', kind: 'agent', displayName: 'test-agent-a' },
  ]);
  render(<ContainerAttribution containerId={container.id} />);
  expect(await screen.findByText('Created by Test User')).toBeInTheDocument();
  expect(screen.getByText('Jan 1, 2026')).toBeInTheDocument();
  expect(screen.getByText('Edited by test-agent-a')).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});
