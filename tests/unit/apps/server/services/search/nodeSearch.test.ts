import { beforeEach, describe, expect, it } from '@jest/globals';

const poolQuery = jest.fn();
const embed = jest.fn();
const readPrefs = jest.fn();
const mockFtsSearchNodes = jest.fn();
const mockResolveScope = jest.fn();
const mockResolveEmbeddingProvider = jest.fn();

jest.mock('@snaglet/db', () => ({
  getPool: () => ({ query: (...args: unknown[]) => poolQuery(...args) }),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: () => ({ query: (...args: unknown[]) => poolQuery(...args) }),
}));

jest.mock('@server/config/logger.js', () => ({
  logger: { warn: jest.fn() },
}));

// createQueryEmbedding resolves the models-catalog row for the active
// provider before embedding (embeddings.model_id FKs into models.id).
// Without this mock the lookup hits a real DbClient and the vector
// channel silently degrades — embed() never gets called.
jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    findByProviderAndModelId: jest.fn(async () => ({ id: 'test:embed', dimensions: 2 })),
  },
}));

// nodeSearch reads preferences through settingsService. Tests build the value
// with `prefs({...})`; `readPrefs.mockResolvedValue` receives the object, not
// a JSON string.
jest.mock('@server/services/settings/index.js', () => ({
  settingsService: { read: (...args: unknown[]) => readPrefs(...args) },
}));
jest.mock('@server/services/settings/categories/search.js', () => ({
  searchSettings: { preferences: { category: 'search', key: 'preferences' } },
}));

jest.mock('@server/services/embedding/EmbeddingProvider.js', () => ({
  resolveEmbeddingProvider: (...args: unknown[]) => mockResolveEmbeddingProvider(...args),
}));

jest.mock('@server/services/search/ftsSearchNodes.js', () => ({
  ftsSearchNodes: (...args: unknown[]) => mockFtsSearchNodes(...args),
  scopedNodeIdsSql: () => ({
    cte: 'scoped AS (SELECT NULL::text AS node_id WHERE false)',
    params: [],
  }),
}));

jest.mock('@server/services/search/searchPolicy.js', () => ({
  resolveScope: (...args: unknown[]) => mockResolveScope(...args),
}));

// Tier-3 pass — committed callers set rerank: true; palette never does.
const mockRerank = jest.fn();
jest.mock('@server/services/reranking/LocalRerankerService.js', () => ({
  rerank: (...args: unknown[]) => mockRerank(...args),
  warnIfRerankerUnavailable: jest.fn(async () => false),
  releaseLocalReranker: async () => undefined,
}));
const mockRerankerFlag = jest.fn(async () => true);
jest.mock('@server/services/reranking/rerankerFlag', () => ({
  isRerankerEnabled: () => mockRerankerFlag(),
}));

import { workspaceSearchNodes } from '@server/services/search/nodeSearch';

const prefs = (overrides: Record<string, unknown> = {}) => ({
  useVector: true,
  useFts: true,
  useGraphWalk: true,
  threadBoost: true,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  readPrefs.mockResolvedValue(prefs());
  mockResolveScope.mockResolvedValue({ mode: 'root', source: 'explicit_container' });
  mockFtsSearchNodes.mockResolvedValue([{ id: 'fts-1', rank: 1, channel: 'fts', title: 'Alpha' }]);
  embed.mockResolvedValue([0.1, 0.2]);
  mockResolveEmbeddingProvider.mockResolvedValue({
    embedQuery: embed,
    embedDocument: embed,
    info: { provider: 'test', model: 'embed' },
  });
  poolQuery.mockResolvedValue({
    rows: [{ id: 'vector-1', title: 'Vector result', similarity: 0.9 }],
  });
});

