/**
 * Settle-before-embed for file content, against the real
 * database + filesystem with a virtual clock.
 *
 * Every save bumps nodes.updated_at; a changed file is embedded only after
 * FILE_EMBED_SETTLE_MS without changes, and a file that never settles is still
 * embedded once FILE_EMBED_MAX_WAIT_MS has passed. The clock is injected and
 * each "save" stamps nodes.updated_at at the virtual time.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
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
  FILE_EMBED_MAX_WAIT_MS,
  FILE_EMBED_SETTLE_MS,
  listMissingFileEmbeddingCandidates,
  sweepMissingFileEmbeddings,
} from '@server/services/embedding/fileContentEmbedding';
import { reconcileProject } from '@server/services/fileIndexing';

const RUN = Date.now();
const PROVIDER_ID = `mockfsettle-${RUN}`;
const MODEL_KEY = `emb-settle-${RUN}`;
const MODEL_ID = `model-file-settle-it-${RUN}`;

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

let dir = '';
let containerId = '';
let multiContainerId = '';
let project: ProjectRow;
let virtualNow = 0;
let waiting = new Map<string, number>();
let version = 0;

const policy = () => ({ now: () => virtualNow, waiting });

/** Save the file, index it, and stamp the row's updated_at at the virtual time. */
async function save(): Promise<void> {
  version += 1;
  await writeFile(path.join(dir, 'doc.ts'), `export const settle${RUN}v${version} = ${version};\n`);
  await reconcileProject(project);
  const files = await Files.listByProject(project.id);
  await getDb().query(`UPDATE public.nodes SET updated_at = $2 WHERE id = $1`, [
    files[0]!.id,
    new Date(virtualNow),
  ]);
}

async function clearEmbeddings(): Promise<void> {
  await getDb().query(`DELETE FROM public.file_embeddings WHERE model_id = $1`, [MODEL_ID]);
}

