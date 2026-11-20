/**
 * Concurrent writers of the same content against the real database
 * (throwaway test Postgres only).
 *
 *   1. Concurrent `FileEmbeddings.replaceChunks` for one (content_hash,
 *      model_id) serialize on an advisory xact lock: no unique-key error
 *      (23505), exactly one chunk set.
 *   2. `listMissingFileEmbeddingCandidates` with an excluded project skips
 *      that project's files and still returns other projects' files.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Containers, Projects, getDb } from '@snaglet/db';
import { Files, FileEmbeddings, type FileEmbeddingChunkInput } from '@snaglet/db/tables/files';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import { listMissingFileEmbeddingCandidates } from '@server/services/embedding/fileContentEmbedding';

/** Freshly written files: the 30 s settle window is covered in fileEmbedSettle.test.ts. */
const NO_SETTLE = { settleMs: 0 } as const;
import { reconcileProject } from '@server/services/fileIndexing';

const RUN = Date.now();
const PROVIDER_ID = `mockfconc-${RUN}`;
const MODEL_KEY = `emb-conc-${RUN}`;
const MODEL_ID = `model-file-embed-conc-${RUN}`;
const DIM = 768;

function chunks(count: number, seed: number): FileEmbeddingChunkInput[] {
  return Array.from({ length: count }, (_, i) => ({
    vector: Array.from({ length: DIM }, (_, d) => ((seed + i + d) % 7) / 7),
    chunkIndex: i,
    chunkStart: i * 10,
    chunkEnd: i * 10 + 10,
  }));
}

const tmpDirs: string[] = [];
const containerIds: string[] = [];

async function makeProject(name: string, folderPath: string): Promise<ProjectRow> {
  const container = await Containers.create({ name: `${name}-c`, category: 'project' });
  containerIds.push(container.id);
  return Projects.create({ name, containerId: container.id, folderPath });
}

describe('file embeddings under concurrent writers', () => {
  beforeAll(async () => {
    const pool = getDb();
    await pool.query(
      `INSERT INTO public.providers (id, name, type) VALUES ($1, 'Mock File Conc', 'runtime')
       ON CONFLICT (id) DO NOTHING`,
      [PROVIDER_ID]
    );
    await pool.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
       VALUES ($1, $2, $3, 'Mock File Conc Embedding', 'embedding', ${DIM})
       ON CONFLICT (provider_id, model_id) DO NOTHING`,
      [MODEL_ID, PROVIDER_ID, MODEL_KEY]
    );
  }, 20_000);

  afterAll(async () => {
    const pool = getDb();
    await pool.query(`DELETE FROM public.file_embeddings WHERE model_id = $1`, [MODEL_ID]);
    if (containerIds.length > 0) {
      await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [containerIds]);
    }
    await pool.query(`DELETE FROM public.models WHERE id = $1`, [MODEL_ID]);
    await pool.query(`DELETE FROM public.providers WHERE id = $1`, [PROVIDER_ID]);
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });

  it('concurrent replaceChunks for the same (hash, model) never hit the unique key', async () => {
    const pool = getDb();
    for (let round = 0; round < 5; round++) {
      const hash = `conc-hash-${RUN}-${round}`;
      // Different chunk counts so "exactly one chunk set" is checkable.
      const writers = [3, 3, 2, 4, 3, 1].map((n, w) =>
        FileEmbeddings.replaceChunks(hash, MODEL_ID, chunks(n, w))
      );
      const settled = await Promise.allSettled(writers);
      const failures = settled.filter((s) => s.status === 'rejected');
      expect(failures).toEqual([]);

      const { rows } = await pool.query<{ chunk_index: number }>(
        `SELECT chunk_index FROM public.file_embeddings
          WHERE content_hash = $1 AND model_id = $2 ORDER BY chunk_index`,
        [hash, MODEL_ID]
      );
      const indexes = rows.map((r) => r.chunk_index);
      // One complete chunk set from a single writer: 0..n-1, no duplicates.
      expect(indexes).toEqual(Array.from({ length: indexes.length }, (_, i) => i));
      expect([1, 2, 3, 4]).toContain(indexes.length);
    }
  }, 30_000);

  it('listMissingFileEmbeddingCandidates skips excluded projects only', async () => {
    const dirA = await mkdtemp(path.join(tmpdir(), 'snaglet-fconc-a-'));
    const dirB = await mkdtemp(path.join(tmpdir(), 'snaglet-fconc-b-'));
    tmpDirs.push(dirA, dirB);
    await writeFile(path.join(dirA, 'a.ts'), `export const a${RUN} = 'only in A';\n`);
    await writeFile(path.join(dirB, 'b.ts'), `export const b${RUN} = 'only in B';\n`);
    const projectA = await makeProject(`fconc-a-${RUN}`, dirA);
    const projectB = await makeProject(`fconc-b-${RUN}`, dirB);
    await reconcileProject(projectA);
    await reconcileProject(projectB);

    const [fileA] = await Files.listByProject(projectA.id);
    const [fileB] = await Files.listByProject(projectB.id);
    expect(fileA && fileB).toBeTruthy();

    const all = await listMissingFileEmbeddingCandidates(MODEL_ID, 10_000, [], NO_SETTLE);
    expect(all).toEqual(expect.arrayContaining([fileA!.id, fileB!.id]));

    const withoutA = await listMissingFileEmbeddingCandidates(
      MODEL_ID,
      10_000,
      [projectA.id],
      NO_SETTLE
    );
    expect(withoutA).not.toContain(fileA!.id);
    expect(withoutA).toContain(fileB!.id);

    // Empty exclusion list behaves like no exclusion.
    const none = await listMissingFileEmbeddingCandidates(MODEL_ID, 10_000, [], NO_SETTLE);
    expect(none).toEqual(expect.arrayContaining([fileA!.id, fileB!.id]));
  }, 30_000);
});
