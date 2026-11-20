/**
 * Content-addressed file embeddings, end to end against the real database and
 * filesystem (run-scoped mock provider, per-file PostgreSQL clone):
 *   1. the same bytes linked by two projects embed exactly once (provider call
 *      count asserted), so N worktrees do not mean N× embeddings;
 *   2. re-reconciling an unchanged tree leaves nothing to embed;
 *   3. search returns one hit per unique content, listing every owning path;
 *   4. deleting one project drops only its references, and GC removes exactly
 *      the chunk sets nothing references.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Containers, Projects, getDb } from '@snaglet/db';
import { Files, FileEmbeddings } from '@snaglet/db/tables/files';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import {
  MockEmbeddingProvider,
  setEmbeddingProvider,
  resetEmbeddingProvider,
  type EmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import {
  embedFileContent,
  gcOrphanFileEmbeddings,
  listMissingFileEmbeddingCandidates,
  sweepMissingFileEmbeddings,
} from '@server/services/embedding/fileContentEmbedding';
import { reconcileProject } from '@server/services/fileIndexing';
import { purgeProjectIndex } from '@server/services/fileIndexing/watcher';
import { searchFileNodes } from '@server/services/search/fileNodeSearch';

/** These tests embed freshly written files; the 30 s settle window is covered separately. */
const NO_SETTLE = { settleMs: 0 } as const;

const RUN = Date.now();
const PROVIDER_ID = `mockfemb-${RUN}`;
const MODEL_KEY = `emb-${RUN}`;
const MODEL_ID = `model-file-embed-it-${RUN}`;

const SHARED_BODY = `export const walrusShared${RUN} = 'same bytes in two projects';\n`;
const UNIQUE_BODY = `export const octopusUnique${RUN} = 'only in project A';\n`;

const mock = new MockEmbeddingProvider(768);
let embedDocumentCalls = 0;
const provider: EmbeddingProvider = {
  info: { provider: PROVIDER_ID, model: MODEL_KEY, dimensions: 768 },
  embedDocument: (text) => {
    embedDocumentCalls += 1;
    return mock.embedDocument(text);
  },
  embedQuery: (text) => mock.embedQuery(text),
};

const tmpDirs: string[] = [];
const containerIds: string[] = [];
let projectA: ProjectRow;
let projectB: ProjectRow;

async function makeProject(name: string, folderPath: string): Promise<ProjectRow> {
  const container = await Containers.create({ name: `${name}-c`, category: 'project' });
  containerIds.push(container.id);
  return Projects.create({ name, containerId: container.id, folderPath });
}