describe('workspaceSearchNodes read preferences', () => {
  it('runs both channels for implicit hybrid mode', async () => {
    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
    });

    expect(result.channels_used).toEqual(['fts', 'vector']);
    expect(mockFtsSearchNodes).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('skips vector search when useVector is false', async () => {
    readPrefs.mockResolvedValueOnce(prefs({ useVector: false }));

    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
    });

    expect(result.channels_used).toEqual(['fts']);
    expect(mockFtsSearchNodes).toHaveBeenCalledTimes(1);
    expect(embed).not.toHaveBeenCalled();
  });

  it('skips keyword search when useFts is false', async () => {
    readPrefs.mockResolvedValueOnce(prefs({ useFts: false }));

    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
    });

    expect(result.channels_used).toEqual(['vector']);
    expect(mockFtsSearchNodes).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('returns an actionable hint when both implicit channels are disabled', async () => {
    readPrefs.mockResolvedValueOnce(prefs({ useVector: false, useFts: false }));

    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
    });

    expect(result.channels_used).toEqual([]);
    expect(result.hits).toEqual([]);
    expect(result.suggested).toContain('No workspace search channels are enabled');
  });

  it('lets an explicit semantic mode bypass the persisted vector gate', async () => {
    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
      mode: 'semantic',
    });

    expect(result.channels_used).toEqual(['vector']);
    expect(readPrefs).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('ignores per-node writer settings when deciding read channels', async () => {
    readPrefs.mockResolvedValueOnce(
      prefs({
        nodeEmbeddingSettings: {
          doc: { onSave: false, onEdit: false, staleCheck: false },
        },
      })
    );

    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
    });

    expect(result.channels_used).toEqual(['fts', 'vector']);
  });

  it('reuses a precomputed embedding without calling the provider embed method again', async () => {
    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
      precomputedEmbedding: { vector: [0.3, 0.4], modelId: 'test:embed' },
    });

    expect(result.channels_used).toEqual(['fts', 'vector']);
    expect(embed).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledWith(expect.any(String), [
      '[0.3,0.4]',
      'test:embed',
      'doc',
      null,
      null,
      40,
    ]);
  });

  it('keeps strict scoped body vectors on the ANN-served candidate query', async () => {
    mockResolveScope.mockResolvedValueOnce({
      mode: 'project',
      project_id: 'project-snaglet',
      source: 'explicit_project',
    });

    await workspaceSearchNodes({
      query: 'embeddings',
      kind: 'doc',
      scope: { project_id: 'project-snaglet' },
      mode: 'semantic',
    });

    const sql = String(poolQuery.mock.calls[0]?.[0]);
    expect(sql).not.toContain('eligible_embeddings AS MATERIALIZED');
    expect(sql).toContain('FROM public.embeddings');
    expect(sql).toContain('chunk_index >= 0');
    expect(sql).toContain('ORDER BY vector <=>');
  });

  it('applies explicit updated ordering before the final limit', async () => {
    mockFtsSearchNodes.mockResolvedValueOnce([
      { id: 'older', rank: 1, channel: 'fts', title: 'Exact older result' },
      { id: 'newer', rank: 2, channel: 'fts', title: 'Exact newer result' },
    ]);
    poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'older',
          created_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-02T00:00:00.000Z',
        },
        {
          id: 'newer',
          created_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-20T00:00:00.000Z',
        },
      ],
    });

    const result = await workspaceSearchNodes({
      query: 'exact result',
      kind: 'doc',
      scope: { container_id: 'root' },
      mode: 'keyword',
      order_by: 'updated_desc',
      limit: 1,
    });

    expect(mockFtsSearchNodes).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: 'updated_desc', limit: 4 })
    );
    expect(result.hits.map((hit) => hit.node_id)).toEqual(['newer']);
  });

  it('keeps thread lookup on the lexical title channel', async () => {
    const result = await workspaceSearchNodes({
      query: 'planning',
      kind: 'thread',
      scope: { container_id: 'root' },
    });

    expect(result.channels_used).toEqual(['fts']);
    expect(embed).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('keeps container lookup on the lexical name channel', async () => {
    const result = await workspaceSearchNodes({
      query: 'shipping status',
      kind: 'container',
      scope: { container_id: 'root' },
    });

    expect(result.channels_used).toEqual(['fts']);
    expect(embed).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects explicit semantic mode for structural thread/container kinds', async () => {
    const thread = await workspaceSearchNodes({
      query: 'planning',
      kind: 'thread',
      scope: { container_id: 'root' },
      mode: 'semantic',
    });
    const container = await workspaceSearchNodes({
      query: 'shipping',
      kind: 'container',
      scope: { container_id: 'root' },
      mode: 'semantic',
    });
    expect(thread.channels_used).toEqual([]);
    expect(container.channels_used).toEqual([]);
    expect(thread.suggested).toContain("Use mode: 'keyword'");
    expect(container.suggested).toContain("Use mode: 'keyword'");
    expect(embed).not.toHaveBeenCalled();
  });

  it('supports tool nodes on the lexical channel only', async () => {
    const result = await workspaceSearchNodes({
      query: 'workspace search',
      kind: 'tool',
      scope: { container_id: 'root' },
    });

    expect(result.channels_used).toEqual(['fts']);
    expect(mockFtsSearchNodes).toHaveBeenCalledWith({
      query: 'workspace search',
      kind: 'tool',
      scope: { mode: 'root', source: 'explicit_container' },
      limit: 40,
      timeRange: null,
    });
    expect(embed).not.toHaveBeenCalled();
  });

  it('applies time_range to both lexical and vector channels', async () => {
    await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
      time_range: {
        from: '2026-05-01T00:00:00Z',
        to: '2026-06-01T00:00:00Z',
      },
    });

    expect(mockFtsSearchNodes).toHaveBeenCalledWith(
      expect.objectContaining({
        timeRange: expect.objectContaining({
          from: '2026-05-01T00:00:00.000Z',
          to: '2026-06-01T00:00:00.000Z',
          mode: 'filter',
          field: 'activity_at',
        }),
      })
    );
    expect(poolQuery).toHaveBeenCalledWith(expect.any(String), [
      '[0.1,0.2]',
      'test:embed',
      'doc',
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      40,
    ]);
  });
});

