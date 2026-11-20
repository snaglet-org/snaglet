import path from 'node:path';
import os from 'node:os';
import { realpath, mkdtemp, mkdir, writeFile, readdir, rm, symlink } from 'node:fs/promises';

const mockListAll = jest.fn();
jest.mock('@snaglet/db', () => ({ Projects: { listAll: mockListAll } }));

import {
  inspectProjectFolder,
  validateProjectFolderChange,
} from '@server/services/projectFolderImpact';

describe('project folder impact with real filesystem candidates', () => {
  let root: string;
  beforeEach(async () => {
    mockListAll.mockResolvedValue([]);
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-folder-impact-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts a small repository without creating an indexing config', async () => {
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, 'hello.ts'), 'export {};');
    const before = await readdir(root);
    const impact = await validateProjectFolderChange(root);
    expect(impact).toMatchObject({ eligibleFiles: 1, requiresConfirmation: false });
    expect(await readdir(root)).toEqual(before);
    expect(await readdir(root)).not.toContain('snaglet.config.json');
  });

  it('warns without a repository marker but does not block, and stays read-only', async () => {
    await writeFile(path.join(root, 'note.md'), 'Hello');
    const impact = await validateProjectFolderChange(root);
    expect(impact).toMatchObject({ requiresConfirmation: false });
    expect(impact.warnings.join(' ')).toMatch(/No repository marker/);
    expect(await readdir(root)).toEqual(['note.md']);
  });

  it('requires confirmation above 500 eligible files, but not at 500', async () => {
    await mkdir(path.join(root, '.git'));
    await Promise.all(
      Array.from({ length: 500 }, (_, i) => writeFile(path.join(root, `${i}.ts`), 'x'))
    );
    await expect(validateProjectFolderChange(root)).resolves.toMatchObject({
      eligibleFiles: 500,
      requiresConfirmation: false,
    });
    await writeFile(path.join(root, 'extra.ts'), 'x');
    await expect(validateProjectFolderChange(root)).rejects.toThrow(/501 eligible files/);
    expect(await readdir(root)).not.toContain('snaglet.config.json');
  });

  it('identifies immediate repositories without following symlinked children', async () => {
    await mkdir(path.join(root, '.git'));
    for (const name of ['one', 'two'])
      await mkdir(path.join(root, name, '.git'), { recursive: true });
    await symlink(path.join(root, 'one'), path.join(root, 'linked'));
    const impact = await inspectProjectFolder(root);
    expect(impact.childRepositories.sort()).toEqual(['one', 'two']);
    const linked = await validateProjectFolderChange(root);
    expect(linked.requiresConfirmation).toBe(false);
    expect(linked.warnings.join(' ')).toMatch(/folder of repositories/);
  });

  it('warns about an ancestor of another active project, excluding self and archived projects', async () => {
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, 'child'));
    mockListAll.mockResolvedValue([
      { id: 'other', folderPath: path.join(root, 'child'), archived: false },
    ]);
    const nested = await validateProjectFolderChange(root, 'self');
    expect(nested.requiresConfirmation).toBe(false);
    expect(nested.warnings.join(' ')).toMatch(/contains folders linked/);
    expect((await validateProjectFolderChange(root, 'other')).warnings).toEqual([]);
    mockListAll.mockResolvedValue([
      { id: 'other', folderPath: path.join(root, 'child'), archived: true },
    ]);
    expect((await validateProjectFolderChange(root, 'self')).warnings).toEqual([]);
  });

  it('detects ancestors through symlink aliases and recognizes an unchanged aliased folder', async () => {
    const repository = path.join(root, 'repository');
    const alias = path.join(root, 'alias');
    const childAlias = path.join(root, 'child-alias');
    await mkdir(path.join(repository, '.git'), { recursive: true });
    await mkdir(path.join(repository, 'child'));
    await symlink(repository, alias);
    await symlink(path.join(repository, 'child'), childAlias);
    mockListAll.mockResolvedValue([{ id: 'other', folderPath: childAlias, archived: false }]);
    expect((await validateProjectFolderChange(alias, 'self')).warnings.join(' ')).toMatch(
      /contains folders linked/
    );
    mockListAll.mockResolvedValue([]);
    await expect(validateProjectFolderChange(repository, 'self', alias)).resolves.toMatchObject({
      folderPath: repository,
      replacingFolder: false,
      requiresConfirmation: false,
    });
  });

  it('lets a small folder replace an existing one without confirmation', async () => {
    await mkdir(path.join(root, '.git'));
    await expect(
      validateProjectFolderChange(root, 'self', path.join(root, 'previous'))
    ).resolves.toMatchObject({ replacingFolder: true, requiresConfirmation: false });
    await expect(validateProjectFolderChange(root, 'self', root)).resolves.toMatchObject({
      replacingFolder: false,
    });
  });
});
