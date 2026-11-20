import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, rename, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findProjectFolderByMarker } from '@server/services/projectFolderIdentity';

describe('project marker discovery', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'snaglet-marker-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function marker(folder: string, id = 'container-test') {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'snaglet.config.json'), JSON.stringify({ projectId: id }));
  }

  it('finds a renamed folder', async () => {
    await marker(path.join(root, 'original'));
    const moved = path.join(root, 'renamed');
    await rename(path.join(root, 'original'), moved);
    expect(await findProjectFolderByMarker('container-test', [root])).toEqual({
      status: 'found',
      path: moved,
    });
  });
  it('finds a folder moved between parents', async () => {
    await marker(path.join(root, 'first', 'project'));
    await mkdir(path.join(root, 'second'));
    const moved = path.join(root, 'second', 'project');
    await rename(path.join(root, 'first', 'project'), moved);
    expect(await findProjectFolderByMarker('container-test', [root])).toEqual({
      status: 'found',
      path: moved,
    });
  });
  it('reports an unfound folder', async () => {
    expect(await findProjectFolderByMarker('container-test', [root])).toEqual({
      status: 'missing',
    });
  });
  it('never chooses between duplicate markers', async () => {
    await marker(path.join(root, 'first'));
    await marker(path.join(root, 'copy'));
    expect(await findProjectFolderByMarker('container-test', [root])).toEqual({
      status: 'ambiguous',
    });
  });
  it('deduplicates overlapping roots', async () => {
    const folder = path.join(root, 'project');
    await marker(folder);
    expect(await findProjectFolderByMarker('container-test', [root, folder])).toEqual({
      status: 'found',
      path: folder,
    });
  });
  it('ignores mismatched and malformed markers', async () => {
    await marker(path.join(root, 'other'), 'container-other');
    await writeFile(path.join(root, 'snaglet.config.json'), '{broken');
    expect(await findProjectFolderByMarker('container-test', [root])).toEqual({
      status: 'missing',
    });
  });
  it('does not descend past depth three', async () => {
    await marker(path.join(root, 'a', 'b', 'c', 'd'));
    expect(await findProjectFolderByMarker('container-test', [root])).toEqual({
      status: 'missing',
    });
  });
  it('does not follow directory symlinks or dependency trees', async () => {
    await marker(path.join(root, '.hidden'));
    await symlink(path.join(root, '.hidden'), path.join(root, 'alias'));
    await marker(path.join(root, 'node_modules', 'project'));
    expect(await findProjectFolderByMarker('container-test', [root])).toEqual({
      status: 'missing',
    });
  });
});
