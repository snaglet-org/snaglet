/**
 * Category changes on the containers PATCH route are one-way. Thread and
 * table scopes point at project containers, so the route refuses any change
 * out of 'project' with a 400 before it writes anything — including when the
 * same request also moves the container — and the project's facet, indexed
 * files and embeddings stay exactly as they were. A plain folder, which
 * nothing scopes to, may be promoted to a project in place: its children stay
 * put and a folder under a project becomes a subproject. 'project' is the
 * only category: anything else is rejected with a 400.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, Containers, Docs, Files, Embeddings } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import containersRouter from '@server/domains/containers/containers.routes';

const PREFIX = 'demote-test';
const PROJECT_ID = `container-${PREFIX}-project`;
const PLAIN_ID = `container-${PREFIX}-plain`;
const OTHER_PARENT_ID = `container-${PREFIX}-other-parent`;
const DOC_ID = `doc-${PREFIX}-child`;
const PROMOTE_ID = `container-${PREFIX}-promote`;
const PROMOTE_SUBFOLDER_ID = `container-${PREFIX}-promote-sub`;
const PROMOTE_DOC_ID = `doc-${PREFIX}-promote-doc`;
const NESTED_ID = `container-${PREFIX}-nested`;

// Seeded by migrations/seeds/local-models.sql — present in every
// migrated database, so the embeddings FK to models(id) is satisfied.
const EMBEDDER_MODEL_ID = 'model-8f21c9d4-6a35-5e0b-9c47-2de1a07b4f63';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/containers', containersRouter);
  app.use(errorHandler);
  return app;
}

function fakeVector(): number[] {
  const v = new Array<number>(768).fill(0);
  v[0] = 1;
  return v;
}

async function cleanup() {
  const pool = getDb();
  // File nodes first (they hang under the containers), then the rest.
  await pool.query(
    `DELETE FROM public.nodes
      WHERE type = 'file'
        AND id IN (SELECT id FROM public.files WHERE project_id = $1)`,
    [PROJECT_ID]
  );
  await pool.query(`DELETE FROM public.nodes WHERE id IN ($1, $2, $3, $4, $5, $6, $7, $8)`, [
    PROJECT_ID,
    PLAIN_ID,
    OTHER_PARENT_ID,
    DOC_ID,
    PROMOTE_ID,
    PROMOTE_SUBFOLDER_ID,
    PROMOTE_DOC_ID,
    NESTED_ID,
  ]);
}

let app: express.Application;
let fileIds: string[] = [];

async function expectProjectIntact(): Promise<void> {
  const container = await Containers.findById(PROJECT_ID);
  expect(container?.category).toBe('project');
  expect(container?.folderPath).toBe('/tmp/demote-test-folder');
  expect(container?.githubUrl).toBe('https://github.com/example/demote-test');
  expect(container?.fileIndexingEnabled).toBe(false);
  expect(await Files.countByProject(PROJECT_ID)).toBe(2);
  const { rows } = await getDb().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM public.embeddings WHERE node_id = ANY($1::text[])`,
    [fileIds]
  );
  expect(rows[0].n).toBe(2);
  expect((await Docs.findById(DOC_ID))?.containerId).toBe(PROJECT_ID);
}

describe('PATCH /api/containers/:id — folder → project is allowed, project → anything is not', () => {
  beforeAll(async () => {
    await cleanup();
    app = makeApp();

    // A project container with the full facet + two indexed files, each with
    // an embedding chunk, plus a doc child.
    await Containers.create({
      id: PROJECT_ID,
      name: `${PREFIX} project`,
      category: 'project',
      folderPath: '/tmp/demote-test-folder',
      githubUrl: 'https://github.com/example/demote-test',
      fileIndexingEnabled: false,
    });
    await Docs.create({ id: DOC_ID, title: `${PREFIX} child doc`, containerId: PROJECT_ID });

    const f1 = await Files.upsertByPath({
      projectId: PROJECT_ID,
      relativePath: 'src/a.ts',
      contentHash: 'hash-a',
      sizeBytes: 10,
      containerId: PROJECT_ID,
    });
    const f2 = await Files.upsertByPath({
      projectId: PROJECT_ID,
      relativePath: 'src/b.ts',
      contentHash: 'hash-b',
      sizeBytes: 20,
      containerId: PROJECT_ID,
    });
    fileIds = [f1.id, f2.id];
    for (const nodeId of fileIds) {
      await Embeddings.create({
        nodeId,
        modelId: EMBEDDER_MODEL_ID,
        vector: fakeVector(),
        contentHash: `content-${nodeId}`,
      });
    }

    await Containers.create({ id: PLAIN_ID, name: `${PREFIX} plain` });
    await Containers.create({ id: OTHER_PARENT_ID, name: `${PREFIX} other parent` });

    // A plain folder to promote, holding a doc and a subfolder, plus a plain
    // folder nested under the project.
    await Containers.create({ id: PROMOTE_ID, name: `${PREFIX} promote me` });
    await Containers.create({
      id: PROMOTE_SUBFOLDER_ID,
      name: `${PREFIX} promote sub`,
      parentId: PROMOTE_ID,
    });
    await Docs.create({
      id: PROMOTE_DOC_ID,
      title: `${PREFIX} promote doc`,
      containerId: PROMOTE_ID,
    });
    await Containers.create({ id: NESTED_ID, name: `${PREFIX} nested`, parentId: PROJECT_ID });
  });

  afterAll(async () => {
    await cleanup();
  });

  it('refuses a project becoming null with a 400 and leaves the project intact', async () => {
    const res = await request(app).patch(`/api/containers/${PROJECT_ID}`).send({ category: null });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cannot change out of 'project'/);
    await expectProjectIntact();
  });

  it('refuses the change before a move in the same request commits', async () => {
    const res = await request(app)
      .patch(`/api/containers/${PROJECT_ID}`)
      .send({ category: null, parentId: OTHER_PARENT_ID });
    expect(res.status).toBe(400);
    expect((await Containers.findById(PROJECT_ID))?.parentId).toBeNull();
    await expectProjectIntact();
  });

  it('promotes a plain folder to a project in place; its doc and subfolder stay its children', async () => {
    const res = await request(app)
      .patch(`/api/containers/${PROMOTE_ID}`)
      .send({ category: 'project' });
    expect(res.status).toBe(200);
    expect(res.body.data.category).toBe('project');
    expect(res.body.data.folderPath).toBeNull();
    const promoted = await Containers.findById(PROMOTE_ID);
    expect(promoted?.category).toBe('project');
    expect(promoted?.parentId).toBeNull();
    expect((await Docs.findById(PROMOTE_DOC_ID))?.containerId).toBe(PROMOTE_ID);
    const sub = await Containers.findById(PROMOTE_SUBFOLDER_ID);
    expect(sub?.parentId).toBe(PROMOTE_ID);
    expect(sub?.category).toBeNull();
  });

  it('a promoted project cannot be demoted back to a folder', async () => {
    const res = await request(app).patch(`/api/containers/${PROMOTE_ID}`).send({ category: null });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cannot change out of 'project'/);
    expect((await Containers.findById(PROMOTE_ID))?.category).toBe('project');
  });

  it('a plain folder nested under a project becomes a subproject and the parent is untouched', async () => {
    const res = await request(app)
      .patch(`/api/containers/${NESTED_ID}`)
      .send({ category: 'project' });
    expect(res.status).toBe(200);
    expect(res.body.data.category).toBe('project');
    expect(res.body.data.parentId).toBe(PROJECT_ID);
    await expectProjectIntact();
  });

  it('promotion and a move in the same request both land', async () => {
    const res = await request(app)
      .patch(`/api/containers/${PLAIN_ID}`)
      .send({ category: 'project', parentId: OTHER_PARENT_ID });
    expect(res.status).toBe(200);
    const row = await Containers.findById(PLAIN_ID);
    expect(row?.category).toBe('project');
    expect(row?.parentId).toBe(OTHER_PARENT_ID);
    // Put it back to a root-level project for the tests below.
    await request(app).patch(`/api/containers/${PLAIN_ID}`).send({ parentId: null });
  });

  it('re-sending the current project category is a plain update', async () => {
    const res = await request(app)
      .patch(`/api/containers/${PROJECT_ID}`)
      .send({ category: 'project', name: `${PREFIX} project renamed` });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe(`${PREFIX} project renamed`);
    await expectProjectIntact();
  });

  it('clearing an already-null category on a plain container is a no-op update', async () => {
    const back = await request(app)
      .patch(`/api/containers/${OTHER_PARENT_ID}`)
      .send({ category: null });
    expect(back.status).toBe(200);
    expect(back.body.data.category).toBeNull();
    expect(back.body.data).not.toHaveProperty('phase');
  });

  it.each([['reference'], ['log'], ['status']])(
    'rejects the unsupported %s category with 400 and mutates nothing',
    async (retired) => {
      // No translation by design: an unsupported value fails rather than
      // being silently rewritten.
      const before = await Containers.findById(OTHER_PARENT_ID);

      const res = await request(app)
        .patch(`/api/containers/${OTHER_PARENT_ID}`)
        .send({ category: retired });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/category must be one of project/);

      const after = await Containers.findById(OTHER_PARENT_ID);
      expect(after?.category).toBe(before?.category);
      expect(after?.updatedAt).toBe(before?.updatedAt);
    }
  );
});
