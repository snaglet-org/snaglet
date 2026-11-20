import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { useTreeReveal, type UseTreeRevealArgs } from './useTreeReveal';

const timestamp = '2026-01-01T00:00:00.000Z';
const doc = (id: string, containerId: string): LibraryTreeChild => ({
  kind: 'doc',
  id,
  containerId,
  title: 'Doc',
  content: '',
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const tree = (children: LibraryTreeChild[]): LibraryTreeChild[] => [
  {
    kind: 'container',
    id: 'container-1',
    parentId: null,
    name: 'Folder',
    sortOrder: 0,
    category: null,
    folderPath: null,
    githubUrl: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    children,
  },
];

const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const thread = (id: string, projectId: string | null): LibraryTreeChild => ({
  kind: 'thread',
  id,
  projectId,
  title: 'Thread',
  sortOrder: 0,
  lastMessageAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const projectTree = (children: LibraryTreeChild[]): LibraryTreeChild[] => [
  {
    kind: 'container',
    id: PROJECT_ID,
    parentId: null,
    name: 'Test project',
    sortOrder: 0,
    category: 'project',
    folderPath: null,
    githubUrl: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    children,
  },
];

type Props = Omit<UseTreeRevealArgs, 'treeRef' | 'setExpanded'>;

function setup(initial: Props) {
  const setExpanded = vi.fn();
  const treeRef = { current: document.createElement('div') };
  const view = renderHook((props: Props) => useTreeReveal({ ...props, treeRef, setExpanded }), {
    initialProps: initial,
  });
  return { setExpanded, rerender: view.rerender };
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
});
afterEach(() => vi.restoreAllMocks());

describe('useTreeReveal', () => {
  const base: Props = {
    roots: tree([doc('doc-1', 'container-1')]),
    revealNodeId: null,
    revealNonce: 0,
    searchRevealId: null,
    searchRevealNonce: 0,
  };

  it('acts on a search pick once, not again on every later tree refresh', () => {
    const { setExpanded, rerender } = setup(base);
    rerender({ ...base, searchRevealId: 'doc-1', searchRevealNonce: 1 });
    expect(setExpanded).toHaveBeenCalledTimes(1);

    // A doc autosave refreshes the tree: new roots, same request.
    rerender({
      ...base,
      roots: tree([doc('doc-1', 'container-1')]),
      searchRevealId: 'doc-1',
      searchRevealNonce: 1,
    });
    rerender({
      ...base,
      roots: tree([doc('doc-1', 'container-1'), doc('doc-2', 'container-1')]),
      searchRevealId: 'doc-1',
      searchRevealNonce: 1,
    });
    expect(setExpanded).toHaveBeenCalledTimes(1);

    // A new pick of the same row is a new request.
    rerender({ ...base, searchRevealId: 'doc-1', searchRevealNonce: 2 });
    expect(setExpanded).toHaveBeenCalledTimes(2);
  });

  it('lets a later dashboard reveal win over a stale search target', () => {
    const { setExpanded, rerender } = setup(base);
    rerender({ ...base, searchRevealId: 'doc-1', searchRevealNonce: 1 });
    const roots = tree([doc('doc-1', 'container-1'), doc('doc-2', 'container-1')]);
    rerender({
      ...base,
      roots,
      searchRevealId: 'doc-1',
      searchRevealNonce: 1,
      revealNodeId: 'doc-2',
      revealNonce: 1,
    });
    expect(setExpanded).toHaveBeenCalledTimes(2);
  });

  it('keeps a request pending until the node appears in the tree', () => {
    const { setExpanded, rerender } = setup({ ...base, roots: null });
    rerender({ ...base, roots: null, revealNodeId: 'doc-2', revealNonce: 1 });
    rerender({ ...base, revealNodeId: 'doc-2', revealNonce: 1 });
    expect(setExpanded).not.toHaveBeenCalled();

    rerender({
      ...base,
      roots: tree([doc('doc-2', 'container-1')]),
      revealNodeId: 'doc-2',
      revealNonce: 1,
    });
    expect(setExpanded).toHaveBeenCalledTimes(1);
  });

  it('does not replay a request that predates the mount', () => {
    const { setExpanded } = setup({ ...base, revealNodeId: 'doc-1', revealNonce: 4 });
    expect(setExpanded).not.toHaveBeenCalled();
  });
  it('expands the project and its Threads group when revealing a project thread', () => {
    const { setExpanded, rerender } = setup({
      ...base,
      roots: projectTree([thread('thread-1111111111111-aaaaaaaaa', PROJECT_ID)]),
    });
    rerender({
      ...base,
      roots: projectTree([thread('thread-1111111111111-aaaaaaaaa', PROJECT_ID)]),
      revealNodeId: 'thread-1111111111111-aaaaaaaaa',
      revealNonce: 1,
    });
    expect(setExpanded).toHaveBeenCalledTimes(1);
    const update = setExpanded.mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    expect([...update(new Set())]).toEqual([PROJECT_ID, `${PROJECT_ID}/threads`]);
  });

  it('expands the workspace Threads group when revealing a flat thread', () => {
    const roots = [thread('thread-2222222222222-bbbbbbbbb', null)];
    const { setExpanded, rerender } = setup({ ...base, roots });
    rerender({ ...base, roots, revealNodeId: 'thread-2222222222222-bbbbbbbbb', revealNonce: 1 });
    const update = setExpanded.mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    expect([...update(new Set())]).toEqual(['workspace/threads']);
  });

  const table = (id: string, projectId: string | null): TableCatalogEntry => ({
    id,
    name: 'Table',
    origin: 'custom',
    projectId,
    sortOrder: 0,
    createdAt: timestamp,
  });

  it('expands the project and its Tables group when revealing a linked catalog table', () => {
    const roots = projectTree([]);
    const tables = [table('table-1111111111111-aaaaaaaaa', PROJECT_ID)];
    const { setExpanded, rerender } = setup({ ...base, roots, tables });
    rerender({
      ...base,
      roots,
      tables,
      revealNodeId: 'table-1111111111111-aaaaaaaaa',
      revealNonce: 1,
    });
    expect(setExpanded).toHaveBeenCalledTimes(1);
    const update = setExpanded.mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    expect([...update(new Set())]).toEqual([PROJECT_ID, `${PROJECT_ID}/tables`]);
  });

  it('expands the workspace Tables group when revealing an unlinked table', () => {
    const roots = projectTree([]);
    const tables = [table('table-2222222222222-bbbbbbbbb', null)];
    const { setExpanded, rerender } = setup({ ...base, roots, tables });
    rerender({
      ...base,
      roots,
      tables,
      revealNodeId: 'table-2222222222222-bbbbbbbbb',
      revealNonce: 1,
    });
    const update = setExpanded.mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    expect([...update(new Set())]).toEqual(['workspace/tables']);
  });

  it('keeps a table reveal pending until the catalog holds it', () => {
    const roots = projectTree([]);
    const { setExpanded, rerender } = setup({ ...base, roots, tables: null });
    rerender({
      ...base,
      roots,
      tables: null,
      revealNodeId: 'table-2222222222222-bbbbbbbbb',
      revealNonce: 1,
    });
    expect(setExpanded).not.toHaveBeenCalled();
    rerender({
      ...base,
      roots,
      tables: [table('table-2222222222222-bbbbbbbbb', null)],
      revealNodeId: 'table-2222222222222-bbbbbbbbb',
      revealNonce: 1,
    });
    expect(setExpanded).toHaveBeenCalledTimes(1);
  });
});
