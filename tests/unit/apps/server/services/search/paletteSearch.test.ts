import { beforeEach, describe, expect, it } from '@jest/globals';

const poolQuery = jest.fn();
const createQueryEmbedding = jest.fn();
const workspaceSearchNodes = jest.fn();
const readSearchPreferences = jest.fn();
const resolveEmbeddingProvider = jest.fn();

jest.mock('@snaglet/db', () => ({
  getPool: () => ({ query: (...args: unknown[]) => poolQuery(...args) }),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: () => ({ query: (...args: unknown[]) => poolQuery(...args) }),
}));

jest.mock('@server/services/search/nodeSearch.js', () => ({
  createQueryEmbedding: (...args: unknown[]) => createQueryEmbedding(...args),
  supportsVectorSearch: (kind: string) => kind === 'doc' || kind === 'message',
  workspaceSearchNodes: (...args: unknown[]) => workspaceSearchNodes(...args),
}));

// The consumer reads `settingsService.read(searchSettings.preferences)`; the
// mock fn is named `readSearchPreferences` so per-test mockResolvedValue
// calls stay readable.
jest.mock('@server/services/settings/index.js', () => ({
  settingsService: {
    read: (...args: unknown[]) => readSearchPreferences(...args),
  },
}));
jest.mock('@server/services/settings/categories/search.js', () => ({
  searchSettings: { preferences: { category: 'search', key: 'preferences' } },
}));

jest.mock('@server/services/embedding/EmbeddingProvider.js', () => ({
  resolveEmbeddingProvider: (...args: unknown[]) => resolveEmbeddingProvider(...args),
}));

// paletteSearchSupport checks the local model's file readiness before
// enabling the vector channel; default every test to "installed".
const getLocalEmbedderStatus = jest.fn();
jest.mock('@server/services/embedding/LocalEmbedderService.js', () => ({
  getLocalEmbedderStatus: (...args: unknown[]) => getLocalEmbedderStatus(...args),
}));

import { paletteSearch } from '@server/services/search/paletteSearch';
import {
  coverageFor,
  isNodeSearchPaletteKind,
  shareMeaningBudget,
  supportsPaletteVector,
  type PaletteSearchHit,
} from '@server/services/search/paletteSearchSupport';
import type { SearchPreferences } from '@server/services/settings/categories/search';

beforeEach(() => {
  jest.clearAllMocks();
  createQueryEmbedding.mockResolvedValue({ vector: [0.1, 0.2], modelId: 'test:embed' });
  resolveEmbeddingProvider.mockResolvedValue({ info: { provider: 'test', model: 'embed' } });
  getLocalEmbedderStatus.mockResolvedValue({ ready: true });
  readSearchPreferences.mockResolvedValue({
    useVector: true,
    useFts: true,
    useGraphWalk: true,
    threadBoost: true,
  });
  workspaceSearchNodes.mockImplementation(async ({ kind }: { kind: string }) => ({
    hits: [{ node_id: `${kind}-1`, kind, score: 0.03, channels: ['fts', 'vector'] }],
    channels_used: kind === 'doc' || kind === 'message' ? ['fts', 'vector'] : ['fts'],
    scope_applied: { mode: 'root', source: 'explicit_container' },
    scope_source: 'explicit_container',
  }));
  poolQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM public.docs')) {
      return {
        rows: [
          {
            id: 'doc-1',
            title: 'Doc one',
            container_id: null,
            sort_order: 1,
            created_at: '2026-01-01',
            updated_at: '2026-01-02',
          },
        ],
      };
    }
    if (sql.includes('FROM public.messages')) {
      return {
        rows: [
          {
            id: 'message-1',
            content: 'Message one',
            role: 'assistant',
            thread_id: 'thread-1',
            thread_title: 'Planning',
            agent_id: 'agent-1',
            user_id: null,
            created_at: '2026-01-01',
            updated_at: '2026-01-02',
          },
        ],
      };
    }
    if (sql.includes('FROM public.threads')) {
      return {
        rows: [
          {
            id: 'thread-1',
            title: 'Planning',
            container_id: null,
            sort_order: 1,
            last_message_at: null,
            created_at: '2026-01-01',
            updated_at: '2026-01-02',
          },
        ],
      };
    }
    if (sql.includes('FROM public.containers')) {
      return {
        rows: [
          {
            id: 'container-1',
            name: 'Architecture',
            category: null,
            description: null,
            parent_id: null,
            sort_order: 1,
            created_at: '2026-01-01',
            updated_at: '2026-01-02',
          },
        ],
      };
    }
    return { rows: [] };
  });
});

