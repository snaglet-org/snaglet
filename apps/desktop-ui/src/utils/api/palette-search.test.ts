import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const core = vi.hoisted(() => ({ fetchData: vi.fn() }));
vi.mock('./core', async () => {
  const actual = await vi.importActual<typeof import('./core')>('./core');
  return { ...actual, fetchData: core.fetchData };
});

import {
  PALETTE_KIND_FILTER_OPTIONS,
  PALETTE_NODE_KINDS,
  PREFIX_FILTER_META,
  paletteHitContext,
  paletteSearchApi,
  paletteTableEntry,
  parsePalettePrefix,
} from './palette-search';

describe('palette search human filter registry', () => {
  it('covers every searchable palette kind exactly once', () => {
    expect(PALETTE_KIND_FILTER_OPTIONS.map((option) => option.kind).sort()).toEqual(
      [...PALETTE_NODE_KINDS].sort()
    );
  });

  it('resolves image and project aliases through the same registry', () => {
    expect(PREFIX_FILTER_META.image).toEqual({ kind: 'image', label: 'Image' });
    expect(PREFIX_FILTER_META.images).toEqual({ kind: 'image', label: 'Image' });
    expect(PREFIX_FILTER_META.project?.kind).toBe('container');
  });

  it('does not alias task/tasks to docs — a task is a table row, not a doc', () => {
    expect(PREFIX_FILTER_META.task).toBeUndefined();
    expect(PREFIX_FILTER_META.tasks).toBeUndefined();
  });

  it('parses `table:` and `tables:` as a Database table filter', () => {
    expect(PREFIX_FILTER_META.table).toEqual({ kind: 'table', label: 'Table' });
    expect(parsePalettePrefix('table:reading')).toEqual({
      prefix: 'table',
      remainder: 'reading',
      kind: 'table',
    });
    expect(parsePalettePrefix('Tables:budget')).toMatchObject({ kind: 'table' });
  });

  it('labels a table hit by the sidebar group it lives in', () => {
    expect(paletteHitContext({ kind: 'table', payload: { origin: 'builtin' } })).toBe(
      'Snaglet table'
    );
    expect(paletteHitContext({ kind: 'table', payload: { origin: 'custom' } })).toBe('Your table');
    expect(paletteHitContext({ kind: 'table', payload: {} })).toBeNull();
  });

  it('reads a table hit catalog entry only when the payload carries all of it', () => {
    const tableId = 'table-builtin-docs';
    expect(
      paletteTableEntry(tableId, { name: 'Docs', origin: 'builtin', createdAt: '2026-01-01' })
    ).toEqual({
      id: tableId,
      name: 'Docs',
      origin: 'builtin',
      projectId: null,
      sortOrder: 0,
      createdAt: '2026-01-01',
    });
    expect(
      paletteTableEntry('table-1111111111111-aaaaaaaaa', {
        name: 'Reading list',
        origin: 'custom',
        projectId: 'container-1111111111111-aaaaaaaaa',
        sortOrder: 3,
        createdAt: '2026-01-01',
      })
    ).toMatchObject({ projectId: 'container-1111111111111-aaaaaaaaa', sortOrder: 3 });
    expect(paletteTableEntry(tableId, { name: 'Docs' })).toBeNull();
    expect(
      paletteTableEntry(tableId, { name: 'Docs', origin: 'system', createdAt: '2026-01-01' })
    ).toBeNull();
  });

  it('drops built-in (Snaglet-managed) tables from search results', async () => {
    const custom = {
      node_id: 'table-1111111111111-aaaaaaaaa',
      kind: 'table',
      score: 1,
      channels: ['keyword'],
      payload: { name: 'Reading list', origin: 'custom' },
    };
    const builtin = {
      ...custom,
      node_id: 'table-builtin-docs',
      payload: { name: 'Docs', origin: 'builtin' },
    };
    core.fetchData.mockResolvedValueOnce({
      byKind: { table: [builtin, custom] },
      channelsUsed: ['keyword'],
      semanticStatus: 'ready',
    });
    const result = await paletteSearchApi.search({ query: 'docs' });
    expect(result.byKind.table?.map((hit) => hit.node_id)).toEqual([custom.node_id]);
    expect(result.items.map((item) => (item.type === 'workspace' ? item.nodeId : null))).toEqual([
      custom.node_id,
    ]);
  });

  it('builds a visible image evidence excerpt from description and tags', () => {
    expect(
      paletteHitContext({
        kind: 'image',
        payload: { description: 'Shoreline reference', tags: ['coast', 'blue'] },
      })
    ).toBe('Shoreline reference · Tags: coast, blue');
  });
});
