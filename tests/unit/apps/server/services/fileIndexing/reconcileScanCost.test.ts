/**
 * reconcile scan cost — an unchanged file costs one stat, not a read and a
 * hash, and a scan loads the project's rows instead of querying per file.
 *
 * Real temp folders, the real reconcile, ingest and watcher; the file table is
 * an in-memory map and chokidar a plain emitter. The recent-write clock runs
 * 10 s ahead so freshly written fixtures count as settled; one test uses the
 * real clock. Content rewritten with its old size and mtime put back is still
 * re-read, because ctime moves. A rewrite that also kept ctime (not possible
 * from userland) is accepted: the watcher reports the write, a backfill reads
 * every file, and so does the first scan after a restart.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface Row {
  relativePath: string;
  contentHash: string;
}

const rows = new Map<string, Row>();
const readPaths: string[] = [];
const emitters: EventEmitter[] = [];
const listByProject = jest.fn(async () => [...rows.values()]);
const byProjectAndPath = jest.fn(async (_projectId: string, rel: string) => rows.get(rel) ?? null);

jest.mock('@snaglet/db/tables/files', () => ({
  Files: {
    listByProject: () => listByProject(),
    byProjectAndPath: (projectId: string, rel: string) => byProjectAndPath(projectId, rel),
    upsertByPath: async (input: Row) => {
      rows.set(input.relativePath, {
        relativePath: input.relativePath,
        contentHash: input.contentHash,
      });
      return {};
    },
    deleteByPath: async (_projectId: string, rel: string) => rows.delete(rel),
    countByProject: async () => rows.size,
  },
}));

jest.mock('@server/services/embedding/fileSource', () => {
  const actual = jest.requireActual<typeof import('@server/services/embedding/fileSource')>(
    '@server/services/embedding/fileSource'
  );
  return {
    ...actual,
    readEmbeddableFileContent: (
      ...args: Parameters<typeof actual.readEmbeddableFileContent>
    ): ReturnType<typeof actual.readEmbeddableFileContent> => {
      readPaths.push(args[0]);
      return actual.readEmbeddableFileContent(...args);
    },
  };
});

jest.mock('chokidar', () => ({
  __esModule: true,
  default: {
    watch: () => {
      const e = new EventEmitter() as EventEmitter & { close: () => Promise<void> };
      e.close = async () => undefined;
      emitters.push(e);
      return e;
    },
  },
}));

jest.mock('@server/services/embedding/fileContentEmbedding', () => ({
  gcOrphanFileEmbeddings: async () => 0,
}));

jest.mock('@server/realtime/surfaces/fileEmbeddings', () => ({
  emitFileEmbeddingCoverageChanged: () => undefined,
  emitFileIndexingImpactChanged: () => undefined,
  emitProjectIndexingStatusChanged: () => undefined,
}));

jest.mock('@server/config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { ProjectRow } from '@snaglet/db/tables/projects';
import { compileIgnoreRules } from '@server/services/fileIndexing/exclusions';
import {
  cachedRead,
  forgetProjectHashedStats,
  setHashedStatClockForTests,
} from '@server/services/fileIndexing/hashedStatCache';
import { removeFile } from '@server/services/fileIndexing/ingest';
import { reconcileProject } from '@server/services/fileIndexing/reconcile';
import { startProjectWatcher, stopProjectWatcher } from '@server/services/fileIndexing/watcher';

const rules = compileIgnoreRules({});
const OLD = new Date('2026-01-01T00:00:00Z');
const OLDER = new Date('2025-06-01T00:00:00Z');
let folder = '';
let seq = 0;

function project(): ProjectRow {
  seq += 1;
  return {
    id: `proj-scan-cost-${seq}`,
    folderPath: folder,
    containerId: `container-scan-cost-${seq}`,
  } as unknown as ProjectRow;
}

const abs = (rel: string) => path.join(folder, rel);

/** Write a file and date it in the past, as an untouched file on disk would be. */
async function writeOld(rel: string, body: string): Promise<void> {
  await mkdir(path.dirname(abs(rel)), { recursive: true });
  await writeFile(abs(rel), body);
  await utimes(abs(rel), OLD, OLD);
}

/** A project whose files were all hashed once, with the read log reset. */
async function indexedProject(files: Record<string, string>): Promise<ProjectRow> {
  for (const [rel, body] of Object.entries(files)) await writeOld(rel, body);
  const p = project();
  await reconcileProject(p, rules);
  readPaths.length = 0;
  listByProject.mockClear();
  byProjectAndPath.mockClear();
  return p;
}

/** The cached read for a file as it is on disk now. */
async function cachedNow(p: ProjectRow, rel: string) {
  return cachedRead(p.id, rel, await stat(abs(rel)));
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'snaglet-scan-cost-'));
  rows.clear();
  readPaths.length = 0;
  emitters.length = 0;
  listByProject.mockClear();
  byProjectAndPath.mockClear();
  setHashedStatClockForTests(() => Date.now() + 10_000);
});

afterEach(async () => {
  setHashedStatClockForTests(null);
  await rm(folder, { recursive: true, force: true });
});

