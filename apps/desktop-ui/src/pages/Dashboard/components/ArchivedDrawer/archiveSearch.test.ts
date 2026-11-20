import { describe, expect, it } from 'vitest';
import type { ArchivedNode } from '@desktop/utils/api';
import {
  archiveKindOf,
  buildArchiveIndex,
  matchRanges,
  parseArchiveQuery,
  searchArchive,
} from './archiveSearch';

function node(
  id: string,
  type: string,
  title: string | null,
  extra: Partial<ArchivedNode> = {}
): ArchivedNode {
  return {
    id,
    type,
    title,
    archived: true,
    archived_at: '2026-07-06T00:00:00Z',
    container_id: null,
    project_id: null,
    sort_order: 0,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-06T00:00:00Z',
    ...extra,
  };
}

const showA = node('container-a', 'container', 'Radio show A');
const showB = node('container-b', 'container', 'Radio show B');
const segmentsA = node('table-a', 'table', 'segments', { container_id: 'container-a' });
const segmentsB = node('table-b', 'table', 'segments', { container_id: 'container-b' });
const notesA = node('field-a', 'table_field', 'notes', { container_id: 'table-a' });
const plan = node('doc-a', 'doc', 'Launch plan');
const tree = {
  roots: [showA, plan, showB],
  children: [segmentsA, segmentsB, notesA],
};

const titles = (rows: { entry: { title: string } }[]) => rows.map((row) => row.entry.title);

describe('parseArchiveQuery', () => {
  it('lowercases, splits on whitespace and drops repeats', () => {
    expect(parseArchiveQuery('  Radio   SEGMENTS radio ')).toEqual(['radio', 'segments']);
    expect(parseArchiveQuery('   ')).toEqual([]);
  });
});

describe('archiveKindOf', () => {
  it('maps each listed type to its kind and anything else to other', () => {
    expect(archiveKindOf('container')).toBe('container');
    expect(archiveKindOf('table_field')).toBe('table_field');
    expect(archiveKindOf('mystery')).toBe('other');
  });
});

describe('buildArchiveIndex', () => {
  it('lists roots with their subtrees in the drawer order, with each archived parent path', () => {
    const index = buildArchiveIndex(tree, 'default');
    expect(index.map((entry) => [entry.title, entry.depth, entry.path])).toEqual([
      ['Radio show A', 0, []],
      ['segments', 1, ['Radio show A']],
      ['notes', 2, ['Radio show A', 'segments']],
      ['Launch plan', 0, []],
      ['Radio show B', 0, []],
      ['segments', 1, ['Radio show B']],
    ]);
  });

  it('starts a root in an active folder at that folder’s location', () => {
    const index = buildArchiveIndex(
      {
        roots: [node('container-x', 'container', 'Drafts', { location: ['Live project', 'docs'] })],
        children: [node('doc-x', 'doc', 'Outline', { container_id: 'container-x' })],
      },
      'default'
    );
    expect(index.map((entry) => entry.path)).toEqual([
      ['Live project', 'docs'],
      ['Live project', 'docs', 'Drafts'],
    ]);
    const result = searchArchive(index, {
      terms: parseArchiveQuery('live outline'),
      kind: 'all',
      limit: 10,
    });
    expect(result.rows.map((row) => [row.entry.title, row.context])).toEqual([
      ['Drafts', true],
      ['Outline', false],
    ]);
    // The live folder's name finds the root archived from it, not its contents.
    const live = searchArchive(index, { terms: parseArchiveQuery('live'), kind: 'all', limit: 10 });
    expect(live.rows.map((row) => [row.entry.title, row.context])).toEqual([['Drafts', false]]);
  });

  it('sorts siblings newest archived first, undated ones last', () => {
    const index = buildArchiveIndex(
      {
        roots: [
          node('a', 'doc', 'Older', { archived_at: '2026-07-01T00:00:00Z' }),
          node('b', 'doc', 'Undated', { archived_at: null }),
          node('c', 'doc', 'Newer', { archived_at: '2026-07-09T00:00:00Z' }),
        ],
        children: [],
      },
      'newest'
    );
    expect(index.map((entry) => entry.title)).toEqual(['Newer', 'Older', 'Undated']);
  });

  it('names an untitled item by its type and survives a parent cycle', () => {
    const loopA = node('loop-a', 'container', null, { container_id: 'loop-b' });
    const loopB = node('loop-b', 'container', 'Loop', { container_id: 'loop-a' });
    const index = buildArchiveIndex({ roots: [loopA], children: [loopB, loopA] }, 'default');
    expect(index.map((entry) => entry.title)).toEqual(['Untitled container', 'Loop']);
  });
});

