/**
 * The project file-indexing switch is the typed `containers.file_indexing_enabled`
 * column. PATCH /api/projects/:id `fileIndexingEnabled` and
 * PUT /api/projects/:id/index-config `enabled` both write it, project and
 * container rows read it back, and a `configJson` body field never reaches
 * the database. Database access is real; folder reconciliation
 * is mocked (no project here links a folder).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, Projects, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';

const mockOnProjectFolderChanged = jest.fn();
jest.mock('@server/services/fileIndexing', () => ({
  ensureWatchConfig: jest.fn(),
  getDefaultExclusions: () => ({ dirs: [], filenames: [], extensions: [] }),
  onProjectFolderChanged: (...args: unknown[]) => mockOnProjectFolderChanged(...args),
  readIndexConfig: jest.fn(),
  scheduleProjectReindex: jest.fn(),
  writeIndexConfig: jest.fn(),
}));
jest.mock('@server/services/fileIndexing/watcher', () => ({ purgeProjectIndex: jest.fn() }));

import projectsRouter from '@server/domains/projects/projects.routes';

const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';

const app = express();
app.use(express.json());
app.use('/api/projects', projectsRouter);
app.use(errorHandler);

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.nodes WHERE id = $1`, [PROJECT_ID]);
}

async function storedSwitch(): Promise<boolean | undefined> {
  const { rows } = await getDb().query<{ file_indexing_enabled: boolean }>(
    'SELECT file_indexing_enabled FROM public.containers WHERE id = $1',
    [PROJECT_ID]
  );
  return rows[0]?.file_indexing_enabled;
}

describe('project file-indexing switch', () => {
  beforeAll(async () => {
    await cleanup();
    await Containers.create({ id: PROJECT_ID, name: 'Test project', category: 'project' });
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(cleanup);

  it('starts on, and project and container rows expose it without a configJson', async () => {
    const res = await request(app).get(`/api/projects/${PROJECT_ID}`).expect(200);
    expect(res.body.data.fileIndexingEnabled).toBe(true);
    expect(res.body.data).not.toHaveProperty('configJson');
    const container = await Containers.findById(PROJECT_ID);
    expect(container?.fileIndexingEnabled).toBe(true);
    expect(container).not.toHaveProperty('configJson');
  });

  it('PATCH fileIndexingEnabled writes the column and reconciles the project', async () => {
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .send({ fileIndexingEnabled: false })
      .expect(200);
    expect(res.body.data.fileIndexingEnabled).toBe(false);
    expect(await storedSwitch()).toBe(false);
    expect((await Projects.findById(PROJECT_ID))?.fileIndexingEnabled).toBe(false);
    expect(mockOnProjectFolderChanged).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('PATCH refuses a non-boolean fileIndexingEnabled and changes nothing', async () => {
    await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .send({ fileIndexingEnabled: 'true' })
      .expect(400);
    expect(await storedSwitch()).toBe(false);
  });

  it('PATCH ignores a configJson field', async () => {
    await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .send({ configJson: { fileIndexingEnabled: true } })
      .expect(200);
    expect(await storedSwitch()).toBe(false);
  });

  it('PUT index-config enabled writes the column on a project without a folder', async () => {
    const res = await request(app)
      .put(`/api/projects/${PROJECT_ID}/index-config`)
      .send({ enabled: true })
      .expect(200);
    expect(res.body.data).toMatchObject({ hasFolder: false, enabled: true });
    expect(await storedSwitch()).toBe(true);
    expect(mockOnProjectFolderChanged).toHaveBeenCalledWith(PROJECT_ID);
  });
});
