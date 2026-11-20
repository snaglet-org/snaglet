/**
 * File-index data loss — end-to-end against the real database + filesystem
 * (per-file PostgreSQL clone, temp folders only).
 *
 *   - a reconcile that cannot read a folder keeps that folder's rows, and
 *     once the folder is readable again the same rows (same ids) are still
 *     there — nothing was deleted and re-created.
 *   - renaming the watched project folder while the real chokidar watcher
 *     runs leaves every row (and id) in place.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Containers, Projects, getDb } from '@snaglet/db';
import { Files } from '@snaglet/db/tables/files';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import { compileIgnoreRules } from '@server/services/fileIndexing/exclusions';
import { getProjectIndexingRuntime } from '@server/services/fileIndexing/projectIndexingStatus';
import { reconcileProject } from '@server/services/fileIndexing/reconcile';
import {
  isWatchingProject,
  startProjectWatcher,
  stopProjectWatcher,
} from '@server/services/fileIndexing/watcher';

const RUN = Date.now();
const rules = compileIgnoreRules({});
const tmpDirs: string[] = [];
const containerIds: string[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeProject(name: string, folderPath: string): Promise<ProjectRow> {
  const container = await Containers.create({ name: `${name}-c`, category: 'project' });
  containerIds.push(container.id);
  return Projects.create({ name, containerId: container.id, folderPath });
}

async function makeTree(root: string, files: string[]): Promise<void> {
  for (const rel of files) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), `export const v${RUN} = '${rel}';\n`);
  }
}

async function rowIds(projectId: string): Promise<Record<string, string>> {
  const rows = await Files.listByProject(projectId);
  return Object.fromEntries(rows.map((r) => [r.relativePath, r.id]));
}

describe('file-index data loss (integration)', () => {
  const files = ['src/a.ts', 'src/b.ts', 'locked/c.ts', 'locked/deep/d.ts'];

  // Nested so it unwinds before the shared DB teardown closes the pool.
  afterAll(async () => {
    if (containerIds.length > 0) {
      await getDb().query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [containerIds]);
    }
    for (const d of tmpDirs) {
      // `locked/` only exists in the reconcile fixture; restore its mode so rm can clear it.
      await chmod(path.join(d, 'locked'), 0o755).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
      await rm(d, { recursive: true, force: true });
    }
  });

  describe('unreadable folder during reconcile', () => {
    let dir = '';
    let project: ProjectRow;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'snaglet-dataloss-rec-'));
      tmpDirs.push(dir);
      await makeTree(dir, files);
      project = await makeProject(`dataloss-rec-${RUN}`, dir);
      await reconcileProject(project, rules);
    });

    it('keeps the unreadable subtree, then finds the same rows once it is readable', async () => {
      if (process.getuid?.() === 0) return;
      const before = await rowIds(project.id);
      expect(Object.keys(before).sort()).toEqual(
        files.map((f) => f.split('/').join(path.sep)).sort()
      );

      await chmod(path.join(dir, 'locked'), 0o000);
      try {
        const result = await reconcileProject(project, rules);
        expect(result).toMatchObject({ removed: 0, kept: 2 });
        expect(await rowIds(project.id)).toEqual(before);
        expect(getProjectIndexingRuntime(project.id).lastWarning).toMatch(/locked/);
      } finally {
        await chmod(path.join(dir, 'locked'), 0o755);
      }

      const again = await reconcileProject(project, rules);
      expect(again).toMatchObject({ removed: 0, kept: 0 });
      expect(await rowIds(project.id)).toEqual(before);
      expect(getProjectIndexingRuntime(project.id).lastWarning).toBeNull();
    });
  });

  describe('watched folder renamed', () => {
    let dir = '';
    let project: ProjectRow;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'snaglet-dataloss-watch-'));
      tmpDirs.push(dir, `${dir}-moved`);
      await makeTree(dir, files);
      project = await makeProject(`dataloss-watch-${RUN}`, dir);
      await reconcileProject(project, rules);
    });

    afterAll(async () => {
      await stopProjectWatcher(project.id);
    });

    it('keeps every row and id when the folder moves under a live watcher', async () => {
      const before = await rowIds(project.id);
      expect(Object.keys(before)).toHaveLength(files.length);

      startProjectWatcher(project, rules);
      await wait(1_000); // let chokidar finish its initial (ignored) crawl
      await rename(dir, `${dir}-moved`);
      await wait(2_500); // well past the 500 ms drain debounce

      expect(await rowIds(project.id)).toEqual(before);
      expect(isWatchingProject(project.id)).toBe(false);
    }, 15_000);
  });
});
