/**
 * Unit tests for the palette-search route (filesystem-mentions contract).
 *
 * The route accepts { query } where the query may carry a `kind:` prefix
 * (doc:/task:/file:/folder:/agent:/table:/node:), delegates workspace search to
 * paletteSearch(), filters the kind-bucketed results per the prefix, and —
 * when a thread with a project folder is in scope — merges fuzzy
 * filesystem hits.
 */

import { beforeEach, describe, expect, it } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

const paletteSearch = jest.fn();
const dbQuery = jest.fn();
const searchProjectFilesystem = jest.fn();
const searchFileNodes = jest.fn();

jest.mock('@server/services/search/paletteSearch.js', () => ({
  paletteSearch: (...args: unknown[]) => paletteSearch(...args),
}));

jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (...args: unknown[]) => dbQuery(...args) }),
}));

jest.mock('@server/services/search/filesystemSearch.js', () => ({
  searchProjectFilesystem: (...args: unknown[]) => searchProjectFilesystem(...args),
}));

jest.mock('@server/services/search/fileNodeSearch.js', () => ({
  resolveFileNodeByPath: jest.fn(),
  searchFileNodes: (...args: unknown[]) => searchFileNodes(...args),
}));

import paletteSearchRoutes from '@server/routes/palette-search';
import { errorHandler } from '@server/middleware/errorHandler';

const BASE_RESULT = {
  byKind: {
    doc: [{ node_id: 'doc-1', kind: 'doc', score: 1, channels: ['fts'], payload: {} }],
    agent: [{ node_id: 'agent-1', kind: 'agent', score: 1, channels: ['fts'], payload: {} }],
  },
  channelsUsed: ['fts'],
  semanticStatus: 'ready',
  semanticStatusReason: null,
  coverage: {},
};

