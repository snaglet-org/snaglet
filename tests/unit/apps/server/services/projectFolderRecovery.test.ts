import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import type { ProjectRow } from '@snaglet/db/tables/projects';

const mockFind = jest.fn();
const mockUpdate = jest.fn();
const mockList = jest.fn();
const mockWarn = jest.fn();
const mockLink = jest.fn();
const mockIdle = jest.fn();
const mockNotify = jest.fn();
const mockEmit = jest.fn();
jest.mock('@snaglet/db/tables/projects', () => ({
  Projects: {
    findById: mockFind,
    update: mockUpdate,
    listAll: mockList,
    withFolderWriteLock: async (fn: (tx: undefined) => Promise<unknown>) => fn(undefined),
  },
}));
jest.mock('@server/config/logger', () => ({ logger: { warn: mockWarn, info: jest.fn() } }));
jest.mock('@server/services/projectFolder', () => ({ linkProjectFolder: mockLink }));
jest.mock('@server/services/projectFolderImpact', () => ({ assertProjectFolderIdle: mockIdle }));
jest.mock('@server/services/NotificationService', () => ({
  notificationService: { create: mockNotify },
}));
jest.mock('@server/realtime/surfaces/tree', () => ({ emitTreeNodeUpdated: mockEmit }));

import {
  recoverProjectFolder,
  unavailableNativeFolderResolver,
} from '@server/services/projectFolderRecovery';

