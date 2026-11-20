/**
 * configWatcher — the gate-file watcher never polls and, after a fatal watch
 * error, warns once and leaves the project's gate to the periodic scan
 * Two consecutive sweeps (startConfigWatcher calls) give
 * one warning; an hour later, or after a stop, it may try again.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

interface FakeWatcher extends EventEmitter {
  close: jest.Mock<() => Promise<void>>;
}
const created: Array<{ options: Record<string, unknown>; watcher: FakeWatcher }> = [];

jest.mock('chokidar', () => ({
  __esModule: true,
  default: {
    watch: (_target: unknown, options: Record<string, unknown>) => {
      const watcher = new EventEmitter() as FakeWatcher;
      watcher.close = jest.fn(async () => undefined);
      created.push({ options, watcher });
      return watcher;
    },
  },
}));
jest.mock('@server/config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { ProjectRow } from '@snaglet/db/tables/projects';
import { logger } from '@server/config/logger';
import {
  setConfigWatcherClockForTests,
  startConfigWatcher,
  stopAllConfigWatchers,
  stopConfigWatcher,
} from '@server/services/fileIndexing/configWatcher';

const warn = logger.warn as jest.Mock;
const project = { id: 'proj-config-1', folderPath: '/test/project-root' } as unknown as ProjectRow;
const noop = () => undefined;
const err = (code: string) => Object.assign(new Error(code), { code });
let clock = 0;

beforeEach(() => {
  created.length = 0;
  clock = 1_000_000;
  setConfigWatcherClockForTests(() => clock);
  warn.mockClear();
});

afterEach(async () => {
  await stopAllConfigWatchers();
  setConfigWatcherClockForTests(null);
});

describe('config watcher', () => {
  it('passes usePolling:false', () => {
    startConfigWatcher(project, noop);
    expect(created[0]?.options.usePolling).toBe(false);
  });

  it('ENOSPC: one warning across two sweeps, closed, retried only after an hour', async () => {
    startConfigWatcher(project, noop);
    created[0]!.watcher.emit('error', err('ENOSPC'));
    created[0]!.watcher.emit('error', err('ENOSPC'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(created[0]!.watcher.close).toHaveBeenCalledTimes(1);

    clock += 5 * 60_000;
    startConfigWatcher(project, noop); // sweep 1
    clock += 5 * 60_000;
    startConfigWatcher(project, noop); // sweep 2
    expect(created).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);

    clock += 60 * 60_000;
    startConfigWatcher(project, noop);
    expect(created).toHaveLength(2);
  });

  it('a config/folder change (stop) clears the failure mark', async () => {
    startConfigWatcher(project, noop);
    created[0]!.watcher.emit('error', err('EMFILE'));
    await stopConfigWatcher(project.id);
    startConfigWatcher(project, noop);
    expect(created).toHaveLength(2);
  });

  it('ignores transient errors', () => {
    startConfigWatcher(project, noop);
    created[0]!.watcher.emit('error', err('EBUSY'));
    expect(warn).not.toHaveBeenCalled();
    expect(created[0]!.watcher.close).not.toHaveBeenCalled();
  });
});
