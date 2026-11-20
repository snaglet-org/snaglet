import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { grepFileFallback } from '@server/services/ToolService/lib/grepFileFallback';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'snaglet-grep-fallback-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('grepFileFallback', () => {
  it('finds content and path matches in deterministic lexical order', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'zeta.ts'), 'const needle = true;\n');
    await writeFile(path.join(root, 'alpha.ts'), 'const needle = true;\n');
    await writeFile(path.join(root, 'needle-name.ts'), 'nothing relevant here\n');

    const result = await grepFileFallback({
      projectRoot: root,
      searchPath: root,
      query: 'needle',
      limit: 10,
    });

    expect(result.unavailableReason).toBeUndefined();
    expect(result.hits.map((hit) => hit.relativePath)).toEqual([
      'alpha.ts',
      'zeta.ts',
      'needle-name.ts',
    ]);
    expect(result.hits.map((hit) => hit.matchSource)).toEqual(['content', 'content', 'path']);
    expect(result.hits[0]).toMatchObject({ matchedOn: 'grep', indexed: false, line: 1 });
  });

  it('honors base exclusions and compiled snaglet.config ignore rules', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await mkdir(path.join(root, 'vendor'), { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(
      path.join(root, 'snaglet.config.json'),
      JSON.stringify({ embeddings: { enabled: true, ignorePaths: ['vendor'] } })
    );
    await writeFile(path.join(root, 'node_modules', 'hidden.ts'), 'needle');
    await writeFile(path.join(root, 'vendor', 'hidden.ts'), 'needle');
    await writeFile(path.join(root, 'src', 'visible.ts'), 'needle');

    const result = await grepFileFallback({
      projectRoot: root,
      searchPath: root,
      query: 'needle',
      limit: 10,
    });

    expect(result.hits.map((hit) => hit.relativePath)).toEqual(['src/visible.ts']);
  });

  it('does not let over-budget content affect matching but retains an explicit path hit', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'needle-path.ts'), 'needle appears in over-budget content');

    const result = await grepFileFallback({
      projectRoot: root,
      searchPath: root,
      query: 'needle',
      limit: 10,
      maxBytes: 4,
    });

    expect(result.truncated).toBe(true);
    expect(result.scannedBytes).toBe(0);
    expect(result.hits).toEqual([
      expect.objectContaining({ relativePath: 'needle-path.ts', matchSource: 'path' }),
    ]);
    expect(result.hits[0]?.line).toBeUndefined();
  });

  it('drops an over-budget content-only match', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'plain.ts'), 'needle appears after the byte budget');

    const result = await grepFileFallback({
      projectRoot: root,
      searchPath: root,
      query: 'needle',
      limit: 10,
      maxBytes: 4,
    });

    expect(result.hits).toEqual([]);
    expect(result.scannedBytes).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it('caps matches and traverses lexical paths deterministically', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'z.ts'), 'needle');
    await writeFile(path.join(root, 'a.ts'), 'needle');

    const result = await grepFileFallback({
      projectRoot: root,
      searchPath: root,
      query: 'needle',
      limit: 10,
      maxMatches: 1,
    });

    expect(result.hits.map((hit) => hit.relativePath)).toEqual(['a.ts']);
    expect(result.truncated).toBe(true);
  });

  it('reports empty and unavailable scopes explicitly', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'file.ts');
    await writeFile(file, 'needle');

    await expect(
      grepFileFallback({ projectRoot: root, searchPath: root, query: '   ', limit: 5 })
    ).resolves.toMatchObject({ hits: [], unavailableReason: 'empty-query' });
    await expect(
      grepFileFallback({
        projectRoot: path.join(root, 'missing'),
        searchPath: root,
        query: 'needle',
        limit: 5,
      })
    ).resolves.toMatchObject({ hits: [], unavailableReason: 'project-folder-unavailable' });
    await expect(
      grepFileFallback({ projectRoot: root, searchPath: file, query: 'needle', limit: 5 })
    ).resolves.toMatchObject({ hits: [], unavailableReason: 'search-path-unavailable' });
  });

  it('skips symlink entries and rejects a search-path symlink escaping the project', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(path.join(outside, 'outside.ts'), 'needle');
    try {
      // Creating a file symlink needs a Windows capability that normal users
      // may not have. The directory junction below still verifies link safety.
      await symlink(path.join(outside, 'outside.ts'), path.join(root, 'linked-file.ts'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    await symlink(
      outside,
      path.join(root, 'linked-dir'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await writeFile(path.join(root, 'inside.ts'), 'needle');

    const result = await grepFileFallback({
      projectRoot: root,
      searchPath: root,
      query: 'needle',
      limit: 10,
    });
    expect(result.hits.map((hit) => hit.relativePath)).toEqual(['inside.ts']);

    await expect(
      grepFileFallback({
        projectRoot: root,
        searchPath: path.join(root, 'linked-dir'),
        query: 'needle',
        limit: 10,
      })
    ).resolves.toMatchObject({ hits: [], unavailableReason: 'outside-project' });
  });
});
