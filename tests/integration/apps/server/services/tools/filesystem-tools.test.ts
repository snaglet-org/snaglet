import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import pathResolveTool from '@server/services/ToolService/handlers/trivial/filesystemResolvePath';
import findFilesTool from '@server/services/ToolService/handlers/files/findFiles';
import repoTreeTool from '@server/services/ToolService/handlers/files/repoTree';

const hasRg = (() => {
  try {
    execSync('rg --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('filesystem and log tool behavior', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-filesystem-tools-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('path-resolve resolves a relative path against basePath', async () => {
    const nestedDir = path.join(tmpDir, 'nested');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(path.join(nestedDir, 'note.txt'), 'hello\n', 'utf8');

    const result = await pathResolveTool({ path: 'note.txt', basePath: nestedDir }, {});
    const parsed = JSON.parse(result) as {
      absolutePath: string;
      exists: boolean;
      kind: string;
      parentDirectory: string;
    };

    expect(parsed.absolutePath).toBe(path.join(nestedDir, 'note.txt'));
    expect(parsed.exists).toBe(true);
    expect(parsed.kind).toBe('file');
    expect(parsed.parentDirectory).toBe(nestedDir);
  });

  it('path-resolve rejects missing path input', async () => {
    await expect(pathResolveTool({}, {})).rejects.toThrow('Missing required parameter: path');
  });

  (hasRg ? it : it.skip)('find-files returns absolute paths and supports filtering', async () => {
    const searchDir = path.join(tmpDir, 'search');
    await mkdir(path.join(searchDir, 'src'), { recursive: true });
    await writeFile(path.join(searchDir, 'src', 'match-tool.ts'), 'export {};\n', 'utf8');
    await writeFile(path.join(searchDir, 'src', 'ignore.txt'), 'ignore\n', 'utf8');

    const result = await findFilesTool(
      {
        path: searchDir,
        glob: '**/*.ts',
        nameContains: 'match-tool',
        maxResults: 20,
      },
      {}
    );
    const parsed = JSON.parse(result) as { count: number; files: string[] };

    expect(parsed.count).toBe(1);
    expect(parsed.files).toEqual([path.join(searchDir, 'src', 'match-tool.ts')]);
  });

  (hasRg ? it : it.skip)(
    'find-files without query preserves the legacy file list shape',
    async () => {
      const searchDir = path.join(tmpDir, 'legacy');
      await mkdir(path.join(searchDir, 'src'), { recursive: true });
      await writeFile(path.join(searchDir, 'src', 'match-tool.ts'), 'export {};\n', 'utf8');

      const result = await findFilesTool({ path: searchDir, glob: '**/*.ts', maxResults: 20 }, {});
      const parsed = JSON.parse(result) as { files: unknown[] };

      expect(parsed.files).toEqual([path.join(searchDir, 'src', 'match-tool.ts')]);
    }
  );

  (hasRg ? it : it.skip)(
    'find-files matches names only — file contents never influence results',
    async () => {
      // find_files is a deterministic name/glob locator (content search lives
      // in code_search, meaning search in semantic_file_search): a file whose
      // content matches but whose name does not must not surface.
      const searchDir = path.join(tmpDir, 'keyword');
      await mkdir(path.join(searchDir, 'src'), { recursive: true });
      await writeFile(path.join(searchDir, 'src', 'payment-router.ts'), 'export {};\n', 'utf8');
      await writeFile(path.join(searchDir, 'src', 'content-only.ts'), 'payment router\n', 'utf8');

      const result = await findFilesTool(
        { path: searchDir, nameContains: 'payment', maxResults: 20 },
        {}
      );
      const parsed = JSON.parse(result) as { files: string[] };

      expect(parsed.files).toEqual([path.join(searchDir, 'src', 'payment-router.ts')]);
    }
  );

  it('repo-tree renders a tree for the provided directory', async () => {
    await mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await writeFile(path.join(tmpDir, 'src', 'index.ts'), 'export {};\n', 'utf8');

    const result = await repoTreeTool({ path: tmpDir, depth: 2, maxEntries: 30 }, {});

    expect(result).toContain(`${tmpDir}/`);
    expect(result).toContain('src/');
    expect(result).toContain('index.ts');
  });
});
