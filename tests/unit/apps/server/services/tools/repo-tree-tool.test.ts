import { describe, it, expect } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

import repoTreeTool from '@server/services/ToolService/handlers/files/repoTree';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-repo-tree-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('repo_tree tool smart mode', () => {
  it('keeps legacy depth behavior when smart is false', async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, 'a', 'b'), { recursive: true });
      await writeFile(path.join(dir, 'a', 'b', 'c.txt'), 'hello');
      await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');

      const output = await repoTreeTool({ path: dir, depth: 1 }, {});

      expect(output).toContain('a/');
      expect(output).toContain('node_modules/');
      expect(output).toContain('b/');
      expect(output).not.toContain('c.txt');
    });
  });

  it('auto-expands directories with fewer than 5 children in smart mode', async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, 'service', 'src'), { recursive: true });
      await writeFile(path.join(dir, 'service', 'src', 'index.ts'), 'export {};');

      const output = await repoTreeTool({ path: dir, depth: 1, smart: true }, {});

      expect(output).toContain('service/');
      expect(output).toContain('src/');
      expect(output).toContain('index.ts');
    });
  });

  it('collapses directories with more than 20 children and shows item count', async () => {
    await withTempDir(async (dir) => {
      const largeDir = path.join(dir, 'large');
      await mkdir(largeDir, { recursive: true });
      await Promise.all(
        Array.from({ length: 21 }, (_, i) =>
          writeFile(path.join(largeDir, `file-${String(i).padStart(2, '0')}.txt`), 'x')
        )
      );

      const output = await repoTreeTool({ path: dir, depth: 4, smart: true }, {});

      expect(output).toContain('large/ (21 items)');
      expect(output).not.toContain('file-00.txt');
    });
  });

  it('skips common non-code directories in smart mode', async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, 'node_modules', 'lib'), { recursive: true });
      await mkdir(path.join(dir, 'dist'), { recursive: true });
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'main.ts'), 'export {};');

      const output = await repoTreeTool({ path: dir, depth: 3, smart: true }, {});

      expect(output).toContain('src/');
      expect(output).toContain('main.ts');
      expect(output).not.toContain('node_modules/');
      expect(output).not.toContain('dist/');
    });
  });
});