const projectId = 'container-1111111111111-aaaaaaaaa';
describe('project folder recovery (real disposable folders, mocked persistence)', () => {
  let root: string;
  let original: string;
  let moved: string;
  let project: ProjectRow;
  beforeEach(async () => {
    jest.clearAllMocks();
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-recovery-')));
    original = path.join(root, 'original');
    moved = path.join(root, 'moved');
    await mkdir(original);
    await writeFile(
      path.join(original, 'snaglet.config.json'),
      JSON.stringify({
        projectId,
        embeddings: { enabled: false },
        custom: 'kept',
      })
    );
    await writeFile(path.join(original, 'file.txt'), 'stable file contents');
    project = {
      id: projectId,
      containerId: projectId,
      name: 'Test Project',
      githubUrl: null,
      folderPath: original,
      description: null,
      archived: false,
      fileIndexingEnabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    mockFind.mockImplementation(async () => project);
    mockList.mockImplementation(async () => [project]);
    mockUpdate.mockImplementation(async (_id: string, update: Partial<ProjectRow>) => {
      project = { ...project, ...update };
      return project;
    });
    mockIdle.mockImplementation(() => undefined);
    mockLink.mockResolvedValue('test-alias');
    mockNotify.mockResolvedValue(null);
    await recoverProjectFolder(projectId); // Reset episode deduplication.
    jest.clearAllMocks();
    await rename(original, moved);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('treats an unlinked project as not needing recovery, not a concurrent change', async () => {
    project.folderPath = null;
    expect(await recoverProjectFolder(projectId)).toEqual({ status: 'unlinked' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('uses marker fallback with native unavailable, preserving opt-outs and file contents', async () => {
    const beforeApply = jest.fn(async () => undefined);
    const configBefore = await readFile(path.join(moved, 'snaglet.config.json'), 'utf8');
    expect(await unavailableNativeFolderResolver.resolve(projectId)).toEqual({
      status: 'unavailable',
    });
    const result = await recoverProjectFolder(projectId, { roots: [root], beforeApply });
    expect(result.status).toBe('recovered');
    expect(mockUpdate).toHaveBeenCalledWith(projectId, { folderPath: moved }, undefined);
    expect(mockLink).toHaveBeenCalledWith(projectId, moved);
    expect(beforeApply).toHaveBeenCalledWith(projectId);
    expect(project.fileIndexingEnabled).toBe(false);
    expect(await readFile(path.join(moved, 'snaglet.config.json'), 'utf8')).toBe(configBefore);
    expect(await readFile(path.join(moved, 'file.txt'), 'utf8')).toBe('stable file contents');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ id: projectId, kind: 'container' })
    );
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'app_update', body: `${original} → ${moved}` })
    );
  });

  it('does not guess between duplicate markers', async () => {
    const duplicate = path.join(root, 'duplicate');
    await mkdir(duplicate);
    await writeFile(path.join(duplicate, 'snaglet.config.json'), JSON.stringify({ projectId }));
    expect(await recoverProjectFolder(projectId, { roots: [root] })).toEqual({
      status: 'ambiguous',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
  });

  it('retains a missing folder with no candidate', async () => {
    await rm(moved, { recursive: true });
    expect(await recoverProjectFolder(projectId, { roots: [root] })).toEqual({ status: 'missing' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it.each(['{"projectId":"other"}', '{bad', '{}'])(
    'rejects unverified manual Locate (%s)',
    async (config) => {
      await writeFile(path.join(moved, 'snaglet.config.json'), config);
      expect(await recoverProjectFolder(projectId, { candidate: moved })).toEqual({
        status: 'unverified',
      });
      expect(mockLink).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    }
  );

  it('busy recovery defers without repointing or updating, then succeeds on retry', async () => {
    mockIdle.mockImplementation(() => {
      throw new Error('busy');
    });
    expect(await recoverProjectFolder(projectId, { roots: [root] })).toEqual({ status: 'busy' });
    expect(mockLink).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    mockIdle.mockImplementation(() => undefined);
    expect((await recoverProjectFolder(projectId, { roots: [root] })).status).toBe('recovered');
  });

  it('does not commit a new path when the alias cannot be repointed', async () => {
    mockLink.mockRejectedValueOnce(new Error('alias occupied'));
    expect(await recoverProjectFolder(projectId, { roots: [root] })).toEqual({ status: 'failed' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Test Project folder missing' })
    );
  });

  it('rechecks concurrent relinks after watcher shutdown', async () => {
    const manual = path.join(root, 'manual');
    const beforeApply = async () => {
      project = { ...project, folderPath: manual };
    };
    expect(await recoverProjectFolder(projectId, { roots: [root], beforeApply })).toEqual({
      status: 'changed',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
  });

  it.each([null, '{bad', '[]', '{"projectId":"other"}'])(
    'rejects native candidates without valid unclaimed or matching config (%s)',
    async (config) => {
      if (config === null) await rm(path.join(moved, 'snaglet.config.json'));
      else await writeFile(path.join(moved, 'snaglet.config.json'), config);
      const nativeResolver = { resolve: async () => ({ status: 'found' as const, path: moved }) };
      expect(await recoverProjectFolder(projectId, { nativeResolver })).toEqual({
        status: 'unverified',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockLink).not.toHaveBeenCalled();
    }
  );

  it('accepts proven native identity with valid unclaimed config', async () => {
    await writeFile(path.join(moved, 'snaglet.config.json'), '{"embeddings":{"enabled":false}}');
    const nativeResolver = { resolve: async () => ({ status: 'found' as const, path: moved }) };
    expect((await recoverProjectFolder(projectId, { nativeResolver })).status).toBe('recovered');
  });

  it.each(['same', 'inside', 'contains'])('rejects ownership overlap (%s)', async (relation) => {
    const otherRoot =
      relation === 'same' ? moved : relation === 'inside' ? root : path.join(moved, 'child');
    if (relation === 'contains') await mkdir(otherRoot);
    mockList.mockImplementation(async () => [
      project,
      { ...project, id: 'other', folderPath: otherRoot },
    ]);
    expect(await recoverProjectFolder(projectId, { candidate: moved })).toEqual({
      status: 'unverified',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
  });

  it('ignores archived project overlaps', async () => {
    mockList.mockImplementation(async () => [
      project,
      { ...project, id: 'other', folderPath: moved, archived: true },
    ]);
    expect((await recoverProjectFolder(projectId, { candidate: moved })).status).toBe('recovered');
  });

  it('logs each unresolved status only once until recovery succeeds', async () => {
    // A present result clears deduplication retained from earlier tests.
    await rename(moved, original);
    await recoverProjectFolder(projectId);
    await rename(original, moved);
    await rm(moved, { recursive: true });
    await recoverProjectFolder(projectId, { roots: [root] });
    await recoverProjectFolder(projectId, { roots: [root] });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('missing'));
  });

  it('notifies once per missing episode and retries failed delivery without changing the index', async () => {
    await rm(moved, { recursive: true });
    mockNotify.mockRejectedValueOnce(new Error('notice unavailable'));
    await recoverProjectFolder(projectId, { roots: [root] });
    await recoverProjectFolder(projectId, { roots: [root] });
    await recoverProjectFolder(projectId, { roots: [root] });
    expect(mockNotify).toHaveBeenCalledTimes(2);
    expect(mockNotify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Test Project folder missing',
        body: expect.stringContaining('Your file index is kept'),
      })
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
    await mkdir(original);
    await recoverProjectFolder(projectId);
    await rm(original, { recursive: true });
    await recoverProjectFolder(projectId, { roots: [root] });
    expect(mockNotify).toHaveBeenCalledTimes(3);
  });

  it('rolls back the alias if persistence fails', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('write failed'));
    expect(await recoverProjectFolder(projectId, { roots: [root] })).toEqual({ status: 'failed' });
    expect(mockLink).toHaveBeenLastCalledWith(projectId, original);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Test Project folder missing' })
    );
  });
});
