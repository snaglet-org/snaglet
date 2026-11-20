import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerTreeNode, DocTreeNode } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import {
  __resetProjectListForTests,
  collectProjects,
  projectLabel,
  projectOptionLabel,
  useLinkedProjectFolders,
  useProjectList,
} from './projectList';

const api = vi.hoisted(() => ({ listTree: vi.fn() }));

vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return { ...actual, containersApi: { ...actual.containersApi, listTree: api.listTree } };
});

const timestamp = '2026-01-01T00:00:00.000Z';

function container(
  id: string,
  name: string,
  category: ContainerTreeNode['category'],
  children: ContainerTreeNode['children'] = []
): ContainerTreeNode {
  return {
    kind: 'container',
    id,
    parentId: null,
    name,
    sortOrder: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    children,
    category,
    folderPath: null,
    githubUrl: null,
  };
}

const doc: DocTreeNode = {
  kind: 'doc',
  id: 'doc-1111111111111-aaaaaaaaa',
  containerId: null,
  title: 'Test doc',
  content: '',
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const sales = container('container-4444444444444-project2', 'Sales', 'project');
const launch = container('container-3333333333333-project1', 'Launch', 'project', [
  container('container-5555555555555-folder02', 'Doing', null),
]);
const archive = container('container-6666666666666-folder01', 'Archive', null, [sales]);

beforeEach(() => {
  __resetProjectListForTests();
  api.listTree.mockReset().mockResolvedValue([doc, launch, archive]);
});

describe('collectProjects', () => {
  it('lists project containers at any depth, sorted by name, with their lineage', () => {
    expect(collectProjects([doc, archive, launch])).toEqual([
      { id: launch.id, name: 'Launch', ancestors: [] },
      { id: sales.id, name: 'Sales', ancestors: ['Archive'] },
    ]);
  });
});

describe('project labels', () => {
  const projects = collectProjects([doc, archive, launch]);

  it('prefixes a nested project with its lineage', () => {
    expect(projectOptionLabel(projects[0])).toBe('Launch');
    expect(projectOptionLabel(projects[1])).toBe('Archive / Sales');
  });

  it('names a listed project, calls an unlisted one archived, and reads as loading before the list', () => {
    expect(projectLabel(sales.id, projects)).toBe('Sales');
    expect(projectLabel('container-9999999999999-gone0001', projects)).toBe('Archived project');
    expect(projectLabel(sales.id, null)).toBe('Loading project…');
    expect(projectLabel(sales.id, null, { loaded: true })).toBe('Archived project');
  });
});

describe('useProjectList', () => {
  it('loads the tree once for every mount and shares the result', async () => {
    const first = renderHook(() => useProjectList());
    const second = renderHook(() => useProjectList());
    expect(first.result.current.projects).toBeNull();

    await waitFor(() => expect(first.result.current.projects).toHaveLength(2));
    expect(second.result.current.projects).toBe(first.result.current.projects);
    expect(api.listTree).toHaveBeenCalledTimes(1);
  });

  it('reports a failed load and clears it on a successful reload', async () => {
    api.listTree.mockRejectedValueOnce(new Error('HTTP 502'));
    const { result } = renderHook(() => useProjectList());
    await waitFor(() => expect(result.current.error).toBe('HTTP 502'));
    expect(result.current.projects).toBeNull();

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(result.current.error).toBeNull();
  });

  it('renames a flat project in place and re-sorts without a refetch', async () => {
    api.listTree.mockResolvedValue([doc, launch, sales]);
    const { result } = renderHook(() => useProjectList());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    act(() => emitLibraryEvent({ type: 'renamed', kind: 'container', id: launch.id, name: 'Zed' }));
    expect(result.current.projects?.map((project) => project.name)).toEqual(['Sales', 'Zed']);
    act(() => emitLibraryEvent({ type: 'renamed', kind: 'doc', id: doc.id, name: 'Other' }));
    act(() =>
      emitLibraryEvent({ type: 'renamed', kind: 'container', id: archive.id, name: 'Other' })
    );
    expect(result.current.projects?.map((project) => project.name)).toEqual(['Sales', 'Zed']);
    expect(api.listTree).toHaveBeenCalledTimes(1);
  });

  it('refetches on a container rename while a nested project exists (its lineage may have changed)', async () => {
    const { result } = renderHook(() => useProjectList());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    const renamedArchive = container(archive.id, 'Vault', null, [sales]);
    api.listTree.mockResolvedValue([doc, launch, renamedArchive]);
    act(() =>
      emitLibraryEvent({ type: 'renamed', kind: 'container', id: archive.id, name: 'Vault' })
    );
    await waitFor(() =>
      expect(
        result.current.projects?.find((project) => project.id === sales.id)?.ancestors
      ).toEqual(['Vault'])
    );
    expect(api.listTree).toHaveBeenCalledTimes(2);
  });

  it('refetches for a created project container and ignores created folders', async () => {
    const { result } = renderHook(() => useProjectList());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    const alpha = container('container-7777777777777-project3', 'Alpha', 'project');
    const folder = container('container-8888888888888-folder02', 'Misc', null);

    act(() =>
      emitLibraryEvent({ type: 'created', kind: 'container', id: folder.id, node: folder })
    );
    expect(api.listTree).toHaveBeenCalledTimes(1);

    api.listTree.mockResolvedValue([doc, launch, archive, alpha]);
    act(() => emitLibraryEvent({ type: 'created', kind: 'container', id: alpha.id, node: alpha }));
    await waitFor(() =>
      expect(result.current.projects?.map((project) => project.name)).toEqual([
        'Alpha',
        'Launch',
        'Sales',
      ])
    );
    expect(api.listTree).toHaveBeenCalledTimes(2);
  });

  it('refetches when a container is deleted or the tree changes elsewhere', async () => {
    const { result } = renderHook(() => useProjectList());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    api.listTree.mockResolvedValue([doc, launch]);
    act(() => emitLibraryEvent({ type: 'deleted', kind: 'container', id: archive.id }));
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    api.listTree.mockResolvedValue([doc, launch, archive]);
    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [sales.id] }));
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    api.listTree.mockResolvedValue([doc]);
    act(() => emitLibraryEvent({ type: 'archive-changed', ids: [launch.id], reload: true }));
    await waitFor(() => expect(result.current.projects).toHaveLength(0));
    expect(api.listTree).toHaveBeenCalledTimes(4);
  });
});

describe('useLinkedProjectFolders', () => {
  it('loads nothing until enabled, then lists the linked folders', async () => {
    const linked = { ...container('container-7777777777777-project3', 'Site', 'project') };
    linked.folderPath = '/tmp/test-project';
    api.listTree.mockResolvedValue([launch, linked]);

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useLinkedProjectFolders(enabled),
      { initialProps: { enabled: false } }
    );
    expect(api.listTree).not.toHaveBeenCalled();
    expect(result.current).toBeNull();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current).toEqual(['/tmp/test-project']));
  });
});
