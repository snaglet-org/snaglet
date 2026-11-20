/**
 * Pause / backfill / clear — end-to-end against the real database + filesystem
 * (per-file PostgreSQL clone).
 *
 *   1. Pause: `embeddings.enabled: false` in snaglet.config.json stops the sweep but
 *      keeps every file row and embedding; semantic file search still works.
 *   2. Backfill while paused: the project-scoped pass reconciles new files and
 *      embeds missing content without flipping the preference on disk. It
 *      reads every file again rather than settling any from a cached stat.
 *   3. Clear preview: content shared with another project counts as kept, so
 *      reclaimable bytes < linked bytes.
 *   4. Confirmed clear: deletes only this project's rows and orphaned chunk
 *      sets; shared embeddings, source files and snaglet.config.json survive.
 *   5. Removing snaglet.config.json purges the project's index.
 * Plus route-level checks (status payload, conflict 409) via supertest.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Containers, Projects, getDb } from '@snaglet/db';
import { Files, FileEmbeddings } from '@snaglet/db/tables/files';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import {
  MockEmbeddingProvider,
  setEmbeddingProvider,
  resetEmbeddingProvider,
  type EmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import { sweepMissingFileEmbeddings } from '@server/services/embedding/fileContentEmbedding';
import { ensureWatchConfig, reindexAll, writeIndexConfig } from '@server/services/fileIndexing';
import { readWatchConfig, watchConfigPath } from '@server/services/fileIndexing/watchConfig';
import {
  cancelProjectBackfill,
  runProjectBackfill,
  startProjectBackfill,
} from '@server/services/fileIndexing/backfill';
import {
  clearProjectEmbeddings,
  getProjectEmbeddingsClearPreview,
} from '@server/services/fileIndexing/clearEmbeddings';
import {
  rememberRead,
  setHashedStatClockForTests,
} from '@server/services/fileIndexing/hashedStatCache';
import { reconcileProject } from '@server/services/fileIndexing/reconcile';
import {
  endExclusiveOp,
  getProjectIndexingRuntime,
  tryBeginExclusiveOp,
} from '@server/services/fileIndexing/projectIndexingStatus';
import { registerProjectEmbeddingRoutes } from '@server/domains/projects/handlers/embeddingsHandlers';
import { errorHandler } from '@server/middleware';
import { searchFileNodes } from '@server/services/search/fileNodeSearch';
import type { ProjectEmbeddingsClearPreview, ProjectIndexingStatus } from '@snaglet/shared/types';

/** These tests embed freshly written files; the 30 s settle window is covered separately. */
const NO_SETTLE = { settleMs: 0 } as const;

const RUN = Date.now();
const PROVIDER_ID = `mockpbc-${RUN}`;
const MODEL_KEY = `emb-pbc-${RUN}`;
const MODEL_ID = `model-pbc-${RUN}`;

const SHARED_BODY = `export const walrusShared${RUN} = 'same bytes in two projects';\n`;
const UNIQUE_BODY = `export const octopusUnique${RUN} = 'only in project A';\n`;
const LATE_BODY = `export const pelicanLate${RUN} = 'added while paused';\n`;

const mock = new MockEmbeddingProvider(768);
const provider: EmbeddingProvider = {
  info: { provider: PROVIDER_ID, model: MODEL_KEY, dimensions: 768 },
  embedDocument: (text) => mock.embedDocument(text),
  embedQuery: (text) => mock.embedQuery(text),
};

const tmpDirs: string[] = [];
const containerIds: string[] = [];
let dirA = '';
let dirB = '';
let projectA: ProjectRow;
let projectB: ProjectRow;

async function makeProject(name: string, folderPath: string): Promise<ProjectRow> {
  const container = await Containers.create({ name: `${name}-c`, category: 'project' });
  containerIds.push(container.id);
  return Projects.create({ name, containerId: container.id, folderPath });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerProjectEmbeddingRoutes(router);
  app.use('/projects', router);
  app.use(errorHandler);
  return app;
}

const hashOf = async (projectId: string, relativePath: string) => {
  const row = (await Files.listByProject(projectId)).find((f) => f.relativePath === relativePath);
  return row?.contentHash ?? null;
};

