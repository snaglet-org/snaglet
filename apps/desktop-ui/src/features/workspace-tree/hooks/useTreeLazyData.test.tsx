/**
 * useTreeLazyData fills the per-project file cache for every expanded
 * project, however it opened — including a reveal or create flow that adds
 * it to the expanded set after the tree loaded, with no chevron click.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerTreeNode } from '../../../utils/api';

const api = vi.hoisted(() => ({
  listByProject: vi.fn(),
  listAgents: vi.fn(),
  listParticipants: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({
  filesApi: { listByProject: api.listByProject },
  agentsApi: { list: api.listAgents },
}));
vi.mock('../../../utils/api/threads', () => ({
  threadsApi: { listParticipants: api.listParticipants },
}));

import { useTreeLazyData } from './useTreeLazyData';

const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const project: ContainerTreeNode = {
  kind: 'container',
  id: PROJECT_ID,
  parentId: null,
  name: 'Test project',
  sortOrder: 0,
  category: 'project',
  folderPath: '/tmp/test-project',
  githubUrl: null,
  createdBy: null,
  lastEditedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  children: [],
};

// One roots array across renders, as the tree keeps it until a refetch.
const roots = [project];

beforeEach(() => {
  vi.resetAllMocks();
  api.listByProject.mockResolvedValue([]);
});

describe('useTreeLazyData', () => {
  it('loads the files of a project expanded after the tree loaded', async () => {
    const { result, rerender } = renderHook(
      ({ expanded }: { expanded: Set<string> }) =>
        useTreeLazyData({ roots, expanded, reloadKey: 0 }),
      { initialProps: { expanded: new Set<string>() } }
    );
    expect(api.listByProject).not.toHaveBeenCalled();

    rerender({ expanded: new Set([PROJECT_ID]) });

    await waitFor(() => expect(result.current.projectFiles.get(PROJECT_ID)).toEqual([]));
    expect(api.listByProject).toHaveBeenCalledTimes(1);
    expect(api.listByProject).toHaveBeenCalledWith(PROJECT_ID);
  });
});
