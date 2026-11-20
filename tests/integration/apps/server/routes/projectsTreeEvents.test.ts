/**
 * Project mutations change what the sidebar tree renders (the container's name
 * and its project category), so each one must announce itself on the tree
 * surface. Database access is real; the tree emitters are spied.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, Docs, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';

const mockEmitTreeNodeCreated = jest.fn();
const mockEmitTreeNodeUpdated = jest.fn();
jest.mock('@server/realtime/surfaces/tree', () => ({
  ...jest.requireActual<object>('@server/realtime/surfaces/tree'),
  emitTreeNodeCreated: (...args: unknown[]) => mockEmitTreeNodeCreated(...args),
  emitTreeNodeUpdated: (...args: unknown[]) => mockEmitTreeNodeUpdated(...args),
}));
// Keep folder reconciliation out of a route test; no project here links a folder.
jest.mock('@server/services/fileIndexing', () => ({
  ensureWatchConfig: jest.fn(),
  onProjectFolderChanged: jest.fn(),
}));
jest.mock('@server/services/fileIndexing/watcher', () => ({ purgeProjectIndex: jest.fn() }));

import projectsRouter from '@server/domains/projects/projects.routes';

const PROMOTED = 'container-project-events-test-promoted';
const NOT_A_CONTAINER = 'doc-project-events-test-doc';

const app = express();
app.use(express.json());
app.use('/api/projects', projectsRouter);
app.use(errorHandler);

const createdIds: string[] = [];

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [
    [PROMOTED, NOT_A_CONTAINER, ...createdIds],
  ]);
}

describe('project routes emit tree events', () => {
  beforeAll(async () => {
    await cleanup();
    await Containers.create({ id: PROMOTED, name: 'Bare project', category: 'project' });
    await Docs.create({ id: NOT_A_CONTAINER, title: 'Not a container' });
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(cleanup);

  it('POST without a container mints one that is already a project', async () => {
    const res = await request(app).post('/api/projects').send({ name: 'New project' }).expect(201);
    createdIds.push(res.body.data.id);

    expect(mockEmitTreeNodeCreated).toHaveBeenCalledTimes(1);
    expect(mockEmitTreeNodeCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: res.body.data.id,
        kind: 'container',
        title: 'New project',
        category: 'project',
      })
    );
    expect((await Containers.findById(res.body.data.id))?.category).toBe('project');
  });

  it('POST naming an existing project container announces its new name', async () => {
    await request(app)
      .post('/api/projects')
      .send({ name: 'Named project', containerId: PROMOTED })
      .expect(201);

    expect(mockEmitTreeNodeUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: PROMOTED, kind: 'container', title: 'Named project' })
    );
  });

  it('POST naming a plain container is a 400 that writes nothing — there is no promotion', async () => {
    const plain = 'container-project-events-test-plain';
    createdIds.push(plain);
    await Containers.create({ id: plain, name: 'Plain folder' });

    await request(app)
      .post('/api/projects')
      .send({ name: 'Would be promoted', containerId: plain })
      .expect(400);

    expect(mockEmitTreeNodeUpdated).not.toHaveBeenCalled();
    const after = await Containers.findById(plain);
    expect(after?.category).toBeNull();
    expect(after?.name).toBe('Plain folder');
  });

  it('POST naming a non-container is a 404 that writes nothing', async () => {
    await request(app)
      .post('/api/projects')
      .send({ name: 'Nope', containerId: NOT_A_CONTAINER })
      .expect(404);
    expect(mockEmitTreeNodeUpdated).not.toHaveBeenCalled();
    expect((await Docs.findById(NOT_A_CONTAINER))?.title).toBe('Not a container');
  });

  it('PATCH with a new name announces the rename; a facet-only edit does not', async () => {
    await request(app).patch(`/api/projects/${PROMOTED}`).send({ name: 'Renamed' }).expect(200);
    expect(mockEmitTreeNodeUpdated).toHaveBeenCalledTimes(1);
    expect(mockEmitTreeNodeUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: PROMOTED, kind: 'container', title: 'Renamed' })
    );

    mockEmitTreeNodeUpdated.mockClear();
    await request(app)
      .patch(`/api/projects/${PROMOTED}`)
      .send({ description: 'Only a facet' })
      .expect(200);
    expect(mockEmitTreeNodeUpdated).not.toHaveBeenCalled();
  });

  it('has no DELETE (demote) route — a project stays a project', async () => {
    await request(app).delete(`/api/projects/${PROMOTED}`).expect(404);
    expect(mockEmitTreeNodeUpdated).not.toHaveBeenCalled();
    expect((await Containers.findById(PROMOTED))?.category).toBe('project');
  });
});