describe('workspaceSearchNodes min_score', () => {
  it('drops weak fused hits when an explicit relevance floor is provided', async () => {
    mockResolveEmbeddingProvider.mockResolvedValueOnce(null);

    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
      min_score: 0.02,
    });

    expect(result.hits).toEqual([]);
    expect(result.suggested).toContain('No matches above the relevance threshold');
  });

  it('preserves weak ranked hits when min_score is zero', async () => {
    mockResolveEmbeddingProvider.mockResolvedValueOnce(null);

    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
      min_score: 0,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.node_id).toBe('fts-1');
  });
});

describe('workspaceSearchNodes vector-only candidates', () => {
  it('returns far vector-only candidates with their similarity, closest first', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [
        { id: 'near', title: 'Relevant result', similarity: 0.72 },
        { id: 'mid', title: 'Near neighbor', similarity: 0.57 },
        { id: 'far', title: 'Far neighbor', similarity: 0.41 },
      ],
    });

    const result = await workspaceSearchNodes({
      query: 'vague word',
      kind: 'doc',
      scope: { container_id: 'root' },
      mode: 'semantic',
    });

    expect(result.hits.map((hit) => [hit.node_id, hit.vectorSimilarity, hit.channels])).toEqual([
      ['near', 0.72, ['vector']],
      ['mid', 0.57, ['vector']],
      ['far', 0.41, ['vector']],
    ]);
  });
});

describe('workspaceSearchNodes rerank flag (tiering contract)', () => {
  it('does not touch the reranker by default (palette tier)', async () => {
    await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
    });

    expect(mockRerank).not.toHaveBeenCalled();
  });

  it('rerank: true re-orders the fused candidates via the cross-encoder', async () => {
    mockFtsSearchNodes.mockResolvedValue([
      { id: 'doc-a', rank: 1, channel: 'fts', title: 'Alpha' },
      { id: 'doc-b', rank: 2, channel: 'fts', title: 'Beta' },
    ]);
    poolQuery.mockResolvedValue({ rows: [] });
    // Cross-encoder prefers doc-b.
    mockRerank.mockResolvedValue({
      results: [
        { id: 'doc-b', score: 5, index: 1, text: 'Beta' },
        { id: 'doc-a', score: 1, index: 0, text: 'Alpha' },
      ],
    });

    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
      rerank: true,
    });

    expect(mockRerank).toHaveBeenCalledTimes(1);
    expect(result.hits.map((hit) => hit.node_id)).toEqual(['doc-b', 'doc-a']);
  });

  it('degrades to RRF order when the reranker fails', async () => {
    mockFtsSearchNodes.mockResolvedValue([
      { id: 'doc-a', rank: 1, channel: 'fts', title: 'Alpha' },
      { id: 'doc-b', rank: 2, channel: 'fts', title: 'Beta' },
    ]);
    poolQuery.mockResolvedValue({ rows: [] });
    mockRerank.mockRejectedValue(new Error('model not installed'));

    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
      rerank: true,
    });

    expect(result.hits.map((hit) => hit.node_id)).toEqual(['doc-a', 'doc-b']);
  });

  it('rerank: true keeps the fused order without the cross-encoder while the reranker flag is off', async () => {
    mockRerankerFlag.mockResolvedValueOnce(false);
    mockFtsSearchNodes.mockResolvedValue([
      { id: 'doc-a', rank: 1, channel: 'fts', title: 'Alpha' },
      { id: 'doc-b', rank: 2, channel: 'fts', title: 'Beta' },
    ]);
    poolQuery.mockResolvedValue({ rows: [] });

    const result = await workspaceSearchNodes({
      query: 'alpha',
      kind: 'doc',
      scope: { container_id: 'root' },
      rerank: true,
    });

    expect(mockRerank).not.toHaveBeenCalled();
    expect(result.hits.map((hit) => hit.node_id)).toEqual(['doc-a', 'doc-b']);
  });
});
