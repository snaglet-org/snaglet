import { describe, expect, it } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { findNodeAncestorNodes, findNodeAncestors, findNodeTitle } from './nodeAncestors';

// Minimal tree builders — only the fields the ancestor walk reads.
function container(id: string, name: string, children: LibraryTreeChild[] = []): LibraryTreeChild {
  return { kind: 'container', id, name, category: null, children } as unknown as LibraryTreeChild;
}
function project(id: string, name: string, children: LibraryTreeChild[] = []): LibraryTreeChild {
  return {
    kind: 'container',
    id,
    name,
    category: 'project',
    children,
  } as unknown as LibraryTreeChild;
}
function doc(id: string, title: string): LibraryTreeChild {
  return { kind: 'doc', id, title } as unknown as LibraryTreeChild;
}
function thread(id: string, title: string): LibraryTreeChild {
  return { kind: 'thread', id, title } as unknown as LibraryTreeChild;
}

// The server nests a thread under its project container (never under a
// folder); a flat thread sits at the root.
const tree: LibraryTreeChild[] = [
  container('c-snaglet', 'Snaglet', [
    container('c-prog', 'In Progress', [doc('d-1', 'Doc title')]),
    project('c-proj', 'Project A', [thread('t-1', 'Thread title')]),
    doc('d-root', 'Top-level doc'),
  ]),
  project('c-proj-root', 'Project B'),
  thread('t-flat', 'Flat thread'),
];

describe('findNodeAncestors', () => {
  it('resolves the container path for a nested doc', () => {
    expect(findNodeAncestors(tree, 'd-1')).toEqual(['Snaglet', 'In Progress']);
  });

  it('resolves the project lineage for a project thread', () => {
    expect(findNodeAncestors(tree, 't-1')).toEqual(['Snaglet', 'Project A']);
  });

  it('resolves an empty path for a flat thread', () => {
    expect(findNodeAncestors(tree, 't-flat')).toEqual([]);
  });

  it('resolves the direct-parent path for a doc one level deep', () => {
    expect(findNodeAncestors(tree, 'd-root')).toEqual(['Snaglet']);
  });

  it('returns an empty path for a root-level container (no ancestors)', () => {
    expect(findNodeAncestors(tree, 'c-snaglet')).toEqual([]);
  });

  it('returns the container path for a nested container', () => {
    expect(findNodeAncestors(tree, 'c-prog')).toEqual(['Snaglet']);
  });

  it('returns null when the node is not in the tree', () => {
    expect(findNodeAncestors(tree, 'missing')).toBeNull();
  });
});

describe('findNodeAncestorNodes', () => {
  it('returns the containers themselves, the direct parent last', () => {
    const ancestors = findNodeAncestorNodes(tree, 'd-1') ?? [];
    expect(ancestors.map((ancestor) => ancestor.id)).toEqual(['c-snaglet', 'c-prog']);
    expect(ancestors.every((ancestor) => ancestor.kind === 'container')).toBe(true);
  });

  it('returns null when the node is not in the tree', () => {
    expect(findNodeAncestorNodes(tree, 'missing')).toBeNull();
  });
});

describe('findNodeTitle', () => {
  it('names a container by its name and other nodes by their title, at any depth', () => {
    expect(findNodeTitle(tree, 'c-prog')).toBe('In Progress');
    expect(findNodeTitle(tree, 'd-1')).toBe('Doc title');
    expect(findNodeTitle(tree, 't-1')).toBe('Thread title');
    expect(findNodeTitle(tree, 't-flat')).toBe('Flat thread');
  });

  it('returns null for a missing or untitled node', () => {
    expect(findNodeTitle(tree, 'd-missing')).toBeNull();
    expect(findNodeTitle([thread('t-untitled', '  ')], 't-untitled')).toBeNull();
    expect(
      findNodeTitle([{ kind: 'thread', id: 't-null', title: null } as LibraryTreeChild], 't-null')
    ).toBeNull();
  });
});