describe('reconcile scan cost', () => {
  it('counts a file unchanged from its stat without reading it', async () => {
    const p = await indexedProject({ 'a.ts': 'one', 'src/b.ts': 'two' });

    const result = await reconcileProject(p, rules);

    expect(result).toMatchObject({ upserted: 0, unchanged: 2, removed: 0 });
    expect(readPaths).toEqual([]);
  });

  it('reads and hashes again when the mtime changes', async () => {
    const p = await indexedProject({ 'a.ts': 'one' });
    await utimes(abs('a.ts'), OLDER, OLDER);

    const result = await reconcileProject(p, rules);

    expect(result).toMatchObject({ upserted: 0, unchanged: 1 });
    expect(readPaths).toEqual([abs('a.ts')]);
    readPaths.length = 0;
    await reconcileProject(p, rules);
    expect(readPaths).toEqual([]);
  });

  it('reads, hashes and upserts when the size changes', async () => {
    const p = await indexedProject({ 'a.ts': 'one' });
    const before = rows.get('a.ts')?.contentHash;
    await writeOld('a.ts', 'one and more');

    const result = await reconcileProject(p, rules);

    expect(result).toMatchObject({ upserted: 1, unchanged: 0 });
    expect(readPaths).toEqual([abs('a.ts')]);
    expect(rows.get('a.ts')?.contentHash).not.toBe(before);
  });

  it('re-reads content rewritten in place with its old size and mtime put back', async () => {
    const p = await indexedProject({ 'a.ts': 'aaa' });
    const hashed = await stat(abs('a.ts'));
    expect(cachedRead(p.id, 'a.ts', hashed)).toEqual({
      kind: 'hashed',
      contentHash: rows.get('a.ts')?.contentHash,
    });
    await new Promise((r) => setTimeout(r, 20));
    await writeOld('a.ts', 'bbb');
    const now = await stat(abs('a.ts'));
    expect([now.size, now.mtimeMs, now.ino, now.dev]).toEqual([
      hashed.size,
      hashed.mtimeMs,
      hashed.ino,
      hashed.dev,
    ]);
    expect(now.ctimeMs).not.toBe(hashed.ctimeMs);

    const result = await reconcileProject(p, rules);

    expect(result).toMatchObject({ upserted: 1 });
    expect(readPaths).toEqual([abs('a.ts')]);
  });

  it('re-reads a file replaced by a rename with the same size and mtime', async () => {
    const p = await indexedProject({ 'a.ts': 'aaa' });
    const hashed = await stat(abs('a.ts'));
    await writeOld('b.tmp', 'bbb');
    await rename(abs('b.tmp'), abs('a.ts'));
    expect((await stat(abs('a.ts'))).ino).not.toBe(hashed.ino);

    const result = await reconcileProject(p, rules);

    expect(result).toMatchObject({ upserted: 1 });
    expect(readPaths).toEqual([abs('a.ts')]);
  });

  it('does not cache a file whose ctime is recent, even with an old mtime', async () => {
    setHashedStatClockForTests(null);
    const p = await indexedProject({ 'a.ts': 'one' });
    expect(await cachedNow(p, 'a.ts')).toBeNull();

    await reconcileProject(p, rules);

    expect(readPaths).toEqual([abs('a.ts')]);
  });

  it('settles a binary file from its stat once it was skipped', async () => {
    const p = await indexedProject({ 'image.dat': 'GIF\u0000\u0001binary', 'a.ts': 'one' });
    expect(await cachedNow(p, 'image.dat')).toEqual({ kind: 'skipped' });

    const result = await reconcileProject(p, rules);

    expect(result).toMatchObject({ skipped: 1, unchanged: 1 });
    expect(readPaths).toEqual([]);
  });

  it('keeps reading a file it could not open', async () => {
    if (process.getuid?.() === 0) return; // root ignores chmod
    await writeOld('locked.ts', 'one');
    await chmod(abs('locked.ts'), 0o000);
    try {
      const p = await indexedProject({});
      expect(await cachedNow(p, 'locked.ts')).toBeNull();

      const result = await reconcileProject(p, rules);

      expect(result).toMatchObject({ skipped: 1 });
      expect(readPaths).toEqual([abs('locked.ts')]);
    } finally {
      await chmod(abs('locked.ts'), 0o644);
    }
  });

  it('hashes every file again with a fresh cache, as after a restart', async () => {
    const p = await indexedProject({ 'a.ts': 'one', 'b.ts': 'two' });
    forgetProjectHashedStats(p.id);

    const result = await reconcileProject(p, rules);

    expect(result).toMatchObject({ unchanged: 2 });
    expect(readPaths.sort()).toEqual([abs('a.ts'), abs('b.ts')]);
  });

  it('loads the rows once for lookups and once for removals, never per file', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`d${i % 10}/f${i}.ts`, `// ${i}\n`])
    );
    const p = await indexedProject(files);

    const result = await reconcileProject(p, rules);

    expect(result).toMatchObject({ unchanged: 300 });
    expect(listByProject).toHaveBeenCalledTimes(2);
    expect(byProjectAndPath).not.toHaveBeenCalled();
  });

  it('forgets a removed file', async () => {
    const p = await indexedProject({ 'a.ts': 'one' });
    expect(await cachedNow(p, 'a.ts')).not.toBeNull();

    await removeFile(p, 'a.ts');

    expect(await cachedNow(p, 'a.ts')).toBeNull();
  });

  it('re-reads a file the watcher reported changed', async () => {
    const p = await indexedProject({ 'a.ts': 'one', 'b.ts': 'two' });
    startProjectWatcher(p, rules);
    try {
      emitters[emitters.length - 1].emit('change', abs('a.ts'));

      const result = await reconcileProject(p, rules);

      expect(result).toMatchObject({ unchanged: 2 });
      expect(readPaths).toEqual([abs('a.ts')]);
    } finally {
      await stopProjectWatcher(p.id);
    }
  });
});
