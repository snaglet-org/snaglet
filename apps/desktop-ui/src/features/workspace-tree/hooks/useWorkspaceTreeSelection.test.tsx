import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { useWorkspaceTreeSelection } from './useWorkspaceTreeSelection';

const FIRST = {
  kind: 'doc',
  id: 'doc-1',
  containerId: null,
  title: 'First',
} as LibraryTreeChild;

const SECOND = {
  kind: 'doc',
  id: 'doc-2',
  containerId: null,
  title: 'Second',
} as LibraryTreeChild;

const plainActivation = { metaKey: false, ctrlKey: false, shiftKey: false };

describe('useWorkspaceTreeSelection row activation', () => {
  it('selects and opens a plainly activated row', () => {
    const onNodeClick = vi.fn();
    const { result } = renderHook(() =>
      useWorkspaceTreeSelection({
        roots: [FIRST, SECOND],
        expanded: new Set(),
        tablesByProject: null,
        workspaceTables: null,
        onNodeClick,
      })
    );

    act(() => result.current.clickRow(FIRST, plainActivation));

    expect(result.current.selectedIds).toEqual(new Set([FIRST.id]));
    expect(result.current.selectionAnchorId).toBe(FIRST.id);
    expect(onNodeClick).toHaveBeenCalledWith(FIRST);
  });

  it('retains modifier multi-select behavior without opening a pane', () => {
    const onNodeClick = vi.fn();
    const { result } = renderHook(() =>
      useWorkspaceTreeSelection({
        roots: [FIRST, SECOND],
        expanded: new Set(),
        tablesByProject: null,
        workspaceTables: null,
        onNodeClick,
      })
    );

    act(() => result.current.clickRow(FIRST, plainActivation));
    onNodeClick.mockClear();
    act(() =>
      result.current.clickRow(SECOND, {
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
      })
    );

    expect(result.current.selectedIds).toEqual(new Set([FIRST.id, SECOND.id]));
    expect(result.current.selectionAnchorId).toBe(SECOND.id);
    expect(onNodeClick).not.toHaveBeenCalled();
  });
  it('lists threads and tables in drawn order only while their groups are expanded', () => {
    const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
    const projectThread = {
      kind: 'thread',
      id: 'thread-1111111111111-aaaaaaaaa',
      projectId: PROJECT_ID,
      title: 'Project chat',
    } as LibraryTreeChild;
    const flatThread = {
      kind: 'thread',
      id: 'thread-2222222222222-bbbbbbbbb',
      projectId: null,
      title: 'Flat chat',
    } as LibraryTreeChild;
    const project = {
      kind: 'container',
      id: PROJECT_ID,
      parentId: null,
      name: 'Test project',
      category: 'project',
      children: [projectThread, FIRST],
    } as LibraryTreeChild;
    const projectTable = table('table-1111111111111-aaaaaaaaa', PROJECT_ID, 0);
    const flatTable = table('table-2222222222222-bbbbbbbbb', null, 0);
    // A root doc listed before the project still draws after it, in the
    // workspace Docs & context group.
    const roots = [SECOND, project, flatThread];
    const render = (expanded: Set<string>) =>
      renderHook(() =>
        useWorkspaceTreeSelection({
          roots,
          expanded,
          tablesByProject: new Map([[PROJECT_ID, [projectTable]]]),
          workspaceTables: [flatTable],
          onNodeClick: vi.fn(),
        })
      ).result.current.visibleOrderIndex;

    // Collapsed groups hide their rows; a project's folder rows keep their
    // places, and the root doc hides with its Docs & context group.
    const collapsed = render(new Set([PROJECT_ID]));
    expect([...collapsed.keys()]).toEqual([PROJECT_ID, FIRST.id]);

    // Open groups: a project's Threads and Tables rows come
    // before its folders, as drawn; the workspace groups follow the projects.
    const open = render(
      new Set([
        PROJECT_ID,
        'workspace/items',
        `${PROJECT_ID}/threads`,
        `${PROJECT_ID}/tables`,
        'workspace/threads',
        'workspace/tables',
      ])
    );
    expect([...open.keys()]).toEqual([
      PROJECT_ID,
      projectThread.id,
      projectTable.id,
      FIRST.id,
      SECOND.id,
      flatThread.id,
      flatTable.id,
    ]);
  });

  it('selects table rows with the same gestures, and opens one only on a plain click', () => {
    const tableA = table('table-1111111111111-aaaaaaaaa', null, 0);
    const tableB = table('table-2222222222222-bbbbbbbbb', null, 1);
    const tableC = table('table-3333333333333-ccccccccc', null, 2);
    const { result } = renderHook(() =>
      useWorkspaceTreeSelection({
        roots: [FIRST],
        expanded: new Set(['workspace/tables']),
        tablesByProject: new Map(),
        workspaceTables: [tableA, tableB, tableC],
        onNodeClick: vi.fn(),
      })
    );

    let opened = false;
    act(() => {
      opened = result.current.clickTable(tableA, plainActivation);
    });
    expect(opened).toBe(true);
    expect(result.current.selectedIds).toEqual(new Set([tableA.id]));

    act(() => {
      opened = result.current.clickTable(tableC, { ...plainActivation, shiftKey: true });
    });
    expect(opened).toBe(false);
    expect(result.current.selectedIds).toEqual(new Set([tableA.id, tableB.id, tableC.id]));

    act(() => {
      opened = result.current.clickTable(tableB, { ...plainActivation, metaKey: true });
    });
    expect(opened).toBe(false);
    expect(result.current.selectedIds).toEqual(new Set([tableA.id, tableC.id]));

    // A doc and a table can share one selection.
    act(() => result.current.clickRow(FIRST, { ...plainActivation, metaKey: true }));
    expect(result.current.selectedIds).toEqual(new Set([tableA.id, tableC.id, FIRST.id]));
  });
});

function table(id: string, projectId: string | null, sortOrder: number): TableCatalogEntry {
  return {
    id,
    name: `Table ${sortOrder}`,
    origin: 'custom',
    projectId,
    sortOrder,
    createdAt: '2026-07-29T12:00:00.000Z',
  };
}