describe('settle-before-embed for file content', () => {
  beforeAll(async () => {
    setEmbeddingProvider(provider);
    const pool = getDb();
    await pool.query(
      `INSERT INTO public.providers (id, name, type) VALUES ($1, 'Mock File Settle', 'runtime')
       ON CONFLICT (id) DO NOTHING`,
      [PROVIDER_ID]
    );
    await pool.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
       VALUES ($1, $2, $3, 'Mock File Settle Embedding', 'embedding', 768)
       ON CONFLICT (provider_id, model_id) DO NOTHING`,
      [MODEL_ID, PROVIDER_ID, MODEL_KEY]
    );
    dir = await mkdtemp(path.join(tmpdir(), 'snaglet-fsettle-'));
    const container = await Containers.create({ name: `fsettle-${RUN}-c`, category: 'project' });
    containerId = container.id;
    project = await Projects.create({
      name: `fsettle-${RUN}`,
      containerId,
      folderPath: dir,
    });
  }, 20_000);

  afterAll(async () => {
    const pool = getDb();
    resetEmbeddingProvider();
    await pool.query(`DELETE FROM public.file_embeddings WHERE model_id = $1`, [MODEL_ID]);
    await pool.query(`DELETE FROM public.nodes WHERE id = $1`, [containerId]);
    await pool.query(`DELETE FROM public.models WHERE id = $1`, [MODEL_ID]);
    await pool.query(`DELETE FROM public.providers WHERE id = $1`, [PROVIDER_ID]);
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    virtualNow = Date.now();
    waiting = new Map();
    embedDocumentCalls = 0;
    await clearEmbeddings();
  });

  it('is not a candidate 5 s after a save, and is one after the settle window', async () => {
    await save();
    virtualNow += 5_000;
    expect(await listMissingFileEmbeddingCandidates(MODEL_ID, 10, [], policy())).toEqual([]);
    virtualNow += FILE_EMBED_SETTLE_MS - 5_000 + 1_000; // 31 s after the save
    expect(await listMissingFileEmbeddingCandidates(MODEL_ID, 10, [], policy())).toHaveLength(1);
  });

  it('10 rapid saves 2 s apart produce exactly one embed, of the final version', async () => {
    for (let i = 0; i < 10; i += 1) {
      await save();
      const result = await sweepMissingFileEmbeddings(10, provider, policy());
      expect(result).toEqual({ embedded: 0, reused: 0 });
      virtualNow += 2_000;
    }
    expect(embedDocumentCalls).toBe(0);

    virtualNow += FILE_EMBED_SETTLE_MS;
    const settled = await sweepMissingFileEmbeddings(10, provider, policy());
    expect(settled).toEqual({ embedded: 1, reused: 0 });
    expect(embedDocumentCalls).toBe(1);
    expect(await FileEmbeddings.countRows(MODEL_ID)).toBe(1);
    const [file] = await Files.listByProject(project.id);
    expect(await FileEmbeddings.existsByHashModel(file!.contentHash, MODEL_ID)).toBe(true);
  });

  it('a file that never settles is embedded at the max-wait cap, then waits afresh', async () => {
    const start = virtualNow;
    // Saved every 20 s (always inside the 30 s settle window) for just under 10 min.
    while (virtualNow - start < FILE_EMBED_MAX_WAIT_MS - 20_000) {
      await save();
      expect(await sweepMissingFileEmbeddings(10, provider, policy())).toEqual({
        embedded: 0,
        reused: 0,
      });
      virtualNow += 20_000;
    }
    expect(embedDocumentCalls).toBe(0);

    // Still changing, but the cap has been reached: embed the current version.
    virtualNow = start + FILE_EMBED_MAX_WAIT_MS;
    await save();
    expect(await sweepMissingFileEmbeddings(10, provider, policy())).toEqual({
      embedded: 1,
      reused: 0,
    });
    expect(embedDocumentCalls).toBe(1);

    // The very next save starts a new wait rather than embedding every tick.
    virtualNow += 20_000;
    await save();
    expect(await sweepMissingFileEmbeddings(10, provider, policy())).toEqual({
      embedded: 0,
      reused: 0,
    });
    expect(embedDocumentCalls).toBe(1);
  });
  describe('backlogs and truncated lookups', () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    let multiDir = '';
    let multiProject: ProjectRow;
    const ids = new Map<string, string>();

    async function stamp(name: string, at: number): Promise<void> {
      await getDb().query(`UPDATE public.nodes SET updated_at = $2 WHERE id = $1`, [
        ids.get(name),
        new Date(at),
      ]);
    }

    beforeAll(async () => {
      await Files.deleteByProject(project.id); // isolate from the earlier tests
      multiDir = await mkdtemp(path.join(tmpdir(), 'snaglet-fsettle-multi-'));
      const container = await Containers.create({
        name: `fsettle-m-${RUN}-c`,
        category: 'project',
      });
      multiContainerId = container.id;
      for (const name of names) {
        await writeFile(
          path.join(multiDir, `${name}.ts`),
          `export const m${RUN}${name} = '${name}';\n`
        );
      }
      multiProject = await Projects.create({
        name: `fsettle-m-${RUN}`,
        containerId: container.id,
        folderPath: multiDir,
      });
      await reconcileProject(multiProject);
      for (const f of await Files.listByProject(multiProject.id)) {
        ids.set(path.basename(f.relativePath, '.ts'), f.id);
      }
    }, 20_000);

    afterAll(async () => {
      await getDb().query(`DELETE FROM public.nodes WHERE id = $1`, [multiContainerId]);
      await rm(multiDir, { recursive: true, force: true });
    });

    it('an overdue file is embedded even when old settled candidates exceed the batch limit', async () => {
      const t = Date.now();
      virtualNow = t;
      // a, b, c, d: settled long ago (a backlog bigger than the batch); e: just saved.
      await stamp('a', t - 4 * 3_600_000);
      await stamp('b', t - 3 * 3_600_000);
      await stamp('c', t - 2 * 3_600_000);
      await stamp('d', t - 1 * 3_600_000);
      await stamp('e', t);
      waiting.set(ids.get('e')!, t - FILE_EMBED_MAX_WAIT_MS - 1_000);

      const batch = await listMissingFileEmbeddingCandidates(MODEL_ID, 2, [], policy());
      expect(batch).toHaveLength(2);
      expect(batch[0]).toBe(ids.get('e'));

      const result = await sweepMissingFileEmbeddings(2, provider, policy());
      expect(result.embedded).toBe(2);
      const eFile = (await Files.listByProject(multiProject.id)).find(
        (f) => f.id === ids.get('e')
      )!;
      expect(await FileEmbeddings.existsByHashModel(eFile.contentHash, MODEL_ID)).toBe(true);
      // Attempted embed clears the wait so the next version waits afresh.
      expect(waiting.has(ids.get('e')!)).toBe(false);
    });

    it('an overdue file whose embed fails at the provider stays overdue', async () => {
      let attempts = 0;
      const failing: EmbeddingProvider = {
        ...provider,
        embedDocument: async () => {
          attempts += 1;
          throw new Error('provider down');
        },
      };
      const t = Date.now();
      virtualNow = t;
      await getDb().query(`DELETE FROM public.file_embeddings WHERE model_id = $1`, [MODEL_ID]);
      await stamp('e', t);
      waiting.set(ids.get('e')!, t - FILE_EMBED_MAX_WAIT_MS - 1_000);
      await sweepMissingFileEmbeddings(1, failing, policy());
      expect(attempts).toBeGreaterThan(0); // the overdue file really was tried
      expect(waiting.has(ids.get('e')!)).toBe(true);
    });

    it('does not prune wait entries the truncated unsettled lookup could not see', async () => {
      const t = Date.now();
      virtualNow = t;
      waiting = new Map();
      // Three unsettled files; the lookup only samples the 2 oldest changes.
      await stamp('a', t - 3_000);
      await stamp('b', t - 2_000);
      await stamp('c', t - 1_000);
      await stamp('d', t - 4 * 3_600_000);
      await stamp('e', t - 4 * 3_600_000);
      await getDb().query(`DELETE FROM public.file_embeddings WHERE model_id = $1`, [MODEL_ID]);
      const since = t - 5 * 60_000;
      waiting.set(ids.get('c')!, since); // newest change: truncated out of the sample

      await listMissingFileEmbeddingCandidates(MODEL_ID, 10, [], {
        ...policy(),
        unsettledLimit: 2,
      });
      expect(waiting.get(ids.get('c')!)).toBe(since); // kept, clock not reset
      expect(waiting.has(ids.get('a')!)).toBe(true);
      expect(waiting.has(ids.get('b')!)).toBe(true);

      // With room for all of them, absent ids are pruned.
      waiting.set('file-gone', since);
      await listMissingFileEmbeddingCandidates(MODEL_ID, 10, [], {
        ...policy(),
        unsettledLimit: 50,
      });
      expect(waiting.has('file-gone')).toBe(false);
      expect(waiting.get(ids.get('c')!)).toBe(since);
    });
  });
});
