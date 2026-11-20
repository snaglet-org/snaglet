/**
 * watcherRootGuard — moving the watched folder must not empty the index.
 *
 * chokidar is replaced by a tiny emitter so each test decides exactly which
 * events arrive; the watched root is a real temp folder so the root-identity
 * checks run against the real filesystem. The file table and ingest are mocked
 * to observe which removals the drain applies.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const emitters: EventEmitter[] = [];
let totalRows = 0;
const removed: string[] = [];
let onRemove: ((relPath: string) => Promise<void>) | null = null;

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

jest.mock('@snaglet/db/tables/files', () => ({
  Files: {
    countByProject: async () => totalRows,
    deleteByProject: async () => 0,
  },
}));

jest.mock('@server/services/fileIndexing/ingest', () => ({
  ingestFile: async () => 'upserted',
  removeFile: async (_project: unknown, relPath: string) => {
    removed.push(relPath);
    if (onRemove) await onRemove(relPath);
    return true;
  },
}));

jest.mock('@server/services/embedding/fileContentEmbedding', () => ({
  gcOrphanFileEmbeddings: async () => 0,
}));

jest.mock('@server/realtime/surfaces/fileEmbeddings', () => ({
  emitFileEmbeddingCoverageChanged: () => undefined,
  emitProjectIndexingStatusChanged: () => undefined,
}));

jest.mock('@server/config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { ProjectRow } from '@snaglet/db/tables/projects';
import { compileIgnoreRules } from '@server/services/fileIndexing/exclusions';
import { getProjectIndexingRuntime } from '@server/services/fileIndexing/projectIndexingStatus';
import {
  isWatchingProject,
  startProjectWatcher,
  stopAllWatchers,
  stopProjectWatcher,
} from '@server/services/fileIndexing/watcher';

/** Past the 500 ms drain debounce plus slack for the async drain itself. */
const DRAIN_WAIT_MS = 800;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let folder = '';
let seq = 0;

function project(): ProjectRow {
  seq += 1;
  return { id: `proj-watch-${seq}`, folderPath: folder } as unknown as ProjectRow;
}

/** Start watching and give the async root-identity read a moment to land. */
async function watch(p: ProjectRow): Promise<EventEmitter> {
  startProjectWatcher(p, compileIgnoreRules({}));
  await wait(20);
  return emitters[emitters.length - 1] as EventEmitter;
}

function unlinkMany(e: EventEmitter, n: number): void {
  for (let i = 0; i < n; i += 1) e.emit('unlink', path.join(folder, `f${i}.ts`));
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'snaglet-watch-guard-'));
  totalRows = 1000;
  removed.length = 0;
  onRemove = null;
});

afterEach(async () => {
  await stopAllWatchers();
  await rm(folder, { recursive: true, force: true });
  await rm(`${folder}-moved`, { recursive: true, force: true });
});

describe('watcher root guard', () => {
  it('applies ordinary removals while the root is intact', async () => {
    const p = project();
    const e = await watch(p);
    unlinkMany(e, 3);
    await wait(DRAIN_WAIT_MS);
    expect(removed.sort()).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
    expect(isWatchingProject(p.id)).toBe(true);
  });

  it('drops the queued removals and pauses when the root is renamed before the drain', async () => {
    const p = project();
    const e = await watch(p);
    unlinkMany(e, 20);
    await rename(folder, `${folder}-moved`);
    await wait(DRAIN_WAIT_MS);
    expect(removed).toEqual([]);
    expect(isWatchingProject(p.id)).toBe(false);
    expect(getProjectIndexingRuntime(p.id).lastWarning).toMatch(/missing or was moved/);
  });

  it('drops the queued removals when the root is swapped for a new folder at the same path', async () => {
    const p = project();
    const e = await watch(p);
    unlinkMany(e, 5);
    await rename(folder, `${folder}-moved`);
    await mkdir(folder);
    await wait(DRAIN_WAIT_MS);
    expect(removed).toEqual([]);
    expect(isWatchingProject(p.id)).toBe(false);
  });

  it('stops removing when the root is renamed mid-drain', async () => {
    const p = project();
    const e = await watch(p);
    unlinkMany(e, 10);
    onRemove = async (relPath) => {
      if (relPath === 'f2.ts') await rename(folder, `${folder}-moved`);
    };
    await wait(DRAIN_WAIT_MS);
    expect(removed).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
    expect(isWatchingProject(p.id)).toBe(false);
  });

  it('stopping the watcher mid-drain halts the remaining removals', async () => {
    const p = project();
    const e = await watch(p);
    unlinkMany(e, 10);
    onRemove = async (relPath) => {
      if (relPath === 'f1.ts') await stopProjectWatcher(p.id);
    };
    await wait(DRAIN_WAIT_MS);
    expect(removed).toEqual(['f0.ts', 'f1.ts']);
  });

  it('pauses immediately on unlinkDir of the root, without waiting for the debounce', async () => {
    const p = project();
    const e = await watch(p);
    unlinkMany(e, 5);
    e.emit('unlinkDir', folder);
    await wait(50);
    expect(isWatchingProject(p.id)).toBe(false);
    await wait(DRAIN_WAIT_MS);
    expect(removed).toEqual([]);
  });

  it('ignores unlinkDir of a subfolder', async () => {
    const p = project();
    const e = await watch(p);
    e.emit('unlinkDir', path.join(folder, 'sub'));
    await wait(50);
    expect(isWatchingProject(p.id)).toBe(true);
  });

  it('holds back a mass removal (> half and > 200 rows) and keeps watching', async () => {
    totalRows = 300;
    const p = project();
    const e = await watch(p);
    unlinkMany(e, 250);
    await wait(DRAIN_WAIT_MS);
    expect(removed).toEqual([]);
    expect(isWatchingProject(p.id)).toBe(true);
    expect(getProjectIndexingRuntime(p.id).lastWarning).toMatch(
      /250 of 300 indexed files are missing from the folder; Snaglet kept them/
    );
  });

  it('applies a large batch that is not most of the project', async () => {
    totalRows = 1000;
    const p = project();
    const e = await watch(p);
    unlinkMany(e, 250);
    await wait(DRAIN_WAIT_MS * 2);
    expect(removed).toHaveLength(250);
  });
});
