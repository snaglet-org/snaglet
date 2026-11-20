import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileIgnoreRules } from '@server/services/fileIndexing/exclusions';
import { scanProjectFiles } from '@server/services/fileIndexing/scan';

describe('scanProjectFiles', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'snaglet-index-impact-'));
    await Promise.all([
      mkdir(path.join(folder, 'src', 'generated'), { recursive: true }),
      mkdir(path.join(folder, 'docs'), { recursive: true }),
      mkdir(path.join(folder, 'tests'), { recursive: true }),
      mkdir(path.join(folder, 'node_modules', 'package'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(folder, 'src', 'index.ts'), 'export {};'),
      writeFile(path.join(folder, 'src', 'generated', 'client.ts'), 'generated'),
      writeFile(path.join(folder, 'docs', 'readme.md'), '# Readme'),
      writeFile(path.join(folder, 'tests', 'index.test.ts'), 'test'),
      writeFile(path.join(folder, 'node_modules', 'package', 'junk.js'), 'junk'),
    ]);
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('aborts its own traversal without disrupting a shared scan', async () => {
    const rules = compileIgnoreRules({});
    const sharedScan = scanProjectFiles(folder, rules);
    const controller = new AbortController();
    controller.abort();
    await expect(scanProjectFiles(folder, rules, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect((await sharedScan).paths.length).toBeGreaterThan(0);
  });

  it('counts eligible files while pruning ignored and non-included subtrees', async () => {
    const rules = compileIgnoreRules({
      includePaths: ['src', '**/*.md'],
      ignorePaths: ['**/generated'],
    });

    const scan = await scanProjectFiles(folder, rules);

    expect(scan.paths.sort()).toEqual([
      path.join('docs', 'readme.md'),
      path.join('src', 'index.ts'),
    ]);
    expect(scan.impact).toMatchObject({ eligibleFiles: 2, capped: false });
    expect(scan.impact.scannedEntries).toBeLessThan(12);
  });
  // An unreadable folder must never look empty.
  it('reports a folder it cannot list as unreadable and the walk as incomplete', async () => {
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const locked = path.join(folder, 'docs');
    await chmod(locked, 0o000);
    try {
      const scan = await scanProjectFiles(
        folder,
        compileIgnoreRules({}),
        new AbortController().signal
      );
      expect(scan.complete).toBe(false);
      expect(scan.unreadableDirs).toEqual([
        { path: 'docs', code: expect.stringMatching(/EACCES|EPERM/) },
      ]);
      expect(scan.paths).toContain(path.join('src', 'index.ts'));
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('a clean walk is complete and records the root identity', async () => {
    const scan = await scanProjectFiles(
      folder,
      compileIgnoreRules({}),
      new AbortController().signal
    );
    expect(scan.complete).toBe(true);
    expect(scan.unreadableDirs).toEqual([]);
    expect(scan.rootIdentity).toEqual({ dev: expect.any(Number), ino: expect.any(Number) });
  });

  it('a missing root is incomplete, never an empty-but-complete tree', async () => {
    const gone = `${folder}-moved`;
    await rename(folder, gone);
    try {
      const scan = await scanProjectFiles(
        folder,
        compileIgnoreRules({}),
        new AbortController().signal
      );
      expect(scan.paths).toEqual([]);
      expect(scan.complete).toBe(false);
      expect(scan.rootIdentity).toBeNull();
      expect(scan.unreadableDirs).toEqual([{ path: '', code: 'ENOENT' }]);
    } finally {
      await rename(gone, folder);
    }
  });
});
