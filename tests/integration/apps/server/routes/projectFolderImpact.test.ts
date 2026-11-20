import path from 'node:path';
import os from 'node:os';
import { realpath, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { Containers, Projects, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';

// Keep background reconciliation out of a route test. Candidate scanning and
// database access are real; these spies prove rejected changes never reach IO.
const mockEnsureWatchConfig = jest.fn();
const mockFolderChanged = jest.fn();
const mockPurge = jest.fn();
const mockLinkFolder = jest.fn();
const mockUnlinkFolder = jest.fn();
jest.mock('@server/services/projectFolder', () => ({
  ...jest.requireActual<object>('@server/services/projectFolder'),
  linkProjectFolder: mockLinkFolder,
  unlinkProjectFolder: mockUnlinkFolder,
}));
jest.mock('@server/services/fileIndexing', () => ({
  ensureWatchConfig: mockEnsureWatchConfig,
  onProjectFolderChanged: mockFolderChanged,
}));
jest.mock('@server/services/fileIndexing/watcher', () => ({ purgeProjectIndex: mockPurge }));

import projectsRouter from '@server/domains/projects/projects.routes';
import createContainer from '@server/services/ToolService/handlers/containers/createContainer';
import updateContainer from '@server/services/ToolService/handlers/containers/updateContainer';
import {
  tryBeginExclusiveOp,
  endExclusiveOp,
} from '@server/services/fileIndexing/projectIndexingStatus';

describe('project folder route review boundary', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use(errorHandler);
  let root: string;
  let projectId: string;
  let original: string;
  let candidate: string;
  // Over the 500-file review threshold: the only folder that needs a person's confirmation.
  let big: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-folder-route-')));
    original = path.join(root, 'original');
    candidate = path.join(root, 'candidate');
    await mkdir(path.join(original, '.git'), { recursive: true });
    await mkdir(candidate);
    big = path.join(root, 'big');
    await mkdir(path.join(big, '.git'), { recursive: true });
    await Promise.all(
      Array.from({ length: 501 }, (_, i) => writeFile(path.join(big, `${i}.ts`), 'x'))
    );
    const project = await Containers.create({
      name: 'Folder review test',
      category: 'project',
      folderPath: original,
    });
    projectId = project.id;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function expectNoChange() {
    const project = await Projects.findById(projectId);
    expect(project).toMatchObject({ name: 'Folder review test', folderPath: original });
    expect(await readdir(candidate)).toEqual([]);
    expect(await readdir(big)).not.toContain('snaglet.config.json');
    expect(mockEnsureWatchConfig).not.toHaveBeenCalled();
    expect(mockFolderChanged).not.toHaveBeenCalled();
    expect(mockPurge).not.toHaveBeenCalled();
    expect(mockLinkFolder).not.toHaveBeenCalled();
    expect(mockUnlinkFolder).not.toHaveBeenCalled();
  }

  it('previews a candidate without modifying the project, config, or index', async () => {
    const response = await request(app)
      .post(`/api/projects/${projectId}/folder-path/preview`)
      .send({ folderPath: big })
      .expect(200);
    expect(response.body.data).toMatchObject({
      folderPath: big,
      requiresConfirmation: true,
      replacingFolder: true,
    });
    await expectNoChange();
  });

  it('rejects creation before allocating a container', async () => {
    const before = await getDb().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.nodes'
    );
    await request(app)
      .post('/api/projects')
      .send({ name: 'Must not exist', folderPath: big })
      .expect(409);
    const after = await getDb().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.nodes'
    );
    expect(after.rows).toEqual(before.rows);
    await expectNoChange();
  });

  it('rejects PATCH before updating any fields', async () => {
    await request(app)
      .patch(`/api/projects/${projectId}`)
      .send({ name: 'Must not change', folderPath: big, fileIndexingEnabled: true })
      .expect(409);
    await expectNoChange();
  });

  it('rejects PUT before clearing the existing index, linking, or writing config', async () => {
    await request(app)
      .put(`/api/projects/${projectId}/folder-path`)
      .send({ folderPath: big, clearPreviousIndex: true })
      .expect(409);
    await expectNoChange();
  });

  it('blocks a confirmed folder change while backfill is active', async () => {
    expect(tryBeginExclusiveOp(projectId, 'backfill')).toBe(true);
    try {
      const response = await request(app)
        .put(`/api/projects/${projectId}/folder-path`)
        .send({ folderPath: candidate, confirmFolderLink: true, clearPreviousIndex: true })
        .expect(409);
      expect(JSON.stringify(response.body)).toContain('active indexing operation');
      await expectNoChange();
    } finally {
      endExclusiveOp(projectId);
    }
  });

  it.each(['patch', 'put'] as const)(
    'blocks %s unlink while backfill is active',
    async (method) => {
      expect(tryBeginExclusiveOp(projectId, 'backfill')).toBe(true);
      try {
        const url = `/api/projects/${projectId}${method === 'put' ? '/folder-path' : ''}`;
        await request(app)[method](url).send({ folderPath: null }).expect(409);
        await expectNoChange();
      } finally {
        endExclusiveOp(projectId);
      }
    }
  );

  it.each([false, true])(
    'persists a confirmed repoint and only purges when clearPreviousIndex is %s',
    async (clearPreviousIndex) => {
      await request(app)
        .put(`/api/projects/${projectId}/folder-path`)
        .send({ folderPath: candidate, confirmFolderLink: true, clearPreviousIndex })
        .expect(200);
      expect(await Projects.findById(projectId)).toMatchObject({ folderPath: candidate });
      expect(mockEnsureWatchConfig).toHaveBeenCalledWith(candidate, projectId);
      expect(mockLinkFolder).toHaveBeenCalledWith(projectId, candidate);
      expect(mockFolderChanged).toHaveBeenCalledWith(projectId);
      if (clearPreviousIndex) {
        expect(mockPurge).toHaveBeenCalledWith(projectId, expect.anything());
        expect(mockPurge.mock.invocationCallOrder[0]).toBeLessThan(
          mockLinkFolder.mock.invocationCallOrder[0]
        );
      } else {
        expect(mockPurge).not.toHaveBeenCalled();
      }
      expect(mockUnlinkFolder).not.toHaveBeenCalled();
    }
  );

  it('accepts a safe small folder on create without explicit confirmation', async () => {
    await mkdir(path.join(candidate, '.git'));
    const response = await request(app)
      .post('/api/projects')
      .send({ name: 'Safe project', folderPath: candidate })
      .expect(201);
    expect(response.body.data).toMatchObject({ name: 'Safe project', folderPath: candidate });
    expect(await Projects.findById(response.body.data.id)).toMatchObject({ folderPath: candidate });
  });

  it('blocks risky tool creation before allocating a node', async () => {
    const before = await getDb().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.nodes'
    );
    await expect(
      createContainer(
        { name: 'Unsafe tool project', category: 'project', folder_path: big } as never,
        {},
        {} as never
      )
    ).rejects.toThrow(/needs confirmation/);
    const after = await getDb().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.nodes'
    );
    expect(after.rows).toEqual(before.rows);
    await expectNoChange();
  });

  it('blocks risky tool updates before applying accompanying metadata', async () => {
    await expect(
      updateContainer(
        {
          container_id: projectId,
          folder_path: big,
          description: 'Must not change',
        } as never,
        {},
        {} as never
      )
    ).rejects.toThrow(/needs confirmation/);
    expect((await Containers.findById(projectId))?.description).not.toBe('Must not change');
    await expectNoChange();
  });
});
