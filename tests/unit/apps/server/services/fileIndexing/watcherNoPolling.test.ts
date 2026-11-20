/**
 * watcherNoPolling — chokidar's polling watch mode is never enabled.
 *
 * chokidar is replaced by an emitter that records its options. Covers: usePolling
 * is an explicit false on the project watcher; a fatal watch error (ENOSPC) logs
 * one warning, closes the watcher, marks the project scan-only and is not
 * restarted by the next sweep (until the hourly retry or a config/folder change);
 * transient errors are ignored; the macOS fsevents diagnostic warns once.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

interface FakeWatcher extends EventEmitter {
  close: jest.Mock<() => Promise<void>>;
}
const created: Array<{ target: unknown; options: Record<string, unknown>; watcher: FakeWatcher }> =
  [];

jest.mock('chokidar', () => ({
  __esModule: true,
  default: {
    watch: (target: unknown, options: Record<string, unknown>) => {
      const watcher = new EventEmitter() as FakeWatcher;
      watcher.close = jest.fn(async () => undefined);
      created.push({ target, options, watcher });
      return watcher;
    },
  },
}));

jest.mock('@snaglet/db/tables/files', () => ({
  Files: { countByProject: async () => 0, deleteByProject: async () => 0 },
}));
jest.mock('@server/services/fileIndexing/ingest', () => ({
  ingestFile: async () => 'upserted',
  removeFile: async () => true,
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
import { logger } from '@server/config/logger';
import { compileIgnoreRules } from '@server/services/fileIndexing/exclusions';
import { getProjectIndexingRuntime } from '@server/services/fileIndexing/projectIndexingStatus';
import {
  resetFseventsCheckForTests,
  warnIfFseventsUnavailable,
} from '@server/services/fileIndexing/watchBackend';
import {
  clearScanOnly,
  getProjectWatchMode,
  isWatchingProject,
  setWatcherClockForTests,
  startProjectWatcher,
  stopAllWatchers,
} from '@server/services/fileIndexing/watcher';

const warn = logger.warn as jest.Mock;
const HOUR_MS = 60 * 60_000;
let clock = 0;
let seq = 0;

function project(): ProjectRow {
  seq += 1;
  return { id: `proj-nopoll-${seq}`, folderPath: '/test/project-root' } as unknown as ProjectRow;
}

function fatal(code: string, errPath?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: watch failed`), { code, path: errPath });
}

const rules = compileIgnoreRules({});
const flush = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  created.length = 0;
  clock = 1_000_000;
  setWatcherClockForTests(() => clock);
  warn.mockClear();
  resetFseventsCheckForTests();
});

afterEach(async () => {
  await stopAllWatchers();
  setWatcherClockForTests(null);
});

describe('watcher never polls', () => {
  it('passes an explicit usePolling:false to the project watcher', () => {
    const p = project();
    startProjectWatcher(p, rules);
    expect(created).toHaveLength(1);
    expect(created[0]?.options.usePolling).toBe(false);
    expect(getProjectWatchMode(p.id)).toBe('live');
  });
});

describe('fatal watcher errors fall back to the scan', () => {
  it('ENOSPC: one warning, watcher closed, scan-only, not restarted by the next sweep', async () => {
    const p = project();
    startProjectWatcher(p, rules);
    const { watcher } = created[0]!;

    watcher.emit('error', fatal('ENOSPC'));
    watcher.emit('error', fatal('ENOSPC')); // a second event must not warn again
    await flush();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/ENOSPC.*fs\.inotify\.max_user_watches/);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(isWatchingProject(p.id)).toBe(false);
    expect(getProjectWatchMode(p.id)).toBe('scan-only');
    expect(getProjectIndexingRuntime(p.id).lastWarning).toMatch(/periodic scan/);

    // The periodic sweep calls startProjectWatcher again: it must not retry yet.
    clock += 5 * 60_000;
    startProjectWatcher(p, rules);
    expect(created).toHaveLength(1);
    expect(getProjectWatchMode(p.id)).toBe('scan-only');
  });

  it('retries after an hour', async () => {
    const p = project();
    startProjectWatcher(p, rules);
    created[0]!.watcher.emit('error', fatal('EMFILE'));
    await flush();
    clock += HOUR_MS + 1;
    startProjectWatcher(p, rules);
    expect(created).toHaveLength(2);
    expect(getProjectWatchMode(p.id)).toBe('live');
  });

  it('a config or folder change clears the scan-only mark', async () => {
    const p = project();
    startProjectWatcher(p, rules);
    created[0]!.watcher.emit('error', fatal('ENOSPC'));
    await flush();
    clearScanOnly(p.id);
    startProjectWatcher(p, rules);
    expect(created).toHaveLength(2);
  });

  it('EPERM on the watched root is fatal; EPERM/EBUSY on a single file is ignored', async () => {
    const p = project();
    startProjectWatcher(p, rules);
    const { watcher } = created[0]!;
    watcher.emit('error', fatal('EPERM', '/test/project-root/locked.txt'));
    watcher.emit('error', fatal('EBUSY', '/test/project-root/busy.txt'));
    watcher.emit('error', fatal('EPERM')); // no path: can't be attributed to the root
    watcher.emit('error', fatal('EACCES'));
    await flush();
    expect(warn).not.toHaveBeenCalled();
    expect(isWatchingProject(p.id)).toBe(true);

    watcher.emit('error', fatal('EPERM', '/test/project-root'));
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getProjectWatchMode(p.id)).toBe('scan-only');
  });
});

describe('fsevents diagnostic', () => {
  it('warns once on macOS when fsevents cannot load, never elsewhere', () => {
    const missing = () => {
      throw new Error("Cannot find module 'fsevents'");
    };
    warnIfFseventsUnavailable('linux', missing);
    expect(warn).not.toHaveBeenCalled();
    warnIfFseventsUnavailable('darwin', missing);
    warnIfFseventsUnavailable('darwin', missing);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /fsevents unavailable; using fs\.watch \(no polling\)/
    );
  });

  it('stays quiet when fsevents loads', () => {
    warnIfFseventsUnavailable('darwin', () => ({}));
    expect(warn).not.toHaveBeenCalled();
  });
});
