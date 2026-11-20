import { describe, it, expect } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

import findFilesTool from '@server/services/ToolService/handlers/files/findFiles';
import { listFilesByGlob } from '@server/services/ToolService/lib/listFilesByGlob';

interface FindFilesResponse {
  basePath: string;
  count: number;
  truncated: boolean;
  files: unknown;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-find-files-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seed(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'registry.ts'), 'export {};');
  await writeFile(path.join(dir, 'src', 'tool.ts'), 'export {};');
  await writeFile(path.join(dir, 'README.md'), '# readme');
}

async function callFindFiles(input: Record<string, unknown>): Promise<FindFilesResponse> {
  const raw = await findFilesTool(input, {});
  return JSON.parse(raw as string) as FindFilesResponse;
}

describe('find_files locator', () => {
  it('returns matching paths filtered by glob', async () => {
    await withTempDir(async (dir) => {
      await seed(dir);
      const out = await callFindFiles({ path: dir, glob: '**/*.ts' });
      const files = out.files as string[];
      expect(files).toContain(path.join(dir, 'src', 'registry.ts'));
      expect(files).toContain(path.join(dir, 'src', 'tool.ts'));
      expect(files).not.toContain(path.join(dir, 'README.md'));
    });
  });

  it('passes a spaced Unicode path to ripgrep as one argv value', async () => {
    await withTempDir(async (dir) => {
      const searchPath = path.join(dir, 'folder with space café');
      await seed(searchPath);

      const out = await callFindFiles({ path: searchPath, glob: '**/*.ts' });

      expect(out.files).toContain(path.join(searchPath, 'src', 'registry.ts'));
    });
  });

  it('narrows by nameContains substring (case-insensitive)', async () => {
    await withTempDir(async (dir) => {
      await seed(dir);
      const out = await callFindFiles({ path: dir, nameContains: 'REGISTRY' });
      const files = out.files as string[];
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(path.join(dir, 'src', 'registry.ts'));
    });
  });

  it('returns plain string paths — no score or semantic matchedOn fields', async () => {
    await withTempDir(async (dir) => {
      await seed(dir);
      const out = await callFindFiles({ path: dir, glob: '**/*.ts' });
      const files = out.files as unknown[];
      expect(files.length).toBeGreaterThan(0);
      for (const entry of files) {
        // Locator output is a bare path string, never a tagged result object.
        expect(typeof entry).toBe('string');
      }
      expect(JSON.stringify(out)).not.toContain('matchedOn');
      expect(JSON.stringify(out)).not.toContain('"score"');
    });
  });

  it('ignores a stray `query` param — it is a deterministic locator, not a searcher', async () => {
    await withTempDir(async (dir) => {
      await seed(dir);
      const withQuery = await callFindFiles({ path: dir, glob: '**/*.ts', query: 'anything here' });
      const withoutQuery = await callFindFiles({ path: dir, glob: '**/*.ts' });
      // query has no effect on output: same files, same shape, no semantic tagging.
      expect(withQuery.files).toEqual(withoutQuery.files);
      expect(JSON.stringify(withQuery)).not.toContain('semantic');
      expect(JSON.stringify(withQuery)).not.toContain('keyword');
    });
  });

  it('caps results at maxResults and flags truncation', async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, 'many'), { recursive: true });
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          writeFile(path.join(dir, 'many', `f-${i}.ts`), 'export {};')
        )
      );
      const out = await callFindFiles({ path: dir, glob: '**/*.ts', maxResults: 3 });
      expect((out.files as string[]).length).toBe(3);
      expect(out.count).toBe(3);
      expect(out.truncated).toBe(true);
    });
  });

  it('uses the ignore-aware fallback when ripgrep is unavailable', async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, 'node_modules'), { recursive: true });
      await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
      await writeFile(path.join(dir, '.hidden.ts'), 'export {};');
      await writeFile(path.join(dir, 'node_modules', 'dependency.ts'), 'export {};');
      await writeFile(path.join(dir, 'visible.ts'), 'export {};');

      const files = await listFilesByGlob(dir, '**/*.ts', { executable: '__snaglet_missing_rg__' });

      expect(files).toEqual([path.join(dir, 'visible.ts')]);
    });
  });

  it('lets a nested ignore rule re-include its matching file in the fallback', async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, 'generated'), { recursive: true });
      await writeFile(path.join(dir, '.gitignore'), 'generated/*.ts\n');
      await writeFile(path.join(dir, 'generated', '.gitignore'), '!keep.ts\n');
      await writeFile(path.join(dir, 'generated', 'keep.ts'), 'export const keep = true;');
      await writeFile(path.join(dir, 'generated', 'drop.ts'), 'export const drop = true;');

      const files = await listFilesByGlob(dir, '**/*.ts', { executable: '__snaglet_missing_rg__' });

      expect(files).toEqual([path.join(dir, 'generated', 'keep.ts')]);
    });
  });

  it('applies an ancestor ignore file when the fallback starts in a subdirectory', async () => {
    await withTempDir(async (dir) => {
      const dependencies = path.join(dir, 'node_modules');
      await mkdir(dependencies, { recursive: true });
      await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
      await writeFile(path.join(dependencies, 'dependency.ts'), 'export {};');

      const files = await listFilesByGlob(dependencies, '**/*.ts', {
        executable: '__snaglet_missing_rg__',
      });

      expect(files).toEqual([]);
    });
  });

  it('reports fallback enumeration exhaustion instead of returning a partial list', async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, 'a.ts'), 'export {};');
      await writeFile(path.join(dir, 'b.ts'), 'export {};');
      await writeFile(path.join(dir, 'c.ts'), 'export {};');

      await expect(
        listFilesByGlob(dir, '**/*.ts', {
          executable: '__snaglet_missing_rg__',
          fallbackEntryLimit: 2,
        })
      ).rejects.toThrow('Narrow the search path and retry');
    });
  });
});
