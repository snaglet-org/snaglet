/**
 * Quick search's matches found only by meaning, over the palette route against
 * real PostgreSQL, with the built-in local embedding model's ids. With no
 * keyword hit, an unfiltered search lists the five closest of the docs and
 * indexed files together, however low they score; a keyword hit is listed
 * whatever its similarity; a filtered search lists meaning hits up to its
 * limit. Each vector is built so its cosine similarity to the query is known.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, Docs, getDb } from '@snaglet/db';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { FileEmbeddings, Files } from '@snaglet/db/tables/files';
import {
  resetEmbeddingProvider,
  setEmbeddingProvider,
  type EmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import {
  LOCAL_EMBEDDER_MODEL_ID,
  LOCAL_EMBEDDER_PROVIDER_ID,
} from '@server/services/embedding/embedderModelManifest';

// The local model's files are not installed under Jest; report them ready so
// search takes the vector path with the test provider below.
jest.mock('@server/services/embedding/LocalEmbedderService', () => ({
  ...jest.requireActual<object>('@server/services/embedding/LocalEmbedderService'),
  getLocalEmbedderStatus: async () => ({ ready: true }),
}));

import paletteSearchRouter from '@server/routes/palette-search';
import { errorHandler } from '@server/middleware/errorHandler';

const PROJECT = 'container-1111111111111-ppppppppp';
const KEYWORD_DOC = 'doc-1111111111111-kkkkkkkkk';
/** Doc id → cosine similarity to the query, closest first. */
const MEANING_DOCS: [string, number][] = [
  ['doc-1111111111111-aaaaaaaaa', 0.45],
  ['doc-1111111111111-bbbbbbbbb', 0.4],
  ['doc-1111111111111-ccccccccc', 0.35],
  ['doc-1111111111111-ddddddddd', 0.3],
  ['doc-1111111111111-eeeeeeeee', 0.25],
  ['doc-1111111111111-fffffffff', 0.2],
  ['doc-1111111111111-ggggggggg', 0.15],
];
/** File path → cosine similarity to the query, closest first. */
const MEANING_FILES: [string, number][] = [
  ['notes/near.md', 0.42],
  ['notes/mid.md', 0.33],
  ['notes/far.md', 0.1],
];

/** A unit vector whose cosine similarity to the query vector is `similarity`. */
function vectorAt(similarity: number): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[0] = similarity;
  vector[1] = Math.sqrt(1 - similarity ** 2);
  return vector;
}

const provider: EmbeddingProvider = {
  info: { provider: LOCAL_EMBEDDER_PROVIDER_ID, model: LOCAL_EMBEDDER_MODEL_ID, dimensions: 768 },
  async embedDocument(): Promise<number[]> {
    return vectorAt(1);
  },
  async embedQuery(): Promise<number[]> {
    return vectorAt(1);
  },
};

type Hit = { node_id: string; channels: string[] };
type PaletteData = { byKind: Record<string, Hit[]>; files: { relativePath: string }[] };

async function search(body: Record<string, unknown>): Promise<PaletteData> {
  const app = express();
  app.use(express.json());
  app.use('/api/search/palette', paletteSearchRouter);
  app.use(errorHandler);
  const response = await request(app).post('/api/search/palette').send(body);
  expect(response.status).toBe(200);
  return response.body.data as PaletteData;
}

const docIds = (data: PaletteData) => (data.byKind.doc ?? []).map((hit) => hit.node_id);
const filePaths = (data: PaletteData) => data.files.map((file) => file.relativePath);
const meaningDocIds = (count: number) => MEANING_DOCS.slice(0, count).map(([id]) => id);

describe('quick search matches found only by meaning', () => {
  beforeAll(async () => {
    const { rows } = await getDb().query<{ id: string }>(
      `SELECT id FROM public.models WHERE provider_id = $1 AND model_id = $2`,
      [LOCAL_EMBEDDER_PROVIDER_ID, LOCAL_EMBEDDER_MODEL_ID]
    );
    const modelId = rows[0]?.id;
    if (!modelId) throw new Error('The local embedding model row is missing from the template');

    await Docs.create({ id: KEYWORD_DOC, title: 'Zzqv field notes' });
    await Embeddings.create({ nodeId: KEYWORD_DOC, modelId, vector: vectorAt(0.05) });
    for (const [id, similarity] of MEANING_DOCS) {
      await Docs.create({ id, title: `Test doc ${id.slice(-1)}` });
      await Embeddings.create({ nodeId: id, modelId, vector: vectorAt(similarity) });
    }

    await Containers.create({ id: PROJECT, name: 'Test project a', category: 'project' });
    for (const [relativePath, similarity] of MEANING_FILES) {
      const contentHash = `hash-${relativePath}`;
      await Files.upsertByPath({ projectId: PROJECT, relativePath, contentHash, sizeBytes: 12 });
      await FileEmbeddings.replaceChunks(contentHash, modelId, [
        { vector: vectorAt(similarity), chunkIndex: 0, chunkStart: 0, chunkEnd: 12 },
      ]);
    }
    setEmbeddingProvider(provider);
  });

  afterAll(() => {
    resetEmbeddingProvider();
  });

  it('lists the five closest docs and files when no words match, however far', async () => {
    const data = await search({ query: 'vvkq', mode: 'hybrid' });

    expect(docIds(data)).toEqual(meaningDocIds(3));
    expect(filePaths(data)).toEqual(['notes/near.md', 'notes/mid.md']);
  });

  it('lists a keyword hit outside the budget of five', async () => {
    const data = await search({ query: 'zzqv', mode: 'hybrid' });

    expect(docIds(data)).toEqual([KEYWORD_DOC, ...meaningDocIds(3)]);
    expect(data.byKind.doc?.[0]?.channels).toContain('fts');
    expect(filePaths(data)).toEqual(['notes/near.md', 'notes/mid.md']);
  });

  it('lists far meaning hits up to the requested limit in a filtered search', async () => {
    const data = await search({ query: 'doc:zzqv', mode: 'hybrid', perKindLimit: 8 });

    expect(docIds(data)).toEqual([KEYWORD_DOC, ...meaningDocIds(7)]);
    expect(data.files).toEqual([]);
  });
});