describe('pause / backfill / clear lifecycle (real DB + FS)', () => {
  beforeAll(async () => {
    const pool = getDb();
    setEmbeddingProvider(provider);
    await pool.query(
      `INSERT INTO public.providers (id, name, type) VALUES ($1, 'Mock PBC', 'runtime')
       ON CONFLICT (id) DO NOTHING`,
      [PROVIDER_ID]
    );
    await pool.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
       VALUES ($1, $2, $3, 'Mock PBC Embedding', 'embedding', 768)
       ON CONFLICT (provider_id, model_id) DO NOTHING`,
      [MODEL_ID, PROVIDER_ID, MODEL_KEY]
    );

    dirA = await mkdtemp(path.join(tmpdir(), 'snaglet-pbc-a-'));
    dirB = await mkdtemp(path.join(tmpdir(), 'snaglet-pbc-b-'));
    tmpDirs.push(dirA, dirB);
    await writeFile(path.join(dirA, 'unique.ts'), UNIQUE_BODY);
    await writeFile(path.join(dirA, 'shared.ts'), SHARED_BODY);
    await writeFile(path.join(dirB, 'shared.ts'), SHARED_BODY);
    await ensureWatchConfig(dirA);
    await ensureWatchConfig(dirB);

    projectA = await makeProject(`pbc-a-${RUN}`, dirA);
    projectB = await makeProject(`pbc-b-${RUN}`, dirB);

    // Bootstrap: both projects active (separate folders → both owners), then
    // embed everything so the pause/backfill/clear steps start from full
    // coverage under the mock model.
    await reindexAll('test:pbc-bootstrap', undefined, [projectA, projectB]);
    await sweepMissingFileEmbeddings(50, provider, NO_SETTLE);
  }, 30_000);

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

  it('bootstrap indexed and embedded both projects', async () => {
    const filesA = await Files.listByProject(projectA.id);
    expect(filesA.map((f) => f.relativePath).sort()).toEqual(['shared.ts', 'unique.ts']);
    expect((await Files.listByProject(projectB.id)).map((f) => f.relativePath)).toEqual([
      'shared.ts',
    ]);
    const uniqueHash = await hashOf(projectA.id, 'unique.ts');
    expect(await FileEmbeddings.existsByHashModel(uniqueHash!, MODEL_ID)).toBe(true);
  });

  it('enabled:false pauses the sweep but preserves rows, embeddings, and search', async () => {
    await writeIndexConfig(dirA, { enabled: false });

    await reindexAll('test:pbc-pause', undefined, [projectA, projectB]);

    // Rows and embeddings preserved.
    const filesA = await Files.listByProject(projectA.id);
    expect(filesA.map((f) => f.relativePath).sort()).toEqual(['shared.ts', 'unique.ts']);
    const uniqueHash = await hashOf(projectA.id, 'unique.ts');
    expect(await FileEmbeddings.existsByHashModel(uniqueHash!, MODEL_ID)).toBe(true);

    // The paused project's semantic file search still works.
    const hits = await searchFileNodes(`octopusUnique${RUN} only in project A`, 8, {
      projectId: projectA.id,
    });
    expect(hits.some((hit) => hit.contentHash === uniqueHash)).toBe(true);
  });

  it('GET indexing-status reports paused with intact coverage totals', async () => {
    const res = await request(makeApp()).get(`/projects/${projectA.id}/indexing-status`);
    expect(res.status).toBe(200);
    const status = res.body.data as ProjectIndexingStatus;
    expect(status.hasFolder).toBe(true);
    expect(status.configStatus).toBe('present');
    expect(status.workerEnabled).toBe(false); // paused
    expect(status.coverage.totalFiles).toBe(2); // nothing was deleted
    expect(status.activeExclusiveOp).toBeNull();
  });

  it('backfill embeds new files while paused and leaves the preference untouched', async () => {
    await writeFile(path.join(dirA, 'late.ts'), LATE_BODY);
    const configBefore = await readFile(watchConfigPath(dirA), 'utf8');

    const result = await runProjectBackfill(projectA.id, { providerOverride: provider });

    expect(result.reconciledUpserts).toBe(1); // late.ts picked up
    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(0);

    const lateHash = await hashOf(projectA.id, 'late.ts');
    expect(lateHash).not.toBeNull();
    expect(await FileEmbeddings.existsByHashModel(lateHash!, MODEL_ID)).toBe(true);

    // Worker preference unchanged: still paused, file byte-identical.
    expect(await readFile(watchConfigPath(dirA), 'utf8')).toBe(configBefore);
    const cfg = await readWatchConfig(dirA);
    expect(cfg.status).toBe('present');
    expect(cfg.enabled).toBe(false);
  });

  it('backfill reads every file again instead of settling it from a cached stat', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'snaglet-pbc-stale-'));
    tmpDirs.push(dir);
    await ensureWatchConfig(dir);
    const file = path.join(dir, 'stale.txt');
    await writeFile(file, `stale-${RUN}`);
    const project = await makeProject(`pbc-stale-${RUN}`, dir);
    const later = () => Date.now() + 10_000; // the fixture counts as settled
    setHashedStatClockForTests(later);
    try {
      await reconcileProject(project);
      const realHash = await hashOf(project.id, 'stale.txt');
      // A stale index the stat cannot reveal: the row and the cache agree on a
      // hash the bytes no longer have, so the periodic scan keeps it.
      const staleHash = 'f'.repeat(64);
      await getDb().query(`UPDATE public.files SET content_hash = $1 WHERE project_id = $2`, [
        staleHash,
        project.id,
      ]);
      rememberRead(project.id, dir, 'stale.txt', await stat(file), later(), {
        kind: 'hashed',
        contentHash: staleHash,
      });
      await reconcileProject(project);
      expect(await hashOf(project.id, 'stale.txt')).toBe(staleHash);

      const result = await runProjectBackfill(project.id, { providerOverride: provider });

      expect(result.reconciledUpserts).toBe(1);
      expect(await hashOf(project.id, 'stale.txt')).toBe(realHash);
    } finally {
      setHashedStatClockForTests(null);
    }
  });

  it('cancels after one candidate, retains vectors, releases the slot and resumes only missing work', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'snaglet-pbc-cancel-'));
    tmpDirs.push(dir);
    await ensureWatchConfig(dir);
    await writeFile(path.join(dir, 'first.txt'), `cancel-first-${RUN}`);
    await writeFile(path.join(dir, 'second.txt'), `cancel-second-${RUN}`);
    const project = await makeProject(`pbc-cancel-${RUN}`, dir);
    let calls = 0;
    const cancelingProvider: EmbeddingProvider = {
      ...provider,
      embedDocument: async (text) => {
        calls += 1;
        const canceled = await request(makeApp()).post(
          `/projects/${project.id}/embeddings/backfill/cancel`
        );
        expect(canceled.status).toBe(200);
        return provider.embedDocument(text);
      },
    };
    const result = await runProjectBackfill(project.id, { providerOverride: cancelingProvider });
    expect(result).toMatchObject({
      canceled: true,
      total: 2,
      processed: 1,
      embedded: 1,
      failed: 0,
    });
    expect(calls).toBe(1);
    expect(getProjectIndexingRuntime(project.id)).toMatchObject({
      op: 'cancelled',
      activeExclusiveOp: null,
      lastError: null,
      backfill: { processed: 1, embedded: 1, total: 2 },
    });
    const finishedFiles = await Files.listByProject(project.id);
    const retained = await Promise.all(
      finishedFiles.map((file) => FileEmbeddings.existsByHashModel(file.contentHash, MODEL_ID))
    );
    expect(retained.filter(Boolean)).toHaveLength(1);
    const noRunning = await request(makeApp()).post(
      `/projects/${project.id}/embeddings/backfill/cancel`
    );
    expect(noRunning.status).toBe(404);
    const resumed = await runProjectBackfill(project.id, { providerOverride: provider });
    expect(resumed).toMatchObject({ total: 1, embedded: 1, failed: 0 });
    expect(resumed.canceled).toBeUndefined();
    expect(getProjectIndexingRuntime(project.id).op).toBe('idle');
  });

  it('cancels during scanning without entering the embedding phase', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'snaglet-pbc-cancel-scan-'));
    tmpDirs.push(dir);
    await ensureWatchConfig(dir);
    await writeFile(path.join(dir, 'scan.txt'), `cancel-scan-${RUN}`);
    const project = await makeProject(`pbc-cancel-scan-${RUN}`, dir);
    await startProjectBackfill(project.id);
    // Cancel synchronously before the traversal can complete.
    cancelProjectBackfill(project.id);
    for (let i = 0; i < 100 && getProjectIndexingRuntime(project.id).activeExclusiveOp; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(getProjectIndexingRuntime(project.id)).toMatchObject({
      op: 'cancelled',
      activeExclusiveOp: null,
      lastError: null,
      backfill: null,
      lastCheckedAt: null,
    });
    const resumed = await runProjectBackfill(project.id, { providerOverride: provider });
    expect(resumed.embedded).toBe(1);
  });

  it('backfill conflicts with an active exclusive op (409), then recovers', async () => {
    expect(tryBeginExclusiveOp(projectA.id, 'clear')).toBe(true);
    try {
      const res = await request(makeApp()).post(`/projects/${projectA.id}/embeddings/backfill`);
      expect(res.status).toBe(409);
    } finally {
      endExclusiveOp(projectA.id);
    }
  });

  it('clear preview separates shared content from genuinely reclaimable bytes', async () => {
    const res = await request(makeApp()).get(`/projects/${projectA.id}/embeddings/clear-preview`);
    expect(res.status).toBe(200);
    const preview = res.body.data as ProjectEmbeddingsClearPreview;

    expect(preview.fileCount).toBe(3); // unique, shared, late
    expect(preview.uniqueContents).toBe(3);
    expect(preview.sharedContents).toBe(1); // shared.ts also referenced by B
    expect(preview.exclusiveContents).toBe(2);
    expect(preview.vectorChunks).toBeGreaterThan(0);
    expect(preview.reclaimableBytes).toBeGreaterThan(0);
    // Shared bytes are linked but not reclaimable.
    expect(preview.reclaimableBytes).toBeLessThan(preview.linkedBytes);
  });

  it('confirmed clear deletes only this project — shared embeddings, sources, and config survive', async () => {
    const uniqueHash = await hashOf(projectA.id, 'unique.ts');
    const sharedHash = await hashOf(projectA.id, 'shared.ts');
    const sourceBefore = await readFile(path.join(dirA, 'unique.ts'), 'utf8');
    const configBefore = await readFile(watchConfigPath(dirA), 'utf8');

    const result = await clearProjectEmbeddings(projectA.id);
    expect(result.removedFiles).toBe(3);
    expect(result.removedChunks).toBeGreaterThan(0);

    // This project's rows are gone; its exclusive chunk sets were GC'd.
    expect(await Files.listByProject(projectA.id)).toEqual([]);
    expect(await FileEmbeddings.existsByHashModel(uniqueHash!, MODEL_ID)).toBe(false);

    // Shared content survives for project B, and B's search keeps working.
    expect(await FileEmbeddings.existsByHashModel(sharedHash!, MODEL_ID)).toBe(true);
    const hits = await searchFileNodes(`walrusShared${RUN} same bytes`, 8, {
      projectId: projectB.id,
    });
    expect(hits.some((hit) => hit.contentHash === sharedHash)).toBe(true);

    // Sources and the worker preference are byte-identical.
    expect(await readFile(path.join(dirA, 'unique.ts'), 'utf8')).toBe(sourceBefore);
    expect(await readFile(watchConfigPath(dirA), 'utf8')).toBe(configBefore);

    // Status now reports zero coverage, still paused, nothing running.
    const res = await request(makeApp()).get(`/projects/${projectA.id}/indexing-status`);
    const status = res.body.data as ProjectIndexingStatus;
    expect(status.coverage.totalFiles).toBe(0);
    expect(status.workerEnabled).toBe(false);
    expect(status.activeExclusiveOp).toBeNull();
  });

  it('removing snaglet.config.json purges the project index and GCs unreferenced content', async () => {
    const sharedHash = await hashOf(projectB.id, 'shared.ts');
    await unlink(watchConfigPath(dirB));

    await reindexAll('test:pbc-config-removed', undefined, [projectA, projectB]);

    // B's index is purged, and the now-unreferenced chunk set is GC'd.
    expect(await Files.listByProject(projectB.id)).toEqual([]);
    expect(await FileEmbeddings.existsByHashModel(sharedHash!, MODEL_ID)).toBe(false);
  });
});