describe('paletteSearch', () => {
  it('embeds once and reuses the embedding across vector-capable kind buckets', async () => {
    const result = await paletteSearch({ query: 'alpha', kinds: ['doc', 'message'] });

    expect(createQueryEmbedding).toHaveBeenCalledTimes(1);
    expect(workspaceSearchNodes).toHaveBeenCalledTimes(2);
    expect(workspaceSearchNodes).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: 'doc',
        precomputedEmbedding: { vector: [0.1, 0.2], modelId: 'test:embed' },
      })
    );
    expect(workspaceSearchNodes).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: 'message',
        precomputedEmbedding: { vector: [0.1, 0.2], modelId: 'test:embed' },
      })
    );
    expect(result.channelsUsed).toEqual(['fts', 'vector']);
    expect(result.semanticStatus).toBe('ready');
    expect(result.coverage).toEqual({ doc: 'hybrid', message: 'hybrid' });
    expect(result.byKind.doc?.[0]?.payload).toMatchObject({ title: 'Doc one' });
    expect(result.byKind.message?.[0]?.payload).toMatchObject({ title: 'Message one' });
  });

  describe('matches found only by meaning', () => {
    type StubHit = { id: string; channels: ('fts' | 'vector')[]; similarity?: number };

    // Node search returns these per kind; hydration finds every id.
    function stubSearch(byKind: Record<string, StubHit[]>): void {
      workspaceSearchNodes.mockImplementation(async ({ kind }: { kind: string }) => ({
        hits: (byKind[kind] ?? []).map((hit) => ({
          node_id: hit.id,
          kind,
          score: 0.016,
          channels: hit.channels,
          ...(hit.similarity === undefined ? {} : { vectorSimilarity: hit.similarity }),
        })),
        channels_used: ['fts', 'vector'],
        scope_applied: { mode: 'root', source: 'explicit_container' },
        scope_source: 'explicit_container',
      }));
      poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        const ids = (params?.[0] ?? []) as string[];
        const times = { created_at: '2026-01-01', updated_at: '2026-01-02' };
        if (sql.includes('FROM public.docs')) {
          return {
            rows: ids.map((id) => ({ id, title: id, container_id: null, sort_order: 1, ...times })),
          };
        }
        if (sql.includes('FROM public.messages')) {
          return {
            rows: ids.map((id) => ({
              id,
              content: id,
              role: 'assistant',
              thread_id: 'thread-1',
              thread_title: 'Planning',
              agent_id: null,
              user_id: null,
              ...times,
            })),
          };
        }
        return { rows: [] };
      });
    }

    const ids = (hits: PaletteSearchHit[] | undefined) => (hits ?? []).map((hit) => hit.node_id);
    const meaning = (id: string, similarity: number): StubHit => ({
      id,
      channels: ['vector'],
      similarity,
    });

    beforeEach(() => {
      resolveEmbeddingProvider.mockResolvedValue({
        info: { provider: 'local-onnx', model: 'nomic-embed-text-v1.5' },
      });
    });

    it('returns the five closest when nothing matched the words, however low they score', async () => {
      stubSearch({
        doc: [
          meaning('doc-a', 0.45),
          meaning('doc-b', 0.44),
          meaning('doc-c', 0.31),
          meaning('doc-d', 0.3),
        ],
        message: [meaning('message-a', 0.43), meaning('message-b', 0.2)],
      });

      const result = await paletteSearch({
        query: 'zzqv nonexistent sentient banana 92841',
        kinds: ['doc', 'message'],
        mode: 'hybrid',
        broadInteractiveSearch: true,
      });

      expect(ids(result.byKind.doc)).toEqual(['doc-a', 'doc-b', 'doc-c', 'doc-d']);
      expect(ids(result.byKind.message)).toEqual(['message-a']);
    });

    it('hydrates only the hits it lists', async () => {
      stubSearch({
        doc: Array.from({ length: 8 }, (_, i) => meaning(`doc-${i}`, 0.5 - i * 0.01)),
      });

      await paletteSearch({
        query: 'zzqv',
        kinds: ['doc'],
        mode: 'hybrid',
        broadInteractiveSearch: true,
      });

      const docHydrations = poolQuery.mock.calls.filter(([sql]) =>
        String(sql).includes('FROM public.docs')
      );
      expect(docHydrations).toHaveLength(1);
      expect(docHydrations[0]?.[1]).toEqual([['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4']]);
    });

    it('keeps every keyword hit outside the budget and lists it before meaning-only hits', async () => {
      stubSearch({
        doc: [
          meaning('doc-meaning-1', 0.7),
          { id: 'doc-word-1', channels: ['fts'] },
          meaning('doc-meaning-2', 0.69),
          { id: 'doc-word-2', channels: ['fts', 'vector'], similarity: 0.2 },
          meaning('doc-meaning-3', 0.5),
          { id: 'doc-word-3', channels: ['fts'] },
          meaning('doc-meaning-4', 0.49),
          { id: 'doc-word-4', channels: ['fts'] },
        ],
        message: [
          { id: 'message-word-1', channels: ['fts'] },
          meaning('message-meaning-1', 0.68),
          { id: 'message-word-2', channels: ['fts'] },
          meaning('message-meaning-2', 0.48),
          { id: 'message-word-3', channels: ['fts'] },
          meaning('message-meaning-3', 0.47),
        ],
      });

      const result = await paletteSearch({
        query: 'planning',
        kinds: ['doc', 'message'],
        mode: 'hybrid',
        broadInteractiveSearch: true,
      });

      expect(ids(result.byKind.doc)).toEqual([
        'doc-word-1',
        'doc-word-2',
        'doc-word-3',
        'doc-word-4',
        'doc-meaning-1',
        'doc-meaning-2',
        'doc-meaning-3',
        'doc-meaning-4',
      ]);
      expect(ids(result.byKind.message)).toEqual([
        'message-word-1',
        'message-word-2',
        'message-word-3',
        'message-meaning-1',
      ]);
    });

    it('asks hybrid vector lanes for twice the per-kind limit to leave keyword hits room', async () => {
      stubSearch({
        doc: [
          { id: 'doc-word-1', channels: ['fts'] },
          meaning('doc-meaning-1', 0.4),
          { id: 'doc-word-2', channels: ['fts'] },
          { id: 'doc-word-3', channels: ['fts'] },
        ],
      });

      const result = await paletteSearch({
        query: 'planning',
        kinds: ['doc', 'container'],
        perKindLimit: 2,
        mode: 'hybrid',
        broadInteractiveSearch: true,
      });

      expect(workspaceSearchNodes).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'doc', limit: 4 })
      );
      // Container search has no vector channel, so it keeps the plain limit.
      expect(workspaceSearchNodes).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'container', limit: 2 })
      );
      expect(ids(result.byKind.doc)).toEqual(['doc-word-1', 'doc-word-2', 'doc-meaning-1']);
    });

    it('keeps the plain per-kind limit on the keyword tier', async () => {
      stubSearch({});

      await paletteSearch({
        query: 'planning',
        kinds: ['doc', 'message'],
        mode: 'keyword',
        broadInteractiveSearch: true,
      });

      for (const kind of ['doc', 'message']) {
        expect(workspaceSearchNodes).toHaveBeenCalledWith(
          expect.objectContaining({ kind, limit: 6 })
        );
      }
    });

    it('ranks meaning-only hits by similarity alone after the keyword hits', async () => {
      stubSearch({
        doc: [
          { id: 'doc-word-1', channels: ['fts'] },
          { id: 'doc-word-2', channels: ['fts'] },
          ...['doc-a', 'doc-b', 'doc-c', 'doc-d', 'doc-e'].map((id) => meaning(id, 0.7)),
        ],
        message: [meaning('message-1', 0.68)],
      });

      const result = await paletteSearch({
        query: 'where did we leave off',
        kinds: ['doc', 'message'],
        mode: 'hybrid',
        broadInteractiveSearch: true,
      });

      expect(ids(result.byKind.doc)).toEqual([
        'doc-word-1',
        'doc-word-2',
        'doc-a',
        'doc-b',
        'doc-c',
        'doc-d',
        'doc-e',
      ]);
      expect(ids(result.byKind.message)).toEqual([]);
    });

    it('applies no floor to a filtered search and keeps node-search order up to the per-kind limit', async () => {
      stubSearch({
        doc: [
          { id: 'doc-word-1', channels: ['fts'] },
          ...Array.from({ length: 6 }, (_, i) => meaning(`doc-meaning-${i}`, 0.12 - i * 0.01)),
        ],
      });

      const result = await paletteSearch({ query: 'zzqv', kinds: ['doc'], mode: 'hybrid' });

      expect(workspaceSearchNodes).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'doc', limit: 6 })
      );
      expect(ids(result.byKind.doc)).toEqual([
        'doc-word-1',
        'doc-meaning-0',
        'doc-meaning-1',
        'doc-meaning-2',
        'doc-meaning-3',
        'doc-meaning-4',
      ]);
    });
  });

  describe('shareMeaningBudget', () => {
    const hit = (id: string, channels: ('fts' | 'vector')[], similarity?: number) =>
      ({
        node_id: id,
        kind: 'doc',
        score: 0.01,
        channels,
        ...(similarity === undefined ? {} : { vectorSimilarity: similarity }),
        payload: {},
      }) as PaletteSearchHit;
    const file = (nodeId: string, score: number) => ({ nodeId, score });

    it('keeps the five closest of workspace meaning hits and files together', () => {
      const shared = shareMeaningBudget(
        {
          doc: [
            hit('doc-word', ['fts']),
            hit('doc-near', ['vector'], 0.6),
            hit('doc-far', ['vector'], 0.4),
          ],
          message: [hit('message-near', ['vector'], 0.55), hit('message-mid', ['vector'], 0.5)],
        },
        [file('file-near', 0.58), file('file-mid', 0.45), file('file-far', 0.3)]
      );

      expect(shared.byKind.doc?.map((entry) => entry.node_id)).toEqual(['doc-word', 'doc-near']);
      expect(shared.byKind.message?.map((entry) => entry.node_id)).toEqual([
        'message-near',
        'message-mid',
      ]);
      expect(shared.files.map((entry) => entry.nodeId)).toEqual(['file-near', 'file-mid']);
    });

    it('never counts keyword hits against the budget', () => {
      const words = Array.from({ length: 8 }, (_, i) =>
        hit(`doc-word-${i}`, ['fts', 'vector'], 0.1)
      );
      const shared = shareMeaningBudget({ doc: words }, [file('file-a', 0.2)]);

      expect(shared.byKind.doc).toEqual(words);
      expect(shared.files.map((entry) => entry.nodeId)).toEqual(['file-a']);
    });
  });

  it('reuses one embedding for body-semantic kinds and keeps structural kinds lexical', async () => {
    const result = await paletteSearch({
      query: 'planning',
      kinds: ['doc', 'message', 'thread', 'container'],
    });

    expect(createQueryEmbedding).toHaveBeenCalledTimes(1);
    expect(workspaceSearchNodes).toHaveBeenCalledTimes(4);
    for (const kind of ['doc', 'message']) {
      expect(workspaceSearchNodes).toHaveBeenCalledWith(
        expect.objectContaining({
          kind,
          precomputedEmbedding: { vector: [0.1, 0.2], modelId: 'test:embed' },
        })
      );
    }
    for (const kind of ['thread', 'container']) {
      expect(workspaceSearchNodes).toHaveBeenCalledWith(
        expect.objectContaining({ kind, precomputedEmbedding: null })
      );
    }
    expect(result.channelsUsed).toEqual(['fts', 'vector']);
    expect(result.coverage).toEqual({
      doc: 'hybrid',
      message: 'hybrid',
      thread: 'lexical',
      container: 'lexical',
    });
  });

  it('asks every node lane for type-ahead title matches, never the reranker', async () => {
    await paletteSearch({ query: 'Automations rech', kinds: ['thread', 'doc'], mode: 'keyword' });

    for (const kind of ['thread', 'doc']) {
      expect(workspaceSearchNodes).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'Automations rech',
          kind,
          typeahead: true,
          rerank: false,
        })
      );
    }
  });

  it('reports lexical coverage when semantic search is disabled in preferences', async () => {
    readSearchPreferences.mockResolvedValue({
      useVector: false,
      useFts: true,
      useGraphWalk: true,
      threadBoost: true,
    });

    const result = await paletteSearch({ query: 'alpha', kinds: ['doc'] });

    expect(resolveEmbeddingProvider).not.toHaveBeenCalled();
    expect(createQueryEmbedding).not.toHaveBeenCalled();
    expect(result.semanticStatus).toBe('disabled');
    expect(result.coverage).toEqual({ doc: 'lexical' });
  });

  it('honors an explicit semantic mode independently of stored search defaults', async () => {
    readSearchPreferences.mockResolvedValue({
      useVector: false,
      useFts: true,
      useGraphWalk: true,
      threadBoost: true,
    });
    workspaceSearchNodes.mockResolvedValue({
      hits: [{ node_id: 'doc-1', kind: 'doc', score: 0.03, channels: ['vector'] }],
      channels_used: ['vector'],
      scope_applied: { mode: 'root', source: 'explicit_container' },
      scope_source: 'explicit_container',
    });

    const result = await paletteSearch({ query: 'meaning', kinds: ['doc'], mode: 'semantic' });

    expect(resolveEmbeddingProvider).toHaveBeenCalledTimes(1);
    expect(createQueryEmbedding).toHaveBeenCalledTimes(1);
    expect(workspaceSearchNodes).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'doc', mode: 'semantic' })
    );
    expect(result.channelsUsed).toEqual(['vector']);
    expect(result.coverage).toEqual({ doc: 'semantic' });
  });

  it('does not run palette-only lexical queries in explicit semantic mode', async () => {
    const result = await paletteSearch({ query: 'vega', kinds: ['agent'], mode: 'semantic' });

    expect(workspaceSearchNodes).not.toHaveBeenCalled();
    expect(
      poolQuery.mock.calls.some(([sql]) =>
        typeof sql === 'string' ? sql.includes('FROM public.agents') : false
      )
    ).toBe(false);
    expect(result.byKind.agent).toEqual([]);
    expect(result.channelsUsed).toEqual([]);
  });

  it('reports a missing provider as unavailable without attempting a query embedding', async () => {
    resolveEmbeddingProvider.mockResolvedValue(null);

    const result = await paletteSearch({ query: 'alpha', kinds: ['doc'] });

    expect(createQueryEmbedding).not.toHaveBeenCalled();
    expect(result.semanticStatus).toBe('unavailable');
    expect(result.semanticStatusReason).toBe('The built-in embedding model is not available.');
    expect(result.coverage).toEqual({ doc: 'lexical' });
  });

  it('reports the local embedder as unavailable until its model files exist', async () => {
    resolveEmbeddingProvider.mockResolvedValue({
      info: { provider: 'local-onnx', model: 'nomic-embed-text-v1.5', dimensions: 768 },
    });
    getLocalEmbedderStatus.mockResolvedValue({
      ready: false,
      error: 'Embedder ONNX model file is missing. Run `pnpm embedder:fetch` to download it.',
    });

    const result = await paletteSearch({ query: 'alpha', kinds: ['doc'] });

    expect(createQueryEmbedding).not.toHaveBeenCalled();
    expect(result.semanticStatus).toBe('unavailable');
    expect(result.coverage).toEqual({ doc: 'lexical' });
  });

  it('uses direct browse queries for an empty query with explicit kind chips', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM public.nodes n') && sql.includes('ORDER BY n.sort_order')) {
        return { rows: [{ id: 'thread-1' }] };
      }
      if (sql.includes('FROM public.threads')) {
        return {
          rows: [
            {
              id: 'thread-1',
              title: 'Planning',
              container_id: null,
              sort_order: 1,
              last_message_at: null,
              created_at: '2026-01-01',
              updated_at: '2026-01-02',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await paletteSearch({ query: '', kinds: ['thread'] });

    expect(workspaceSearchNodes).not.toHaveBeenCalled();
    expect(result.byKind.thread?.[0]?.payload).toMatchObject({ title: 'Planning' });
  });

  it('short-circuits exact pasted ids before running text search', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('n.id = $1') && sql.includes('n.type::text AS type')) {
        return { rows: [{ id: 'doc-123', type: 'doc' }] };
      }
      if (sql.includes('FROM public.docs')) {
        return {
          rows: [
            {
              id: 'doc-123',
              title: 'Exact doc',
              container_id: null,
              sort_order: 1,
              created_at: '2026-01-01',
              updated_at: '2026-01-02',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await paletteSearch({ query: 'doc-123', kinds: ['doc', 'thread'] });

    expect(workspaceSearchNodes).not.toHaveBeenCalled();
    expect(createQueryEmbedding).not.toHaveBeenCalled();
    expect(result.byKind.doc?.[0]?.payload).toMatchObject({ title: 'Exact doc' });
    expect(result.byKind.thread).toEqual([]);
  });
});

describe('paletteSearch — table lane', () => {
  const CATALOG_ROWS = [
    {
      id: 'table-builtin-credentials',
      name: 'Credentials',
      origin: 'builtin',
      created_at: '2026-01-01',
    },
    {
      id: 'table-1111111111111-aaaaaaaaa',
      name: 'test_table_a',
      origin: 'custom',
      created_at: '2026-01-02',
    },
  ];

  function mockCatalog(matchIds: string[]): void {
    poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM public.table_catalog t') && sql.includes('ILIKE')) {
        return { rows: matchIds.map((id, index) => ({ id, score: 1 - index * 0.1 })) };
      }
      if (sql.includes('FROM public.table_catalog t') && sql.includes('ANY($1::text[])')) {
        const ids = (params?.[0] ?? []) as string[];
        return { rows: CATALOG_ROWS.filter((row) => ids.includes(row.id)) };
      }
      if (sql.includes('FROM public.table_catalog t') && sql.includes('ORDER BY (t.origin')) {
        return { rows: [{ id: CATALOG_ROWS[1].id }, { id: CATALOG_ROWS[0].id }] };
      }
      if (sql.includes('FROM public.table_catalog t') && sql.includes('WHERE t.id = $1')) {
        const id = params?.[0];
        return {
          rows: CATALOG_ROWS.filter((row) => row.id === id).map(({ id: rowId }) => ({ id: rowId })),
        };
      }
      return { rows: [] };
    });
  }

  function catalogCalls(): [string, unknown[]][] {
    return poolQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('public.table_catalog')
    ) as [string, unknown[]][];
  }

  it('finds a table by name through the keyword-only catalog lane', async () => {
    mockCatalog(['table-builtin-credentials']);

    const result = await paletteSearch({ query: 'cred', kinds: ['table'] });

    expect(workspaceSearchNodes).not.toHaveBeenCalled();
    expect(createQueryEmbedding).not.toHaveBeenCalled();
    expect(result.coverage).toEqual({ table: 'lexical' });
    expect(result.channelsUsed).toEqual(['fts']);
    expect(result.byKind.table).toEqual([
      {
        node_id: 'table-builtin-credentials',
        kind: 'table',
        score: 1,
        channels: ['fts'],
        vectorSimilarity: undefined,
        payload: {
          name: 'Credentials',
          title: 'Credentials',
          origin: 'builtin',
          createdAt: '2026-01-01',
        },
      },
    ]);
    // The lane never reads nodes and never selects the physical table name.
    for (const [sql] of poolQuery.mock.calls as [string][]) {
      expect(sql).not.toContain('public.nodes');
      expect(sql).not.toContain('table_name');
    }
  });

  it('ranks exact, then prefix, then substring, with a deterministic tiebreak', async () => {
    mockCatalog([]);

    await paletteSearch({ query: 'Cred', kinds: ['table'], perKindLimit: 5 });

    const [sql, params] = catalogCalls()[0]!;
    expect(sql).toMatch(/WHEN lower\(t\.name\) = lower\(\$1\) THEN 1\.0/);
    expect(sql).toMatch(/ILIKE \(\$3::text \|\| '%'\) ESCAPE/);
    expect(sql).toMatch(/ORDER BY score DESC, lower\(t\.name\) ASC, t\.id ASC/);
    expect(params).toEqual(['Cred', 5, 'Cred']);
  });

  it('escapes LIKE wildcards so underscores and percent signs match literally', async () => {
    mockCatalog([]);

    await paletteSearch({ query: 'test_t%\\x', kinds: ['table'] });

    const [, params] = catalogCalls()[0]!;
    expect(params).toEqual(['test_t%\\x', 6, 'test\\_t\\%\\\\x']);
  });

  it('does not run the table lane in explicit semantic mode', async () => {
    mockCatalog(['table-builtin-credentials']);

    const result = await paletteSearch({ query: 'cred', kinds: ['table'], mode: 'semantic' });

    expect(catalogCalls()).toEqual([]);
    expect(result.byKind.table).toEqual([]);
    expect(result.coverage).toEqual({ table: 'disabled' });
  });

  it('browses the catalog for an empty table filter, custom tables first', async () => {
    mockCatalog([]);

    const result = await paletteSearch({ query: '', kinds: ['table'] });

    expect(
      poolQuery.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('FROM public.nodes')
      )
    ).toBe(false);
    expect(result.byKind.table?.map((hit) => hit.node_id)).toEqual([
      'table-1111111111111-aaaaaaaaa',
      'table-builtin-credentials',
    ]);
    expect(result.byKind.table?.[0]?.payload).toMatchObject({
      title: 'test_table_a',
      origin: 'custom',
    });
  });

  it('resolves a pasted catalog id exactly without a nodes lookup', async () => {
    mockCatalog([]);

    const result = await paletteSearch({
      query: 'table-builtin-credentials',
      kinds: ['doc', 'table'],
    });

    expect(workspaceSearchNodes).not.toHaveBeenCalled();
    expect(
      poolQuery.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('n.type::text AS type')
      )
    ).toBe(false);
    expect(result.byKind.table?.map((hit) => hit.node_id)).toEqual(['table-builtin-credentials']);
    expect(result.byKind.doc).toEqual([]);
  });

  it('drops a hit whose catalog row disappeared before hydration', async () => {
    mockCatalog(['table-1111111111111-zzzzzzzzz']);

    const result = await paletteSearch({ query: 'gone', kinds: ['table'] });

    expect(result.byKind.table).toEqual([]);
  });

  it('is not a node-search kind and never advertises a vector channel', () => {
    expect(isNodeSearchPaletteKind('table')).toBe(false);
    expect(supportsPaletteVector('table')).toBe(false);
    expect(
      coverageFor(['table', 'doc'], { useFts: true, useVector: true } as SearchPreferences, 'ready')
    ).toEqual({ table: 'lexical', doc: 'hybrid' });
  });
});