describe('POST /api/search/palette', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    paletteSearch.mockResolvedValue(structuredClone(BASE_RESULT));
    searchProjectFilesystem.mockResolvedValue([
      { path: '/tmp/literal.ts', name: 'literal.ts', kind: 'file', score: 1 },
    ]);
    searchFileNodes.mockResolvedValue([]);
    // No thread → no project folder → no filesystem scan.
    dbQuery.mockResolvedValue({ rows: [] });
    app = express();
    app.use(express.json());
    app.use('/api/search/palette', paletteSearchRoutes);
    app.use(errorHandler);
  });

  it('delegates a plain query to paletteSearch across the default kinds', async () => {
    const response = await request(app).post('/api/search/palette').send({ query: 'alpha' });

    expect(response.status).toBe(200);
    expect(paletteSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'alpha',
        kinds: expect.arrayContaining(['doc', 'agent', 'table']),
      })
    );
    expect(response.body.data.byKind.doc).toHaveLength(1);
    expect(response.body.data.byKind.agent).toHaveLength(1);
  });

  it('parses a kind prefix into a kinds restriction', async () => {
    const response = await request(app).post('/api/search/palette').send({ query: 'doc:alpha' });

    expect(response.status).toBe(200);
    expect(paletteSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'alpha', kinds: ['doc'] })
    );
  });

  it('keeps a generic keyword query cheap without message or thread-summary lanes', async () => {
    const response = await request(app)
      .post('/api/search/palette')
      .send({ query: 'images from the launch', mode: 'keyword' });

    expect(response.status).toBe(200);
    expect(paletteSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'images from the launch',
        kinds: expect.arrayContaining(['image', 'doc', 'container']),
      })
    );
    expect(paletteSearch.mock.calls.at(-1)?.[0].kinds).not.toContain('message');
    expect(paletteSearch.mock.calls.at(-1)?.[0].kinds).not.toContain('thread_summary');
    expect(response.body.data.byKind.doc).toHaveLength(1);
    expect(searchProjectFilesystem).toHaveBeenCalled();
    expect(searchFileNodes).not.toHaveBeenCalled();
  });

  it('restores message and thread-summary lanes for an evidence-intent keyword query', async () => {
    const response = await request(app)
      .post('/api/search/palette')
      .send({ query: 'when did we discuss embeddings?', mode: 'keyword' });

    expect(response.status).toBe(200);
    expect(paletteSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'keyword',
        kinds: expect.arrayContaining(['message', 'thread_summary']),
      })
    );
  });

  it('restores evidence lanes during debounced hybrid enrichment', async () => {
    const response = await request(app)
      .post('/api/search/palette')
      .send({ query: 'embeddings', mode: 'hybrid' });

    expect(response.status).toBe(200);
    expect(paletteSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'hybrid',
        kinds: expect.arrayContaining(['message', 'thread_summary']),
      })
    );
  });

  it('honors an explicit message filter on the keyword tier', async () => {
    const response = await request(app)
      .post('/api/search/palette')
      .send({ query: 'embeddings', mode: 'keyword', kinds: ['message'] });

    expect(response.status).toBe(200);
    expect(paletteSearch).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'keyword', kinds: ['message'] })
    );
  });

  it('keeps explicit kind filters strict', async () => {
    const response = await request(app)
      .post('/api/search/palette')
      .send({ query: 'doc: images from the launch' });

    expect(response.status).toBe(200);
    expect(paletteSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'images from the launch', kinds: ['doc'] })
    );
  });

  it('narrows an agent: prefix to the agent lane', async () => {
    const response = await request(app).post('/api/search/palette').send({ query: 'agent:pix' });

    expect(response.status).toBe(200);
    expect(paletteSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'pix', kinds: ['agent'] })
    );
  });

  it('file: prefix empties workspace buckets (filesystem-only search)', async () => {
    const response = await request(app).post('/api/search/palette').send({ query: 'file:index' });

    expect(response.status).toBe(200);
    const byKind = response.body.data.byKind;
    expect(byKind.doc).toEqual([]);
    expect(byKind.agent).toEqual([]);
  });

  it('forwards semantic metadata (status + reason) from the service', async () => {
    paletteSearch.mockResolvedValue({
      ...structuredClone(BASE_RESULT),
      semanticStatus: 'unavailable',
      semanticStatusReason: 'The local embedding model is not installed yet.',
    });

    const response = await request(app).post('/api/search/palette').send({ query: 'alpha' });

    expect(response.status).toBe(200);
    expect(response.body.data.semanticStatus).toBe('unavailable');
    expect(response.body.data.semanticStatusReason).toBe(
      'The local embedding model is not installed yet.'
    );
  });

  it('forwards explicit project and container scope to palette search', async () => {
    await request(app).post('/api/search/palette').send({ query: 'alpha', projectId: 'project-1' });
    expect(paletteSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: { project_id: 'project-1' } })
    );

    await request(app)
      .post('/api/search/palette')
      .send({ query: 'alpha', containerId: 'container-1' });
    expect(paletteSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: { container_id: 'container-1' } })
    );
  });

  it('does not rewrite query text into hidden scope, time, or ordering filters', async () => {
    const response = await request(app)
      .post('/api/search/palette')
      .send({ query: 'latest embeddings task in Snaglet yesterday', mode: 'hybrid' });

    expect(response.status).toBe(200);
    expect(paletteSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'latest embeddings task in Snaglet yesterday',
        scope: undefined,
        mode: 'hybrid',
        orderBy: 'relevance',
        timeRange: null,
      })
    );
    expect(response.body.data.executionPlan).toMatchObject({
      query: 'latest embeddings task in Snaglet yesterday',
      scopePolicy: 'neutral',
      ordering: 'relevance',
    });
    expect(searchFileNodes).toHaveBeenCalledWith(
      'latest embeddings task in Snaglet yesterday',
      8,
      undefined
    );
  });

  it('excludes lexical filesystem hits in semantic mode', async () => {
    const response = await request(app)
      .post('/api/search/palette')
      .send({ query: 'meaning', mode: 'semantic' });

    expect(response.status).toBe(200);
    expect(paletteSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'meaning', mode: 'semantic' })
    );
    expect(searchProjectFilesystem).not.toHaveBeenCalled();
    expect(response.body.data.filesystem).toEqual([]);
  });

  it('ignores legacy settled flags and returns the base hybrid result', async () => {
    const response = await request(app)
      .post('/api/search/palette')
      .send({ query: 'meaning', mode: 'hybrid', settled: true });

    expect(response.status).toBe(200);
    expect(response.body.data.rerank).toBeUndefined();
    expect(response.body.data.byKind).toEqual(BASE_RESULT.byKind);
  });

  it('returns semantic file hits directly without a settled rerank pass', async () => {
    const file = {
      nodeId: 'file-1',
      relativePath: 'src/search.ts',
      absolutePath: '/tmp/src/search.ts',
      projectId: 'project-1',
      sizeBytes: 12,
      updatedAt: '2026-01-01T00:00:00.000Z',
      score: 0.8,
    };
    searchFileNodes.mockResolvedValue([file]);

    const response = await request(app).post('/api/search/palette').send({
      query: 'meaning',
      mode: 'hybrid',
      settled: true,
      rerankScope: 'quick-search',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.rerank).toBeUndefined();
    expect(response.body.data.files).toEqual([file]);
  });

  describe('matches found only by meaning', () => {
    const fileHit = (nodeId: string, score: number) => ({
      nodeId,
      relativePath: `notes/${nodeId}.md`,
      absolutePath: `/tmp/notes/${nodeId}.md`,
      projectId: 'project-1',
      sizeBytes: 12,
      updatedAt: '2026-01-01T00:00:00.000Z',
      score,
    });
    const meaningHit = (nodeId: string, kind: string, similarity: number) => ({
      node_id: nodeId,
      kind,
      score: 0.01,
      channels: ['vector'],
      vectorSimilarity: similarity,
      payload: {},
    });
    const ids = (hits: { node_id: string }[]) => hits.map((hit) => hit.node_id);

    it('pools files with meaning-only workspace hits and keeps the five closest', async () => {
      paletteSearch.mockResolvedValue({
        ...structuredClone(BASE_RESULT),
        byKind: {
          doc: [
            { node_id: 'doc-word', kind: 'doc', score: 1, channels: ['fts'], payload: {} },
            meaningHit('doc-near', 'doc', 0.6),
            meaningHit('doc-mid', 'doc', 0.5),
            meaningHit('doc-far', 'doc', 0.4),
          ],
          message: [meaningHit('message-near', 'message', 0.55)],
          agent: [
            { node_id: 'agent-word', kind: 'agent', score: 1, channels: ['fts'], payload: {} },
          ],
        },
      });
      searchFileNodes.mockResolvedValue([
        fileHit('file-near', 0.58),
        fileHit('file-mid', 0.45),
        fileHit('file-far', 0.3),
      ]);

      const response = await request(app)
        .post('/api/search/palette')
        .send({ query: 'zzqv', mode: 'hybrid' });

      expect(response.status).toBe(200);
      const { byKind, files } = response.body.data;
      expect(ids(byKind.doc)).toEqual(['doc-word', 'doc-near', 'doc-mid']);
      expect(ids(byKind.message)).toEqual(['message-near']);
      expect(ids(byKind.agent)).toEqual(['agent-word']);
      expect(files.map((file: { nodeId: string }) => file.nodeId)).toEqual([
        'file-near',
        'file-mid',
      ]);
    });

    it('lists low-similarity files when nothing else matched', async () => {
      paletteSearch.mockResolvedValue({ ...structuredClone(BASE_RESULT), byKind: {} });
      searchFileNodes.mockResolvedValue([fileHit('file-a', 0.31), fileHit('file-b', 0.3)]);

      const response = await request(app)
        .post('/api/search/palette')
        .send({ query: 'zzqv nonexistent banana', mode: 'hybrid' });

      expect(response.body.data.files.map((file: { nodeId: string }) => file.nodeId)).toEqual([
        'file-a',
        'file-b',
      ]);
    });

    it('applies no floor and no shared budget to an explicit file search', async () => {
      const files = Array.from({ length: 7 }, (_, i) => fileHit(`file-${i}`, 0.3 - i * 0.02));
      searchFileNodes.mockResolvedValue(files);

      const response = await request(app).post('/api/search/palette').send({
        query: 'file:zzqv nonexistent banana',
        mode: 'hybrid',
      });

      expect(response.body.data.files).toEqual(files);
    });

    it('keeps filtered meaning hits as palette search ranked them', async () => {
      const docs = Array.from({ length: 6 }, (_, i) =>
        meaningHit(`doc-${i}`, 'doc', 0.2 - i * 0.01)
      );
      paletteSearch.mockResolvedValue({ ...structuredClone(BASE_RESULT), byKind: { doc: docs } });

      const response = await request(app)
        .post('/api/search/palette')
        .send({ query: 'doc:zzqv', mode: 'hybrid' });

      expect(ids(response.body.data.byKind.doc)).toEqual(ids(docs));
    });
  });

  it('treats a missing query as empty browse', async () => {
    const response = await request(app).post('/api/search/palette').send({});

    expect(response.status).toBe(200);
    expect(paletteSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '' }));
  });

  describe('table kind', () => {
    const TABLE_HIT = {
      node_id: 'table-builtin-credentials',
      kind: 'table',
      score: 0.9,
      channels: ['fts'],
      payload: { name: 'Credentials', title: 'Credentials', origin: 'builtin' },
    };

    it('narrows a table: prefix to the table lane with no file or filesystem lanes', async () => {
      paletteSearch.mockResolvedValue({
        ...structuredClone(BASE_RESULT),
        byKind: { table: [TABLE_HIT] },
      });

      const response = await request(app)
        .post('/api/search/palette')
        .send({ query: 'table: cred', mode: 'keyword' });

      expect(response.status).toBe(200);
      expect(paletteSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'cred', kinds: ['table'], broadInteractiveSearch: false })
      );
      expect(searchProjectFilesystem).not.toHaveBeenCalled();
      expect(searchFileNodes).not.toHaveBeenCalled();
      expect(response.body.data.byKind.table).toEqual([TABLE_HIT]);
      expect(response.body.data.filesystem).toEqual([]);
    });

    it('keeps only table buckets for an explicit kinds: [table] request', async () => {
      paletteSearch.mockResolvedValue({
        ...structuredClone(BASE_RESULT),
        byKind: { ...structuredClone(BASE_RESULT).byKind, table: [TABLE_HIT] },
      });

      const response = await request(app)
        .post('/api/search/palette')
        .send({ query: 'cred', kinds: ['table'] });

      expect(response.status).toBe(200);
      expect(paletteSearch).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['table'] }));
      expect(response.body.data.byKind.table).toEqual([TABLE_HIT]);
      expect(response.body.data.byKind.doc).toEqual([]);
      expect(response.body.data.byKind.agent).toEqual([]);
    });

    it('includes the table lane in the fast keyword tier', async () => {
      await request(app).post('/api/search/palette').send({ query: 'cred', mode: 'keyword' });

      expect(paletteSearch.mock.calls.at(-1)?.[0].kinds).toContain('table');
    });

    it('excludes tables and agents from a node: filter', async () => {
      await request(app).post('/api/search/palette').send({ query: 'node:alpha' });

      const kinds = paletteSearch.mock.calls.at(-1)?.[0].kinds as string[];
      expect(kinds).toEqual(expect.arrayContaining(['doc', 'container', 'thread']));
      expect(kinds).not.toContain('table');
      expect(kinds).not.toContain('agent');
    });

    it('keeps tables out of an explicitly scoped search', async () => {
      await request(app)
        .post('/api/search/palette')
        .send({ query: 'cred', kinds: ['table', 'doc'], containerId: 'container-1' });

      expect(paletteSearch).toHaveBeenCalledWith(
        expect.objectContaining({ kinds: ['doc'], scope: { container_id: 'container-1' } })
      );
    });
  });
});