describe('searchArchive', () => {
  const index = buildArchiveIndex(tree, 'default');

  it('lists every item when there is no query or kind', () => {
    const result = searchArchive(index, { terms: [], kind: 'all', limit: 100 });
    expect(result.total).toBe(6);
    expect(result.rows.every((row) => !row.context)).toBe(true);
    expect(titles(result.rows)).toEqual(index.map((entry) => entry.title));
  });

  it('matches the title case-insensitively and keeps the ancestors as context', () => {
    const result = searchArchive(index, {
      terms: parseArchiveQuery('SEGMENTS'),
      kind: 'all',
      limit: 100,
    });
    expect(result.total).toBe(2);
    expect(result.rows.map((row) => [row.entry.title, row.context])).toEqual([
      ['Radio show A', true],
      ['segments', false],
      ['Radio show B', true],
      ['segments', false],
    ]);
  });

  it('narrows by the archived parent path, and every word must match', () => {
    const result = searchArchive(index, {
      terms: parseArchiveQuery('show b segments'),
      kind: 'all',
      limit: 100,
    });
    expect(result.rows.map((row) => [row.entry.id, row.context])).toEqual([
      ['container-b', true],
      ['table-b', false],
    ]);
  });

  it('lists a matching parent, not everything inside it', () => {
    const radio = searchArchive(index, {
      terms: parseArchiveQuery('radio'),
      kind: 'all',
      limit: 100,
    });
    expect(radio.rows.map((row) => [row.entry.id, row.context])).toEqual([
      ['container-a', false],
      ['container-b', false],
    ]);
    // A word in the item's own name, narrowed by its parents' names.
    const column = searchArchive(index, {
      terms: parseArchiveQuery('radio notes'),
      kind: 'all',
      limit: 100,
    });
    expect(column.rows.map((row) => [row.entry.id, row.context])).toEqual([
      ['container-a', true],
      ['table-a', true],
      ['field-a', false],
    ]);
  });

  it('lets a parent’s name match on its own once a kind is chosen, and counts each chip that way', () => {
    const all = searchArchive(index, {
      terms: parseArchiveQuery('radio'),
      kind: 'all',
      limit: 100,
    });
    const tables = searchArchive(index, {
      terms: parseArchiveQuery('radio'),
      kind: 'table',
      limit: 100,
    });
    expect(tables.rows.map((row) => [row.entry.id, row.context])).toEqual([
      ['container-a', true],
      ['table-a', false],
      ['container-b', true],
      ['table-b', false],
    ]);
    expect(tables.total).toBe(2);
    expect(tables.insideCounts.get('container-a')).toBe(1);
    // The All chip counts what All lists; each kind chip what that chip lists.
    for (const result of [all, tables]) {
      expect(result.queryTotal).toBe(2);
      expect(result.kindCounts.get('container')).toBe(2);
      expect(result.kindCounts.get('table')).toBe(2);
      expect(result.kindCounts.get('table_field')).toBe(1);
    }
    expect(all.total).toBe(2);
    const columns = searchArchive(index, {
      terms: parseArchiveQuery('radio'),
      kind: 'table_field',
      limit: 100,
    });
    expect(columns.total).toBe(1);
  });

  it('filters by kind and counts each kind for the query alone', () => {
    const result = searchArchive(index, {
      terms: parseArchiveQuery('n'),
      kind: 'table',
      limit: 100,
    });
    expect(result.total).toBe(2);
    expect(result.kindCounts.get('container')).toBeUndefined();
    expect(result.kindCounts.get('table')).toBe(2);
    expect(result.kindCounts.get('table_field')).toBe(1);
    expect(result.kindCounts.get('doc')).toBe(1);
    expect(result.queryTotal).toBe(4);
    expect(result.insideCounts.get('container-a')).toBe(1);
    expect(result.insideCounts.get('table-a')).toBeUndefined();
    expect(result.rows.map((row) => [row.entry.id, row.context])).toEqual([
      ['container-a', true],
      ['table-a', false],
      ['container-b', true],
      ['table-b', false],
    ]);
  });

  it('caps the matches it returns and reports how many there are', () => {
    const result = searchArchive(index, { terms: [], kind: 'all', limit: 2 });
    expect(result.total).toBe(6);
    expect(result.shown).toBe(2);
    expect(titles(result.rows)).toEqual(['Radio show A', 'segments']);
  });
});

describe('matchRanges', () => {
  it('finds every case-insensitive occurrence and merges overlaps', () => {
    expect(matchRanges('Radio show radio', ['radio'])).toEqual([
      [0, 5],
      [11, 16],
    ]);
    expect(matchRanges('segments', ['seg', 'egm'])).toEqual([[0, 4]]);
    expect(matchRanges('segments', [])).toEqual([]);
  });
});