describe('content-addressed file embeddings (dedupe, GC, search)', () => {
  beforeAll(async () => {
    const pool = getDb();
    setEmbeddingProvider(provider);
    await pool.query(
      `INSERT INTO public.providers (id, name, type) VALUES ($1, 'Mock File Embed', 'runtime')
       ON CONFLICT (id) DO NOTHING`,
      [PROVIDER_ID]
    );
    await pool.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
       VALUES ($1, $2, $3, 'Mock File Embedding', 'embedding', 768)
       ON CONFLICT (provider_id, model_id) DO NOTHING`,
      [MODEL_ID, PROVIDER_ID, MODEL_KEY]
    );

    // Two separate folders with identical file content — the worktree case the
    // ownership resolver cannot collapse (different trees, same bytes).
    const dirA = await mkdtemp(path.join(tmpdir(), 'snaglet-femb-a-'));
    const dirB = await mkdtemp(path.join(tmpdir(), 'snaglet-femb-b-'));
    tmpDirs.push(dirA, dirB);
    await writeFile(path.join(dirA, 'shared.ts'), SHARED_BODY);
    await writeFile(path.join(dirB, 'shared.ts'), SHARED_BODY);
    await writeFile(path.join(dirA, 'unique.ts'), UNIQUE_BODY);

    projectA = await makeProject(`femb-a-${RUN}`, dirA);
    projectB = await makeProject(`femb-b-${RUN}`, dirB);
    await reconcileProject(projectA);
    await reconcileProject(projectB);
  }, 20_000);

  afterAll(async () => {
    const pool = getDb();
    resetEmbeddingProvider();
    await pool.query(`DELETE FROM public.file_embeddings WHERE model_id = $1`, [MODEL_ID]);
    if (containerIds.length > 0) {
      await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [containerIds]);
    }
    await pool.query(`DELETE FROM public.models WHERE id = $1`, [MODEL_ID]);
    await pool.query(`DELETE FROM public.providers WHERE id = $1`, [PROVIDER_ID]);
    await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('indexes both projects but shares content by hash', async () => {
    const filesA = await Files.listByProject(projectA.id);
    const filesB = await Files.listByProject(projectB.id);
    expect(filesA.map((f) => f.relativePath).sort()).toEqual(['shared.ts', 'unique.ts']);
    expect(filesB.map((f) => f.relativePath)).toEqual(['shared.ts']);
    const sharedA = filesA.find((f) => f.relativePath === 'shared.ts');
    const sharedB = filesB[0];
    expect(sharedA?.contentHash).toBe(sharedB?.contentHash);
    expect(await Files.countByContentHash(sharedA!.contentHash)).toBe(2);
  });

  it('embeds each unique content exactly once across both projects', async () => {
    embedDocumentCalls = 0;
    const result = await sweepMissingFileEmbeddings(50, provider, NO_SETTLE);
    // Three file rows, but only two unique contents → two embeds, no reuse
    // needed (the shared hash is deduped inside the candidate query itself).
    expect(result).toEqual({ embedded: 2, reused: 0 });
    expect(embedDocumentCalls).toBe(2);
    expect(await FileEmbeddings.countRows(MODEL_ID)).toBe(2);
  });

  it('re-reconciling an unchanged tree leaves zero embedding work', async () => {
    const again = await reconcileProject(projectA);
    expect(again).toMatchObject({ upserted: 0, removed: 0 });
    expect(again.unchanged).toBe(2);

    embedDocumentCalls = 0;
    expect(await listMissingFileEmbeddingCandidates(MODEL_ID, 50, [], NO_SETTLE)).toEqual([]);
    const sweep = await sweepMissingFileEmbeddings(50, provider, NO_SETTLE);
    expect(sweep).toEqual({ embedded: 0, reused: 0 });
    // The acceptance metric: an unchanged reindex performs zero computations.
    expect(embedDocumentCalls).toBe(0);
  });

  it('embedFileContent short-circuits on an already-embedded hash (zero compute)', async () => {
    const shared = (await Files.listByProject(projectB.id))[0];
    embedDocumentCalls = 0;
    const result = await embedFileContent({
      contentHash: shared.contentHash,
      content: SHARED_BODY,
      providerOverride: provider,
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe('unchanged');
    expect(embedDocumentCalls).toBe(0);
  });

  it('search returns one hit per unique content, listing both owning paths', async () => {
    const hits = await searchFileNodes(`walrusShared${RUN} same bytes`, 8);
    const shared = (await Files.listByProject(projectB.id))[0];
    const sharedHits = hits.filter((hit) => hit.contentHash === shared.contentHash);
    expect(sharedHits).toHaveLength(1);
    const paths = sharedHits[0].paths;
    expect(paths).toHaveLength(2);
    expect(paths.map((p) => p.projectId).sort()).toEqual([projectA.id, projectB.id].sort());
    expect(paths.every((p) => p.relativePath === 'shared.ts')).toBe(true);

    // Scoped to one project, the hit narrows to that project's reference only.
    const scoped = await searchFileNodes(`walrusShared${RUN} same bytes`, 8, {
      projectId: projectB.id,
    });
    const scopedShared = scoped.filter((hit) => hit.contentHash === shared.contentHash);
    expect(scopedShared).toHaveLength(1);
    expect(scopedShared[0].paths).toHaveLength(1);
    expect(scopedShared[0].projectId).toBe(projectB.id);
  });

  it('unlinking one project keeps shared content; GC removes only orphans', async () => {
    const filesA = await Files.listByProject(projectA.id);
    const sharedHash = filesA.find((f) => f.relativePath === 'shared.ts')!.contentHash;
    const uniqueHash = filesA.find((f) => f.relativePath === 'unique.ts')!.contentHash;

    // Purge project A's index (the unlink/gate-off path — GC runs inside).
    await purgeProjectIndex(projectA.id);
    expect(await Files.listByProject(projectA.id)).toEqual([]);

    // Shared content still referenced by B → survives. Unique content → gone.
    expect(await FileEmbeddings.existsByHashModel(sharedHash, MODEL_ID)).toBe(true);
    expect(await FileEmbeddings.existsByHashModel(uniqueHash, MODEL_ID)).toBe(false);

    // Project B's semantic search is intact after A's removal.
    const hits = await searchFileNodes(`walrusShared${RUN} same bytes`, 8, {
      projectId: projectB.id,
    });
    expect(hits.some((hit) => hit.contentHash === sharedHash)).toBe(true);

    // Dropping the last reference orphans the shared set; GC reaps it.
    await Files.deleteByProject(projectB.id);
    const removed = await gcOrphanFileEmbeddings();
    expect(removed).toBeGreaterThan(0);
    expect(await FileEmbeddings.existsByHashModel(sharedHash, MODEL_ID)).toBe(false);
    expect(await FileEmbeddings.countRows(MODEL_ID)).toBe(0);
  });
});
