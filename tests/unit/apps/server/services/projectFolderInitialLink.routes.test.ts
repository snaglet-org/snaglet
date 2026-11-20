import express from 'express';
import request from 'supertest';
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectRow } from '@snaglet/db/tables/projects';

const mockFind = jest.fn();
const mockList = jest.fn();
const mockUpdate = jest.fn();
const mockLink = jest.fn();
const mockChanged = jest.fn();
const mockRelocated = jest.fn();
const mockStop = jest.fn();
const mockEnsure = jest.fn();
jest.mock('@snaglet/db', () => ({
  Projects: {
    findById: mockFind,
    listAll: mockList,
    update: mockUpdate,
    withFolderWriteLock: async (fn: (tx: undefined) => Promise<unknown>) => fn(undefined),
  },
  Containers: {},
}));
jest.mock('@snaglet/db/tables/projects', () => ({
  Projects: {
    findById: mockFind,
    listAll: mockList,
    update: mockUpdate,
    withFolderWriteLock: async (fn: (tx: undefined) => Promise<unknown>) => fn(undefined),
  },
}));
jest.mock('@server/services/projectFolder', () => ({
  ...jest.requireActual<object>('@server/services/projectFolder'),
  linkProjectFolder: mockLink,
  unlinkProjectFolder: jest.fn(),
}));
jest.mock('@server/services/fileIndexing', () => ({
  ensureWatchConfig: mockEnsure,
  onProjectFolderChanged: mockChanged,
  onProjectFolderRelocated: mockRelocated,
  stopProjectFolderWatchers: mockStop,
}));
jest.mock('@server/services/fileIndexing/watcher', () => ({ purgeProjectIndex: jest.fn() }));
jest.mock('@server/services/NotificationService', () => ({
  notificationService: { create: jest.fn(async () => null) },
}));
jest.mock('@server/realtime/surfaces/tree', () => ({ emitTreeNodeUpdated: jest.fn() }));
import projectsRouter from '@server/domains/projects/projects.routes';
import { errorHandler } from '@server/middleware';

// Real recovery and folder validation, mocked persistence and background indexing.
describe('initial folder link versus recovery conflicts', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use(errorHandler);
  let root: string;
  let candidate: string;
  let row: ProjectRow;
  beforeEach(async () => {
    jest.clearAllMocks();
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-initial-link-')));
    candidate = path.join(root, 'candidate');
    await mkdir(path.join(candidate, '.git'), { recursive: true });
    row = {
      id: 'container-1111111111111-aaaaaaaaa',
      containerId: 'container-1111111111111-aaaaaaaaa',
      name: 'Test Project',
      folderPath: null,
      githubUrl: null,
      description: null,
      archived: false,
      fileIndexingEnabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    mockFind.mockImplementation(async () => row);
    mockList.mockImplementation(async () => [row]);
    mockUpdate.mockImplementation(async (_id: string, patch: Partial<ProjectRow>) => {
      row = { ...row, ...patch };
      return row;
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('links a project with no previous folder through the normal path', async () => {
    const response = await request(app)
      .put(`/api/projects/${row.id}/folder-path`)
      .send({ folderPath: candidate })
      .expect(200);
    expect(response.body.data.folderPath).toBe(candidate);
    expect(mockEnsure).toHaveBeenCalledWith(candidate, row.id);
    expect(mockLink).toHaveBeenCalledWith(row.id, candidate);
    expect(mockChanged).toHaveBeenCalledWith(row.id);
    expect(mockRelocated).not.toHaveBeenCalled();
  });

  it('still recovers a proven moved folder without normal replacement', async () => {
    const original = path.join(root, 'original');
    await rename(candidate, original);
    await writeFile(
      path.join(original, 'snaglet.config.json'),
      JSON.stringify({ projectId: row.id })
    );
    row.folderPath = original;
    await rename(original, candidate);
    await request(app)
      .put(`/api/projects/${row.id}/folder-path`)
      .send({ folderPath: candidate })
      .expect(200);
    expect(row.folderPath).toBe(candidate);
    expect(mockRelocated).toHaveBeenCalledWith(row.id);
    expect(mockChanged).not.toHaveBeenCalled();
  });

  it('still refuses a genuine concurrent change with 409', async () => {
    row.folderPath = path.join(root, 'missing');
    await writeFile(
      path.join(candidate, 'snaglet.config.json'),
      JSON.stringify({ projectId: row.id })
    );
    mockStop.mockImplementationOnce(async () => {
      row = { ...row, folderPath: root };
    });
    await request(app)
      .put(`/api/projects/${row.id}/folder-path`)
      .send({ folderPath: candidate })
      .expect(409);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockChanged).not.toHaveBeenCalled();
    expect(mockRelocated).not.toHaveBeenCalled();
  });
});
