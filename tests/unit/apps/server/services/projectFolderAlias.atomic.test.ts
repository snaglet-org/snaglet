import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readlink, rm } from 'node:fs/promises';
import type { NodeRunner } from '@snaglet/db/tables/nodes';

let mockAliasRoot = '';
const mockFind = jest.fn();
const mockList = jest.fn();
const mockLock = jest.fn();
jest.mock('@server/services/snagletHome', () => ({
  get SNAGLET_PROJECTS_DIR() {
    return mockAliasRoot;
  },
}));
jest.mock('@snaglet/db/tables/projects', () => ({
  Projects: {
    findById: mockFind,
    listAll: mockList,
    withFolderWriteLock: mockLock,
  },
}));
import {
  reconcileProjectFolderSymlinks,
  refreshProjectFolderAlias,
} from '@server/services/projectFolder';

describe('alias refresh serialization', () => {
  let root: string;
  let folder: string;
  const tx: NodeRunner = { query: jest.fn() };
  beforeEach(async () => {
    jest.clearAllMocks();
    root = await mkdtemp(path.join(os.tmpdir(), 'snaglet-alias-atomic-'));
    mockAliasRoot = path.join(root, 'aliases');
    folder = path.join(root, 'current');
    await mkdir(folder);
    mockLock.mockImplementation(async (fn: (runner: NodeRunner) => Promise<unknown>) => fn(tx));
    mockFind.mockResolvedValue({ id: 'container-test', folderPath: folder, archived: false });
    mockList.mockResolvedValue([{ id: 'container-test', folderPath: folder, archived: false }]);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('search refresh uses the latest persisted folder read under the lock', async () => {
    await refreshProjectFolderAlias('container-test');
    expect(mockFind).toHaveBeenCalledWith('container-test', tx);
    expect(await readlink(path.join(mockAliasRoot, 'container-test'))).toBe(folder);
  });

  it('bootstrap rebuilds aliases from a fresh locked snapshot', async () => {
    await reconcileProjectFolderSymlinks();
    expect(mockList).toHaveBeenCalledWith(tx);
    expect(await readlink(path.join(mockAliasRoot, 'container-test'))).toBe(folder);
  });

  it('search refresh removes a stale alias if the folder was cleared', async () => {
    await refreshProjectFolderAlias('container-test');
    mockFind.mockResolvedValue({ id: 'container-test', folderPath: null, archived: false });
    await refreshProjectFolderAlias('container-test');
    await expect(readlink(path.join(mockAliasRoot, 'container-test'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
