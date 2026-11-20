import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import type { NodeRunner } from '@snaglet/db/tables/nodes';

const mockFind = jest.fn();
const mockUpdate = jest.fn();
const mockList = jest.fn();
const mockLink = jest.fn();
const mockLock = jest.fn();
jest.mock('@snaglet/db/tables/projects', () => ({
  Projects: {
    findById: mockFind,
    update: mockUpdate,
    listAll: mockList,
    withFolderWriteLock: mockLock,
  },
}));
jest.mock('@server/config/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn() } }));
jest.mock('@server/services/projectFolder', () => ({ linkProjectFolder: mockLink }));
jest.mock('@server/services/projectFolderImpact', () => ({ assertProjectFolderIdle: jest.fn() }));
jest.mock('@server/services/NotificationService', () => ({
  notificationService: { create: jest.fn(async () => null) },
}));
jest.mock('@server/realtime/surfaces/tree', () => ({ emitTreeNodeUpdated: jest.fn() }));
import { recoverProjectFolder } from '@server/services/projectFolderRecovery';

function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('atomic recovery application', () => {
  let root: string;
  let candidate: string;
  let row: ProjectRow;
  let alias: string;
  const tx: NodeRunner = { query: jest.fn() };
  beforeEach(async () => {
    jest.clearAllMocks();
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-atomic-recovery-')));
    candidate = path.join(root, 'moved');
    await mkdir(candidate);
    row = {
      id: 'container-1111111111111-aaaaaaaaa',
      containerId: 'container-1111111111111-aaaaaaaaa',
      name: 'Test Project',
      folderPath: path.join(root, 'missing'),
      githubUrl: null,
      description: null,
      archived: false,
      fileIndexingEnabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    alias = row.folderPath ?? '';
    await writeFile(
      path.join(candidate, 'snaglet.config.json'),
      JSON.stringify({ projectId: row.id })
    );
    mockFind.mockImplementation(async () => row);
    mockList.mockImplementation(async () => [row]);
    mockUpdate.mockImplementation(
      async (_id: string, patch: Partial<ProjectRow>, runner: NodeRunner) => {
        expect(runner).toBe(tx);
        row = { ...row, ...patch };
        return row;
      }
    );
    mockLink.mockImplementation(async (_id: string, folder: string) => {
      alias = folder;
    });
    let tail = Promise.resolve();
    mockLock.mockImplementation((fn: (runner: NodeRunner) => Promise<unknown>) => {
      const result = tail.then(() => fn(tx));
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('holds serialization across watcher shutdown, alias repoint and persistence against a racing manual update', async () => {
    const entered = deferred();
    const resume = deferred();
    const recovery = recoverProjectFolder(row.id, {
      candidate,
      beforeApply: async () => {
        entered.release();
        await resume.promise;
      },
    });
    await entered.promise;
    const manualFolder = path.join(root, 'manual');
    const manual = mockLock(async (runner: NodeRunner) => {
      await mockUpdate(row.id, { folderPath: manualFolder }, runner);
      await mockLink(row.id, manualFolder);
    });
    await Promise.resolve();
    expect(mockUpdate).not.toHaveBeenCalled();
    resume.release();
    expect((await recovery).status).toBe('recovered');
    await manual;
    expect(row.folderPath).toBe(manualFolder);
    expect(alias).toBe(manualFolder);
    expect(mockList).toHaveBeenCalledWith(tx);
  });

  it('checks ownership inside the lock after a competing new folder link wins', async () => {
    const other = { ...row, id: 'container-2222222222222-bbbbbbbbb', folderPath: candidate };
    mockLock.mockImplementationOnce(async (fn: (runner: NodeRunner) => Promise<unknown>) => {
      mockList.mockResolvedValue([row, other]);
      return fn(tx);
    });
    expect(await recoverProjectFolder(row.id, { candidate })).toEqual({ status: 'unverified' });
    expect(mockList).toHaveBeenCalledWith(tx);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
  });

  it('does not overwrite a manual relink that won while discovery was in flight', async () => {
    const manualFolder = path.join(root, 'manual');
    mockLock.mockImplementationOnce(async (fn: (runner: NodeRunner) => Promise<unknown>) => {
      row = { ...row, folderPath: manualFolder };
      alias = manualFolder;
      return fn(tx);
    });
    expect(await recoverProjectFolder(row.id, { candidate })).toEqual({ status: 'changed' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(alias).toBe(manualFolder);
  });
});
