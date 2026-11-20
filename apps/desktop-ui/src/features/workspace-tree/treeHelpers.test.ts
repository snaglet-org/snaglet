import { describe, expect, it } from 'vitest';
import type { ContainerTreeNode, DocTreeNode, ThreadTreeNode } from '@desktop/utils/api';
import { resolveDropTarget } from './treeHelpers';
import { partitionThreads, placementParentOf, tablesGroupId, threadsGroupId } from './treeUtils';

const timestamp = '2026-01-01T00:00:00.000Z';
const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';

const doc: DocTreeNode = {
  kind: 'doc',
  id: 'doc-1111111111111-aaaaaaaaa',
  containerId: PROJECT_ID,
  title: 'Notes',
  content: '',
  sortOrder: 3,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const thread: ThreadTreeNode = {
  kind: 'thread',
  id: 'thread-1111111111111-aaaaaaaaa',
  projectId: PROJECT_ID,
  title: 'Planning chat',
  sortOrder: 0,
  lastMessageAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const project: ContainerTreeNode = {
  kind: 'container',
  id: PROJECT_ID,
  parentId: null,
  name: 'Test project',
  sortOrder: 1,
  category: 'project',
  folderPath: null,
  githubUrl: null,
  createdBy: null,
  lastEditedBy: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  children: [doc, thread],
};

describe('resolveDropTarget', () => {
  it('drops inside a container with no positional intent', () => {
    expect(resolveDropTarget(project, 'inside')).toEqual({
      parentId: PROJECT_ID,
      sortOrder: undefined,
    });
  });

  it('drops beside a doc at its slot', () => {
    expect(resolveDropTarget(doc, 'above')).toEqual({ parentId: PROJECT_ID, sortOrder: 3 });
    expect(resolveDropTarget(doc, 'below')).toEqual({ parentId: PROJECT_ID, sortOrder: 4 });
  });

  it('drops beside a thread at its slot in its project, never inside it', () => {
    expect(resolveDropTarget(thread, 'above')).toEqual({ parentId: PROJECT_ID, sortOrder: 0 });
    expect(resolveDropTarget(thread, 'below')).toEqual({ parentId: PROJECT_ID, sortOrder: 1 });
    expect(resolveDropTarget(thread, 'inside')).toBeUndefined();
  });

  it('resolves the root for a null target', () => {
    expect(resolveDropTarget(null, 'inside')).toEqual({ parentId: null, sortOrder: undefined });
  });
});

describe('thread placement helpers', () => {
  it('reads a thread placement from its project, a folder node from its parent', () => {
    expect(placementParentOf(thread)).toBe(PROJECT_ID);
    expect(placementParentOf({ ...thread, projectId: null })).toBeNull();
    expect(placementParentOf(doc)).toBe(PROJECT_ID);
    expect(placementParentOf(project)).toBeNull();
  });

  it('splits a child list into threads and folder-tree rows, keeping order', () => {
    expect(partitionThreads(project.children)).toEqual({ threads: [thread], others: [doc] });
  });

  it('keys the generated groups apart from node ids', () => {
    expect(threadsGroupId(null)).toBe('workspace/threads');
    expect(threadsGroupId(PROJECT_ID)).toBe(`${PROJECT_ID}/threads`);
    expect(tablesGroupId(PROJECT_ID)).toBe(`${PROJECT_ID}/tables`);
  });
});
