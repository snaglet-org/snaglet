/**
 * WikiLinkPreviewModal — a container preview mounts the same ContainerView a
 * pane shows, for projects too (so a project preview lists its threads and
 * tables), whether the chip names the container or the project.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ContainerTreeNode } from '@desktop/utils/api';
import { WikiLinkPreviewModal } from './WikiLinkPreviewModal';

const api = vi.hoisted(() => ({ get: vi.fn(), listTree: vi.fn() }));
vi.mock('@desktop/utils/api', async (original) => ({
  ...(await original<typeof import('@desktop/utils/api')>()),
  containersApi: api,
}));
vi.mock('@desktop/features/rich-markdown/renderer/useWorkspaceAncestors', () => ({
  useWorkspaceAncestors: () => [],
}));
vi.mock('@desktop/pages/Dashboard/views/ContainerView', () => ({
  ContainerView: ({ container }: { container: ContainerTreeNode }) => (
    <div data-testid="container-view">
      {container.id}:{container.category ?? 'none'}
    </div>
  ),
}));

const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const project: ContainerTreeNode = {
  kind: 'container',
  id: PROJECT_ID,
  name: 'Test project',
  category: 'project',
  parentId: null,
  folderPath: null,
  githubUrl: null,
  children: [],
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({
    id: PROJECT_ID,
    parentId: null,
    name: 'Test project',
    sortOrder: 0,
    x: null,
    y: null,
    category: 'project',
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
  api.listTree.mockResolvedValue([project]);
});

it('previews a project container through ContainerView', async () => {
  render(<WikiLinkPreviewModal kind="container" id={PROJECT_ID} onClose={vi.fn()} />);
  expect(await screen.findByTestId('container-view')).toHaveTextContent(`${PROJECT_ID}:project`);
});

it('previews a project chip through the same ContainerView, loading it as a container', async () => {
  render(<WikiLinkPreviewModal kind="project" id={PROJECT_ID} onClose={vi.fn()} />);
  expect(await screen.findByTestId('container-view')).toHaveTextContent(`${PROJECT_ID}:project`);
  expect(api.get).toHaveBeenCalledWith(PROJECT_ID);
});
