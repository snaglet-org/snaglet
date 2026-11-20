import { describe, expect, it } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import {
  greeting,
  indexTree,
  messageSnippet,
  readPins,
  recentDocs,
  recentThreads,
} from './hubModel';

const doc = (id: string, updatedAt: string): LibraryTreeChild => ({
  kind: 'doc',
  id,
  containerId: null,
  title: `Doc ${id}`,
  content: '',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt,
});

const thread = (id: string, lastMessageAt: string | null, updatedAt: string): LibraryTreeChild => ({
  kind: 'thread',
  id,
  projectId: null,
  title: `Thread ${id}`,
  sortOrder: 0,
  lastMessageAt,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt,
});

const container = (
  id: string,
  name: string,
  children: LibraryTreeChild[],
  category: 'project' | null = null
): LibraryTreeChild => ({
  kind: 'container',
  id,
  parentId: null,
  name,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  children,
  category,
  folderPath: null,
  githubUrl: null,
});

const tree: LibraryTreeChild[] = [
  doc('loose', '2026-11-10T00:00:00.000Z'),
  thread('flat', null, '2026-11-12T00:00:00.000Z'),
  container(
    'p1',
    'Snaglet',
    [
      thread('in-project', '2026-11-15T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
      container('f1', 'Design', [doc('nested', '2026-11-16T00:00:00.000Z')]),
    ],
    'project'
  ),
];

describe('indexTree', () => {
  it('lists docs with their folder path and threads with their project', () => {
    const index = indexTree(tree);
    expect(index.docsById.get('nested')?.path).toEqual(['Snaglet', 'Design']);
    expect(index.docsById.get('loose')?.path).toEqual([]);
    expect(index.threadsById.get('in-project')?.projectName).toBe('Snaglet');
    expect(index.threadsById.get('flat')?.projectName).toBeNull();
    expect(index.projects.map((p) => p.id)).toEqual(['p1']);
  });
});

describe('recent lists', () => {
  it('orders threads by last message, else last change, newest first', () => {
    const ids = recentThreads(indexTree(tree)).map((t) => t.node.id);
    expect(ids).toEqual(['in-project', 'flat']);
  });

  it('orders docs by last edit and keeps the limit', () => {
    const index = indexTree(tree);
    expect(recentDocs(index).map((d) => d.node.id)).toEqual(['nested', 'loose']);
    expect(recentDocs(index, 1).map((d) => d.node.id)).toEqual(['nested']);
  });
});

describe('greeting', () => {
  it('follows the time of day', () => {
    expect(greeting(new Date(2026, 10, 16, 8))).toBe('Good morning');
    expect(greeting(new Date(2026, 10, 16, 13))).toBe('Good afternoon');
    expect(greeting(new Date(2026, 10, 16, 21))).toBe('Good evening');
  });
});

describe('messageSnippet', () => {
  it('reads markdown as one plain line, keeping chip labels', () => {
    expect(
      messageSnippet(
        '## Done\n\n**Signed** the build, see [Release notes](doc-123).\n\n```sh\npnpm build\n```\n- next: `smoke`'
      )
    ).toBe('Done Signed the build, see Release notes. next: smoke');
  });

  it('cuts long text with an ellipsis', () => {
    const text = messageSnippet('word '.repeat(100), 20);
    expect(text.length).toBeLessThanOrEqual(20);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('readPins', () => {
  it('reads one person’s pins oldest first and drops malformed ones', () => {
    const value = {
      'user-a': {
        'doc:d2': { kind: 'doc', id: 'd2', pinnedAt: '2026-11-16T02:00:00.000Z' },
        'table:t1': {
          kind: 'table',
          id: 't1',
          title: 'Budget',
          pinnedAt: '2026-11-16T01:00:00.000Z',
        },
        'agent:x': { kind: 'agent', id: 'x', pinnedAt: '2026-11-16T03:00:00.000Z' },
        broken: 'nope',
      },
      'user-b': { 'doc:d9': { kind: 'doc', id: 'd9', pinnedAt: '2026-11-16T00:00:00.000Z' } },
    };
    expect(readPins(value, 'user-a')).toEqual([
      { kind: 'table', id: 't1', title: 'Budget', pinnedAt: '2026-11-16T01:00:00.000Z' },
      { kind: 'doc', id: 'd2', pinnedAt: '2026-11-16T02:00:00.000Z' },
    ]);
    expect(readPins(value, 'user-c')).toEqual([]);
    expect(readPins(null, 'user-a')).toEqual([]);
  });
});
